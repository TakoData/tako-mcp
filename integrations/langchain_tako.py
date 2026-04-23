"""
LangChain / LangGraph integration for Tako's REST API.

Provides a ``TakoToolkit`` that exposes all eight Tako tools as LangChain-
compatible ``BaseTool`` instances.  Each tool communicates directly with
Tako's REST API (no MCP layer required), making this suitable for use in
LangChain agents, LangGraph workflows, or any framework that consumes
``BaseTool`` objects.

Quick start
-----------
::

    from langchain_tako import create_tako_tools

    tools = create_tako_tools(api_token="tak_...")
    # Pass *tools* to your LangChain agent or LangGraph node.

The only hard runtime dependency beyond the standard library is **httpx**.
LangChain classes (``BaseTool``, ``BaseToolkit``, ``BaseModel``) are imported
lazily so that the module can be installed without pulling in the full
``langchain-core`` package -- an ``ImportError`` with install instructions
is raised the first time a LangChain symbol is actually needed.
"""

from __future__ import annotations

import json
from typing import Any, Optional, Type

import httpx

# ---------------------------------------------------------------------------
# Lazy / optional LangChain imports
# ---------------------------------------------------------------------------

try:
    from langchain_core.tools import BaseTool, BaseToolkit
    from pydantic import BaseModel, Field
except ImportError as _exc:  # pragma: no cover
    raise ImportError(
        "The Tako LangChain integration requires 'langchain-core' and 'pydantic'. "
        "Install them with:\n\n"
        "  pip install langchain-core pydantic\n"
    ) from _exc


# ---------------------------------------------------------------------------
# Pydantic v2 input schemas
# ---------------------------------------------------------------------------


class KnowledgeSearchInput(BaseModel):
    """Input schema for the Tako knowledge search tool."""

    query: str = Field(
        ...,
        description=(
            "Natural language search query for charts and data "
            "(e.g. 'US GDP growth', 'Intel vs Nvidia revenue')."
        ),
    )
    count: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Number of results to return (1-20).",
    )
    search_effort: str = Field(
        default="deep",
        description="Search depth -- 'fast' for quick results, 'deep' for comprehensive search.",
    )
    country_code: str = Field(
        default="US",
        description="ISO country code for localized results (e.g. 'US', 'GB').",
    )
    locale: str = Field(
        default="en-US",
        description="Locale for results (e.g. 'en-US', 'en-GB').",
    )


class ExploreKnowledgeGraphInput(BaseModel):
    """Input schema for the Tako knowledge graph exploration tool."""

    query: str = Field(
        ...,
        description=(
            "Natural language query to explore "
            "(e.g. 'tech companies', 'GDP metrics', 'automotive industry')."
        ),
    )
    node_types: Optional[list[str]] = Field(
        default=None,
        description=(
            "Optional filter for specific node types. Accepted values: "
            "'entity', 'metric', 'cohort', 'db', 'units', 'time_period', 'property'."
        ),
    )
    limit: int = Field(
        default=20,
        ge=1,
        le=50,
        description="Maximum number of results per type (1-50).",
    )


class GetChartImageInput(BaseModel):
    """Input schema for retrieving a chart's static image URL."""

    pub_id: str = Field(
        ...,
        description="The unique identifier (pub_id / card_id) of the chart.",
    )
    dark_mode: bool = Field(
        default=True,
        description="Whether to return the dark-mode version of the image.",
    )


class GetInsightsInput(BaseModel):
    """Input schema for retrieving AI-generated chart insights."""

    pub_id: str = Field(
        ...,
        description="The unique identifier (pub_id / card_id) of the chart.",
    )
    effort: str = Field(
        default="medium",
        description=(
            "Reasoning effort level -- 'low' for a quick summary, "
            "'medium' for balanced analysis, 'high' for deep analysis."
        ),
    )


class ListSchemasInput(BaseModel):
    """Input schema for listing available chart schemas (no parameters required)."""

    pass


class GetSchemaInput(BaseModel):
    """Input schema for retrieving a specific chart schema definition."""

    schema_name: str = Field(
        ...,
        description=(
            "Name of the schema (e.g. 'bar_chart', 'pie_chart', "
            "'timeseries_card', 'scatter_chart', 'choropleth')."
        ),
    )


