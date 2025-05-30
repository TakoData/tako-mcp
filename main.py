import logging
import os
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
                KnowledgeSearchSourceIndex.WEB
            ]
        )
    except Exception:
        logging.error(f"Failed to search Tako: {text}, {traceback.format_exc()}")
        return "No card found"
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
        logging.error(f"Failed to generate visualization: {dataset}, {traceback.format_exc()}")
        return f"Failed to generate visualization: {dataset}, {traceback.format_exc()}"
    return response.model_dump()
    
@mcp.tool()
async def get_current_stock_price(symbol: str) -> str:
    """
    Use this function to get the current stock price for a given symbol.

    Args:
        symbol (str): The stock symbol.

    Returns:
        str: The current stock price or error message.
    """
    try:
        query = f"current stock price for {symbol}"
        result = await search_tako(query)
        return result.model_dump()
    except Exception as e:
        return f"Error fetching current price for {symbol}: {e}"

@mcp.tool()
async def get_historical_stock_prices(symbol: str, period: str = "1mo", interval: str = "1d") -> str:
    """
    Use this function to get the historical stock price for a given symbol.

    Args:
        symbol (str): The stock symbol.
        period (str): The period for which to retrieve historical prices. Defaults to "1mo".
                      Valid periods: 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max
        interval (str): The interval between data points. Defaults to "1d".
                        Valid intervals: 1d,5d,1wk,1mo,3mo

    Returns:
        str: The historical stock price or error message.
    """
    try:
        query = f"historical stock price for {symbol} over the past {period}"
        result = await search_tako(query)
        return result.model_dump()
    except Exception as e:
        return f"Error fetching historical prices for {symbol}: {e}"

if __name__ == "__main__":
    if ENVIRONMENT == "remote":
        mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")
