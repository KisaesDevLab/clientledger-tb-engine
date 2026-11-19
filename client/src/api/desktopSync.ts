// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Desktop sync (S2): the signed-in user's pairing codes and paired desktops.
 * The desktop itself talks to /api/v1/sync/* with its own device token; the
 * web app only makes the code and lists and removes devices.
 */

import { apiFetch } from './client';

export const DESKTOP_SYNC_QUERY_KEY = ['desktop-sync-devices'] as const;

export interface PairingCode {
  /** As shown: XXXX-XXXX. */
  code: string;
  expiresAt: string;
}

export interface SyncDevice {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Who paired it. */
  user: string;
  /** Paired by the signed-in user. */
  mine: boolean;
}

export function createPairingCode() {
  return apiFetch<PairingCode>('/desktop-sync/codes', { method: 'POST' });
}

export function listSyncDevices(all: boolean) {
  return apiFetch<SyncDevice[]>(`/desktop-sync/devices${all ? '?all=1' : ''}`);
}

export function revokeSyncDevice(id: number) {
  return apiFetch<{ id: number }>(`/desktop-sync/devices/${id}`, { method: 'DELETE' });
}

/** A period a desktop holds (desktop sync S3). */
export interface SyncCheckout {
  id: number;
  periodId: number;
  periodName: string;
  clientId: number;
  clientName: string;
  user: string;
  device: string;
  since: string;
  days: number;
  stale: boolean;
}

/** Every live check-out (an admin), or the user's own. */
export function listCheckouts() {
  return apiFetch<SyncCheckout[]>('/desktop-sync/checkouts');
}
