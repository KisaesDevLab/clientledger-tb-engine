// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Phase 17: Backup & Restore System
 *
 * POST /api/v1/backup/full                    -> create full backup
 * POST /api/v1/backup/settings                -> create settings backup
 * POST /api/v1/backup/client/:clientId        -> create client backup
 * POST /api/v1/backup/period/:periodId        -> create period backup
 * GET  /api/v1/backup/history                 -> list backups
 * GET  /api/v1/backup/:backupId/download      -> download .tbak file
 * DELETE /api/v1/backup/:backupId             -> delete backup
 * POST /api/v1/restore/upload                 -> upload & preview
 * POST /api/v1/restore/execute                -> execute restore
 * GET  /api/v1/restore/history                -> list restore history
 */
import { Router, Response, Request, NextFunction } from 'express';
import archiver from 'archiver';
import unzipper from 'unzipper';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import type { Knex } from 'knex';
import {
  deleteFsClientData, dumpFsClientTables, dumpFsLibrary, restoreFsClientTables, restoreFsLibrary, FS_USER_FK_COLUMNS,
} from '../lib/fs/fsBackup';
import { sendServerError } from '../lib/safeError';

// ─────────────────────────────────────────────────────────────────────────────
// Restore upload session cache
//
// When an admin uploads a .tbak via /restore/upload we stage it under TEMP_DIR
// and hand back a basename. /restore/execute then resolves that basename and runs
// the restore. Without binding, any admin (or any admin session with a CSRF-ish
// vector) could point execute at another admin's staged file. We therefore
// associate each staged file with (uploaderId, randomNonce) and require the
// executing admin to supply both a matching nonce and be the same uploader.
// ─────────────────────────────────────────────────────────────────────────────

interface RestoreUploadSession { uploaderId: number; nonce: string; expiresAt: number; }
const restoreUploadSessions = new Map<string, RestoreUploadSession>();
const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

function rememberUploadSession(tempBase: string, uploaderId: number, nonce: string): void {
  restoreUploadSessions.set(tempBase, { uploaderId, nonce, expiresAt: Date.now() + UPLOAD_SESSION_TTL_MS });
}
function consumeUploadSession(tempBase: string, uploaderId: number, nonce: string): boolean {
  const entry = restoreUploadSessions.get(tempBase);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) { restoreUploadSessions.delete(tempBase); return false; }
  if (entry.uploaderId !== uploaderId) return false;
  // Constant-time comparison on the nonce so a leaked filename can't be brute forced
  const a = Buffer.from(entry.nonce, 'utf8');
  const b = Buffer.from(String(nonce ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  restoreUploadSessions.delete(tempBase);
  return true;
}
// Periodic sweep — cheap, no-op if the map is empty.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of restoreUploadSessions) {
    if (v.expiresAt < now) restoreUploadSessions.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// Directories
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_DIR = process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups');
const TEMP_DIR = path.join(BACKUP_DIR, 'temp');

fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type BackupLevel = 'full' | 'settings' | 'client' | 'period';

interface BackupOptions {
  clientId?: number;
  periodId?: number;
  triggerType?: 'manual' | 'scheduled' | 'pre_restore';
}

interface BackupHistoryRow {
  id: number;
  backup_type: string;
  backup_level: string;
  client_id: number | null;
  client_name: string | null;
  period_id: number | null;
  period_name: string | null;
  filename: string;
  file_size: number | null;
  checksum: string | null;
  storage_local: string | null;
  trigger_type: string;
  status: string;
  error_message: string | null;
  record_counts: Record<string, number> | null;
  created_by: number | null;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backup service
// ─────────────────────────────────────────────────────────────────────────────

async function createBackup(
  level: BackupLevel,
  options: BackupOptions,
  userId: number | null,
): Promise<BackupHistoryRow> {
  const { clientId, periodId, triggerType = 'manual' } = options;

  // Collect table data inside a REPEATABLE READ transaction so that every
  // SELECT sees the same snapshot — otherwise a user committing a JE or TB
  // edit mid-backup can produce an internally inconsistent archive.
  const tableData: Record<string, unknown[]> = {};
  const recordCounts: Record<string, number> = {};
  let clientName: string | null = null;
  let periodName: string | null = null;
  let username = 'system';

  await db.transaction(
    async (trx) => {
      async function dump(table: string, rows: unknown[]) {
        tableData[table] = rows;
        recordCounts[table] = rows.length;
      }

      // Resolve names inside the txn too so they stay consistent with the dump.
      if (clientId) {
        const c = await trx('clients').where('id', clientId).first('name');
        clientName = c?.name ?? null;
      }
      if (periodId) {
        const p = await trx('periods').where('id', periodId).first('period_name');
        periodName = p?.period_name ?? null;
      }
      if (userId) {
        const u = await trx('app_users').where('id', userId).first('username');
        username = u?.username ?? 'system';
      }

      if (level === 'full') {
        await dump('app_users', await trx('app_users').select('*'));
        await dump('clients', await trx('clients').select('*'));
        await dump('periods', await trx('periods').select('*'));
        await dump('chart_of_accounts', await trx('chart_of_accounts').select('*'));
        await dump('trial_balance', await trx('trial_balance').select('*'));
        await dump('journal_entries', await trx('journal_entries').select('*'));
        await dump('journal_entry_lines', await trx('journal_entry_lines').select('*'));
        await dump('bank_transactions', await trx('bank_transactions').select('*'));
        await dump('classification_rules', await trx('classification_rules').select('*'));
        await dump('variance_notes', await trx('variance_notes').select('*'));
        await dump('document_imports', await trx('document_imports').select('*'));
        await dump('tax_codes', await trx('tax_codes').select('*'));
        await dump('tax_code_software_maps', await trx('tax_code_software_maps').select('*'));
        const hasSettings = await trx.schema.hasTable('app_settings');
        if (hasSettings) {
          await dump('app_settings', await trx('app_settings').select('*'));
        }
        // Statement Writer firm library (letterhead, letters, styles, templates).
        for (const [t, r] of Object.entries(await dumpFsLibrary(trx))) await dump(t, r);
      } else if (level === 'settings') {
        await dump('tax_codes', await trx('tax_codes').select('*'));
        await dump('tax_code_software_maps', await trx('tax_code_software_maps').select('*'));
        await dump('app_users', await trx('app_users').select('*'));
        const hasSettings = await trx.schema.hasTable('app_settings');
        if (hasSettings) {
          await dump('app_settings', await trx('app_settings').select('*'));
        }
        for (const [t, r] of Object.entries(await dumpFsLibrary(trx))) await dump(t, r);
      } else if (level === 'client' && clientId) {
        // Tax codes MUST ride along with COA. chart_of_accounts.tax_code_id
        // has a FK into tax_codes — restoring onto a fresh DB without
        // dumping them fails FK validation on the COA insert.
        await dump('tax_codes', await trx('tax_codes').select('*'));
        await dump('tax_code_software_maps', await trx('tax_code_software_maps').select('*'));
        const client = await trx('clients').where('id', clientId).select('*');
        await dump('clients', client);
        const periodRows = await trx('periods').where('client_id', clientId).select('*');
        await dump('periods', periodRows);
        const periodIds = periodRows.map((p: { id: number }) => p.id);
        await dump('chart_of_accounts', await trx('chart_of_accounts').where('client_id', clientId).select('*'));
        const coaRows = await trx('chart_of_accounts').where('client_id', clientId).select('id');
        const coaIds = coaRows.map((r: { id: number }) => r.id);
        await dump('trial_balance', periodIds.length > 0 ? await trx('trial_balance').whereIn('period_id', periodIds).select('*') : []);
        await dump('journal_entries', periodIds.length > 0 ? await trx('journal_entries').whereIn('period_id', periodIds).select('*') : []);
        const jeRows = periodIds.length > 0 ? await trx('journal_entries').whereIn('period_id', periodIds).select('id') : [];
        const jeIds = jeRows.map((r: { id: number }) => r.id);
        await dump('journal_entry_lines', jeIds.length > 0 ? await trx('journal_entry_lines').whereIn('journal_entry_id', jeIds).select('*') : []);
        await dump('bank_transactions', await trx('bank_transactions').where('client_id', clientId).select('*'));
        await dump('classification_rules', await trx('classification_rules').where('client_id', clientId).select('*'));
        await dump('variance_notes', coaIds.length > 0 ? await trx('variance_notes').whereIn('account_id', coaIds).select('*') : []);
        await dump('document_imports', periodIds.length > 0 ? await trx('document_imports').whereIn('period_id', periodIds).select('*') : []);
        // Workpaper / engagement artifacts that the round-2 audit flagged as
        // silently missing from client backups. Each is table-name-guarded
        // so restores onto older schemas still work.
        if (await trx.schema.hasTable('tickmark_library')) {
          await dump('tickmark_library', await trx('tickmark_library').where('client_id', clientId).select('*'));
        }
        if (await trx.schema.hasTable('lead_sheets')) {
          await dump('lead_sheets', await trx('lead_sheets').where('client_id', clientId).select('*'));
        }
        // client_documents was previously missing from backups altogether —
        // it appeared only in deleteClientData, so every document row was
        // silently dropped from a client archive.
        await dump('client_documents', await trx('client_documents').where('client_id', clientId).select('*'));
        if (await trx.schema.hasTable('client_folder_links')) {
          await dump('client_folder_links', await trx('client_folder_links').where('client_id', clientId).select('*'));
        }
        if (await trx.schema.hasTable('lead_sheet_attachments')) {
          await dump('lead_sheet_attachments', await trx('lead_sheet_attachments').where('client_id', clientId).select('*'));
        }
        // The QuickBooks binding rides along (tokens are encrypted at rest and
        // stay encrypted in the archive). Only a same-client replace restores it.
        if (await trx.schema.hasTable('qbo_connections')) {
          await dump('qbo_connections', await trx('qbo_connections').where('client_id', clientId).select('*'));
        }
        if (await trx.schema.hasTable('lead_sheet_notes')) {
          await dump('lead_sheet_notes', await trx('lead_sheet_notes').where('client_id', clientId).select('*'));
        }
        if (await trx.schema.hasTable('lead_sheet_signoffs') && periodIds.length > 0) {
          await dump('lead_sheet_signoffs', await trx('lead_sheet_signoffs').whereIn('period_id', periodIds).select('*'));
        }
        // Statement Writer: layouts, statement sets, finalized versions and
        // classification. The issued PDF bytes are deliberately NOT dumped
        // (lib/fs/fsBackup.ts) — backups carry rows, not bytes.
        for (const [t, r] of Object.entries(await dumpFsClientTables(trx, clientId))) await dump(t, r);
        if (await trx.schema.hasTable('tb_tickmarks') && periodIds.length > 0) {
          await dump('tb_tickmarks', await trx('tb_tickmarks').whereIn('period_id', periodIds).select('*'));
        }
        if (await trx.schema.hasTable('engagement_tasks') && periodIds.length > 0) {
          await dump('engagement_tasks', await trx('engagement_tasks').whereIn('period_id', periodIds).select('*'));
        }
        if (await trx.schema.hasTable('m1_adjustments') && periodIds.length > 0) {
          await dump('m1_adjustments', await trx('m1_adjustments').whereIn('period_id', periodIds).select('*'));
        }
        if (await trx.schema.hasTable('bank_reconciliations') && periodIds.length > 0) {
          const reconRows = await trx('bank_reconciliations').whereIn('period_id', periodIds).select('*');
          await dump('bank_reconciliations', reconRows);
          const reconIds = reconRows.map((r: { id: number }) => r.id);
          if (reconIds.length > 0 && await trx.schema.hasTable('reconciliation_items')) {
            await dump('reconciliation_items', await trx('reconciliation_items').whereIn('reconciliation_id', reconIds).select('*'));
          }
        }
      } else if (level === 'period' && periodId) {
        await dump('tax_codes', await trx('tax_codes').select('*'));
        await dump('tax_code_software_maps', await trx('tax_code_software_maps').select('*'));
        const period = await trx('periods').where('id', periodId).first('*');
        const cId = period?.client_id;
        const client = cId ? await trx('clients').where('id', cId).select('*') : [];
        await dump('clients', client);
        await dump('periods', period ? [period] : []);
        await dump('chart_of_accounts', cId ? await trx('chart_of_accounts').where('client_id', cId).select('*') : []);
        const coaRows = cId ? await trx('chart_of_accounts').where('client_id', cId).select('id') : [];
        const coaIds = coaRows.map((r: { id: number }) => r.id);
        await dump('trial_balance', await trx('trial_balance').where('period_id', periodId).select('*'));
        const jeRows = await trx('journal_entries').where('period_id', periodId).select('*');
        await dump('journal_entries', jeRows);
        const jeIds = jeRows.map((r: { id: number }) => r.id);
        await dump('journal_entry_lines', jeIds.length > 0 ? await trx('journal_entry_lines').whereIn('journal_entry_id', jeIds).select('*') : []);
        await dump('bank_transactions', cId ? await trx('bank_transactions').where('client_id', cId).where('period_id', periodId).select('*') : []);
        await dump('variance_notes', coaIds.length > 0 ? await trx('variance_notes').where('period_id', periodId).whereIn('account_id', coaIds).select('*') : []);
        await dump('document_imports', await trx('document_imports').where('period_id', periodId).select('*'));
        if (await trx.schema.hasTable('lead_sheets')) {
          await dump('lead_sheets', cId ? await trx('lead_sheets').where('client_id', cId).select('*') : []);
        }
        if (await trx.schema.hasTable('lead_sheet_signoffs')) {
          await dump('lead_sheet_signoffs', await trx('lead_sheet_signoffs').where('period_id', periodId).select('*'));
        }
        // Statement Writer: this period's statement sets and the layouts they use.
        if (cId) for (const [t, r] of Object.entries(await dumpFsClientTables(trx, cId, periodId))) await dump(t, r);
        await dump('client_documents', await trx('client_documents').where('period_id', periodId).select('*'));
        if (await trx.schema.hasTable('lead_sheet_notes')) {
          await dump('lead_sheet_notes', await trx('lead_sheet_notes').where('period_id', periodId).select('*'));
        }
        if (await trx.schema.hasTable('lead_sheet_attachments')) {
          await dump('lead_sheet_attachments', await trx('lead_sheet_attachments').where('period_id', periodId).select('*'));
        }
        if (await trx.schema.hasTable('tb_tickmarks')) {
          await dump('tb_tickmarks', await trx('tb_tickmarks').where('period_id', periodId).select('*'));
        }
        if (await trx.schema.hasTable('engagement_tasks')) {
          await dump('engagement_tasks', await trx('engagement_tasks').where('period_id', periodId).select('*'));
        }
        if (await trx.schema.hasTable('m1_adjustments')) {
          await dump('m1_adjustments', await trx('m1_adjustments').where('period_id', periodId).select('*'));
        }
        if (await trx.schema.hasTable('bank_reconciliations')) {
          const reconRows = await trx('bank_reconciliations').where('period_id', periodId).select('*');
          await dump('bank_reconciliations', reconRows);
          const reconIds = reconRows.map((r: { id: number }) => r.id);
          if (reconIds.length > 0 && await trx.schema.hasTable('reconciliation_items')) {
            await dump('reconciliation_items', await trx('reconciliation_items').whereIn('reconciliation_id', reconIds).select('*'));
          }
        }
      }
    },
    { isolationLevel: 'repeatable read' },
  );

  // Build filename. TypeScript narrows these to `null` across the async
  // closure above even though the callback assigns to them, so force the
  // wider type via assertion.
  const resolvedClientName = clientName as string | null;
  const resolvedPeriodName = periodName as string | null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const suffix = resolvedClientName
    ? `_${resolvedClientName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`
    : resolvedPeriodName
    ? `_${resolvedPeriodName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`
    : '';
  const filename = `backup_${level}${suffix}_${ts}.tbak`;
  const filePath = path.join(BACKUP_DIR, filename);

  // Build manifest (no checksum yet)
  const manifest = {
    version: '1.0',
    backupType: level,
    backupLevel: level,
    createdAt: new Date().toISOString(),
    createdBy: username,
    clientId: clientId ?? null,
    clientName: resolvedClientName,
    periodId: periodId ?? null,
    periodName: resolvedPeriodName,
    recordCounts,
    checksum: '',
  };

  // Create ZIP
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // Add manifest
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // Add table files
    for (const [tableName, rows] of Object.entries(tableData)) {
      archive.append(JSON.stringify(rows, null, 2), { name: `tables/${tableName}.json` });
    }

    archive.finalize();
  });

  // Compute checksum via streaming hash — avoids pulling the whole .tbak into
  // memory, which matters for full backups that can reach several hundred MB.
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const checksum: string = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve('sha256:' + hash.digest('hex')));
    stream.on('error', reject);
  });

  // Update manifest with checksum (re-zip would be needed for perfect integrity; store in DB instead)
  manifest.checksum = checksum;

  // Insert backup_history
  const [record] = await db('backup_history')
    .insert({
      backup_type: level,
      backup_level: level,
      client_id: clientId ?? null,
      client_name: resolvedClientName,
      period_id: periodId ?? null,
      period_name: resolvedPeriodName,
      filename,
      file_size: fileSize,
      checksum,
      storage_local: filePath,
      trigger_type: triggerType,
      status: 'completed',
      record_counts: JSON.stringify(recordCounts),
      created_by: userId,
    })
    .returning('*');

  return record as BackupHistoryRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore helpers
