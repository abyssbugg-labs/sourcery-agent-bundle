"""Build minimal-change agent prompts from Sourcery security findings.

Field names follow ``SecurityIssueResponse`` from the pinned OpenAPI snapshot
(``openapi/sourcery-openapi.json``). Legacy key names used by Sourcery's
UI "copy prompt" flow (``risk``, ``cause``, ``recommended_fix``, ``fix_impact``)
are still honoured when present, so UI exports render too.
"""

from __future__ import annotations

from typing import Any


def _render_location(finding: dict[str, Any]) -> str | None:
    file_path = finding.get("file_path")
    if not file_path:
        return None
    line_start = finding.get("line_start")
    line_end = finding.get("line_end")
    if line_start is None:
        return str(file_path)
    if line_end and line_end != line_start:
        return f"{file_path}:{line_start}-{line_end}"
    return f"{file_path}:{line_start}"


def _render_source_snippet(finding: dict[str, Any]) -> str | None:
    source_code = finding.get("source_code")
    if not source_code:
        return None
    line_start = finding.get("source_code_line_start") or finding.get("line_start")
    header = f"(snippet from line {line_start})" if line_start else "(snippet)"
    return f"{header}\n```\n{source_code}\n```"


def _render_dependency_chain(finding: dict[str, Any]) -> str | None:
    graph = finding.get("dependency_graph")
    if not isinstance(graph, dict):
        return None
    nodes = {node["name"]: node for node in graph.get("nodes", []) if node.get("name")}
    if not nodes:
        return None

    children: dict[str, list[str]] = {}
    for edge in graph.get("edges", []):
        children.setdefault(edge["from_package"], []).append(edge["to_package"])

    def label(name: str) -> str:
        node = nodes.get(name, {})
        version = f"@{node['version']}" if node.get("version") else ""
        tags = [tag for tag in (node.get("relationship"), "dev" if node.get("dev") else None) if tag]
        suffix = f" [{', '.join(tags)}]" if tags else ""
        return f"{name}{version}{suffix}"

    vulnerable = {name for name, node in nodes.items() if node.get("vulnerable")}
    roots = [name for name, node in nodes.items() if node.get("relationship") == "root"] or list(nodes)
    paths: list[str] = []

    def walk(name: str, trail: list[str]) -> None:
        trail = [*trail, name]
        if name in vulnerable:
            paths.append(" -> ".join(label(step) for step in trail))
            return
        for child in children.get(name, []):
            if child not in trail:
                walk(child, trail)

    for root in roots:
        walk(root, [])
    unique = list(dict.fromkeys(paths))
    if not unique:
        return None
    return "\n".join(f"- {path}" for path in unique[:10])


def _render_fix(finding: dict[str, Any]) -> str:
    explicit = finding.get("recommended_fix") or finding.get("fix")
    if explicit:
        return str(explicit)

    issue_type = finding.get("issue_type")
    if issue_type == "LICENSE":
        package = finding.get("package_name") or "the flagged package"
        version = f" from {finding['package_version']}" if finding.get("package_version") else ""
        licenses = finding.get("package_licenses") or []
        terms = ", ".join(str(v) for v in licenses) if licenses else "the detected license terms"
        guidance = (
            f"`{package}`{version} ships under {terms}, which this repository's license policy "
            "does not allow. Replace it with a compatible alternative or remove the dependency; "
            "if the usage is intentional, route the finding for license-policy review instead."
        )
        manifest = finding.get("manifest_file_path") or finding.get("file_path")
        target = f" Edit the manifest `{manifest}`." if manifest else ""
        return guidance + target

    if issue_type == "DEPENDENCY":
        package = finding.get("package_name") or "the flagged package"
        version = f" from {finding['package_version']}" if finding.get("package_version") else ""
        fixed = finding.get("fixed_versions") or []
        if fixed:
            versions = ", ".join(str(v) for v in fixed)
            upgrade = (
                f"Upgrade `{package}`{version} to a fixed version ({versions}); "
                "prefer the release on the same major/minor track as the installed version."
            )
        else:
            upgrade = (
                f"No fixed version is listed for `{package}`; remove or constrain the dependency, "
                "or apply the advisory's mitigation."
            )
        manifest = finding.get("manifest_file_path") or finding.get("file_path")
        target = f" Edit the manifest `{manifest}`." if manifest else ""
        return upgrade + target

    rule = f" (rule `{finding['rule_id']}`)" if finding.get("rule_id") else ""
    location = _render_location(finding)
    where = f" at `{location}`" if location else ""
    kind = issue_type or "security"
    return f"Make the minimal code change{where} that resolves this {kind} finding{rule}."


def build_fix_prompt(finding: dict[str, Any]) -> str:
    title = str(finding.get("title", "")).strip()
    description = finding.get("description") or finding.get("risk") or ""
    cause = finding.get("cause") or ""

    meta = " | ".join(
        f"{label}: {finding[key]}"
        for label, key in (
            ("Type", "issue_type"),
            ("Severity", "severity"),
            ("Status", "status"),
            ("Rule", "rule_id"),
        )
        if finding.get(key)
    )
    issue_body = "\n\n".join(part for part in (meta, title, str(description), str(cause)) if part)

    sections = [f"<issue>\n{issue_body}\n</issue>"]

    locations = []
    location = _render_location(finding)
    if location:
        locations.append(f"- flagged: {location}")
    if finding.get("manifest_file_path"):
        locations.append(f"- fix manifest: {finding['manifest_file_path']}")
    snippet = _render_source_snippet(finding)
    if snippet:
        locations.append(snippet)
    if locations:
        sections.append("<locations>\n" + "\n".join(locations) + "\n</locations>")

    package_lines = []
    if finding.get("package_name"):
        name = str(finding["package_name"])
        if finding.get("package_version"):
            name += f"@{finding['package_version']}"
        if finding.get("package_type"):
            name += f" ({finding['package_type']})"
        package_lines.append(name)
    if finding.get("fixed_versions") and finding.get("issue_type") != "LICENSE":
        package_lines.append("fixed versions: " + ", ".join(str(v) for v in finding["fixed_versions"]))
    if finding.get("package_licenses"):
        package_lines.append("licenses: " + ", ".join(str(v) for v in finding["package_licenses"]))
    if package_lines:
        sections.append("<package>\n" + "\n".join(package_lines) + "\n</package>")

    chain = _render_dependency_chain(finding)
    if chain:
        sections.append("<dependency_path>\n" + chain + "\n</dependency_path>")

    sections.append("<fix>\n" + _render_fix(finding) + "\n</fix>")

    impact = finding.get("fix_impact") or finding.get("impact")
    if impact:
        sections.append(f"<fix_impact>\n{impact}\n</fix_impact>")

    if finding.get("documentation_url"):
        sections.append(f"<documentation_url>\n{finding['documentation_url']}\n</documentation_url>")

    body = "\n\n".join(sections)
    return (
        "Please fix the following security issue:\n\n"
        f"{body}\n\n"
        "Keep the changes minimal - only the code changes necessary to fix this security issue."
    )
