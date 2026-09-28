/**
 * HTTP client for the pinned Sourcery security API surface.
 *
 * Requests are gated against the exact operations in the OpenAPI snapshot
 * committed at `openapi/sourcery-openapi.json` (see `./constants.js`); anything
 * outside that surface is rejected before a socket is opened.
 *
 * Paths use the `/api/v1/...` convention from the docs. `SOURCERY_API_BASE`
 * already includes the `/api` prefix (default `https://api.sourcery.ai/api`).
 */

import { API_BASE, BULK_UPDATE_MAX_IDS, LIST_MAX_LIMIT, STATUS_INPUTS } from "./constants.js";

/** Report Sourcery API or configuration failures raised by this bundle. */
export class SourceryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceryError";
  }
}

/** Report local validation failures raised before any request is attempted. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const EXACT_OPERATIONS: ReadonlySet<string> = new Set([
  "GET /api/v1/security-issues",
  "GET /api/v1/security-issues/stats",
  "PATCH /api/v1/security-issues",
  "GET /api/v1/security-issue-groups",
  "GET /api/v1/security-issue-groups/stats",
  "PATCH /api/v1/security-issue-groups",
]);

const DETAIL_OPERATION = /^\/api\/v1\/(?:security-issues|security-issue-groups)\/\d+$/;

/** Raise unless `method path` is one of the eight verified operations. */
export function ensureAllowed(method: string, path: string): void {
  const normalized = method.trim().toUpperCase();
  if (EXACT_OPERATIONS.has(`${normalized} ${path}`)) return;
  if (normalized === "GET" && DETAIL_OPERATION.test(path)) return;
  throw new SourceryError(
    `Operation is not in the pinned Sourcery OpenAPI surface: ${normalized} ${path}`,
  );
}

/** Drop `null`/`undefined` values so unset filters are omitted from requests. */
function withoutNone<T extends Record<string, unknown>>(mapping: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(mapping).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

/** Coerce one path/bulk id to an integer. */
function checkedId(id: number): number {
  const coerced = Number(id);
  if (!Number.isInteger(coerced)) {
    throw new ValidationError(`id must be an integer; got ${String(id)}`);
  }
  return coerced;
}

/** Validate bulk-update ids (non-empty, at most 100). */
function checkedIds(ids: readonly number[]): number[] {
  if (ids.length === 0) {
    throw new ValidationError("ids must contain at least one id");
  }
  if (ids.length > BULK_UPDATE_MAX_IDS) {
    throw new ValidationError(
      `ids must contain at most ${BULK_UPDATE_MAX_IDS} ids; got ${ids.length}`,
    );
  }
  return ids.map(checkedId);
}

/** Validate a page size against the API's 1..100 bound. */
function checkedLimit(limit: number | null | undefined): number | null | undefined {
  if (limit === null || limit === undefined) return limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
    throw new ValidationError(`limit must be between 1 and ${LIST_MAX_LIMIT}; got ${limit}`);
  }
  return limit;
}

export interface BulkUpdateChanges {
  status?: string | null;
  snoozed_until?: string | null;
  severity_override?: string | null;
}

/** Reject no-op updates, unknown statuses, and invalid snooze combinations. */
export function validateBulkUpdate({
  status,
  snoozed_until,
  severity_override,
}: BulkUpdateChanges): void {
  if (status == null && severity_override == null) {
    throw new ValidationError(
      "bulk update requires status and/or severity_override; refusing to send a no-op PATCH",
    );
  }
  if (status != null && !(STATUS_INPUTS as readonly string[]).includes(status)) {
    throw new ValidationError(
      `status must be one of ${JSON.stringify(STATUS_INPUTS)}; got ${JSON.stringify(status)}`,
    );
  }
  if (snoozed_until != null && status !== "SNOOZED") {
    throw new ValidationError("snoozed_until is only valid with status='SNOOZED'");
  }
  if (status === "SNOOZED" && snoozed_until == null) {
    throw new ValidationError("snoozed_until is required when status='SNOOZED'");
  }
}

