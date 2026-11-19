// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { assertNotCheckedOut, assertPeriodUnlocked, logAudit } from '../lib/periodGuard';
import { ensureTrialBalanceRows } from '../lib/ensureTrialBalanceRows';
import { sendServerError } from '../lib/safeError';
import { reconcilePyTieOut, sumTrueUpLines, type TrueUpLine } from '../lib/pyTieOut';
import { parseAliases, applyAliasClaims, type AliasClaim } from '../lib/importAliases';

/** `journal_entries.source_tag` for an entry this screen created. */
export const PY_TIEOUT_TAG = 'py_tieout';

export const pyComparisonRouter = Router({ mergeParams: true });
pyComparisonRouter.use(authMiddleware);


// ─── GET / — Comparison data with variances ────────────────────────────────

pyComparisonRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }

  try {
    const period = await db('periods').where({ id: periodId }).first('client_id');
    if (!period) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }

    // Get uploaded PY data
    const pyRows = await db('py_comparison_data as py')
      .join('chart_of_accounts as coa', 'coa.id', 'py.account_id')
      .where('py.period_id', periodId)
      .select(
        'py.account_id',
        'coa.account_number',
        'coa.account_name',
        'coa.category',
        'py.py_debit',
        'py.py_credit',
        'py.source',
        'py.source_filename',
        'py.uploaded_at',
        'py.uploaded_by',
      )
      .orderBy('coa.account_number');

    if (pyRows.length === 0) {
      res.json({ data: null, error: null });
      return;
    }

    // Get rolled PY balances from trial_balance for ALL accounts
    const tbRows = await db('trial_balance as tb')
      .join('chart_of_accounts as coa', 'coa.id', 'tb.account_id')
      .where({ 'tb.period_id': periodId })
      .select(
        'tb.account_id',
        'coa.account_number',
        'coa.account_name',
        'coa.category',
        'tb.prior_year_debit',
        'tb.prior_year_credit',
      );
    const tbMap = new Map<number, { pyDr: number; pyCr: number; accountNumber: string; accountName: string; category: string }>();
    for (const r of tbRows) {
      tbMap.set(r.account_id, {
        pyDr: Number(r.prior_year_debit),
        pyCr: Number(r.prior_year_credit),
        accountNumber: r.account_number,
        accountName: r.account_name,
        category: r.category,
      });
    }

    // Build uploaded PY lookup
    const pyMap = new Map<number, { dr: number; cr: number }>();
    for (const py of pyRows) {
      pyMap.set(py.account_id, { dr: Number(py.py_debit), cr: Number(py.py_credit) });
    }

    // Named lookup for accounts that appear only on a true-up line.
    const coaById = new Map<number, { account_number: string; account_name: string; category: string }>();
    for (const r of tbRows) coaById.set(r.account_id, { account_number: r.account_number, account_name: r.account_name, category: r.category });
    for (const r of pyRows) coaById.set(r.account_id, { account_number: r.account_number, account_name: r.account_name, category: r.category });

    // Build comparison: union of all accounts in either TB or PY data
    type ComparisonAccount = {
      accountId: number;
      accountNumber: string;
      accountName: string;
      category: string;
      rolledPyDebit: number;
      rolledPyCredit: number;
      uploadedPyDebit: number;
      uploadedPyCredit: number;
      varianceDebit: number;
      varianceCredit: number;
      status: 'match' | 'diff';
      /** Net effect of the tagged PY true-up entries on this account. */
      trueUpDebit?: number;
      trueUpCredit?: number;
      /** uploaded + true-up. */
      adjustedPyDebit?: number;
      adjustedPyCredit?: number;
      /** adjusted − rolled, net debit. 0 = this account ties. */
      remainingVarianceCents?: number;
    };
    const accounts: ComparisonAccount[] = [];
    const seen = new Set<number>();

    // 1) All accounts from TB (includes ones without uploaded PY)
    for (const tb of tbRows) {
      seen.add(tb.account_id);
      const uploaded = pyMap.get(tb.account_id) ?? { dr: 0, cr: 0 };
      const rolledDr = Number(tb.prior_year_debit);
      const rolledCr = Number(tb.prior_year_credit);
      const varDr = uploaded.dr - rolledDr;
      const varCr = uploaded.cr - rolledCr;
      accounts.push({
        accountId: tb.account_id,
        accountNumber: tb.account_number,
        accountName: tb.account_name,
        category: tb.category,
        rolledPyDebit: rolledDr,
        rolledPyCredit: rolledCr,
        uploadedPyDebit: uploaded.dr,
        uploadedPyCredit: uploaded.cr,
        varianceDebit: varDr,
        varianceCredit: varCr,
        status: varDr === 0 && varCr === 0 ? 'match' : 'diff',
      });
    }

    // 2) Accounts in PY data but not in TB (uploaded-only)
    for (const py of pyRows) {
      if (seen.has(py.account_id)) continue;
      const uploadedDr = Number(py.py_debit);
      const uploadedCr = Number(py.py_credit);
      accounts.push({
        accountId: py.account_id,
        accountNumber: py.account_number,
        accountName: py.account_name,
        category: py.category,
        rolledPyDebit: 0,
        rolledPyCredit: 0,
        uploadedPyDebit: uploadedDr,
        uploadedPyCredit: uploadedCr,
        varianceDebit: uploadedDr,
        varianceCredit: uploadedCr,
        status: uploadedDr === 0 && uploadedCr === 0 ? 'match' : 'diff',
      });
    }

    // Sort by category order then account number
    const catOrder: Record<string, number> = { assets: 0, liabilities: 1, equity: 2, revenue: 3, expenses: 4 };
    accounts.sort((a, b) => {
      const c = (catOrder[a.category] ?? 9) - (catOrder[b.category] ?? 9);
      return c !== 0 ? c : a.accountNumber.localeCompare(b.accountNumber);
    });

    // Source metadata from first uploaded row
    const source = {
      type: pyRows[0].source,
      filename: pyRows[0].source_filename,
      uploadedAt: pyRows[0].uploaded_at,
    };

    const variances = accounts.filter((a) => a.status === 'diff');

    // Tagged PY true-ups. They are posted in the CURRENT year — the prior year
    // is closed — so the only way to answer "would my adjustments make the
    // prior year tie?" is to apply their lines to the uploaded balances here.
    const tagged = (await db('journal_entries')
      .where({ period_id: periodId, source_tag: PY_TIEOUT_TAG })
      .select('id')) as Array<{ id: number }>;
    const taggedLines: TrueUpLine[] = tagged.length === 0 ? [] : ((await db('journal_entry_lines')
      .whereIn('journal_entry_id', tagged.map((t) => t.id))
      .select('account_id', 'debit', 'credit')) as Array<{ account_id: number; debit: string | number; credit: string | number }>)
      .map((l) => ({ accountId: l.account_id, debit: Number(l.debit), credit: Number(l.credit) }));

    const tieOut = reconcilePyTieOut(accounts, sumTrueUpLines(taggedLines), tagged.length);
    // An account only a true-up touched (an offset that carried no variance of
    // its own) has no comparison row yet; give it one so the plug is visible.
    for (const [accountId, row] of tieOut.rows) {
      if (accounts.some((a) => a.accountId === accountId)) continue;
      const coa = coaById.get(accountId);
      accounts.push({
        accountId,
        accountNumber: coa?.account_number ?? String(accountId),
        accountName: coa?.account_name ?? 'Unknown account',
        category: coa?.category ?? 'assets',
        rolledPyDebit: 0,
        rolledPyCredit: 0,
        uploadedPyDebit: 0,
        uploadedPyCredit: 0,
        varianceDebit: 0,
        varianceCredit: 0,
        status: 'match',
        trueUpDebit: row.trueUpDebit,
        trueUpCredit: row.trueUpCredit,
        adjustedPyDebit: row.adjustedPyDebit,
        adjustedPyCredit: row.adjustedPyCredit,
        remainingVarianceCents: row.remainingVarianceCents,
      });
    }
    for (const a of accounts) {
      const row = tieOut.rows.get(a.accountId);
      a.trueUpDebit = row?.trueUpDebit ?? 0;
      a.trueUpCredit = row?.trueUpCredit ?? 0;
      a.adjustedPyDebit = row?.adjustedPyDebit ?? a.uploadedPyDebit;
      a.adjustedPyCredit = row?.adjustedPyCredit ?? a.uploadedPyCredit;
      a.remainingVarianceCents = row?.remainingVarianceCents ?? 0;
    }

    const summary = {
      totalAccounts: accounts.length,
      matched: accounts.length - variances.length,
      variances: variances.length,
      netVarianceCents: accounts.reduce((s, a) => s + (a.varianceDebit - a.varianceCredit), 0),
      trueUp: tieOut.summary,
    };

    res.json({ data: { source, accounts, summary }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'py-comparison');
  }
});

