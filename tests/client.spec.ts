import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SourceryClient,
  SourceryError,
  ValidationError,
  ensureAllowed,
} from "../src/client.js";
import { BULK_UPDATE_MAX_IDS, VERIFIED_OPERATIONS } from "../src/constants.js";
import type { VerifiedOperation } from "../src/constants.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Fails loudly if a test reaches the network layer. */
function boomFetch(): typeof fetch {
  return (() => {
    throw new Error("network access attempted before local validation");
  }) as typeof fetch;
}

function clientWith(fetchImpl: typeof fetch): SourceryClient {
  return new SourceryClient({ apiKey: "test-key", fetchImpl });
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** Records one request and answers with a JSON object. */
function recordingClient(body: unknown): {
  client: SourceryClient;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client = clientWith((url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  return { client, calls };
}

const verifiedPaths: ReadonlyArray<[string, string]> = VERIFIED_OPERATIONS.map((operation) => [
  operation.method,
  operation.path.replace("{id}", "1"),
]);

describe("allow-list", () => {
  it.each(verifiedPaths)("allows %s %s", (method, path) => {
    expect(() => ensureAllowed(method, path)).not.toThrow();
  });

  it.each([
    ["GET", "/api/v1/security-issues/abc"],
    ["GET", "/api/v1/security-issues/1/extra"],
    ["GET", "/api/v1/security-issues/stats/extra"],
    ["PATCH", "/api/v1/security-issues/1"],
    ["DELETE", "/api/v1/security-issues"],
    ["POST", "/api/v1/security-issue-groups"],
    ["GET", "/api/v1/other"],
    ["GET", "/v1/security-issues"],
  ])("rejects %s %s", (method, path) => {
    expect(() => ensureAllowed(method, path)).toThrow(SourceryError);
  });
});

describe("client construction", () => {
  it("requires an api key", () => {
    vi.stubEnv("SOURCERY_API_KEY", "");
    vi.stubEnv("SOURCERY_API_BASE", "");
    expect(() => new SourceryClient()).toThrow(SourceryError);
  });

  it("resolves the api key from the environment", () => {
    vi.stubEnv("SOURCERY_API_KEY", "env-key");
    expect(() => new SourceryClient({ fetchImpl: boomFetch() })).not.toThrow();
  });

  it("rejects plain-http base urls", () => {
    expect(() => new SourceryClient({ apiKey: "test-key", baseUrl: "http://api.example.com" }))
      .toThrow(SourceryError);
    expect(() => new SourceryClient({ apiKey: "test-key", baseUrl: "https://api.example.com/api" }))
      .not.toThrow();
  });
});

describe("local validation before the network", () => {
  it("rejects unlisted paths before any network call", async () => {
    const client = clientWith(boomFetch());
    await expect(
      client.request({ method: "GET", path: "/api/v1/not-a-real-path" }),
    ).rejects.toThrow(SourceryError);
  });

  it("checks bulk id bounds before any network call", async () => {
    const client = clientWith(boomFetch());
    await expect(client.bulk_update_issues({ ids: [] })).rejects.toThrow(ValidationError);
    await expect(
      client.bulk_update_issues({
        ids: Array.from({ length: BULK_UPDATE_MAX_IDS + 1 }, (_, index) => index + 1),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(client.bulk_update_groups({ ids: [] })).rejects.toThrow(ValidationError);
  });

  it("rejects out-of-range limits before any network call", async () => {
    const client = clientWith(boomFetch());
    await expect(client.list_issues({ limit: 0 })).rejects.toThrow(ValidationError);
    await expect(client.list_issues({ limit: 101 })).rejects.toThrow(ValidationError);
    await expect(client.list_groups({ limit: 101 })).rejects.toThrow(ValidationError);
  });

  it("requires a change before any network call", async () => {
    const client = clientWith(boomFetch());
    await expect(client.bulk_update_issues({ ids: [1] })).rejects.toThrow(ValidationError);
    await expect(
      client.bulk_update_issues({ ids: [1], snoozed_until: "2030-01-01T00:00:00Z" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.bulk_update_issues({ ids: [1], status: "ACTIVE", snoozed_until: "2030-01-01T00:00:00Z" }),
    ).rejects.toThrow(ValidationError);
    await expect(client.bulk_update_groups({ ids: [1] })).rejects.toThrow(ValidationError);
  });

  it("rejects SOLVED status before any network call", async () => {
    const client = clientWith(boomFetch());
    await expect(client.bulk_update_issues({ ids: [1], status: "SOLVED" })).rejects.toThrow(
      ValidationError,
    );
    await expect(client.bulk_update_groups({ ids: [1], status: "SOLVED" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("requires snoozed_until for SNOOZED updates", async () => {
    const client = clientWith(boomFetch());
    await expect(client.bulk_update_issues({ ids: [1], status: "SNOOZED" })).rejects.toThrow(
      ValidationError,
    );
    await expect(client.bulk_update_groups({ ids: [1], status: "SNOOZED" })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("response hardening", () => {
  it("raises on 2xx responses without a JSON body", async () => {
    const client = clientWith(() =>
      Promise.resolve(new Response("", { status: 200 })),
    );
    await expect(
      client.request({ method: "GET", path: "/api/v1/security-issues" }),
    ).rejects.toThrow(SourceryError);
  });

  it("raises on 2xx JSON that is not an object", async () => {
    const client = clientWith(() => Promise.resolve(new Response("[]", { status: 200 })));
    await expect(
      client.request({ method: "GET", path: "/api/v1/security-issues" }),
    ).rejects.toThrow(SourceryError);
  });

  it("raises on HTTP error statuses with a body preview", async () => {
    const client = clientWith(() =>
      Promise.resolve(new Response("nope", { status: 404 })),
    );
    await expect(
      client.request({ method: "GET", path: "/api/v1/security-issues/1" }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("wire behavior", () => {
  it("sends bearer auth and serializes list params", async () => {
    const { client, calls } = recordingClient({ data: [] });
    await client.list_issues({ repository_ids: [1, 2], statuses: ["ACTIVE"], limit: 50 });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      "https://api.sourcery.ai/api/v1/security-issues",
    );
    expect(parsed.searchParams.getAll("repository_ids")).toEqual(["1", "2"]);
    expect(parsed.searchParams.get("statuses")).toBe("ACTIVE");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      Accept: "application/json",
    });
  });

  it("omits unset filters from list requests", async () => {
    const { client, calls } = recordingClient({ data: [] });
    await client.list_groups({ search: "prototype pollution" });

    const parsed = new URL(calls[0]!.url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      "https://api.sourcery.ai/api/v1/security-issue-groups",
    );
    expect(parsed.searchParams.get("search")).toBe("prototype pollution");
    expect(parsed.searchParams.get("limit")).toBeNull();
    expect(parsed.searchParams.get("cursor")).toBeNull();
  });

  it("fetches a single issue by id", async () => {
    const { client, calls } = recordingClient({ id: 42 });
    await client.get_issue(42);

    expect(calls[0]!.url).toBe("https://api.sourcery.ai/api/v1/security-issues/42");
  });

  it("patches snake_case bodies and omits unset fields", async () => {
    const { client, calls } = recordingClient({ updated: 1 });
    await client.bulk_update_groups({
      ids: [3, 4],
      status: "SNOOZED",
      snoozed_until: "2030-01-01T00:00:00Z",
    });

    const { init } = calls[0]!;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      ids: [3, 4],
      status: "SNOOZED",
      snoozed_until: "2030-01-01T00:00:00Z",
    });
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("patches severity_override updates with a reason", async () => {
    const { client, calls } = recordingClient({ updated: 2 });
    await client.bulk_update_issues({
      ids: [1, 2, 3],
      severity_override: "LOW",
      reason: "triaged as low impact",
    });

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      ids: [1, 2, 3],
      severity_override: "LOW",
      reason: "triaged as low impact",
    });
  });
});

describe("verified operations surface", () => {
  it("materializes exactly eight operations", () => {
    expect(verifiedPaths).toHaveLength(8);
  });

  it("uses only GET and PATCH methods", () => {
    for (const [method] of verifiedPaths) {
      expect(["GET", "PATCH"]).toContain(method);
    }
  });

  it("keeps VerifiedOperation importable for the tool layer", () => {
    const operation: VerifiedOperation = VERIFIED_OPERATIONS[0]!;
    expect(operation.description.length).toBeGreaterThan(0);
  });
});
