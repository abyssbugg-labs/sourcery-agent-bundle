# Using this bundle with AI coding agents

This repository is a **hybrid plugin bundle**: one portable core plus per-host adapters.

- **Core** — [Agent Plugins 1.0.0](https://agent-plugins.org/specification): `plugin.json`, `skills/`, `mcp.json`. Cursor and OpenAI (Codex CLI, ChatGPT desktop) load this format natively.
- **Adapters** — `.claude-plugin/plugin.json` + `.mcp.json` for Claude Code; `.agents/plugins/marketplace.json` for Codex/ChatGPT local installs; `scripts/install-rovodev.sh` for the Rovo Dev CLI.
- **Server** — 12 MCP tools over Sourcery's public security API (pinned OpenAPI snapshot in `openapi/`). **Skills** — `sourcery-triage`, `sourcery-remediate`.

| Host | Loads | MCP transport |
|---|---|---|
| Claude Code | `.claude-plugin/` + shared `skills/` | stdio (`.mcp.json`) |
| Cursor | core | stdio (`mcp.json`) |
| Codex CLI + ChatGPT desktop | core | stdio (`mcp.json`) |
| ChatGPT web | remote only | Streamable HTTP |
| VS Code (GitHub Copilot) | core (native Agent Plugins) | plugin `mcp.json`; `chat.pluginLocations` |
| Devin (CLI + Desktop) | Claude-format or core via `devin plugins install`; skills dirs | plugin `.mcp.json` / `devin mcp add` |
| Grok Build CLI (`grok`) | Claude-compatible: reads Claude plugins/skills/MCPs; `~/.grok/skills` | `grok mcp add` / plugin MCPs |
| Amp (`amp`) | skills via `amp skill add`; also reads Claude skill paths | `amp mcp add` (`amp.mcpServers`) |
| Hermes (`hermes`) | `~/.hermes/skills` | `hermes mcp add` |
| Grok Bot | hosted conversational skills + curated plugin directory | desktop MCP box (app-managed) |
| OpenClaw (`openclaw`) | bundles: ours loads as a Claude bundle (skills + `mcpServers`) | bundle `.mcp.json` / `openclaw mcp add` |
| Rovo Dev CLI (`acli rovodev`) | `~/.rovodev/` | stdio (`~/.rovodev/mcp.json`) |
| Any other MCP host | whatever you wire | stdio: `bin/run-server` |

One-shot local wiring for the installed CLIs: `scripts/install-local-hosts.sh` (idempotent; covers grok, amp, hermes, openclaw, VS Code, and Devin skill links). Rovo Dev has its own: `scripts/install-rovodev.sh`.

## The API key

No file in this repository carries the key.

| Host | How the key reaches the server |
|---|---|
| Claude Code | enable prompt (`userConfig`, `sensitive` → OS keychain) |
| Codex CLI | export `SOURCERY_API_KEY` in the environment that launches Codex |
| ChatGPT web | held by the hosted server |
| Cursor / Rovo Dev / Grok / Amp / Hermes / OpenClaw / VS Code / Devin / generic | `SOURCERY_API_KEY` in the launching environment, or the key file (see below) |

On first launch the launcher creates a venv and installs the package into the host-provided data directory (`${PLUGIN_DATA}` or `${CLAUDE_PLUGIN_DATA}`, fallback `~/.local/share/sourcery-agent`). Later launches reuse it; it reinstalls automatically when `pyproject.toml` or `src/` change. All bootstrap logs go to stderr; stdout stays clean for the MCP protocol.

## Claude Code

```bash
claude --plugin-dir .
claude plugin validate .        # schema + component check
```

The enable flow prompts for the Sourcery API key. Skills appear as `/sourcery-agent:sourcery-triage` and `/sourcery-agent:sourcery-remediate`. For distribution to others, add a `.claude-plugin/marketplace.json` and publish through the plugin marketplace flow.

## Cursor

```bash
ln -s "$PWD" ~/.cursor/plugins/local/sourcery-agent
```

Reload the window, then check **Customize** for the plugin, its skills, and the MCP server. On Teams/Enterprise plans, admins must allow local plugin imports. Cursor loads the portable core directly — no Cursor-specific files are required.

## Codex CLI + ChatGPT desktop

A repo-scoped marketplace is included at `.agents/plugins/marketplace.json` (the plugin root is the repo root):

```bash
codex plugin marketplace add ./
codex plugin list
```

Alternatively point a personal marketplace (`~/.agents/plugins/marketplace.json`) at this repo. Plugin-scoped toggles live under `[plugins."sourcery-agent@…"]` in Codex `config.toml`. Set `SOURCERY_API_KEY` in the shell that launches Codex.

## ChatGPT (web)

ChatGPT cannot launch local stdio servers — it needs a reachable HTTPS MCP endpoint:

```bash
SOURCERY_API_KEY=... bin/run-http        # Streamable HTTP, default 127.0.0.1:8765/mcp
```

1. Expose the endpoint over HTTPS (tunnel or your own host).
2. Open **Workspace settings** in ChatGPT and enable **Developer mode** (requires an eligible Business, Enterprise, or Edu workspace).
3. **Settings → Apps → Create** to register the app with your MCP URL (streaming HTTP is supported).
4. Tools appear under **Developer mode** in the composer; write actions require confirmation.

Security: `bin/run-http` binds loopback by default and **refuses non-loopback hosts** unless both `SOURCERY_MCP_ALLOW_REMOTE=1` and a non-empty `SOURCERY_MCP_AUTH_TOKEN` are set; the transport itself does not terminate request auth, so a fronting proxy must require that bearer token. Public-directory submission additionally requires a public HTTPS endpoint and OAuth when the server accesses private data. `examples/mcp.http.json` is a template for the remote variant.

## Rovo Dev CLI (`acli rovodev`)

```bash
scripts/install-rovodev.sh
```

The script backs up and updates `~/.rovodev/mcp.json` with a `sourcery` server entry and links the skills into `~/.rovodev/skills/`. Review with `acli rovodev mcp`, then restart Rovo Dev. Set `SOURCERY_API_KEY` in your shell profile so the CLI inherits it.

## VS Code (GitHub Copilot)

VS Code loads the portable core natively (Agent Plugins 1.0). The installer registers it via `chat.pluginLocations` — it resolves the platform settings path (macOS/Linux/Windows, or set `VSCODE_USER_DIR` to override) and backs the file up before editing. Reload the window, then check the Agent Plugins view (search `@agentPlugins` in the Extensions view). Alternatives: **Chat: Install Plugin From Source** with a Git URL once this repo is pushed, or add the repo to `chat.plugins.marketplaces`.

## Devin

- Skills: linked into `~/.config/devin/skills` and `~/.devin/skills` by the installer (created as needed; same `SKILL.md` format).
- Full plugin (CLI): `devin plugins install --local "<repo>"` — Claude-format plugins are honored (`.mcp.json` + `${CLAUDE_PLUGIN_ROOT}` supported). `--local` keeps it off your Devin Cloud personal plugins.
- Direct MCP: `devin mcp add sourcery --command "<repo>/bin/run-server"`.

## Grok Build CLI (`grok`)

Grok reads Claude Code plugins, marketplaces, skills, and MCPs with zero configuration, so the Claude-format adapter works as-is. The installer also registers the server directly:

```bash
grok mcp add sourcery --scope user -- "<repo>/bin/run-server"
```

Skills are linked into `~/.grok/skills/`. Config lives in `~/.grok/config.toml` (`[mcp_servers.sourcery]`); `${VAR}` expands from the environment.

## Amp (`amp`)

```bash
amp mcp add sourcery -- "<repo>/bin/run-server"            # -> amp.mcpServers in ~/.config/amp/settings.json
amp skill add --global "<repo>/skills/sourcery-triage"     # -> ~/.config/agents/skills/
amp skill add --global "<repo>/skills/sourcery-remediate"
```

Amp also reads skills from `.claude/skills/`, `~/.claude/skills/`, and `~/.claude/plugins/cache/`. For orb threads, prefer skills with a skill-local `mcp.json` (Amp format) if you need the tools hidden until the skill loads.

## Hermes (`hermes`)

```bash
hermes mcp add sourcery --command "<repo>/bin/run-server"
```

`hermes mcp list` verifies the connection (install-time discovery enumerates all 12 tools). Skills are linked into `~/.hermes/skills/`. Native Hermes plugins are Python packages (`plugin.yaml` + code) — use MCP + skills instead.

## OpenClaw (`openclaw`)

OpenClaw loads bundles; this repo is detected as a Claude bundle (the `.claude-plugin` marker wins over the root `plugin.json`) with capabilities **skills + mcpServers**:

```bash
openclaw plugins install --link "<repo>"   # linked, not copied (live edits)
openclaw plugins inspect sourcery-agent    # Format: bundle / Bundle format: claude
openclaw gateway restart                   # then load it in sessions
```

Direct-MCP alternative: `openclaw mcp add` or embedded settings (`mcp.servers`, `${ENV_VAR}` supported in headers).

## Grok Bot

Hosted product: skills are conversational (**Settings → Plugins → Yours**, enabled per Bot) and public plugins come from a curated directory. Use [`docs/grok-bot-skill.md`](grok-bot-skill.md) — paste-in skill text for triage and remediation. The desktop app's MCP box (`mcpBoxServers` in `~/.grokbot/settings.json`) is app-managed.

## API key file (host-agnostic)

Hosts that don't expand `${user_config.*}` can use a key file instead:

```bash
mkdir -p ~/.local/share/sourcery-agent
printf '%s' 'YOUR_KEY' > ~/.local/share/sourcery-agent/sourcery_api_key
chmod 600 ~/.local/share/sourcery-agent/sourcery_api_key
```

The launcher reads it when `SOURCERY_API_KEY` is unset (or is an unexpanded `${…}` reference). Override the location with `PLUGIN_DATA` or `SOURCERY_API_KEY_FILE`.

## Any other MCP host (generic)

Register a stdio server whose command is the launcher:

```text
command: /absolute/path/to/sourcery-agent-bundle/bin/run-server
```

The launcher is host-agnostic: it derives the plugin root from its own path and needs only `PLUGIN_DATA` (optional) and `SOURCERY_API_KEY` from the environment.

## CLI, sub-agent, and the hooks example

- **CLI** — `sourcery-agent snapshot|list|get|counts|fix-prompt` (add `--json` for scripting). Works standalone (console script after `pip install`) or via `bin/sourcery-agent` in any plugin host; on Claude-style hosts `bin/` is on PATH while the plugin is enabled. Key resolution: `SOURCERY_API_KEY`, else the key file below.
- **Sub-agent** — `agents/sourcery-triager.md`: a read-only triage persona (Write/Edit disallowed) for Claude Code and other Claude-format readers; produces the prioritized report and fix plan without touching code.
- **Hooks** — **enabled** for Claude Code via `hooks/hooks.json`: a `SessionStart` prewarm (`bin/prewarm`) installs the venv/dependencies once so the first Sourcery tool call in a session is fast. Source example and rationale kept at `examples/hooks/claude-hooks.json`: findings refresh on Sourcery's scan cadence, not per local edit, so a "check findings after each edit" hook would be noise. Other hosts: VS Code Agent Plugins packages read `com.github.copilot/hooks/hooks.json`; OpenClaw detects Claude hooks but does not execute them.

## Troubleshooting

- **First call is slow** — one-time venv + dependency install; later launches are fast.
- **`SOURCERY_API_KEY is not set` on stderr** — the server still starts; Sourcery tools return configuration errors until the key is set.
- **No tools in the host** — verify the host loaded `mcp.json` / `.mcp.json`, and that `bin/run-server` is executable.
