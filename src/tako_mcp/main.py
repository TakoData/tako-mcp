import base64
import concurrent
import logging
import os
import tempfile
import traceback
from typing import Any
import requests

from tako.client import TakoClient, KnowledgeSearchSourceIndex
from tako.types.knowledge_search.types import KnowledgeSearchResults
from tako.types.visualize.types import TakoDataFormatDataset
from mcp.server.fastmcp import Context, FastMCP
from tako.client import TakoClient
from tako.types.knowledge_search.types import KnowledgeSearchSourceIndex, KnowledgeSearchResults
from tako.types.visualize.types import TakoDataFormatDataset

TAKO_API_KEY = os.getenv("TAKO_API_KEY")
X_TAKO_URL = os.getenv("X_TAKO_URL", "https://trytako.com/")
ENVIRONMENT = os.getenv("ENVIRONMENT")
PORT = os.getenv("PORT", 8001)
HOST = os.getenv("HOST", "0.0.0.0")

# Initialize MCP Server
mcp = FastMCP("tako", port=PORT, host=HOST)

def _get_insight_for_chart(card_id: str, ctx: Context) -> str:
    """Get insight for a card."""
    try:
        response = _get_tako_client_from_context(ctx).beta_chart_insights(card_id)
    except Exception:
        logging.error(f"Failed to get insight for card: {card_id}, {traceback.format_exc()}")
        return "No insight found"
    return response

def _add_insight_to_knowledge_response(response: KnowledgeSearchResults, ctx: Context) -> dict[str, Any]:
    resp_dict = response.model_dump()
    def get_insights_for_per_card(card_id: str) -> str:
        return card_id, _get_insight_for_chart(card_id, ctx)
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = []
        if "outputs" in resp_dict and "knowledge_cards" in resp_dict["outputs"]:
            for card in resp_dict["outputs"]["knowledge_cards"]:
                futures.append(executor.submit(get_insights_for_per_card, card["card_id"]))
        card_id_to_insight = {}
        for future in concurrent.futures.as_completed(futures):
            card_id, insight = future.result()
            card_id_to_insight[card_id] = insight
        for card in resp_dict["outputs"]["knowledge_cards"]:
            card["insight"] = card_id_to_insight[card["card_id"]]
    return resp_dict
           
def _get_tako_client_from_context(ctx: Context) -> TakoClient:
    if ENVIRONMENT == "local":
        return TakoClient(api_key=TAKO_API_KEY, server_url=X_TAKO_URL)
    else:
        return TakoClient(api_key=ctx.session_config.takoApiKey, server_url=X_TAKO_URL)

@mcp.tool()
async def search_tako(text: str, ctx: Context) -> dict[str, Any] | str:
    """Search the Tako knowledge index for any knowledge you want and get data and visualizations.
    Returns embed, webpage, and image url of the visualization with relevant metadata such as source, methodology, and description
    as well as the data used to generate the visualization.
    """
    try:
        response = _get_tako_client_from_context(ctx).knowledge_search(
            text=text,
            source_indexes=[
                KnowledgeSearchSourceIndex.TAKO,
            ],
        )
    except Exception as e:
        logging.error(f"Failed to search Tako: {text}, {traceback.format_exc()}")
        return f"No card found {e}: {traceback.format_exc()}"
    return response.model_dump()


@mcp.tool()
async def web_search_tako(text: str, ctx: Context) -> dict[str, Any] | str:
    """Search the general web using Parallel Web Search to get data and visualizations.
    Returns embed, webpage, and image url of the visualization with relevant metadata such as source, methodology, and description
    as well as the data used to generate the visualization.
    """
    try:
        response = _get_tako_client_from_context(ctx).knowledge_search(
            text=text,
            source_indexes=[
                KnowledgeSearchSourceIndex.WEB,
            ],
        )
        resp_dict = _add_insight_to_knowledge_response(response, ctx)
    except Exception:
        logging.error(f"Failed to search Tako: {text}, {traceback.format_exc()}")
        return "No card found"
    return resp_dict


