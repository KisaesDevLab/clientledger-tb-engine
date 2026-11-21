// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { assertDeleteSparesHeldPeriods, assertNotCheckedOut, checkedOutBy, checkedOutByMany, logAudit } from '../lib/periodGuard';
import { checkoutApi, checkoutWarnDays } from '../lib/sync/checkouts';
import { sendServerError } from '../lib/safeError';
import { isForeignKeyViolation, foreignKeyBlockMessage, isRaisedException } from '../lib/pgErrors';

export const periodCollectionRouter = Router({ mergeParams: true });
periodCollectionRouter.use(authMiddleware);

export const periodItemRouter = Router();
periodItemRouter.use(authMiddleware);

const periodSchema = z.object({
  // Overrides the year folder derived from end_date and the client's year end
  // — for a short year, a stub period, or the firm's own naming.
  folderYear: z.string().trim().max(20).nullable().optional(),
  periodName: z.string().min(1).max(100),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  isCurrent: z.boolean().optional(),
});

// GET /api/v1/clients/:clientId/periods
periodCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  try {
    // A period that came along only as a reference (desktop sync) is not
    // one to open.
    const periods = (await db('periods')
      .where({ client_id: clientId, is_reference: false })
      .orderBy('end_date', 'desc')) as Array<Record<string, unknown> & { id: number }>;
    // Desktop sync: who holds each period, if anyone (banner, Periods page).
    const warnDays = await checkoutWarnDays();
    const holders = await checkedOutByMany(db, periods.map((p) => p.id));
    const withCheckout = periods.map((p) => {
      const holder = holders.get(p.id);
      return { ...p, checkout: holder ? checkoutApi(holder, warnDays) : null };
    });
    res.json({ data: withCheckout, error: null, meta: { count: periods.length, checkoutWarnDays: warnDays } });
  } catch (err: unknown) {
    sendServerError(res, err, 'periods');
  }
});

// POST /api/v1/clients/:clientId/periods
periodCollectionRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = periodSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { periodName, startDate, endDate, isCurrent, folderYear } = result.data;

  try {
    await db.transaction(async (trx) => {
      if (isCurrent) {
        await trx('periods').where({ client_id: clientId }).update({ is_current: false });
      }
      const [period] = await trx('periods')
        .insert({
          client_id: clientId,
          period_name: periodName,
          folder_year: folderYear ?? null,
          start_date: startDate ?? null,
          end_date: endDate ?? null,
          is_current: isCurrent ?? false,
        })
        .returning('*');
      await logAudit({ userId: req.user!.userId, periodId: period.id, entityType: 'period', entityId: period.id, action: 'create', description: `Created period "${periodName}"` }, trx);
      res.status(201).json({ data: period, error: null });
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'periods');
  }
});

// PATCH /api/v1/periods/:id
periodItemRouter.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  const result = periodSchema.partial().safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const d = result.data;

  try {
    await db.transaction(async (trx) => {
      if (d.isCurrent === true) {
        const period = await trx('periods').where({ id }).first('client_id');
        if (period) {
          await trx('periods').where({ client_id: period.client_id }).update({ is_current: false });
        }
      }
      // Desktop sync: the name, folder year and dates of a held period wait
      // for its send-back; is_current (flipped on every sibling when a new
      // period is made current) stays open.
      if (d.periodName !== undefined || d.folderYear !== undefined || d.startDate !== undefined || d.endDate !== undefined) {
        await assertNotCheckedOut(trx, [id]);
      }
      const updates: Record<string, unknown> = {};
      if (d.periodName !== undefined) updates.period_name = d.periodName;
      if (d.folderYear !== undefined) updates.folder_year = d.folderYear;
      if (d.startDate !== undefined) updates.start_date = d.startDate;
      if (d.endDate !== undefined) updates.end_date = d.endDate;
      if (d.isCurrent !== undefined) updates.is_current = d.isCurrent;

      const [updated] = await trx('periods').where({ id }).update(updates).returning('*');
      if (!updated) {
        res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
        return;
      }
      await logAudit({ userId: req.user!.userId, periodId: id, entityType: 'period', entityId: id, action: 'update', description: `Updated period "${updated.period_name}" — ${Object.keys(updates).join(', ')}` }, trx);
      res.json({ data: updated, error: null });
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'periods');
  }
});

// POST /api/v1/periods/:id/lock
/**
 * POST /api/v1/periods/:id/checkout/release — admin only (desktop sync S3).
 * Ends a desktop's hold with a reason, for a desktop that is gone or a user
 * who left. The desktop's unsent work is not sent; it can send it back only
 * if the period has not changed since (S4).
 */
const releaseSchema = z.object({ reason: z.string().trim().min(3).max(500) });
periodItemRouter.post('/:id/checkout/release', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  if (req.user?.role !== 'admin') {
    res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Only an admin can release a check-out.' } });
    return;
  }
  const body = releaseSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Say why it is being released (at least 3 characters).' } });
    return;
  }
  try {
    const released = await db.transaction(async (trx) => {
      await trx('periods').where({ id }).forUpdate().first('id');
      const holder = await checkedOutBy(trx, id);
      if (!holder) return null;
      await trx('period_checkouts').where({ id: holder.id }).update({ released_at: trx.fn.now(), released_by: req.user!.userId, release_reason: body.data.reason });
      await logAudit({
        userId: req.user!.userId, periodId: id, entityType: 'period_checkout', entityId: holder.id, action: 'release',
        description: `Released the check-out held by ${holder.user} on "${holder.device}": ${body.data.reason}`,
      }, trx);
      return holder;
    });
    if (!released) {
      res.status(404).json({ data: null, error: { code: 'NOT_CHECKED_OUT', message: 'This period is not checked out.' } });
      return;
    }
    res.json({ data: { released: true, user: released.user, device: released.device }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'periods');
  }
});

