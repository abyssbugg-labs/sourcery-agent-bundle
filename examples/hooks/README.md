# Hooks example (not enabled)

This folder keeps a source example and rationale. Nothing ships enabled: the
old `hooks/hooks.json` SessionStart prewarm (which warmed the Python venv) was
removed when the server moved to the published npm package — `npx` fetches and
caches `@abyssbugg/sourcery` on first run with no warm-up hook needed.

## What the example does

`SessionStart` → an `echo` hint on stderr, reminding you to pull a
`sourcery snapshot` when a session starts. It performs no work and is safe to
copy into `hooks/hooks.json` (Claude format) as a starting point for your own
hooks.

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
