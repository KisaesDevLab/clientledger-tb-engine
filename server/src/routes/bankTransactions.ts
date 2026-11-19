// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { parse } from 'fast-csv';
import { Readable } from 'stream';
import type { Knex } from 'knex';
import { createHash } from 'crypto';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { assertNotCheckedOut, assertPeriodUnlocked, lockAndListHeld, logAudit } from '../lib/periodGuard';
import { aiComplete, markAiUsageParseError } from '../lib/aiComplete';
import { ensureTrialBalanceRows } from '../lib/ensureTrialBalanceRows';
import { getLLMProvider } from '../lib/aiClient';
import { TB_TASK_CLASSES } from '../lib/routerProvider';
import { extractJsonArray } from '../lib/aiJsonExtract';
import { sendServerError } from '../lib/safeError';

// v2 dedup key. check_number and source_account_id distinguish identical
// activity across accounts (e.g. the same service fee hitting two accounts on
// the same day); ordinal is the occurrence index of an identical row WITHIN
// one import file, so two legitimate same-day/same-amount transactions both
// survive while a re-import of the same file still dedups.
function txHash(
  date: string,
  description: string,
  amount: number,
  checkNumber: string | null,
  sourceAccountId: number | null,
  ordinal: number,
): string {
  const key = `${date}|${description}|${amount}|${checkNumber ?? ''}|${sourceAccountId ?? ''}|${ordinal}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 64);
}

// Hash format used before the v2 key. Rows imported by older versions carry
// this hash; consulted (for the first occurrence only) so upgrading does not
// duplicate previously imported statements on re-import.
export function legacyTxHash(date: string, description: string, amount: number): string {
  return createHash('sha256').update(`${date}|${description}|${amount}`).digest('hex').slice(0, 64);
}

// Parse a dollar-and-cents string ("10.07", "-1,234.50", "$ (10.05)") to integer cents.
// Uses string arithmetic, not float — `parseFloat('1.005') * 100` rounds the wrong way.
// Returns null if the input is not a valid number.
function parseDollarsToCents(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Accounting parentheses → negative
  let sign = 1;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { sign = -1; s = paren[1]; }
  // Strip currency symbols, thousands separators, whitespace
  s = s.replace(/[\s,$£€¥]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [intPart = '0', fracPartRaw = ''] = s.split('.');
  // Pad/truncate fractional to exactly 2 digits, half-up on 3rd digit
  let fracPart = fracPartRaw.slice(0, 2).padEnd(2, '0');
  if (fracPartRaw.length >= 3) {
    const third = fracPartRaw.charCodeAt(2) - 48;
    if (third >= 5) {
      // round up the 2-digit fraction; carry into integer part if it becomes 100
      const bumped = Number(fracPart) + 1;
      if (bumped === 100) {
        fracPart = '00';
        // add 1 to intPart as string to avoid Number overflow at extreme sizes
        const digits = intPart.split('').reverse();
        let carry = 1;
        for (let i = 0; i < digits.length && carry > 0; i++) {
          const n = Number(digits[i]) + carry;
          digits[i] = String(n % 10);
          carry = Math.floor(n / 10);
        }
        if (carry > 0) digits.push(String(carry));
        const newInt = digits.reverse().join('');
        const cents = Number(newInt + fracPart);
        return isFinite(cents) ? sign * cents : null;
      } else {
        fracPart = String(bumped).padStart(2, '0');
      }
    }
  }
  const combined = `${intPart}${fracPart}`;
  const cents = Number(combined);
  return isFinite(cents) ? sign * cents : null;
}

// ---- Journal entry sync helper ----
// Creates, replaces, or deletes the auto-generated book JE for a bank transaction.
// A JE is created when the transaction has account_id + source_account_id + period_id.
// Sign convention: amount > 0 → DR source, CR classification
//                  amount < 0 → DR classification, CR source (abs amount)
async function syncTxJE(
  trx: Knex.Transaction,
  txId: number,
  clientId: number,
  userId: number,
): Promise<void> {
  const tx = await trx('bank_transactions').where({ id: txId, client_id: clientId }).first();
  if (!tx) return;

  // Figure out every period row this operation will touch and lock them in
  // ASCENDING id order. Acquiring locks in a canonical order across all code
  // paths eliminates the two-way deadlock where tx A holds period 5 and wants
  // 7 while tx B holds 7 and wants 5.
  let existingJePeriodId: number | null = null;
  if (tx.journal_entry_id) {
    const existingJe = await trx('journal_entries')
      .where({ id: tx.journal_entry_id })
      .first('period_id');
    existingJePeriodId = (existingJe?.period_id as number | null) ?? null;
  }
  const targetPeriodId: number | null = tx.period_id ?? null;
  const periodsToLock = Array.from(
    new Set(
      [existingJePeriodId, targetPeriodId].filter((p): p is number => typeof p === 'number'),
    ),
  ).sort((a, b) => a - b);
  for (const pid of periodsToLock) {
    await assertPeriodUnlocked(pid, trx);
  }

  // If there's no period to sync against, just clear any stale JE link. The
  // existing JE's period (if any) is already locked above.
  if (!tx.period_id) {
    if (tx.journal_entry_id) {
      await trx('journal_entry_lines').where({ journal_entry_id: tx.journal_entry_id }).delete();
      await trx('journal_entries').where({ id: tx.journal_entry_id }).delete();
      await trx('bank_transactions').where({ id: txId }).update({ journal_entry_id: null });
    }
    return;
  }

  // Delete any existing auto-generated JE (lock on its period already acquired above)
  if (tx.journal_entry_id) {
    await trx('journal_entry_lines').where({ journal_entry_id: tx.journal_entry_id }).delete();
    await trx('journal_entries').where({ id: tx.journal_entry_id }).delete();
    await trx('bank_transactions').where({ id: txId }).update({ journal_entry_id: null });
  }

  // Need all three fields to create a JE. Note: pg returns BIGINT columns as
  // strings, so the zero check must happen after conversion — `'0' === 0` is
  // never true and would let zero-amount JEs through.
  if (!tx.account_id || !tx.source_account_id) return;

  const txAmount = BigInt(tx.amount);
  if (txAmount === 0n) return;
  const absAmountBig = txAmount < 0n ? -txAmount : txAmount;
  const absAmount = Number(absAmountBig);
  const debitAccountId  = txAmount > 0n ? tx.source_account_id : tx.account_id;
  const creditAccountId = txAmount > 0n ? tx.account_id : tx.source_account_id;
  const lastEntry = await trx('journal_entries')
    .where({ period_id: tx.period_id, entry_type: 'trans' })
    .max('entry_number as max')
    .first();
  const entryNumber = ((lastEntry?.max as number) ?? 0) + 1;

  const [je] = await trx('journal_entries').insert({
    period_id: tx.period_id,
    entry_number: entryNumber,
    entry_type: 'trans',
    entry_date: tx.transaction_date,
    description: tx.description ?? `Bank transaction ${tx.transaction_date}`,
    is_recurring: false,
    created_by: userId,
  }).returning('*');

  await trx('journal_entry_lines').insert([
    { journal_entry_id: je.id, account_id: debitAccountId,  debit: absAmount, credit: 0 },
    { journal_entry_id: je.id, account_id: creditAccountId, debit: 0, credit: absAmount },
  ]);

  // Ensure trial_balance rows exist for both accounts
  await ensureTrialBalanceRows(trx, tx.period_id, [debitAccountId, creditAccountId]);

  await trx('bank_transactions').where({ id: txId }).update({ journal_entry_id: je.id });
}

export const btCollectionRouter = Router({ mergeParams: true });
export const btRulesRouter = Router({ mergeParams: true });
btCollectionRouter.use(authMiddleware);
btRulesRouter.use(authMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });


// GET /api/v1/clients/:clientId/bank-transactions
btCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize) || 100));
    const offset = (page - 1) * pageSize;

    let countQuery = db('bank_transactions').where({ client_id: clientId });
    if (req.query.sourceAccountId) {
      countQuery = countQuery.where('source_account_id', Number(req.query.sourceAccountId));
    }
    if (req.query.periodId) {
      countQuery = countQuery.where('period_id', Number(req.query.periodId));
    }
    if (req.query.status) {
      countQuery = countQuery.where('classification_status', String(req.query.status));
    }
    if (req.query.entrySource) {
      countQuery = countQuery.where('entry_source', String(req.query.entrySource));
    } else if (req.query.excludeEntrySource) {
      countQuery = countQuery.whereNot('entry_source', String(req.query.excludeEntrySource));
    }
    const [{ count }] = await countQuery.count('id as count');
    const total = Number(count);

    let query = db('bank_transactions as bt')
      .where('bt.client_id', clientId)
      .leftJoin('chart_of_accounts as coa', 'bt.account_id', 'coa.id')
      .leftJoin('chart_of_accounts as ai_coa', 'bt.ai_suggested_account_id', 'ai_coa.id')
      .leftJoin('chart_of_accounts as src', 'bt.source_account_id', 'src.id')
      .select(
        'bt.*',
        'coa.account_name',
        'coa.account_number',
        db.raw('ai_coa.account_name as ai_suggested_account_name'),
        db.raw('ai_coa.account_number as ai_suggested_account_number'),
        db.raw('src.account_name as source_account_name'),
        db.raw('src.account_number as source_account_number'),
      )
      .orderBy([{ column: 'bt.transaction_date', order: 'desc' }, { column: 'bt.id', order: 'desc' }]);

    if (req.query.sourceAccountId) {
      query = query.where('bt.source_account_id', Number(req.query.sourceAccountId));
    }

    if (req.query.periodId) {
      query = query.where('bt.period_id', Number(req.query.periodId));
    }
    if (req.query.status) {
      query = query.where('bt.classification_status', String(req.query.status));
    }
    if (req.query.entrySource) {
      query = query.where('bt.entry_source', String(req.query.entrySource));
    } else if (req.query.excludeEntrySource) {
      query = query.whereNot('bt.entry_source', String(req.query.excludeEntrySource));
    }

    // Status tallies across the WHOLE filtered dataset (ignoring the status
    // filter and pagination) so the UI can show dataset-wide counts instead of
    // presenting per-page tallies as totals.
    let statusQuery = db('bank_transactions').where({ client_id: clientId });
    if (req.query.sourceAccountId) statusQuery = statusQuery.where('source_account_id', Number(req.query.sourceAccountId));
    if (req.query.periodId) statusQuery = statusQuery.where('period_id', Number(req.query.periodId));
    if (req.query.entrySource) statusQuery = statusQuery.where('entry_source', String(req.query.entrySource));
    else if (req.query.excludeEntrySource) statusQuery = statusQuery.whereNot('entry_source', String(req.query.excludeEntrySource));
    const statusRows = await statusQuery.groupBy('classification_status').select('classification_status').count('id as cnt');
    const statusCounts: Record<string, number> = {};
    for (const r of statusRows as Array<{ classification_status: string; cnt: string | number }>) {
      statusCounts[r.classification_status] = Number(r.cnt);
    }

    const rows = await query.limit(pageSize).offset(offset);
    // BIGINT comes back as a string from pg; hand the client a real number so
    // arithmetic and sorting behave.
    const data = (rows as Record<string, unknown>[]).map((r) => ({ ...r, amount: Number(r.amount) }));
    res.json({ data, error: null, meta: { total, page, pageSize, pages: Math.ceil(total / pageSize), statusCounts } });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// POST /api/v1/clients/:clientId/bank-transactions (manual entry)
const txSchema = z.object({
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().max(500).optional(),
  amount: z.number().int(),
  checkNumber: z.string().max(20).optional(),
  periodId: z.number().int().positive().optional(),
  sourceAccountId: z.number().int().positive().optional(),
});

btCollectionRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = txSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { transactionDate, description, amount, checkNumber, periodId, sourceAccountId } = result.data;
  try {
    // Refuse to create bank-tx rows pointing at a locked period. Without this,
    // any downstream classification would then try to post into a locked
    // period and the user sees a cascade of surprise errors.
    if (periodId) {
      const periodRow = await db('periods').where({ id: periodId }).first('locked_at', 'is_reference');
      // A reference period (desktop sync) holds no data here either.
      if (periodRow?.locked_at || periodRow?.is_reference) {
        res.status(409).json({
          data: null,
          error: { code: 'PERIOD_LOCKED', message: 'Cannot add transactions to a locked period.' },
        });
        return;
      }
    }
    const row = await db.transaction(async (trx) => {
      // Desktop sync: not into a period a desktop holds.
      await assertNotCheckedOut(trx, [periodId]);
      const [inserted] = await trx('bank_transactions').insert({
        client_id: clientId,
        period_id: periodId ?? null,
        source_account_id: sourceAccountId ?? null,
        transaction_date: transactionDate,
        description: description ?? null,
        amount,
        check_number: checkNumber ?? null,
        classification_status: 'unclassified',
      }).returning('*');
      return inserted;
    });
    res.status(201).json({ data: row, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// ---- Flexible date parser ----
// Handles YYYY-MM-DD, M/D/YYYY, MM/DD/YYYY, M/D/YY, M-D-YYYY variants
function parseFlexDate(val: string): string | null {
  const s = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const slash = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/.exec(s);
  if (slash) {
    const [, m, d, y] = slash;
    const year = y.length === 2 ? (Number(y) >= 50 ? `19${y}` : `20${y}`) : y.padStart(4, '20');
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

// ---- OFX/QFX/QBO parser (handles both SGML 1.x and XML 2.x) ----

interface ParsedTx {
  transaction_date: string;
  description: string | null;
  amount: number; // cents
  check_number: string | null;
}

// Extract a leaf element value from XML OFX (has closing tags on every element)
function ofxTagXml(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(block);
  return m ? m[1].trim() : null;
}

// Extract a leaf element value from SGML OFX (no closing tags on leaf elements;
// value ends at end of line or next opening tag)
function ofxTagSgml(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>[ \t]*([^\r\n<]+)`, 'i').exec(block);
  return m ? m[1].trim() : null;
}

