import { createTakoClient } from "tako-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TAKO_API_KEY =
  process.env.TAKO_API_KEY ??
  (() => {
    throw new Error("TAKO_API_KEY environment variable is required");
  })();
const tako_client = createTakoClient(TAKO_API_KEY);

// Create server instance
const server = new McpServer({
  name: "tako",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

async function search_tako(text: string) {
  try {
    const response = await tako_client.knowledgeSearch(text);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(response)
        }
      ]
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No card found"
        }
      ],
      isError: true
    };
  }
}

server.tool(
  "search_tako",
  "Search Tako for any knowledge you want and get data and visualizations.",
  {
    text: z.string().describe("The text to search Tako for"),
  },
  async ({ text }) => {
    return await search_tako(text);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });