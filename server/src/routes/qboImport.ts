// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Trial balance import from a connected QuickBooks Online company.
 *
 * Mounted under /api/v1/import/ on purpose: nginx gives that prefix its long
 * timeout and the existing limiters route /preview → uploadLimiter and
 * /confirm → aiStepLimiter without any new wiring.
 *
 * Preview pulls the report and parks it (raw JSON + sha256 + params) on a
 * pending `document_imports` row. Confirm RE-DERIVES every amount from that
 * stored report and only takes routing decisions from the browser: the client
 * never supplies a cent.
 *
 * Two targets share the flow. `current` (default) lands in the period's
 * unadjusted columns. `prior` pulls the PRIOR year's report — the adjacent
 * period's dates when the app has one, else this period's dates slid back a
 * year — and lands in `py_comparison_data` for the PY Tie-Out, exactly as a
 * CSV upload of the bookkeeper's final prior-year TB would. Both stamp
 * `qbo_account_id`, so a link made during a tie-out serves the next import.
 */

import { createHash } from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { assertPeriodUnlocked, logAudit } from '../lib/periodGuard';
import { sendServerError } from '../lib/safeError';
import { inferAccountType, type AccountCategory } from '../lib/accountTypeInference';
import { assignSequentialNumbers } from '../lib/accountNumbering';
import { suggestLeadSheet } from '../lib/leadSheets';
import { loadQboConfig } from '../lib/qbo/settings';
import { apiForConnection, loadConnectionForClient, QboConnectionError } from '../lib/qbo/tokenStore';
import { QboApiError } from '../lib/qbo/apiClient';
import { QboOAuthError } from '../lib/qbo/oauth';
import {
  extractSummaryTotals,
  flattenTrialBalanceRows,
  parseReportHeader,
  validateTotals,
} from '../lib/qbo/reportParser';
import { findAbsentNonzeroAccounts, matchRows, type CoaRowForMatch, type QboAccountLite } from '../lib/qbo/matcher';
import { applyDecisions, DecisionError } from '../lib/qbo/decisions';
import { isUniqueViolation, uniqueViolationMessage } from '../lib/pgErrors';
import { buildSuggestPrompt, sanitizeSuggestions, QBO_SUGGEST_BATCH_SIZE, type MatchSuggestion, type SuggestCandidate } from '../lib/qbo/suggest';
import { aiComplete, markAiUsageParseError } from '../lib/aiComplete';
import { getLLMProvider } from '../lib/aiClient';
import { TB_TASK_CLASSES } from '../lib/routerProvider';
import { extractJsonArray } from '../lib/aiJsonExtract';
import { priorYearRange, type CandidatePeriod, type PriorRange } from '../lib/qbo/priorRange';

type ImportTarget = 'current' | 'prior';

export const qboImportRouter = Router();
qboImportRouter.use(authMiddleware);

/** What the pending import row keeps in `ai_extraction`. */
interface StoredQboImport {
  raw: unknown;
  sha256: string;
  params: { start_date: string; end_date: string; accounting_method: 'Accrual' | 'Cash' };
  header: ReturnType<typeof parseReportHeader>;
  companyName: string;
  accountingMethod: 'Accrual' | 'Cash';
  realmId: string;
  environment: string;
  accounts: QboAccountLite[];
  fetchedAt: string;
  /** Absent on rows written before the PY tie-out target existed: those are `current`. */
  target?: ImportTarget;
  priorRange?: PriorRange;
  decisions?: unknown;
  result?: unknown;
}

function isoDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function respondQboError(res: Response, err: unknown): boolean {
  if (err instanceof QboConnectionError) {
    const status = err.code === 'NOT_FOUND' ? 404 : 409;
    res.status(status).json({ data: null, error: { code: `QBO_${err.code}`, message: err.message } });
    return true;
  }
  if (err instanceof QboApiError) {
    res.status(502).json({ data: null, error: { code: 'QBO_API_ERROR', message: err.message } });
    return true;
  }
  // A refresh that Intuit refused. invalid_grant already flipped the row to needs_reauth in
  // tokenStore; a fatal (e.g. invalid_client) means the app credentials themselves are wrong.
  if (err instanceof QboOAuthError) {
    const message =
      err.kind === 'invalid_grant'
        ? 'QuickBooks no longer accepts this connection — reconnect the client under Setup → QuickBooks.'
        : err.kind === 'transient'
          ? 'Intuit is temporarily unavailable. Try again in a minute.'
          : `Intuit rejected the app credentials (${err.intuitError ?? `HTTP ${err.status}`}). Check the Client ID / Client Secret under Admin → QuickBooks API.`;
    res.status(err.kind === 'transient' ? 503 : 409).json({ data: null, error: { code: `QBO_OAUTH_${err.kind.toUpperCase()}`, message } });
    return true;
  }
  return false;
}

async function loadCoaForMatch(clientId: number): Promise<CoaRowForMatch[]> {
  return (await db('chart_of_accounts')
    .where({ client_id: clientId, is_active: true })
    .select('id', 'account_number', 'account_name', 'qbo_account_id', 'qbo_account_name', 'category')) as CoaRowForMatch[];
}

