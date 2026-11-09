// Human/agent control lock + credential vault for gateway.js (token mode only). Node core only.
//
// Control ("Watching" / "Take control"):
//   GET  /control/state    -> {holder:'agent'|'human', by, since, idleSec}
//   POST /control/take     -> human takes the browser; agent tools/call answered with an error
//   POST /control/release  -> back to the agent
//   POST /control/ping     -> human activity heartbeat (auto-release after CONTROL_IDLE_SEC)
//   These sit behind the platform SSO (same as noVNC). POSTs need header X-Agent-Desktop: 1
//   (blocks cross-site form posts). Who took control is taken from the SSO email header when present.
//
// Vault (values from env/secrets, never returned):
//   VAULT_<ITEM>_USER, VAULT_<ITEM>_PASSWORD, VAULT_<ITEM>_ORIGIN (https://host, required)
//   /vault/mcp (Bearer PW_MCP_TOKEN) is a tiny stateless MCP server with tools:
//     vault_list()                      -> items with origin + which fields exist (no values)
//     vault_fill(item, field, selector?) -> types the value into a page whose origin == item origin
//   The fill goes through Chromium's CDP on 127.0.0.1 and is refused on any other origin.
'use strict';
const http = require('node:http');

const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const IDLE_SEC = parseInt(process.env.CONTROL_IDLE_SEC || '300', 10);

// ---------------------------------------------------------------- control lock
const control = { holder: 'agent', by: '', since: Date.now(), last: Date.now() };
function controlState() {
  if (control.holder === 'human' && (Date.now() - control.last) / 1000 > IDLE_SEC) {
    log(`control auto-release after ${IDLE_SEC}s idle (was ${control.by || 'human'})`);
    Object.assign(control, { holder: 'agent', by: '', since: Date.now() });
  }
  return { holder: control.holder, by: control.by, since: new Date(control.since).toISOString(),
    idleSec: Math.round((Date.now() - control.last) / 1000), autoReleaseSec: IDLE_SEC };
}
function humanHolds() { return controlState().holder === 'human'; }

function who(req) {
  const h = req.headers;
  const e = h['x-auth-request-email'] || h['x-forwarded-email'] || h['x-email'] || h['remote-user'] || '';
  return String(e).slice(0, 120).replace(/[^\w@.+-]/g, '') || 'human';
}
function log(s) { console.log(`${new Date().toISOString()} ${s}`); }
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function handleControl(req, res) {
  const path = req.url.split('?')[0];
  if (path === '/control/state' && req.method === 'GET') return json(res, 200, controlState()), true;
  if (!path.startsWith('/control/')) return false;
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
  if (req.headers['x-agent-desktop'] !== '1') return json(res, 403, { error: 'missing X-Agent-Desktop header' }), true;
  const by = who(req);
  if (path === '/control/take') {
    Object.assign(control, { holder: 'human', by, since: Date.now(), last: Date.now() });
    log(`control taken by ${by}`);
  } else if (path === '/control/release') {
    log(`control released by ${by}`);
    Object.assign(control, { holder: 'agent', by: '', since: Date.now(), last: Date.now() });
  } else if (path === '/control/ping') {
    if (control.holder === 'human') control.last = Date.now();
  } else return json(res, 404, { error: 'not found' }), true;
  json(res, 200, controlState());
  return true;
}

// JSON-RPC helpers for MCP bodies
function rpcIds(msg) { return (Array.isArray(msg) ? msg : [msg]).filter((m) => m && m.method === 'tools/call'); }
function blockedReply(msg) {
  const calls = rpcIds(msg);
  const one = (m) => ({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text',
    text: `A human is controlling the browser (${control.by || 'human'}, since ${new Date(control.since).toISOString()}). ` +
      'Do not retry right away: tell the user you are waiting, then try again after they press Release ' +
      `(auto-release after ${IDLE_SEC}s without human input).` }] } });
  return Array.isArray(msg) ? calls.map(one) : one(calls[0]);
}

// ---------------------------------------------------------------- vault
function loadVault(env) {
  const items = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^VAULT_([A-Z0-9_]+?)_(USER|PASSWORD|ORIGIN)$/.exec(k);
    if (!m || !v) continue;
    const name = m[1].toLowerCase();
    (items[name] ||= {})[m[2].toLowerCase()] = v;
  }
  for (const [name, it] of Object.entries(items)) {
    try {
      const u = new URL(it.origin || '');
      if (u.protocol !== 'https:') throw new Error('not https');
      it.origin = u.origin;
    } catch { log(`vault item ${name} ignored: VAULT_${name.toUpperCase()}_ORIGIN missing or not https`); delete items[name]; }
  }
  return items;
}
const VAULT = loadVault(process.env);

function cdpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path, agent: false }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    ws.onerror = () => reject(new Error('cdp connect failed'));
    ws.onopen = () => resolve({
      send: (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close(),
    });
  });
}

// Runs inside the page. Value arrives as a CDP call argument, never inside source text.
const FILL_FN = `function (field, selector, value) {
  const vis = (e) => !!(e && e.offsetParent !== null && !e.disabled && !e.readOnly);
  const pick = (sels) => { for (const s of sels) { for (const e of document.querySelectorAll(s)) if (vis(e)) return e; } return null; };
  let el = null;
  if (selector) { el = document.querySelector(selector); if (!vis(el)) return { ok: false, error: 'selector not found or hidden' }; }
  else if (field === 'password') el = pick(['input[type=password]']);
  else el = pick(['input[autocomplete=username]', 'input[type=email]', 'input[name=username]', 'input[name*=user i]', 'input[name*=email i]', 'input[id*=user i]', 'input[id*=email i]', 'input[type=text]']);
  if (!el) return { ok: false, error: 'no matching ' + field + ' field on the page' };
  if (field === 'password' && el.type !== 'password') return { ok: false, error: 'refusing to put a password into a non-password field' };
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, field: el.name || el.id || el.type };
}`;

