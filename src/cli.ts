#!/usr/bin/env node
/**
 * Single-binary CLI for the Sourcery bundle (TypeScript port of
 * `python/src/sourcery_agent/cli.py`, extended with server entry points).
 *
 * Subcommands:
 * - `sourcery` (no args) or `sourcery stdio` — MCP server over stdio.
 * - `sourcery http` — MCP server over streamable HTTP (see `./http.js`).
 * - `sourcery setup [--api-key KEY] [--check]` — print a ready-to-paste
 *   mcpServers config block; `--check` makes one live allow-listed
 *   `issue_stats` call to verify the key. The key is never printed in full.
 * - `sourcery snapshot | list | get | counts | fix-prompt` — query findings
 *   from a terminal, scripts, or CI (ported from the Python CLI).
 *
 * Key resolution mirrors the Python CLI: `SOURCERY_API_KEY` (environment), or
 * a key file at `SOURCERY_API_KEY_FILE` (fallback
 * `PLUGIN_DATA`/`CLAUDE_PLUGIN_DATA`/`~/.local/share/sourcery-agent` +
 * `sourcery_api_key`). Runtime failures print `sourcery-agent: <message>` to
 * stderr and exit 1; malformed command lines print an argparse-style error
 * and exit 2.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SourceryClient, SourceryError } from "./client.js";
import { ISSUE_TYPES, SEVERITIES, STATUSES } from "./constants.js";
import type { IssueType, Status } from "./constants.js";
import { runHttp } from "./http.js";
import { buildFixPrompt } from "./prompts.js";
import type { Finding } from "./prompts.js";
import { runStdio } from "./stdio.js";

/** Injection surface for the CLI: streams, environment, key file, and fetch. */
export interface CliIo {
  /** Environment consulted for keys and filters; defaults to `process.env`. */
  env: Record<string, string | undefined>;
  /** Raw stdout writer; defaults to `process.stdout.write`. */
  stdout: (text: string) => void;
  /** Raw stderr writer; defaults to `process.stderr.write`. */
  stderr: (text: string) => void;
  /**
   * Read a key file, returning `null` when it does not exist (mirrors
   * `Path.is_file()` + `read_text()`); read failures must throw. Defaults to
   * the filesystem; tests may inject.
   */
  readKeyFile?: (path: string) => string | null;
  /** Fetch implementation handed to `SourceryClient` (tests). */
  fetchImpl?: typeof fetch;
}

/** Malformed command line; reported argparse-style with exit code 2. */
export class CliUsageError extends Error {
  /** Process exit code for usage errors (argparse convention). */
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Terminal escape injection: strip ANSI CSI/OSC sequences and control bytes from untrusted finding text before rendering (JSON output stays raw data). */
const ESCAPE_SEQUENCES =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Strip ANSI/OSC escape sequences and control characters from untrusted text.
 *
 * Newlines and tabs are preserved (they are outside the stripped control
 * range), matching the Python `sanitize_for_terminal` regex exactly.
 */
export function sanitizeForTerminal(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "");
}

/**
 * True when an env value is a real key (not empty or an unexpanded reference
 * such as `${user_config.sourcery_api_key}`).
 */
export function usableKey(value: string | null | undefined): boolean {
  return Boolean(value) && !value!.includes("${");
}

/**
 * Render a field the way the Python f-strings do: `str(value)`, with absent
 * (`undefined`) and `null` fields rendering as `None`. Arrays render as JSON
 * (Python renders list reprs; double quotes are the only difference).
 */
