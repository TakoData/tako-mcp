#!/usr/bin/env python3
"""
Test client for the Tako MCP server.

Usage:
    python -m tests.test_client --api-token YOUR_API_TOKEN
    python -m tests.test_client --url http://localhost:8001 --api-token YOUR_API_TOKEN
"""

import argparse
import asyncio
import json
import sys
import traceback

import httpx

DEFAULT_MCP_BASE_URL = "http://localhost:8001"


class MCPClient:
    """Async MCP client that connects via SSE."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.session_id = None
        self.message_id = 0
        self._responses = {}
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))
        self._sse_task = None

    async def connect(self):
        """Establish SSE connection and receive session_id."""
        self._sse_task = asyncio.create_task(self._sse_reader())
        for _ in range(50):
            if self.session_id:
                await asyncio.sleep(0.2)
                return True
            await asyncio.sleep(0.1)
        return False

    async def _sse_reader(self):
        """Read SSE events from the server."""
        try:
            async with self._client.stream("GET", f"{self.base_url}/sse") as resp:
                if resp.status_code != 200:
                    print(f"SSE connection failed with status {resp.status_code}")
                    return
                event_type = None
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    if line.startswith("event:"):
                        event_type = line[6:].strip()
                    elif line.startswith("data:"):
                        data = line[5:].strip()
                        if event_type == "endpoint" and "session_id=" in data:
                            self.session_id = data.split("session_id=")[1].split("&")[0]
                            print(f"   Received session_id: {self.session_id}")
                        elif event_type == "message":
                            try:
                                msg = json.loads(data)
                                msg_id = msg.get("id")
                                if msg_id in self._responses:
                                    self._responses[msg_id].set_result(msg)
                            except Exception as e:
                                print(f"Error parsing message: {e}")
                        event_type = None
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"SSE error: {e}")

    async def close(self):
        """Close the SSE connection and HTTP client."""
        if self._sse_task:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except Exception:
                pass
        if self._client:
            await self._client.aclose()

    async def send(self, method: str, params: dict = None) -> dict:
        """Send a JSON-RPC method call to the server."""
        if not self.session_id:
            raise RuntimeError("No session_id. Call connect() first.")

        self.message_id += 1
        msg_id = self.message_id
        msg = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params:
            msg["params"] = params

        future = asyncio.get_event_loop().create_future()
        self._responses[msg_id] = future

        try:
            resp = await self._client.post(
                f"{self.base_url}/messages/?session_id={self.session_id}",
                json=msg,
            )
            if resp.status_code >= 400:
                try:
                    error_data = resp.json()
                    error_msg = error_data.get("error", resp.text)
                except Exception:
                    error_msg = resp.text
                raise RuntimeError(f"HTTP {resp.status_code}: {error_msg}")
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"HTTP error {e.response.status_code}: {e.response.text}")

        try:
            return await asyncio.wait_for(future, timeout=120.0)
        finally:
            self._responses.pop(msg_id, None)

    async def initialize(self):
        """Initialize the MCP session."""
        return await self.send(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1.0.0"},
            },
        )

    async def list_tools(self):
        """List available tools."""
        return await self.send("tools/list", {})

    async def call_tool(self, name: str, args: dict):
        """Call a tool with the given arguments."""
        return await self.send("tools/call", {"name": name, "arguments": args})


async def test_health(base_url: str) -> bool:
    """Test the health check endpoint."""
    print("\n" + "=" * 60)
    print("TEST: Health Check")
    print("=" * 60)
    async with httpx.AsyncClient() as c:
        try:
            r = await c.get(f"{base_url}/health")
            if r.status_code == 200:
                print(f"PASS: Health: {r.text}")
                return True
        except Exception as e:
            print(f"FAIL: {e}")
    return False


async def test_initialize(base_url: str) -> bool:
    """Test MCP initialization."""
    print("\n" + "=" * 60)
    print("TEST: Initialize")
    print("=" * 60)
    mcp = MCPClient(base_url)
    try:
        connected = await mcp.connect()
        if not connected:
            print("FAIL: Failed to connect - no session_id received")
            return False
        print(f"   Session ID: {mcp.session_id}")
        result = await mcp.initialize()
        info = result.get("result", {}).get("serverInfo", {})
        print(f"PASS: Server: {info}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        traceback.print_exc()
        return False
    finally:
        await mcp.close()


async def test_list_tools(base_url: str) -> bool:
    """Test listing available tools."""
    print("\n" + "=" * 60)
    print("TEST: List Tools")
    print("=" * 60)
    mcp = MCPClient(base_url)
    try:
        connected = await mcp.connect()
        if not connected:
            print("FAIL: Failed to connect")
            return False
        await mcp.initialize()
        result = await mcp.list_tools()
        tools = result.get("result", {}).get("tools", [])
        print(f"PASS: Found {len(tools)} tools:")
        for t in tools:
            print(f"   - {t['name']}")
        return len(tools) >= 4
    except Exception as e:
        print(f"FAIL: {e}")
        traceback.print_exc()
        return False
    finally:
        await mcp.close()


async def test_knowledge_search(base_url: str, api_token: str) -> dict | None:
    """Test the knowledge_search tool."""
    print("\n" + "=" * 60)
    print("TEST: knowledge_search")
    print("=" * 60)
    mcp = MCPClient(base_url)
    try:
        await mcp.connect()
        await mcp.initialize()
        print("   Searching: 'Intel vs Nvidia headcount'")
        result = await mcp.call_tool(
            "knowledge_search",
            {
                "query": "Intel vs Nvidia headcount",
                "api_token": api_token,
                "count": 3,
                "search_effort": "fast",
            },
        )
        content = result.get("result", {}).get("content", [])
        if content:
            data = json.loads(content[0].get("text", "{}"))
            results = data.get("results", [])
            print(f"PASS: Found {len(results)} results:")
            for r in results:
                print(f"   - {r.get('title', '?')[:50]}")
                print(f"     ID: {r.get('card_id')}")
            return data
    except Exception as e:
        print(f"FAIL: {e}")
        traceback.print_exc()
    finally:
        await mcp.close()
    return None


async def test_get_image(base_url: str, api_token: str, pub_id: str) -> bool:
    """Test the get_chart_image tool."""
    print("\n" + "=" * 60)
    print("TEST: get_chart_image")
    print("=" * 60)
    mcp = MCPClient(base_url)
    try:
        await mcp.connect()
        await mcp.initialize()
        print(f"   Getting image for: {pub_id}")
        result = await mcp.call_tool(
            "get_chart_image",
            {
                "pub_id": pub_id,
                "api_token": api_token,
            },
        )
        content = result.get("result", {}).get("content", [])
        if content:
            data = json.loads(content[0].get("text", "{}"))
            if "image_url" in data:
                print(f"PASS: Image URL: {data['image_url'][:60]}...")
                return True
            elif "error" in data:
                print(f"WARN: {data['error']}")
                return True
    except Exception as e:
        print(f"FAIL: {e}")
    finally:
        await mcp.close()
    return False


async def test_insights(base_url: str, api_token: str, pub_id: str) -> bool:
    """Test the get_card_insights tool."""
    print("\n" + "=" * 60)
    print("TEST: get_card_insights")
    print("=" * 60)
    mcp = MCPClient(base_url)
    try:
        await mcp.connect()
        await mcp.initialize()
        print(f"   Getting insights for: {pub_id}")
        result = await mcp.call_tool(
            "get_card_insights",
            {
                "pub_id": pub_id,
                "api_token": api_token,
                "effort": "low",
            },
        )
        content = result.get("result", {}).get("content", [])
        if content:
            data = json.loads(content[0].get("text", "{}"))
            if "error" in data:
                print(f"WARN: {data['error']}")
                return False
            print(f"PASS: Insights: {data.get('insights', '')[:100]}...")
            return True
    except Exception as e:
        print(f"FAIL: {e}")
        traceback.print_exc()
    finally:
        await mcp.close()
    return False


async def test_invalid_session(base_url: str) -> bool:
    """Test that invalid session IDs return 410."""
    print("\n" + "=" * 60)
    print("TEST: Invalid Session Handling")
    print("=" * 60)

    fake_session_id = "00000000-0000-0000-0000-000000000000"

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            print(f"   Testing with fake session_id: {fake_session_id}")
            resp = await client.post(
                f"{base_url}/messages/?session_id={fake_session_id}",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/list",
                    "params": {},
                },
            )

            if resp.status_code == 410:
                print("PASS: Got expected 410 response")
                return True
            elif resp.status_code >= 400:
                print(f"WARN: Got HTTP {resp.status_code} instead of 410")
                return True
            else:
                print(f"FAIL: Expected error response, got HTTP {resp.status_code}")
                return False

        except Exception as e:
            print(f"FAIL: {e}")
            traceback.print_exc()
            return False


async def test_list_schemas(base_url: str, api_token: str) -> bool:
    """Test the list_chart_schemas tool."""
    print("\n" + "=" * 60)
    print("TEST: list_chart_schemas")
    print("=" * 60)
    mcp = MCPClient(base_url)
    try:
        await mcp.connect()
        await mcp.initialize()
        result = await mcp.call_tool(
            "list_chart_schemas",
            {"api_token": api_token},
        )
        content = result.get("result", {}).get("content", [])
        if content:
            data = json.loads(content[0].get("text", "{}"))
            schemas = data.get("schemas", [])
            print(f"PASS: Found {len(schemas)} schemas:")
            for s in schemas:
                print(f"   - {s.get('name')}: {s.get('description', '')[:50]}")
            return len(schemas) > 0
    except Exception as e:
        print(f"FAIL: {e}")
        traceback.print_exc()
    finally:
        await mcp.close()
    return False


async def test_create_chart(base_url: str, api_token: str) -> str | None:
    """Test the create_chart tool and return the created card_id."""
    print("\n" + "=" * 60)
    print("TEST: create_chart")
    print("=" * 60)
    mcp = MCPClient(base_url)
    try:
        await mcp.connect()
        await mcp.initialize()
        print("   Creating bar chart...")
        result = await mcp.call_tool(
            "create_chart",
            {
                "schema_name": "bar_chart",
                "api_token": api_token,
                "source": "Test Data",
                "components": [
                    {
                        "component_type": "header",
                        "config": {
                            "title": "Test Revenue Chart",
                            "subtitle": "Created via MCP"
                        }
                    },
                    {
                        "component_type": "categorical_bar",
                        "config": {
                            "datasets": [{
                                "label": "Revenue",
                                "data": [
                                    {"x": "Q1", "y": 100},
                                    {"x": "Q2", "y": 120},
                                    {"x": "Q3", "y": 115},
                                    {"x": "Q4", "y": 140}
                                ],
                                "units": "$M"
                            }],
                            "title": "Quarterly Revenue"
                        }
                    }
                ]
            },
        )
        content = result.get("result", {}).get("content", [])
        if content:
            data = json.loads(content[0].get("text", "{}"))
            if "error" in data:
                print(f"FAIL: {data.get('error')}")
                print(f"   Details: {data.get('details', data.get('message', ''))}")
                return None
            card_id = data.get("card_id")
            print(f"PASS: Created chart with card_id: {card_id}")
            print(f"   Embed URL: {data.get('embed_url', '')[:60]}...")
            return card_id
    except Exception as e:
        print(f"FAIL: {e}")
        traceback.print_exc()
    finally:
        await mcp.close()
    return None


async def test_open_chart_ui(base_url: str, api_token: str, pub_id: str) -> bool:
    """Test the open_chart_ui tool."""
    print("\n" + "=" * 60)
    print("TEST: open_chart_ui (MCP-UI)")
    print("=" * 60)

    mcp = MCPClient(base_url)
    try:
        await mcp.connect()
        await mcp.initialize()

        print(f"   Opening UI for: {pub_id}")
        result = await mcp.call_tool(
            "open_chart_ui",
            {
                "pub_id": pub_id,
                "dark_mode": True,
                "width": 900,
                "height": 600,
            },
        )

        content = result.get("result", {}).get("content", [])
        if not content:
            print("FAIL: No content returned")
            return False

        resource_item = next((c for c in content if c.get("type") == "resource"), None)
        if not resource_item:
            print("FAIL: No resource content item found")
            return False

        resource = resource_item.get("resource", {})
        uri = resource.get("uri", "")

        if not uri.startswith("ui://"):
            print(f"FAIL: Resource uri does not start with ui:// (got: {uri})")
            return False

        print(f"PASS: UI resource uri: {uri}")
        return True

    except Exception as e:
        print(f"FAIL: {e}")
        traceback.print_exc()
        return False
    finally:
        await mcp.close()


async def run_all(base_url: str, api_token: str):
    """Run all tests."""
    print("#" * 60)
    print(f"# Tako MCP Tests - {base_url}")
    print("#" * 60)

    results = {
        "health": await test_health(base_url),
        "initialize": await test_initialize(base_url),
        "list_tools": await test_list_tools(base_url),
    }

    if not all(results.values()):
        print("\nFAIL: Basic tests failed")
        return False

    results["invalid_session"] = await test_invalid_session(base_url)

    if api_token:
        search = await test_knowledge_search(base_url, api_token)
        results["knowledge_search"] = search is not None

        pub_id = None
        if search and search.get("results"):
            pub_id = search["results"][0].get("card_id")
        else:
            print("WARN: No pub_id found from search, will use created chart")

        if pub_id:
            results["get_chart_image"] = await test_get_image(base_url, api_token, pub_id)
            results["get_card_insights"] = await test_insights(base_url, api_token, pub_id)
            results["open_chart_ui"] = await test_open_chart_ui(base_url, api_token, pub_id)

        # ThinViz tests
        results["list_chart_schemas"] = await test_list_schemas(base_url, api_token)
        created_card_id = await test_create_chart(base_url, api_token)
        results["create_chart"] = created_card_id is not None

        # If we didn't get a pub_id from search, use the created chart
        if not pub_id and created_card_id:
            results["open_chart_ui"] = await test_open_chart_ui(
                base_url, api_token, created_card_id
            )

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for name, ok in results.items():
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {name}")

    return all(results.values())


def main():
    parser = argparse.ArgumentParser(description="Test the Tako MCP server")
    parser.add_argument("--url", default=DEFAULT_MCP_BASE_URL, help="MCP server URL")
    parser.add_argument("--api-token", default="", help="Tako API token")
    args = parser.parse_args()

    ok = asyncio.run(run_all(args.url, args.api_token))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
