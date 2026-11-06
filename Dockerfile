# Lightweight agent browser desktop: Xvfb + x11vnc + noVNC (websockify) + Chromium
# One port (3000, plain HTTP + WebSocket); TLS is terminated by the reverse proxy.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN=1280x800x24 \
    PORT=3000 \
    CDP_PORT=9222

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc python3-websockify openbox \
      fonts-noto-core fonts-noto-color-emoji ca-certificates tini procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 agent \
    && mkdir -p /home/agent/profile && chown -R agent:agent /home/agent

COPY start.sh /usr/local/bin/start.sh
COPY index.html /usr/share/novnc/index.html
RUN chmod +x /usr/local/bin/start.sh

USER agent
WORKDIR /home/agent
VOLUME /home/agent/profile
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
