# Grok Bot skill (paste-in)

Grok Bot doesn't load local plugin files: skills are created conversationally and live in your Bot account (**Settings → Plugins → Yours** for private skills, enabled per Bot). Paste the block below into a Grok Bot chat and ask it to save it as a skill. Live data requires a Sourcery connector/login for the Bot; otherwise the bot works from a pasted findings export.

```text
Save two skills.

Skill 1 — "Sourcery findings triage". Use when I ask about security findings,
vulnerabilities, CVEs, or what to fix first.
- Input: optionally a repository or environment qualifier. If Sourcery isn't
  connected, ask me to paste the findings export and continue with that.
- Sequence: (1) summarize open findings by severity and status; (2) pick the
  top findings by severity CRITICAL → HIGH → MEDIUM → LOW, grouping ones that
  share a single fix; (3) for each: id, title, severity, type, location
  (file or package), and the single most useful next action; (4) when I supply
  a previous report, list what is no longer present.
- Validation: never claim a finding is resolved unless a later scan or my
  explicit confirmation says so. Treat "solved" as scanner-owned.
- Return: a short prioritized table plus a 3-line summary.
- Rule: never push code, open PRs, or contact anyone without my approval.

Skill 2 — "Sourcery finding remediation". Use when I pick one finding to fix.
- Restate the minimal change first: dependency/license findings → upgrade the
  package in the manifest (the lockfile is only the detection site) choosing a
  fixed version on the same release track; code findings (SAST/IaC/secret) →
  change only the flagged lines.
- Ask for approval before any write, then list exactly what changed.
- Afterwards, remind me to let the next Sourcery scan confirm the finding is
  solved, and offer to prepare a PR description (not push).
```
