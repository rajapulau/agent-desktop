# Agent desktop PoC: Chromium + Selkies (WebSocket stream over HTTP :3000, TLS handled by the proxy)
FROM lscr.io/linuxserver/chromium:latest

# Chromium flags: container-safe shared memory
ENV CHROME_CLI="--disable-dev-shm-usage" \
    TITLE="Agent Desktop"

# Only expose the plain-HTTP port; the reverse proxy (Handlify) terminates TLS
EXPOSE 3000