/**
 * The client's INACTIVE accounts, by number. Never match candidates, but the
 * chart's unique indexes still count them: a confirm that created an account
 * with a retired account's number, or one still carrying the QuickBooks id a
 * retired account holds, died on a duplicate-key 500. Every step that picks
 * or checks a number sees these as taken.
 */
async function loadInactiveByNumber(clientId: number): Promise<Map<string, { id: number; account_name: string; qbo_account_id: string | null }>> {
  const rows = (await db('chart_of_accounts')
    .where({ client_id: clientId, is_active: false })
    .select('id', 'account_number', 'account_name', 'qbo_account_id')) as Array<{ id: number; account_number: string; account_name: string; qbo_account_id: string | null }>;
  return new Map(rows.map((r) => [r.account_number.trim(), { id: r.id, account_name: r.account_name, qbo_account_id: r.qbo_account_id }]));
}

// ─────────────────────────────────────────────────────────────────────────
// POST /preview
// ─────────────────────────────────────────────────────────────────────────
const previewSchema = z.object({
  periodId: z.number().int().positive(),
  clientId: z.number().int().positive(),
  accountingMethod: z.enum(['Accrual', 'Cash']).optional(),
  target: z.enum(['current', 'prior']).default('current'),
});

qboImportRouter.post('/preview', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { periodId, clientId, target } = parsed.data;
  try {
    const cfg = await loadQboConfig();
    if (!cfg.configured) {
      res.status(409).json({ data: null, error: { code: 'QBO_NOT_CONFIGURED', message: 'QuickBooks is not configured.' } });
      return;
    }
    const period = await db('periods').where({ id: periodId, client_id: clientId }).first();
    if (!period) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found for this client.' } });
      return;
    }
    await assertPeriodUnlocked(periodId);
    const periodStart = isoDate(period.start_date);
    const periodEnd = isoDate(period.end_date);
    if (!periodStart || !periodEnd) {
      res.status(422).json({
        data: null,
        error: { code: 'PERIOD_DATES_REQUIRED', message: 'The period needs a start and end date before its trial balance can be pulled from QuickBooks.' },
      });
      return;
    }
    let startDate = periodStart;
    let endDate = periodEnd;
    let priorRange: PriorRange | undefined;
    if (target === 'prior') {
      const others = (await db('periods')
        .where({ client_id: clientId, is_reference: false })
        .whereNot('id', periodId)
        .whereNotNull('start_date')
        .whereNotNull('end_date')
        .select('id', 'period_name', 'start_date', 'end_date')) as Array<{ id: number; period_name: string; start_date: unknown; end_date: unknown }>;
      const candidates: CandidatePeriod[] = others
        .map((p) => ({ id: p.id, period_name: p.period_name, start_date: isoDate(p.start_date) ?? '', end_date: isoDate(p.end_date) ?? '' }))
        .filter((p) => p.start_date && p.end_date);
      priorRange = priorYearRange(periodStart, periodEnd, candidates);
      startDate = priorRange.startDate;
      endDate = priorRange.endDate;
    }

    const conn = await loadConnectionForClient(clientId);
    if (!conn) {
      res.status(409).json({ data: null, error: { code: 'QBO_NOT_CONNECTED', message: 'This client is not connected to a QuickBooks company.' } });
      return;
    }
    if (conn.status !== 'active' || conn.environment !== cfg.environment) {
      res.status(409).json({
        data: null,
        error: { code: 'QBO_NEEDS_REAUTH', message: 'The QuickBooks connection for this client needs re-authorization. Reconnect it on the QuickBooks page.' },
      });
      return;
    }

    const api = await apiForConnection(conn);
    const info = await api.companyInfo();
    const prefs = await api.preferences();
    const accountingMethod = parsed.data.accountingMethod ?? prefs.reportBasis ?? 'Accrual';
    const accounts = await api.allAccounts();
    const params = { start_date: startDate, end_date: endDate, accounting_method: accountingMethod } as const;
    const raw = await api.trialBalance(params);

    const header = parseReportHeader(raw);
    const reportRows = flattenTrialBalanceRows(raw);
    const totals = validateTotals(reportRows, extractSummaryTotals(raw));
    if (!totals.summaryMatches) {
      res.status(422).json({
        data: null,
        error: {
          code: 'QBO_REPORT_PARSE_MISMATCH',
          message: `The QuickBooks report total does not match the sum of its rows (rows ${totals.debitCents}/${totals.creditCents} cents). The import was refused rather than importing a partial balance.`,
        },
      });
      return;
    }

    const coa = await loadCoaForMatch(clientId);
    const inactive = await loadInactiveByNumber(clientId);
    const rows = matchRows(reportRows, coa, accounts, { inactiveNumbers: new Set(inactive.keys()) });
    const matchedIds = new Set(rows.filter((r) => r.matchedAccountId !== null).map((r) => r.matchedAccountId!));
    const tbRows = (await db('trial_balance as tb')
      .join('chart_of_accounts as coa', 'coa.id', 'tb.account_id')
      .where({ 'tb.period_id': periodId })
      .select('tb.account_id', 'coa.account_number', 'coa.account_name', 'tb.unadjusted_debit', 'tb.unadjusted_credit')) as Array<{
      account_id: number;
      account_number: string;
      account_name: string;
      unadjusted_debit: string | number;
      unadjusted_credit: string | number;
    }>;
    // A tie-out never zeroes anything: an account QuickBooks omitted simply has no uploaded
    // PY balance, and the comparison already shows that as a variance against the rolled PY.
    const absentNonzero = target === 'prior' ? [] : findAbsentNonzeroAccounts(tbRows, matchedIds);

    const warnings: string[] = [];
    if (!totals.balanced) warnings.push('OUT_OF_BALANCE');
    if (totals.summaryMissing) warnings.push('SUMMARY_MISSING');
    if (reportRows.length === 0) warnings.push('NO_REPORT_DATA');
    if (header.startPeriod && header.startPeriod !== startDate) warnings.push('START_DATE_DIFFERS');
    if (header.endPeriod && header.endPeriod !== endDate) warnings.push('END_DATE_DIFFERS');

    const stored: StoredQboImport = {
      raw,
      sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
      params,
      header,
      companyName: info.CompanyName,
      accountingMethod,
      realmId: conn.realm_id,
      environment: conn.environment,
      accounts,
      fetchedAt: new Date().toISOString(),
      target,
      ...(priorRange ? { priorRange } : {}),
    };
    let importId = 0;
    await db.transaction(async (trx) => {
      await trx('document_imports').where({ period_id: periodId, import_type: 'qbo', status: 'pending' }).del();
      const [row] = (await trx('document_imports')
        .insert({
          client_id: clientId,
          period_id: periodId,
          import_type: 'qbo',
          document_type: 'trial_balance',
          status: 'pending',
          ai_extraction: JSON.stringify(stored),
          imported_by: req.user!.userId,
          imported_at: trx.fn.now(),
        })
        .returning('id')) as Array<{ id: number }>;
      importId = row.id;
    });

    res.json({
      data: {
        importId,
        target,
        priorRange: priorRange ?? null,
        companyName: info.CompanyName,
        accountingMethod,
        defaultAccountingMethod: prefs.reportBasis,
        bookCloseDate: prefs.bookCloseDate,
        header,
        params,
        totals: {
          debitCents: totals.debitCents,
          creditCents: totals.creditCents,
          balanced: totals.balanced,
          imbalanceCents: totals.imbalanceCents,
        },
        rows,
        absentNonzero,
        warnings,
        sha256: stored.sha256,
      },
      error: null,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked' } });
      return;
    }
    if (respondQboError(res, err)) return;
    sendServerError(res, err, 'qbo-import preview');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /confirm
// ─────────────────────────────────────────────────────────────────────────
const decisionSchema = z.object({
  rowKey: z.string().max(20),
  action: z.enum(['match', 'create_new', 'skip']),
  matchedAccountId: z.number().int().positive().nullable().optional(),
  newAccountNumber: z.string().max(40).nullable().optional(),
  newAccountName: z.string().max(255).nullable().optional(),
  newCategory: z.string().max(20).nullable().optional(),
  newNormalBalance: z.string().max(10).nullable().optional(),
});

const confirmSchema = z.object({
  importId: z.number().int().positive(),
  decisions: z.array(decisionSchema).max(5000),
  zeroAbsent: z.boolean().default(true),
  acknowledgeUnbalanced: z.boolean().optional(),
});

// ── POST /suggest-matches ─────────────────────────────────────────────────────
// The opt-in AI pass. Re-derives the unresolved rows from the stored report
// (never from the browser), asks the model which existing account each one
// is, and returns SUGGESTIONS — the preview badges them and the reviewer
// confirms. Nothing is written here. `rowKeys` lets the client page through a
// long report so no one request runs longer than the router's proxy allows.

const suggestSchema = z.object({
  importId: z.number().int().positive(),
  rowKeys: z.array(z.string().min(1).max(20)).max(500).optional(),
});

qboImportRouter.post('/suggest-matches', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = suggestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { importId, rowKeys } = parsed.data;
  try {
    const importRow = await db('document_imports').where({ id: importId, import_type: 'qbo' }).first();
    if (!importRow) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Import not found.' } });
      return;
    }
    if (importRow.status !== 'pending') {
      res.status(409).json({ data: null, error: { code: 'IMPORT_ALREADY_CONFIRMED', message: 'This import was already confirmed. Run a new preview.' } });
      return;
    }
    const clientId = importRow.client_id as number;
    const periodId = importRow.period_id as number;
    const stored = (typeof importRow.ai_extraction === 'string' ? JSON.parse(importRow.ai_extraction) : importRow.ai_extraction) as StoredQboImport;

    const coa = await loadCoaForMatch(clientId);
    const inactive = await loadInactiveByNumber(clientId);
    const matched = matchRows(flattenTrialBalanceRows(stored.raw), coa, stored.accounts ?? [], { inactiveNumbers: new Set(inactive.keys()) });
    const wanted = rowKeys ? new Set(rowKeys) : null;
    const unresolved = matched.filter(
      (r) => (wanted ? wanted.has(r.rowKey) : true) && r.qboAccountId !== null && r.action !== 'match',
    );
    // Candidates: accounts nothing on this report already claims and no other QBO account is bound to.
    const claimed = new Set(matched.filter((r) => r.matchedAccountId !== null).map((r) => r.matchedAccountId!));
    const candidates: SuggestCandidate[] = coa
      .filter((c) => !claimed.has(c.id) && !c.qbo_account_id)
      .map((c) => ({ id: c.id, account_number: c.account_number, account_name: c.account_name, category: c.category ?? null }));

    if (unresolved.length === 0 || candidates.length === 0) {
      res.json({ data: { suggestions: [] as MatchSuggestion[], rowsConsidered: unresolved.length, candidates: candidates.length }, error: null });
      return;
    }

    const { provider, fastModel } = await getLLMProvider();
    const suggestions: MatchSuggestion[] = [];
    // A candidate suggested in one batch is not offered to the next, so two
    // batches cannot hand the same account to two QBO rows.
    const taken = new Set<number>();
    for (let i = 0; i < unresolved.length; i += QBO_SUGGEST_BATCH_SIZE) {
      const batch = unresolved.slice(i, i + QBO_SUGGEST_BATCH_SIZE);
      const offered = candidates.filter((c) => !taken.has(c.id));
      if (offered.length === 0) break;
      const { result, logId } = await aiComplete(
        provider,
        { model: fastModel, taskClass: TB_TASK_CLASSES.QBO_MATCH, maxTokens: 4096, messages: [{ role: 'user', content: buildSuggestPrompt(batch, offered) }] },
        { endpoint: 'qbo/suggest-matches', userId: req.user?.userId, userRole: req.user?.role, clientId, periodId },
      );
      const arr = extractJsonArray(result.text);
      if (!arr) {
        markAiUsageParseError(logId, `Invalid JSON (finish=${result.stopReason ?? 'unknown'}). text[0..500]=${JSON.stringify(result.text.slice(0, 500))}`);
        continue;
      }
      for (const sug of sanitizeSuggestions(arr, batch, offered)) {
        taken.add(sug.accountId);
        suggestions.push(sug);
      }
    }

    res.json({ data: { suggestions, rowsConsidered: unresolved.length, candidates: candidates.length }, error: null });
  } catch (err) {
    if (respondQboError(res, err)) return;
    sendServerError(res, err, 'qbo/suggest-matches');
  }
});

