// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * The period stamp (desktop sync S1): one SHA-256 over everything a desktop
 * pull carries for a period (SQ4), so the server can tell at send-back
 * whether the period changed since it was pulled.
 *
 * It must be the same on every instance that holds the same period, so it
 * never sees a database id: an account is its `sync_uid`, an entry its type
 * and number, a lead sheet its code, a tickmark its symbol, a bank
 * transaction its `sync_uid`, an attachment its file's SHA-256, a
 * reconciliation its account and statement date. Who did something (user
 * ids, which a restore clears) and when a row was written (created_at,
 * updated_at, imported_at, uploaded_at) are left out; the times that are
 * part of the work (completed, resolved, signed, cleared, finalized) stay.
 * DATE columns are written as their calendar date, so the time zone of the
 * process does not matter.
 *
 * Pure: the caller loads the rows (`periodStampLoad.ts`). Same idea as
 * `leadSheetBalanceStamp` and `fsSourceStamp`.
 */

import crypto from 'crypto';

type Row = Record<string, unknown>;

/** The tables a period pull carries (SQ4), in the order they are hashed. */
export const STAMP_TABLES = [
  'trial_balance',
  'journal_entries',
  'journal_entry_lines',
  'bank_transactions',
  'variance_notes',
  'tb_tickmarks',
  'm1_adjustments',
  'engagement_tasks',
  'lead_sheet_notes',
  'lead_sheet_signoffs',
  'py_comparison_data',
  'lead_sheet_attachments',
  'bank_reconciliations',
  'reconciliation_items',
  'fs_reports',
  'fs_report_versions',
] as const;

export type StampTable = (typeof STAMP_TABLES)[number];

/** What a column that points at another row becomes. */
export type RefKind = 'account' | 'period' | 'journal' | 'leadSheet' | 'tickmark' | 'document' | 'bankTxn' | 'recon' | 'fsReport' | 'fsLayout';

interface TableSpec {
  /** Columns that point at another row, and what they become. */
  refs?: Record<string, RefKind>;
  /** DATE columns (written as the calendar date). */
  dates?: string[];
  /** Left out besides the common ones. */
  drop?: string[];
  /** Statement layouts inside (their ids become the keys they name). */
  layouts?: string[];
}

/** Never hashed: ids, who, and when the row was written. */
const COMMON_DROP = new Set([
  'id', 'client_id', 'period_id', 'created_at', 'updated_at', 'imported_at', 'uploaded_at',
  'created_by', 'updated_by', 'classified_by', 'uploaded_by', 'author_id', 'resolved_by', 'user_id',
  'invalidated_by', 'assignee_id', 'completed_by', 'deleted_by', 'finalized_by', 'reopened_by',
]);

const SPECS: Record<StampTable, TableSpec> = {
  trial_balance: { refs: { account_id: 'account' } },
  journal_entries: { dates: ['entry_date'] },
  journal_entry_lines: { refs: { journal_entry_id: 'journal', account_id: 'account' } },
  bank_transactions: {
    refs: {
      account_id: 'account', ai_suggested_account_id: 'account', source_account_id: 'account', journal_entry_id: 'journal',
    },
    dates: ['transaction_date'],
  },
  variance_notes: { refs: { account_id: 'account', compare_period_id: 'period' } },
  tb_tickmarks: { refs: { account_id: 'account', tickmark_id: 'tickmark' } },
  m1_adjustments: {},
  engagement_tasks: {},
  lead_sheet_notes: { refs: { lead_sheet_id: 'leadSheet', account_id: 'account' } },
  lead_sheet_signoffs: { refs: { lead_sheet_id: 'leadSheet' } },
  py_comparison_data: { refs: { account_id: 'account' } },
  lead_sheet_attachments: { refs: { lead_sheet_id: 'leadSheet', account_id: 'account', document_id: 'document' } },
  bank_reconciliations: { refs: { source_account_id: 'account' }, dates: ['statement_date'] },
  reconciliation_items: { refs: { reconciliation_id: 'recon', transaction_id: 'bankTxn' } },
  // The layout a set uses is the CLIENT's (fs_client_layouts), edited while a
  // period is out and handled on send-back by the SQ3 rule (owner
  // 2026-11-19), so it is not part of the period: a layout edit must not
  // move a held period's stamp. A finalized version's frozen layout_json is.
  fs_reports: { drop: ['current_version_id', 'client_layout_id'] },
  // model_json is derived from the numbers (numbers_hash carries them).
  fs_report_versions: { refs: { report_id: 'fsReport' }, drop: ['model_json'], layouts: ['layout_json'] },
};