@mcp.tool()
async def deep_search_tako(text: str, ctx: Context) -> dict[str, Any] | str:
    """Perform a deep or analytical search of Tako for any knowledge you want and get data and visualizations.
    Returns embed, webpage, and image url of the visualization with relevant metadata such as source, methodology, and description
    as well as the data used to generate the visualization.
    """
    try:
        response = _get_tako_client_from_context(ctx).knowledge_search(
            text=text,
            source_indexes=[
                "tako_deep",
            ],
        )
    except Exception as e:
        logging.error(f"Failed to search Tako: {text}, {traceback.format_exc()}")
        return f"No card found {e}: {traceback.format_exc()}"
    return response.model_dump()

@mcp.tool()
async def data_search_tako(text: str, ctx: Context) -> dict[str, Any] | str:
    """Search the Tako knowledge index for any knowledge you want and get data and visualizations.
    Returns embed, webpage, and image url of the visualization with relevant metadata such as source, methodology, and description
    as well as the data used to generate the visualization.
    """
    try:
        response = _get_tako_client_from_context(ctx).knowledge_search(
            text=text,
            source_indexes=[
                KnowledgeSearchSourceIndex.TAKO.value,
                "tako_deep",
            ],
            extra_params="include_data_url=true",
        )
    except Exception:
        logging.error(f"Failed to get file data: {text}, {traceback.format_exc()}")
        return f"Failed to get file data: {text}, {traceback.format_exc()}"
    

    assert isinstance(response, KnowledgeSearchResults), f"Response is not a KnowledgeSearchResults: {response}"
    assert response.outputs is not None, f"Response.outputs is None: {response}"
    assert response.outputs.knowledge_cards is not None, f"Response.outputs.knowledge_cards is None: {response}"
    
    ret: dict[str, Any] = response.model_dump()
    ret["raw_data_by_card_id"] = {}
    for kc in response.outputs.knowledge_cards:
        if kc.data_url:
            response = requests.get(kc.data_url)
            response.raise_for_status()  # Raise an exception for bad status codes
            data = response.text
            ret["raw_data_by_card_id"][kc.card_id] = data
    return ret


@mcp.tool()
async def upload_file_to_visualize(
    filename: str, content: str, ctx: Context, encoding: str = "base64", 
) -> str:
    """Upload a file in base64 format to Tako to visualize. Returns the file_id of the uploaded file that can call visualize_file with.

    Supported file type extensions:
    - .csv
    - .xlsx
    - .xls
    - .parquet

    Response:
        file_id: <file_id>
    """
    if encoding == "base64":
        file_data = base64.b64decode(content)

        # Use tempfile to create a temporary file in the system's temp directory
        with tempfile.NamedTemporaryFile(
            prefix="temp_", suffix="_" + filename, delete=False
        ) as temp_file:
            temp_file.write(file_data)
            temp_file_path = temp_file.name

        try:
            file_id = _get_tako_client_from_context(ctx).beta_upload_file(temp_file_path)
        except Exception:
            logging.error(
                f"Failed to upload file: {temp_file_path}, {traceback.format_exc()}"
            )
            return f"Failed to upload file: {temp_file_path}, {traceback.format_exc()}"
        finally:
            # Clean up the temporary file
            if os.path.exists(temp_file_path):
                os.remove(temp_file_path)
    else:
        raise ValueError(
            f"Unsupported encoding: {encoding}, supported encoding is base64"
        )

    return f"{file_id}"

@mcp.tool()
async def upload_file_from_local_path(local_path: str, ctx: Context) -> str:
    """Upload a file from a local path to Tako to visualize. Returns the file_id of the uploaded file that can call visualize_file with.
    
    Response: 
        file_id: <file_id>
    """
    try:
        file_id = _get_tako_client_from_context(ctx).beta_upload_file(local_path)
    except Exception:
        logging.error(f"Failed to upload file: {local_path}, {traceback.format_exc()}")
        return f"Failed to upload file: {local_path}, {traceback.format_exc()}"
    return f"{file_id}"


