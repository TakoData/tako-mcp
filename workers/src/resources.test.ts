import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { describe, expect, it } from "vitest";

import type { Env } from "./env.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { createMcpServer } from "./mcp.js";
import {
  DOC_MIME_TYPE,
  DOC_RESOURCE_URIS,
  docResources,
  registerDocResources,
} from "./resources.js";
import type { Tier } from "./freetier.js";
import type { Surface } from "./surface.js";
import { TOOL_REGISTRY } from "./tools/_registry.js";
import { DOMAINS, FRESHNESS } from "./vocabulary.js";
import type { ToolContext } from "./tools/types.js";

const ctx: ToolContext = {
  token: "test-key",
  env: { DJANGO_BASE_URL: "http://localhost:8000" } as Env,
  sendProgress: async () => {},
  surface: "generic",
};

/** Drive a real server over an in-memory transport, as a client would. */
async function withClient<T>(
  options: Parameters<typeof createMcpServer>[1],
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createMcpServer(ctx, {
    ...options,
    surface: options?.surface ?? "generic",
  });
  const client = new Client(
    { name: "resource-test", version: "0.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// Only `chatgpt` registers the chart widget, so `generic` is the surface that
// used to reach resources/list with nothing registered — and it is the one every
// non-ChatGPT client lands on.
const SURFACES: Surface[] = ["generic", "chatgpt"];

function guideText(
  surface: Surface = "generic",
  tier: Tier = "authenticated",
): string {
  return String(
    docResources(surface, tier).find((d) => d.uri === DOC_RESOURCE_URIS[0])
      ?.text,
  );
}

function coverageText(): string {
  return String(
    docResources("generic", "authenticated").find(
      (d) => d.uri === DOC_RESOURCE_URIS[1],
    )?.text,
  );
}

describe("documentation resources", () => {
  it("resources/list is non-empty on every surface", async () => {
    // The regression: the widget-less surface advertised the `resources`
    // capability and then answered with an empty list, which capability-probing
    // clients and MCP directory audits score as broken.
    for (const surface of SURFACES) {
      const { resources } = await withClient({ surface }, (c) =>
        c.listResources(),
      );
      expect(resources.length, surface).toBeGreaterThan(0);
    }
  });

  it("resources/list is non-empty on the anonymous free tier", async () => {
    const { resources } = await withClient(
      { surface: "generic", tier: "free" },
      (c) => c.listResources(),
    );
    expect(resources.length).toBeGreaterThan(0);
  });

  it("every documentation resource appears in the list with its metadata", async () => {
    const { resources } = await withClient({ surface: "generic" }, (c) =>
      c.listResources(),
    );
    for (const doc of docResources("generic", "authenticated")) {
      const listed = resources.find((r) => r.uri === doc.uri);
      expect(listed, doc.uri).toBeDefined();
      expect(listed?.name).toBe(doc.name);
      expect(listed?.mimeType).toBe(DOC_MIME_TYPE);
      // The description is what a client shows before fetching; an entry
      // without one is a URI the model has no reason to read.
      expect(listed?.description).toBeTruthy();
    }
  });

  it("every listed resource can actually be read", async () => {
    for (const doc of docResources("generic", "authenticated")) {
      const result = await withClient({ surface: "generic" }, (c) =>
        c.readResource({ uri: doc.uri }),
      );
      expect(result.contents).toHaveLength(1);
      const [item] = result.contents;
      expect(item?.mimeType).toBe(DOC_MIME_TYPE);
      // The contents union is text-or-blob; these are always text, and
      // asserting that is part of the contract.
      expect(item && "text" in item ? item.text : undefined).toContain(
        "# Tako",
      );
    }
  });

  it("the widget resource still registers alongside the docs", async () => {
    // The chatgpt surface registers `ui://tako/embed/chart`; the doc resources
    // must not shadow it or trip the SDK's duplicate-URI guard.
    const { resources } = await withClient({ surface: "chatgpt" }, (c) =>
      c.listResources(),
    );
    const uris = resources.map((r) => r.uri);
    expect(uris.some((uri) => uri.startsWith("ui://"))).toBe(true);
    for (const doc of docResources("generic", "authenticated")) {
      expect(uris).toContain(doc.uri);
    }
  });

  it("resources/templates/list answers rather than erroring", async () => {
    // The removed empty-list fallback used to wire this handler by hand on
    // widget-less instances; registering any resource wires it instead.
    await expect(
      withClient({ surface: "generic" }, (c) => c.listResourceTemplates()),
    ).resolves.toBeDefined();
  });

  it("reading an unknown uri errors instead of returning empty contents", async () => {
    await expect(
      withClient({ surface: "generic" }, (c) =>
        c.readResource({ uri: "tako://guide/does-not-exist" }),
      ),
    ).rejects.toThrow();
  });

  it("documentation resource uris are unique", () => {
    const uris = [...DOC_RESOURCE_URIS];
    expect(new Set(uris).size).toBe(uris.length);
  });

  it("the docs name only tools the default surface actually registers", async () => {
    // A guide that names a tool the server does not register sends the model
    // after something that does not exist — the same failure the phantom-tool
    // checks guard on the prompt side. This caught a real one: the guide was
    // written naming `tako_answer`, which has since moved behind `?tools=answer`
    // and is absent from the default surface.
    const { tools } = await withClient({ surface: "generic" }, (c) =>
      c.listTools(),
    );
    const toolNames = new Set(tools.map((t) => t.name));
    const named = new Set(
      [...String(guideText()).matchAll(/`(tako_[a-z_]+)`/g)].map(
        (m) => m[1] as string,
      ),
    );
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) {
      expect(toolNames, name).toContain(name);
    }
  });

  it("the docs do not name a tool that no longer exists anywhere", () => {
    // Belt and braces for the case above: a tool deleted from the registry
    // outright would also vanish from the surface, but this asserts against the
    // registry so the failure message points at the real cause.
    const registryNames = new Set(
      TOOL_REGISTRY.map((t: { name: string }) => t.name),
    );
    for (const [, name] of String(guideText()).matchAll(/`(tako_[a-z_]+)`/g)) {
      expect(registryNames, name).toContain(name);
    }
  });

  it("every parameter the guide names exists on a registered tool", async () => {
    // The tool-NAME check above missed this class: the guide tells the model to
    // set `include_contents: true`, and a renamed or removed parameter leaves
    // that instruction silently wrong. Same failure as a phantom tool, one level
    // down.
    const { tools } = await withClient({ surface: "generic" }, (c) =>
      c.listTools(),
    );
    const known = new Set<string>();
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
      };
      for (const key of Object.keys(schema?.properties ?? {})) {
        known.add(key);
      }
    }
    const named = [...guideText().matchAll(/`([a-z][a-z0-9_]*): [^`]+`/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length).toBeGreaterThan(0);
    for (const param of named) {
      expect(known, param).toContain(param);
    }
  });

  it("the coverage document and the server instructions agree on the domains", () => {
    // They did not: the instructions listed `weather`, the resource did not, and
    // the resource added `US government spending` that the instructions lacked.
    // Both now render DOMAINS.
    const text = coverageText();
    for (const domain of DOMAINS) {
      expect(text, domain.name).toContain(domain.name);
    }
    // Both surfaces render DOMAINS, so every name appears in both.
    for (const domain of DOMAINS) {
      expect(SERVER_INSTRUCTIONS, domain.name).toContain(domain.name);
    }
  });

  it("the chatgpt surface documents the extra tool it registers", async () => {
    const { tools } = await withClient({ surface: "chatgpt" }, (c) =>
      c.listTools(),
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain("tako_visualize");
    expect(guideText("chatgpt", "authenticated")).toContain("tako_visualize");
    // ...and the generic guide must not promise a tool that surface lacks.
    expect(guideText("generic", "authenticated")).not.toContain(
      "tako_visualize",
    );
  });

  it("only the anonymous guide describes the anonymous gate", () => {
    expect(guideText("generic", "free")).toContain("anonymous");
    expect(guideText("generic", "authenticated")).not.toContain(
      "This connection is anonymous",
    );
  });

  it("a uri collision throws instead of dropping the document", () => {
    const server = createMcpServer(ctx, { surface: "generic" });
    // Re-registering into a set that already claims the URI is a programming
    // error, not a case to absorb silently.
    expect(() =>
      registerDocResources(
        server,
        new Set([DOC_RESOURCE_URIS[0]]),
        "generic",
        "authenticated",
      ),
    ).toThrow(/already registered/);
  });

  it("the freshness claim has one definition", () => {
    expect(guideText()).toContain(FRESHNESS);
  });

  it("the guide describes ?tools= as narrowing, not unlocking", () => {
    // `?tools=` became an allowlist that REPLACES the default listing (#263).
    // The guide still said it "unlocks further tools", which is now backwards --
    // exactly the prose-goes-stale-when-code-changes failure this document is
    // most exposed to, since nothing type-checks a sentence.
    const text = guideText();
    expect(text).toContain("REPLACES");
    // The old claim, not the bare word -- the corrected sentence says "does not
    // unlock extras", which is the point.
    expect(text).not.toContain("unlock through");
    expect(text).not.toContain("Further tools unlock");
  });
});
