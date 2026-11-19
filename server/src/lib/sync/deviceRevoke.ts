// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.
/**
 * Desktop sync S2: when a paired desktop stops working (owner 2026-11-19).
 *
 *   - Removed from Settings › Desktop sync (the owner or an admin).
 *   - The user is deactivated: revoked at that moment (Users page, Vibe Auth
 *     `setActive`), so reactivating the account does not bring them back.
 *   - Unused for DEVICE_IDLE_DAYS (checked on every call).
 *   - The user's password is RESET: by an admin (Users page, Vibe Auth) or
 *     through an emailed reset link. A reset means someone else may have had
 *     the account, so the desktops it paired are cut off. A user changing
 *     their own password while signed in, or signing out, does not.
 */
import type { Knex } from 'knex';
import { db } from '../../db';
import { logAudit } from '../periodGuard';

export const DEVICE_IDLE_DAYS = 90;
export const DEVICE_IDLE_MS = DEVICE_IDLE_DAYS * 24 * 60 * 60 * 1000;

/** Whether a device last used at `lastUsed` (or paired at `created`) has gone idle. */
export function deviceIdle(lastUsed: Date | string | null, created: Date | string, now = Date.now()): boolean {
  const t = new Date(lastUsed ?? created).getTime();
  return now - t > DEVICE_IDLE_MS;
}

/**
 * Releases the periods these devices hold (security review: a removed or
 * deactivated desktop's holds froze those periods until an admin released
 * them one by one). Their unsent work stays on the desktop.
 */
export async function releaseDeviceHolds(
  q: Knex | Knex.Transaction,
  deviceIds: number[],
  by: number | null,
  reason: string,
): Promise<number> {
  if (deviceIds.length === 0) return 0;
  const rows = (await q('period_checkouts').whereIn('device_id', deviceIds).whereNull('released_at')
    .update({ released_at: q.fn.now(), released_by: by, release_reason: reason }).returning(['id', 'period_id', 'user_id'])) as Array<{ id: number; period_id: number; user_id: number }>;
  for (const r of rows) {
    await logAudit({ userId: by ?? r.user_id, periodId: r.period_id, entityType: 'period_checkout', entityId: r.id, action: 'release', description: `Check-out released: ${reason}` }, 'commit' in q ? (q as Knex.Transaction) : undefined);
  }
  return rows.length;
}

/**
 * Revokes every live device the user paired and deletes their unused pairing
 * codes; writes one audit row when any device was revoked. `by` is the admin
 * who caused it, or null. `reset: true` (a password reset) also stamps
 * `app_users.sync_reset_at`, so a session from before it cannot make a new
 * code (`POST /desktop-sync/codes`).
 */
export async function revokeUserDevices(
  userId: number,
  by: number | null,
  reason: string,
  opts: { reset?: boolean; trx?: Knex.Transaction } = {},
): Promise<number> {
  const trx = opts.trx;
  const q = trx ?? db;
  await q('sync_pairing_codes').where({ user_id: userId }).whereNull('used_at').delete();
  if (opts.reset) await q('app_users').where({ id: userId }).update({ sync_reset_at: q.fn.now() });
  const ids = (await q('sync_devices')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: q.fn.now(), revoked_by: by })
    .returning('id')) as Array<{ id: number }>;
  // Their holds go with them.
  await releaseDeviceHolds(q, ids.map((r) => Number(r.id)), by, `its desktop was removed (${reason})`);
  if (ids.length > 0) {
    await logAudit({
      userId: by ?? userId,
      periodId: null,
      entityType: 'sync_device',
      entityId: null,
      action: 'revoke',
      description: `${ids.length} paired desktop${ids.length === 1 ? '' : 's'} removed: ${reason}`,
    }, trx);
  }
  return ids.length;
}
