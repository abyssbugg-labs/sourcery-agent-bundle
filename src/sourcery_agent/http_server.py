"""Streamable HTTP entry point for the Sourcery MCP server.

Used by ``bin/run-http`` for remote/self-hosted deployments (for example the
ChatGPT developer-mode app flow), where a local stdio process is not possible.
The stdio path remains ``python -m sourcery_agent.server``.
"""

from __future__ import annotations

import os

from .server import mcp


def main() -> None:
    host = os.getenv("SOURCERY_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("SOURCERY_MCP_PORT", "8765"))
    path = os.getenv("SOURCERY_MCP_PATH", "/mcp")
    mcp.run(transport="streamable-http", host=host, port=port, streamable_http_path=path)


if __name__ == "__main__":
    main()
