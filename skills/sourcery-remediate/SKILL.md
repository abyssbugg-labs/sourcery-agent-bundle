---
name: sourcery-remediate
description: Fix a specific Sourcery security finding in the codebase with a minimal change. Use when the user says to fix or remediate a finding id, asks to remove a vulnerability, or picks an issue from a triage report.
---

# Sourcery finding remediation

1. Fetch the finding with `sourcery_get_finding` (full record: location, source snippet, package data, fixed versions, dependency chain).
2. Build the fix instruction with `sourcery_build_fix_prompt` (pass the finding JSON) and follow it — minimal changes only.
3. Apply the fix according to the issue type:
   - `DEPENDENCY` / `LICENSE`: edit the manifest named in `manifest_file_path` (the flagged `file_path` is only the lockfile detection site) and upgrade `package_name` to a version from `fixed_versions` on the same release track as `package_version`.
   - `SAST` / `IAC` / `SECRET`: change only the flagged lines at `file_path` (cross-check `source_code` against `source_code_line_start`).
4. Verify: run the repository's tests or the build for the touched area. Do not call the fix done before verification passes.
5. Do not try to set `SOLVED` — Sourcery marks findings solved automatically on the next scan that no longer detects them. If triage should act on the finding meanwhile, use `sourcery_bulk_update_findings` for status (`ACTIVE` / `IGNORED` / `SNOOZED`), a severity override, or a snooze with `snoozed_until`.
6. Summarize: what changed, which finding id it addresses, and what to watch on the next Sourcery scan.