// ── POST /suggest-numbers ─────────────────────────────────────────────────────
// Account numbers for the QuickBooks accounts that have none (a company that
// never turned on account numbers sends every account without an AcctNum).
// There is no `QB<Id>` placeholder any more: the preview will not confirm a
// new account without a number, and this is how the reviewer gets one.
//
// Two sources, in order: the AI numbering pass (the same task class the CSV
// and PDF imports use, opt-in with consent on the client) when `useAi` is set
// and the router/provider answers, then `assignSequentialNumbers` for every
// row the AI missed — or for all of them when AI is off or fails. Nothing is
// written; the numbers land in the preview's editable Acct # cells.
// `reservedNumbers` carries numbers earlier chunks were already handed.

const numberSchema = z.object({
  importId: z.number().int().positive(),
  rowKeys: z.array(z.string().min(1).max(20)).max(500).optional(),
  reservedNumbers: z.array(z.string().max(40)).max(5000).optional(),
  useAi: z.boolean().optional().default(true),
});

const NUMBER_AI_BATCH_SIZE = 25;
const NUMBER_AI_MAX_TOKENS = 8000;

interface NumberSuggestion {
  rowKey: string;
  suggestedNumber: string;
  suggestedCategory: string | null;
  suggestedNormalBalance: string | null;
  source: 'ai' | 'sequence';
}

