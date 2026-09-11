---
name: sourcery-triage
description: Triage Sourcery security findings. Use when the user asks about security findings, vulnerabilities, CVEs, or what to fix first in a repository, or wants a findings summary for a report, review, or standup.
---

# Sourcery findings triage

Work from the `sourcery` MCP tools (`sourcery_security_snapshot`, `sourcery_list_findings`, `sourcery_get_finding`, `sourcery_get_security_counts`, `sourcery_list_groups`, `sourcery_get_group`, `sourcery_get_group_counts`).

1. Start with `sourcery_security_snapshot` — counts by status/severity plus the first page of active issues. Pass `repository_ids` / `issue_types` when the user scoped the request.
2. Page through with `sourcery_list_findings` (filters: `repository_ids`, `issue_types`, `statuses`, `search`; take `next_cursor` from the response for the next page). Prefer `statuses: ["ACTIVE"]` unless asked otherwise.
3. Drill into the findings that matter: `sourcery_get_finding` for the full record (source snippet, dependency graph, fixed versions) and `sourcery_get_group` for same-rule / same-package groups.
4. Report concisely. For each prioritized finding: id, title, severity, issue type, location (file or package), and the single most useful next action. Order CRITICAL → HIGH → MEDIUM → LOW, and prefer findings that share a fix (same package upgrade) when ordering by effort.
5. Offer to fix the top findings with the `sourcery-remediate` skill.

Notes:

- Enum values — severity: `NO_RISK`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`; issue type: `SAST`, `IAC`, `SECRET`, `DEPENDENCY`, `LICENSE`; status: `ACTIVE`, `IGNORED`, `SNOOZED`, `SOLVED`.
- `SOLVED` is scanner-owned (set automatically when a scan no longer detects the issue) and is rejected as PATCH input; never present it as a manually settable status.
- Bulk updates accept at most 100 ids per call and return `updated_ids` plus per-id `failed` reasons.
- Keep reports useful for a human — no raw JSON dumps.
