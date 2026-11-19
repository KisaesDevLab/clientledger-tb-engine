// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { referenceError } from '../lib/periodGuard';
import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { logAudit } from '../lib/periodGuard';
import { ensureTrialBalanceRows } from '../lib/ensureTrialBalanceRows';
import { sendServerError } from '../lib/safeError';

export const rollForwardRouter = Router({ mergeParams: true });
rollForwardRouter.use(authMiddleware);

// POST /api/v1/periods/:id/roll-forward
rollForwardRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const sourceId = Number(req.params.id);
  if (isNaN(sourceId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }

  const schema = z.object({
    periodName: z.string().min(1).max(100),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    isCurrent: z.boolean().optional(),
    copyRecurringJEs: z.boolean().optional().default(true),
    mode: z.enum(['all_balances', 'close_income', 'zero_balances']).optional().default('all_balances'),
    retainedEarningsAccountId: z.number().int().positive().optional(),
    keepWorkpaperRefs: z.boolean().optional().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }

  const { periodName, startDate, endDate, isCurrent, copyRecurringJEs, mode, retainedEarningsAccountId, keepWorkpaperRefs } = parsed.data;

  if (mode === 'close_income' && !retainedEarningsAccountId) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Retained earnings account is required when closing income to equity.' } });
    return;
  }

  try {
    const result = await db.transaction(async (trx): Promise<{ kind: 'not_found' } | { kind: 'unbalanced'; diff: string } | { kind: 'ok'; row: Record<string, unknown> }> => {
      // Lock the source period row inside the trx so concurrent JE writes against it
      // can't land between our balance check and the roll-forward copy.
      const sourcePeriod = await trx('periods').where({ id: sourceId }).forUpdate().first();
      if (!sourcePeriod) return { kind: 'not_found' };
      // A reference period (desktop sync) has no balances to roll forward.
      if (sourcePeriod.is_reference) throw referenceError();

      // ── Pre-check: source period TB must be in balance. Use BigInt to avoid
      //    precision loss on very large firm aggregates.
      const sourceCheck = await trx('v_adjusted_trial_balance').where({ period_id: sourceId });
      if (sourceCheck.length > 0) {
        let srcDr = 0n;
        let srcCr = 0n;
        for (const r of sourceCheck as Record<string, unknown>[]) {
          srcDr += BigInt((r.book_adjusted_debit ?? 0) as number | string);
          srcCr += BigInt((r.book_adjusted_credit ?? 0) as number | string);
        }
        if (srcDr !== srcCr) {
          const diffCents = srcDr > srcCr ? srcDr - srcCr : srcCr - srcDr;
          return { kind: 'unbalanced', diff: (Number(diffCents) / 100).toFixed(2) };
        }
      }

      // Clear current flag if needed
      if (isCurrent) {
        await trx('periods').where({ client_id: sourcePeriod.client_id }).update({ is_current: false });
      }

      // Create new period (convert empty date strings to null for PostgreSQL date column)
      const [period] = await trx('periods').insert({
        client_id: sourcePeriod.client_id,
        period_name: periodName,
        start_date: startDate?.trim() || null,
        end_date: endDate?.trim() || null,
        is_current: isCurrent ?? false,
        rolled_forward_from: sourceId,
      }).returning('*');

      // ── Roll-forward TB rows based on selected mode ──────────────────────
      type TBViewRow = { account_id: number; book_adjusted_debit: string | number; book_adjusted_credit: string | number };
      const tbRows: TBViewRow[] = await trx('v_adjusted_trial_balance').where({ period_id: sourceId });

      // Load account categories for mode-aware filtering
      const accountIds = tbRows.map((r) => r.account_id);
      const accountCategories = accountIds.length > 0
        ? await trx('chart_of_accounts').whereIn('id', accountIds).select('id', 'category')
        : [];
      const catMap = new Map<number, string>(accountCategories.map((a: { id: number; category: string }) => [a.id, a.category]));
      const BS_CATEGORIES = new Set(['assets', 'liabilities', 'equity']);

      if (mode === 'zero_balances') {
        // Mode 3: Create rows with zero balances for all accounts
        if (tbRows.length > 0) {
          await trx('trial_balance').insert(
            tbRows.map((r) => ({
              period_id: period.id,
              account_id: r.account_id,
              unadjusted_debit: 0,
              unadjusted_credit: 0,
              prior_year_debit: Number(r.book_adjusted_debit),
              prior_year_credit: Number(r.book_adjusted_credit),
              updated_by: req.user!.userId,
            })),
          );
        }
      } else if (mode === 'close_income') {
        // Mode 2: Roll balance sheet accounts forward; close revenue/expense
        // net to the retained earnings account.
        // First, validate the user-supplied RE account: it must exist on this
        // client, be active, and live in the equity category. Otherwise we'd
        // silently close net income into (say) an AR account.
        if (!retainedEarningsAccountId) {
          throw new Error('retainedEarningsAccountId is required for close_income mode');
        }
        const reAccount = await trx('chart_of_accounts')
          .where({ id: retainedEarningsAccountId, client_id: sourcePeriod.client_id, is_active: true })
          .first('id', 'category');
        if (!reAccount) {
          throw new Error(`Retained earnings account ${retainedEarningsAccountId} not found on this client`);
        }
        if (reAccount.category !== 'equity') {
          throw new Error(`Retained earnings account must be in the 'equity' category (got '${reAccount.category}')`);
        }

        const bsInserts: { period_id: number; account_id: number; unadjusted_debit: number; unadjusted_credit: number; prior_year_debit: number; prior_year_credit: number; updated_by: number }[] = [];
        let netIncomeDebit = 0;
        let netIncomeCredit = 0;

        for (const r of tbRows) {
          const cat = catMap.get(r.account_id) ?? 'expenses';
          const adjDebit = Number(r.book_adjusted_debit);
          const adjCredit = Number(r.book_adjusted_credit);

          if (BS_CATEGORIES.has(cat)) {
            // Balance sheet: carry forward
            bsInserts.push({
              period_id: period.id,
              account_id: r.account_id,
              unadjusted_debit: adjDebit,
              unadjusted_credit: adjCredit,
              prior_year_debit: adjDebit,
              prior_year_credit: adjCredit,
              updated_by: req.user!.userId,
            });
          } else {
            // Income statement: accumulate net income (credit - debit)
            netIncomeDebit += adjDebit;
            netIncomeCredit += adjCredit;
            // Create zero-balance rows so accounts appear in new period
            bsInserts.push({
              period_id: period.id,
              account_id: r.account_id,
              unadjusted_debit: 0,
              unadjusted_credit: 0,
              prior_year_debit: adjDebit,
              prior_year_credit: adjCredit,
              updated_by: req.user!.userId,
            });
          }
        }

        // Close net income to retained earnings account
        const netIncome = netIncomeCredit - netIncomeDebit; // positive = profit
        const reAccountId = retainedEarningsAccountId!;
        const existingRE = bsInserts.find((r) => r.account_id === reAccountId);
        if (existingRE) {
          // Add net income to existing RE row
          if (netIncome >= 0) {
            existingRE.unadjusted_credit += netIncome;
          } else {
            existingRE.unadjusted_debit += Math.abs(netIncome);
          }
        } else {
          // RE account not in source TB — create it
          bsInserts.push({
            period_id: period.id,
            account_id: reAccountId,
            unadjusted_debit: netIncome < 0 ? Math.abs(netIncome) : 0,
            unadjusted_credit: netIncome >= 0 ? netIncome : 0,
            prior_year_debit: 0,
            prior_year_credit: 0,
            updated_by: req.user!.userId,
          });
        }

        if (bsInserts.length > 0) {
          await trx('trial_balance').insert(bsInserts);
        }
      } else {
        // Mode 1 (default): Roll ALL balances forward as-is
        if (tbRows.length > 0) {
          await trx('trial_balance').insert(
            tbRows.map((r) => ({
              period_id: period.id,
              account_id: r.account_id,
              unadjusted_debit: Number(r.book_adjusted_debit),
              unadjusted_credit: Number(r.book_adjusted_credit),
              prior_year_debit: Number(r.book_adjusted_debit),
              prior_year_credit: Number(r.book_adjusted_credit),
              updated_by: req.user!.userId,
            })),
          );
        }
      }

      // Copy tickmark assignments
      // Lead sheets need no copy step here. Membership lives on the
      // chart_of_accounts row, which is client-scoped and shared across
      // periods, so it carries forward on its own. Sign-offs are keyed by
      // period, so the new period correctly starts unsigned — evidence must
      // never roll forward. keepWorkpaperRefs deliberately does NOT clear
      // lead_sheet_id either: a W/P ref is a per-year annotation, a lead sheet
      // is structure.
      const tbTickmarks = await trx('tb_tickmarks').where({ period_id: sourceId });
      if (tbTickmarks.length > 0) {
        await trx('tb_tickmarks').insert(
          tbTickmarks.map((tm: { account_id: number; tickmark_id: number }) => ({
            period_id: period.id,
            account_id: tm.account_id,
            tickmark_id: tm.tickmark_id,
            created_by: req.user!.userId,
          }))
        );
      }

      // Optionally clear workpaper references on COA accounts
      if (!keepWorkpaperRefs) {
        await trx('chart_of_accounts')
          .where({ client_id: sourcePeriod.client_id, is_active: true })
          .whereNotNull('workpaper_ref')
          .update({ workpaper_ref: null, updated_at: trx.fn.now() });
      }

      // Copy recurring JEs
      let jeCopied = 0;
      if (copyRecurringJEs) {
        const recurringJEs = await trx('journal_entries')
          .where({ period_id: sourceId, is_recurring: true })
          .whereIn('entry_type', ['book', 'tax']);

        for (const je of recurringJEs) {
          const lines = await trx('journal_entry_lines').where({ journal_entry_id: je.id });
          if (lines.length === 0) continue;

          const lastEntry = await trx('journal_entries')
            .where({ period_id: period.id, entry_type: je.entry_type })
            .max('entry_number as max').first();
          const entryNumber = (lastEntry?.max ?? 0) + 1;

          const jeDate = startDate ?? new Date().toISOString().slice(0, 10);
          const [newJe] = await trx('journal_entries').insert({
            period_id: period.id,
            entry_number: entryNumber,
            entry_type: je.entry_type,
            entry_date: jeDate,
            description: je.description,
            is_recurring: true,
            created_by: req.user!.userId,
          }).returning('*');

          await trx('journal_entry_lines').insert(
            lines.map((l: { account_id: number; debit: string | number; credit: string | number }) => ({
              journal_entry_id: newJe.id,
              account_id: l.account_id,
              debit: Number(l.debit),
              credit: Number(l.credit),
            })),
          );

          // Ensure trial_balance rows exist for all referenced accounts
          await ensureTrialBalanceRows(trx, period.id, lines.map((l: { account_id: number }) => l.account_id));
          jeCopied++;
        }
      }

      // ── Post-check: new period TB must be in balance ──────────────────
      const newTbCheck = await trx('v_adjusted_trial_balance').where({ period_id: period.id });
      if (newTbCheck.length > 0) {
        let newDr = 0n;
        let newCr = 0n;
        for (const r of newTbCheck as Record<string, unknown>[]) {
          newDr += BigInt((r.book_adjusted_debit ?? 0) as number | string);
          newCr += BigInt((r.book_adjusted_credit ?? 0) as number | string);
        }
        if (newDr !== newCr) {
          const diffCents = newDr > newCr ? newDr - newCr : newCr - newDr;
          const diff = (Number(diffCents) / 100).toFixed(2);
          throw Object.assign(
            new Error(`Rolled-forward period is out of balance by $${diff}. This may indicate a data issue — the roll forward has been cancelled.`),
            { code: 'TB_OUT_OF_BALANCE', status: 409 },
          );
        }
      }

      await logAudit({
        userId: req.user!.userId,
        periodId: period.id,
        entityType: 'period',
        entityId: period.id,
        action: 'create',
        description: `Rolled forward from "${sourcePeriod.period_name}" (mode: ${mode}) — ${tbRows.length} TB accounts, ${jeCopied} recurring JEs, ${tbTickmarks.length} tickmark assignments copied`,
      }, trx);

      return { kind: 'ok', row: { period, tbCount: tbRows.length, jeCopied } as Record<string, unknown> };
    });

    if (result.kind === 'not_found') {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Source period not found' } });
      return;
    }
    if (result.kind === 'unbalanced') {
      res.status(409).json({ data: null, error: { code: 'TB_OUT_OF_BALANCE', message: `Source period trial balance is out of balance by $${result.diff}. Resolve before rolling forward.` } });
      return;
    }
    res.status(201).json({ data: result.row, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'TB_OUT_OF_BALANCE') {
      res.status(409).json({ data: null, error: { code: 'TB_OUT_OF_BALANCE', message: e.message ?? 'Trial balance is out of balance.' } });
      return;
    }
    sendServerError(res, err, 'roll-forward');
  }
});
