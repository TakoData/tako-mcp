"""
Tako integration for CrewAI.

Provides CrewAI-compatible tools that wrap the Tako API, enabling agents
in CrewAI pipelines to search for charts, create visualizations, list
available chart schemas, and retrieve AI-generated chart insights.

Usage:
    from integrations.crewai_tako import create_tako_tools

    tools = create_tako_tools(api_token="your-tako-api-token")
    agent = Agent(role="Data Analyst", tools=tools, ...)
"""

from __future__ import annotations

import json
from typing import Any, Optional

try:
    from crewai.tools import BaseTool
except ImportError:
    raise ImportError(
        "CrewAI is required for this integration. "
        "Install it with: pip install crewai"
    )

try:
    import httpx
except ImportError:
    raise ImportError(
        "httpx is required for this integration. "
        "Install it with: pip install httpx"
    )

DEFAULT_API_URL = "https://api.tako.com"


def _headers(api_token: str) -> dict[str, str]:
    """Build request headers with Tako API authentication."""
    return {
        "Content-Type": "application/json",
        "X-API-Key": api_token,
    }


def _error_response(error: str, message: str, suggestion: str) -> str:
    """Return a standardised JSON error string."""
    return json.dumps(
        {"error": error, "message": message, "suggestion": suggestion},
        indent=2,
    )


# ---------------------------------------------------------------------------
# Tool: Knowledge Search
# ---------------------------------------------------------------------------

class TakoSearchTool(BaseTool):
    """Search Tako's knowledge base for charts and data visualisations."""

    name: str = "tako_search"
    description: str = (
        "Use this when you need to find existing charts and data visualizations on "
        "any topic. Searches Tako's curated knowledge base of charts covering "
        "economics, finance, demographics, technology, and more. Returns matching "
        "charts with titles, descriptions, URLs, and source information."
    )

    api_token: str
    api_url: str = DEFAULT_API_URL

    def _run(
        self,
        query: str,
        count: int = 5,
        search_effort: str = "deep",
        country_code: str = "US",
        locale: str = "en-US",
    ) -> str:
        """
        Search for charts and data visualisations.

        Args:
            query: Natural language search query (e.g. "US GDP growth",
                   "Intel vs Nvidia revenue").
            count: Number of results to return (1-20).
            search_effort: "fast" for quick results or "deep" for comprehensive.
            country_code: ISO country code for localised results (e.g. "US").
            locale: Locale string (e.g. "en-US").

        Returns:
            JSON string with matching charts.
        """
        try:
            with httpx.Client(timeout=60.0, follow_redirects=True) as client:
                resp = client.post(
                    f"{self.api_url.rstrip('/')}/api/v1/knowledge_search",
                    json={
                        "inputs": {
                            "text": query,
                            "count": count,
                        },
                        "source_indexes": ["tako"],
                        "search_effort": search_effort,
                        "country_code": country_code,
                        "locale": locale,
                    },
                    headers=_headers(self.api_token),
                )
                resp.raise_for_status()

                data = resp.json()
                cards = data.get("outputs", {}).get("knowledge_cards", [])

                results = []
                for card in cards:
                    results.append(
                        {
                            "card_id": card.get("card_id"),
                            "title": card.get("title"),
                            "description": card.get("description"),
                            "url": card.get("url"),
                            "source": card.get("source"),
                        }
                    )

                return json.dumps(
                    {"results": results, "count": len(results)},
                    indent=2,
                )

        except httpx.TimeoutException:
            return _error_response(
                "Request timed out",
                "The search request took too long.",
                "Try using search_effort='fast' or a more specific query.",
            )
        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token is valid and try again.",
            )


# ---------------------------------------------------------------------------
# Tool: Create Chart
# ---------------------------------------------------------------------------