async function vaultFill(item, field, selector) {
  const it = VAULT[item];
  if (!it) return { ok: false, error: `unknown vault item '${item}'` };
  if (!['user', 'password'].includes(field)) return { ok: false, error: "field must be 'user' or 'password'" };
  if (!it[field]) return { ok: false, error: `vault item '${item}' has no ${field}` };
  if (humanHolds()) return { ok: false, error: 'a human is controlling the browser; wait for Release' };
  let targets;
  try { targets = await cdpJson('/json/list'); } catch { return { ok: false, error: 'browser not reachable' }; }
  // Only pages whose current origin equals the item's origin are eligible (most recently active first).
  const page = targets.find((t) => { try { return t.type === 'page' && new URL(t.url).origin === it.origin; } catch { return false; } });
  if (!page) return { ok: false, error: `no open tab on ${it.origin}; navigate there first (fill refused on other sites)` };
  const s = await cdpSession(page.webSocketDebuggerUrl);
  try {
    const doc = await s.send('Runtime.evaluate', { expression: 'document', returnByValue: false });
    const href = await s.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    if (new URL(href.result.value).origin !== it.origin) return { ok: false, error: 'page origin changed; fill refused' };
    const r = await s.send('Runtime.callFunctionOn', {
      objectId: doc.result.objectId, functionDeclaration: FILL_FN, returnByValue: true,
      arguments: [{ value: field }, { value: selector || '' }, { value: it[field] }],
    });
    const out = r.result && r.result.value ? r.result.value : { ok: false, error: 'fill failed' };
    log(`vault_fill item=${item} field=${field} origin=${it.origin} ok=${out.ok}`);
    return out;
  } finally { s.close(); }
}

const VAULT_TOOLS = [
  { name: 'vault_list', description: 'List saved logins for this browser (names, site origin, which fields exist). Never returns values.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'vault_fill', description: 'Type a saved login value into the open login form. Navigate to the site first. ' +
      'Only works on a tab whose origin equals the item origin. The value is never shown to you. Fill user, then password, then click the login button yourself.',
    inputSchema: { type: 'object', properties: {
      item: { type: 'string', description: 'Item name from vault_list' },
      field: { type: 'string', enum: ['user', 'password'] },
      selector: { type: 'string', description: 'Optional CSS selector of the input; default auto-detect' } },
    required: ['item', 'field'], additionalProperties: false } },
];

async function vaultCall(name, args) {
  if (name === 'vault_list') {
    const items = Object.entries(VAULT).map(([n, it]) => ({ item: n, origin: it.origin, user: !!it.user, password: !!it.password }));
    return { content: [{ type: 'text', text: JSON.stringify({ items }) }] };
  }
  if (name === 'vault_fill') {
    const r = await vaultFill(String(args.item || '').toLowerCase(), String(args.field || ''), args.selector ? String(args.selector) : '');
    return { isError: !r.ok, content: [{ type: 'text', text: r.ok ? `filled ${args.field} for ${args.item} (value hidden)` : r.error }] };
  }
  return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
}

// Minimal stateless Streamable HTTP MCP server (JSON responses).
async function handleVaultMcp(req, res, body) {
  if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  let msg; try { msg = JSON.parse(body || 'null'); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  const one = async (m) => {
    if (!m || m.id === undefined || m.id === null) return null; // notification
    if (m.method === 'initialize') return { jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: (m.params && m.params.protocolVersion) || '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'agent-desktop-vault', version: '1.0.0' } } };
    if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} };
    if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: { tools: VAULT_TOOLS } };
    if (m.method === 'tools/call') {
      try { return { jsonrpc: '2.0', id: m.id, result: await vaultCall(m.params.name, m.params.arguments || {}) }; }
      catch (e) { return { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'vault error: ' + e.message }] } }; }
    }
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } };
  };
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(one))).filter(Boolean) : await one(msg);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  json(res, 200, out);
}

// Redact vault values from anything the agent can read (snapshots, evaluate results, page text).
// Covers raw and JSON-escaped forms. Applied to every MCP response body.
const REDACT = [];
for (const [name, it] of Object.entries(VAULT)) {
  for (const f of ['user', 'password']) {
    const v = it[f]; if (!v || v.length < 4) continue;
    const forms = new Set([v, JSON.stringify(v).slice(1, -1), JSON.stringify(JSON.stringify(v).slice(1, -1)).slice(1, -1)]);
    for (const x of forms) REDACT.push([Buffer.from(x, 'utf8'), Buffer.from(`[vault:${name}.${f}]`, 'utf8')]);
  }
}
REDACT.sort((a, b) => b[0].length - a[0].length);
function redact(buf) {
  if (!REDACT.length) return buf;
  for (const [needle, repl] of REDACT) {
    let i = buf.indexOf(needle); if (i < 0) continue;
    const parts = []; let start = 0;
    while (i >= 0) { parts.push(buf.subarray(start, i), repl); start = i + needle.length; i = buf.indexOf(needle, start); }
    parts.push(buf.subarray(start)); buf = Buffer.concat(parts);
  }
  return buf;
}
const hasRedactions = () => REDACT.length > 0;

module.exports = { redact, hasRedactions, handleControl, humanHolds, blockedReply, rpcIds, handleVaultMcp, loadVault, controlState };
