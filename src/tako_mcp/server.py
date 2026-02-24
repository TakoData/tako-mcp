"""
Tako MCP Server

Exposes Tako's knowledge base and interactive charts via the Model Context Protocol (MCP).

This server allows AI agents to:
- Search for relevant charts and datasets
- Fetch chart preview images and AI-generated insights
- Create custom charts from raw data using 15+ chart types
- Render fully interactive Tako visualizations via MCP-UI
"""

import html
import json
import logging
import os
import re
import sys
import time
import urllib.parse
from typing import Any

import httpx
from anyio import ClosedResourceError
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp_ui_server import UIMetadataKey, create_ui_resource
from mcp_ui_server.core import UIResource
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse, PlainTextResponse

# Suppress noisy logs from dependencies
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
logging.getLogger("starlette.middleware").setLevel(logging.WARNING)

# Configuration from environment
TAKO_API_URL = os.environ.get("TAKO_API_URL", "https://api.tako.com").rstrip("/")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://tako.com").rstrip("/")
# Public-facing API URL for external consumers (image URLs, etc.)
# Falls back to TAKO_API_URL if not set separately
PUBLIC_API_URL = os.environ.get("PUBLIC_API_URL", TAKO_API_URL).rstrip("/")

SERVER_VERSION = "0.1.0"

# Build allowed hosts list for DNS rebinding protection
allowed_hosts_list = [
    "localhost:*",
    "127.0.0.1:*",
]

# Add environment-specific hosts if provided
mcp_allowed_hosts = os.environ.get("MCP_ALLOWED_HOSTS", "")
if mcp_allowed_hosts:
    allowed_hosts_list.extend(mcp_allowed_hosts.split(","))

# Allow disabling DNS rebinding protection for development
enable_dns_rebinding = os.environ.get("MCP_ENABLE_DNS_REBINDING", "true").lower() == "true"

mcp = FastMCP(
    "tako-knowledge",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=enable_dns_rebinding,
        allowed_hosts=allowed_hosts_list,
        allowed_origins=[
            "http://localhost:*",
            "https://tako.com",
        ],
    ),
)


# =============================================================================
# Structured output models (MCP structuredContent)
# =============================================================================


class SearchResultItem(BaseModel):
    """A single chart result from a knowledge search."""

    card_id: str | None = Field(default=None, description="Unique chart identifier")
    title: str | None = Field(default=None, description="Chart title")
    description: str | None = Field(default=None, description="Chart description")
    url: str | None = Field(default=None, description="Chart URL on Tako")
    source: str | None = Field(default=None, description="Data source attribution")
    open_ui_tool: str | None = Field(
        default=None, description="Tool name to open interactive chart"
    )
    open_ui_args: dict[str, Any] | None = Field(
        default=None, description="Arguments for open_chart_ui tool"
    )


class SearchResults(BaseModel):
    """Results from a knowledge search query."""

    results: list[SearchResultItem] = Field(description="List of matching charts")
    count: int = Field(description="Number of results returned")


class ChartImageResult(BaseModel):
    """Result from getting a chart preview image."""

    image_url: str = Field(description="Public URL to the PNG chart image")
    pub_id: str = Field(description="Chart identifier")
    dark_mode: bool = Field(description="Whether dark mode was used")


class ChartInsightsResult(BaseModel):
    """AI-generated insights for a chart."""

    pub_id: str = Field(description="Chart identifier")
    insights: str = Field(description="Bullet-point analysis of chart data")
    description: str = Field(description="Narrative summary of the chart")


class EntityResult(BaseModel):
    """An entity from the knowledge graph."""

    name: str | None = Field(default=None, description="Entity name")
    type: str | None = Field(default=None, description="Entity type")
    description: str | None = Field(default=None, description="Entity description")
    aliases: list[str] = Field(default_factory=list, description="Alternative names")
    available_tables: list[str] = Field(
        default_factory=list, description="Related data tables"
    )
    node_id: str | None = Field(default=None, description="Knowledge graph node ID")


class MetricResult(BaseModel):
    """A metric from the knowledge graph."""

    name: str | None = Field(default=None, description="Metric name")
    description: str | None = Field(default=None, description="Metric description")
    units: list[str] = Field(default_factory=list, description="Measurement units")
    time_periods: list[str] = Field(
        default_factory=list, description="Available time granularities"
    )
    compatible_tables: list[str] = Field(
        default_factory=list, description="Compatible data tables"
    )
    node_id: str | None = Field(default=None, description="Knowledge graph node ID")


class CohortResult(BaseModel):
    """A cohort/group from the knowledge graph."""

    name: str | None = Field(default=None, description="Cohort name")
    description: str | None = Field(default=None, description="Cohort description")
    member_count: int | None = Field(
        default=None, description="Number of members in the cohort"
    )
    sample_members: list[str] = Field(
        default_factory=list, description="Example members"
    )
    node_id: str | None = Field(default=None, description="Knowledge graph node ID")


class KnowledgeGraphResult(BaseModel):
    """Results from exploring the knowledge graph."""

    query: str | None = Field(default=None, description="Original query")
    total_matches: int = Field(default=0, description="Total number of matches")
    entities: list[EntityResult] = Field(
        default_factory=list, description="Matching entities"
    )
    metrics: list[MetricResult] = Field(
        default_factory=list, description="Matching metrics"
    )
    cohorts: list[CohortResult] = Field(
        default_factory=list, description="Matching cohorts"
    )
    time_periods: list[Any] = Field(
        default_factory=list, description="Available time periods"
    )
    execution_time_ms: int = Field(default=0, description="Query execution time in ms")


class SchemaEntry(BaseModel):
    """A chart schema/template entry."""

    name: str | None = Field(default=None, description="Schema name identifier")
    description: str | None = Field(default=None, description="Schema description")
    use_case: str = Field(default="", description="Recommended use case for this chart type")
    components: list[dict[str, Any]] = Field(
        default_factory=list, description="Component definitions"
    )


class ChartSchemaList(BaseModel):
    """List of available chart schemas."""

    schemas: list[SchemaEntry] = Field(description="Available chart templates")
    count: int = Field(description="Number of schemas")


class ChartSchemaDetail(BaseModel):
    """Detailed schema for a specific chart type."""

    name: str | None = Field(default=None, description="Schema name")
    description: str | None = Field(default=None, description="Schema description")
    components: list[dict[str, Any]] = Field(
        default_factory=list, description="Component definitions with configs"
    )
    template: dict[str, Any] | None = Field(
        default=None, description="Template configuration"
    )


