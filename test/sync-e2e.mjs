#!/usr/bin/env node
// Desktop sync pairing check (S2). Boots the real server against a scratch
// Postgres database with the demo client, then pairs desktops and checks the
// device token's reach: it lists clients on the sync routes, is refused on
// every other route, stops when revoked or when its user is deactivated, and
// a reviewer's device reads but does not write. Pairing under single sign-on
// with oidc_only on is in sso-e2e.mjs.
//
//   npm run test:sync-e2e        (from server/ or the root)
//
// Prerequisites: a Postgres the dev credentials can CREATE DATABASE on
// (docker compose up -d gives one), server/node_modules installed.
//   E2E_PG_ADMIN_URL   admin connection (default: the compose dev instance)
//   E2E_KEEP_DB=1      leave the scratch database behind for inspection
//   E2E_VERBOSE=1      stream the server's output instead of buffering it

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = require('pg');

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVER = path.join(ROOT, 'server');
const KNEX_CLI = path.join(SERVER, 'node_modules', 'knex', 'bin', 'cli.js');
const TSX_IMPORT = ['--import', 'tsx'];

const ADMIN_URL = process.env.E2E_PG_ADMIN_URL
  ?? `postgres://vibetb:localdev123@127.0.0.1:${process.env.POSTGRES_PUBLISH_PORT ?? '5432'}/postgres`;
const VERBOSE = process.env.E2E_VERBOSE === '1';
const KEEP_DB = process.env.E2E_KEEP_DB === '1';
const ADMIN_PASSWORD = 'E2eAdmin!2026';
const DB_PREFIX = 'vibe_tb_sync_e2e_';

// ─────────────────────────────────────────────────────────────── plumbing

const t0 = Date.now();
const log = (line) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${line}`);
const lines = [];
function capture(prefix, chunk) {
  for (const l of String(chunk).split(/\r?\n/)) {
    if (!l) continue;
    if (VERBOSE) console.log(`${prefix} ${l}`);
    lines.push(`${prefix} ${l}`);
    if (lines.length > 400) lines.shift();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function childEnv(extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS',
    'ProgramFiles', 'ProgramFiles(x86)'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'APP_BASE_URL', 'ALLOWED_ORIGIN', 'VIBE_AI_MODE', 'MAIL_TRANSPORT']) env[k] = '';
  return { ...env, ...extra };
}

function run(cmd, args, { cwd, env, prefix }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stdout.on('data', (c) => capture(prefix, c));
    child.stderr.on('data', (c) => { stderr += c; capture(prefix, c); });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

function killTree(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      return;
    }
    // The server runs in its own process group (spawned detached): end the
    // whole group, the Chromium a PDF render started included, and kill it
    // if it has not gone in 5 s (it would otherwise keep CI waiting).
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
    group('SIGTERM');
    setTimeout(() => group('SIGKILL'), 5000).unref();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────── database

let admin;
let dbc;
let dbName;
let dbUrl;

async function createScratchDb() {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const stale = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE '${DB_PREFIX}%'`);
  for (const r of stale.rows) await admin.query(`DROP DATABASE "${r.datname}" WITH (FORCE)`);
  dbName = `${DB_PREFIX}${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  dbUrl = u.toString();
  log(`created ${dbName}`);
}

async function dropScratchDb() {
  if (dbc) { await dbc.end().catch(() => {}); dbc = null; }
  if (admin && dbName && !KEEP_DB) {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch((e) => console.error('drop failed:', e.message));
    log(`dropped ${dbName}`);
  } else if (KEEP_DB) log(`kept ${dbName} (E2E_KEEP_DB=1)`);
  if (admin) { await admin.end().catch(() => {}); admin = null; }
}

const sql = async (text, params = []) => (await dbc.query(text, params)).rows;
const one = async (text, params = []) => (await sql(text, params))[0];

// ─────────────────────────────────────────────────────────────── server

const secrets = { JWT_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex') };
let server = null;

async function startServer() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...TSX_IMPORT, 'src/app.ts'], {
    cwd: SERVER,
    env: childEnv({ ...secrets, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: dbUrl, MIGRATIONS_AUTO: 'false', VIBE_AUTH_MODE: 'local', SYNC_PART_BYTES: String(1024 * 1024) }),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (c) => capture('[server]', c));
  child.stderr.on('data', (c) => capture('[server]', c));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const code = await Promise.race([exited, sleep(150).then(() => null)]);
    if (code !== null) throw new Error(`server exited with code ${code} before becoming healthy`);
    if (await fetch(`${base}/api/v1/health`).then((r) => r.status === 200).catch(() => false)) break;
    if (Date.now() > deadline) throw new Error('server did not become healthy in 30 s');
  }
  server = { child, base };
  log(`server up on ${base}`);
}

async function api(p, { method = 'GET', token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form !== undefined) body = form;
  const res = await fetch(server.base + p, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) { try { data = JSON.parse(buf.toString('utf8')); } catch { /* not json */ } }
  return { status: res.status, headers: res.headers, buf, json: data, text: data ? JSON.stringify(data) : `<${buf.length} bytes>` };
}

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; log(`ok   ${name}`); } catch (err) { log(`FAIL ${name}`); throw err; }
}


// ─────────────────────────────────────────────────────────────── scenarios

async function signIn(username, password, newPassword) {
  let login = await api('/api/v1/auth/login', { method: 'POST', json: { username, password } });
  assert.equal(login.status, 200, login.text);
  if (newPassword) {
    const rot = await api('/api/v1/auth/change-password', { method: 'POST', token: login.json.data.token, json: { currentPassword: password, newPassword } });
    assert.equal(rot.status, 200, rot.text);
    login = await api('/api/v1/auth/login', { method: 'POST', json: { username, password: newPassword } });
    assert.equal(login.status, 200, login.text);
  }
  return login.json.data.token;
}

async function pairWith(sessionToken, deviceName) {
  const c = await api('/api/v1/desktop-sync/codes', { method: 'POST', token: sessionToken });
  assert.equal(c.status, 201, c.text);
  assert.match(c.json.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const p = await api('/api/v1/sync/pair', { method: 'POST', json: { code: c.json.data.code.toLowerCase(), deviceName } });
  assert.equal(p.status, 201, p.text);
  assert.match(p.json.data.token, /^vtbsync_/);
  return { code: c.json.data.code, token: p.json.data.token, deviceId: p.json.data.device.id };
}

const unzipper = require('unzipper');

/** Polls a sync job until it is done or failed (30 s). */
async function waitJob(token, jobId) {
  for (let i = 0; i < 200; i++) {
    const j = await api(`/api/v1/sync/jobs/${jobId}`, { token });
    assert.equal(j.status, 200, j.text);
    if (j.json.data.state === 'done' || j.json.data.state === 'failed') return j.json.data;
    await sleep(150);
  }
  throw new Error('job did not finish in 30 s');
}

/** The manifest inside a .tbak. */
async function manifestOf(buf) {
  const dir = await unzipper.Open.buffer(buf);
  const entry = dir.files.find((f) => f.path === 'manifest.json');
  assert.ok(entry, 'manifest.json in the archive');
  return JSON.parse((await entry.buffer()).toString('utf8'));
}

const archiver = require('archiver');
const { createHash, randomUUID } = await import('node:crypto');
const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');

/**
 * What a desktop does to a pulled archive before sending it back: change its
 * tables, then write the zip again with each entry's checksum.
 */
async function rewriteArchive(buf, mutate, afterEntries) {
  const dir = await unzipper.Open.buffer(buf);
  const entries = new Map();
  for (const f of dir.files) if (f.type === 'File') entries.set(f.path, await f.buffer());
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  const tables = {};
  for (const [name, b] of entries) if (name.startsWith('tables/')) tables[name.slice(7, -5)] = JSON.parse(b.toString('utf8'));
  // Other entries (files/<document id>) can be changed too.
  await mutate(tables, manifest, entries);
  manifest.entries = {};
  const out = new Map();
  for (const [t, rows] of Object.entries(tables)) out.set(`tables/${t}.json`, Buffer.from(JSON.stringify(rows, null, 2), 'utf8'));
  for (const [name, b] of entries) if (!name.startsWith('tables/') && name !== 'manifest.json') out.set(name, b);
  for (const [name, b] of out) manifest.entries[name] = { sha256: sha256Hex(b), size: b.length };
  if (afterEntries) afterEntries(manifest);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const z = archiver('zip', { zlib: { level: 1 } });
    z.on('data', (c) => chunks.push(c));
    z.on('end', () => resolve(Buffer.concat(chunks)));
    z.on('error', reject);
    for (const [name, b] of out) z.append(b, { name });
    z.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    void z.finalize();
  });
}

/** The adjusted trial balance totals a desktop sends (`sync.totals`): TB rows plus book and transfer entries. */
function totalsOf(t) {
  const types = new Map(t.journal_entries.map((j) => [j.id, j.entry_type]));
  // As the view: entries count only on accounts with a trial balance row.
  const tbAccounts = new Set(t.trial_balance.map((r) => r.account_id));
  let d = 0n, c = 0n;
  for (const r of t.trial_balance) { d += BigInt(r.unadjusted_debit ?? 0); c += BigInt(r.unadjusted_credit ?? 0); }
  for (const l of t.journal_entry_lines) {
    if (!['book', 'trans'].includes(types.get(l.journal_entry_id)) || !tbAccounts.has(l.account_id)) continue;
    d += BigInt(l.debit ?? 0); c += BigInt(l.credit ?? 0);
  }
  return { bookDebit: String(d), bookCredit: String(c) };
}

/** Asks for the parts to be joined and polls until done; returns { complete, joinError }. */
async function completeAndWait(token, uploadId) {
  const c = await api(`/api/v1/sync/uploads/${uploadId}/complete`, { method: 'POST', token });
  if (c.status !== 200 && c.status !== 202) return { status: c.status, error: c.json?.error };
  for (let i = 0; i < 200; i++) {
    const st = await api(`/api/v1/sync/uploads/${uploadId}`, { token });
    if (st.json.data.complete || st.json.data.joinError) return { complete: st.json.data.complete, joinError: st.json.data.joinError };
    await sleep(100);
  }
  throw new Error('join did not finish');
}

/** Uploads a buffer in parts and completes it; returns the upload id. */
async function uploadBuf(token, buf) {
  const start = await api('/api/v1/sync/uploads', { method: 'POST', token, json: { size: buf.length, sha256: sha256Hex(buf) } });
  assert.equal(start.status, 201, start.text);
  const { uploadId, partBytes, parts } = start.json.data;
  for (let n = 0; n < parts; n++) {
    const r = await fetch(`${server.base}/api/v1/sync/uploads/${uploadId}/parts/${n}`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: buf.subarray(n * partBytes, Math.min(buf.length, (n + 1) * partBytes)),
    });
    assert.equal(r.status, 200, await r.text());
  }
  const done = await completeAndWait(token, uploadId);
  assert.equal(done.complete, true, JSON.stringify(done));
  return uploadId;
}

/**
 * Desktop sync S5: every call goes through a proxy that behaves like
 * Cloudflare at a smaller scale: a request body over BODY_CAP is refused
 * (413), and a response that has not started within RESPONSE_MS is cut
 * (524). Upload parts are 1 MB here (SYNC_PART_BYTES), so the cap sits just
 * above them; nothing may hold a request open for long.
 */
const PROXY_BODY_CAP = 1.5 * 1024 * 1024;
const PROXY_RESPONSE_MS = 15_000;
/** Other routes (a web finalize renders a PDF) get Cloudflare's own ~100 s. */
const PROXY_RESPONSE_MS_WEB = 100_000;
let proxyCuts = 0;
async function startProxy(target) {
  const http = await import('node:http');
  const up = new URL(target);
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let size = 0;
    const chunks = [];
    let refused = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > PROXY_BODY_CAP && !refused) {
        refused = true; proxyCuts++;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: null, error: { code: 'PROXY_BODY_TOO_LARGE', message: 'proxy body cap' } }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (refused) return;
      const fwd = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, (r) => {
        clearTimeout(timer);
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      const timer = setTimeout(() => {
        proxyCuts++;
        fwd.destroy();
        if (!res.headersSent) { res.writeHead(524); res.end('proxy timeout'); }
      }, req.url.startsWith('/api/v1/sync/') ? PROXY_RESPONSE_MS : PROXY_RESPONSE_MS_WEB);
      fwd.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
      fwd.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  srv.unref();
  return `http://127.0.0.1:${port}`;
}