// ─── POST /manual — Save manually entered PY balances ──────────────────────

const manualRowSchema = z.object({
  accountId: z.number().int().positive(),
  debit: z.number().int().min(0),
  credit: z.number().int().min(0),
});
const manualSchema = z.object({ accounts: z.array(manualRowSchema).min(1) });

pyComparisonRouter.post('/manual', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }

  try {
    await assertPeriodUnlocked(periodId);
    const period = await db('periods').where({ id: periodId }).first('client_id');
    if (!period) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }

    // Balance check: total debits must equal total credits
    const totalDr = parsed.data.accounts.reduce((s, a) => s + a.debit, 0);
    const totalCr = parsed.data.accounts.reduce((s, a) => s + a.credit, 0);
    if (totalDr !== totalCr) {
      const diff = (Math.abs(totalDr - totalCr) / 100).toFixed(2);
      res.status(409).json({ data: null, error: { code: 'TB_OUT_OF_BALANCE', message: `Imported trial balance is out of balance by $${diff}. Total debits ($${(totalDr / 100).toFixed(2)}) must equal total credits ($${(totalCr / 100).toFixed(2)}).` } });
      return;
    }

    await db.transaction(async (trx) => {
      // Again under the period row lock (desktop sync): the parse above took time.
      await assertNotCheckedOut(trx, [periodId]);
      // Clear existing PY data for this period
      await trx('py_comparison_data').where({ period_id: periodId }).delete();

      // Insert new rows
      await trx('py_comparison_data').insert(
        parsed.data.accounts.map((a) => ({
          period_id: periodId,
          account_id: a.accountId,
          py_debit: a.debit,
          py_credit: a.credit,
          source: 'manual',
          source_filename: null,
          uploaded_at: trx.fn.now(),
          uploaded_by: req.user!.userId,
        })),
      );

      await logAudit({
        userId: req.user!.userId,
        periodId,
        entityType: 'py_comparison',
        entityId: periodId,
        action: 'create',
        description: `Manually entered PY comparison data — ${parsed.data.accounts.length} accounts`,
      }, trx);
    });

    res.status(201).json({ data: { saved: parsed.data.accounts.length }, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
      return;
    }
    sendServerError(res, err, 'py-comparison');
  }
});