class ChartCreateResult(BaseModel):
    """Result from creating a new chart."""

    card_id: str | None = Field(default=None, description="New chart's unique identifier")
    title: str | None = Field(default=None, description="Chart title")
    description: str | None = Field(default=None, description="Chart description")
    webpage_url: str | None = Field(
        default=None, description="URL to view the chart on Tako"
    )
    embed_url: str | None = Field(
        default=None, description="URL to embed the chart"
    )
    image_url: str | None = Field(
        default=None, description="URL to a static PNG preview"
    )
    open_ui_tool: str | None = Field(
        default=None, description="Tool name to open interactive chart"
    )
    open_ui_args: dict[str, Any] | None = Field(
        default=None, description="Arguments for open_chart_ui tool"
    )


class TakoToolError(Exception):
    """Error raised by Tako tools to signal failure to the MCP client."""

    pass


def _get_auth_header(api_token: str | None) -> dict:
    """Build request headers with authentication."""
    headers = {"Content-Type": "application/json"}
    if api_token:
        headers["X-API-Key"] = api_token
    return headers


@mcp.tool(annotations={
    "title": "Tako: Search Charts",
    "readOnlyHint": True,
    "destructiveHint": False,
    "openWorldHint": False,
})
async def knowledge_search(
    query: str,
    api_token: str,
    count: int = 5,
    search_effort: str = "deep",
    country_code: str = "US",
    locale: str = "en-US",
) -> SearchResults:
    """
    Use this when you need to find existing charts and data visualizations on any topic.
    This searches Tako's curated knowledge base of charts covering economics, finance,
    demographics, technology, and more. Start here when a user asks about data trends,
    comparisons, or statistics — Tako likely already has a relevant visualization.

    Args:
        query: Natural language search query for charts and data (e.g., "US GDP growth",
            "Intel vs Nvidia revenue", "climate change temperature data")
        api_token: Your Tako API token for authentication
        count: Number of results to return (1-20), defaults to 5
        search_effort: Search depth - "fast" for quick results, "deep" for comprehensive search
        country_code: ISO country code for localized results (e.g., "US", "GB")
        locale: Locale for results (e.g., "en-US", "en-GB")

    Returns:
        SearchResults with matching charts including card_id, title, description, url, source,
        and open_ui_args for rendering charts interactively.
    """
    start_time = time.time()
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            resp = await client.post(
                f"{TAKO_API_URL}/api/v1/knowledge_search",
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
                headers=_get_auth_header(api_token),
            )
            resp.raise_for_status()

            data = resp.json()
            cards = data.get("outputs", {}).get("knowledge_cards", [])

            results = []
            for card in cards:
                card_id = card.get("card_id")
                item = SearchResultItem(
                    card_id=card_id,
                    title=card.get("title"),
                    description=card.get("description"),
                    url=card.get("url"),
                    source=card.get("source"),
                    open_ui_tool="open_chart_ui" if card_id else None,
                    open_ui_args={"pub_id": card_id} if card_id else None,
                )
                results.append(item)

            elapsed_time = time.time() - start_time
            logging.debug(
                f"knowledge_search completed in {elapsed_time:.2f}s: "
                f"query={query[:50]}, count={len(results)}, effort={search_effort}"
            )
            return SearchResults(results=results, count=len(results))
    except httpx.TimeoutException:
        elapsed_time = time.time() - start_time
        logging.warning(
            f"knowledge_search timed out after {elapsed_time:.2f}s: "
            f"query={query[:50]}, effort={search_effort}"
        )
        raise TakoToolError(
            "Request timed out. Try using search_effort='fast' for quicker results, "
            "or use a more specific query."
        )
    except httpx.HTTPStatusError as e:
        raise TakoToolError(
            f"HTTP {e.response.status_code}: Check your API token is valid and try again."
        )