function pystr(value: unknown, fallback = "None"): string {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** `dict.get(key, fallback)` semantics: fallback only when the key is absent. */
function dictGet(finding: Finding, key: string, fallback?: unknown): unknown {
  const value = finding[key];
  return value === undefined ? fallback : value;
}

/** Python truthiness for `or`-chains (`""`, `0`, `null` are all falsy). */
function truthy(value: unknown): boolean {
  return Boolean(value);
}

/**
 * Copy a finding with untrusted string fields sanitized for terminal display.
 */
function forDisplay(finding: Finding): Finding {
  const display: Finding = {};
  for (const [key, value] of Object.entries(finding)) {
    display[key] = typeof value === "string" ? sanitizeForTerminal(value) : value;
  }
  return display;
}

/** Mask a key for display: never the full value. */
function maskKey(key: string): string {
  if (key.length <= 8) return "...";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Render one finding as a single fixed-width table row (port of
 * `format_finding_row`). Locations longer than 34 characters keep their tail;
 * titles longer than 60 characters are truncated with an ellipsis.
 */
export function formatFindingRow(finding: Finding): string {
  const findingId = sanitizeForTerminal(pystr(dictGet(finding, "id", "?")));
  const severity = sanitizeForTerminal(pystr(dictGet(finding, "severity", "?")));
  const issueType = sanitizeForTerminal(pystr(dictGet(finding, "issue_type", "?")));
  const status = sanitizeForTerminal(pystr(dictGet(finding, "status", "?")));
  const filePath = dictGet(finding, "file_path");
  let location = sanitizeForTerminal(pystr(truthy(filePath) ? filePath : "", ""));
  if (!location && truthy(dictGet(finding, "package_name"))) {
    const version = truthy(dictGet(finding, "package_version"))
      ? `@${pystr(dictGet(finding, "package_version"))}`
      : "";
    location = sanitizeForTerminal(`${pystr(dictGet(finding, "package_name"))}${version}`);
  }
  if (location.length > 34) {
    location = "..." + location.slice(-31);
  }
  const rawTitle = dictGet(finding, "title");
  let title = sanitizeForTerminal(pystr(truthy(rawTitle) ? rawTitle : "", "")).trim();
  if (title.length > 60) {
    title = title.slice(0, 57) + "...";
  }
  return (
    `${findingId.padStart(7)}  ${severity.padEnd(8)}  ${issueType.padEnd(10)}  ` +
    `${status.padEnd(8)}  ${location.padEnd(34)}  ${title}`
  );
}

/** Sort key mirroring `-_SEVERITY_RANK.get(severity, -1)` (unknown last). */
function severitySortKey(finding: Finding): number {
  const severity = dictGet(finding, "severity");
  const rank =
    typeof severity === "string"
      ? SEVERITIES.indexOf(severity as (typeof SEVERITIES)[number])
      : -1;
  return rank === -1 ? 1 : -rank;
}

/** Print findings as a severity-sorted table with a header. */
function printFindings(io: CliIo, items: readonly Finding[]): void {
  print(
    io,
    `${"ID".padStart(7)}  ${"SEVERITY".padEnd(8)}  ${"TYPE".padEnd(10)}  ` +
      `${"STATUS".padEnd(8)}  ${"LOCATION".padEnd(34)}  TITLE`,
  );
  const ordered = [...items].sort((a, b) => severitySortKey(a) - severitySortKey(b));
  for (const finding of ordered) {
    print(io, formatFindingRow(finding));
  }
}

/** Print the status and severity count summary. */
function printStats(io: CliIo, stats: Finding): void {
  print(
    io,
    `total=${pystr(stats["total_count"])} active=${pystr(stats["active_count"])} ` +
      `snoozed=${pystr(stats["snoozed_count"])} ignored=${pystr(stats["ignored_count"])} ` +
      `solved=${pystr(stats["solved_count"])}`,
  );
  print(
    io,
    `active severity: critical=${pystr(stats["critical_count"])} high=${pystr(stats["high_count"])} ` +
      `medium=${pystr(stats["medium_count"])} low=${pystr(stats["low_count"])}`,
  );
}

/** Write one line (newline-terminated) to the CLI's stdout. */
function print(io: CliIo, line: string): void {
  io.stdout(`${line}\n`);
}

/** Default key-file reader: `Path.is_file()` (swallows stat errors) + read. */
function defaultReadKeyFile(path: string): string | null {
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return null;
  return readFileSync(path, "utf8");
}

/**
 * Populate the API key from the environment or the key file (port of
 * `_load_key`). Returns the key, or `undefined` when none is usable.
 */
export function loadKey(io: Pick<CliIo, "env" | "readKeyFile">): string | undefined {
  if (usableKey(io.env["SOURCERY_API_KEY"])) {
    return io.env["SOURCERY_API_KEY"];
  }
  const dataDir =
    io.env["PLUGIN_DATA"] ||
    io.env["CLAUDE_PLUGIN_DATA"] ||
    join(homedir(), ".local/share/sourcery-agent");
  const keyFile = io.env["SOURCERY_API_KEY_FILE"] || join(dataDir, "sourcery_api_key");
  const content = (io.readKeyFile ?? defaultReadKeyFile)(keyFile);
  if (content) {
    const key = content.trim();
    if (key) return key;
  }
  return undefined;
}

/** `snapshot` arguments. */
export interface SnapshotArgs {
  kind: "snapshot";
  repoId: number[];
  issueTypes: IssueType[];
  limit: number;
  json: boolean;
}

/** `list` arguments. */
export interface ListArgs {
  kind: "list";
  repoId: number[];
  issueTypes: IssueType[];
  statuses: Status[];
  search?: string;
  cursor?: string;
  limit: number;
  json: boolean;
}

/** `get` arguments. */
export interface GetArgs {
  kind: "get";
  id: number;
  json: boolean;
}

/** `counts` arguments. */
export interface CountsArgs {
  kind: "counts";
  repoId: number[];
  issueTypes: IssueType[];
  json: boolean;
}

/** `fix-prompt` arguments. */
export interface FixPromptArgs {
  kind: "fix-prompt";
  id: number;
}

/** `setup` arguments. */
export interface SetupArgs {
  kind: "setup";
  apiKey?: string;
  check: boolean;
}

/** Server entry-point arguments. */
export interface StdioArgs {
  kind: "stdio";
}

/** `http` arguments. */
export interface HttpArgs {
  kind: "http";
}

/** `--help` requested (optionally for one subcommand). */
export interface HelpArgs {
  kind: "help";
  command?: string;
}

/** Parsed command line: one discriminated action for {@link runCli}. */
export type CliArgs =
  | SnapshotArgs
  | ListArgs
  | GetArgs
  | CountsArgs
  | FixPromptArgs
  | SetupArgs
  | StdioArgs
  | HttpArgs
  | HelpArgs;

/** Subcommand names, in the order reported by usage errors. */
const COMMAND_NAMES = [
  "stdio",
  "http",
  "setup",
  "snapshot",
  "list",
  "get",
  "counts",
  "fix-prompt",
] as const;

/** Top-level usage text. */
const USAGE = `sourcery - Sourcery security findings for AI coding agents.

Usage: sourcery <command> [options]

Commands:
  stdio          run the MCP server over stdio (default with no command)
  http           run the MCP server over streamable HTTP
  setup          print a ready-to-paste mcpServers config (add --check to verify the key)
  snapshot       counts by status/severity plus the first page of active findings
  list           list findings with filters
  get ID         show one finding
  counts         aggregate counts by status and severity
  fix-prompt ID  print the minimal-change fix prompt for one finding

Run 'sourcery <command> --help' for command-specific options.`;

/** Per-subcommand help text (argparse-style). */
const COMMAND_USAGE: Record<string, string> = {
  stdio: `Usage: sourcery stdio

Run the MCP server over stdio (the default when no command is given).
Reads SOURCERY_API_KEY from the environment (or the key file, like the CLI).`,
  http: `Usage: sourcery http

Run the MCP server over streamable HTTP (loopback-only by default).

Environment:
  SOURCERY_MCP_HOST          bind host (default 127.0.0.1)
  SOURCERY_MCP_PORT          bind port (default 8765)
  SOURCERY_MCP_PATH          MCP endpoint path (default /mcp)
  SOURCERY_MCP_ALLOW_REMOTE  set to 1 to allow non-loopback binds
  SOURCERY_MCP_AUTH_TOKEN    bearer token; required for non-loopback binds and enforced on every request when set`,
  setup: `Usage: sourcery setup [--api-key KEY] [--check]

Print a ready-to-paste mcpServers config block for MCP hosts and explain
where the API key goes. The key is never printed in full.

Options:
  --api-key KEY  use this key (masked in the output) instead of SOURCERY_API_KEY
  --check        make one live allow-listed call (issue_stats) to verify the key`,
  snapshot: `Usage: sourcery snapshot [--repo-id N] [--type TYPE] [--limit N] [--json]

Counts by status/severity plus the first page of active findings.

Options:
  --repo-id N  filter by repository id (repeatable)
  --type TYPE  filter by issue type (repeatable)
  --limit N    active-findings page size (default 25)
  --json       print machine-readable JSON`,
  list: `Usage: sourcery list [--repo-id N] [--type TYPE] [--status STATUS] [--search S] [--cursor C] [--limit N] [--json]

List findings with filters and pagination.

Options:
  --repo-id N      filter by repository id (repeatable)
  --type TYPE      filter by issue type (repeatable)
  --status STATUS  filter by status (repeatable)
  --search S       substring match on title / file / package
  --cursor C       pagination cursor from a previous next_cursor
  --limit N        page size (default 20)
  --json           print machine-readable JSON`,
  get: `Usage: sourcery get ID [--json]

Show one finding's details.`,
  counts: `Usage: sourcery counts [--repo-id N] [--type TYPE] [--json]

Aggregate counts by status and severity.

Options:
  --repo-id N  filter by repository id (repeatable)
  --type TYPE  filter by issue type (repeatable)
  --json       print machine-readable JSON`,
  "fix-prompt": `Usage: sourcery fix-prompt ID

Print the minimal-change fix prompt for one finding.`,
};

/** One trailing value for a flag; raises argparse-style when missing. */
function nextValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new CliUsageError(`argument ${flag}: expected one argument`);
  }
  return value;
}