// ─── POST /confirm-csv — Confirm CSV/Excel import ──────────────────────────

const csvConfirmSchema = z.object({
  clientId: z.number().int().positive(),
  sourceType: z.enum(['csv', 'excel']),
  sourceFilename: z.string().optional(),
  matches: z.array(z.object({
    csvAccountNumber: z.string().nullable().optional(),
    csvAccountName: z.string().nullable().optional(),
    matchedAccountId: z.number().int().positive().nullable(),
    debitCents: z.number().int().min(0),
    creditCents: z.number().int().min(0),
    action: z.enum(['match', 'skip', 'create_new']).optional(),
    newCategory: z.enum(['assets', 'liabilities', 'equity', 'revenue', 'expenses']).optional(),
    newNormalBalance: z.enum(['debit', 'credit']).optional(),
    newAccountNumber: z.string().optional(),
  })),
});

pyComparisonRouter.post('/confirm-csv', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  const parsed = csvConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }

  const { clientId, sourceType, sourceFilename, matches } = parsed.data;

  // Balance check: total debits must equal total credits (excluding skipped rows)
  const activeMatches = matches.filter((m) => m.action !== 'skip');
  const csvTotalDr = activeMatches.reduce((s, m) => s + m.debitCents, 0);
  const csvTotalCr = activeMatches.reduce((s, m) => s + m.creditCents, 0);
  if (csvTotalDr !== csvTotalCr) {
    const diff = (Math.abs(csvTotalDr - csvTotalCr) / 100).toFixed(2);
    res.status(409).json({ data: null, error: { code: 'TB_OUT_OF_BALANCE', message: `Imported trial balance is out of balance by $${diff}. Total debits ($${(csvTotalDr / 100).toFixed(2)}) must equal total credits ($${(csvTotalCr / 100).toFixed(2)}).` } });
    return;
  }

  try {
    await assertPeriodUnlocked(periodId);
    const period = await db('periods').where({ id: periodId }).first('client_id');
    if (!period || period.client_id !== clientId) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found or client mismatch' } });
      return;
    }

    const stats = await db.transaction(async (trx) => {
      // Again under the period row lock (desktop sync): the parse above took time.
      await assertNotCheckedOut(trx, [periodId]);
      // Clear existing PY data
      await trx('py_comparison_data').where({ period_id: periodId }).delete();

      let imported = 0;
      let skipped = 0;
      let created = 0;
      const aliasClaims: AliasClaim[] = [];

      // Build lookup of existing accounts by number for create_new dedup
      const existingAccounts = await trx('chart_of_accounts')
        .where({ client_id: clientId, is_active: true })
        .select('id', 'account_number');
      const existingByNumber = new Map<string, number>(existingAccounts.map((a: { id: number; account_number: string }) => [a.account_number, a.id]));

      for (const match of matches) {
        if (match.action === 'skip') {
          skipped++;
          continue;
        }

        let accountId = match.matchedAccountId;

        if (match.action === 'create_new') {
          // Create new account in COA
          const accountNum = match.newAccountNumber?.trim() || match.csvAccountNumber?.trim() || `PY${Date.now().toString(36).slice(-6).toUpperCase()}`;
          // Check if it already exists
          if (existingByNumber.has(accountNum)) {
            accountId = existingByNumber.get(accountNum)!;
          } else {
            const category = match.newCategory ?? 'expenses';
            const normalBalance = match.newNormalBalance ?? (category === 'assets' || category === 'expenses' ? 'debit' : 'credit');
            const [newAccount] = await trx('chart_of_accounts')
              .insert({
                client_id: clientId,
                account_number: accountNum,
                account_name: match.csvAccountName?.trim() ?? accountNum,
                category,
                normal_balance: normalBalance,
                is_active: true,
              })
              .returning('id');
            accountId = newAccount.id;
            existingByNumber.set(accountNum, newAccount.id);
            created++;
          }
        }

        if (!accountId) {
          skipped++;
          continue;
        }

        await trx('py_comparison_data').insert({
          period_id: periodId,
          account_id: accountId,
          py_debit: match.debitCents,
          py_credit: match.creditCents,
          source: sourceType,
          source_filename: sourceFilename ?? null,
          uploaded_at: trx.fn.now(),
          uploaded_by: req.user!.userId,
        }).onConflict(['period_id', 'account_id']).merge(['py_debit', 'py_credit', 'source', 'source_filename', 'uploaded_at', 'uploaded_by']);

        imported++;

        if (match.csvAccountName?.trim() && accountId) {
          aliasClaims.push({ accountId, name: match.csvAccountName.trim() });
        }
      }

      // Store import aliases
      // One text means one account: applyAliasClaims grants each alias to the
      // account the row imported into and strips it from whoever held it, so a
      // correction made in the preview is not undone by the next import.
      await applyAliasClaims(trx, clientId, aliasClaims);
      await logAudit({
        userId: req.user!.userId,
        periodId,
        entityType: 'py_comparison',
        entityId: periodId,
        action: 'create',
        description: `Imported PY comparison from ${sourceType}${sourceFilename ? ` (${sourceFilename})` : ''} — ${imported} accounts`,
      }, trx);

      return { imported, skipped, created, total: matches.length };
    });

    res.status(201).json({ data: stats, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
      return;
    }
    sendServerError(res, err, 'py-comparison');
  }
});