@mcp.tool(annotations={
    "title": "Tako: Get Chart Image",
    "readOnlyHint": True,
    "destructiveHint": False,
    "openWorldHint": False,
})
async def get_chart_image(
    pub_id: str,
    api_token: str,
    dark_mode: bool = True,
) -> ChartImageResult:
    """
    Use this when you need a static preview image of a chart to display or embed.
    Returns a direct URL to a PNG image of the chart. Useful for including chart
    previews in responses or documents.

    Args:
        pub_id: The unique identifier (pub_id/card_id) of the chart
        api_token: Your Tako API token for authentication
        dark_mode: Whether to return dark mode version of the image (default: True)

    Returns:
        ChartImageResult with image_url (public PNG URL), pub_id, and dark_mode setting.
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/image/{pub_id}/",
            params={"dark_mode": str(dark_mode).lower()},
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 200:
            image_url = f"{PUBLIC_API_URL}/api/v1/image/{pub_id}/?dark_mode={str(dark_mode).lower()}"
            return ChartImageResult(
                image_url=image_url, pub_id=pub_id, dark_mode=dark_mode
            )
        elif resp.status_code == 404:
            raise TakoToolError(
                f"Chart image not found for pub_id '{pub_id}'. "
                "Use knowledge_search to find valid chart IDs."
            )
        elif resp.status_code == 408:
            raise TakoToolError(
                "Image generation timed out. The image is still rendering. "
                "Wait a few seconds and try again."
            )
        else:
            resp.raise_for_status()
            raise TakoToolError(
                "Unexpected error. Check your API token and try again."
            )


@mcp.tool(annotations={
    "title": "Tako: Get AI Insights",
    "readOnlyHint": True,
    "destructiveHint": False,
    "openWorldHint": False,
})
async def get_card_insights(
    pub_id: str,
    api_token: str,
    effort: str = "medium",
) -> ChartInsightsResult:
    """
    Use this when you want AI-generated analysis of a chart's data. Returns bullet-point
    insights and a natural language description that summarizes trends, outliers, and key
    takeaways from the chart.

    Args:
        pub_id: The unique identifier (pub_id/card_id) of the chart
        api_token: Your Tako API token for authentication
        effort: Reasoning effort level - "low" for quick summary, "medium" for balanced
            analysis, "high" for deep analysis (default: "medium")

    Returns:
        ChartInsightsResult with pub_id, insights (bullet-point analysis), and
        description (narrative summary).
    """
    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/internal/chart-configs/{pub_id}/chart-insights/",
            params={"effort": effort},
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 404:
            raise TakoToolError(
                f"Chart not found for pub_id '{pub_id}'. "
                "Use knowledge_search to find valid chart IDs."
            )

        resp.raise_for_status()
        data = resp.json()

        return ChartInsightsResult(
            pub_id=pub_id,
            insights=data.get("insights", ""),
            description=data.get("description", ""),
        )


@mcp.tool(annotations={
    "title": "Tako: Explore Knowledge Graph",
    "readOnlyHint": True,
    "destructiveHint": False,
    "openWorldHint": False,
})
async def explore_knowledge_graph(
    query: str,
    api_token: str,
    node_types: list[str] | None = None,
    limit: int = 20,
) -> KnowledgeGraphResult:
    """
    Use this when you need to discover what data is available before searching.
    Helps find entities (companies, countries), metrics (revenue, GDP), cohorts
    (S&P 500, G7), and time periods. Use this to disambiguate queries or understand
    what data Tako has before calling knowledge_search.

    Args:
        query: Natural language query to explore (e.g., "tech companies", "GDP metrics",
            "automotive industry")
        api_token: Your Tako API token for authentication
        node_types: Optional filter for specific node types. Can include:
            - "entity": Companies, countries, people, organizations
            - "metric": Measurements like revenue, GDP, temperature
            - "cohort": Groups like "S&P 500", "BRICS"
            - "db": Database tables
            - "units": Measurement units like USD, celsius
            - "time_period": Time granularities like yearly, monthly
            - "property": Properties like "net", "total"
        limit: Maximum number of results per type (1-50), defaults to 20

    Returns:
        KnowledgeGraphResult with entities, metrics, cohorts, time_periods, and total_matches.
    """
    start_time = time.time()
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            resp = await client.post(
                f"{TAKO_API_URL}/api/v1/explore/",
                json={
                    "query": query,
                    "node_types": node_types,
                    "limit": limit,
                },
                headers=_get_auth_header(api_token),
            )
            resp.raise_for_status()

            data = resp.json()

            result = KnowledgeGraphResult(
                query=data.get("query"),
                total_matches=data.get("total_matches", 0),
                entities=[
                    EntityResult(
                        name=e.get("name"),
                        type=e.get("type"),
                        description=e.get("description"),
                        aliases=e.get("aliases", [])[:3],
                        available_tables=e.get("available_tables", [])[:3],
                        node_id=e.get("node_id"),
                    )
                    for e in data.get("entities", [])
                ],
                metrics=[
                    MetricResult(
                        name=m.get("name"),
                        description=m.get("description"),
                        units=m.get("units", [])[:3],
                        time_periods=m.get("time_periods", [])[:3],
                        compatible_tables=m.get("compatible_tables", [])[:3],
                        node_id=m.get("node_id"),
                    )
                    for m in data.get("metrics", [])
                ],
                cohorts=[
                    CohortResult(
                        name=c.get("name"),
                        description=c.get("description"),
                        member_count=c.get("member_count"),
                        sample_members=c.get("sample_members", []),
                        node_id=c.get("node_id"),
                    )
                    for c in data.get("cohorts", [])
                ],
                time_periods=data.get("time_periods", []),
                execution_time_ms=data.get("execution_time_ms", 0),
            )

            elapsed_time = time.time() - start_time
            logging.debug(
                f"explore_knowledge_graph completed in {elapsed_time:.2f}s: "
                f"query={query[:50]}, total_matches={result.total_matches}"
            )
            return result

    except httpx.TimeoutException:
        elapsed_time = time.time() - start_time
        logging.warning(
            f"explore_knowledge_graph timed out after {elapsed_time:.2f}s: query={query[:50]}"
        )
        raise TakoToolError(
            "Request timed out. Try a more specific query or filter by node_types "
            "to narrow results."
        )
    except httpx.HTTPStatusError as e:
        raise TakoToolError(
            f"HTTP {e.response.status_code}: Check your API token is valid and try again."
        )
    except TakoToolError:
        raise
    except Exception as e:
        logging.error(f"explore_knowledge_graph error: {e}", exc_info=True)
        raise TakoToolError(
            "Unexpected error. Check your API token and try again. "
            "If the issue persists, the Tako API may be temporarily unavailable."
        )


# =============================================================================
# ThinViz API - Create charts from templates with your own data
# =============================================================================


@mcp.tool(annotations={
    "title": "Tako: List Chart Types",
    "readOnlyHint": True,
    "destructiveHint": False,
    "openWorldHint": False,
})
async def list_chart_schemas(
    api_token: str,
) -> ChartSchemaList:
    """
    Use this when you want to see all available chart templates before creating a custom
    chart. Returns the full list of ThinViz schemas including timeseries, bar charts, pie
    charts, scatter plots, maps, and more. Call this first when the user wants to create
    a new visualization.

    Available schemas include: stock_card, timeseries_card, bar_chart, grouped_bar_chart,
    data_table_chart, histogram, pie_chart, table, header, financial_boxes, choropleth,
    treemap, heatmap, boxplot, waterfall, scatter_chart, bubble_chart.

    Args:
        api_token: Your Tako API token for authentication

    Returns:
        ChartSchemaList with schemas array (name, description, use_case, components) and count.
    """
    # Recommended use cases for each schema to help agents pick the right chart type
    _schema_use_cases = {
        "stock_card": "Financial data with ticker info — stock prices, forex, crypto over time",
        "timeseries_card": "Any time-based data — trends, growth rates, historical comparisons",
        "bar_chart": "Single-series categorical comparisons — revenue by region, top 10 lists",
        "grouped_bar_chart": "Multi-series categorical comparisons — side-by-side or stacked bars",
        "data_table_chart": "Bar chart with a data table below for exact values",
        "histogram": "Frequency distributions — age distribution, salary ranges, score buckets",
        "pie_chart": "Proportional/percentage data — market share, budget allocation",
        "table": "Raw tabular data display — rankings, detailed breakdowns",
        "header": "Title/subtitle card header (usually combined with other components)",
        "financial_boxes": "KPI metric boxes — revenue, growth rate, key numbers at a glance",
        "choropleth": "Geographic map data — by US state or world country",
        "treemap": "Hierarchical proportional data — org structure, category breakdowns",
        "heatmap": "2D correlation or intensity matrices — correlation tables, activity grids",
        "boxplot": "Statistical distributions — comparing spread across categories",
        "waterfall": "Sequential additive/subtractive changes — income statements, bridge charts",
        "scatter_chart": "2-variable correlation — height vs weight, price vs quantity",
        "bubble_chart": "3-variable data — scatter with size dimension for a third variable",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{TAKO_API_URL}/api/v1/thin_viz/default_schema/",
                headers=_get_auth_header(api_token),
            )
            resp.raise_for_status()
            schemas = resp.json()

            result = []
            for schema in schemas:
                name = schema.get("name")
                entry = SchemaEntry(
                    name=name,
                    description=schema.get("description"),
                    use_case=_schema_use_cases.get(name, ""),
                    components=schema.get("components", []),
                )
                result.append(entry)

            return ChartSchemaList(schemas=result, count=len(result))
    except httpx.HTTPStatusError as e:
        raise TakoToolError(
            f"HTTP {e.response.status_code}: Check your API token is valid and try again."
        )


@mcp.tool(annotations={
    "title": "Tako: Get Chart Schema",
    "readOnlyHint": True,
    "destructiveHint": False,
    "openWorldHint": False,
})
async def get_chart_schema(
    schema_name: str,
    api_token: str,
) -> ChartSchemaDetail:
    """
    Use this when you need to understand the exact data format required for a specific
    chart type. Returns the schema definition including required fields, data structure,
    and configuration options. Always call this before create_chart to understand what
    data is needed.

    Args:
        schema_name: Name of the schema (e.g., "stock_card", "bar_chart", "grouped_bar_chart",
            "pie_chart", "scatter_chart", "choropleth", "timeseries_card")
        api_token: Your Tako API token for authentication

    Returns:
        ChartSchemaDetail with schema name, description, components array, and template details.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/thin_viz/default_schema/{schema_name}/",
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 404:
            raise TakoToolError(
                f"Schema '{schema_name}' not found. "
                "Use list_chart_schemas to see all available schema names."
            )

        resp.raise_for_status()
        schema = resp.json()

        return ChartSchemaDetail(
            name=schema.get("name"),
            description=schema.get("description"),
            components=schema.get("components", []),
            template=schema.get("template"),
        )


