/**
 * Tests for the single-binary CLI (port of `python/tests/test_cli.py`, plus
 * coverage for the new `setup` subcommand and usage errors). Everything runs
 * through `runCli` with injected streams/env/fetch — no spawned processes and
 * no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatFindingRow,
  forDisplay,
  loadKey,
  parseCliArgs,
  runCli,
  sanitizeForTerminal,
  usableKey,
} from "../src/cli.js";
import type { CliIo } from "../src/cli.js";

/** An io collector: records stdout/stderr text and never touches the console. */
function makeIo(env: Record<string, string | undefined> = {}): {
  io: CliIo;
  out: () => string;
  err: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    env,
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    // Tests never read the real key file...
    readKeyFile: () => null,
    // ...and never reach the network.
    fetchImpl: (() => {
      throw new Error("network access attempted in CLI test");
    }) as typeof fetch,
  };
  return { io, out: () => stdout.join(""), err: () => stderr.join("") };
}

/** Fetch stub answering recorded JSON bodies for URLs containing `match`. */
function routeFetch(
  calls: Array<{ url: string; init: RequestInit }>,
  routes: Array<{ match: string; body: unknown }>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      return Promise.reject(new Error(`unexpected request: ${url}`));
    }
    return Promise.resolve(new Response(JSON.stringify(route.body), { status: 200 }));
  }) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parser (port of test_parser_has_expected_commands)", () => {
  it("every documented subcommand parses to an action", () => {
    const cases: Array<[string[], string]> = [
      [["snapshot"], "snapshot"],
      [["list"], "list"],
      [["get", "1"], "get"],
      [["counts"], "counts"],
      [["fix-prompt", "2"], "fix-prompt"],
    ];
    for (const [argv, kind] of cases) {
      expect(parseCliArgs(argv).kind).toBe(kind);
    }
  });

  it("parses filters, limit, and --json", () => {
    const parsed = parseCliArgs([
      "list",
      "--repo-id",
      "3",
      "--repo-id",
      "7",
      "--type",
      "SAST",
      "--status",
      "ACTIVE",
      "--search",
      "eval",
      "--limit",
      "5",
      "--json",
    ]);
    expect(parsed).toMatchObject({
      kind: "list",
      repoId: [3, 7],
      issueTypes: ["SAST"],
      statuses: ["ACTIVE"],
      search: "eval",
      limit: 5,
      json: true,
    });
  });

  it("no args means the stdio server; help and unknown commands are distinct", () => {
    expect(parseCliArgs([]).kind).toBe("stdio");
    expect(parseCliArgs(["--help"]).kind).toBe("help");
    expect(() => parseCliArgs(["bogus"])).toThrow(/invalid choice: 'bogus'/);
  });

  it("usage errors for malformed values", () => {
    expect(() => parseCliArgs(["snapshot", "--repo-id", "abc"])).toThrow(/invalid int value: 'abc'/);
    expect(() => parseCliArgs(["list", "--type", "NOPE"])).toThrow(/invalid choice: 'NOPE'/);
    expect(() => parseCliArgs(["get"])).toThrow(/arguments are required: id/);
    expect(() => parseCliArgs(["snapshot", "--repo-id"])).toThrow(/expected one argument/);
  });
});

describe("row formatting (ports of the format_finding_row tests)", () => {
  it("handles spec findings", () => {
    const row = formatFindingRow({
      id: 7,
      severity: "HIGH",
      issue_type: "SAST",
      status: "ACTIVE",
      title: "Unsafe use of eval",
      file_path: "src/app.py",
    });
    expect(row).toContain("7");
    expect(row).toContain("HIGH");
    expect(row).toContain("src/app.py");
  });

  it("falls back to the package as location", () => {
    const row = formatFindingRow({
      id: 42,
      severity: "CRITICAL",
      issue_type: "DEPENDENCY",
      status: "ACTIVE",
      title: "Prototype pollution",
      package_name: "lo-lib",
      package_version: "4.17.20",
    });
    expect(row).toContain("lo-lib@4.17.20");
  });

  it("strips terminal escape sequences from finding text", () => {
    const row = formatFindingRow({
      id: 1,
      severity: "HIGH",
      issue_type: "SAST",
      status: "ACTIVE",
      title: "evil \x1b]0;owned\x07 title",
      file_path: "src/\x1b[31mapp.py",
    });
    expect(row).not.toContain("\x1b");
    expect(row).not.toContain("\x07");
    expect(row).toContain("evil ");
    expect(row).toContain("app.py");
  });
});

