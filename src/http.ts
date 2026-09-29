/**
 * Streamable HTTP entry point for the Sourcery MCP server.
 *
 * Port of `python/src/sourcery_agent/http_server.py`, used for remote /
 * self-hosted deployments (for example the ChatGPT developer-mode app flow)
 * where a local stdio process is not possible. The stdio path is `./stdio.js`.
 *
 * Security: this transport serves the full tool set — including bulk updates —
 * with the process's Sourcery API key, so it is loopback-only by default.
 * Remote mode requires `SOURCERY_MCP_ALLOW_REMOTE=1` **and** a non-empty
 * `SOURCERY_MCP_AUTH_TOKEN`; when a token is configured every request to the
 * MCP endpoint must carry `Authorization: Bearer <token>` exactly matching
 * (the semantic of the Python `StaticTokenVerifier`; terminate TLS in front —
 * see docs/COMPATIBILITY.md).
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createSourceryServer } from "./server.js";
import type { SourceryServerOptions } from "./server.js";

/** Environment mapping consulted for HTTP configuration. */
type EnvLike = Record<string, string | undefined>;

/** Authorization header value: a string, a repeated-header array, or absent. */
type AuthorizationHeader = string | string[] | undefined;

/** Options for {@link runHttp}; transport options fall back to the environment. */
export interface HttpServerOptions extends SourceryServerOptions {
  /** Bind host; defaults to `SOURCERY_MCP_HOST` then `127.0.0.1`. */
  host?: string;
  /** Bind port; defaults to `SOURCERY_MCP_PORT` then `8765`. */
  port?: number;
  /** MCP endpoint path; defaults to `SOURCERY_MCP_PATH` then `/mcp`. */
  path?: string;
  /** Environment override (tests); defaults to `process.env`. */
  env?: EnvLike;
}

/** A running HTTP entry point, exposing the underlying socket for tests/shutdown. */
export interface HttpServerHandle {
  /** The `node:http` server that was bound. */
  server: Server;
  /** The single stateful MCP transport serving all sessions. */
  transport: StreamableHTTPServerTransport;
  /** URL the MCP endpoint listens on. */
  url: string;
  /** Close the transport and the HTTP listener. */
  close(): Promise<void>;
}

/** Default port when `SOURCERY_MCP_PORT` is unset (mirrors http_server.py). */
const DEFAULT_PORT = 8765;
/** Default endpoint path when `SOURCERY_MCP_PATH` is unset. */
const DEFAULT_PATH = "/mcp";

/**
 * True when `host` cannot be reached from another machine.
 *
 * Mirrors Python's `ipaddress.ip_address(...).is_loopback` on a trimmed,
 * lowercased value: `localhost`, any `127.0.0.0/8` address, and the IPv6
 * loopback literal `::1` (including bracketed `[::1]`, zone-indexed `::1%lo0`,
 * and the IPv4-mapped `::ffff:127.x.x.x` forms) are loopback; `0.0.0.0` and
 * every other address or hostname are not. Leading-zero IPv4 octets are
 * rejected like `ipaddress` rejects them.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!normalized) return false;
  if (normalized === "localhost") return true;

  // IPv6 literals contain a colon; strip a zone index before comparing.
  if (normalized.includes(":")) {
    const zoneIndex = normalized.indexOf("%");
    const address = zoneIndex === -1 ? normalized : normalized.slice(0, zoneIndex);
    if (address === "::1") return true;
    const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
    if (mapped) {
      const octets = mapped.slice(1).map((part) => Number(part));
      return isLoopbackIpv4(octets);
    }
    return false;
  }

  const parts = normalized.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false; // ipaddress rejects leading zeros
    const value = Number(part);
    if (value > 255) return false;
    octets.push(value);
  }
  return isLoopbackIpv4(octets);
}

/** True for the `127.0.0.0/8` block. */
function isLoopbackIpv4(octets: readonly number[]): boolean {
  return octets[0] === 127;
}

/**
 * Refuse non-loopback binds unless remote mode and an auth token are
 * configured.
 *
 * Port of `check_bind_allowed`: loopback binds are always allowed;
 * non-loopback binds require `SOURCERY_MCP_ALLOW_REMOTE=1` **and** a
 * non-empty `SOURCERY_MCP_AUTH_TOKEN`. Throws (instead of exiting) so callers
 * stay testable; the CLI entry catches and exits 1.
 */
