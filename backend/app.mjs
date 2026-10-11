import http from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import path from 'node:path';

const derive = promisify(scrypt);
const scryptOptions = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export async function passwordHash(password) {
  const salt = randomBytes(24).toString('hex');
  return { salt, hash: (await derive(password, salt, 64, scryptOptions)).toString('hex') };
}
function normalIP(ip) { return String(ip).replace(/^::ffff:/, ''); }
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
  });
}
const closeServer = server => new Promise(resolve => {
  if (!server.listening) return resolve();
  server.close(resolve);
  server.closeAllConnections?.();
});

export async function createApp({ config, dataDir, webDir }) {
  if (!config.auth?.salt || !/^[a-f0-9]{128}$/.test(config.auth.hash ?? '')) throw new Error('Configure the administrator password first.');
  if (!net.isIP(config.printerHost)) throw new Error('printerHost must be the printer IP address.');
  const apiHost = config.apiHost ?? '127.0.0.1';
  // Put a TLS reverse proxy in front of this loopback-only API for remote use.
  if (!['127.0.0.1', '::1', 'localhost'].includes(apiHost)) throw new Error('The API must bind to loopback. Use an HTTPS reverse proxy for remote access.');
  const allowedSources = new Set((config.allowedSourceIPs ?? []).map(normalIP));
  if (config.gatewayEnabled && !allowedSources.size) throw new Error('Set allowedSourceIPs before enabling the print gateway.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const spool = path.join(dataDir, 'spool');
  await mkdir(spool, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'jobs.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, source_ip TEXT NOT NULL, received_at TEXT NOT NULL,
      document TEXT NOT NULL DEFAULT 'Print job', bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, completed_at TEXT, error TEXT
    ); CREATE INDEX IF NOT EXISTS jobs_received ON jobs(received_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_source ON jobs(source_ip);`);
  db.prepare("UPDATE jobs SET status='interrupted', error='Gateway restarted before delivery was confirmed.' WHERE status IN ('receiving','queued','forwarding')").run();
  // No automatic replay after a crash: a partial send could otherwise print twice.
  for (const name of await readdir(spool)) {
    if (/^[a-f0-9-]{36}\.prn$/.test(name)) await rm(path.join(spool, name), { force: true });
  }
  const sessions = new Map();
  const failures = new Map();
  const sockets = new Set();
  const receiving = new Set();
  const pending = [];
  let forwarding = false;
  let stopping = false;
  let closed = false;
  let gatewayAddress = null;
  const now = () => new Date().toISOString();
  const update = db.prepare('UPDATE jobs SET status=?, bytes=?, document=?, completed_at=?, error=? WHERE id=?');
  function change(job, status, error = null) {
    job.status = status;
    update.run(status, job.bytes, job.document, ['forwarded', 'failed', 'interrupted'].includes(status) ? now() : null, error, job.id);
  }
  async function pump() {
    if (forwarding || stopping) return;
    forwarding = true;
    try {
      while (pending.length && !stopping) {
        const job = pending.shift();
        change(job, 'forwarding');
        const destination = net.createConnection({ host: config.printerHost, port: config.printerPort ?? 9100 });
        sockets.add(destination);
        destination.setTimeout(config.forwardTimeoutMs ?? 60000, () => destination.destroy(new Error('Printer connection timed out.')));
        destination.on('error', () => {});
        destination.resume();
        try {
          await once(destination, 'connect');
          await pipeline(createReadStream(job.file), destination);
          change(job, 'forwarded');
        } catch {
          change(job, 'failed', 'Delivery to the printer could not be confirmed. Check the printer before sending the job again.');
        } finally {
          sockets.delete(destination);
          destination.destroy();
          await rm(job.file, { force: true });
        }
      }
    } finally { forwarding = false; }
  }
  const gateway = net.createServer({ allowHalfOpen: true }, client => {
    const source = normalIP(client.remoteAddress);
    if (stopping || !allowedSources.has(source) || receiving.size >= 8 || pending.length >= 100) { client.destroy(); return; }
    receiving.add(client);
    sockets.add(client);
    client.setTimeout(config.receiveTimeoutMs ?? 120000, () => client.destroy(new Error('Print submission timed out.')));
    client.on('error', () => {});
    const job = { id: randomUUID(), bytes: 0, source, document: 'Print job' };
    job.file = path.join(spool, job.id + '.prn');
    let inserted = false;
    let prefix = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        job.bytes += chunk.length;
        if (job.bytes > (config.maxJobBytes ?? 256 * 1024 * 1024)) return callback(new Error('Print submission exceeds the size limit.'));
        if (!inserted) {
          db.prepare("INSERT INTO jobs(id,source_ip,received_at,status) VALUES(?,?,?,'receiving')").run(job.id, source, now());
          inserted = true;
        }
        if (prefix.length < 16384) prefix = Buffer.concat([prefix, chunk.subarray(0, 16384 - prefix.length)]);
        callback(null, chunk);
      }
    });
    (async () => {
      try {
        await pipeline(client, meter, createWriteStream(job.file, { flags: 'wx', mode: 0o600 }));
        if (inserted) {
          const title = prefix.toString('latin1').match(/@PJL\s+JOB[^\r\n]*\bNAME\s*=\s*"([^"\r\n]{1,200})"/i)?.[1];
          if (title) job.document = title.replace(/[\x00-\x1f\x7f]/g, '').trim() || 'Print job';
          change(job, stopping ? 'interrupted' : 'queued');
          if (!stopping) { pending.push(job); void pump(); }
          else await rm(job.file, { force: true });
        } else await rm(job.file, { force: true });
      } catch {
        if (inserted) change(job, 'interrupted', 'The client did not complete its print submission.');
        await rm(job.file, { force: true });
      } finally {
        prefix = null;
        receiving.delete(client); sockets.delete(client); client.end(); client.destroy();
      }
    })().catch(error => { console.error('Print gateway operation failed:', error.code ?? error.name); });
  });
  const origins = new Set(config.allowedOrigins ?? []);
  function send(res, code, value, type = 'application/json; charset=utf-8') {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
  }
  async function jsonBody(req) {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('JSON content is required.');
    let size = 0; const parts = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new Error('Request is too large.');
      parts.push(chunk);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  function queryFilter(url) {
    const terms = []; const args = [];
    for (const [param, op] of [['from', '>='], ['to', '<=']]) {
      const raw = url.searchParams.get(param);
      if (raw) {
        const date = new Date(raw);
        if (!Number.isFinite(date.getTime())) throw new Error('Invalid date filter.');
        terms.push('received_at ' + op + ' ?'); args.push(date.toISOString());
      }
    }
    const source = url.searchParams.get('ip');
    if (source) { terms.push('source_ip=?'); args.push(source); }
    const q = url.searchParams.get('q')?.trim().slice(0, 200);
    if (q) {
      const pattern = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
      terms.push("(source_ip LIKE ? ESCAPE '\\' OR document LIKE ? ESCAPE '\\')"); args.push(pattern, pattern);
    }
    return { where: terms.length ? ' WHERE ' + terms.join(' AND ') : '', args };
  }
  const api = http.createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) return send(res, 403, { error: 'This website is not allowed to access the gateway.' });
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Private-Network': 'true' }); return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const address = normalIP(req.socket.remoteAddress);
        const failure = failures.get(address);
        if (failure && failure.until > Date.now() && failure.count >= 5) return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
        if (failure?.until <= Date.now()) failures.delete(address);
        const body = await jsonBody(req);
        if (typeof body.password !== 'string' || body.password.length > 1024 || typeof body.username !== 'string') return send(res, 400, { error: 'Enter your username and password.' });
        const actual = await derive(body.password, config.auth.salt, 64, scryptOptions);
        const valid = timingSafeEqual(actual, Buffer.from(config.auth.hash, 'hex'));
        if (!valid || body.username !== config.username) {
          const count = (failures.get(address)?.count ?? 0) + 1;
          failures.set(address, { count, until: Date.now() + 15 * 60 * 1000 });
          return send(res, 401, { error: 'Incorrect username or password.' });
        }
        failures.delete(address);
        for (const [token, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(token);
        if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(48).toString('base64url');
        const expiresAt = Date.now() + (config.sessionLifetimeMs ?? 8 * 60 * 60 * 1000);
        sessions.set(token, { expiresAt });
        return send(res, 200, { token, expiresAt, username: config.username });
      }
      if (url.pathname.startsWith('/api/')) {
        const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
        const session = sessions.get(token);
        if (!session || session.expiresAt <= Date.now()) { sessions.delete(token); return send(res, 401, { error: 'Please sign in to view print history.' }); }
        if (url.pathname === '/api/logout' && req.method === 'POST') { sessions.delete(token); return send(res, 200, { ok: true }); }
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
        const { where, args } = queryFilter(url);
        if (url.pathname === '/api/dashboard') {
          const summary = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(bytes),0) bytes,
            COALESCE(SUM(status='forwarded'),0) forwarded, COALESCE(SUM(status IN ('failed','interrupted')),0) failed,
            COALESCE(SUM(status IN ('receiving','queued','forwarding')),0) pending, COUNT(DISTINCT source_ip) devices FROM jobs${where}`).get(...args);
          const devices = db.prepare(`SELECT source_ip,COUNT(*) jobs,SUM(bytes) bytes,MAX(received_at) last_seen,
            SUM(status='forwarded') forwarded FROM jobs${where} GROUP BY source_ip ORDER BY jobs DESC,source_ip`).all(...args);
          const daily = db.prepare(`SELECT substr(received_at,1,10) day,COUNT(*) jobs FROM jobs${where} GROUP BY day ORDER BY day`).all(...args);
          return send(res, 200, { summary, devices, daily, printer: { host: config.printerHost, name: config.printerName ?? 'Network printer' }, gateway: { enabled: !!gatewayAddress, listenPort: gatewayAddress?.port ?? null, publicAddress: config.gatewayPublicAddress ?? null }, updatedAt: now() });
        }
        if (url.pathname === '/api/jobs') {
          const page = Math.max(1, Math.min(1000000, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1));
          const total = db.prepare('SELECT COUNT(*) total FROM jobs' + where).get(...args).total;
          const jobs = db.prepare(`SELECT * FROM jobs${where} ORDER BY received_at DESC,id DESC LIMIT 25 OFFSET ?`).all(...args, (page - 1) * 25);
          return send(res, 200, { total, page, pageSize: 25, jobs });
        }
        if (url.pathname === '/api/export') {
          const rows = db.prepare(`SELECT * FROM jobs${where} ORDER BY received_at DESC LIMIT 50000`).all(...args);
          const lines = ['Received (UTC),Source IP,Document,Bytes,Status,Delivered (UTC),Error', ...rows.map(row => [row.received_at, row.source_ip, row.document, row.bytes, row.status, row.completed_at, row.error].map(csvCell).join(','))];
          res.setHeader('Content-Disposition', 'attachment; filename="print-jobs.csv"');
          return send(res, 200, '\uFEFF' + lines.join('\r\n'), 'text/csv; charset=utf-8');
        }
        return send(res, 404, { error: 'Unknown API endpoint.' });
      }
      if (req.method !== 'GET' || !webDir) return send(res, 404, { error: 'Not found.' });
      const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/config.js': ['config.js', 'text/javascript; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const file = staticFiles[url.pathname];
      if (!file) return send(res, 404, { error: 'Not found.' });
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      send(res, 200, await readFile(path.join(webDir, file[0])), file[1]);
    } catch (error) {
      if (!res.headersSent) send(res, 400, { error: error instanceof SyntaxError ? 'Invalid request.' : 'Unable to complete this request.' });
      else res.end();
    }
  });
  api.requestTimeout = 15000; api.headersTimeout = 10000; api.maxHeadersCount = 30;
  const apiAddress = await listen(api, config.apiPort ?? 8765, apiHost);
  origins.add(`http://${apiAddress.address === '::1' ? '[::1]' : apiAddress.address}:${apiAddress.port}`);
  origins.add(`http://localhost:${apiAddress.port}`);
  try {
    if (config.gatewayEnabled) gatewayAddress = await listen(gateway, config.gatewayPort ?? 19100, config.gatewayHost ?? '0.0.0.0');
  } catch (error) { await closeServer(api); db.close(); throw error; }
  return {
    apiAddress, gatewayAddress,
    async close() {
      if (closed) return;
      closed = true;
      stopping = true;
      for (const socket of sockets) socket.destroy();
      await Promise.all([closeServer(api), closeServer(gateway)]);
      while (forwarding || receiving.size) await new Promise(resolve => setTimeout(resolve, 10));
      for (const job of pending.splice(0)) { change(job, 'interrupted', 'Gateway stopped before delivery.'); await rm(job.file, { force: true }); }
      db.close();
    }
  };
}