/** Integer flag value (`type=int`); raises argparse-style when invalid. */
function nextInt(argv: readonly string[], index: number, flag: string): number {
  const raw = nextValue(argv, index, flag);
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new CliUsageError(`argument ${flag}: invalid int value: '${raw}'`);
  }
  return Number(trimmed);
}

/** Choice flag value; raises argparse-style when invalid. */
function nextChoice<T extends string>(
  argv: readonly string[],
  index: number,
  flag: string,
  choices: readonly T[],
): T {
  const raw = nextValue(argv, index, flag);
  if (!(choices as readonly string[]).includes(raw)) {
    const options = choices.map((choice) => `'${choice}'`).join(", ");
    throw new CliUsageError(`argument ${flag}: invalid choice: '${raw}' (choose from ${options})`);
  }
  return raw as T;
}

/** Integer positional value (`type=int`); raises argparse-style when invalid. */
function positionalInt(raw: string): number {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new CliUsageError(`argument id: invalid int value: '${raw}'`);
  }
  return Number(trimmed);
}

/** Shared loop state for per-command parsers. */
interface ParseState {
  repoId: number[];
  issueTypes: IssueType[];
  statuses: Status[];
  search?: string;
  cursor?: string;
  limit?: number;
  json: boolean;
  help: boolean;
  positionals: string[];
}

