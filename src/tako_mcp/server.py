"""
Tako MCP Server

Exposes Tako's knowledge base and interactive charts via the Model Context Protocol (MCP).

This server allows AI agents to:
- Search for relevant charts and datasets
- Fetch chart preview images and AI-generated insights
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
TAKO_API_URL = os.environ.get("TAKO_API_URL", "https://api.trytako.com").rstrip("/")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://trytako.com").rstrip("/")

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
            "https://trytako.com",
        ],
    ),
)


def _get_auth_header(api_token: str | None) -> dict:
    """Build request headers with authentication."""
    headers = {"Content-Type": "application/json"}
    if api_token:
        headers["X-API-Key"] = api_token
    return headers


@mcp.tool()
async def knowledge_search(
    query: str,
    api_token: str,
    count: int = 5,
    search_effort: str = "deep",
    country_code: str = "US",
    locale: str = "en-US",
) -> str:
    """
    Search Tako's knowledge base for charts and data visualizations.

    Args:
        query: Natural language search query for charts and data
        api_token: Your Tako API token for authentication
        count: Number of results to return (1-20), defaults to 5
        search_effort: Search depth - "fast" for quick results, "deep" for comprehensive search
        country_code: ISO country code for localized results (e.g., "US", "GB")
        locale: Locale for results (e.g., "en-US", "en-GB")

    Returns:
        JSON response containing matching charts with URLs, titles, descriptions, and metadata
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
                "message": "The search request took too long. Try using search_effort='fast' for quicker results.",
            },
            indent=2,
        )


@mcp.tool()
async def get_chart_image(
    pub_id: str,
    api_token: str,
    dark_mode: bool = True,
) -> str:
    """
    Get the preview image URL for a chart.

    Args:
        pub_id: The unique identifier (pub_id/card_id) of the chart
        api_token: Your Tako API token for authentication
        dark_mode: Whether to return dark mode version of the image (default: True)

    Returns:
        URL to the chart's preview image that can be displayed or embedded
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/image/{pub_id}/",
            params={"dark_mode": str(dark_mode).lower()},
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 200:
            image_url = f"{TAKO_API_URL}/api/v1/image/{pub_id}/?dark_mode={str(dark_mode).lower()}"
            return json.dumps(
                {
                    "image_url": image_url,
                    "pub_id": pub_id,
                    "dark_mode": dark_mode,
                },
                indent=2,
            )
        elif resp.status_code == 404:
            return json.dumps({"error": "Chart image not found", "pub_id": pub_id})
        elif resp.status_code == 408:
            return json.dumps(
                {"error": "Image generation timed out, try again", "pub_id": pub_id}
            )
        else:
            resp.raise_for_status()
            return json.dumps({"error": "Unexpected error"})


@mcp.tool()
async def get_card_insights(
    pub_id: str,
    api_token: str,
    effort: str = "medium",
) -> str:
    """
    Get AI-generated insights for a chart.

    Args:
        pub_id: The unique identifier (pub_id/card_id) of the chart
        api_token: Your Tako API token for authentication
        effort: Reasoning effort level - "low", "medium", or "high" (default: "medium")

    Returns:
        JSON with bullet-point insights and a description analyzing the chart's data
    """
    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/internal/chart-configs/{pub_id}/chart-insights/",
            params={"effort": effort},
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 404:
            return json.dumps({"error": "Chart not found", "pub_id": pub_id})

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


@mcp.tool()
async def explore_knowledge_graph(
    query: str,
    api_token: str,
    node_types: list[str] | None = None,
    limit: int = 20,
) -> str:
    """
    Explore Tako's knowledge graph to discover available entities, metrics, cohorts, and other data.

    Use this tool to:
    - Find what entities are available (companies, countries, people, etc.)
    - Discover metrics and measurements that can be queried
    - Check which data is available before constructing a search query
    - Disambiguate ambiguous entity names (e.g., "Apple" could be the company or the fruit)

    Args:
        query: Natural language query to explore the knowledge graph (e.g., "tech companies", "GDP metrics")
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
        JSON response with discovered entities, metrics, cohorts, and time periods
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
                "message": "The explore request took too long. Try a more specific query.",
            },
            indent=2,
        )
    except httpx.HTTPStatusError as e:
        return json.dumps(
            {
                "error": f"HTTP {e.response.status_code}",
                "message": str(e),
            },
            indent=2,
        )
    except Exception as e:
        logging.error(f"explore_knowledge_graph error: {e}", exc_info=True)
        return json.dumps(
            {
                "error": "Unexpected error",
                "message": str(e),
            },
            indent=2,
        )


