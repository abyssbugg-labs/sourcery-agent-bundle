/**
 * stdio entry point for the Sourcery MCP server.
 *
 * The TypeScript counterpart of running `python -m sourcery_agent.server`:
 * the MCP host spawns this process and speaks JSON-RPC over stdin/stdout, so
 * nothing else may write to stdout. The `SourceryClient` inside the server
 * factory resolves `SOURCERY_API_KEY` lazily, so a missing key only fails when
 * a network-backed tool runs.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createSourceryServer } from "./server.js";
import type { SourceryServerOptions } from "./server.js";

/**
 * Create the Sourcery MCP server and connect it to a `StdioServerTransport`.
 *
 * Resolves once the transport handshake completes; the process stays alive
 * until the host closes stdin or the transport closes. No process-level
 * wiring (signal handlers, exit codes) is installed here — that belongs to
 * the CLI entry in `./cli.js`.
 */
export async function runStdio(options: SourceryServerOptions = {}): Promise<void> {
  const server = createSourceryServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
