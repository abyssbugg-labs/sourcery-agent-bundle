/**
 * Server/tool tests: port of the unit-relevant server tests from
 * `python/tests/test_sourcery_bundle.py` (limit checks, bulk-validate-before-
 * client, capabilities surface) plus end-to-end tool calls through the MCP
 * SDK's InMemoryTransport with a recording fetch.
 */

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SourceryClient, ValidationError } from "../src/client.js";
import { API_BASE, SPEC_INFO, SPEC_SHA256 } from "../src/constants.js";
import { createSourceryServer } from "../src/server.js";
import { checkLimit, getTool, TOOLS } from "../src/tools.js";
import type { ToolContext } from "../src/tools.js";

/** The exact twelve tool names exposed over MCP. */
const TOOL_NAMES = [
  "sourcery_security_snapshot",
  "sourcery_list_findings",
  "sourcery_get_finding",
  "sourcery_get_security_counts",
  "sourcery_bulk_update_findings",
  "sourcery_list_groups",
  "sourcery_get_group",
  "sourcery_get_group_counts",
  "sourcery_bulk_update_groups",
  "sourcery_build_fix_prompt",
  "sourcery_capabilities",
  "sourcery_api_request",
] as const;

/** One captured outbound request. */
interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** Tool context whose client construction fails loudly. */
function failingContext(): ToolContext {
  return {
    getClient(): never {
      throw new Error("client must not be constructed for invalid bulk updates");
    },
  };
}

/** Extract the first text content block from a tool result. */
function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a text content block");
  }
  return first.text;
}

/**
 * Connect a fresh server (with a recording fetch) to an MCP client over
 * InMemoryTransport, run `fn`, then tear both sides down.
 */
async function withServer<T>(
  fetchImpl: typeof fetch,
  fn: (client: Client, calls: CapturedCall[]) => Promise<T>,
): Promise<T> {
  const calls: CapturedCall[] = [];
  const recording: typeof fetch = (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return fetchImpl(url, init);
  };
  const server = createSourceryServer({ apiKey: "test-key", fetchImpl: recording });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client, calls);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("checkLimit", () => {
  it("accepts 100", () => {
    expect(checkLimit(100)).toBe(100);
  });

  it("rejects 101 and 0", () => {
    expect(() => checkLimit(101)).toThrow(/limit must be between 1 and 100/);
    expect(() => checkLimit(0)).toThrow(/limit must be between 1 and 100/);
  });
});

