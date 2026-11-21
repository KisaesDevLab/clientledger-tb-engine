#!/usr/bin/env node
// Single sign-on end-to-end check for Trial Balance (Vibe Auth integration
// plan, rule I13). Boots the real server against a scratch Postgres database
// and a fake OpenID provider (test/fake-idp.mjs) and walks the eleven
// scenarios the plan names: status in local/both, PKCE login → JIT with the
// mapped role, existing-user email link + role sync, unverified email denied,
// /auth/settings 403/200, the oidc_only guard, break-glass local login +
// audit, back-channel logout revokes, fresh login after revocation,
// RP-initiated logout, boot refusal without break-glass. Steps H1–H4 add the
// hardening rules: the break-glass account is protected, SSO-only accounts
// cannot self-service reset, role sync never demotes the last admin.
//
//   npm run test:sso-e2e            (from the repo root or server/)
//
// Prerequisites: a Postgres the dev credentials can CREATE DATABASE on
// (docker compose up -d gives one), server/node_modules installed.
//   E2E_PG_ADMIN_URL   admin connection (default: the compose dev instance)
//   E2E_KEEP_DB=1      leave the scratch database behind for inspection
//   E2E_VERBOSE=1      stream the server's output instead of buffering it
//
// Design notes, each of which cost a debugging round:
//   - Mode changes are RESTARTS. A successful PUT /auth/settings {mode} is
//     persisted and overrides VIBE_AUTH_MODE for every later boot, which would
//     silently break the boot-refusal scenario. The only PUT here is the guard
//     scenario, refused before anything is stored.
//   - The port is chosen by this script, not the child: VIBE_OIDC_PUBLIC_URL
//     (and so the redirect URI registered with the IdP) is baked in at boot.
//   - The env is a whitelist. server/.env is read by dotenv, which never
//     overrides a set variable, so everything that matters is set explicitly.
//   - A token's `iat` has whole-second resolution while the revocation
//     moment is in milliseconds: a login in the same second as a back-channel
//     logout is still revoked. The fresh-login scenario waits it out.
//   - A back-channel token needs `sub`. Trial Balance's JWT `sid` is its own
//     random id, so a sid-only token cannot reach it; revocation is by
//     subject → user (rule I6), and that is what real providers send.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { FakeIdp } from './fake-idp.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = require('pg');

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVER = path.join(ROOT, 'server');
const KNEX_CLI = path.join(SERVER, 'node_modules', 'knex', 'bin', 'cli.js');
const VIBE_CLI = path.join(SERVER, 'node_modules', '@kisaesdevlab', 'vibe-auth', 'dist', 'cli.js');
const TSX_IMPORT = ['--import', 'tsx']; // resolved from cwd = server/, one process (no wrapper to orphan)

const ADMIN_URL = process.env.E2E_PG_ADMIN_URL
  ?? `postgres://vibetb:localdev123@127.0.0.1:${process.env.POSTGRES_PUBLISH_PORT ?? '5432'}/postgres`; // the compose dev db
const VERBOSE = process.env.E2E_VERBOSE === '1';
const KEEP_DB = process.env.E2E_KEEP_DB === '1';

const CLIENT_ID = 'vibe-tb-e2e';
const CLIENT_SECRET = 's3cret';
const BREAKGLASS_PASSWORD = 'E2eBreakGlass!2026';
const ADMIN_PASSWORD = 'E2eAdmin!2026';
const PAT_PASSWORD = 'E2ePat!2026';

const KURT = { sub: 'u-100', email: 'kurt@kisaes.com', email_verified: true, name: 'Kurt', groups: ['vibe-partner'], amr: ['pwd', 'otp'] };
const PAT_IDP = { sub: 'u-200', email: 'pat@kisaes.com', email_verified: true, name: 'Pat', groups: ['vibe-partner'] };
const NOBODY = { sub: 'u-300', email: 'nobody@kisaes.com', email_verified: false, groups: ['vibe-partner'] };

// ─────────────────────────────────────────────────────────────── plumbing

const t0 = Date.now();
const log = (line) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${line}`);

class Ring {
  lines = [];
  push(prefix, chunk) {
    for (const l of String(chunk).split(/\r?\n/)) {
      if (!l) continue;
      const line = `${prefix} ${l}`;
      if (VERBOSE) console.log(line);
      this.lines.push(line);
      if (this.lines.length > 400) this.lines.shift();
    }
  }
  dump() {
    if (this.lines.length) console.error(this.lines.slice(-200).join('\n'));
  }
}
const output = new Ring();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Whitelisted environment for every child: nothing from the developer's shell or server/.env leaks in. */
function childEnv(extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const empty = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'APP_BASE_URL', 'ALLOWED_ORIGIN', 'VIBE_AI_MODE', 'MAIL_TRANSPORT',
    'VIBE_OIDC_INTERNAL_BASE', 'VIBE_OIDC_ROLE_MAP', 'VIBE_OIDC_DEFAULT_ROLE', 'VIBE_OIDC_REQUIRE_MFA_AMR', 'VIBE_OIDC_IDP_NAME'];
  for (const k of empty) env[k] = '';
  return { ...env, ...extra };
}

function run(cmd, args, { cwd, env, prefix }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; output.push(prefix, c); });
    child.stderr.on('data', (c) => { stderr += c; output.push(prefix, c); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function killTree(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────── database

let admin;      // pg client on the maintenance db
let dbc;        // pg client on the scratch db
let dbName;
let dbUrl;

async function createScratchDb() {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const stale = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE 'vibe_tb_sso_e2e_%'`);
  for (const r of stale.rows) {
    log(`dropping leftover ${r.datname}`);
    await admin.query(`DROP DATABASE "${r.datname}" WITH (FORCE)`);
  }
  dbName = `vibe_tb_sso_e2e_${Date.now().toString(36)}`;
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