// ─────────────────────────────────────────────────────────────────────────────

// Guards against zip-bomb / pathological archives on restore. Totals are
// tracked across all extracted table files — a crafted .tbak that claims
// to hold a billion rows can otherwise OOM the Pi.
const MAX_RESTORE_ENTRIES = 200;
const MAX_RESTORE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const MAX_RESTORE_TABLE_BYTES = 512 * 1024 * 1024;             // 512 MiB per table

async function readZipContents(filePath: string): Promise<Record<string, unknown[]>> {
  const tables: Record<string, unknown[]> = {};
  const dir = await unzipper.Open.file(filePath);

  if (dir.files.length > MAX_RESTORE_ENTRIES) {
    throw Object.assign(
      new Error(`Backup archive has ${dir.files.length} entries (max ${MAX_RESTORE_ENTRIES})`),
      { code: 'INVALID_BACKUP' },
    );
  }

  let totalBytes = 0;
  for (const file of dir.files) {
    // Reject entries whose path tries to escape the archive root.
    if (file.path.includes('..') || path.isAbsolute(file.path)) {
      throw Object.assign(new Error(`Backup contains unsafe path: ${file.path}`), { code: 'INVALID_BACKUP' });
    }
    if (!file.path.startsWith('tables/') || !file.path.endsWith('.json')) continue;

    // unzipper exposes both compressed and uncompressed sizes; the
    // uncompressedSize field is reported by the ZIP's central directory.
    const declaredSize = (file as unknown as { uncompressedSize?: number }).uncompressedSize ?? 0;
    if (declaredSize > MAX_RESTORE_TABLE_BYTES) {
      throw Object.assign(
        new Error(`Backup table "${file.path}" is ${declaredSize} bytes (max ${MAX_RESTORE_TABLE_BYTES})`),
        { code: 'INVALID_BACKUP' },
      );
    }
    totalBytes += declaredSize;
    if (totalBytes > MAX_RESTORE_UNCOMPRESSED_BYTES) {
      throw Object.assign(
        new Error(`Backup archive exceeds ${MAX_RESTORE_UNCOMPRESSED_BYTES} bytes uncompressed`),
        { code: 'INVALID_BACKUP' },
      );
    }

    const tableName = path.basename(file.path, '.json');
    const content = await file.buffer();
    tables[tableName] = JSON.parse(content.toString('utf8')) as unknown[];
  }
  return tables;
}

async function readManifest(filePath: string): Promise<Record<string, unknown>> {
  const dir = await unzipper.Open.file(filePath);
  const manifestFile = dir.files.find((f) => f.path === 'manifest.json');
  if (!manifestFile) throw new Error('manifest.json not found in backup');
  const content = await manifestFile.buffer();
  return JSON.parse(content.toString('utf8')) as Record<string, unknown>;
}

type IdMap = Map<string, Map<number, number>>;

// Chunk a long array into batches of `size` — lets us bulk-insert without
// hitting Postgres parameter limits (~65k placeholders per INSERT).
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const BATCH_SIZE = 500;

// ─────────────────────────────────────────────────────────────────────────────
// json/jsonb round-tripping
//
// node-pg serializes a JS array as a Postgres ARRAY literal — ["a","b"] becomes
// {"a","b"} — which a json/jsonb column rejects with `invalid input syntax for
// type json`. Reading a jsonb column back gives us a parsed JS value, so any
// jsonb array in a backup (chart_of_accounts.import_aliases, app_settings.value,
// document_imports.ai_extraction, …) fails on re-insert.
//
// The empty array is a nasty special case: it renders as `{}`, which IS valid
// JSON, so a restore looks perfectly healthy right up until someone actually has
// data in one of those columns.
//
// Fix: pre-encode every value bound for a json/jsonb column to a string, which
// the driver then passes through verbatim. Column lists come from
// information_schema and are cached per table for the life of the process.
// ─────────────────────────────────────────────────────────────────────────────

