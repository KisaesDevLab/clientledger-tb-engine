// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop full backup and restore (ClientLedger Trial Balance, owner decision
// Q21). The engine's own `full` level dumps a fixed list of tables and has no
// restore-everything mode, so the desktop uses this instead:
//
//   backup   every base table in `public`, read in ONE repeatable-read
//            snapshot, plus every file under the documents folder
//            (UPLOADS_DIR), into a .tbak with the format-2 manifest
//            (lib/backupManifest.ts), backupLevel 'desktop_full'. Sign-in
//            data is left out (SIGN_IN_TABLES, REDACTED_COLUMNS; Q32).
//   restore  into an EMPTY database (the launcher drops and recreates it):
//            migrate up to the archive's schema version, empty what the
//            migrations seeded, load every table with foreign keys deferred,
//            reset sequences, migrate to latest, then unpack the documents.
//
// Generic on purpose: a table added upstream is covered without a code change.
// Desktop only (Q9): appliance and hosted never read these archives, and the
// level name makes the engine's /restore refuse one cleanly.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import unzipper from 'unzipper';
import type { Knex } from 'knex';
import {
  FORMAT_VERSION,
  MANIFEST_PATH,
  appliedMigrations,
  compareSchema,
  entryFor,
  hashArchive,
  sha256Hex,
  verifyEntries,
  DAMAGED_MESSAGE,
  TOO_NEW_MESSAGE,
  type ManifestEntries,
} from '../lib/backupManifest';
import { MIGRATIONS } from './sources.generated';
import { staticSource } from './database';

export const FULL_LEVEL = 'desktop_full';

/** Never dumped: the schema version travels in the manifest instead. */
export const EXCLUDED_TABLES: ReadonlySet<string> = new Set(['knex_migrations', 'knex_migrations_lock']);

/**
 * Sign-in data the desktop never uses (owner decision Q32): sessions,
 * identities, second factors, reset tokens and SSO settings are left out of
 * a desktop full backup. A restore leaves these tables empty; the desktop
 * signs in with the launcher's session token, not with any of them.
 */
export const SIGN_IN_TABLES: ReadonlySet<string> = new Set([
  'auth_identities',
  'auth_revocations',
  'auth_sessions_oidc',
  'auth_settings',
  'password_reset_tokens',
  'trusted_browsers',
  'user_passkeys',
  'user_totp',
  'webauthn_challenges',
]);

/**
 * Columns written as a value that can never sign in (Q32). The rows stay,
 * because entries, documents and the audit trail point at their users;
 * '!' is the engine's own "cannot log in" hash (the mcp_agent user).
 */
export const REDACTED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  app_users: { password_hash: '!' },
};

/** A row as it goes into a desktop full backup (Q32 redactions applied). */
export function redactRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const cols = REDACTED_COLUMNS[table];
  if (!cols) return row;
  const out = { ...row };
  for (const [c, v] of Object.entries(cols)) if (c in out) out[c] = v;
  return out;
}

const BYTEA_TAG = '$bytea';
const INSERT_BATCH = 500;

export interface Column {
  name: string;
  dataType: string;
  generated: boolean;
}

export async function listTables(db: Knex | Knex.Transaction): Promise<string[]> {
  const rows = (await db('information_schema.tables')
    .where({ table_schema: 'public', table_type: 'BASE TABLE' })
    .orderBy('table_name')
    .select('table_name')) as Array<{ table_name: string }>;
  return rows.map((r) => r.table_name).filter((t) => !EXCLUDED_TABLES.has(t));
}

export async function columnsOf(db: Knex | Knex.Transaction, table: string): Promise<Column[]> {
  const rows = (await db('information_schema.columns')
    .where({ table_schema: 'public', table_name: table })
    .orderBy('ordinal_position')
    .select('column_name', 'data_type', 'is_generated')) as Array<{
    column_name: string;
    data_type: string;
    is_generated: string;
  }>;
  return rows.map((r) => ({ name: r.column_name, dataType: r.data_type, generated: r.is_generated === 'ALWAYS' }));
}