describe("registered tools", () => {
  it("registers exactly the twelve pinned tools", () => {
    expect(TOOLS).toHaveLength(12);
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("gives every tool a description", () => {
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
    }
  });
});

describe("capabilities", () => {
  it("reports the pinned surface and spec sha", () => {
    const tool = getTool("sourcery_capabilities");
    if (!tool) throw new Error("capabilities tool missing");
    const payload = tool.run({}, failingContext()) as Record<string, unknown>;
    expect(payload["api_base"]).toBe(API_BASE);
    const spec = payload["spec"] as Record<string, unknown>;
    expect(spec["sha256"]).toBe(SPEC_SHA256);
    expect(spec["info"]).toBe(SPEC_INFO);
    expect(payload["operations"]).toHaveLength(8);
    const enums = payload["enums"] as Record<string, unknown>;
    expect(enums["status_inputs"]).toEqual(["ACTIVE", "IGNORED", "SNOOZED"]);
    expect(payload["review_commands"]).toHaveProperty("commands");
  });
});

describe("bulk tools validate before constructing a client", () => {
  it("rejects no-op updates without constructing a client", () => {
    const findings = getTool("sourcery_bulk_update_findings");
    const groups = getTool("sourcery_bulk_update_groups");
    if (!findings || !groups) throw new Error("bulk tools missing");
    const ctx = failingContext();
    expect(() => findings.run({ ids: [1] }, ctx)).toThrow(ValidationError);
    expect(() =>
      findings.run({ ids: [1], status: "ACTIVE", snoozed_until: "2030-01-01T00:00:00Z" }, ctx),
    ).toThrow(ValidationError);
    expect(() => groups.run({ ids: [1], snoozed_until: "2030-01-01T00:00:00Z" }, ctx)).toThrow(
      ValidationError,
    );
  });

  it("rejects SOLVED and out-of-range ids without constructing a client", () => {
    const findings = getTool("sourcery_bulk_update_findings");
    const groups = getTool("sourcery_bulk_update_groups");
    if (!findings || !groups) throw new Error("bulk tools missing");
    const ctx = failingContext();
    expect(() => findings.run({ ids: [1], status: "SOLVED" }, ctx)).toThrow();
    expect(() => findings.run({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }, ctx)).toThrow();
    expect(() => groups.run({ ids: [], status: "ACTIVE" }, ctx)).toThrow();
  });
});

describe("server over InMemoryTransport", () => {
  it("lists all twelve tools with snake_case input properties", async () => {
    await withServer(async () => {
      throw new Error("network access attempted before local validation");
    }, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(tools).toHaveLength(12);
      const listFindings = tools.find((tool) => tool.name === "sourcery_list_findings");
      if (!listFindings) throw new Error("sourcery_list_findings missing");
      const properties = Object.keys(
        (listFindings.inputSchema as { properties: Record<string, unknown> }).properties,
      );
      expect(properties).toEqual(
        expect.arrayContaining(["repository_ids", "issue_types", "statuses", "search", "limit", "cursor"]),
      );
    });
  });

  it("wires sourcery_list_findings arguments through to the client", async () => {
    await withServer(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 1 }], has_more: false }), { status: 200 }),
        ),
      async (client, calls) => {
        const result = await client.callTool({
          name: "sourcery_list_findings",
          arguments: { repository_ids: [1, 2], limit: 50 },
        });
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(textOf(result))).toEqual({ data: [{ id: 1 }], has_more: false });
        expect(calls).toHaveLength(1);
        const url = new URL(calls[0]!.url);
        expect(url.pathname).toBe("/api/v1/security-issues");
        expect(url.searchParams.getAll("repository_ids")).toEqual(["1", "2"]);
        expect(url.searchParams.get("limit")).toBe("50");
      },
    );
  });

  it("builds sourcery_security_snapshot from stats plus the active first page", async () => {
    await withServer(
      (url) => {
        const body = String(url).includes("/stats")
          ? { active: 3 }
          : { data: [{ id: 9 }], has_more: true, next_cursor: "c2" };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      },
      async (client, calls) => {
        const result = await client.callTool({
          name: "sourcery_security_snapshot",
          arguments: {},
        });
        expect(result.isError).toBeUndefined();
        const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
        expect(payload["counts"]).toEqual({ active: 3 });
        expect(payload["active_issues"]).toEqual([{ id: 9 }]);
        expect(payload["has_more"]).toBe(true);
        expect(payload["next_cursor"]).toBe("c2");
        expect(calls).toHaveLength(2);
        expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/security-issues/stats");
        const listUrl = new URL(calls[1]!.url);
        expect(listUrl.pathname).toBe("/api/v1/security-issues");
        expect(listUrl.searchParams.get("statuses")).toBe("ACTIVE");
        expect(listUrl.searchParams.get("limit")).toBe("25");
      },
    );
  });

  it("returns capabilities without touching the network", async () => {
    await withServer(async () => {
      throw new Error("network access attempted before local validation");
    }, async (client) => {
      const result = await client.callTool({
        name: "sourcery_capabilities",
        arguments: {},
      });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
      expect((payload["spec"] as Record<string, unknown>)["sha256"]).toBe(SPEC_SHA256);
      expect(payload["operations"]).toHaveLength(8);
    });
  });

  it("surfaces zod validation failures as tool errors without a request", async () => {
    await withServer(async () => {
      throw new Error("network access attempted before local validation");
    }, async (client, calls) => {
      const result = await client.callTool({
        name: "sourcery_list_findings",
        arguments: { limit: 101 },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid arguments for tool sourcery_list_findings");
      expect(calls).toHaveLength(0);
    });
  });

  it("surfaces SourceryError as a tool error", async () => {
    await withServer(
      () => Promise.resolve(new Response("nope", { status: 404 })),
      async (client) => {
        const result = await client.callTool({
          name: "sourcery_get_finding",
          arguments: { finding_id: 42 },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("HTTP 404");
      },
    );
  });

  it("returns the fix prompt as plain text", async () => {
    await withServer(async () => {
      throw new Error("network access attempted before local validation");
    }, async (client) => {
      const result = await client.callTool({
        name: "sourcery_build_fix_prompt",
        arguments: {
          finding_json: JSON.stringify({
            issue_type: "SAST",
            rule_id: "python.lang.security.audit.eval-detected",
            title: "Unsafe use of eval",
            description: "User input flows into eval().",
            file_path: "src/app.py",
            line_start: 10,
            line_end: 12,
          }),
        },
      });
      expect(result.isError).toBeUndefined();
      const text = textOf(result);
      expect(text).toContain("Keep the changes minimal");
      expect(text).toContain("src/app.py:10-12");
      expect(text).toContain("untrusted");
    });
  });
});

describe("round-6 raw bridge validation (ported from fix/security-hardening-and-ci)", () => {
  const bridge = getTool("sourcery_api_request");
  const rejectingCtx: ToolContext = {
    getClient() {
      throw new Error("invalid bridge payload reached the client");
    },
  };

  it.each([
    ["DELETE", "/api/v1/security-issues", "{}", "null"],
    ["GET", "/api/v1/not-a-path", "{}", "null"],
    ["GET", "/api/v1/security-issues", '{"bogus": 1}', "null"],
    ["GET", "/api/v1/security-issues", '{"repository_ids": [0]}', "null"],
    ["GET", "/api/v1/security-issues", '{"repository_ids": "1"}', "null"],
    ["GET", "/api/v1/security-issues", '{"statuses": ["NOPE"]}', "null"],
    ["GET", "/api/v1/security-issues", '{"issue_types": ["NOPE"]}', "null"],
    ["GET", "/api/v1/security-issues", '{"limit": 101}', "null"],
    ["GET", "/api/v1/security-issues", '{"limit": 1.5}', "null"],
    ["GET", "/api/v1/security-issues", '{"search": 5}', "null"],
    ["GET", "/api/v1/security-issues/stats", '{"cursor": "x"}', "null"],
    ["GET", "/api/v1/security-issues/1", '{"limit": 5}', "null"],
    ["GET", "/api/v1/security-issues", "{}", '{"ids": [1]}'],
    ["PATCH", "/api/v1/security-issues", '{"cursor": "x"}', '{"ids": [1], "status": "ACTIVE"}'],
    ["PATCH", "/api/v1/security-issues", "{}", '{"ids": [1]}'],
    ["PATCH", "/api/v1/security-issues", "{}", '{"ids": [1], "status": "SOLVED"}'],
    ["PATCH", "/api/v1/security-issues", "{}", '{"ids": [1], "snoozed_until": "2030-01-01T00:00:00Z"}'],
    ["PATCH", "/api/v1/security-issues", "{}", '{"ids": [1], "status": "ACTIVE", "severity_override": 5}'],
    ["PATCH", "/api/v1/security-issues/1", "{}", '{"ids": [1], "status": "ACTIVE"}'],
    ["PATCH", "/api/v1/security-issues", "{}", '"not-an-object"'],
  ])(
    "rejects %s %s before the client (%s, %s)",
    (method, path, paramsJson, bodyJson) => {
      // Validation throws synchronously, before any promise (or client) exists.
      expect(() =>
        bridge!.run({ method, path, params_json: paramsJson, body_json: bodyJson }, rejectingCtx),
      ).toThrow();
    },
  );

  it("rejects more than one hundred ids before the client (test_raw_bridge_rejects_more_than_one_hundred_ids_before_client)", () => {
    const body = JSON.stringify({ ids: Array.from({ length: 101 }, (_, i) => i + 1), status: "ACTIVE" });
    expect(() =>
      bridge!.run(
        { method: "PATCH", path: "/api/v1/security-issues", params_json: "{}", body_json: body },
        rejectingCtx,
      ),
    ).toThrow(/at most 100 entries/);
  });

  it("preserves and forwards all eight verified operations (test_raw_bridge_preserves_all_verified_operations)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const recording = new SourceryClient({
      apiKey: "test-key",
      fetchImpl: (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      },
    });
    const ctx: ToolContext = { getClient: () => recording };
    const operations: ReadonlyArray<readonly [string, string, string, string]> = [
      ["GET", "/api/v1/security-issues", '{"limit": 5}', "null"],
      ["GET", "/api/v1/security-issues/stats", "{}", "null"],
      ["GET", "/api/v1/security-issues/1", "{}", "null"],
      ["PATCH", "/api/v1/security-issues", "{}", '{"ids": [1], "status": "ACTIVE"}'],
      ["GET", "/api/v1/security-issue-groups", '{"limit": 5}', "null"],
      ["GET", "/api/v1/security-issue-groups/stats", "{}", "null"],
      ["GET", "/api/v1/security-issue-groups/1", "{}", "null"],
      ["PATCH", "/api/v1/security-issue-groups", "{}", '{"ids": [1], "status": "ACTIVE"}'],
    ];
    for (const [method, path, paramsJson, bodyJson] of operations) {
      await bridge!.run({ method, path, params_json: paramsJson, body_json: bodyJson }, ctx);
    }
    expect(calls).toHaveLength(8);
    expect(calls.map((call) => call.init.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "PATCH",
      "GET",
      "GET",
      "GET",
      "PATCH",
    ]);
    expect(calls[0]!.url).toBe("https://api.sourcery.ai/api/v1/security-issues?limit=5");
    expect(calls[2]!.url).toBe("https://api.sourcery.ai/api/v1/security-issues/1");
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ ids: [1], status: "ACTIVE" });
  });
});