const jsonColumnCache = new Map<string, Set<string>>();

async function jsonColumnsFor(trx: Knex.Transaction, table: string): Promise<Set<string>> {
  const cached = jsonColumnCache.get(table);
  if (cached) return cached;
  const names = (await trx('information_schema.columns')
    .where({ table_schema: 'public', table_name: table })
    .whereIn('data_type', ['json', 'jsonb'])
    .pluck('column_name')) as string[];
  const set = new Set(names);
  jsonColumnCache.set(table, set);
  return set;
}

/** JSON-encode any json/jsonb values in `rows` so Postgres accepts them. */
async function encodeJsonColumns<T extends Record<string, unknown>>(
  trx: Knex.Transaction,
  table: string,
  rows: T[],
): Promise<T[]> {
  const cols = await jsonColumnsFor(trx, table);
  if (cols.size === 0 || rows.length === 0) return rows;
  return rows.map((row) => {
    let out: T = row;
    for (const col of cols) {
      const value = row[col];
      // null/undefined pass through so nullable columns and NOT NULL defaults
      // behave normally. EVERY other shape gets encoded, strings included: a
      // jsonb string column reads back as a bare JS string ("hello", not
      // "\"hello\""), which Postgres rejects unless we re-quote it. Values here
      // always come from a `SELECT *` on a json/jsonb column, so they are parsed
      // JS values — never already-encoded text — and double-encoding can't occur.
      if (value === undefined || value === null) continue;
      if (out === row) out = { ...row };
      (out as Record<string, unknown>)[col] = JSON.stringify(value);
    }
    return out;
  });
}

/** Encode json columns, then bulk-insert in parameter-limit-safe batches. */
async function insertBatched(
  trx: Knex.Transaction,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const encoded = await encodeJsonColumns(trx, table, rows);
  for (const batch of chunk(encoded, BATCH_SIZE)) {
    await trx(table).insert(batch);
  }
}

// User-attribution FKs (who edited/locked/classified a row) point at app_users,
// but client/period archives never carry the users table — and even a settings
// restore only materializes users on explicit opt-in. So these ids only resolve
// when the archive came from THIS instance. For a backup we produced (looked up
// by backupId) attribution is kept when the user still exists; for an uploaded
// .tbak the same numeric id could be a different person on the source instance,
// so attribution is dropped rather than misassigned. Leaving the raw id in
// place — the previous behaviour — failed the whole restore on the FK when the
// user was absent.
const USER_FK_COLUMNS: Record<string, string[]> = {
  periods: ['locked_by'],
  trial_balance: ['updated_by'],
  journal_entries: ['created_by'],
  bank_transactions: ['classified_by'],
  variance_notes: ['created_by'],
  document_imports: ['imported_by', 'verified_by'],
  lead_sheets: ['created_by'],
  lead_sheet_signoffs: ['user_id', 'invalidated_by'],
  lead_sheet_attachments: ['created_by', 'deleted_by'],
  lead_sheet_notes: ['author_id', 'resolved_by'],
  client_documents: ['uploaded_by', 'deleted_by'],
  client_folder_links: ['created_by'],
  qbo_connections: ['connected_by'],
  ...FS_USER_FK_COLUMNS,
};

type UserFkSanitizer = (table: string, row: Record<string, unknown>) => Record<string, unknown>;

async function makeUserFkSanitizer(
  trx: Knex.Transaction,
  trustSourceUserIds: boolean,
): Promise<UserFkSanitizer> {
  const validIds = trustSourceUserIds
    ? new Set((await trx('app_users').pluck('id')) as number[])
    : new Set<number>();
  return (table, row) => {
    const cols = USER_FK_COLUMNS[table];
    if (!cols) return row;
    let out = row;
    for (const col of cols) {
      const value = out[col];
      if (value != null && !validIds.has(value as number)) {
        if (out === row) out = { ...row };
        out[col] = null;
      }
    }
    return out;
  };
}

/**
 * Legacy alpha system tax codes (GROSS_RECEIPTS, REPORTING_ONLY, …) were purged
 * by migration 20260817000002 — system codes are numeric only. Archives written
 * before that can still carry them, both as tax_codes rows and as
 * chart_of_accounts.tax_code_id references.
 */
function isLegacyAlphaTaxCode(row: Record<string, unknown>): boolean {
  return row.is_system === true && !/^[0-9]+$/.test(String(row.tax_code ?? ''));
}

/**
 * Build a resolver for chart_of_accounts.tax_code_id on client restores. Client
 * archives don't restore tax_codes, so the raw id is only meaningful on the
 * instance that wrote the archive — and even there the code may since have been
 * deleted (see above). Resolution: id still exists live → keep; otherwise look
 * the archive's tax_codes row up by (return_form, activity_type, tax_code) → live
 * id; otherwise null (the account shows as unmapped instead of failing the FK).
 */
async function makeTaxCodeResolver(
  trx: Knex.Transaction,
  tables: Record<string, unknown[]>,
): Promise<(oldId: unknown) => number | null> {
  const liveRows = (await trx('tax_codes').select('id', 'return_form', 'activity_type', 'tax_code')) as Array<{
    id: number; return_form: string; activity_type: string; tax_code: string;
  }>;
  const liveIds = new Set(liveRows.map((r) => r.id));
  const liveByKey = new Map(liveRows.map((r) => [`${r.return_form}|${r.activity_type}|${r.tax_code}`, r.id]));
  const archiveById = new Map<number, string>();
  for (const row of (tables['tax_codes'] as Array<Record<string, unknown>> | undefined) ?? []) {
    if (typeof row.id === 'number') {
      archiveById.set(row.id, `${row.return_form}|${row.activity_type}|${row.tax_code}`);
    }
  }
  return (oldId: unknown): number | null => {
    if (oldId === null || oldId === undefined) return null;
    const id = oldId as number;
    if (liveIds.has(id)) return id;
    const key = archiveById.get(id);
    return key !== undefined ? liveByKey.get(key) ?? null : null;
  };
}