/**
 * The columns of a period table that point at another row, and what kind
 * (the send-back merge remaps ids by the same table, so the two agree).
 */
export function stampRefs(table: StampTable): Record<string, RefKind> {
  return { ...(SPECS[table].refs ?? {}) };
}

/** The rows and the lookups a stamp needs. */
export interface PeriodStampInput {
  /** The client's accounts (`sync_uid` stands for the account). */
  accounts: Array<{ id: number; sync_uid: string }>;
  /** The client's periods (a variance note's comparison period). */
  periods: Array<{ id: number; sync_uid: string }>;
  /** The client's lead sheets. */
  leadSheets: Array<{ id: number; code: string | null }>;
  /** The client's tickmark library. */
  tickmarks: Array<{ id: number; symbol: string }>;
  /** The documents behind the period's attachments. */
  documents: Array<{ id: number; sha256: string | null }>;
  /** Bank transactions a reconciliation item names, the period's or not. */
  bankTransactions: Array<{ id: number; sync_uid: string }>;
  /** The client's statement layouts the period's sets use. */
  fsLayouts: Row[];
  /** The period's rows, by table. */
  rows: Partial<Record<StampTable, Row[]>>;
}

function calendarDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A DATE column as its calendar date, from the database (a Date at local
 * midnight) or from an archive's JSON, so a period and its archive stamp
 * alike. Archives write plain YYYY-MM-DD (Q104); older ones wrote the Date as
 * ISO text, and of that text only the date part counts, because that is what
 * Postgres stores when the text is inserted into a DATE column (it ignores
 * the time and zone). Reading it in this server's zone instead put every date
 * from a server or desktop on UTC a day early here when this one was west of
 * UTC, and every send-back was refused.
 */
export function dateText(v: unknown): unknown {
  if (v instanceof Date) return calendarDate(v);
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(v);
    if (m) return m[1];
  }
  return v;
}

/** JSON with sorted keys: equal values, equal text. */
function canonical(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Buffer.isBuffer(v)) return JSON.stringify(crypto.createHash('sha256').update(v).digest('hex'));
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Row;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** `null`, or the value a reference stands for (`?` when it names nothing known). */
interface Resolver {
  (kind: RefKind, id: unknown): string | null;
  /** An id inside a statement layout, as the account's uid or the lead sheet's code. */
  key?: (kind: 'account' | 'leadSheet', id: unknown) => string;
}

