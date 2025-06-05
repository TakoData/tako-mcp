import base64
import logging
import os
import tempfile
import traceback
from typing import Any

from tako.client import TakoClient, KnowledgeSearchSourceIndex
from tako.types.visualize.types import TakoDataFormatDataset
from mcp.server.fastmcp import FastMCP

TAKO_API_KEY = os.getenv("TAKO_API_KEY")
X_TAKO_URL = os.getenv("X_TAKO_URL", "https://trytako.com")
ENVIRONMENT = os.getenv("ENVIRONMENT", "local")


# Initialize MCP Server and Tako Client
mcp = FastMCP("tako", port=8001, host="0.0.0.0")
tako_client = TakoClient(api_key=TAKO_API_KEY, server_url=X_TAKO_URL)


@mcp.tool()
async def search_tako(text: str) -> str:
    """Search Tako for any knowledge you want and get data and visualizations."""
    try:
        response = tako_client.knowledge_search(
            text=text,
            source_indexes=[
                KnowledgeSearchSourceIndex.TAKO,
                KnowledgeSearchSourceIndex.WEB,
            ],
        )
    except Exception:
        logging.error(f"Failed to search Tako: {text}, {traceback.format_exc()}")
        return "No card found"
    return response.model_dump()


@mcp.tool()
async def upload_file_to_visualize(filename: str, content: str, encoding: str = "base64") -> str:
    """Upload a file in base64 format to Tako to visualize. Returns the file_id of the uploaded file that can call visualize_file with.
    
    Response: 
        file_id: <file_id>
    """
    if encoding == "base64":
        file_data = base64.b64decode(content)
        
        # Use tempfile to create a temporary file in the system's temp directory
        with tempfile.NamedTemporaryFile(prefix="temp_", suffix="_" + filename, delete=False) as temp_file:
            temp_file.write(file_data)
            temp_file_path = temp_file.name
        
        try:
            file_id = tako_client.beta_upload_file(temp_file_path)
        except Exception:
            logging.error(f"Failed to upload file: {temp_file_path}, {traceback.format_exc()}")
            return f"Failed to upload file: {temp_file_path}, {traceback.format_exc()}"
        finally:
            # Clean up the temporary file
            if os.path.exists(temp_file_path):
                os.remove(temp_file_path)
    else:
        raise ValueError(f"Unsupported encoding: {encoding}, supported encoding is base64")

    return f"{file_id}"


@mcp.tool()
async def visualize_file(file_id: str) -> str:
    """Visualize a file in Tako using the file_id returned from upload_file_to_visualize. Returns the visualization."""
    try:   
        response = tako_client.beta_visualize(file_id=file_id)
    except Exception:
        logging.error(f"Failed to visualize file: {file_id}, {traceback.format_exc()}")
        return f"Failed to visualize file: {file_id}, {traceback.format_exc()}"
    return response.model_dump()


@mcp.tool()
async def visualize_dataset(dataset: dict[str, Any]) -> str:
    """Given a structured dataset in Tako Data Format, return a visualization."""
    try:
        tako_dataset = TakoDataFormatDataset.model_validate(dataset)
    except Exception:
        logging.error(f"Invalid dataset format: {dataset}, {traceback.format_exc()}")
        # If a dataset is invalid, return the traceback to the client so it can retry with the correct format
        return f"Invalid dataset format: {dataset}, {traceback.format_exc()}"

    try:
        response = tako_client.beta_visualize(tako_dataset)
    except Exception:
        logging.error(
            f"Failed to generate visualization: {dataset}, {traceback.format_exc()}"
        )
        return f"Failed to generate visualization: {dataset}, {traceback.format_exc()}"
    return response.model_dump()


@mcp.prompt()
async def generate_search_tako_prompt(text: str) -> str:
    """Generate a prompt to search Tako for given user input text."""
    return f"""
    You are a data analyst agent that generates a Tako search query for a user input text to search Tako and retrieve real-time data and visualizations. 
    
    Generate queries and search Tako following the instructions below:
    
    Step 1. Generate search queries following the instructions below and call `search_tako(query)` for each query.
    * If the text includes a cohort such as "G7", "African Countries", "Magnificent 7 stocks", generate search queries for each individual countries, stocks, or companies within the cohort. For example, if user input includes "G7", generate queries for "United States", "Canada", "France", "Germany", "Italy", "Japan", and "United Kingdom".
    * If the text is about a broad topic, generate specific search queries related to the topic.
    * If the text can be answered by categorizing the data, generate search queries using semantic functions such as "Top 10", or "Bottom 10".
    * If the text is about a timeline, generate a search query starting with "Timeline of".
    * Search for a single metric per query. For example if user wants to know about a company, you may generate query like "Market Cap of Tesla" or "Revenue of Tesla" but not "Tesla's Market Cap and Revenue".
    
    Step 2. Ground your answer based on the results from Tako.
    * Using the data provided by Tako, ground your answer.
    
    Step 3. Add visualizations from Step 1 to your answer.
    * Use the embed or image link provided by Tako to add visualizations to your answer.
    
    <UserInputText>
    {text}
    </UserInputText>
    """


@mcp.prompt()
async def generate_visualization_prompt(text: str) -> str:
    """Generate a prompt to generate a visualization for given user input text."""
    return f"""You are an expert at tidying up datasets and add rich metadata to them to help with visualization.

*** Task 1: Tidy the dataset ***

You are to take the dataset and make it a "tidy dataset".

There are three interrelated features that make a dataset tidy:

1. Each variable is a column; each column is a variable.
2. Each observation is row; each row is an observation.
3. Each value is a cell; each cell is a single value.

There are two common problems you find in data that are ingested that make them not tidy:

1. A variable might be spread across multiple columns.
2. An observation might be scattered across multiple rows.

For 1., we need to "melt" the wide data, with multiple columns, into long data.
For 2., we need to unstack or pivot the multiple rows into columns (ie go from long to wide.)

Example 1 (needs melting):
| country | 1999 | 2000 |
| USA     | 100   | 200   |
| Canada  | 10    | 20    |

Becomes (after melting):
| country | year | value |
| USA     | 1999 | 100   |
| USA     | 2000 | 200   |
| Canada  | 1999 | 10    |
| Canada  | 2000 | 20    |

Example 2 (needs pivoting):
| country | year | type | count
| USA     | 2020 | cases  | 10
| USA     | 2020 | population | 2000000
| USA     | 2021 | cases  | 30
| USA     | 2021 | population | 2050000
| Canada  | 2020 | cases  | 40
| Canada  | 2020 | population | 3000000
| Canada  | 2021 | population | 3000000

Becomes (after pivoting):
| country | year  | cases | population
| USA     | 2020  | 10    | 2000000
| USA     | 2021  | 30    | 2050000
| Canada  | 2020  | 40    | 3000000
| Canada  | 2021  | NULL  | 3000000

You are to take the dataset and make it tidy.

*** Task 2: Enrich the dataset with metadata ***

You are to take the dataset and add rich metadata to it to help with visualization. 
For variables that are appropriate for timeseries visualizations, you are to add specific
metadata. 

For variables that are appropriate for categorical bar chart visualizations, you are to add specific
metadata.

See the schema {TakoDataFormatDataset.model_json_schema()} for more information.

Make the metadata consistent, rich, and useful for visualizations.

<UserInputText>
{text}
</UserInputText>
"""


if __name__ == "__main__":
    if ENVIRONMENT == "remote":
        mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")
