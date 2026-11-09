// Single-port gateway for agent-desktop.
//   /pw/mcp   -> Playwright MCP  (127.0.0.1:$PLAYWRIGHT_MCP_PORT/mcp)  Bearer $PW_MCP_TOKEN required
//   /cua/mcp  -> cua-driver MCP  (127.0.0.1:$CUA_MCP_PORT/mcp)         Bearer $CUA_MCP_TOKEN required
//   /vault/mcp -> built-in vault MCP (vault_list, vault_fill)    Bearer $PW_MCP_TOKEN required
//   /control/* -> Watching / Take control lock (behind the platform SSO like noVNC)
//   /healthz  -> 200 "ok" (no auth, no data)
//   anything else -> noVNC/websockify (127.0.0.1:$VNC_WEB_PORT), HTTP + WebSocket
// MCP routes answer 401 without the right token (constant-time compare) and 503 when the token
// is not configured. Tokens are never logged. No dependencies: Node core only.
'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const cv = require('./control_vault.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const VNC_WEB_PORT = parseInt(process.env.VNC_WEB_PORT || '6080', 10);
const ROUTES = {
  '/pw/mcp': { port: parseInt(process.env.PLAYWRIGHT_MCP_PORT || '8931', 10), token: process.env.PW_MCP_TOKEN || '' },
  '/cua/mcp': { port: parseInt(process.env.CUA_MCP_PORT || '8932', 10), token: process.env.CUA_MCP_TOKEN || '' },
  '/vault/mcp': { port: 0, token: process.env.PW_MCP_TOKEN || '' },
};
const MIN_TOKEN_LEN = 24;

function digest(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest(); }
function tokenOk(header, expected) {
  if (!expected || expected.length < MIN_TOKEN_LEN) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  const got = m ? m[1] : '';
  // Compare fixed-length digests so neither content nor length leaks through timing.
  const ok = crypto.timingSafeEqual(digest(got), digest(expected));
  return ok && got.length > 0;
}

function matchRoute(url) {
  const path = (url || '/').split('?')[0];
  for (const prefix of Object.keys(ROUTES)) {
    if (path === prefix || path === prefix + '/') return { prefix, ...ROUTES[prefix] };
  }
  if (/^\/(pw|cua|vault)(\/|$)/.test(path)) return { prefix: null };
  return null;
}

function deny(res, code, msg) {
  const h = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (code === 401) h['www-authenticate'] = 'Bearer';
  res.writeHead(code, h);
  res.end(JSON.stringify({ error: msg }));
}

// Hop-by-hop headers must not be forwarded (RFC 9110 7.6.1). Forwarding e.g. "Connection: close"
// from a front proxy breaks the upstream socket and yields alternating empty 400s.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'authorization', 'host']);
function cleanHeaders(src, extra) {
  const listed = String(src.connection || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const lk = k.toLowerCase();
    if (HOP.has(lk) || listed.includes(lk) || v === undefined) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined) delete out[k]; else out[k] = v;
  }
  return out;
}

function proxyHttp(req, res, port, path, extraHeaders, body, redactOut) {
  const headers = cleanHeaders(req.headers, extraHeaders);
  if (body) headers['content-length'] = String(body.length);
  headers.host = `127.0.0.1:${port}`;
  // agent:false = fresh connection per request, never reuse a socket the upstream may have closed
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path, headers, agent: false }, (ur) => {
    const rh = cleanHeaders(ur.headers, {});
    // MCP POST responses are finite (one JSON or one SSE event, then end): buffer them and strip
    // vault values. Long-lived GET SSE streams carry only notifications and are piped as-is.
    if (redactOut && req.method === 'POST' && cv.hasRedactions()) {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        const out = cv.redact(Buffer.concat(chunks));
        delete rh['content-length']; rh['content-length'] = String(out.length);
        res.writeHead(ur.statusCode || 502, rh); res.end(out);
      });
      ur.on('error', () => res.destroy());
      return;
    }
    res.writeHead(ur.statusCode || 502, rh);
    ur.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) deny(res, 502, 'upstream unavailable'); else res.destroy(); });
  req.on('aborted', () => up.destroy());
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  if (body) up.end(body); else req.pipe(up);
}

const MAX_MCP_BODY = 8 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_MCP_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  const r = matchRoute(req.url);
  if (r) {
    if (!r.prefix) return deny(res, 404, 'not found');
    if (!r.token) return deny(res, 503, 'mcp disabled: token not configured');
    if (!tokenOk(req.headers['authorization'], r.token)) {
      console.log(`${new Date().toISOString()} mcp ${r.prefix} ${req.method} ${String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()} 401`);
      return deny(res, 401, 'unauthorized');
    }
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    // Access log (no headers/tokens/bodies): time, route, method, client ip, final status
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    res.on('finish', () => console.log(`${new Date().toISOString()} mcp ${r.prefix} ${req.method} ${ip} ${res.statusCode}`));
    if (req.method !== 'POST') {
      if (r.prefix === '/vault/mcp') return cv.handleVaultMcp(req, res, '');
      return proxyHttp(req, res, r.port, '/mcp' + qs, { origin: undefined, referer: undefined });
    }
    return readBody(req).then((body) => {
      let msg = null; try { msg = JSON.parse(body.toString('utf8')); } catch (_) { /* let upstream answer */ }
      // While a human holds control, agent tool calls are answered here and never reach the browser.
      if (msg && cv.rpcIds(msg).length && cv.humanHolds()) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(cv.blockedReply(msg)));
      }
      if (r.prefix === '/vault/mcp') return cv.handleVaultMcp(req, res, body.toString('utf8'));
      // Upstream origin check: present the request as same-origin local traffic.
      return proxyHttp(req, res, r.port, '/mcp' + qs, { origin: undefined, referer: undefined }, body, true);
    }, () => deny(res, 413, 'body too large'));
  }
  if (cv.handleControl(req, res)) return;
  proxyHttp(req, res, VNC_WEB_PORT, req.url, {});
});

// WebSocket upgrades: only noVNC (websockify). MCP routes never upgrade.
server.on('upgrade', (req, sock, head) => {
  if (matchRoute(req.url)) { sock.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const up = net.connect(VNC_WEB_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (k.toLowerCase() === 'authorization') continue;
      lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});

server.headersTimeout = 30000;
server.requestTimeout = 0; // MCP SSE streams stay open
server.listen(PORT, '0.0.0.0', () => {
  const st = Object.entries(ROUTES).map(([p, r]) => `${p}=${r.token && r.token.length >= MIN_TOKEN_LEN ? 'on' : 'off'}`).join(' ');
  console.log(`gateway listening :${PORT} (noVNC -> :${VNC_WEB_PORT}; ${st})`);
});