// ─── POST /confirm-pdf — Confirm PDF import ────────────────────────────────

const pdfConfirmSchema = z.object({
  clientId: z.number().int().positive(),
  sourceFilename: z.string().optional(),
  matches: z.array(z.object({
    pdfAccountNumber: z.string().nullable().optional(),
    pdfAccountName: z.string().nullable().optional(),
    matchedAccountId: z.number().int().positive().nullable(),
    debitCents: z.number().int().min(0),
    creditCents: z.number().int().min(0),
    action: z.enum(['match', 'skip', 'create_new']).optional(),
    newCategory: z.enum(['assets', 'liabilities', 'equity', 'revenue', 'expenses']).optional(),
    newNormalBalance: z.enum(['debit', 'credit']).optional(),
    newAccountNumber: z.string().optional(),
  })),
});

pyComparisonRouter.post('/confirm-pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  const parsed = pdfConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }

  const { clientId, sourceFilename, matches } = parsed.data;

  // Balance check: total debits must equal total credits (excluding skipped rows)
  const pdfActiveMatches = matches.filter((m) => m.action !== 'skip');
  const pdfTotalDr = pdfActiveMatches.reduce((s, m) => s + m.debitCents, 0);
  const pdfTotalCr = pdfActiveMatches.reduce((s, m) => s + m.creditCents, 0);
  if (pdfTotalDr !== pdfTotalCr) {
    const diff = (Math.abs(pdfTotalDr - pdfTotalCr) / 100).toFixed(2);
    res.status(409).json({ data: null, error: { code: 'TB_OUT_OF_BALANCE', message: `Imported trial balance is out of balance by $${diff}. Total debits ($${(pdfTotalDr / 100).toFixed(2)}) must equal total credits ($${(pdfTotalCr / 100).toFixed(2)}).` } });
    return;
  }

  try {
    await assertPeriodUnlocked(periodId);
    const period = await db('periods').where({ id: periodId }).first('client_id');
    if (!period || period.client_id !== clientId) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found or client mismatch' } });
      return;
    }

    const stats = await db.transaction(async (trx) => {
      // Again under the period row lock (desktop sync): the parse above took time.
      await assertNotCheckedOut(trx, [periodId]);
      await trx('py_comparison_data').where({ period_id: periodId }).delete();

      let imported = 0;
      let skipped = 0;
      let created = 0;
      const aliasClaims: AliasClaim[] = [];

      // Build lookup of existing accounts by number for create_new dedup
      const existingAccounts = await trx('chart_of_accounts')
        .where({ client_id: clientId, is_active: true })
        .select('id', 'account_number');
      const existingByNumber = new Map<string, number>(existingAccounts.map((a: { id: number; account_number: string }) => [a.account_number, a.id]));

      for (const match of matches) {
        if (match.action === 'skip') {
          skipped++;
          continue;
        }

        let accountId = match.matchedAccountId;

        if (match.action === 'create_new') {
          const accountNum = match.newAccountNumber?.trim() || match.pdfAccountNumber?.trim() || `PY${Date.now().toString(36).slice(-6).toUpperCase()}`;
          if (existingByNumber.has(accountNum)) {
            accountId = existingByNumber.get(accountNum)!;
          } else {
            const category = match.newCategory ?? 'expenses';
            const normalBalance = match.newNormalBalance ?? (category === 'assets' || category === 'expenses' ? 'debit' : 'credit');
            const [newAccount] = await trx('chart_of_accounts')
              .insert({
                client_id: clientId,
                account_number: accountNum,
                account_name: match.pdfAccountName?.trim() ?? accountNum,
                category,
                normal_balance: normalBalance,
                is_active: true,
              })
              .returning('id');
            accountId = newAccount.id;
            existingByNumber.set(accountNum, newAccount.id);
            created++;
          }
        }

        if (!accountId) {
          skipped++;
          continue;
        }

        await trx('py_comparison_data').insert({
          period_id: periodId,
          account_id: accountId,
          py_debit: match.debitCents,
          py_credit: match.creditCents,
          source: 'pdf',
          source_filename: sourceFilename ?? null,
          uploaded_at: trx.fn.now(),
          uploaded_by: req.user!.userId,
        }).onConflict(['period_id', 'account_id']).merge(['py_debit', 'py_credit', 'source', 'source_filename', 'uploaded_at', 'uploaded_by']);

        imported++;

        const name = match.pdfAccountName?.trim();
        if (name && accountId) {
          aliasClaims.push({ accountId, name: name });
        }
      }

      // Store import aliases
      // One text means one account: applyAliasClaims grants each alias to the
      // account the row imported into and strips it from whoever held it, so a
      // correction made in the preview is not undone by the next import.
      await applyAliasClaims(trx, clientId, aliasClaims);
      await logAudit({
        userId: req.user!.userId,
        periodId,
        entityType: 'py_comparison',
        entityId: periodId,
        action: 'create',
        description: `Imported PY comparison from PDF${sourceFilename ? ` (${sourceFilename})` : ''} — ${imported} accounts`,
      }, trx);

      return { imported, skipped, created, total: matches.length };
    });

    res.status(201).json({ data: stats, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
      return;
    }
    sendServerError(res, err, 'py-comparison');
  }
});