class CreateChartInput(BaseModel):
    """Input schema for creating a new chart from raw data."""

    schema_name: str = Field(
        ...,
        description=(
            "Name of the chart schema to use (e.g. 'bar_chart', "
            "'grouped_bar_chart', 'pie_chart', 'scatter_chart')."
        ),
    )
    components: list[dict[str, Any]] = Field(
        ...,
        description=(
            "List of component configurations matching the schema requirements. "
            "Each component needs 'component_type' and 'config' fields."
        ),
    )
    source: Optional[str] = Field(
        default=None,
        description="Optional attribution text (e.g. 'Yahoo Finance', 'Company Reports').",
    )


class OpenChartUIInput(BaseModel):
    """Input schema for generating an interactive chart embed URL."""

    pub_id: str = Field(
        ...,
        description="The unique identifier (pub_id / card_id) of the chart.",
    )
    dark_mode: bool = Field(
        default=True,
        description="Whether to use dark-mode theme.",
    )


# ---------------------------------------------------------------------------
# Helper: shared HTTP client logic
# ---------------------------------------------------------------------------


def _auth_headers(api_token: str) -> dict[str, str]:
    """Return default request headers including the API key."""
    return {
        "Content-Type": "application/json",
        "X-API-Key": api_token,
    }


async def _make_request(
    method: str,
    url: str,
    api_token: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, str] | None = None,
    timeout: float = 60.0,
) -> dict[str, Any] | str:
    """Execute an HTTP request and return the parsed JSON response.

    Raises a descriptive error string on failure so that the LLM receives
    actionable feedback rather than a raw traceback.
    """
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.request(
            method,
            url,
            headers=_auth_headers(api_token),
            json=json_body,
            params=params,
        )
        response.raise_for_status()
        return response.json()


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


class TakoSearchTool(BaseTool):
    """Search Tako's curated knowledge base of charts and data visualizations."""

    name: str = "tako_search"
    description: str = (
        "Use this when you need to find existing charts and data visualizations on "
        "any topic. Searches Tako's knowledge base covering economics, finance, "
        "demographics, technology, and more. Start here when a user asks about data "
        "trends, comparisons, or statistics."
    )
    args_schema: Type[BaseModel] = KnowledgeSearchInput

    api_token: str
    api_url: str = "https://api.tako.com"

    async def _arun(
        self,
        query: str,
        count: int = 5,
        search_effort: str = "deep",
        country_code: str = "US",
        locale: str = "en-US",
        **kwargs: Any,
    ) -> str:
        """Execute an async knowledge search against the Tako API."""
        try:
            data = await _make_request(
                "POST",
                f"{self.api_url}/api/v1/knowledge_search",
                self.api_token,
                json_body={
                    "inputs": {"text": query, "count": count},
                    "source_indexes": ["tako"],
                    "search_effort": search_effort,
                    "country_code": country_code,
                    "locale": locale,
                },
            )
            cards = data.get("outputs", {}).get("knowledge_cards", [])
            results = []
            for card in cards:
                card_id = card.get("card_id")
                result: dict[str, Any] = {
                    "card_id": card_id,
                    "title": card.get("title"),
                    "description": card.get("description"),
                    "url": card.get("url"),
                    "source": card.get("source"),
                }
                if card_id:
                    result["embed_url"] = f"https://tako.com/embed/{card_id}/?theme=dark"
                results.append(result)
            return json.dumps({"results": results, "count": len(results)}, indent=2)
        except httpx.HTTPStatusError as exc:
            return json.dumps(
                {"error": f"HTTP {exc.response.status_code}", "message": str(exc)}
            )
        except httpx.TimeoutException:
            return json.dumps(
                {
                    "error": "Request timed out",
                    "suggestion": "Try search_effort='fast' or a more specific query.",
                }
            )

    def _run(
        self,
        query: str,
        count: int = 5,
        search_effort: str = "deep",
        country_code: str = "US",
        locale: str = "en-US",
        **kwargs: Any,
    ) -> str:
        """Synchronous fallback -- delegates to the async implementation."""
        import asyncio

        return asyncio.run(
            self._arun(
                query=query,
                count=count,
                search_effort=search_effort,
                country_code=country_code,
                locale=locale,
            )
        )


