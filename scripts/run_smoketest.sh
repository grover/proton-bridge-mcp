#!/usr/bin/env bash
# run_smoketest.sh — start MCP server + Inspector for manual smoke testing.
#
# Usage: npm run smoketest  (builds first, then runs this script)
#
# Starts all components as background daemons, verifies they are listening,
# reports PIDs/ports/tokens, opens browser after 10s, then exits.
# Processes keep running until killed. PIDs are written to .smoketest.pids.
# Re-running the script kills stale processes if their ports are still in use.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PIDFILE="$ROOT/.smoketest.pids"

# ── Guard ────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "Error: .env not found." >&2
  echo "  Copy .env.example → .env and fill in your Proton Bridge credentials." >&2
  exit 1
fi

# ── Load .env ────────────────────────────────────────────────────────────────
set -a
# shellcheck source=/dev/null
source .env
set +a

# ── Auth token — reuse from env or generate ──────────────────────────────────
if [ -z "${PROTONMAIL_MCP_AUTH_TOKEN:-}" ]; then
  DEBUG_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
  export PROTONMAIL_MCP_AUTH_TOKEN="$DEBUG_TOKEN"
else
  DEBUG_TOKEN="$PROTONMAIL_MCP_AUTH_TOKEN"
fi

# ── Ports ────────────────────────────────────────────────────────────────────
INSPECTOR_PORT=$(node -e "
  const net = require('net');
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    process.stdout.write(String(s.address().port));
    s.close();
  });
")

export PROTONMAIL_AUDIT_LOG_PATH="${PROTONMAIL_AUDIT_LOG_PATH:-./audit.jsonl}"
export PROTONMAIL_LOG_LEVEL="${PROTONMAIL_LOG_LEVEL:-debug}"

MCP_HOST="${PROTONMAIL_MCP_HOST:-127.0.0.1}"
MCP_PORT="${PROTONMAIL_MCP_PORT:-3000}"
MCP_BASE="${PROTONMAIL_MCP_BASE_PATH:-/mcp}"
MCP_URL="http://${MCP_HOST}:${MCP_PORT}${MCP_BASE}"
INSPECTOR_URL="http://127.0.0.1:${INSPECTOR_PORT}"
PROXY_PORT=6277

# ── Kill stale processes if their ports are in use ───────────────────────────
if [ -f "$PIDFILE" ]; then
  read -r OLD_SERVER OLD_INSPECTOR < "$PIDFILE" || true
  if [ -n "${OLD_SERVER:-}" ] && nc -z "$MCP_HOST" "$MCP_PORT" 2>/dev/null; then
    echo "Killing stale MCP server (PID ${OLD_SERVER}) on port ${MCP_PORT} ..."
    kill "$OLD_SERVER" 2>/dev/null || true
    sleep 0.5
  fi
  if [ -n "${OLD_INSPECTOR:-}" ] && nc -z localhost "$PROXY_PORT" 2>/dev/null; then
    echo "Killing stale Inspector (PID ${OLD_INSPECTOR}) on port ${PROXY_PORT} ..."
    kill "$OLD_INSPECTOR" 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PIDFILE"
fi

# ── Cleanup helper (only used on startup failure) ────────────────────────────
started_pids=()
fail_cleanup() {
  for pid in "${started_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  rm -f "$PIDFILE"
}

# ── Start MCP server ─────────────────────────────────────────────────────────
echo ""
echo "Starting MCP server on ${MCP_URL} ..."
node dist/index.js --http &
SERVER_PID=$!
started_pids+=("$SERVER_PID")

# ── Verify MCP server is listening ───────────────────────────────────────────
echo -n "  Waiting for MCP server on port ${MCP_PORT} "
for i in $(seq 1 40); do
  if nc -z "$MCP_HOST" "$MCP_PORT" 2>/dev/null; then
    echo " ✓"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo " ✗"
    echo "  ERROR: MCP server process (PID ${SERVER_PID}) exited unexpectedly." >&2
    fail_cleanup
    exit 1
  fi
  echo -n "."
  sleep 0.25