# =============================================================================
# ThinViz API - Create charts from templates with your own data
# =============================================================================


@mcp.tool()
async def list_chart_schemas(
    api_token: str,
) -> str:
    """
    List available chart schemas (templates) for creating visualizations.

    ThinViz schemas are pre-configured templates that simplify chart creation.
    Each schema defines what components are needed (e.g., timeseries, bar chart, header).

    Args:
        api_token: Your Tako API token for authentication

    Returns:
        JSON list of available schemas with their names, descriptions, and required components
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/thin_viz/default_schema/",
            headers=_get_auth_header(api_token),
        )
        resp.raise_for_status()
        schemas = resp.json()

        # Simplify response for readability
        result = []
        for schema in schemas:
            result.append({
                "name": schema.get("name"),
                "description": schema.get("description"),
                "components": schema.get("components", []),
            })

        return json.dumps({"schemas": result, "count": len(result)}, indent=2)


@mcp.tool()
async def get_chart_schema(
    schema_name: str,
    api_token: str,
) -> str:
    """
    Get detailed information about a chart schema including required component configurations.

    Use this to understand what data format is needed before calling create_chart.

    Args:
        schema_name: Name of the schema (e.g., "stock_card", "bar_chart", "grouped_bar_chart")
        api_token: Your Tako API token for authentication

    Returns:
        JSON with schema details including component types and their configuration options
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{TAKO_API_URL}/api/v1/thin_viz/default_schema/{schema_name}/",
            headers=_get_auth_header(api_token),
        )

        if resp.status_code == 404:
            return json.dumps({"error": f"Schema '{schema_name}' not found"})

        resp.raise_for_status()
        schema = resp.json()

        return json.dumps({
            "name": schema.get("name"),
            "description": schema.get("description"),
            "components": schema.get("components", []),
            "template": schema.get("template"),
        }, indent=2)


@mcp.tool()
async def create_chart(
    schema_name: str,
    components: list[dict],
    api_token: str,
    source: str | None = None,
) -> str:
    """
    Create a new chart using a schema template and your own data.

    This is the primary way to create custom visualizations with Tako.
    Use list_chart_schemas and get_chart_schema to understand available options.

    Args:
        schema_name: Name of the schema to use (e.g., "stock_card", "bar_chart", "grouped_bar_chart")
        components: List of component configurations matching the schema requirements.
            Each component needs "component_type" and "config" fields.
        api_token: Your Tako API token for authentication
        source: Optional attribution text (e.g., "Yahoo Finance", "Company Reports")

    Returns:
        JSON with the created chart's card_id, embed_url, image_url, and other metadata

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
                return json.dumps({"error": f"Schema '{schema_name}' not found"})
            if resp.status_code == 400:
                error_data = resp.json()
                return json.dumps({
                    "error": "Invalid component configuration",
                    "details": error_data,
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
        }, indent=2)
    except Exception as e:
        logging.error(f"create_chart error: {e}", exc_info=True)
        return json.dumps({
            "error": "Unexpected error",
            "message": str(e),
        }, indent=2)


# =============================================================================
# MCP-UI - Interactive chart embedding
# =============================================================================


@mcp.tool()
async def open_chart_ui(
    pub_id: str,
    dark_mode: bool = True,
    width: int = 900,
    height: int = 600,
) -> list[UIResource]:
    """
    Open an interactive chart in the UI.

    Returns an MCP-UI resource that renders a fully interactive Tako chart
    with zooming, filtering, hover interactions, and responsive resizing.

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


# ASGI application setup
_mcp_app = mcp.sse_app()


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
    """ASGI application with custom error handling for MCP SSE connections."""
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
                "timestamp": time.time(),
            }
            response = JSONResponse(health_data)
            wrapped_send = _wrap_send(send, response_started)
            await response(scope, receive, wrapped_send)
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
        await _mcp_app(scope, receive, wrapped_send)
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
    logging.info(f"Listening on {host}:{port}")
    logging.info("=" * 60)

    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