/** Walk the remaining tokens for the shared filter/flag options. */
function parseOptions(
  argv: readonly string[],
  options: { statuses: boolean; search: boolean; cursor: boolean; limit: boolean },
): ParseState {
  const state: ParseState = {
    repoId: [],
    issueTypes: [],
    statuses: [],
    json: false,
    help: false,
    positionals: [],
  };
  let afterDoubleDash = false;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && (arg === "-h" || arg === "--help")) {
      state.help = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg.length > 1) {
      switch (arg) {
        case "--repo-id":
          state.repoId.push(nextInt(argv, index, "--repo-id"));
          index += 2;
          continue;
        case "--type":
          state.issueTypes.push(nextChoice(argv, index, "--type", ISSUE_TYPES));
          index += 2;
          continue;
        case "--status":
          if (!options.statuses) throw new CliUsageError(`unrecognized arguments: ${arg}`);
          state.statuses.push(nextChoice(argv, index, "--status", STATUSES));
          index += 2;
          continue;
        case "--search":
          if (!options.search) throw new CliUsageError(`unrecognized arguments: ${arg}`);
          state.search = nextValue(argv, index, "--search");
          index += 2;
          continue;
        case "--cursor":
          if (!options.cursor) throw new CliUsageError(`unrecognized arguments: ${arg}`);
          state.cursor = nextValue(argv, index, "--cursor");
          index += 2;
          continue;
        case "--limit":
          if (!options.limit) throw new CliUsageError(`unrecognized arguments: ${arg}`);
          state.limit = nextInt(argv, index, "--limit");
          index += 2;
          continue;
        case "--json":
          state.json = true;
          index += 1;
          continue;
        default:
          throw new CliUsageError(`unrecognized arguments: ${arg}`);
      }
    }
    state.positionals.push(arg);
    index += 1;
  }
  return state;
}