async function restoreAsNew(
  tables: Record<string, unknown[]>,
  trx: Knex.Transaction,
  trustSourceUserIds: boolean,
): Promise<{
  newClientId: number;
  idMappings: Record<string, Record<number, number>>;
  /** Nullable FK links nulled because the archive didn't carry the parent row. */
  droppedLinks: number;
}> {
  const idMap: IdMap = new Map();
  const sanitizeUserFks = await makeUserFkSanitizer(trx, trustSourceUserIds);

  function getNewId(table: string, oldId: number): number {
    // Fail loudly rather than silently fall through to the old ID — if the backup
    // references a parent row we never mapped, returning `oldId` would point the
    // new child at an unrelated (possibly different-client) existing row.
    const mapped = idMap.get(table)?.get(oldId);
    if (mapped === undefined) {
      throw Object.assign(
        new Error(`Restore consistency error: ${table} id ${oldId} referenced but not remapped. The backup is missing a parent row.`),
        { code: 'RESTORE_BROKEN_REF', status: 400 },
      );
    }
    return mapped;
  }

  // Nullable FK columns get the soft treatment: if the archive references a
  // parent we never restored (common for period-level backups, which carry only
  // one period's slice), we null the link instead of failing the whole restore.
  // Leaving the raw old id in place — the previous behaviour — silently pointed
  // the restored rows at ANOTHER client's records.
  let droppedLinks = 0;
  function mapOptional(table: string, oldId: unknown): number | null {
    if (oldId === null || oldId === undefined) return null;
    const mapped = idMap.get(table)?.get(oldId as number);
    if (mapped === undefined) {
      droppedLinks++;
      return null;
    }
    return mapped;
  }

  function registerMap(table: string): Map<number, number> {
    const m = new Map<number, number>();
    idMap.set(table, m);
    return m;
  }

  let newClientId = 0;

  // 1. clients — row-by-row because we check for name collisions
  const clientsData = tables['clients'] as Array<Record<string, unknown>> | undefined;
  if (clientsData && clientsData.length > 0) {
    const clientMap = registerMap('clients');
    for (const row of clientsData) {
      const oldId = row.id as number;
      const existing = await trx('clients').where('name', row.name as string).first('id');
      let insertName = row.name as string;
      if (existing) {
        insertName = `${insertName} (Restored)`;
      }
      // default_source_account_id points into chart_of_accounts, which is
      // restored AFTER clients — insert null and patch it once accounts are mapped.
      const [inserted] = await trx('clients')
        .insert({ ...row, id: undefined, name: insertName, default_source_account_id: null })
        .returning('id');
      const newId = (inserted as { id: number }).id;
      clientMap.set(oldId, newId);
      newClientId = newId;
    }

    // Take a per-client advisory lock so a second concurrent restore onto the
    // same target client serializes cleanly rather than corrupting state.
    // pg_advisory_xact_lock releases automatically at transaction end.
    await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [42, newClientId]);
  }

  // 2. periods — bulk insert, preserving old->new id order.
  // rolled_forward_from is a self-reference, so it can't be resolved during the
  // insert (the target period may not exist yet). Insert null, then patch in a
  // second pass once every period is mapped.
  const periodsData = tables['periods'] as Array<Record<string, unknown>> | undefined;
  if (periodsData && periodsData.length > 0) {
    const periodMap = registerMap('periods');
    const prepared = periodsData.map((row) => sanitizeUserFks('periods', {
      ...row,
      id: undefined,
      client_id: getNewId('clients', row.client_id as number),
      rolled_forward_from: null,
    }));
    const encoded = await encodeJsonColumns(trx, 'periods', prepared);
    for (const batch of chunk(encoded, BATCH_SIZE)) {
      const indexInWhole = encoded.indexOf(batch[0]);
      const inserted = await trx('periods').insert(batch).returning('id');
      inserted.forEach((r, i) => {
        const oldId = periodsData[indexInWhole + i].id as number;
        periodMap.set(oldId, (r as { id: number }).id);
      });
    }
    for (const row of periodsData) {
      if (row.rolled_forward_from == null) continue;
      const newSelfId = periodMap.get(row.id as number);
      const newParentId = mapOptional('periods', row.rolled_forward_from);
      if (newSelfId !== undefined && newParentId !== null) {
        await trx('periods').where('id', newSelfId).update({ rolled_forward_from: newParentId });
      }
    }
  }

  // 2.5 lead_sheets — must precede chart_of_accounts, which carries the
  // lead_sheet_id FK that gets remapped below.
  const leadSheetData = tables['lead_sheets'] as Array<Record<string, unknown>> | undefined;
  if (leadSheetData && leadSheetData.length > 0 && (await trx.schema.hasTable('lead_sheets'))) {
    const lsMap = registerMap('lead_sheets');
    const prepared = leadSheetData.map((row) => ({
      ...row,
      id: undefined,
      client_id: getNewId('clients', row.client_id as number),
    }));
    for (const batch of chunk(prepared, BATCH_SIZE)) {
      const indexInWhole = prepared.indexOf(batch[0]);
      const inserted = await trx('lead_sheets').insert(batch.map((r) => sanitizeUserFks('lead_sheets', r))).returning('id');
      inserted.forEach((r, i) => {
        const oldId = leadSheetData[indexInWhole + i].id as number;
        lsMap.set(oldId, (r as { id: number }).id);
      });
    }
  }

  // 3. chart_of_accounts — bulk insert
  const coaData = tables['chart_of_accounts'] as Array<Record<string, unknown>> | undefined;
  if (coaData && coaData.length > 0) {
    const coaMap = registerMap('chart_of_accounts');
    const resolveTaxCode = await makeTaxCodeResolver(trx, tables);
    const prepared = coaData.map((row) => ({
      ...row,
      id: undefined,
      client_id: getNewId('clients', row.client_id as number),
      tax_code_id: resolveTaxCode(row.tax_code_id),
      lead_sheet_id: mapOptional('lead_sheets', row.lead_sheet_id),
    }));
    const encoded = await encodeJsonColumns(trx, 'chart_of_accounts', prepared);
    for (const batch of chunk(encoded, BATCH_SIZE)) {
      const indexInWhole = encoded.indexOf(batch[0]);
      const inserted = await trx('chart_of_accounts').insert(batch).returning('id');
      inserted.forEach((r, i) => {
        const oldId = coaData[indexInWhole + i].id as number;
        coaMap.set(oldId, (r as { id: number }).id);
      });
    }
    // Second pass: clients.default_source_account_id (deferred above).
    for (const row of clientsData ?? []) {
      const newDefault = mapOptional('chart_of_accounts', row.default_source_account_id);
      const newCid = getNewId('clients', row.id as number);
      if (newDefault !== null) {
        await trx('clients').where('id', newCid).update({ default_source_account_id: newDefault });
      }
    }
  }

  // 4. trial_balance — bulk insert (no id mapping needed downstream)
  const tbData = tables['trial_balance'] as Array<Record<string, unknown>> | undefined;
  if (tbData && tbData.length > 0) {
    const rows = tbData.map((row) => sanitizeUserFks('trial_balance', {
      ...row,
      id: undefined,
      period_id: getNewId('periods', row.period_id as number),
      account_id: getNewId('chart_of_accounts', row.account_id as number),
    }));
    await insertBatched(trx, 'trial_balance', rows);
  }

  // 5. journal_entries — bulk insert, tracking old->new id
  const jeData = tables['journal_entries'] as Array<Record<string, unknown>> | undefined;
  if (jeData && jeData.length > 0) {
    const jeMap = registerMap('journal_entries');
    const prepared = jeData.map((row) => sanitizeUserFks('journal_entries', {
      ...row,
      id: undefined,
      period_id: getNewId('periods', row.period_id as number),
    }));
    const encoded = await encodeJsonColumns(trx, 'journal_entries', prepared);
    for (const batch of chunk(encoded, BATCH_SIZE)) {
      const indexInWhole = encoded.indexOf(batch[0]);
      const inserted = await trx('journal_entries').insert(batch).returning('id');
      inserted.forEach((r, i) => {
        const oldId = jeData[indexInWhole + i].id as number;
        jeMap.set(oldId, (r as { id: number }).id);
      });
    }
  }

  // 6. journal_entry_lines — bulk insert
  const jelData = tables['journal_entry_lines'] as Array<Record<string, unknown>> | undefined;
  if (jelData && jelData.length > 0) {
    const rows = jelData.map((row) => ({
      ...row,
      id: undefined,
      journal_entry_id: getNewId('journal_entries', row.journal_entry_id as number),
      account_id: getNewId('chart_of_accounts', row.account_id as number),
    }));
    await insertBatched(trx, 'journal_entry_lines', rows);
  }

  // 7. bank_transactions — bulk insert.
  // Every FK on this table has to be rewritten, not just client_id/account_id:
  // period_id, source_account_id, ai_suggested_account_id and journal_entry_id
  // are all nullable FKs that previously carried the SOURCE instance's ids
  // straight through, silently attaching the restored client's transactions to
  // the original client's period and accounts.
  const btData = tables['bank_transactions'] as Array<Record<string, unknown>> | undefined;
  if (btData && btData.length > 0) {
    const rows = btData.map((row) => sanitizeUserFks('bank_transactions', {
      ...row,
      id: undefined,
      client_id: getNewId('clients', row.client_id as number),
      account_id: row.account_id ? getNewId('chart_of_accounts', row.account_id as number) : null,
      period_id: mapOptional('periods', row.period_id),
      source_account_id: mapOptional('chart_of_accounts', row.source_account_id),
      ai_suggested_account_id: mapOptional('chart_of_accounts', row.ai_suggested_account_id),
      journal_entry_id: mapOptional('journal_entries', row.journal_entry_id),
    }));
    await insertBatched(trx, 'bank_transactions', rows);
  }

  // 8. classification_rules — bulk insert
  const rulesData = tables['classification_rules'] as Array<Record<string, unknown>> | undefined;
  if (rulesData && rulesData.length > 0) {
    const rows = rulesData.map((row) => ({
      ...row,
      id: undefined,
      client_id: getNewId('clients', row.client_id as number),
      account_id: row.account_id ? getNewId('chart_of_accounts', row.account_id as number) : null,
    }));
    await insertBatched(trx, 'classification_rules', rows);
  }

  // 9. variance_notes — bulk insert.
  // compare_period_id is NOT NULL and FKs into periods, so a note whose compare
  // period didn't ride along in the archive can't be restored at all — skip it
  // rather than fail the restore or point it at a stranger's period.
  const vnData = tables['variance_notes'] as Array<Record<string, unknown>> | undefined;
  if (vnData && vnData.length > 0) {
    const rows = vnData
      .map((row) => sanitizeUserFks('variance_notes', {
        ...row,
        id: undefined,
        account_id: getNewId('chart_of_accounts', row.account_id as number),
        period_id: getNewId('periods', row.period_id as number),
        compare_period_id: mapOptional('periods', row.compare_period_id),
      }))
      .filter((row) => row.compare_period_id !== null);
    await insertBatched(trx, 'variance_notes', rows);
  }

  // 10. document_imports — bulk insert. client_id is NOT NULL and was previously
  // left pointing at the source client.
  const diData = tables['document_imports'] as Array<Record<string, unknown>> | undefined;
  if (diData && diData.length > 0) {
    const rows = diData.map((row) => sanitizeUserFks('document_imports', {
      ...row,
      id: undefined,
      client_id: getNewId('clients', row.client_id as number),
      period_id: getNewId('periods', row.period_id as number),
    }));
    await insertBatched(trx, 'document_imports', rows);
  }

  // 10.5 client_documents — must precede lead_sheet_attachments, which carries
  // the document_id FK. Registers an id map for that remap.
  //
  // The bytes are NOT in the archive, only the rows: a restored instance will
  // have documents whose object is absent until the files are moved across.
  // The download handler's FILE_MISSING message says so.
  const docData = tables['client_documents'] as Array<Record<string, unknown>> | undefined;
  if (docData && docData.length > 0) {
    const docMap = registerMap('client_documents');
    const prepared = docData.map((row) => {
      const newClientId = getNewId('clients', row.client_id as number);
      // An object key encodes the ORIGINAL client's folder. Restoring into a
      // different client must not point the copies at that client's objects:
      // the two rows would share one file, and deleting either would destroy
      // the other's bytes. Drop the storage pointers instead — the row keeps
      // its metadata, and the download handler already explains that the file
      // was not part of the backup.
      const sameClient = newClientId === (row.client_id as number);
      return sanitizeUserFks('client_documents', {
        ...row,
        id: undefined,
        client_id: newClientId,
        period_id: mapOptional('periods', row.period_id),
        linked_account_id: mapOptional('chart_of_accounts', row.linked_account_id),
        linked_journal_entry_id: mapOptional('journal_entries', row.linked_journal_entry_id),
        ...(sameClient ? {} : { object_key: null, bucket: null, file_path: null, etag: null }),
      });
    });
    for (const batch of chunk(prepared, BATCH_SIZE)) {
      const indexInWhole = prepared.indexOf(batch[0]);
      const inserted = await trx('client_documents').insert(batch).returning('id');
      inserted.forEach((r, i) => {
        docMap.set(docData[indexInWhole + i].id as number, (r as { id: number }).id);
      });
    }
  }

  // 10.6 client_folder_links — one row per client, and storage_path is unique,
  // so a restore into an instance that already has that path must not collide.
  const linkData = tables['client_folder_links'] as Array<Record<string, unknown>> | undefined;
  if (linkData && linkData.length > 0 && (await trx.schema.hasTable('client_folder_links'))) {
    for (const row of linkData) {
      const newClientId = getNewId('clients', row.client_id as number);
      // A restored-as-new client must NOT claim the original's folder: the path
      // is unique, and two clients pointing at one folder would interleave
      // their documents. It arrives unlinked instead, which the Storage page
      // surfaces and which matches linking being an explicit act.
      if (newClientId !== (row.client_id as number)) continue;
      await trx('client_folder_links')
        .insert(sanitizeUserFks('client_folder_links', { ...row, id: undefined, client_id: newClientId }))
        // Restoring into an instance that already knows this folder is fine.
        .onConflict('client_id').ignore();
    }
  }

  // 11. lead_sheet_signoffs — balance_stamp is content-derived, so it needs no
  // remapping: a restored engagement stays "signed" when the amounts came back
  // identical and goes STALE when they didn't, which is exactly right.
  const lsSignoffData = tables['lead_sheet_signoffs'] as Array<Record<string, unknown>> | undefined;
  if (lsSignoffData && lsSignoffData.length > 0 && (await trx.schema.hasTable('lead_sheet_signoffs'))) {
    const rows = lsSignoffData
      .map((row) => sanitizeUserFks('lead_sheet_signoffs', {
        ...row,
        id: undefined,
        period_id: getNewId('periods', row.period_id as number),
        lead_sheet_id: mapOptional('lead_sheets', row.lead_sheet_id),
      }))
      // A signature whose lead sheet didn't come along has nothing to attach to.
      .filter((row) => row.lead_sheet_id !== null);
    await insertBatched(trx, 'lead_sheet_signoffs', rows);
  }

  // 11.5 lead_sheet_notes — after lead_sheets, periods and chart_of_accounts,
  // all three of which it points at.
  const lsNoteData = tables['lead_sheet_notes'] as Array<Record<string, unknown>> | undefined;
  if (lsNoteData && lsNoteData.length > 0 && (await trx.schema.hasTable('lead_sheet_notes'))) {
    const rows = lsNoteData.map((row) => sanitizeUserFks('lead_sheet_notes', {
      ...row,
      id: undefined,
      client_id: newClientId,
      period_id: getNewId('periods', row.period_id as number),
      lead_sheet_id: mapOptional('lead_sheets', row.lead_sheet_id),
      account_id: mapOptional('chart_of_accounts', row.account_id),
    }));
    await insertBatched(trx, 'lead_sheet_notes', rows);
  }

  // 12. lead_sheet_attachments — after client_documents (document_id FK) and
  // lead_sheets. Tombstone rows come across too: they are what reserves a
  // retired ref code so it is never reissued.
  const attData = tables['lead_sheet_attachments'] as Array<Record<string, unknown>> | undefined;
  if (attData && attData.length > 0 && (await trx.schema.hasTable('lead_sheet_attachments'))) {
    const rows = attData
      .map((row) => sanitizeUserFks('lead_sheet_attachments', {
        ...row,
        id: undefined,
        client_id: getNewId('clients', row.client_id as number),
        period_id: getNewId('periods', row.period_id as number),
        lead_sheet_id: mapOptional('lead_sheets', row.lead_sheet_id),
        account_id: mapOptional('chart_of_accounts', row.account_id),
        document_id: mapOptional('client_documents', row.document_id),
      }));
    await insertBatched(trx, 'lead_sheet_attachments', rows);
  }

  // 13. Statement Writer — last: it points at periods, accounts and lead
  // sheets, both as columns and inside its layout JSON.
  await restoreFsClientTables(trx, tables, {
    clientId: newClientId,
    period: (id) => idMap.get('periods')?.get(id),
    account: (id) => idMap.get('chart_of_accounts')?.get(id),
    leadSheet: (id) => idMap.get('lead_sheets')?.get(id),
    sanitizeUserFks,
    trustLibraryIds: trustSourceUserIds,
  });

  // Build serializable id_mappings
  const idMappings: Record<string, Record<number, number>> = {};
  for (const [table, map] of idMap.entries()) {
    idMappings[table] = Object.fromEntries(map.entries());
  }

  return { newClientId, idMappings, droppedLinks };
}

