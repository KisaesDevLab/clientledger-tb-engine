// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop (Q30): one client out of a desktop full backup, as an ordinary
// client .tbak that the engine's own /restore/* takes "as new".
//
// A desktop full backup (fullBackup.ts) holds every table as the database
// returned it, and every document file as files/<storage key>. A client
// .tbak (routes/backup.ts createBackup('client')) holds a fixed selection
// of tables and, with includeFiles, each document as files/<documentId>.
// `selectClientTables` is that selection over the full backup's rows: same
// tables, same filters, same "only if the table exists" guards, in the same
// order. The shell's P03 acceptance test compares an extract with the
// engine's own client backup of the same client, table by table and row by
// row, so a table added upstream fails it instead of going missing.
//
// The client .tbak keeps the FULL backup's schema version: its rows have
// that shape, whatever this engine is.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import unzipper from 'unzipper';
import {
  FORMAT_VERSION,
  MANIFEST_PATH,
  documentFilePath,
  entryFor,
  hashArchive,
  sha256Hex,
  verifyEntries,
  type ManifestEntries,
} from '../lib/backupManifest';
import { FULL_LEVEL } from './fullBackup';

type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

export class ExtractError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_A_FULL_BACKUP' | 'BACKUP_DAMAGED' | 'CLIENT_NOT_IN_BACKUP' | 'UNSUPPORTED_VALUE',
  ) {
    super(message);
  }
}

const ids = (rows: Row[]): Set<number> => new Set(rows.map((r) => r.id as number));
const byCol = (rows: Row[] | undefined, col: string, wanted: Set<number>): Row[] =>
  (rows ?? []).filter((r) => wanted.has(r[col] as number));
const ofClient = (rows: Row[] | undefined, clientId: number): Row[] =>
  (rows ?? []).filter((r) => r.client_id === clientId);

/**
 * The client-level selection of createBackup('client'), over rows already in
 * memory. `tables` has every table of the full backup (an absent key means
 * the table did not exist in that database).
 */