const VALID_CATEGORIES = new Set(['assets', 'liabilities', 'equity', 'revenue', 'expenses']);

qboImportRouter.post('/suggest-numbers', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = numberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { importId, rowKeys, reservedNumbers, useAi } = parsed.data;
  try {
    const importRow = await db('document_imports').where({ id: importId, import_type: 'qbo' }).first();
    if (!importRow) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Import not found.' } });
      return;
    }
    if (importRow.status !== 'pending') {
      res.status(409).json({ data: null, error: { code: 'IMPORT_ALREADY_CONFIRMED', message: 'This import was already confirmed. Run a new preview.' } });
      return;
    }
    const clientId = importRow.client_id as number;
    const periodId = importRow.period_id as number;
    const stored = (typeof importRow.ai_extraction === 'string' ? JSON.parse(importRow.ai_extraction) : importRow.ai_extraction) as StoredQboImport;

    const coa = await loadCoaForMatch(clientId);
    const inactive = await loadInactiveByNumber(clientId);
    const matched = matchRows(flattenTrialBalanceRows(stored.raw), coa, stored.accounts ?? [], { inactiveNumbers: new Set(inactive.keys()) });
    const wanted = rowKeys ? new Set(rowKeys) : null;
    // Only rows QuickBooks sent without a number; a row that has one keeps it.
    const targets = matched.filter(
      (r) => (wanted ? wanted.has(r.rowKey) : true) && r.action !== 'match' && !(r.qboAcctNum ?? '').trim(),
    );
    if (targets.length === 0) {
      res.json({ data: { suggestions: [] as NumberSuggestion[], rowsConsidered: 0, aiUsed: false, aiError: null }, error: null });
      return;
    }

    const existing = coa.map((c) => ({ number: c.account_number, category: (c.category ?? null) as AccountCategory | null }));
    // Inactive accounts keep their numbers: neither the model nor the sequence may hand one out.
    for (const n of inactive.keys()) existing.push({ number: n, category: null });
    const used = new Set<string>(existing.map((e) => e.number));
    const reserved: string[] = [];
    for (const n of reservedNumbers ?? []) {
      const clean = String(n).trim();
      if (clean) { reserved.push(clean); used.add(clean); }
    }

    const results = new Map<string, NumberSuggestion>();
    let aiUsed = false;
    let aiError: string | null = null;

    if (useAi) {
      try {
        const { provider, fastModel } = await getLLMProvider();
        const existingList = coa.map((c) => `${c.account_number} — ${c.account_name} (${c.category ?? 'untyped'})`).join('\n');
        const assignedSoFar: string[] = [];
        for (let i = 0; i < targets.length; i += NUMBER_AI_BATCH_SIZE) {
          const batch = targets.slice(i, i + NUMBER_AI_BATCH_SIZE);
          const accountList = batch
            .map((r) => `ref ${r.rowKey}: "${r.qboFullName}"${r.newCategory ? ` [category: ${r.newCategory}]` : r.classification ? ` [QuickBooks type: ${r.classification}]` : ''}`)
            .join('\n');
          const prompt = `You are an expert accountant. Assign standard chart of accounts numbers to these accounts.

Standard numbering conventions:
- 1000-1999: Assets (1000-1099 cash/bank, 1100-1199 receivables, 1200-1299 inventory, 1300-1499 prepaid/other current, 1500-1999 fixed assets)
- 2000-2999: Liabilities (2000-2099 accounts payable, 2100-2199 accrued liabilities, 2200-2499 other current, 2500-2999 long-term debt)
- 3000-3999: Equity (3000-3099 contributed capital/paid-in, 3900-3999 retained earnings/distributions)
- 4000-4999: Revenue / income
- 5000-5999: Cost of goods sold / direct costs
- 6000-7999: Operating expenses (6000-6999 general & admin, 7000-7999 other operating)
- 8000-8999: Other income/expense, interest, taxes

Follow the digit count and bands this chart already uses. Existing account numbers already in use (avoid conflicts):
${existingList || '(none)'}
${assignedSoFar.length > 0 ? `\nAlso already assigned earlier in this same import (avoid these too):\n${assignedSoFar.join(', ')}\n` : ''}

Accounts that need numbers:
${accountList}

Assign numbers with gaps of 10-50 between consecutive entries to allow future insertions. Infer the category and normal balance from the account name when no category is given.

Return ONLY a valid JSON array (no prose, no markdown fences). Use the EXACT ref values shown above:
[
  { "ref": "12", "suggestedNumber": "1000", "suggestedCategory": "assets", "suggestedNormalBalance": "debit" }
]`;
          const { result, logId } = await aiComplete(
            provider,
            {
              model: fastModel,
              taskClass: TB_TASK_CLASSES.ACCOUNT_NUMBERING,
              maxTokens: Math.min(NUMBER_AI_MAX_TOKENS, Math.max(2048, batch.length * 150)),
              messages: [{ role: 'user', content: prompt }],
            },
            { endpoint: 'qbo/suggest-numbers', userId: req.user?.userId, userRole: req.user?.role, clientId, periodId },
          );
          aiUsed = true;
          type Raw = { ref?: string | number; suggestedNumber?: string | number; suggestedCategory?: string; suggestedNormalBalance?: string };
          const arr = extractJsonArray<Raw>(result.text);
          if (!arr) {
            markAiUsageParseError(logId, `Invalid JSON (finish=${result.stopReason ?? 'unknown'}). text[0..500]=${JSON.stringify(result.text.slice(0, 500))}`);
            continue;
          }
          const byKey = new Map(batch.map((r) => [r.rowKey, r]));
          for (const raw of arr) {
            if (!raw || typeof raw !== 'object') continue;
            const row = byKey.get(String(raw.ref ?? '').trim());
            if (!row || results.has(row.rowKey)) continue;
            let num = String(raw.suggestedNumber ?? '').replace(/[^0-9]/g, '').slice(0, 20);
            if (!num) continue;
            while (used.has(num)) num = String(parseInt(num, 10) + 1);
            used.add(num);
            assignedSoFar.push(num);
            const cat = String(raw.suggestedCategory ?? '').toLowerCase().trim();
            const nb = String(raw.suggestedNormalBalance ?? '').toLowerCase().trim();
            results.set(row.rowKey, {
              rowKey: row.rowKey,
              suggestedNumber: num,
              // QuickBooks' own Classification, when it typed the row, beats the model's guess.
              suggestedCategory: row.newCategory ?? (VALID_CATEGORIES.has(cat) ? cat : null),
              suggestedNormalBalance: row.newNormalBalance ?? (nb === 'credit' || nb === 'debit' ? nb : null),
              source: 'ai',
            });
          }
        }
      } catch (err) {
        // AI unavailable or refused: the sequence fills every row instead,
        // and the client is told why the numbers are plain.
        aiError = err instanceof Error ? err.message : String(err);
        console.warn(`[qbo/suggest-numbers] AI pass failed, numbering in sequence: ${aiError}`);
      }
    }

    const rest = targets.filter((r) => !results.has(r.rowKey));
    if (rest.length > 0) {
      const seq = assignSequentialNumbers(
        rest.map((r) => ({ key: r.rowKey, name: r.qboFullName, category: r.newCategory })),
        existing,
        [...reserved, ...Array.from(results.values()).map((s) => s.suggestedNumber)],
      );
      for (const s of seq) {
        const row = rest.find((r) => r.rowKey === s.key)!;
        results.set(s.key, {
          rowKey: s.key,
          suggestedNumber: s.number,
          suggestedCategory: row.newCategory ?? s.category,
          suggestedNormalBalance: row.newNormalBalance ?? s.normalBalance,
          source: 'sequence',
        });
      }
    }

    const suggestions = targets.map((r) => results.get(r.rowKey)!);
    res.json({ data: { suggestions, rowsConsidered: targets.length, aiUsed, aiError }, error: null });
  } catch (err) {
    if (respondQboError(res, err)) return;
    sendServerError(res, err, 'qbo/suggest-numbers');
  }
});

