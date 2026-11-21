// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/** Self-service password change, extracted verbatim from the old Settings Account card. */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { changePassword } from '../../api/auth';
import { CHECKOUTS_QUERY_KEY, DESKTOP_SYNC_QUERY_KEY, listCheckouts, listSyncDevices } from '../../api/desktopSync';
import { PasswordInput } from '../PasswordInput';

export function ChangePasswordForm() {
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaved, setPwSaved] = useState(false);
  const qc = useQueryClient();
  // Changing your password signs out your paired desktops and releases the
  // periods they hold (desktop sync): say so before, not after.
  const { data: devices } = useQuery({
    queryKey: [...DESKTOP_SYNC_QUERY_KEY, false],
    queryFn: async () => (await listSyncDevices(false)).data ?? [],
  });
  const { data: checkouts } = useQuery({
    queryKey: CHECKOUTS_QUERY_KEY,
    queryFn: async () => (await listCheckouts()).data ?? [],
  });
  const myDevices = (devices ?? []).filter((d) => d.mine);
  const myHolds = (checkouts ?? []).filter((c) => c.mine);

  const handleChangePassword = async () => {
    setPwError(null);
    if (pwNew !== pwConfirm) {
      setPwError('The two new-password fields do not match.');
      return;
    }
    if (pwNew === pwCurrent) {
      setPwError('New password must differ from the current one.');
      return;
    }
    setPwSaving(true);
    const res = await changePassword(pwCurrent, pwNew);
    setPwSaving(false);
    if (res.error) {
      setPwError(res.error.message);
      return;
    }
    setPwCurrent('');
    setPwNew('');
    setPwConfirm('');
    setPwSaved(true);
    setTimeout(() => setPwSaved(false), 3000);
    void qc.invalidateQueries({ queryKey: DESKTOP_SYNC_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: CHECKOUTS_QUERY_KEY });
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">Password</h4>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        At least 8 characters with an uppercase letter, a lowercase letter, and a number.
      </p>
      <form
        onSubmit={(e) => { e.preventDefault(); void handleChangePassword(); }}
        className="space-y-3 max-w-sm"
      >
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Current password</label>
          <PasswordInput
            value={pwCurrent}
            onChange={(e) => setPwCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">New password</label>
          <PasswordInput
            value={pwNew}
            onChange={(e) => setPwNew(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            required
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Confirm new password</label>
          <PasswordInput
            value={pwConfirm}
            onChange={(e) => setPwConfirm(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            required
          />
        </div>
        {myDevices.length > 0 && (
          <div className="px-3 py-2 rounded text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
            Changing your password signs out your {myDevices.length === 1 ? 'paired desktop' : `${myDevices.length} paired desktops`} ({myDevices.map((d) => d.name).join(', ')}).
            {myHolds.length > 0 && (
              <> {myHolds.length === 1 ? 'The period it holds' : `The ${myHolds.length} periods they hold`} ({myHolds.map((c) => `${c.clientName} ${c.periodName}`).join(', ')}) will be released: send back any desktop work first, or it may be refused if the period changes here.</>
            )}
            {' '}Pair again from Settings afterwards.
          </div>
        )}
        <button
          type="submit"
          disabled={pwSaving || !pwCurrent || !pwNew || !pwConfirm}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {pwSaving ? 'Changing…' : 'Change Password'}
        </button>
      </form>
      {pwError && (
        <div className="mt-3 px-3 py-2 rounded text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400">{pwError}</div>
      )}
      {pwSaved && (
        <div className="mt-3 px-3 py-2 rounded text-xs bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400">Password changed.</div>
      )}
    </div>
  );
}
