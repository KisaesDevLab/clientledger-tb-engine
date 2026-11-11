// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// GET /api/v1/desktop/periods/:periodId/trial-balance/totals
//
// The column totals of GET /periods/:periodId/trial-balance, added up by
// PostgreSQL over exactly the rows that route returns (v_adjusted_trial_balance,
// active accounts). The desktop grid adds its rows for display and checks them
// against these to the penny (the engine is the source of truth for every
// number); upstream has no totals route because its React grid adds in the
// browser. Read-only, no desktop data: nothing here goes into a .tbak.

import { Router, type Response } from 'express';
import { db } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';

/** Every debit/credit pair on the view, in the order the grid shows them. */
export const STAGES = [
  'unadjusted',
  'trans_adj',
  'book_adj',
  'tax_adj',
  'book_adjusted',
  'tax_adjusted',
  'prior_year',
] as const;

export type Stage = (typeof STAGES)[number];

export interface TbTotals {
  period_id: number;
  account_count: number;
  /** stage → { debit, credit } in cents. */
  stages: Record<Stage, { debit: number; credit: number }>;
  unadjusted_in_balance: boolean;
  book_in_balance: boolean;
  tax_in_balance: boolean;
}

/**
 * A SUM over BIGINT comes back from pg as a numeric string. Cents stay exact
 * as a JSON number up to 2^53 (about $90 trillion); past that this throws
 * rather than answer a rounded total.
 */
export function centsFromSum(value: unknown): number {
  const big = BigInt(value === null || value === undefined ? 0 : String(value));
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('trial balance total out of range');
  }
  return Number(big);
}

/** The totals answer from one row of sums (`<stage>_debit`, `<stage>_credit`, `account_count`). */
export function totalsFromSums(periodId: number, sums: Record<string, unknown>): TbTotals {
  const stages = {} as TbTotals['stages'];
  for (const s of STAGES) {
    stages[s] = { debit: centsFromSum(sums[`${s}_debit`]), credit: centsFromSum(sums[`${s}_credit`]) };
  }
  return {
    period_id: periodId,
    account_count: centsFromSum(sums.account_count),
    stages,
    unadjusted_in_balance: stages.unadjusted.debit === stages.unadjusted.credit,
    book_in_balance: stages.book_adjusted.debit === stages.book_adjusted.credit,
    tax_in_balance: stages.tax_adjusted.debit === stages.tax_adjusted.credit,
  };
}

export const desktopTbRouter = Router();

desktopTbRouter.get('/desktop/periods/:periodId/trial-balance/totals', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (!Number.isInteger(periodId) || periodId < 1) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  try {
    const period = await db('periods').where({ id: periodId }).first('id');
    if (!period) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }
    const sums: Record<string, unknown> = await db('v_adjusted_trial_balance')
      .where({ period_id: periodId, is_active: true })
      .first(
        db.raw('count(*) as account_count'),
        ...STAGES.flatMap((s) => [
          db.raw('coalesce(sum(??), 0) as ??', [`${s}_debit`, `${s}_debit`]),
          db.raw('coalesce(sum(??), 0) as ??', [`${s}_credit`, `${s}_credit`]),
        ]),
      );
    res.json({ data: totalsFromSums(periodId, sums ?? {}), error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop/tbTotals');
  }
});