describe("sanitize_for_terminal (port of test_sanitize_for_terminal_removes_sequences)", () => {
  it("removes ANSI/OSC escapes and control bytes but keeps newlines", () => {
    expect(sanitizeForTerminal("a\x1b[31mb")).toBe("ab");
    expect(sanitizeForTerminal("x\x07y")).toBe("xy");
    expect(sanitizeForTerminal("ok\nline")).toBe("ok\nline");
  });
});

describe("usable_key (port of test_usable_key_rejects_placeholders)", () => {
  it("rejects empty, missing, and unexpanded references", () => {
    expect(usableKey("real-key")).toBe(true);
    expect(usableKey("${user_config.sourcery_api_key}")).toBe(false);
    expect(usableKey("")).toBe(false);
    expect(usableKey(null)).toBe(false);
    expect(usableKey(undefined)).toBe(false);
  });
});

describe("loadKey", () => {
  it("prefers a usable env key", () => {
    expect(loadKey({ env: { SOURCERY_API_KEY: "env-key" } })).toBe("env-key");
    expect(
      loadKey({ env: { SOURCERY_API_KEY: "${user_config.sourcery_api_key}" }, readKeyFile: () => null }),
    ).toBeUndefined();
  });

  it("falls back to the key file and trims it", () => {
    const key = loadKey({
      env: { PLUGIN_DATA: "/data", SOURCERY_API_KEY_FILE: "/data/custom-key" },
      readKeyFile: (path) => (path === "/data/custom-key" ? "file-key\n" : null),
    });
    expect(key).toBe("file-key");
  });
});

describe("main error reporting (ports of the main tests)", () => {
  it("reports a missing key with exit 1 and SOURCERY_API_KEY guidance", async () => {
    // Inline io (no injected key reader) to exercise the real filesystem
    // path: statSync on the missing file yields ENOENT, so no key resolves.
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["snapshot"], {
      env: { SOURCERY_API_KEY_FILE: "/nonexistent/definitely-missing-key" },
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: (text) => {
        stderr.push(text);
      },
      fetchImpl: (() => {
        throw new Error("network access attempted in CLI test");
      }) as typeof fetch,
    });
    const errText = stderr.join("");
    expect(code).toBe(1);
    expect(errText).toContain("sourcery-agent:");
    expect(errText).toContain("SOURCERY_API_KEY");
    expect(stdout.join("")).toBe("");
  });

  it("reports key file read errors instead of raising", async () => {
    const { io, err } = makeIo({ SOURCERY_API_KEY_FILE: "/tmp/unreadable-key" });
    io.readKeyFile = () => {
      throw new Error("permission denied");
    };
    const code = await runCli(["snapshot"], io);
    expect(code).toBe(1);
    expect(err()).toContain("sourcery-agent:");
    expect(err()).toContain("permission denied");
  });
});

