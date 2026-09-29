/**
 * The twelve MCP tool definitions for Sourcery's public security API.
 *
 * Faithful port of the tool surface in `python/src/sourcery_agent/server.py`,
 * wired against the pinned OpenAPI snapshot (`openapi/sourcery-openapi.json`);
 * `constants.VERIFIED_OPERATIONS` lists the exact eight operations. Sourcery's
 * PR review commands (review, summary, guide, title, resolve, dismiss, create
 * issue) are GitHub/GitLab comment or label commands, not public REST — use
 * your Git provider connector for those.
 *
 * Input schemas are strict zod objects with snake_case property names exactly
 * as the API documents. Bulk-update handlers run `validateBulkUpdate` BEFORE
 * the client is constructed, so no-op updates fail locally (parity with the
 * Python `test_bulk_tools_validate_before_constructing_a_client`).
 */

import { z } from "zod";

import {
  API_BASE,
  BULK_UPDATE_MAX_IDS,
  ISSUE_TYPES,
  LIST_MAX_LIMIT,
  OPENAPI_URL,
  REVIEW_COMMANDS,
  SEVERITIES,
  SPEC_FETCHED,
  SPEC_INFO,
  SPEC_SHA256,
  SPEC_SNAPSHOT_PATH,
  STATUSES,
  STATUS_INPUTS,
  VERIFIED_OPERATIONS,
} from "./constants.js";
import { validateBulkUpdate } from "./client.js";
import type { SourceryClient } from "./client.js";
import { buildFixPrompt } from "./prompts.js";
import type { Finding } from "./prompts.js";

/** Query parameters accepted by the client's `request` (scalar or scalar-array values). */
type RequestParams = Record<
  string,
  string | number | boolean | readonly (string | number | boolean)[] | null
>;

/**
 * Execution context handed to every tool run: the client is built lazily so
 * that local validation failures never construct (or authenticate) a client.
 */
export interface ToolContext {
  /** Build (or reuse) the SourceryClient for this invocation. */
  getClient(): SourceryClient;
}

/** One MCP tool: its name, description, strict zod input schema, and handler. */
export interface SourceryTool {
  /** Tool name exposed over MCP (snake_case, `sourcery_`-prefixed). */
  readonly name: string;
  /** Tool description shown in `tools/list`. */
  readonly description: string;
  /** Strict zod input schema; property names are snake_case. */
  readonly schema: z.ZodType;
  /**
   * Run the tool. Parses `args` with `schema` first, so invalid input and
   * local validation failures throw BEFORE `ctx.getClient()` is called.
   */
  run(args: unknown, ctx: ToolContext): unknown;
}

/** Normalize one tool definition so `run` always parses input through `schema`. */
function defineTool<S extends z.ZodType>(definition: {
  name: string;
  description: string;
  schema: S;
  run(args: z.output<S>, ctx: ToolContext): unknown;
}): SourceryTool {
  const { name, description, schema, run } = definition;
  return {
    name,
    description,
    schema,
    run: (args: unknown, ctx: ToolContext) => run(schema.parse(args), ctx),
  };
}

/** Report whether a value is a plain object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a page size against the API's 1..100 bound (the Python
 * `_check_limit` analog); schemas enforce the same bound.
 */