export function checkBindAllowed(
  host: string,
  env: EnvLike = process.env,
): void {
  if (isLoopbackHost(host)) return;
  if ((env["SOURCERY_MCP_ALLOW_REMOTE"] ?? "").trim() !== "1") {
    throw new Error(
      `refusing to bind SOURCERY_MCP_HOST='${host}': the HTTP transport exposes ` +
        "Sourcery findings and bulk updates with this process's API key. Set " +
        "SOURCERY_MCP_ALLOW_REMOTE=1 and SOURCERY_MCP_AUTH_TOKEN to enable " +
        "authenticated remote mode.",
    );
  }
  if (!(env["SOURCERY_MCP_AUTH_TOKEN"] ?? "").trim()) {
    throw new Error(
      "refusing to bind a non-loopback SOURCERY_MCP_HOST without " +
        "SOURCERY_MCP_AUTH_TOKEN; remote mode requires SDK-enforced bearer " +
        "authentication on every request.",
    );
  }
}

/** Normalize an endpoint path to a single leading slash, no trailing slash. */
export function normalizeHttpPath(path: string): string {
  return `/${path.trim().replace(/^\/+|\/+$/g, "")}`;
}

/**
 * Return the actual MCP resource URL or reject unsafe remote metadata.
 *
 * Port of `resolve_resource_url`: the port must be 1..65535; an explicit
 * `SOURCERY_MCP_RESOURCE_URL` must be an absolute HTTP(S) URL (HTTPS-only for
 * remote binds) with no user info, no query or fragment, a valid port, and a
 * path matching the MCP endpoint; remote binds without one are refused.
 * Loopback binds default to `http://[host]:port/path`.
 */