class TakoExploreKnowledgeGraphTool(BaseTool):
    """Explore Tako's knowledge graph to discover available data."""

    name: str = "tako_explore_knowledge_graph"
    description: str = (
        "Use this when you need to discover what data is available before searching. "
        "Helps find entities (companies, countries), metrics (revenue, GDP), cohorts "
        "(S&P 500, G7), and time periods. Use to disambiguate queries or understand "
        "what data Tako has before calling tako_search."
    )
    args_schema: Type[BaseModel] = ExploreKnowledgeGraphInput

    api_token: str
    api_url: str = "https://api.tako.com"

    async def _arun(
        self,
        query: str,
        node_types: Optional[list[str]] = None,
        limit: int = 20,
        **kwargs: Any,
    ) -> str:
        """Execute an async knowledge graph exploration."""
        try:
            data = await _make_request(
                "POST",
                f"{self.api_url}/api/v1/explore/",
                self.api_token,
                json_body={
                    "query": query,
                    "node_types": node_types,
                    "limit": limit,
                },
            )
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
        except httpx.HTTPStatusError as exc:
            return json.dumps(
                {"error": f"HTTP {exc.response.status_code}", "message": str(exc)}
            )
        except httpx.TimeoutException:
            return json.dumps(
                {
                    "error": "Request timed out",
                    "suggestion": "Try a more specific query or filter by node_types.",
                }
            )

    def _run(
        self,
        query: str,
        node_types: Optional[list[str]] = None,
        limit: int = 20,
        **kwargs: Any,
    ) -> str:
        """Synchronous fallback."""
        import asyncio

        return asyncio.run(
            self._arun(query=query, node_types=node_types, limit=limit)
        )


class TakoGetChartImageTool(BaseTool):
    """Retrieve a static preview image URL for a Tako chart."""

    name: str = "tako_get_chart_image"
    description: str = (
        "Use this when you need a static PNG preview image of a chart to display or "
        "embed. Returns a direct URL to a PNG image of the chart."
    )
    args_schema: Type[BaseModel] = GetChartImageInput

    api_token: str
    api_url: str = "https://api.tako.com"

    async def _arun(
        self,
        pub_id: str,
        dark_mode: bool = True,
        **kwargs: Any,
    ) -> str:
        """Fetch the chart image endpoint and return the public image URL."""
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.get(
                    f"{self.api_url}/api/v1/image/{pub_id}/",
                    params={"dark_mode": str(dark_mode).lower()},
                    headers=_auth_headers(self.api_token),
                )
                if resp.status_code == 200:
                    image_url = (
                        f"{self.api_url}/api/v1/image/{pub_id}/"
                        f"?dark_mode={str(dark_mode).lower()}"
                    )
                    return json.dumps(
                        {
                            "image_url": image_url,
                            "pub_id": pub_id,
                            "dark_mode": dark_mode,
                        },
                        indent=2,
                    )
                elif resp.status_code == 404:
                    return json.dumps(
                        {
                            "error": "Chart image not found",
                            "pub_id": pub_id,
                            "suggestion": "Verify the pub_id is correct. Use tako_search to find valid chart IDs.",
                        }
                    )
                else:
                    resp.raise_for_status()
                    return json.dumps({"error": "Unexpected response"})
        except httpx.HTTPStatusError as exc:
            return json.dumps(
                {"error": f"HTTP {exc.response.status_code}", "message": str(exc)}
            )

    def _run(self, pub_id: str, dark_mode: bool = True, **kwargs: Any) -> str:
        """Synchronous fallback."""
        import asyncio

        return asyncio.run(
            self._arun(pub_id=pub_id, dark_mode=dark_mode)
        )