class TakoCreateChartTool(BaseTool):
    """Create a new chart on Tako from raw data."""

    name: str = "tako_create_chart"
    description: str = (
        "Use this when you need to create a new chart from raw data. Pass a schema "
        "name and component configurations to generate an interactive Tako "
        "visualisation. Supports 15+ chart types including timeseries, bar charts, "
        "scatter plots, maps, and more. Call tako_list_schemas first to see "
        "available chart types."
    )

    api_token: str
    api_url: str = DEFAULT_API_URL

    def _run(
        self,
        schema_name: str,
        components: list[dict[str, Any]],
        source: Optional[str] = None,
    ) -> str:
        """
        Create a chart from a schema template and data components.

        Args:
            schema_name: Chart schema (e.g. "bar_chart", "timeseries_card",
                         "pie_chart", "scatter_chart", "choropleth").
            components: List of component dicts, each with "component_type"
                        and "config" keys.
            source: Optional attribution text (e.g. "Yahoo Finance").

        Returns:
            JSON string with card_id, title, URLs, etc.
        """
        try:
            payload: dict[str, Any] = {"components": components}
            if source:
                payload["source"] = source

            with httpx.Client(timeout=60.0) as client:
                resp = client.post(
                    f"{self.api_url.rstrip('/')}/api/v1/thin_viz/default_schema/{schema_name}/create/",
                    json=payload,
                    headers=_headers(self.api_token),
                )

                if resp.status_code == 404:
                    return json.dumps(
                        {
                            "error": f"Schema '{schema_name}' not found",
                            "suggestion": "Use tako_list_schemas to see available schema names.",
                        }
                    )
                if resp.status_code == 400:
                    return json.dumps(
                        {
                            "error": "Invalid component configuration",
                            "details": resp.json(),
                            "suggestion": "Verify the component structure matches the schema.",
                        }
                    )

                resp.raise_for_status()
                data = resp.json()

                return json.dumps(
                    {
                        "card_id": data.get("card_id"),
                        "title": data.get("title"),
                        "description": data.get("description"),
                        "webpage_url": data.get("webpage_url"),
                        "embed_url": data.get("embed_url"),
                        "image_url": data.get("image_url"),
                    },
                    indent=2,
                )

        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token and component configuration.",
            )


# ---------------------------------------------------------------------------
# Tool: List Schemas
# ---------------------------------------------------------------------------

class TakoListSchemasTool(BaseTool):
    """List all available chart schemas (templates) on Tako."""

    name: str = "tako_list_schemas"
    description: str = (
        "Use this when you want to see all available chart templates before "
        "creating a custom chart. Returns the full list of Tako chart schemas "
        "including timeseries, bar charts, pie charts, scatter plots, maps, and "
        "more. Call this first when the user wants to create a new visualisation."
    )

    api_token: str
    api_url: str = DEFAULT_API_URL

    def _run(self) -> str:
        """
        List available chart schemas.

        Returns:
            JSON string with an array of schemas and their descriptions.
        """
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(
                    f"{self.api_url.rstrip('/')}/api/v1/thin_viz/default_schema/",
                    headers=_headers(self.api_token),
                )
                resp.raise_for_status()
                schemas = resp.json()

                result = []
                for schema in schemas:
                    result.append(
                        {
                            "name": schema.get("name"),
                            "description": schema.get("description"),
                            "components": schema.get("components", []),
                        }
                    )

                return json.dumps(
                    {"schemas": result, "count": len(result)},
                    indent=2,
                )

        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token is valid and try again.",
            )


# ---------------------------------------------------------------------------
# Tool: Get Insights
# ---------------------------------------------------------------------------

