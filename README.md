# agent-desktop

Lightweight per-user browser desktop for AI agents: Xvfb + x11vnc + noVNC + Chromium.

- One HTTP port (3000): noVNC web client + WebSocket. TLS is terminated by the reverse proxy.
- No UDP, no video encoding (VNC sends only changed regions), so low CPU.
- Chromium profile in /home/agent/profile (mount a volume to persist logins).
- CDP (Playwright) on 127.0.0.1:9222 inside the container, not exposed yet.
- Protect the URL with SSO/auth at the proxy: VNC itself has no password.