/** Rows to JSON: bytea is tagged base64; everything else is what pg returns. */
export function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = Buffer.isBuffer(v) ? { [BYTEA_TAG]: v.toString('base64') } : v;
  }
  return out;
}

/** JSON back to insertable values, by the column's type in this database. */
export function decodeRow(row: Record<string, unknown>, columns: Column[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    if (c.generated || !(c.name in row)) continue;
    const v = row[c.name];
    if (v === null || v === undefined) {
      out[c.name] = null;
    } else if (c.dataType === 'bytea') {
      const tagged = v as Record<string, unknown>;
      out[c.name] = typeof tagged[BYTEA_TAG] === 'string' ? Buffer.from(tagged[BYTEA_TAG] as string, 'base64') : v;
    } else if (c.dataType === 'json' || c.dataType === 'jsonb') {
      // pg hands back parsed JSON; an insert needs text, or a JS array would
      // be sent as a Postgres array literal.
      out[c.name] = JSON.stringify(v);
    } else {
      out[c.name] = v;
    }
  }
  return out;
}

/** Every file under `root`, as posix paths relative to it. */
function walk(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(abs, r);
      else if (e.isFile()) out.push(r);
    }
  };
  visit(root, '');
  return out.sort();
}

export interface FullBackupResult {
  path: string;
  size: number;
  sha256: string;
  schemaVersion: string | null;
  recordCounts: Record<string, number>;
  clientCount: number;
  fileCount: number;
}

/**
 * Write a full backup to `dest` (via `dest.partial` and a rename, so a reader
 * never sees half a file). `uploadsRoot` is the documents folder.
 */
export async function writeFullBackup(
  db: Knex,
  dest: string,
  uploadsRoot: string,
  appVersion: string,
): Promise<FullBackupResult> {
  const tableData: Record<string, string> = {};
  const recordCounts: Record<string, number> = {};
  await db.transaction(
    async (trx) => {
      for (const table of await listTables(trx)) {
        if (SIGN_IN_TABLES.has(table)) continue;
        const rows = (await trx(table).select('*')) as Array<Record<string, unknown>>;
        tableData[table] = JSON.stringify(rows.map((r) => encodeRow(redactRow(table, r))));
        recordCounts[table] = rows.length;
      }
    },
    { isolationLevel: 'repeatable read', readOnly: true },
  );
  const applied = await appliedMigrations(db);
  const files = walk(uploadsRoot);

  const entries: ManifestEntries = {};
  const manifest = {
    version: '1.0',
    formatVersion: FORMAT_VERSION,
    source: 'desktop',
    appVersion,
    schemaVersion: applied[applied.length - 1] ?? null,
    backupType: FULL_LEVEL,
    backupLevel: FULL_LEVEL,
    createdAt: new Date().toISOString(),
    recordCounts,
    clientCount: recordCounts['clients'] ?? 0,
    includesFiles: true,
    fileCount: files.length,
    entries,
    checksum: '',
  };

  const partial = `${dest}.partial`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(partial);
    const zip = archiver('zip', { zlib: { level: 6 } });
    out.on('close', resolve);
    out.on('error', reject);
    zip.on('error', reject);
    zip.pipe(out);
    const build = async () => {
      for (const [table, text] of Object.entries(tableData)) {
        const name = `tables/${table}.json`;
        entries[name] = entryFor(text);
        await appendAndWait(zip, Buffer.from(text, 'utf8'), name);
        delete tableData[table];
      }
      for (const rel of files) {
        const body = await fs.promises.readFile(path.join(uploadsRoot, ...rel.split('/')));
        const name = `files/${rel}`;
        entries[name] = { sha256: sha256Hex(body), size: body.length };
        await appendAndWait(zip, body, name);
      }
      zip.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_PATH });
      await zip.finalize();
    };
    build().catch(reject);
  });
  const body = fs.createReadStream(partial);
  const hash = crypto.createHash('sha256');
  for await (const c of body) hash.update(c as Buffer);
  const size = fs.statSync(partial).size;
  fs.renameSync(partial, dest);
  return {
    path: dest,
    size,
    sha256: hash.digest('hex'),
    schemaVersion: manifest.schemaVersion,
    recordCounts,
    clientCount: manifest.clientCount,
    fileCount: files.length,
  };
}