/** Reject stray positionals for commands that take none. */
function requireNoPositionals(state: ParseState): void {
  if (state.positionals.length > 0) {
    throw new CliUsageError(`unrecognized arguments: ${state.positionals.join(" ")}`);
  }
}

/** Parse `sourcery snapshot ...`. */
function parseSnapshot(argv: readonly string[]): CliArgs {
  const state = parseOptions(argv, { statuses: false, search: false, cursor: false, limit: true });
  if (state.help) return { kind: "help", command: "snapshot" };
  requireNoPositionals(state);
  return {
    kind: "snapshot",
    repoId: state.repoId,
    issueTypes: state.issueTypes,
    limit: state.limit ?? 25,
    json: state.json,
  };
}

/** Parse `sourcery list ...`. */
function parseList(argv: readonly string[]): CliArgs {
  const state = parseOptions(argv, { statuses: true, search: true, cursor: true, limit: true });
  if (state.help) return { kind: "help", command: "list" };
  requireNoPositionals(state);
  return {
    kind: "list",
    repoId: state.repoId,
    issueTypes: state.issueTypes,
    statuses: state.statuses,
    search: state.search,
    cursor: state.cursor,
    limit: state.limit ?? 20,
    json: state.json,
  };
}

/** Parse `sourcery counts ...`. */
function parseCounts(argv: readonly string[]): CliArgs {
  const state = parseOptions(argv, { statuses: false, search: false, cursor: false, limit: false });
  if (state.help) return { kind: "help", command: "counts" };
  requireNoPositionals(state);
  return {
    kind: "counts",
    repoId: state.repoId,
    issueTypes: state.issueTypes,
    json: state.json,
  };
}

/** Parse a single required integer positional (`get` / `fix-prompt`). */
function parseIdCommand(argv: readonly string[]): { id: number; json: boolean; help: boolean } {
  const state = parseOptions(argv, { statuses: false, search: false, cursor: false, limit: false });
  if (state.help) return { id: 0, json: state.json, help: true };
  if (state.positionals.length === 0) {
    throw new CliUsageError("the following arguments are required: id");
  }
  if (state.positionals.length > 1) {
    throw new CliUsageError(`unrecognized arguments: ${state.positionals.slice(1).join(" ")}`);
  }
  return { id: positionalInt(state.positionals[0]!), json: state.json, help: false };
}

/** Parse `sourcery get ID [--json]`. */
function parseGet(argv: readonly string[]): CliArgs {
  const parsed = parseIdCommand(argv);
  if (parsed.help) return { kind: "help", command: "get" };
  return { kind: "get", id: parsed.id, json: parsed.json };
}