// ─── DELETE / — Clear PY comparison data ───────────────────────────────────

pyComparisonRouter.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }

  try {
    const deleted = await db.transaction(async (trx): Promise<number> => {
      await assertPeriodUnlocked(periodId, trx);
      const n: number = await trx('py_comparison_data').where({ period_id: periodId }).delete();
      return n;
    });
    await logAudit({
      userId: req.user!.userId,
      periodId,
      entityType: 'py_comparison',
      entityId: periodId,
      action: 'delete',
      description: `Cleared PY comparison data — ${deleted} rows removed`,
    });
    res.json({ data: { deleted }, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
      return;
    }
    sendServerError(res, err, 'py-comparison');
  }
});

// ─── POST /create-aje — Generate AJE from selected variances ───────────────

const ajeSchema = z.object({
  entryType: z.enum(['book', 'tax']),
  description: z.string().optional(),
  offsetAccountId: z.number().int().positive(),
  accountIds: z.array(z.number().int().positive()).min(1),
  /** Swap debit and credit on every line, offset included. */
  reverse: z.boolean().optional().default(false),
});

pyComparisonRouter.post('/create-aje', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  const parsed = ajeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }

  const { entryType, description, offsetAccountId, accountIds, reverse } = parsed.data;

  try {
    const entry = await db.transaction(async (trx) => {
      await assertPeriodUnlocked(periodId, trx);

      // The WHOLE period's upload, not just the selected accounts: an account
      // absent from the file is uploaded ZERO, not "no data". That is exactly
      // how the comparison screen computes its variance, and it is the most
      // common reason to need a true-up — the bookkeeper's file simply omitted
      // the account. Selecting only such rows used to refuse the entry with
      // "No PY comparison data found for selected accounts" even though the
      // screen was showing the variance and a correct preview of the lines.
      const pyRows = await trx('py_comparison_data')
        .where({ period_id: periodId })
        .select('account_id', 'py_debit', 'py_credit');

      if (pyRows.length === 0) {
        throw Object.assign(new Error('No prior-year balances have been uploaded for this period, so there is nothing to true up against.'), { code: 'NOT_FOUND', status: 404 });
      }
      const pyMap = new Map<number, { dr: number; cr: number }>(
        pyRows.map((r: { account_id: number; py_debit: string | number; py_credit: string | number }) =>
          [r.account_id, { dr: Number(r.py_debit), cr: Number(r.py_credit) }]),
      );

      // Get rolled PY from trial_balance
      const tbRows = await trx('trial_balance')
        .whereIn('account_id', accountIds)
        .where({ period_id: periodId })
        .select('account_id', 'prior_year_debit', 'prior_year_credit');
      const tbMap = new Map(tbRows.map((r: { account_id: number; prior_year_debit: string | number; prior_year_credit: string | number }) => [
        r.account_id, { pyDr: Number(r.prior_year_debit), pyCr: Number(r.prior_year_credit) },
      ]));

      // Build JE lines from variances
      type JELine = { accountId: number; debit: number; credit: number };
      const lines: JELine[] = [];
      let totalDebit = 0;
      let totalCredit = 0;

      // Deduped: one line per account however the selection arrived.
      for (const accountId of Array.from(new Set(accountIds))) {
        const rolled = tbMap.get(accountId) ?? { pyDr: 0, pyCr: 0 };
        const uploaded = pyMap.get(accountId) ?? { dr: 0, cr: 0 };
        // Direction: the rolled PY (this app's final prior year, AJEs
        // included) is the truth and the upload is the bookkeeper's opening
        // balance. The entry brings the bookkeeper's balance TO the rolled
        // one, so a positive value here (rolled more debit than uploaded) is
        // a DEBIT. This is rolled − uploaded — the opposite sign of the
        // variance column, which reads uploaded − rolled. Mirrors AjePanel.
        const netVariance = (rolled.pyDr - uploaded.dr) - (rolled.pyCr - uploaded.cr);

        if (netVariance === 0) continue;

        if (netVariance > 0) {
          lines.push({ accountId, debit: netVariance, credit: 0 });
          totalDebit += netVariance;
        } else {
          lines.push({ accountId, debit: 0, credit: Math.abs(netVariance) });
          totalCredit += Math.abs(netVariance);
        }
      }

      if (lines.length === 0) {
        throw Object.assign(new Error('All selected accounts have zero variance'), { code: 'VALIDATION_ERROR', status: 400 });
      }

      // Offset line absorbs the net
      const offsetDebit = totalCredit > totalDebit ? totalCredit - totalDebit : 0;
      const offsetCredit = totalDebit > totalCredit ? totalDebit - totalCredit : 0;
      lines.push({ accountId: offsetAccountId, debit: offsetDebit, credit: offsetCredit });
      totalDebit += offsetDebit;
      totalCredit += offsetCredit;

      // Reversal is applied to the finished, balanced entry — offset included —
      // so the swap can never unbalance it. Mirrors AjePanel's preview.
      if (reverse) {
        for (const l of lines) { const d = l.debit; l.debit = l.credit; l.credit = d; }
        [totalDebit, totalCredit] = [totalCredit, totalDebit];
      }

      if (totalDebit !== totalCredit) {
        throw Object.assign(new Error('Internal error: AJE does not balance'), { code: 'VALIDATION_ERROR', status: 400 });
      }

      // Create the journal entry (same pattern as journalEntries.ts POST)
      await trx.raw('SELECT id FROM periods WHERE id = ? FOR UPDATE', [periodId]);
      const lastEntry = await trx('journal_entries')
        .where({ period_id: periodId, entry_type: entryType })
        .max('entry_number as max')
        .first();
      const entryNumber = (lastEntry?.max ?? 0) + 1;

      const entryDate = new Date().toISOString().slice(0, 10);
      const [je] = await trx('journal_entries')
        .insert({
          period_id: periodId,
          entry_number: entryNumber,
          entry_type: entryType,
          entry_date: entryDate,
          description: description ?? 'PY true-up — bring opening balances to prior-year final',
          is_recurring: false,
          // Tagged so the tie-out screen can apply these lines back to the
          // uploaded prior year and report whether it would tie — the entry
          // itself has to be posted in the current year, the prior one is closed.
          source_tag: PY_TIEOUT_TAG,
          created_by: req.user!.userId,
        })
        .returning('*');

      await trx('journal_entry_lines').insert(
        lines.map((l) => ({
          journal_entry_id: je.id,
          account_id: l.accountId,
          debit: l.debit,
          credit: l.credit,
        })),
      );

      // Ensure TB rows exist for all affected accounts
      await ensureTrialBalanceRows(trx, periodId, lines.map((l) => l.accountId));

      await logAudit({
        userId: req.user!.userId,
        periodId,
        entityType: 'journal_entry',
        entityId: je.id,
        action: 'create',
        description: `PY tie-out ${entryType} AJE #${entryNumber} — ${lines.length - 1} variance accounts + offset`,
      }, trx);

      return { ...je, lines };
    });

    res.status(201).json({ data: entry, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
      return;
    }
    if (e.code === 'NOT_FOUND') {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: e.message ?? 'Not found' } });
      return;
    }
    if (e.code === 'VALIDATION_ERROR') {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: e.message ?? 'Validation error' } });
      return;
    }
    sendServerError(res, err, 'py-comparison');
  }
});
