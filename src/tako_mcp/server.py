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

import httpx
from anyio import ClosedResourceError
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp_ui_server import UIMetadataKey, create_ui_resource
from mcp_ui_server.core import UIResource
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
) -> str:
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
        JSON with matching charts including card_id, title, description, url, and source.
        Each result includes open_ui_args for rendering the chart interactively.
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
                result = {
                    "card_id": card_id,
                    "title": card.get("title"),
                    "description": card.get("description"),
                    "url": card.get("url"),
                    "source": card.get("source"),
                }
                if card_id:
                    result["open_ui_tool"] = "open_chart_ui"
                    result["open_ui_args"] = {"pub_id": card_id}
                results.append(result)

            elapsed_time = time.time() - start_time
            logging.debug(
                f"knowledge_search completed in {elapsed_time:.2f}s: "
                f"query={query[:50]}, count={len(results)}, effort={search_effort}"
            )
            return json.dumps({"results": results, "count": len(results)}, indent=2)
    except httpx.TimeoutException:
        elapsed_time = time.time() - start_time
        logging.warning(
            f"knowledge_search timed out after {elapsed_time:.2f}s: "
            f"query={query[:50]}, effort={search_effort}"
        )
        return json.dumps(
            {
                "error": "Request timed out",
                "message": "The search request took too long.",
                "suggestion": "Try using search_effort='fast' for quicker results, or use a more specific query.",
            },
            indent=2,
        )
    except httpx.HTTPStatusError as e:
        return json.dumps(
            {
                "error": f"HTTP {e.response.status_code}",
                "message": str(e),
                "suggestion": "Check your API token is valid and try again.",
            },
            indent=2,
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
) -> str:
    """
    Use this when you need a static preview image of a chart to display or embed.
    Returns a direct URL to a PNG image of the chart. Useful for including chart
    previews in responses or documents.

    Args:
        pub_id: The unique identifier (pub_id/card_id) of the chart
        api_token: Your Tako API token for authentication
        dark_mode: Whether to return dark mode version of the image (default: True)

    Returns:
        JSON with image_url (public PNG URL), pub_id, and dark_mode setting
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/image/{pub_id}/",
            params={"dark_mode": str(dark_mode).lower()},
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 200:
            image_url = f"{PUBLIC_API_URL}/api/v1/image/{pub_id}/?dark_mode={str(dark_mode).lower()}"
            return json.dumps(
                {
                    "image_url": image_url,
                    "pub_id": pub_id,
                    "dark_mode": dark_mode,
                },
                indent=2,
            )
        elif resp.status_code == 404:
            return json.dumps({
                "error": "Chart image not found",
                "pub_id": pub_id,
                "suggestion": "Verify the pub_id/card_id is correct. Use knowledge_search to find valid chart IDs.",
            })
        elif resp.status_code == 408:
            return json.dumps({
                "error": "Image generation timed out",
                "pub_id": pub_id,
                "suggestion": "The image is still rendering. Wait a few seconds and try again.",
            })
        else:
            resp.raise_for_status()
            return json.dumps({
                "error": "Unexpected error",
                "suggestion": "Check your API token and try again. If the issue persists, the Tako API may be temporarily unavailable.",
            })


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
) -> str:
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
        JSON with pub_id, insights (bullet-point analysis), and description (narrative summary)
    """
    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/internal/chart-configs/{pub_id}/chart-insights/",
            params={"effort": effort},
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 404:
            return json.dumps({
                "error": "Chart not found",
                "pub_id": pub_id,
                "suggestion": "Verify the pub_id/card_id is correct. Use knowledge_search to find valid chart IDs.",
            })

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
) -> str:
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
        JSON with entities, metrics, cohorts, time_periods, and total_matches
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

            result = {
                "query": data.get("query"),
                "total_matches": data.get("total_matches", 0),
                "entities": [
                    {
                        "name": e.get("name"),
                        "type": e.get("type"),
                        "description": e.get("description"),
                        "aliases": e.get("aliases", [])[:3],
                        "available_tables": e.get("available_tables", [])[:3],
                        "node_id": e.get("node_id"),
                    }
                    for e in data.get("entities", [])
                ],
                "metrics": [
                    {
                        "name": m.get("name"),
                        "description": m.get("description"),
                        "units": m.get("units", [])[:3],
                        "time_periods": m.get("time_periods", [])[:3],
                        "compatible_tables": m.get("compatible_tables", [])[:3],
                        "node_id": m.get("node_id"),
                    }
                    for m in data.get("metrics", [])
                ],
                "cohorts": [
                    {
                        "name": c.get("name"),
                        "description": c.get("description"),
                        "member_count": c.get("member_count"),
                        "sample_members": c.get("sample_members", []),
                        "node_id": c.get("node_id"),
                    }
                    for c in data.get("cohorts", [])
                ],
                "time_periods": data.get("time_periods", []),
                "execution_time_ms": data.get("execution_time_ms", 0),
            }

            elapsed_time = time.time() - start_time
            logging.debug(
                f"explore_knowledge_graph completed in {elapsed_time:.2f}s: "
                f"query={query[:50]}, total_matches={result['total_matches']}"
            )
            return json.dumps(result, indent=2)

    except httpx.TimeoutException:
        elapsed_time = time.time() - start_time
        logging.warning(
            f"explore_knowledge_graph timed out after {elapsed_time:.2f}s: query={query[:50]}"
        )
        return json.dumps(
            {
                "error": "Request timed out",
                "message": "The explore request took too long.",
                "suggestion": "Try a more specific query or filter by node_types to narrow results.",
            },
            indent=2,
        )
    except httpx.HTTPStatusError as e:
        return json.dumps(
            {
                "error": f"HTTP {e.response.status_code}",
                "message": str(e),
                "suggestion": "Check your API token is valid and try again.",
            },
            indent=2,
        )
    except Exception as e:
        logging.error(f"explore_knowledge_graph error: {e}", exc_info=True)
        return json.dumps(
            {
                "error": "Unexpected error",
                "message": str(e),
                "suggestion": "Check your API token and try again. If the issue persists, the Tako API may be temporarily unavailable.",
            },
            indent=2,
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
) -> str:
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
        JSON with schemas array (name, description, components) and count
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
                entry = {
                    "name": name,
                    "description": schema.get("description"),
                    "use_case": _schema_use_cases.get(name, ""),
                    "components": schema.get("components", []),
                }
                result.append(entry)

            return json.dumps({"schemas": result, "count": len(result)}, indent=2)
    except httpx.HTTPStatusError as e:
        return json.dumps(
            {
                "error": f"HTTP {e.response.status_code}",
                "message": str(e),
                "suggestion": "Check your API token is valid and try again.",
            },
            indent=2,
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
) -> str:
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
        JSON with schema name, description, components array, and template details
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/thin_viz/default_schema/{schema_name}/",
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 404:
            return json.dumps({
                "error": f"Schema '{schema_name}' not found",
                "suggestion": "Use list_chart_schemas to see all available schema names.",
            })

        resp.raise_for_status()
        schema = resp.json()

        return json.dumps({
            "name": schema.get("name"),
            "description": schema.get("description"),
            "components": schema.get("components", []),
            "template": schema.get("template"),
        }, indent=2)


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
) -> str:
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
        JSON with card_id, title, description, webpage_url, embed_url, image_url,
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
                return json.dumps({
                    "error": f"Schema '{schema_name}' not found",
                    "suggestion": "Use list_chart_schemas to see all available schema names.",
                })
            if resp.status_code == 400:
                error_data = resp.json()
                return json.dumps({
                    "error": "Invalid component configuration",
                    "details": error_data,
                    "suggestion": "Use get_chart_schema to see the required data format for this schema.",
                })

            resp.raise_for_status()
            data = resp.json()

            card_id = data.get("card_id")
            result = {
                "card_id": card_id,
                "title": data.get("title"),
                "description": data.get("description"),
                "webpage_url": data.get("webpage_url"),
                "embed_url": data.get("embed_url"),
                "image_url": data.get("image_url"),
            }

            # Add hint about opening the chart UI
            if card_id:
                result["open_ui_tool"] = "open_chart_ui"
                result["open_ui_args"] = {"pub_id": card_id}

            return json.dumps(result, indent=2)

    except httpx.HTTPStatusError as e:
        return json.dumps({
            "error": f"HTTP {e.response.status_code}",
            "message": str(e),
            "suggestion": "Check your API token and component configuration. Use get_chart_schema to verify the expected format.",
        }, indent=2)
    except Exception as e:
        logging.error(f"create_chart error: {e}", exc_info=True)
        return json.dumps({
            "error": "Unexpected error",
            "message": str(e),
            "suggestion": "Check your API token and try again. If the issue persists, the Tako API may be temporarily unavailable.",
        }, indent=2)


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
    logging.info(f"Listening on {host}:{port}")
    logging.info("=" * 60)

    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