async function auditActions() {
  return (await sql(`SELECT action, entity_id, description FROM audit_log WHERE entity_type = 'auth' ORDER BY id`))
    .map((r) => ({ action: r.action, entityId: r.entity_id, detail: safeJson(r.description) }));
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };
const hasAudit = (rows, action, pred = () => true) => rows.some((r) => r.action === action && pred(r));

// ─────────────────────────────────────────────────────────────── server

const secrets = { JWT_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex') };
let idp;
let server = null; // { child, port, base }

function serverEnv(mode, port) {
  return childEnv({
    ...secrets,
    NODE_ENV: 'development',
    PORT: String(port),
    DATABASE_URL: dbUrl,
    MIGRATIONS_AUTO: 'false',
    VIBE_AUTH_MODE: mode,
    VIBE_OIDC_ISSUER: idp.issuer,
    VIBE_OIDC_CLIENT_ID: CLIENT_ID,
    VIBE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    VIBE_OIDC_PUBLIC_URL: `http://127.0.0.1:${port}`,
    VIBE_BREAKGLASS_USERNAME: 'vibe-breakglass',
  });
}

/** Boot the server in `mode`; resolves once /api/v1/health answers (and, for SSO modes, the IdP is discovered). */
async function startServer(mode) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...TSX_IMPORT, 'src/app.ts'], {
    cwd: SERVER, env: serverEnv(mode, port), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (c) => output.push(`[server:${mode}]`, c));
  child.stderr.on('data', (c) => output.push(`[server:${mode}]`, c));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const code = await Promise.race([exited, sleep(150).then(() => null)]);
    if (code !== null) throw new Error(`server (${mode}) exited with code ${code} before becoming healthy`);
    const ok = await fetch(`${base}/api/v1/health`).then((r) => r.status === 200).catch(() => false);
    if (ok) break;
  }
  if (mode !== 'local') {
    const until = Date.now() + 15_000;
    for (;;) {
      const s = await fetch(`${base}/auth/status`).then((r) => r.json()).catch(() => null);
      if (s?.oidc?.reachable) break;
      if (Date.now() > until) throw new Error(`IdP not reachable from the server: ${JSON.stringify(s)}`);
      await sleep(150);
    }
  }
  server = { child, port, base, mode };
  log(`server up (${mode}) on ${base}`);
  return server;
}

/** Boot in `mode` and expect the process to refuse; returns {code, stderrTail}. */
async function startServerExpectingRefusal(mode) {
  const port = await freePort();
  let stderr = '';
  const child = spawn(process.execPath, [...TSX_IMPORT, 'src/app.ts'], {
    cwd: SERVER, env: serverEnv(mode, port), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (c) => output.push(`[server:${mode}]`, c));
  child.stderr.on('data', (c) => { stderr += c; output.push(`[server:${mode}]`, c); });
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', (c) => resolve(c))),
    sleep(30_000).then(() => 'timeout'),
  ]);
  if (code === 'timeout') { await killTree(child); throw new Error(`server (${mode}) did not exit within 30 s`); }
  return { code, stderr };
}

async function stopServer() {
  if (!server) return;
  await killTree(server.child);
  log(`server stopped (${server.mode})`);
  server = null;
}

// ─────────────────────────────────────────────────────────────── http helpers