@mcp.tool(annotations={
    "title": "Tako: Create Chart",
    "readOnlyHint": False,
    "destructiveHint": False,
    "openWorldHint": True,
})
async def create_chart(
    schema_name: str,
    components: list[dict],
    api_token: str,
    source: str | None = None,
) -> ChartCreateResult:
    """
    Use this when you need to create a new chart from raw data. This is the primary chart
    creation tool — pass a schema name and your data components to generate an interactive
    Tako visualization. The chart will be hosted and shareable. Supports 15+ chart types
    including timeseries, bar charts, scatter plots, maps, and more.

    Workflow: call list_chart_schemas to see options, then get_chart_schema for the data
    format, then this tool to create the chart.

    Args:
        schema_name: Name of the schema to use (e.g., "stock_card", "bar_chart",
            "grouped_bar_chart", "pie_chart", "scatter_chart", "choropleth")
        components: List of component configurations matching the schema requirements.
            Each component needs "component_type" and "config" fields.
        api_token: Your Tako API token for authentication
        source: Optional attribution text (e.g., "Yahoo Finance", "Company Reports")

    Returns:
        ChartCreateResult with card_id, title, description, webpage_url, embed_url, image_url,
        and open_ui_args for rendering the chart interactively.

    Example components for "bar_chart" schema:
        [
            {
                "component_type": "header",
                "config": {"title": "Revenue by Region", "subtitle": "Q4 2024"}
            },
            {
                "component_type": "categorical_bar",
                "config": {
                    "datasets": [{
                        "label": "Revenue",
                        "data": [
                            {"x": "North America", "y": 120},
                            {"x": "Europe", "y": 98},
                            {"x": "Asia", "y": 156}
                        ],
                        "units": "$M"
                    }],
                    "title": "Revenue by Region"
                }
            }
        ]

    Example components for "stock_card" schema:
        [
            {
                "component_type": "stock_boxes",
                "config": {
                    "items": [{
                        "labelPrimary": "AAPL",
                        "labelSecondary": "NASDAQ",
                        "valuePrimary": "$195.20",
                        "valueSecondary": "USD",
                        "subValue": "+$9.70 (+5.24%)"
                    }]
                }
            },
            {
                "component_type": "generic_timeseries",
                "config": {
                    "datasets": [{
                        "label": "AAPL",
                        "data": [
                            {"x": "2024-01-01", "y": 185.50},
                            {"x": "2024-01-02", "y": 190.25},
                            {"x": "2024-01-03", "y": 195.20}
                        ],
                        "type": "line",
                        "units": "$"
                    }],
                    "chart_type": "line",
                    "title": "AAPL Stock Price"
                }
            }
        ]
    """
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            payload = {"components": components}
            if source:
                payload["source"] = source

            resp = await client.post(
                f"{TAKO_API_URL}/api/v1/thin_viz/default_schema/{schema_name}/create/",
                json=payload,
                headers=_get_auth_header(api_token),
            )

            if resp.status_code == 404:
                raise TakoToolError(
                    f"Schema '{schema_name}' not found. "
                    "Use list_chart_schemas to see all available schema names."
                )
            if resp.status_code == 400:
                error_data = resp.json()
                raise TakoToolError(
                    f"Invalid component configuration: {json.dumps(error_data)}. "
                    "Use get_chart_schema to see the required data format for this schema."
                )

            resp.raise_for_status()
            data = resp.json()

            card_id = data.get("card_id")
            return ChartCreateResult(
                card_id=card_id,
                title=data.get("title"),
                description=data.get("description"),
                webpage_url=data.get("webpage_url"),
                embed_url=data.get("embed_url"),
                image_url=data.get("image_url"),
                open_ui_tool="open_chart_ui" if card_id else None,
                open_ui_args={"pub_id": card_id} if card_id else None,
            )

    except httpx.HTTPStatusError as e:
        raise TakoToolError(
            f"HTTP {e.response.status_code}: Check your API token and component configuration. "
            "Use get_chart_schema to verify the expected format."
        )
    except TakoToolError:
        raise
    except Exception as e:
        logging.error(f"create_chart error: {e}", exc_info=True)
        raise TakoToolError(
            "Unexpected error. Check your API token and try again. "
            "If the issue persists, the Tako API may be temporarily unavailable."
        )


# =============================================================================
# MCP-UI - Interactive chart embedding
# =============================================================================