qboImportRouter.post('/confirm', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { importId, decisions, zeroAbsent } = parsed.data;
  try {
    const importRow = await db('document_imports').where({ id: importId, import_type: 'qbo' }).first();
    if (!importRow) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Import not found.' } });
      return;
    }
    if (importRow.status !== 'pending') {
      res.status(409).json({ data: null, error: { code: 'IMPORT_ALREADY_CONFIRMED', message: 'This import was already confirmed. Run a new preview.' } });
      return;
    }
    const clientId = importRow.client_id as number;
    const periodId = importRow.period_id as number;
    const stored = (typeof importRow.ai_extraction === 'string' ? JSON.parse(importRow.ai_extraction) : importRow.ai_extraction) as StoredQboImport;

    const conn = await loadConnectionForClient(clientId);
    if (!conn || conn.realm_id !== stored.realmId) {
      res.status(409).json({
        data: null,
        error: { code: 'QBO_CONNECTION_CHANGED', message: 'The QuickBooks connection for this client changed since the preview. Run a new preview.' },
      });
      return;
    }

    // Everything numeric comes from the stored report, matched against the COA as it is NOW.
    const reportRows = flattenTrialBalanceRows(stored.raw);
    const totals = validateTotals(reportRows, extractSummaryTotals(stored.raw));
    if (!totals.balanced && !parsed.data.acknowledgeUnbalanced) {
      res.status(422).json({
        data: null,
        error: { code: 'OUT_OF_BALANCE', message: `The QuickBooks report is out of balance by ${totals.imbalanceCents} cents. Acknowledge it to import anyway.` },
      });
      return;
    }
    const existingCoa = await loadCoaForMatch(clientId);
    const inactive = await loadInactiveByNumber(clientId);
    const matched = matchRows(reportRows, existingCoa, stored.accounts ?? [], { inactiveNumbers: new Set(inactive.keys()) });
    let finalRows;
    try {
      finalRows = applyDecisions(matched, decisions);
    } catch (err) {
      if (err instanceof DecisionError) {
        res.status(422).json({ data: null, error: { code: 'INVALID_DECISION', message: err.message } });
        return;
      }
      throw err;
    }

    // A matched id must belong to this client — a forged id would move a balance onto another client's account.
    const validAccountIds = new Set(existingCoa.map((c) => c.id));
    const badId = finalRows.find((r) => r.action === 'match' && !validAccountIds.has(r.matchedAccountId!));
    if (badId) {
      res.status(422).json({ data: null, error: { code: 'INVALID_ACCOUNT_ID', message: `Account ${badId.matchedAccountId} does not belong to this client.` } });
      return;
    }
    const existingByNumber = new Map(existingCoa.map((c) => [c.account_number, c]));
    const seenNew = new Set<string>();
    for (const r of finalRows) {
      if (r.action !== 'create_new') continue;
      // Same cleaning the insert applies, done here so a number that cleans
      // to nothing is refused up front — there is no QB<Id> stand-in any more.
      const num = (r.newAccountNumber ?? '').replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 20);
      if (!num) {
        res.status(422).json({ data: null, error: { code: 'MISSING_ACCOUNT_NUMBER', message: `"${r.qboFullName}" is a new account but has no usable account number.` } });
        return;
      }
      r.newAccountNumber = num;
      const retired = inactive.get(num);
      if (retired) {
        res.status(422).json({
          data: null,
          error: {
            code: 'ACCOUNT_NUMBER_INACTIVE',
            message: `Account number ${num} belongs to the inactive account "${retired.account_name}". Reactivate that account in the Chart of Accounts and match "${r.qboFullName}" to it, or give the new account a different number.`,
          },
        });
        return;
      }
      if (seenNew.has(num)) {
        res.status(422).json({ data: null, error: { code: 'DUPLICATE_ACCOUNT_NUMBER', message: `Account number ${num} is used by more than one new account.` } });
        return;
      }
      seenNew.add(num);
    }
    // Two rows pointed at the same existing account would silently overwrite each other's balance.
    const seenMatch = new Set<number>();
    for (const r of finalRows) {
      if (r.action !== 'match') continue;
      if (seenMatch.has(r.matchedAccountId!)) {
        const acct = existingCoa.find((c) => c.id === r.matchedAccountId);
        res.status(422).json({
          data: null,
          error: { code: 'DUPLICATE_MATCH', message: `More than one QuickBooks account is matched to ${acct?.account_number ?? r.matchedAccountId}.` },
        });
        return;
      }
      seenMatch.add(r.matchedAccountId!);
    }

    const leadSheets = (await db('lead_sheets').where({ client_id: clientId }).select('id', 'code')) as Array<{ id: number; code: string | null }>;
    const leadSheetByCode = new Map<string, number>(
      leadSheets.filter((s) => !!s.code).map((s) => [s.code!.trim().toUpperCase(), s.id]),
    );

    const target: ImportTarget = stored.target ?? 'current';
    const stats = { accountsMatched: 0, accountsCreated: 0, rowsImported: 0, rowsSkipped: 0, accountsZeroed: 0, qboIdsLinked: 0 };

    await db.transaction(async (trx) => {
      await trx.raw('SELECT id FROM periods WHERE id = ? FOR UPDATE', [periodId]);
      await assertPeriodUnlocked(periodId, trx);

      const upsertCurrent = async (accountId: number, debit: number, credit: number): Promise<void> => {
        await trx('trial_balance')
          .insert({
            period_id: periodId,
            account_id: accountId,
            unadjusted_debit: debit,
            unadjusted_credit: credit,
            updated_by: req.user!.userId,
            updated_at: trx.fn.now(),
          })
          .onConflict(['period_id', 'account_id'])
          .merge(['unadjusted_debit', 'unadjusted_credit', 'updated_by', 'updated_at']);
      };
      // Same shape as /py-comparison/confirm-csv: the upload REPLACES the period's PY data.
      const pySourceFilename = `${stored.companyName} ${stored.params.start_date} – ${stored.params.end_date} (${stored.accountingMethod})`.slice(0, 255);
      const upsertPrior = async (accountId: number, debit: number, credit: number): Promise<void> => {
        await trx('py_comparison_data')
          .insert({
            period_id: periodId,
            account_id: accountId,
            py_debit: debit,
            py_credit: credit,
            source: 'qbo',
            source_filename: pySourceFilename,
            uploaded_at: trx.fn.now(),
            uploaded_by: req.user!.userId,
          })
          .onConflict(['period_id', 'account_id'])
          .merge(['py_debit', 'py_credit', 'source', 'source_filename', 'uploaded_at', 'uploaded_by']);
      };
      const upsertTb = target === 'prior' ? upsertPrior : upsertCurrent;
      if (target === 'prior') await trx('py_comparison_data').where({ period_id: periodId }).del();

      const stampQboId = async (accountId: number, qboId: string | null, qboName: string | null): Promise<void> => {
        if (!qboId) return;
        // The user may have re-pointed a QBO account at a different COA row; the
        // old holder loses the link so the partial unique index is never tripped.
        await trx('chart_of_accounts').where({ client_id: clientId, qbo_account_id: qboId }).whereNot('id', accountId).update({ qbo_account_id: null });
        const changed = await trx('chart_of_accounts')
          .where({ id: accountId })
          .andWhere((q) => q.whereNull('qbo_account_id').orWhereNot('qbo_account_id', qboId))
          .update({ qbo_account_id: qboId });
        if (changed) stats.qboIdsLinked++;
        // The display name rides along so a later name match sees QBO's
        // current wording, not what an old CSV recorded.
        if (qboName) await trx('chart_of_accounts').where({ id: accountId }).update({ qbo_account_name: qboName.slice(0, 255) });
      };

      const touched = new Set<number>();
      for (const r of finalRows) {
        if (r.action === 'skip') {
          stats.rowsSkipped++;
          continue;
        }
        let accountId: number;
        if (r.action === 'match') {
          accountId = r.matchedAccountId!;
          stats.accountsMatched++;
        } else {
          // Cleaned and verified non-empty by the loop above.
          const number = r.newAccountNumber!;
          const existing = existingByNumber.get(number);
          if (existing) {
            // Number already on the books (e.g. the number was retyped to an existing one): treat as a match.
            accountId = existing.id;
            stats.accountsMatched++;
          } else {
            const category = r.newCategory ?? inferAccountType(number, r.newAccountName ?? '').category;
            const normalBalance = r.newNormalBalance ?? inferAccountType(number, r.newAccountName ?? '').normalBalance;
            const hit = suggestLeadSheet({ category, subcategory: null, accountNumber: number, accountName: r.newAccountName ?? '' });
            const leadSheetId = hit ? leadSheetByCode.get(hit.code.toUpperCase()) ?? null : null;
            // An account nothing on the preview could see (inactive, or bound
            // since the preview) may still hold this QuickBooks id; the partial
            // unique index would refuse the insert. The reviewer chose to create
            // a new account for it, so the old link is stale — clear it first,
            // exactly as stampQboId does for a match.
            if (r.qboAccountId) {
              await trx('chart_of_accounts').where({ client_id: clientId, qbo_account_id: r.qboAccountId }).update({ qbo_account_id: null });
            }
            const [created] = (await trx('chart_of_accounts')
              .insert({
                client_id: clientId,
                account_number: number,
                account_name: (r.newAccountName ?? r.qboFullName).slice(0, 255),
                category,
                normal_balance: normalBalance,
                is_active: true,
                qbo_account_id: r.qboAccountId,
                qbo_account_name: r.qboFullName.slice(0, 255),
                lead_sheet_id: leadSheetId,
                lead_sheet_source: leadSheetId ? 'auto' : null,
              })
              .returning('id')) as Array<{ id: number }>;
            accountId = created.id;
            existingByNumber.set(number, { id: accountId, account_number: number, account_name: r.newAccountName ?? '', qbo_account_id: r.qboAccountId });
            stats.accountsCreated++;
            if (r.qboAccountId) stats.qboIdsLinked++;
          }
        }
        if (r.action === 'match' || existingByNumber.get(r.newAccountNumber ?? '')?.id === accountId) {
          await stampQboId(accountId, r.qboAccountId, r.qboFullName);
        }
        await upsertTb(accountId, r.debitCents, r.creditCents);
        touched.add(accountId);
        stats.rowsImported++;
      }

      if (zeroAbsent && target === 'current') {
        const tbRows = (await trx('trial_balance as tb')
          .join('chart_of_accounts as coa', 'coa.id', 'tb.account_id')
          .where({ 'tb.period_id': periodId })
          .select('tb.account_id', 'coa.account_number', 'coa.account_name', 'tb.unadjusted_debit', 'tb.unadjusted_credit')) as Array<{
          account_id: number;
          account_number: string;
          account_name: string;
          unadjusted_debit: string | number;
          unadjusted_credit: string | number;
        }>;
        for (const a of findAbsentNonzeroAccounts(tbRows, touched)) {
          await upsertTb(a.accountId, 0, 0);
          stats.accountsZeroed++;
        }
      }

      const result = { ...stats, confirmedAt: new Date().toISOString(), confirmedBy: req.user!.userId, zeroAbsent };
      await trx('document_imports')
        .where({ id: importId })
        .update({
          status: 'confirmed',
          ai_extraction: JSON.stringify({ ...stored, decisions, result }),
          imported_by: req.user!.userId,
          imported_at: trx.fn.now(),
        });
      await trx('qbo_connections').where({ id: conn.id }).update({ last_import_at: trx.fn.now(), updated_at: trx.fn.now() });

      await logAudit(
        target === 'prior'
          ? {
              userId: req.user!.userId,
              periodId,
              clientId,
              entityType: 'py_comparison',
              entityId: periodId,
              action: 'create',
              description: `Imported PY comparison from QuickBooks "${stored.companyName}" (${stored.params.start_date} – ${stored.params.end_date}, ${stored.accountingMethod}) — ${stats.rowsImported} accounts, ${stats.accountsCreated} new accounts`,
            }
          : {
              userId: req.user!.userId,
              periodId,
              clientId,
              entityType: 'document_import',
              entityId: importId,
              action: 'import',
              description: `QuickBooks trial balance imported from "${stored.companyName}" (${stored.params.start_date} – ${stored.params.end_date}, ${stored.accountingMethod}): ${stats.rowsImported} rows, ${stats.accountsCreated} new accounts, ${stats.accountsZeroed} zeroed`,
            },
        trx,
      );
    });

    res.json({
      data: {
        ...stats,
        target,
        accountsWithoutTaxCodes: stats.accountsCreated,
        total: stats.rowsImported + stats.rowsSkipped,
      },
      error: null,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked' } });
      return;
    }
    if (respondQboError(res, err)) return;
    // A unique index nothing above caught (a number or QuickBooks link taken
    // by a row the preview could not see): say which, instead of "internal error".
    if (isUniqueViolation(err)) {
      console.warn(`[qbo-import confirm] refused by ${err.constraint ?? 'a unique index'}: ${err.detail ?? ''}`);
      res.status(409).json({ data: null, error: { code: 'IMPORT_CONFLICT', message: uniqueViolationMessage(err, 'import') } });
      return;
    }
    sendServerError(res, err, 'qbo-import confirm');
  }
});