done

if ! nc -z "$MCP_HOST" "$MCP_PORT" 2>/dev/null; then
  echo " ✗"
  echo "  ERROR: MCP server did not start listening on port ${MCP_PORT} within 10s." >&2
  fail_cleanup
  exit 1
fi

# ── Start MCP Inspector ──────────────────────────────────────────────────────
echo "Starting MCP Inspector ..."
CLIENT_PORT="$INSPECTOR_PORT" \
  npx --yes @modelcontextprotocol/inspector@latest \
  --transport http \
  --header "Authorization: Bearer ${DEBUG_TOKEN}" \
  --server-url "$MCP_URL" &
INSPECTOR_PID=$!
started_pids+=("$INSPECTOR_PID")

# ── Verify Inspector proxy is listening ──────────────────────────────────────
echo -n "  Waiting for Inspector proxy on port ${PROXY_PORT} "
for i in $(seq 1 40); do
  if nc -z localhost "$PROXY_PORT" 2>/dev/null; then
    echo " ✓"
    break
  fi
  if ! kill -0 "$INSPECTOR_PID" 2>/dev/null; then
    echo " ✗"
    echo "  ERROR: Inspector process (PID ${INSPECTOR_PID}) exited unexpectedly." >&2
    fail_cleanup
    exit 1
  fi
  echo -n "."
  sleep 0.25
done

if ! nc -z localhost "$PROXY_PORT" 2>/dev/null; then
  echo " ✗"
  echo "  ERROR: Inspector proxy did not start listening on port ${PROXY_PORT} within 10s." >&2
  fail_cleanup
  exit 1
fi

# ── Verify Inspector UI is listening ─────────────────────────────────────────
echo -n "  Waiting for Inspector UI on port ${INSPECTOR_PORT} "
for i in $(seq 1 40); do
  if nc -z localhost "$INSPECTOR_PORT" 2>/dev/null; then
    echo " ✓"
    break
  fi
  echo -n "."
  sleep 0.25
done

if ! nc -z localhost "$INSPECTOR_PORT" 2>/dev/null; then
  echo " ✗"
  echo "  WARNING: Inspector UI not responding on port ${INSPECTOR_PORT}." >&2
fi

# ── Write PID file ───────────────────────────────────────────────────────────
echo "${SERVER_PID} ${INSPECTOR_PID}" > "$PIDFILE"

# ── Report ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                   SMOKE TEST READY                         ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                            ║"
printf "║  MCP Server    : %-40s ║\n" "${MCP_URL}"
printf "║  Inspector UI  : %-40s ║\n" "${INSPECTOR_URL}"
printf "║  Inspector Proxy: %-39s ║\n" "http://127.0.0.1:${PROXY_PORT}"
echo "║                                                            ║"
printf "║  Auth token    : %-40s ║\n" "${DEBUG_TOKEN}"
printf "║  Bearer header : Bearer %-33s ║\n" "${DEBUG_TOKEN}"
echo "║                                                            ║"
echo "║  Processes:                                                ║"
printf "║    MCP Server     PID %-5s  port %-5s                    ║\n" "${SERVER_PID}" "${MCP_PORT}"
printf "║    Inspector      PID %-5s  port %-5s  proxy %-5s       ║\n" "${INSPECTOR_PID}" "${INSPECTOR_PORT}" "${PROXY_PORT}"
echo "║                                                            ║"
printf "║  PID file      : %-40s ║\n" ".smoketest.pids"
echo "║                                                            ║"
echo "║  Run again to restart, or kill PIDs when done.             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Open browser after 10s ───────────────────────────────────────────────────
(
  sleep 10
  if command -v open >/dev/null 2>&1; then
    open "$INSPECTOR_URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$INSPECTOR_URL"
  fi
) &
disown