export function selectClientTables(tables: Tables, clientId: number): Tables {
  const has = (t: string) => Object.prototype.hasOwnProperty.call(tables, t);
  const out: Tables = {};
  out.tax_codes = tables.tax_codes ?? [];
  out.tax_code_software_maps = tables.tax_code_software_maps ?? [];
  out.clients = (tables.clients ?? []).filter((r) => r.id === clientId);
  const periods = ofClient(tables.periods, clientId);
  out.periods = periods;
  const periodIds = ids(periods);
  const coa = ofClient(tables.chart_of_accounts, clientId);
  out.chart_of_accounts = coa;
  const coaIds = ids(coa);
  out.trial_balance = periodIds.size > 0 ? byCol(tables.trial_balance, 'period_id', periodIds) : [];
  const jes = periodIds.size > 0 ? byCol(tables.journal_entries, 'period_id', periodIds) : [];
  out.journal_entries = jes;
  const jeIds = ids(jes);
  out.journal_entry_lines = jeIds.size > 0 ? byCol(tables.journal_entry_lines, 'journal_entry_id', jeIds) : [];
  out.bank_transactions = ofClient(tables.bank_transactions, clientId);
  out.classification_rules = ofClient(tables.classification_rules, clientId);
  out.variance_notes = coaIds.size > 0 ? byCol(tables.variance_notes, 'account_id', coaIds) : [];
  out.document_imports = periodIds.size > 0 ? byCol(tables.document_imports, 'period_id', periodIds) : [];
  if (has('tickmark_library')) out.tickmark_library = ofClient(tables.tickmark_library, clientId);
  if (has('lead_sheets')) out.lead_sheets = ofClient(tables.lead_sheets, clientId);
  out.client_documents = ofClient(tables.client_documents, clientId);
  if (has('client_folder_links')) out.client_folder_links = ofClient(tables.client_folder_links, clientId);
  if (has('lead_sheet_attachments')) out.lead_sheet_attachments = ofClient(tables.lead_sheet_attachments, clientId);
  if (has('qbo_connections')) out.qbo_connections = ofClient(tables.qbo_connections, clientId);
  if (has('lead_sheet_notes')) out.lead_sheet_notes = ofClient(tables.lead_sheet_notes, clientId);
  if (has('lead_sheet_signoffs') && periodIds.size > 0) {
    out.lead_sheet_signoffs = byCol(tables.lead_sheet_signoffs, 'period_id', periodIds);
  }
  // dumpFsClientTables (lib/fs/fsBackup.ts), periodId null.
  if (has('fs_reports')) {
    const reports = ofClient(tables.fs_reports, clientId);
    const reportIds = ids(reports);
    out.fs_client_layouts = ofClient(tables.fs_client_layouts, clientId);
    out.fs_reports = reports;
    out.fs_report_versions = reportIds.size > 0 ? byCol(tables.fs_report_versions, 'report_id', reportIds) : [];
    out.fs_cash_flow_overrides = ofClient(tables.fs_cash_flow_overrides, clientId);
    out.fs_equity_roles = ofClient(tables.fs_equity_roles, clientId);
  }
  if (has('tb_tickmarks') && periodIds.size > 0) out.tb_tickmarks = byCol(tables.tb_tickmarks, 'period_id', periodIds);
  if (has('engagement_tasks') && periodIds.size > 0) {
    out.engagement_tasks = byCol(tables.engagement_tasks, 'period_id', periodIds);
  }
  if (has('m1_adjustments') && periodIds.size > 0) out.m1_adjustments = byCol(tables.m1_adjustments, 'period_id', periodIds);
  if (has('bank_reconciliations') && periodIds.size > 0) {
    const recons = byCol(tables.bank_reconciliations, 'period_id', periodIds);
    out.bank_reconciliations = recons;
    const reconIds = ids(recons);
    if (reconIds.size > 0 && has('reconciliation_items')) {
      out.reconciliation_items = byCol(tables.reconciliation_items, 'reconciliation_id', reconIds);
    }
  }
  return out;
}

/** A tagged binary value cannot go into a client archive (it would restore as JSON). */
function refuseBinary(tables: Tables): void {
  for (const [t, rows] of Object.entries(tables)) {
    for (const r of rows) {
      for (const v of Object.values(r)) {
        if (Buffer.isBuffer(v) || (v && typeof v === 'object' && !Array.isArray(v) && '$bytea' in (v as object))) {
          throw new ExtractError(`The table ${t} holds binary data a client backup cannot carry.`, 'UNSUPPORTED_VALUE');
        }
      }
    }
  }
}