class TakoGetInsightsTool(BaseTool):
    """Get AI-generated insights and analysis for a Tako chart."""

    name: str = "tako_get_insights"
    description: str = (
        "Use this when you want AI-generated analysis of a chart's data. Returns "
        "bullet-point insights and a natural language description summarizing trends, "
        "outliers, and key takeaways from the chart."
    )
    args_schema: Type[BaseModel] = GetInsightsInput

    api_token: str
    api_url: str = "https://api.tako.com"

    async def _arun(
        self,
        pub_id: str,
        effort: str = "medium",
        **kwargs: Any,
    ) -> str:
        """Fetch AI-generated insights for a chart."""
        try:
            data = await _make_request(
                "GET",
                f"{self.api_url}/api/v1/internal/chart-configs/{pub_id}/chart-insights/",
                self.api_token,
                params={"effort": effort},
                timeout=90.0,
            )
            return json.dumps(
                {
                    "pub_id": pub_id,
                    "insights": data.get("insights", ""),
                    "description": data.get("description", ""),
                },
                indent=2,
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return json.dumps(
                    {
                        "error": "Chart not found",
                        "pub_id": pub_id,
                        "suggestion": "Verify the pub_id is correct. Use tako_search to find valid chart IDs.",
                    }
                )
            return json.dumps(
                {"error": f"HTTP {exc.response.status_code}", "message": str(exc)}
            )

    def _run(self, pub_id: str, effort: str = "medium", **kwargs: Any) -> str:
        """Synchronous fallback."""
        import asyncio

        return asyncio.run(
            self._arun(pub_id=pub_id, effort=effort)
        )


class TakoListSchemasTool(BaseTool):
    """List all available chart schemas (templates) for creating custom visualizations."""

    name: str = "tako_list_schemas"
    description: str = (
        "Use this when you want to see all available chart templates before creating "
        "a custom chart. Returns the full list of ThinViz schemas including timeseries, "
        "bar charts, pie charts, scatter plots, maps, and more."
    )
    args_schema: Type[BaseModel] = ListSchemasInput

    api_token: str
    api_url: str = "https://api.tako.com"

    async def _arun(self, **kwargs: Any) -> str:
        """Fetch the list of available chart schemas."""
        try:
            schemas = await _make_request(
                "GET",
                f"{self.api_url}/api/v1/thin_viz/default_schema/",
                self.api_token,
                timeout=30.0,
            )
            result = []
            for schema in schemas:
                result.append(
                    {
                        "name": schema.get("name"),
                        "description": schema.get("description"),
                        "components": schema.get("components", []),
                    }
                )
            return json.dumps({"schemas": result, "count": len(result)}, indent=2)
        except httpx.HTTPStatusError as exc:
            return json.dumps(
                {"error": f"HTTP {exc.response.status_code}", "message": str(exc)}
            )

    def _run(self, **kwargs: Any) -> str:
        """Synchronous fallback."""
        import asyncio

        return asyncio.run(self._arun())


class TakoGetSchemaTool(BaseTool):
    """Get the detailed schema definition for a specific chart type."""

    name: str = "tako_get_schema"
    description: str = (
        "Use this when you need to understand the exact data format required for a "
        "specific chart type. Returns the schema definition including required fields, "
        "data structure, and configuration options. Always call this before "
        "tako_create_chart to understand what data is needed."
    )
    args_schema: Type[BaseModel] = GetSchemaInput

    api_token: str
    api_url: str = "https://api.tako.com"

    async def _arun(self, schema_name: str, **kwargs: Any) -> str:
        """Fetch the detailed schema for a given chart type."""
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    f"{self.api_url}/api/v1/thin_viz/default_schema/{schema_name}/",
                    headers=_auth_headers(self.api_token),
                )
                if resp.status_code == 404:
                    return json.dumps(
                        {
                            "error": f"Schema '{schema_name}' not found",
                            "suggestion": "Use tako_list_schemas to see all available schema names.",
                        }
                    )
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
            return json.dumps(
                {"error": f"HTTP {exc.response.status_code}", "message": str(exc)}
            )

    def _run(self, schema_name: str, **kwargs: Any) -> str:
        """Synchronous fallback."""
        import asyncio

        return asyncio.run(
            self._arun(schema_name=schema_name)
        )


class TakoCreateChartTool(BaseTool):
    """Create a new interactive Tako chart from raw data."""

    name: str = "tako_create_chart"
    description: str = (
        "Use this when you need to create a new chart from raw data. Pass a schema "
        "name and your data components to generate an interactive Tako visualization. "
        "Supports 15+ chart types including timeseries, bar charts, scatter plots, "
        "maps, and more. Call tako_list_schemas and tako_get_schema first to understand "
        "the required data format."
    )
    args_schema: Type[BaseModel] = CreateChartInput

    api_token: str
    api_url: str = "https://api.tako.com"

    async def _arun(
        self,
        schema_name: str,
        components: list[dict[str, Any]],
        source: Optional[str] = None,
        **kwargs: Any,
    ) -> str:
        """Create a chart via the ThinViz API."""
        try:
            payload: dict[str, Any] = {"components": components}
            if source:
                payload["source"] = source

            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{self.api_url}/api/v1/thin_viz/default_schema/{schema_name}/create/",
                    json=payload,
                    headers=_auth_headers(self.api_token),
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
                            "suggestion": "Use tako_get_schema to see the required data format.",
                        }
                    )
                resp.raise_for_status()
                data = resp.json()

                card_id = data.get("card_id")
                result: dict[str, Any] = {
                    "card_id": card_id,
                    "title": data.get("title"),
                    "description": data.get("description"),
                    "webpage_url": data.get("webpage_url"),
                    "embed_url": data.get("embed_url"),
                    "image_url": data.get("image_url"),
                }
                if card_id:
                    result["interactive_url"] = (
                        f"https://tako.com/embed/{card_id}/?theme=dark"
                    )
                return json.dumps(result, indent=2)

        except httpx.HTTPStatusError as exc:
            return json.dumps(
                {"error": f"HTTP {exc.response.status_code}", "message": str(exc)}
            )

    def _run(
        self,
        schema_name: str,
        components: list[dict[str, Any]],
        source: Optional[str] = None,
        **kwargs: Any,
    ) -> str:
        """Synchronous fallback."""
        import asyncio

        return asyncio.run(
            self._arun(schema_name=schema_name, components=components, source=source)
        )


