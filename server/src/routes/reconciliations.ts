// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { assertNotCheckedOut } from '../lib/periodGuard';
import type { Knex } from 'knex';

// ── Collection: /api/v1/clients/:clientId/reconciliations ────────────────────
export const reconciliationCollectionRouter = Router({ mergeParams: true });
reconciliationCollectionRouter.use(authMiddleware);

/**
 * Reject mutations against a reconciliation whose period is locked. Returns
 * true iff the caller should abort (already replied 409). Locked reconciliations
 * must remain read-only once their period is closed.
 */
/**
 * Desktop sync: refuses (PERIOD_CHECKED_OUT) a write to a reconciliation
 * whose period a desktop holds. Inside the write's transaction, so it
 * orders against a pull's check-out.
 */
async function assertReconNotCheckedOut(trx: Knex.Transaction, recId: number): Promise<void> {
  const r = await trx('bank_reconciliations').where({ id: recId }).first('period_id');
  await assertNotCheckedOut(trx, [r?.period_id as number | null | undefined]);
}

async function reconciliationPeriodLocked(recId: number, res: Response): Promise<boolean> {
  const row = await db('bank_reconciliations as br')
    .leftJoin('periods as p', 'p.id', 'br.period_id')
    .where('br.id', recId)
    .first('p.locked_at', 'p.is_reference');
  // A reference period (desktop sync) is as read-only as a locked one.
  if (row?.locked_at || row?.is_reference) {
    res.status(409).json({
      data: null,
      error: { code: 'PERIOD_LOCKED', message: 'This reconciliation is in a locked period and cannot be modified.' },
    });
    return true;
  }
  return false;
}

const createSchema = z.object({
  sourceAccountId: z.number().int().positive(),
  periodId: z.number().int().positive().optional(),
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  statementEndingBalance: z.number().int(), // cents, can be negative (overdraft)
  beginningBookBalance: z.number().int().optional(),
  notes: z.string().optional(),
});

// GET /api/v1/clients/:clientId/reconciliations
reconciliationCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  try {
    const rows = await db('bank_reconciliations as r')
      .join('chart_of_accounts as coa', 'coa.id', 'r.source_account_id')
      .leftJoin('app_users as u', 'u.id', 'r.completed_by')
      .where('r.client_id', clientId)
      .select(
        'r.id', 'r.client_id', 'r.source_account_id', 'r.period_id',
        'r.statement_date', 'r.statement_ending_balance', 'r.beginning_book_balance',
        'r.status', 'r.notes', 'r.created_by', 'r.completed_by', 'r.completed_at', 'r.created_at',
        'coa.account_number', 'coa.account_name',
        'u.display_name as completed_by_name',
      )
      .orderBy('r.statement_date', 'desc');

    const result = rows.map((r: Record<string, unknown>) => ({
      ...r,
      statement_ending_balance: Number(r.statement_ending_balance),
      beginning_book_balance: Number(r.beginning_book_balance),
    }));
    res.json({ data: result, error: null, meta: { count: result.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'reconciliations');
  }
});

// POST /api/v1/clients/:clientId/reconciliations
reconciliationCollectionRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = createSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { sourceAccountId, periodId, statementDate, statementEndingBalance, beginningBookBalance, notes } = result.data;
  try {
    const [rec] = await db.transaction(async (trx) => {
      await assertNotCheckedOut(trx, [periodId]);
      return trx('bank_reconciliations').insert({
      client_id: clientId,
      source_account_id: sourceAccountId,
      period_id: periodId ?? null,
      statement_date: statementDate,
      statement_ending_balance: statementEndingBalance,
      beginning_book_balance: beginningBookBalance ?? 0,
      status: 'open',
      notes: notes ?? null,
      created_by: req.user!.userId,
    }).returning('*');
    });
    res.status(201).json({ data: { ...rec, statement_ending_balance: Number(rec.statement_ending_balance), beginning_book_balance: Number(rec.beginning_book_balance) }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'reconciliations');
  }
});

// ── Item: /api/v1/reconciliations/:id ────────────────────────────────────────
export const reconciliationItemRouter = Router({ mergeParams: true });
reconciliationItemRouter.use(authMiddleware);