/** The full-backup entry of a document's file: files/<storage key>, local storage only. */
export function fullEntryOf(doc: Row): string | null {
  const key = doc.object_key;
  if (typeof key !== 'string' || !key || (doc.storage_backend && doc.storage_backend !== 'local')) return null;
  return `files/${key.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

export interface ExtractResult {
  path: string;
  size: number;
  sha256: string;
  clientName: string | null;
  fileCount: number;
  missingFiles: number[];
}

/**
 * Write the client `clientId` of the desktop full backup `fullPath` as a
 * client .tbak at `dest` (via `dest.partial` and a rename).
 */
export async function extractClient(fullPath: string, clientId: number, dest: string, appVersion: string): Promise<ExtractResult> {
  const dir = await unzipper.Open.file(fullPath);
  const manifestFile = dir.files.find((f) => f.path === MANIFEST_PATH);
  if (!manifestFile) throw new ExtractError('This is not a backup file.', 'NOT_A_FULL_BACKUP');
  const manifest = JSON.parse((await manifestFile.buffer()).toString('utf8')) as Record<string, unknown>;
  if (manifest.backupLevel !== FULL_LEVEL) {
    throw new ExtractError('Only a full backup made by this app can have one client taken out of it.', 'NOT_A_FULL_BACKUP');
  }
  const checked = verifyEntries(manifest, await hashArchive(fullPath));
  if (!checked.ok || checked.legacy) {
    throw new ExtractError(
      'This backup file is damaged: its contents do not match the checksums recorded when it was made.',
      'BACKUP_DAMAGED',
    );
  }
  const tables: Tables = {};
  for (const f of dir.files) {
    const m = /^tables\/(.+)\.json$/.exec(f.path);
    if (m) tables[m[1]] = JSON.parse((await f.buffer()).toString('utf8')) as Row[];
  }
  const selected = selectClientTables(tables, clientId);
  const client = selected.clients[0];
  if (!client) throw new ExtractError('That client is not in this backup.', 'CLIENT_NOT_IN_BACKUP');

  const fileEntries = new Map(dir.files.map((f) => [f.path, f]));
  const clientName = (client.name as string | null) ?? null;
  const written = await writeClientArchive(
    dest,
    {
      version: '1.0',
      formatVersion: FORMAT_VERSION,
      source: 'desktop',
      appVersion,
      // The rows are the full backup's, so its schema, not this engine's.
      schemaVersion: (manifest.schemaVersion as string | null) ?? null,
      backupType: 'client',
      backupLevel: 'client',
      createdAt: new Date().toISOString(),
      createdBy: 'desktop',
      clientId,
      clientName,
      periodId: null,
      periodName: null,
    },
    selected,
    (doc) => {
      const from = fullEntryOf(doc);
      const entry = from ? fileEntries.get(from) : undefined;
      return entry ? () => entry.buffer() : null;
    },
  );
  return { path: dest, size: written.size, sha256: written.sha256, clientName, fileCount: written.fileCount, missingFiles: written.missingFiles };
}

/**
 * Write a client .tbak at `dest` (via `dest.partial` and a rename): the
 * tables, each document's file as files/<documentId> when `fileOf` has one,
 * and `manifest` completed with the counts, file list and checksums.
 */
export async function writeClientArchive(
  dest: string,
  manifest: Record<string, unknown>,
  tables: Tables,
  fileOf: (doc: Row) => (() => Promise<Buffer>) | null,
): Promise<{ size: number; sha256: string; fileCount: number; missingFiles: number[] }> {
  refuseBinary(tables);
  const recordCounts: Record<string, number> = {};
  for (const [t, rows] of Object.entries(tables)) recordCounts[t] = rows.length;
  const entries: ManifestEntries = {};
  const files: Array<{ documentId: number; path: string }> = [];
  const missingFiles: number[] = [];
  const out = { ...manifest, recordCounts, includesFiles: true, files, missingFiles, entries, checksum: '' };

  const partial = `${dest}.partial`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(partial);
      const zip = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      zip.on('error', reject);
      zip.pipe(output);
      const build = async () => {
        for (const [t, rows] of Object.entries(tables)) {
          const name = `tables/${t}.json`;
          const text = JSON.stringify(rows, null, 2);
          entries[name] = entryFor(text);
          zip.append(text, { name });
        }
        for (const doc of tables.client_documents ?? []) {
          const read = fileOf(doc);
          if (!read) {
            missingFiles.push(doc.id as number);
            continue;
          }
          const body = await read();
          const name = documentFilePath(doc.id as number);
          entries[name] = { sha256: sha256Hex(body), size: body.length };
          files.push({ documentId: doc.id as number, path: name });
          zip.append(body, { name });
        }
        zip.append(JSON.stringify(out, null, 2), { name: MANIFEST_PATH });
        await zip.finalize();
      };
      build().catch(reject);
    });
    const hash = crypto.createHash('sha256');
    for await (const c of fs.createReadStream(partial)) hash.update(c as Buffer);
    const size = fs.statSync(partial).size;
    fs.renameSync(partial, dest);
    return { size, sha256: hash.digest('hex'), fileCount: files.length, missingFiles };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}
