// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { evalAmountExpr } from '../utils/evalAmountExpr';
import { CsvImportDialog } from '../components/CsvImportDialog';
import { PdfImportDialog } from '../components/PdfImportDialog';
import { QboImportDialog } from '../components/QboImportDialog';
import { JournalEntryDialog } from '../components/JournalEntryDialog';
import { JournalEntryEditDialog } from '../components/JournalEntryEditDialog';
import { VerificationPanel } from '../components/VerificationPanel';
import { TransJEZoomModal } from '../components/TransJEZoomModal';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getGroupedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  getTrialBalance,
  initializeTrialBalance,
  updateBalance,
  importTBBalances,
  importPriorYearBalances,
  type TBRow,
  type TBImportRow,
} from '../api/trialBalance';
import { updateAccount, type AccountInput } from '../api/chartOfAccounts';
import { listClients } from '../api/clients';
import { listPeriods, type Period } from '../api/periods';
import { useUIStore, pushToast } from '../store/uiStore';
import { engagementFilename } from '../utils/reportFilename';
import { TickmarkPickerModal } from '../components/TickmarkPickerModal';
import { invalidateAfterBalanceChange, invalidateAfterJournalEntry, invalidateAfterTickmarkToggle } from '../lib/queryInvalidation';
import { RefreshButton } from '../components/RefreshButton';
import { CheckoutBanner } from '../components/CheckoutBanner';
import {
  listTickmarks,
  getTBTickmarks,
  toggleTBTickmark,
  TICKMARK_COLOR_CLASSES,
  type Tickmark,
  type TBTickmarkMap,
} from '../api/tickmarks';
import { listImports, type DocumentImport } from '../api/pdfImport';
import { useQboConnections, findQboConnection } from '../hooks/useQboConnections';
import { useFeatures } from '../hooks/useFeatures';
import { downloadXlsx } from '../utils/downloadXlsx';
import { checkFileSize } from '../utils/fileLimits';
import { openTBPopout } from './TBPopoutPage';

// ─── Types ───────────────────────────────────────────────────────────────────

type EditableColKey =
  | 'account_number'
  | 'account_name'
  | 'unadjusted_debit'
  | 'unadjusted_credit'
  | 'unaj_net'
  | 'category'
  | 'workpaper_ref';

const EDITABLE_COLS: EditableColKey[] = [
  'account_number',
  'account_name',
  'unadjusted_debit',
  'unadjusted_credit',
  'category',
  'workpaper_ref',
];

// Navigation cols for single-column mode (replaces the two debit/credit cols with unaj_net)
const EDITABLE_COLS_SINGLE: EditableColKey[] = [
  'account_number',
  'account_name',
  'unaj_net',
  'category',
  'workpaper_ref',
];

const ACCOUNT_CATEGORIES: TBRow['category'][] = ['assets', 'liabilities', 'equity', 'revenue', 'expenses'];

