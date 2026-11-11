// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// GET /api/v1/desktop/clients/summary
//
// One row per period of every active client: the figures the desktop Clients
// screen shows beside each engagement (Q16). Upstream has no such route (its
// web dashboard is per client), so the desktop app would otherwise have to
// work them out itself, which CLAUDE.md rule 1 forbids. Read-only, computed
// from upstream tables only: nothing desktop-specific goes into a .tbak.
//
//   status        not_started  nothing on the trial balance yet (no balance,
//                              no entry on any account)
//                 ready_for_review  a live reviewer sign-off on a lead sheet,
//                              or engagement tasks exist and all are done
//                 in_progress  anything else
//   (upstream records no tax-software exports, so "Exported to …" is left
//   out until it does)
//   book_net / tax_net   adjusted debits less credits, cents (0 = in balance)
//   aje_count            book and tax adjusting entries
//   last_worked          newest change to the trial balance, an entry or a task

import { Router, type Response } from 'express';
import { db } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { centsFromSum } from './tbTotals';

export type EngagementStatus = 'not_started' | 'in_progress' | 'ready_for_review';

export interface StatusInputs {
  hasActivity: boolean;
  reviewerSigned: boolean;
  tasksTotal: number;
  tasksDone: number;
}

export function statusOf(s: StatusInputs): EngagementStatus {
  if (!s.hasActivity) return 'not_started';
  if (s.reviewerSigned || (s.tasksTotal > 0 && s.tasksDone === s.tasksTotal)) return 'ready_for_review';
  return 'in_progress';
}

export interface PeriodSummary {
  client_id: number;
  period_id: number;
  status: EngagementStatus;
  account_count: number;
  book_net: number;
  tax_net: number;
  book_in_balance: boolean;
  tax_in_balance: boolean;
  aje_count: number;
  last_worked: string | null;
}

/** One row of the summary query → the answer. */
export function summaryFromRow(r: Record<string, unknown>): PeriodSummary {
  const bookNet = centsFromSum(r.book_net);
  const taxNet = centsFromSum(r.tax_net);
  const lastWorked = r.last_worked == null ? null : new Date(r.last_worked as string | Date).toISOString();
  return {
    client_id: Number(r.client_id),
    period_id: Number(r.period_id),
    status: statusOf({
      hasActivity: Number(r.active_accounts ?? 0) > 0 || Number(r.entry_count ?? 0) > 0,
      reviewerSigned: Number(r.reviewer_signoffs ?? 0) > 0,
      tasksTotal: Number(r.tasks_total ?? 0),
      tasksDone: Number(r.tasks_done ?? 0),
    }),
    account_count: Number(r.account_count ?? 0),
    book_net: bookNet,
    tax_net: taxNet,
    book_in_balance: bookNet === 0,
    tax_in_balance: taxNet === 0,
    aje_count: Number(r.aje_count ?? 0),
    last_worked: lastWorked,
  };
}

const SUMMARY_SQL = `
  SELECT p.client_id, p.id AS period_id,
         COALESCE(tb.account_count, 0)  AS account_count,
         COALESCE(tb.active_accounts, 0) AS active_accounts,
         COALESCE(tb.book_net, 0) AS book_net,
         COALESCE(tb.tax_net, 0)  AS tax_net,
         COALESCE(je.aje_count, 0)   AS aje_count,
         COALESCE(je.entry_count, 0) AS entry_count,
         COALESCE(so.reviewer_signoffs, 0) AS reviewer_signoffs,
         COALESCE(et.tasks_total, 0) AS tasks_total,
         COALESCE(et.tasks_done, 0)  AS tasks_done,
         GREATEST(tbu.last_tb, je.last_je, et.last_task) AS last_worked
    FROM periods p
    JOIN clients c ON c.id = p.client_id AND c.is_active = true
    LEFT JOIN (
      SELECT period_id,
             count(*) AS account_count,
             count(*) FILTER (WHERE unadjusted_debit <> 0 OR unadjusted_credit <> 0
                                 OR trans_adj_debit <> 0 OR trans_adj_credit <> 0
                                 OR book_adj_debit <> 0 OR book_adj_credit <> 0
                                 OR tax_adj_debit <> 0 OR tax_adj_credit <> 0) AS active_accounts,
             sum(book_adjusted_debit) - sum(book_adjusted_credit) AS book_net,
             sum(tax_adjusted_debit) - sum(tax_adjusted_credit) AS tax_net
        FROM v_adjusted_trial_balance
       WHERE is_active = true
       GROUP BY period_id
    ) tb ON tb.period_id = p.id
    LEFT JOIN (
      SELECT period_id, max(updated_at) AS last_tb FROM trial_balance GROUP BY period_id
    ) tbu ON tbu.period_id = p.id
    LEFT JOIN (
      SELECT period_id,
             count(*) FILTER (WHERE entry_type IN ('book', 'tax')) AS aje_count,
             count(*) AS entry_count,
             max(updated_at) AS last_je
        FROM journal_entries
       GROUP BY period_id
    ) je ON je.period_id = p.id
    LEFT JOIN (
      SELECT period_id, count(*) AS reviewer_signoffs
        FROM lead_sheet_signoffs
       WHERE role = 'reviewer' AND invalidated_at IS NULL
       GROUP BY period_id
    ) so ON so.period_id = p.id
    LEFT JOIN (
      SELECT period_id,
             count(*) AS tasks_total,
             count(*) FILTER (WHERE status IN ('completed', 'n_a')) AS tasks_done,
             max(updated_at) AS last_task
        FROM engagement_tasks
       GROUP BY period_id
    ) et ON et.period_id = p.id
   ORDER BY p.client_id, p.id`;

export const desktopClientSummaryRouter = Router();

desktopClientSummaryRouter.get('/desktop/clients/summary', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await db.raw(SUMMARY_SQL);
    const rows = (result as { rows: Record<string, unknown>[] }).rows;
    res.json({ data: rows.map(summaryFromRow), error: null, meta: { count: rows.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop/clientSummary');
  }
});
