import os

from tako.client import TakoClient, KnowledgeSearchSourceIndex
from mcp.server.fastmcp import FastMCP

TAKO_API_KEY = os.getenv("TAKO_API_KEY")
ENVIRONMENT = os.getenv("ENVIRONMENT", "local")


# Initialize MCP Server and Tako Client
mcp = FastMCP("tako", port=8001)
tako_client = TakoClient(api_key=TAKO_API_KEY)

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

if __name__ == "__main__":
    if ENVIRONMENT == "remote":
        mcp.run(transport="sse")
    else:
        mcp.run(transport="stdio")