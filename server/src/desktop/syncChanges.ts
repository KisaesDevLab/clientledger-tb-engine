// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// What changed in a period since it was pulled (P12 D2.5, the Send back
// summary). Pure: the route in syncRoutes.ts loads the rows.

import { STAMP_TABLES, periodStamp, type PeriodStampInput, type StampTable } from '../lib/sync/periodStamp';

type Rows = Record<string, unknown>[];
const tableRows = (tables: Record<string, unknown[]>, t: string): Rows => (tables[t] ?? []) as Rows;

/** A pulled archive's own period as stamp input (as upstream's archiveStamp reads one). */
export function archiveInput(tables: Record<string, unknown[]>, ownPeriodId: number): PeriodStampInput {
  return {
    accounts: tableRows(tables, 'chart_of_accounts').map((r) => ({ id: Number(r.id), sync_uid: String(r.sync_uid) })),
    periods: tableRows(tables, 'periods').map((r) => ({ id: Number(r.id), sync_uid: String(r.sync_uid) })),
    leadSheets: tableRows(tables, 'lead_sheets').map((r) => ({ id: Number(r.id), code: (r.code as string | null) ?? null })),
    tickmarks: tableRows(tables, 'tickmark_library').map((r) => ({ id: Number(r.id), symbol: String(r.symbol) })),
    documents: tableRows(tables, 'client_documents').map((r) => ({ id: Number(r.id), sha256: (r.sha256 as string | null) ?? null })),
    bankTransactions: tableRows(tables, 'bank_transactions').map((r) => ({ id: Number(r.id), sync_uid: String(r.sync_uid) })),
    fsLayouts: tableRows(tables, 'fs_client_layouts'),
    rows: Object.fromEntries(STAMP_TABLES.map((t) => [t, t === 'bank_transactions'
      ? tableRows(tables, t).filter((r) => Number(r.period_id) === ownPeriodId)
      : tableRows(tables, t)])),
  };
}

/** Each row of `table` as its own stamp, with its sync_uid when it has one. */
function rowStamps(input: PeriodStampInput, table: StampTable): Array<{ uid: string | null; stamp: string }> {
  return (input.rows[table] ?? []).map((r) => ({
    uid: typeof r.sync_uid === 'string' ? r.sync_uid : null,
    stamp: periodStamp({ ...input, rows: { [table]: [r] } }),
  }));
}

/** Rows added, removed and changed in one table (changed: the same sync_uid, other contents). */
export function tableChanges(before: PeriodStampInput, after: PeriodStampInput, table: StampTable): { added: number; removed: number; changed: number } {
  const a = rowStamps(before, table);
  const b = rowStamps(after, table);
  const left = new Map<string, number>();
  for (const r of a) left.set(r.stamp, (left.get(r.stamp) ?? 0) + 1);
  const onlyAfter: typeof b = [];
  for (const r of b) {
    const n = left.get(r.stamp) ?? 0;
    if (n > 0) left.set(r.stamp, n - 1);
    else onlyAfter.push(r);
  }
  const onlyBefore = a.filter((r) => {
    const n = left.get(r.stamp) ?? 0;
    if (n > 0) { left.set(r.stamp, n - 1); return true; }
    return false;
  });
  const beforeUids = new Set(onlyBefore.map((r) => r.uid).filter((u): u is string => u !== null));
  const changed = onlyAfter.filter((r) => r.uid !== null && beforeUids.has(r.uid)).length;
  return { added: onlyAfter.length - changed, removed: onlyBefore.length - changed, changed };
}