export function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${LIST_MAX_LIMIT}; got ${limit}`);
  }
  return limit;
}

/** Copy `key` out of a response mapping, falling back when the key is absent. */
function getOr(response: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return key in response ? response[key] : fallback;
}

/** Return the verified Sourcery integration boundary for this bundle. */
export function buildCapabilities(): Record<string, unknown> {
  return {
    public_api: "REST API for security findings (pinned OpenAPI snapshot)",
    api_base: API_BASE,
    spec: {
      url: OPENAPI_URL,
      info: SPEC_INFO,
      snapshot: SPEC_SNAPSHOT_PATH,
      sha256: SPEC_SHA256,
      fetched: SPEC_FETCHED,
    },
    operations: VERIFIED_OPERATIONS.map((operation) => ({
      method: operation.method,
      path: operation.path,
      description: operation.description,
    })),
    enums: {
      issue_types: ISSUE_TYPES,
      statuses: STATUSES,
      status_inputs: STATUS_INPUTS,
      severities: SEVERITIES,
    },
    review_commands: {
      commands: REVIEW_COMMANDS,
      transport: "GitHub/GitLab comments or labels, not public REST",
    },
  };
}

/** Shared filter block for the list/count tools (snake_case, strict). */
const listFiltersShape = {
  repository_ids: z.array(z.number().int()).nullish(),
  issue_types: z.array(z.enum(ISSUE_TYPES)).nullish(),
  statuses: z.array(z.enum(STATUSES)).nullish(),
  search: z.string().nullish(),
} as const;

/** Shared bulk-change block for the bulk-update tools. */
const bulkChangesShape = {
  ids: z.array(z.number().int()).min(1).max(BULK_UPDATE_MAX_IDS),
  status: z.enum(STATUS_INPUTS).nullish(),
  snoozed_until: z.string().nullish(),
  severity_override: z.enum(SEVERITIES).nullish(),
  reason: z.string().nullish(),
} as const;

/** Look up one registered tool by name (useful for tests and dispatchers). */
export function getTool(name: string): SourceryTool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** `sourcery_capabilities` — the pinned integration boundary, no client needed. */
export const sourceryCapabilities = defineTool({
  name: "sourcery_capabilities",
  description: "Return the verified Sourcery integration boundary for this bundle.",
  schema: z.object({}).strict(),
  run: () => buildCapabilities(),
});

/** `sourcery_security_snapshot` — counts plus the first page of ACTIVE issues. */
export const sourcerySecuritySnapshot = defineTool({
  name: "sourcery_security_snapshot",
  description: "Triage overview: counts by status/severity plus the first page of active issues.",
  schema: z
    .object({
      repository_ids: listFiltersShape.repository_ids,
      issue_types: listFiltersShape.issue_types,
      limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(25),
    })
    .strict(),
  run: (input, ctx) => {
    const { repository_ids, issue_types, limit } = input;
    const client = ctx.getClient();
    return (async () => {
      const counts = await client.issue_stats({ repository_ids, issue_types });
      const active = await client.list_issues({
        repository_ids,
        issue_types,
        statuses: ["ACTIVE"],
        limit: checkLimit(limit),
      });
      return {
        counts,
        active_issues: getOr(active, "data", []),
        has_more: active["has_more"] ?? null,
        next_cursor: active["next_cursor"] ?? null,
      };
    })();
  },
});

/** `sourcery_list_findings` — list issues with spec filters and cursor paging. */
export const sourceryListFindings = defineTool({
  name: "sourcery_list_findings",
  description: "List security issues with spec filters; pass a previous `next_cursor` to page.",
  schema: z.object({ ...listFiltersShape, limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(20), cursor: z.string().nullish() }).strict(),
  run: ({ repository_ids, issue_types, statuses, search, limit, cursor }, ctx) =>
    ctx.getClient().list_issues({
      repository_ids,
      issue_types,
      statuses,
      search,
      cursor,
      limit: checkLimit(limit),
    }),
});

/** `sourcery_get_finding` — one full issue record by id. */
export const sourceryGetFinding = defineTool({
  name: "sourcery_get_finding",
  description:
    "Fetch a single security issue (full record incl. source snippet and dependency graph).",
  schema: z.object({ finding_id: z.number().int() }).strict(),
  run: ({ finding_id }, ctx) => ctx.getClient().get_issue(finding_id),
});

/** `sourcery_get_security_counts` — aggregate issue counts by status/severity. */
export const sourceryGetSecurityCounts = defineTool({
  name: "sourcery_get_security_counts",
  description: "Aggregate issue counts by status and severity.",
  schema: z.object({ repository_ids: listFiltersShape.repository_ids, issue_types: listFiltersShape.issue_types }).strict(),
  run: ({ repository_ids, issue_types }, ctx) =>
    ctx.getClient().issue_stats({ repository_ids, issue_types }),
});

/** `sourcery_bulk_update_findings` — bulk status/severity change (max 100 ids). */
export const sourceryBulkUpdateFindings = defineTool({
  name: "sourcery_bulk_update_findings",
  description:
    "Bulk-update issue status/severity (max 100 ids; SOLVED cannot be set manually).\n\n" +
    "Returns `updated_ids` plus `failed` entries with reason `not_found` or `not_eligible`.",
  schema: z.object(bulkChangesShape).strict(),
  run: (input, ctx) => {
    // Local validation strictly before client construction: no-op PATCHes and
    // invalid snooze/status combinations fail without touching the network.
    validateBulkUpdate(input);
    return ctx.getClient().bulk_update_issues(input);
  },
});

/** `sourcery_list_groups` — list issue groups with the same filters as findings. */
export const sourceryListGroups = defineTool({
  name: "sourcery_list_groups",
  description:
    "List security issue groups (same filters as findings; groups aggregate one rule/package).",
  schema: z.object({ ...listFiltersShape, limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(20), cursor: z.string().nullish() }).strict(),
  run: ({ repository_ids, issue_types, statuses, search, limit, cursor }, ctx) =>
    ctx.getClient().list_groups({
      repository_ids,
      issue_types,
      statuses,
      search,
      cursor,
      limit: checkLimit(limit),
    }),
});

/** `sourcery_get_group` — one issue group (with its issues) by id. */
export const sourceryGetGroup = defineTool({
  name: "sourcery_get_group",
  description: "Fetch a single issue group including all its issues and any linked tracker task.",
  schema: z.object({ group_id: z.number().int() }).strict(),
  run: ({ group_id }, ctx) => ctx.getClient().get_group(group_id),
});

/** `sourcery_get_group_counts` — aggregate group counts by status/severity. */
export const sourceryGetGroupCounts = defineTool({
  name: "sourcery_get_group_counts",
  description: "Aggregate group counts by status and severity.",
  schema: z.object({ repository_ids: listFiltersShape.repository_ids, issue_types: listFiltersShape.issue_types }).strict(),
  run: ({ repository_ids, issue_types }, ctx) =>
    ctx.getClient().group_stats({ repository_ids, issue_types }),
});

/** `sourcery_bulk_update_groups` — bulk status/severity change for groups. */
export const sourceryBulkUpdateGroups = defineTool({
  name: "sourcery_bulk_update_groups",
  description:
    "Bulk-update groups (max 100 ids); a group updates when at least one issue changes.",
  schema: z.object(bulkChangesShape).strict(),
  run: (input, ctx) => {
    validateBulkUpdate(input);
    return ctx.getClient().bulk_update_groups(input);
  },
});

/** `sourcery_build_fix_prompt` — minimal-change agent prompt from a finding JSON blob. */
export const sourceryBuildFixPrompt = defineTool({
  name: "sourcery_build_fix_prompt",
  description:
    "Build a minimal-change agent prompt from a Sourcery finding object.\n\n" +
    "Handles DEPENDENCY findings via `fixed_versions` + `manifest_file_path` and " +
    "renders the dependency chain when `dependency_graph` is present.",
  schema: z.object({ finding_json: z.string() }).strict(),
  run: ({ finding_json }) => {
    let finding: unknown;
    try {
      finding = JSON.parse(finding_json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`finding_json is not valid JSON: ${message}`);
    }
    if (!isPlainObject(finding)) {
      throw new Error("finding_json must decode to an object");
    }
    return buildFixPrompt(finding);
  },
});

/**
 * Reject params values the URL serializer cannot round-trip (the client would
 * otherwise stringify nested objects into garbage query strings).
 */
function checkedRequestParams(params: Record<string, unknown>): RequestParams {
  const checked: RequestParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      checked[key] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      )
    ) {
      checked[key] = value;
      continue;
    }
    throw new Error(
      `params_json values must be strings, numbers, booleans, null, or arrays of those; got ${key}`,
    );
  }
  return checked;
}

/** Collection endpoints (list + bulk-PATCH) in the pinned surface. */
const COLLECTION_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/security-issues",
  "/api/v1/security-issue-groups",
]);
/** Aggregate-count endpoints in the pinned surface. */
const STATS_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/security-issues/stats",
  "/api/v1/security-issue-groups/stats",
]);
/** Single-item detail endpoints in the pinned surface (positive integer id). */
const ITEM_PATH = /^\/api\/v1\/security-(?:issues|issue-groups)\/[1-9][0-9]*$/;

/** Validate a JSON array of positive integer identifiers. */
export function positiveIntegerList(
  value: unknown,
  field: string,
  maxItems?: number,
): readonly number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (maxItems !== undefined && value.length > maxItems) {
    throw new Error(`${field} must contain at most ${maxItems} entries`);
  }
  if (value.some((item) => typeof item !== "number" || !Number.isInteger(item) || item <= 0)) {
    throw new Error(`${field} must contain only positive integers`);
  }
  return value as readonly number[];
}

/** Reject values outside a pinned enum; the message mirrors the client's. */
function checkSubset(values: unknown, allowed: readonly string[], field: string): void {
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array`);
  }
  for (const value of values) {
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new Error(
        `${field} must be one of ${JSON.stringify(allowed)}; got ${JSON.stringify(value)}`,
      );
    }
  }
}

