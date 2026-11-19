// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listPeriods,
  createPeriod,
  updatePeriod,
  deletePeriod,
  lockPeriod,
  unlockPeriod,
  releaseCheckout,
  rollForwardPeriod,
  type Period,
  type PeriodInput,
  type RollForwardInput,
  type RollForwardMode,
} from '../api/periods';
import { listAccounts, type Account } from '../api/chartOfAccounts';
import { useUIStore, useAuthStore } from '../store/uiStore';
import { DateInput } from '../components/DateInput';
import { confirmAction } from '../components/ConfirmDialog';
import { RefreshButton } from '../components/RefreshButton';
import { checkoutSentence } from '../components/CheckoutBanner';

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b dark:border-gray-700">
          <h2 className="text-base font-semibold dark:text-white">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

interface PeriodFormProps {
  initial?: Partial<PeriodInput>;
  onSave: (input: PeriodInput) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}

function PeriodForm({ initial, onSave, onCancel, saving, error }: PeriodFormProps) {
  const [form, setForm] = useState<PeriodInput>({
    periodName: initial?.periodName ?? '',
    startDate: initial?.startDate ?? '',
    endDate: initial?.endDate ?? '',
    isCurrent: initial?.isCurrent ?? false,
    folderYear: initial?.folderYear ?? '',
  });

  const set = <K extends keyof PeriodInput>(k: K, v: PeriodInput[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave({ ...form, startDate: form.startDate || undefined, endDate: form.endDate || undefined, folderYear: form.folderYear?.trim() || null }); }} className="space-y-4">
      {error && <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-3 py-2 rounded text-sm">{error}</div>}
      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Period Name</label>
        <input
          value={form.periodName}
          onChange={(e) => set('periodName', e.target.value)}
          placeholder="e.g. FY 2025, Q1 2025"
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
          required
          autoFocus
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Start Date</label>
          <DateInput
            value={form.startDate ?? ''}
            onChange={(e) => set('startDate', e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">End Date</label>
          <DateInput
            value={form.endDate ?? ''}
            onChange={(e) => set('endDate', e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Document Year Folder</label>
        <input
          value={form.folderYear ?? ''}
          onChange={(e) => set('folderYear', e.target.value)}
          placeholder="Derived from the end date"
          maxLength={20}
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          The year folder documents for this period are filed under. Leave blank to derive it from the
          end date and the client's tax year end — set it for a short year, a stub period, or your own naming.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
        <input
          type="checkbox"
          checked={form.isCurrent ?? false}
          onChange={(e) => set('isCurrent', e.target.checked)}
          className="rounded border-gray-300 text-blue-600"
        />
        Mark as current period
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300">Cancel</button>
        <button type="submit" disabled={saving} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function RollForwardModal({ source, onClose }: { source: Period; onClose: () => void }) {
  const { selectedClientId } = useUIStore();
  const [form, setForm] = useState<RollForwardInput>({
    periodName: `${source.period_name} (copy)`,
    startDate: '',
    endDate: '',
    isCurrent: false,
    copyRecurringJEs: true,
    keepWorkpaperRefs: true,
    mode: 'all_balances',
  });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tbCount: number; jeCopied: number } | null>(null);

  // Load equity accounts for retained earnings selector
  const { data: accounts } = useQuery({
    queryKey: ['chart-of-accounts', selectedClientId],
    queryFn: async () => {
      if (!selectedClientId) return [];
      const res = await listAccounts(selectedClientId);
      if (res.error) return [];
      return res.data ?? [];
    },
    enabled: !!selectedClientId,
  });
  const equityAccounts = (accounts ?? []).filter((a: Account) => a.category === 'equity');

  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: RollForwardInput) => rollForwardPeriod(source.id, input),
    onSuccess: (res) => {
      if (res.error) { setError(res.error.message); return; }
      setResult({ tbCount: res.data!.tbCount, jeCopied: res.data!.jeCopied });
      // Invalidate periods list immediately so it's fresh when modal closes
      qc.invalidateQueries({ queryKey: ['periods'] });
    },
  });

  const set = <K extends keyof RollForwardInput>(k: K, v: RollForwardInput[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const MODE_LABELS: Record<RollForwardMode, string> = {
    all_balances: 'Roll forward all balances',
    close_income: 'Close income/expense to retained earnings',
    zero_balances: 'Create new period with zero balances',
  };

  const MODE_DESCRIPTIONS: Record<RollForwardMode, string> = {
    all_balances: 'All book-adjusted balances become opening balances in the new period.',
    close_income: 'Balance sheet accounts carry forward. Revenue and expense accounts reset to zero, and net income/loss is closed to a selected equity account.',
    zero_balances: 'All accounts are created in the new period with zero balances. No balances are carried forward.',
  };

  return (
    <Modal title={`Roll Forward — ${source.period_name}`} onClose={onClose}>
      {result ? (
        <div className="space-y-4">
          <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded px-4 py-3 text-sm text-green-800 dark:text-green-400">
            New period created. <strong>{result.tbCount}</strong> TB accounts rolled forward
            {result.jeCopied > 0 && <>, <strong>{result.jeCopied}</strong> recurring JE{result.jeCopied !== 1 ? 's' : ''} copied</>}.
          </div>
          <div className="flex justify-end">
            <button onClick={onClose} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">Done</button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(form); }} className="space-y-4">
          {error && <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-3 py-2 rounded text-sm">{error}</div>}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">New Period Name</label>
            <input
              value={form.periodName}
              onChange={(e) => set('periodName', e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              required autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Start Date</label>
              <DateInput value={form.startDate ?? ''} onChange={(e) => set('startDate', e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">End Date</label>
              <DateInput value={form.endDate ?? ''} onChange={(e) => set('endDate', e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white" />
            </div>
          </div>

          {/* Balance mode selector */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Opening Balances</label>
            <div className="space-y-2">
              {(['all_balances', 'close_income', 'zero_balances'] as RollForwardMode[]).map((m) => (
                <label key={m} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="radio"
                    name="rollForwardMode"
                    checked={form.mode === m}
                    onChange={() => set('mode', m)}
                    className="mt-0.5 text-blue-600"
                  />
                  <div>
                    <span className="font-medium">{MODE_LABELS[m]}</span>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{MODE_DESCRIPTIONS[m]}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Retained earnings account selector — only for close_income mode */}
          {form.mode === 'close_income' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Close Net Income To</label>
              <select
                value={form.retainedEarningsAccountId ?? ''}
                onChange={(e) => set('retainedEarningsAccountId', e.target.value ? Number(e.target.value) : undefined)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                required
              >
                <option value="">Select equity account…</option>
                {equityAccounts.map((a: Account) => (
                  <option key={a.id} value={a.id}>{a.account_number} — {a.account_name}</option>
                ))}
              </select>
              {equityAccounts.length === 0 && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">No equity accounts found. Create a retained earnings account in Chart of Accounts first.</p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input type="checkbox" checked={form.copyRecurringJEs ?? true} onChange={(e) => set('copyRecurringJEs', e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-600 text-blue-600" />
              Copy recurring journal entries to new period
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input type="checkbox" checked={form.keepWorkpaperRefs ?? true} onChange={(e) => set('keepWorkpaperRefs', e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-600 text-blue-600" />
              Keep workpaper references
              <span className="text-[11px] text-gray-400 dark:text-gray-500">(uncheck to clear WP refs for new period)</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input type="checkbox" checked={form.isCurrent ?? false} onChange={(e) => set('isCurrent', e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-600 text-blue-600" />
              Mark new period as current
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300">Cancel</button>
            <button type="submit" disabled={mutation.isPending || (form.mode === 'close_income' && !form.retainedEarningsAccountId)}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              {mutation.isPending ? 'Creating…' : 'Create New Period'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function PeriodsPage() {
  const { selectedClientId, setSelectedPeriodId } = useUIStore();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editPeriod, setEditPeriod] = useState<Period | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [rollForwardSource, setRollForwardSource] = useState<Period | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  /** Desktop sync: the period an admin is releasing, and why. */
  const [releaseFor, setReleaseFor] = useState<Period | null>(null);
  const [releaseReason, setReleaseReason] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['periods', selectedClientId],
    queryFn: async () => {
      if (!selectedClientId) return [];
      const res = await listPeriods(selectedClientId);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: selectedClientId !== null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['periods', selectedClientId] });

  const createMutation = useMutation({
    mutationFn: (input: PeriodInput) => createPeriod(selectedClientId!, input),
    onSuccess: (res) => {
      if (res.error) { setFormError(res.error.message); return; }
      invalidate(); setShowAdd(false); setFormError(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: number; input: Partial<PeriodInput> }) => updatePeriod(id, input),
    onSuccess: (res) => {
      if (res.error) { setFormError(res.error.message); return; }
      invalidate(); setEditPeriod(null); setFormError(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deletePeriod,
    // apiFetch resolves with { error } rather than throwing, so a refused
    // delete (409 PERIOD_IN_USE, locked, 500) must be read here or it is
    // silently swallowed and the row just stays put.
    onSuccess: (res) => {
      if (res.error) { setLockError(res.error.message); return; }
      invalidate();
    },
  });

  const lockMutation = useMutation({
    mutationFn: lockPeriod,
    onSuccess: (res) => {
      if (res.error) { setLockError(res.error.message); return; }
      setLockError(null);
      invalidate();
    },
  });

  const releaseMutation = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => releaseCheckout(id, reason),
    onSuccess: (res) => {
      if (res.error) { setLockError(res.error.message); return; }
      setLockError(null);
      setReleaseFor(null);
      setReleaseReason('');
      invalidate();
    },
  });

  const unlockMutation = useMutation({
    mutationFn: unlockPeriod,
    onSuccess: (res) => {
      if (res.error) { setLockError(res.error.message); return; }
      setLockError(null);
      invalidate();
    },
  });

  if (!selectedClientId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500">
        <div className="text-center">
          <p className="text-lg font-medium">No client selected</p>
          <p className="text-sm mt-1">Choose a client from the sidebar.</p>
        </div>
      </div>
    );
  }

  const periods = data ?? [];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Periods<RefreshButton /></h2>
          <p className="text-sm text-gray-500 dark:text-gray-500 mt-0.5">{periods.length} period{periods.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => { setShowAdd(true); setFormError(null); }}
          className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >
          + Add Period
        </button>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-4 py-3 rounded text-sm mb-4">{error.message}</div>
      )}

      {lockError && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-4 py-2 text-sm rounded mb-3">
          {lockError}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-400 dark:text-gray-500">Loading...</div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Period</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Start</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">End</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Lock</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {periods.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">
                    No periods yet. Click &ldquo;+ Add Period&rdquo; to create one.
                  </td>
                </tr>
              ) : (
                periods.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{p.period_name}</td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{p.start_date?.slice(0, 10) ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{p.end_date?.slice(0, 10) ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      {p.is_current ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400">Current</span>
                      ) : (
                        <button
                          onClick={() => updateMutation.mutate({ id: p.id, input: { isCurrent: true } })}
                          className="text-xs text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400"
                        >
                          Set current
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {p.checkout ? (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${p.checkout.stale ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300' : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'}`}>
                              {p.checkout.stale ? 'Checked out (stale)' : 'Checked out'}
                            </span>
                            {isAdmin && (
                              <button
                                onClick={() => { setReleaseFor(p); setReleaseReason(''); }}
                                title="End this desktop's check-out"
                                className="text-xs text-gray-400 dark:text-gray-500 hover:text-amber-600 dark:hover:text-amber-400"
                              >
                                Release
                              </button>
                            )}
                          </div>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{checkoutSentence(p.checkout)}</span>
                        </div>
                      ) : p.locked_at ? (
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400">Locked</span>
                          {isAdmin && (
                            <button
                              onClick={async () => { if (await confirmAction({ message: `Unlock "${p.period_name}"? Changes will be permitted again.`, confirmLabel: 'Unlock' })) unlockMutation.mutate(p.id); }}
                              title="Unlock this period to allow changes"
                              className="text-xs text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400"
                            >
                              Unlock
                            </button>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={async () => { if (await confirmAction({ message: `Lock "${p.period_name}"? No changes can be made until unlocked.`, confirmLabel: 'Lock' })) { setLockError(null); lockMutation.mutate(p.id); } }}
                          title="Lock this period"
                          className="text-xs text-gray-400 dark:text-gray-500 hover:text-amber-600 dark:hover:text-amber-400"
                        >
                          Lock
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => { setSelectedPeriodId(p.id); }}
                        className="text-xs text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 mr-3"
                      >
                        Select
                      </button>
                      <button
                        onClick={() => setRollForwardSource(p)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 mr-3"
                      >
                        Roll Forward
                      </button>
                      <button
                        onClick={() => { setEditPeriod(p); setFormError(null); }}
                        disabled={!!p.locked_at || !!p.checkout}
                        title={p.checkout ? 'A desktop has this period checked out.' : p.locked_at ? 'Period is locked. Unlock it to edit.' : 'Edit period'}
                        className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 mr-3 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Edit
                      </button>
                      <button
                        onClick={async () => { if (await confirmAction({ message: `Delete "${p.period_name}"?`, tone: 'danger' })) deleteMutation.mutate(p.id); }}
                        disabled={!!p.locked_at || !!p.checkout}
                        title={p.checkout ? 'A desktop has this period checked out.' : p.locked_at ? 'Period is locked. Unlock it to delete.' : 'Delete period'}
                        className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <Modal title="Add Period" onClose={() => setShowAdd(false)}>
          <PeriodForm
            onSave={(input) => createMutation.mutate(input)}
            onCancel={() => setShowAdd(false)}
            saving={createMutation.isPending}
            error={formError}
          />
        </Modal>
      )}

      {releaseFor && (
        <Modal title={`Release "${releaseFor.period_name}"?`} onClose={() => setReleaseFor(null)}>
          <form
            onSubmit={(e) => { e.preventDefault(); releaseMutation.mutate({ id: releaseFor.id, reason: releaseReason.trim() }); }}
            className="space-y-3"
          >
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {releaseFor.checkout ? checkoutSentence(releaseFor.checkout) : ''} Releasing lets this period be changed here again.
              Work not yet sent back from that desktop stays on it, and can be sent back only if the period has not changed here since.
            </p>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Why (kept in the audit log)
              <input
                autoFocus
                value={releaseReason}
                onChange={(e) => setReleaseReason(e.target.value)}
                maxLength={500}
                placeholder="e.g. the laptop was lost"
                className="mt-1 w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:text-white"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReleaseFor(null)} className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300">Cancel</button>
              <button
                type="submit"
                disabled={releaseReason.trim().length < 3 || releaseMutation.isPending}
                className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
              >
                {releaseMutation.isPending ? 'Releasing…' : 'Release'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {rollForwardSource && (
        <RollForwardModal
          source={rollForwardSource}
          onClose={() => { setRollForwardSource(null); invalidate(); }}
        />
      )}

      {editPeriod && (
        <Modal title="Edit Period" onClose={() => setEditPeriod(null)}>
          <PeriodForm
            initial={{
              periodName: editPeriod.period_name,
              startDate: editPeriod.start_date?.slice(0, 10) ?? '',
              endDate: editPeriod.end_date?.slice(0, 10) ?? '',
              isCurrent: editPeriod.is_current,
              folderYear: editPeriod.folder_year,
            }}
            onSave={(input) => updateMutation.mutate({ id: editPeriod.id, input })}
            onCancel={() => setEditPeriod(null)}
            saving={updateMutation.isPending}
            error={formError}
          />
        </Modal>
      )}
    </div>
  );
}
