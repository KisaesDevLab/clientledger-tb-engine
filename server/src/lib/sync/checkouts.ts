// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.
/**
 * Desktop sync S3: how a check-out is shown (sync API, web Periods page,
 * admin dashboard). A check-out is never released automatically (SQ2); one
 * older than `sync.checkout_warn_days` (default 14) is flagged as stale.
 */
import { db } from '../../db';
import type { PeriodCheckoutHolder } from '../periodGuard';

export const CHECKOUT_WARN_DAYS_DEFAULT = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `settings['sync.checkout_warn_days']`, a whole number of days, else 14. */
export async function checkoutWarnDays(): Promise<number> {
  const row = await db('settings').where({ key: 'sync.checkout_warn_days' }).first('value');
  const n = Number(typeof row?.value === 'string' ? row.value.replace(/"/g, '') : row?.value);
  return Number.isInteger(n) && n > 0 && n <= 365 ? n : CHECKOUT_WARN_DAYS_DEFAULT;
}

/** Whole days a check-out has been out. */
export function daysOut(since: Date, now = Date.now()): number {
  return Math.max(0, Math.floor((now - since.getTime()) / DAY_MS));
}

export function checkoutApi(h: PeriodCheckoutHolder, warnDays: number, viewerDeviceId?: number) {
  const days = daysOut(h.since);
  return {
    id: h.id,
    user: h.user,
    device: h.device,
    since: h.since.toISOString(),
    days,
    stale: days >= warnDays,
    ...(viewerDeviceId !== undefined ? { mine: h.deviceId === viewerDeviceId } : {}),
  };
}

/** A DATE column as YYYY-MM-DD (pg hands back a Date at local midnight). */
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}