/** Parse `sourcery fix-prompt ID`. */
function parseFixPrompt(argv: readonly string[]): CliArgs {
  const parsed = parseIdCommand(argv);
  if (parsed.help) return { kind: "help", command: "fix-prompt" };
  return { kind: "fix-prompt", id: parsed.id };
}

/** Parse `sourcery setup [--api-key KEY] [--check]`. */
function parseSetup(argv: readonly string[]): CliArgs {
  let apiKey: string | undefined;
  let check = false;
  let help = false;
  let afterDoubleDash = false;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && (arg === "-h" || arg === "--help")) {
      help = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg.length > 1) {
      switch (arg) {
        case "--api-key":
          apiKey = nextValue(argv, index, "--api-key");
          index += 2;
          continue;
        case "--check":
          check = true;
          index += 1;
          continue;
        default:
          throw new CliUsageError(`unrecognized arguments: ${arg}`);
      }
    }
    throw new CliUsageError(`unrecognized arguments: ${arg}`);
  }
  if (help) return { kind: "help", command: "setup" };
  return { kind: "setup", apiKey, check };
}

/** Parse flagless server commands (`stdio` / `http`). */
function parseFlagless(argv: readonly string[], command: "stdio" | "http"): CliArgs {
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return { kind: "help", command };
    if (arg !== "--") throw new CliUsageError(`unrecognized arguments: ${arg}`);
  }
  return command === "stdio" ? { kind: "stdio" } : { kind: "http" };
}

/**
 * Parse the CLI argv into a discriminated action. No args means the stdio
 * server; `--help` / `-h` produce a help action; anything malformed raises
 * {@link CliUsageError} (exit code 2).
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const command = argv[0];
  if (command === undefined) return { kind: "stdio" };
  const rest = argv.slice(1);
  if (command === "-h" || command === "--help") return { kind: "help" };
  switch (command) {
    case "stdio":
      return parseFlagless(rest, "stdio");
    case "http":
      return parseFlagless(rest, "http");
    case "setup":
      return parseSetup(rest);
    case "snapshot":
      return parseSnapshot(rest);
    case "list":
      return parseList(rest);
    case "get":
      return parseGet(rest);
    case "counts":
      return parseCounts(rest);
    case "fix-prompt":
      return parseFixPrompt(rest);
    default: {
      const options = COMMAND_NAMES.map((name) => `'${name}'`).join(", ");
      throw new CliUsageError(
        `argument command: invalid choice: '${command}' (choose from ${options})`,
      );
    }
  }
}

/** Build the client for query commands; a missing key fails before any I/O. */
function makeClient(io: CliIo): SourceryClient {
  const apiKey = loadKey(io);
  if (!apiKey) {
    throw new SourceryError("SOURCERY_API_KEY is not configured");
  }
  return new SourceryClient({ apiKey, fetchImpl: io.fetchImpl });
}

/** Ready-to-paste mcpServers block printed by `sourcery setup`. */
const SETUP_JSON_BLOCK = JSON.stringify(
  {
    mcpServers: {
      sourcery: {
        command: "npx",
        args: ["-y", "@abyssbugg/sourcery@latest"],
        env: { SOURCERY_API_KEY: "<your-sourcery-api-key>" },
      },
    },
  },
  null,
  2,
);

