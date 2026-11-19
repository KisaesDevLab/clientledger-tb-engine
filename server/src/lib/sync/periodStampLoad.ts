// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Loads what `periodStamp` hashes for one period (desktop sync S1). Read
 * only. Every table is optional, so an instance missing one (an older
 * schema in a test) still stamps what it has.
 */

import type { Knex } from 'knex';
import { periodStamp, type PeriodStampInput, type StampTable } from './periodStamp';

type Row = Record<string, unknown>;

async function rowsIf(db: Knex, table: string, q: (b: Knex.QueryBuilder) => Knex.QueryBuilder): Promise<Row[]> {
  if (!(await db.schema.hasTable(table))) return [];
  return (await q(db(table)).select('*')) as Row[];
}

/** The rows and lookups for period `periodId`, or `null` when there is no such period. */
export async function loadPeriodStampInput(db: Knex, periodId: number): Promise<PeriodStampInput | null> {
  const period = await db('periods').where({ id: periodId }).first('id', 'client_id');
  if (!period) return null;
  const clientId = period.client_id as number;
  const byPeriod = (t: string) => rowsIf(db, t, (b) => b.where('period_id', periodId));

  const rows: Partial<Record<StampTable, Row[]>> = {};
  rows.trial_balance = await byPeriod('trial_balance');
  rows.journal_entries = await byPeriod('journal_entries');
  const jeIds = rows.journal_entries.map((j) => j.id as number);
  rows.journal_entry_lines = jeIds.length
    ? await rowsIf(db, 'journal_entry_lines', (b) => b.whereIn('journal_entry_id', jeIds))
    : [];
  rows.bank_transactions = await byPeriod('bank_transactions');
  rows.variance_notes = await byPeriod('variance_notes');
  rows.tb_tickmarks = await byPeriod('tb_tickmarks');
  rows.m1_adjustments = await byPeriod('m1_adjustments');
  rows.engagement_tasks = await byPeriod('engagement_tasks');
  rows.lead_sheet_notes = await byPeriod('lead_sheet_notes');
  rows.lead_sheet_signoffs = await byPeriod('lead_sheet_signoffs');
  rows.py_comparison_data = await byPeriod('py_comparison_data');
  rows.lead_sheet_attachments = await byPeriod('lead_sheet_attachments');
  rows.bank_reconciliations = await byPeriod('bank_reconciliations');
  const reconIds = rows.bank_reconciliations.map((r) => r.id as number);
  rows.reconciliation_items = reconIds.length
    ? await rowsIf(db, 'reconciliation_items', (b) => b.whereIn('reconciliation_id', reconIds))
    : [];
  rows.fs_reports = await byPeriod('fs_reports');
  const reportIds = rows.fs_reports.map((r) => r.id as number);
  rows.fs_report_versions = reportIds.length
    ? await rowsIf(db, 'fs_report_versions', (b) => b.whereIn('report_id', reportIds))
    : [];

  const docIds = rows.lead_sheet_attachments.map((a) => a.document_id).filter((x): x is number => x != null);
  const txnIds = rows.reconciliation_items.map((i) => i.transaction_id).filter((x): x is number => x != null);
  const layoutIds = rows.fs_reports.map((r) => r.client_layout_id).filter((x): x is number => x != null);

  return {
    accounts: (await db('chart_of_accounts').where({ client_id: clientId }).select('id', 'sync_uid')) as PeriodStampInput['accounts'],
    periods: (await db('periods').where({ client_id: clientId }).select('id', 'sync_uid')) as PeriodStampInput['periods'],
    leadSheets: (await rowsIf(db, 'lead_sheets', (b) => b.where({ client_id: clientId }))).map((r) => ({ id: r.id as number, code: (r.code as string | null) ?? null })),
    tickmarks: (await rowsIf(db, 'tickmark_library', (b) => b.where({ client_id: clientId }))).map((r) => ({ id: r.id as number, symbol: r.symbol as string })),
    documents: docIds.length
      ? (await db('client_documents').whereIn('id', docIds).select('id', 'sha256')) as PeriodStampInput['documents']
      : [],
    bankTransactions: txnIds.length
      ? (await db('bank_transactions').whereIn('id', txnIds).select('id', 'sync_uid')) as PeriodStampInput['bankTransactions']
      : [],
    fsLayouts: layoutIds.length ? await rowsIf(db, 'fs_client_layouts', (b) => b.whereIn('id', layoutIds)) : [],
    rows,
  };
}

/** Period `periodId`'s stamp, or `null` when there is no such period. */
export async function stampPeriod(db: Knex, periodId: number): Promise<string | null> {
  const input = await loadPeriodStampInput(db, periodId);
  return input ? periodStamp(input) : null;
}
