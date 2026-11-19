// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Desktop sync S3 (SQ2): an admin sees, on the dashboard, every period a
 * desktop has held longer than the firm's warning (default 14 days).
 * Nothing is released automatically; this is the nudge to ask, or to
 * release it on the Periods page.
 */

import { useQuery } from '@tanstack/react-query';
import { listCheckouts } from '../api/desktopSync';
import { useAuthStore } from '../store/uiStore';

export function StaleCheckoutsNotice() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { data } = useQuery({
    queryKey: ['desktop-sync-checkouts'],
    queryFn: async () => {
      const res = await listCheckouts();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: isAdmin,
    refetchInterval: 5 * 60_000,
  });
  const stale = (data ?? []).filter((c) => c.stale);
  if (!isAdmin || stale.length === 0) return null;
  return (
    <div role="status" className="rounded-lg border border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-900/30 px-5 py-3 text-sm text-amber-900 dark:text-amber-200">
      <p className="font-medium mb-1">
        {stale.length === 1 ? 'A period has' : `${stale.length} periods have`} been checked out to a desktop for a long time
      </p>
      <ul className="list-disc ml-5 space-y-0.5">
        {stale.map((c) => (
          <li key={c.id}>
            {c.clientName} · {c.periodName}: {c.user} on “{c.device}”, {c.days} days
          </li>
        ))}
      </ul>
      <p className="text-xs mt-1">
        Ask them to send it back. If that desktop is gone, release it on the Periods page.
      </p>
    </div>
  );
}
