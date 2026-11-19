// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.
/**
 * Desktop sync S4: a desktop sends a period back. The archive (the server's
 * own period `.tbak` format, written by the desktop) replaces the period's
 * SQ4 data in ONE transaction, under the client's restore lock.
 *
 * What it is matched by (SQ1): accounts by `sync_uid`, then number; lead
 * sheets by code; tickmarks by symbol; tax codes by the restore resolver;
 * statement layouts by `sync_uid`; bank transactions by `sync_uid`; the
 * period's own rows by period. Ids are remapped by the period stamp's
 * reference table (`stampRefs`), so the stamp and the merge agree.
 *
 * Rows other rows point at are updated in place, not deleted and re-made:
 * bank transactions (a later period's reconciliation item may clear one),
 * Statement Writer versions (their issued PDFs are in no archive). Journal
 * entries are replaced, and what pointed at one from outside the period is
 * linked again by entry type + number.
 *
 * Client-level changes follow SQ3 (owner 2026-11-19): a new account, lead
 * sheet, tickmark or layout is added; a change to an existing account or
 * layout is applied only when the server's row has not changed since the
 * pull, otherwise the server's stays and the difference is listed. Nothing
 * client-level is deleted.
 *
 * Accepted only when, inside the transaction, the server period's stamp
 * after the merge equals the stamp of the archive's own rows, and every
 * other period's stamp is unchanged; otherwise everything rolls back.
 *
 * The archive is untrusted: only the SQ4 and lookup tables are read, its
 * client and period ids are never used, and a row of any other period
 * refuses the send-back.
 */
import fs from 'fs';
import type { Knex } from 'knex';
import unzipper from 'unzipper';
import { db } from '../../db';
import {
  USER_FK_COLUMNS, encodeJsonColumns, entryBuffer, insertBatched, makeTaxCodeResolver, makeUserFkSanitizer, readManifest, readZipContents,
} from '../../routes/backup';
import { BackupRefusal, appliedMigrations, checkArchive, documentFilePath, syncManifestProblem } from '../backupManifest';
import { remapFsLayoutIds } from '../fs/fsLayoutRemap';
import { deleteDocument, storeDocument, workpaperSection, type DocumentRow } from '../documentStore';
import { checkedOutBy, logAudit } from '../periodGuard';
import { currentStampFor } from '../leadSheetStamp';
import { STAMP_TABLES, periodStamp, stampRefs, type PeriodStampInput, type RefKind, type StampTable } from './periodStamp';
import { loadPeriodStampInput } from './periodStampLoad';
import { SyncJobError } from './jobs';

type Row = Record<string, unknown>;

export interface MergeTarget {
  periodId: number;
  clientId: number;
  deviceId: number;
  deviceName: string;
  userId: number;
  /** The live check-out the device sends back under, or null (SQ2 off / released). */
  checkoutId: number | null;
  /** A period new to the server (S4 step 5): nothing to compare with the pull. */
  fresh?: boolean;
  /**
   * What the server recorded when this device pulled (inside the pull's own
   * snapshot): the client-level rows as they were. Null when there is none.
   */
  baseline: PullBaseline | null;
}

/**
 * The client-level rows a pull handed out, recorded by the server in the
 * pull's snapshot (never taken from the archive): SQ3 asks whether the
 * server's row is still as it was then, and a row the archive has that the
 * server no longer has was deleted on the server (not added on the desktop).
 */
export interface PullBaseline {
  /** account sync_uid → updated_at (ISO). */
  accounts: Record<string, string>;
  /** layout sync_uid → updated_at (ISO). */
  layouts: Record<string, string>;
  /** `code:X`, or `name:Y` for a lead sheet without a code. */
  leadSheets: string[];
  /** tickmark symbols. */
  tickmarks: string[];
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const leadSheetKey = (r: Row): string => (r.code ? `code:${String(r.code)}` : `name:${String(r.name)}`);

/** The baseline of a client, read inside a pull's snapshot. */
export async function readBaseline(q: Knex | Knex.Transaction, clientId: number): Promise<PullBaseline> {
  const accounts = (await q('chart_of_accounts').where({ client_id: clientId }).select('sync_uid', 'updated_at')) as Row[];
  const layouts = (await q('fs_client_layouts').where({ client_id: clientId }).select('sync_uid', 'updated_at')) as Row[];
  const sheets = (await q('lead_sheets').where({ client_id: clientId }).select('code', 'name')) as Row[];
  const marks = (await q('tickmark_library').where({ client_id: clientId }).pluck('symbol')) as string[];
  return {
    accounts: Object.fromEntries(accounts.map((a) => [String(a.sync_uid), iso(a.updated_at) ?? ''])),
    layouts: Object.fromEntries(layouts.map((l) => [String(l.sync_uid), iso(l.updated_at) ?? ''])),
    leadSheets: sheets.map(leadSheetKey),
    tickmarks: marks.map(String),
  };
}

/** A database refusal (a constraint) as a send-back refusal: not "try again". */
export function asSyncError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string; table?: string } | null;
  if (e && typeof e.code === 'string' && ['23505', '23503', '23502', '23514'].includes(e.code)) {
    return new SyncJobError('SYNC_ARCHIVE_CONFLICT', `The archive conflicts with data on the server (${e.table ?? 'a table'}: ${e.constraint ?? e.code}), so nothing was changed. Correct it on the desktop and send it again.`);
  }
  return err;
}

export interface MergeResult {
  stamp: string;
  stampBefore: string | null;
  totalsBefore: Totals;
  totalsAfter: Totals;
  counts: Record<string, number>;
  accountsAdded: string[];
  leadSheetsAdded: string[];
  tickmarksAdded: string[];
  layoutsAdded: string[];
  /** SQ3: client-level changes not applied because the server's row changed since the pull. */
  differences: Array<{ kind: 'account' | 'layout'; key: string; field: string; server: unknown; desktop: unknown }>;
}

interface Totals {
  bookDebit: string;
  bookCredit: string;
}

