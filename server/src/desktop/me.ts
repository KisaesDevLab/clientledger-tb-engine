// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop (Q74): the name of the person at this PC.
//
// The desktop runs every request as one built-in engine user. The engine
// copies that user's display name into lead sheet sign-offs, notes and
// completed checklist tasks, so the app sets it to the name the person gave
// on this PC ("Your name or initials"). Only the session's own user (set at
// start-up, currentUser.ts) is read or changed; upstream's /users routes are
// untouched. The session middleware has already checked the launch token.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { sendServerError } from '../lib/safeError';
import { currentUserId } from './currentUser';

export const desktopMeRouter = Router();

interface Me { id: number; username: string; displayName: string | null }

async function me(userId: number): Promise<Me | null> {
  const row = await db('app_users').where({ id: userId }).first('id', 'username', 'display_name');
  return row ? { id: row.id, username: row.username, displayName: row.display_name ?? null } : null;
}

desktopMeRouter.get('/desktop/me', async (_req: Request, res: Response): Promise<void> => {
  try {
    const id = currentUserId();
    const m = id === null ? null : await me(id);
    if (!m) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'The desktop user is missing' } });
      return;
    }
    res.json({ data: m, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop/me');
  }
});

const putSchema = z.object({ displayName: z.string().trim().min(1).max(255) });

desktopMeRouter.put('/desktop/me', async (req: Request, res: Response): Promise<void> => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'A name of 1 to 255 characters' } });
    return;
  }
  const id = currentUserId();
  if (id === null) {
    res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'The desktop user is missing' } });
    return;
  }
  try {
    await db('app_users').where({ id }).update({ display_name: parsed.data.displayName, updated_at: db.fn.now() });
    res.json({ data: await me(id), error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop/me');
  }
});