function appendAndWait(zip: archiver.Archiver, body: Buffer, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== name) return;
      zip.off('entry', onEntry);
      resolve();
    };
    zip.on('entry', onEntry);
    zip.once('error', reject);
    zip.append(body, { name });
  });
}

export class FullRestoreError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Run migrations one at a time until `target` is the newest applied. */
export async function migrateTo(db: Knex, target: string): Promise<void> {
  const source = { migrationSource: staticSource(MIGRATIONS) };
  for (;;) {
    const applied = await appliedMigrations(db);
    if (applied[applied.length - 1] === target) return;
    const [, ran] = (await db.migrate.up(source)) as [number, string[]];
    if (ran.length === 0) throw new FullRestoreError('The database could not be prepared.', 'MIGRATE_FAILED');
  }
}

/**
 * Run `fn` in one transaction with every foreign key deferred to commit, so
 * rows can go in table by table in any order. Only for a database that is
 * ours and new: the keys are made deferrable first and put back afterwards.
 */
export async function withDeferredForeignKeys<T>(db: Knex, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  const fks = (await db.raw(`
    SELECT cl.relname AS tbl, c.conname AS name
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE c.contype = 'f' AND n.nspname = 'public' AND NOT c.condeferrable`)).rows as Array<{ tbl: string; name: string }>;
  const alterAll = async (clause: string) => {
    await db.transaction(async (trx) => {
      for (const fk of fks) await trx.raw(`ALTER TABLE ?? ALTER CONSTRAINT ?? ${clause}`, [fk.tbl, fk.name]);
    });
  };
  await alterAll('DEFERRABLE INITIALLY DEFERRED');
  try {
    return await db.transaction(async (trx) => {
      await trx.raw('SET CONSTRAINTS ALL DEFERRED');
      return fn(trx);
    });
  } finally {
    await alterAll('NOT DEFERRABLE');
  }
}

/** Identity and serial columns continue after the ids now in each table. */
export async function resetSequences(trx: Knex.Transaction): Promise<void> {
  const seqs = (await trx.raw(`
    SELECT c.table_name AS tbl, c.column_name AS col,
           pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS seq
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) IS NOT NULL`)).rows as Array<{
    tbl: string;
    col: string;
    seq: string;
  }>;
  for (const s of seqs) {
    await trx.raw(`SELECT setval(?, COALESCE((SELECT MAX(??) FROM ??), 0) + 1, false)`, [s.seq, s.col, s.tbl]);
  }
}

/** A path inside the archive that is safe to unpack under a folder. */
export function safeRelative(entryPath: string): string | null {
  if (!entryPath.startsWith('files/')) return null;
  const rel = entryPath.slice('files/'.length);
  if (!rel || rel.includes('\\') || path.posix.isAbsolute(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes(':'))) return null;
  return rel;
}