@mcp.tool(annotations={
    "title": "Tako: Open Interactive Chart",
    "readOnlyHint": True,
    "destructiveHint": False,
    "openWorldHint": True,
})
async def open_chart_ui(
    pub_id: str,
    dark_mode: bool = True,
    width: int = 900,
    height: int = 600,
) -> list[UIResource]:
    """
    Use this when you want to display a fully interactive chart to the user.
    Returns an MCP-UI resource that renders the chart with zooming, panning, hover
    interactions, and responsive resizing. Prefer this over get_chart_image when
    the user wants to explore the data interactively.

    Args:
        pub_id: The unique identifier (pub_id/card_id) of the chart
        dark_mode: Whether to use dark mode theme (default: True)
        width: Initial width in pixels (default: 900)
        height: Initial height in pixels (default: 600)

    Returns:
        UIResource containing an interactive iframe embed of the chart
    """
    base_url = PUBLIC_BASE_URL
    if not base_url.startswith(("http://", "https://")):
        base_url = f"https://{base_url}"

    embed_url = f"{base_url}/embed/{pub_id}/?theme={'dark' if dark_mode else 'light'}"
    safe_url = html.escape(embed_url, quote=True)

    html_doc = f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {{ margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; }}
      #tako-embed {{
        width: 100% !important;
        height: {height}px !important;
        min-height: {height}px !important;
        border: 0 !important;
        display: block !important;
      }}
    </style>
  </head>
  <body>
    <iframe
      id="tako-embed"
      width="100%"
      height="{height}"
      src="{safe_url}"
      scrolling="no"
      frameborder="0"
      allow="fullscreen"
    ></iframe>

    <script>
      (function() {{
        "use strict";
        var iframe = document.getElementById("tako-embed");
        if (!iframe) return;

        iframe.style.height = "{height}px";
        iframe.style.minHeight = "{height}px";

        window.addEventListener("message", function(e) {{
          var d = e.data || {{}};
          if (d.type !== "tako::resize") return;

          var targetIframe = document.getElementById("tako-embed");
          if (!targetIframe || targetIframe.contentWindow !== e.source) return;

          if (typeof d.height === "number" && d.height > 0) {{
            var newHeight = d.height + "px";
            targetIframe.style.height = newHeight;
            targetIframe.style.minHeight = newHeight;
            targetIframe.setAttribute("height", d.height);
          }}
        }});
      }})();
    </script>
  </body>
