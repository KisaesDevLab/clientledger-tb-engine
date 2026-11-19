// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { useState } from 'react';
import { evalAndFormatAmount } from '../utils/evalAmountExpr';
import { validateJeLines } from '../utils/jeLines';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listJournalEntries,
  createJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
  type JournalEntry,
  type JEInput,
} from '../api/journalEntries';
import { listAccounts, type Account } from '../api/chartOfAccounts';
import { useUIStore } from '../store/uiStore';
import { listPeriods } from '../api/periods';
import { AccountSearchDropdown } from '../components/AccountSearchDropdown';
import { DateInput } from '../components/DateInput';
import { confirmAction } from '../components/ConfirmDialog';
import { useJeLineEditing } from '../hooks/useJeLineEditing';
import { invalidateAfterJournalEntry } from '../lib/queryInvalidation';
import { RefreshButton } from '../components/RefreshButton';
import { CheckoutBanner } from '../components/CheckoutBanner';

function fmt(cents: number): string {
  if (cents === 0) return '—';
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(dateStr: string): string {
  return dateStr.slice(0, 10);
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b dark:border-gray-700 shrink-0">
          <h2 className="text-base font-semibold dark:text-white">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>
        <div className="px-5 py-4 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

interface JEFormLine {
  accountId: number | '';
  debit: string;
  credit: string;
}

function JEForm({
  periodId,
  clientId,
  onSave,
  onCancel,
  saving,
  error,
  initialType,
  initialDate,
  initialDescription,
  initialLines,
  periodEndDate,
}: {
  periodId: number;
  clientId: number;
  onSave: (input: JEInput) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  initialType?: 'book' | 'tax';
  initialDate?: string;
  initialDescription?: string;
  initialLines?: JEFormLine[];
  periodEndDate?: string;
}) {
  const [entryType, setEntryType] = useState<'book' | 'tax'>(initialType ?? 'book');
  const [entryDate, setEntryDate] = useState(initialDate ?? periodEndDate ?? new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState(initialDescription ?? '');
  const [lines, setLines] = useState<JEFormLine[]>(
    initialLines ?? [
      { accountId: '', debit: '', credit: '' },
      { accountId: '', debit: '', credit: '' },
    ],
  );
  const { linesBodyRef, focusDebit, fillBalance } = useJeLineEditing<JEFormLine>();

  const { data: accountsData } = useQuery({
    queryKey: ['chart-of-accounts', clientId],
    queryFn: async () => {
      const res = await listAccounts(clientId);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
  });
  const accounts: Account[] = accountsData ?? [];

  // Totals/validation run on exactly the lines that will post; rows with an
  // amount but no account block submit instead of being silently dropped.
  const lineStatus = validateJeLines(lines);
  const { totalDebit, totalCredit, balanced } = lineStatus;

  const setLine = (idx: number, field: keyof JEFormLine, value: string | number) =>
    setLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));

  const addLine = () => setLines((prev) => [...prev, { accountId: '', debit: '', credit: '' }]);
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!lineStatus.canSubmit) return;
    onSave({
      periodId,
      entryType,
      entryDate,
      description: description || undefined,
      lines: lineStatus.lines,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-3 py-2 rounded text-sm">{error}</div>}

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
          <select
            value={entryType}
            onChange={(e) => setEntryType(e.target.value as 'book' | 'tax')}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
          >
            <option value="book">Book AJE</option>
            <option value="tax">Tax AJE</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
          <DateInput
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            required
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional memo"
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
          />
        </div>
      </div>

      <div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-400">Account</th>
              <th className="px-2 py-1.5 text-right text-xs font-semibold text-gray-600 dark:text-gray-400 w-36">Debit</th>
              <th className="px-2 py-1.5 text-right text-xs font-semibold text-gray-600 dark:text-gray-400 w-36">Credit</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody ref={linesBodyRef} className="divide-y divide-gray-100 dark:divide-gray-700">
            {lines.map((line, idx) => (
              <tr key={idx}>
                <td className="px-1 py-1">
                  <AccountSearchDropdown
                    accounts={accounts}
                    value={line.accountId}
                    onChange={(accountId) => setLine(idx, 'accountId', accountId)}
                    onSelected={() => focusDebit(idx)}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    data-je-debit={idx}
                    value={line.debit}
                    onChange={(e) => setLine(idx, 'debit', e.target.value)}
                    onBlur={(e) => setLine(idx, 'debit', evalAndFormatAmount(e.target.value))}
                    onKeyDown={(e) => { if (e.key === 'Enter') setLine(idx, 'debit', evalAndFormatAmount((e.target as HTMLInputElement).value)); }}
                    placeholder="0.00"
                    className="w-full text-right border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    value={line.credit}
                    onChange={(e) => setLine(idx, 'credit', e.target.value)}
                    onBlur={(e) => setLine(idx, 'credit', evalAndFormatAmount(e.target.value))}
                    onKeyDown={(e) => { if (e.key === 'Enter') setLine(idx, 'credit', evalAndFormatAmount((e.target as HTMLInputElement).value)); }}
                    placeholder="0.00"
                    className="w-full text-right border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                  />
                </td>
                <td className="px-1 py-1 text-center">
                  {lines.length > 2 && (
                    <button type="button" onClick={() => removeLine(idx)} aria-label="Remove line" className="text-gray-400 dark:text-gray-500 hover:text-red-500 text-lg leading-none">&times;</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/60">
              <td className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
                <button type="button" onClick={addLine} className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-xs">+ Add line</button>
              </td>
              <td className={`px-2 py-1.5 text-right text-sm font-semibold ${balanced ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {fmt(totalDebit)}
              </td>
              <td className={`px-2 py-1.5 text-right text-sm font-semibold ${balanced ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {fmt(totalCredit)}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
        {!balanced && (totalDebit > 0 || totalCredit > 0) && (
          <button
            type="button"
            onClick={() => fillBalance(lines, setLines)}
            title="Put the balancing amount on the last line"
            className="block text-xs text-red-600 dark:text-red-400 mt-1 underline decoration-dotted underline-offset-2 hover:text-red-700 dark:hover:text-red-300"
          >
            Entry is out of balance by {fmt(Math.abs(totalDebit - totalCredit))}. Click to balance.
          </button>
        )}
        {lineStatus.blockers.map((b) => (
          <p key={b} className="text-xs text-red-600 dark:text-red-400 mt-1">{b}</p>
        ))}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300">Cancel</button>
        <button
          type="submit"
          disabled={saving || !lineStatus.canSubmit}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Entry'}
        </button>
      </div>
    </form>
  );
}

function TransEditForm({
  entry,
  clientId,
  onSave,
  onCancel,
  saving,
  error,
}: {
  entry: JournalEntry;
  clientId: number;
  onSave: (data: { entryDate: string; description: string | null; lines: { accountId: number; debit: number; credit: number }[] }) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const [entryDate, setEntryDate] = useState(fmtDate(entry.entry_date));
  const [description, setDescription] = useState(entry.description ?? '');
  const [lines, setLines] = useState<JEFormLine[]>(
    entry.lines.map((l) => ({
      accountId: l.account_id,
      debit: l.debit > 0 ? (l.debit / 100).toFixed(2) : '',
      credit: l.credit > 0 ? (l.credit / 100).toFixed(2) : '',
    })),
  );
  const { linesBodyRef, focusDebit, fillBalance } = useJeLineEditing<JEFormLine>();

  const { data: accountsData } = useQuery({
    queryKey: ['chart-of-accounts', clientId],
    queryFn: async () => { const res = await listAccounts(clientId); if (res.error) throw new Error(res.error.message); return res.data; },
  });
  const accounts: Account[] = accountsData ?? [];

  const lineStatus = validateJeLines(lines);
  const { totalDebit, totalCredit, balanced } = lineStatus;

  const setLine = (idx: number, field: keyof JEFormLine, value: string | number) =>
    setLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  const addLine = () => setLines((prev) => [...prev, { accountId: '', debit: '', credit: '' }]);
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!lineStatus.canSubmit) return;
    onSave({
      entryDate,
      description: description || null,
      lines: lineStatus.lines,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-3 py-2 rounded text-sm">{error}</div>}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
          <div className="px-2 py-1.5 text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded">Transaction</div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
          <DateInput value={entryDate} onChange={(e) => setEntryDate(e.target.value)} required className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional memo" className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400" />
        </div>
      </div>
      <div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-400">Account</th>
              <th className="px-2 py-1.5 text-right text-xs font-semibold text-gray-600 dark:text-gray-400 w-36">Debit</th>
              <th className="px-2 py-1.5 text-right text-xs font-semibold text-gray-600 dark:text-gray-400 w-36">Credit</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody ref={linesBodyRef} className="divide-y divide-gray-100 dark:divide-gray-700">
            {lines.map((line, idx) => (
              <tr key={idx}>
                <td className="px-1 py-1">
                  <AccountSearchDropdown accounts={accounts} value={line.accountId} onChange={(accountId) => setLine(idx, 'accountId', accountId)} onSelected={() => focusDebit(idx)} />
                </td>
                <td className="px-1 py-1">
                  <input data-je-debit={idx} value={line.debit} onChange={(e) => setLine(idx, 'debit', e.target.value)} onBlur={(e) => setLine(idx, 'debit', evalAndFormatAmount(e.target.value))} placeholder="0.00" className="w-full text-right border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400" />
                </td>
                <td className="px-1 py-1">
                  <input value={line.credit} onChange={(e) => setLine(idx, 'credit', e.target.value)} onBlur={(e) => setLine(idx, 'credit', evalAndFormatAmount(e.target.value))} placeholder="0.00" className="w-full text-right border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400" />
                </td>
                <td className="px-1 py-1 text-center">
                  {lines.length > 2 && <button type="button" onClick={() => removeLine(idx)} aria-label="Remove line" className="text-gray-400 dark:text-gray-500 hover:text-red-500 text-lg leading-none">&times;</button>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/60">
              <td className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
                <button type="button" onClick={addLine} className="text-teal-600 hover:text-teal-800 dark:text-teal-400 dark:hover:text-teal-300 text-xs">+ Add line</button>
              </td>
              <td className={`px-2 py-1.5 text-right text-sm font-semibold ${balanced ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{fmt(totalDebit)}</td>
              <td className={`px-2 py-1.5 text-right text-sm font-semibold ${balanced ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{fmt(totalCredit)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
        {!balanced && (totalDebit > 0 || totalCredit > 0) && (
          <button
            type="button"
            onClick={() => fillBalance(lines, setLines)}
            title="Put the balancing amount on the last line"
            className="block text-xs text-red-600 dark:text-red-400 mt-1 underline decoration-dotted underline-offset-2 hover:text-red-700 dark:hover:text-red-300"
          >
            Entry is out of balance by {fmt(Math.abs(totalDebit - totalCredit))}. Click to balance.
          </button>
        )}
        {lineStatus.blockers.map((b) => (
          <p key={b} className="text-xs text-red-600 dark:text-red-400 mt-1">{b}</p>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300">Cancel</button>
        <button type="submit" disabled={saving || !lineStatus.canSubmit} className="px-3 py-1.5 text-sm bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Entry'}
        </button>
      </div>
    </form>
  );
}

function JEDetail({ entry }: { entry: JournalEntry }) {
  const totalDebit = entry.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = entry.lines.reduce((s, l) => s + l.credit, 0);
  return (
    <div className="mt-2 border-t border-gray-100 dark:border-gray-700 pt-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 dark:text-gray-400">
            <th className="text-left pb-1 font-medium">Account</th>
            <th className="text-right pb-1 font-medium w-28">Debit</th>
            <th className="text-right pb-1 font-medium w-28">Credit</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l, i) => (
            <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
              <td className="py-0.5 text-sm text-gray-700 dark:text-gray-300"><span className="font-mono">{l.account_number}</span> – {l.account_name}</td>
              <td className="py-0.5 text-right text-sm font-mono text-gray-700 dark:text-gray-300">{l.debit > 0 ? fmt(l.debit) : ''}</td>
              <td className="py-0.5 text-right text-sm font-mono text-gray-700 dark:text-gray-300">{l.credit > 0 ? fmt(l.credit) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-300 dark:border-gray-600 font-semibold text-gray-700 dark:text-gray-300">
            <td className="pt-1">Total</td>
            <td className="pt-1 text-right text-sm font-mono">{fmt(totalDebit)}</td>
            <td className="pt-1 text-right text-sm font-mono">{fmt(totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function JournalEntriesPage() {
  const { selectedPeriodId, selectedClientId } = useUIStore();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editEntry, setEditEntry] = useState<JournalEntry | null>(null);
  // collapsed tracks which entries are folded; default = all expanded
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | 'book' | 'tax' | 'trans'>('all');

  const { data: periodsData } = useQuery({
    queryKey: ['periods', selectedClientId],
    queryFn: async () => { const r = await listPeriods(selectedClientId!); return r.data ?? []; },
    enabled: !!selectedClientId,
  });
  const currentPeriod = periodsData?.find((p) => p.id === selectedPeriodId);

  const queryKey = ['journal-entries', selectedPeriodId, typeFilter];

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!selectedPeriodId) return [];
      const res = await listJournalEntries(selectedPeriodId, typeFilter === 'all' ? undefined : typeFilter);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: selectedPeriodId !== null,
  });

  const invalidateAll = () => {
    invalidateAfterJournalEntry(qc);
  };

  const createMutation = useMutation({
    mutationFn: createJournalEntry,
    onSuccess: (res) => {
      if (res.error) { setFormError(res.error.message); return; }
      invalidateAll();
      setShowAdd(false);
      setFormError(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateJournalEntry>[1] }) =>
      updateJournalEntry(id, data),
    onSuccess: (res) => {
      if (res.error) { setFormError(res.error.message); return; }
      invalidateAll();
      setEditEntry(null);
      setFormError(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteJournalEntry,
    onSuccess: () => invalidateAll(),
  });

  const toggleCollapsed = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  if (!selectedPeriodId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500">
        <div className="text-center">
          <p className="text-lg font-medium">No period selected</p>
          <p className="text-sm mt-1">Choose a client and period from the sidebar.</p>
        </div>
      </div>
    );
  }

  const entries = data ?? [];
  const bookCount = entries.filter((e) => e.entry_type === 'book').length;
  const taxCount = entries.filter((e) => e.entry_type === 'tax').length;
  const transCount = entries.filter((e) => e.entry_type === 'trans').length;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Journal Entries<RefreshButton /></h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {bookCount} book · {taxCount} tax · {transCount} trans
          </p>
          <CheckoutBanner className="mt-2" />
        </div>
        <div className="flex items-center gap-3">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
          >
            <option value="all">All types</option>
            <option value="book">Book AJE</option>
            <option value="tax">Tax AJE</option>
            <option value="trans">Trans</option>
          </select>
          <button
            onClick={() => { setShowAdd(true); setFormError(null); }}
            className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
          >
            + New Entry
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-4 py-3 rounded text-sm mb-4">{error.message}</div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-400 dark:text-gray-500">Loading...</div>
      ) : entries.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-10 text-center text-gray-400 dark:text-gray-500">
          No journal entries yet. Click &ldquo;+ New Entry&rdquo; to add an AJE.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const isExpanded = !collapsed.has(entry.id);
            return (
              <div key={entry.id} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div
                  className="flex items-center px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  onClick={() => toggleCollapsed(entry.id)}
                >
                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold mr-3 ${
                    entry.entry_type === 'book' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400'
                    : entry.entry_type === 'tax' ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400'
                    : 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                  }`}>
                    {entry.entry_type === 'book' ? 'BOOK' : entry.entry_type === 'tax' ? 'TAX' : 'TRANS'} #{entry.entry_number}
                  </span>
                  {entry.source_tag === 'py_tieout' && (
                    <span
                      title="Prior-year true-up, created from the PY Tie-Out screen. Posted in the current year; that screen shows what it does to the prior year."
                      className="inline-flex px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 mr-3 whitespace-nowrap"
                    >
                      PY true-up
                    </span>
                  )}
                  {entry.workpaper_ref && (
                    <span
                      title="Supporting workpaper"
                      className="inline-flex px-1.5 py-0.5 rounded text-xs font-mono bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 mr-3 whitespace-nowrap"
                    >
                      W/P {entry.workpaper_ref}
                    </span>
                  )}
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300 flex-1">{entry.description ?? '(no description)'}</span>
                  <span className="text-sm text-gray-400 dark:text-gray-500 mr-4">{fmtDate(entry.entry_date)}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditEntry(entry); setFormError(null); }}
                    className="text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 mr-3"
                  >
                    Edit
                  </button>
                  <button
                    onClick={async (e) => { e.stopPropagation(); if (await confirmAction({ message: `Delete this ${entry.entry_type === 'trans' ? 'transaction entry' : 'journal entry'}?${entry.entry_type === 'trans' ? '\n\nThe linked bank transaction will be unclassified.' : ''}`, tone: 'danger' })) deleteMutation.mutate(entry.id); }}
                    className="text-xs text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 mr-2"
                  >
                    Delete
                  </button>
                  <span className="text-gray-400 dark:text-gray-500 text-sm">{isExpanded ? '▲' : '▼'}</span>
                </div>
                {isExpanded && (
                  <div className="px-4 pb-4">
                    <JEDetail entry={entry} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && selectedClientId && (
        <Modal title="New Journal Entry" onClose={() => setShowAdd(false)}>
          <JEForm
            periodId={selectedPeriodId}
            clientId={selectedClientId}
            onSave={(input) => createMutation.mutate(input)}
            onCancel={() => setShowAdd(false)}
            saving={createMutation.isPending}
            error={formError}
            periodEndDate={currentPeriod?.end_date?.slice(0, 10)}
          />
        </Modal>
      )}

      {editEntry && selectedClientId && editEntry.entry_type !== 'trans' && (
        <Modal title="Edit Journal Entry" onClose={() => { setEditEntry(null); setFormError(null); }}>
          <JEForm
            periodId={selectedPeriodId}
            clientId={selectedClientId}
            initialType={editEntry.entry_type as 'book' | 'tax'}
            initialDate={fmtDate(editEntry.entry_date)}
            initialDescription={editEntry.description ?? ''}
            initialLines={editEntry.lines.map((l) => ({
              accountId: l.account_id,
              debit: l.debit > 0 ? (l.debit / 100).toFixed(2) : '',
              credit: l.credit > 0 ? (l.credit / 100).toFixed(2) : '',
            }))}
            onSave={(input) =>
              updateMutation.mutate({
                id: editEntry.id,
                data: { entryType: input.entryType, entryDate: input.entryDate, description: input.description ?? null, lines: input.lines },
              })
            }
            onCancel={() => { setEditEntry(null); setFormError(null); }}
            saving={updateMutation.isPending}
            error={formError}
          />
        </Modal>
      )}

      {editEntry && selectedClientId && editEntry.entry_type === 'trans' && (
        <Modal title="Edit Transaction Entry" onClose={() => { setEditEntry(null); setFormError(null); }}>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Changes will sync to the linked bank transaction.</p>
          <TransEditForm
            entry={editEntry}
            clientId={selectedClientId}
            onSave={(data) =>
              updateMutation.mutate({
                id: editEntry.id,
                data: { entryDate: data.entryDate, description: data.description, lines: data.lines },
              })
            }
            onCancel={() => { setEditEntry(null); setFormError(null); }}
            saving={updateMutation.isPending}
            error={formError}
          />
        </Modal>
      )}
    </div>
  );
}