export interface ListIssuesOptions {
  repository_ids?: number[] | null;
  issue_types?: string[] | null;
  statuses?: string[] | null;
  search?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface BulkUpdateOptions extends BulkUpdateChanges {
  ids: number[];
  reason?: string | null;
}

export interface RequestInput {
  method: string;
  path: string;
  params?: Record<
    string,
    string | number | boolean | readonly (string | number | boolean)[] | null
  > | null;
  body?: unknown;
}

export interface SourceryClientOptions {
  apiKey?: string | null;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}

/** Minimal client confined to the pinned Sourcery API operation surface. */
export class SourceryClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  /** Resolve the API key and base URL (https only); raise without a key. */
  constructor(options: SourceryClientOptions = {}) {
    const apiKey = options.apiKey || process.env.SOURCERY_API_KEY;
    if (!apiKey) {
      throw new SourceryError("SOURCERY_API_KEY is not configured");
    }
    const resolvedBase = (options.baseUrl || process.env.SOURCERY_API_BASE || API_BASE).replace(
      /\/+$/,
      "",
    );
    if (!resolvedBase.startsWith("https://")) {
      throw new SourceryError(
        `SOURCERY_API_BASE must be an https:// URL; got ${JSON.stringify(resolvedBase)}`,
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = resolvedBase;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Perform one allow-listed API request and return the decoded JSON object. */
  async request(input: RequestInput): Promise<Record<string, unknown>> {
    const method = input.method.trim().toUpperCase();
    ensureAllowed(method, input.path);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let url = `${this.baseUrl}${input.path.startsWith("/api") ? input.path.slice("/api".length) : input.path}`;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (value === null || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        search.append(key, String(item));
      }
    }
    const query = search.toString();
    if (query) url += `?${query}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceryError(`Sourcery request failed: ${message}`);
    }

    const text = await response.text();
    if (response.status >= 400) {
      throw new SourceryError(
        `Sourcery returned HTTP ${response.status}: ${text.slice(0, 2000)}`,
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new SourceryError(
        `Sourcery returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      );
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new SourceryError(
        `Sourcery returned a non-object JSON response (HTTP ${response.status}): ${JSON.stringify(data)?.slice(0, 200) ?? ""}`,
      );
    }
    return data as Record<string, unknown>;
  }

  /** GET the security-issues page matching the given filters. */
  async list_issues(options: ListIssuesOptions = {}): Promise<Record<string, unknown>> {
    return this.request({
      method: "GET",
      path: "/api/v1/security-issues",
      params: withoutNone({
        repository_ids: options.repository_ids,
        issue_types: options.issue_types,
        statuses: options.statuses,
        search: options.search,
        cursor: options.cursor,
        limit: checkedLimit(options.limit),
      }),
    });
  }

  /** GET one security issue by id. */
  async get_issue(issue_id: number): Promise<Record<string, unknown>> {
    return this.request({
      method: "GET",
      path: `/api/v1/security-issues/${checkedId(issue_id)}`,
    });
  }

  /** GET aggregate issue counts by status and severity. */
  async issue_stats(
    options: Pick<ListIssuesOptions, "repository_ids" | "issue_types"> = {},
  ): Promise<Record<string, unknown>> {
    return this.request({
      method: "GET",
      path: "/api/v1/security-issues/stats",
      params: withoutNone({
        repository_ids: options.repository_ids,
        issue_types: options.issue_types,
      }),
    });
  }

  /** PATCH a status/severity change onto up to 100 issues. */
  async bulk_update_issues(options: BulkUpdateOptions): Promise<Record<string, unknown>> {
    const { ids, reason, ...changes } = options;
    validateBulkUpdate(changes);
    return this.request({
      method: "PATCH",
      path: "/api/v1/security-issues",
      body: withoutNone({
        ids: checkedIds(ids),
        status: changes.status,
        snoozed_until: changes.snoozed_until,
        severity_override: changes.severity_override,
        reason,
      }),
    });
  }

  /** GET the security-issue-groups page matching the given filters. */
  async list_groups(options: ListIssuesOptions = {}): Promise<Record<string, unknown>> {
    return this.request({
      method: "GET",
      path: "/api/v1/security-issue-groups",
      params: withoutNone({
        repository_ids: options.repository_ids,
        issue_types: options.issue_types,
        statuses: options.statuses,
        search: options.search,
        cursor: options.cursor,
        limit: checkedLimit(options.limit),
      }),
    });
  }

  /** GET one issue group (with its issues) by id. */
  async get_group(group_id: number): Promise<Record<string, unknown>> {
    return this.request({
      method: "GET",
      path: `/api/v1/security-issue-groups/${checkedId(group_id)}`,
    });
  }

  /** GET aggregate group counts by status and severity. */
  async group_stats(
    options: Pick<ListIssuesOptions, "repository_ids" | "issue_types"> = {},
  ): Promise<Record<string, unknown>> {
    return this.request({
      method: "GET",
      path: "/api/v1/security-issue-groups/stats",
      params: withoutNone({
        repository_ids: options.repository_ids,
        issue_types: options.issue_types,
      }),
    });
  }

  /** PATCH a status/severity change onto up to 100 groups. */
  async bulk_update_groups(options: BulkUpdateOptions): Promise<Record<string, unknown>> {
    const { ids, reason, ...changes } = options;
    validateBulkUpdate(changes);
    return this.request({
      method: "PATCH",
      path: "/api/v1/security-issue-groups",
      body: withoutNone({
        ids: checkedIds(ids),
        status: changes.status,
        snoozed_until: changes.snoozed_until,
        severity_override: changes.severity_override,
        reason,
      }),
    });
  }
}
