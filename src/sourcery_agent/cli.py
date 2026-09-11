"""User-facing CLI for Sourcery findings.

Wraps the typed client in ``sourcery_client`` so findings can be queried from a
terminal, scripts, or CI without an agent host. Key resolution mirrors the MCP
launcher: ``SOURCERY_API_KEY`` (environment), or a key file at
``PLUGIN_DATA/sourcery_api_key`` (fallback ``~/.local/share/sourcery-agent/sourcery_api_key``).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from . import constants
from .prompts import build_fix_prompt
from .sourcery_client import SourceryClient, SourceryError

_SEVERITY_RANK = {name: rank for rank, name in enumerate(constants.SEVERITIES)}


def usable_key(value: str | None) -> bool:
    """True when an env value is a real key (not empty or an unexpanded reference)."""
    return bool(value) and "${" not in value


def _load_key() -> None:
    if usable_key(os.getenv("SOURCERY_API_KEY")):
        return
    os.environ.pop("SOURCERY_API_KEY", None)

    data_dir = (
        os.getenv("PLUGIN_DATA")
        or os.getenv("CLAUDE_PLUGIN_DATA")
        or os.path.expanduser("~/.local/share/sourcery-agent")
    )
    key_file = Path(os.getenv("SOURCERY_API_KEY_FILE") or os.path.join(data_dir, "sourcery_api_key"))
    if key_file.is_file():
        key = key_file.read_text().strip()
        if key:
            os.environ["SOURCERY_API_KEY"] = key


def format_finding_row(finding: dict[str, Any]) -> str:
    finding_id = str(finding.get("id", "?"))
    severity = str(finding.get("severity", "?"))
    issue_type = str(finding.get("issue_type", "?"))
    status = str(finding.get("status", "?"))
    location = str(finding.get("file_path") or "")
    if not location and finding.get("package_name"):
        version = f"@{finding['package_version']}" if finding.get("package_version") else ""
        location = f"{finding['package_name']}{version}"
    if len(location) > 34:
        location = "..." + location[-31:]
    title = str(finding.get("title") or "").strip()
    if len(title) > 60:
        title = title[:57] + "..."
    return f"{finding_id:>7}  {severity:<8}  {issue_type:<10}  {status:<8}  {location:<34}  {title}"


def _print_findings(items: list[dict[str, Any]]) -> None:
    print(f"{'ID':>7}  {'SEVERITY':<8}  {'TYPE':<10}  {'STATUS':<8}  {'LOCATION':<34}  TITLE")
    ordered = sorted(items, key=lambda f: -_SEVERITY_RANK.get(f.get("severity"), -1))
    for finding in ordered:
        print(format_finding_row(finding))


def _print_stats(stats: dict[str, Any]) -> None:
    print(
        f"total={stats.get('total_count')} active={stats.get('active_count')} "
        f"snoozed={stats.get('snoozed_count')} ignored={stats.get('ignored_count')} "
        f"solved={stats.get('solved_count')}"
    )
    print(
        f"active severity: critical={stats.get('critical_count')} high={stats.get('high_count')} "
        f"medium={stats.get('medium_count')} low={stats.get('low_count')}"
    )


def cmd_snapshot(args: argparse.Namespace) -> int:
    client = SourceryClient()
    counts = client.issue_stats(repository_ids=args.repo_id, issue_types=args.type)
    page = client.list_issues(
        repository_ids=args.repo_id, issue_types=args.type, statuses=["ACTIVE"], limit=args.limit
    )
    if args.json:
        print(json.dumps({"counts": counts, "active_issues": page}, indent=2))
        return 0
    _print_stats(counts)
    active = page.get("data", [])
    print(f"\nActive findings ({len(active)} shown):")
    _print_findings(active)
    if page.get("has_more"):
        print(f"more available - next cursor: {page.get('next_cursor')}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    page = SourceryClient().list_issues(
        repository_ids=args.repo_id,
        issue_types=args.type,
        statuses=args.status,
        search=args.search,
        cursor=args.cursor,
        limit=args.limit,
    )
    if args.json:
        print(json.dumps(page, indent=2))
        return 0
    _print_findings(page.get("data", []))
    if page.get("has_more"):
        print(f"more available - pass --cursor {page.get('next_cursor')}")
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    finding = SourceryClient().get_issue(args.id)
    if args.json:
        print(json.dumps(finding, indent=2))
        return 0
    print(f"#{finding.get('id')}  {finding.get('title')}")
    print(
        f"severity={finding.get('severity')} status={finding.get('status')} "
        f"type={finding.get('issue_type')} rule={finding.get('rule_id')}"
    )
    if finding.get("file_path"):
        suffix = f":{finding['line_start']}" if finding.get("line_start") else ""
        if finding.get("line_end") and finding["line_end"] != finding.get("line_start"):
            suffix = f":{finding['line_start']}-{finding['line_end']}"
        print(f"location: {finding['file_path']}{suffix}")
    if finding.get("package_name"):
        print(
            f"package: {finding['package_name']}@{finding.get('package_version')} "
            f"fixed versions: {finding.get('fixed_versions')}"
        )
    if finding.get("manifest_file_path"):
        print(f"manifest to edit: {finding['manifest_file_path']}")
    if finding.get("documentation_url"):
        print(f"docs: {finding['documentation_url']}")
    description = (finding.get("description") or "").strip()
    if description:
        print(f"\n{description}")
    return 0


def cmd_counts(args: argparse.Namespace) -> int:
    stats = SourceryClient().issue_stats(repository_ids=args.repo_id, issue_types=args.type)
    if args.json:
        print(json.dumps(stats, indent=2))
        return 0
    _print_stats(stats)
    return 0


def cmd_fix_prompt(args: argparse.Namespace) -> int:
    finding = SourceryClient().get_issue(args.id)
    print(build_fix_prompt(finding))
    return 0


def _add_filters(
    parser: argparse.ArgumentParser, *, statuses: bool = False, search: bool = False, cursor: bool = False
) -> None:
    parser.add_argument(
        "--repo-id", dest="repo_id", type=int, action="append", metavar="N",
        help="filter by repository id (repeatable)",
    )
    parser.add_argument(
        "--type", dest="type", action="append", choices=constants.ISSUE_TYPES, metavar="TYPE",
        help="filter by issue type (repeatable)",
    )
    if statuses:
        parser.add_argument(
            "--status", dest="status", action="append", choices=constants.STATUSES, metavar="STATUS",
            help="filter by status (repeatable)",
        )
    if search:
        parser.add_argument("--search", help="substring match on title / file / package")
    if cursor:
        parser.add_argument("--cursor", help="pagination cursor from a previous next_cursor")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sourcery-agent", description="Query Sourcery security findings from the terminal."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("snapshot", help="counts by status/severity plus the first page of active findings")
    _add_filters(p)
    p.add_argument("--limit", type=int, default=25)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_snapshot)

    p = sub.add_parser("list", help="list findings with filters")
    _add_filters(p, statuses=True, search=True, cursor=True)
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("get", help="show one finding")
    p.add_argument("id", type=int)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("counts", help="aggregate counts by status and severity")
    _add_filters(p)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_counts)

    p = sub.add_parser("fix-prompt", help="print the minimal-change fix prompt for one finding")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_fix_prompt)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        _load_key()
        return args.func(args)
    except (SourceryError, ValueError, OSError) as exc:
        print(f"sourcery-agent: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
