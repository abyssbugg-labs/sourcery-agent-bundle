/**
 * Facts pinned from Sourcery's live OpenAPI document.
 *
 * Everything here was verified against the snapshot committed at
 * `openapi/sourcery-openapi.json` (fetched 2026-09-10):
 *
 *     source   https://api.sourcery.ai/api/openapi.json
 *     info     Sourcery API 0.1.0 (OpenAPI 3.1.0)
 *     sha256   9fdb45e657a6406c86ea0d0def2963d534e20bec1a9c88f7d62dbc2e6807f877
 *
 * To refresh, re-download the spec and update the SHA-256 here at the same
 * time; the drift test in `tests/constants.spec.ts` fails on mismatch.
 */

export const API_BASE = "https://api.sourcery.ai/api";
export const OPENAPI_URL = "https://api.sourcery.ai/api/openapi.json";
export const SPEC_INFO = "Sourcery API 0.1.0 (OpenAPI 3.1.0)";
export const SPEC_SNAPSHOT_PATH = "openapi/sourcery-openapi.json";
export const SPEC_SHA256 = "9fdb45e657a6406c86ea0d0def2963d534e20bec1a9c88f7d62dbc2e6807f877";
export const SPEC_FETCHED = "2026-09-10";

/** Issue type enum values from the spec. */
export const ISSUE_TYPES = ["SAST", "IAC", "SECRET", "DEPENDENCY", "LICENSE"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const STATUSES = ["ACTIVE", "IGNORED", "SNOOZED", "SOLVED"] as const;
export type Status = (typeof STATUSES)[number];

// `SOLVED` is scanner-owned: issues become SOLVED automatically when a scan
// no longer detects them, so it is not accepted as PATCH input.
export const STATUS_INPUTS = ["ACTIVE", "IGNORED", "SNOOZED"] as const;
export type StatusInput = (typeof STATUS_INPUTS)[number];

export const SEVERITIES = ["NO_RISK", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const BULK_UPDATE_MAX_IDS = 100;

/** Page-size cap for the list endpoints (the spec's `limit` maximum is 100). */
export const LIST_MAX_LIMIT = 100;

/** One operation of the pinned API surface; `{id}` is an integer path parameter. */
export interface VerifiedOperation {
  method: string;
  path: string;
  description: string;
}

/** The exact operations in the pinned document. */
export const VERIFIED_OPERATIONS: readonly VerifiedOperation[] = [
  {
    method: "GET",
    path: "/api/v1/security-issues",
    description: "List security issues (filters + cursor pagination)",
  },
  {
    method: "GET",
    path: "/api/v1/security-issues/stats",
    description: "Aggregate issue counts by status and severity",
  },
  {
    method: "GET",
    path: "/api/v1/security-issues/{id}",
    description: "Fetch a single security issue",
  },
  {
    method: "PATCH",
    path: "/api/v1/security-issues",
    description: "Bulk-update issues (max 100 ids)",
  },
  {
    method: "GET",
    path: "/api/v1/security-issue-groups",
    description: "List security issue groups (filters + cursor pagination)",
  },
  {
    method: "GET",
    path: "/api/v1/security-issue-groups/stats",
    description: "Aggregate group counts by status and severity",
  },
  {
    method: "GET",
    path: "/api/v1/security-issue-groups/{id}",
    description: "Fetch a single issue group with its issues",
  },
  {
    method: "PATCH",
    path: "/api/v1/security-issue-groups",
    description: "Bulk-update groups (max 100 ids)",
  },
];

/**
 * Documented PR review controls — GitHub/GitLab comment or label commands,
 * not public REST endpoints.
 */
export const REVIEW_COMMANDS = [
  "review",
  "summary",
  "guide",
  "title",
  "resolve",
  "dismiss",
  "create issue",
] as const;
