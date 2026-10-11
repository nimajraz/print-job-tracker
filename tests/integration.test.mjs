import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp, passwordHash } from '../backend/app.mjs';

const password = 'integration-only-credential';
const auth = await passwordHash(password);
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'print-ledger-test-'));
  const received = [];
  const printer = net.createServer(socket => {
    const chunks = [];
    socket.on('data', c => chunks.push(c));
    socket.on('end', () => { if (chunks.length) received.push(Buffer.concat(chunks)); });
  });
  printer.listen(0, '127.0.0.1'); await once(printer, 'listening');
  const config = { username: 'admin', auth, printerHost: '127.0.0.1', printerPort: printer.address().port, apiPort: 0, gatewayPort: 0, gatewayHost: '127.0.0.1', gatewayEnabled: true, allowedSourceIPs: ['127.0.0.1', '127.0.0.2'], allowedOrigins: ['https://nimajraz.github.io'], receiveTimeoutMs: 3000, forwardTimeoutMs: 3000, ...overrides };
  let app = await createApp({ config, dataDir });
  const base = () => 'http://127.0.0.1:' + app.apiAddress.port;
  async function api(route, { token, ...options } = {}) {
    const headers = { ...options.headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    return fetch(base() + route, { ...options, headers, signal: AbortSignal.timeout(5000) });
  }
  async function login(pass = password) {
    return api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pass }) });
  }
  async function send(payload, localAddress = '127.0.0.1') {
    const socket = net.createConnection({ host: '127.0.0.1', port: app.gatewayAddress.port, localAddress });
    socket.on('error', () => {}); await once(socket, 'connect');
    const finished = once(socket, 'close'); socket.end(payload); await finished;
  }
  async function waitFor(predicate) {
    const end = Date.now() + 4500;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error('Expected gateway state did not arrive.');
  }
  async function restart() { await app.close(); app = await createApp({ config, dataDir }); }
  t.after(async () => { await app.close(); await new Promise(r => printer.close(r)); await rm(dataDir, { recursive: true, force: true }); });
  return { api, login, send, waitFor, received, dataDir, restart, config, get app() { return app; } };
}

test('private history requires authentication; logout revokes session', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/jobs')).status, 401);
  assert.equal((await f.api('/api/dashboard')).status, 401);
  assert.equal((await f.api('/api/export')).status, 401);
  assert.equal((await f.login('incorrect')).status, 401);
  const response = await f.login(); assert.equal(response.status, 200);
  const { token } = await response.json(); assert.ok(token.length > 40);
  assert.equal((await f.api('/api/jobs', { token })).status, 200);
  assert.equal((await f.api('/api/logout', { token, method: 'POST' })).status, 200);
  assert.equal((await f.api('/api/jobs', { token })).status, 401);
});
test('foreign origins are rejected and approved origin preflight is exact', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/login', { method: 'POST', headers: { Origin: 'https://attacker.example' } })).status, 403);
  const response = await f.api('/api/jobs', { method: 'OPTIONS', headers: { Origin: 'https://nimajraz.github.io' } });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), 'https://nimajraz.github.io');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});
