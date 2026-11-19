// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Settings → Desktop sync (every user; desktop sync S2). "Connect a desktop"
 * shows a one-time code to type into ClientLedger Trial Balance on the
 * computer; the list shows the desktops connected, when each was last used,
 * and removes one. An admin may list every user's.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore, pushToast } from '../store/uiStore';
import { confirmAction } from './ConfirmDialog';
import {
  DESKTOP_SYNC_QUERY_KEY, createPairingCode, listSyncDevices, revokeSyncDevice, type PairingCode, type SyncDevice,
} from '../api/desktopSync';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60000));
}

export function DesktopSyncCard() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  /**
   * The devices there were when the code was made. A new one of the user's
   * own afterwards used it; ids, not times, so the PC's clock and other
   * users' desktops (with "Every user" on) play no part.
   */
  const [knownIds, setKnownIds] = useState<Set<number>>(() => new Set());
  const [connected, setConnected] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The code's countdown, and the list re-read when the code is used.
  useEffect(() => {
    if (!code) return undefined;
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, [code]);

  const devices = useQuery({
    queryKey: [...DESKTOP_SYNC_QUERY_KEY, all],
    queryFn: async () => {
      const res = await listSyncDevices(all);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    refetchInterval: code ? 10000 : false,
  });

  const expired = code ? minutesLeft(code.expiresAt, now) === 0 : false;

  // The code is spent once a desktop pairs with it: say so instead of
  // showing it as still good.
  useEffect(() => {
    if (!code || !devices.data) return;
    const fresh = devices.data.find((d) => d.mine && !knownIds.has(d.id));
    if (fresh) {
      setConnected(fresh.name);
      setCode(null);
    }
  }, [code, knownIds, devices.data]);

  async function connect() {
    setMaking(true);
    // Which desktops are there before the code exists (see knownIds).
    const before = await listSyncDevices(false);
    if (before.error) {
      setMaking(false);
      pushToast(before.error.message, 'error');
      return;
    }
    const res = await createPairingCode();
    setMaking(false);
    if (res.error) {
      pushToast(res.error.message, 'error');
      return;
    }
    setNow(Date.now());
    setKnownIds(new Set(before.data.map((d) => d.id)));
    setConnected(null);
    setCode(res.data);
  }

  async function remove(d: SyncDevice) {
    const ok = await confirmAction({
      title: 'Remove this desktop?',
      message: `"${d.name}" will no longer reach this server. Work already on that computer stays there; to send it back, pair it again.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await revokeSyncDevice(d.id);
    if (res.error) {
      pushToast(res.error.message, 'error');
      return;
    }
    pushToast(`Removed "${d.name}".`, 'success');
    await qc.invalidateQueries({ queryKey: DESKTOP_SYNC_QUERY_KEY });
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-5 py-4">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">Desktop sync</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Connect ClientLedger Trial Balance on a computer to this server, so it can open a client and period here, work on it
        offline, and send it back. A connected desktop acts as you.
      </p>

      <div className="mb-4">
        <button
          type="button"
          onClick={connect}
          disabled={making}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {making ? 'Making a code…' : code ? 'Make a new code' : 'Connect a desktop'}
        </button>
        {connected && !code && (
          <p className="mt-3 text-sm text-green-700 dark:text-green-400">Connected “{connected}”. The code has been used.</p>
        )}
        {code && (
          <div className="mt-3 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 max-w-md">
            {expired ? (
              <p className="text-sm text-gray-700 dark:text-gray-300">This code has expired. Make a new one.</p>
            ) : (
              <>
                <p className="text-xs text-gray-600 dark:text-gray-300 mb-1">
                  In ClientLedger Trial Balance, open Settings › Firm server and enter this code:
                </p>
                <p className="font-mono text-2xl tracking-widest text-gray-900 dark:text-white select-all" aria-label="Pairing code">
                  {code.code}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Works once, for {minutesLeft(code.expiresAt, now)} more minute{minutesLeft(code.expiresAt, now) === 1 ? '' : 's'}.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mb-2 max-w-md">
        <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">{all ? 'Every user’s desktops' : 'Your desktops'}</h4>
        {isAdmin && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Every user
          </label>
        )}
      </div>
      {devices.error ? (
        <p className="text-xs text-red-600 dark:text-red-400">Could not load the desktops: {(devices.error as Error).message}</p>
      ) : !devices.data ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading…</p>
      ) : devices.data.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">No desktops connected.</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700 max-w-md">
          {devices.data.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{d.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {all && <>{d.user} · </>}Connected {when(d.createdAt)} · Last used {when(d.lastUsedAt)}
                </p>
              </div>
              <button type="button" onClick={() => remove(d)} className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 whitespace-nowrap">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
