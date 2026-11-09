// Regression test for gateway.js: hop-by-hop headers must not reach upstream, auth must hold.
// Run: node --test test/gateway.test.js   (Node >= 20, no deps)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TOKEN = 'a'.repeat(40);
function freePort() {
  return new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
}
function req(port, opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, agent: false, ...opts }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

test('gateway', async (t) => {
  const seen = [];
  const upstream = http.createServer((q, s) => {
    seen.push(q.headers);
    let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
      s.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'keep-alive': 'timeout=5', 'x-up': '1' });
      s.end(JSON.stringify({ ok: true, len: b.length }));
    });
  });
  const upPort = await freePort(); await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));
  const gwPort = await freePort();
  const gw = spawn(process.execPath, [path.join(__dirname, '..', 'gateway.js')], {
    env: { ...process.env, PORT: String(gwPort), PLAYWRIGHT_MCP_PORT: String(upPort), CUA_MCP_PORT: String(upPort), PW_MCP_TOKEN: TOKEN, CUA_MCP_TOKEN: '', VNC_WEB_PORT: String(upPort) },
    stdio: 'ignore',
  });
  t.after(() => { gw.kill(); upstream.close(); });
  for (let i = 0; i < 50; i++) { try { await req(gwPort, { path: '/healthz' }); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }

  await t.test('no token -> 401', async () => {
    assert.strictEqual((await req(gwPort, { method: 'POST', path: '/pw/mcp' }, '{}')).status, 401);
  });
  await t.test('wrong token -> 401', async () => {
    const r = await req(gwPort, { method: 'POST', path: '/pw/mcp', headers: { authorization: 'Bearer ' + 'b'.repeat(40) } }, '{}');
    assert.strictEqual(r.status, 401);
  });
  await t.test('unset token -> 503', async () => {
    const r = await req(gwPort, { method: 'POST', path: '/cua/mcp', headers: { authorization: 'Bearer ' + TOKEN } }, '{}');
    assert.strictEqual(r.status, 503);
  });
  await t.test('hop-by-hop headers stripped both ways, 100 sequential + 20 parallel all 200', async () => {
    const headers = {
      authorization: 'Bearer ' + TOKEN, connection: 'close, x-drop-me', 'keep-alive': 'timeout=1', te: 'trailers',
      'proxy-connection': 'close', upgrade: 'h2c', 'x-drop-me': '1', 'x-keep': '1', 'content-type': 'application/json',
    };
    const one = () => req(gwPort, { method: 'POST', path: '/pw/mcp', headers }, '{"x":1}');
    for (let i = 0; i < 100; i++) assert.strictEqual((await one()).status, 200, `seq ${i}`);
    const par = await Promise.all(Array.from({ length: 20 }, one));
    par.forEach((r, i) => assert.strictEqual(r.status, 200, `par ${i}`));
    const h = seen[seen.length - 1];
    for (const k of ['authorization', 'keep-alive', 'te', 'proxy-connection', 'upgrade', 'x-drop-me', 'trailer']) assert.ok(!(k in h), `upstream got ${k}`);
    assert.notStrictEqual(h.connection, 'close, x-drop-me');
    assert.strictEqual(h['x-keep'], '1');
    const r = await one();
    assert.ok(!('keep-alive' in r.headers), 'response leaked keep-alive');
    assert.strictEqual(r.headers['x-up'], '1');
  });
});