test('complete print bytes are forwarded and counted by actual source IP', async t => {
  const f = await fixture(t); const { token } = await (await f.login()).json();
  const payload = Buffer.from('\x1b%-12345X@PJL JOB NAME="Report Alpha"\r\nPRINT-DATA\r\n\x1b%-12345X');
  await f.send(payload); await f.send(Buffer.from('SECOND-JOB'), '127.0.0.2');
  await f.waitFor(() => f.received.length === 2);
  await f.waitFor(async () => (await (await f.api('/api/dashboard', { token })).json()).summary.forwarded === 2);
  assert.deepEqual(f.received[0], payload);
  const dashboard = await (await f.api('/api/dashboard', { token })).json();
  assert.equal(dashboard.summary.total, 2); assert.equal(dashboard.summary.devices, 2);
  assert.deepEqual(dashboard.devices.map(d => d.source_ip).sort(), ['127.0.0.1', '127.0.0.2']);
  const jobs = await (await f.api('/api/jobs?ip=127.0.0.1', { token })).json();
  assert.equal(jobs.jobs[0].document, 'Report Alpha'); assert.equal(jobs.jobs[0].bytes, payload.length);
  assert.equal(jobs.jobs[0].status, 'forwarded');
  await f.waitFor(async () => (await readdir(path.join(f.dataDir, 'spool'))).length === 0);
});
test('jobs persist after restart; old sessions do not', async t => {
  const f = await fixture(t); const { token } = await (await f.login()).json();
  await f.send(Buffer.from('PERSISTED')); await f.waitFor(() => f.received.length === 1);
  await f.waitFor(async () => (await (await f.api('/api/dashboard', { token })).json()).summary.forwarded === 1);
  await f.restart(); assert.equal((await f.api('/api/jobs', { token })).status, 401);
  const fresh = await (await f.login()).json(); const result = await (await f.api('/api/jobs', { token: fresh.token })).json();
  assert.equal(result.total, 1); assert.equal(result.jobs[0].status, 'forwarded');
});
test('blocked source addresses cannot submit jobs', async t => {
  const f = await fixture(t, { allowedSourceIPs: ['127.0.0.2'] });
  const { token } = await (await f.login()).json();
  const socket = net.createConnection({ host: '127.0.0.1', port: f.app.gatewayAddress.port }); socket.on('error', () => {});
  const ended = new Promise(resolve => { socket.once('error', resolve); socket.once('close', resolve); }); socket.end('BLOCKED'); await ended;
  const result = await (await f.api('/api/jobs', { token })).json(); assert.equal(result.total, 0); assert.equal(f.received.length, 0);
});
test('oversized upload is recorded but never forwarded', async t => {
  const f = await fixture(t, { maxJobBytes: 12 }); const { token } = await (await f.login()).json();
  const socket = net.createConnection({ host: '127.0.0.1', port: f.app.gatewayAddress.port }); socket.on('error', () => {}); await once(socket, 'connect');
  socket.write('FIRST'); await new Promise(r => setTimeout(r, 30)); socket.end('TOO-MUCH-ADDITIONAL-DATA');
  await new Promise(r => socket.once('close', r));
  await f.waitFor(async () => (await (await f.api('/api/dashboard', { token })).json()).summary.failed === 1);
  assert.equal(f.received.length, 0);
  const result = await (await f.api('/api/jobs', { token })).json(); assert.equal(result.jobs[0].status, 'interrupted');
});
test('failed printer delivery is recorded without an automatic retry', async t => {
  const unused = net.createServer(); unused.listen(0, '127.0.0.1'); await once(unused, 'listening'); const unusedPort = unused.address().port; await new Promise(r => unused.close(r));
  const f = await fixture(t, { printerPort: unusedPort }); const { token } = await (await f.login()).json();
  await f.send(Buffer.from('UNREACHABLE'));
  await f.waitFor(async () => (await (await f.api('/api/dashboard', { token })).json()).summary.failed === 1);
  const result = await (await f.api('/api/jobs', { token })).json(); assert.equal(result.jobs[0].status, 'failed');
  assert.equal(f.received.length, 0); await f.restart(); assert.equal(f.received.length, 0);
});
test('CSV escapes formula-like names, and SQL metacharacters stay literal', async t => {
  const f = await fixture(t); const { token } = await (await f.login()).json();
  await f.send(Buffer.from('@PJL JOB NAME="=SUM(1,2)"\r\nDATA'));
  await f.waitFor(() => f.received.length === 1);
  const csv = await (await f.api('/api/export', { token })).text(); assert.match(csv, /'=SUM\(1,2\)/);
  const query = await (await f.api('/api/jobs?q=' + encodeURIComponent("%' OR 1=1--"), { token })).json(); assert.equal(query.total, 0);
  assert.equal((await f.api('/api/jobs?from=invalid-date', { token })).status, 400);
});
test('sign-in failures are rate limited', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 5; n++) assert.equal((await f.login('wrong')).status, 401);
  assert.equal((await f.login()).status, 429);
});
test('expired sessions cannot read job metadata', async t => {
  const f = await fixture(t, { sessionLifetimeMs: 20 }); const { token } = await (await f.login()).json();
  await new Promise(r => setTimeout(r, 40)); assert.equal((await f.api('/api/dashboard', { token })).status, 401);
});
test('health is public but reveals no printer, source, or job metadata', async t => {
  const f = await fixture(t); const response = await f.api('/api/health'); assert.deepEqual(await response.json(), { ok: true });
});
test('empty probe connections do not become print jobs', async t => {
  const f = await fixture(t); const { token } = await (await f.login()).json(); await f.send(Buffer.alloc(0));
  const result = await (await f.api('/api/jobs', { token })).json(); assert.equal(result.total, 0); assert.equal(f.received.length, 0);
});
test('non-loopback API binding and missing print allowlist are rejected', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'print-ledger-invalid-'));
  try {
    await assert.rejects(createApp({ config: { auth, printerHost: '127.0.0.1', apiHost: '0.0.0.0' }, dataDir: dir }), /loopback/);
    await assert.rejects(createApp({ config: { auth, printerHost: '127.0.0.1', gatewayEnabled: true }, dataDir: dir }), /allowedSourceIPs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('restart marks ambiguous jobs interrupted instead of replaying them', async t => {
  const f = await fixture(t); await f.app.close();
  const database = new DatabaseSync(path.join(f.dataDir, 'jobs.sqlite'));
  database.prepare("INSERT INTO jobs(id,source_ip,received_at,status) VALUES('prior','127.0.0.1',?,'forwarding')").run(new Date().toISOString()); database.close();
  // Restart helper is not used because this fixture was explicitly closed.
  const next = await createApp({ config: f.config, dataDir: f.dataDir });
  try {
    const login = await fetch('http://127.0.0.1:' + next.apiAddress.port + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
    const { token } = await login.json(); const jobs = await (await fetch('http://127.0.0.1:' + next.apiAddress.port + '/api/jobs', { headers: { Authorization: 'Bearer ' + token } })).json();
    assert.equal(jobs.jobs[0].status, 'interrupted'); assert.equal(f.received.length, 0);
  } finally { await next.close(); }
});
