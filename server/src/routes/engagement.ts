// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { assertNotCheckedOut } from '../lib/periodGuard';

export const engagementCollectionRouter = Router({ mergeParams: true });
engagementCollectionRouter.use(authMiddleware);

export const engagementItemRouter = Router({ mergeParams: true });
engagementItemRouter.use(authMiddleware);

export const engagementSummaryRouter = Router({ mergeParams: true });
engagementSummaryRouter.use(authMiddleware);

const STATUS_VALUES = ['open', 'in_progress', 'review', 'completed', 'n_a'] as const;

const taskSchema = z.object({
  title:      z.string().min(1).max(500),
  description: z.string().optional().nullable(),
  category:   z.string().max(100).optional().nullable(),
  status:     z.enum(STATUS_VALUES).optional(),
  assigneeId: z.number().int().positive().optional().nullable(),
  sortOrder:  z.number().int().optional(),
  notes:      z.string().optional().nullable(),
});

function parseRow(r: Record<string, unknown>) {
  return r;
}

// GET /api/v1/periods/:periodId/engagement-tasks
engagementCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  try {
    const rows = await db('engagement_tasks as t')
      .leftJoin('app_users as a', 'a.id', 't.assignee_id')
      .leftJoin('app_users as cb', 'cb.id', 't.completed_by')
      .where('t.period_id', periodId)
      .orderBy([{ column: 't.sort_order', order: 'asc' }, { column: 't.id', order: 'asc' }])
      .select(
        't.*',
        'a.display_name as assignee_name',
        'cb.display_name as completed_by_name',
      );
    res.json({ data: rows.map(r => parseRow(r as Record<string, unknown>)), error: null, meta: { count: rows.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'engagement');
  }
});

// POST /api/v1/periods/:periodId/engagement-tasks
engagementCollectionRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  const result = taskSchema.safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const d = result.data;
  try {
    const [row] = await db.transaction(async (trx) => {
      // Desktop sync: not in a period a desktop holds.
      await assertNotCheckedOut(trx, [periodId]);
      return trx('engagement_tasks').insert({
      period_id:   periodId,
      title:       d.title,
      description: d.description ?? null,
      category:    d.category ?? null,
      status:      d.status ?? 'open',
      assignee_id: d.assigneeId ?? null,
      sort_order:  d.sortOrder ?? 0,
      notes:       d.notes ?? null,
      created_by:  req.user!.userId,
    }).returning('*');
    });
    res.status(201).json({ data: parseRow(row as Record<string, unknown>), error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'engagement');
  }
});

// PATCH /api/v1/engagement-tasks/:id
engagementItemRouter.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  const result = taskSchema.partial().safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const d = result.data;
  const updates: Record<string, unknown> = { updated_at: db.fn.now() };
  if (d.title       !== undefined) updates.title       = d.title;
  if (d.description !== undefined) updates.description = d.description;
  if (d.category    !== undefined) updates.category    = d.category;
  if (d.sortOrder   !== undefined) updates.sort_order  = d.sortOrder;
  if (d.notes       !== undefined) updates.notes       = d.notes;
  if (d.assigneeId  !== undefined) updates.assignee_id = d.assigneeId;
  if (d.status !== undefined) {
    updates.status = d.status;
    if (d.status === 'completed') {
      updates.completed_by = req.user!.userId;
      updates.completed_at = db.fn.now();
    } else {
      updates.completed_by = null;
      updates.completed_at = null;
    }
  }
  try {
    const [updated] = await db.transaction(async (trx) => {
      await assertNotCheckedOut(trx, [(await trx('engagement_tasks').where({ id }).first('period_id'))?.period_id]);
      return trx('engagement_tasks').where({ id }).update(updates).returning('*');
    });
    if (!updated) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Task not found' } }); return; }
    res.json({ data: parseRow(updated as Record<string, unknown>), error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'engagement');
  }
});

// DELETE /api/v1/engagement-tasks/:id
engagementItemRouter.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  try {
    const deleted = await db.transaction(async (trx): Promise<number> => {
      await assertNotCheckedOut(trx, [(await trx('engagement_tasks').where({ id }).first('period_id'))?.period_id]);
      const n: number = await trx('engagement_tasks').where({ id }).delete();
      return n;
    });
    if (!deleted) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Task not found' } }); return; }
    res.json({ data: { id }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'engagement');
  }
});

// GET /api/v1/engagement-summary
// Returns all open/in_progress/review tasks across all periods & clients, with client+period info
engagementSummaryRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await db('engagement_tasks as t')
      .join('periods as p', 'p.id', 't.period_id')
      .join('clients as c', 'c.id', 'p.client_id')
      .leftJoin('app_users as a', 'a.id', 't.assignee_id')
      .whereNotIn('t.status', ['completed', 'n_a'])
      .orderBy([
        { column: 'c.name', order: 'asc' },
        { column: 'p.id',   order: 'desc' },
        { column: 't.sort_order', order: 'asc' },
        { column: 't.id',   order: 'asc' },
      ])
      .select(
        't.id', 't.title', 't.category', 't.status', 't.notes',
        't.period_id', 't.assignee_id',
        'p.period_name', 'p.end_date',
        'c.id as client_id', 'c.name as client_name',
        'a.display_name as assignee_name',
      );
    res.json({ data: rows, error: null, meta: { count: rows.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'engagement');
  }
});
