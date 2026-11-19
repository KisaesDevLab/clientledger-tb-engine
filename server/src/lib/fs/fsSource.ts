// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * The Statement Writer's data source: one period of the adjusted trial
 * balance, shaped into the engine's `FsSourceData`.
 *
 * This is the whole seam between the engine ported from Vibe MyBooks and this
 * app. MyBooks reads a dated ledger; here a PERIOD holds balances, so there
 * are at most three trial balance snapshots:
 *
 *   periodEnd                 this period         the basis columns of the view
 *   priorEnd  (= start − 1)   the prior year      this period's prior_year_*
 *   day before priorStart     the year before it  the PRIOR PERIOD's prior_year_*
 *
 * The third exists only when the prior period is in the app. Without it the
 * prior year has no opening balance sheet, so its equity roll-forward and
 * cash flows cannot be stated — the engine leaves them out and says why,
 * rather than reading a missing opening as zero.
 *
 * `buildFsSource` is pure (tested); `loadFsSource` is the DB half.
 */

import type { Knex } from 'knex';
import { hasReportableActivity } from '../tbActivity';
import { priorYearRange, shiftBackOneYear, type CandidatePeriod } from '../qbo/priorRange';
import {
  FS_VIRTUAL_RE_ID, fsClientEntityKind,
  type FsCashFlowClass, type FsEquityRole, type FsReportSettings, type FsSourceAccount, type FsSourceData,
  type FsSourceGrouping, type FsSourcePeriod,
} from './engine';
import { fsSourceStamp } from './fsStamp';

/** One row of v_adjusted_trial_balance joined to chart_of_accounts. */
export interface FsTbRow {
  account_id: number;
  account_number: string;
  account_name: string;
  category: string;
  lead_sheet_id: number | null;
  cash_flow_category: string | null;
  prior_year_debit: number | string | null;
  prior_year_credit: number | string | null;
  unadjusted_debit: number | string | null;
  unadjusted_credit: number | string | null;
  trans_adj_debit: number | string | null;
  trans_adj_credit: number | string | null;
  book_adj_debit: number | string | null;
  book_adj_credit: number | string | null;
  tax_adj_debit: number | string | null;
  tax_adj_credit: number | string | null;
  book_adjusted_debit: number | string | null;
  book_adjusted_credit: number | string | null;
  tax_adjusted_debit: number | string | null;
  tax_adjusted_credit: number | string | null;
}

export interface FsSourceInput {
  clientName: string;
  entityType: string | null;
  settings: Pick<FsReportSettings, 'framework' | 'entityKind'>;
  periodStart: string;
  periodEnd: string;
  /** The period that ends the day before this one starts, when it is in the app. */
  priorPeriod: { startDate: string; rows: FsTbRow[] } | null;
  rows: FsTbRow[];
  leadSheets: Array<{ id: number; code: string | null; name: string; sort_order: number }>;
  equityRoles: Array<{ account_id: number; role: string; is_fold: boolean }>;
  cashFlowOverrides: Array<{ account_id: number | null; lead_sheet_id: number | null; classification: string }>;
}

const n = (v: number | string | null | undefined): number => Number(v ?? 0);
/** Signed cents, + = debit. */
const net = (dr: number | string | null, cr: number | string | null): number => n(dr) - n(cr);

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// chart_of_accounts.category → the engine's account type. Signing follows
// the CATEGORY (assets/expenses debit-natural), never normal_balance — a
// per-account flag the user can set independently, which would invert every
// contra account.
const ACCOUNT_TYPE: Readonly<Record<string, string>> = {
  assets: 'asset', liabilities: 'liability', equity: 'equity', revenue: 'revenue', expenses: 'expense',
};
const BS_TYPES = new Set(['asset', 'liability', 'equity']);

// The existing Cash Flow page's per-account category, where it is set.
const COA_CASH_FLOW_CLASS: Readonly<Record<string, FsCashFlowClass>> = {
  cash: 'cash', operating: 'operating', investing: 'investing', financing: 'financing', non_cash: 'noncash_adjustment',
};

