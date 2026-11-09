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
