// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Desktop sync S3: says so when the selected period is checked out to a
 * desktop. The server refuses every change to it until the desktop sends it
 * back or an admin releases it (Periods page); this tells the user why
 * before they try.
 */

import { useQuery } from '@tanstack/react-query';
import { listPeriods, type Period, type PeriodCheckout } from '../api/periods';
import { useUIStore } from '../store/uiStore';

/** The selected period's check-out, from the shared period list. */
export function useSelectedPeriodCheckout(): PeriodCheckout | null {
  const { selectedClientId, selectedPeriodId } = useUIStore();
  const { data } = useQuery({
    queryKey: ['periods', selectedClientId],
    queryFn: async () => {
      if (!selectedClientId) return [] as Period[];
      const res = await listPeriods(selectedClientId);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: selectedClientId !== null,
  });
  return data?.find((p) => p.id === selectedPeriodId)?.checkout ?? null;
}

export function checkoutSentence(c: PeriodCheckout): string {
  const since = new Date(c.since).toLocaleDateString();
  const days = c.days === 0 ? 'today' : c.days === 1 ? '1 day ago' : `${c.days} days ago`;
  return `Checked out to ${c.user} on “${c.device}” since ${since} (${days}).`;
}

export function CheckoutBanner({ className = '' }: { className?: string }) {
  const checkout = useSelectedPeriodCheckout();
  if (!checkout) return null;
  return (
    <div
      role="status"
      className={`rounded border px-3 py-2 text-sm ${checkout.stale
        ? 'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-900/30 dark:text-amber-200'
        : 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-200'} ${className}`}
    >
      <span className="font-medium">{checkoutSentence(checkout)}</span>{' '}
      It is read-only here until that desktop sends it back. An admin can release it on the Periods page.
    </div>
  );
}
