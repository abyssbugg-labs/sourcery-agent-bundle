/**
 * MCP server factory for Sourcery's public security API (TypeScript port of
 * the tool wiring in `python/src/sourcery_agent/server.py`).
 *
 * Wired against the pinned OpenAPI snapshot (`openapi/sourcery-openapi.json`);
 * `constants.VERIFIED_OPERATIONS` lists the exact eight operations. Sourcery's
 * PR review commands (review, summary, guide, title, resolve, dismiss, create
 * issue) are GitHub/GitLab comment or label commands, not public REST — use
 * your Git provider connector for those.
 *
 * The client is constructed lazily from the given options (falling back to
 * `SOURCERY_API_KEY` / `SOURCERY_API_BASE` env vars), so local validation
 * failures surface before any client — or network — exists. Handler throws
 * (zod validation, `SourceryError`) are converted by the SDK into tool error
 * results (`isError: true`) instead of crashing the server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { SourceryClient } from "./client.js";
import { TOOLS } from "./tools.js";
import type { ToolContext } from "./tools.js";

/** Options for {@link createSourceryServer}; all fields fall back to the environment. */
export interface SourceryServerOptions {
  /** Sourcery API bearer token; defaults to `SOURCERY_API_KEY`. */
  apiKey?: string;
  /** API base URL (must be https); defaults to `SOURCERY_API_BASE` then the pinned default. */
  baseUrl?: string;
  /** Fetch implementation for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Server name reported in the MCP `initialize` handshake. */
const SERVER_NAME = "Sourcery Agent Bundle";
/** Server version reported in the MCP `initialize` handshake. */
const SERVER_VERSION = "0.2.0";

/** Pinned instructions describing the triage workflow over this tool surface. */
const INSTRUCTIONS =
  "Sourcery security-findings triage and remediation. Start with " +
  "sourcery_security_snapshot for an overview, drill into " +
  "sourcery_list_findings / sourcery_get_finding, and use " +
  "sourcery_build_fix_prompt to hand a finding to a coding agent. " +
  "All tools are limited to Sourcery's public security API.";

/** Serialize a handler value: strings pass through, everything else as JSON. */
function formatResult(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * Create the MCP server with all twelve Sourcery tools registered.
 *
 * The `SourceryClient` is constructed lazily on the first tool run that needs
 * it (memoized per server instance), so a missing API key only fails when a
 * network-backed tool is actually invoked.
 */
export function createSourceryServer(options: SourceryServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  let cachedClient: SourceryClient | undefined;
  const ctx: ToolContext = {
    getClient(): SourceryClient {
      cachedClient ??= new SourceryClient({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        fetchImpl: options.fetchImpl,
      });
      return cachedClient;
    },
  };

  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.schema,
    }, async (args: unknown) => formatResult(await tool.run(args, ctx)));
  }
  return server;
}
