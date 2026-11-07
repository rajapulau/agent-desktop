#!/bin/sh
# Start: virtual display -> window manager -> Chromium -> agent MCPs -> VNC -> noVNC web on $PORT
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
  # Agent A: Playwright MCP attached to the SAME Chromium (what the human sees)
  (
    until curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; do sleep 1; done
    while true; do
      playwright-mcp --cdp-endpoint "http://127.0.0.1:$CDP_PORT" \
        --host 0.0.0.0 --port "$PLAYWRIGHT_MCP_PORT" --allowed-hosts '*' \
        ${PLAYWRIGHT_MCP_ARGS} >/tmp/playwright-mcp.log 2>&1 || true
      sleep 2
    done
  ) &
  # Agent B: cua-driver MCP (stdio) bridged to Streamable HTTP
  (
    while true; do
      supergateway --stdio "cua-driver mcp" --outputTransport streamableHttp \
        --port "$CUA_MCP_PORT" --streamableHttpPath /mcp >/tmp/cua-mcp.log 2>&1 || true
      sleep 2
    done
  ) &
fi

# VNC only on localhost; exposed to the outside solely via websockify/noVNC
x11vnc -display :99 -localhost -forever -shared -nopw -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &

exec websockify --web /usr/share/novnc "$PORT" localhost:5900
