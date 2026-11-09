#!/bin/sh
# Start: virtual display -> window manager -> Chromium -> agent MCPs -> VNC -> noVNC
#
# Two modes (MCP_AUTH):
#   token  - hardened: MCPs + noVNC on 127.0.0.1, one public port ($PORT) served by gateway.js
#            (/ noVNC, /pw/mcp and /cua/mcp with Bearer token). An MCP whose token is unset stays off.
#   legacy - the original layout, unchanged: noVNC on $PORT, Playwright MCP on :8931/mcp and
#            cua MCP on :8932/mcp, no auth (publish only behind an auth proxy, e.g. instabox private ports).
# Default (MCP_AUTH unset): token if PW_MCP_TOKEN or CUA_MCP_TOKEN is set, otherwise legacy,
# so existing deployments that never set tokens keep working exactly as before.
set -e
PROFILE=/home/agent/profile
mkdir -p "$PROFILE"
rm -f "$PROFILE"/Singleton* /tmp/.X99-lock

if [ -z "$MCP_AUTH" ]; then
  if [ -n "$PW_MCP_TOKEN" ] || [ -n "$CUA_MCP_TOKEN" ]; then MCP_AUTH=token; else MCP_AUTH=legacy; fi
fi
case "$MCP_AUTH" in
  token) BIND=127.0.0.1 ;;
  legacy) BIND=0.0.0.0
          echo "MCP_AUTH=legacy: MCP ports $PLAYWRIGHT_MCP_PORT/$CUA_MCP_PORT have NO auth; publish them only behind an auth proxy" >&2 ;;
  *) echo "MCP_AUTH must be 'token' or 'legacy' (got '$MCP_AUTH')" >&2; exit 1 ;;
esac
echo "agent-desktop mode: $MCP_AUTH" >&2

Xvfb :99 -screen 0 "$SCREEN" -nolisten tcp &
sleep 1
openbox >/dev/null 2>&1 &

# Chromium restarts if closed. CDP stays on localhost; agents reach it through the MCP servers.
(
  while true; do
    chromium \
      --no-sandbox --test-type --disable-dev-shm-usage --disable-gpu \
      --no-first-run --no-default-browser-check --lang=en-US --accept-lang=en-US,en --password-store=basic \
      --user-data-dir="$PROFILE" --start-maximized \
      --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" \
      ${CHROME_CLI} ${START_URL:-https://www.google.com/?hl=en} >/tmp/chromium.log 2>&1 || true
    sleep 2
  done
) &

start_pw() {
  (
    until curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; do sleep 1; done
    while true; do
      if [ "$MCP_AUTH" = legacy ]; then
        playwright-mcp --cdp-endpoint "http://127.0.0.1:$CDP_PORT" \
          --host 0.0.0.0 --port "$PLAYWRIGHT_MCP_PORT" --allowed-hosts '*' \
          ${PLAYWRIGHT_MCP_ARGS} >/tmp/playwright-mcp.log 2>&1 || true
      else
        playwright-mcp --cdp-endpoint "http://127.0.0.1:$CDP_PORT" \
          --host 127.0.0.1 --port "$PLAYWRIGHT_MCP_PORT" \
          ${PLAYWRIGHT_MCP_ARGS} >/tmp/playwright-mcp.log 2>&1 || true
      fi
      sleep 2
    done
  ) &
}
start_cua() {
  (
    while true; do
      supergateway --stdio "cua-driver mcp" --outputTransport streamableHttp \
        --host "$BIND" --port "$CUA_MCP_PORT" --streamableHttpPath /mcp >/tmp/cua-mcp.log 2>&1 || true
      sleep 2
    done
  ) &
}

if [ "$ENABLE_MCP" = "1" ]; then
  if [ "$MCP_AUTH" = legacy ]; then
    start_pw; start_cua
  else
    # Token mode: each MCP starts only when its token is configured (>= 24 chars).
    if [ "${#PW_MCP_TOKEN}" -ge 24 ]; then start_pw; else echo "PW_MCP_TOKEN missing or too short: Playwright MCP not started" >&2; fi
    if [ "${#CUA_MCP_TOKEN}" -ge 24 ]; then start_cua; else echo "CUA_MCP_TOKEN missing or too short: cua-driver MCP not started" >&2; fi
  fi
fi

# VNC only on localhost
x11vnc -display :99 -localhost -forever -shared -nopw -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &

if [ "$MCP_AUTH" = legacy ]; then
  # Original layout: noVNC/websockify directly on $PORT
  exec websockify --web /usr/share/novnc "$PORT" localhost:5900
fi

# Token mode: noVNC on localhost, gateway.js is the single public listener
websockify --web /usr/share/novnc 127.0.0.1:"$VNC_WEB_PORT" localhost:5900 >/tmp/websockify.log 2>&1 &
exec node /usr/local/lib/agent-desktop/gateway.js