interface ActiveCell { row: number; col: EditableColKey }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(cents: number): string {
  if (cents === 0) return '—';
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTotal(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Returns integer cents, or NaN when the input is not a valid amount or
// expression. NaN must be rejected by the caller — silently stripping the
// invalid characters would synthesize a different number ("100/0" → "1000").
function parseCents(val: string): number {
  const evaled = evalAmountExpr(val);
  const cleaned = evaled.replace(/[$,\s]/g, '');
  if (cleaned === '') return 0;
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return NaN;
  return Math.round(parseFloat(cleaned) * 100);
}

const CATEGORY_COLORS: Record<string, string> = {
  assets: 'bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  liabilities: 'bg-orange-50 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  equity: 'bg-purple-50 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400',
  revenue: 'bg-green-50 dark:bg-green-900/40 text-green-700 dark:text-green-400',
  expenses: 'bg-red-50 dark:bg-red-900/40 text-red-700 dark:text-red-400',
};

// Column group styles keyed by column ID — works correctly regardless of visibility
function colClass(columnId: string, isHeader = false): string {
  const b  = isHeader ? 'border-gray-300 dark:border-gray-600' : 'border-gray-200 dark:border-gray-700';
  const br = `border-r ${b}`;
  switch (columnId) {
    case 'category':             return br;
    case 'prior_year_debit':     return `bg-gray-100${isHeader ? '' : '/60'} dark:bg-gray-600/20`;
    case 'prior_year_credit':    return `bg-gray-100${isHeader ? '' : '/60'} dark:bg-gray-600/20 ${br}`;
    case 'py_balance':           return `bg-gray-100${isHeader ? '' : '/60'} dark:bg-gray-600/20 ${br}`;
    case 'unadjusted_credit':    return br;
    // Trans JE columns (teal)
    case 'trans_adj_debit':      return `bg-teal-50${isHeader ? '' : '/50'} dark:bg-teal-900/20`;
    case 'trans_adj_credit':     return `bg-teal-50${isHeader ? '' : '/50'} dark:bg-teal-900/20 ${br}`;
    case 'book_adj_credit':      return br;
    case 'book_adjusted_debit':  return `bg-blue-50${isHeader ? '' : '/50'} dark:bg-blue-900/20`;
    case 'book_adjusted_credit': return `bg-blue-50${isHeader ? '' : '/50'} dark:bg-blue-900/20 ${br}`;
    case 'tax_adj_credit':       return br;
    case 'tax_adjusted_debit':   return `bg-purple-50${isHeader ? '' : '/50'} dark:bg-purple-900/20`;
    case 'tax_adjusted_credit':  return `bg-purple-50${isHeader ? '' : '/50'} dark:bg-purple-900/20 ${br}`;
    // Single-column view IDs
    case 'unaj_balance':         return br;
    case 'trans_adj_balance':    return br;
    case 'post_trans_balance':   return `bg-teal-50${isHeader ? '' : '/50'} dark:bg-teal-900/20 ${br}`;
    case 'book_adj_balance':     return br;
    case 'book_balance':         return `bg-blue-50${isHeader ? '' : '/50'} dark:bg-blue-900/20 ${br}`;
    case 'tax_adj_balance':      return br;
    case 'tax_balance':          return `bg-purple-50${isHeader ? '' : '/50'} dark:bg-purple-900/20 ${br}`;
    default:                     return '';
  }
}

function getCellDisplayValue(rowData: TBRow, col: EditableColKey): string {
  switch (col) {
    case 'account_number':    return rowData.account_number;
    case 'account_name':      return rowData.account_name;
    case 'unadjusted_debit':  return rowData.unadjusted_debit === 0 ? '' : (rowData.unadjusted_debit / 100).toFixed(2);
    case 'unadjusted_credit': return rowData.unadjusted_credit === 0 ? '' : (rowData.unadjusted_credit / 100).toFixed(2);
    case 'unaj_net': {
      const net = rowData.unadjusted_debit - rowData.unadjusted_credit;
      return net === 0 ? '' : (net / 100).toFixed(2);
    }
    case 'category':          return rowData.category;
    case 'workpaper_ref':     return rowData.workpaper_ref ?? '';
  }
}

const columnHelper = createColumnHelper<TBRow>();

/**
 * Fixed leading columns in BOTH view modes: Acct #, Account Name, Cat., LS.
 * The group header and the subtotal/total rows span this many cells before
 * the amount columns start — hard-coding 3 is what shifted the "Prior Year /
 * Unadjusted / AJE" group row one column to the left when LS was added.
 */
const FIXED_COLS = 4;

// ─── Page component ───────────────────────────────────────────────────────────

export function TrialBalancePage() {
  const { selectedPeriodId, selectedClientId } = useUIStore();
  const qc = useQueryClient();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [lastSyncMsg, setLastSyncMsg] = useState<string | null>(null);
  const [syncedUpToDate, setSyncedUpToDate] = useState(false);
  // View toggles live in the persisted UI store so they survive navigation
  // and reloads — a preparer who works single-column with PY on should not
  // have to re-tick both every time they open the grid.
  // Non-zero-only sits with them: also a standing preference, not a per-visit
  // filter, so it survives navigating away and reloading.
  const { tbView, setTbView } = useUIStore();
  const { showTax, showPY, singleColumn, nonZeroOnly: hideZeroBalances } = tbView;
  const setHideZeroBalances = (v: boolean) => setTbView({ nonZeroOnly: v });
  const setShowTax = (v: boolean) => setTbView({ showTax: v });
  const setShowPY = (v: boolean) => setTbView({ showPY: v });
  const setSingleColumn = (v: boolean) => setTbView({ singleColumn: v });
  const [zoomAccount, setZoomAccount] = useState<{ accountId: number; accountName: string; accountNumber: string; entryType: 'trans' | 'book' | 'tax' } | null>(null);
  const [notesRow, setNotesRow] = useState<TBRow | null>(null);
  const [tickmarkRow, setTickmarkRow] = useState<TBRow | null>(null);
  const [showPYImportModal, setShowPYImportModal] = useState(false);
  const [showCsvImportDialog, setShowCsvImportDialog] = useState(false);
  const [showPdfImportDialog, setShowPdfImportDialog] = useState(false);
  const [showQboImportDialog, setShowQboImportDialog] = useState(false);
  const [showJEDialog, setShowJEDialog] = useState(false);
  const [editJeId, setEditJeId] = useState<number | null>(null);
  const [filterText, setFilterText] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterUnit, setFilterUnit] = useState<string>('');

  // Excel-like cell selection
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const ignoreBlur = useRef(false);
  const editStartedByChar = useRef(false);

  const queryKey = ['trial-balance', selectedPeriodId];

  useEffect(() => {
    setActiveCell(null);
    setEditing(false);
    setLastSyncMsg(null);
    setSyncedUpToDate(false);
  }, [selectedPeriodId]);

  useEffect(() => {
    if (!editing && activeCell) containerRef.current?.focus();
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeCell) {
      document
        .querySelector(`[data-cell="${activeCell.col}|${activeCell.row}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeCell]);

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!selectedPeriodId) return [];
      const res = await getTrialBalance(selectedPeriodId);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: selectedPeriodId !== null,
    // TB is multi-user editable — keep the stale window short so other users'
    // edits show up quickly, and refetch whenever the tab regains focus.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });

  const { data: tickmarkLibrary } = useQuery({
    queryKey: ['tickmarks', selectedClientId],
    queryFn: async () => {
      if (!selectedClientId) return [] as Tickmark[];
      const res = await listTickmarks(selectedClientId);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: selectedClientId !== null,
  });

  const { data: tbTickmarks } = useQuery({
    queryKey: ['tb-tickmarks', selectedPeriodId],
    queryFn: async () => {
      if (!selectedPeriodId) return {} as TBTickmarkMap;
      const res = await getTBTickmarks(selectedPeriodId);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: selectedPeriodId !== null,
  });

  const toggleTickmarkMut = useMutation({
    mutationFn: ({ accountId, tickmarkId }: { accountId: number; tickmarkId: number }) =>
      toggleTBTickmark(selectedPeriodId!, accountId, tickmarkId),
    onSettled: () => invalidateAfterTickmarkToggle(qc),
  });

  const { data: periods } = useQuery({
    queryKey: ['periods', selectedClientId],
    queryFn: async () => {
      if (!selectedClientId) return [] as Period[];
      const res = await listPeriods(selectedClientId);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: selectedClientId !== null,
  });

  const currentPeriod = periods?.find((p) => p.id === selectedPeriodId);
  // A period a desktop holds (desktop sync) is as read-only here as a locked one.
  const isPeriodLocked = !!(currentPeriod?.locked_at || currentPeriod?.checkout);

  const { data: periodImports } = useQuery({
    queryKey: ['period-imports', selectedPeriodId],
    queryFn: async () => {
      if (!selectedPeriodId) return [] as DocumentImport[];
      const res = await listImports(selectedPeriodId);
      if (res.error) return [] as DocumentImport[];
      return res.data ?? ([] as DocumentImport[]);
    },
    enabled: selectedPeriodId !== null,
  });

  const firstImport = periodImports?.[0] ?? null;

  // QuickBooks: the button only shows when the connector is configured, and only
  // works when THIS client has a live connection (set up on the QuickBooks page).
  const features = useFeatures();
  const { data: qboConnections } = useQboConnections(features?.quickbooks === true);
  const qboConnection = findQboConnection(qboConnections, selectedClientId);
  const qboActive = qboConnection?.status === 'active';

  const { data: clients } = useQuery({
    queryKey: ['clients'],
    queryFn: async () => { const r = await listClients(); return r.data ?? []; },
  });
  const currentClient = clients?.find((c: { id: number }) => c.id === selectedClientId);
  const isTaxEntity = currentClient && ['1065', '1120', '1120S', '1040_C'].includes(currentClient.entity_type);

  const handleExportCsv = () => {
    // notes are exported as cell comments, not a column
    const SKIP_COLS = new Set(['notes']);

    const getExportValue = (colId: string, r: TBRow): string => {
      const cents = (v: number) => v === 0 ? '' : String(v / 100);
      const netSigned = (d: number, c: number) => {
        const net = d - c;
        return net === 0 ? '' : String(net / 100);
      };
      const netDr = (d: number, c: number) => { const n = d - c; return n > 0 ? String(n / 100) : ''; };
      const netCr = (d: number, c: number) => { const n = c - d; return n > 0 ? String(n / 100) : ''; };
      switch (colId) {
        case 'account_number':       return r.account_number;
        case 'account_name':         return r.account_name;
        case 'category':             return r.category;
        case 'tax_line':             return r.tax_line ?? '';
        case 'workpaper_ref':        return r.workpaper_ref ?? '';
        case 'prior_year_debit':     return cents(r.prior_year_debit);
        case 'prior_year_credit':    return cents(r.prior_year_credit);
        case 'unadjusted_debit':     return cents(r.unadjusted_debit);
        case 'unadjusted_credit':    return cents(r.unadjusted_credit);
        case 'trans_adj_debit':      return cents(r.trans_adj_debit);
        case 'trans_adj_credit':     return cents(r.trans_adj_credit);
        case 'book_adj_debit':       return cents(r.book_adj_debit);
        case 'book_adj_credit':      return cents(r.book_adj_credit);
        case 'book_adjusted_debit':  return netDr(r.book_adjusted_debit, r.book_adjusted_credit);
        case 'book_adjusted_credit': return netCr(r.book_adjusted_debit, r.book_adjusted_credit);
        case 'tax_adj_debit':        return cents(r.tax_adj_debit);
        case 'tax_adj_credit':       return cents(r.tax_adj_credit);
        case 'tax_adjusted_debit':   return netDr(r.tax_adjusted_debit, r.tax_adjusted_credit);
        case 'tax_adjusted_credit':  return netCr(r.tax_adjusted_debit, r.tax_adjusted_credit);
        // Single-column signed-net balance columns
        case 'py_balance':           return netSigned(r.prior_year_debit, r.prior_year_credit);
        case 'unaj_balance':         return netSigned(r.unadjusted_debit, r.unadjusted_credit);
        case 'trans_adj_balance':    return netSigned(r.trans_adj_debit, r.trans_adj_credit);
        case 'post_trans_balance':   return netSigned(r.post_trans_debit, r.post_trans_credit);
        case 'book_adj_balance':     return netSigned(r.book_adj_debit, r.book_adj_credit);
        case 'book_balance':         return netSigned(r.book_adjusted_debit, r.book_adjusted_credit);
        case 'tax_adj_balance':      return netSigned(r.tax_adj_debit, r.tax_adj_credit);
        case 'tax_balance':          return netSigned(r.tax_adjusted_debit, r.tax_adjusted_credit);
        case 'tickmarks': {
          const marks = tbTickmarks?.[r.account_id] ?? [];
          return marks.map((m) => m.symbol).join(' ');
        }
        default:                     return '';
      }
    };

    // Column widths and numeric flags keyed by column ID
    const COL_META: Record<string, { width: number; numeric?: boolean }> = {
      account_number:       { width: 12 },
      account_name:         { width: 36 },
      category:             { width: 12 },
      tax_line:             { width: 16 },
      workpaper_ref:        { width: 10 },
      prior_year_debit:     { width: 14, numeric: true },
      prior_year_credit:    { width: 14, numeric: true },
      py_balance:           { width: 14, numeric: true },
      unadjusted_debit:     { width: 14, numeric: true },
      unadjusted_credit:    { width: 14, numeric: true },
      trans_adj_debit:      { width: 13, numeric: true },
      trans_adj_credit:     { width: 13, numeric: true },
      book_adj_debit:       { width: 13, numeric: true },
      book_adj_credit:      { width: 13, numeric: true },
      book_adjusted_debit:  { width: 14, numeric: true },
      book_adjusted_credit: { width: 14, numeric: true },
      tax_adj_debit:        { width: 13, numeric: true },
      tax_adj_credit:       { width: 13, numeric: true },
      tax_adjusted_debit:   { width: 14, numeric: true },
      tax_adjusted_credit:  { width: 14, numeric: true },
      unaj_balance:         { width: 14, numeric: true },
      trans_adj_balance:    { width: 13, numeric: true },
      post_trans_balance:   { width: 13, numeric: true },
      book_adj_balance:     { width: 13, numeric: true },
      book_balance:         { width: 14, numeric: true },
      tax_adj_balance:      { width: 13, numeric: true },
      tax_balance:          { width: 14, numeric: true },
      tickmarks:            { width: 8 },
    };

    const visibleCols = tableInstance.getVisibleLeafColumns().filter((c) => !SKIP_COLS.has(c.id));
    const header = visibleCols.map((c) => (typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id));
    const colMeta = visibleCols.map((c) => COL_META[c.id] ?? { width: 14 });
    const exportRows = tableInstance.getRowModel().rows;
    const dataRows = exportRows.map((row) => visibleCols.map((c) => getExportValue(c.id, row.original)));

    // Attach preparer/reviewer notes as hidden cell comments on the W/P Ref column
    const wpRefColIdx = visibleCols.findIndex((c) => c.id === 'workpaper_ref');
    const commentColIdx = wpRefColIdx >= 0 ? wpRefColIdx : 0;
    const comments = exportRows.flatMap((row, rowIdx) => {
      const r = row.original;
      const parts: string[] = [];
      if (r.preparer_notes) parts.push(`Preparer: ${r.preparer_notes}`);
      if (r.reviewer_notes) parts.push(`Reviewer: ${r.reviewer_notes}`);
      if (!parts.length) return [];
      return [{ row: rowIdx, col: commentColIdx, text: parts.join('\n\n') }];
    });

    downloadXlsx(
      engagementFilename(currentPeriod?.period_name, currentClient?.name, 'trial-balance.xlsx'),
      [header, ...dataRows],
      comments.length ? comments : undefined,
      colMeta,
    );
  };

  const initMutation = useMutation({
    mutationFn: () => initializeTrialBalance(selectedPeriodId!),
    onSuccess: (res) => {
      if (res.error) return;
      const { initialized, removed } = res.data;
      const parts: string[] = [];
      if (initialized > 0) parts.push(`${initialized} added`);
      if (removed > 0) parts.push(`${removed} removed`);
      const msg = parts.length > 0 ? parts.join(', ') : 'Already up to date';
      setLastSyncMsg(msg);
      setSyncedUpToDate(initialized === 0 && removed === 0);
      invalidateAfterBalanceChange(qc);
    },
  });

  const balanceMutation = useMutation({
    mutationFn: ({ accountId, debit, credit, expectedUpdatedAt }: { accountId: number; debit: number; credit: number; expectedUpdatedAt: string | null }) =>
      updateBalance(selectedPeriodId!, accountId, debit, credit, expectedUpdatedAt),
    onMutate: async ({ accountId, debit, credit }) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<TBRow[]>(queryKey);
      qc.setQueryData<TBRow[]>(queryKey, (old) =>
        old?.map((r) =>
          r.account_id === accountId
            ? {
                ...r,
                unadjusted_debit: debit,
                unadjusted_credit: credit,
                post_trans_debit: debit + r.trans_adj_debit,
                post_trans_credit: credit + r.trans_adj_credit,
                book_adjusted_debit: debit + r.trans_adj_debit + r.book_adj_debit,
                book_adjusted_credit: credit + r.trans_adj_credit + r.book_adj_credit,
                tax_adjusted_debit: debit + r.trans_adj_debit + r.book_adj_debit + r.tax_adj_debit,
                tax_adjusted_credit: credit + r.trans_adj_credit + r.book_adj_credit + r.tax_adj_credit,
              }
            : r,
        ),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev); },
    onSuccess: (res) => {
      // Errors (including STALE_WRITE) surface via the global mutation-cache
      // toast — no extra alert needed. On STALE_WRITE the cache is already
      // rolled back by onError so there's nothing to patch.
      if (res.error) {
        return;
      } else if (res.data) {
        // Write the new updated_at into cache so follow-up edits from the
        // same session use a fresh expectedUpdatedAt and don't self-conflict.
        qc.setQueryData<TBRow[]>(queryKey, (old) =>
          old?.map((r) => (r.account_id === res.data!.accountId ? { ...r, row_updated_at: res.data!.updatedAt } : r)),
        );
      }
    },
    onSettled: () => invalidateAfterBalanceChange(qc),
  });

  const accountMutation = useMutation({
    mutationFn: ({ accountId, updates }: { accountId: number; updates: Partial<AccountInput> }) =>
      updateAccount(accountId, updates),
    onMutate: async ({ accountId, updates }) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<TBRow[]>(queryKey);
      qc.setQueryData<TBRow[]>(queryKey, (old) =>
        old?.map((r) => {
          if (r.account_id !== accountId) return r;
          return {
            ...r,
            ...(updates.accountNumber !== undefined ? { account_number: updates.accountNumber } : {}),
            ...(updates.accountName !== undefined ? { account_name: updates.accountName } : {}),
            ...(updates.category !== undefined ? { category: updates.category } : {}),
            ...(updates.workpaperRef !== undefined ? { workpaper_ref: updates.workpaperRef || null } : {}),
            ...(updates.preparerNotes !== undefined ? { preparer_notes: updates.preparerNotes || null } : {}),
            ...(updates.reviewerNotes !== undefined ? { reviewer_notes: updates.reviewerNotes || null } : {}),
          };
        }),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev); },
    onSettled: () => invalidateAfterBalanceChange(qc),
  });

  const handleBalanceEdit = useCallback(
    (row: TBRow, field: 'unadjusted_debit' | 'unadjusted_credit', cents: number) => {
      balanceMutation.mutate({
        accountId: row.account_id,
        debit: field === 'unadjusted_debit' ? cents : row.unadjusted_debit,
        credit: field === 'unadjusted_credit' ? cents : row.unadjusted_credit,
        expectedUpdatedAt: row.row_updated_at ?? null,
      });
    },
    [balanceMutation],
  );

  // ── Filter ────────────────────────────────────────────────────────────────

  const availableUnits = useMemo(
    () => [...new Set((data ?? []).map((r) => r.unit).filter((u): u is string => !!u))].sort(),
    [data],
  );

  const filteredDataForNav = useMemo(
    () => (data ?? []).filter((r) => {
      if (filterCategory && r.category !== filterCategory) return false;
      if (filterUnit && r.unit !== filterUnit) return false;
      if (filterText) {
        const q = filterText.toLowerCase();
        if (!r.account_number.toLowerCase().includes(q) && !r.account_name.toLowerCase().includes(q)) return false;
      }
      if (hideZeroBalances) {
        const hasBalance = r.unadjusted_debit !== 0 || r.unadjusted_credit !== 0
          || r.book_adjusted_debit !== 0 || r.book_adjusted_credit !== 0
          || r.tax_adjusted_debit !== 0 || r.tax_adjusted_credit !== 0
          || r.prior_year_debit !== 0 || r.prior_year_credit !== 0;
        if (!hasBalance) return false;
      }
      return true;
    }),
    [data, filterCategory, filterUnit, filterText, hideZeroBalances],
  );

  // ── Table (placeholder for navigation row count) ───────────────────────────

  const table = useReactTable({
    data: filteredDataForNav,
    columns: [],
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
  });

  // ── Navigation & edit helpers ──────────────────────────────────────────────

  function commitEdit(rowData: TBRow, col: EditableColKey, text: string) {
    const trimmed = text.trim();
    switch (col) {
      case 'unadjusted_debit':
      case 'unadjusted_credit': {
        const cents = parseCents(text);
        if (Number.isNaN(cents)) {
          pushToast(`"${text.trim()}" is not a valid amount — balance unchanged.`, 'error');
          break;
        }
        // Accounting-negative in one column posts to the opposite column —
        // the server (correctly) rejects negative debit/credit values.
        if (cents < 0) {
          balanceMutation.mutate({
            accountId: rowData.account_id,
            debit:  col === 'unadjusted_debit' ? 0 : -cents,
            credit: col === 'unadjusted_debit' ? -cents : 0,
            expectedUpdatedAt: rowData.row_updated_at ?? null,
          });
        } else {
          handleBalanceEdit(rowData, col, cents);
        }
        break;
      }
      case 'unaj_net': {
        const net = parseCents(text);
        if (Number.isNaN(net)) {
          pushToast(`"${text.trim()}" is not a valid amount — balance unchanged.`, 'error');
          break;
        }
        balanceMutation.mutate({
          accountId: rowData.account_id,
          debit: net > 0 ? net : 0,
          credit: net < 0 ? -net : 0,
          expectedUpdatedAt: rowData.row_updated_at ?? null,
        });
        break;
      }
      case 'account_number':
        if (trimmed && trimmed !== rowData.account_number)
          accountMutation.mutate({ accountId: rowData.account_id, updates: { accountNumber: trimmed } });
        break;
      case 'account_name':
        if (trimmed && trimmed !== rowData.account_name)
          accountMutation.mutate({ accountId: rowData.account_id, updates: { accountName: trimmed } });
        break;
      case 'category':
        if (ACCOUNT_CATEGORIES.includes(trimmed as TBRow['category']) && trimmed !== rowData.category)
          accountMutation.mutate({ accountId: rowData.account_id, updates: { category: trimmed as TBRow['category'] } });
        break;
      case 'workpaper_ref':
        accountMutation.mutate({ accountId: rowData.account_id, updates: { workpaperRef: trimmed || undefined } });
        break;
    }
  }

  function navigate(
    dir: 'up' | 'down' | 'left' | 'right' | 'tab' | 'shift-tab',
    ac: ActiveCell,
    saveText?: { rowData: TBRow; text: string },
  ) {
    if (saveText) commitEdit(saveText.rowData, ac.col, saveText.text);
    setEditing(false);

    const rows = table.getRowModel().rows;
    const rowCount = rows.length;
    const activeCols = singleColumn ? EDITABLE_COLS_SINGLE : EDITABLE_COLS;
    const colIdx = activeCols.indexOf(ac.col);
    let newRow = ac.row;
    let newColIdx = colIdx;

    switch (dir) {
      case 'up':    newRow = Math.max(0, ac.row - 1); break;
      case 'down':  newRow = Math.min(rowCount - 1, ac.row + 1); break;
      case 'left':  newColIdx = Math.max(0, colIdx - 1); break;
      case 'right': newColIdx = Math.min(activeCols.length - 1, colIdx + 1); break;
      case 'tab':
        if (colIdx < activeCols.length - 1) { newColIdx = colIdx + 1; }
        else if (ac.row < rowCount - 1) { newColIdx = 0; newRow = ac.row + 1; }
        break;
      case 'shift-tab':
        if (colIdx > 0) { newColIdx = colIdx - 1; }
        else if (ac.row > 0) { newColIdx = activeCols.length - 1; newRow = ac.row - 1; }
        break;
    }
    setActiveCell({ row: newRow, col: activeCols[newColIdx] });
  }

  function handleContainerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!activeCell || editing) return;
    const rows = table.getRowModel().rows;
    const rowData = rows[activeCell.row]?.original;

    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); navigate('up', activeCell); break;
      case 'ArrowDown':  e.preventDefault(); navigate('down', activeCell); break;
      case 'ArrowLeft':  e.preventDefault(); navigate('left', activeCell); break;
      case 'ArrowRight': e.preventDefault(); navigate('right', activeCell); break;
      case 'Tab':        e.preventDefault(); navigate(e.shiftKey ? 'shift-tab' : 'tab', activeCell); break;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (rowData && !isPeriodLocked) {
          editStartedByChar.current = false;
          setEditText(getCellDisplayValue(rowData, activeCell.col));
          setEditing(true);
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (!isPeriodLocked) {
          e.preventDefault();
          editStartedByChar.current = false;
          setEditText('');
          setEditing(true);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setActiveCell(null);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !isPeriodLocked) {
          e.preventDefault();
          editStartedByChar.current = true;
          setEditText(e.key);
          setEditing(true);
        }
    }
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>, ac: ActiveCell, rowData: TBRow) {
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        ignoreBlur.current = true;
        navigate(e.shiftKey ? 'up' : 'down', ac, { rowData, text: editText });
        break;
      case 'Tab':
        e.preventDefault();
        ignoreBlur.current = true;
        navigate(e.shiftKey ? 'shift-tab' : 'tab', ac, { rowData, text: editText });
        break;
      case 'Escape':
        e.preventDefault();
        ignoreBlur.current = true;
        setEditing(false);
        break;
    }
  }

  function handleInputBlur(ac: ActiveCell, rowData: TBRow) {
    if (ignoreBlur.current) { ignoreBlur.current = false; return; }
    commitEdit(rowData, ac.col, editText);
    setEditing(false);
  }

  // ── Cell renderer ──────────────────────────────────────────────────────────

  function renderCell(rowIndex: number, col: EditableColKey, rowData: TBRow) {
    const isActive = activeCell?.row === rowIndex && activeCell?.col === col;
    const isNumber = col === 'unadjusted_debit' || col === 'unadjusted_credit' || col === 'unaj_net';
    const isSelect = col === 'category';
    const alignClass = isNumber ? 'text-right' : 'text-left';
    const fontClass = isNumber ? 'font-mono tabular-nums' : col === 'account_number' ? 'font-mono' : '';
    const cellId = `${col}|${rowIndex}`;

    if (isActive && editing && !isPeriodLocked) {
      if (isSelect) {
        return (
          <select
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => handleInputKeyDown(e, { row: rowIndex, col }, rowData)}
            onBlur={() => handleInputBlur({ row: rowIndex, col }, rowData)}
            className="w-full text-sm bg-white dark:bg-gray-800 dark:text-white outline-none px-1 py-0 border-0 capitalize"
          >
            {ACCOUNT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        );
      }
      return (
        <input
          autoFocus
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={(e) => handleInputKeyDown(e, { row: rowIndex, col }, rowData)}
          onBlur={() => handleInputBlur({ row: rowIndex, col }, rowData)}
          onFocus={(e) => {
            if (editStartedByChar.current) {
              const len = e.target.value.length;
              e.target.setSelectionRange(len, len);
            } else {
              e.target.select();
            }
          }}
          className={`w-full text-sm bg-white dark:bg-gray-800 dark:text-white outline-none px-1 py-0 border-0 ${alignClass} ${fontClass}`}
        />
      );
    }

    const rawDisplay = getCellDisplayValue(rowData, col);
    let display: React.ReactNode;
    if (col === 'unaj_net') {
      const net = rowData.unadjusted_debit - rowData.unadjusted_credit;
      display = net === 0
        ? <span className="text-gray-300 dark:text-gray-600">—</span>
        : net < 0
          ? <span className="text-red-600 dark:text-red-400">({fmtTotal(Math.abs(net))})</span>
          : <span>{fmtTotal(net)}</span>;
    } else if (isNumber) {
      display = rawDisplay
        ? fmt(parseCents(rawDisplay) || 0)
        : <span className="text-gray-300 dark:text-gray-600">—</span>;
    } else if (col === 'category') {
      display = (
        <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium capitalize ${CATEGORY_COLORS[rawDisplay]}`}>
          {rawDisplay.slice(0, 3)}
        </span>
      );
    } else {
      display = rawDisplay || <span className="text-gray-300 dark:text-gray-600 italic text-xs">—</span>;
    }

    if (isActive) {
      return (
        <div
          data-cell={cellId}
          className={`w-full px-1 py-0.5 text-sm select-none ring-2 ring-blue-500 ring-inset bg-blue-50/80 dark:bg-blue-900/30 rounded-sm ${alignClass} ${fontClass}`}
        >
          {display}
        </div>
      );
    }

    return (
      <div
        data-cell={cellId}
        onClick={() => { if (!isPeriodLocked) { setActiveCell({ row: rowIndex, col }); setEditing(false); containerRef.current?.focus(); } }}
        onDoubleClick={() => {
          if (isPeriodLocked) return;
          editStartedByChar.current = false;
          setActiveCell({ row: rowIndex, col });
          setEditText(getCellDisplayValue(rowData, col));
          setEditing(true);
        }}
        className={`w-full px-1 py-0.5 text-sm select-none ${isPeriodLocked ? 'cursor-not-allowed' : 'cursor-default hover:bg-gray-100 dark:hover:bg-gray-700'} ${alignClass} ${fontClass}`}
      >
        {display}
      </div>
    );
  }