/** Name-based default for an equity account's role (MyBooks' defaultEquityRole). */
export function defaultEquityRole(name: string): FsEquityRole {
  const s = name.toLowerCase();
  if (/distribut|draw|dividend|withdraw/.test(s)) return 'distributions';
  if (/contribut|paid.?in|capital stock|common stock|preferred/.test(s)) return 'contributions';
  if (/retained|accumulated adjustments|\baaa\b|members?.? equity|partners?.? capital|owner.?s equity|owner.?s capital/.test(s)) return 'retained';
  return 'other';
}

function snapshot(date: string, balances: Record<string, number>, taxBalances?: Record<string, number>): FsSourcePeriod {
  const hasData = Object.values(balances).some((v) => v !== 0)
    || (!!taxBalances && Object.values(taxBalances).some((v) => v !== 0));
  return { date, balances, ...(taxBalances ? { taxBalances } : {}), hasData };
}

export function buildFsSource(input: FsSourceInput): FsSourceData {
  const { periodStart, periodEnd, priorPeriod } = input;
  const priorEnd = dayBefore(periodStart);
  // The prior period's own start when it is in the app (a short year, a stub
  // period); otherwise a year before this one.
  const priorStart = priorPeriod && priorPeriod.startDate <= priorEnd ? priorPeriod.startDate : shiftBackOneYear(periodStart);
  const openingDate = dayBefore(priorStart);

  const priorRowById = new Map((priorPeriod?.rows ?? []).map((r) => [r.account_id, r]));
  const fold = input.equityRoles.find((r) => r.is_fold)?.account_id ?? null;

  // Dormant accounts stay off every report (CLAUDE.md): no beginning balance,
  // no activity, no ending balance. An account is kept when it has any of
  // those here, or a balance in the opening snapshot of the prior year, or is
  // the account net income is closed into.
  const rows = input.rows.filter((r) => {
    if (hasReportableActivity(r as unknown as Record<string, unknown>)) return true;
    const p = priorRowById.get(r.account_id);
    if (p && net(p.prior_year_debit, p.prior_year_credit) !== 0) return true;
    return r.account_id === fold;
  });

  const accounts: FsSourceAccount[] = rows.map((r) => ({
    id: String(r.account_id),
    number: r.account_number || null,
    name: r.account_name,
    accountType: ACCOUNT_TYPE[r.category] ?? 'expense',
    detailType: null,
    isVirtual: false,
  }));
  const typeOf = new Map(accounts.map((a) => [a.id, a.accountType]));

  const cy: Record<string, number> = {};
  const cyTax: Record<string, number> = {};
  const py: Record<string, number> = {};
  const pyTax: Record<string, number> = {};
  const opening: Record<string, number> = {};
  for (const r of rows) {
    const id = String(r.account_id);
    cy[id] = net(r.book_adjusted_debit, r.book_adjusted_credit);
    cyTax[id] = net(r.tax_adjusted_debit, r.tax_adjusted_credit);
    py[id] = net(r.prior_year_debit, r.prior_year_credit);
    const p = priorRowById.get(r.account_id);
    // Tax AJEs are per period and never roll forward, so the prior year's
    // tax figure is its book figure plus the prior PERIOD's tax AJEs.
    pyTax[id] = py[id]! + (p ? net(p.tax_adj_debit, p.tax_adj_credit) : 0);
    if (p) opening[id] = net(p.prior_year_debit, p.prior_year_credit);
  }

  const snapshots: Record<string, FsSourcePeriod> = {
    [periodEnd]: snapshot(periodEnd, cy, cyTax),
    // Always present: an all-zero prior year is a KNOWN empty opening (a
    // first-year client), which is different from an unknown one.
    [priorEnd]: snapshot(priorEnd, py, priorPeriod ? pyTax : undefined),
  };
  if (priorPeriod) snapshots[openingDate] = snapshot(openingDate, opening);

  const kept = new Set(rows.map((r) => r.account_id));
  const groupings: FsSourceGrouping[] = [...input.leadSheets]
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map((ls) => ({
      id: String(ls.id),
      code: ls.code,
      name: ls.name,
      sortOrder: ls.sort_order,
      accountIds: rows.filter((r) => r.lead_sheet_id === ls.id).map((r) => String(r.account_id)),
    }));

  // Equity roles: a stored row wins, otherwise the name decides.
  const storedRole = new Map(input.equityRoles.filter((r) => kept.has(r.account_id)).map((r) => [String(r.account_id), r.role as FsEquityRole]));
  const equityRoles: Record<string, FsEquityRole> = {};
  for (const a of accounts) {
    if (a.accountType !== 'equity') continue;
    equityRoles[a.id] = storedRole.get(a.id) ?? defaultEquityRole(a.name);
  }
  // Where net income is closed: the chosen account, else the lowest-numbered
  // retained-earnings account, else a virtual one.
  let reAccountId = fold !== null && kept.has(fold) && typeOf.get(String(fold)) === 'equity' ? String(fold) : null;
  if (!reAccountId) {
    const retained = accounts
      .filter((a) => a.accountType === 'equity' && equityRoles[a.id] === 'retained')
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '', undefined, { numeric: true }) || a.id.localeCompare(b.id));
    reAccountId = retained[0]?.id ?? FS_VIRTUAL_RE_ID;
  }

  // Cash-flow classes. Account level: a Statement Writer override, else the
  // category already kept on the chart of accounts for the Cash Flow page.
  // Lead sheet level: a Statement Writer override. The engine falls back to
  // its own defaults for everything else.
  const cashFlowOverrides: FsSourceData['cashFlowOverrides'] = [];
  const accountOverride = new Map(input.cashFlowOverrides.filter((o) => o.account_id !== null).map((o) => [o.account_id!, o.classification as FsCashFlowClass]));
  for (const r of rows) {
    if (!BS_TYPES.has(ACCOUNT_TYPE[r.category] ?? '')) continue;
    const cls = accountOverride.get(r.account_id) ?? (r.cash_flow_category ? COA_CASH_FLOW_CLASS[r.cash_flow_category] : undefined);
    if (cls) cashFlowOverrides.push({ accountId: String(r.account_id), groupingId: null, classification: cls });
  }
  for (const o of input.cashFlowOverrides) {
    if (o.lead_sheet_id !== null) cashFlowOverrides.push({ accountId: null, groupingId: String(o.lead_sheet_id), classification: o.classification as FsCashFlowClass });
  }

  const source: Omit<FsSourceData, 'sourceStamp'> = {
    companyName: input.clientName,
    entityKind: input.settings.entityKind ?? fsClientEntityKind(input.entityType),
    framework: input.settings.framework,
    periodStart, periodEnd, priorStart, priorEnd,
    accounts, groupings, snapshots, reAccountId, equityRoles, cashFlowOverrides,
    ...(input.settings.framework === 'tax' && !priorPeriod ? { taxPriorIsBook: true } : {}),
  };
  return { ...source, sourceStamp: fsSourceStamp(source) };
}

