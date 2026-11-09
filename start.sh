#!/bin/sh
# Start: virtual display -> window manager -> Chromium -> agent MCPs (localhost only)
#        -> VNC -> noVNC (localhost) -> token gateway on $PORT (the only exposed port)
set -e
PROFILE=/home/agent/profile
mkdir -p "$PROFILE"
rm -f "$PROFILE"/Singleton* /tmp/.X99-lock

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

if [ "$ENABLE_MCP" = "1" ]; then
  # Each MCP starts only when its token is configured (>= 24 chars); both listen on 127.0.0.1 only.
  # Public access goes through gateway.js (/pw/mcp, /cua/mcp) which enforces the Bearer token.
  if [ "${#PW_MCP_TOKEN}" -ge 24 ]; then
    (
      until curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; do sleep 1; done
      while true; do
        playwright-mcp --cdp-endpoint "http://127.0.0.1:$CDP_PORT" \
          --host 127.0.0.1 --port "$PLAYWRIGHT_MCP_PORT" \
          ${PLAYWRIGHT_MCP_ARGS} >/tmp/playwright-mcp.log 2>&1 || true
        sleep 2
      done
    ) &
  else
    echo "PW_MCP_TOKEN missing or too short: Playwright MCP not started" >&2
  fi
  if [ "${#CUA_MCP_TOKEN}" -ge 24 ]; then
    (
      while true; do
        supergateway --stdio "cua-driver mcp" --outputTransport streamableHttp \
          --host 127.0.0.1 --port "$CUA_MCP_PORT" --streamableHttpPath /mcp >/tmp/cua-mcp.log 2>&1 || true
        sleep 2
      done
    ) &
  else
    echo "CUA_MCP_TOKEN missing or too short: cua-driver MCP not started" >&2
  fi
fi

# VNC only on localhost; noVNC/websockify on localhost; gateway is the single public listener
x11vnc -display :99 -localhost -forever -shared -nopw -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 127.0.0.1:"$VNC_WEB_PORT" localhost:5900 >/tmp/websockify.log 2>&1 &

exec node /usr/local/lib/agent-desktop/gateway.js
