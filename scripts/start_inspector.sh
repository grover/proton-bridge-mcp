#!/usr/bin/env bash
# start_inspector.sh — start the MCP Inspector only (VSCode debug helper).
#
# Used by the "Start MCP Inspector" VSCode task defined in .vscode/tasks.json.
# The MCP server is started separately by the VSCode debug launch config.
# The browser is opened by VSCode's serverReadyAction when the server is ready.
#
# Auth token and server URL are read from .env (same values used by the debugger).
# Inspector UI is pinned to port 6274 (MCP Inspector default).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Load .env ─────────────────────────────────────────────────────────────────
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

# ── Config ────────────────────────────────────────────────────────────────────
MCP_HOST="${PROTONMAIL_MCP_HOST:-127.0.0.1}"
MCP_PORT="${PROTONMAIL_MCP_PORT:-3000}"
MCP_BASE="${PROTONMAIL_MCP_BASE_PATH:-/mcp}"
MCP_URL="http://${MCP_HOST}:${MCP_PORT}${MCP_BASE}"
TOKEN="${PROTONMAIL_MCP_AUTH_TOKEN:-}"

# ── Run MCP Inspector on fixed port 6274 ─────────────────────────────────────
CLIENT_PORT=6274 \
  npx --yes @modelcontextprotocol/inspector \
  --url "$MCP_URL" \
  --header "Authorization: Bearer ${TOKEN}"