export function resolveResourceUrl(
  host: string,
  port: number,
  path: string,
  configured: string | undefined,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SOURCERY_MCP_PORT must be between 1 and 65535; got ${port}`);
  }
  const normalizedPath = normalizeHttpPath(path);
  if (configured) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new Error("SOURCERY_MCP_RESOURCE_URL must be an absolute URL");
    }
    const parsedPort = Number(parsed.port);
    if (
      parsed.port !== "" &&
      (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)
    ) {
      throw new Error("SOURCERY_MCP_RESOURCE_URL contains an invalid port");
    }
    const allowedSchemes = isLoopbackHost(host)
      ? new Set(["http:", "https:"])
      : new Set(["https:"]);
    if (
      !allowedSchemes.has(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      const expected = isLoopbackHost(host) ? "HTTP(S)" : "HTTPS";
      throw new Error(
        `SOURCERY_MCP_RESOURCE_URL must be an absolute ${expected} URL without user information`,
      );
    }
    if (parsed.search || parsed.hash) {
      throw new Error("SOURCERY_MCP_RESOURCE_URL must not contain a query or fragment");
    }
    if (parsed.pathname.replace(/\/+$/, "") !== normalizedPath.replace(/\/+$/, "")) {
      throw new Error(
        `SOURCERY_MCP_RESOURCE_URL path must be ${JSON.stringify(normalizedPath)}; ` +
          `got ${JSON.stringify(parsed.pathname)}`,
      );
    }
    return configured;
  }
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Remote bind ${host}:${port} requires explicit SOURCERY_MCP_RESOURCE_URL ` +
        `(e.g., https://mcp.example.com${normalizedPath})`,
    );
  }
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}${normalizedPath}`;
}

/**
 * Static-token bearer check for the MCP endpoint.
 *
 * Accepts only an `Authorization` header of exactly `Bearer <token>` for the
 * configured token (mirroring the Python `StaticTokenVerifier` semantics);
 * every other value — missing header, other scheme, wrong token — is
 * rejected, which callers map to HTTP 401.
 */
export function bearerTokenAuthorized(
  header: AuthorizationHeader,
  expectedToken: string,
): boolean {
  if (!expectedToken) return false;
  const value = Array.isArray(header) ? header[0] : header;
  return value === `Bearer ${expectedToken}`;
}

/** JSON-RPC error body used for responses the transport never sees. */
function jsonErrorBody(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Host-header values accepted by DNS-rebinding protection for a loopback bind. */
function loopbackAllowedHosts(host: string, port: number): string[] {
  const values = new Set<string>([
    `${host}:${port}`,
    host,
    `localhost:${port}`,
    "localhost",
    `127.0.0.1:${port}`,
    "127.0.0.1",
    `[::1]:${port}`,
    "[::1]",
  ]);
  return [...values];
}

/**
 * Run the Streamable HTTP server (loopback-only unless remote mode is
 * configured).
 *
 * Reads `SOURCERY_MCP_HOST` (default `127.0.0.1`), `SOURCERY_MCP_PORT`
 * (default 8765), `SOURCERY_MCP_PATH` (default `/mcp`),
 * `SOURCERY_MCP_AUTH_TOKEN`, `SOURCERY_MCP_RESOURCE_URL` and
 * `SOURCERY_MCP_ISSUER_URL` from the environment, applies the bind guard and
 * resource-URL resolution first, then binds. A single stateful transport
 * instance serves all sessions, matching the Python single-server model;
 * DNS-rebinding protection is enabled (Host allow-list for loopback binds —
 * for remote binds the Host header is client-controlled and bearer
 * authentication is the guard instead). With a token configured, the RFC 9728
 * protected-resource metadata document is served at
 * `/.well-known/oauth-protected-resource` and advertised in 401 responses.
 * Resolves with a handle once the socket is listening; the caller keeps the
 * process alive until `handle.close()`.
 */
export async function runHttp(options: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const env = options.env ?? process.env;
  const host = options.host ?? env["SOURCERY_MCP_HOST"] ?? "127.0.0.1";
  const rawPort = options.port ?? Number(env["SOURCERY_MCP_PORT"] ?? String(DEFAULT_PORT));
  const path = normalizeHttpPath(options.path ?? env["SOURCERY_MCP_PATH"] ?? DEFAULT_PATH);
  const token = (env["SOURCERY_MCP_AUTH_TOKEN"] ?? "").trim();

  checkBindAllowed(host, env);
  const resourceUrl = resolveResourceUrl(host, rawPort, path, env["SOURCERY_MCP_RESOURCE_URL"]);
  const issuerUrl = (env["SOURCERY_MCP_ISSUER_URL"] ?? "").trim() || resourceUrl;
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", resourceUrl).toString();
  const resourceMetadata = token
    ? {
        resource: resourceUrl,
        authorization_servers: [issuerUrl],
        scopes_supported: ["sourcery"],
        bearer_methods_supported: ["header"],
      }
    : null;

  const server = createSourceryServer(options);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    ...(isLoopbackHost(host)
      ? { allowedHosts: loopbackAllowedHosts(host, rawPort) }
      : {}),
  });
  await server.connect(transport);

  const endpoint = new URL(path, `http://${host}:${rawPort}`);
  const httpServer = createServer((req, res) => {
    void handleRequest(req, res, transport, path, token, resourceMetadata, metadataUrl);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(rawPort, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  process.stderr.write(
    `Sourcery MCP streamable HTTP server listening on ${endpoint.origin}${path}\n`,
  );

  return {
    server: httpServer,
    transport,
    url: `${endpoint.origin}${path}`,
    async close(): Promise<void> {
      await transport.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

/** Authenticate and dispatch one request to the MCP transport. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
  path: string,
  token: string,
  resourceMetadata: Record<string, unknown> | null,
  metadataUrl: string | null,
): Promise<void> {
  try {
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (token && requestPath === "/.well-known/oauth-protected-resource") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resourceMetadata));
      return;
    }
    if (requestPath !== path) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(jsonErrorBody(-32001, `Not Found: ${requestPath}`));
      return;
    }
    if (token && !bearerTokenAuthorized(req.headers.authorization, token)) {
      res.writeHead(401, {
        "content-type": "application/json",
        ...(metadataUrl
          ? { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` }
          : { "www-authenticate": "Bearer" }),
      });
      res.end(jsonErrorBody(-32001, "Unauthorized: missing or invalid bearer token"));
      return;
    }
    await transport.handleRequest(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`sourcery http: request failed: ${message}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    res.end(jsonErrorBody(-32603, "Internal server error"));
  }
}
