"""Streamable HTTP entry point for the Sourcery MCP server.

Used by ``bin/run-http`` for remote/self-hosted deployments (for example the
ChatGPT developer-mode app flow), where a local stdio process is not possible.
The stdio path remains ``python -m sourcery_agent.server``.

Security: this transport serves the full tool set — including bulk updates —
with the process's Sourcery API key, so it is loopback-only by default. Binding
a non-loopback host requires ``SOURCERY_MCP_ALLOW_REMOTE=1`` **and** a
``SOURCERY_MCP_AUTH_TOKEN``; the server does not terminate request auth itself,
so the token must be enforced by a fronting proxy (see docs/COMPATIBILITY.md).
"""

from __future__ import annotations

import ipaddress
import os

from .server import mcp


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
            "SOURCERY_MCP_ALLOW_REMOTE=1 and SOURCERY_MCP_AUTH_TOKEN, and require that "
            "token at your reverse proxy."
        )
    if not os.getenv("SOURCERY_MCP_AUTH_TOKEN", "").strip():
        raise SystemExit(
            "refusing to bind a non-loopback SOURCERY_MCP_HOST without "
            "SOURCERY_MCP_AUTH_TOKEN; set the token and enforce it at your reverse proxy."
        )


def main() -> None:
    host = os.getenv("SOURCERY_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("SOURCERY_MCP_PORT", "8765"))
    path = os.getenv("SOURCERY_MCP_PATH", "/mcp")
    check_bind_allowed(host)
    mcp.run(transport="streamable-http", host=host, port=port, streamable_http_path=path)


if __name__ == "__main__":
    main()
