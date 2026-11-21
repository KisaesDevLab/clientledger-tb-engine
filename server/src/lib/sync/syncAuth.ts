// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Desktop sync S2: the middleware for `/api/v1/sync/*`.
 *
 * Accepts only `Authorization: Bearer vtbsync_…` (a device token). Every other
 * route keeps its own `authMiddleware`, which refuses a device token as an
 * invalid JWT, so a device token reaches nothing outside the sync routes; and
 * a session JWT is refused here, so the sync routes are a device's only.
 *
 * The device acts as the user who paired it (SQ5): a deactivated user's
 * devices stop at once, a revoked device too. A reviewer may read (pull);
 * `blockReviewerWrites` after this stops their writes. Every call writes an
 * audit row naming the device, once the answer is sent, apart from polling
 * reads (see below). A device unused for 90 days is retired here (`deviceRevoke.ts`).
 */

import type { NextFunction, Response } from 'express';
import { db } from '../../db';
import type { AuthRequest } from '../../middleware/auth';
import { logAudit } from '../periodGuard';
import { deviceIdle, DEVICE_IDLE_DAYS, releaseDeviceHolds } from './deviceRevoke';
import { isDeviceToken, sha256 } from './deviceTokens';

export interface SyncRequest extends AuthRequest {
  syncDevice?: { id: number; name: string };
}

/** last_used_at is written at most this often per device. */
const TOUCH_MS = 60 * 1000;

function refuse(res: Response, code: string, message: string): void {
  res.status(401).json({ data: null, error: { code, message } });
}

export async function syncAuthMiddleware(req: SyncRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!isDeviceToken(token)) {
    res.locals.syncUnknownToken = true;
    refuse(res, 'SYNC_NOT_PAIRED', 'This computer is not connected to this server. Pair it again from Settings › Desktop sync.');
    return;
  }
  try {
    const row = await db('sync_devices as d')
      .join('app_users as u', 'u.id', 'd.user_id')
      .where('d.token_hash', sha256(token))
      .first('d.id', 'd.name', 'd.revoked_at', 'd.last_used_at', 'd.created_at', 'u.id as user_id', 'u.username', 'u.role', 'u.is_active');
    if (!row) {
      res.locals.syncUnknownToken = true;
      refuse(res, 'SYNC_NOT_PAIRED', 'This computer is not connected to this server. Pair it again from Settings › Desktop sync.');
      return;
    }
    if (row.revoked_at) {
      refuse(res, 'SYNC_DEVICE_REVOKED', 'This computer\'s connection to the server was removed. Pair it again from Settings › Desktop sync.');
      return;
    }
    if (deviceIdle(row.last_used_at, row.created_at)) {
      // Revoked, released and audited together (code review): never revoked with its holds left behind.
      await db.transaction(async (trx) => {
        const n = await trx('sync_devices').where({ id: row.id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
        if (n === 0) return; // another request ended it first
        await releaseDeviceHolds(trx, [row.id], null, `desktop "${row.name}" unused for ${DEVICE_IDLE_DAYS} days`);
        await logAudit({ userId: row.user_id, periodId: null, entityType: 'sync_device', entityId: row.id, action: 'revoke', description: `Desktop "${row.name}" removed: unused for ${DEVICE_IDLE_DAYS} days` }, trx);
      });
      refuse(res, 'SYNC_DEVICE_EXPIRED', `This computer had not synced for ${DEVICE_IDLE_DAYS} days, so its connection ended. Pair it again from Settings › Desktop sync.`);
      return;
    }
    if (!row.is_active) {
      refuse(res, 'ACCOUNT_INACTIVE', 'The account this computer was connected with is no longer active.');
      return;
    }
    req.user = { userId: row.user_id, username: row.username, role: row.role, stage: null, methods: [] };
    req.syncDevice = { id: row.id, name: row.name };
    const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
    if (Date.now() - last > TOUCH_MS) {
      await db('sync_devices').where({ id: row.id }).update({ last_used_at: db.fn.now() });
    }
    // Audited: every write, every refusal, and any read a route marks as
    // handing out client data (`res.locals.syncAudit = true`). Not the
    // polling (who am I, job status), which would flood the append-only log.
    res.on('finish', () => {
      if (req.method === 'GET' && res.statusCode < 400 && !res.locals.syncAudit) return;
      void logAudit({
        userId: row.user_id,
        periodId: null,
        entityType: 'sync_device',
        entityId: row.id,
        action: 'sync',
        description: `${req.method} ${req.baseUrl}${req.path} from "${row.name}": ${res.statusCode}`,
      });
    });
    next();
  } catch (err: unknown) {
    console.error('[sync] device check failed', err instanceof Error ? err.message : err);
    res.status(500).json({ data: null, error: { code: 'SERVER_ERROR', message: 'An internal error occurred. Please try again.' } });
  }
}
