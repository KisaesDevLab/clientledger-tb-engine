// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { assertClientKeysFrozen, assertNotCheckedOut } from '../lib/periodGuard';

// Tickmark library (per client)
export const tickmarkLibraryCollectionRouter = Router({ mergeParams: true });
tickmarkLibraryCollectionRouter.use(authMiddleware);

export const tickmarkLibraryItemRouter = Router({ mergeParams: true });
tickmarkLibraryItemRouter.use(authMiddleware);

// TB tickmark assignments (per period)
export const tbTickmarkRouter = Router({ mergeParams: true });
tbTickmarkRouter.use(authMiddleware);

const COLORS = ['gray', 'blue', 'green', 'red', 'purple', 'amber'] as const;

const librarySchema = z.object({
  symbol:      z.string().min(1).max(10),
  description: z.string().min(1).max(500),
  color:       z.enum(COLORS).optional().default('gray'),
  sortOrder:   z.number().int().optional(),
});

// GET /api/v1/clients/:clientId/tickmarks
tickmarkLibraryCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } }); return; }
  try {
    const rows = await db('tickmark_library').where({ client_id: clientId })
      .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'id', order: 'asc' }]);
    res.json({ data: rows, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// POST /api/v1/clients/:clientId/tickmarks
tickmarkLibraryCollectionRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } }); return; }
  const result = librarySchema.safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const d = result.data;
  try {
    const [row] = await db('tickmark_library').insert({
      client_id:   clientId,
      symbol:      d.symbol,
      description: d.description,
      color:       d.color,
      sort_order:  d.sortOrder ?? 0,
      created_by:  req.user!.userId,
    }).returning('*');
    res.status(201).json({ data: row, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// PATCH /api/v1/tickmarks/:id
tickmarkLibraryItemRouter.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  const result = librarySchema.partial().safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const d = result.data;
  const updates: Record<string, unknown> = {};
  if (d.symbol      !== undefined) updates.symbol      = d.symbol;
  if (d.description !== undefined) updates.description = d.description;
  if (d.color       !== undefined) updates.color       = d.color;
  if (d.sortOrder   !== undefined) updates.sort_order  = d.sortOrder;
  try {
    const [updated] = await db.transaction(async (trx) => {
      // A send-back matches tickmarks by symbol (owner 2026-11-19).
      if (d.symbol !== undefined) {
        const was = await trx('tickmark_library').where({ id }).first('symbol', 'client_id');
        if (was && was.symbol !== d.symbol) await assertClientKeysFrozen(trx, Number(was.client_id), "a tickmark's symbol");
      }
      return trx('tickmark_library').where({ id }).update(updates).returning('*');
    });
    if (!updated) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Tickmark not found' } }); return; }
    res.json({ data: updated, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// DELETE /api/v1/tickmarks/:id
tickmarkLibraryItemRouter.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  try {
    const deleted = await db.transaction(async (trx): Promise<number> => {
      // Desktop sync: the delete cascades to the tickmarks placed in every
      // period; not while a desktop holds one of them.
      await assertNotCheckedOut(trx, await trx('tb_tickmarks').where({ tickmark_id: id }).distinct().pluck('period_id'));
      const n: number = await trx('tickmark_library').where({ id }).delete();
      return n;
    });
    if (!deleted) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Tickmark not found' } }); return; }
    res.json({ data: { id }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// ── System-default tickmarks (admin only) ────────────────────────────────────

export const systemTickmarkCollectionRouter = Router();
systemTickmarkCollectionRouter.use(authMiddleware);

export const systemTickmarkItemRouter = Router({ mergeParams: true });
systemTickmarkItemRouter.use(authMiddleware);

function requireAdmin(req: AuthRequest, res: Response, next: () => void): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Admin only.' } });
    return;
  }
  next();
}

// GET /api/v1/system-tickmarks
systemTickmarkCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await db('system_tickmarks')
      .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'id', order: 'asc' }]);
    res.json({ data: rows, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// POST /api/v1/system-tickmarks
systemTickmarkCollectionRouter.post('/', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const result = librarySchema.safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const d = result.data;
  try {
    const [row] = await db('system_tickmarks').insert({
      symbol:      d.symbol,
      description: d.description,
      color:       d.color,
      sort_order:  d.sortOrder ?? 0,
      created_by:  req.user!.userId,
    }).returning('*');
    res.status(201).json({ data: row, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// POST /api/v1/system-tickmarks/apply/:clientId
// Copies system defaults into a client's library; skips symbols already present.
systemTickmarkCollectionRouter.post('/apply/:clientId', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } }); return; }
  try {
    const client = await db('clients').where({ id: clientId }).first('id');
    if (!client) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Client not found' } }); return; }

    const [systemRows, clientRows] = await Promise.all([
      db('system_tickmarks').orderBy('sort_order').orderBy('id'),
      db('tickmark_library').where({ client_id: clientId }).select('symbol'),
    ]);
    const existingSymbols = new Set(clientRows.map((r: { symbol: string }) => r.symbol));
    const toInsert = systemRows.filter((r: { symbol: string }) => !existingSymbols.has(r.symbol));
    if (toInsert.length > 0) {
      await db('tickmark_library').insert(
        toInsert.map((r: { symbol: string; description: string; color: string; sort_order: number }) => ({
          client_id:   clientId,
          symbol:      r.symbol,
          description: r.description,
          color:       r.color,
          sort_order:  r.sort_order,
          created_by:  req.user!.userId,
        })),
      );
    }
    res.json({ data: { applied: toInsert.length, skipped: systemRows.length - toInsert.length }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// PATCH /api/v1/system-tickmarks/:id
systemTickmarkItemRouter.patch('/', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  const result = librarySchema.partial().safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const d = result.data;
  const updates: Record<string, unknown> = {};
  if (d.symbol      !== undefined) updates.symbol      = d.symbol;
  if (d.description !== undefined) updates.description = d.description;
  if (d.color       !== undefined) updates.color       = d.color;
  if (d.sortOrder   !== undefined) updates.sort_order  = d.sortOrder;
  try {
    const [updated] = await db('system_tickmarks').where({ id }).update(updates).returning('*');
    if (!updated) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'System tickmark not found' } }); return; }
    res.json({ data: updated, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// DELETE /api/v1/system-tickmarks/:id
systemTickmarkItemRouter.delete('/', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  try {
    const deleted = await db('system_tickmarks').where({ id }).delete();
    if (!deleted) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'System tickmark not found' } }); return; }
    res.json({ data: { id }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// ── TB tickmark assignments ───────────────────────────────────────────────────

// GET /api/v1/periods/:periodId/tb-tickmarks
// Returns { [accountId]: TickmarkLibraryRow[] }
tbTickmarkRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  try {
    const rows = await db('tb_tickmarks as tt')
      .join('tickmark_library as tl', 'tl.id', 'tt.tickmark_id')
      .where('tt.period_id', periodId)
      .select('tt.account_id', 'tl.id', 'tl.symbol', 'tl.description', 'tl.color', 'tl.sort_order');
    // Group by account_id
    const map: Record<number, object[]> = {};
    for (const r of rows) {
      const aid = r.account_id as number;
      if (!map[aid]) map[aid] = [];
      map[aid].push({ id: r.id, symbol: r.symbol, description: r.description, color: r.color });
    }
    res.json({ data: map, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});

// POST /api/v1/periods/:periodId/tb-tickmarks/toggle
tbTickmarkRouter.post('/toggle', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  const bodySchema = z.object({ accountId: z.number().int(), tickmarkId: z.number().int() });
  const result = bodySchema.safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  const { accountId, tickmarkId } = result.data;
  try {
    const action = await db.transaction(async (trx) => {
      // Desktop sync: not in a period a desktop holds.
      await assertNotCheckedOut(trx, [periodId]);
      const existing = await trx('tb_tickmarks').where({ period_id: periodId, account_id: accountId, tickmark_id: tickmarkId }).first('id');
      if (existing) {
        await trx('tb_tickmarks').where({ id: existing.id }).delete();
        return 'removed';
      }
      await trx('tb_tickmarks').insert({ period_id: periodId, account_id: accountId, tickmark_id: tickmarkId, created_by: req.user!.userId });
      return 'assigned';
    });
    res.json({ data: { action }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'tickmarks');
  }
});
