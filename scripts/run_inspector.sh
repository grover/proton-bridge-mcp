#!/usr/bin/env bash
# run_inspector.sh — start the MCP server + MCP Inspector in one command.
#
# Usage: npm run inspector  (builds first, then runs this script)
#
# Requirements:
#   - .env must exist (copy .env.example → .env and fill in your credentials)
#   - dist/ must exist (npm run build)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Guard ──────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "Error: .env not found." >&2
  echo "  Copy .env.example → .env and fill in your Proton Bridge credentials." >&2
  exit 1
fi

# ── Load .env ─────────────────────────────────────────────────────────────────
set -a
# shellcheck source=/dev/null
source .env
set +a

# ── Dynamic secrets & ports ───────────────────────────────────────────────────
DEBUG_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
INSPECTOR_PORT=$(node -e "
  const net = require('net');
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    process.stdout.write(String(s.address().port));
    s.close();
  });
")

# ── Config overrides ──────────────────────────────────────────────────────────
export PROTONMAIL_MCP_AUTH_TOKEN="$DEBUG_TOKEN"
export PROTONMAIL_AUDIT_LOG_PATH="${PROTONMAIL_AUDIT_LOG_PATH:-./audit.jsonl}"
export PROTONMAIL_LOG_LEVEL="${PROTONMAIL_LOG_LEVEL:-debug}"

MCP_HOST="${PROTONMAIL_MCP_HOST:-127.0.0.1}"
MCP_PORT="${PROTONMAIL_MCP_PORT:-3000}"
MCP_BASE="${PROTONMAIL_MCP_BASE_PATH:-/mcp}"
MCP_URL="http://${MCP_HOST}:${MCP_PORT}${MCP_BASE}"
INSPECTOR_URL="http://127.0.0.1:${INSPECTOR_PORT}"

# ── Start MCP server ──────────────────────────────────────────────────────────
echo ""
echo "Starting MCP server on ${MCP_URL} ..."
node dist/index.js --http &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Wait for server to accept connections ─────────────────────────────────────
for i in $(seq 1 20); do
  if nc -z "$MCP_HOST" "$MCP_PORT" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

echo ""
echo "  MCP server : ${MCP_URL}"
echo "  Auth token : ${DEBUG_TOKEN}"
echo "  Inspector  : ${INSPECTOR_URL}"
echo ""

# ── Open browser after a short delay ─────────────────────────────────────────
(
  sleep 2
  if command -v open >/dev/null 2>&1; then
    open "$INSPECTOR_URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$INSPECTOR_URL"
  fi
) &

# ── Run MCP Inspector ─────────────────────────────────────────────────────────
CLIENT_PORT="$INSPECTOR_PORT" \
  npx --yes @modelcontextprotocol/inspector@latest \
  --transport http \
  --header "Authorization: Bearer ${DEBUG_TOKEN}" \
  --server-url "$MCP_URL"