async function main() {
  await createScratchDb();
  const env = childEnv({ ...secrets, NODE_ENV: 'development', DATABASE_URL: dbUrl });
  const mig = await run(process.execPath, [...TSX_IMPORT, 'src/migrate.ts'], { cwd: SERVER, env, prefix: '[migrate]' });
  assert.equal(mig.code, 0, `migrations failed: ${mig.stderr}`);
  for (const s of ['001_default_admin.js', '004_comprehensive_demo.js']) {
    const seed = await run(process.execPath, [KNEX_CLI, 'seed:run', '--knexfile', 'knexfile.js', '--specific', s], { cwd: SERVER, env, prefix: '[seed]' });
    assert.equal(seed.code, 0, `seed ${s} failed: ${seed.stderr}`);
  }
  dbc = new Client({ connectionString: dbUrl });
  await dbc.connect();
  await startServer();
  // Every call from here on goes through the proxy (S5).
  server.base = await startProxy(server.base);

  let admin;
  let laptop;
  let reviewer;
  let reviewerId;
  let reviewerDevice;

  await step('sign in as admin', async () => {
    admin = await signIn('admin', 'admin1234', ADMIN_PASSWORD);
  });

  await step('a code made by a signed-in user pairs a desktop (any case, with the dash)', async () => {
    laptop = await pairWith(admin, 'Example  laptop ');
    const d = await one(`SELECT name, token_hash FROM sync_devices WHERE id = $1`, [laptop.deviceId]);
    assert.equal(d.name, 'Example laptop', 'the name tidied');
    assert.notEqual(d.token_hash, laptop.token, 'only the hash is stored');
    assert.equal(d.token_hash.length, 64);
  });

  await step('the paired token lists clients and says who it is', async () => {
    const r = await api('/api/v1/sync/clients', { token: laptop.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.data.length > 0, 'the demo clients');
    assert.match(r.json.data[0].sync_uid, /^[0-9a-f-]{36}$/);
    const me = await api('/api/v1/sync/me', { token: laptop.token });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.data.device.name, 'Example laptop');
    assert.equal(me.json.data.user.username, 'admin');
    assert.ok(me.json.data.server.appVersion);
    assert.ok((await one(`SELECT last_used_at FROM sync_devices WHERE id = $1`, [laptop.deviceId])).last_used_at, 'last used is kept');
  });

  await step('two desktops typing the same code at once: exactly one pairs', async () => {
    const c = await api('/api/v1/desktop-sync/codes', { method: 'POST', token: admin });
    const both = await Promise.all([1, 2].map((i) => api('/api/v1/sync/pair', { method: 'POST', json: { code: c.json.data.code, deviceName: `Race ${i}` } })));
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 400], both.map((r) => r.text).join(' | '));
    assert.equal((await one(`SELECT count(*)::int AS n FROM sync_devices WHERE name LIKE 'Race %'`)).n, 1);
  });

  await step('a new code retires the earlier unused one', async () => {
    const first = await api('/api/v1/desktop-sync/codes', { method: 'POST', token: admin });
    const second = await api('/api/v1/desktop-sync/codes', { method: 'POST', token: admin });
    const old = await api('/api/v1/sync/pair', { method: 'POST', json: { code: first.json.data.code, deviceName: 'Old code' } });
    assert.equal(old.json.error.code, 'SYNC_CODE_INVALID');
    const fresh = await api('/api/v1/sync/pair', { method: 'POST', json: { code: second.json.data.code, deviceName: 'New code' } });
    assert.equal(fresh.status, 201, fresh.text);
    await api(`/api/v1/desktop-sync/devices/${fresh.json.data.device.id}`, { method: 'DELETE', token: admin });
    await sql(`DELETE FROM sync_devices WHERE name IN ('Race 1', 'Race 2', 'New code')`);
  });

  await step('a code pairs once; a wrong, malformed or expired one is refused alike', async () => {
    const again = await api('/api/v1/sync/pair', { method: 'POST', json: { code: laptop.code, deviceName: 'Second' } });
    assert.equal(again.status, 400, again.text);
    assert.equal(again.json.error.code, 'SYNC_CODE_INVALID');
    const wrong = await api('/api/v1/sync/pair', { method: 'POST', json: { code: 'ABCD-EFGH', deviceName: 'Second' } });
    assert.equal(wrong.json.error.code, 'SYNC_CODE_INVALID');
    const junk = await api('/api/v1/sync/pair', { method: 'POST', json: { code: 'not a code', deviceName: 'Second' } });
    assert.equal(junk.json.error.code, 'SYNC_CODE_INVALID');
    const noName = await api('/api/v1/sync/pair', { method: 'POST', json: { code: 'ABCD-EFGH', deviceName: '  ' } });
    assert.equal(noName.json.error.code, 'VALIDATION_ERROR');
    const c = await api('/api/v1/desktop-sync/codes', { method: 'POST', token: admin });
    await sql(`UPDATE sync_pairing_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    const expired = await api('/api/v1/sync/pair', { method: 'POST', json: { code: c.json.data.code, deviceName: 'Late' } });
    assert.equal(expired.status, 400, expired.text);
    assert.equal(expired.json.error.code, 'SYNC_CODE_INVALID');
    assert.equal(expired.json.error.message, again.json.error.message, 'one message: nothing to learn from which');
  });

  await step('the device token is refused on every route but the sync ones, and a session on the sync ones', async () => {
    for (const p of ['/api/v1/clients', '/api/v1/users', '/api/v1/desktop-sync/devices']) {
      const r = await api(p, { token: laptop.token });
      assert.equal(r.status, 401, `${p}: ${r.text}`);
    }
    const w = await api('/api/v1/clients', { method: 'POST', token: laptop.token, json: { name: 'Example' } });
    assert.equal(w.status, 401, w.text);
    const s = await api('/api/v1/sync/clients', { token: admin });
    assert.equal(s.status, 401, s.text);
    assert.equal(s.json.error.code, 'SYNC_NOT_PAIRED');
    const none = await api('/api/v1/sync/clients');
    assert.equal(none.status, 401);
  });

  await step('a reviewer\'s desktop reads but does not write', async () => {
    const u = await api('/api/v1/users', { method: 'POST', token: admin, json: { username: 'example.reviewer', displayName: 'Example Reviewer', password: 'E2eReviewer!2026', role: 'reviewer' } });
    assert.equal(u.status, 201, u.text);
    reviewerId = u.json.data.id;
    reviewer = await signIn('example.reviewer', 'E2eReviewer!2026', 'E2eReviewer!2027');
    reviewerDevice = await pairWith(reviewer, 'Example reviewer laptop');
    assert.equal((await api('/api/v1/sync/clients', { token: reviewerDevice.token })).status, 200);
    const w = await api('/api/v1/sync/clients', { method: 'POST', token: reviewerDevice.token, json: {} });
    assert.equal(w.status, 403, w.text);
    assert.equal(w.json.error.code, 'READ_ONLY');
    const a = await api('/api/v1/sync/clients', { method: 'POST', token: laptop.token, json: {} });
    assert.equal(a.status, 404, `an admin's device gets past the gate: ${a.text}`);
    // The reviewer gate still holds for ordinary writes; only their own
    // account and desktops are open to them.
    const write = await api('/api/v1/clients', { method: 'POST', token: reviewer, json: { name: 'Example' } });
    assert.equal(write.status, 403, write.text);
    assert.equal(write.json.error.code, 'READ_ONLY');
  });

  await step('each user sees their own devices; an admin everyone\'s; only the owner or an admin removes one', async () => {
    const mine = await api('/api/v1/desktop-sync/devices', { token: reviewer });
    assert.deepEqual(mine.json.data.map((d) => d.name), ['Example reviewer laptop']);
    const all = await api('/api/v1/desktop-sync/devices?all=1', { token: admin });
    assert.deepEqual(all.json.data.map((d) => d.name).sort(), ['Example laptop', 'Example reviewer laptop']);
    const notAll = await api('/api/v1/desktop-sync/devices?all=1', { token: reviewer });
    assert.equal(notAll.json.meta.all, false, 'all is for admins');
    const theirs = await api(`/api/v1/desktop-sync/devices/${laptop.deviceId}`, { method: 'DELETE', token: reviewer });
    assert.equal(theirs.status, 404, 'someone else\'s device is not found');
    const gone = await api(`/api/v1/desktop-sync/devices/${reviewerDevice.deviceId}`, { method: 'DELETE', token: admin });
    assert.equal(gone.status, 200, gone.text);
    const r = await api('/api/v1/sync/clients', { token: reviewerDevice.token });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'SYNC_DEVICE_REVOKED');
    assert.ok((await one(`SELECT revoked_at FROM sync_devices WHERE id = $1`, [reviewerDevice.deviceId])).revoked_at, 'kept, revoked');
  });

  await step('a deactivated user\'s devices stop at once', async () => {
    const again = await pairWith(reviewer, 'Example reviewer desktop');
    assert.equal((await api('/api/v1/sync/me', { token: again.token })).status, 200);
    const off = await api(`/api/v1/users/${reviewerId}`, { method: 'PATCH', token: admin, json: { isActive: false } });
    assert.equal(off.status, 200, off.text);
    const r = await api('/api/v1/sync/me', { token: again.token });
    assert.equal(r.status, 401, r.text);
    // Removed at deactivation, not merely refused while inactive.
    assert.equal(r.json.error.code, 'SYNC_DEVICE_REVOKED');
  });

  await step('pairing, sync calls and removals are in the audit log, naming the device', async () => {
    const rows = await sql(`SELECT action, description FROM audit_log WHERE entity_type = 'sync_device' ORDER BY id`);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['pairing_code', 'pair', 'sync', 'revoke']) assert.ok(actions.has(a), `${a} in ${[...actions]}`);
    assert.ok(rows.some((r) => r.action === 'sync' && r.description.includes('"Example laptop"') && r.description.includes('/api/v1/sync/clients')), 'a sync call names its device');
  });

  await step('polling reads are not audited; client data and refusals are', async () => {
    const d = await pairWith(admin, 'Audit probe');
    const before = (await one(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'sync_device' AND action = 'sync'`)).n;
    for (let i = 0; i < 3; i++) assert.equal((await api('/api/v1/sync/me', { token: d.token })).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await one(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'sync_device' AND action = 'sync'`)).n, before, '/me is not audited');
    await api('/api/v1/sync/clients', { token: d.token });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await one(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'sync_device' AND action = 'sync'`)).n, before + 1, 'the client list is');
  });

  await step('a device unused for 90 days ends; one used inside that keeps working', async () => {
    const old = await pairWith(admin, 'Idle desktop');
    await sql(`UPDATE sync_devices SET last_used_at = now() - interval '91 days', created_at = now() - interval '200 days' WHERE id = $1`, [old.deviceId]);
    const r = await api('/api/v1/sync/me', { token: old.token });
    assert.equal(r.status, 401, r.text);
    assert.equal(r.json.error.code, 'SYNC_DEVICE_EXPIRED');
    assert.ok((await one(`SELECT revoked_at FROM sync_devices WHERE id = $1`, [old.deviceId])).revoked_at, 'and it is marked removed');
    const recent = await pairWith(admin, 'Busy desktop');
    await sql(`UPDATE sync_devices SET last_used_at = now() - interval '89 days' WHERE id = $1`, [recent.deviceId]);
    assert.equal((await api('/api/v1/sync/me', { token: recent.token })).status, 200);
  });

  await step("an admin resetting a user's password ends that user's desktops, and only theirs", async () => {
    const u = await api('/api/v1/users', { method: 'POST', token: admin, json: { username: 'example.staff', displayName: 'Example Staff', password: 'E2eStaff!2026', role: 'preparer' } });
    assert.equal(u.status, 201, u.text);
    const staffId = u.json.data.id;
    const staff = await signIn('example.staff', 'E2eStaff!2026', 'E2eStaff!2027');
    const mine = await pairWith(admin, 'Admin desktop');
    const theirs = await pairWith(staff, 'Staff desktop');
    const reset = await api(`/api/v1/users/${staffId}`, { method: 'PATCH', token: admin, json: { password: 'Another-Example-Pass-91!' } });
    assert.equal(reset.status, 200, reset.text);
    assert.equal((await api('/api/v1/sync/me', { token: theirs.token })).json.error.code, 'SYNC_DEVICE_REVOKED');
    assert.equal((await api('/api/v1/sync/me', { token: mine.token })).status, 200, "the admin's own desktop is untouched");
  });

  let afterReset;
  await step('an emailed reset link ends the desktops, and a session from before it cannot pair again', async () => {
    const u = await api('/api/v1/users', { method: 'POST', token: admin, json: { username: 'example.mailreset', displayName: 'Example Mail Reset', password: 'E2eMail!2026', role: 'preparer' } });
    assert.equal(u.status, 201, u.text);
    const oldSession = await signIn('example.mailreset', 'E2eMail!2026', 'E2eMail!2027');
    const desk = await pairWith(oldSession, 'Mail reset desktop');
    // A pending unused code from before the reset must die with it too.
    const pending = await api('/api/v1/desktop-sync/codes', { method: 'POST', token: oldSession });
    assert.equal(pending.status, 201, pending.text);
    // The link the reset email would carry (the mailer is not configured here).
    const raw = 'e2e-reset-' + Date.now();
    await sql(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, encode(sha256($2::bytea), 'hex'), now() + interval '1 hour')`, [u.json.data.id, raw]);
    // Past the second the old session was issued in.
    await new Promise((r) => setTimeout(r, 1100));
    const done = await api('/api/v1/auth/password-reset/confirm', { method: 'POST', json: { token: raw, newPassword: 'E2eMail!2028x' } });
    assert.equal(done.status, 200, done.text);
    assert.equal((await api('/api/v1/sync/me', { token: desk.token })).json.error.code, 'SYNC_DEVICE_REVOKED');
    const usePending = await api('/api/v1/sync/pair', { method: 'POST', json: { code: pending.json.data.code, deviceName: 'From an old code' } });
    assert.equal(usePending.json.error.code, 'SYNC_CODE_INVALID', 'a code made before the reset is gone');
    const again = await api('/api/v1/desktop-sync/codes', { method: 'POST', token: oldSession });
    assert.equal(again.status, 401, `a session from before the reset may not make a code: ${again.text}`);
    assert.equal(again.json.error.code, 'SIGN_IN_AGAIN');
    const fresh = await signIn('example.mailreset', 'E2eMail!2028x');
    afterReset = { userId: u.json.data.id, desk: await pairWith(fresh, 'After reset desktop') };
  });

  await step('deactivating ends the desktops for good: reactivating does not bring them back', async () => {
    // The user from the step above (sign-ins are limited to 10 per 15 minutes).
    const { userId, desk } = afterReset;
    assert.equal((await api('/api/v1/sync/me', { token: desk.token })).status, 200);
    assert.equal((await api(`/api/v1/users/${userId}`, { method: 'PATCH', token: admin, json: { isActive: false } })).status, 200);
    assert.equal((await api(`/api/v1/users/${userId}`, { method: 'PATCH', token: admin, json: { isActive: true } })).status, 200);
    assert.equal((await api('/api/v1/sync/me', { token: desk.token })).json.error.code, 'SYNC_DEVICE_REVOKED');
  });

  // ─────────────────────────────── S3: read and pull
  const s3 = {};
  await step('S3: capabilities say what this server speaks', async () => {
    s3.laptop = await pairWith(admin, 'S3 laptop');
    s3.desk = await pairWith(admin, 'S3 desk');
    const c = await api('/api/v1/sync/capabilities', { token: s3.laptop.token });
    assert.equal(c.status, 200, c.text);
    assert.deepEqual(c.json.data.formatVersions, [2]);
    assert.match(c.json.data.schemaVersion, /^\d{14}_.+\.js$/);
    assert.ok(c.json.data.features.includes('checkout-v1'));
    assert.equal(c.json.data.checkoutWarnDays, 14);
  });

  await step('S3: the client list pages and searches', async () => {
    await sql(`INSERT INTO clients (name, entity_type) VALUES ('Example Paging Client A', 'llc'), ('Example Paging Client B', 'llc')`);
    const all = await sql(`SELECT name FROM clients WHERE is_active ORDER BY name, id`);
    const page = await api('/api/v1/sync/clients?limit=1&offset=1', { token: s3.laptop.token });
    assert.equal(page.status, 200, page.text);
    assert.equal(page.json.meta.total, all.length);
    assert.deepEqual(page.json.data.map((c) => c.name), [all[1].name]);
    const word = all[0].name.split(/\s+/)[0];
    const found = await api(`/api/v1/sync/clients?search=${encodeURIComponent(word.toLowerCase())}`, { token: s3.laptop.token });
    assert.ok(found.json.data.some((c) => c.name === all[0].name), `search "${word}"`);
    assert.equal((await api('/api/v1/sync/clients?limit=0', { token: s3.laptop.token })).status, 400);
  });

  await step("S3: a client's periods carry their stamps, and a reference period is not offered", async () => {
    const c = await one(`SELECT c.id, c.sync_uid FROM clients c JOIN periods p ON p.client_id = c.id JOIN trial_balance tb ON tb.period_id = p.id
                         GROUP BY c.id ORDER BY count(*) DESC, c.id LIMIT 1`);
    s3.client = c;
    const ref = await one(`INSERT INTO periods (client_id, period_name, start_date, end_date, is_reference) VALUES ($1, 'Example reference', '1990-01-01', '1990-12-31', true) RETURNING id`, [c.id]);
    const r = await api(`/api/v1/sync/clients/${c.sync_uid}/periods`, { token: s3.laptop.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.data.length > 0);
    assert.ok(!r.json.data.some((p) => p.period_name === 'Example reference'), 'the reference is not listed');
    for (const p of r.json.data) {
      assert.match(p.stamp, /^[0-9a-f]{64}$/);
      assert.equal(p.checkout, null);
    }
    await sql(`DELETE FROM periods WHERE id = $1`, [ref.id]);
    const withTb = await one(`SELECT p.id, p.sync_uid FROM periods p JOIN trial_balance tb ON tb.period_id = p.id WHERE p.client_id = $1 GROUP BY p.id ORDER BY count(*) DESC, p.id LIMIT 1`, [c.id]);
    s3.period = { ...withTb, stamp: r.json.data.find((p) => p.sync_uid === withTb.sync_uid).stamp };
    assert.equal((await api('/api/v1/sync/clients/00000000-0000-4000-8000-000000000000/periods', { token: s3.laptop.token })).status, 404);
  });

  await step('S3: a pull with check-out returns a job; its archive carries the stamp and the check-out', async () => {
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: s3.laptop.token, json: { checkout: true } });
    assert.equal(pull.status, 202, pull.text);
    s3.checkoutId = pull.json.data.checkoutId;
    assert.ok(s3.checkoutId > 0);
    const job = await waitJob(s3.laptop.token, pull.json.data.jobId);
    assert.equal(job.state, 'done', JSON.stringify(job.error));
    assert.equal(job.result.stamp, s3.period.stamp, 'the stamp in the result is the period as listed');
    const other = await api(`/api/v1/sync/jobs/${pull.json.data.jobId}`, { token: s3.desk.token });
    assert.equal(other.status, 404, "another device's job is not visible");
    const a = await api(`/api/v1/sync/jobs/${pull.json.data.jobId}/archive`, { token: s3.laptop.token });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.buf.subarray(0, 2).toString('latin1'), 'PK');
    const m = await manifestOf(a.buf);
    assert.equal(m.backupLevel, 'period');
    assert.equal(m.periodId, s3.period.id);
    assert.equal(m.sync.stamp, s3.period.stamp);
    assert.equal(m.sync.checkoutId, s3.checkoutId);
    assert.equal(m.sync.periodUid, s3.period.sync_uid);
    assert.equal(m.sync.clientUid, s3.client.sync_uid);
    assert.equal((await one(`SELECT stamp_at_pull FROM period_checkouts WHERE id = $1`, [s3.checkoutId])).stamp_at_pull, s3.period.stamp);
    assert.equal((await one(`SELECT count(*)::int AS n FROM backup_history WHERE period_id = $1`, [s3.period.id])).n, 0, 'a pull is not a backup');
  });

  await step('S3: a checked-out period refuses web writes, naming who has it', async () => {
    const [a1, a2] = (await sql(`SELECT id FROM chart_of_accounts WHERE client_id = $1 ORDER BY account_number LIMIT 2`, [s3.client.id])).map((r) => r.id);
    s3.je = { periodId: s3.period.id, entryType: 'book', entryDate: '2025-12-31', description: 'Example S3 entry', lines: [{ accountId: a1, debit: 100, credit: 0 }, { accountId: a2, debit: 0, credit: 100 }] };
    const w = await api('/api/v1/journal-entries', { method: 'POST', token: admin, json: s3.je });
    assert.equal(w.status, 409, w.text);
    assert.equal(w.json.error.code, 'PERIOD_CHECKED_OUT');
    assert.match(w.json.error.message, /S3 laptop/);
    const listed = await api(`/api/v1/sync/clients/${s3.client.sync_uid}/periods`, { token: s3.desk.token });
    const p = listed.json.data.find((x) => x.sync_uid === s3.period.sync_uid);
    assert.equal(p.checkout.device, 'S3 laptop');
    assert.equal(p.checkout.mine, false);
    assert.equal(p.checkout.stale, false);
  });

  await step('S3: a second device is refused a check-out but may pull to read; the holder re-pulls the same check-out', async () => {
    const again = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: s3.desk.token, json: { checkout: true } });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.error.code, 'PERIOD_CHECKED_OUT');
    assert.match(again.json.error.message, /S3 laptop/);
    const read = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: s3.desk.token, json: { checkout: false } });
    assert.equal(read.status, 202, read.text);
    assert.equal(read.json.data.checkoutId, null);
    assert.equal((await waitJob(s3.desk.token, read.json.data.jobId)).state, 'done');
    const mine = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: s3.laptop.token, json: {} });
    assert.equal(mine.status, 202, mine.text);
    assert.equal(mine.json.data.checkoutId, s3.checkoutId, 'checkout defaults to true and is the one it holds');
    await waitJob(s3.laptop.token, mine.json.data.jobId);
  });

  await step("S3: a reviewer's desktop pulls to read only", async () => {
    assert.equal((await api(`/api/v1/users/${reviewerId}`, { method: 'PATCH', token: admin, json: { isActive: true } })).status, 200);
    const rd = await pairWith(reviewer, 'S3 reviewer desktop');
    const out = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: rd.token, json: { checkout: true } });
    assert.equal(out.status, 403, out.text);
    const read = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: rd.token, json: { checkout: false } });
    assert.equal(read.status, 202, read.text);
    assert.equal((await waitJob(rd.token, read.json.data.jobId)).state, 'done');
  });

  await step('S3: an old check-out is flagged stale, never released', async () => {
    await sql(`UPDATE period_checkouts SET created_at = now() - interval '15 days' WHERE id = $1`, [s3.checkoutId]);
    const listed = await api(`/api/v1/sync/clients/${s3.client.sync_uid}/periods`, { token: s3.laptop.token });
    const p = listed.json.data.find((x) => x.sync_uid === s3.period.sync_uid);
    assert.equal(p.checkout.days, 15);
    assert.equal(p.checkout.stale, true);
    assert.equal(p.checkout.mine, true);
  });

  await step('S3: only the holder gives a check-out back; then the web writes again', async () => {
    assert.equal((await api(`/api/v1/sync/checkouts/${s3.checkoutId}`, { method: 'DELETE', token: s3.desk.token })).status, 404);
    const r = await api(`/api/v1/sync/checkouts/${s3.checkoutId}`, { method: 'DELETE', token: s3.laptop.token });
    assert.equal(r.status, 200, r.text);
    const w = await api('/api/v1/journal-entries', { method: 'POST', token: admin, json: s3.je });
    assert.equal(w.status, 201, w.text);
    assert.equal((await api(`/api/v1/sync/checkouts/${s3.checkoutId}`, { method: 'DELETE', token: s3.laptop.token })).status, 404, 'once');
  });

  await step('S3: a locked period pulls only to read', async () => {
    await sql(`UPDATE periods SET locked_at = now() WHERE id = $1`, [s3.period.id]);
    const out = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: s3.laptop.token, json: { checkout: true } });
    assert.equal(out.status, 409, out.text);
    assert.equal(out.json.error.code, 'PERIOD_LOCKED');
    const read = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: s3.laptop.token, json: { checkout: false } });
    assert.equal(read.status, 202, read.text);
    await waitJob(s3.laptop.token, read.json.data.jobId);
    await sql(`UPDATE periods SET locked_at = NULL WHERE id = $1`, [s3.period.id]);
  });

  await step('S3: polling is not audited; an archive download is', async () => {
    const n = async () => (await one(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'sync_device' AND action = 'sync' AND description LIKE '%/archive%'`)).n;
    assert.ok((await n()) >= 1);
    const checkouts = await sql(`SELECT action FROM audit_log WHERE entity_type = 'period_checkout' ORDER BY id`);
    assert.deepEqual([...new Set(checkouts.map((r) => r.action))].sort(), ['checkout', 'release']);
  });

  await step('S3: every period-writing route and MCP tool refuses a held period, and its stamp does not move', async () => {
    const cid = s3.client.id;
    const pid = s3.period.id;
    const adminId = (await one(`SELECT id FROM app_users WHERE username = 'admin'`)).id;
    const [acc1, acc2] = await sql(`SELECT id, account_number, account_name FROM chart_of_accounts WHERE client_id = $1 ORDER BY account_number LIMIT 2`, [cid]);
    const a1 = acc1.id;
    const a2 = acc2.id;
    const created = async (r, what) => { assert.ok(r.status === 200 || r.status === 201, `${what}: ${r.status} ${r.text}`); return r.json.data; };

    // ── 1. Fixtures, one row of each kind the routes touch, before the check-out.
    const other = await one(`INSERT INTO periods (client_id, period_name, start_date, end_date, is_current) VALUES ($1, 'Example FY 2023', '2023-01-01', '2023-12-31', false) RETURNING id`, [cid]);
    const txU = (await created(await api(`/api/v1/clients/${cid}/bank-transactions`, { method: 'POST', token: admin, json: { transactionDate: '2024-06-28', description: 'Example walk deposit', amount: 12345, periodId: pid, sourceAccountId: a1 } }), 'bank transaction')).id;
    const txAi = (await created(await api(`/api/v1/clients/${cid}/bank-transactions`, { method: 'POST', token: admin, json: { transactionDate: '2024-06-29', description: 'Example walk suggestion', amount: -2500, periodId: pid, sourceAccountId: a1 } }), 'bank transaction')).id;
    await sql(`UPDATE bank_transactions SET classification_status = 'ai_suggested', ai_suggested_account_id = $2, ai_confidence = 0.9 WHERE id = $1`, [txAi, a2]);
    const recOpen = (await created(await api(`/api/v1/clients/${cid}/reconciliations`, { method: 'POST', token: admin, json: { sourceAccountId: a1, periodId: pid, statementDate: '2024-12-31', statementEndingBalance: 12345, notes: 'Example walk reconciliation' } }), 'reconciliation')).id;
    const recDone = (await one(
      `INSERT INTO bank_reconciliations (client_id, source_account_id, period_id, statement_date, statement_ending_balance, beginning_book_balance, status, created_by, completed_by, completed_at)
       VALUES ($1,$2,$3,'2024-11-30',0,0,'completed',$4,$4,now()) RETURNING id`, [cid, a1, pid, adminId])).id;
    const jeLines = [{ accountId: a1, debit: 2500, credit: 0 }, { accountId: a2, debit: 0, credit: 2500 }];
    const jeId = (await created(await api('/api/v1/journal-entries', { method: 'POST', token: admin, json: { ...s3.je, description: 'Example walk entry', lines: jeLines } }), 'journal entry')).id;
    const taskId = (await one(`INSERT INTO engagement_tasks (period_id, title, status, created_by) VALUES ($1, 'Example walk task', 'open', $2) RETURNING id`, [pid, adminId])).id;
    const m1Id = (await one(`INSERT INTO m1_adjustments (period_id, description, category, book_amount, tax_amount, created_by) VALUES ($1, 'Example walk M-1', 'Meals & Entertainment', 10000, 5000, $2) RETURNING id`, [pid, adminId])).id;
    const lsId = (await one(`INSERT INTO lead_sheets (client_id, code, name, sort_order, created_by) VALUES ($1, 'W', 'Example walk lead sheet', 900, $2) RETURNING id`, [cid, adminId])).id;
    const noteId = (await one(`INSERT INTO lead_sheet_notes (client_id, period_id, lead_sheet_id, account_id, body, author_id, author_name) VALUES ($1,$2,$3,$4,'Example walk query',$5,'Administrator') RETURNING id`, [cid, pid, lsId, a1, adminId])).id;
    await sql(`INSERT INTO lead_sheet_signoffs (period_id, lead_sheet_id, role, user_id, user_name, balance_stamp) VALUES ($1,$2,'preparer',$3,'Administrator','example-stamp')`, [pid, lsId, adminId]);
    const tmId = (await one(`INSERT INTO tickmark_library (client_id, symbol, description, color, sort_order, created_by) VALUES ($1, 'Ω', 'Example walk tickmark', 'green', 900, $2) RETURNING id`, [cid, adminId])).id;
    await sql(`INSERT INTO tb_tickmarks (period_id, account_id, tickmark_id, created_by) VALUES ($1,$2,$3,$4)`, [pid, a1, tmId, adminId]);
    await sql(`INSERT INTO variance_notes (account_id, period_id, compare_period_id, note, created_by) VALUES ($1,$2,$3,'Example walk variance',$4)`, [a1, pid, other.id, adminId]);
    await sql(`INSERT INTO py_comparison_data (period_id, account_id, py_debit, py_credit, source, source_filename, uploaded_by) VALUES ($1,$2,100,0,'manual',NULL,$4), ($1,$3,0,100,'manual',NULL,$4)`, [pid, a1, a2, adminId]);
    const fsBody = { name: 'Example FS', settings: { framework: 'gaap', columns: { mode: 'cy_py', pctOfRevenue: false, varianceAmt: false, variancePct: false } }, layoutSource: { kind: 'default' } };
    const reportId = (await created(await api(`/api/v1/periods/${pid}/fs/reports`, { method: 'POST', token: admin, json: fsBody }), 'FS report')).report.id;
    const otherReportId = (await created(await api(`/api/v1/periods/${other.id}/fs/reports`, { method: 'POST', token: admin, json: fsBody }), 'FS report in the other period')).report.id;
    // A final set, for reopen (which refuses a draft anyway).
    const finalReportId = (await created(await api(`/api/v1/periods/${pid}/fs/reports`, { method: 'POST', token: admin, json: { ...fsBody, name: 'Example FS final' } }), 'FS report to finalize')).report.id;
    await created(await api(`/api/v1/fs/reports/${finalReportId}/finalize`, { method: 'POST', token: admin, json: { overrideValidation: true, reason: 'Example override reason' } }), 'FS finalize');
    // The client has no storage folder link here, so an upload cannot store
    // bytes: the attachment and its document are inserted as backup-e2e does.
    // Every attachment route checks the guard before it touches storage.
    const docId = (await one(
      `INSERT INTO client_documents (client_id, filename, file_size, file_type, uploaded_by, storage_backend, object_key, sha256, period_id, section)
       VALUES ($1,'W-1.pdf',1234,'application/pdf',$2,'local','example/walk/W-1.pdf','example-sha',$3,'Workpapers') RETURNING id`, [cid, adminId, pid])).id;
    const attId = (await one(
      `INSERT INTO lead_sheet_attachments (client_id, period_id, lead_sheet_id, lead_sheet_code, account_id, ref_code, document_id, source_file_name, created_by)
       VALUES ($1,$2,$3,'W',$4,'W-1',$5,'example-walk.pdf',$6) RETURNING id`, [cid, pid, lsId, a1, docId, adminId])).id;
    // QuickBooks confirm reads a pending preview and the client's connection
    // row (no call to Intuit): both inserted, the connection a stand-in.
    const realm = 'example-realm-walk';
    const qboConn = (await one(
      `INSERT INTO qbo_connections (client_id, realm_id, company_name, environment, status, refresh_token_enc, refresh_token_expires_at, first_authorized_at, connected_by)
       VALUES ($1,$2,'Example Company','sandbox','active','example-not-a-token', now() + interval '90 days', now(), $3) RETURNING id`, [cid, realm, adminId])).id;
    const qboRaw = {
      Header: { ReportName: 'TrialBalance', StartPeriod: '2024-01-01', EndPeriod: '2024-12-31', ReportBasis: 'Accrual' },
      Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Debit', ColType: 'Money' }, { ColTitle: 'Credit', ColType: 'Money' }] },
      Rows: { Row: [
        { type: 'Data', ColData: [{ value: 'Example Cash', id: '9001' }, { value: '1.00' }, { value: '' }] },
        { type: 'Data', ColData: [{ value: 'Example Revenue', id: '9002' }, { value: '' }, { value: '1.00' }] },
        { group: 'GrandTotal', Summary: { ColData: [{ value: 'TOTAL' }, { value: '1.00' }, { value: '1.00' }] } },
      ] },
    };
    const stored = {
      raw: qboRaw, sha256: 'example', params: { start_date: '2024-01-01', end_date: '2024-12-31', accounting_method: 'Accrual' },
      header: { reportBasis: 'Accrual', startPeriod: '2024-01-01', endPeriod: '2024-12-31', currency: null, time: null, noReportData: false },
      companyName: 'Example Company', accountingMethod: 'Accrual', realmId: realm, environment: 'sandbox', accounts: [], fetchedAt: new Date().toISOString(), target: 'current',
    };
    const qboImportId = (await one(`INSERT INTO document_imports (client_id, period_id, import_type, document_type, status, ai_extraction, imported_by) VALUES ($1,$2,'qbo','trial_balance','pending',$3,$4) RETURNING id`, [cid, pid, JSON.stringify(stored), adminId])).id;
    // A client backup to restore over the client in place.
    const backup = await created(await api(`/api/v1/backup/client/${cid}`, { method: 'POST', token: admin }), 'client backup');
    const walkStart = (await one(`SELECT now() AS t`)).t;

    // ── 2. Check the period out from a new desktop and record its stamp.
    const walk = await pairWith(admin, 'Walk desktop');
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: walk.token, json: { checkout: true } });
    assert.equal(pull.status, 202, pull.text);
    const walkCheckoutId = pull.json.data.checkoutId;
    assert.equal((await waitJob(walk.token, pull.json.data.jobId)).state, 'done');
    const listedPeriod = async () => {
      const r = await api(`/api/v1/sync/clients/${s3.client.sync_uid}/periods`, { token: walk.token });
      assert.equal(r.status, 200, r.text);
      return r.json.data.find((p) => p.sync_uid === s3.period.sync_uid);
    };
    const before = await listedPeriod();
    assert.equal(before.checkout?.device, 'Walk desktop');
    const periodBefore = await one(`SELECT period_name, start_date, end_date, folder_year, locked_at FROM periods WHERE id = $1`, [pid]);
    const countIn = async (table) => (await one(`SELECT count(*)::int AS n FROM ${table} WHERE period_id = $1`, [pid])).n;
    const pyBefore = await countIn('py_comparison_data');

    const failures = [];
    try {
      // ── 3. Every PERIOD_ROUTES entry, as admin, at the held period's rows.
      const exists = (table, id, extra = '') => async () => (await one(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1 ${extra}`, [id])).n === 1;
      const csvForm = () => {
        const f = new FormData();
        f.append('file', new Blob(['Date,Description,Amount\n2024-07-02,Example walk import,250\n'], { type: 'text/csv' }), 'example-walk.csv');
        f.append('periodId', String(pid));
        f.append('sourceAccountId', String(a1));
        return f;
      };
      const { PDFDocument } = require('pdf-lib');
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([200, 200]);
      const pdfBytes = await pdfDoc.save();
      const pdfForm = () => {
        const f = new FormData();
        f.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'example-walk-2.pdf');
        f.append('leadSheetId', String(lsId));
        f.append('accountId', String(a1));
        return f;
      };
      const tbMatch = (a, debitCents, creditCents) => ({ csvRow: 0, csvAccountNumber: a.account_number, csvAccountName: a.account_name, csvDebit: debitCents ? (debitCents / 100).toFixed(2) : null, csvCredit: creditCents ? (creditCents / 100).toFixed(2) : null, matchedAccountId: a.id, matchedAccountNumber: a.account_number, matchedAccountName: a.account_name, confidence: 1, matchType: 'exact', action: 'match', debitCents, creditCents });
      const pdfMatch = (a, debitCents, creditCents) => ({ pdfAccountName: a.account_name, pdfAccountNumber: a.account_number, pdfAmount: ((debitCents || creditCents) / 100).toFixed(2), isDebit: debitCents > 0, debitCents, creditCents, matchedAccountId: a.id, matchedAccountNumber: a.account_number, matchedAccountName: a.account_name, confidence: 1, matchType: 'exact', action: 'match', category: 'assets' });

      const walkRoutes = [
        ['bankTransactions.ts btCollectionRouter POST /', 'POST', `/api/v1/clients/${cid}/bank-transactions`, { json: { transactionDate: '2024-07-01', description: 'Example walk new', amount: 500, periodId: pid, sourceAccountId: a1 } }],
        ['bankTransactions.ts btCollectionRouter POST /import', 'POST', `/api/v1/clients/${cid}/bank-transactions/import`, { form: csvForm }],
        ['bankTransactions.ts btCollectionRouter POST /manual', 'POST', `/api/v1/clients/${cid}/bank-transactions/manual`, { json: { periodId: pid, sourceAccountId: a1, transactions: [{ transactionDate: '2024-07-03', description: 'Example walk manual', amount: 700, accountId: a2, createRule: false }] } }],
        ['bankTransactions.ts btCollectionRouter POST /batch-delete', 'POST', `/api/v1/clients/${cid}/bank-transactions/batch-delete`, { json: { ids: [txU] }, still: exists('bank_transactions', txU) }],
        ['bankTransactions.ts btCollectionRouter POST /batch-classify', 'POST', `/api/v1/clients/${cid}/bank-transactions/batch-classify`, { json: { ids: [txU], accountId: a2 } }],
        ['bankTransactions.ts btCollectionRouter POST /batch-update-source', 'POST', `/api/v1/clients/${cid}/bank-transactions/batch-update-source`, { json: { ids: [txU], sourceAccountId: a2 } }],
        ['bankTransactions.ts btCollectionRouter POST /batch-confirm-ai', 'POST', `/api/v1/clients/${cid}/bank-transactions/batch-confirm-ai`, { json: { ids: [txAi] } }],
        ['bankTransactions.ts btCollectionRouter PATCH /:id', 'PATCH', `/api/v1/clients/${cid}/bank-transactions/${txU}`, { json: { accountId: a2, description: 'Example walk renamed' } }],
        ['bankTransactions.ts btCollectionRouter DELETE /:id', 'DELETE', `/api/v1/clients/${cid}/bank-transactions/${txU}`, { still: exists('bank_transactions', txU) }],
        ['bankStatementPdfImport.ts bankStatementPdfRouter POST /confirm', 'POST', '/api/v1/import/bank-statement-pdf/confirm', { json: { clientId: cid, periodId: pid, sourceAccountId: a1, transactions: [{ date: '2024-07-04', description: 'Example walk statement line', amount: 900, checkNumber: null, payeeName: null, category: null }] } }],
        ['csvImport.ts csvImportRouter POST /confirm', 'POST', '/api/v1/import/csv/confirm', { json: { periodId: pid, clientId: cid, matches: [tbMatch(acc1, 100, 0), { ...tbMatch(acc2, 0, 100), csvRow: 1 }], aiExtraction: null } }],
        ['pdfImport.ts pdfImportRouter POST /confirm', 'POST', '/api/v1/import/pdf/confirm', { json: { periodId: pid, clientId: cid, matches: [pdfMatch(acc1, 100, 0), pdfMatch(acc2, 0, 100)], aiExtraction: null } }],
        ['qboImport.ts qboImportRouter POST /confirm', 'POST', '/api/v1/import/qbo/confirm', { json: { importId: qboImportId, decisions: [{ rowKey: '0', action: 'skip' }, { rowKey: '1', action: 'skip' }] } }],
        ['documents.ts documentsItemRouter DELETE /:id', 'DELETE', `/api/v1/documents/${docId}`, { still: exists('client_documents', docId, 'AND deleted_at IS NULL') }],
        ['fs.ts fsRouter PATCH /reports/:reportId', 'PATCH', `/api/v1/fs/reports/${reportId}`, { json: { name: 'Example FS renamed' } }],
        ['fs.ts fsRouter DELETE /reports/:reportId', 'DELETE', `/api/v1/fs/reports/${reportId}`, { still: exists('fs_reports', reportId, 'AND archived_at IS NULL') }],
        // Rolling forward writes the TARGET period: the other period's statements into the held one.
        ['fs.ts fsRouter POST /reports/:reportId/roll-forward', 'POST', `/api/v1/fs/reports/${otherReportId}/roll-forward`, { json: { periodId: pid, name: 'Example FS rolled' } }],
        ['fs.ts fsRouter POST /reports/:reportId/finalize', 'POST', `/api/v1/fs/reports/${reportId}/finalize`, { json: { overrideValidation: true, reason: 'Example override reason' } }],
        ['fs.ts fsRouter POST /reports/:reportId/reopen', 'POST', `/api/v1/fs/reports/${finalReportId}/reopen`, { json: {}, still: exists('fs_reports', finalReportId, `AND status = 'final'`) }],
        ['fs.ts fsPeriodRouter POST /reports', 'POST', `/api/v1/periods/${pid}/fs/reports`, { json: { ...fsBody, name: 'Example FS second' } }],
        ['journalEntries.ts jeItemRouter POST /', 'POST', '/api/v1/journal-entries', { json: { ...s3.je, description: 'Example walk entry two', lines: jeLines } }],
        ['journalEntries.ts jeItemRouter PUT /:id/lines', 'PUT', `/api/v1/journal-entries/${jeId}/lines`, { json: { lines: [{ accountId: a1, debit: 3000, credit: 0 }, { accountId: a2, debit: 0, credit: 3000 }] } }],
        ['journalEntries.ts jeItemRouter PATCH /:id', 'PATCH', `/api/v1/journal-entries/${jeId}`, { json: { description: 'Example walk entry edited' } }],
        ['journalEntries.ts jeItemRouter DELETE /:id', 'DELETE', `/api/v1/journal-entries/${jeId}`, { still: exists('journal_entries', jeId) }],
        ['leadSheetAttachments.ts leadSheetAttachmentCollectionRouter POST /', 'POST', `/api/v1/periods/${pid}/lead-sheet-attachments`, { form: pdfForm }],
        ['leadSheetAttachments.ts leadSheetAttachmentItemRouter POST /annotations', 'POST', `/api/v1/lead-sheet-attachments/${attId}/annotations`, { json: { kind: 'note', page: 1, xPct: 0.5, yPct: 0.5, text: 'Example walk annotation', color: 'red' } }],
        ['leadSheetAttachments.ts leadSheetAttachmentItemRouter DELETE /', 'DELETE', `/api/v1/lead-sheet-attachments/${attId}`, { still: exists('lead_sheet_attachments', attId, 'AND deleted_at IS NULL') }],
        ['leadSheets.ts leadSheetItemRouter DELETE /', 'DELETE', `/api/v1/lead-sheets/${lsId}`, { still: exists('lead_sheets', lsId) }],
        ['leadSheets.ts leadSheetPeriodRouter POST /:leadSheetId/signoff', 'POST', `/api/v1/periods/${pid}/lead-sheets/${lsId}/signoff`, { json: { role: 'reviewer' } }],
        ['leadSheets.ts leadSheetPeriodRouter POST /:leadSheetId/unsign', 'POST', `/api/v1/periods/${pid}/lead-sheets/${lsId}/unsign`, { json: { role: 'preparer' } }],
        ['leadSheets.ts leadSheetPeriodRouter POST /:leadSheetId/notes', 'POST', `/api/v1/periods/${pid}/lead-sheets/${lsId}/notes`, { json: { leadSheetId: lsId, accountId: a1, body: 'Example walk second query' } }],
        ['leadSheets.ts leadSheetPeriodRouter POST /:leadSheetId/notes/:noteId/resolve', 'POST', `/api/v1/periods/${pid}/lead-sheets/${lsId}/notes/${noteId}/resolve`, { json: { resolved: true } }],
        ['periods.ts periodItemRouter PATCH /:id', 'PATCH', `/api/v1/periods/${pid}`, { json: { periodName: 'Example renamed period' } }],
        ['periods.ts periodItemRouter POST /:id/lock', 'POST', `/api/v1/periods/${pid}/lock`, { json: {} }],
        ['pyComparison.ts pyComparisonRouter POST /manual', 'POST', `/api/v1/periods/${pid}/py-comparison/manual`, { json: { accounts: [{ accountId: a1, debit: 200, credit: 0 }, { accountId: a2, debit: 0, credit: 200 }] } }],
        ['pyComparison.ts pyComparisonRouter POST /confirm-csv', 'POST', `/api/v1/periods/${pid}/py-comparison/confirm-csv`, { json: { clientId: cid, sourceType: 'csv', sourceFilename: 'example-walk.csv', matches: [{ csvAccountNumber: acc1.account_number, csvAccountName: acc1.account_name, matchedAccountId: a1, debitCents: 300, creditCents: 0, action: 'match' }, { csvAccountNumber: acc2.account_number, csvAccountName: acc2.account_name, matchedAccountId: a2, debitCents: 0, creditCents: 300, action: 'match' }] } }],
        ['pyComparison.ts pyComparisonRouter POST /confirm-pdf', 'POST', `/api/v1/periods/${pid}/py-comparison/confirm-pdf`, { json: { clientId: cid, sourceFilename: 'example-walk.pdf', matches: [{ pdfAccountNumber: acc1.account_number, pdfAccountName: acc1.account_name, matchedAccountId: a1, debitCents: 400, creditCents: 0, action: 'match' }, { pdfAccountNumber: acc2.account_number, pdfAccountName: acc2.account_name, matchedAccountId: a2, debitCents: 0, creditCents: 400, action: 'match' }] } }],
        ['pyComparison.ts pyComparisonRouter DELETE /', 'DELETE', `/api/v1/periods/${pid}/py-comparison`, { still: async () => (await countIn('py_comparison_data')) === pyBefore }],
        ['pyComparison.ts pyComparisonRouter POST /create-aje', 'POST', `/api/v1/periods/${pid}/py-comparison/create-aje`, { json: { entryType: 'book', description: 'Example walk true-up', offsetAccountId: a2, accountIds: [a1] } }],
        ['reconciliations.ts reconciliationCollectionRouter POST /', 'POST', `/api/v1/clients/${cid}/reconciliations`, { json: { sourceAccountId: a1, periodId: pid, statementDate: '2024-10-31', statementEndingBalance: 0 } }],
        ['reconciliations.ts reconciliationItemRouter PATCH /', 'PATCH', `/api/v1/reconciliations/${recOpen}`, { json: { notes: 'Example walk edited' } }],
        ['reconciliations.ts reconciliationItemRouter POST /toggle-item', 'POST', `/api/v1/reconciliations/${recOpen}/toggle-item`, { json: { transactionId: txU } }],
        ['reconciliations.ts reconciliationItemRouter POST /complete', 'POST', `/api/v1/reconciliations/${recOpen}/complete`, { json: { force: true } }],
        ['reconciliations.ts reconciliationItemRouter POST /reopen', 'POST', `/api/v1/reconciliations/${recDone}/reopen`, { json: {} }],
        ['reconciliations.ts reconciliationItemRouter DELETE /', 'DELETE', `/api/v1/reconciliations/${recOpen}`, { still: exists('bank_reconciliations', recOpen) }],
        ['tickmarks.ts tickmarkLibraryItemRouter DELETE /', 'DELETE', `/api/v1/tickmarks/${tmId}`, { still: exists('tickmark_library', tmId) }],
        ['tickmarks.ts tbTickmarkRouter POST /toggle', 'POST', `/api/v1/periods/${pid}/tb-tickmarks/toggle`, { json: { accountId: a1, tickmarkId: tmId } }],
        ['trialBalance.ts tbPeriodRouter POST /initialize', 'POST', `/api/v1/periods/${pid}/trial-balance/initialize`, { json: {} }],
        ['trialBalance.ts tbPeriodRouter POST /import', 'POST', `/api/v1/periods/${pid}/trial-balance/import`, { json: { rows: [{ accountNumber: acc1.account_number, accountName: 'Example walk alias', debit: 100, credit: 0 }] } }],
        ['trialBalance.ts tbPeriodRouter POST /import-prior-year', 'POST', `/api/v1/periods/${pid}/trial-balance/import-prior-year`, { json: { rows: [{ accountNumber: acc1.account_number, debit: 100, credit: 0 }] } }],
        ['trialBalance.ts tbPeriodRouter PUT /:accountId', 'PUT', `/api/v1/periods/${pid}/trial-balance/${a1}`, { json: { unadjustedDebit: 100, unadjustedCredit: 0 } }],
        ['taxWorkpapers.ts m1CollectionRouter POST /', 'POST', `/api/v1/periods/${pid}/m1-adjustments`, { json: { description: 'Example walk M-1 two', category: 'Penalties & Fines', bookAmount: 100, taxAmount: 0 } }],
        ['taxWorkpapers.ts m1ItemRouter PATCH /', 'PATCH', `/api/v1/m1-adjustments/${m1Id}`, { json: { notes: 'Example walk edited' } }],
        ['taxWorkpapers.ts m1ItemRouter DELETE /', 'DELETE', `/api/v1/m1-adjustments/${m1Id}`, { still: exists('m1_adjustments', m1Id) }],
        ['engagement.ts engagementCollectionRouter POST /', 'POST', `/api/v1/periods/${pid}/engagement-tasks`, { json: { title: 'Example walk task two', status: 'open' } }],
        ['engagement.ts engagementItemRouter PATCH /', 'PATCH', `/api/v1/engagement-tasks/${taskId}`, { json: { status: 'in_progress', notes: 'Example walk edited' } }],
        ['engagement.ts engagementItemRouter DELETE /', 'DELETE', `/api/v1/engagement-tasks/${taskId}`, { still: exists('engagement_tasks', taskId) }],
        ['comparison.ts comparisonRouter PUT /variance-notes/:accountId', 'PUT', `/api/v1/periods/${pid}/compare/${other.id}/variance-notes/${a1}`, { json: { note: 'Example walk variance edited' } }],
        ['varianceNotes.ts varianceNotesRouter PUT /:accountId', 'PUT', `/api/v1/periods/${pid}/variance-notes/${a2}`, { json: { note: 'Example walk variance' } }],
        // Last: a missed guard here would delete the period or the client's data and fail every route after it.
        ['backup.ts restoreRouter POST /execute', 'POST', '/api/v1/restore/execute', { json: { backupId: backup.id, mode: 'replace', targetClientId: cid }, still: exists('periods', pid) }],
        ['periods.ts periodItemRouter DELETE /:id', 'DELETE', `/api/v1/periods/${pid}`, { still: exists('periods', pid) }],
      ];

      // The walk covers PERIOD_ROUTES exactly, read from the classification test.
      const classified = readFileSync(path.join(SERVER, 'src', 'lib', '__tests__', 'periodWriteRoutes.test.ts'), 'utf8');
      const listOf = (name) => [...classified.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const periodRoutes = listOf('PERIOD_ROUTES');
      const walked = walkRoutes.map((r) => r[0]);
      const missing = periodRoutes.filter((r) => !walked.includes(r));
      const extra = walked.filter((r) => !periodRoutes.includes(r));
      if (missing.length || extra.length) failures.push(`walk does not match PERIOD_ROUTES: missing ${JSON.stringify(missing)}, not listed ${JSON.stringify(extra)}`);

      for (const [route, method, url, { json, form, still } = {}] of walkRoutes) {
        let r;
        try {
          r = await api(url, { method, token: admin, json, form: form?.() });
        } catch (err) {
          failures.push(`${route} (${method} ${url}): request failed: ${err.message}`);
          continue;
        }
        if (r.status !== 409 || r.json?.error?.code !== 'PERIOD_CHECKED_OUT' || !String(r.json?.error?.message).includes('Walk desktop')) {
          failures.push(`${route} (${method} ${url}): ${r.status} ${r.text}`);
        }
        if (still && !(await still())) failures.push(`${route} (${method} ${url}): the row is gone`);
      }

      // ── 4. Every MCP_PERIOD_TOOLS tool, through the real handlers.
      // run() keeps only stderr, and the tool result is on stdout.
      const mcpCall = (tool, args) => new Promise((resolve) => {
        const child = spawn(process.execPath, [...TSX_IMPORT, 'src/mcpCall.ts', tool, JSON.stringify(args)], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => capture(`[mcp ${tool}]`, c));
        child.on('exit', (code) => resolve({ code, out }));
      });
      const mcpTools = {
        update_trial_balance_row: { periodId: pid, accountId: a1, debitCents: 100, creditCents: 0 },
        create_journal_entry: { periodId: pid, entryType: 'book', entryDate: '2024-12-31', description: 'Example MCP entry', lines: jeLines },
        lock_period: { periodId: pid },
        add_variance_note: { periodId: pid, accountId: a1, note: 'Example MCP variance note' },
        update_engagement_task: { taskId, status: 'in_progress', notes: 'Example MCP edit' },
      };
      const periodTools = listOf('MCP_PERIOD_TOOLS');
      if (JSON.stringify([...periodTools].sort()) !== JSON.stringify(Object.keys(mcpTools).sort())) {
        failures.push(`MCP walk does not match MCP_PERIOD_TOOLS: ${JSON.stringify(periodTools)} vs ${JSON.stringify(Object.keys(mcpTools))}`);
      }
      for (const [tool, args] of Object.entries(mcpTools)) {
        const { code, out } = await mcpCall(tool, args);
        const line = out.split(/\r?\n/).find((l) => l.startsWith('{'));
        let result = null;
        try { result = line ? JSON.parse(line) : null; } catch { /* reported below */ }
        const text = (result?.content ?? []).map((c) => c.text ?? '').join(' ');
        if (code !== 0 || result?.isError !== true || !text.includes('Walk desktop')) failures.push(`MCP ${tool}: exit ${code} ${line ?? out}`);
      }
      if (!(await exists('engagement_tasks', taskId)())) failures.push('MCP update_engagement_task: the task is gone');

      // ── 5. Nothing moved: the stamp, the holder, and the period's own fields (not in the stamp).
      const after = await listedPeriod();
      if (after?.stamp !== before.stamp) failures.push(`the stamp moved: ${before.stamp} -> ${after?.stamp}`);
      if (after?.checkout?.device !== 'Walk desktop') failures.push(`the check-out is no longer Walk desktop's: ${JSON.stringify(after?.checkout)}`);
      const periodAfter = await one(`SELECT period_name, start_date, end_date, folder_year, locked_at FROM periods WHERE id = $1`, [pid]);
      if (JSON.stringify(periodAfter) !== JSON.stringify(periodBefore)) failures.push(`the period row changed: ${JSON.stringify(periodBefore)} -> ${JSON.stringify(periodAfter)}`);
    } finally {
      // ── 6. Give the check-out back and tidy what is not period data.
      const rel = await api(`/api/v1/sync/checkouts/${walkCheckoutId}`, { method: 'DELETE', token: walk.token });
      if (rel.status !== 200) failures.push(`release: ${rel.status} ${rel.text}`);
      const backups = await sql(`SELECT id FROM backup_history WHERE id = $1 OR (client_id = $2 AND trigger_type = 'pre_restore' AND created_at >= $3)`, [backup.id, cid, walkStart]);
      for (const b of backups) await api(`/api/v1/backup/${b.id}`, { method: 'DELETE', token: admin });
      await sql(`DELETE FROM qbo_connections WHERE id = $1`, [qboConn]);
    }
    assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
  });

  await step("S3: while a period is held, a lead sheet's code and a tickmark's symbol stay; the admin list shows the hold", async () => {
    const d = await pairWith(admin, 'Rename desktop');
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    assert.equal(pull.status, 202, pull.text);
    await waitJob(d.token, pull.json.data.jobId);
    const ls = await one(`INSERT INTO lead_sheets (client_id, code, name) VALUES ($1, 'EXR', 'Example rename sheet') RETURNING id`, [s3.client.id]);
    const tm = await one(`INSERT INTO tickmark_library (client_id, symbol, description) VALUES ($1, 'ER', 'Example rename mark') RETURNING id`, [s3.client.id]);
    const code = await api(`/api/v1/lead-sheets/${ls.id}`, { method: 'PATCH', token: admin, json: { code: 'EXR2', name: 'Example rename sheet' } });
    assert.equal(code.status, 409, code.text);
    assert.equal(code.json.error.code, 'PERIOD_CHECKED_OUT');
    const name = await api(`/api/v1/lead-sheets/${ls.id}`, { method: 'PATCH', token: admin, json: { name: 'Example renamed sheet' } });
    assert.equal(name.status, 200, `a name change is fine: ${name.text}`);
    const sym = await api(`/api/v1/tickmarks/${tm.id}`, { method: 'PATCH', token: admin, json: { symbol: 'E2' } });
    assert.equal(sym.status, 409, sym.text);
    assert.equal((await api(`/api/v1/tickmarks/${tm.id}`, { method: 'PATCH', token: admin, json: { description: 'Example mark' } })).status, 200);
    const list = await api('/api/v1/desktop-sync/checkouts', { token: admin });
    assert.equal(list.status, 200, list.text);
    const mine = list.json.data.find((c) => c.device === 'Rename desktop');
    assert.ok(mine, 'listed');
    assert.equal(mine.periodId, s3.period.id);
    assert.equal(mine.stale, false);
    assert.equal((await api(`/api/v1/sync/checkouts/${pull.json.data.checkoutId}`, { method: 'DELETE', token: d.token })).status, 200);
    assert.equal((await api(`/api/v1/lead-sheets/${ls.id}`, { method: 'PATCH', token: admin, json: { code: 'EXR2', name: 'Example renamed sheet' } })).status, 200, 'free again once released');
  });

  await step('S3: a reference period refuses every write; a client layout edit does not move a held period stamp', async () => {
    const c = s3.client.id;
    const ref = await one(`INSERT INTO periods (client_id, period_name, start_date, end_date, is_reference) VALUES ($1, 'Example reference 2', '1991-01-01', '1991-12-31', true) RETURNING id`, [c]);
    const [a1] = (await sql(`SELECT id FROM chart_of_accounts WHERE client_id = $1 ORDER BY account_number LIMIT 1`, [c])).map((r) => r.id);
    const tick = await one(`SELECT id FROM tickmark_library WHERE client_id = $1 ORDER BY id LIMIT 1`, [c]);
    const calls = [
      ['variance note', `/api/v1/periods/${ref.id}/variance-notes/${a1}`, 'PUT', { note: 'Example' }],
      ['engagement task', `/api/v1/periods/${ref.id}/engagement-tasks`, 'POST', { title: 'Example task' }],
      ['tickmark', `/api/v1/periods/${ref.id}/tb-tickmarks/toggle`, 'POST', { accountId: a1, tickmarkId: tick?.id ?? 1 }],
      ['lock', `/api/v1/periods/${ref.id}/lock`, 'POST', {}],
      ['rename', `/api/v1/periods/${ref.id}`, 'PATCH', { periodName: 'Example renamed' }],
      ['roll forward', `/api/v1/periods/${ref.id}/roll-forward`, 'POST', { periodName: 'Example from a reference', startDate: '1992-01-01', endDate: '1992-12-31' }],
    ];
    const bad = [];
    for (const [what, url, method, json] of calls) {
      const r = await api(url, { method, token: admin, json });
      if (r.status !== 409 || r.json?.error?.code !== 'PERIOD_LOCKED' || !/reference/.test(r.json?.error?.message ?? '')) bad.push(`${what}: ${r.status} ${r.text}`);
    }
    assert.deepEqual(bad, []);
    await sql(`DELETE FROM periods WHERE id = $1`, [ref.id]);

    // The layout a held period's report uses is the client's (SQ3), not the period's.
    const rep = await one(`SELECT client_layout_id FROM fs_reports WHERE period_id = $1 AND archived_at IS NULL ORDER BY id LIMIT 1`, [s3.period.id]);
    assert.ok(rep, 'the walk left a Statement Writer set in the period');
    const d = await pairWith(admin, 'Layout desktop');
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    assert.equal(pull.status, 202, pull.text);
    await waitJob(d.token, pull.json.data.jobId);
    const stampOf = async () => (await api(`/api/v1/sync/clients/${s3.client.sync_uid}/periods`, { token: d.token })).json.data.find((x) => x.sync_uid === s3.period.sync_uid).stamp;
    const before = await stampOf();
    const edit = await api(`/api/v1/fs/layouts/${rep.client_layout_id}`, { method: 'PATCH', token: admin, json: { name: 'Example layout, renamed' } });
    assert.equal(edit.status, 200, edit.text);
    assert.equal(await stampOf(), before, 'a layout edit leaves the held period stamp as it was');
    assert.equal((await api(`/api/v1/sync/checkouts/${pull.json.data.checkoutId}`, { method: 'DELETE', token: d.token })).status, 200);
  });

  // ─────────────────────────────── S4: send back
  await step('S4: an upload arrives in parts, resumable, and is checked whole', async () => {
    const d = await pairWith(admin, 'Upload desktop');
    const other = await pairWith(admin, 'Other desktop');
    const data = randomBytes(2.5 * 1024 * 1024);
    const sha = (await import('node:crypto')).createHash('sha256').update(data).digest('hex');
    const start = await api('/api/v1/sync/uploads', { method: 'POST', token: d.token, json: { size: data.length, sha256: sha } });
    assert.equal(start.status, 201, start.text);
    const { uploadId, partBytes, parts } = start.json.data;
    assert.equal(partBytes, 1024 * 1024);
    assert.equal(parts, 3);
    const part = (n) => data.subarray(n * partBytes, Math.min(data.length, (n + 1) * partBytes));
    const put = (n, buf, token = d.token) => fetch(`${server.base}/api/v1/sync/uploads/${uploadId}/parts/${n}`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: buf,
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
    assert.equal((await put(2, part(2))).status, 200);
    const early = await api(`/api/v1/sync/uploads/${uploadId}/complete`, { method: 'POST', token: d.token });
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.error.code, 'SYNC_UPLOAD_INCOMPLETE');
    assert.equal((await put(0, part(1).subarray(0, 10))).json.error.code, 'SYNC_PART_SIZE');
    assert.equal((await put(0, part(0), other.token)).status, 404, "another computer's upload is not found");
    assert.equal((await put(0, part(0))).status, 200);
    assert.equal((await put(0, part(0))).status, 200, 'a part sent again replaces itself');
    const status = await api(`/api/v1/sync/uploads/${uploadId}`, { token: d.token });
    assert.deepEqual(status.json.data.received, [0, 2]);
    assert.deepEqual((await put(1, part(1))).json.data.received, [0, 1, 2]);
    const done = await completeAndWait(d.token, uploadId);
    assert.equal(done.complete, true, JSON.stringify(done));
    assert.equal((await api(`/api/v1/sync/uploads/${uploadId}/complete`, { method: 'POST', token: d.token })).status, 200, 'complete again: already done');
    // A file that does not match its announced hash is refused.
    const lie = await api('/api/v1/sync/uploads', { method: 'POST', token: d.token, json: { size: 100, sha256: '0'.repeat(64) } });
    const lieId = lie.json.data.uploadId;
    await fetch(`${server.base}/api/v1/sync/uploads/${lieId}/parts/0`, { method: 'PUT', headers: { authorization: `Bearer ${d.token}` }, body: randomBytes(100) });
    const bad = await completeAndWait(d.token, lieId);
    assert.equal(bad.complete, false);
    assert.equal(bad.joinError?.code, 'SYNC_UPLOAD_HASH');
    assert.equal((await api('/api/v1/sync/uploads', { method: 'POST', token: d.token, json: { size: 3 * 1024 ** 3, sha256: sha } })).json.error.code, 'SYNC_UPLOAD_TOO_LARGE');
  });

  let s4;
  // The demo seed has entries on accounts without a trial balance row; the
  // web makes one first (ensureTrialBalanceRows), and so does this fixture.
  await sql(`INSERT INTO trial_balance (period_id, account_id, unadjusted_debit, unadjusted_credit)
             SELECT DISTINCT j.period_id, l.account_id, 0, 0 FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id
             WHERE NOT EXISTS (SELECT 1 FROM trial_balance t WHERE t.period_id = j.period_id AND t.account_id = l.account_id)
             ON CONFLICT DO NOTHING`);
  await step('S4: pull, change on the desktop, send back: the period matches, other periods are untouched, the hold ends', async () => {
    const d = await pairWith(admin, 'Roundtrip desktop');
    const P = s3.period.id;
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    assert.equal(pull.status, 202, pull.text);
    const checkoutId = pull.json.data.checkoutId;
    const job = await waitJob(d.token, pull.json.data.jobId);
    assert.equal(job.state, 'done', JSON.stringify(job.error));
    const archive = (await api(`/api/v1/sync/jobs/${pull.json.data.jobId}/archive`, { token: d.token })).buf;
    const others = await sql(`SELECT id FROM periods WHERE client_id = $1 AND id <> $2 AND NOT is_reference ORDER BY id`, [s3.client.id, P]);
    const otherRowsBefore = await sql(`SELECT period_id, account_id, unadjusted_debit, unadjusted_credit FROM trial_balance WHERE period_id = ANY($1) ORDER BY 1, 2`, [others.map((o) => o.id)]);
    let newAccountNumber, changedAccountId, tbBefore;
    const sent = await rewriteArchive(archive, async (t, m) => {
      // 1. A balance changes.
      const tb = t.trial_balance[0];
      changedAccountId = tb.account_id;
      tbBefore = Number(tb.unadjusted_debit);
      tb.unadjusted_debit = String(tbBefore + 12345);
      // 2. A new account, and 3. an AJE that uses it.
      const maxId = Math.max(...t.chart_of_accounts.map((a) => a.id));
      const base = t.chart_of_accounts[0];
      newAccountNumber = `9${String(Date.now()).slice(-5)}`;
      t.chart_of_accounts.push({ ...base, id: maxId + 1, sync_uid: randomUUID(), account_number: newAccountNumber, account_name: 'Example desktop account' });
      const jeId = Math.max(0, ...t.journal_entries.map((j) => j.id)) + 1000;
      const lineId = Math.max(0, ...t.journal_entry_lines.map((l) => l.id)) + 1000;
      const num = Math.max(0, ...t.journal_entries.filter((j) => j.entry_type === 'book').map((j) => j.entry_number)) + 1;
      t.journal_entries.push({ ...(t.journal_entries[0] ?? {}), id: jeId, period_id: m.periodId, entry_type: 'book', entry_number: num, entry_date: '2025-12-31', description: 'Example desktop AJE', is_recurring: false });
      t.journal_entry_lines.push(
        { ...t.journal_entry_lines[0], id: lineId, journal_entry_id: jeId, account_id: maxId + 1, debit: '500', credit: '0' },
        { ...t.journal_entry_lines[0], id: lineId + 1, journal_entry_id: jeId, account_id: base.id, debit: '0', credit: '500' },
      );
      t.trial_balance.push({ ...t.trial_balance[0], id: 900000, account_id: maxId + 1, unadjusted_debit: '0', unadjusted_credit: '0' });
      // 4. A tickmark, new to the library, placed on the changed account.
      const tmId = Math.max(0, ...(t.tickmark_library ?? []).map((x) => x.id)) + 1;
      t.tickmark_library = [...(t.tickmark_library ?? []), { id: tmId, client_id: m.clientId, symbol: 'DX', description: 'Example desktop mark', color: 'blue', sort_order: 99 }];
      t.tb_tickmarks = [...(t.tb_tickmarks ?? []), { id: 1, period_id: m.periodId, account_id: changedAccountId, tickmark_id: tmId }];
      // 5. An engagement task done.
      // A desktop sends whole rows, as the server would write them.
      t.engagement_tasks = [...(t.engagement_tasks ?? []), {
        id: 1, period_id: m.periodId, title: 'Example desktop task', description: null, category: null, status: 'completed',
        assignee_id: null, sort_order: 0, notes: null, completed_by: null, completed_at: null, created_by: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }];
      m.sync.totals = totalsOf(t);
    });
    const uploadId = await uploadBuf(d.token, sent);
    const push = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId, checkoutId } });
    assert.equal(push.status, 202, push.text);
    const pj = await waitJob(d.token, push.json.data.jobId);
    assert.equal(pj.state, 'done', JSON.stringify(pj.error));
    assert.deepEqual(pj.result.accountsAdded, [newAccountNumber]);
    assert.deepEqual(pj.result.tickmarksAdded, ['DX']);
    assert.deepEqual(pj.result.differences, []);
    // The period is the desktop's now.
    const tbNow = await one(`SELECT unadjusted_debit FROM trial_balance WHERE period_id = $1 AND account_id = $2`, [P, changedAccountId]);
    assert.equal(Number(tbNow.unadjusted_debit), tbBefore + 12345);
    const aje = await one(`SELECT je.id FROM journal_entries je WHERE je.period_id = $1 AND je.description = 'Example desktop AJE'`, [P]);
    assert.ok(aje, 'the AJE arrived');
    assert.equal((await one(`SELECT count(*)::int AS n FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = $1 AND a.account_number = $2`, [aje.id, newAccountNumber])).n, 1, 'its line names the new account');
    assert.ok(await one(`SELECT 1 FROM tb_tickmarks tt JOIN tickmark_library tl ON tl.id = tt.tickmark_id WHERE tt.period_id = $1 AND tl.symbol = 'DX'`, [P]));
    assert.ok(await one(`SELECT 1 FROM engagement_tasks WHERE period_id = $1 AND title = 'Example desktop task'`, [P]));
    // Other periods untouched; the hold ended; the web writes again.
    assert.deepEqual(await sql(`SELECT period_id, account_id, unadjusted_debit, unadjusted_credit FROM trial_balance WHERE period_id = ANY($1) ORDER BY 1, 2`, [others.map((o) => o.id)]), otherRowsBefore);
    assert.ok((await one(`SELECT released_at FROM period_checkouts WHERE id = $1`, [checkoutId])).released_at);
    const listed = await api(`/api/v1/sync/clients/${s3.client.sync_uid}/periods`, { token: d.token });
    const p = listed.json.data.find((x) => x.sync_uid === s3.period.sync_uid);
    assert.equal(p.checkout, null);
    assert.equal(p.stamp, pj.result.stamp, 'the listed stamp is the merged one');
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE action = 'sync_merge' AND period_id = $1`, [P]));
    s4 = { desk: d, archive };
  });

  await step('S4: a send-back is refused when it is not held, when the period changed, or when the archive is damaged or wrong', async () => {
    const d = s4.desk;
    const P = s3.period.id;
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    const checkoutId = pull.json.data.checkoutId;
    await waitJob(d.token, pull.json.data.jobId);
    const archive = (await api(`/api/v1/sync/jobs/${pull.json.data.jobId}/archive`, { token: d.token })).buf;
    const pushJob = async (buf, json) => {
      const uploadId = await uploadBuf(d.token, buf);
      const r = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId, ...json } });
      if (r.status !== 202) return { refused: r.json.error.code };
      const j = await waitJob(d.token, r.json.data.jobId);
      return j.state === 'failed' ? { refused: j.error.code } : { done: j.result };
    };
    // Damaged: a table that does not match its listed checksum.
    const damaged = await rewriteArchive(archive, async () => {}, (m) => { m.entries['tables/trial_balance.json'].sha256 = '0'.repeat(64); });
    assert.equal((await pushJob(damaged, { checkoutId })).refused, 'SYNC_ARCHIVE_DAMAGED');
    // Wrong schema.
    const wrongSchema = await rewriteArchive(archive, async (t, m) => { m.schemaVersion = '20200101000000_example.js'; });
    assert.equal((await pushJob(wrongSchema, { checkoutId })).refused, 'SYNC_SCHEMA_MISMATCH');
    // Another period's archive.
    const wrongPeriod = await rewriteArchive(archive, async (t, m) => { m.sync.periodUid = randomUUID(); });
    assert.equal((await pushJob(wrongPeriod, { checkoutId })).refused, 'SYNC_WRONG_PERIOD');
    // Released by an admin, then changed on the server: refused either way.
    assert.equal((await api(`/api/v1/periods/${P}/checkout/release`, { method: 'POST', token: admin, json: { reason: 'Example: test release' } })).status, 200);
    const tb = await one(`SELECT account_id FROM trial_balance WHERE period_id = $1 ORDER BY account_id LIMIT 1`, [P]);
    assert.equal((await api(`/api/v1/periods/${P}/trial-balance/${tb.account_id}`, { method: 'PUT', token: admin, json: { unadjustedDebit: 777, unadjustedCredit: 0 } })).status, 200);
    assert.equal((await pushJob(archive, { checkoutId })).refused, 'SYNC_NOT_HELD');
    const noHold = await rewriteArchive(archive, async (t, m) => { m.sync.stampAtPull = m.sync.stamp; m.sync.totals = totalsOf(t); });
    assert.equal((await pushJob(noHold, { checkoutId: null })).refused, 'PERIOD_CHANGED');
  });

  await step('S4: SQ3: a web edit after the pull wins and is listed; an account added on both sides matches by number', async () => {
    const d = s4.desk;
    const P = s3.period.id;
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    const checkoutId = pull.json.data.checkoutId;
    await waitJob(d.token, pull.json.data.jobId);
    const archive = (await api(`/api/v1/sync/jobs/${pull.json.data.jobId}/archive`, { token: d.token })).buf;
    const acct = await one(`SELECT id, account_number, account_name FROM chart_of_accounts WHERE client_id = $1 ORDER BY account_number LIMIT 1`, [s3.client.id]);
    await new Promise((r) => setTimeout(r, 50));
    // On the web, after the pull: the account is renamed, and a new account is added.
    const ren = await api(`/api/v1/chart-of-accounts/${acct.id}`, { method: 'PUT', token: admin, json: { accountName: 'Example renamed on the web' } });
    if (ren.status >= 400) await sql(`UPDATE chart_of_accounts SET account_name = 'Example renamed on the web' WHERE id = $1`, [acct.id]);
    const both = `8${String(Date.now()).slice(-5)}`;
    await sql(`INSERT INTO chart_of_accounts (client_id, account_number, account_name, category, normal_balance) SELECT client_id, $2, 'Example both sides', category, normal_balance FROM chart_of_accounts WHERE id = $1`, [acct.id, both]);
    const sent = await rewriteArchive(archive, async (t, m) => {
      const a = t.chart_of_accounts.find((x) => x.id === acct.id) ?? t.chart_of_accounts.find((x) => x.account_number === acct.account_number);
      a.account_name = 'Example renamed on the desktop';
      const maxId = Math.max(...t.chart_of_accounts.map((x) => x.id));
      t.chart_of_accounts.push({ ...a, id: maxId + 1, sync_uid: randomUUID(), account_number: both, account_name: 'Example both sides' });
      m.sync.totals = totalsOf(t);
    });
    const uploadId = await uploadBuf(d.token, sent);
    const push = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId, checkoutId } });
    const j = await waitJob(d.token, push.json.data.jobId);
    assert.equal(j.state, 'done', JSON.stringify(j.error));
    assert.deepEqual(j.result.accountsAdded, [], 'the account added on both sides matched by number');
    const diff = j.result.differences.find((x) => x.kind === 'account' && x.field === 'account_name');
    assert.ok(diff, JSON.stringify(j.result.differences));
    assert.equal(diff.desktop, 'Example renamed on the desktop');
    assert.equal((await one(`SELECT account_name FROM chart_of_accounts WHERE id = $1`, [acct.id])).account_name, 'Example renamed on the web', "the server's change stays");
    assert.equal((await one(`SELECT count(*)::int AS n FROM chart_of_accounts WHERE client_id = $1 AND account_number = $2`, [s3.client.id, both])).n, 1);
    // And a new journal line on an account with no trial balance row is refused.
    const p2 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    await waitJob(d.token, p2.json.data.jobId);
    const a2 = (await api(`/api/v1/sync/jobs/${p2.json.data.jobId}/archive`, { token: d.token })).buf;
    const orphan = await rewriteArchive(a2, async (t, m) => {
      // An account with no trial balance row and no entries yet (the web would add a row first).
      const noTb = t.chart_of_accounts.find((x) => !t.trial_balance.some((r) => r.account_id === x.id) && !t.journal_entry_lines.some((l) => l.account_id === x.id));
      assert.ok(noTb, 'the fixture has an account with no trial balance row');
      const je = Math.max(0, ...t.journal_entries.map((x) => x.id)) + 5000;
      t.journal_entries.push({ ...t.journal_entries[0], id: je, entry_type: 'book', entry_number: 99999, description: 'Example orphan' });
      t.journal_entry_lines.push({ ...t.journal_entry_lines[0], id: 990001, journal_entry_id: je, account_id: noTb.id, debit: '1', credit: '0' });
      t.journal_entry_lines.push({ ...t.journal_entry_lines[0], id: 990002, journal_entry_id: je, account_id: t.trial_balance[0].account_id, debit: '0', credit: '1' });
      m.sync.totals = totalsOf(t);
    });
    const up2 = await uploadBuf(d.token, orphan);
    const r2 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId: up2, checkoutId: p2.json.data.checkoutId } });
    const j2 = await waitJob(d.token, r2.json.data.jobId);
    assert.equal(j2.error?.code, 'SYNC_ARCHIVE_INVALID', 'a new entry on an account with no trial balance row is refused (both sides would leave it out of the totals)');
    assert.equal((await api(`/api/v1/sync/checkouts/${p2.json.data.checkoutId}`, { method: 'DELETE', token: d.token })).status, 200, 'a refused send-back keeps the hold');
  });

  await step('S4: every foreign key into a period table from outside it is one the merge handles', async () => {
    const PERIOD_TABLES = ['trial_balance', 'journal_entries', 'journal_entry_lines', 'bank_transactions', 'variance_notes', 'tb_tickmarks', 'm1_adjustments',
      'engagement_tasks', 'lead_sheet_notes', 'lead_sheet_signoffs', 'py_comparison_data', 'lead_sheet_attachments', 'bank_reconciliations',
      'reconciliation_items', 'fs_reports', 'fs_report_versions'];
    // Handled: relinked by type + number, kept in place, or a period table's own child.
    const HANDLED = new Set([
      'client_documents.linked_journal_entry_id', // relinked by entry type + number
      'bank_transactions.journal_entry_id', // updated in place by uid; other periods' rows relinked
      'journal_entry_lines.journal_entry_id', 'reconciliation_items.reconciliation_id', 'reconciliation_items.transaction_id',
      'fs_report_versions.report_id', // kept by version number
      'fs_report_version_files.version_id', // versions are kept, so their PDFs stay
      'period_checkouts.period_id', 'sync_jobs.period_id', // not period tables (released by the merge / job state)
    ]);
    const rows = await sql(`
      SELECT c.conrelid::regclass::text AS from_table, a.attname AS from_col, c.confrelid::regclass::text AS to_table
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid::regclass::text = ANY ($1)`, [PERIOD_TABLES]);
    const unhandled = rows.filter((r) => !HANDLED.has(`${r.from_table}.${r.from_col}`)).map((r) => `${r.from_table}.${r.from_col} -> ${r.to_table}`);
    assert.deepEqual(unhandled, [], 'classify a new foreign key into a period table here and in mergePeriod.ts');
  });

  await step('S4: a period and a client made on the desktop arrive with their uids; an overlap or a known client is refused', async () => {
    const d = s4.desk;
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: false } });
    await waitJob(d.token, pull.json.data.jobId);
    const archive = (await api(`/api/v1/sync/jobs/${pull.json.data.jobId}/archive`, { token: d.token })).buf;
    const newUid = randomUUID();
    const asNewPeriod = (start, end) => rewriteArchive(archive, async (t, m) => {
      const own = t.periods.find((p) => p.id === m.periodId);
      Object.assign(own, { sync_uid: newUid, period_name: 'Example FY 2030', start_date: start, end_date: end, is_current: false, locked_at: null });
      for (const b of t.bank_transactions) if (b.period_id === m.periodId) b.sync_uid = randomUUID();
      // The walk's attachment has no file, and this client has no folder to store one in.
      t.lead_sheet_attachments = [];
      // Statements are finalized on the server: a new period arrives with drafts only.
      t.fs_report_versions = [];
      for (const r of t.fs_reports ?? []) { r.current_version_id = null; r.status = 'draft'; }
      m.sync.periodUid = newUid;
      m.sync.totals = totalsOf(t);
    });
    const send = async (buf, url) => {
      const uploadId = await uploadBuf(d.token, buf);
      const r = await api(url, { method: 'POST', token: d.token, json: { uploadId } });
      if (r.status !== 202) return { refused: r.json.error.code };
      const j = await waitJob(d.token, r.json.data.jobId);
      return j.state === 'failed' ? { refused: j.error.code, message: j.error.message } : { done: j.result };
    };
    const periodsUrl = `/api/v1/sync/clients/${s3.client.sync_uid}/periods/push`;
    const p0 = await one(`SELECT start_date::text AS s, end_date::text AS e FROM periods WHERE id = $1`, [s3.period.id]);
    assert.equal((await send(await asNewPeriod(p0.s, p0.e), periodsUrl)).refused, 'PERIOD_OVERLAPS');
    assert.equal((await one(`SELECT count(*)::int AS n FROM periods WHERE sync_uid = $1`, [newUid])).n, 0, 'a refused new period leaves nothing behind');
    const ok = await send(await asNewPeriod('2030-01-01', '2030-12-31'), periodsUrl);
    assert.ok(ok.done, JSON.stringify(ok));
    const made = await one(`SELECT id, client_id, is_reference, period_name FROM periods WHERE sync_uid = $1`, [newUid]);
    assert.equal(made.client_id, s3.client.id);
    assert.equal(made.is_reference, false);
    assert.equal(made.period_name, 'Example FY 2030');
    const tbN = (id) => one(`SELECT count(*)::int AS n FROM trial_balance WHERE period_id = $1`, [id]);
    assert.equal((await tbN(made.id)).n, (await tbN(s3.period.id)).n, 'its trial balance arrived');
    const again = await send(await asNewPeriod('2031-01-01', '2031-12-31'), periodsUrl);
    assert.equal(again.refused, 'SYNC_PERIOD_EXISTS');
    // A period that came along only as a reference is filled in (SQ7).
    const refUid = randomUUID();
    const ref = await one(`INSERT INTO periods (client_id, sync_uid, period_name, start_date, end_date, is_reference) VALUES ($1, $2, 'Example FY 2032', '2032-01-01', '2032-12-31', true) RETURNING id`, [s3.client.id, refUid]);
    const filled = await send(await rewriteArchive(archive, async (t, m) => {
      const own = t.periods.find((p) => p.id === m.periodId);
      Object.assign(own, { sync_uid: refUid, period_name: 'Example FY 2032', start_date: '2032-01-01', end_date: '2032-12-31', is_current: false, locked_at: null });
      for (const b of t.bank_transactions) if (b.period_id === m.periodId) b.sync_uid = randomUUID();
      t.lead_sheet_attachments = [];
      t.fs_report_versions = [];
      for (const r of t.fs_reports ?? []) { r.current_version_id = null; r.status = 'draft'; }
      m.sync.periodUid = refUid;
      m.sync.totals = totalsOf(t);
    }), periodsUrl);
    assert.ok(filled.done, JSON.stringify(filled));
    const r2 = await one(`SELECT id, is_reference FROM periods WHERE sync_uid = $1`, [refUid]);
    assert.equal(r2.id, ref.id, 'the same row');
    assert.equal(r2.is_reference, false, 'no longer a reference');
    assert.ok((await tbN(ref.id)).n > 0);

    // A whole client made on the desktop.
    const b = await api(`/api/v1/backup/client/${s3.client.id}`, { method: 'POST', token: admin, json: {} });
    assert.ok(b.status === 200 || b.status === 201, b.text);
    const backupId = b.json.data.id ?? b.json.data.backup?.id;
    const clientArchive = (await api(`/api/v1/backup/${backupId}/download`, { token: admin })).buf;
    const known = await send(clientArchive, '/api/v1/sync/clients/push');
    assert.equal(known.refused, 'CLIENT_EXISTS');
    const clientUid = randomUUID();
    const fresh = await rewriteArchive(clientArchive, async (t) => {
      t.clients[0].sync_uid = clientUid;
      t.fs_report_versions = [];
      for (const r of t.fs_reports ?? []) { r.current_version_id = null; r.status = 'draft'; }
      t.clients[0].name = (await one(`SELECT name FROM clients WHERE id = $1`, [s3.client.id])).name; // the same name: allowed, no suffix
      for (const tb of ['periods', 'chart_of_accounts', 'bank_transactions', 'fs_client_layouts']) for (const r of t[tb] ?? []) r.sync_uid = randomUUID();
    });
    // A new client whose accounts' uids are held here already is refused.
    const heldUids = await rewriteArchive(clientArchive, async (t) => {
      t.clients[0].sync_uid = randomUUID();
      t.fs_report_versions = [];
      for (const r of t.fs_reports ?? []) { r.current_version_id = null; r.status = 'draft'; }
      for (const tb of ['periods', 'bank_transactions', 'fs_client_layouts']) for (const r of t[tb] ?? []) r.sync_uid = randomUUID();
    });
    assert.equal((await send(heldUids, '/api/v1/sync/clients/push')).refused, 'SYNC_UID_EXISTS');
    const nc = await send(fresh, '/api/v1/sync/clients/push');
    assert.ok(nc.done, JSON.stringify(nc));
    const c = await one(`SELECT id, name FROM clients WHERE sync_uid = $1`, [clientUid]);
    assert.ok(c, 'the client keeps its uid');
    assert.ok(!c.name.includes('(Restored)'), 'and its name');
    assert.equal(nc.done.clientId, c.id);
    await api(`/api/v1/backup/${backupId}`, { method: 'DELETE', token: admin });
  });

  await step('S4: an attachment changed on the desktop (a stamp burned in) replaces its file; a refused send-back leaves no file behind', async () => {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const pdf = async (text) => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([300, 200]);
      page.drawText(text, { x: 20, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
      return Buffer.from(await doc.save());
    };
    const d = s4.desk;
    const P = s3.period.id;
    const folder = `Example sync attachments ${Date.now()}`;
    const link = await api(`/api/v1/storage/links/${s3.client.id}/create`, { method: 'POST', token: admin, json: { folderName: folder } });
    assert.equal(link.status, 201, link.text);
    try {
      const form = new FormData();
      form.append('file', new Blob([await pdf('Example original')], { type: 'application/pdf' }), 'example.pdf');
      const att = await api(`/api/v1/periods/${P}/lead-sheet-attachments`, { method: 'POST', token: admin, form });
      assert.equal(att.status, 201, att.text);
      const ref = att.json.data.ref_code;
      const oldDoc = att.json.data.document_id;
      const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
      const checkoutId = pull.json.data.checkoutId;
      await waitJob(d.token, pull.json.data.jobId);
      const archive = (await api(`/api/v1/sync/jobs/${pull.json.data.jobId}/archive`, { token: d.token })).buf;
      const stamped = await pdf('Example original - reviewed');
      const withStamp = (totalsDelta) => rewriteArchive(archive, async (t, m, entries) => {
        const a = t.lead_sheet_attachments.find((x) => x.ref_code === ref);
        const doc = t.client_documents.find((x) => x.id === a.document_id);
        assert.ok(entries.has(`files/${doc.id}`), 'the pull carried the file');
        entries.set(`files/${doc.id}`, stamped);
        doc.sha256 = sha256Hex(stamped);
        doc.file_size = stamped.length;
        const tt = totalsOf(t);
        m.sync.totals = { bookDebit: String(BigInt(tt.bookDebit) + totalsDelta), bookCredit: tt.bookCredit };
      });
      const docsBefore = (await one(`SELECT count(*)::int AS n FROM client_documents WHERE client_id = $1`, [s3.client.id])).n;
      // Refused (the totals are off): the file stored for it is removed again.
      const up1 = await uploadBuf(d.token, await withStamp(1n));
      const r1 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId: up1, checkoutId } });
      const j1 = await waitJob(d.token, r1.json.data.jobId);
      assert.equal(j1.error?.code, 'SYNC_TOTALS_MISMATCH');
      assert.equal((await one(`SELECT count(*)::int AS n FROM client_documents WHERE client_id = $1`, [s3.client.id])).n, docsBefore, 'no document left behind');
      assert.equal((await one(`SELECT document_id FROM lead_sheet_attachments WHERE period_id = $1 AND ref_code = $2`, [P, ref])).document_id, oldDoc);
      // Accepted: the attachment points at the new file; the old one is gone.
      const up2 = await uploadBuf(d.token, await withStamp(0n));
      const r2 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId: up2, checkoutId } });
      const j2 = await waitJob(d.token, r2.json.data.jobId);
      assert.equal(j2.state, 'done', JSON.stringify(j2.error));
      const now = await one(`SELECT a.document_id, d.sha256 FROM lead_sheet_attachments a JOIN client_documents d ON d.id = a.document_id WHERE a.period_id = $1 AND a.ref_code = $2`, [P, ref]);
      assert.notEqual(now.document_id, oldDoc);
      assert.equal(now.sha256, sha256Hex(stamped));
      assert.equal((await one(`SELECT count(*)::int AS n FROM client_documents WHERE id = $1`, [oldDoc])).n, 0, 'the old document is removed');
      const file = await api(`/api/v1/documents/${now.document_id}/download`, { token: admin });
      if (file.status === 200) assert.equal(sha256Hex(file.buf), sha256Hex(stamped), 'the stored bytes are the stamped ones');
    } finally {
      const l = await one(`SELECT storage_path FROM client_folder_links WHERE client_id = $1`, [s3.client.id]);
      await sql(`DELETE FROM client_folder_links WHERE client_id = $1`, [s3.client.id]);
      if (l?.storage_path) {
        const fsm = await import('node:fs');
        fsm.rmSync(path.join(SERVER, 'uploads', l.storage_path), { recursive: true, force: true });
      }
    }
  });

  await step('Review fixes: desktop ids, issued statements, authorship, a duplicate import, a deleted tickmark', async () => {
    const d = s4.desk;
    const P = s3.period.id;
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    const checkoutId = pull.json.data.checkoutId;
    await waitJob(d.token, pull.json.data.jobId);
    const archive = (await api(`/api/v1/sync/jobs/${pull.json.data.jobId}/archive`, { token: d.token })).buf;
    assert.ok((await one(`SELECT count(*)::int AS n FROM fs_report_versions v JOIN fs_reports r ON r.id = v.report_id WHERE r.period_id = $1`, [P])).n > 0, 'the period has an issued statement (the walk finalized one)');
    // A tickmark no period uses, deleted on the server while the period is out.
    const tm = await one(`INSERT INTO tickmark_library (client_id, symbol, description) VALUES ($1, 'ZD', 'Example deleted') RETURNING id`, [s3.client.id]);
    const p2 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    await waitJob(d.token, p2.json.data.jobId);
    const archive2 = (await api(`/api/v1/sync/jobs/${p2.json.data.jobId}/archive`, { token: d.token })).buf;
    void archive;
    assert.equal((await api(`/api/v1/tickmarks/${tm.id}`, { method: 'DELETE', token: admin })).status, 200);
    const other = (await one(`SELECT id FROM app_users WHERE username = 'example.reviewer'`)).id;
    const me = (await api('/api/v1/sync/me', { token: d.token })).json.data.user.id;
    // As a desktop writes it: its own ids for accounts and lead sheets, everywhere they appear.
    const K = 700000;
    const shift = (v) => (v == null ? v : Number(v) + K);
    const shiftJson = (j) => {
      if (Array.isArray(j)) return j.map(shiftJson);
      if (j && typeof j === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(j)) {
          if (k === 'accountId' || k === 'groupingId') out[k] = v == null ? v : String(Number(v) + K);
          else if (k === 'columnCaptions' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([a, c]) => [String(Number(a) + K), c]));
          else out[k] = shiftJson(v);
        }
        return out;
      }
      return j;
    };
    const sent = await rewriteArchive(archive2, async (t, m) => {
      for (const a of t.chart_of_accounts) a.id = shift(a.id);
      for (const l of t.lead_sheets ?? []) l.id = shift(l.id);
      for (const a of t.chart_of_accounts) if (a.lead_sheet_id != null) a.lead_sheet_id = shift(a.lead_sheet_id);
      for (const [tb, cols] of Object.entries({
        trial_balance: ['account_id'], journal_entry_lines: ['account_id'], variance_notes: ['account_id'], tb_tickmarks: ['account_id'],
        lead_sheet_notes: ['account_id', 'lead_sheet_id'], lead_sheet_signoffs: ['lead_sheet_id'], py_comparison_data: ['account_id'],
        lead_sheet_attachments: ['account_id', 'lead_sheet_id'], bank_reconciliations: ['source_account_id'],
        bank_transactions: ['account_id', 'ai_suggested_account_id', 'source_account_id'],
      })) for (const r of t[tb] ?? []) for (const c of cols) r[c] = shift(r[c]);
      for (const l of t.fs_client_layouts ?? []) l.layout_json = shiftJson(l.layout_json);
      for (const v of t.fs_report_versions ?? []) v.layout_json = shiftJson(v.layout_json);
      // Authorship: a sign-off "by" someone else, and a task "completed by" someone else.
      const ls = t.lead_sheets[0];
      t.lead_sheet_signoffs = [...(t.lead_sheet_signoffs ?? []), {
        ...(t.lead_sheet_signoffs?.[0] ?? {}), id: 990, period_id: m.periodId, lead_sheet_id: ls.id, role: 'reviewer',
        user_id: other, user_name: 'Example Reviewer', balance_stamp: 'f'.repeat(64), signed_at: new Date().toISOString(), invalidated_at: null, invalidated_by: null,
      }].filter((x) => !(x.lead_sheet_id === ls.id && x.role === 'reviewer' && x.id !== 990));
      t.engagement_tasks = [...(t.engagement_tasks ?? []), {
        id: 991, period_id: m.periodId, title: 'Example forged task', description: null, category: null, status: 'completed',
        assignee_id: other, sort_order: 0, notes: null, completed_by: other, completed_at: new Date().toISOString(), created_by: other,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }];
      m.sync.totals = totalsOf(t);
    });
    const up = await uploadBuf(d.token, sent);
    const r = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId: up, checkoutId: p2.json.data.checkoutId } });
    const j = await waitJob(d.token, r.json.data.jobId);
    assert.equal(j.state, 'done', `desktop ids and an issued statement send back: ${JSON.stringify(j.error)}`);
    assert.ok(!await one(`SELECT 1 FROM tickmark_library WHERE client_id = $1 AND symbol = 'ZD'`, [s3.client.id]), 'deleted on the server: not added back');
    const sign = await one(`SELECT user_id, user_name, balance_stamp FROM lead_sheet_signoffs WHERE period_id = $1 AND role = 'reviewer' AND invalidated_at IS NULL ORDER BY id DESC LIMIT 1`, [P]);
    assert.equal(sign.user_id, me, 'nobody signs for another');
    assert.notEqual(sign.balance_stamp, 'f'.repeat(64), 'the server computes the balance stamp');
    const task = await one(`SELECT completed_by, assignee_id, created_by FROM engagement_tasks WHERE period_id = $1 AND title = 'Example forged task'`, [P]);
    assert.deepEqual([task.completed_by, task.assignee_id, task.created_by], [null, null, null], 'a user the period never had in that role is blanked');
    void checkoutId;

    // A statement line imported on the desktop that the server has already: a plain refusal.
    const p3 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    await waitJob(d.token, p3.json.data.jobId);
    const a3 = (await api(`/api/v1/sync/jobs/${p3.json.data.jobId}/archive`, { token: d.token })).buf;
    const elsewhere = await one(`INSERT INTO bank_transactions (client_id, transaction_date, description, amount, classification_status, import_hash)
                                 VALUES ($1, '2025-03-01', 'Example elsewhere', 100, 'unclassified', 'example-hash-1') RETURNING id`, [s3.client.id]);
    const dup = await rewriteArchive(a3, async (t, m) => {
      t.bank_transactions.push({ ...t.bank_transactions.find((b) => b.period_id === m.periodId), id: 995000, sync_uid: randomUUID(), import_hash: 'example-hash-1', journal_entry_id: null, account_id: null });
      m.sync.totals = totalsOf(t);
    });
    const r3 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId: await uploadBuf(d.token, dup), checkoutId: p3.json.data.checkoutId } });
    assert.equal((await waitJob(d.token, r3.json.data.jobId)).error?.code, 'SYNC_DUPLICATE_IMPORT');
    await sql(`DELETE FROM bank_transactions WHERE id = $1`, [elsewhere.id]);
    // Deleted and imported again on the desktop (same line, a new uid): fine.
    const own = await one(`SELECT id FROM bank_transactions WHERE period_id = $1 AND journal_entry_id IS NULL ORDER BY id LIMIT 1`, [P]);
    if (own) await sql(`UPDATE bank_transactions SET import_hash = 'example-hash-2' WHERE id = $1`, [own.id]);
    const p4 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    await waitJob(d.token, p4.json.data.jobId);
    const a4 = (await api(`/api/v1/sync/jobs/${p4.json.data.jobId}/archive`, { token: d.token })).buf;
    const again = await rewriteArchive(a4, async (t, m) => {
      const b = t.bank_transactions.find((x) => x.import_hash === 'example-hash-2');
      if (b) { b.sync_uid = randomUUID(); b.id = 996000; }
      m.sync.totals = totalsOf(t);
    });
    const r4 = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: d.token, json: { uploadId: await uploadBuf(d.token, again), checkoutId: p4.json.data.checkoutId } });
    const j4 = await waitJob(d.token, r4.json.data.jobId);
    assert.equal(j4.state, 'done', JSON.stringify(j4.error));
  });

  await step('Review fixes: a removed desktop releases its holds; a manifest bomb is refused; a new client carries no storage pointers', async () => {
    const d = await pairWith(admin, 'Example removed desktop');
    const pull = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/pull`, { method: 'POST', token: d.token, json: { checkout: true } });
    await waitJob(d.token, pull.json.data.jobId);
    assert.equal((await api(`/api/v1/desktop-sync/devices/${d.deviceId}`, { method: 'DELETE', token: admin })).status, 200);
    assert.ok((await one(`SELECT released_at FROM period_checkouts WHERE id = $1`, [pull.json.data.checkoutId])).released_at, 'released with its desktop');
    // A manifest that inflates past its cap.
    const dd = s4.desk;
    const bomb = await new Promise((resolve, reject) => {
      const chunks = [];
      const z = archiver('zip', { zlib: { level: 9 } });
      z.on('data', (x) => chunks.push(x)); z.on('end', () => resolve(Buffer.concat(chunks))); z.on('error', reject);
      z.append(Buffer.concat([Buffer.from('{"pad":"'), Buffer.alloc(20 * 1024 * 1024, 0x20), Buffer.from('"}')]), { name: 'manifest.json' });
      void z.finalize();
    });
    assert.ok(bomb.length < 1024 * 1024, 'small on the wire');
    const r = await api(`/api/v1/sync/periods/${s3.period.sync_uid}/push`, { method: 'POST', token: dd.token, json: { uploadId: await uploadBuf(dd.token, bomb), checkoutId: null } });
    assert.equal((await waitJob(dd.token, r.json.data.jobId)).error?.code, 'SYNC_ARCHIVE_INVALID');
    assert.equal((await api('/api/v1/sync/me', { token: dd.token })).status, 200, 'the server is still up');
    // A client from a desktop: documents without storage pointers, no folder link.
    const b = await api(`/api/v1/backup/client/${s3.client.id}`, { method: 'POST', token: admin, json: {} });
    const backupId = b.json.data.id ?? b.json.data.backup?.id;
    const ca = (await api(`/api/v1/backup/${backupId}/download`, { token: admin })).buf;
    const uid = randomUUID();
    const forged = await rewriteArchive(ca, async (t) => {
      t.clients[0].sync_uid = uid;
      for (const tb of ['periods', 'chart_of_accounts', 'bank_transactions', 'fs_client_layouts']) for (const x of t[tb] ?? []) x.sync_uid = randomUUID();
      t.fs_report_versions = [];
      for (const x of t.fs_reports ?? []) { x.current_version_id = null; x.status = 'draft'; }
      t.client_folder_links = [{ id: 1, client_id: t.clients[0].id, storage_path: 'Example stolen folder', storage_backend: 'local', status: 'linked' }];
      t.client_documents = [...(t.client_documents ?? []), { id: 424242, client_id: t.clients[0].id, filename: 'x.pdf', object_key: 'Other Client/secret.pdf', storage_backend: 'local', file_size: 1, file_type: 'application/pdf' }];
      t.app_users = [{ id: 1, username: 'example.injected', role: 'admin' }];
    });
    const sentC = await api('/api/v1/sync/clients/push', { method: 'POST', token: dd.token, json: { uploadId: await uploadBuf(dd.token, forged) } });
    const jc = await waitJob(dd.token, sentC.json.data.jobId);
    assert.equal(jc.state, 'done', JSON.stringify(jc.error));
    const cid = (await one(`SELECT id FROM clients WHERE sync_uid = $1`, [uid])).id;
    assert.equal((await one(`SELECT count(*)::int AS n FROM client_documents WHERE client_id = $1 AND object_key IS NOT NULL`, [cid])).n, 0, 'no storage pointer kept');
    assert.equal((await one(`SELECT count(*)::int AS n FROM client_folder_links WHERE client_id = $1`, [cid])).n, 0, 'no folder link');
    assert.equal((await one(`SELECT count(*)::int AS n FROM app_users WHERE username = 'example.injected'`)).n, 0, 'no user');
    await api(`/api/v1/backup/${backupId}`, { method: 'DELETE', token: admin });
  });

  await step('S5: everything above went through a proxy that cuts bodies over 1.5 MB and sync responses after 15 s, and nothing was cut', async () => {
    assert.equal(proxyCuts, 0);
    // The proxy does cut: a body over the cap is refused before the server sees it.
    const big = await fetch(`${server.base}/api/v1/sync/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(PROXY_BODY_CAP + 10) }).catch(() => null);
    assert.ok(!big || big.status === 413);
    const caps = await api('/api/v1/sync/capabilities', { token: s4.desk.token });
    assert.ok(caps.json.data.partBytes < PROXY_BODY_CAP, 'the parts the server asks for fit under the cap');
  });

  await step('pairing is rate limited by address, whatever token a guesser sends', async () => {
    let limited = false;
    for (let i = 0; i < 14 && !limited; i++) {
      // A made-up, unsigned JWT naming a different user each time must not
      // buy a fresh bucket.
      const fake = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId: 1000 + i })).toString('base64url')}.`;
      const r = await fetch(server.base + '/api/v1/sync/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fake}` },
        body: JSON.stringify({ code: 'ABCD-EFGH', deviceName: 'Guess' }),
      });
      limited = r.status === 429;
    }
    assert.ok(limited, 'refused after 10 tries in 15 minutes');
  });

  log(`\n${passed} steps passed`);
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  if (!(err instanceof assert.AssertionError)) {
    console.error('\n--- last server output ---');
    console.error(lines.slice(-80).join('\n'));
  }
  console.error('\n', err);
} finally {
  if (server) await killTree(server.child);
  await dropScratchDb();
}
process.exit(failed ? 1 : 0);
