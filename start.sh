#!/bin/sh
# Start: virtual display -> window manager -> Chromium -> VNC server -> noVNC web on $PORT
set -e
PROFILE=/home/agent/profile
mkdir -p "$PROFILE"
rm -f "$PROFILE"/Singleton* /tmp/.X99-lock

Xvfb :99 -screen 0 "$SCREEN" -nolisten tcp &
sleep 1
openbox >/dev/null 2>&1 &

# Chromium keeps restarting if it is closed. CDP listens on localhost only (agent sidecar/tunnel later).
(
  while true; do
    chromium \
      --no-sandbox --test-type --disable-dev-shm-usage --disable-gpu \
      --no-first-run --no-default-browser-check --password-store=basic \
      --user-data-dir="$PROFILE" --start-maximized \
      --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" \
      ${CHROME_CLI} about:blank >/tmp/chromium.log 2>&1 || true
    sleep 2
  done
) &

# VNC only on localhost; exposed to the outside solely via websockify/noVNC
x11vnc -display :99 -localhost -forever -shared -nopw -quiet -rfbport 5900 &

exec websockify --web /usr/share/novnc "$PORT" localhost:5900