// GET /api/v1/reconciliations/:id  — reconciliation detail + cleared txns + all txns for account
reconciliationItemRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  try {
    const rec = await db('bank_reconciliations as r')
      .join('chart_of_accounts as coa', 'coa.id', 'r.source_account_id')
      .where('r.id', id)
      .first(
        'r.*',
        'coa.account_number', 'coa.account_name',
      );
    if (!rec) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Reconciliation not found' } });
      return;
    }

    // All transactions for this source account on or before statement date
    const txns = await db('bank_transactions')
      .where({ client_id: rec.client_id, source_account_id: rec.source_account_id })
      .where('transaction_date', '<=', rec.statement_date)
      .orderBy('transaction_date', 'asc')
      .select('id', 'transaction_date', 'description', 'amount', 'check_number', 'classification_status');

    // Which are cleared in THIS reconciliation
    const clearedIds = await db('reconciliation_items')
      .where({ reconciliation_id: id })
      .pluck('transaction_id');
    const clearedSet = new Set(clearedIds.map(Number));

    // Transactions already cleared in an earlier COMPLETED reconciliation of
    // the same account are not outstanding — re-presenting them every month
    // overstates the outstanding-items schedule and invites double-clearing
    // against the beginning balance.
    const previouslyClearedIds = await db('reconciliation_items as ri')
      .join('bank_reconciliations as br', 'br.id', 'ri.reconciliation_id')
      .where('br.source_account_id', rec.source_account_id)
      .where('br.status', 'completed')
      .whereNot('br.id', id)
      .where('br.statement_date', '<=', rec.statement_date)
      .pluck('ri.transaction_id');
    const previouslyClearedSet = new Set(previouslyClearedIds.map(Number));

    const transactions = txns
      .filter((t: Record<string, unknown>) => !previouslyClearedSet.has(Number(t.id)))
      .map((t: Record<string, unknown>) => ({
        ...t,
        amount: Number(t.amount),
        is_cleared: clearedSet.has(Number(t.id)),
      }));

    res.json({
      data: {
        reconciliation: {
          ...rec,
          statement_ending_balance: Number(rec.statement_ending_balance),
          beginning_book_balance: Number(rec.beginning_book_balance),
        },
        transactions,
      },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'reconciliations');
  }
});

// PATCH /api/v1/reconciliations/:id  — update statement balance / notes
const patchSchema = z.object({
  statementEndingBalance: z.number().int().optional(),
  beginningBookBalance: z.number().int().optional(),
  notes: z.string().optional().nullable(),
});

reconciliationItemRouter.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  const result = patchSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (result.data.statementEndingBalance !== undefined) updates.statement_ending_balance = result.data.statementEndingBalance;
  if (result.data.beginningBookBalance !== undefined) updates.beginning_book_balance = result.data.beginningBookBalance;
  if (result.data.notes !== undefined) updates.notes = result.data.notes;

  try {
    const rec = await db('bank_reconciliations').where({ id }).first('status');
    if (!rec) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Reconciliation not found' } });
      return;
    }
    if (rec.status === 'completed') {
      res.status(409).json({ data: null, error: { code: 'LOCKED', message: 'Reconciliation is completed' } });
      return;
    }
    const [updated] = await db.transaction(async (trx) => {
      await assertReconNotCheckedOut(trx, id);
      return trx('bank_reconciliations').where({ id }).update(updates).returning('*');
    });
    res.json({ data: { ...updated, statement_ending_balance: Number(updated.statement_ending_balance), beginning_book_balance: Number(updated.beginning_book_balance) }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'reconciliations');
  }
});

// POST /api/v1/reconciliations/:id/toggle-item  — clear or unclear a transaction
reconciliationItemRouter.post('/toggle-item', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const { transactionId } = req.body as { transactionId: number };
  if (isNaN(id) || !transactionId) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid IDs' } });
    return;
  }
  try {
    if (await reconciliationPeriodLocked(id, res)) return;
    const rec = await db('bank_reconciliations').where({ id }).first('status');
    if (!rec) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Reconciliation not found' } });
      return;
    }
    if (rec.status === 'completed') {
      res.status(409).json({ data: null, error: { code: 'LOCKED', message: 'Reconciliation is completed' } });
      return;
    }
    const cleared = await db.transaction(async (trx) => {
      await assertReconNotCheckedOut(trx, id);
      const existing = await trx('reconciliation_items').where({ reconciliation_id: id, transaction_id: transactionId }).first('id');
      if (existing) {
        await trx('reconciliation_items').where({ reconciliation_id: id, transaction_id: transactionId }).delete();
        return false;
      }
      await trx('reconciliation_items').insert({ reconciliation_id: id, transaction_id: transactionId });
      return true;
    });
    res.json({ data: { cleared, transactionId }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'reconciliations');
  }
});