/** Handle `sourcery setup`: config block plus an optional live key check. */
async function cmdSetup(args: SetupArgs, io: CliIo): Promise<number> {
  const provided = args.apiKey?.trim();
  const key = provided || loadKey(io);
  let checkLine: string | null = null;
  if (args.check) {
    if (!key) {
      throw new SourceryError(
        "SOURCERY_API_KEY is not configured; pass --api-key KEY (or set SOURCERY_API_KEY) to run --check",
      );
    }
    const client = new SourceryClient({ apiKey: key, fetchImpl: io.fetchImpl });
    const stats = await client.issue_stats({});
    checkLine = `check: OK - issue_stats responded (total=${pystr(stats["total_count"])})`;
  }

  print(io, "Sourcery MCP setup");
  print(io, "");
  print(io, "1. Get your Sourcery API key from your Sourcery account settings.");
  print(io, "");
  print(io, "2. Register the MCP server with your host using this ready-to-paste block");
  print(io, "   (the key goes in the env block - the host's userConfig env):");
  print(io, "");
  print(io, SETUP_JSON_BLOCK);
  print(io, "");
  print(io, "3. Or export the key in your shell before starting the host:");
  print(io, "   export SOURCERY_API_KEY=<your-sourcery-api-key>");
  print(io, "");
  if (key) {
    const source = provided ? "--api-key" : "SOURCERY_API_KEY";
    print(io, `Key configured from ${source}: ${maskKey(key)} (never printed in full)`);
  } else {
    print(
      io,
      "No API key found yet - set SOURCERY_API_KEY (or pass --api-key KEY) so the tools can reach the Sourcery API.",
    );
  }
  if (checkLine) print(io, checkLine);
  return 0;
}

/** Counts by status/severity plus the first page of active findings. */
async function cmdSnapshot(args: SnapshotArgs, io: CliIo, client: SourceryClient): Promise<number> {
  const repositoryIds = args.repoId.length > 0 ? args.repoId : null;
  const issueTypes = args.issueTypes.length > 0 ? args.issueTypes : null;
  const counts = await client.issue_stats({ repository_ids: repositoryIds, issue_types: issueTypes });
  const page = await client.list_issues({
    repository_ids: repositoryIds,
    issue_types: issueTypes,
    statuses: ["ACTIVE"],
    limit: args.limit,
  });
  if (args.json) {
    print(io, JSON.stringify({ counts, active_issues: page }, null, 2));
    return 0;
  }
  printStats(io, counts);
  const active = Array.isArray(page["data"]) ? (page["data"] as Finding[]) : [];
  print(io, `\nActive findings (${active.length} shown):`);
  printFindings(io, active);
  if (page["has_more"]) {
    print(io, `more available - next cursor: ${pystr(page["next_cursor"])}`);
  }
  return 0;
}

/** List findings with the requested filters and pagination. */
async function cmdList(args: ListArgs, io: CliIo, client: SourceryClient): Promise<number> {
  const page = await client.list_issues({
    repository_ids: args.repoId.length > 0 ? args.repoId : null,
    issue_types: args.issueTypes.length > 0 ? args.issueTypes : null,
    statuses: args.statuses.length > 0 ? args.statuses : null,
    search: args.search ?? null,
    cursor: args.cursor ?? null,
    limit: args.limit,
  });
  if (args.json) {
    print(io, JSON.stringify(page, null, 2));
    return 0;
  }
  printFindings(io, Array.isArray(page["data"]) ? (page["data"] as Finding[]) : []);
  if (page["has_more"]) {
    print(io, `more available - pass --cursor ${pystr(page["next_cursor"])}`);
  }
  return 0;
}

/** Print one finding's details. */
async function cmdGet(args: GetArgs, io: CliIo, client: SourceryClient): Promise<number> {
  const raw = await client.get_issue(args.id);
  if (args.json) {
    print(io, JSON.stringify(raw, null, 2));
    return 0;
  }
  const finding = forDisplay(raw);
  print(io, `#${pystr(finding["id"])}  ${pystr(finding["title"])}`);
  print(
    io,
    `severity=${pystr(finding["severity"])} status=${pystr(finding["status"])} ` +
      `type=${pystr(finding["issue_type"])} rule=${pystr(finding["rule_id"])}`,
  );
  if (truthy(finding["file_path"])) {
    let suffix = truthy(finding["line_start"]) ? `:${pystr(finding["line_start"])}` : "";
    if (truthy(finding["line_end"]) && finding["line_end"] !== finding["line_start"]) {
      suffix = `:${pystr(finding["line_start"])}-${pystr(finding["line_end"])}`;
    }
    print(io, `location: ${pystr(finding["file_path"])}${suffix}`);
  }
  if (truthy(finding["package_name"])) {
    print(
      io,
      `package: ${pystr(finding["package_name"])}@${pystr(finding["package_version"])} ` +
        `fixed versions: ${pystr(finding["fixed_versions"])}`,
    );
  }
  if (truthy(finding["manifest_file_path"])) {
    print(io, `manifest to edit: ${pystr(finding["manifest_file_path"])}`);
  }
  if (truthy(finding["documentation_url"])) {
    print(io, `docs: ${pystr(finding["documentation_url"])}`);
  }
  const description = pystr(truthy(finding["description"]) ? finding["description"] : "", "").trim();
  if (description) {
    print(io, `\n${description}`);
  }
  return 0;
}