describe("query commands through injected fetch", () => {
  const FINDING_LOW = {
    id: 3,
    severity: "LOW",
    issue_type: "SAST",
    status: "ACTIVE",
    title: "Weak hash",
    file_path: "src/low.py",
  };
  const FINDING_CRITICAL = {
    id: 9,
    severity: "CRITICAL",
    issue_type: "SAST",
    status: "ACTIVE",
    title: "SQL injection",
    file_path: "src/high.py",
  };
  const STATS = {
    total_count: 2,
    active_count: 2,
    snoozed_count: 0,
    ignored_count: 0,
    solved_count: 0,
    critical_count: 1,
    high_count: 0,
    medium_count: 0,
    low_count: 1,
  };

  it("snapshot prints stats and a severity-sorted table, then the cursor hint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = routeFetch(calls, [
      { match: "/security-issues/stats", body: STATS },
      {
        match: "/api/v1/security-issues",
        body: { data: [FINDING_LOW, FINDING_CRITICAL], has_more: true, next_cursor: "abc123" },
      },
    ]);
    const { io, out } = makeIo({ SOURCERY_API_KEY: "test-key" });
    io.fetchImpl = fetchImpl;

    const code = await runCli(["snapshot"], io);

    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/v1/security-issues/stats");
    expect(calls[1]!.url).toContain("/v1/security-issues?statuses=ACTIVE");
    const text = out();
    expect(text).toContain("total=2 active=2 snoozed=0 ignored=0 solved=0");
    expect(text).toContain("Active findings (2 shown):");
    const criticalIndex = text.indexOf("SQL injection");
    const lowIndex = text.indexOf("Weak hash");
    expect(criticalIndex).toBeGreaterThan(-1);
    expect(criticalIndex).toBeLessThan(lowIndex);
    expect(text).toContain("more available - next cursor: abc123");
  });

  it("list passes filters and --json prints the raw page", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const page = { data: [FINDING_CRITICAL], has_more: false };
    const fetchImpl = routeFetch(calls, [{ match: "/api/v1/security-issues", body: page }]);
    const { io, out } = makeIo({ SOURCERY_API_KEY: "test-key" });
    io.fetchImpl = fetchImpl;

    const code = await runCli(
      ["list", "--repo-id", "3", "--status", "ACTIVE", "--cursor", "cur9", "--json"],
      io,
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("repository_ids=3");
    expect(calls[0]!.url).toContain("statuses=ACTIVE");
    expect(calls[0]!.url).toContain("cursor=cur9");
    expect(JSON.parse(out())).toEqual(page);
  });

  it("get --json prints the finding JSON", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const finding = { ...FINDING_LOW, description: "Weak hashing algorithm." };
    const fetchImpl = routeFetch(calls, [{ match: "/security-issues/7", body: finding }]);
    const { io, out } = makeIo({ SOURCERY_API_KEY: "test-key" });
    io.fetchImpl = fetchImpl;

    const code = await runCli(["get", "7", "--json"], io);

    expect(code).toBe(0);
    expect(calls[0]!.url).toContain("/v1/security-issues/7");
    expect(JSON.parse(out())).toEqual(finding);
  });

  it("get renders sanitized detail lines for a spec finding", async () => {
    const finding = {
      id: 7,
      title: "Unsafe eval",
      severity: "HIGH",
      status: "ACTIVE",
      issue_type: "SAST",
      rule_id: "EV-1",
      file_path: "src/app.py",
      line_start: 10,
      line_end: 12,
      documentation_url: "https://docs.example.com/ev",
      description: "Do not use eval.",
    };
    const fetchImpl = routeFetch([], [{ match: "/security-issues/7", body: finding }]);
    const { io, out } = makeIo({ SOURCERY_API_KEY: "test-key" });
    io.fetchImpl = fetchImpl;

    const code = await runCli(["get", "7"], io);

    expect(code).toBe(0);
    const text = out();
    expect(text).toContain("#7  Unsafe eval");
    expect(text).toContain("severity=HIGH status=ACTIVE type=SAST rule=EV-1");
    expect(text).toContain("location: src/app.py:10-12");
    expect(text).toContain("docs: https://docs.example.com/ev");
    expect(text).toContain("\nDo not use eval.");
  });

  it("fix-prompt prints the built prompt", async () => {
    const finding = {
      id: 2,
      title: "Hardcoded secret",
      severity: "CRITICAL",
      issue_type: "SECRET",
      status: "ACTIVE",
      rule_id: "SEC-1",
      file_path: "src/k.py",
      line_start: 4,
      line_end: 4,
      description: "A secret is hardcoded.",
    };
    const fetchImpl = routeFetch([], [{ match: "/security-issues/2", body: finding }]);
    const { io, out } = makeIo({ SOURCERY_API_KEY: "test-key" });
    io.fetchImpl = fetchImpl;

    const code = await runCli(["fix-prompt", "2"], io);

    expect(code).toBe(0);
    expect(out()).toContain("Please fix the following security issue:");
    expect(out()).toContain("Hardcoded secret");
    expect(out()).toContain("<fix>");
  });

  it("counts prints the stats summary", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = routeFetch(calls, [{ match: "/security-issues/stats", body: STATS }]);
    const { io, out } = makeIo({ SOURCERY_API_KEY: "test-key" });
    io.fetchImpl = fetchImpl;

    const code = await runCli(["counts", "--json"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out())).toEqual(STATS);
  });

  it("API failures print sourcery-agent: ... and exit 1", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response("nope", { status: 401 }));
    const { io, err } = makeIo({ SOURCERY_API_KEY: "test-key" });
    io.fetchImpl = fetchImpl;

    const code = await runCli(["counts"], io);

    expect(code).toBe(1);
    expect(err()).toContain("sourcery-agent:");
    expect(err()).toContain("HTTP 401");
  });
});

