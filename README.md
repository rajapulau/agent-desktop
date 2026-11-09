# agent-desktop

Lightweight per-user browser desktop for AI agents: Xvfb + x11vnc + noVNC + Chromium.

- One HTTP port (3000): noVNC web client + WebSocket. TLS is terminated by the reverse proxy.
- No UDP, no video encoding (VNC sends only changed regions), so low CPU.
- Chromium profile in /home/agent/profile (mount a volume to persist logins).
- CDP (Playwright) on 127.0.0.1:9222 inside the container, not exposed yet.
- Protect the URL with SSO/auth at the proxy: VNC itself has no password.

## Hybrid agent control (MCP, Streamable HTTP) - single port, token-gated

Only `$PORT` (3000) is exposed; it is served by `gateway.js`:

| Path | Target | Auth |
|------|--------|------|
| `/` | noVNC web UI (websockify on 127.0.0.1:6080) | proxy SSO (Handlify access) |
| `/pw/mcp` | Playwright MCP (127.0.0.1:8931) | `Authorization: Bearer $PW_MCP_TOKEN` |
| `/cua/mcp` | cua-driver MCP (127.0.0.1:8932, via supergateway) | `Authorization: Bearer $CUA_MCP_TOKEN` |
| `/healthz` | `ok` | none |

- Tokens are compared in constant time; wrong/missing token -> 401. A token that is unset or shorter than 24 chars keeps that MCP stopped (route answers 503).
- Node 24 is copied from `node:24.22.2-trixie-slim` pinned by digest (no Debian Node 20).
- cua-driver is a pinned release tarball verified with SHA256 (`CUA_DRIVER_VERSION`, `CUA_DRIVER_SHA256` build args).
- `ENABLE_MCP=0` runs only the desktop. Use `delivery_mode: "foreground"` for cua on Chromium.
- Mount a volume on `/home/agent/profile` and run ONE replica to keep browser logins.

## Proxy behaviour and tests

- `gateway.js` strips hop-by-hop headers in both directions (`Connection` and every header it lists, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Proxy-Connection`, `Proxy-Authorization`) and opens a fresh upstream socket per request. Forwarding an ingress `Connection: close` used to break the next request (alternating empty 400s).
- MCP access log on stdout: time, route, method, client IP, status. No headers, tokens or bodies.
- Tests: `node --test test/gateway.test.js` (401 without/with wrong token, 503 when unset, hop-by-hop stripping, 100 sequential + 20 parallel requests).

## Deployment notes: agent-desktop-data (Handlify, Solocraft / Tim Data)

- 1 replica (SRE, handlify-apps!6). SSO gate on every path except `/pw/mcp` and `/cua/mcp` for requests that carry `Authorization: Bearer` (Handlify `bearer-paths` tag); the app then checks the token.
- **No PVC, on purpose (no extra cost):** the browser profile lives in the pod, so a Metabase login is lost whenever the pod is replaced. Someone re-logs in through noVNC with the Tim Data read-only Metabase account.
- Whoever holds an MCP token acts as whatever account is logged in to the browser. Use only read-only accounts, keep tokens only in Solocraft's `.env`, and rotate them (new values on both sides via a machine handoff).

## Watching / Take control (token mode)

- The noVNC page opens in **Watching** mode (view only). **Take control** gives the human mouse/keyboard; while a human holds control the gateway answers every agent `tools/call` (Playwright, cua and vault) with an error telling the agent to wait, so human and agent never fight over the browser. **Release** hands it back; it also auto-releases after `CONTROL_IDLE_SEC` (default 300) without human input.
- Endpoints (behind the platform SSO like noVNC): `GET /control/state`, `POST /control/take|release|ping` (need header `X-Agent-Desktop: 1`). The SSO email header, when present, is recorded as the holder and logged.
- Legacy mode has no `/control`; the page then stays fully interactive as before.

## Vault (token mode)

- Logins come from env/secrets, one item per prefix: `VAULT_<ITEM>_USER`, `VAULT_<ITEM>_PASSWORD`, `VAULT_<ITEM>_ORIGIN` (https origin, required; items without it are ignored). On Handlify set them as app secrets.
- `/vault/mcp`, also reachable as `/pw/mcp?server=vault` for ingresses that only bypass SSO on exact MCP paths (Bearer `PW_MCP_TOKEN`), is a small MCP server with `vault_list` (names, origin, which fields exist; never values) and `vault_fill(item, field, selector?)`. Fill types via CDP into a tab whose **current origin equals the item origin**, refuses passwords into non-password inputs and refuses while a human holds control.
- Every MCP response leaving the gateway is scrubbed: vault values (raw and JSON-escaped) are replaced with `[vault:item.field]`, so snapshots/evaluate output never show them to the agent. Logs record item/field/origin only.
- 2FA/captcha stay manual through Take control.

### Encrypted vault values (recommended)

Set `VAULT_PRIVATE_KEY` (base64 DER PKCS#8 RSA-3072) as an app secret. The matching public key goes to the bot.
The bot stores each login as `enc:v1:<base64 RSA-OAEP-SHA256({o: origin, f: field, v: value})>`, so its server holds
only ciphertext. With the key set, `vault_fill_value` accepts only `value_enc`; origin and field come from inside the
seal (a copied ciphertext cannot be typed into another site/field). Plaintext `value` is refused.