class TakoOpenChartUITool(BaseTool):
    """Generate an interactive embed URL for a Tako chart (no API call needed)."""

    name: str = "tako_open_chart_ui"
    description: str = (
        "Use this when you want to display a fully interactive chart to the user. "
        "Returns an embed URL for the chart with zooming, panning, and hover "
        "interactions. No API call is made -- the URL is constructed locally."
    )
    args_schema: Type[BaseModel] = OpenChartUIInput

    api_token: str = ""  # Not required -- no API call is made.
    api_url: str = "https://api.tako.com"  # Unused, kept for interface consistency.

    async def _arun(
        self,
        pub_id: str,
        dark_mode: bool = True,
        **kwargs: Any,
    ) -> str:
        """Return the Tako embed URL for the given chart."""
        theme = "dark" if dark_mode else "light"
        embed_url = f"https://tako.com/embed/{pub_id}/?theme={theme}"
        return json.dumps(
            {
                "pub_id": pub_id,
                "embed_url": embed_url,
                "dark_mode": dark_mode,
            },
            indent=2,
        )

    def _run(
        self,
        pub_id: str,
        dark_mode: bool = True,
        **kwargs: Any,
    ) -> str:
        """Synchronous implementation (no I/O required)."""
        theme = "dark" if dark_mode else "light"
        embed_url = f"https://tako.com/embed/{pub_id}/?theme={theme}"
        return json.dumps(
            {
                "pub_id": pub_id,
                "embed_url": embed_url,
                "dark_mode": dark_mode,
            },
            indent=2,
        )


# ---------------------------------------------------------------------------
# TakoToolkit -- aggregates all eight tools
# ---------------------------------------------------------------------------


class TakoToolkit(BaseToolkit):
    """LangChain-compatible toolkit that provides all eight Tako tools.

    Parameters
    ----------
    api_token : str
        Tako API token used for authentication (sent as ``X-API-Key`` header).
    api_url : str, optional
        Base URL for the Tako REST API.  Defaults to ``https://api.tako.com``.

    Usage
    -----
    ::

        from langchain_tako import TakoToolkit

        toolkit = TakoToolkit(api_token="tak_...")
        tools = toolkit.get_tools()
    """

    api_token: str = Field(..., description="Tako API token for authentication.")
    api_url: str = Field(
        default="https://api.tako.com",
        description="Base URL for the Tako REST API.",
    )

    def get_tools(self) -> list[BaseTool]:
        """Return all eight Tako tools configured with the toolkit's credentials."""
        common = {"api_token": self.api_token, "api_url": self.api_url}
        return [
            TakoSearchTool(**common),
            TakoExploreKnowledgeGraphTool(**common),
            TakoGetChartImageTool(**common),
            TakoGetInsightsTool(**common),
            TakoListSchemasTool(**common),
            TakoGetSchemaTool(**common),
            TakoCreateChartTool(**common),
            TakoOpenChartUITool(**common),
        ]


# ---------------------------------------------------------------------------
# Convenience factory function
# ---------------------------------------------------------------------------


def create_tako_tools(
    api_token: str,
    api_url: str = "https://api.tako.com",
) -> list[BaseTool]:
    """Create and return all eight Tako LangChain tools.

    This is a shorthand for ``TakoToolkit(api_token=...).get_tools()``.

    Parameters
    ----------
    api_token : str
        Tako API token (sent as the ``X-API-Key`` header on every request).
    api_url : str, optional
        Base URL for the Tako REST API.  Defaults to ``https://api.tako.com``.

    Returns
    -------
    list[BaseTool]
        A list of eight ``BaseTool`` instances -- one for each Tako capability.
    """
    toolkit = TakoToolkit(api_token=api_token, api_url=api_url)
    return toolkit.get_tools()
