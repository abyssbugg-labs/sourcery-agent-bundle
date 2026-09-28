# Sourcery Agent Bundle

A hybrid plugin bundle for agent-driven Sourcery security workflows: an MCP server (12 tools over Sourcery's public security API, pinned OpenAPI snapshot), two Agent Skills, and adapters for Claude Code, Cursor, Codex/ChatGPT, VS Code, Devin, Grok (CLI + Bot), Amp, Hermes, OpenClaw, and Rovo Dev CLI. The server ships as the npm package `@abyssbugg/sourcery` — most hosts just register `npx -y @abyssbugg/sourcery@latest`. See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for per-host install steps.

## What is confirmed

Sourcery's current docs say the **only public API** is a Team-plan REST API for security findings. The documented API base is `https://api.sourcery.ai/api`, and the first documented request is:

```bash
curl https://api.sourcery.ai/api/v1/security-issues \
  -H "Authorization: Bearer $SOURCERY_API_KEY"
```

**Verified and pinned.** The live OpenAPI document (`https://api.sourcery.ai/api/openapi.json`) is committed as a snapshot at `openapi/sourcery-openapi.json`:

- Info: `Sourcery API 0.1.0 (OpenAPI 3.1.0)`
- Fetched: 2026-09-10
- SHA-256: `9fdb45e657a6406c86ea0d0def2963d534e20bec1a9c88f7d62dbc2e6807f877`

Every tool and the client allow-list are wired from that snapshot. The verified surface is exactly eight operations:

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/security-issues` | List issues (filters + cursor pagination) |
| GET | `/v1/security-issues/stats` | Counts by status and severity |
| GET | `/v1/security-issues/{id}` | Fetch one issue |
| PATCH | `/v1/security-issues` | Bulk update (max 100 ids) |
| GET | `/v1/security-issue-groups` | List groups (same filters) |
| GET | `/v1/security-issue-groups/stats` | Counts by status and severity |
| GET | `/v1/security-issue-groups/{id}` | Fetch one group including its issues |
| PATCH | `/v1/security-issue-groups` | Bulk update groups (max 100 ids) |

## Why the Sourcery API + Git connector split

Sourcery's PR review controls are currently documented as GitHub/GitLab comment or label commands (`review`, `summary`, `guide`, `title`, `resolve`, `dismiss`, `create issue`) rather than public REST endpoints. Those actions are therefore best implemented through your GitHub/GitLab connector, while Sourcery is used for security findings.

## Bundle shape

Repo root = plugin root. The portable core (`plugin.json` + `skills/` + `mcp.json`) follows the [Agent Plugins 1.0.0](https://agent-plugins.org/specification) standard, which Cursor and OpenAI (Codex, ChatGPT desktop) load natively; the other files are thin per-host adapters.

```text
sourcery-agent-bundle/
  plugin.json                      # Agent Plugins core manifest
  mcp.json                         # portable stdio wiring -> bin/sourcery
  skills/
    sourcery-triage/SKILL.md       # findings triage workflow
    sourcery-remediate/SKILL.md    # minimal-change fix workflow
  bin/
    sourcery                       # launcher: dist/cli.js when built, else npx @abyssbugg/sourcery
  agents/
    sourcery-triager.md            # read-only triage sub-agent (Claude format)
  .claude-plugin/plugin.json       # Claude Code manifest + userConfig API key
  .mcp.json                        # Claude Code MCP wiring (npx)
  .agents/plugins/marketplace.json # Codex/ChatGPT local marketplace entry
  scripts/
    install-rovodev.sh             # Rovo Dev CLI wiring (mcp.json + skills)
    install-local-hosts.sh         # grok, amp, hermes, openclaw, VS Code, Devin
  examples/
    mcp.http.json                  # remote deployment template
    hooks/                         # optional hooks example (SessionStart echo; not enabled)
  docs/
    COMPATIBILITY.md               # per-host setup matrix
    grok-bot-skill.md              # paste-in skill for Grok Bot
  openapi/
    sourcery-openapi.json          # pinned spec snapshot (SHA-256 above)
  src/                             # TypeScript: MCP server + findings CLI (@abyssbugg/sourcery)
    constants.ts                   # pinned facts: operations, enums, spec hash
  tests/                           # TypeScript tests (constants drift pin, tools, client)
  python/                          # Python reference implementation (server, client, prompts)
    src/sourcery_agent/
    tests/
  package.json                     # npm package manifest (@abyssbugg/sourcery)
  .env.example
  README.md
```

## Tools

- `sourcery_security_snapshot`: counts by status/severity plus the first page of active issues — start here for a triage overview.
- `sourcery_list_findings`: list issues with `repository_ids`, `issue_types`, `statuses`, `search`, `limit`, `cursor`.
- `sourcery_get_finding`: fetch one issue (full record incl. source snippet and dependency graph).
- `sourcery_get_security_counts`: aggregate counts by status and severity.
- `sourcery_bulk_update_findings`: bulk status/severity changes (≤100 ids; `SOLVED` is scanner-owned and rejected).
- `sourcery_list_groups`, `sourcery_get_group`, `sourcery_get_group_counts`, `sourcery_bulk_update_groups`: the same capabilities for issue groups.
- `sourcery_build_fix_prompt`: builds the Sourcery-style minimal-change agent prompt from a finding; the DEPENDENCY path uses `fixed_versions` + `manifest_file_path` and renders the dependency chain.
- `sourcery_capabilities`: describes the verified surface, spec pin, and enum values.
- `sourcery_api_request`: compatibility bridge restricted to the eight verified operations.

## CLI

```bash
npx -y @abyssbugg/sourcery@latest snapshot                          # counts + first page of active findings
npx -y @abyssbugg/sourcery@latest list --status ACTIVE --limit 50   # filterable list
npx -y @abyssbugg/sourcery@latest get 1234                          # one finding in full
npx -y @abyssbugg/sourcery@latest fix-prompt 1234                   # minimal-change agent prompt
```

Inside an enabled plugin host, `bin/sourcery` runs the same CLI (it prefers a locally built `dist/cli.js` and otherwise falls back to npx). Add `--json` to any query command for scripting.

## Setup

Requirements: Node 20+. Most hosts register the MCP server directly:

```bash
export SOURCERY_API_KEY='...'
npx -y @abyssbugg/sourcery@latest        # stdio MCP server (no args)
npx -y @abyssbugg/sourcery@latest http   # Streamable HTTP (127.0.0.1:8765/mcp)
```

Or install it as a plugin bundle — one step per host (details in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)):

| Host | Quick start |
|---|---|
| Claude Code | `claude --plugin-dir .` — prompts for the API key on enable |
| Cursor | symlink the repo into `~/.cursor/plugins/local/`, reload |
| Codex CLI / ChatGPT desktop | `codex plugin marketplace add ./` |
| ChatGPT web | run `npx -y @abyssbugg/sourcery@latest http` behind HTTPS, add via developer mode |
| VS Code / Grok / Amp / Hermes / OpenClaw | `scripts/install-local-hosts.sh` (idempotent; registers plugin, MCP, and skills) |
| Devin | skill links via the installer; `devin plugins install --local .` for the full plugin |
| Grok Bot | paste-in skill from `docs/grok-bot-skill.md` |
| Rovo Dev CLI | `scripts/install-rovodev.sh` |

For development and tests, see the [Python reference implementation](python/) (its suite doubles as the bundle-packaging checker) and run `npm test` for the TypeScript suite. The server is built on the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`).

## Regenerating the pinned snapshot

When Sourcery publishes a spec change:

```bash
curl -sS --fail -o openapi/sourcery-openapi.json https://api.sourcery.ai/api/openapi.json
shasum -a 256 openapi/sourcery-openapi.json   # update SPEC_SHA256 in src/constants.ts (+ python/src/sourcery_agent/constants.py, README/docs)
npm test                                      # tests/constants.spec.ts fails on drift
```

Sourcery's PR review commands (review, summary, guide, title, resolve, dismiss, create issue) remain GitHub/GitLab comment or label commands — implement those through your Git provider connector, not the Sourcery REST API.