@mcp.tool()
async def upload_file_from_url(url: str, ctx: Context) -> str:
    """Upload a file from an external url to Tako to visualize. Returns the file_id of the uploaded file that can call visualize_file with.
    
    Response: 
        file_id: <file_id>
    """
    try:
        file_id = _get_tako_client_from_context(ctx).beta_file_connector(url)
    except Exception:
        logging.error(f"Failed to upload file: {url}, {traceback.format_exc()}")
        return f"Failed to upload file: {url}, {traceback.format_exc()}"
    return f"{file_id}"
    
    
@mcp.tool()
async def visualize_file(file_id: str, ctx: Context, query: str | None = None) -> str:
    """
    Visualize a file in Tako using the file_id returned from upload_file_to_visualize.
    Optionally, provide a query that includes an analytical question and visualization types to visualize the file.

    Query Examples:
    - Show me a timeseries graph of X and Y over the last 10 years.
    - Show me a bar chart comparing the top 10 companies by revenue in 2024.
    - Show me a map of which state ordered the most pizza in 2024.
    - Show me a box plot of the distribution of math scores by gender.
    - Show me a heatmap of the correlation between revenue and profit for the divisions of a company.
    - Compare the revenue of the top 10 companies by revenue in 2024.
    - Show me a pie chart of the categories of products sold in 2023.
    - Histogram of the distribution of salary in the marketing department.

    Args:
        file_id: The file_id of the file to visualize.
        query: The query to visualize the file.

    Returns:
        Tako Card with Visualization Embed and Image Link.
    """
    try:
        response = _get_tako_client_from_context(ctx).beta_visualize(file_id=file_id, query=query)
        resp_dict = _add_insight_to_knowledge_response(response, ctx)
    except Exception:
        logging.error(f"Failed to visualize file: {file_id}, {traceback.format_exc()}")
        return f"Failed to visualize file: {file_id}, {traceback.format_exc()}"
    return resp_dict


@mcp.tool()
async def visualize_dataset(dataset: dict[str, Any], ctx: Context, query: str | None = None) -> str:
    """
    Visualize a dataset in Tako Data Format.
    Optionally, provide a query that includes an analytical question and visualization types to visualize the dataset.

    Query Examples:
    - Show me a timeseries graph of X and Y over the last 10 years.
    - Show me a bar chart comparing the top 10 companies by revenue in 2024.
    - Show me a map of which state ordered the most pizza in 2024.
    - Show me a box plot of the distribution of math scores by gender.
    - Show me a heatmap of the correlation between revenue and profit for the divisions of a company.
    - Compare the revenue of the top 10 companies by revenue in 2024.
    - Show me a pie chart of the categories of products sold in 2023.
    - Histogram of the distribution of salary in the marketing department.

    Args:
        dataset: The dataset to visualize in Tako Data Format (Tidy data).
        query: The query to visualize the dataset.

    Returns:
        Tako Card with Visualization Embed and Image Link.
    """
    try:
        tako_dataset = TakoDataFormatDataset.model_validate(dataset)
    except Exception:
        logging.error(f"Invalid dataset format: {dataset}, {traceback.format_exc()}")
        # If a dataset is invalid, return the traceback to the client so it can retry with the correct format
        return f"Invalid dataset format: {dataset}, {traceback.format_exc()}"

    try:
        response = _get_tako_client_from_context(ctx).beta_visualize(tako_dataset, query=query)
        resp_dict = _add_insight_to_knowledge_response(response, ctx)
    except Exception:
        logging.error(
            f"Failed to generate visualization: {dataset}, {traceback.format_exc()}"
        )
        return f"Failed to generate visualization: {dataset}, {traceback.format_exc()}"
    return resp_dict


@mcp.prompt()
async def generate_search_tako_prompt(text: str, ctx: Context) -> str:
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
    * Using the data provided by Tako, ground your answer. Use the `data_url` to get a URL to download the data.
    
    Step 3. Add visualizations from Step 1 to your answer.
    * Use the embed or image link provided by Tako to add visualizations to your answer.
    
    <UserInputText>
    {text}
    </UserInputText>
    """


@mcp.prompt()
async def generate_visualization_prompt(text: str, ctx: Context) -> str:
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
    elif ENVIRONMENT == "local":
        mcp.run(transport="stdio")