async function readManifest(dir: unzipper.CentralDirectory): Promise<Record<string, unknown>> {
  const m = dir.files.find((f) => f.path === MANIFEST_PATH);
  if (!m) throw new FullRestoreError('This file is not a ClientLedger Trial Balance backup.', 'NOT_A_BACKUP');
  try {
    return JSON.parse((await m.buffer()).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new FullRestoreError('This file is not a ClientLedger Trial Balance backup.', 'NOT_A_BACKUP');
  }
}

/** Read an archive's manifest (for the restore wizard's details). */
export async function readFullManifest(archivePath: string): Promise<Record<string, unknown>> {
  return readManifest(await unzipper.Open.file(archivePath));
}

export interface FullRestoreResult {
  schemaVersion: string;
  recordCounts: Record<string, number>;
  fileCount: number;
  migratedAfter: number;
}

/**
 * Restore `archivePath` into the empty database behind `db` and the empty
 * documents folder `uploadsRoot`. Refuses a damaged archive, one from a newer
 * engine, one that is not a desktop full backup, and a database that is not
 * empty.
 */
export async function restoreFullBackup(db: Knex, archivePath: string, uploadsRoot: string): Promise<FullRestoreResult> {
  const dir = await unzipper.Open.file(archivePath);
  const manifest = await readManifest(dir);
  if (manifest.backupLevel !== FULL_LEVEL) {
    throw new FullRestoreError(
      'This backup holds one client or settings, not everything. Restore it as one client instead.',
      'NOT_A_FULL_BACKUP',
    );
  }
  if ((await appliedMigrations(db)).length > 0) {
    throw new FullRestoreError('The database is not empty; a full restore needs a new one.', 'DATABASE_NOT_EMPTY');
  }
  const checked = verifyEntries(manifest, await hashArchive(archivePath));
  if (!checked.ok || checked.legacy) {
    // A desktop full backup always carries its checksums.
    throw new FullRestoreError(DAMAGED_MESSAGE, 'BACKUP_DAMAGED');
  }

  // 1. Schema exactly as the backup's. Compared with the migrations this
  // engine ships (the database is still empty).
  const target = manifest.schemaVersion;
  const known = MIGRATIONS.map(([name]) => name);
  if (compareSchema(target, known) === 'newer') {
    throw new FullRestoreError(TOO_NEW_MESSAGE.replace('Vibe Trial Balance', 'ClientLedger Trial Balance'), 'BACKUP_SCHEMA_TOO_NEW');
  }
  if (typeof target !== 'string' || !known.includes(target)) {
    throw new FullRestoreError(
      'This backup was made by a different version of the app and cannot be restored here.',
      'BACKUP_SCHEMA_UNKNOWN',
    );
  }
  await migrateTo(db, target);

  // 2. Load every table, foreign keys checked once at commit.
  const tablesHere = await listTables(db);
  const recordCounts: Record<string, number> = {};
  await withDeferredForeignKeys(db, async (trx) => {
    // What the migrations seeded (tax codes, system users, settings) is
    // replaced by the backup's own rows.
    if (tablesHere.length > 0) {
      await trx.raw(`TRUNCATE ${tablesHere.map(() => '??').join(', ')} RESTART IDENTITY`, tablesHere);
    }
    const byPath = new Map(dir.files.map((f) => [f.path, f]));
    for (const table of tablesHere) {
      const entry = byPath.get(`tables/${table}.json`);
      if (!entry) continue; // a table the backup's version had empty or absent
      const rows = JSON.parse((await entry.buffer()).toString('utf8')) as Array<Record<string, unknown>>;
      const cols = await columnsOf(trx, table);
      const prepared = rows.map((r) => decodeRow(r, cols));
      for (let i = 0; i < prepared.length; i += INSERT_BATCH) {
        await trx(table).insert(prepared.slice(i, i + INSERT_BATCH));
      }
      recordCounts[table] = rows.length;
    }
    for (const f of dir.files) {
      const m = /^tables\/(.+)\.json$/.exec(f.path);
      if (m && !tablesHere.includes(m[1])) {
        throw new FullRestoreError(`The backup has a table this version does not: ${m[1]}.`, 'BACKUP_SCHEMA_UNKNOWN');
      }
    }
    await resetSequences(trx);
  });

  // 3. Up to this version's schema.
  const [, after] = (await db.migrate.latest({ migrationSource: staticSource(MIGRATIONS) })) as [number, string[]];

  // 4. Documents.
  let fileCount = 0;
  for (const f of dir.files) {
    if (f.type === 'Directory' || !f.path.startsWith('files/')) continue;
    const rel = safeRelative(f.path);
    if (!rel) throw new FullRestoreError(`The backup has an unsafe file name: ${f.path}`, 'BACKUP_DAMAGED');
    const destPath = path.join(uploadsRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, await f.buffer());
    fileCount += 1;
  }

  return { schemaVersion: target, recordCounts, fileCount, migratedAfter: after.length };
}
