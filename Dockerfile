# Agent browser desktop (hybrid control), hardened single-port build
#  - Human: noVNC web UI at /  (Xvfb + x11vnc + websockify on 127.0.0.1), behind the proxy's SSO
#  - Agent A: Playwright MCP at /pw/mcp  (127.0.0.1:8931, Bearer PW_MCP_TOKEN)
#  - Agent B: cua-driver MCP at /cua/mcp (127.0.0.1:8932, Bearer CUA_MCP_TOKEN)
# Only $PORT (gateway.js) is exposed. MCP routes refuse requests without the right token.

# Node 24 (pinned by digest) - Debian trixie's nodejs package is Node 20, which we do not use.
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS node

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN=1280x800x24 \
    PORT=3000 \
    VNC_WEB_PORT=6080 \
    CDP_PORT=9222 \
    ENABLE_MCP=1 \
    PLAYWRIGHT_MCP_PORT=8931 \
    CUA_MCP_PORT=8932 \
    PATH=/home/agent/.local/bin:$PATH

ARG CUA_DRIVER_VERSION=0.44.0
ARG CUA_DRIVER_SHA256=9d87c18e983eca8e2c2448149d943e0e1dd2a6d86bdd108560c5f3bc64e62f29

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc python3-websockify openbox xdotool \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      ca-certificates curl tini procps \
    && rm -rf /var/lib/apt/lists/* \
    && node --version | grep -q '^v24\.' \
    && npm install -g --omit=dev @playwright/mcp@0.0.84 supergateway@4.2.1 \
    && npm cache clean --force \
    && useradd -m -u 1000 agent \
    && mkdir -p /home/agent/profile /home/agent/.local/bin && chown -R agent:agent /home/agent

# cua-driver: pinned release + SHA256 (no curl | bash)
RUN curl -fsSL -o /tmp/cua.tgz \
      "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64-binary.tar.gz" \
    && echo "${CUA_DRIVER_SHA256}  /tmp/cua.tgz" | sha256sum -c - \
    && mkdir -p /opt/cua-driver && tar -xzf /tmp/cua.tgz -C /opt/cua-driver && rm -f /tmp/cua.tgz \
    && ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver \
    && cua-driver --version

COPY start.sh /usr/local/bin/start.sh
COPY gateway.js /usr/local/lib/agent-desktop/gateway.js
COPY index.html /usr/share/novnc/index.html
# Old noVNC pages redirect to the minimal UI (browsers may have cached the vnc.html URL)
COPY vnc-redirect.html /usr/share/novnc/vnc.html
COPY vnc-redirect.html /usr/share/novnc/vnc_lite.html
RUN chmod +x /usr/local/bin/start.sh

USER agent
WORKDIR /home/agent
RUN cua-driver telemetry disable || true

VOLUME /home/agent/profile
# token mode publishes only 3000; legacy mode (no tokens) also uses 8931/8932
EXPOSE 3000 8931 8932

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
