// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { assertNotCheckedOut } from '../lib/periodGuard';

export const varianceNotesRouter = Router({ mergeParams: true });
varianceNotesRouter.use(authMiddleware);

// GET /api/v1/periods/:periodId/variance-notes
varianceNotesRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  try {
    const rows = await db('variance_notes').where({ period_id: periodId }).orderBy('account_id');
    res.json({ data: rows, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'varianceNotes');
  }
});

// PUT /api/v1/periods/:periodId/variance-notes/:accountId
varianceNotesRouter.put('/:accountId', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  const accountId = Number(req.params.accountId);
  if (isNaN(periodId) || isNaN(accountId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } }); return; }
  const schema = z.object({ note: z.string().max(2000) });
  const result = schema.safeParse(req.body);
  if (!result.success) { res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } }); return; }
  try {
    // A note with no comparison period is kept against the period itself:
    // compare_period_id is NOT NULL and a foreign key into periods, so the 0
    // this used to write was refused on every save (500).
    const row = await db.transaction(async (trx) => {
      // Desktop sync: not in a period a desktop holds.
      await assertNotCheckedOut(trx, [periodId]);
      if (!result.data.note.trim()) {
        // Only this note: the account's notes against other periods stay.
        await trx('variance_notes').where({ period_id: periodId, account_id: accountId, compare_period_id: periodId }).delete();
        return null;
      }
      const [r] = await trx('variance_notes')
        .insert({ period_id: periodId, account_id: accountId, compare_period_id: periodId, note: result.data.note.trim(), created_by: req.user!.userId })
        .onConflict(['period_id', 'account_id', 'compare_period_id'])
        .merge({ note: result.data.note.trim() })
        .returning('*');
      return r;
    });
    res.json({ data: row ?? { deleted: true }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'varianceNotes');
  }
});