/** Tables read from the archive; anything else in it is ignored. */
const LOOKUP_TABLES = ['clients', 'periods', 'chart_of_accounts', 'lead_sheets', 'tickmark_library', 'tax_codes', 'client_documents', 'fs_client_layouts'];
/** Period tables replaced as a whole: nothing outside the period points at their rows. */
const REPLACED: StampTable[] = ['trial_balance', 'variance_notes', 'tb_tickmarks', 'm1_adjustments', 'engagement_tasks', 'lead_sheet_notes', 'py_comparison_data'];
/** The columns of an issued Statement Writer version that may change after it is issued. */
const VERSION_MUTABLE = new Set(['report_id', 'status', 'superseded_at', 'reopened_by', 'reopened_at']);
/** One attachment file at most (as an upload on the web), and all of them together. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL = 1024 * 1024 * 1024;

/** Columns never copied from an archive row. */
const NEVER = new Set(['id', 'client_id', 'period_id']);
/** Columns an SQ3 comparison leaves out. */
const NOT_COMPARED = new Set(['id', 'client_id', 'sync_uid', 'created_at', 'updated_at', 'created_by', 'updated_by']);

const fail = (code: string, message: string): SyncJobError => new SyncJobError(code, message);
const rowsOf = (tables: Record<string, unknown[]>, t: string): Row[] => ((tables[t] ?? []) as Row[]);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

async function totals(q: Knex | Knex.Transaction, periodId: number): Promise<Totals> {
  const r = await q('v_adjusted_trial_balance').where({ period_id: periodId })
    .sum({ d: 'book_adjusted_debit', c: 'book_adjusted_credit' }).first();
  return { bookDebit: String(r?.d ?? 0), bookCredit: String(r?.c ?? 0) };
}

async function columnsOf(trx: Knex.Transaction, table: string): Promise<Set<string>> {
  return new Set(Object.keys(await trx(table).columnInfo()));
}

/** The archive row as a row of this server's table: known columns only, ids dropped. */
function pick(row: Row, cols: Set<string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (cols.has(k) && !NEVER.has(k)) out[k] = v;
  return out;
}