// ─── DB half ─────────────────────────────────────────────────────────────

export class FsSourceError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
  }
}

export function isoDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * Raw TB rows for one period. `is_active` only and NO dormancy filter in SQL
 * (as `loadStampRows`): which accounts are dormant depends on the prior
 * period too, so `buildFsSource` decides.
 */
export async function loadFsTbRows(q: Knex | Knex.Transaction, periodId: number): Promise<FsTbRow[]> {
  return q('v_adjusted_trial_balance as vtb')
    .join('chart_of_accounts as coa', 'coa.id', 'vtb.account_id')
    .where('vtb.period_id', periodId)
    .where('vtb.is_active', true)
    .orderBy('vtb.account_number')
    .select(
      'vtb.account_id', 'vtb.account_number', 'vtb.account_name', 'vtb.category', 'vtb.lead_sheet_id',
      'coa.cash_flow_category',
      'vtb.prior_year_debit', 'vtb.prior_year_credit',
      'vtb.unadjusted_debit', 'vtb.unadjusted_credit',
      'vtb.trans_adj_debit', 'vtb.trans_adj_credit',
      'vtb.book_adj_debit', 'vtb.book_adj_credit',
      'vtb.tax_adj_debit', 'vtb.tax_adj_credit',
      'vtb.book_adjusted_debit', 'vtb.book_adjusted_credit',
      'vtb.tax_adjusted_debit', 'vtb.tax_adjusted_credit',
    ) as Promise<FsTbRow[]>;
}

