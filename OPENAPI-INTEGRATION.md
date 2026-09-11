# The pinned Sourcery OpenAPI snapshot

Status: **wired.** The bundle is generated against the live Sourcery OpenAPI document, committed in this repo:

- Snapshot: `openapi/sourcery-openapi.json`
- Source: `https://api.sourcery.ai/api/openapi.json`
- Info: `Sourcery API 0.1.0 (OpenAPI 3.1.0)`
- Fetched: 2026-09-10
- SHA-256: `9fdb45e657a6406c86ea0d0def2963d534e20bec1a9c88f7d62dbc2e6807f877`

## Verified operations → tools

| OpenAPI operation | MCP tool |
|---|---|
| `GET /v1/security-issues` | `sourcery_list_findings`, `sourcery_security_snapshot` |
| `GET /v1/security-issues/stats` | `sourcery_get_security_counts` |
| `GET /v1/security-issues/{id}` | `sourcery_get_finding` |
| `PATCH /v1/security-issues` | `sourcery_bulk_update_findings` |
| `GET /v1/security-issue-groups` | `sourcery_list_groups` |
| `GET /v1/security-issue-groups/stats` | `sourcery_get_group_counts` |
| `GET /v1/security-issue-groups/{id}` | `sourcery_get_group` |
| `PATCH /v1/security-issue-groups` | `sourcery_bulk_update_groups` |

`sourcery_api_request` remains as a compatibility bridge, but only these eight operations are permitted. Enforcement lives in `sourcery_client.ensure_allowed` (transport layer) and is covered by `tests/test_sourcery_bundle.py` (CI layer).

## Refreshing the snapshot

```bash
curl -sS --fail -o openapi/sourcery-openapi.json https://api.sourcery.ai/api/openapi.json
shasum -a 256 openapi/sourcery-openapi.json
```

Then update `SPEC_SHA256` / `SPEC_FETCHED` in `src/sourcery_agent/constants.py` plus the hash in `README.md`. Run `pytest` — the allow-list tests fail on any drift between the spec surface and the code.

## Git provider workflow tools (not Sourcery REST)

Sourcery's PR review controls are GitHub/GitLab comment or label commands; they have no public REST endpoints. Implement these through your Git provider connector:

- `sourcery_review_pr`
- `sourcery_summary_pr`
- `sourcery_resolve_review_comments`
- `sourcery_dismiss_review`
- `sourcery_create_issue_from_review`