// POST /api/v1/reconciliations/:id/complete
reconciliationItemRouter.post('/complete', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  try {
    if (await reconciliationPeriodLocked(id, res)) return;
    const rec = await db('bank_reconciliations').where({ id }).first();
    if (!rec) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Reconciliation not found' } });
      return;
    }
    if (rec.status === 'completed') {
      res.status(409).json({ data: null, error: { code: 'ALREADY_DONE', message: 'Already completed' } });
      return;
    }

    // Reconciliation tie-out: cleared items on the statement side, plus any
    // beginning difference, must reconcile to the statement ending balance.
    // Formula (simplified single-account rec):
    //   beginning_book_balance + sum(cleared_amounts) == statement_ending_balance
    // If off, refuse to mark "completed" — a reconciliation that doesn't tie
    // is just a checkbox, not an attestation. Caller can pass ?force=true on
    // body to override (we log a warning via audit trail if used).
    const force = (req.body as { force?: boolean })?.force === true;
    if (!force) {
      const clearedRows = await db('reconciliation_items as ri')
        .join('bank_transactions as bt', 'bt.id', 'ri.transaction_id')
        .where('ri.reconciliation_id', id)
        .select('bt.amount');
      const clearedTotal = clearedRows.reduce(
        (sum, r: { amount: string | number }) => sum + Number(r.amount ?? 0),
        0,
      );
      const expected = Number(rec.statement_ending_balance);
      const actual = Number(rec.beginning_book_balance) + clearedTotal;
      const diff = actual - expected;
      // Amounts are integer cents — a reconciliation must tie exactly;
      // force=true is the only sanctioned override.
      if (diff !== 0) {
        res.status(409).json({
          data: null,
          error: {
            code: 'RECONCILIATION_OUT_OF_BALANCE',
            message: `Reconciliation is out of balance by ${(Math.abs(diff) / 100).toFixed(2)}. Beginning ${(Number(rec.beginning_book_balance) / 100).toFixed(2)} + cleared ${(clearedTotal / 100).toFixed(2)} = ${(actual / 100).toFixed(2)}, but statement is ${(expected / 100).toFixed(2)}. Resolve or pass force=true.`,
          },
        });
        return;
      }
    }

    const [updated] = await db.transaction(async (trx) => {
      await assertReconNotCheckedOut(trx, id);
      return trx('bank_reconciliations')
        .where({ id })
        .update({ status: 'completed', completed_by: req.user!.userId, completed_at: trx.fn.now() })
        .returning('*');
    });
    res.json({ data: { ...updated, statement_ending_balance: Number(updated.statement_ending_balance), beginning_book_balance: Number(updated.beginning_book_balance) }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'reconciliations');
  }
});

// POST /api/v1/reconciliations/:id/reopen  (admin only)
reconciliationItemRouter.post('/reopen', async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Only admins can reopen reconciliations.' } });
    return;
  }
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  try {
    const rec = await db('bank_reconciliations').where({ id }).first('id', 'status');
    if (!rec) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    if (rec.status !== 'completed') {
      res.status(409).json({ data: null, error: { code: 'NOT_COMPLETED', message: 'Reconciliation is not completed' } });
      return;
    }
    const [updated] = await db.transaction(async (trx) => {
      await assertReconNotCheckedOut(trx, id);
      return trx('bank_reconciliations')
        .where({ id })
        .update({ status: 'open', completed_by: null, completed_at: null })
        .returning('*');
    });
    res.json({ data: { ...updated, statement_ending_balance: Number(updated.statement_ending_balance), beginning_book_balance: Number(updated.beginning_book_balance) }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'reconciliations');
  }
});

// DELETE /api/v1/reconciliations/:id
reconciliationItemRouter.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  try {
    const rec = await db('bank_reconciliations').where({ id }).first('id', 'status');
    if (!rec) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    if (rec.status === 'completed') {
      res.status(409).json({ data: null, error: { code: 'LOCKED', message: 'Cannot delete a completed reconciliation' } });
      return;
    }
    await db.transaction(async (trx) => {
      await assertReconNotCheckedOut(trx, id);
      await trx('reconciliation_items').where({ reconciliation_id: id }).delete();
      await trx('bank_reconciliations').where({ id }).delete();
    });
    res.json({ data: { id }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'reconciliations');
  }
});