export interface FsPeriodContext {
  periodId: number;
  clientId: number;
  clientName: string;
  entityType: string | null;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  lockedAt: unknown;
}

export async function loadFsPeriodContext(q: Knex | Knex.Transaction, periodId: number): Promise<FsPeriodContext> {
  const row = await q('periods as p')
    .join('clients as c', 'c.id', 'p.client_id')
    .where('p.id', periodId)
    .first('p.id', 'p.client_id', 'p.period_name', 'p.start_date', 'p.end_date', 'p.locked_at', 'c.name as client_name', 'c.entity_type');
  if (!row) throw new FsSourceError('PERIOD_NOT_FOUND', 404, 'Period not found.');
  const periodStart = isoDate(row.start_date);
  const periodEnd = isoDate(row.end_date);
  if (!periodStart || !periodEnd || periodStart > periodEnd) {
    throw new FsSourceError('PERIOD_DATES_REQUIRED', 422, 'This period needs a start date and an end date before statements can be prepared. Set them on the Periods page.');
  }
  return {
    periodId: row.id, clientId: row.client_id, clientName: row.client_name, entityType: row.entity_type ?? null,
    periodName: row.period_name, periodStart, periodEnd, lockedAt: row.locked_at ?? null,
  };
}

export async function loadFsSource(
  q: Knex | Knex.Transaction,
  periodId: number,
  settings: Pick<FsReportSettings, 'framework' | 'entityKind'>,
): Promise<{ source: FsSourceData; period: FsPeriodContext }> {
  const period = await loadFsPeriodContext(q, periodId);

  const others = (await q('periods')
    .where({ client_id: period.clientId, is_reference: false })
    .whereNot({ id: periodId })
    .whereNotNull('start_date')
    .whereNotNull('end_date')
    .select('id', 'period_name', 'start_date', 'end_date')) as Array<{ id: number; period_name: string; start_date: unknown; end_date: unknown }>;
  const candidates: CandidatePeriod[] = others
    .map((p) => ({ id: p.id, period_name: p.period_name, start_date: isoDate(p.start_date) ?? '', end_date: isoDate(p.end_date) ?? '' }))
    .filter((p) => p.start_date && p.end_date);
  const prior = priorYearRange(period.periodStart, period.periodEnd, candidates);

  const [rows, priorRows, leadSheets, equityRoles, cashFlowOverrides] = await Promise.all([
    loadFsTbRows(q, periodId),
    prior.source === 'period' && prior.priorPeriodId ? loadFsTbRows(q, prior.priorPeriodId) : Promise.resolve(null),
    q('lead_sheets').where({ client_id: period.clientId }).select('id', 'code', 'name', 'sort_order'),
    q('fs_equity_roles').where({ client_id: period.clientId }).select('account_id', 'role', 'is_fold'),
    q('fs_cash_flow_overrides').where({ client_id: period.clientId }).select('account_id', 'lead_sheet_id', 'classification'),
  ]);

  const source = buildFsSource({
    clientName: period.clientName,
    entityType: period.entityType,
    settings,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    priorPeriod: priorRows ? { startDate: prior.startDate, rows: priorRows } : null,
    rows,
    leadSheets: leadSheets as FsSourceInput['leadSheets'],
    equityRoles: equityRoles as FsSourceInput['equityRoles'],
    cashFlowOverrides: cashFlowOverrides as FsSourceInput['cashFlowOverrides'],
  });
  return { source, period };
}