/** Validate query parameters for one verified GET operation. */
export function validateApiRequestGet(
  path: string,
  params: Record<string, unknown>,
): void {
  let allowed: ReadonlySet<string>;
  if (COLLECTION_PATHS.has(path)) {
    allowed = new Set([
      "repository_ids",
      "issue_types",
      "statuses",
      "search",
      "limit",
      "cursor",
    ]);
  } else if (STATS_PATHS.has(path)) {
    allowed = new Set(["repository_ids", "issue_types"]);
  } else if (ITEM_PATH.test(path)) {
    allowed = new Set();
  } else {
    throw new Error(`GET path is not a verified Sourcery operation: ${path}`);
  }
  const unknown = Object.keys(params).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown parameters for ${path}: ${JSON.stringify(unknown.sort())}`);
  }
  if ("repository_ids" in params) {
    positiveIntegerList(params["repository_ids"], "repository_ids");
  }
  if ("issue_types" in params) {
    checkSubset(params["issue_types"], ISSUE_TYPES, "issue_types");
  }
  if ("statuses" in params) {
    checkSubset(params["statuses"], STATUSES, "statuses");
  }
  if ("limit" in params) {
    if (typeof params["limit"] !== "number" || !Number.isInteger(params["limit"])) {
      throw new Error("limit must be an integer");
    }
    checkLimit(params["limit"]);
  }
  for (const field of ["search", "cursor"]) {
    if (field in params && params[field] !== null && typeof params[field] !== "string") {
      throw new Error(`${field} must be a string or null`);
    }
  }
}

/** Validate a bulk-update body for one verified PATCH operation. */
export function validateApiRequestPatch(
  path: string,
  body: Record<string, unknown>,
): void {
  if (!COLLECTION_PATHS.has(path)) {
    throw new Error(`PATCH path is not a verified Sourcery operation: ${path}`);
  }
  const allowed = new Set(["ids", "status", "snoozed_until", "severity_override", "reason"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown fields in PATCH ${path}: ${JSON.stringify(unknown.sort())}`);
  }
  if (!("ids" in body)) {
    throw new Error(`PATCH ${path} requires 'ids' field`);
  }
  positiveIntegerList(body["ids"], "ids", BULK_UPDATE_MAX_IDS);
  const status = body["status"];
  if (status !== null && status !== undefined) {
    if (typeof status !== "string" || !(STATUS_INPUTS as readonly string[]).includes(status)) {
      throw new Error(
        `status must be one of ${JSON.stringify(STATUS_INPUTS)}; got ${JSON.stringify(status)}`,
      );
    }
  }
  const severity = body["severity_override"];
  if (severity !== null && severity !== undefined) {
    if (typeof severity !== "string" || !(SEVERITIES as readonly string[]).includes(severity)) {
      throw new Error(
        `severity_override must be one of ${JSON.stringify(SEVERITIES)}; got ${JSON.stringify(severity)}`,
      );
    }
  }
  for (const field of ["snoozed_until", "reason"]) {
    if (field in body && body[field] !== null && typeof body[field] !== "string") {
      throw new Error(`${field} must be a string or null`);
    }
  }
  validateBulkUpdate({
    status: typeof status === "string" ? status : null,
    snoozed_until: typeof body["snoozed_until"] === "string" ? body["snoozed_until"] : null,
    severity_override: typeof severity === "string" ? severity : null,
  });
}

