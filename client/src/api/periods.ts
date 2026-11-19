// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { apiFetch } from './client';

export interface Period {
  id: number;
  client_id: number;
  period_name: string;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  /** Overrides the derived year folder for stored documents. */
  folder_year: string | null;
  rolled_forward_from: number | null;
  locked_at: string | null;
  locked_by: number | null;
  created_at: string;
  /** Desktop sync: the desktop holding this period, if any. */
  checkout?: PeriodCheckout | null;
}

export interface PeriodCheckout {
  id: number;
  user: string;
  device: string;
  since: string;
  days: number;
  /** Out longer than the firm's warning (default 14 days). */
  stale: boolean;
}

export interface PeriodInput {
  periodName: string;
  startDate?: string;
  endDate?: string;
  isCurrent?: boolean;
  folderYear?: string | null;
}

export const listPeriods = (clientId: number) =>
  apiFetch<Period[]>(`/clients/${clientId}/periods`);

export const createPeriod = (clientId: number, input: PeriodInput) =>
  apiFetch<Period>(`/clients/${clientId}/periods`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const updatePeriod = (id: number, input: Partial<PeriodInput>) =>
  apiFetch<Period>(`/periods/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const deletePeriod = (id: number) =>
  apiFetch<{ id: number }>(`/periods/${id}`, { method: 'DELETE' });

export const lockPeriod = (id: number) =>
  apiFetch<Period>(`/periods/${id}/lock`, { method: 'POST' });

/** Admin: end a desktop's check-out (desktop sync), with a reason. */
export const releaseCheckout = (id: number, reason: string) =>
  apiFetch<{ released: boolean; user: string; device: string }>(`/periods/${id}/checkout/release`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });

export const unlockPeriod = (id: number) =>
  apiFetch<Period>(`/periods/${id}/unlock`, { method: 'POST' });

export type RollForwardMode = 'all_balances' | 'close_income' | 'zero_balances';

export interface RollForwardInput {
  periodName: string;
  startDate?: string;
  endDate?: string;
  isCurrent?: boolean;
  copyRecurringJEs?: boolean;
  /** How to handle balances in the new period */
  mode?: RollForwardMode;
  /** Account ID to close net income/loss into (required when mode='close_income') */
  retainedEarningsAccountId?: number;
  /** Whether to keep workpaper references on COA accounts (default: true) */
  keepWorkpaperRefs?: boolean;
}

export interface RollForwardResult {
  period: Period;
  tbCount: number;
  jeCopied: number;
}

export const rollForwardPeriod = (id: number, input: RollForwardInput) =>
  apiFetch<RollForwardResult>(`/periods/${id}/roll-forward`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