/** Print aggregate counts by status and severity. */
async function cmdCounts(args: CountsArgs, io: CliIo, client: SourceryClient): Promise<number> {
  const stats = await client.issue_stats({
    repository_ids: args.repoId.length > 0 ? args.repoId : null,
    issue_types: args.issueTypes.length > 0 ? args.issueTypes : null,
  });
  if (args.json) {
    print(io, JSON.stringify(stats, null, 2));
    return 0;
  }
  printStats(io, stats);
  return 0;
}

/** Print the minimal-change fix prompt for one finding. */
async function cmdFixPrompt(args: FixPromptArgs, io: CliIo, client: SourceryClient): Promise<number> {
  const finding = await client.get_issue(args.id);
  print(io, buildFixPrompt(finding));
  return 0;
}

/** Dispatch a parsed action and return the process exit code. */
async function dispatchCommand(args: CliArgs, io: CliIo): Promise<number> {
  switch (args.kind) {
    case "stdio":
      await runStdio({ apiKey: loadKey(io) });
      return 0;
    case "http":
      // Mirrors Python's SystemExit(message): the guidance prints bare to
      // stderr and the process exits 1.
      try {
        await runHttp({ env: io.env, apiKey: loadKey(io) });
      } catch (error) {
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
      return 0;
    case "setup":
      return cmdSetup(args, io);
    case "snapshot":
      return cmdSnapshot(args, io, makeClient(io));
    case "list":
      return cmdList(args, io, makeClient(io));
    case "get":
      return cmdGet(args, io, makeClient(io));
    case "counts":
      return cmdCounts(args, io, makeClient(io));
    case "fix-prompt":
      return cmdFixPrompt(args, io, makeClient(io));
    // Help is handled by the caller before dispatch; this keeps the switch
    // exhaustive for the compiler.
    case "help":
      return 0;
  }
}

/**
 * Run the CLI and return the process exit code.
 *
 * Parse failures exit 2 (argparse convention); runtime failures print
 * `sourcery-agent: <message>` to stderr and exit 1; success exits 0. Output
 * goes through {@link CliIo}, so tests inject collectors instead of spawning
 * processes.
 */
export async function runCli(argv: readonly string[], overrides: Partial<CliIo> = {}): Promise<number> {
  const io: CliIo = {
    env: overrides.env ?? process.env,
    stdout: overrides.stdout ?? ((text: string) => {
      process.stdout.write(text);
    }),
    stderr: overrides.stderr ?? ((text: string) => {
      process.stderr.write(text);
    }),
    readKeyFile: overrides.readKeyFile,
    fetchImpl: overrides.fetchImpl,
  };

  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    io.stderr(`sourcery: error: ${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (args.kind === "help") {
    print(io, args.command ? (COMMAND_USAGE[args.command] ?? USAGE) : USAGE);
    return 0;
  }

  try {
    return await dispatchCommand(args, io);
  } catch (error) {
    io.stderr(`sourcery-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** True when this module is the process entry point (the `sourcery` bin). */
function isMainModule(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/* Entry-point wiring: only when executed directly as the bin. */
if (isMainModule()) {
  void runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`sourcery-agent: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