/**
 * Tear down every row belonging to a client, children first.
 *
 * `DELETE FROM clients` alone is not enough. The cascade graph reaches
 * chart_of_accounts and periods, but several FKs pointing at those two tables
 * are NO ACTION (journal_entry_lines.account_id, bank_transactions.account_id,
 * variance_notes.account_id, …). Postgres does not guarantee it will cascade the
 * grandchildren before it checks those constraints, so the delete raised a
 * foreign-key violation and rolled the whole restore back.
 *
 * Deleting explicitly in dependency order is deterministic and keeps the FK
 * semantics the rest of the app relies on when a user removes a single account.
 * Optional tables are hasTable-guarded so a restore onto an older schema works.
 */
async function deleteClientData(trx: Knex.Transaction, clientId: number): Promise<void> {
  const periodIds = (await trx('periods').where('client_id', clientId).pluck('id')) as number[];
  const coaIds = (await trx('chart_of_accounts').where('client_id', clientId).pluck('id')) as number[];
  const jeIds = periodIds.length
    ? ((await trx('journal_entries').whereIn('period_id', periodIds).pluck('id')) as number[])
    : [];

  const has = async (t: string) => trx.schema.hasTable(t);

  if (jeIds.length) {
    await trx('journal_entry_lines').whereIn('journal_entry_id', jeIds).delete();
  }

  if (await has('bank_reconciliations')) {
    const reconIds = (await trx('bank_reconciliations').where('client_id', clientId).pluck('id')) as number[];
    if (reconIds.length && (await has('reconciliation_items'))) {
      await trx('reconciliation_items').whereIn('reconciliation_id', reconIds).delete();
    }
    await trx('bank_reconciliations').where('client_id', clientId).delete();
  }

  // Rows keyed by period.
  if (periodIds.length) {
    for (const table of ['lead_sheet_notes', 'lead_sheet_attachments', 'lead_sheet_signoffs', 'tb_tickmarks', 'engagement_tasks', 'm1_adjustments', 'py_comparison_data']) {
      if (await has(table)) await trx(table).whereIn('period_id', periodIds).delete();
    }
    await trx('variance_notes').whereIn('period_id', periodIds).orWhereIn('compare_period_id', periodIds).delete();
    await trx('document_imports').whereIn('period_id', periodIds).delete();
    await trx('trial_balance').whereIn('period_id', periodIds).delete();
  }

  // Rows keyed by account (may exist even with no periods).
  if (coaIds.length) {
    await trx('variance_notes').whereIn('account_id', coaIds).delete();
    if (await has('tb_tickmarks')) await trx('tb_tickmarks').whereIn('account_id', coaIds).delete();
    if (await has('py_comparison_data')) await trx('py_comparison_data').whereIn('account_id', coaIds).delete();
  }

  // bank_transactions references journal_entries, chart_of_accounts AND periods,
  // so it must go before all three.
  await trx('bank_transactions').where('client_id', clientId).delete();
  if (jeIds.length) await trx('journal_entries').whereIn('id', jeIds).delete();

  // Statement Writer rows point at periods, lead sheets and accounts.
  await deleteFsClientData(trx, clientId);

  // Direct children of clients that also point into chart_of_accounts.
  await trx('classification_rules').where('client_id', clientId).delete();
  for (const table of ['lead_sheet_notes', 'client_documents', 'client_folder_links', 'tickmark_library', 'lead_sheets', 'saved_reports', 'export_consolidation_settings']) {
    if (await has(table)) await trx(table).where('client_id', clientId).delete();
  }

  await trx('chart_of_accounts').where('client_id', clientId).delete();

  // periods.rolled_forward_from is a self-reference — break the links first so
  // the row order within this delete can't matter.
  if (periodIds.length) {
    await trx('periods').whereIn('id', periodIds).update({ rolled_forward_from: null });
    await trx('periods').whereIn('id', periodIds).delete();
  }

  await trx('clients').where('id', clientId).delete();
}