class TakoGetInsightsTool(BaseTool):
    """Get AI-generated insights for a Tako chart."""

    name: str = "tako_get_insights"
    description: str = (
        "Use this when you want AI-generated analysis of a chart's data. Returns "
        "bullet-point insights and a natural language description summarising "
        "trends, outliers, and key takeaways from the chart."
    )

    api_token: str
    api_url: str = DEFAULT_API_URL

    def _run(
        self,
        pub_id: str,
        effort: str = "medium",
    ) -> str:
        """
        Retrieve AI-generated insights for a chart.

        Args:
            pub_id: The unique identifier (pub_id / card_id) of the chart.
            effort: Reasoning depth - "low", "medium", or "high".

        Returns:
            JSON string with insights and description.
        """
        try:
            with httpx.Client(timeout=90.0) as client:
                resp = client.get(
                    f"{self.api_url.rstrip('/')}/api/v1/internal/chart-configs/{pub_id}/chart-insights/",
                    params={"effort": effort},
                    headers=_headers(self.api_token),
                )

                if resp.status_code == 404:
                    return json.dumps(
                        {
                            "error": "Chart not found",
                            "pub_id": pub_id,
                            "suggestion": "Verify the pub_id/card_id is correct.",
                        }
                    )

                resp.raise_for_status()
                data = resp.json()

                return json.dumps(
                    {
                        "pub_id": pub_id,
                        "insights": data.get("insights", ""),
                        "description": data.get("description", ""),
                    },
                    indent=2,
                )

        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token and pub_id, then try again.",
            )


# ---------------------------------------------------------------------------
# Tool: Explore Knowledge Graph
# ---------------------------------------------------------------------------

class TakoExploreKnowledgeGraphTool(BaseTool):
    """Explore Tako's knowledge graph to discover available data."""

    name: str = "tako_explore_knowledge_graph"
    description: str = (
        "Use this when you need to discover what data is available before searching. "
        "Helps find entities (companies, countries), metrics (revenue, GDP), cohorts "
        "(S&P 500, G7), and time periods. Use to disambiguate queries or understand "
        "what data Tako has before calling tako_search."
    )

    api_token: str
    api_url: str = DEFAULT_API_URL

    def _run(
        self,
        query: str,
        node_types: Optional[list[str]] = None,
        limit: int = 20,
    ) -> str:
        try:
            with httpx.Client(timeout=60.0, follow_redirects=True) as client:
                resp = client.post(
                    f"{self.api_url.rstrip('/')}/api/v1/explore/",
                    json={
                        "query": query,
                        "node_types": node_types,
                        "limit": limit,
                    },
                    headers=_headers(self.api_token),
                )
                resp.raise_for_status()
                data = resp.json()
                return json.dumps(
                    {
                        "query": data.get("query"),
                        "total_matches": data.get("total_matches", 0),
                        "entities": data.get("entities", []),
                        "metrics": data.get("metrics", []),
                        "cohorts": data.get("cohorts", []),
                        "time_periods": data.get("time_periods", []),
                    },
                    indent=2,
                )
        except httpx.TimeoutException:
            return _error_response(
                "Request timed out",
                "The exploration request took too long.",
                "Try a more specific query or filter by node_types.",
            )
        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token is valid and try again.",
            )


# ---------------------------------------------------------------------------
# Tool: Get Chart Image
# ---------------------------------------------------------------------------

class TakoGetChartImageTool(BaseTool):
    """Get a static PNG preview image URL for a Tako chart."""

    name: str = "tako_get_chart_image"
    description: str = (
        "Use this when you need a static PNG preview image of a chart to display or "
        "embed. Returns a direct URL to a PNG image of the chart."
    )

    api_token: str
    api_url: str = DEFAULT_API_URL

    def _run(
        self,
        pub_id: str,
        dark_mode: bool = True,
    ) -> str:
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.get(
                    f"{self.api_url.rstrip('/')}/api/v1/image/{pub_id}/",
                    params={"dark_mode": str(dark_mode).lower()},
                    headers=_headers(self.api_token),
                )
                if resp.status_code == 200:
                    image_url = (
                        f"{self.api_url.rstrip('/')}/api/v1/image/{pub_id}/"
                        f"?dark_mode={str(dark_mode).lower()}"
                    )
                    return json.dumps(
                        {"image_url": image_url, "pub_id": pub_id, "dark_mode": dark_mode},
                        indent=2,
                    )
                elif resp.status_code == 404:
                    return json.dumps({
                        "error": "Chart image not found",
                        "pub_id": pub_id,
                        "suggestion": "Verify the pub_id/card_id is correct.",
                    })
                else:
                    resp.raise_for_status()
                    return json.dumps({"error": "Unexpected error"})
        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token and try again.",
            )