function ofxDate(raw: string): string | null {
  // Strip timezone suffix: YYYYMMDDHHMMSS.mmm[TZ:NAME] or [...] or [+HH] etc.
  const d = raw.replace(/[\[.+\-].*$/, '').replace(/\s/g, '');
  if (d.length >= 8 && /^\d{8}/.test(d)) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  return null;
}

function parseOfx(fileBuffer: Buffer): ParsedTx[] {
  // Try UTF-8 first; fall back to latin1 for Windows-1252 encoded files
  let content = fileBuffer.toString('utf8');
  if (content.includes('\uFFFD')) {
    content = fileBuffer.toString('latin1');
  }

  // Strip UTF-8 BOM if present
  content = content.replace(/^\uFEFF/, '');

  // Detect XML vs SGML:
  //   OFX 2.x XML:  leaf elements have closing tags  e.g. </DTPOSTED>
  //   OFX 1.x SGML: only aggregate elements have closing tags; leaf elements do NOT
  //   OFXHEADER:200 also signals XML; OFXHEADER:100 signals SGML
  const isXml =
    /OFXHEADER:\s*200/i.test(content) ||
    /^<\?xml/i.test(content.trimStart()) ||
    /<\/DTPOSTED>/i.test(content) ||
    /<\/TRNAMT>/i.test(content);

  const results: ParsedTx[] = [];

  if (isXml) {
    const blockRe = /<STMTTRN[^>]*>([\s\S]*?)<\/STMTTRN>/gi;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(content)) !== null) {
      const b = m[1];
      const date = ofxTagXml(b, 'DTPOSTED');
      const amt = ofxTagXml(b, 'TRNAMT');
      const name = ofxTagXml(b, 'NAME') ?? ofxTagXml(b, 'MEMO') ?? ofxTagXml(b, 'PAYEE');
      const check = ofxTagXml(b, 'CHECKNUM');
      if (!date || !amt) continue;
      const parsedDate = ofxDate(date);
      const parsedCents = parseDollarsToCents(amt);
      if (!parsedDate || parsedCents === null) continue;
      results.push({
        transaction_date: parsedDate,
        description: name || null,
        amount: parsedCents,
        check_number: check || null,
      });
    }
  } else {
    // SGML: aggregate elements like <STMTTRN>...</STMTTRN> have closing tags,
    // but leaf elements like <DTPOSTED> and <TRNAMT> do not.
    const blocks = content.split(/<STMTTRN[^>]*>/i).slice(1);
    for (const block of blocks) {
      // Terminate block at </STMTTRN> (present in SGML for aggregate close)
      const endIdx = block.search(/<\/STMTTRN>/i);
      const b = endIdx >= 0 ? block.slice(0, endIdx) : block;

      const date = ofxTagSgml(b, 'DTPOSTED');
      const amt = ofxTagSgml(b, 'TRNAMT');
      const name = ofxTagSgml(b, 'NAME') ?? ofxTagSgml(b, 'MEMO') ?? ofxTagSgml(b, 'PAYEE');
      const check = ofxTagSgml(b, 'CHECKNUM');
      if (!date || !amt) continue;
      const parsedDate = ofxDate(date);
      const parsedCents = parseDollarsToCents(amt);
      if (!parsedDate || parsedCents === null) continue;
      results.push({
        transaction_date: parsedDate,
        description: name || null,
        amount: parsedCents,
        check_number: check || null,
      });
    }
  }

  return results;
}

