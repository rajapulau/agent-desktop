# agent-desktop

Lightweight per-user browser desktop for AI agents: Xvfb + x11vnc + noVNC + Chromium.

- One HTTP port (3000): noVNC web client + WebSocket. TLS is terminated by the reverse proxy.
- No UDP, no video encoding (VNC sends only changed regions), so low CPU.
- Chromium profile in /home/agent/profile (mount a volume to persist logins).
- CDP (Playwright) on 127.0.0.1:9222 inside the container, not exposed yet.
- Protect the URL with SSO/auth at the proxy: VNC itself has no password.

## Hybrid agent control (MCP, Streamable HTTP)

| Port | Server | Use |
|------|--------|-----|
| 3000 | noVNC web UI | human view + takeover |
| 8931 | Playwright MCP (`/mcp`) | default: DOM/accessibility actions on the same Chromium via CDP |
| 8932 | cua-driver MCP (`/mcp`, via supergateway) | fallback: OS-level mouse/keyboard + screenshots (X11). Use `delivery_mode: "foreground"` for Chromium |

Set `ENABLE_MCP=0` to run only the desktop. `PLAYWRIGHT_MCP_ARGS` passes extra flags (e.g. `--allowed-origins`).
The MCP ports have NO auth: only publish them behind a private token/SSO.