# ---------------------------------------------------------------------------
# Tool: Get Chart Schema
# ---------------------------------------------------------------------------

class TakoGetSchemaTool(BaseTool):
    """Get the detailed schema definition for a specific chart type."""

    name: str = "tako_get_schema"
    description: str = (
        "Use this when you need to understand the exact data format required for a "
        "specific chart type. Returns the schema definition including required fields "
        "and configuration options. Always call this before tako_create_chart."
    )

    api_token: str
    api_url: str = DEFAULT_API_URL

    def _run(self, schema_name: str) -> str:
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(
                    f"{self.api_url.rstrip('/')}/api/v1/thin_viz/default_schema/{schema_name}/",
                    headers=_headers(self.api_token),
                )
                if resp.status_code == 404:
                    return json.dumps({
                        "error": f"Schema '{schema_name}' not found",
                        "suggestion": "Use tako_list_schemas to see available schema names.",
                    })
                resp.raise_for_status()
                schema = resp.json()
                return json.dumps(
                    {
                        "name": schema.get("name"),
                        "description": schema.get("description"),
                        "components": schema.get("components", []),
                        "template": schema.get("template"),
                    },
                    indent=2,
                )
        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token is valid and try again.",
            )


# ---------------------------------------------------------------------------
# Tool: Open Chart UI
# ---------------------------------------------------------------------------

class TakoOpenChartUITool(BaseTool):
    """Generate an interactive embed URL for a Tako chart."""

    name: str = "tako_open_chart_ui"
    description: str = (
        "Use this when you want to display a fully interactive chart to the user. "
        "Returns an embed URL for the chart with zooming, panning, and hover "
        "interactions. No API call is made — the URL is constructed locally."
    )

    api_token: str = ""
    api_url: str = DEFAULT_API_URL

    def _run(
        self,
        pub_id: str,
        dark_mode: bool = True,
    ) -> str:
        theme = "dark" if dark_mode else "light"
        embed_url = f"https://tako.com/embed/{pub_id}/?theme={theme}"
        return json.dumps(
            {"pub_id": pub_id, "embed_url": embed_url, "dark_mode": dark_mode},
            indent=2,
        )


# ---------------------------------------------------------------------------
# Convenience factory
# ---------------------------------------------------------------------------

def create_tako_tools(
    api_token: str,
    api_url: str = DEFAULT_API_URL,
) -> list[BaseTool]:
    """
    Create all Tako tools for use in a CrewAI agent.

    Args:
        api_token: Your Tako API token (from https://tako.com account settings).
        api_url: Base URL for the Tako API. Defaults to https://api.tako.com.

    Returns:
        A list of CrewAI BaseTool instances ready to pass to an Agent.

    Example:
        from crewai import Agent
        from integrations.crewai_tako import create_tako_tools

        tools = create_tako_tools(api_token="tak_...")
        analyst = Agent(
            role="Data Analyst",
            goal="Find and visualise data trends",
            tools=tools,
        )
    """
    kwargs = {"api_token": api_token, "api_url": api_url}
    return [
        TakoSearchTool(**kwargs),
        TakoExploreKnowledgeGraphTool(**kwargs),
        TakoGetChartImageTool(**kwargs),
        TakoGetInsightsTool(**kwargs),
        TakoListSchemasTool(**kwargs),
        TakoGetSchemaTool(**kwargs),
        TakoCreateChartTool(**kwargs),
        TakoOpenChartUITool(**kwargs),
    ]