periodItemRouter.post('/:id/lock', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  try {
    // Wrap lock acquisition + balance check in a single transaction with a row-level
    // lock on the period. Otherwise two concurrent lock requests, or a write landing
    // between the balance check and the UPDATE, can seal an out-of-balance period.
    const result = await db.transaction(async (trx) => {
      const existing = await trx('periods').where({ id }).forUpdate().first('id', 'locked_at', 'period_name');
      if (!existing) return { kind: 'not_found' as const };
      // Desktop sync: a send-back is refused into a locked period, so locking
      // a held one would strand the desktop's work. Release it first.
      await assertNotCheckedOut(trx, [id]);
      if (existing.locked_at) {
        // Already locked — return current state idempotently
        const full = await trx('periods').where({ id }).first();
        return { kind: 'already' as const, row: full };
      }

      // Re-read TB inside the trx so a concurrent write can't change it mid-way.
      // Use BigInt for the sum so 2^53-cent thresholds can't silently overflow.
      const tbRows = await trx('v_adjusted_trial_balance').where({ period_id: id });
      if (tbRows.length > 0) {
        let bkDr = 0n;
        let bkCr = 0n;
        for (const r of tbRows as Record<string, unknown>[]) {
          bkDr += BigInt((r.book_adjusted_debit ?? 0) as number | string);
          bkCr += BigInt((r.book_adjusted_credit ?? 0) as number | string);
        }
        if (bkDr !== bkCr) {
          const diffCents = bkDr > bkCr ? bkDr - bkCr : bkCr - bkDr;
          const diff = (Number(diffCents) / 100).toFixed(2);
          return { kind: 'unbalanced' as const, diff };
        }
      }
      const [updated] = await trx('periods')
        .where({ id })
        .update({ locked_at: trx.fn.now(), locked_by: req.user!.userId })
        .returning('*');
      await logAudit({ userId: req.user!.userId, periodId: id, entityType: 'period', entityId: id, action: 'lock', description: `Locked period "${updated.period_name}"` }, trx);
      return { kind: 'ok' as const, row: updated };
    });

    if (result.kind === 'not_found') {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }
    if (result.kind === 'unbalanced') {
      res.status(409).json({ data: null, error: { code: 'TB_OUT_OF_BALANCE', message: `Trial balance is out of balance by $${result.diff}. Resolve before locking.` } });
      return;
    }
    res.json({ data: result.row, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'periods');
  }
});

// POST /api/v1/periods/:id/unlock  (admin only)
periodItemRouter.post('/:id/unlock', async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Only admins can unlock periods.' } });
    return;
  }
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  try {
    const [updated] = await db('periods')
      .where({ id })
      .update({ locked_at: null, locked_by: null })
      .returning('*');
    if (!updated) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }
    await logAudit({ userId: req.user!.userId, periodId: id, entityType: 'period', entityId: id, action: 'unlock', description: `Unlocked period "${updated.period_name}"` });
    res.json({ data: updated, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'periods');
  }
});

// DELETE /api/v1/periods/:id
periodItemRouter.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  try {
    const period = await db('periods').where({ id }).first('id', 'locked_at', 'period_name');
    if (!period) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }
    if (period.locked_at && req.user?.role !== 'admin') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: 'Cannot delete a locked period. Ask an admin to unlock it first.' } });
      return;
    }
    // Children cascade (migration 20260903000001 covers the five that once
    // did not). The audit row is written in the same transaction as the delete
    // so a refused delete leaves no "Deleted period" entry behind.
    let deleted: number | undefined;
    await db.transaction(async (trx) => {
      // Desktop sync: deleting would erase the check-out with the period.
      // …nor a held period it cascades into: variance notes compared with this
      // one, reconciliations clearing its transactions (code review). This and
      // every period it reaches are locked first, in one ascending pass.
      await assertDeleteSparesHeldPeriods(trx, { periodIds: [id] });
      await assertNotCheckedOut(trx, [id]);
      await logAudit({ userId: req.user!.userId, periodId: null, entityType: 'period', entityId: id, action: 'delete', description: `Deleted period "${period.period_name ?? id}"` }, trx);
      const rows = await trx('periods').where({ id }).delete().returning('id');
      deleted = rows[0] ? Number((rows[0] as { id: number }).id ?? rows[0]) : undefined;
    });
    if (!deleted) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }
    res.json({ data: { id }, error: null });
  } catch (err: unknown) {
    // A table that still references the period and has no delete action.
    // Say what it is instead of "internal error", so the user can clear it
    // (or an admin can add the cascade) rather than guessing.
    if (isForeignKeyViolation(err)) {
      console.warn(`[periods] delete ${id} blocked by ${err.table ?? err.constraint ?? 'unknown FK'}`);
      res.status(409).json({ data: null, error: { code: 'PERIOD_IN_USE', message: foreignKeyBlockMessage(err, 'this period') } });
      return;
    }
    // A trigger that RAISEd (SQLSTATE P0001) — the audit log's append-only
    // guard is the known one. Its message says what refused; pass it on
    // rather than hiding it behind "internal error".
    if (isRaisedException(err)) {
      console.warn(`[periods] delete ${id} refused by a database rule: ${err.message}`);
      res.status(409).json({ data: null, error: { code: 'PERIOD_DELETE_REFUSED', message: `Cannot delete this period: ${err.message}` } });
      return;
    }
    sendServerError(res, err, 'periods');
  }
});