test('control lock + vault', async (t) => {
  const calls = [];
  const upstream = http.createServer((q, s) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { calls.push(b); s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"jsonrpc":"2.0","id":1,"result":{"up":true}}'); }); });
  const upPort = await freePort(); await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));
  const gwPort = await freePort();
  const gw = spawn(process.execPath, [path.join(__dirname, '..', 'gateway.js')], {
    env: { ...process.env, PORT: String(gwPort), PLAYWRIGHT_MCP_PORT: String(upPort), CUA_MCP_PORT: String(upPort), PW_MCP_TOKEN: TOKEN, CUA_MCP_TOKEN: TOKEN,
      VNC_WEB_PORT: String(upPort), CDP_PORT: '1', CONTROL_IDLE_SEC: '2',
      VAULT_METABASE_USER: 'u@example.com', VAULT_METABASE_PASSWORD: 'SECRETVALUE', VAULT_METABASE_ORIGIN: 'https://metabase-internal.qiscus.com/',
      VAULT_BAD_USER: 'x', VAULT_BAD_ORIGIN: 'http://insecure.example' },
    stdio: 'ignore',
  });
  t.after(() => { gw.kill(); upstream.close(); });
  for (let i = 0; i < 50; i++) { try { await req(gwPort, { path: '/healthz' }); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
  const auth = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
  const call = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_navigate', arguments: {} } });
  const ctl = (p, h = { 'x-agent-desktop': '1' }) => req(gwPort, { method: 'POST', path: '/control/' + p, headers: h });

  await t.test('agent passes while agent holds', async () => {
    const r = await req(gwPort, { method: 'POST', path: '/pw/mcp', headers: auth }, call);
    assert.match(r.body, /"up":true/);
  });
  await t.test('take requires csrf header', async () => {
    assert.strictEqual((await ctl('take', {})).status, 403);
  });
  await t.test('human take blocks tools/call on pw and cua, not other methods', async () => {
    const st = JSON.parse((await ctl('take', { 'x-agent-desktop': '1', 'x-auth-request-email': 'ganjar@qiscus.com' })).body);
    assert.strictEqual(st.holder, 'human'); assert.strictEqual(st.by, 'ganjar@qiscus.com');
    const n = calls.length;
    for (const p of ['/pw/mcp', '/cua/mcp']) {
      const r = JSON.parse((await req(gwPort, { method: 'POST', path: p, headers: auth }, call)).body);
      assert.strictEqual(r.id, 7); assert.strictEqual(r.result.isError, true); assert.match(r.result.content[0].text, /human is controlling/);
    }
    assert.strictEqual(calls.length, n, 'blocked call reached upstream');
    const l = await req(gwPort, { method: 'POST', path: '/pw/mcp', headers: auth }, JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }));
    assert.match(l.body, /"up":true/);
  });
  await t.test('release gives control back', async () => {
    assert.strictEqual(JSON.parse((await ctl('release')).body).holder, 'agent');
    assert.match((await req(gwPort, { method: 'POST', path: '/pw/mcp', headers: auth }, call)).body, /"up":true/);
  });
  await t.test('auto release after idle', async () => {
    await ctl('take'); await new Promise((r) => setTimeout(r, 2500));
    assert.strictEqual(JSON.parse((await req(gwPort, { path: '/control/state' })).body).holder, 'agent');
  });
  await t.test('vault mcp: auth, list without values, bad origin dropped', async () => {
    assert.strictEqual((await req(gwPort, { method: 'POST', path: '/vault/mcp' }, '{}')).status, 401);
    const init = JSON.parse((await req(gwPort, { method: 'POST', path: '/vault/mcp', headers: auth }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }))).body);
    assert.strictEqual(init.result.serverInfo.name, 'agent-desktop-vault');
    const alias = JSON.parse((await req(gwPort, { method: 'POST', path: '/pw/mcp?server=vault', headers: auth }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))).body);
    assert.strictEqual(alias.result.serverInfo.name, 'agent-desktop-vault');
    assert.strictEqual((await req(gwPort, { method: 'POST', path: '/pw/mcp?server=vault' }, '{}')).status, 401);
    const tl = JSON.parse((await req(gwPort, { method: 'POST', path: '/vault/mcp', headers: auth }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).body);
    assert.deepStrictEqual(tl.result.tools.map((x) => x.name), ['vault_list', 'vault_fill']);
    const raw = (await req(gwPort, { method: 'POST', path: '/vault/mcp', headers: auth }, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vault_list', arguments: {} } }))).body;
    assert.ok(!raw.includes('SECRETVALUE') && !raw.includes('u@example.com'), 'vault_list leaked a value');
    const items = JSON.parse(JSON.parse(raw).result.content[0].text).items;
    assert.deepStrictEqual(items, [{ item: 'metabase', origin: 'https://metabase-internal.qiscus.com', user: true, password: true }]);
    const f = JSON.parse((await req(gwPort, { method: 'POST', path: '/vault/mcp', headers: auth }, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vault_fill', arguments: { item: 'metabase', field: 'password' } } }))).body);
    assert.strictEqual(f.result.isError, true); assert.ok(!JSON.stringify(f).includes('SECRETVALUE'));
  });
});

test('vault values are redacted from MCP responses', async (t) => {
  const SECRET = 'Pw"With\\Quote77';
  const upstream = http.createServer((q, s) => { q.resume(); q.on('end', () => {
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `textbox "Password": ${SECRET} user=leakuser99 nested=${JSON.stringify(SECRET)}` }] } }) + '\n\n');
  }); });
  const upPort = await freePort(); await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));
  const gwPort = await freePort();
  const gw = spawn(process.execPath, [path.join(__dirname, '..', 'gateway.js')], {
    env: { ...process.env, PORT: String(gwPort), PLAYWRIGHT_MCP_PORT: String(upPort), CUA_MCP_PORT: String(upPort), PW_MCP_TOKEN: TOKEN, CUA_MCP_TOKEN: TOKEN, VNC_WEB_PORT: String(upPort),
      VAULT_M_USER: 'leakuser99', VAULT_M_PASSWORD: SECRET, VAULT_M_ORIGIN: 'https://example.com' }, stdio: 'ignore' });
  t.after(() => { gw.kill(); upstream.close(); });
  for (let i = 0; i < 50; i++) { try { await req(gwPort, { path: '/healthz' }); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
  for (const p of ['/pw/mcp', '/cua/mcp']) {
    const r = await req(gwPort, { method: 'POST', path: p, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' } }, '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}');
    assert.ok(!r.body.includes('Quote77') && !r.body.includes('leakuser99'), `${p} leaked: ${r.body}`);
    assert.match(r.body, /\[vault:m\.password\]/); assert.match(r.body, /\[vault:m\.user\]/);
  }
});