/** `sourcery_api_request` — compatibility bridge over the eight verified operations. */
export const sourceryApiRequest = defineTool({
  name: "sourcery_api_request",
  description:
    "Compatibility bridge: call one of the eight verified operations directly.\n\n" +
    "Prefer the typed tools. The path allow-list is enforced in the client; anything " +
    "outside the pinned OpenAPI surface is rejected before a request is made.",
  schema: z
    .object({
      method: z.string(),
      path: z.string(),
      params_json: z.string().default("{}"),
      body_json: z.string().default("null"),
    })
    .strict(),
  run: ({ method, path, params_json, body_json }, ctx) => {
    let params: unknown;
    let body: unknown;
    try {
      params = JSON.parse(params_json || "{}");
      body = body_json === "" || body_json === "null" ? undefined : JSON.parse(body_json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON argument: ${message}`);
    }
    if (!isPlainObject(params)) {
      throw new Error("params_json must decode to an object");
    }
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod === "GET") {
      if (body !== undefined) {
        throw new Error(`GET ${path} does not accept a request body`);
      }
      validateApiRequestGet(path, params);
    } else if (normalizedMethod === "PATCH") {
      if (Object.keys(params).length > 0) {
        throw new Error(`PATCH ${path} does not accept query parameters`);
      }
      if (!isPlainObject(body)) {
        throw new Error("PATCH body must decode to an object");
      }
      validateApiRequestPatch(path, body);
    } else {
      throw new Error("method must be GET or PATCH");
    }
    return ctx.getClient().request({
      method: normalizedMethod,
      path,
      params: checkedRequestParams(params),
      body,
    });
  },
});

/** All twelve tools, in registration order. */
export const TOOLS: readonly SourceryTool[] = [
  sourceryCapabilities,
  sourcerySecuritySnapshot,
  sourceryListFindings,
  sourceryGetFinding,
  sourceryGetSecurityCounts,
  sourceryBulkUpdateFindings,
  sourceryListGroups,
  sourceryGetGroup,
  sourceryGetGroupCounts,
  sourceryBulkUpdateGroups,
  sourceryBuildFixPrompt,
  sourceryApiRequest,
];
