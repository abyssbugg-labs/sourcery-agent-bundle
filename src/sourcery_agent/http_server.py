"""Streamable HTTP entry point for the Sourcery MCP server.

Used by ``bin/run-http`` for remote/self-hosted deployments (for example the
ChatGPT developer-mode app flow), where a local stdio process is not possible.
The stdio path remains ``python -m sourcery_agent.server``.

Security: this transport serves the full tool set — including bulk updates —
with the process's Sourcery API key, so it is loopback-only by default. Remote
mode requires ``SOURCERY_MCP_ALLOW_REMOTE=1`` **and** a non-empty
``SOURCERY_MCP_AUTH_TOKEN``; when a token is configured the MCP SDK's bearer
verifier requires ``Authorization: Bearer <token>`` on every request (terminate
TLS in front — see docs/COMPATIBILITY.md).
"""

from __future__ import annotations

import ipaddress
import os
from urllib.parse import urlparse

from .server import build_server


def is_loopback_host(host: str) -> bool:
    """True when ``host`` cannot be reached from another machine."""
    normalized = host.strip().lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def check_bind_allowed(host: str) -> None:
    """Refuse non-loopback binds unless remote mode and an auth token are configured."""
    if is_loopback_host(host):
        return
    if os.getenv("SOURCERY_MCP_ALLOW_REMOTE", "").strip() != "1":
        raise SystemExit(
            f"refusing to bind SOURCERY_MCP_HOST={host!r}: the HTTP transport exposes "
            "Sourcery findings and bulk updates with this process's API key. Set "
            "SOURCERY_MCP_ALLOW_REMOTE=1 and SOURCERY_MCP_AUTH_TOKEN to enable "
            "authenticated remote mode."
        )
    if not os.getenv("SOURCERY_MCP_AUTH_TOKEN", "").strip():
        raise SystemExit(
            "refusing to bind a non-loopback SOURCERY_MCP_HOST without "
            "SOURCERY_MCP_AUTH_TOKEN; remote mode requires SDK-enforced bearer "
            "authentication on every request."
        )


def resolve_resource_url(host: str, port: int, path: str, configured: str | None) -> str:
    """Return the actual MCP resource URL or reject unsafe remote metadata."""
    if not 1 <= port <= 65535:
        raise SystemExit(f"SOURCERY_MCP_PORT must be between 1 and 65535; got {port}")
    normalized_path = "/" + path.strip().strip("/")
    if configured:
        try:
            parsed = urlparse(configured)
            _ = parsed.port
        except ValueError as exc:
            raise SystemExit(
                "SOURCERY_MCP_RESOURCE_URL contains an invalid authority"
            ) from exc
        allowed_schemes = {"http", "https"} if is_loopback_host(host) else {"https"}
        if (
            parsed.scheme not in allowed_schemes
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            expected = "HTTP(S)" if is_loopback_host(host) else "HTTPS"
            raise SystemExit(
                f"SOURCERY_MCP_RESOURCE_URL must be an absolute {expected} URL "
                "without user information"
            )
        if parsed.query or parsed.fragment:
            raise SystemExit("SOURCERY_MCP_RESOURCE_URL must not contain a query or fragment")
        if parsed.path.rstrip("/") != normalized_path.rstrip("/"):
            raise SystemExit(
                f"SOURCERY_MCP_RESOURCE_URL path must be {normalized_path!r}; got {parsed.path!r}"
            )
        return configured
    if not is_loopback_host(host):
        raise SystemExit(
            f"Remote bind {host}:{port} requires explicit SOURCERY_MCP_RESOURCE_URL "
            f"(e.g., https://mcp.example.com{normalized_path})"
        )
    url_host = f"[{host}]" if ":" in host else host
    return f"http://{url_host}:{port}{normalized_path}"


def main() -> None:
    """Run the Streamable HTTP server with endpoint-matched auth metadata."""
    host = os.getenv("SOURCERY_MCP_HOST", "127.0.0.1")
    raw_port = os.getenv("SOURCERY_MCP_PORT", "8765")
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise SystemExit(f"SOURCERY_MCP_PORT must be an integer; got {raw_port!r}") from exc
    path = "/" + os.getenv("SOURCERY_MCP_PATH", "/mcp").strip().strip("/")
    check_bind_allowed(host)
    auth_token = os.getenv("SOURCERY_MCP_AUTH_TOKEN")
    resource_url = resolve_resource_url(
        host,
        port,
        path,
        os.getenv("SOURCERY_MCP_RESOURCE_URL"),
    )
    build_server(auth_token=auth_token, resource_url=resource_url).run(
        transport="streamable-http",
        host=host,
        port=port,
        streamable_http_path=path,
    )


if __name__ == "__main__":
    main()