// POST /api/v1/clients/:clientId/bank-transactions/import (CSV / OFX / QFX / QBO)
btCollectionRouter.post('/import', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  if (!req.file) {
    res.status(400).json({ data: null, error: { code: 'NO_FILE', message: 'No file uploaded' } });
    return;
  }

  const periodId = req.body.periodId ? Number(req.body.periodId) : null;
  const sourceAccountId = req.body.sourceAccountId ? Number(req.body.sourceAccountId) : null;

  interface TxRow {
    transaction_date: string;
    description: string | null;
    amount: number;
    check_number: string | null;
    client_id: number;
    period_id: number | null;
    source_account_id: number | null;
    classification_status: string;
  }

  try {
    const rows: TxRow[] = [];
    const filename = (req.file.originalname ?? '').toLowerCase();
    const isOfx = /\.(ofx|qfx|qbo)$/.test(filename);

    if (isOfx) {
      const parsed = parseOfx(req.file.buffer);
      for (const p of parsed) {
        rows.push({ client_id: clientId, period_id: periodId, source_account_id: sourceAccountId, classification_status: 'unclassified', ...p });
      }
    } else {
      // Column mapping — explicit mapping from request body, or fall back to auto-detect
      const dateCol: string = req.body.dateCol ?? '';
      const descCol: string = req.body.descCol ?? '';
      const amountCol: string = req.body.amountCol ?? '';
      const debitCol: string = req.body.debitCol ?? '';
      const creditCol: string = req.body.creditCol ?? '';
      const checkCol: string = req.body.checkCol ?? '';

      const pick = (row: Record<string, string>, explicit: string, fallbacks: string[]): string => {
        if (explicit && row[explicit] !== undefined) return row[explicit];
        for (const f of fallbacks) if (row[f] !== undefined) return row[f];
        return '';
      };

      await new Promise<void>((resolve, reject) => {
        const stream = Readable.from(req.file!.buffer);
        stream
          .pipe(parse({ headers: true, trim: true, ignoreEmpty: true }))
          .on('data', (row: Record<string, string>) => {
            const dateRaw = pick(row, dateCol, ['Date', 'date', 'Transaction Date', 'transaction_date']);
            const descRaw = pick(row, descCol, ['Description', 'description', 'Memo', 'memo', 'Payee', 'payee']);
            const checkRaw = pick(row, checkCol, ['Check', 'check', 'Check Number', 'check_number']);

            if (!dateRaw) return;

            const transaction_date = parseFlexDate(dateRaw);
            if (!transaction_date) return;

            // Amount: explicit signed column, or debit/credit split, or auto-detect.
            // All arithmetic happens in integer cents — parseFloat introduces rounding errors.
            let amtCents: number | null;
            if (amountCol && row[amountCol] !== undefined) {
              amtCents = parseDollarsToCents(row[amountCol]);
            } else if (debitCol || creditCol) {
              // Bank-statement convention: the Debit/Withdrawal column is money
              // OUT of the account, the Credit/Deposit column is money IN. The
              // app-wide sign convention (OFX path, JE sync) is positive =
              // deposit, so amount = credit − debit.
              const drC = debitCol ? (parseDollarsToCents(row[debitCol]) ?? 0) : 0;
              const crC = creditCol ? (parseDollarsToCents(row[creditCol]) ?? 0) : 0;
              amtCents = crC - drC;
            } else {
              const amtRaw = pick(row, '', ['Amount', 'amount']);
              if (amtRaw !== '') {
                amtCents = parseDollarsToCents(amtRaw);
              } else {
                // A bare Debit column with no Amount column is money out → negative
                const drRaw = pick(row, '', ['Debit', 'debit']);
                const drC = parseDollarsToCents(drRaw);
                amtCents = drC === null ? null : -drC;
              }
            }

            if (amtCents === null) return;

            rows.push({
              client_id: clientId,
              period_id: periodId,
              source_account_id: sourceAccountId,
              transaction_date,
              description: descRaw.trim() || null,
              amount: amtCents,
              check_number: checkRaw.trim() || null,
              classification_status: 'unclassified',
            });
          })
          .on('end', resolve)
          .on('error', reject);
      });
    }

    if (rows.length === 0) {
      const hint = isOfx
        ? 'No STMTTRN blocks found. Verify the file is a valid OFX/QFX/QBO export and contains transaction data.'
        : 'No valid rows found. Check that the file has a header row with Date and Amount columns.';
      res.status(400).json({ data: null, error: { code: 'EMPTY_FILE', message: hint } });
      return;
    }

    // Assign each row its occurrence index among identical rows in this file,
    // so legitimate within-file duplicates get distinct dedup hashes.
    const occurrenceCounts = new Map<string, number>();
    const hashedRows = rows.map((row) => {
      const key = `${row.transaction_date}|${row.description ?? ''}|${row.amount}|${row.check_number ?? ''}|${row.source_account_id ?? ''}`;
      const ordinal = occurrenceCounts.get(key) ?? 0;
      occurrenceCounts.set(key, ordinal + 1);
      return {
        row,
        ordinal,
        hash: txHash(row.transaction_date, row.description ?? '', row.amount,
          row.check_number, row.source_account_id, ordinal),
        legacyHash: legacyTxHash(row.transaction_date, row.description ?? '', row.amount),
      };
    });

    let importedCount = 0;
    let duplicateCount = 0;
    await db.transaction(async (trx) => {
      // Desktop sync: not into a period a desktop holds.
      await assertNotCheckedOut(trx, hashedRows.map((h) => (h.row as { period_id?: number | null }).period_id));
      // Rows imported before the v2 hash carry the legacy format; match first
      // occurrences against it so re-importing an overlapping statement after
      // the upgrade does not duplicate existing data.
      const legacyCandidates = [...new Set(hashedRows.filter(h => h.ordinal === 0).map(h => h.legacyHash))];
      const existingLegacy = new Set<string>(
        legacyCandidates.length > 0
          ? await trx('bank_transactions')
              .where({ client_id: clientId })
              .whereIn('import_hash', legacyCandidates)
              .pluck('import_hash')
          : [],
      );

      for (const { row, ordinal, hash, legacyHash } of hashedRows) {
        if (ordinal === 0 && existingLegacy.has(legacyHash)) { duplicateCount++; continue; }
        const [inserted] = await trx('bank_transactions')
          .insert({ ...row, import_hash: hash })
          .onConflict(['client_id', 'import_hash'])
          .ignore()
          .returning('id');
        if (inserted) { importedCount++; } else { duplicateCount++; }
      }
    });

    res.json({ data: { imported: importedCount, duplicates: duplicateCount }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// POST /api/v1/clients/:clientId/bank-transactions/manual
const manualBatchSchema = z.object({
  periodId: z.number().int().positive().optional(),
  sourceAccountId: z.number().int().positive().optional(), // batch-level fallback
  transactions: z.array(z.object({
    transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().max(500).min(1),
    amount: z.number().int().refine((v) => v !== 0, { message: 'Amount must be non-zero' }),
    checkNumber: z.string().max(20).optional(),
    accountId: z.number().int().positive(),
    sourceAccountId: z.number().int().positive().optional(), // per-transaction (overrides batch)
    createRule: z.boolean().optional(),
  })).min(1),
});

btCollectionRouter.post('/manual', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = manualBatchSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { periodId, sourceAccountId, transactions } = result.data;
  try {
    let createdIds: number[] = [];
    let rulesUpdated = 0;

    await db.transaction(async (trx) => {
      const inserted: Array<{ id: number }> = [];

      for (const tx of transactions) {
        const [row] = await trx('bank_transactions').insert({
          client_id: clientId,
          period_id: periodId ?? null,
          source_account_id: tx.sourceAccountId ?? sourceAccountId ?? null,
          transaction_date: tx.transactionDate,
          description: tx.description,
          amount: tx.amount,
          check_number: tx.checkNumber ?? null,
          account_id: tx.accountId,
          classification_status: 'manual',
          entry_source: 'manual',
          classified_by: req.user!.userId,
        }).returning('id');
        inserted.push(row);

        // Sync journal entry
        await syncTxJE(trx, row.id as number, clientId, req.user!.userId);

        // Create or reinforce classification rule
        if (tx.createRule !== false) {
          const existing = await trx('classification_rules')
            .where({ client_id: clientId, payee_pattern: tx.description.trim() })
            .first();
          await trx('classification_rules')
            .insert({
              client_id: clientId,
              payee_pattern: tx.description.trim(),
              account_id: tx.accountId,
              times_confirmed: 1,
            })
            .onConflict(['client_id', 'payee_pattern'])
            .merge({
              account_id: tx.accountId,
              times_confirmed: db.raw('classification_rules.times_confirmed + 1'),
              updated_at: db.fn.now(),
            });
          rulesUpdated++;
        }
      }

      createdIds = inserted.map((r) => r.id as number);
    });

    res.status(201).json({
      data: { created: createdIds.length, ids: createdIds, rulesUpdated },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// POST /api/v1/clients/:clientId/bank-transactions/batch-delete
const batchIdsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

btCollectionRouter.post('/batch-delete', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = batchIdsSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  try {
    await db.transaction(async (trx) => {
      const txs = await trx('bank_transactions')
        .where({ client_id: clientId })
        .whereIn('id', result.data.ids)
        .select('id', 'journal_entry_id', 'period_id');
      // Desktop sync: the rows' own periods, held or not (the JE check below
      // covers the entries' periods).
      await assertNotCheckedOut(trx, txs.map((t: { period_id: number | null }) => t.period_id));

      const jeIds = txs.map((t: { journal_entry_id: number | null }) => t.journal_entry_id).filter(Boolean) as number[];
      if (jeIds.length > 0) {
        // Any JE we are about to delete belongs to some period — every one of those
        // periods must be unlocked before we can mutate them. Lock in ascending
        // id order so this batch can't deadlock against another concurrent batch.
        const jePeriods = await trx('journal_entries')
          .whereIn('id', jeIds)
          .distinct('period_id');
        const periodIds = jePeriods
          .map((p: { period_id: number | null }) => p.period_id)
          .filter((p: number | null): p is number => typeof p === 'number')
          .sort((a: number, b: number) => a - b);
        for (const pid of periodIds) {
          await assertPeriodUnlocked(pid, trx);
        }
        await trx('journal_entry_lines').whereIn('journal_entry_id', jeIds).delete();
        await trx('journal_entries').whereIn('id', jeIds).delete();
      }
      await trx('bank_transactions').where({ client_id: clientId }).whereIn('id', result.data.ids).delete();
    });
    res.json({ data: { deleted: result.data.ids.length }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// POST /api/v1/clients/:clientId/bank-transactions/batch-classify
const batchClassifySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  accountId: z.number().int().positive(),
});

btCollectionRouter.post('/batch-classify', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = batchClassifySchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { ids, accountId } = result.data;
  try {
    await db.transaction(async (trx) => {
      await trx('bank_transactions')
        .where({ client_id: clientId })
        .whereIn('id', ids)
        .update({ account_id: accountId, classification_status: 'manual', classified_by: req.user!.userId });

      // Upsert classification rules for transactions that have a description
      const txsWithDesc = await trx('bank_transactions')
        .where({ client_id: clientId })
        .whereIn('id', ids)
        .whereNotNull('description')
        .select('id', 'description');

      for (const tx of txsWithDesc) {
        const pattern = (tx.description as string).trim();
        if (!pattern) continue;
        await trx('classification_rules')
          .insert({ client_id: clientId, payee_pattern: pattern, account_id: accountId, times_confirmed: 1 })
          .onConflict(['client_id', 'payee_pattern'])
          .merge({ account_id: accountId, times_confirmed: db.raw('classification_rules.times_confirmed + 1'), updated_at: db.fn.now() });
      }

      // Sync JE for ALL classified transactions (not just those with descriptions)
      for (const id of ids) {
        await syncTxJE(trx, id, clientId, req.user!.userId);
      }
    });

    res.json({ data: { updated: ids.length }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// POST /api/v1/clients/:clientId/bank-transactions/batch-update-source
const batchUpdateSourceSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  sourceAccountId: z.number().int().positive().nullable(),
});

btCollectionRouter.post('/batch-update-source', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = batchUpdateSourceSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { ids, sourceAccountId } = result.data;
  try {
    await db.transaction(async (trx) => {
      // Desktop sync: unclassified rows too, by their own period.
      await assertNotCheckedOut(trx, await trx('bank_transactions').where({ client_id: clientId }).whereIn('id', ids).pluck('period_id'));
      await trx('bank_transactions')
        .where({ client_id: clientId })
        .whereIn('id', ids)
        .update({ source_account_id: sourceAccountId });

      // Re-sync JEs for any transactions that already have a classification
      const classified = await trx('bank_transactions')
        .where({ client_id: clientId })
        .whereIn('id', ids)
        .whereNotNull('account_id')
        .select('id');

      for (const tx of classified) {
        await syncTxJE(trx, tx.id as number, clientId, req.user!.userId);
      }
    });
    res.json({ data: { updated: ids.length }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// POST /api/v1/clients/:clientId/bank-transactions/batch-confirm-ai
const batchConfirmAiSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

btCollectionRouter.post('/batch-confirm-ai', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = batchConfirmAiSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  try {
    // Only confirm transactions that have an AI suggestion and haven't been manually classified
    const eligible = await db('bank_transactions')
      .where({ client_id: clientId, classification_status: 'ai_suggested' })
      .whereIn('id', result.data.ids)
      .whereNotNull('ai_suggested_account_id')
      .select('id', 'ai_suggested_account_id', 'description');

    if (eligible.length === 0) {
      res.json({ data: { confirmed: 0 }, error: null });
      return;
    }

    let confirmed = 0;
    await db.transaction(async (trx) => {
      for (const tx of eligible) {
        await trx('bank_transactions')
          .where({ id: tx.id, client_id: clientId })
          .update({
            account_id: tx.ai_suggested_account_id,
            classification_status: 'confirmed',
            classified_by: req.user!.userId,
          });

        // Upsert classification rule
        const pattern = (tx.description as string | null)?.trim();
        if (pattern) {
          await trx('classification_rules')
            .insert({ client_id: clientId, payee_pattern: pattern, account_id: tx.ai_suggested_account_id, times_confirmed: 1 })
            .onConflict(['client_id', 'payee_pattern'])
            .merge({ account_id: tx.ai_suggested_account_id, times_confirmed: db.raw('classification_rules.times_confirmed + 1'), updated_at: db.fn.now() });
        }

        // Create journal entry
        await syncTxJE(trx, tx.id as number, clientId, req.user!.userId);
        confirmed++;
      }
    });

    res.json({ data: { confirmed }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// POST /api/v1/clients/:clientId/bank-transactions/ai-classify
const aiClassifySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

btCollectionRouter.post('/ai-classify', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  const result = aiClassifySchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  try {
    // Skip transactions already confirmed or manually classified — don't overwrite human decisions
    const transactions = await db('bank_transactions')
      .where({ client_id: clientId })
      .whereIn('id', result.data.ids)
      .whereNotIn('classification_status', ['confirmed', 'manual'])
      // Desktop sync: rows of a period a desktop holds are left alone.
      .where((w) => w.whereNull('period_id').orWhereNotIn('period_id', db('period_checkouts').whereNull('released_at').select('period_id')))
      .select('id', 'description', 'amount', 'transaction_date');

    if (transactions.length === 0) {
      res.json({ data: { classified: 0, results: [] }, error: null });
      return;
    }

    const accounts = await db('chart_of_accounts')
      .where({ client_id: clientId, is_active: true })
      .select('id', 'account_number', 'account_name', 'category')
      .orderBy('account_number');

    const rules = await db('classification_rules as r')
      .join('chart_of_accounts as c', 'r.account_id', 'c.id')
      .where('r.client_id', clientId)
      .select('r.payee_pattern', 'c.account_number', 'c.account_name', 'r.times_confirmed')
      .orderBy('r.times_confirmed', 'desc')
      .limit(50);

    interface AccountRow { id: number; account_number: string; account_name: string; category: string; }
    interface RuleRow { payee_pattern: string; account_number: string; account_name: string; }
    interface TxRow { id: number; description: string | null; amount: number; transaction_date: string; }

    const coaList = (accounts as AccountRow[]).map((a) =>
      `ID:${a.id} | ${a.account_number} - ${a.account_name} (${a.category})`
    ).join('\n');

    const rulesList = rules.length > 0
      ? (rules as RuleRow[]).map((r) => `"${r.payee_pattern}" → ${r.account_number} ${r.account_name}`).join('\n')
      : 'None yet';

    // Format amount with explicit debit/credit label so the model understands sign convention
    const txList = (transactions as TxRow[]).map((t) => {
      const cents = Number(t.amount);
      const dollars = Math.abs(cents) / 100;
      const flow = cents >= 0 ? 'CREDIT' : 'DEBIT';
      return `ID:${t.id} | ${t.transaction_date} | ${t.description ?? '(no description)'} | ${flow} $${dollars.toFixed(2)}`;
    }).join('\n');

    const prompt = `You are an accounting assistant. Classify each bank transaction to the single most appropriate GL account.

Sign convention: CREDIT = money into the bank account (positive amount), DEBIT = money out (negative amount).

CHART OF ACCOUNTS:
${coaList}

EXISTING CLASSIFICATION RULES (use these as strong hints):
${rulesList}

TRANSACTIONS TO CLASSIFY:
${txList}

Respond with a JSON array and nothing else. Each element: { "id": number, "accountId": number, "confidence": 0.0-1.0, "reasoning": string }`;

    const { provider, fastModel } = await getLLMProvider();
    const { result: aiResult, logId } = await aiComplete(
      provider,
      { model: fastModel, taskClass: TB_TASK_CLASSES.BANK_CLASSIFY, maxTokens: 8192, messages: [{ role: 'user', content: prompt }] },
      { endpoint: 'bank/classify', userId: req.user?.userId, userRole: req.user?.role, clientId },
    );

    const suggestions = extractJsonArray<{ id: number; accountId: number; confidence: number; reasoning: string }>(aiResult.text);
    if (!suggestions) {
      markAiUsageParseError(logId, `Invalid JSON array (finish=${aiResult.stopReason ?? 'unknown'}). text[0..500]=${JSON.stringify(aiResult.text.slice(0, 500))}`);
      res.status(500).json({ data: null, error: { code: 'AI_PARSE_ERROR', message: 'AI response did not contain a JSON array' } });
      return;
    }

    const accountIdSet = new Set((accounts as AccountRow[]).map((a) => a.id));
    let classified = 0;
    await db.transaction(async (trx) => {
      // A period checked out while the model was answering is skipped too.
      const rows = (await trx('bank_transactions').where({ client_id: clientId }).whereIn('id', suggestions.map((s) => s.id)).select('id', 'period_id')) as Array<{ id: number; period_id: number | null }>;
      const held = await lockAndListHeld(trx, rows.map((r) => r.period_id));
      const periodOf = new Map(rows.map((r) => [r.id, r.period_id]));
      for (const s of suggestions) {
        if (!accountIdSet.has(s.accountId)) continue;
        const pid = periodOf.get(s.id);
        if (pid && held.has(pid)) continue;
        await trx('bank_transactions')
          .where({ id: s.id, client_id: clientId })
          .update({
            ai_suggested_account_id: s.accountId,
            ai_confidence: Math.min(1, Math.max(0, Number(s.confidence))),
            classification_status: 'ai_suggested',
          });
        classified++;
      }
    });

    res.json({ data: { classified, results: suggestions }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// PATCH /api/v1/clients/:clientId/bank-transactions/:id
const classifySchema = z.object({
  accountId: z.number().int().positive().nullable().optional(),
  periodId: z.number().int().positive().nullable().optional(),
  classificationStatus: z.enum(['unclassified', 'ai_suggested', 'confirmed', 'manual']).optional(),
  description: z.string().max(500).nullable().optional(),
  // Manual-entry editable fields
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount: z.number().int().refine((v) => v !== 0, { message: 'Amount must be non-zero' }).optional(),
  sourceAccountId: z.number().int().positive().nullable().optional(),
  checkNumber: z.string().max(20).nullable().optional(),
});

btCollectionRouter.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  const id = Number(req.params.id);
  if (isNaN(clientId) || isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  const result = classifySchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (result.data.accountId !== undefined) updates.account_id = result.data.accountId;
  if (result.data.periodId !== undefined) updates.period_id = result.data.periodId;
  if (result.data.description !== undefined) updates.description = result.data.description;
  if (result.data.transactionDate !== undefined) updates.transaction_date = result.data.transactionDate;
  if (result.data.amount !== undefined) updates.amount = result.data.amount;
  if (result.data.sourceAccountId !== undefined) updates.source_account_id = result.data.sourceAccountId;
  if (result.data.checkNumber !== undefined) updates.check_number = result.data.checkNumber;
  if (result.data.classificationStatus !== undefined) {
    updates.classification_status = result.data.classificationStatus;
  } else if (result.data.accountId) {
    updates.classification_status = 'manual';
    updates.classified_by = req.user!.userId;
  }

  try {
    let finalRow: Record<string, unknown> | undefined;

    await db.transaction(async (trx) => {
      // Fetch existing transaction before update for reclassification audit
      const existingTx = await trx('bank_transactions').where({ id, client_id: clientId }).first();
      // Desktop sync: neither out of nor into a period a desktop holds.
      await assertNotCheckedOut(trx, [existingTx?.period_id, updates.period_id as number | null | undefined]);

      const updated = await trx('bank_transactions')
        .where({ id, client_id: clientId })
        .update(updates)
        .returning('*');

      if (updated.length === 0) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });

      finalRow = updated[0];

      // Upsert classification rule when manually confirming
      const status = updates.classification_status as string | undefined;
      if ((status === 'confirmed' || status === 'manual') && updates.account_id && finalRow!.description) {
        await trx('classification_rules')
          .insert({
            client_id: clientId,
            payee_pattern: (finalRow!.description as string).trim(),
            account_id: updates.account_id,
            times_confirmed: 1,
          })
          .onConflict(['client_id', 'payee_pattern'])
          .merge({
            account_id: updates.account_id,
            times_confirmed: db.raw('classification_rules.times_confirmed + 1'),
            updated_at: db.fn.now(),
          });
      }

      // Sync the auto-generated journal entry
      await syncTxJE(trx, id, clientId, req.user!.userId);
      // Re-fetch after JE sync so journal_entry_id is current
      finalRow = await trx('bank_transactions').where({ id }).first();

      // If transaction had a linked JE, log the reclassification
      const newAccountId = updates.account_id as number | undefined;
      if (existingTx?.journal_entry_id && newAccountId && existingTx?.account_id !== newAccountId) {
        await logAudit({
          userId: req.user!.userId,
          periodId: existingTx.period_id,
          entityType: 'bank_transaction',
          entityId: id,
          action: 'reclassify',
          description: `Bank transaction reclassified — linked JE #${existingTx.journal_entry_id} updated`,
        }, trx);
      }
    });

    if (!finalRow) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Transaction not found after update' } });
      return;
    }
    res.json({ data: finalRow, error: null });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Transaction not found' } });
      return;
    }
    sendServerError(res, err, 'bank-tx');
  }
});

// DELETE /api/v1/clients/:clientId/bank-transactions/:id
btCollectionRouter.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  const id = Number(req.params.id);
  if (isNaN(clientId) || isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  try {
    await db.transaction(async (trx) => {
      const tx = await trx('bank_transactions').where({ id, client_id: clientId }).first('journal_entry_id', 'period_id');
      if (!tx) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
      // Desktop sync: the row's own period (the JE check below covers the entry's).
      await assertNotCheckedOut(trx, [tx.period_id]);
      if (tx.journal_entry_id) {
        const existingJe = await trx('journal_entries').where({ id: tx.journal_entry_id }).first('period_id');
        if (existingJe?.period_id) {
          await assertPeriodUnlocked(existingJe.period_id as number, trx);
        }
        await trx('journal_entry_lines').where({ journal_entry_id: tx.journal_entry_id }).delete();
        await trx('journal_entries').where({ id: tx.journal_entry_id }).delete();
      }
      await trx('bank_transactions').where({ id, client_id: clientId }).delete();
    });
    res.json({ data: { deleted: 1 }, error: null });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Transaction not found' } });
      return;
    }
    sendServerError(res, err, 'bank-tx');
  }
});

// GET /api/v1/clients/:clientId/classification-rules
btRulesRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  try {
    const rules = await db('classification_rules as r')
      .join('chart_of_accounts as c', 'r.account_id', 'c.id')
      .where('r.client_id', clientId)
      .select('r.*', 'c.account_name', 'c.account_number')
      .orderBy('r.sort_order', 'asc')
      .orderBy('r.times_confirmed', 'desc');
    res.json({ data: rules, error: null, meta: { count: rules.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});

// DELETE /api/v1/clients/:clientId/classification-rules/:id
btRulesRouter.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  const id = Number(req.params.id);
  if (isNaN(clientId) || isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  try {
    const deleted = await db('classification_rules').where({ id, client_id: clientId }).delete();
    if (deleted === 0) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Rule not found' } });
      return;
    }
    res.json({ data: { deleted }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'bank-tx');
  }
});
