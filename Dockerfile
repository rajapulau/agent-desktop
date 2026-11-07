# Agent browser desktop (hybrid control)
#  - Human: noVNC web UI on :3000 (Xvfb + x11vnc + websockify), takeover any time
#  - Agent A: Playwright MCP on :8931 (DOM/accessibility, via Chromium CDP)
#  - Agent B: cua-driver MCP on :8932 (OS-level mouse/keyboard + screenshots, X11)
# TLS/auth must be handled by the proxy in front (Handlify SSO / instabox private token).
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN=1280x800x24 \
    PORT=3000 \
    CDP_PORT=9222 \
    ENABLE_MCP=1 \
    PLAYWRIGHT_MCP_PORT=8931 \
    CUA_MCP_PORT=8932 \
    PATH=/home/agent/.local/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc python3-websockify openbox xdotool \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      ca-certificates curl tini procps nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --omit=dev @playwright/mcp@0.0.84 supergateway@4.2.1 \
    && npm cache clean --force \
    && useradd -m -u 1000 agent \
    && mkdir -p /home/agent/profile && chown -R agent:agent /home/agent

COPY start.sh /usr/local/bin/start.sh
COPY index.html /usr/share/novnc/index.html
# Old noVNC pages redirect to the minimal UI (browsers may have cached the vnc.html URL)
COPY vnc-redirect.html /usr/share/novnc/vnc.html
COPY vnc-redirect.html /usr/share/novnc/vnc_lite.html
RUN chmod +x /usr/local/bin/start.sh

USER agent
WORKDIR /home/agent

# cua-driver (Rust build, Linux x86_64), telemetry off
RUN curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-install.sh \
    && bash /tmp/cua-install.sh \
    && rm -f /tmp/cua-install.sh \
    && cua-driver telemetry disable

VOLUME /home/agent/profile
EXPOSE 3000 8931 8932

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