  // ── Columns ────────────────────────────────────────────────────────────────

  const columns = [
    columnHelper.accessor('account_number', {
      header: 'Acct #',
      cell: (i) => renderCell(i.row.index, 'account_number', i.row.original),
    }),
    columnHelper.accessor('account_name', {
      header: 'Account Name',
      cell: (i) => renderCell(i.row.index, 'account_name', i.row.original),
    }),
    columnHelper.accessor('category', {
      header: 'Cat.',
      cell: (i) => renderCell(i.row.index, 'category', i.row.original),
    }),
    columnHelper.accessor('lead_sheet_code', {
      header: 'LS',
      cell: (i) => {
        const v = i.getValue();
        return (
          <span
            title={i.row.original.lead_sheet_name ?? undefined}
            className="block text-center text-xs font-mono text-gray-500 dark:text-gray-400"
          >
            {v ?? '—'}
          </span>
        );
      },
    }),
    columnHelper.accessor('prior_year_debit', {
      header: 'PY Dr',
      cell: (i) => { const v = i.getValue(); return <span className={`text-right block text-sm font-mono tabular-nums ${v === 0 ? 'text-gray-300 dark:text-gray-600' : 'text-gray-500 dark:text-gray-400'}`}>{v === 0 ? '—' : fmt(v)}</span>; },
    }),
    columnHelper.accessor('prior_year_credit', {
      header: 'PY Cr',
      cell: (i) => { const v = i.getValue(); return <span className={`text-right block text-sm font-mono tabular-nums ${v === 0 ? 'text-gray-300 dark:text-gray-600' : 'text-gray-500 dark:text-gray-400'}`}>{v === 0 ? '—' : fmt(v)}</span>; },
    }),
    columnHelper.accessor('unadjusted_debit', {
      header: 'Unaj. Dr',
      cell: (i) => renderCell(i.row.index, 'unadjusted_debit', i.row.original),
    }),
    columnHelper.accessor('unadjusted_credit', {
      header: 'Unaj. Cr',
      cell: (i) => renderCell(i.row.index, 'unadjusted_credit', i.row.original),
    }),
    columnHelper.accessor('trans_adj_debit', {
      header: 'Trans Dr',
      cell: (i) => {
        const v = i.getValue();
        const row = i.row.original;
        const hasAny = row.trans_adj_debit !== 0 || row.trans_adj_credit !== 0;
        return <span className={`text-right block text-sm font-mono tabular-nums ${v === 0 ? 'text-gray-300 dark:text-gray-600' : 'text-teal-700 dark:text-teal-400 cursor-pointer underline decoration-dotted hover:text-teal-500'}`} onClick={hasAny ? () => setZoomAccount({ accountId: row.account_id, accountName: row.account_name, accountNumber: row.account_number, entryType: 'trans' }) : undefined}>{v === 0 ? '—' : fmt(v)}</span>;
      },
    }),
    columnHelper.accessor('trans_adj_credit', {
      header: 'Trans Cr',
      cell: (i) => {
        const v = i.getValue();
        const row = i.row.original;
        const hasAny = row.trans_adj_debit !== 0 || row.trans_adj_credit !== 0;
        return <span className={`text-right block text-sm font-mono tabular-nums ${v === 0 ? 'text-gray-300 dark:text-gray-600' : 'text-teal-700 dark:text-teal-400 cursor-pointer underline decoration-dotted hover:text-teal-500'}`} onClick={hasAny ? () => setZoomAccount({ accountId: row.account_id, accountName: row.account_name, accountNumber: row.account_number, entryType: 'trans' }) : undefined}>{v === 0 ? '—' : fmt(v)}</span>;
      },
    }),
    columnHelper.accessor('book_adj_debit', {
      header: 'AJE Dr',
      cell: (i) => {
        const v = i.getValue();
        const row = i.row.original;
        const hasAny = row.book_adj_debit !== 0 || row.book_adj_credit !== 0;
        return <span className={`text-right block text-sm font-mono tabular-nums ${v === 0 ? 'text-gray-300 dark:text-gray-600' : 'text-blue-700 dark:text-blue-400 cursor-pointer underline decoration-dotted hover:text-blue-500'}`} onClick={hasAny ? () => setZoomAccount({ accountId: row.account_id, accountName: row.account_name, accountNumber: row.account_number, entryType: 'book' }) : undefined}>{v === 0 ? '—' : fmt(v)}</span>;
      },
    }),
    columnHelper.accessor('book_adj_credit', {
      header: 'AJE Cr',
      cell: (i) => {
        const v = i.getValue();
        const row = i.row.original;
        const hasAny = row.book_adj_debit !== 0 || row.book_adj_credit !== 0;
        return <span className={`text-right block text-sm font-mono tabular-nums ${v === 0 ? 'text-gray-300 dark:text-gray-600' : 'text-blue-700 dark:text-blue-400 cursor-pointer underline decoration-dotted hover:text-blue-500'}`} onClick={hasAny ? () => setZoomAccount({ accountId: row.account_id, accountName: row.account_name, accountNumber: row.account_number, entryType: 'book' }) : undefined}>{v === 0 ? '—' : fmt(v)}</span>;
      },
    }),
    columnHelper.accessor('book_adjusted_debit', {
      header: 'Adj Dr',
      cell: (i) => { const net = i.row.original.book_adjusted_debit - i.row.original.book_adjusted_credit; return <span className={`text-right block text-sm font-mono font-semibold tabular-nums ${net <= 0 ? 'text-gray-300 dark:text-gray-600' : ''}`}>{net > 0 ? fmt(net) : '—'}</span>; },
    }),
    columnHelper.accessor('book_adjusted_credit', {
      header: 'Adj Cr',
      cell: (i) => { const net = i.row.original.book_adjusted_credit - i.row.original.book_adjusted_debit; return <span className={`text-right block text-sm font-mono font-semibold tabular-nums ${net <= 0 ? 'text-gray-300 dark:text-gray-600' : ''}`}>{net > 0 ? fmt(net) : '—'}</span>; },
    }),
    columnHelper.accessor('tax_adj_debit', {
      header: 'Tx Adj Dr',
      cell: (i) => {
        const v = i.getValue();
        const row = i.row.original;
        const hasAny = row.tax_adj_debit !== 0 || row.tax_adj_credit !== 0;
        return <span className={`text-right block text-sm font-mono tabular-nums ${v === 0 ? 'text-gray-300 dark:text-gray-600' : 'text-purple-700 dark:text-purple-400 cursor-pointer underline decoration-dotted hover:text-purple-500'}`} onClick={hasAny ? () => setZoomAccount({ accountId: row.account_id, accountName: row.account_name, accountNumber: row.account_number, entryType: 'tax' }) : undefined}>{v === 0 ? '—' : fmt(v)}</span>;
      },
    }),
    columnHelper.accessor('tax_adj_credit', {
      header: 'Tx Adj Cr',
      cell: (i) => {
        const v = i.getValue();
        const row = i.row.original;
        const hasAny = row.tax_adj_debit !== 0 || row.tax_adj_credit !== 0;
        return <span className={`text-right block text-sm font-mono tabular-nums ${v === 0 ? 'text-gray-300 dark:text-gray-600' : 'text-purple-700 dark:text-purple-400 cursor-pointer underline decoration-dotted hover:text-purple-500'}`} onClick={hasAny ? () => setZoomAccount({ accountId: row.account_id, accountName: row.account_name, accountNumber: row.account_number, entryType: 'tax' }) : undefined}>{v === 0 ? '—' : fmt(v)}</span>;
      },
    }),
    columnHelper.accessor('tax_adjusted_debit', {
      header: 'Tx Dr',
      cell: (i) => { const net = i.row.original.tax_adjusted_debit - i.row.original.tax_adjusted_credit; return <span className={`text-right block text-sm font-mono font-semibold tabular-nums ${net <= 0 ? 'text-gray-300 dark:text-gray-600' : ''}`}>{net > 0 ? fmt(net) : '—'}</span>; },
    }),
    columnHelper.accessor('tax_adjusted_credit', {
      header: 'Tx Cr',
      cell: (i) => { const net = i.row.original.tax_adjusted_credit - i.row.original.tax_adjusted_debit; return <span className={`text-right block text-sm font-mono font-semibold tabular-nums ${net <= 0 ? 'text-gray-300 dark:text-gray-600' : ''}`}>{net > 0 ? fmt(net) : '—'}</span>; },
    }),
    ...(showTax ? [columnHelper.accessor('tax_line', {
      header: 'Tax Code',
      cell: (i) => <span className="text-sm text-gray-600 dark:text-gray-400">{i.getValue() ?? ''}</span>,
    })] : []),
    columnHelper.accessor('workpaper_ref', {
      header: 'W/P Ref',
      cell: (i) => renderCell(i.row.index, 'workpaper_ref', i.row.original),
    }),
    columnHelper.display({
      id: 'notes',
      header: 'Notes',
      cell: ({ row }) => {
        const hasNotes = !!(row.original.preparer_notes || row.original.reviewer_notes);
        return (
          <button
            onClick={() => !isPeriodLocked && setNotesRow(row.original)}
            disabled={isPeriodLocked}
            title={isPeriodLocked ? 'Period is locked' : hasNotes ? 'View/edit notes' : 'Add notes'}
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${isPeriodLocked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-200 dark:hover:bg-gray-700'} ${hasNotes ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500'}`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16.862 3.487a2.25 2.25 0 0 1 3.182 3.182L7.5 19.213 3 21l1.787-4.5L16.862 3.487z"/>
            </svg>
          </button>
        );
      },
    }),
    columnHelper.display({
      id: 'tickmarks',
      header: 'Marks',
      cell: ({ row }) => {
        const marks = tbTickmarks?.[row.original.account_id] ?? [];
        return (
          <button
            onClick={() => !isPeriodLocked && setTickmarkRow(row.original)}
            disabled={isPeriodLocked}
            title={isPeriodLocked ? 'Period is locked' : 'Assign tickmarks'}
            className={`flex items-center gap-0.5 min-w-[2rem] h-6 px-1 rounded ${isPeriodLocked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-200 dark:hover:bg-gray-700'}`}
          >
            {marks.length === 0
              ? <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
              : marks.map((m) => (
                  <span key={m.id} className={`inline-flex items-center justify-center w-5 h-5 rounded text-xs font-bold ${TICKMARK_COLOR_CLASSES[m.color]}`}>
                    {m.symbol}
                  </span>
                ))
            }
          </button>
        );
      },
    }),
  ];

  // Net balance helper: debit-positive, credit-negative
  function fmtBal(dr: number, cr: number) {
    const net = dr - cr;
    if (net === 0) return <span className="text-gray-300 dark:text-gray-600">—</span>;
    return (
      <span className={net < 0 ? 'text-red-600' : ''}>
        {net < 0 ? `(${fmtTotal(Math.abs(net))})` : fmtTotal(net)}
      </span>
    );
  }

  // Single-column variant: replaces each Dr+Cr pair with one net Balance column
  const singleColumns = [
    columnHelper.accessor('account_number', {
      header: 'Acct #',
      cell: (i) => renderCell(i.row.index, 'account_number', i.row.original),
    }),
    columnHelper.accessor('account_name', {
      header: 'Account Name',
      cell: (i) => renderCell(i.row.index, 'account_name', i.row.original),
    }),
    columnHelper.accessor('category', {
      header: 'Cat.',
      cell: (i) => renderCell(i.row.index, 'category', i.row.original),
    }),
    columnHelper.accessor('lead_sheet_code', {
      header: 'LS',
      cell: (i) => {
        const v = i.getValue();
        return (
          <span
            title={i.row.original.lead_sheet_name ?? undefined}
            className="block text-center text-xs font-mono text-gray-500 dark:text-gray-400"
          >
            {v ?? '—'}
          </span>
        );
      },
    }),
    columnHelper.display({
      id: 'py_balance',
      header: 'Prior Year',
      cell: ({ row: r }) => (
        <span className="text-right block text-sm font-mono tabular-nums text-gray-500 dark:text-gray-400">
          {fmtBal(r.original.prior_year_debit, r.original.prior_year_credit)}
        </span>
      ),
    }),
    columnHelper.display({
      id: 'unaj_balance',
      header: 'Unadjusted',
      cell: ({ row: r }) => renderCell(r.index, 'unaj_net', r.original),
    }),
    columnHelper.display({
      id: 'trans_adj_balance',
      header: 'Trans JEs',
      cell: ({ row: r }) => {
        const hasValue = r.original.trans_adj_debit !== 0 || r.original.trans_adj_credit !== 0;
        return (
          <span
            className={`text-right block text-sm font-mono tabular-nums ${hasValue ? 'text-teal-700 dark:text-teal-400 cursor-pointer underline decoration-dotted hover:text-teal-500' : 'text-gray-300 dark:text-gray-600'}`}
            onClick={hasValue ? () => setZoomAccount({ accountId: r.original.account_id, accountName: r.original.account_name, accountNumber: r.original.account_number, entryType: 'trans' }) : undefined}
          >
            {fmtBal(r.original.trans_adj_debit, r.original.trans_adj_credit)}
          </span>
        );
      },
    }),
    columnHelper.display({
      id: 'post_trans_balance',
      header: 'Post-Trans',
      cell: ({ row: r }) => (
        <span className="text-right block text-sm font-mono tabular-nums">
          {fmtBal(r.original.post_trans_debit, r.original.post_trans_credit)}
        </span>
      ),
    }),
    columnHelper.display({
      id: 'book_adj_balance',
      header: 'AJE',
      cell: ({ row: r }) => {
        const hasValue = r.original.book_adj_debit !== 0 || r.original.book_adj_credit !== 0;
        return (
          <span
            className={`text-right block text-sm font-mono tabular-nums ${hasValue ? 'text-blue-700 dark:text-blue-400 cursor-pointer underline decoration-dotted hover:text-blue-500' : 'text-gray-300 dark:text-gray-600'}`}
            onClick={hasValue ? () => setZoomAccount({ accountId: r.original.account_id, accountName: r.original.account_name, accountNumber: r.original.account_number, entryType: 'book' }) : undefined}
          >
            {fmtBal(r.original.book_adj_debit, r.original.book_adj_credit)}
          </span>
        );
      },
    }),
    columnHelper.display({
      id: 'book_balance',
      header: 'Adjusted',
      cell: ({ row: r }) => (
        <span className="text-right block text-sm font-mono font-semibold tabular-nums">
          {fmtBal(r.original.book_adjusted_debit, r.original.book_adjusted_credit)}
        </span>
      ),
    }),
    ...(showTax ? [
      columnHelper.display({
        id: 'tax_adj_balance',
        header: 'Tx Adj',
        cell: ({ row: r }) => {
          const hasValue = r.original.tax_adj_debit !== 0 || r.original.tax_adj_credit !== 0;
          return (
            <span
              className={`text-right block text-sm font-mono tabular-nums ${hasValue ? 'text-purple-700 dark:text-purple-400 cursor-pointer underline decoration-dotted hover:text-purple-500' : 'text-gray-300 dark:text-gray-600'}`}
              onClick={hasValue ? () => setZoomAccount({ accountId: r.original.account_id, accountName: r.original.account_name, accountNumber: r.original.account_number, entryType: 'tax' }) : undefined}
            >
              {fmtBal(r.original.tax_adj_debit, r.original.tax_adj_credit)}
            </span>
          );
        },
      }),
      columnHelper.display({
        id: 'tax_balance',
        header: 'Tx Balance',
        cell: ({ row: r }) => (
          <span className="text-right block text-sm font-mono font-semibold tabular-nums">
            {fmtBal(r.original.tax_adjusted_debit, r.original.tax_adjusted_credit)}
          </span>
        ),
      }),
    ] : []),
    ...(showTax ? [columnHelper.accessor('tax_line', {
      header: 'Tax Code',
      cell: (i) => <span className="text-sm text-gray-600 dark:text-gray-400">{i.getValue() ?? ''}</span>,
    })] : []),
    columnHelper.accessor('workpaper_ref', {
      header: 'W/P Ref',
      cell: (i) => renderCell(i.row.index, 'workpaper_ref', i.row.original),
    }),
    columnHelper.display({
      id: 'notes',
      header: 'Notes',
      cell: ({ row }) => {
        const hasNotes = !!(row.original.preparer_notes || row.original.reviewer_notes);
        return (
          <button
            onClick={() => !isPeriodLocked && setNotesRow(row.original)}
            disabled={isPeriodLocked}
            title={isPeriodLocked ? 'Period is locked' : hasNotes ? 'View/edit notes' : 'Add notes'}
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${isPeriodLocked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-200 dark:hover:bg-gray-700'} ${hasNotes ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500'}`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16.862 3.487a2.25 2.25 0 0 1 3.182 3.182L7.5 19.213 3 21l1.787-4.5L16.862 3.487z"/>
            </svg>
          </button>
        );
      },
    }),
    columnHelper.display({
      id: 'tickmarks',
      header: 'Marks',
      cell: ({ row }) => {
        const marks = tbTickmarks?.[row.original.account_id] ?? [];
        return (
          <button
            onClick={() => !isPeriodLocked && setTickmarkRow(row.original)}
            disabled={isPeriodLocked}
            title={isPeriodLocked ? 'Period is locked' : 'Assign tickmarks'}
            className={`flex items-center gap-0.5 min-w-[2rem] h-6 px-1 rounded ${isPeriodLocked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-200 dark:hover:bg-gray-700'}`}
          >
            {marks.length === 0
              ? <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
              : marks.map((m) => (
                  <span key={m.id} className={`inline-flex items-center justify-center w-5 h-5 rounded text-xs font-bold ${TICKMARK_COLOR_CLASSES[m.color]}`}>
                    {m.symbol}
                  </span>
                ))
            }
          </button>
        );
      },
    }),
  ];

  const hasTrans = useMemo(
    () => (data ?? []).some((r) => r.trans_adj_debit !== 0 || r.trans_adj_credit !== 0),
    [data],
  );

  const columnVisibility: VisibilityState = {
    prior_year_debit:    showPY,
    prior_year_credit:   showPY,
    py_balance:          showPY,
    trans_adj_debit:     hasTrans,
    trans_adj_credit:    hasTrans,
    trans_adj_balance:   hasTrans,
    post_trans_balance:  hasTrans,
    tax_adj_debit:       showTax,
    tax_adj_credit:      showTax,
    tax_adjusted_debit:  showTax,
    tax_adjusted_credit: showTax,
  };

  const tableInstance = useReactTable({
    data: filteredDataForNav,
    columns: singleColumn ? singleColumns : columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
  });

  // ── Footer calculations ────────────────────────────────────────────────────
  // Totals sum the VISIBLE rows so the columns always foot to the detail shown
  // (and to the Excel export, which exports the filtered rows).

  const rows = filteredDataForNav;
  const colSum = (key: keyof TBRow) => rows.reduce((s, r) => s + (r[key] as number), 0);
  // Net-side totals for adjusted columns: sum only the side that wins per row
  const netDrSum = (dk: keyof TBRow, ck: keyof TBRow) =>
    rows.reduce((s, r) => { const n = (r[dk] as number) - (r[ck] as number); return s + (n > 0 ? n : 0); }, 0);
  const netCrSum = (dk: keyof TBRow, ck: keyof TBRow) =>
    rows.reduce((s, r) => { const n = (r[ck] as number) - (r[dk] as number); return s + (n > 0 ? n : 0); }, 0);
  const calcNetIncome = (dk: keyof TBRow, ck: keyof TBRow) => {
    const revNet = rows
      .filter((r) => r.category === 'revenue')
      .reduce((s, r) => s + (r[ck] as number) - (r[dk] as number), 0);
    const expNet = rows
      .filter((r) => r.category === 'expenses')
      .reduce((s, r) => s + (r[dk] as number) - (r[ck] as number), 0);
    return revNet - expNet;
  };

  const pyNetIncome         = calcNetIncome('prior_year_debit', 'prior_year_credit');
  const unajNetIncome      = calcNetIncome('unadjusted_debit', 'unadjusted_credit');
  const postTransNetIncome = calcNetIncome('post_trans_debit', 'post_trans_credit');
  const bkNetIncome        = calcNetIncome('book_adjusted_debit', 'book_adjusted_credit');
  const txNetIncome        = calcNetIncome('tax_adjusted_debit', 'tax_adjusted_credit');

  function fmtNet(n: number) {
    if (n === 0) return <span className="text-gray-400">—</span>;
    return n > 0
      ? <span className="text-green-700 dark:text-green-400">{fmtTotal(n)}</span>
      : <span className="text-red-600 dark:text-red-400">({fmtTotal(Math.abs(n))})</span>;
  }

  const isEmpty = !data || data.length === 0;
  const showSyncButton = isEmpty || !syncedUpToDate;

  const uncodedTaxLines = isTaxEntity
    ? (data ?? []).filter((r) => r.is_active && (r.category === 'revenue' || r.category === 'expenses') && !r.tax_line).length
    : 0;

  // ── Render ─────────────────────────────────────────────────────────────────

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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b dark:border-gray-700 bg-white dark:bg-gray-800 shrink-0">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Trial Balance<RefreshButton /></h2>
          {data && <p className="text-xs text-gray-500 dark:text-gray-400">{data.length} accounts · click to select · double-click or F2 to edit · Tab/Enter/arrows to navigate</p>}
          <CheckoutBanner className="mt-2" />
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => !isPeriodLocked && setShowJEDialog(true)}
            disabled={isPeriodLocked}
            title={isPeriodLocked ? 'Period is locked' : 'Create a new journal entry'}
            className="px-3 py-1.5 text-sm border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-400 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            New JE
          </button>
          {/* Single-column balance toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={singleColumn}
              onChange={(e) => setSingleColumn(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-blue-600"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">Single</span>
          </label>
          {/* Prior Year column toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showPY}
              onChange={(e) => setShowPY(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-gray-500"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">PY</span>
          </label>
          {/* Tax column toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showTax}
              onChange={(e) => setShowTax(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-purple-600"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">Tax</span>
          </label>

          {lastSyncMsg && (
            <span className="text-xs text-gray-500 dark:text-gray-400">{lastSyncMsg}</span>
          )}
          <button
            onClick={() => !isPeriodLocked && setShowPYImportModal(true)}
            disabled={isPeriodLocked}
            title={isPeriodLocked ? 'Period is locked — unlock to import' : undefined}
            className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Import PY
          </button>
          <button
            onClick={() => !isPeriodLocked && setShowCsvImportDialog(true)}
            disabled={isPeriodLocked}
            title={isPeriodLocked ? 'Period is locked — unlock to import' : undefined}
            className="px-3 py-1.5 text-sm border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 rounded hover:bg-emerald-50 dark:hover:bg-emerald-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Import File
          </button>
          <button
            onClick={() => !isPeriodLocked && setShowPdfImportDialog(true)}
            disabled={isPeriodLocked}
            title={isPeriodLocked ? 'Period is locked — unlock to import' : undefined}
            className="px-3 py-1.5 text-sm border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 rounded hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Import from PDF
          </button>
          {features?.quickbooks && (
            <button
              onClick={() => !isPeriodLocked && qboActive && setShowQboImportDialog(true)}
              disabled={isPeriodLocked || !qboActive}
              title={
                isPeriodLocked ? 'Period is locked — unlock to import'
                : !qboActive ? (qboConnection?.status === 'needs_reauth'
                    ? 'QuickBooks connection needs re-authorization — see Setup → QuickBooks'
                    : 'Connect this client to QuickBooks under Setup → QuickBooks first')
                : undefined
              }
              className="px-3 py-1.5 text-sm border border-green-300 dark:border-green-700 text-green-700 dark:text-green-400 rounded hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Import from QuickBooks
            </button>
          )}
          <button
            onClick={handleExportCsv}
            disabled={!data?.length}
            className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300 disabled:opacity-40"
          >
            Export Excel
          </button>
          <button
            onClick={() => selectedPeriodId && openTBPopout(selectedPeriodId, currentPeriod?.period_name)}
            disabled={!data?.length}
            title="Open trial balance in a separate window"
            className="p-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300 disabled:opacity-40"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </button>
          {showSyncButton && (
            <button
              onClick={() => initMutation.mutate()}
              disabled={initMutation.isPending || isPeriodLocked}
              title={isPeriodLocked ? 'Period is locked — unlock to sync' : undefined}
              className="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {initMutation.isPending ? 'Syncing...' : isEmpty ? 'Initialize from COA' : 'Sync with COA'}
            </button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 shrink-0">
        <input
          type="text"
          value={filterText}
          onChange={(e) => { setFilterText(e.target.value); setActiveCell(null); }}
          placeholder="Search accounts…"
          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
        />
        <select
          value={filterCategory}
          onChange={(e) => { setFilterCategory(e.target.value); setActiveCell(null); }}
          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
        >
          <option value="">All categories</option>
          <option value="assets">Assets</option>
          <option value="liabilities">Liabilities</option>
          <option value="equity">Equity</option>
          <option value="revenue">Revenue</option>
          <option value="expenses">Expenses</option>
        </select>
        {availableUnits.length > 0 && (
          <select
            value={filterUnit}
            onChange={(e) => { setFilterUnit(e.target.value); setActiveCell(null); }}
            className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
          >
            <option value="">All units</option>
            {availableUnits.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideZeroBalances}
            onChange={(e) => { setHideZeroBalances(e.target.checked); setActiveCell(null); }}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Non-zero only
        </label>
        {/* Clear resets the transient filters only. Non-zero-only is a standing
            preference, so it is turned off by unticking it, not by Clear. */}
        {(filterText || filterCategory || filterUnit) && (
          <button
            onClick={() => { setFilterText(''); setFilterCategory(''); setFilterUnit(''); }}
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            Clear
          </button>
        )}
        {(filterText || filterCategory || filterUnit || hideZeroBalances) && data && (
          <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">
            {filteredDataForNav.length} of {data.length} accounts
          </span>
        )}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border-b border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-4 py-2 text-sm shrink-0">
          {error.message}
        </div>
      )}

      {/* A checked-out period says so in the header banner instead. */}
      {isPeriodLocked && !currentPeriod?.checkout && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-400 px-4 py-2 text-sm shrink-0 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0 text-amber-600" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/>
          </svg>
          <span>This period is locked. Unlock it to make changes.</span>
        </div>
      )}

      {uncodedTaxLines > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-400 px-4 py-2 text-sm shrink-0 flex items-center gap-2">
          <span className="font-semibold">{uncodedTaxLines} income/expense account{uncodedTaxLines !== 1 ? 's' : ''} missing tax line codes.</span>
          <span className="text-amber-600">Assign tax lines in the Tax Code column to complete your tax mapping.</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center flex-1 text-gray-400 dark:text-gray-500">Loading...</div>
      ) : (
        <div
          ref={containerRef}
          tabIndex={0}
          onKeyDown={handleContainerKeyDown}
          className="flex-1 overflow-auto outline-none"
          onClick={(e) => {
            if (e.target === e.currentTarget) setActiveCell(null);
          }}
        >
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-white dark:bg-gray-800">
              {/* Group header */}
              {singleColumn ? (
                <tr className="bg-gray-100 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
                  <th colSpan={FIXED_COLS} className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 border-r border-gray-300 dark:border-gray-600"></th>
                  {showPY && <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold bg-gray-100 dark:bg-gray-600/20 border-r border-gray-300 dark:border-gray-600">Prior Year</th>}
                  <th className="px-2 py-1 text-xs text-center text-gray-600 dark:text-gray-400 font-semibold border-r border-gray-300 dark:border-gray-600">Unadjusted</th>
                  {hasTrans && <th className="px-2 py-1 text-xs text-center text-teal-600 dark:text-teal-400 font-semibold border-r border-gray-300 dark:border-gray-600">Trans JEs</th>}
                  {hasTrans && <th className="px-2 py-1 text-xs text-center text-gray-700 dark:text-gray-300 font-semibold bg-teal-50 dark:bg-teal-900/20 border-r border-gray-300 dark:border-gray-600">Post-Trans</th>}
                  <th className="px-2 py-1 text-xs text-center text-blue-600 dark:text-blue-400 font-semibold border-r border-gray-300 dark:border-gray-600">AJE</th>
                  <th className="px-2 py-1 text-xs text-center text-gray-700 dark:text-gray-300 font-semibold bg-blue-50 dark:bg-blue-900/20 border-r border-gray-300 dark:border-gray-600">Adjusted</th>
                  {showTax && <th className="px-2 py-1 text-xs text-center text-purple-600 dark:text-purple-400 font-semibold border-r border-gray-300 dark:border-gray-600">Tax Adj.</th>}
                  {showTax && <th className="px-2 py-1 text-xs text-center text-gray-700 dark:text-gray-300 font-semibold bg-purple-50 dark:bg-purple-900/20 border-r border-gray-300 dark:border-gray-600">Tax Adjusted</th>}
                  {showTax && <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold border-r border-gray-300 dark:border-gray-600">Tax Code</th>}
                  <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold border-r border-gray-300 dark:border-gray-600">W/P</th>
                  <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold"></th>
                  <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold">Marks</th>
                </tr>
              ) : (
                <tr className="bg-gray-100 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
                  <th colSpan={FIXED_COLS} className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 border-r border-gray-300 dark:border-gray-600"></th>
                  {showPY && <th colSpan={2} className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold bg-gray-100 dark:bg-gray-600/20 border-r border-gray-300 dark:border-gray-600">Prior Year</th>}
                  <th colSpan={2} className="px-2 py-1 text-xs text-center text-gray-600 dark:text-gray-400 font-semibold border-r border-gray-300 dark:border-gray-600">Unadjusted</th>
                  {hasTrans && <th colSpan={2} className="px-2 py-1 text-xs text-center text-teal-600 dark:text-teal-400 font-semibold bg-teal-50 dark:bg-teal-900/20 border-r border-gray-300 dark:border-gray-600">Trans JEs</th>}
                  <th colSpan={2} className="px-2 py-1 text-xs text-center text-blue-600 dark:text-blue-400 font-semibold border-r border-gray-300 dark:border-gray-600">AJE</th>
                  <th colSpan={2} className="px-2 py-1 text-xs text-center text-gray-700 dark:text-gray-300 font-semibold bg-blue-50 dark:bg-blue-900/20 border-r border-gray-300 dark:border-gray-600">Adjusted</th>
                  {showTax && <th colSpan={2} className="px-2 py-1 text-xs text-center text-purple-600 dark:text-purple-400 font-semibold border-r border-gray-300 dark:border-gray-600">Tax Adj.</th>}
                  {showTax && <th colSpan={2} className="px-2 py-1 text-xs text-center text-gray-700 dark:text-gray-300 font-semibold bg-purple-50 dark:bg-purple-900/20 border-r border-gray-300 dark:border-gray-600">Tax Adjusted</th>}
                  {showTax && <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold border-r border-gray-300 dark:border-gray-600">Tax Code</th>}
                  <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold border-r border-gray-300 dark:border-gray-600">W/P</th>
                  <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold"></th>
                  <th className="px-2 py-1 text-xs text-center text-gray-500 dark:text-gray-400 font-semibold">Marks</th>
                </tr>
              )}
              {/* Column headers */}
              {tableInstance.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
                  {hg.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className={`px-2 py-2 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider cursor-pointer whitespace-nowrap select-none ${colClass(header.column.id, true)}`}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === 'asc' && ' ↑'}
                      {header.column.getIsSorted() === 'desc' && ' ↓'}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {tableInstance.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={tableInstance.getVisibleLeafColumns().length} className="px-4 py-12 text-center text-gray-400 dark:text-gray-500">
                    {!selectedPeriodId ? (
                      <span>Select a period to view the trial balance.</span>
                    ) : (filterText || filterCategory || filterUnit || hideZeroBalances) ? (
                      <span>No accounts match the current filter.</span>
                    ) : isEmpty ? (
                      <span>
                        No active accounts.{' '}
                        <span className="text-gray-500 dark:text-gray-400">Import a chart of accounts or activate accounts on the Chart of Accounts page.</span>
                      </span>
                    ) : (
                      <span>
                        No active accounts match this view.{' '}
                        <span className="text-gray-500 dark:text-gray-400">Import a chart of accounts or activate accounts on the Chart of Accounts page.</span>
                      </span>
                    )}
                  </td>
                </tr>
              ) : (
                tableInstance.getRowModel().rows.map((row, rowIdx) => (
                  <tr key={row.id} className={rowIdx % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/40 dark:bg-gray-700/20'}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className={`px-2 py-0.5 text-gray-700 dark:text-gray-300 ${colClass(cell.column.id)}`}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="sticky bottom-0 z-10">
                {singleColumn ? (
                  <>
                    {/* Single-column totals */}
                    <tr className="border-t-2 border-gray-400 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 font-semibold">
                      <td colSpan={FIXED_COLS} className="px-2 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-r border-gray-300 dark:border-gray-600">
                        Totals
                      </td>
                      {showPY && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-gray-500 dark:text-gray-400 bg-gray-100/60 dark:bg-gray-600/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtBal(colSum('prior_year_debit'), colSum('prior_year_credit'))}
                      </td>}
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums border-r border-gray-200 dark:border-gray-700">
                        {fmtBal(colSum('unadjusted_debit'), colSum('unadjusted_credit'))}
                      </td>
                      {hasTrans && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-teal-700 dark:text-teal-400 border-r border-gray-200 dark:border-gray-700">
                        {fmtBal(colSum('trans_adj_debit'), colSum('trans_adj_credit'))}
                      </td>}
                      {hasTrans && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums font-semibold bg-teal-50/80 dark:bg-teal-900/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtBal(colSum('post_trans_debit'), colSum('post_trans_credit'))}
                      </td>}
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-blue-700 dark:text-blue-400 border-r border-gray-200 dark:border-gray-700">
                        {fmtBal(colSum('book_adj_debit'), colSum('book_adj_credit'))}
                      </td>
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums font-semibold bg-blue-50/80 dark:bg-blue-900/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtBal(colSum('book_adjusted_debit'), colSum('book_adjusted_credit'))}
                      </td>
                      {showTax && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-purple-700 dark:text-purple-400 border-r border-gray-200 dark:border-gray-700">
                        {fmtBal(colSum('tax_adj_debit'), colSum('tax_adj_credit'))}
                      </td>}
                      {showTax && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums font-semibold bg-purple-50/80 dark:bg-purple-900/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtBal(colSum('tax_adjusted_debit'), colSum('tax_adjusted_credit'))}
                      </td>}
                      <td colSpan={4}></td>
                    </tr>
                    {/* Net income in single-column mode */}
                    <tr className="border-t border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/60">
                      <td colSpan={FIXED_COLS} className="px-2 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-r border-gray-300 dark:border-gray-600">
                        Net Income/(Loss)
                      </td>
                      {showPY && <td className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums text-gray-500 dark:text-gray-400 bg-gray-100/60 dark:bg-gray-600/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtNet(pyNetIncome)}
                      </td>}
                      <td className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums border-r border-gray-200 dark:border-gray-700">
                        {fmtNet(unajNetIncome)}
                      </td>
                      {hasTrans && <td className="border-r border-gray-200 dark:border-gray-700"></td>}
                      {hasTrans && <td className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums bg-teal-50/80 dark:bg-teal-900/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtNet(postTransNetIncome)}
                      </td>}
                      <td className="border-r border-gray-200 dark:border-gray-700"></td>
                      <td className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums bg-blue-50/80 dark:bg-blue-900/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtNet(bkNetIncome)}
                      </td>
                      {showTax && <td className="border-r border-gray-200 dark:border-gray-700"></td>}
                      {showTax && <td className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums bg-purple-50/80 dark:bg-purple-900/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtNet(txNetIncome)}
                      </td>}
                      <td colSpan={4}></td>
                    </tr>
                  </>
                ) : (
                  <>
                    {/* Dr/Cr column totals */}
                    <tr className="border-t-2 border-gray-400 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 font-semibold">
                      <td colSpan={FIXED_COLS} className="px-2 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-r border-gray-300 dark:border-gray-600">
                        Totals
                      </td>
                      {showPY && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-gray-500 dark:text-gray-400 bg-gray-100/60 dark:bg-gray-600/20">{fmtTotal(colSum('prior_year_debit'))}</td>}
                      {showPY && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-gray-500 dark:text-gray-400 bg-gray-100/60 dark:bg-gray-600/20 border-r border-gray-200 dark:border-gray-700">{fmtTotal(colSum('prior_year_credit'))}</td>}
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums border-r border-gray-200 dark:border-gray-700">{fmtTotal(colSum('unadjusted_debit'))}</td>
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums border-r border-gray-200 dark:border-gray-700">{fmtTotal(colSum('unadjusted_credit'))}</td>
                      {hasTrans && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-teal-700 dark:text-teal-400">{fmtTotal(colSum('trans_adj_debit'))}</td>}
                      {hasTrans && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-teal-700 dark:text-teal-400 border-r border-gray-200 dark:border-gray-700">{fmtTotal(colSum('trans_adj_credit'))}</td>}
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-blue-700 dark:text-blue-400">{fmtTotal(colSum('book_adj_debit'))}</td>
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-blue-700 dark:text-blue-400 border-r border-gray-200 dark:border-gray-700">{fmtTotal(colSum('book_adj_credit'))}</td>
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums font-semibold bg-blue-50/80 dark:bg-blue-900/20">{fmtTotal(netDrSum('book_adjusted_debit', 'book_adjusted_credit'))}</td>
                      <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums font-semibold bg-blue-50/80 dark:bg-blue-900/20 border-r border-gray-200 dark:border-gray-700">{fmtTotal(netCrSum('book_adjusted_debit', 'book_adjusted_credit'))}</td>
                      {showTax && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-purple-700 dark:text-purple-400">{fmtTotal(colSum('tax_adj_debit'))}</td>}
                      {showTax && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums text-purple-700 dark:text-purple-400 border-r border-gray-200 dark:border-gray-700">{fmtTotal(colSum('tax_adj_credit'))}</td>}
                      {showTax && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums font-semibold bg-purple-50/80 dark:bg-purple-900/20">{fmtTotal(netDrSum('tax_adjusted_debit', 'tax_adjusted_credit'))}</td>}
                      {showTax && <td className="px-2 py-1.5 text-right text-sm font-mono tabular-nums font-semibold bg-purple-50/80 dark:bg-purple-900/20 border-r border-gray-200 dark:border-gray-700">{fmtTotal(netCrSum('tax_adjusted_debit', 'tax_adjusted_credit'))}</td>}
                      <td colSpan={4}></td>
                    </tr>
                    {/* Net income / (loss) */}
                    <tr className="border-t border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/60">
                      <td colSpan={FIXED_COLS} className="px-2 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-r border-gray-300 dark:border-gray-600">
                        Net Income/(Loss)
                      </td>
                      {showPY && <td colSpan={2} className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums text-gray-500 dark:text-gray-400 bg-gray-100/60 dark:bg-gray-600/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtNet(pyNetIncome)}
                      </td>}
                      <td colSpan={2} className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums border-r border-gray-200 dark:border-gray-700">
                        {fmtNet(unajNetIncome)}
                      </td>
                      {hasTrans && <td colSpan={2} className="border-r border-gray-200 dark:border-gray-700"></td>}
                      <td colSpan={2} className="border-r border-gray-200 dark:border-gray-700"></td>
                      <td colSpan={2} className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums bg-blue-50/80 dark:bg-blue-900/20 border-r border-gray-200 dark:border-gray-700">
                        {fmtNet(bkNetIncome)}
                      </td>
                      {showTax && <td colSpan={2} className="border-r border-gray-200 dark:border-gray-700"></td>}
                      {showTax && (
                        <td colSpan={2} className="px-2 py-1 text-right text-sm font-mono font-semibold tabular-nums bg-purple-50/80 dark:bg-purple-900/20 border-r border-gray-200 dark:border-gray-700">
                          {fmtNet(txNetIncome)}
                        </td>
                      )}
                      <td colSpan={4}></td>
                    </tr>
                  </>
                )}
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Source Document Verification Panel */}
      {firstImport && selectedPeriodId && (
        <VerificationPanel
          importRecord={firstImport}
          periodId={selectedPeriodId}
          isPeriodLocked={isPeriodLocked}
        />
      )}

      {/* Prior Year Import modal */}
      {showPYImportModal && selectedPeriodId && (
        <TBImportModal
          periodId={selectedPeriodId}
          mode="prior-year"
          onClose={() => setShowPYImportModal(false)}
          onSuccess={() => { setShowPYImportModal(false); invalidateAfterBalanceChange(qc); }}
        />
      )}

      {/* CSV Smart Import dialog */}
      {showCsvImportDialog && selectedPeriodId && selectedClientId && (
        <CsvImportDialog
          periodId={selectedPeriodId}
          clientId={selectedClientId}
          onClose={() => setShowCsvImportDialog(false)}
          onSuccess={() => { setShowCsvImportDialog(false); invalidateAfterBalanceChange(qc); }}
        />
      )}

      {/* PDF Smart Import dialog */}
      {showPdfImportDialog && selectedPeriodId && selectedClientId && (
        <PdfImportDialog
          periodId={selectedPeriodId}
          clientId={selectedClientId}
          onClose={() => setShowPdfImportDialog(false)}
          onSuccess={() => { setShowPdfImportDialog(false); invalidateAfterBalanceChange(qc); }}
        />
      )}

      {/* QuickBooks import dialog */}
      {showQboImportDialog && selectedPeriodId && selectedClientId && (
        <QboImportDialog
          periodId={selectedPeriodId}
          clientId={selectedClientId}
          onClose={() => setShowQboImportDialog(false)}
          onSuccess={() => {
            setShowQboImportDialog(false);
            invalidateAfterBalanceChange(qc);
            qc.invalidateQueries({ queryKey: ['accounts', selectedClientId] });
            qc.invalidateQueries({ queryKey: ['qbo-connections'] });
          }}
        />
      )}

      {/* Journal Entry dialog */}
      {showJEDialog && selectedPeriodId && selectedClientId && (
        <JournalEntryDialog
          periodId={selectedPeriodId}
          clientId={selectedClientId}
          periodEndDate={currentPeriod?.end_date?.slice(0, 10)}
          onClose={() => setShowJEDialog(false)}
          onSuccess={() => { setShowJEDialog(false); invalidateAfterJournalEntry(qc); }}
        />
      )}

      {/* Notes modal */}
      {notesRow && (
        <NotesModal
          row={notesRow}
          onClose={() => setNotesRow(null)}
          onSave={(accountId, preparerNotes, reviewerNotes) => {
            accountMutation.mutate({ accountId, updates: { preparerNotes, reviewerNotes } });
            setNotesRow(null);
          }}
        />
      )}

      {/* Tickmark modal */}
      {tickmarkRow && (
        <TickmarkPickerModal
          accountNumber={tickmarkRow.account_number}
          accountName={tickmarkRow.account_name}
          library={tickmarkLibrary ?? []}
          assigned={tbTickmarks?.[tickmarkRow.account_id] ?? []}
          onClose={() => setTickmarkRow(null)}
          onToggle={(tickmarkId) => toggleTickmarkMut.mutate({ accountId: tickmarkRow.account_id, tickmarkId })}
        />
      )}

      {/* Trans JE zoom modal */}
      {zoomAccount && selectedPeriodId && (
        <TransJEZoomModal
          periodId={selectedPeriodId}
          accountId={zoomAccount.accountId}
          accountNumber={zoomAccount.accountNumber}
          accountName={zoomAccount.accountName}
          entryType={zoomAccount.entryType}
          onClose={() => setZoomAccount(null)}
          onEditJE={(jeId) => { setZoomAccount(null); setEditJeId(jeId); }}
        />
      )}

      {/* JE edit dialog */}
      {editJeId !== null && selectedClientId && (
        <JournalEntryEditDialog
          journalEntryId={editJeId}
          clientId={selectedClientId}
          onClose={() => setEditJeId(null)}
          onSaved={() => { setEditJeId(null); invalidateAfterJournalEntry(qc); }}
        />
      )}
    </div>
  );
}

// ─── TB Import Modal ───────────────────────────────────────────────────────────

interface TBMapping {
  accountNumberCol: string;
  accountNameCol: string;
  debitCol: string;
  creditCol: string;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

function bestTBMatch(headers: string[], candidates: string[]): string {
  const lower = headers.map((h) => h.toLowerCase().replace(/[\s_-]/g, ''));
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase().replace(/[\s_-]/g, ''));
    if (idx !== -1) return headers[idx];
  }
  return '';
}

function autoDetectTBMapping(headers: string[]): TBMapping {
  return {
    accountNumberCol: bestTBMatch(headers, ['accountnumber', 'account_number', 'acct#', 'acctno', 'acct', 'number', 'code']),
    accountNameCol: bestTBMatch(headers, ['accountname', 'account_name', 'description', 'name', 'accountdescription', 'account_description', 'account']),
    debitCol: bestTBMatch(headers, ['debit', 'dr', 'debitamount', 'debit_amount']),
    creditCol: bestTBMatch(headers, ['credit', 'cr', 'creditamount', 'credit_amount']),
  };
}

function TBImportModal({ periodId, mode, onClose, onSuccess }: {
  periodId: number;
  mode: 'current' | 'prior-year';
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<TBMapping>({ accountNumberCol: '', accountNameCol: '', debitCol: '', creditCol: '' });
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ upserted: number; skipped: number; total: number } | null>(null);
  const [importing, setImporting] = useState(false);

  const title = mode === 'current' ? 'Import Unadjusted Balances' : 'Import Prior Year Balances';

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Excel files handled via exceljs later in this file — allow larger size.
    const kind = /\.(xlsx|xls|xlsm)$/i.test(file.name) ? 'excel' : 'csv';
    if (!checkFileSize(file, kind)) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) { setError('File must have at least a header row and one data row.'); return; }
      const hdrs = parseCsvLine(lines[0]);
      const rows = lines.slice(1).map(parseCsvLine);
      setHeaders(hdrs);
      setRawRows(rows);
      setMapping(autoDetectTBMapping(hdrs));
      setError('');
      setStep(2);
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!mapping.accountNumberCol) { setError('Account Number column is required.'); return; }
    if (!mapping.debitCol) { setError('Debit column is required.'); return; }
    if (!mapping.creditCol) { setError('Credit column is required.'); return; }

    const acctIdx = headers.indexOf(mapping.accountNumberCol);
    const nameIdx = mapping.accountNameCol ? headers.indexOf(mapping.accountNameCol) : -1;
    const drIdx = headers.indexOf(mapping.debitCol);
    const crIdx = headers.indexOf(mapping.creditCol);

    // Accounting-aware amount parsing: "(1,234.56)" and "1234.56-" are
    // NEGATIVE. Stripping the parens (the old behavior) silently flipped
    // imported credits into debits.
    const parseImportAmount = (raw: string | undefined): number => {
      let s = (raw ?? '').trim().replace(/[$\s]/g, '');
      if (!s) return 0;
      let sign = 1;
      const paren = /^\((.*)\)$/.exec(s);
      if (paren) { sign = -1; s = paren[1]; }
      if (s.endsWith('-')) { sign = -sign; s = s.slice(0, -1); }
      if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
      if (s.startsWith('+')) s = s.slice(1);
      s = s.replace(/,/g, '');
      if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
      return sign * Math.round(parseFloat(s) * 100);
    };

    const invalidRows: string[] = [];
    const rows: TBImportRow[] = rawRows
      .filter((r) => r[acctIdx]?.trim())
      .map((r) => {
        const acct = r[acctIdx]?.trim() ?? '';
        const dr = parseImportAmount(r[drIdx]);
        const cr = parseImportAmount(r[crIdx]);
        if (Number.isNaN(dr) || Number.isNaN(cr)) {
          invalidRows.push(acct);
          return { accountNumber: acct, debit: 0, credit: 0 };
        }
        // A negative in one column is a balance on the opposite side — the
        // API schema requires non-negative debit/credit columns.
        return {
          accountNumber: acct,
          ...(nameIdx >= 0 && r[nameIdx]?.trim() ? { accountName: r[nameIdx].trim() } : {}),
          debit: Math.max(0, dr) + Math.max(0, -cr),
          credit: Math.max(0, cr) + Math.max(0, -dr),
        };
      });

    if (invalidRows.length > 0) {
      setError(`Unparseable amount(s) on account(s): ${invalidRows.slice(0, 5).join(', ')}${invalidRows.length > 5 ? '…' : ''}. Fix the file and retry — no rows were imported.`);
      return;
    }
    if (!rows.length) { setError('No valid rows to import.'); return; }
    setImporting(true);
    setError('');
    try {
      const fn = mode === 'current' ? importTBBalances : importPriorYearBalances;
      const res = await fn(periodId, rows);
      if (res.error) { setError(res.error.message); setImporting(false); return; }
      setResult(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  if (result) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-sm">
          <div className="px-5 py-4 border-b dark:border-gray-700">
            <h2 className="text-base font-semibold dark:text-white">{title} — Complete</h2>
          </div>
          <div className="px-5 py-4 space-y-2 text-sm dark:text-gray-300">
            <p><span className="font-medium">{result.upserted}</span> rows imported</p>
            {result.skipped > 0 && <p className="text-amber-600 dark:text-amber-400"><span className="font-medium">{result.skipped}</span> rows skipped (account number not found in COA)</p>}
            <p className="text-gray-500 dark:text-gray-400">Total in file: {result.total}</p>
          </div>
          <div className="px-5 py-3 border-t dark:border-gray-700 flex justify-end">
            <button onClick={onSuccess} className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold dark:text-white">{title}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Step {step} of 2 — {step === 1 ? 'Select CSV file' : 'Map columns'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>

        <div className="px-5 py-4">
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                CSV must have columns for Account Number, Debit, and Credit (in dollars, not cents).
              </p>
              <label className="block">
                <span className="sr-only">Choose CSV file</span>
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleFile}
                  className="block w-full text-sm text-gray-500 dark:text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-gray-300 dark:file:border-gray-600 file:text-sm file:bg-gray-50 dark:file:bg-gray-700 dark:file:text-gray-300 hover:file:bg-gray-100 dark:hover:file:bg-gray-600"
                />
              </label>
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500 dark:text-gray-400">{rawRows.length} data rows detected · {headers.length} columns</p>

              <div className="space-y-2">
                {([
                  { label: 'Account Number *', key: 'accountNumberCol' as keyof TBMapping },
                  { label: 'Account Name', key: 'accountNameCol' as keyof TBMapping },
                  { label: 'Debit *', key: 'debitCol' as keyof TBMapping },
                  { label: 'Credit *', key: 'creditCol' as keyof TBMapping },
                ] as Array<{ label: string; key: keyof TBMapping }>).map(({ label, key }) => (
                  <div key={key} className="flex items-center gap-3">
                    <span className="text-xs text-gray-600 dark:text-gray-400 w-36 shrink-0">{label}</span>
                    <select
                      value={mapping[key]}
                      onChange={(e) => setMapping((m) => ({ ...m, [key]: e.target.value }))}
                      className="flex-1 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                    >
                      <option value="">— skip —</option>
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              {/* Preview */}
              <div className="overflow-auto max-h-40 border border-gray-200 dark:border-gray-700 rounded">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-gray-800/60 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">Acct #</th>
                      {mapping.accountNameCol && <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">Name</th>}
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400">Debit</th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400">Credit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {rawRows.slice(0, 50).map((row, i) => {
                      const acctIdx = headers.indexOf(mapping.accountNumberCol);
                      const nameIdx = headers.indexOf(mapping.accountNameCol);
                      const drIdx = headers.indexOf(mapping.debitCol);
                      const crIdx = headers.indexOf(mapping.creditCol);
                      return (
                        <tr key={i} className={i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/40 dark:bg-gray-700/20'}>
                          <td className="px-2 py-0.5 text-gray-700 dark:text-gray-300">{acctIdx >= 0 ? row[acctIdx] : '—'}</td>
                          {mapping.accountNameCol && <td className="px-2 py-0.5 text-gray-700 dark:text-gray-300 truncate max-w-[10rem]">{nameIdx >= 0 ? row[nameIdx] : '—'}</td>}
                          <td className="px-2 py-0.5 text-right text-gray-700 dark:text-gray-300">{drIdx >= 0 ? row[drIdx] : '—'}</td>
                          <td className="px-2 py-0.5 text-right text-gray-700 dark:text-gray-300">{crIdx >= 0 ? row[crIdx] : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            </div>
          )}
        </div>

        {step === 2 && (
          <div className="px-5 py-3 border-t dark:border-gray-700 flex justify-between items-center">
            <button onClick={() => setStep(1)} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">← Back</button>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300">Cancel</button>
              <button
                onClick={handleImport}
                disabled={importing}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {importing ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Notes Modal ───────────────────────────────────────────────────────────────

function NotesModal({ row, onClose, onSave }: {
  row: TBRow;
  onClose: () => void;
  onSave: (accountId: number, preparerNotes: string, reviewerNotes: string) => void;
}) {
  const [preparer, setPreparer] = useState(row.preparer_notes ?? '');
  const [reviewer, setReviewer] = useState(row.reviewer_notes ?? '');

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold dark:text-white">{row.account_number} — {row.account_name}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Workpaper Notes</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Preparer Notes</label>
            <textarea
              value={preparer}
              onChange={(e) => setPreparer(e.target.value)}
              rows={4}
              autoFocus
              placeholder="Enter preparer notes, tick marks, or references…"
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Reviewer Notes</label>
            <textarea
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              rows={3}
              placeholder="Enter reviewer comments or sign-off…"
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300">Cancel</button>
            <button
              onClick={() => onSave(row.account_id, preparer, reviewer)}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Save Notes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