async function restoreReplace(
  tables: Record<string, unknown[]>,
  targetClientId: number,
  trx: Knex.Transaction,
  trustSourceUserIds: boolean,
): Promise<void> {
  // Take a per-client advisory lock first so concurrent restores on the same
  // client serialize. Any other session holding the lock (e.g. another
  // restore) blocks here until the current txn ends.
  await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [42, targetClientId]);

  const sanitizeUserFks = await makeUserFkSanitizer(trx, trustSourceUserIds);

  await deleteClientData(trx, targetClientId);

  const clientsData = tables['clients'] as Array<Record<string, unknown>> | undefined;
  if (!clientsData || clientsData.length === 0) return;

  const oldClientId = clientsData[0].id as number;

  function remapClientId(row: Record<string, unknown>): Record<string, unknown> {
    if (row.client_id === oldClientId) return { ...row, client_id: targetClientId };
    return row;
  }

  // Insert client with target ID
  // default_source_account_id is patched after chart_of_accounts is restored.
  await trx('clients').insert({ ...clientsData[0], id: targetClientId, default_source_account_id: null });

  const periodIdMap = new Map<number, number>();
  const coaIdMap = new Map<number, number>();
  const jeIdMap = new Map<number, number>();

  // Nullable FKs resolve to null when the archive doesn't carry the parent.
  // The old `?? row.<col>` fallbacks left the SOURCE instance's id in place,
  // which on this DB resolves to some unrelated row.
  function mapOptional(map: Map<number, number>, oldId: unknown): number | null {
    if (oldId === null || oldId === undefined) return null;
    return map.get(oldId as number) ?? null;
  }

  // periods — bulk. rolled_forward_from is a self-reference; null it on insert
  // and patch once every period has an id.
  const periodsData = tables['periods'] as Array<Record<string, unknown>> | undefined;
  if (periodsData && periodsData.length > 0) {
    const prepared = periodsData.map((row) =>
      sanitizeUserFks('periods', remapClientId({ ...row, id: undefined, rolled_forward_from: null })),
    );
    const encoded = await encodeJsonColumns(trx, 'periods', prepared);
    for (const batch of chunk(encoded, BATCH_SIZE)) {
      const indexInWhole = encoded.indexOf(batch[0]);
      const ins = await trx('periods').insert(batch).returning('id');
      ins.forEach((r, i) => {
        periodIdMap.set(periodsData[indexInWhole + i].id as number, (r as { id: number }).id);
      });
    }
    for (const row of periodsData) {
      if (row.rolled_forward_from == null) continue;
      const newSelfId = periodIdMap.get(row.id as number);
      const newParentId = mapOptional(periodIdMap, row.rolled_forward_from);
      if (newSelfId !== undefined && newParentId !== null) {
        await trx('periods').where('id', newSelfId).update({ rolled_forward_from: newParentId });
      }
    }
  }

  // chart_of_accounts — bulk
  const coaData = tables['chart_of_accounts'] as Array<Record<string, unknown>> | undefined;
  if (coaData && coaData.length > 0) {
    const resolveTaxCode = await makeTaxCodeResolver(trx, tables);
    // lead_sheet_id is nulled on insert and applied below: the FK fires at
    // insert time, and lead_sheets are restored after this block.
    const prepared = coaData.map((row) =>
      remapClientId({ ...row, id: undefined, tax_code_id: resolveTaxCode(row.tax_code_id), lead_sheet_id: null }),
    );
    const encoded = await encodeJsonColumns(trx, 'chart_of_accounts', prepared);
    for (const batch of chunk(encoded, BATCH_SIZE)) {
      const indexInWhole = encoded.indexOf(batch[0]);
      const ins = await trx('chart_of_accounts').insert(batch).returning('id');
      ins.forEach((r, i) => {
        coaIdMap.set(coaData[indexInWhole + i].id as number, (r as { id: number }).id);
      });
    }
    const newDefault = mapOptional(coaIdMap, clientsData[0].default_source_account_id);
    if (newDefault !== null) {
      await trx('clients').where('id', targetClientId).update({ default_source_account_id: newDefault });
    }
  }

  // trial_balance — bulk
  const tbData = tables['trial_balance'] as Array<Record<string, unknown>> | undefined;
  if (tbData && tbData.length > 0) {
    const rows = tbData.map((row) => sanitizeUserFks('trial_balance', {
      ...row,
      id: undefined,
      period_id: periodIdMap.get(row.period_id as number) ?? row.period_id,
      account_id: coaIdMap.get(row.account_id as number) ?? row.account_id,
    }));
    await insertBatched(trx, 'trial_balance', rows);
  }

  // journal_entries — bulk
  const jeData = tables['journal_entries'] as Array<Record<string, unknown>> | undefined;
  if (jeData && jeData.length > 0) {
    const prepared = jeData.map((row) => sanitizeUserFks('journal_entries', {
      ...row,
      id: undefined,
      period_id: periodIdMap.get(row.period_id as number) ?? row.period_id,
    }));
    const encoded = await encodeJsonColumns(trx, 'journal_entries', prepared);
    for (const batch of chunk(encoded, BATCH_SIZE)) {
      const indexInWhole = encoded.indexOf(batch[0]);
      const ins = await trx('journal_entries').insert(batch).returning('id');
      ins.forEach((r, i) => {
        jeIdMap.set(jeData[indexInWhole + i].id as number, (r as { id: number }).id);
      });
    }
  }

  // journal_entry_lines — bulk
  const jelData = tables['journal_entry_lines'] as Array<Record<string, unknown>> | undefined;
  if (jelData && jelData.length > 0) {
    const rows = jelData.map((row) => ({
      ...row,
      id: undefined,
      journal_entry_id: jeIdMap.get(row.journal_entry_id as number) ?? row.journal_entry_id,
      account_id: coaIdMap.get(row.account_id as number) ?? row.account_id,
    }));
    await insertBatched(trx, 'journal_entry_lines', rows);
  }

  // bank_transactions — bulk
  const btData = tables['bank_transactions'] as Array<Record<string, unknown>> | undefined;
  if (btData && btData.length > 0) {
    const rows = btData.map((row) => sanitizeUserFks('bank_transactions', {
      ...row,
      id: undefined,
      client_id: targetClientId,
      account_id: row.account_id ? (coaIdMap.get(row.account_id as number) ?? row.account_id) : null,
      period_id: mapOptional(periodIdMap, row.period_id),
      source_account_id: mapOptional(coaIdMap, row.source_account_id),
      ai_suggested_account_id: mapOptional(coaIdMap, row.ai_suggested_account_id),
      journal_entry_id: mapOptional(jeIdMap, row.journal_entry_id),
    }));
    await insertBatched(trx, 'bank_transactions', rows);
  }

  // classification_rules — bulk
  const rulesData = tables['classification_rules'] as Array<Record<string, unknown>> | undefined;
  if (rulesData && rulesData.length > 0) {
    const rows = rulesData.map((row) => remapClientId({
      ...row,
      id: undefined,
      account_id: row.account_id ? (coaIdMap.get(row.account_id as number) ?? row.account_id) : null,
    }));
    await insertBatched(trx, 'classification_rules', rows);
  }

  // variance_notes — bulk
  // compare_period_id is NOT NULL — drop notes whose compare period isn't in
  // the archive instead of pointing them at an unrelated period.
  const vnData = tables['variance_notes'] as Array<Record<string, unknown>> | undefined;
  if (vnData && vnData.length > 0) {
    const rows = vnData
      .map((row) => sanitizeUserFks('variance_notes', {
        ...row,
        id: undefined,
        account_id: coaIdMap.get(row.account_id as number) ?? row.account_id,
        period_id: periodIdMap.get(row.period_id as number) ?? row.period_id,
        compare_period_id: mapOptional(periodIdMap, row.compare_period_id),
      }))
      .filter((row) => row.compare_period_id !== null);
    await insertBatched(trx, 'variance_notes', rows);
  }

  // document_imports — bulk
  const diData = tables['document_imports'] as Array<Record<string, unknown>> | undefined;
  if (diData && diData.length > 0) {
    const rows = diData.map((row) => sanitizeUserFks('document_imports', remapClientId({
      ...row,
      id: undefined,
      period_id: periodIdMap.get(row.period_id as number) ?? row.period_id,
    })));
    await insertBatched(trx, 'document_imports', rows);
  }

  // lead_sheets — deleteClientData removes these, so without re-inserting them
  // a replace-mode restore would silently wipe the client's lead sheets, and
  // with them every account's assignment.
  const lsMap = new Map<number, number>();
  const lsData = tables['lead_sheets'] as Array<Record<string, unknown>> | undefined;
  if (lsData && lsData.length > 0 && (await trx.schema.hasTable('lead_sheets'))) {
    for (const row of lsData) {
      const [ins] = await trx('lead_sheets')
        .insert(sanitizeUserFks('lead_sheets', remapClientId({ ...row, id: undefined })))
        .returning('id');
      lsMap.set(row.id as number, (ins as { id: number }).id);
    }
  }

  // Apply the assignments now that the new lead sheet ids exist. Driven by the
  // ARCHIVED value on each account row, since the insert above nulled it.
  if (coaData && coaData.length > 0) {
    for (const row of coaData) {
      const archived = row.lead_sheet_id as number | null;
      const newAccountId = coaIdMap.get(row.id as number);
      if (!archived || !newAccountId) continue;
      const newLeadSheetId = lsMap.get(archived);
      if (!newLeadSheetId) continue; // archived sheet absent — stays unassigned
      await trx('chart_of_accounts')
        .where({ id: newAccountId })
        .update({ lead_sheet_id: newLeadSheetId, lead_sheet_source: row.lead_sheet_source ?? null });
    }
  }

  // lead_sheet_signoffs
  const soData = tables['lead_sheet_signoffs'] as Array<Record<string, unknown>> | undefined;
  if (soData && soData.length > 0 && (await trx.schema.hasTable('lead_sheet_signoffs'))) {
    const rows = soData
      .map((row) => sanitizeUserFks('lead_sheet_signoffs', {
        ...row,
        id: undefined,
        period_id: periodIdMap.get(row.period_id as number) ?? row.period_id,
        lead_sheet_id: lsMap.get(row.lead_sheet_id as number) ?? null,
      }))
      .filter((row) => row.lead_sheet_id !== null);
    await insertBatched(trx, 'lead_sheet_signoffs', rows);
  }

  // client_documents. Replace mode takes an arbitrary targetClientId, so it is
  // NOT safe to assume the archive came from that same client: an object key
  // encodes the ORIGINAL client's folder, and keeping it would both point two
  // clients at one file and collide with the live row on the partial unique
  // index over (bucket, object_key). Same rule as restore-as-new — drop the
  // storage pointers whenever the client changed, and keep them when it didn't.
  const sameClient = oldClientId === targetClientId;
  const docMap = new Map<number, number>();
  const cdData = tables['client_documents'] as Array<Record<string, unknown>> | undefined;
  if (cdData && cdData.length > 0) {
    for (const row of cdData) {
      const [ins] = await trx('client_documents')
        .insert(sanitizeUserFks('client_documents', remapClientId({
          ...row,
          id: undefined,
          period_id: row.period_id ? (periodIdMap.get(row.period_id as number) ?? null) : null,
          linked_account_id: mapOptional(coaIdMap, row.linked_account_id),
          linked_journal_entry_id: null,
          ...(sameClient ? {} : { object_key: null, bucket: null, file_path: null, etag: null }),
        })))
        .returning('id');
      docMap.set(row.id as number, (ins as { id: number }).id);
    }
  }

  // qbo_connections — the live row (if any) is NOT deleted by deleteClientData
  // and wins: Intuit rotates refresh tokens on every use, so the archived pair
  // is usually already dead. Re-insert only when the client has no live
  // binding and the archive came from this same client; a different client
  // would hit UNIQUE (environment, realm_id) or steal the company outright.
  const qboData = tables['qbo_connections'] as Array<Record<string, unknown>> | undefined;
  if (sameClient && qboData && qboData.length > 0 && (await trx.schema.hasTable('qbo_connections'))) {
    for (const row of qboData) {
      await trx('qbo_connections')
        .insert(sanitizeUserFks('qbo_connections', remapClientId({ ...row, id: undefined, access_token_enc: null, access_token_expires_at: null })))
        // Bare ON CONFLICT: covers UNIQUE(client_id) and UNIQUE(environment, realm_id) alike.
        .onConflict().ignore();
    }
  }

  // client_folder_links — one row per client, so re-insert only if the delete
  // above removed it. When the target is a DIFFERENT client the archived path
  // belongs to somebody else and storage_path is unique, so the client arrives
  // unlinked instead — same rule as restore-as-new.
  const cflData = tables['client_folder_links'] as Array<Record<string, unknown>> | undefined;
  if (sameClient && cflData && cflData.length > 0 && (await trx.schema.hasTable('client_folder_links'))) {
    for (const row of cflData) {
      await trx('client_folder_links')
        .insert(sanitizeUserFks('client_folder_links', remapClientId({ ...row, id: undefined })))
        .onConflict('client_id').ignore();
    }
  }

  // lead_sheet_attachments — after documents (FK) and lead sheets. Tombstones
  // come across too: they are what keeps a retired ref code reserved.
  const laData = tables['lead_sheet_attachments'] as Array<Record<string, unknown>> | undefined;
  if (laData && laData.length > 0 && (await trx.schema.hasTable('lead_sheet_attachments'))) {
    const rows = laData.map((row) => sanitizeUserFks('lead_sheet_attachments', remapClientId({
      ...row,
      id: undefined,
      period_id: periodIdMap.get(row.period_id as number) ?? row.period_id,
      lead_sheet_id: lsMap.get(row.lead_sheet_id as number) ?? null,
      account_id: mapOptional(coaIdMap, row.account_id),
      document_id: docMap.get(row.document_id as number) ?? null,
    })));
    await insertBatched(trx, 'lead_sheet_attachments', rows);
  }

  // lead_sheet_notes — after lead_sheets, periods and chart_of_accounts.
  const lnData = tables['lead_sheet_notes'] as Array<Record<string, unknown>> | undefined;
  if (lnData && lnData.length > 0 && (await trx.schema.hasTable('lead_sheet_notes'))) {
    const rows = lnData.map((row) => sanitizeUserFks('lead_sheet_notes', remapClientId({
      ...row,
      id: undefined,
      period_id: periodIdMap.get(row.period_id as number) ?? row.period_id,
      lead_sheet_id: lsMap.get(row.lead_sheet_id as number) ?? null,
      account_id: mapOptional(coaIdMap, row.account_id),
    })));
    await insertBatched(trx, 'lead_sheet_notes', rows);
  }

  // Statement Writer — deleteClientData removed these; put the archive's back.
  await restoreFsClientTables(trx, tables, {
    clientId: targetClientId,
    period: (id) => periodIdMap.get(id),
    account: (id) => coaIdMap.get(id),
    leadSheet: (id) => lsMap.get(id),
    sanitizeUserFks,
    trustLibraryIds: trustSourceUserIds,
  });
}

