# Hooks example (an enabled copy lives at `hooks/hooks.json`)

This folder keeps the source example and rationale. An enabled copy ships at
`hooks/hooks.json`, so Claude Code runs the `SessionStart` prewarm from the repo
as-is. To disable: delete `hooks/hooks.json` (this example stays here).

## What the example does

`SessionStart` → `bin/prewarm`: creates the plugin venv and installs dependencies
up front, so the first Sourcery tool call in a session is fast. Later sessions
are already warm and nearly instant. Trade-off: on very first use, session start
blocks for ~10–40 seconds while installing.

## What it deliberately does *not* do

A `PostToolUse` hook that "checks Sourcery findings after edits" is a poor fit
for Sourcery's model: findings refresh on Sourcery's own scan cadence
(server-side, after a push), not per local edit — the hook would spend a
network call per edit for data that rarely changes. If you want an in-session
signal, prefer asking for a `sourcery snapshot` on demand or a `Stop`-hook
reminder you control.

## Other hosts

- VS Code reads hooks for Agent Plugins packages from `com.github.copilot/hooks/hooks.json`
  (Claude-format plugins use `hooks/hooks.json`).
- OpenClaw detects Claude `hooks/hooks.json` but does not execute it; its runnable
  hook layout is a hook pack (`HOOK.md` + handler).
- Codex runs command hooks from `hooks/hooks.json` but they require trust review;
  adapt before relying on them.