function makeResolver(input: PeriodStampInput): Resolver {
  const byId = <T extends { id: number }>(rows: T[], f: (r: T) => string | null) =>
    new Map(rows.map((r) => [Number(r.id), f(r)]));
  const accounts = byId(input.accounts, (r) => r.sync_uid);
  const periods = byId(input.periods, (r) => r.sync_uid);
  const leadSheets = byId(input.leadSheets, (r) => r.code ?? '');
  const tickmarks = byId(input.tickmarks, (r) => r.symbol);
  const documents = byId(input.documents, (r) => r.sha256);
  const txns = byId(input.bankTransactions, (r) => r.sync_uid);
  for (const t of input.rows.bank_transactions ?? []) {
    if (t.sync_uid) txns.set(Number(t.id), String(t.sync_uid));
  }
  const journals = new Map((input.rows.journal_entries ?? []).map((j) => [Number(j.id), `${j.entry_type}#${j.entry_number}`]));
  const recons = new Map((input.rows.bank_reconciliations ?? []).map((r) => [
    Number(r.id),
    `${accounts.get(Number(r.source_account_id)) ?? '?'}|${String(dateText(r.statement_date))}`,
  ]));
  const layoutsById = new Map(input.fsLayouts.map((l) => [Number(l.id), l]));
  const reports = new Map((input.rows.fs_reports ?? []).map((r) => [Number(r.id), String(r.name)]));
  const refKey = (kind: 'account' | 'leadSheet', id: unknown): string => {
    // '-1' is the virtual retained-earnings account, never a row.
    if (kind === 'account' && (id === '-1' || Number(id) === -1)) return 'retained-earnings';
    const n = Number(id);
    const key = kind === 'account' ? accounts.get(n) : leadSheets.get(n);
    return key ?? '?';
  };
  const kinds: Record<RefKind, (id: number) => string | null | undefined> = {
    account: (id) => accounts.get(id),
    period: (id) => periods.get(id),
    journal: (id) => journals.get(id),
    leadSheet: (id) => leadSheets.get(id),
    tickmark: (id) => tickmarks.get(id),
    document: (id) => documents.get(id),
    bankTxn: (id) => txns.get(id),
    recon: (id) => recons.get(id),
    fsReport: (id) => reports.get(id),
    fsLayout: (id) => {
      const l = layoutsById.get(id);
      if (!l) return undefined;
      return canonical({
        name: l.name,
        layout_json: keyedLayout(l.layout_json, refKey),
        style_json: l.style_json,
        archived_at: l.archived_at ?? null,
      });
    },
  };
  const resolve: Resolver = (kind, id) => {
    if (id === null || id === undefined) return null;
    return kinds[kind](Number(id)) ?? '?';
  };
  resolve.key = refKey;
  return resolve;
}

/**
 * A statement layout with every id inside replaced by the key it names (an
 * account's uid, a lead sheet's code), so the same layout reads the same on
 * every instance and a new account elsewhere in the client moves nothing.
 * Ids appear as a lead sheet line's `ref.groupingId`, `accountId` in line
 * refs and schedule lines, `accountIds` lists, and the equity statement's
 * `columnCaptions` keys (`fsLayoutRemap.ts` lists them).
 */
function keyedLayout(layout: unknown, key: (kind: 'account' | 'leadSheet', id: unknown) => string): unknown {
  const walk = (v: unknown, parentKey?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (!v || typeof v !== 'object' || v instanceof Date) return v;
    const out: Row = {};
    for (const [k, x] of Object.entries(v as Row)) {
      if (k === 'groupingId' && x != null) out[k] = key('leadSheet', x);
      else if (k === 'accountId' && x != null) out[k] = key('account', x);
      else if (k === 'accountIds' && Array.isArray(x)) out[k] = x.map((id) => key('account', id));
      else if (k === 'columnCaptions' && x && typeof x === 'object' && parentKey === 'equity') {
        out[k] = Object.fromEntries(Object.entries(x as Row).map(([ck, cv]) => [ck === 'all' ? ck : key('account', ck), cv]));
      } else out[k] = walk(x, k);
    }
    return out;
  };
  return walk(layout);
}

/** One row as text, with its references replaced. */
function rowText(table: StampTable, row: Row, resolve: Resolver): string {
  const spec = SPECS[table];
  const dates = new Set(spec.dates ?? []);
  const drop = new Set(spec.drop ?? []);
  const layouts = new Set(spec.layouts ?? []);
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (COMMON_DROP.has(k) || drop.has(k)) continue;
    // A row's own sync_uid is its identity across instances; keep it.
    const ref = spec.refs?.[k];
    if (ref) out[k] = resolve(ref, v);
    else if (dates.has(k)) out[k] = dateText(v);
    else if (layouts.has(k) && resolve.key) out[k] = keyedLayout(v, resolve.key);
    else out[k] = v;
  }
  return canonical(out);
}

/** The period's stamp: hex SHA-256. */
export function periodStamp(input: PeriodStampInput): string {
  const resolve = makeResolver(input);
  const h = crypto.createHash('sha256');
  h.update('vtb-period-stamp v1\n');
  for (const table of STAMP_TABLES) {
    // Plain code-unit order: the same on every instance, whatever its ICU.
    const lines = (input.rows[table] ?? []).map((r) => rowText(table, r, resolve)).sort();
    h.update(`${table} ${lines.length}\n`);
    for (const l of lines) h.update(`${l}\n`);
  }
  return h.digest('hex');
}
