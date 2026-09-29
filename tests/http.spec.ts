/**
 * Tests for the Streamable HTTP entry point (ports of the three http_server
 * tests in `python/tests/test_sourcery_bundle.py`, plus the bearer-token
 * helper and the round-6 resource-URL / metadata hardening). One integration
 * test binds a real loopback socket to verify the RFC 9728 metadata route.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bearerTokenAuthorized,
  checkBindAllowed,
  isLoopbackHost,
  resolveResourceUrl,
  runHttp,
} from "../src/http.js";
import { tokensMatch } from "../src/server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLoopbackHost (port of test_http_server_loopback_detection)", () => {
  it("recognizes loopback hostnames and addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });

  it("covers the obvious loopback IPv6 forms and the rest of 127.0.0.0/8", () => {
    expect(isLoopbackHost("127.7.7.7")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::1%lo0")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost(" localhost ")).toBe(true);
  });

  it("rejects non-loopback addresses, hostnames, and malformed input", () => {
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("::2")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost("127.1")).toBe(false);
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
    expect(isLoopbackHost("127.0.0.001")).toBe(false); // ipaddress rejects leading zeros
  });
});

describe("checkBindAllowed (port of test_http_server_refuses_public_bind_without_optin)", () => {
  it("refuses non-loopback binds without explicit opt-in", () => {
    vi.stubEnv("SOURCERY_MCP_ALLOW_REMOTE", undefined);
    vi.stubEnv("SOURCERY_MCP_AUTH_TOKEN", undefined);
    for (const host of ["0.0.0.0", "192.168.1.20"]) {
      expect(() => checkBindAllowed(host)).toThrow(
        /refusing to bind SOURCERY_MCP_HOST='(0\.0\.0\.0|192\.168\.1\.20)'/,
      );
    }
    expect(() => checkBindAllowed("127.0.0.1")).not.toThrow();
  });

  it("guides toward remote mode and a token", () => {
    vi.stubEnv("SOURCERY_MCP_ALLOW_REMOTE", undefined);
    vi.stubEnv("SOURCERY_MCP_AUTH_TOKEN", undefined);
    expect(() => checkBindAllowed("0.0.0.0")).toThrow(/SOURCERY_MCP_ALLOW_REMOTE=1/);
  });
});

describe("checkBindAllowed (port of test_http_server_remote_bind_requires_token)", () => {
  it("remote mode additionally requires an auth token", () => {
    vi.stubEnv("SOURCERY_MCP_ALLOW_REMOTE", "1");
    vi.stubEnv("SOURCERY_MCP_AUTH_TOKEN", undefined);
    expect(() => checkBindAllowed("0.0.0.0")).toThrow(/SOURCERY_MCP_AUTH_TOKEN/);
    vi.stubEnv("SOURCERY_MCP_AUTH_TOKEN", "s3cret");
    expect(() => checkBindAllowed("0.0.0.0")).not.toThrow();
  });

  it("treats a blank token as absent", () => {
    vi.stubEnv("SOURCERY_MCP_ALLOW_REMOTE", "1");
    vi.stubEnv("SOURCERY_MCP_AUTH_TOKEN", "   ");
    expect(() => checkBindAllowed("0.0.0.0")).toThrow(/SOURCERY_MCP_AUTH_TOKEN/);
  });
});

describe("bearerTokenAuthorized (StaticTokenVerifier semantics)", () => {
  it("accepts only the exact configured token", () => {
    expect(bearerTokenAuthorized("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects everything else (mapped to 401 by the server)", () => {
    expect(bearerTokenAuthorized(undefined, "s3cret")).toBe(false);
    expect(bearerTokenAuthorized("", "s3cret")).toBe(false);
    expect(bearerTokenAuthorized("Bearer", "s3cret")).toBe(false);
    expect(bearerTokenAuthorized("Bearer ", "s3cret")).toBe(false);
    expect(bearerTokenAuthorized("Bearer wrong", "s3cret")).toBe(false);
    expect(bearerTokenAuthorized("Bearer s3cret2", "s3cret")).toBe(false);
    expect(bearerTokenAuthorized("bearer s3cret", "s3cret")).toBe(false); // scheme must match exactly
    expect(bearerTokenAuthorized("Token s3cret", "s3cret")).toBe(false);
    expect(bearerTokenAuthorized("Bearer s3cret", "")).toBe(false); // no token configured -> reject
  });

  it("uses the first value of a repeated header", () => {
    expect(bearerTokenAuthorized(["Bearer s3cret", "Bearer other"], "s3cret")).toBe(true);
    expect(bearerTokenAuthorized(["Bearer other", "Bearer s3cret"], "s3cret")).toBe(false);
  });
});

describe("runHttp bind-guard ordering", () => {
  it("throws the bind guidance before creating any listener", async () => {
    await expect(
      runHttp({ host: "0.0.0.0", env: { SOURCERY_MCP_ALLOW_REMOTE: undefined } }),
    ).rejects.toThrow(/SOURCERY_MCP_ALLOW_REMOTE=1/);
  });

  it("throws before binding when remote mode lacks a token", async () => {
    await expect(
      runHttp({
        host: "0.0.0.0",
        env: { SOURCERY_MCP_ALLOW_REMOTE: "1", SOURCERY_MCP_AUTH_TOKEN: undefined },
      }),
    ).rejects.toThrow(/SOURCERY_MCP_AUTH_TOKEN/);
  });

  it("honors SOURCERY_MCP_HOST from the injected environment", async () => {
    await expect(
      runHttp({ env: { SOURCERY_MCP_HOST: "192.168.1.20" } }),
    ).rejects.toThrow(/SOURCERY_MCP_HOST='192\.168\.1\.20'/);
  });
});

describe("resolveResourceUrl (round-6 port of test_remote_resource_url_is_explicit_https_and_matches_mcp_path)", () => {
  it("requires an explicit HTTPS resource URL matching the MCP path for remote binds", () => {
    expect(() => resolveResourceUrl("0.0.0.0", 8765, "/mcp", undefined)).toThrow(
      /requires explicit SOURCERY_MCP_RESOURCE_URL/,
    );
    expect(() => resolveResourceUrl("0.0.0.0", 8765, "/mcp", "http://mcp.example.com/mcp")).toThrow(
      /must be an absolute HTTPS URL/,
    );
    expect(() => resolveResourceUrl("0.0.0.0", 8765, "/mcp", "https://mcp.example.com/wrong")).toThrow(
      /path must be "\/mcp"/,
    );
    expect(
      resolveResourceUrl("0.0.0.0", 8765, "/mcp", "https://mcp.example.com/mcp"),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("rejects malformed URLs and user information", () => {
    for (const bad of [
      "https://user@mcp.example.com/mcp",
      "https://mcp.example.com:invalid/mcp",
      "https://@/mcp",
      "https://[::1/mcp",
      "https://mcp.example.com/mcp?query=1",
      "https://mcp.example.com/mcp#frag",
    ]) {
      expect(() => resolveResourceUrl("0.0.0.0", 8765, "/mcp", bad)).toThrow();
    }
  });

  it("allows plain HTTP only for loopback binds (port of test_local_resource_url_defaults_to_bound_loopback_endpoint)", () => {
    expect(resolveResourceUrl("127.0.0.1", 9876, "/custom", undefined)).toBe(
      "http://127.0.0.1:9876/custom",
    );
    expect(resolveResourceUrl("::1", 9876, "/mcp", "http://[::1]:9876/mcp")).toBe(
      "http://[::1]:9876/mcp",
    );
    expect(() => resolveResourceUrl("127.0.0.1", 9876, "/mcp", "http://example.com/mcp")).not.toThrow();
  });

  it("bounds the bind port (round-7)", () => {
    expect(() => resolveResourceUrl("127.0.0.1", 0, "/mcp", undefined)).toThrow(
      /SOURCERY_MCP_PORT must be between 1 and 65535/,
    );
    expect(() => resolveResourceUrl("127.0.0.1", 70000, "/mcp", undefined)).toThrow(
      /SOURCERY_MCP_PORT must be between 1 and 65535/,
    );
    expect(() => resolveResourceUrl("127.0.0.1", 1.5, "/mcp", undefined)).toThrow(
      /SOURCERY_MCP_PORT must be between 1 and 65535/,
    );
  });
});

describe("tokensMatch (round-6 constant-time compare, port of test_static_token_verifier_handles_unicode_tokens)", () => {
  it("accepts identical tokens, including unicode, and rejects everything else", () => {
    expect(tokensMatch("s3cret", "s3cret")).toBe(true);
    expect(tokensMatch("tökén✓", "tökén✓")).toBe(true);
    expect(tokensMatch("tökén", "token")).toBe(false);
    expect(tokensMatch("s3cret", "s3cret2")).toBe(false);
    expect(tokensMatch("short", "a-much-longer-token")).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });
});

describe("runHttp resource metadata (round-6 port of test_build_server_auth_is_observable)", () => {
  it("serves RFC 9728 metadata and advertises it on 401", async () => {
    const handle = await runHttp({
      env: { SOURCERY_MCP_AUTH_TOKEN: "s3cret", SOURCERY_API_KEY: "test-key" },
      host: "127.0.0.1",
      port: 18123,
      path: "/mcp",
    });
    try {
      const metadata = await fetch("http://127.0.0.1:18123/.well-known/oauth-protected-resource");
      expect(metadata.status).toBe(200);
      const body = (await metadata.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported: string[];
      };
      expect(body.resource).toBe("http://127.0.0.1:18123/mcp");
      expect(body.authorization_servers).toEqual(["http://127.0.0.1:18123/mcp"]);
      expect(body.scopes_supported).toEqual(["sourcery"]);

      const unauthorized = await fetch("http://127.0.0.1:18123/mcp");
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");

      const authorized = await fetch("http://127.0.0.1:18123/mcp", {
        headers: {
          authorization: "Bearer s3cret",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "http-spec", version: "0.0.0" },
          },
        }),
      });
      expect(authorized.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});