describe("setup subcommand", () => {
  const KEY = "sk-setup-abcdef1234567890";

  it("prints the ready-to-paste mcpServers block and never the full key", async () => {
    const { io, out } = makeIo({});
    const code = await runCli(["setup", "--api-key", KEY], io);

    expect(code).toBe(0);
    const text = out();
    expect(text).toContain("npx");
    expect(text).toContain('"-y"');
    expect(text).toContain("@abyssbugg/sourcery@latest");
    expect(text).toContain("SOURCERY_API_KEY");
    expect(text).not.toContain(KEY);
    expect(text).toContain("sk-s...7890");
  });

  it("--check makes exactly one allow-listed issue_stats call with the key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = routeFetch(calls, [
      { match: "/security-issues/stats", body: { total_count: 0, active_count: 0 } },
    ]);
    const { io, out } = makeIo({});
    io.fetchImpl = fetchImpl;

    const code = await runCli(["setup", "--api-key", KEY, "--check"], io);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/security-issues/stats");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(out()).toContain("check: OK");
    expect(out()).not.toContain(KEY);
  });

  it("--check without a key exits 1 with guidance", async () => {
    const { io, err } = makeIo({});
    const code = await runCli(["setup", "--check"], io);
    expect(code).toBe(1);
    expect(err()).toContain("SOURCERY_API_KEY");
  });

  it("--check with a rejected key exits 1 through the runtime error path", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response("bad key", { status: 403 }));
    const { io, err } = makeIo({});
    io.fetchImpl = fetchImpl;

    const code = await runCli(["setup", "--api-key", KEY, "--check"], io);

    expect(code).toBe(1);
    expect(err()).toContain("sourcery-agent:");
    expect(err()).toContain("HTTP 403");
  });
});

describe("help and usage errors", () => {
  it("top-level help exits 0 with usage text", async () => {
    const { io, out } = makeIo({});
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(out()).toContain("Usage: sourcery <command>");
  });

  it("-h exits 0 with usage text", async () => {
    const { io, out } = makeIo({});
    const code = await runCli(["-h"], io);
    expect(code).toBe(0);
    expect(out()).toContain("Usage: sourcery <command>");
  });

  it("subcommand help exits 0", async () => {
    const { io, out } = makeIo({});
    const code = await runCli(["snapshot", "--help"], io);
    expect(code).toBe(0);
    expect(out()).toContain("Usage: sourcery snapshot");
  });

  it("unknown commands exit 2 with argparse-style errors", async () => {
    const { io, err } = makeIo({});
    const code = await runCli(["bogus"], io);
    expect(code).toBe(2);
    expect(err()).toContain("sourcery: error:");
    expect(err()).toContain("invalid choice: 'bogus'");
  });

  it("unknown flags exit 2", async () => {
    const { io, err } = makeIo({});
    const code = await runCli(["get", "1", "--bogus"], io);
    expect(code).toBe(2);
    expect(err()).toContain("unrecognized arguments: --bogus");
  });
});

describe("forDisplay (round-6 recursive sanitization, port of test_for_display_recursively_sanitizes_nested_values)", () => {
  it("recursively sanitizes nested mappings and sequences", () => {
    const payload = {
      details: [{ fixed_versions: ["1.2.3\x1b]0;owned\x07"] }, ["safe\x1b[31m"]],
      top: "ok\x1b[31m",
      count: 5,
      nested: { deeper: { value: "\x07bad" } },
    };
    expect(forDisplay(payload)).toEqual({
      details: [{ fixed_versions: ["1.2.3"] }, ["safe"]],
      top: "ok",
      count: 5,
      nested: { deeper: { value: "bad" } },
    });
  });
});
