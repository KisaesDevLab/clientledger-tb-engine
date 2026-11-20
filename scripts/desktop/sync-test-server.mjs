#!/usr/bin/env node
// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// A real firm server for the desktop's sync tests (ClientLedger Trial
// Balance P12): this repository's server, NOT in desktop mode, on a scratch
// Postgres database with the demo client (Summit Ridge). Prints ONE JSON
// line on stdout once ready:
//
//   {"base":"http://127.0.0.1:<port>","code":"XXXX-XXXX"}   (a pairing code)
//
// then serves until its stdin closes (the test ends), and drops the database.
//
//   E2E_PG_ADMIN_URL   a Postgres the test may CREATE DATABASE on (required)
//   E2E_VERBOSE=1      the server's output to stderr
//
// The setup steps are upstream's (test/sync-e2e.mjs).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = require('pg');
const SERVER = fileURLToPath(new URL('../../server/', import.meta.url));
const KNEX_CLI = path.join(SERVER, 'node_modules', 'knex', 'bin', 'cli.js');
const TSX = ['--import', 'tsx'];
const ADMIN_URL = process.env.E2E_PG_ADMIN_URL;
const VERBOSE = process.env.E2E_VERBOSE === '1';
const PASSWORD = 'SyncTest!2026';
if (!ADMIN_URL) {
  console.error('E2E_PG_ADMIN_URL is required');
  process.exit(2);
}

const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const note = (s) => { if (VERBOSE) process.stderr.write(`${s}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function childEnv(extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'APP_BASE_URL', 'ALLOWED_ORIGIN', 'VIBE_AI_MODE', 'MAIL_TRANSPORT', 'DESKTOP_MODE']) env[k] = '';
  return { ...env, ...extra };
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    c.stdout.on('data', (d) => note(String(d)));
    c.stderr.on('data', (d) => { err += d; note(String(d)); });
    c.on('exit', (code) => resolve({ code, err }));
  });
}

const admin = new Client({ connectionString: ADMIN_URL });
await admin.connect();
const dbName = `cltb_sync_test_${Date.now().toString(36)}`;
await admin.query(`CREATE DATABASE "${dbName}"`);
const u = new URL(ADMIN_URL);
u.pathname = `/${dbName}`;
const dbUrl = u.toString();
const secrets = { JWT_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex') };
let server = null;

async function cleanup(code) {
  if (server) server.kill();
  await sleep(300);
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
  process.exit(code);
}

try {
  const env = childEnv({ ...secrets, NODE_ENV: 'development', DATABASE_URL: dbUrl });
  const mig = await run(process.execPath, [...TSX, 'src/migrate.ts'], env);
  if (mig.code !== 0) throw new Error(`migrations failed: ${mig.err}`);
  for (const s of ['001_default_admin.js', '004_comprehensive_demo.js']) {
    const seed = await run(process.execPath, [KNEX_CLI, 'seed:run', '--knexfile', 'knexfile.js', '--specific', s], env);
    if (seed.code !== 0) throw new Error(`seed ${s} failed: ${seed.err}`);
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [...TSX, 'src/app.ts'], {
    cwd: SERVER,
    env: childEnv({ ...secrets, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: dbUrl, MIGRATIONS_AUTO: 'false', VIBE_AUTH_MODE: 'local', SYNC_PART_BYTES: String(1024 * 1024) }),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  server.stdout.on('data', (d) => note(String(d)));
  server.stderr.on('data', (d) => note(String(d)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await fetch(`${base}/api/v1/health`).then((r) => r.status === 200).catch(() => false)) break;
    if (server.exitCode !== null) throw new Error('the server exited before it was healthy');
    if (Date.now() > deadline) throw new Error('the server was not healthy in 60 s');
    await sleep(200);
  }
  const api = async (p, method, token, json) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(base + p, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  let login = await api('/api/v1/auth/login', 'POST', null, { username: 'admin', password: 'admin1234' });
  const rot = await api('/api/v1/auth/change-password', 'POST', login.json.data.token, { currentPassword: 'admin1234', newPassword: PASSWORD });
  if (rot.status !== 200) throw new Error(`password rotation: ${JSON.stringify(rot.json)}`);
  login = await api('/api/v1/auth/login', 'POST', null, { username: 'admin', password: PASSWORD });
  const made = await api('/api/v1/desktop-sync/codes', 'POST', login.json.data.token);
  say({ base, code: made.json.data.code });
  process.stdin.resume();
  process.stdin.on('end', () => { cleanup(0); });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await cleanup(1);
}
