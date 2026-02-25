"""
Tako integration for Microsoft AutoGen.

Provides AutoGen-compatible function definitions that wrap the Tako API,
enabling agents in AutoGen multi-agent conversations to search for charts,
create visualisations, list chart schemas, retrieve AI-generated insights,
and fetch chart images.

Usage:
    import autogen
    from integrations.autogen_tako import register_tako_tools

    assistant = autogen.AssistantAgent("analyst", llm_config=llm_config)
    register_tako_tools(assistant, api_token="your-tako-api-token")
"""

from __future__ import annotations

import json
from typing import Any, Optional

try:
    import autogen  # noqa: F401 – validate availability
except ImportError:
    raise ImportError(
        "AutoGen is required for this integration. "
        "Install it with: pip install pyautogen"
    )

try:
    import httpx
except ImportError:
    raise ImportError(
        "httpx is required for this integration. "
        "Install it with: pip install httpx"
    )

DEFAULT_API_URL = "https://api.tako.com"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

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
# Function definitions for AutoGen function_map
# ---------------------------------------------------------------------------

# Each factory returns a callable with the correct signature.  The api_token
# and api_url are captured via closure so that they never need to be passed
# by the LLM at call time.


def _make_search_charts(api_token: str, api_url: str):
    """Create the search_charts function bound to credentials."""

    def search_charts(
        query: str,
        count: int = 5,
        search_effort: str = "deep",
        country_code: str = "US",
        locale: str = "en-US",
    ) -> str:
        """Search Tako's knowledge base for charts and data visualisations.

        Use this when you need to find existing charts and data visualisations on
        any topic.  Searches Tako's curated knowledge base covering economics,
        finance, demographics, technology, and more.

        Args:
            query: Natural language search query (e.g. "US GDP growth").
            count: Number of results to return (1-20).
            search_effort: "fast" or "deep".
            country_code: ISO country code (e.g. "US").
            locale: Locale string (e.g. "en-US").

        Returns:
            JSON string with matching chart results.
        """
        try:
            with httpx.Client(timeout=60.0, follow_redirects=True) as client:
                resp = client.post(
                    f"{api_url.rstrip('/')}/api/v1/knowledge_search",
                    json={
                        "inputs": {"text": query, "count": count},
                        "source_indexes": ["tako"],
                        "search_effort": search_effort,
                        "country_code": country_code,
                        "locale": locale,
                    },
                    headers=_headers(api_token),
                )
                resp.raise_for_status()

                data = resp.json()
                cards = data.get("outputs", {}).get("knowledge_cards", [])
                results = [
                    {
                        "card_id": c.get("card_id"),
                        "title": c.get("title"),
                        "description": c.get("description"),
                        "url": c.get("url"),
                        "source": c.get("source"),
                    }
                    for c in cards
                ]
                return json.dumps({"results": results, "count": len(results)}, indent=2)

        except httpx.TimeoutException:
            return _error_response(
                "Request timed out",
                "The search request took too long.",
                "Try search_effort='fast' or a more specific query.",
            )
        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token is valid and try again.",
            )

    return search_charts