</html>"""

    ui_resource = create_ui_resource(
        {
            "uri": f"ui://tako/embed/{pub_id}",
            "content": {
                "type": "rawHtml",
                "htmlString": html_doc,
            },
            "encoding": "text",
            "uiMetadata": {
                UIMetadataKey.PREFERRED_FRAME_SIZE: [f"{width}px", f"{height}px"],
            },
        }
    )
    return [ui_resource]


# =============================================================================
# ASGI application setup
# =============================================================================

_sse_app = mcp.sse_app()
_streamable_http_app = mcp.streamable_http_app()


# =============================================================================
# OAuth 2.1 Authorization Server (RFC 9728)
# =============================================================================

# OAuth configuration
OAUTH_ISSUER = os.environ.get("OAUTH_ISSUER", PUBLIC_BASE_URL)
OAUTH_REGISTRATION_ENABLED = os.environ.get("OAUTH_REGISTRATION_ENABLED", "true").lower() == "true"

# In-memory stores (replace with persistent storage in production)
_oauth_clients: dict[str, dict] = {}
_oauth_codes: dict[str, dict] = {}
_oauth_tokens: dict[str, dict] = {}

_OAUTH_METADATA = {
    "issuer": OAUTH_ISSUER,
    "authorization_endpoint": f"{OAUTH_ISSUER}/oauth/authorize",
    "token_endpoint": f"{OAUTH_ISSUER}/oauth/token",
    "registration_endpoint": f"{OAUTH_ISSUER}/oauth/register" if OAUTH_REGISTRATION_ENABLED else None,
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code", "refresh_token"],
    "token_endpoint_auth_methods_supported": ["none"],
    "code_challenge_methods_supported": ["S256"],
    "scopes_supported": ["read", "write", "admin"],
    "service_documentation": "https://github.com/TakoData/tako-mcp",
}


def _generate_token(prefix: str = "tako") -> str:
    """Generate a cryptographically random token."""
    import secrets
    return f"{prefix}_{secrets.token_urlsafe(32)}"


async def _handle_oauth_metadata(scope, receive, send):
    """Serve OAuth 2.1 Authorization Server Metadata (RFC 8414)."""
    response = JSONResponse(_OAUTH_METADATA)
    await response(scope, receive, send)


async def _handle_oauth_register(scope, receive, send):
    """Handle dynamic client registration (RFC 7591)."""
    if scope["method"] != "POST":
        response = JSONResponse({"error": "method_not_allowed"}, status_code=405)
        await response(scope, receive, send)
        return

    if not OAUTH_REGISTRATION_ENABLED:
        response = JSONResponse({"error": "registration_disabled"}, status_code=403)
        await response(scope, receive, send)
        return

    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body", False):
            break

    try:
        client_meta = json.loads(body) if body else {}
    except json.JSONDecodeError:
        response = JSONResponse({"error": "invalid_request"}, status_code=400)
        await response(scope, receive, send)
        return

    client_id = _generate_token("client")
    client_record = {
        "client_id": client_id,
        "client_name": client_meta.get("client_name", "Unknown Client"),
        "redirect_uris": client_meta.get("redirect_uris", []),
        "grant_types": client_meta.get("grant_types", ["authorization_code"]),
        "response_types": client_meta.get("response_types", ["code"]),
        "scope": client_meta.get("scope", "read"),
        "token_endpoint_auth_method": "none",
    }
    _oauth_clients[client_id] = client_record

    response = JSONResponse(client_record, status_code=201)
    await response(scope, receive, send)


async def _handle_oauth_authorize(scope, receive, send):
    """Handle authorization requests — issues authorization codes."""
    query_string = scope.get("query_string", b"").decode()
    params = urllib.parse.parse_qs(query_string)

    client_id = params.get("client_id", [None])[0]
    redirect_uri = params.get("redirect_uri", [None])[0]
    response_type = params.get("response_type", [None])[0]
    code_challenge = params.get("code_challenge", [None])[0]
    code_challenge_method = params.get("code_challenge_method", [None])[0]
    state = params.get("state", [None])[0]
    requested_scope = params.get("scope", ["read"])[0]

    if response_type != "code":
        response = JSONResponse(
            {"error": "unsupported_response_type", "error_description": "Only 'code' is supported"},
            status_code=400,
        )
        await response(scope, receive, send)
        return

    if not code_challenge or code_challenge_method != "S256":
        response = JSONResponse(
            {"error": "invalid_request", "error_description": "PKCE with S256 is required (OAuth 2.1)"},
            status_code=400,
        )
        await response(scope, receive, send)
        return

    # Generate authorization code
    import secrets
    code = secrets.token_urlsafe(32)
    _oauth_codes[code] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method,
        "scope": requested_scope,
        "created_at": time.time(),
        "expires_at": time.time() + 600,  # 10 minute expiry
    }

    # Redirect back with code
    redirect_params = {"code": code}
    if state:
        redirect_params["state"] = state

    redirect_url = f"{redirect_uri}?{urllib.parse.urlencode(redirect_params)}"
    response = JSONResponse(
        {"redirect_to": redirect_url, "code": code},
        status_code=200,
        headers={"Location": redirect_url},
    )
    await response(scope, receive, send)


async def _handle_oauth_token(scope, receive, send):
    """Handle token exchange — trades authorization codes for access tokens."""
    if scope["method"] != "POST":
        response = JSONResponse({"error": "method_not_allowed"}, status_code=405)
        await response(scope, receive, send)
        return

    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body", False):
            break

    try:
        if b"=" in body:
            params = dict(urllib.parse.parse_qsl(body.decode()))
        else:
            params = json.loads(body) if body else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        response = JSONResponse({"error": "invalid_request"}, status_code=400)
        await response(scope, receive, send)
        return

    grant_type = params.get("grant_type")

    if grant_type == "authorization_code":
        code = params.get("code")
        code_verifier = params.get("code_verifier")

        if not code or code not in _oauth_codes:
            response = JSONResponse({"error": "invalid_grant"}, status_code=400)
            await response(scope, receive, send)
            return

        code_record = _oauth_codes.pop(code)

        if code_record["expires_at"] < time.time():
            response = JSONResponse({"error": "invalid_grant", "error_description": "Code expired"}, status_code=400)
            await response(scope, receive, send)
            return

        # Verify PKCE
        if code_verifier:
            import hashlib
            import base64
            challenge = base64.urlsafe_b64encode(
                hashlib.sha256(code_verifier.encode()).digest()
            ).rstrip(b"=").decode()
            if challenge != code_record["code_challenge"]:
                response = JSONResponse({"error": "invalid_grant", "error_description": "PKCE verification failed"}, status_code=400)
                await response(scope, receive, send)
                return

        access_token = _generate_token("tak")
        refresh_token = _generate_token("ref")
        _oauth_tokens[access_token] = {
            "client_id": code_record.get("client_id"),
            "scope": code_record.get("scope", "read"),
            "created_at": time.time(),
            "expires_at": time.time() + 3600,  # 1 hour
            "refresh_token": refresh_token,
        }

        response = JSONResponse({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": refresh_token,
            "scope": code_record.get("scope", "read"),
        })
        await response(scope, receive, send)

    elif grant_type == "refresh_token":
        refresh = params.get("refresh_token")

        # Find the token record by refresh token
        found = None
        for token, record in _oauth_tokens.items():
            if record.get("refresh_token") == refresh:
                found = (token, record)
                break

        if not found:
            response = JSONResponse({"error": "invalid_grant"}, status_code=400)
            await response(scope, receive, send)
            return

        old_token, old_record = found
        del _oauth_tokens[old_token]

        new_access = _generate_token("tak")
        new_refresh = _generate_token("ref")
        _oauth_tokens[new_access] = {
            "client_id": old_record.get("client_id"),
            "scope": old_record.get("scope", "read"),
            "created_at": time.time(),
            "expires_at": time.time() + 3600,
            "refresh_token": new_refresh,
        }

        response = JSONResponse({
            "access_token": new_access,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": new_refresh,
            "scope": old_record.get("scope", "read"),
        })
        await response(scope, receive, send)
    else:
        response = JSONResponse(
            {"error": "unsupported_grant_type"},
            status_code=400,
        )
        await response(scope, receive, send)

# =============================================================================
# Agent-friendly tools description (served at /v1/tools)
# =============================================================================

_TOOLS_DESCRIPTION = {
    "server": {
        "name": "tako-mcp",
        "version": SERVER_VERSION,
        "description": (
            "Tako MCP Server — create and discover data visualizations. "
            "Search a curated knowledge base of 100K+ charts or create custom "
            "charts from raw data using 15+ chart types."
        ),
        "homepage": "https://tako.com",
        "repository": "https://github.com/TakoData/tako-mcp",
        "connection": "https://mcp.tako.com/sse",
    },
    "authentication": {
        "method": "api_token parameter",
        "description": "Pass your Tako API token as the api_token parameter in each tool call.",
        "get_token": "Sign up at tako.com and create a token in your account settings.",
    },
    "tools": [
        {
            "name": "knowledge_search",
            "category": "search",
            "description": (
                "Search Tako's curated knowledge base of 100K+ charts covering economics, "
                "finance, demographics, technology, and more. Start here when a user asks "
                "about data trends, comparisons, or statistics."
            ),
            "when_to_use": "When you need to find existing charts and data visualizations on any topic.",
            "parameters": {
                "query": {"type": "string", "required": True, "description": "Natural language search query"},
                "api_token": {"type": "string", "required": True, "description": "Tako API token"},
                "count": {"type": "integer", "required": False, "default": 5, "range": "1-20"},
                "search_effort": {"type": "string", "required": False, "default": "deep", "enum": ["fast", "deep"]},
                "country_code": {"type": "string", "required": False, "default": "US"},
                "locale": {"type": "string", "required": False, "default": "en-US"},
            },
            "returns": "SearchResults with matching charts (card_id, title, description, url, source)",
            "example_queries": ["US GDP growth rate", "Intel vs Nvidia revenue", "climate change temperature data"],
        },
        {
            "name": "explore_knowledge_graph",
            "category": "search",
            "description": (
                "Discover available entities (companies, countries), metrics (revenue, GDP), "
                "cohorts (S&P 500, G7), and time periods in Tako's knowledge graph."
            ),
            "when_to_use": "When you need to discover what data is available before searching.",
            "parameters": {
                "query": {"type": "string", "required": True, "description": "Natural language query to explore"},
                "api_token": {"type": "string", "required": True, "description": "Tako API token"},
                "node_types": {"type": "array[string]", "required": False, "enum": ["entity", "metric", "cohort", "db", "units", "time_period", "property"]},
                "limit": {"type": "integer", "required": False, "default": 20, "range": "1-50"},
            },
            "returns": "KnowledgeGraphResult with entities, metrics, cohorts, time_periods",
        },
        {
            "name": "get_chart_image",
            "category": "display",
            "description": "Get a static PNG preview URL for a chart. Useful for including chart previews in responses.",
            "when_to_use": "When you need a static image of a chart to display or embed.",
            "parameters": {
                "pub_id": {"type": "string", "required": True, "description": "Chart identifier (pub_id/card_id)"},
                "api_token": {"type": "string", "required": True, "description": "Tako API token"},
                "dark_mode": {"type": "boolean", "required": False, "default": True},
            },
            "returns": "ChartImageResult with image_url, pub_id, dark_mode",
        },
        {
            "name": "get_card_insights",
            "category": "analysis",
            "description": "Get AI-generated analysis with bullet-point insights and a narrative summary of chart data.",
            "when_to_use": "When you want AI-generated analysis of a chart's data.",
            "parameters": {
                "pub_id": {"type": "string", "required": True, "description": "Chart identifier (pub_id/card_id)"},
                "api_token": {"type": "string", "required": True, "description": "Tako API token"},
                "effort": {"type": "string", "required": False, "default": "medium", "enum": ["low", "medium", "high"]},
            },
            "returns": "ChartInsightsResult with pub_id, insights, description",
        },
        {
            "name": "list_chart_schemas",
            "category": "thinviz",
            "description": (
                "List all available chart templates (15+ types). Call this first when the user "
                "wants to create a new visualization."
            ),
            "when_to_use": "When you want to see all available chart types before creating a chart.",
            "parameters": {
                "api_token": {"type": "string", "required": True, "description": "Tako API token"},
            },
            "returns": "ChartSchemaList with schemas (name, description, use_case, components) and count",
        },
        {
            "name": "get_chart_schema",
            "category": "thinviz",
            "description": "Get the exact data format for a specific chart type. Always call this before create_chart.",
            "when_to_use": "When you need to understand the data format for creating a chart.",
            "parameters": {
                "schema_name": {"type": "string", "required": True, "description": "Schema name (e.g., 'bar_chart', 'timeseries_card')"},
                "api_token": {"type": "string", "required": True, "description": "Tako API token"},
            },
            "returns": "ChartSchemaDetail with name, description, components, template",
        },
        {
            "name": "create_chart",
            "category": "thinviz",
            "description": (
                "Create a new interactive chart from raw data. Supports 15+ chart types. "
                "The chart will be hosted and shareable on Tako."
            ),
            "when_to_use": "When you need to create a new chart from raw data.",
            "workflow": "list_chart_schemas → get_chart_schema → create_chart",
            "parameters": {
                "schema_name": {"type": "string", "required": True, "description": "Schema name"},
                "components": {"type": "array[object]", "required": True, "description": "Component configs matching the schema"},
                "api_token": {"type": "string", "required": True, "description": "Tako API token"},
                "source": {"type": "string", "required": False, "description": "Data source attribution"},
            },
            "returns": "ChartCreateResult with card_id, title, webpage_url, embed_url, image_url",
        },
        {
            "name": "open_chart_ui",
            "category": "display",
            "description": "Render a fully interactive chart with zooming, panning, and hover interactions via MCP-UI.",
            "when_to_use": "When you want to display an interactive chart to the user.",
            "parameters": {
                "pub_id": {"type": "string", "required": True, "description": "Chart identifier (pub_id/card_id)"},
                "dark_mode": {"type": "boolean", "required": False, "default": True},
                "width": {"type": "integer", "required": False, "default": 900},
                "height": {"type": "integer", "required": False, "default": 600},
            },
            "returns": "UIResource containing an interactive iframe embed",
        },
    ],
    "chart_types": [
        {"schema": "timeseries_card", "name": "Line/Area Chart", "use_case": "Trends over time"},
        {"schema": "stock_card", "name": "Stock Chart", "use_case": "Financial data with ticker boxes"},
        {"schema": "bar_chart", "name": "Bar Chart", "use_case": "Categorical comparisons"},
        {"schema": "grouped_bar_chart", "name": "Grouped Bar Chart", "use_case": "Multi-series comparisons"},
        {"schema": "pie_chart", "name": "Pie Chart", "use_case": "Proportional data"},
        {"schema": "scatter_chart", "name": "Scatter Plot", "use_case": "2-variable correlations"},
        {"schema": "bubble_chart", "name": "Bubble Chart", "use_case": "3-variable data"},
        {"schema": "histogram", "name": "Histogram", "use_case": "Frequency distributions"},
        {"schema": "boxplot", "name": "Box Plot", "use_case": "Statistical distributions"},
        {"schema": "choropleth", "name": "Map", "use_case": "Geographic data (US/World)"},
        {"schema": "treemap", "name": "Treemap", "use_case": "Hierarchical data"},
        {"schema": "heatmap", "name": "Heatmap", "use_case": "2D matrices"},
        {"schema": "waterfall", "name": "Waterfall Chart", "use_case": "Sequential changes"},
        {"schema": "financial_boxes", "name": "KPI Boxes", "use_case": "Key metrics display"},
        {"schema": "table", "name": "Table", "use_case": "Tabular data"},
    ],
}

# MCP Server Card (SEP-1649) for /.well-known/mcp
_SERVER_CARD = {
    "protocolVersion": "2025-06-18",
    "serverInfo": {
        "name": "tako-mcp",
        "title": "Tako MCP Server",
        "version": SERVER_VERSION,
        "description": (
            "Create and discover data visualizations. Search Tako's knowledge base of "
            "charts covering economics, finance, demographics, technology, and more. "
            "Create custom charts from raw data using 15+ chart types including timeseries, "
            "bar charts, scatter plots, maps, and more."
        ),
        "iconUrl": "https://tako.com/favicon.ico",
        "documentationUrl": "https://github.com/TakoData/tako-mcp",
    },
    "transport": [
        {
            "type": "streamable-http",
            "endpoint": "/mcp",
        },
        {
            "type": "sse",
            "endpoint": "/sse",
        },
    ],
    "capabilities": {
        "tools": {"listChanged": True},
    },
    "authentication": {
        "required": True,
        "schemes": ["bearer"],
        "oauth": {
            "authorization_server": "/.well-known/oauth-authorization-server",
            "scopes": ["read", "write", "admin"],
            "pkce_required": True,
        },
    },
    "tools": [
        {
            "name": "knowledge_search",
            "description": "Search Tako's knowledge base for charts and data visualizations on any topic.",
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "explore_knowledge_graph",
            "description": "Discover available entities, metrics, cohorts, and time periods in Tako's knowledge graph.",
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "get_chart_image",
            "description": "Get a static PNG preview image URL for a chart.",
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "get_card_insights",
            "description": "Get AI-generated analysis and insights for a chart.",
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "list_chart_schemas",
            "description": "List all available chart templates for creating custom visualizations.",
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "get_chart_schema",
            "description": "Get the detailed schema and data format for a specific chart type.",
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "create_chart",
            "description": "Create a new interactive chart from raw data using 15+ chart types.",
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
        },
        {
            "name": "open_chart_ui",
            "description": "Open a fully interactive chart with zooming, panning, and hover interactions.",
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": True},
        },
    ],
}


def _wrap_send(send, response_started_ref=None):
    """Wrap ASGI send to catch connection errors during SSE streaming."""

    async def wrapped_send(message):
        if (
            response_started_ref is not None
            and message.get("type") == "http.response.start"
        ):
            response_started_ref[0] = True

        try:
            await send(message)
        except ClosedResourceError:
            return
        except (BrokenPipeError, ConnectionResetError):
            return
        except OSError as e:
            if e.errno in (32, 54, 104):
                return
            raise

    return wrapped_send


async def app(scope, receive, send):
    """ASGI application with custom error handling for MCP connections.

    Supports both SSE (/sse, /messages/) and Streamable HTTP (/mcp) transports.
    """
    response_started = [False]

    if scope["type"] == "http":
        if scope["path"] == "/health":
            response = PlainTextResponse("ok")
            wrapped_send = _wrap_send(send, response_started)
            await response(scope, receive, wrapped_send)
            return

        if scope["path"] == "/health/detailed":
            health_data = {
                "status": "ok",
                "service": "tako-mcp-server",
                "version": SERVER_VERSION,
                "timestamp": time.time(),
            }
            response = JSONResponse(health_data)
            wrapped_send = _wrap_send(send, response_started)
            await response(scope, receive, wrapped_send)
            return

        if scope["path"] == "/.well-known/mcp":
            response = JSONResponse(_SERVER_CARD)
            wrapped_send = _wrap_send(send, response_started)
            await response(scope, receive, wrapped_send)
            return

        if scope["path"] == "/v1/tools":
            response = JSONResponse(_TOOLS_DESCRIPTION)
            wrapped_send = _wrap_send(send, response_started)
            await response(scope, receive, wrapped_send)
            return

        # OAuth 2.1 endpoints
        if scope["path"] == "/.well-known/oauth-authorization-server":
            wrapped_send = _wrap_send(send, response_started)
            await _handle_oauth_metadata(scope, receive, wrapped_send)
            return

        if scope["path"] == "/oauth/register":
            wrapped_send = _wrap_send(send, response_started)
            await _handle_oauth_register(scope, receive, wrapped_send)
            return

        if scope["path"] == "/oauth/authorize":
            wrapped_send = _wrap_send(send, response_started)
            await _handle_oauth_authorize(scope, receive, wrapped_send)
            return

        if scope["path"] == "/oauth/token":
            wrapped_send = _wrap_send(send, response_started)
            await _handle_oauth_token(scope, receive, wrapped_send)
            return

        # Route /mcp to Streamable HTTP transport
        if scope["path"] == "/mcp":
            wrapped_send = _wrap_send(send, response_started)
            try:
                await _streamable_http_app(scope, receive, wrapped_send)
            except Exception as e:
                if not response_started[0]:
                    logging.error(f"Streamable HTTP error: {type(e).__name__}: {e}", exc_info=True)
                    try:
                        response = JSONResponse(
                            {"error": "Unexpected error", "code": -32000}, status_code=500
                        )
                        await response(scope, receive, wrapped_send)
                    except RuntimeError:
                        pass
            return

        if scope["path"].startswith("/messages/"):
            query_string = scope.get("query_string", b"").decode()
            params = urllib.parse.parse_qs(query_string)
            session_id = params.get("session_id", [None])[0]
            if session_id:
                logging.debug(f"Processing request for session: {session_id}")
            else:
                logging.warning(f"Request to /messages/ without session_id")

    wrapped_send = _wrap_send(send, response_started)

    try:
        await _sse_app(scope, receive, wrapped_send)
    except ExceptionGroup as eg:
        all_connection_errors = all(
            isinstance(exc, (ClosedResourceError, BrokenPipeError, ConnectionResetError))
            or (isinstance(exc, OSError) and exc.errno in (32, 54, 104))
            for exc in eg.exceptions
        )
        if all_connection_errors:
            logging.debug(f"Client disconnected (ExceptionGroup): path={scope.get('path', 'unknown')}")
        else:
            raise
    except ClosedResourceError:
        if not response_started[0]:
            try:
                response = JSONResponse(
                    {"error": "Session closed", "code": -32000}, status_code=410
                )
                await response(scope, receive, wrapped_send)
            except RuntimeError:
                pass
        else:
            logging.debug(f"Client disconnected mid-stream: path={scope.get('path', 'unknown')}")
    except (BrokenPipeError, ConnectionResetError) as e:
        if not response_started[0]:
            logging.debug(f"Client connection reset before response: {type(e).__name__}")
            try:
                response = JSONResponse(
                    {"error": "Connection reset", "code": -32000}, status_code=410
                )
                await response(scope, receive, wrapped_send)
            except RuntimeError:
                pass
        else:
            logging.debug(f"Client connection reset mid-stream: path={scope.get('path', 'unknown')}")
    except Exception as e:
        error_str = str(e)
        if "Could not find session" in error_str:
            session_match = re.search(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                error_str,
                re.I,
            )
            session_id = session_match.group(0) if session_match else "unknown"
            logging.error(f"Session lookup failed for session_id: {session_id}")

            if response_started[0] is False:
                try:
                    response = JSONResponse(
                        {
                            "error": "Session expired or not found",
                            "code": -32001,
                            "message": "Please reconnect to /sse to establish a new session",
                            "reconnect": True,
                        },
                        status_code=410,
                    )
                    await response(scope, receive, wrapped_send)
                    return
                except RuntimeError:
                    pass
            else:
                try:
                    error_event = {
                        "jsonrpc": "2.0",
                        "error": {
                            "code": -32001,
                            "message": "Session expired. Please reconnect to /sse",
                            "data": {"session_id": session_id, "reconnect": True},
                        },
                        "id": None,
                    }
                    await wrapped_send(
                        {
                            "type": "http.response.body",
                            "body": f"data: {json.dumps(error_event)}\n\n".encode(),
                            "more_body": False,
                        }
                    )
                except Exception:
                    pass
            return

        if not response_started[0]:
            logging.error(f"Unexpected error in MCP app: {type(e).__name__}: {e}", exc_info=True)
            try:
                response = JSONResponse(
                    {"error": "Unexpected error", "code": -32000}, status_code=500
                )
                await response(scope, receive, wrapped_send)
            except RuntimeError:
                pass
        else:
            logging.error(f"Error after response started: {type(e).__name__}: {e}", exc_info=True)


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stdout,
    force=True,
)


def main():
    """Run the MCP server with uvicorn."""
    import uvicorn

    port = int(os.environ.get("PORT", "8001"))
    host = os.environ.get("HOST", "0.0.0.0")

    logging.info("=" * 60)
    logging.info("Tako MCP Server Starting")
    logging.info("=" * 60)
    logging.info(f"Tako API URL: {TAKO_API_URL}")
    logging.info(f"Public Base URL: {PUBLIC_BASE_URL}")
    logging.info(f"DNS rebinding protection: {enable_dns_rebinding}")
    logging.info(f"Transports: SSE (/sse), Streamable HTTP (/mcp)")
    logging.info(f"Discovery: /v1/tools, /.well-known/mcp, /.well-known/oauth-authorization-server")
    logging.info(f"Listening on {host}:{port}")
    logging.info("=" * 60)

    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