async function api(p, { method = 'GET', token, json, form, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(server.base + p, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, headers: res.headers, location: res.headers.get('location') ?? '', text, json: data };
}

const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

/** Follow /auth/oidc/start → IdP (auto-consent) → callback; return the final hop. */
async function ssoLogin({ returnTo } = {}) {
  let url = server.base + '/auth/oidc/start' + (returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '');
  let res;
  let text = '';
  for (let hop = 0; hop < 8; hop++) {
    res = await fetch(url, { redirect: 'manual' });
    const location = res.headers.get('location') ?? '';
    if (res.status >= 300 && res.status < 400 && location) {
      if (url.includes('/auth/oidc/callback')) {
        // End of the flow: the app's post-login redirect carries the token on its fragment.
        const frag = location.split('#')[1] ?? '';
        const token = new URLSearchParams(frag).get('sso_token');
        return { status: res.status, location, token, claims: token ? decodeJwt(token) : null };
      }
      url = new URL(location, url).toString();
      continue;
    }
    text = await res.text();
    return { status: res.status, location, token: null, claims: null, text, contentType: res.headers.get('content-type') ?? '' };
  }
  throw new Error('login redirect chain did not terminate');
}

async function localLogin(username, password) {
  return api('/api/v1/auth/login', { method: 'POST', json: { username, password } });
}

async function breakglassCli(...args) {
  const r = await run(process.execPath, [...TSX_IMPORT, VIBE_CLI, 'breakglass', ...args, '--json'], {
    cwd: SERVER,
    env: childEnv({ ...secrets, NODE_ENV: 'development', DATABASE_URL: dbUrl, VIBE_AUTH_ADAPTER: './src/vibeAuthAdapter.ts', VIBE_BREAKGLASS_USERNAME: 'vibe-breakglass', VIBE_BREAKGLASS_PASSWORD: BREAKGLASS_PASSWORD }),
    prefix: '[cli]',
  });
  assert.equal(r.code, 0, `breakglass ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  const line = r.stdout.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
  assert.ok(line, `breakglass ${args.join(' ')} printed no JSON: ${r.stdout}`);
  return JSON.parse(line);
}

// ─────────────────────────────────────────────────────────────── scenarios

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    log(`ok   ${name}`);
  } catch (err) {
    log(`FAIL ${name}`);
    throw err;
  }
}

async function main() {
  await createScratchDb();

  const mig = await run(process.execPath, [...TSX_IMPORT, 'src/migrate.ts'], {
    cwd: SERVER, env: childEnv({ ...secrets, NODE_ENV: 'development', DATABASE_URL: dbUrl }), prefix: '[migrate]',
  });
  assert.equal(mig.code, 0, `migrations failed: ${mig.stderr}`);
  const seed = await run(process.execPath, [KNEX_CLI, 'seed:run', '--knexfile', 'knexfile.js', '--specific', '001_default_admin.js'], {
    cwd: SERVER, env: childEnv({ ...secrets, NODE_ENV: 'development', DATABASE_URL: dbUrl }), prefix: '[seed]',
  });
  assert.equal(seed.code, 0, `admin seed failed: ${seed.stderr}`);

  dbc = new Client({ connectionString: dbUrl });
  await dbc.connect();
  for (const t of ['auth_identities', 'auth_settings', 'auth_revocations', 'auth_sessions_oidc']) {
    assert.equal((await sql(`SELECT to_regclass($1) AS t`, [t]))[0].t, t, `migration did not create ${t}`);
  }

  idp = await new FakeIdp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: KURT }).start();
  log(`fake IdP at ${idp.issuer}`);

  let adminToken;
  let patToken;
  let patId;

  // ── Boot A: local ─────────────────────────────────────────────────────
  await startServer('local');

  await step('1. status in local mode: SSO off, local login visible, start refused', async () => {
    const s = await api('/auth/status');
    assert.equal(s.status, 200);
    assert.equal(s.json.mode, 'local');
    assert.equal(s.json.oidc.enabled, false);
    assert.equal(s.json.localLoginVisible, true);
    assert.equal(s.json.breakglassPath, '/login/local');
    assert.equal((await api('/auth/oidc/start')).status, 409);
    const login = await localLogin('admin', 'admin1234');
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.data.stage, 'ok');
    adminToken = login.json.data.token;
  });

  await step('fixtures: rotate the bootstrap password, create a preparer', async () => {
    const rot = await api('/api/v1/auth/change-password', { method: 'POST', token: adminToken, json: { currentPassword: 'admin1234', newPassword: ADMIN_PASSWORD } });
    assert.equal(rot.status, 200, rot.text);
    const login = await localLogin('admin', ADMIN_PASSWORD);
    assert.equal(login.status, 200, login.text);
    adminToken = login.json.data.token;
    const create = await api('/api/v1/users', { method: 'POST', token: adminToken, json: { username: 'pat', displayName: 'Pat', email: 'pat@kisaes.com', password: PAT_PASSWORD, role: 'preparer' } });
    assert.equal(create.status, 201, create.text);
    patId = create.json.data.id;
    const pl = await localLogin('pat', PAT_PASSWORD);
    assert.equal(pl.status, 200, pl.text);
    patToken = pl.json.data.token;
  });

  await step('5. /auth/settings is 403 anonymous and for a preparer, 200 for an admin', async () => {
    assert.equal((await api('/auth/settings')).status, 403);
    assert.equal((await api('/auth/settings', { token: patToken })).status, 403);
    const r = await api('/auth/settings', { token: adminToken });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.mode, 'local');
    assert.equal(r.json.breakglass?.exists, false);
    assert.equal(r.json.effective?.redirectUri, `${server.base}/auth/oidc/callback`);
  });

  await step('6. oidc_only cannot be enabled from Settings without break-glass + a fresh test connection', async () => {
    const r = await api('/auth/settings', { method: 'PUT', token: adminToken, json: { mode: 'oidc_only' } });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error, 'validation_failed');
    const errs = r.json.errors.join(' ');
    assert.match(errs, /break-glass/);
    assert.match(errs, /Test connection/);
    assert.equal((await api('/auth/settings', { method: 'PUT', token: patToken, json: { mode: 'oidc_only' } })).status, 403);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_settings'))[0].n, 0, 'a refused PUT must persist nothing');
    assert.ok(!hasAudit(await auditActions(), 'vibe.auth.mode.changed'));
  });

  await stopServer();

  // ── Boot B: oidc_only without break-glass ─────────────────────────────
  await step('11. boot is refused in oidc_only mode while no break-glass user exists', async () => {
    const { code, stderr } = await startServerExpectingRefusal('oidc_only');
    assert.equal(code, 1);
    assert.match(stderr, /break-glass user "vibe-breakglass" does not exist/);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM app_users WHERE username = 'vibe-breakglass'`))[0].n, 0);
  });

  // ── Boot C: both ──────────────────────────────────────────────────────
  await startServer('both');
  let kurtId;
  let kurtSid;
  let revokedAt;

  await step('2. status in both mode: SSO enabled and reachable', async () => {
    const s = (await api('/auth/status')).json;
    assert.equal(s.mode, 'both');
    assert.equal(s.oidc.enabled, true);
    assert.equal(s.oidc.reachable, true);
    assert.equal(s.oidc.issuer, idp.issuer);
    assert.equal(s.oidc.startPath, '/auth/oidc/start');
    assert.equal(s.localLoginVisible, true);
  });

  await step('3. PKCE login provisions a new user with the mapped role and hands the token over on the fragment', async () => {
    idp.user = KURT;
    const r = await ssoLogin();
    assert.equal(r.status, 302, r.text);
    assert.match(r.location, /^\/login#sso_token=/);
    assert.ok(r.token, 'no sso_token on the fragment');
    assert.equal(r.claims.username, 'kurt');
    assert.equal(r.claims.role, 'admin', 'vibe-partner must map to admin');
    assert.equal(typeof r.claims.sid, 'string');
    assert.ok(idp.tokenRequests.at(-1).get('code_verifier'), 'PKCE verifier not sent');
    const [u] = await sql(`SELECT id, username, role, is_active, must_change_password, email_verified_at, email FROM app_users WHERE email = $1`, [KURT.email]);
    assert.ok(u, 'JIT user missing');
    kurtId = u.id;
    kurtSid = r.claims.sid;
    assert.equal(u.username, 'kurt');
    assert.equal(u.role, 'admin');
    assert.equal(u.is_active, true);
    assert.equal(u.must_change_password, false);
    assert.ok(u.email_verified_at, 'JIT user must be marked email-verified');
    assert.equal(r.claims.userId, kurtId);
    const [ident] = await sql(`SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2`, [idp.issuer, KURT.sub]);
    assert.equal(ident?.user_id, String(kurtId));
    const [sess] = await sql(`SELECT user_id, oidc_sid, id_token FROM auth_sessions_oidc WHERE sid = $1`, [kurtSid]);
    assert.equal(sess?.user_id, kurtId);
    assert.equal(sess?.oidc_sid, 'sid-' + KURT.sub);
    assert.ok(sess?.id_token);
    const audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.user.provisioned', (a) => a.entityId === kurtId), 'no provisioned audit row');
    assert.ok(hasAudit(audit, 'vibe.auth.login.success', (a) => a.entityId === kurtId), 'no login.success audit row');
    const me = await api('/api/v1/auth/me', { token: r.token });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.data.mustChangePassword, false);
    const back = await ssoLogin({ returnTo: '/dash' });
    assert.match(back.location, /^\/dash#sso_token=/);
  });

  await step('4. an existing local user is linked by verified email and the role is synced from the group', async () => {
    idp.user = PAT_IDP;
    const before = (await sql('SELECT count(*)::int AS n FROM app_users'))[0].n;
    const r = await ssoLogin();
    assert.equal(r.status, 302, r.text);
    assert.equal(r.claims.username, 'pat');
    assert.equal(r.claims.userId, patId);
    assert.equal(r.claims.role, 'admin');
    assert.equal((await sql('SELECT count(*)::int AS n FROM app_users'))[0].n, before, 'linking must not create a user');
    assert.equal((await sql('SELECT role FROM app_users WHERE id = $1', [patId]))[0].role, 'admin');
    const [ident] = await sql(`SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2`, [idp.issuer, PAT_IDP.sub]);
    assert.equal(ident?.user_id, String(patId));
    const audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.user.linked', (a) => a.entityId === patId));
    assert.ok(hasAudit(audit, 'vibe.auth.role.changed', (a) => a.entityId === patId && a.detail.from === 'preparer' && a.detail.to === 'admin'));
    patToken = r.token;
    assert.equal((await api('/auth/settings', { token: patToken })).status, 200, 'synced admin can read settings');
  });

  await step('9. an unverified email is denied and nothing is written', async () => {
    idp.user = NOBODY;
    const r = await ssoLogin();
    assert.equal(r.status, 401);
    assert.match(r.contentType, /text\/html/);
    assert.match(r.text, /did not confirm your email/);
    assert.equal((await sql('SELECT count(*)::int AS n FROM app_users WHERE email = $1', [NOBODY.email]))[0].n, 0);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_identities WHERE subject = $1', [NOBODY.sub]))[0].n, 0);
    assert.ok(hasAudit(await auditActions(), 'vibe.auth.login.failure', (a) => a.detail.reason === 'unverified_email'));
    assert.equal((await api('/auth/oidc/callback?code=x&state=nope')).status, 400, 'unknown state must be refused');
  });

  await step('10. RP-initiated logout sends the browser to the IdP end-session and drops the session row', async () => {
    idp.user = KURT;
    const login = await ssoLogin();
    const r = await api('/auth/oidc/logout', { token: login.token });
    assert.equal(r.status, 302, r.text);
    const u = new URL(r.location);
    assert.equal(u.origin, idp.base);
    assert.match(u.pathname, /\/end-session\/$/);
    assert.ok(u.searchParams.get('id_token_hint'));
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(u.searchParams.get('post_logout_redirect_uri'), `${server.base}/auth/oidc/logged-out`);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_sessions_oidc WHERE sid = $1', [login.claims.sid]))[0].n, 0);
    assert.ok(hasAudit(await auditActions(), 'vibe.auth.logout', (a) => a.detail.initiated_by === 'user'));
    const idpHop = await fetch(u.toString(), { redirect: 'manual' });
    assert.equal(idpHop.status, 302);
    const done = await fetch(idpHop.headers.get('location'), { redirect: 'manual' });
    assert.equal(done.status, 200);
    assert.match(done.headers.get('content-type') ?? '', /text\/html/);
    // Local-only sign-out keeps the provider session and lands on the login page.
    const again = await ssoLogin();
    const local = await api('/auth/oidc/logout?local=1', { token: again.token });
    assert.equal(local.status, 302);
    assert.equal(local.location, '/login');
  });

  let revokedToken;
  await step('8. back-channel logout revokes every token the user holds, once', async () => {
    idp.user = KURT;
    const login = await ssoLogin();
    revokedToken = login.token;
    assert.equal((await api('/api/v1/auth/me', { token: revokedToken })).status, 200);
    const logoutToken = await idp.logoutToken({ sub: KURT.sub, sid: 'sid-' + KURT.sub });
    revokedAt = Date.now();
    const r = await api('/auth/oidc/backchannel', { method: 'POST', form: { logout_token: logoutToken } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_sessions_oidc WHERE user_id = $1', [kurtId]))[0].n, 0);
    const keys = (await sql('SELECT subject_key FROM auth_revocations WHERE revoked_until > now()')).map((x) => x.subject_key);
    assert.ok(keys.includes(`u:${kurtId}`), `no user revocation row: ${keys}`);
    const me = await api('/api/v1/auth/me', { token: revokedToken });
    assert.equal(me.status, 401);
    assert.match(me.json.error.message, /identity provider/);
    const replay = await api('/auth/oidc/backchannel', { method: 'POST', form: { logout_token: logoutToken } });
    assert.equal(replay.status, 400, 'a replayed logout token must be refused');
    assert.equal((await api('/api/v1/auth/me', { token: patToken })).status, 200, 'revocation is per user');
  });

  await step("9'. a fresh login after the revocation moment is valid while the old token stays dead", async () => {
    // iat is whole seconds; a token minted in the same second as the revocation is still revoked.
    const wait = revokedAt + 1200 - Date.now();
    if (wait > 0) await sleep(wait);
    idp.user = KURT;
    const login = await ssoLogin();
    assert.equal((await api('/api/v1/auth/me', { token: login.token })).status, 200);
    assert.equal((await api('/api/v1/auth/me', { token: revokedToken })).status, 401);
  });

  await step('7. the break-glass CLI provisions an admin who can sign in locally, and both are audited', async () => {
    const created = await breakglassCli('ensure');
    assert.equal(created.status, 'created', JSON.stringify(created));
    assert.equal(created.username, 'vibe-breakglass');
    const [bg] = await sql(`SELECT id, role, is_active, must_change_password, email FROM app_users WHERE username = 'vibe-breakglass'`);
    assert.ok(bg);
    assert.equal(bg.role, 'admin');
    assert.equal(bg.is_active, true);
    assert.equal(bg.must_change_password, false);
    assert.equal(bg.email, 'breakglass@vibe-tb.local');
    let audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.breakglass.rotated'), 'no breakglass.rotated audit row');
    const login = await localLogin('vibe-breakglass', BREAKGLASS_PASSWORD);
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.data.stage, 'ok');
    audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.breakglass.used', (a) => a.entityId === bg.id), 'no breakglass.used audit row');
    assert.equal((await api('/api/v1/auth/me', { token: login.json.data.token })).json.data.role, 'admin');
    const again = await breakglassCli('ensure');
    assert.equal(again.status, 'exists', 'ensure must be idempotent');
    const st = await breakglassCli('status');
    assert.equal(st.exists, true);
    assert.equal(st.active, true);
    assert.equal(st.role, 'admin');
    // The break-glass admin's own token is as good as any admin's for the settings read.
    const settings = await api('/auth/settings', { token: login.json.data.token });
    assert.equal(settings.status, 200, settings.text);
    assert.equal(settings.json.breakglass.exists, true);
  });

  // ── Hardening (still Boot C, mode `both` — none of these rules depend on oidc_only) ──
  const userRow = async (where, value) =>
    (await sql(`SELECT id, username, role, is_active, must_change_password, sso_only_since FROM app_users WHERE ${where} = $1`, [value]))[0];
  const userAudit = async (action, entityId) =>
    sql(`SELECT description FROM audit_log WHERE entity_type = 'user' AND action = $1 AND entity_id = $2 ORDER BY id`, [action, entityId]);
  const openResetTokens = async (userId) =>
    (await sql(`SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND consumed_at IS NULL`, [userId]))[0].n;
  const requestReset = (identifier) => api('/api/v1/auth/password-reset/request', { method: 'POST', json: { identifier } });
  // PATCH /users/:id treats an ABSENT `email` as "clear it" (optionalEmail maps undefined to null),
  // so every PATCH below that must keep the address sends it along.
  const BG_EMAIL = 'breakglass@vibe-tb.local';
  async function waitFor(fn, ms = 3000) {
    const until = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v || Date.now() > until) return v;
      await sleep(50);
    }
  }

  await step('H1. no admin can deactivate, demote or rename the break-glass account (mode: both)', async () => {
    assert.equal((await api('/auth/status')).json.mode, 'both');
    const bg = await userRow('username', 'vibe-breakglass');
    for (const attempt of [
      { method: 'PATCH', json: { isActive: false } },
      { method: 'PATCH', json: { role: 'reviewer' } },
      { method: 'PATCH', json: { displayName: 'x', role: 'preparer', isActive: false } },
      { method: 'DELETE' },
    ]) {
      const r = await api(`/api/v1/users/${bg.id}`, { token: adminToken, ...attempt });
      assert.equal(r.status, 409, `${attempt.method} ${JSON.stringify(attempt.json)}: ${r.text}`);
      assert.equal(r.json.data, null);
      assert.equal(r.json.error.code, 'BREAKGLASS_PROTECTED');
      assert.match(r.json.error.message, /vibe identity rotate-breakglass/);
    }
    // The username is not patchable at all: the field is ignored, the rest applies.
    const rename = await api(`/api/v1/users/${bg.id}`, { method: 'PATCH', token: adminToken, json: { username: 'renamed', displayName: 'Emergency access', email: BG_EMAIL } });
    assert.equal(rename.status, 200, rename.text);
    const after = await userRow('id', bg.id);
    assert.equal(after.username, 'vibe-breakglass');
    assert.equal(after.role, 'admin');
    assert.equal(after.is_active, true);
    assert.equal((await userAudit('breakglass_protected', bg.id)).length, 4, 'every refused attempt is audited');
    // The guard is for this account only.
    const other = await api(`/api/v1/users/${patId}`, { method: 'PATCH', token: adminToken, json: { isActive: false, email: PAT_IDP.email } });
    assert.equal(other.status, 200, other.text);
    assert.equal((await api(`/api/v1/users/${patId}`, { method: 'PATCH', token: adminToken, json: { isActive: true, email: PAT_IDP.email } })).status, 200);
  });

  await step('a variance note with no comparison period saves, reads back and clears', async () => {
    const [c] = await sql(`INSERT INTO clients (name, entity_type) VALUES ('Example Notes Client', 'llc') RETURNING id`);
    const [p] = await sql(`INSERT INTO periods (client_id, period_name, start_date, end_date) VALUES ($1, 'FY 2025', '2025-01-01', '2025-12-31') RETURNING id`, [c.id]);
    const [p0] = await sql(`INSERT INTO periods (client_id, period_name, start_date, end_date) VALUES ($1, 'FY 2024', '2024-01-01', '2024-12-31') RETURNING id`, [c.id]);
    const [a] = await sql(`INSERT INTO chart_of_accounts (client_id, account_number, account_name, category, normal_balance) VALUES ($1, '1000', 'Example Cash', 'assets', 'debit') RETURNING id`, [c.id]);
    // A note against the prior year, as the comparison screen writes it.
    await sql(`INSERT INTO variance_notes (period_id, account_id, compare_period_id, note) VALUES ($1, $2, $3, 'Example comparison note')`, [p.id, a.id, p0.id]);
    const put = await api(`/api/v1/periods/${p.id}/variance-notes/${a.id}`, { method: 'PUT', token: adminToken, json: { note: 'Example note' } });
    assert.equal(put.status, 200, put.text);
    const got = await api(`/api/v1/periods/${p.id}/variance-notes`, { token: adminToken });
    assert.ok(got.json.data.some((n) => n.note === 'Example note'));
    const again = await api(`/api/v1/periods/${p.id}/variance-notes/${a.id}`, { method: 'PUT', token: adminToken, json: { note: 'Example note, edited' } });
    assert.equal(again.status, 200, again.text);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM variance_notes WHERE period_id = $1 AND compare_period_id = $1`, [p.id]))[0].n, 1, 'one note, edited');
    const clear = await api(`/api/v1/periods/${p.id}/variance-notes/${a.id}`, { method: 'PUT', token: adminToken, json: { note: ' ' } });
    assert.equal(clear.status, 200, clear.text);
    assert.deepEqual((await sql(`SELECT note FROM variance_notes WHERE period_id = $1`, [p.id])).map((r) => r.note), ['Example comparison note'], 'clearing it leaves the comparison note');
  });

  await step('H2. an admin password set does not put break-glass into forced rotation (it does for everyone else)', async () => {
    const bg = await userRow('username', 'vibe-breakglass');
    const temp = 'E2eBreakGlassTemp!2026';
    const set = await api(`/api/v1/users/${bg.id}`, { method: 'PATCH', token: adminToken, json: { password: temp, email: BG_EMAIL } });
    assert.equal(set.status, 200, set.text);
    assert.equal((await userRow('id', bg.id)).must_change_password, false);
    const login = await localLogin('vibe-breakglass', temp);
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.data.stage, 'ok');
    assert.equal(login.json.data.user.mustChangePassword ?? false, false);
    assert.equal((await api('/api/v1/users', { token: login.json.data.token })).status, 200, 'not gated behind a rotation');
    // Put the provisioned password back for the oidc_only boot below.
    assert.equal((await api(`/api/v1/users/${bg.id}`, { method: 'PATCH', token: adminToken, json: { password: BREAKGLASS_PASSWORD, email: BG_EMAIL } })).status, 200);
    assert.equal((await userRow('id', bg.id)).must_change_password, false);
    // Contrast: the same call on an ordinary account still forces rotation.
    assert.equal((await api(`/api/v1/users/${patId}`, { method: 'PATCH', token: adminToken, json: { password: PAT_PASSWORD, email: PAT_IDP.email } })).status, 200);
    assert.equal((await userRow('id', patId)).must_change_password, true);
  });

  // The request endpoint allows 5 calls per hour per address and this boot
  // makes exactly 5: unknown, kurt, break-glass, pat, kurt again. A sixth is a 429.
  await step('H3. self-service reset is refused for SSO-only and break-glass accounts with the unknown-account answer', async () => {
    const kurt = await userRow('id', kurtId);
    const bg = await userRow('username', 'vibe-breakglass');
    assert.ok(kurt.sso_only_since, 'a JIT-provisioned user must carry sso_only_since');
    assert.equal((await userRow('id', patId)).sso_only_since, null, 'a local user linked by email keeps its local credential');
    assert.equal(bg.sso_only_since, null);

    const unknown = await requestReset('nobody-at-all@kisaes.com');
    assert.equal(unknown.status, 200, unknown.text);
    const same = (r, who) => {
      assert.equal(r.status, unknown.status, who);
      assert.equal(r.text, unknown.text, `${who}: the body must be identical to the unknown-account body`);
    };

    same(await requestReset(KURT.email), 'SSO-only account');
    assert.equal(await openResetTokens(kurtId), 0, 'no token may be minted for an SSO-only account');
    const refusedKurt = await waitFor(async () => (await userAudit('password_reset_refused', kurtId))[0]);
    assert.ok(refusedKurt, 'no password_reset_refused audit row for the SSO-only account');
    assert.match(refusedKurt.description, /single sign-on account/);

    same(await requestReset('Vibe-Breakglass'), 'break-glass');
    assert.equal(await openResetTokens(bg.id), 0, 'no token may be minted for break-glass');
    const refusedBg = await waitFor(async () => (await userAudit('password_reset_refused', bg.id))[0]);
    assert.ok(refusedBg, 'no password_reset_refused audit row for break-glass');
    assert.match(refusedBg.description, /break-glass/);

    // A local account that ALSO has a linked identity is not SSO-only.
    same(await requestReset('pat@kisaes.com'), 'local account');
    assert.equal(await openResetTokens(patId), 1, 'a local account still gets its reset token');
    assert.equal((await userAudit('password_reset_refused', patId)).length, 0);

    // An admin-driven password set still works, and makes the account a local one.
    const set = await api(`/api/v1/users/${kurtId}`, { method: 'PATCH', token: adminToken, json: { password: 'E2eKurtLocal!2026', email: KURT.email } });
    assert.equal(set.status, 200, set.text);
    assert.equal((await userRow('id', kurtId)).sso_only_since, null);
    assert.equal((await localLogin('kurt', 'E2eKurtLocal!2026')).status, 200);
    same(await requestReset(KURT.email), 'formerly SSO-only account');
    assert.equal(await openResetTokens(kurtId), 1, 'self-service reset applies once an admin has set a password');
  });

  await step('H4. role sync never demotes the last active admin; break-glass does not count as one', async () => {
    idp.user = KURT;
    let kurt = await ssoLogin();
    assert.equal(kurt.claims.role, 'admin');
    // Leave kurt as the only real admin: pat demoted, the seed admin deactivated, break-glass still active.
    const seedAdmin = await userRow('username', 'admin');
    assert.equal((await api(`/api/v1/users/${patId}`, { method: 'PATCH', token: kurt.token, json: { role: 'preparer', email: PAT_IDP.email } })).status, 200);
    assert.equal((await api(`/api/v1/users/${seedAdmin.id}`, { method: 'PATCH', token: kurt.token, json: { isActive: false } })).status, 200);
    const admins = (await sql(`SELECT username FROM app_users WHERE role = 'admin' AND is_active ORDER BY username`)).map((r) => r.username);
    assert.deepEqual(admins, ['kurt', 'vibe-breakglass']);

    idp.user = { ...KURT, groups: ['vibe-staff'] };
    const refused = await ssoLogin();
    assert.equal(refused.status, 302, 'a refused demotion must not fail the sign-in');
    assert.ok(refused.token);
    assert.equal(refused.claims.role, 'admin', 'the token carries the role the account holds, not the one asked for');
    assert.equal((await userRow('id', kurtId)).role, 'admin');
    const audit = await auditActions();
    assert.ok(
      hasAudit(audit, 'vibe.auth.role.demotion_refused', (a) => a.entityId === kurtId && a.detail.reason === 'last_admin' && a.detail.to === 'preparer' && a.detail.kept === 'admin'),
      'no demotion_refused audit row',
    );
    assert.equal((await api('/auth/settings', { token: refused.token })).status, 200, 'still an admin');

    // With another real admin back, the same sign-in IS demoted.
    assert.equal((await api(`/api/v1/users/${patId}`, { method: 'PATCH', token: refused.token, json: { role: 'admin', email: PAT_IDP.email } })).status, 200);
    assert.equal((await api(`/api/v1/users/${seedAdmin.id}`, { method: 'PATCH', token: refused.token, json: { isActive: true } })).status, 200);
    kurt = await ssoLogin();
    assert.equal(kurt.status, 302);
    assert.equal(kurt.claims.role, 'preparer');
    assert.equal((await userRow('id', kurtId)).role, 'preparer');
    assert.equal((await api('/auth/settings', { token: kurt.token })).status, 403);
    idp.user = KURT;
  });

  await stopServer();

  // ── Boot D: oidc_only with break-glass ────────────────────────────────
  await startServer('oidc_only');
  await step('oidc_only: only the break-glass user may sign in locally; SSO start still works', async () => {
    const s = (await api('/auth/status')).json;
    assert.equal(s.mode, 'oidc_only');
    assert.equal(s.localLoginVisible, false);
    const refused = await localLogin('admin', ADMIN_PASSWORD);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.error.code, 'LOCAL_LOGIN_DISABLED');
    const bg = await localLogin('vibe-breakglass', BREAKGLASS_PASSWORD);
    assert.equal(bg.status, 200, bg.text);
    assert.equal((await api('/auth/oidc/start')).status, 302);
  });
  await step('oidc_only: a desktop pairs from a single-sign-on session (desktop sync S2)', async () => {
    idp.user = KURT;
    const sso = await ssoLogin();
    assert.ok(sso.token, 'an SSO session');
    const c = await api('/api/v1/desktop-sync/codes', { method: 'POST', token: sso.token });
    assert.equal(c.status, 201, c.text);
    // Pairing is not a sign-in: no password, so oidc_only does not refuse it.
    const p = await api('/api/v1/sync/pair', { method: 'POST', json: { code: c.json.data.code, deviceName: 'Example SSO laptop' } });
    assert.equal(p.status, 201, p.text);
    const list = await api('/api/v1/sync/clients', { token: p.json.data.token });
    assert.equal(list.status, 200, list.text);
    assert.equal(p.json.data.user.username, 'kurt', 'the device acts as the SSO user');
  });
  await stopServer();
}

// ─────────────────────────────────────────────────────────────── lifecycle

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await stopServer().catch(() => {});
  if (idp) await idp.stop().catch(() => {});
  await dropScratchDb().catch((e) => console.error('cleanup:', e.message));
}

process.on('exit', (code) => { process.stderr.write(`sso-e2e: exiting with code ${code} after ${passed} passed steps\n`); });

const watchdog = setTimeout(() => {
  console.error('sso-e2e: watchdog fired after 180 s');
  output.dump();
  cleanup().finally(() => process.exit(1));
}, 180_000);
watchdog.unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup().finally(() => process.exit(1)); });
}

// Let stdout drain before leaving: process.exit() right after console.log can
// drop the last lines when stdout is a pipe or a file (the CI log would end at
// "server stopped" with a green exit code). Everything is closed by cleanup(),
// so the loop empties on its own; the unref'd timer is a backstop only.
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}

main()
  .then(async () => {
    await cleanup();
    log(`sso-e2e: ${passed} steps passed`);
    finish(0);
  })
  .catch(async (err) => {
    console.error('\nsso-e2e FAILED:', err && err.stack ? err.stack : err);
    output.dump();
    await cleanup();
    finish(1);
  });
