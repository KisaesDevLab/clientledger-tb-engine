// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { assertPeriodUnlocked, logAudit } from '../lib/periodGuard';
import { sendServerError } from '../lib/safeError';

export const m1CollectionRouter = Router({ mergeParams: true });
m1CollectionRouter.use(authMiddleware);

export const m1ItemRouter = Router({ mergeParams: true });
m1ItemRouter.use(authMiddleware);

// Category names drive the M-1 sign convention (income-like vs expense-like),
// so free-form strings are rejected — an unknown category would silently get
// the expense-like sign. Must stay in sync with M1_CATEGORIES in
// client/src/api/taxWorkpapers.ts.
const M1_CATEGORIES = [
  'Meals & Entertainment',
  'Depreciation Difference',
  'Officer Life Insurance',
  'Political Contributions',
  'Penalties & Fines',
  'Tax-Exempt Income',
  'Deferred Revenue',
  'Accrued Expenses',
  'Other Permanent Difference',
  'Other Temporary Difference',
  'Other Income Difference',
] as const;

const m1Schema = z.object({
  description: z.string().min(1).max(500),
  category:    z.enum(M1_CATEGORIES).optional().nullable(),
  bookAmount:  z.number().int(),
  taxAmount:   z.number().int(),
  sortOrder:   z.number().int().optional(),
  notes:       z.string().optional().nullable(),
});

function sendPeriodLocked(res: Response, err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'PERIOD_LOCKED') {
    res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
    return true;
  }
  return false;
}

function parseRow(r: Record<string, unknown>) {
  return {
    ...r,
    book_amount: Number(r.book_amount ?? 0),
    tax_amount:  Number(r.tax_amount  ?? 0),
  };
}

// GET /api/v1/periods/:periodId/m1-adjustments
m1CollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  try {
    const rows = await db('m1_adjustments')
      .where({ period_id: periodId })
      .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'id', order: 'asc' }]);
    res.json({ data: rows.map(r => parseRow(r as Record<string, unknown>)), error: null, meta: { count: rows.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'taxWorkpapers');
  }
});

// POST /api/v1/periods/:periodId/m1-adjustments
m1CollectionRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  const result = m1Schema.safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const d = result.data;
  try {
    // M-1 amounts feed the period's taxable income — locked periods are immutable.
    const [row] = await db.transaction(async (trx) => {
      await assertPeriodUnlocked(periodId, trx);
      return trx('m1_adjustments').insert({
      period_id:   periodId,
      description: d.description,
      category:    d.category ?? null,
      book_amount: d.bookAmount,
      tax_amount:  d.taxAmount,
      sort_order:  d.sortOrder ?? 0,
      notes:       d.notes ?? null,
      created_by:  req.user!.userId,
    }).returning('*');
    });
    await logAudit({ userId: req.user!.userId, periodId, entityType: 'm1_adjustment', entityId: (row as { id: number }).id, action: 'create', description: `Added M-1 adjustment: ${d.description}` });
    res.status(201).json({ data: parseRow(row as Record<string, unknown>), error: null });
  } catch (err: unknown) {
    if (sendPeriodLocked(res, err)) return;
    sendServerError(res, err, 'taxWorkpapers');
  }
});

// PATCH /api/v1/m1-adjustments/:id
m1ItemRouter.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  const result = m1Schema.partial().safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const d = result.data;
  const updates: Record<string, unknown> = { updated_at: db.fn.now() };
  if (d.description !== undefined) updates.description = d.description;
  if (d.category    !== undefined) updates.category    = d.category;
  if (d.bookAmount  !== undefined) updates.book_amount = d.bookAmount;
  if (d.taxAmount   !== undefined) updates.tax_amount  = d.taxAmount;
  if (d.sortOrder   !== undefined) updates.sort_order  = d.sortOrder;
  if (d.notes       !== undefined) updates.notes       = d.notes;
  try {
    const existing = await db('m1_adjustments').where({ id }).first('period_id');
    if (!existing) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Adjustment not found' } }); return; }
    const [updated] = await db.transaction(async (trx) => {
      await assertPeriodUnlocked(Number(existing.period_id), trx);
      return trx('m1_adjustments').where({ id }).update(updates).returning('*');
    });
    if (!updated) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Adjustment not found' } }); return; }
    await logAudit({ userId: req.user!.userId, periodId: Number(existing.period_id), entityType: 'm1_adjustment', entityId: id, action: 'update', description: 'Updated M-1 adjustment' });
    res.json({ data: parseRow(updated as Record<string, unknown>), error: null });
  } catch (err: unknown) {
    if (sendPeriodLocked(res, err)) return;
    sendServerError(res, err, 'taxWorkpapers');
  }
});

// DELETE /api/v1/m1-adjustments/:id
m1ItemRouter.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  try {
    const existing = await db('m1_adjustments').where({ id }).first('period_id', 'description');
    if (!existing) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Adjustment not found' } }); return; }
    const deleted = await db.transaction(async (trx): Promise<number> => {
      await assertPeriodUnlocked(Number(existing.period_id), trx);
      const n: number = await trx('m1_adjustments').where({ id }).delete();
      return n;
    });
    if (!deleted) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Adjustment not found' } }); return; }
    await logAudit({ userId: req.user!.userId, periodId: Number(existing.period_id), entityType: 'm1_adjustment', entityId: id, action: 'delete', description: `Deleted M-1 adjustment: ${existing.description}` });
    res.json({ data: { id }, error: null });
  } catch (err: unknown) {
    if (sendPeriodLocked(res, err)) return;
    sendServerError(res, err, 'taxWorkpapers');
  }
});