/** JSON with sorted keys: a layout written by the desktop compares equal regardless of key order. */
function canon(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Row;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

/** Reads and checks everything that can be checked before touching the database. */
export async function readSendBack(
  filePath: string,
  expect: { periodUid: string | null; clientUid: string; checkoutId: number | null },
): Promise<{ tables: Record<string, unknown[]>; manifest: Row; files: Map<number, Buffer> }> {
  let manifest: Row;
  try {
    manifest = await readManifest(filePath);
  } catch {
    throw fail('SYNC_ARCHIVE_INVALID', 'The file sent is not a Vibe Trial Balance period archive.');
  }
  const problem = syncManifestProblem(manifest);
  if (problem) throw fail('SYNC_ARCHIVE_INVALID', problem);
  // Every entry's checksum, as a restore checks them.
  try {
    await checkArchive(filePath, manifest, db);
  } catch (err: unknown) {
    if (err instanceof BackupRefusal) throw fail(err.code === 'BACKUP_DAMAGED' ? 'SYNC_ARCHIVE_DAMAGED' : 'SYNC_SCHEMA_MISMATCH', err.message);
    throw err;
  }
  const applied = await appliedMigrations(db);
  if (manifest.schemaVersion !== applied[applied.length - 1]) {
    throw fail('SYNC_SCHEMA_MISMATCH', 'This archive was made for a different version of the server. Update the desktop (or the server) so both match, then send it again.');
  }
  if (manifest.backupLevel !== 'period' || typeof manifest.periodId !== 'number') {
    throw fail('SYNC_ARCHIVE_INVALID', 'The file sent is not a period archive.');
  }
  const sync = (manifest.sync ?? {}) as Row;
  if ((expect.periodUid !== null && sync.periodUid !== expect.periodUid) || sync.clientUid !== expect.clientUid || typeof sync.periodUid !== 'string') {
    throw fail('SYNC_WRONG_PERIOD', 'This archive is of another period or client than the one it was sent to.');
  }
  if (expect.checkoutId !== null && num(sync.checkoutId) !== expect.checkoutId) {
    throw fail('SYNC_WRONG_CHECKOUT', 'This archive was not made under the check-out it was sent with.');
  }
  const all = await readZipContents(filePath, 5000);
  const tables: Record<string, unknown[]> = {};
  for (const t of [...LOOKUP_TABLES, ...STAMP_TABLES]) if (Array.isArray(all[t])) tables[t] = all[t] as unknown[];

  // Every period row belongs to the archive's own period.
  const own = manifest.periodId as number;
  for (const t of STAMP_TABLES) {
    if (t === 'bank_transactions') continue; // references may be other periods' (checked below)
    for (const r of rowsOf(tables, t)) {
      if ('period_id' in r && num(r.period_id) !== own) {
        throw fail('SYNC_ARCHIVE_INVALID', `The archive's ${t} holds rows of another period.`);
      }
    }
  }

  // The bytes of the documents behind attachments.
  const files = new Map<number, Buffer>();
  const docIds = new Set(rowsOf(tables, 'lead_sheet_attachments').map((a) => num(a.document_id)).filter((n): n is number => n !== null));
  if (docIds.size > 0) {
    const dir = await unzipper.Open.file(filePath);
    let filesTotal = 0;
    for (const id of docIds) {
      const entry = dir.files.find((f) => f.path === documentFilePath(id));
      if (!entry) continue;
      // Capped as the web caps an attachment (security review: no zip bomb).
      const bytes = await entryBuffer(entry, MAX_ATTACHMENT_BYTES).catch(() => {
        throw fail('SYNC_ARCHIVE_INVALID', `An attachment file in the archive is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`);
      });
      files.set(id, bytes);
      filesTotal += bytes.length;
      if (filesTotal > MAX_ATTACHMENTS_TOTAL) throw fail('SYNC_ARCHIVE_INVALID', 'The attachment files in the archive are too large together.');
    }
  }
  return { tables, manifest, files };
}

/** The stamp of the archive's own rows (`periodStamp` is pure). */
export function archiveStamp(tables: Record<string, unknown[]>, ownPeriodId: number, accountUid?: Map<number, string>): string {
  return periodStamp(archiveStampInput(tables, ownPeriodId, accountUid));
}

/**
 * `accountUid`: archive account id → the uid of the server account it was
 * matched to (an account matched by NUMBER keeps the server's uid, so the
 * archive is stamped with it).
 */
function archiveStampInput(tables: Record<string, unknown[]>, ownPeriodId: number, accountUid?: Map<number, string>): PeriodStampInput {
  return {
    accounts: rowsOf(tables, 'chart_of_accounts').map((r) => ({ id: Number(r.id), sync_uid: accountUid?.get(Number(r.id)) ?? String(r.sync_uid) })),
    periods: rowsOf(tables, 'periods').map((r) => ({ id: Number(r.id), sync_uid: String(r.sync_uid) })),
    leadSheets: rowsOf(tables, 'lead_sheets').map((r) => ({ id: Number(r.id), code: (r.code as string | null) ?? null })),
    tickmarks: rowsOf(tables, 'tickmark_library').map((r) => ({ id: Number(r.id), symbol: String(r.symbol) })),
    documents: rowsOf(tables, 'client_documents').map((r) => ({ id: Number(r.id), sha256: (r.sha256 as string | null) ?? null })),
    bankTransactions: rowsOf(tables, 'bank_transactions').map((r) => ({ id: Number(r.id), sync_uid: String(r.sync_uid) })),
    fsLayouts: rowsOf(tables, 'fs_client_layouts'),
    // The period's own rows: the bank transactions an archive carries as
    // references (an earlier period's, a reconciliation clears) are lookups only.
    rows: Object.fromEntries(STAMP_TABLES.map((t) => [t, t === 'bank_transactions'
      ? rowsOf(tables, t).filter((r) => num(r.period_id) === ownPeriodId)
      : rowsOf(tables, t)])),
  };
}

/** The tables whose rows differ between two stamp inputs (names only: for the log). */
function differingTables(a: PeriodStampInput, b: PeriodStampInput): string[] {
  const one = (i: PeriodStampInput, t: StampTable) => periodStamp({ ...i, rows: { [t]: i.rows[t] ?? [] } });
  return STAMP_TABLES.filter((t) => one(a, t) !== one(b, t));
}

/**
 * Stages attachment files before the transaction (storage writes cannot be
 * rolled back): a new or changed file is stored as a NEW document. Returns
 * archive document id → stored document id, and the documents made, which
 * the caller removes if the merge fails.
 */
export async function stageAttachmentFiles(
  tables: Record<string, unknown[]>,
  files: Map<number, Buffer>,
  target: MergeTarget,
): Promise<{ docMap: Map<number, number>; created: DocumentRow[] }> {
  const docMap = new Map<number, number>();
  const created: DocumentRow[] = [];
  const archiveDocs = new Map(rowsOf(tables, 'client_documents').map((d) => [Number(d.id), d]));
  const serverAtts = (await db('lead_sheet_attachments as a').leftJoin('client_documents as d', 'd.id', 'a.document_id')
    .where('a.period_id', target.periodId).select('a.ref_code', 'a.document_id', 'd.sha256')) as Array<{ ref_code: string; document_id: number | null; sha256: string | null }>;
  const byRef = new Map(serverAtts.map((a) => [a.ref_code, a]));
  const section = await workpaperSection();
  try {
    for (const att of rowsOf(tables, 'lead_sheet_attachments')) {
      const docId = num(att.document_id);
      if (docId === null) continue;
      const doc = archiveDocs.get(docId);
      const here = byRef.get(String(att.ref_code));
      if (here?.document_id && doc && here.sha256 && here.sha256 === doc.sha256) {
        docMap.set(docId, here.document_id);
        continue;
      }
      const bytes = files.get(docId);
      // A removed attachment's file may be gone: it keeps no document then.
      if (!bytes && att.deleted_at) continue;
      if (!bytes) throw fail('SYNC_ARCHIVE_INVALID', `The archive lacks the file of attachment ${String(att.ref_code)}.`);
      // Every attachment is a PDF (the web converts images on upload).
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw fail('SYNC_ARCHIVE_INVALID', `The file of attachment ${String(att.ref_code)} is not a PDF.`);
      const stored = await storeDocument({
        clientId: target.clientId,
        periodId: target.periodId,
        section,
        subfolder: 'Lead Sheets',
        filename: `${String(att.ref_code)}.pdf`,
        mimeType: 'application/pdf',
        buffer: bytes,
        uploadedBy: target.userId,
      });
      created.push(stored as unknown as DocumentRow);
      docMap.set(docId, Number((stored as { id: number }).id));
    }
  } catch (err: unknown) {
    await removeDocuments(created);
    const e = err as { code?: string; message?: string };
    if (e?.code === 'CLIENT_NOT_LINKED' || e?.code === 'NOT_LINKED') {
      throw fail('CLIENT_NOT_LINKED', 'This client has no workpaper folder linked on the server, so its attachments cannot be stored. An admin links one in Settings › Storage; then send it again.');
    }
    throw err;
  }
  return { docMap, created };
}

export async function removeDocuments(docs: DocumentRow[]): Promise<void> {
  for (const d of docs) await deleteDocument(d).catch(() => undefined);
}

/** The merge itself: one transaction. Throws SyncJobError on a refusal. */
export async function mergePeriod(
  trx: Knex.Transaction,
  target: MergeTarget,
  tables: Record<string, unknown[]>,
  manifest: Row,
  docMap: Map<number, number>,
): Promise<{ result: MergeResult; replacedDocs: number[] }> {
  const P = target.periodId;
  const C = target.clientId;
  const ownOld = manifest.periodId as number;
  await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [42, C]);
  const period = await trx('periods').where({ id: P }).forUpdate().first('id', 'locked_at', 'is_reference');
  if (!period || period.is_reference) throw fail('NOT_FOUND', 'No such period on the server.');
  if (period.locked_at) throw fail('PERIOD_LOCKED', 'The period is locked on the server. An admin unlocks it, then send it again.');

  // The hold, and the stamp the desktop started from.
  const holder = await checkedOutBy(trx, P);
  let stampAtPull: string | null;
  if (target.checkoutId !== null) {
    if (!holder || holder.id !== target.checkoutId || holder.deviceId !== target.deviceId) {
      throw fail('SYNC_NOT_HELD', 'This computer no longer holds the period (it was released). Pull it again to carry on.');
    }
    const co = await trx('period_checkouts').where({ id: target.checkoutId }).first('stamp_at_pull');
    stampAtPull = (co.stamp_at_pull as string | null) ?? null;
  } else if (target.fresh) {
    stampAtPull = null;
  } else {
    if (holder) throw fail('PERIOD_CHECKED_OUT', `The period is checked out to ${holder.user} on "${holder.device}".`);
    const sync = (manifest.sync ?? {}) as Row;
    stampAtPull = typeof sync.stampAtPull === 'string' ? sync.stampAtPull : null;
    if (!stampAtPull) throw fail('PERIOD_CHANGED', 'Without a check-out, the archive must say which version of the period it started from (sync.stampAtPull).');
  }
  const baseline = target.baseline;
  // SQ3: the server's row is as the pull handed it out (no baseline: treated as changed).
  const unchangedSincePull = (kind: 'accounts' | 'layouts', uid: unknown, updatedAt: unknown): boolean =>
    !!baseline && baseline[kind][String(uid)] !== undefined && baseline[kind][String(uid)] === iso(updatedAt);
  // A missed guard, or a send-back after a release and a server edit, becomes a refusal.
  const stampBefore = await stampOf(trx, P);
  if (stampAtPull !== null && stampBefore !== stampAtPull) {
    throw fail('PERIOD_CHANGED', 'The period changed on the server since it was pulled, so sending it back would lose that change. Pull it again and redo the work there.');
  }

  const otherPeriods = (await trx('periods').where({ client_id: C, is_reference: false }).whereNot({ id: P }).pluck('id')) as number[];
  const othersBefore = new Map<number, string | null>();
  for (const id of otherPeriods) othersBefore.set(id, await stampOf(trx, id));
  const totalsBefore = await totals(trx, P);
  const sanitize = await makeUserFkSanitizer(trx, true);
  // jsonb columns go in as JSON text (knex would write a JS array as a
  // Postgres array literal).
  const enc = async (table: string, row: Row): Promise<Row> => (await encodeJsonColumns(trx, table, [row]))[0]!;
  const resolveTaxCode = await makeTaxCodeResolver(trx, tables);
  const result: MergeResult = {
    stamp: '', stampBefore, totalsBefore, totalsAfter: totalsBefore, counts: {},
    accountsAdded: [], leadSheetsAdded: [], tickmarksAdded: [], layoutsAdded: [], differences: [],
  };
  const maps: Record<RefKind, Map<number, number>> = {
    account: new Map(), period: new Map(), journal: new Map(), leadSheet: new Map(), tickmark: new Map(),
    document: docMap, bankTxn: new Map(), recon: new Map(), fsReport: new Map(), fsLayout: new Map(),
  };
  // Rows the archive has that the server deleted since the pull: not added back.
  const deletedOnServer: Record<RefKind, Set<number>> = {
    account: new Set(), period: new Set(), journal: new Set(), leadSheet: new Set(), tickmark: new Set(),
    document: new Set(), bankTxn: new Set(), recon: new Set(), fsReport: new Set(), fsLayout: new Set(),
  };
  const mapRef = (kind: RefKind, v: unknown, table: string, col: string): number | null => {
    const old = num(v);
    if (old === null) return null;
    const to = maps[kind].get(old);
    if (to === undefined && deletedOnServer[kind].has(old)) {
      throw fail('SYNC_DELETED_ON_SERVER', `The period uses a ${kind === 'leadSheet' ? 'lead sheet' : kind === 'fsLayout' ? 'statement layout' : kind} that was deleted on the server since the pull. Pull the period again.`);
    }
    if (to === undefined) throw fail('SYNC_ARCHIVE_INVALID', `The archive's ${table}.${col} names a row it does not carry.`);
    return to;
  };

  // ── Who did what (security review): a user id from the desktop stays only
  // when it is the sender's, or already appears in that column of this period
  // on the server (a row the pull handed out); any other is blanked, with the
  // name that goes with it. The archive rows are changed in place, so the
  // stamp of the archive is the stamp of what is written. Sign-offs and
  // issued statements have stricter rules below.
  const pusher = await trx('app_users').where({ id: target.userId }).first('id', 'display_name', 'username');
  const pusherName = String(pusher?.display_name ?? pusher?.username ?? '');
  const NAME_OF: Record<string, Record<string, string>> = {
    lead_sheet_notes: { author_id: 'author_name', resolved_by: 'resolved_by_name' },
  };
  const allowedCache = new Map<string, Set<number>>();
  const allowed = async (table: string, col: string): Promise<Set<number>> => {
    const k = `${table}.${col}`;
    if (!allowedCache.has(k)) {
      const cols = await columnsOf(trx, table);
      const vals = cols.has('period_id') && cols.has(col) ? ((await trx(table).where({ period_id: P }).whereNotNull(col).distinct().pluck(col)) as number[]) : [];
      allowedCache.set(k, new Set(vals.map(Number)));
    }
    return allowedCache.get(k)!;
  };
  for (const t of [...REPLACED.filter((x) => x !== 'lead_sheet_signoffs'), 'journal_entries', 'bank_transactions', 'bank_reconciliations', 'lead_sheet_attachments', 'fs_reports']) {
    const cols = USER_FK_COLUMNS[t] ?? [];
    for (const r of rowsOf(tables, t)) {
      for (const col of cols) {
        const v = num(r[col]);
        if (v === null) continue;
        const name = NAME_OF[t]?.[col];
        if (v === target.userId) {
          if (name) r[name] = pusherName;
        } else if (!(await allowed(t, col)).has(v)) {
          r[col] = null;
          if (name) r[name] = null;
        }
      }
    }
  }
  const remapRow = (table: StampTable, row: Row): Row => {
    const out = { ...row };
    for (const [col, kind] of Object.entries(stampRefs(table))) if (col in out) out[col] = mapRef(kind, out[col], table, col);
    return out;
  };

  // ── Periods: the own one, and references by uid.
  for (const p of rowsOf(tables, 'periods')) {
    const old = Number(p.id);
    if (old === ownOld) { maps.period.set(old, P); continue; }
    const here = await trx('periods').where({ client_id: C, sync_uid: p.sync_uid }).first('id');
    if (here) { maps.period.set(old, Number(here.id)); continue; }
    if (await trx('periods').where({ sync_uid: p.sync_uid }).first('id')) {
      throw fail('SYNC_UID_EXISTS', 'A period the archive refers to belongs to another client on the server.');
    }
    const cols = await columnsOf(trx, 'periods');
    const [ins] = await trx('periods').insert(await enc('periods', { ...sanitize('periods', pick(p, cols)), client_id: C, is_reference: true, is_current: false, locked_at: null, rolled_forward_from: null })).returning('id');
    maps.period.set(old, Number((ins as { id: number }).id));
  }

  // ── Lead sheets by code, tickmarks by symbol: matched, or added.
  for (const ls of rowsOf(tables, 'lead_sheets')) {
    // By code; a lead sheet without one, by name (else it would be added again on every send-back).
    const here = ls.code
      ? await trx('lead_sheets').where({ client_id: C, code: ls.code }).first('id')
      : await trx('lead_sheets').where({ client_id: C, name: ls.name }).whereNull('code').first('id');
    if (here) { maps.leadSheet.set(Number(ls.id), Number(here.id)); continue; }
    if (baseline?.leadSheets.includes(leadSheetKey(ls))) { deletedOnServer.leadSheet.add(Number(ls.id)); continue; }
    const cols = await columnsOf(trx, 'lead_sheets');
    const [ins] = await trx('lead_sheets').insert(await enc('lead_sheets', { ...sanitize('lead_sheets', pick(ls, cols)), client_id: C })).returning('id');
    maps.leadSheet.set(Number(ls.id), Number((ins as { id: number }).id));
    result.leadSheetsAdded.push(String(ls.code ?? ls.name));
  }
  for (const tm of rowsOf(tables, 'tickmark_library')) {
    const here = await trx('tickmark_library').where({ client_id: C, symbol: tm.symbol }).first('id');
    if (here) { maps.tickmark.set(Number(tm.id), Number(here.id)); continue; }
    if (baseline?.tickmarks.includes(String(tm.symbol))) { deletedOnServer.tickmark.add(Number(tm.id)); continue; }
    const cols = await columnsOf(trx, 'tickmark_library');
    const [ins] = await trx('tickmark_library').insert(await enc('tickmark_library', { ...sanitize('tickmark_library', pick(tm, cols)), client_id: C })).returning('id');
    maps.tickmark.set(Number(tm.id), Number((ins as { id: number }).id));
    result.tickmarksAdded.push(String(tm.symbol));
  }

  // ── Chart (SQ3).
  const coaCols = await columnsOf(trx, 'chart_of_accounts');
  const fixAccount = (r: Row): Row => {
    const out = sanitize('chart_of_accounts', pick(r, coaCols));
    if ('tax_code_id' in out) out.tax_code_id = resolveTaxCode(out.tax_code_id);
    if ('lead_sheet_id' in out) out.lead_sheet_id = out.lead_sheet_id == null ? null : maps.leadSheet.get(Number(out.lead_sheet_id)) ?? null;
    delete out.sync_uid;
    return out;
  };
  const accountUid = new Map<number, string>();
  for (const a of rowsOf(tables, 'chart_of_accounts')) {
    const here = (await trx('chart_of_accounts').where({ client_id: C, sync_uid: a.sync_uid }).first())
      ?? (await trx('chart_of_accounts').where({ client_id: C, account_number: a.account_number }).first());
    if (!here && baseline && baseline.accounts[String(a.sync_uid)] !== undefined) {
      // Handed out by the pull, gone from the server now: deleted there, not added back.
      deletedOnServer.account.add(Number(a.id));
      continue;
    }
    const want = fixAccount(a);
    if (!here) {
      const uidFree = !(await trx('chart_of_accounts').where({ sync_uid: a.sync_uid }).first('id'));
      const [ins] = await trx('chart_of_accounts').insert(await enc('chart_of_accounts', { ...want, client_id: C, ...(uidFree ? { sync_uid: a.sync_uid } : {}) })).returning(['id', 'sync_uid']);
      maps.account.set(Number(a.id), Number((ins as { id: number }).id));
      accountUid.set(Number(a.id), String((ins as { sync_uid: string }).sync_uid));
      result.accountsAdded.push(String(a.account_number));
      continue;
    }
    maps.account.set(Number(a.id), Number(here.id));
    accountUid.set(Number(a.id), String(here.sync_uid));
    const changes: Row = {};
    for (const [k, v] of Object.entries(want)) {
      if (NOT_COMPARED.has(k) || same(here[k], v)) continue;
      changes[k] = v;
    }
    if (Object.keys(changes).length === 0) continue;
    if (unchangedSincePull('accounts', here.sync_uid, here.updated_at)) {
      await trx('chart_of_accounts').where({ id: here.id }).update(await enc('chart_of_accounts', changes));
    } else {
      for (const [field, desktop] of Object.entries(changes)) {
        result.differences.push({ kind: 'account', key: String(here.account_number), field, server: here[field], desktop });
      }
    }
  }

  // ── Statement layouts by uid (SQ3).
  const layoutCols = await columnsOf(trx, 'fs_client_layouts');
  const idMaps = { account: (id: number) => maps.account.get(id), leadSheet: (id: number) => maps.leadSheet.get(id) };
  for (const l of rowsOf(tables, 'fs_client_layouts')) {
    const want = sanitize('fs_client_layouts', pick(l, layoutCols));
    delete want.sync_uid;
    want.layout_json = remapFsLayoutIds(want.layout_json, idMaps);
    delete want.source_template_id;
    delete want.source_style_preset_id;
    const here = await trx('fs_client_layouts').where({ client_id: C, sync_uid: l.sync_uid }).first();
    if (!here && baseline && baseline.layouts[String(l.sync_uid)] !== undefined) {
      deletedOnServer.fsLayout.add(Number(l.id));
      continue;
    }
    if (!here && (await trx('fs_client_layouts').where({ sync_uid: l.sync_uid }).first('id'))) {
      throw fail('SYNC_UID_EXISTS', 'A statement layout in the archive belongs to another client on the server.');
    }
    if (!here) {
      const [ins] = await trx('fs_client_layouts').insert(await enc('fs_client_layouts', { ...want, client_id: C, sync_uid: l.sync_uid })).returning('id');
      maps.fsLayout.set(Number(l.id), Number((ins as { id: number }).id));
      result.layoutsAdded.push(String(l.name));
      continue;
    }
    maps.fsLayout.set(Number(l.id), Number(here.id));
    const changes: Row = {};
    for (const k of ['name', 'layout_json', 'style_json', 'archived_at']) {
      if (k in want && !same(here[k], want[k])) changes[k] = want[k];
    }
    if (Object.keys(changes).length === 0) continue;
    if (unchangedSincePull('layouts', here.sync_uid, here.updated_at)) {
      await trx('fs_client_layouts').where({ id: here.id }).update({ ...(await enc('fs_client_layouts', changes)), updated_at: trx.fn.now() });
    } else {
      for (const field of Object.keys(changes)) result.differences.push({ kind: 'layout', key: String(here.name), field, server: here[field], desktop: want[field] });
    }
  }

  // ── Journal entries: what points at the period's entries from outside is linked again by type + number.
  const oldJes = (await trx('journal_entries').where({ period_id: P }).select('id', 'entry_type', 'entry_number')) as Array<{ id: number; entry_type: string; entry_number: number }>;
  // Lines the server has now, as entry type#number|account: older data may
  // have entries on accounts without a trial balance row, taken as they are.
  const serverLines = new Set(((await trx('journal_entry_lines as l').join('journal_entries as j', 'j.id', 'l.journal_entry_id')
    .where('j.period_id', P).select('j.entry_type', 'j.entry_number', 'l.account_id')) as Array<{ entry_type: string; entry_number: number; account_id: number }>)
    .map((r) => `${r.entry_type}#${r.entry_number}|${r.account_id}`));
  const keyOfJe = new Map(oldJes.map((j) => [j.id, `${j.entry_type}#${j.entry_number}`]));
  const oldJeIds = oldJes.map((j) => j.id);
  const docLinks = oldJeIds.length ? (await trx('client_documents').whereIn('linked_journal_entry_id', oldJeIds).select('id', 'linked_journal_entry_id')) as Array<{ id: number; linked_journal_entry_id: number }> : [];
  const btLinks = oldJeIds.length ? (await trx('bank_transactions').whereIn('journal_entry_id', oldJeIds).where((w) => w.whereNull('period_id').orWhereNot('period_id', P)).select('id', 'journal_entry_id')) as Array<{ id: number; journal_entry_id: number }> : [];
  if (oldJeIds.length) {
    await trx('bank_transactions').whereIn('journal_entry_id', oldJeIds).update({ journal_entry_id: null });
    await trx('journal_entries').whereIn('id', oldJeIds).delete();
  }
  const jeCols = await columnsOf(trx, 'journal_entries');
  const newKeyToId = new Map<string, number>();
  for (const je of rowsOf(tables, 'journal_entries')) {
    const [ins] = await trx('journal_entries').insert(await enc('journal_entries', { ...sanitize('journal_entries', pick(je, jeCols)), period_id: P, ...(jeCols.has('client_id') ? { client_id: C } : {}) })).returning('id');
    const id = Number((ins as { id: number }).id);
    maps.journal.set(Number(je.id), id);
    newKeyToId.set(`${je.entry_type}#${je.entry_number}`, id);
  }
  // The adjusted trial balance counts an entry only on an account with a trial
  // balance row (the web makes one, ensureTrialBalanceRows): a NEW line on an
  // account with no row in the archive is refused (both sides would leave it
  // out of the totals, so they would still tie).
  const tbAccounts = new Set(rowsOf(tables, 'trial_balance').map((r) => Number(r.account_id)));
  const jeKeyOld = new Map(rowsOf(tables, 'journal_entries').map((j) => [Number(j.id), `${j.entry_type}#${j.entry_number}`]));
  for (const l of rowsOf(tables, 'journal_entry_lines')) {
    const old = Number(l.account_id);
    if (tbAccounts.has(old)) continue;
    const pair = `${jeKeyOld.get(Number(l.journal_entry_id))}|${maps.account.get(old)}`;
    if (!serverLines.has(pair)) throw fail('SYNC_ARCHIVE_INVALID', 'A journal entry line names an account with no trial balance row in the archive.');
  }
  const jelCols = await columnsOf(trx, 'journal_entry_lines');
  await insertBatched(trx, 'journal_entry_lines', rowsOf(tables, 'journal_entry_lines').map((l) => pick(remapRow('journal_entry_lines', l), jelCols)));
  for (const d of docLinks) {
    const to = newKeyToId.get(keyOfJe.get(d.linked_journal_entry_id) ?? '');
    await trx('client_documents').where({ id: d.id }).update({ linked_journal_entry_id: to ?? null });
  }
  for (const b of btLinks) {
    const to = newKeyToId.get(keyOfJe.get(b.journal_entry_id) ?? '');
    await trx('bank_transactions').where({ id: b.id }).update({ journal_entry_id: to ?? null });
  }
  result.counts.journal_entries = maps.journal.size;

  // ── Bank transactions by uid, in place. Rows the desktop removed go first, so
  // a statement deleted and imported again there does not meet itself here.
  const btCols = await columnsOf(trx, 'bank_transactions');
  const ownUids = new Set(rowsOf(tables, 'bank_transactions').filter((b) => num(b.period_id) === ownOld).map((b) => String(b.sync_uid)));
  const goneRows = ((await trx('bank_transactions').where({ client_id: C, period_id: P }).select('id', 'sync_uid')) as Array<{ id: number; sync_uid: string }>)
    .filter((b) => !ownUids.has(String(b.sync_uid)));
  if (goneRows.length) await trx('bank_transactions').whereIn('id', goneRows.map((b) => b.id)).delete();
  const seen = new Set<number>();
  for (const bt of rowsOf(tables, 'bank_transactions')) {
    const here = await trx('bank_transactions').where({ client_id: C, sync_uid: bt.sync_uid }).first('id', 'period_id');
    if (num(bt.period_id) !== ownOld) {
      // A reference (an earlier period's transaction a reconciliation clears): linked, never replaced.
      if (!here) throw fail('SYNC_ARCHIVE_INVALID', 'A reconciliation clears a transaction this server does not have.');
      maps.bankTxn.set(Number(bt.id), Number(here.id));
      continue;
    }
    const row: Row = { ...sanitize('bank_transactions', pick(remapRow('bank_transactions', bt), btCols)), client_id: C, period_id: P };
    if (here) {
      if (here.period_id !== null && Number(here.period_id) !== P) throw fail('SYNC_ARCHIVE_INVALID', 'A transaction in the archive belongs to another period here.');
      delete row.sync_uid;
      await trx('bank_transactions').where({ id: here.id }).update(await enc('bank_transactions', row));
      maps.bankTxn.set(Number(bt.id), Number(here.id));
      seen.add(Number(here.id));
    } else {
      if (await trx('bank_transactions').where({ sync_uid: bt.sync_uid }).first('id')) {
        throw fail('SYNC_UID_EXISTS', 'A bank transaction in the archive belongs to another client on the server.');
      }
      if (row.import_hash != null && (await trx('bank_transactions').where({ client_id: C, import_hash: row.import_hash }).first('id'))) {
        throw fail('SYNC_DUPLICATE_IMPORT', 'A bank transaction imported on the desktop is already on the server (the same statement line, in this or another period). Remove the duplicate on the desktop and send it again.');
      }
      const [ins] = await trx('bank_transactions').insert(await enc('bank_transactions', row)).returning('id');
      maps.bankTxn.set(Number(bt.id), Number((ins as { id: number }).id));
      seen.add(Number((ins as { id: number }).id));
    }
  }
  result.counts.bank_transactions = seen.size;

  // ── Tables replaced as a whole.
  for (const t of REPLACED) {
    await trx(t).where({ period_id: P }).delete();
    const cols = await columnsOf(trx, t);
    const rows = rowsOf(tables, t).map((r) => ({ ...sanitize(t, pick(remapRow(t, r), cols)), period_id: P, ...(cols.has('client_id') ? { client_id: C } : {}) }));
    await insertBatched(trx, t, rows);
    result.counts[t] = rows.length;
  }

  // ── Sign-offs (security review): one the server has, exactly, stays as the
  // server has it (it may be invalidated since); any other is the sender's,
  // with the balance stamp the server computes now. Nobody signs for another.
  const signCols = await columnsOf(trx, 'lead_sheet_signoffs');
  const serverSigns = (await trx('lead_sheet_signoffs').where({ period_id: P })) as Row[];
  const signKey = (r: Row) => [r.lead_sheet_id, r.role, iso(r.signed_at), num(r.user_id), r.user_name ?? null, r.balance_stamp].map((x) => String(x)).join('|');
  const serverByKey = new Map(serverSigns.map((r) => [signKey(r), r]));
  await trx('lead_sheet_signoffs').where({ period_id: P }).delete();
  let signs = 0;
  for (const a of rowsOf(tables, 'lead_sheet_signoffs')) {
    const lsId = mapRef('leadSheet', a.lead_sheet_id, 'lead_sheet_signoffs', 'lead_sheet_id')!;
    const was = serverByKey.get(signKey({ ...a, lead_sheet_id: lsId }));
    const invalidatedBy = num(a.invalidated_by);
    const keptInvalidator = invalidatedBy === null || invalidatedBy === target.userId || invalidatedBy === num(was?.invalidated_by) ? invalidatedBy : null;
    if (was) {
      a.invalidated_by = keptInvalidator;
    } else {
      a.user_id = target.userId;
      a.user_name = pusherName;
      a.balance_stamp = await currentStampFor(trx, P, lsId);
      a.invalidated_by = keptInvalidator;
    }
    await trx('lead_sheet_signoffs').insert(await enc('lead_sheet_signoffs', { ...pick(a, signCols), lead_sheet_id: lsId, period_id: P }));
    signs++;
  }
  result.counts.lead_sheet_signoffs = signs;

  // ── Reconciliations and their items.
  await trx('bank_reconciliations').where({ period_id: P }).delete();
  const recCols = await columnsOf(trx, 'bank_reconciliations');
  for (const r of rowsOf(tables, 'bank_reconciliations')) {
    const [ins] = await trx('bank_reconciliations').insert(await enc('bank_reconciliations', { ...sanitize('bank_reconciliations', pick(remapRow('bank_reconciliations', r), recCols)), client_id: C, period_id: P })).returning('id');
    maps.recon.set(Number(r.id), Number((ins as { id: number }).id));
  }
  const itemCols = await columnsOf(trx, 'reconciliation_items');
  await insertBatched(trx, 'reconciliation_items', rowsOf(tables, 'reconciliation_items').map((i) => pick(remapRow('reconciliation_items', i), itemCols)));
  result.counts.bank_reconciliations = maps.recon.size;

  // ── Lead sheet attachments by ref code (tombstones kept: no ref code is reissued).
  const attCols = await columnsOf(trx, 'lead_sheet_attachments');
  const replacedDocs: number[] = [];
  const archiveRefs = new Set<string>();
  for (const a of rowsOf(tables, 'lead_sheet_attachments')) {
    archiveRefs.add(String(a.ref_code));
    const docOld = num(a.document_id);
    const row: Row = { ...sanitize('lead_sheet_attachments', pick(a, attCols)), client_id: C, period_id: P };
    row.lead_sheet_id = a.lead_sheet_id == null ? null : mapRef('leadSheet', a.lead_sheet_id, 'lead_sheet_attachments', 'lead_sheet_id');
    row.account_id = a.account_id == null ? null : mapRef('account', a.account_id, 'lead_sheet_attachments', 'account_id');
    row.document_id = docOld === null ? null : a.deleted_at ? (maps.document.get(docOld) ?? null) : mapRef('document', docOld, 'lead_sheet_attachments', 'document_id');
    const here = await trx('lead_sheet_attachments').where({ period_id: P, ref_code: a.ref_code }).first('id', 'document_id');
    if (here) {
      if (here.document_id && Number(here.document_id) !== row.document_id) replacedDocs.push(Number(here.document_id));
      await trx('lead_sheet_attachments').where({ id: here.id }).update(await enc('lead_sheet_attachments', row));
    } else {
      await trx('lead_sheet_attachments').insert(await enc('lead_sheet_attachments', row));
    }
  }
  // An attachment is never deleted, only marked removed (its ref code stays
  // taken): one the server has that the archive lacks is refused, not guessed.
  const dropped = ((await trx('lead_sheet_attachments').where({ period_id: P }).pluck('ref_code')) as string[]).filter((r) => !archiveRefs.has(r));
  if (dropped.length) throw fail('SYNC_ARCHIVE_INVALID', `The archive lacks attachment ${dropped[0]} the server has: mark it removed on the desktop instead of deleting it.`);
  result.counts.lead_sheet_attachments = archiveRefs.size;

  // ── Statement Writer: sets by name, versions kept by number (their PDFs live here).
  const repCols = await columnsOf(trx, 'fs_reports');
  const verCols = await columnsOf(trx, 'fs_report_versions');
  const currentOld = new Map<number, number | null>();
  const usedReports = new Set<number>();
  for (const r of rowsOf(tables, 'fs_reports')) {
    const row: Row = { ...sanitize('fs_reports', pick(r, repCols)), client_id: C, period_id: P, current_version_id: null };
    row.client_layout_id = mapRef('fsLayout', r.client_layout_id, 'fs_reports', 'client_layout_id');
    // By name, preferring the same archived state; each server set matched once.
    const cands = (await trx('fs_reports').where({ period_id: P, name: r.name }).select('id', 'archived_at')) as Array<{ id: number; archived_at: unknown }>;
    const free = cands.filter((c) => !usedReports.has(Number(c.id)));
    const here = free.find((c) => !!c.archived_at === !!r.archived_at) ?? free[0];
    if (here) usedReports.add(Number(here.id));
    let id: number;
    if (here) {
      id = Number(here.id);
      await trx('fs_reports').where({ id }).update(await enc('fs_reports', row));
    } else {
      const [ins] = await trx('fs_reports').insert(await enc('fs_reports', row)).returning('id');
      id = Number((ins as { id: number }).id);
    }
    maps.fsReport.set(Number(r.id), id);
    currentOld.set(id, num(r.current_version_id));
  }
  const versionMap = new Map<number, number>();
  for (const v of rowsOf(tables, 'fs_report_versions')) {
    const reportId = mapRef('fsReport', v.report_id, 'fs_report_versions', 'report_id')!;
    // Its layout names accounts and lead sheets by the desktop's ids.
    if (v.layout_json != null) v.layout_json = remapFsLayoutIds(v.layout_json, idMaps);
    const reopenedBy = num(v.reopened_by);
    const row: Row = { ...sanitize('fs_report_versions', pick(v, verCols)), report_id: reportId };
    const here = await trx('fs_report_versions').where({ report_id: reportId, version_no: v.version_no }).first();
    if (!here) {
      // Issued statements are finalized on the server, through its checks (security review).
      throw fail('SYNC_ARCHIVE_INVALID', 'Statements finalized on the desktop cannot be sent: send the period back, then finalize them on the server.');
    }
    if (reopenedBy !== null && reopenedBy !== target.userId && reopenedBy !== num(here.reopened_by)) {
      v.reopened_by = null;
      row.reopened_by = null;
    }
    if (here) {
      // An issued version is frozen (its PDF stays here): only what reopening
      // or superseding it changes may differ.
      const changed = Object.keys(row).filter((k) => !VERSION_MUTABLE.has(k) && k in here && !same(here[k], row[k]));
      if (changed.length) throw fail('SYNC_ARCHIVE_INVALID', `An issued version of the statements "${String(v.version_no)}" differs from the server's (${changed.join(', ')}); issued statements cannot be changed.`);
      await trx('fs_report_versions').where({ id: here.id }).update(await enc('fs_report_versions', row));
      versionMap.set(Number(v.id), Number(here.id));
    }
  }
  for (const [reportId, oldCurrent] of currentOld) {
    await trx('fs_reports').where({ id: reportId }).update({ current_version_id: oldCurrent === null ? null : versionMap.get(oldCurrent) ?? null });
  }
  // A set is never deleted, only archived (its issued versions stay): one the
  // server has that the archive lacks is refused, not guessed.
  const missingSet = await trx('fs_reports').where({ period_id: P }).whereNotIn('id', [...usedReports, ...maps.fsReport.values()]).first('name');
  if (missingSet) throw fail('SYNC_ARCHIVE_INVALID', `The archive lacks the statement set "${String(missingSet.name)}" the server has: archive it on the desktop instead of deleting it.`);
  result.counts.fs_reports = maps.fsReport.size;

  // ── Acceptance.
  const stamp = await stampOf(trx, P);
  const expected = archiveStamp(tables, ownOld, accountUid);
  if (stamp !== expected) {
    const here = await loadPeriodStampInput(trx as unknown as Knex, P);
    console.error('[sync] merge stamp mismatch, period', P, 'tables:', here ? differingTables(here, archiveStampInput(tables, ownOld, accountUid)).join(', ') : '(period gone)');
    throw fail('SYNC_MERGE_MISMATCH', 'The period on the server would not match what the desktop sent, so nothing was changed. Tell your administrator (the server log has the detail).');
  }
  for (const [id, before] of othersBefore) {
    if ((await stampOf(trx, id)) !== before) {
      throw fail('SYNC_MERGE_MISMATCH', 'Sending this period back would have changed another period, so nothing was changed. Tell your administrator.');
    }
  }
  result.stamp = stamp!;
  result.totalsAfter = await totals(trx, P);
  const wanted = (manifest.sync as Row | undefined)?.totals as Totals | undefined;
  if (!wanted) throw fail('SYNC_ARCHIVE_INVALID', "The archive must carry the period's adjusted trial balance totals (sync.totals).");
  if (wanted && (String(wanted.bookDebit) !== result.totalsAfter.bookDebit || String(wanted.bookCredit) !== result.totalsAfter.bookCredit)) {
    throw fail('SYNC_TOTALS_MISMATCH', 'The trial balance totals on the server would not equal the desktop\'s, so nothing was changed.');
  }

  if (target.checkoutId !== null) {
    await trx('period_checkouts').where({ id: target.checkoutId }).update({ released_at: trx.fn.now(), released_by: target.userId, release_reason: 'Sent back by the desktop.' });
  }
  await logAudit({
    userId: target.userId, periodId: P, entityType: 'period', entityId: P, action: 'sync_merge',
    description: `Period sent back by desktop "${target.deviceName}": ${Object.entries(result.counts).map(([t, n]) => `${t} ${n}`).join(', ')}`
      + (result.accountsAdded.length ? `; accounts added ${result.accountsAdded.join(', ')}` : '')
      + (result.differences.length ? `; ${result.differences.length} client-level change(s) kept as on the server` : ''),
  }, trx);
  return { result, replacedDocs };
}

async function stampOf(q: Knex | Knex.Transaction, periodId: number): Promise<string | null> {
  const input = await loadPeriodStampInput(q as Knex, periodId);
  return input ? periodStamp(input) : null;
}

/** Deletes documents the merge replaced, once it committed. */
export async function dropReplacedDocuments(ids: number[]): Promise<void> {
  for (const id of ids) {
    const doc = await db('client_documents').where({ id }).first();
    if (doc) await deleteDocument(doc as DocumentRow).catch(() => undefined);
  }
}

export function removeUploadFile(filePath: string): void {
  try { fs.rmSync(filePath, { force: true }); } catch { /* gone */ }
}