interface RestoreSettingsReport {
  taxCodesUpserted: number;
  /** Legacy alpha system codes in the archive, not restored (numeric only). */
  taxCodesSkippedLegacy: number;
  taxCodeMapsUpserted: number;
  /** Software maps whose parent tax code was absent from the archive. */
  taxCodeMapsSkipped: number;
  appSettingsReplaced: boolean;
  usersCreated: string[];
  usersSkipped: string[];
  /** Statement Writer firm library rows updated or added. */
  statementLibrary?: { letterhead: boolean; letters: number; presets: number; templates: number; skipped: number };
}

interface RestoreSettingsOptions {
  /**
   * When true, settings-level restore will materialize app_users from the
   * backup (inserting new usernames, skipping existing ones). Only safe when
   * the archive originated from a known-trusted backup of this same instance.
   * Defaults to false so a malicious .tbak can't inject admin accounts.
   */
  allowUsers?: boolean;
}

async function restoreSettings(
  tables: Record<string, unknown[]>,
  trx: Knex.Transaction,
  options: RestoreSettingsOptions = {},
): Promise<RestoreSettingsReport> {
  const report: RestoreSettingsReport = {
    taxCodesUpserted: 0,
    taxCodesSkippedLegacy: 0,
    taxCodeMapsUpserted: 0,
    taxCodeMapsSkipped: 0,
    appSettingsReplaced: false,
    usersCreated: [],
    usersSkipped: [],
  };

  // Serialize settings restores so two admins can't race each other.
  await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [42, 0]);

  // Tax codes: upsert by (return_form, activity_type, tax_code).
  //
  // The archive's own `id` values are deliberately dropped. An existing code
  // keeps the id it already has — so live chart_of_accounts.tax_code_id links
  // survive the restore — and a genuinely new code gets a fresh one. Forcing the
  // backup's ids would rewrite primary keys out from under those FK references,
  // and collides outright whenever the source instance numbered its tax_codes
  // differently from the target (i.e. every cross-instance restore).
  const taxCodeIdMap = new Map<number, number>();
  const taxCodesData = tables['tax_codes'] as Array<Record<string, unknown>> | undefined;
  if (taxCodesData && taxCodesData.length > 0) {
    for (const row of taxCodesData) {
      if (isLegacyAlphaTaxCode(row)) { report.taxCodesSkippedLegacy++; continue; }
      const { id: oldId, ...values } = row as { id?: number } & Record<string, unknown>;
      const [upserted] = await trx('tax_codes')
        .insert(values)
        .onConflict(['return_form', 'activity_type', 'tax_code'])
        .merge()
        .returning('id');
      const newId = (upserted as { id: number }).id;
      if (typeof oldId === 'number') taxCodeIdMap.set(oldId, newId);
      report.taxCodesUpserted++;
    }
  }

  // Tax code software maps: upsert on the real unique key,
  // (tax_code_id, tax_software) — the column is `tax_software`, not `software`.
  // tax_code_id is rewritten through the map built above; a map whose parent
  // code isn't in the archive is skipped rather than allowed to violate the FK.
  const mapsData = tables['tax_code_software_maps'] as Array<Record<string, unknown>> | undefined;
  if (mapsData && mapsData.length > 0) {
    for (const row of mapsData) {
      const { id: _oldId, ...values } = row as { id?: number } & Record<string, unknown>;
      const newTaxCodeId = taxCodeIdMap.get(values.tax_code_id as number);
      if (newTaxCodeId === undefined) {
        report.taxCodeMapsSkipped++;
        continue;
      }
      await trx('tax_code_software_maps')
        .insert({ ...values, tax_code_id: newTaxCodeId })
        .onConflict(['tax_code_id', 'tax_software'])
        .merge();
      report.taxCodeMapsUpserted++;
    }
  }

  // App settings: delete all, re-insert
  const hasSettings = await trx.schema.hasTable('app_settings');
  if (hasSettings) {
    const settingsData = tables['app_settings'] as Array<Record<string, unknown>> | undefined;
    if (settingsData && settingsData.length > 0) {
      await trx('app_settings').delete();
      // app_settings.value is jsonb — encode before insert (see encodeJsonColumns).
      await insertBatched(trx, 'app_settings', settingsData);
      report.appSettingsReplaced = true;
    }
  }

  // Statement Writer firm library: updated in place, never deleted.
  report.statementLibrary = await restoreFsLibrary(trx, tables);

  // Users: only restored when the caller explicitly opts in. Blocks the
  // attack where an admin uploads a crafted .tbak containing an attacker's
  // password_hash for a new username — which would otherwise silently give
  // them a login.
  const usersData = tables['app_users'] as Array<Record<string, unknown>> | undefined;
  if (usersData && usersData.length > 0) {
    if (options.allowUsers) {
      for (const row of usersData) {
        const username = row.username as string;
        const existing = await trx('app_users').where('username', username).first('id');
        if (existing) {
          report.usersSkipped.push(username);
        } else {
          await trx('app_users').insert({ ...row, id: undefined });
          report.usersCreated.push(username);
        }
      }
    } else {
      // Report every username we refused to touch so the operator understands
      // why their user list didn't come back.
      for (const row of usersData) {
        report.usersSkipped.push(row.username as string);
      }
    }
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routers
// ─────────────────────────────────────────────────────────────────────────────

export const backupRouter = Router();
export const restoreRouter = Router();

backupRouter.use(authMiddleware);
restoreRouter.use(authMiddleware);

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    return false;
  }
  return true;
}