def _make_create_chart(api_token: str, api_url: str):
    """Create the create_chart function bound to credentials."""

    def create_chart(
        schema_name: str,
        components: list[dict[str, Any]],
        source: Optional[str] = None,
    ) -> str:
        """Create a new chart on Tako from raw data.

        Use this when you need to create a new interactive visualisation. Supports
        15+ chart types. Call list_chart_schemas first to discover available types.

        Args:
            schema_name: Chart schema name (e.g. "bar_chart", "timeseries_card").
            components: List of component dicts with "component_type" and "config".
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
                    f"{api_url.rstrip('/')}/api/v1/thin_viz/default_schema/{schema_name}/create/",
                    json=payload,
                    headers=_headers(api_token),
                )

                if resp.status_code == 404:
                    return json.dumps({
                        "error": f"Schema '{schema_name}' not found",
                        "suggestion": "Use list_chart_schemas to see available names.",
                    })
                if resp.status_code == 400:
                    return json.dumps({
                        "error": "Invalid component configuration",
                        "details": resp.json(),
                        "suggestion": "Check component structure against the schema.",
                    })

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

    return create_chart


def _make_list_chart_schemas(api_token: str, api_url: str):
    """Create the list_chart_schemas function bound to credentials."""

    def list_chart_schemas() -> str:
        """List all available chart schemas (templates) on Tako.

        Use this when you want to see available chart types before creating a
        chart. Returns schema names, descriptions, and component info.

        Returns:
            JSON string with available schemas.
        """
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(
                    f"{api_url.rstrip('/')}/api/v1/thin_viz/default_schema/",
                    headers=_headers(api_token),
                )
                resp.raise_for_status()
                schemas = resp.json()
                result = [
                    {
                        "name": s.get("name"),
                        "description": s.get("description"),
                        "components": s.get("components", []),
                    }
                    for s in schemas
                ]
                return json.dumps({"schemas": result, "count": len(result)}, indent=2)

        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token is valid and try again.",
            )

    return list_chart_schemas


def _make_get_chart_insights(api_token: str, api_url: str):
    """Create the get_chart_insights function bound to credentials."""

    def get_chart_insights(
        pub_id: str,
        effort: str = "medium",
    ) -> str:
        """Get AI-generated insights for a Tako chart.

        Use this when you want analysis of a chart's data. Returns bullet-point
        insights and a natural language description summarising trends and
        key takeaways.

        Args:
            pub_id: The chart's unique identifier (pub_id / card_id).
            effort: Reasoning depth - "low", "medium", or "high".

        Returns:
            JSON string with insights and description.
        """
        try:
            with httpx.Client(timeout=90.0) as client:
                resp = client.get(
                    f"{api_url.rstrip('/')}/api/v1/internal/chart-configs/{pub_id}/chart-insights/",
                    params={"effort": effort},
                    headers=_headers(api_token),
                )

                if resp.status_code == 404:
                    return json.dumps({
                        "error": "Chart not found",
                        "pub_id": pub_id,
                        "suggestion": "Verify the pub_id/card_id is correct.",
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

        except httpx.HTTPStatusError as exc:
            return _error_response(
                f"HTTP {exc.response.status_code}",
                str(exc),
                "Check your API token and pub_id, then try again.",
            )

    return get_chart_insights


def _make_get_chart_image(api_token: str, api_url: str):
    """Create the get_chart_image function bound to credentials."""

    def get_chart_image(
        pub_id: str,
        dark_mode: bool = True,
    ) -> str:
        """Get a static PNG preview image URL for a Tako chart.

        Use this when you need a chart image to display or embed in a document.

        Args:
            pub_id: The chart's unique identifier (pub_id / card_id).
            dark_mode: Whether to return the dark-mode version (default True).

        Returns:
            JSON string with image_url, pub_id, and dark_mode.
        """
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.get(
                    f"{api_url.rstrip('/')}/api/v1/image/{pub_id}/",
                    params={"dark_mode": str(dark_mode).lower()},
                    headers=_headers(api_token),
                )

                if resp.status_code == 200:
                    image_url = (
                        f"{api_url.rstrip('/')}/api/v1/image/{pub_id}/"
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
                    return json.dumps({
                        "error": "Chart image not found",
                        "pub_id": pub_id,
                        "suggestion": "Verify the pub_id/card_id is correct.",
                    })
                elif resp.status_code == 408:
                    return json.dumps({
                        "error": "Image generation timed out",
                        "pub_id": pub_id,
                        "suggestion": "Wait a few seconds and try again.",
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

    return get_chart_image


def _make_explore_knowledge_graph(api_token: str, api_url: str):
    """Create the explore_knowledge_graph function bound to credentials."""

    def explore_knowledge_graph(
        query: str,
        node_types: Optional[list[str]] = None,
        limit: int = 20,
    ) -> str:
        """Explore Tako's knowledge graph to discover available data.

        Use this when you need to discover what data is available before
        searching. Helps find entities, metrics, cohorts, and time periods.

        Args:
            query: Natural language query to explore.
            node_types: Optional filter for node types.
            limit: Maximum results per type (1-50).

        Returns:
            JSON string with entities, metrics, cohorts, time_periods.
        """
        try:
            with httpx.Client(timeout=60.0, follow_redirects=True) as client:
                resp = client.post(
                    f"{api_url.rstrip('/')}/api/v1/explore/",
                    json={
                        "query": query,
                        "node_types": node_types,
                        "limit": limit,
                    },
                    headers=_headers(api_token),
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

    return explore_knowledge_graph


def _make_get_chart_schema(api_token: str, api_url: str):
    """Create the get_chart_schema function bound to credentials."""

    def get_chart_schema(schema_name: str) -> str:
        """Get the detailed schema definition for a specific chart type.

        Use this when you need to understand the data format for a chart type.
        Always call this before create_chart.

        Args:
            schema_name: Schema name (e.g. 'bar_chart', 'timeseries_card').

        Returns:
            JSON string with schema details.
        """
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(
                    f"{api_url.rstrip('/')}/api/v1/thin_viz/default_schema/{schema_name}/",
                    headers=_headers(api_token),
                )
                if resp.status_code == 404:
                    return json.dumps({
                        "error": f"Schema '{schema_name}' not found",
                        "suggestion": "Use list_chart_schemas to see available names.",
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

    return get_chart_schema


def _make_open_chart_ui(api_token: str, api_url: str):
    """Create the open_chart_ui function bound to credentials."""

    def open_chart_ui(
        pub_id: str,
        dark_mode: bool = True,
    ) -> str:
        """Generate an interactive embed URL for a Tako chart.

        Use this when you want to display an interactive chart to the user.
        No API call is made — the URL is constructed locally.

        Args:
            pub_id: The chart's unique identifier (pub_id / card_id).
            dark_mode: Whether to use dark mode (default True).

        Returns:
            JSON string with pub_id, embed_url, dark_mode.
        """
        theme = "dark" if dark_mode else "light"
        embed_url = f"https://tako.com/embed/{pub_id}/?theme={theme}"
        return json.dumps(
            {"pub_id": pub_id, "embed_url": embed_url, "dark_mode": dark_mode},
            indent=2,
        )

    return open_chart_ui


# ---------------------------------------------------------------------------
# AutoGen function tool definitions (for register_for_llm)
# ---------------------------------------------------------------------------

TAKO_FUNCTION_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "search_charts",
        "description": (
            "Search Tako's knowledge base for charts and data visualisations on any "
            "topic. Returns matching charts with titles, descriptions, and URLs."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural language search query (e.g. 'US GDP growth').",
                },
                "count": {
                    "type": "integer",
                    "description": "Number of results (1-20). Default: 5.",
                },
                "search_effort": {
                    "type": "string",
                    "enum": ["fast", "deep"],
                    "description": "Search depth. Default: 'deep'.",
                },
                "country_code": {
                    "type": "string",
                    "description": "ISO country code (e.g. 'US'). Default: 'US'.",
                },
                "locale": {
                    "type": "string",
                    "description": "Locale (e.g. 'en-US'). Default: 'en-US'.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "explore_knowledge_graph",
        "description": (
            "Explore Tako's knowledge graph to discover available entities, metrics, "
            "cohorts, and time periods. Use before search to understand what data exists."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural language query to explore.",
                },
                "node_types": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Filter by node types: entity, metric, cohort, db, units, time_period, property.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results per type (1-50). Default: 20.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "create_chart",
        "description": (
            "Create a new interactive chart on Tako from raw data. Supports 15+ "
            "chart types. Call list_chart_schemas first to see available types."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "schema_name": {
                    "type": "string",
                    "description": "Chart schema name (e.g. 'bar_chart', 'timeseries_card').",
                },
                "components": {
                    "type": "array",
                    "description": "Component configurations with 'component_type' and 'config'.",
                    "items": {"type": "object"},
                },
                "source": {
                    "type": "string",
                    "description": "Optional attribution text (e.g. 'Yahoo Finance').",
                },
            },
            "required": ["schema_name", "components"],
        },
    },
    {
        "name": "list_chart_schemas",
        "description": (
            "List all available chart schemas (templates) on Tako. Returns schema "
            "names, descriptions, and component information."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "get_chart_schema",
        "description": (
            "Get the detailed schema definition for a specific chart type. "
            "Always call this before create_chart to understand the data format."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "schema_name": {
                    "type": "string",
                    "description": "Schema name (e.g. 'bar_chart', 'timeseries_card').",
                },
            },
            "required": ["schema_name"],
        },
    },
    {
        "name": "get_chart_insights",
        "description": (
            "Get AI-generated insights for a Tako chart. Returns bullet-point "
            "analysis and a natural language description of trends and takeaways."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pub_id": {
                    "type": "string",
                    "description": "The chart's unique identifier (pub_id / card_id).",
                },
                "effort": {
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                    "description": "Reasoning depth. Default: 'medium'.",
                },
            },
            "required": ["pub_id"],
        },
    },
    {
        "name": "get_chart_image",
        "description": (
            "Get a static PNG preview image URL for a Tako chart. Useful for "
            "embedding chart previews in responses or documents."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pub_id": {
                    "type": "string",
                    "description": "The chart's unique identifier (pub_id / card_id).",
                },
                "dark_mode": {
                    "type": "boolean",
                    "description": "Dark mode image. Default: true.",
                },
            },
            "required": ["pub_id"],
        },
    },
    {
        "name": "open_chart_ui",
        "description": (
            "Generate an interactive embed URL for a Tako chart. Returns a URL "
            "with zooming, panning, and hover interactions."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pub_id": {
                    "type": "string",
                    "description": "The chart's unique identifier (pub_id / card_id).",
                },
                "dark_mode": {
                    "type": "boolean",
                    "description": "Dark mode theme. Default: true.",
                },
            },
            "required": ["pub_id"],
        },
    },
]


# ---------------------------------------------------------------------------
# Registration helper
# ---------------------------------------------------------------------------

def register_tako_tools(
    agent: Any,
    api_token: str,
    api_url: str = DEFAULT_API_URL,
) -> dict[str, Any]:
    """
    Register Tako tools with an AutoGen agent.

    This registers both the LLM-facing function definitions (so the model
    knows how to call them) and the execution-side function_map (so AutoGen
    can execute the calls).

    Args:
        agent: An AutoGen ConversableAgent (e.g. AssistantAgent or
               UserProxyAgent).
        api_token: Your Tako API token (from https://tako.com account settings).
        api_url: Base URL for the Tako API. Defaults to https://api.tako.com.

    Returns:
        A dict mapping function names to their callables (the function_map),
        which can also be passed to a UserProxyAgent if needed.

    Example:
        import autogen

        config_list = [{"model": "gpt-4", "api_key": "..."}]
        llm_config = {"config_list": config_list}

        assistant = autogen.AssistantAgent("analyst", llm_config=llm_config)
        user_proxy = autogen.UserProxyAgent("user", code_execution_config=False)

        function_map = register_tako_tools(assistant, api_token="tak_...")

        # If using a separate executor agent, register the function_map there:
        user_proxy.register_function(function_map=function_map)
    """
    function_map = {
        "search_charts": _make_search_charts(api_token, api_url),
        "explore_knowledge_graph": _make_explore_knowledge_graph(api_token, api_url),
        "create_chart": _make_create_chart(api_token, api_url),
        "list_chart_schemas": _make_list_chart_schemas(api_token, api_url),
        "get_chart_schema": _make_get_chart_schema(api_token, api_url),
        "get_chart_insights": _make_get_chart_insights(api_token, api_url),
        "get_chart_image": _make_get_chart_image(api_token, api_url),
        "open_chart_ui": _make_open_chart_ui(api_token, api_url),
    }

    # Register function definitions with the agent's LLM config so the model
    # knows these tools are available.
    if hasattr(agent, "llm_config") and agent.llm_config is not None:
        functions = agent.llm_config.get("functions", [])
        functions.extend(TAKO_FUNCTION_DEFINITIONS)
        agent.llm_config["functions"] = functions

    # Register function_map for execution.
    if hasattr(agent, "register_function"):
        agent.register_function(function_map=function_map)

    return function_map
