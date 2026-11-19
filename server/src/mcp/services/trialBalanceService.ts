// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { db } from '../../db';
import { assertPeriodUnlocked } from '../../lib/periodGuard';

function parseBigInt(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

export interface TBRow {
  account_id: number;
  account_number: string;
  account_name: string;
  category: string;
  normal_balance: string;
  unadjusted_debit_dollars: string;
  unadjusted_credit_dollars: string;
  book_adjusted_debit_dollars: string;
  book_adjusted_credit_dollars: string;
  tax_adjusted_debit_dollars: string;
  tax_adjusted_credit_dollars: string;
  tax_line: string | null;
}

export interface TBSummary {
  rows: TBRow[];
  totals: {
    unadjusted_debit_dollars: string;
    unadjusted_credit_dollars: string;
    book_adjusted_debit_dollars: string;
    book_adjusted_credit_dollars: string;
    is_balanced: boolean;
    out_of_balance_dollars: string;
  };
}

export async function getTrialBalance(periodId: number, category?: string): Promise<TBSummary> {
  let q = db('v_adjusted_trial_balance')
    .where({ period_id: periodId, is_active: true });

  if (category) q = q.where({ category });

  const rows = await q.orderBy('account_number', 'asc');

  const mapped: TBRow[] = rows.map((r: Record<string, unknown>) => ({
    account_id: r.account_id as number,
    account_number: r.account_number as string,
    account_name: r.account_name as string,
    category: r.category as string,
    normal_balance: r.normal_balance as string,
    unadjusted_debit_dollars: (parseBigInt(r.unadjusted_debit) / 100).toFixed(2),
    unadjusted_credit_dollars: (parseBigInt(r.unadjusted_credit) / 100).toFixed(2),
    book_adjusted_debit_dollars: (parseBigInt(r.book_adjusted_debit) / 100).toFixed(2),
    book_adjusted_credit_dollars: (parseBigInt(r.book_adjusted_credit) / 100).toFixed(2),
    tax_adjusted_debit_dollars: (parseBigInt(r.tax_adjusted_debit) / 100).toFixed(2),
    tax_adjusted_credit_dollars: (parseBigInt(r.tax_adjusted_credit) / 100).toFixed(2),
    tax_line: r.tax_line as string | null,
  }));

  const totalUnadjDr = rows.reduce((s: number, r: Record<string, unknown>) => s + parseBigInt(r.unadjusted_debit), 0);
  const totalUnadjCr = rows.reduce((s: number, r: Record<string, unknown>) => s + parseBigInt(r.unadjusted_credit), 0);
  const totalBkDr = rows.reduce((s: number, r: Record<string, unknown>) => s + parseBigInt(r.book_adjusted_debit), 0);
  const totalBkCr = rows.reduce((s: number, r: Record<string, unknown>) => s + parseBigInt(r.book_adjusted_credit), 0);
  const diff = Math.abs(totalBkDr - totalBkCr);

  return {
    rows: mapped,
    totals: {
      unadjusted_debit_dollars: (totalUnadjDr / 100).toFixed(2),
      unadjusted_credit_dollars: (totalUnadjCr / 100).toFixed(2),
      book_adjusted_debit_dollars: (totalBkDr / 100).toFixed(2),
      book_adjusted_credit_dollars: (totalBkCr / 100).toFixed(2),
      is_balanced: diff === 0,
      out_of_balance_dollars: (diff / 100).toFixed(2),
    },
  };
}

export async function upsertTrialBalance(
  periodId: number,
  accountId: number,
  debitCents: number,
  creditCents: number,
  userId: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    // In one transaction, so the guard's row lock holds until the write is in
    // (a desktop's check-out cannot slip between them).
    await db.transaction(async (trx) => {
      await assertPeriodUnlocked(periodId, trx);
      await trx('trial_balance')
        .insert({
          period_id: periodId,
          account_id: accountId,
          unadjusted_debit: debitCents,
          unadjusted_credit: creditCents,
          updated_by: userId,
          updated_at: trx.fn.now(),
        })
        .onConflict(['period_id', 'account_id'])
        .merge(['unadjusted_debit', 'unadjusted_credit', 'updated_by', 'updated_at']);
    });
    return { success: true };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'PERIOD_LOCKED') return { success: false, error: e.message };
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