// POST /api/v1/backup/full
backupRouter.post('/full', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const record = await createBackup('full', { triggerType: 'manual' }, req.user!.userId);
    res.json({ data: record, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});

// POST /api/v1/backup/settings
backupRouter.post('/settings', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const record = await createBackup('settings', { triggerType: 'manual' }, req.user!.userId);
    res.json({ data: record, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});

// POST /api/v1/backup/client/:clientId
backupRouter.post('/client/:clientId', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const clientId = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid clientId' } });
      return;
    }
    const record = await createBackup('client', { clientId, triggerType: 'manual' }, req.user!.userId);
    res.json({ data: record, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});

// POST /api/v1/backup/period/:periodId
backupRouter.post('/period/:periodId', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const periodId = parseInt(req.params.periodId, 10);
    if (isNaN(periodId)) {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid periodId' } });
      return;
    }
    const record = await createBackup('period', { periodId, triggerType: 'manual' }, req.user!.userId);
    res.json({ data: record, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});

// GET /api/v1/backup/history
backupRouter.get('/history', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const { clientId } = req.query;
    let query = db('backup_history').select('*').orderBy('created_at', 'desc');
    if (clientId) {
      query = query.where('client_id', parseInt(clientId as string, 10));
    }
    const rows = await query;
    res.json({ data: rows, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});

// GET /api/v1/backup/:backupId/download
backupRouter.get('/:backupId/download', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const backupId = parseInt(req.params.backupId, 10);
    const record = await db('backup_history').where('id', backupId).first('*');
    if (!record) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Backup not found' } });
      return;
    }
    const filePath = record.storage_local as string;
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ data: null, error: { code: 'FILE_NOT_FOUND', message: 'Backup file not found on disk' } });
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="${record.filename as string}"`);
    res.setHeader('Content-Type', 'application/zip');
    const readStream = fs.createReadStream(filePath);
    readStream.on('error', (streamErr) => {
      console.error('[backup] download stream error:', streamErr.message);
      if (!res.headersSent) {
        sendServerError(res, streamErr, 'backup-download');
      } else {
        // Headers already flushed — just tear down the socket. No JSON payload
        // makes sense mid-stream.
        res.destroy(streamErr);
      }
    });
    readStream.pipe(res);
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});

// DELETE /api/v1/backup/:backupId
backupRouter.delete('/:backupId', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const backupId = parseInt(req.params.backupId, 10);
    const record = await db('backup_history').where('id', backupId).first('*');
    if (!record) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Backup not found' } });
      return;
    }
    const filePath = record.storage_local as string;
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    await db('backup_history').where('id', backupId).delete();
    res.json({ data: { deleted: true }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Restore routes
// ─────────────────────────────────────────────────────────────────────────────

// 500 MB ceiling for uploaded .tbak archives — bounded so an admin mis-click or
// a rogue browser upload can't fill the disk. Matches nginx client_max_body_size.
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});

// Narrow rate-limit in front of /restore/upload — 500 MB uploads are expensive,
// so bound them independently of the global bucket to 5/hour per authenticated
// admin (keyed by userId so shared-IP teams don't block each other).
const restoreUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const userId = (req as AuthRequest).user?.userId;
    return userId ? `user:${userId}` : (req.ip ?? 'unknown');
  },
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many restore uploads in the last hour. Wait before retrying.' } },
});

// POST /api/v1/restore/upload
restoreRouter.post(
  '/upload',
  (req: Request, res: Response, next: NextFunction): void => {
    if ((req as AuthRequest).user?.role !== 'admin') {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
      return;
    }
    next();
  },
  restoreUploadLimiter,
  upload.single('file'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ data: null, error: { code: 'NO_FILE', message: 'No file uploaded' } });
        return;
      }

      // Rename to .tbak
      const tbakPath = req.file.path + '.tbak';
      fs.renameSync(req.file.path, tbakPath);

      // Read manifest
      const manifest = await readManifest(tbakPath);

      // Bind this staged file to the uploading admin + a one-time nonce. /restore/execute
      // verifies both before touching the file. Ad-hoc filenames are no longer enough.
      const tempBase = path.basename(tbakPath);
      const nonce = crypto.randomBytes(24).toString('base64url');
      rememberUploadSession(tempBase, req.user!.userId, nonce);

      res.json({
        data: {
          tempFile: tempBase,
          uploadNonce: nonce,
          manifest,
        },
        error: null,
      });
    } catch (err: unknown) {
      sendServerError(res, err, 'backup');
    }
  },
);

// POST /api/v1/restore/execute
restoreRouter.post('/execute', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  // Hoisted so the catch block can flip the pre-inserted 'running' row to
  // 'failed' instead of leaking an orphan row alongside a second failure row.
  let historyId: number | null = null;
  try {
    const { backupId, tempFile, uploadNonce, mode, targetClientId, includeUsers } = req.body as {
      backupId?: number;
      tempFile?: string;
      uploadNonce?: string;
      mode: string;
      targetClientId?: number;
      includeUsers?: boolean;
    };

    let filePath: string;
    let backupRecord: BackupHistoryRow | null = null;

    if (backupId) {
      backupRecord = await db('backup_history').where('id', backupId).first('*') as BackupHistoryRow | null;
      if (!backupRecord) {
        res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Backup not found' } });
        return;
      }
      filePath = backupRecord.storage_local!;
    } else if (tempFile) {
      // Validate no path traversal
      const safeName = path.basename(tempFile);
      // Tie the temp file to the admin who uploaded it + a one-time nonce —
      // a second admin cannot execute a file staged by a different session.
      if (!consumeUploadSession(safeName, req.user!.userId, uploadNonce ?? '')) {
        res.status(403).json({
          data: null,
          error: { code: 'RESTORE_SESSION_INVALID', message: 'This upload was not made by your session, has expired, or the nonce is wrong. Re-upload the file.' },
        });
        return;
      }
      filePath = path.join(TEMP_DIR, safeName);
    } else {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'backupId or tempFile required' } });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ data: null, error: { code: 'FILE_NOT_FOUND', message: 'Backup file not found' } });
      return;
    }

    // Verify checksum for known backups (backupId path). Hash via a stream so the
    // entire .tbak (possibly hundreds of MB) is never held in memory at once.
    if (backupRecord?.checksum) {
      const actual: string = await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve('sha256:' + hash.digest('hex')));
        stream.on('error', reject);
      });
      if (actual !== backupRecord.checksum) {
        res.status(400).json({
          data: null,
          error: { code: 'CHECKSUM_MISMATCH', message: 'Backup file integrity check failed. The file may have been modified or corrupted.' },
        });
        return;
      }
    }

    const tables = await readZipContents(filePath);

    // Validate essential data structure
    if (tables.clients && !Array.isArray(tables.clients)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_BACKUP', message: 'Invalid backup data: clients must be an array.' } });
      return;
    }
    if (tables.periods && !Array.isArray(tables.periods)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_BACKUP', message: 'Invalid backup data: periods must be an array.' } });
      return;
    }
    if (tables.app_users && !Array.isArray(tables.app_users)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_BACKUP', message: 'Invalid backup data: app_users must be an array.' } });
      return;
    }
    let newClientId: number | null = null;
    let idMappings: Record<string, Record<number, number>> = {};
    let settingsReport: RestoreSettingsReport | null = null;
    let droppedLinks = 0;

    // Pre-restore backup for replace mode
    if (mode === 'replace' && targetClientId) {
      try {
        await createBackup('client', { clientId: targetClientId, triggerType: 'pre_restore' }, req.user!.userId);
      } catch (_e) {
        // Non-fatal
      }
    }

    // Insert restore_history BEFORE the data transaction so that a crash
    // between txn commit and history write doesn't lose all record of the
    // restore (admin would re-run and double-restore). We UPDATE the row
    // to 'completed' on success or 'failed' in the catch block.
    const [historyRow] = await db('restore_history').insert({
      backup_id: backupRecord?.id ?? null,
      restore_mode: mode,
      target_client_id: targetClientId ?? null,
      new_client_id: null,
      id_mappings: JSON.stringify({}),
      status: 'running',
      restored_by: req.user!.userId,
    }).returning('id');
    historyId = typeof historyRow === 'object' && historyRow !== null
      ? (historyRow as { id: number }).id
      : Number(historyRow);

    // User-attribution ids (updated_by, created_by, …) are only meaningful when
    // the archive came from this instance — same trust line as allowUsers below.
    const trustSourceUserIds = !!backupRecord;

    await db.transaction(async (trx) => {
      // audit_log.period_id cascades on delete, and the append-only trigger
      // blocks that cascade — so replace mode, which deletes the client's
      // periods, fails outright for any client that has audit history (i.e.
      // every real one). This is the escape hatch migration
      // 20260418000002_audit_log_append_only documents: SET LOCAL, so it is
      // scoped to this transaction and cannot leak into normal operation.
      await trx.raw("SET LOCAL app.audit_log_mutation_allowed = 'true'");

      if (mode === 'as_new') {
        const result = await restoreAsNew(tables, trx, trustSourceUserIds);
        newClientId = result.newClientId;
        idMappings = result.idMappings;
        droppedLinks = result.droppedLinks;
      } else if (mode === 'replace') {
        if (!targetClientId) throw new Error('targetClientId required for replace mode');
        await restoreReplace(tables, targetClientId, trx, trustSourceUserIds);
        newClientId = targetClientId;
      } else if (mode === 'settings') {
        // Only trust app_users rows when we're restoring a backup we produced
        // (looked up by backupId). Ad-hoc uploaded .tbak files never get to
        // create accounts.
        // A backup this instance produced (looked up by backupId) is trusted, so
        // its users come back automatically. An uploaded .tbak is not: it could
        // carry an attacker's password_hash under a new username and silently
        // mint them a login. For that path the admin must tick "restore user
        // accounts" explicitly — the risk is theirs to accept, but it has to be
        // a decision rather than a side effect.
        const allowUsers = !!backupRecord || includeUsers === true;
        settingsReport = await restoreSettings(tables, trx, { allowUsers });
      } else {
        throw new Error(`Unknown restore mode: ${mode}`);
      }
    });

    // Clean up the uploaded restore temp file now that we've used it. Backups
    // loaded by backupId are kept (they live in backups/ not backups/temp).
    if (tempFile) {
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // best-effort; stale temp files can be swept later
      }
    }

    // Flip the history row to completed now that the data txn committed.
    await db('restore_history').where({ id: historyId }).update({
      new_client_id: newClientId,
      id_mappings: JSON.stringify(idMappings),
      status: 'completed',
    });

    res.json({
      data: {
        success: true,
        mode,
        newClientId,
        idMappings,
        settingsReport,
        droppedLinks,
      },
      error: null,
    });
  } catch (err: unknown) {
    const internal = err instanceof Error ? err.message : 'Unknown error';
    const code = (err as { code?: string }).code;
    // If we already staged a 'running' row, flip it to 'failed' so the
    // history has exactly one terminal row per attempt. If the failure
    // happened before the pre-insert, fall back to inserting a 'failed' row
    // so the attempt is still recorded.
    try {
      if (historyId !== null) {
        await db('restore_history').where({ id: historyId }).update({
          status: 'failed',
          error_message: internal,
        });
      } else {
        await db('restore_history').insert({
          backup_id: null,
          restore_mode: (req.body as { mode?: string }).mode ?? 'unknown',
          status: 'failed',
          error_message: internal,
          restored_by: (req as AuthRequest).user?.userId ?? null,
        });
      }
    } catch (_e) { /* ignore */ }
    if (code === 'INVALID_BACKUP' || code === 'RESTORE_BROKEN_REF') {
      // These carry an operator-actionable message that we author ourselves —
      // safe to return verbatim. RESTORE_BROKEN_REF used to fall through to the
      // generic 500 below, hiding the one message that explains the failure.
      res.status((err as { status?: number }).status ?? 400).json({
        data: null,
        error: { code, message: internal, restoreHistoryId: historyId },
      });
      return;
    }
    // Anything else is an unexpected/driver-level error. Keep the generic
    // message (it can carry schema detail), but hand back the restore_history
    // id so the admin can read the real reason off the Restore History table
    // instead of being told only "try again".
    console.error('[restore] failed:', internal);
    res.status(500).json({
      data: null,
      error: {
        code: 'SERVER_ERROR',
        message: historyId !== null
          ? 'Restore failed. See the reason on this attempt in the Restore History table below.'
          : 'An internal error occurred. Please try again.',
        restoreHistoryId: historyId,
      },
    });
  }
});

// GET /api/v1/restore/history
restoreRouter.get('/history', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const rows = await db('restore_history').select('*').orderBy('restored_at', 'desc').limit(100);
    res.json({ data: rows, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled backup
// ─────────────────────────────────────────────────────────────────────────────

// How many scheduled (`trigger_type = 'scheduled'`) backups to keep on disk.
// Manual backups are NEVER pruned automatically — an admin made them, an admin
// can delete them. Without this cap, a daily full backup of a 500-client firm
// fills the Pi's SD card in a couple of months. 14 days is enough headroom to
// notice a bad week of data and still recover.
const SCHEDULED_BACKUP_RETENTION = 14;

async function pruneOldScheduledBackups(): Promise<void> {
  try {
    const stale = await db('backup_history')
      .where({ trigger_type: 'scheduled' })
      .orderBy('created_at', 'desc')
      .offset(SCHEDULED_BACKUP_RETENTION)
      .select('id', 'storage_local', 'filename');

    for (const row of stale) {
      const filePath = row.storage_local as string | null;
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr) {
          // File-system failure shouldn't kill the prune — log and move on.
          // Worst case the row stays, gets retried tomorrow.
          console.warn(
            `[backup] Could not unlink ${filePath}:`,
            unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr),
          );
          continue;
        }
      }
      await db('backup_history').where({ id: row.id }).delete();
      console.log(`[backup] Pruned old scheduled backup: ${row.filename}`);
    }
  } catch (err: unknown) {
    console.error(
      '[backup] Prune failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function startBackupScheduler(): void {
  // Run at 2:00 AM daily
  cron.schedule('0 2 * * *', async () => {
    console.log('[backup] Starting scheduled full backup...');
    try {
      const record = await createBackup('full', { triggerType: 'scheduled' }, null);
      console.log(`[backup] Scheduled backup complete: ${record.filename}`);
      // Prune AFTER the new backup lands so a transient prune failure can never
      // leave the firm with zero scheduled backups on disk.
      await pruneOldScheduledBackups();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[backup] Scheduled backup failed: ${message}`);
    }
  });
  console.log(
    `[backup] Scheduler registered (daily at 02:00, retention: ${SCHEDULED_BACKUP_RETENTION} days)`,
  );
}
