// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { assertPeriodUnlocked } from '../lib/periodGuard';
import { aiComplete, markAiUsageParseError } from '../lib/aiComplete';
import { getLLMProvider } from '../lib/aiClient';
import { TB_TASK_CLASSES } from '../lib/routerProvider';
import { extractJsonObject, extractJsonArray } from '../lib/aiJsonExtract';
import { sendServerError } from '../lib/safeError';
import { fillNewAccountType, inferAccountType, type StatementHint } from '../lib/accountTypeInference';
import { looksLikeTotalRow } from '../lib/importSkipRules';
import {
  BALANCES_EXPORT_FORMAT,
  detectBalancesExport,
  duplicatedQboIds,
  parsePnlFlag,
  parseQboAccountId,
  parseQboAccountName,
  type DetectedImportFormat,
  type PnlFlag,
} from '../lib/balancesExport';
import { parseAliases, applyAliasClaims, type AliasClaim } from '../lib/importAliases';
import { parseColumnMapping } from '../lib/csvColumnMapping';

// ── Excel → CSV conversion ──────────────────────────────────────────────────

const EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb'];

function isExcelFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return EXCEL_EXTENSIONS.includes(ext);
}

/**
 * Read an Excel buffer and convert the first worksheet to CSV text.
 * Preserves numbers as-is (no JS floating-point formatting issues) and
 * quotes fields that contain commas or quotes.
 */
async function excelBufferToCsv(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Excel file has no worksheets');

  // Determine the true column extent by scanning all rows.
  // sheet.columnCount and row.cellCount can both undercount in edge cases.
  let colCount = sheet.columnCount || 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-indexed sparse array; its length is the max col + 1
    const rowMax = Array.isArray(row.values) ? row.values.length - 1 : (row.cellCount || 0);
    if (rowMax > colCount) colCount = rowMax;
  });
  if (colCount === 0) colCount = 1;

  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let col = 1; col <= colCount; col++) {
      const cell = row.getCell(col);
      let val = '';
      if (cell.value !== null && cell.value !== undefined) {
        const v = cell.value as unknown;
        if (typeof v === 'object' && v !== null && 'result' in (v as Record<string, unknown>)) {
          // Formula cell — use the cached result
          val = String((v as { result: unknown }).result ?? '');
        } else if (v instanceof Date) {
          val = v.toISOString().slice(0, 10);
        } else {
          val = String(v);
        }
      }
      // CSV-escape
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      cells.push(val);
    }
    lines.push(cells.join(','));
  });
  return lines.join('\n');
}

export const csvImportRouter = Router();
csvImportRouter.use(authMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Types ────────────────────────────────────────────────────────────────────

export interface CsvMatchRow {
  csvRow: number;
  csvAccountNumber: string | null;
  csvAccountName: string | null;
  csvDebit: string | null;
  csvCredit: string | null;
  matchedAccountId: number | null;
  matchedAccountNumber: string | null;
  matchedAccountName: string | null;
  confidence: number;
  matchType: 'exact' | 'qbo_id' | 'exact_name' | 'fuzzy' | 'alias' | 'none';
  action: 'match' | 'create_new' | 'skip';
  debitCents: number;
  creditCents: number;
  // User-editable fields for create_new rows
  newCategory?: 'assets' | 'liabilities' | 'equity' | 'revenue' | 'expenses';
  newNormalBalance?: 'debit' | 'credit';
  // Carried from a recognised layout (see lib/balancesExport.ts); absent on
  // an ordinary file. `pnl` steers the type inference, the two QBO fields are
  // written onto the chart of accounts on confirm.
  pnl?: PnlFlag | null;
  qboAccountId?: string | null;
  qboAccountName?: string | null;
}

export interface CsvColumns {
  accountNumber: number | null;
  accountName: number | null;
  debit: number | null;
  credit: number | null;
  amount: number | null;
  // Only a recognised layout sets these; the model is never asked for them.
  pnl?: number | null;
  qboAccountName?: number | null;
  qboAccountId?: number | null;
}

export interface AiAnalysisResult {
  delimiter: string;
  hasHeaders: boolean;
  headerRow: number;
  dataStartRow: number;
  amountFormat: 'separate_dr_cr' | 'single_signed' | 'single_parentheses';
  columns: CsvColumns;
  rowsToSkip: number[];
  matches: CsvMatchRow[];
  /** Set when the header row named a known layout and the mapping is fixed, not guessed. */
  detectedFormat?: DetectedImportFormat | null;
}

/** The statement a row's P&L flag places it on, for the type inference. */
function statementHint(pnl: PnlFlag | null | undefined): StatementHint | null {
  return pnl === 'Y' ? 'pnl' : pnl === 'N' ? 'bs' : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────


// ── Amount parsing helpers ───────────────────────────────────────────────────

// Parse a dollars-and-cents string to integer cents using string arithmetic.
// `parseFloat('1.005') * 100 === 100.49999999999999` rounds the wrong direction —
// we take the 3rd fractional digit ≥5 as the half-up rule instead.
function parseAmountToCents(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  let s = String(raw).trim();
  if (s === '' || s === '-') return 0;
  let sign = 1;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { sign = -1; s = paren[1]; }
  s = s.replace(/[\s,$£€¥]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return 0;
  const [intPart = '0', fracRaw = ''] = s.split('.');
  let fracPart = fracRaw.slice(0, 2).padEnd(2, '0');
  let carry = 0;
  if (fracRaw.length >= 3 && fracRaw.charCodeAt(2) - 48 >= 5) {
    const bumped = Number(fracPart) + 1;
    if (bumped === 100) { fracPart = '00'; carry = 1; } else fracPart = String(bumped).padStart(2, '0');
  }
  let intFinal = intPart;
  if (carry) {
    const digits = intPart.split('').reverse();
    let c = 1;
    for (let i = 0; i < digits.length && c > 0; i++) {
      const n = Number(digits[i]) + c;
      digits[i] = String(n % 10);
      c = Math.floor(n / 10);
    }
    if (c > 0) digits.push(String(c));
    intFinal = digits.reverse().join('');
  }
  const cents = Number(`${intFinal}${fracPart}`);
  return isFinite(cents) ? sign * cents : 0;
}

// ── Fallback column detection (no AI) ───────────────────────────────────────

function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 5).join('\n');
  const commas = (sample.match(/,/g) || []).length;
  const tabs = (sample.match(/\t/g) || []).length;
  const semicolons = (sample.match(/;/g) || []).length;
  if (tabs >= commas && tabs >= semicolons) return '\t';
  if (semicolons > commas) return ';';
  return ',';
}

function splitCsvRow(line: string, delimiter: string): string[] {
  // Simple CSV split respecting quoted fields
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function buildFallbackColumnDetection(lines: string[], rawCsv: string): Omit<AiAnalysisResult, 'matches'> & { matches: CsvMatchRow[] } {
  const delimiter = detectDelimiter(lines);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) {
    return {
      delimiter,
      hasHeaders: false,
      headerRow: 0,
      dataStartRow: 0,
      amountFormat: 'separate_dr_cr',
      columns: { accountNumber: null, accountName: null, debit: null, credit: null, amount: null },
      rowsToSkip: [],
      matches: [],
    };
  }

  const firstRow = splitCsvRow(nonEmpty[0], delimiter);
  const colCount = firstRow.length;

  // Heuristic: the first row is a header if it contains column-label keywords
  // AND doesn't look like data. Require at least one amount-column keyword
  // (debit/credit/amount/balance) so that data rows with names like
  // "Accounts Receivable" aren't mistaken for headers.
  const LABEL_KEYWORDS = ['account', 'name', 'description', 'number', 'acct', 'no.'];
  const AMOUNT_KEYWORDS = ['debit', 'credit', 'amount', 'balance', 'dr', 'cr'];
  const hasLabelKeyword = firstRow.some((c) => LABEL_KEYWORDS.some((k) => c.toLowerCase().includes(k)));
  const hasAmountKeyword = firstRow.some((c) => AMOUNT_KEYWORDS.some((k) => c.toLowerCase() === k || c.toLowerCase().includes(k)));
  // A true header row should NOT contain numeric amounts in most cells
  const numericCells = firstRow.filter((c) => /^[\s$(-]*\d[\d,.]*[)\s]*$/.test(c.trim())).length;
  const looksLikeHeader = hasLabelKeyword && hasAmountKeyword && numericCells <= 1;

  let accountNumberCol: number | null = null;
  let accountNameCol: number | null = null;
  let debitCol: number | null = null;
  let creditCol: number | null = null;
  let amountCol: number | null = null;

  if (looksLikeHeader) {
    firstRow.forEach((h, i) => {
      const lower = h.toLowerCase();
      if ((lower.includes('account') && lower.includes('number')) || lower === 'acct #' || lower === 'acct#' || lower === 'no.' || lower === 'number') accountNumberCol = i;
      else if (lower.includes('account') || lower === 'name' || lower === 'description') accountNameCol = i;
      else if (lower.includes('debit') || lower === 'dr') debitCol = i;
      else if (lower.includes('credit') || lower === 'cr') creditCol = i;
      else if (lower.includes('amount') || lower.includes('balance')) amountCol = i;
    });
  }

  // Defaults if detection failed
  if (accountNumberCol === null && colCount >= 1) accountNumberCol = 0;
  if (accountNameCol === null && colCount >= 2) accountNameCol = 1;

  const amountFormat: 'separate_dr_cr' | 'single_signed' | 'single_parentheses' =
    debitCol !== null && creditCol !== null ? 'separate_dr_cr' :
    amountCol !== null ? 'single_signed' : 'separate_dr_cr';

  const dataStartRow = looksLikeHeader ? 1 : 0;

  return {
    delimiter,
    hasHeaders: looksLikeHeader,
    headerRow: looksLikeHeader ? 0 : -1,
    dataStartRow,
    amountFormat,
    columns: { accountNumber: accountNumberCol, accountName: accountNameCol, debit: debitCol, credit: creditCol, amount: amountCol },
    rowsToSkip: [],
    matches: [],
  };
}

/**
 * Deterministic row parser — EVERY non-blank line in the file becomes a row,
 * from the top of the file to EOF, using the detected column mapping.
 *
 * Nothing is dropped. A line that isn't an account — the header, a section
 * heading, a subtotal, a line the model flagged, a line the mapping can't read
 * — comes back with action 'skip' so the preview still draws it and the user
 * can tick it back in. Dropping those lines here is what made imports look like
 * they lost rows: a mis-flagged account never reached the screen at all, so
 * there was nothing to correct.
 */
export function parseAllRows(
  allLines: string[],
  columns: AiAnalysisResult['columns'],
  delimiter: string,
  dataStartRow: number,
  amountFormat: string,
  rowsToSkip: number[],
): CsvMatchRow[] {
  const skipSet = new Set(rowsToSkip);
  const matches: CsvMatchRow[] = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line.trim()) continue; // a truly empty line has nothing to show
    const cells = splitCsvRow(line, delimiter);

    const csvAccountNumber = columns.accountNumber !== null ? (cells[columns.accountNumber] ?? null) : null;
    const csvAccountName = columns.accountName !== null ? (cells[columns.accountName] ?? null) : null;

    // Not an account line: above the first data row, flagged by the model,
    // carrying no account name/number under this mapping, or a "Total…" line
    // carried down from the source report. Shown, not dropped.
    const isAccountLine = !!(csvAccountName?.trim() || csvAccountNumber?.trim());
    // The label lands in whichever column the report used — plenty of exports
    // write "Total Income" into the account-number column and leave the name
    // blank — so both are tested.
    const isTotalLine = looksLikeTotalRow(csvAccountName) || looksLikeTotalRow(csvAccountNumber);
    const skipped = i < dataStartRow || skipSet.has(i) || !isAccountLine || isTotalLine;

    let debitCents = 0;
    let creditCents = 0;

    if (amountFormat === 'separate_dr_cr') {
      debitCents = columns.debit !== null ? parseAmountToCents(cells[columns.debit]) : 0;
      creditCents = columns.credit !== null ? parseAmountToCents(cells[columns.credit]) : 0;
    } else {
      const raw = columns.amount !== null ? (cells[columns.amount] ?? '') : '';
      const amt = parseAmountToCents(raw);
      if (amt >= 0) debitCents = amt;
      else creditCents = Math.abs(amt);
    }

    const row: CsvMatchRow = {
      csvRow: i,
      csvAccountNumber,
      csvAccountName,
      csvDebit: columns.debit !== null ? (cells[columns.debit] ?? null) : null,
      csvCredit: columns.credit !== null ? (cells[columns.credit] ?? null) : null,
      matchedAccountId: null,
      matchedAccountNumber: null,
      matchedAccountName: null,
      confidence: 0,
      matchType: 'none',
      action: skipped ? 'skip' : 'create_new',
      debitCents,
      creditCents,
    };
    // Extra columns a recognised layout carries. Left off the row entirely
    // for an ordinary file so the preview's QuickBooks column stays hidden.
    if (columns.pnl !== undefined && columns.pnl !== null) row.pnl = parsePnlFlag(cells[columns.pnl]);
    if (columns.qboAccountId !== undefined && columns.qboAccountId !== null) row.qboAccountId = parseQboAccountId(cells[columns.qboAccountId]);
    if (columns.qboAccountName !== undefined && columns.qboAccountName !== null) row.qboAccountName = parseQboAccountName(cells[columns.qboAccountName]);
    matches.push(row);
  }

  return matches;
}

/**
 * Column mapping for a file whose header row names a known layout, or null.
 * Today that is the Balances export (lib/balancesExport.ts). The header is
 * the first non-blank line; the first data row follows it.
 */
export function detectKnownLayout(allLines: string[]): (Omit<AiAnalysisResult, 'matches'> & { detectedFormat: DetectedImportFormat }) | null {
  const headerIdx = allLines.findIndex((l) => l.trim().length > 0);
  if (headerIdx < 0) return null;
  const delimiter = detectDelimiter(allLines.slice(headerIdx));
  const cols = detectBalancesExport(splitCsvRow(allLines[headerIdx], delimiter));
  if (!cols) return null;
  return {
    delimiter,
    hasHeaders: true,
    headerRow: headerIdx,
    dataStartRow: headerIdx + 1,
    // adjusted_balance is one signed column: debit balances positive, credit
    // balances negative.
    amountFormat: 'single_signed',
    columns: {
      accountNumber: cols.accountNumber,
      accountName: cols.accountName,
      debit: null,
      credit: null,
      amount: cols.amount,
      pnl: cols.pnl,
      qboAccountName: cols.qboAccountName,
      qboAccountId: cols.qboAccountId,
    },
    rowsToSkip: [],
    detectedFormat: BALANCES_EXPORT_FORMAT,
  };
}

/** How many lines of the file the model is shown. */
const SAMPLE_LINES = 30;

/**
 * The model only ever sees the first SAMPLE_LINES lines, so a skip index past
 * the sample is a guess about a line it never read, and a negative or
 * fractional one is noise. Every row reaches the preview either way, but a
 * guessed skip still hands the user a real account with its box already
 * unticked — which reads exactly like the import dropped it.
 */
function sanitizeRowsToSkip(raw: unknown, sampleCount: number): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < sampleCount);
}

// ── POST /api/v1/import/csv/analyze ─────────────────────────────────────────

csvImportRouter.post(
  '/analyze',
  upload.single('file'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ data: null, error: { code: 'NO_FILE', message: 'No file uploaded' } });
        return;
      }

      const periodId = Number(req.body.periodId);
      const clientId = Number(req.body.clientId);
      if (isNaN(periodId) || isNaN(clientId)) {
        res.status(400).json({ data: null, error: { code: 'INVALID_PARAMS', message: 'periodId and clientId are required' } });
        return;
      }
      // A column mapping the user chose replaces the guess (lib/csvColumnMapping.ts).
      const userMapping = parseColumnMapping(req.body.columnMapping);
      if (userMapping && 'error' in userMapping) {
        res.status(400).json({ data: null, error: { code: 'INVALID_COLUMN_MAPPING', message: userMapping.error } });
        return;
      }

      // Read file content — convert Excel to CSV if needed
      let rawCsv: string;
      if (isExcelFile(req.file.originalname)) {
        rawCsv = await excelBufferToCsv(req.file.buffer);
      } else {
        rawCsv = req.file.buffer.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      }
      // Strip UTF-8 BOM. Excel-saved CSVs prepend \uFEFF to cell [0][0],
      // which broke account-number matching and every first-column TB import
      // created duplicate accounts.
      if (rawCsv.charCodeAt(0) === 0xFEFF) {
        rawCsv = rawCsv.slice(1);
      }
      const allLines = rawCsv.split('\n');
      const sampleLines = allLines.slice(0, SAMPLE_LINES);

      // Load client COA
      const coa = await db('chart_of_accounts')
        .where({ client_id: clientId, is_active: true })
        .select('id', 'account_number', 'account_name', 'category', 'normal_balance', 'import_aliases', 'qbo_account_id')
        .orderBy('account_number');

      type CoaRow = { id: number; account_number: string; account_name: string; category: string; normal_balance: string; import_aliases: unknown; qbo_account_id: string | null };
      const coaSummary = (coa as CoaRow[]).map((a) => {
        const aliases = parseAliases(a.import_aliases);
        const aliasStr = aliases.length > 0 ? aliases.join(',') : '';
        return `${a.id}|${a.account_number}|${a.account_name}|${a.category}|${a.normal_balance}|${aliasStr}`;
      }).join('\n');

      // The model is asked for the file's SHAPE, not its contents: every line is
      // parsed here and shown to the user, so a `matches` array in the reply
      // would be discarded. Asking for one anyway used to push the response
      // toward the token ceiling, and a truncated reply is unparseable JSON —
      // which drops the whole analysis into heuristic fallback, where a wrong
      // column guess makes real accounts read as blank lines.
      const numberedSample = sampleLines.map((l, i) => `${i}| ${l}`).join('\n');

      const prompt = `You are an expert accountant analyzing a CSV trial balance file.

Here are the first ${sampleLines.length} lines of the file${allLines.length > sampleLines.length ? ` (of ${allLines.length} — the rest follow the same layout)` : ''}. Each line is prefixed with its 0-based file line index and "| "; that prefix is NOT part of the data:
\`\`\`
${numberedSample}
\`\`\`

Here is the client's chart of accounts (format: id|account_number|account_name|category|normal_balance|import_aliases):
\`\`\`
${coaSummary || '(no accounts yet)'}
\`\`\`

You are NOT extracting the rows — every line of this file is parsed and shown to the user. Your job is to describe the file's shape so the parser reads every line correctly, and to name the few lines that are not accounts.

Return ONLY a valid JSON object (no prose, no markdown, no code fences) with this exact structure:
{
  "delimiter": ",",
  "hasHeaders": true,
  "headerRow": 0,
  "dataStartRow": 1,
  "amountFormat": "separate_dr_cr",
  "columns": {
    "accountNumber": 0,
    "accountName": 1,
    "debit": 2,
    "credit": 3,
    "amount": null
  },
  "rowsToSkip": []
}

Rules:
- delimiter: the character separating fields — "," ";" "|" or a tab
- headerRow: 0-based index of the header line, or -1 when the file has none
- dataStartRow: 0-based index of the FIRST line that is an account. Every line above it is left out of the import, so never point it past the first account.
- columns: 0-based indexes into a split line; null for a column this file does not have. accountNumber and accountName must be different columns. Pick the column that holds the account's own amount, not a running-balance or prior-year column.
- amountFormat: "separate_dr_cr" when debit and credit are separate columns, "single_signed" when one amount column uses a minus sign for credits, "single_parentheses" when one amount column wraps credits in parentheses
- rowsToSkip: 0-based indexes of lines that are NOT accounts — the header, section headings like "Income" or "Expenses", subtotal and total lines, and page furniture like a report title or a page number.

Before you answer, verify rowsToSkip line by line. Read back each index you listed and look at the line it names: if that line carries an account name or number together with its own amount, it is a real account — take the index out. Then read every remaining sample line in order and confirm each one is either an account the parser should import or an index you listed on purpose; no line may fall between the two. Every line you do not list is imported, so a line listed by mistake is exactly what makes rows go missing.

Only give indexes for lines shown above — the file may be longer, and you must not guess at lines you cannot see. Describe this file; do not repeat the example values above.`;

      // ── Step 1: Detect column mapping ─────────────────────────────────────
      // AI analyzes first 30 rows to detect delimiter, columns, and format.
      // We ONLY use the AI for column detection — row parsing is deterministic.
      let columnMapping: Omit<AiAnalysisResult, 'matches'>;
      let fallbackMode = false;

      // A layout we know by its header row needs no model: the mapping is
      // fixed, and a guess would risk importing the wrong balance column.
      const known = userMapping ?? detectKnownLayout(allLines);
      if (known) {
        columnMapping = known;
      } else try {
        const { provider, fastModel } = await getLLMProvider();
        const { result: aiResult, logId } = await aiComplete(
          provider,
          { model: fastModel, taskClass: TB_TASK_CLASSES.CSV_ANALYZE, maxTokens: 2048, messages: [{ role: 'user', content: prompt }] },
          { endpoint: 'csv/analyze', userId: req.user?.userId, userRole: req.user?.role, clientId, periodId },
        );

        const parsed = extractJsonObject<AiAnalysisResult>(aiResult.text);
        if (!parsed) {
          markAiUsageParseError(logId, `Invalid JSON (finish=${aiResult.stopReason ?? 'unknown'}). text[0..500]=${JSON.stringify(aiResult.text.slice(0, 500))}`);
          throw new Error('AI returned invalid format');
        }
        // Extract column mapping only — discard AI's matches
        columnMapping = {
          delimiter: parsed.delimiter,
          hasHeaders: parsed.hasHeaders,
          headerRow: parsed.headerRow,
          // Clamped to the sample: a dataStartRow past the lines the model read
          // would silently untick real accounts it never saw.
          dataStartRow: Math.min(
            parsed.hasHeaders ? Math.max(parsed.dataStartRow, 1) : 0,
            sampleLines.length,
          ),
          amountFormat: parsed.amountFormat,
          columns: parsed.columns,
          rowsToSkip: sanitizeRowsToSkip(parsed.rowsToSkip, sampleLines.length),
        };
      } catch (_aiErr) {
        // Fallback: heuristic column detection
        fallbackMode = true;
        columnMapping = buildFallbackColumnDetection(allLines, rawCsv);
      }

      // ── Step 2: Parse EVERY row deterministically ─────────────────────────
      // Single pass from dataStartRow to EOF using detected column indices.
      // No row limit, no multi-pass — processes the entire file in one sweep.
      const allMatches = parseAllRows(
        allLines,
        columnMapping.columns,
        columnMapping.delimiter,
        columnMapping.dataStartRow,
        columnMapping.amountFormat,
        columnMapping.rowsToSkip,
      );

      const nonBlankLines = allLines.filter((l) => l.trim()).length;
      const skippedRows = allMatches.filter((m) => m.action === 'skip').length;
      console.log(
        `[csv/analyze] Listed ${allMatches.length} of ${nonBlankLines} non-blank lines ` +
        `(${skippedRows} pre-skipped, dataStartRow=${columnMapping.dataStartRow}, fallback=${fallbackMode}, format=${columnMapping.detectedFormat ?? 'generic'})`,
      );
      if (allMatches.length !== nonBlankLines) {
        console.warn(`[csv/analyze] ROW SHORTFALL: ${nonBlankLines - allMatches.length} line(s) never reached the preview`);
      }

      // ── Step 3: Match ALL rows against COA ────────────────────────────────
      // Skipped rows are matched too but keep their action: the match is what
      // the row needs the moment the user ticks it back in.
      // A QuickBooks id the file carries (Balances export) places a row on
      // the account the connector already linked, even when the numbers
      // differ — but only an id that appears ONCE in the file: one on two
      // rows would land both on the same account and the second upsert would
      // overwrite the first.
      const dupQboIds = duplicatedQboIds(allMatches.map((m) => m.qboAccountId));
      const coaByQboId = new Map<string, CoaRow>();
      for (const a of coa as CoaRow[]) if (a.qbo_account_id) coaByQboId.set(a.qbo_account_id, a);
      for (const match of allMatches) {
        const keepSkipped = match.action === 'skip';
        // 1. Exact account number match
        if (match.csvAccountNumber?.trim()) {
          const numMatch = (coa as CoaRow[]).find((a) => a.account_number.trim() === match.csvAccountNumber!.trim());
          if (numMatch) {
            match.matchedAccountId = numMatch.id;
            match.matchedAccountNumber = numMatch.account_number;
            match.matchedAccountName = numMatch.account_name;
            match.confidence = 1.0;
            match.matchType = 'exact';
            if (!keepSkipped) match.action = 'match';
            continue;
          }
        }

        // 2. Stored QuickBooks id (unique in the file)
        if (match.qboAccountId && !dupQboIds.has(match.qboAccountId)) {
          const idMatch = coaByQboId.get(match.qboAccountId);
          if (idMatch) {
            match.matchedAccountId = idMatch.id;
            match.matchedAccountNumber = idMatch.account_number;
            match.matchedAccountName = idMatch.account_name;
            match.confidence = 0.9;
            match.matchType = 'qbo_id';
            if (!keepSkipped) match.action = 'match';
            continue;
          }
        }

        if (match.csvAccountName?.trim()) {
          const matchNameLower = match.csvAccountName.trim().toLowerCase();

          // 3. The account's OWN name, exactly. This tier used to be missing:
          // aliases were tried first and a real name only ever reached the
          // fuzzy tier at 0.55, so an alias on account B that happened to equal
          // account A's actual name took rows away from A.
          const nameExact = (coa as CoaRow[]).find((a) => a.account_name.trim().toLowerCase() === matchNameLower);
          if (nameExact) {
            match.matchedAccountId = nameExact.id;
            match.matchedAccountNumber = nameExact.account_number;
            match.matchedAccountName = nameExact.account_name;
            match.confidence = 0.98;
            match.matchType = 'exact_name';
            if (!keepSkipped) match.action = 'match';
            continue;
          }

          // 4. Alias exact match
          const aliasMatch = (coa as CoaRow[]).find((a) =>
            parseAliases(a.import_aliases).some((alias) => alias.toLowerCase() === matchNameLower)
          );
          if (aliasMatch) {
            match.matchedAccountId = aliasMatch.id;
            match.matchedAccountNumber = aliasMatch.account_number;
            match.matchedAccountName = aliasMatch.account_name;
            match.confidence = 0.95;
            match.matchType = 'alias';
            if (!keepSkipped) match.action = 'match';
            continue;
          }

          // 5. Fuzzy name match
          const nameMatch = (coa as CoaRow[]).find((a) => {
            const coaLower = a.account_name.toLowerCase();
            return coaLower === matchNameLower || coaLower.includes(matchNameLower) || matchNameLower.includes(coaLower);
          });
          if (nameMatch) {
            match.matchedAccountId = nameMatch.id;
            match.matchedAccountNumber = nameMatch.account_number;
            match.matchedAccountName = nameMatch.account_name;
            match.confidence = 0.55;
            match.matchType = 'fuzzy';
            if (!keepSkipped) match.action = 'match';
          }
        }
      }

      // ── Step 4: Decide the type of every would-be new account NOW ────────
      // The preview shows these values and the confirm writes them. Leaving
      // them blank made the dropdown show a placeholder while the confirm
      // inferred something else from the account number.
      for (const match of allMatches) {
        fillNewAccountType(match, match.csvAccountNumber, match.csvAccountName, statementHint(match.pnl));
      }

      const analysisResult: AiAnalysisResult = { detectedFormat: null, ...columnMapping, matches: allMatches };

      res.json({
        data: {
          ...analysisResult,
          fallbackMode,
          totalRows: nonBlankLines,
          rawPreview: sampleLines,
        },
        error: null,
      });
    } catch (err: unknown) {
      sendServerError(res, err, 'csv-import');
    }
  }
);

// ── POST /api/v1/import/csv/suggest-numbers ──────────────────────────────────

// A trial balance with no account-number column needs a number for EVERY row,
// and that used to go out as ONE model call sized at rows × 150 tokens. For a
// 400-account file that asks for ~60k output tokens: past the model's output
// ceiling, and minutes of wall clock — long enough for the proxy in front of
// the AI router to give up and hand back a 524 before the server ever answered.
//
// So the work is split two ways. Here, rows are assigned in small batches with
// the numbers chosen so far fed forward, so each model call stays short and
// later batches still avoid earlier ones. And the caller pages through the rows
// as well (SUGGEST_CHUNK_SIZE in CsvImportDialog), handing back the numbers it
// already holds as `reservedNumbers` — that keeps any ONE request short no
// matter how big the file is, which is what the proxy actually cares about.
const SUGGEST_BATCH_SIZE = 25;
const SUGGEST_MAX_TOKENS = 8000;

csvImportRouter.post('/suggest-numbers', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { clientId, matches, reservedNumbers } = req.body as {
      clientId: number;
      matches: CsvMatchRow[];
      reservedNumbers?: string[];
    };

    if (!clientId || !Array.isArray(matches)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_PARAMS', message: 'clientId and matches are required' } });
      return;
    }

    // Load existing account numbers to avoid conflicts
    const existing = await db('chart_of_accounts')
      .where({ client_id: clientId, is_active: true })
      .select('account_number', 'account_name', 'category');
    const existingNumbers = new Set(existing.map((a: { account_number: string }) => a.account_number));
    // Numbers the caller was already handed for earlier chunks of this same
    // import — not in the COA yet, but spoken for.
    for (const n of Array.isArray(reservedNumbers) ? reservedNumbers : []) {
      const clean = String(n).replace(/[^0-9]/g, '');
      if (clean) existingNumbers.add(clean);
    }

    // Only process rows that need numbers (no csvAccountNumber)
    const needNumbers = matches.filter((m) => m.action !== 'skip' && (!m.csvAccountNumber || m.csvAccountNumber.trim() === ''));

    if (needNumbers.length === 0) {
      res.json({ data: { suggestions: [] }, error: null });
      return;
    }

    const existingList = existing.map((a: { account_number: string; account_name: string; category: string }) =>
      `${a.account_number} — ${a.account_name} (${a.category})`
    ).join('\n');

    const buildPrompt = (batch: CsvMatchRow[], alsoAvoid: string[]): string => {
    const accountList = batch.map((m) =>
      `csvRow ${m.csvRow}: "${m.csvAccountName ?? 'Unknown'}"${m.newCategory ? ` [category hint: ${m.newCategory}]` : ''}`
    ).join('\n');

    return `You are an expert accountant. Assign standard chart of accounts numbers to these accounts.

Standard numbering conventions:
- 1000-1999: Assets (1000-1099 cash/bank, 1100-1199 receivables, 1200-1299 inventory, 1300-1499 prepaid/other current, 1500-1999 fixed assets)
- 2000-2999: Liabilities (2000-2099 accounts payable, 2100-2199 accrued liabilities, 2200-2499 other current, 2500-2999 long-term debt)
- 3000-3999: Equity (3000-3099 contributed capital/paid-in, 3900-3999 retained earnings/distributions)
- 4000-4999: Revenue / income
- 5000-5999: Cost of goods sold / direct costs
- 6000-7999: Operating expenses (6000-6999 general & admin, 7000-7999 other operating)
- 8000-8999: Other income/expense, interest, taxes

Existing account numbers already in use (avoid conflicts):
${existingList || '(none)'}
${alsoAvoid.length > 0 ? `\nAlso already assigned earlier in this same import (avoid these too):\n${alsoAvoid.join(', ')}\n` : ''}

Accounts that need numbers:
${accountList}

Assign numbers with gaps of 10-50 between consecutive entries to allow future insertions. Infer the category and normal balance from the account name if no hint is provided.

Return ONLY a valid JSON array (no prose, no markdown fences). Use the EXACT csvRow numbers shown above. Include the accountName field:
[
  { "csvRow": 0, "accountName": "Cash", "suggestedNumber": "1000", "suggestedCategory": "assets", "suggestedNormalBalance": "debit" }
]`;
    };

    type SuggestionRaw = { csvRow: number; accountName?: string; suggestedNumber: string; suggestedCategory: string; suggestedNormalBalance: string };

    const { provider, fastModel } = await getLLMProvider();
    const rawSuggestions: SuggestionRaw[] = [];
    const assignedSoFar: string[] = [];
    let batchFailures = 0;

    for (let i = 0; i < needNumbers.length; i += SUGGEST_BATCH_SIZE) {
      const batch = needNumbers.slice(i, i + SUGGEST_BATCH_SIZE);
      const batchNo = Math.floor(i / SUGGEST_BATCH_SIZE) + 1;
      const { result: aiResult2, logId: suggestLogId } = await aiComplete(
        provider,
        {
          model: fastModel,
          taskClass: TB_TASK_CLASSES.ACCOUNT_NUMBERING,
          // Clamped: an unbounded rows × 150 can exceed the model's own output
          // ceiling and fail the call outright.
          maxTokens: Math.min(SUGGEST_MAX_TOKENS, Math.max(2048, batch.length * 150)),
          messages: [{ role: 'user', content: buildPrompt(batch, assignedSoFar) }],
        },
        { endpoint: 'csv/suggest-numbers', userId: req.user?.userId, userRole: req.user?.role, clientId },
      );

      const parsed = extractJsonArray<SuggestionRaw>(aiResult2.text);
      if (!parsed) {
        const detail = `finish=${aiResult2.stopReason ?? 'unknown'}, text[0..500]=${JSON.stringify(aiResult2.text.slice(0, 500))}`;
        console.error(`[csv/suggest-numbers] Batch ${batchNo} failed to parse:`, detail);
        markAiUsageParseError(suggestLogId, `Batch ${batchNo} invalid JSON. ${detail}`);
        // One bad batch shouldn't sink the run — those rows come back without
        // a suggestion and the user fills them in by hand.
        batchFailures++;
        continue;
      }
      rawSuggestions.push(...parsed);
      for (const sug of parsed) {
        const clean = String(sug.suggestedNumber ?? '').replace(/[^0-9]/g, '');
        if (clean) assignedSoFar.push(clean);
      }
    }

    if (rawSuggestions.length === 0 && batchFailures > 0) {
      res.status(500).json({ data: null, error: { code: 'PARSE_ERROR', message: 'AI returned unexpected format' } });
      return;
    }

    // Deduplicate: if AI produced collisions within its own suggestions, increment by 1
    // Sanitize to digits-only, max 20 chars (DB column is varchar(20))
    const usedNumbers = new Set(existingNumbers);
    const suggestions = rawSuggestions.map((s) => {
      let num = s.suggestedNumber.replace(/[^0-9]/g, '').slice(0, 20) || '9999';
      while (usedNumbers.has(num)) {
        num = String(parseInt(num, 10) + 1);
      }
      usedNumbers.add(num);
      // Match by csvRow; fall back to name matching if AI returned wrong row numbers
      const sourceMatch = needNumbers.find((m) => m.csvRow === s.csvRow)
        ?? (s.accountName ? needNumbers.find((m) => m.csvAccountName?.toLowerCase() === s.accountName!.toLowerCase()) : undefined);
      const cat = s.suggestedCategory?.toLowerCase().trim();
      const validCat = ['assets', 'liabilities', 'equity', 'revenue', 'expenses'].includes(cat) ? cat : 'expenses';
      const nb = s.suggestedNormalBalance?.toLowerCase().trim();
      const validNb = nb === 'credit' ? 'credit' : 'debit';
      return {
        csvRow: sourceMatch?.csvRow ?? s.csvRow,
        csvAccountName: sourceMatch?.csvAccountName ?? s.accountName ?? null,
        suggestedNumber: num,
        suggestedCategory: validCat as 'assets' | 'liabilities' | 'equity' | 'revenue' | 'expenses',
        suggestedNormalBalance: validNb as 'debit' | 'credit',
      };
    });

    res.json({ data: { suggestions }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'csv-import');
  }
});

// ── POST /api/v1/import/csv/chat ─────────────────────────────────────────────

csvImportRouter.post('/chat', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { rawPreview, analysis, messages, userMessage, clientId } = req.body as {
      rawPreview: string[];
      analysis: AiAnalysisResult & { fallbackMode?: boolean; totalRows?: number };
      messages: { role: 'user' | 'assistant'; content: string }[];
      userMessage: string;
      clientId: number;
    };

    if (!userMessage || !analysis) {
      res.status(400).json({ data: null, error: { code: 'INVALID_PARAMS', message: 'userMessage and analysis are required' } });
      return;
    }

    // Load COA for context
    const coa = await db('chart_of_accounts')
      .where({ client_id: clientId, is_active: true })
      .select('id', 'account_number', 'account_name', 'category', 'import_aliases')
      .orderBy('account_number');
    const coaSummary = coa.map((a: { id: number; account_number: string; account_name: string; category: string; import_aliases: unknown }) => {
      const aliases = parseAliases(a.import_aliases);
      const aliasStr = aliases.length > 0 ? aliases.join(',') : '';
      return `${a.id}|${a.account_number}|${a.account_name}|${a.category}|${aliasStr}`;
    }).join('\n');

    const systemPrompt = `You are an expert accountant assistant helping review a CSV trial balance import.

Raw CSV preview (first 30 rows):
\`\`\`
${(rawPreview ?? []).join('\n')}
\`\`\`

Current analysis result:
\`\`\`json
${JSON.stringify(analysis, null, 2)}
\`\`\`

Client's chart of accounts (id|account_number|account_name|category):
\`\`\`
${coaSummary || '(no accounts yet)'}
\`\`\`

You are in a conversation with the accountant reviewing this import. Your job is to:
1. Explain what was found in plain language
2. Answer questions about specific rows, account matching, column detection, or amounts
3. If the user asks to correct the analysis (e.g., "column 2 is the debit, not column 3" or "row 5 should be skipped"), produce a corrected analysis

Respond ONLY with a valid JSON object (no prose, no markdown fences):
{
  "reply": "your helpful response in plain text (use \\n for line breaks)",
  "revisedAnalysis": null
}

If the user requests corrections to the column mapping, account matching, or row actions, set revisedAnalysis to a complete corrected analysis object using the same structure as the current analysis. Preserve all existing matches but apply the requested corrections. Otherwise set revisedAnalysis to null.`;

    const aiMessages = [
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];

    const { provider, fastModel } = await getLLMProvider();
    const { result: aiResult3, logId: chatLogId } = await aiComplete(
      provider,
      { model: fastModel, taskClass: TB_TASK_CLASSES.IMPORT_CHAT, maxTokens: 2048, system: systemPrompt, messages: aiMessages },
      { endpoint: 'csv/chat', userId: req.user?.userId, userRole: req.user?.role, clientId },
    );

    const parsed = extractJsonObject<{ reply: string; revisedAnalysis: AiAnalysisResult | null }>(aiResult3.text);
    if (!parsed) {
      markAiUsageParseError(chatLogId, `Chat reply not valid JSON; passed through raw text (finish=${aiResult3.stopReason ?? 'unknown'}).`);
      res.json({ data: { reply: aiResult3.text.trim(), revisedAnalysis: null }, error: null });
      return;
    }
    // The client replaces its matches with these wholesale, and the model
    // rarely echoes newCategory/newNormalBalance back — refill them so the
    // preview keeps showing the type the confirm will write.
    // The carried columns (P&L flag, QuickBooks id/name) are ours, not the
    // model's: put them back by file row so a chat correction cannot lose
    // them, then refill the type with the same hint the preview used.
    const carried = new Map<number, CsvMatchRow>((analysis.matches ?? []).map((m) => [m.csvRow, m]));
    for (const m of parsed.revisedAnalysis?.matches ?? []) {
      const src = carried.get(m.csvRow);
      if (src) {
        if (src.pnl !== undefined) m.pnl = src.pnl;
        if (src.qboAccountId !== undefined) m.qboAccountId = src.qboAccountId;
        if (src.qboAccountName !== undefined) m.qboAccountName = src.qboAccountName;
      }
      fillNewAccountType(m, m.csvAccountNumber, m.csvAccountName, statementHint(m.pnl));
    }
    if (parsed.revisedAnalysis && analysis.detectedFormat !== undefined) parsed.revisedAnalysis.detectedFormat = analysis.detectedFormat;
    res.json({ data: parsed, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'csv-import');
  }
});

// ── POST /api/v1/import/csv/confirm ─────────────────────────────────────────

csvImportRouter.post('/confirm', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { periodId, clientId, matches, aiExtraction } = req.body as {
      periodId: number;
      clientId: number;
      matches: CsvMatchRow[];
      aiExtraction: unknown;
    };

    if (!periodId || !clientId || !Array.isArray(matches)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_PARAMS', message: 'periodId, clientId, and matches are required' } });
      return;
    }

    // Check period exists and belongs to client
    const period = await db('periods').where({ id: periodId, client_id: clientId }).first();
    if (!period) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }

    // Note: the definitive lock check happens inside the transaction below via
    // assertPeriodUnlocked + SELECT FOR UPDATE. A pre-check here would be a
    // TOCTOU race with a concurrent period lock, so we skip it.

    // Pre-load existing COA accounts to avoid try/catch inside transaction
    const existingCoa = (await db('chart_of_accounts')
      .where({ client_id: clientId, is_active: true })
      .select('id', 'account_number', 'qbo_account_id')) as Array<{ id: number; account_number: string; qbo_account_id: string | null }>;
    const existingByNumber = new Map<string, number>(
      existingCoa.map((a) => [a.account_number.trim(), a.id])
    );
    // QuickBooks links the file carries (Balances export). An id that is on
    // two rows of the file, or already held by a different account of this
    // client, is not written — a CSV is not the place to re-point a link the
    // connector made — and the reviewer is told which ones were left alone.
    const qboHolder = new Map<string, number>();
    for (const a of existingCoa) if (a.qbo_account_id) qboHolder.set(a.qbo_account_id, a.id);
    const dupQboIds = duplicatedQboIds(matches.filter((m) => m.action !== 'skip').map((m) => m.qboAccountId));
    const qboWarnings: string[] = [];
    for (const id of dupQboIds) {
      const rows = matches.filter((m) => m.action !== 'skip' && m.qboAccountId === id).map((m) => m.csvAccountNumber ?? `row ${m.csvRow + 1}`);
      qboWarnings.push(`QuickBooks id ${id} is on ${rows.length} rows (${rows.join(', ')}); it was not linked to any of them.`);
    }
    // Cross-client safety: reject any matchedAccountId that doesn't belong to
    // this client. See pdfImport.ts for the same rationale — chart_of_accounts
    // has a global PK, so an AI-hallucinated id could otherwise write TB rows
    // into another client's account.
    const validAccountIds = new Set<number>(existingCoa.map((a: { id: number }) => a.id));
    for (const m of matches) {
      if (m.action !== 'skip' && m.matchedAccountId !== null && m.matchedAccountId !== undefined) {
        if (!validAccountIds.has(m.matchedAccountId)) {
          res.status(422).json({
            data: null,
            error: {
              code: 'INVALID_ACCOUNT_ID',
              message: `Match references account ${m.matchedAccountId} which does not belong to this client. Re-run analysis.`,
            },
          });
          return;
        }
      }
    }

    // Detect account number collisions among create_new rows before starting transaction
    const createNewRows = matches.filter((m) => m.action === 'create_new' && m.csvAccountNumber?.trim());
    const seenNumbers = new Map<string, string>();
    for (const m of createNewRows) {
      const num = m.csvAccountNumber!.trim();
      if (seenNumbers.has(num)) {
        res.status(422).json({ data: null, error: { code: 'DUPLICATE_ACCOUNT_NUMBER', message: `Account number "${num}" appears more than once in the import. Each account number must be unique.` } });
        return;
      }
      seenNumbers.set(num, m.csvAccountName ?? '');
    }

    // Wrap all writes in a single transaction — all succeed or all roll back
    const stats = await db.transaction(async (trx) => {
      // Serialize against concurrent period-lock / roll-forward writers and
      // assert the period isn't locked as of the moment we start inserting.
      await trx.raw('SELECT id FROM periods WHERE id = ? FOR UPDATE', [periodId]);
      await assertPeriodUnlocked(periodId, trx);

      let accountsCreated = 0;
      let accountsMatched = 0;
      let rowsImported = 0;
      let rowsSkipped = 0;
      let qboIdsLinked = 0;

      // Write the file's QuickBooks id/name onto the account the row landed
      // in. The name is always refreshed (it is descriptive, and the connector
      // only ever matches it when unique); the id only when nothing stands in
      // its way.
      const stampQbo = async (accountId: number, match: CsvMatchRow): Promise<void> => {
        const patch: Record<string, unknown> = {};
        if (match.qboAccountName) patch.qbo_account_name = match.qboAccountName;
        const id = match.qboAccountId ?? null;
        if (id && !dupQboIds.has(id)) {
          const holder = qboHolder.get(id);
          if (holder !== undefined && holder !== accountId) {
            const other = existingCoa.find((a) => a.id === holder);
            qboWarnings.push(`QuickBooks id ${id} (${match.csvAccountNumber ?? `row ${match.csvRow + 1}`}) is already linked to account ${other?.account_number ?? holder}; left as is.`);
          } else if (holder === undefined) {
            patch.qbo_account_id = id;
            qboHolder.set(id, accountId);
            qboIdsLinked++;
          }
        }
        if (Object.keys(patch).length === 0) return;
        await trx('chart_of_accounts').where({ id: accountId, client_id: clientId }).update({ ...patch, updated_at: trx.fn.now() });
      };
      // Track which matched accounts need their alias list updated
      const aliasClaims: AliasClaim[] = [];

      for (const match of matches) {
        if (match.action === 'skip') { rowsSkipped++; continue; }

        let accountId = match.matchedAccountId;

        if (match.action === 'create_new' || (match.action === 'match' && !accountId)) {
          if (!match.csvAccountName) { rowsSkipped++; continue; }

          const rawNum = (match as { newAccountNumber?: string }).newAccountNumber?.trim() || match.csvAccountNumber?.trim() || null;
          // Sanitize: strip non-alphanumeric, enforce varchar(20) limit
          const accountNum = rawNum ? rawNum.replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 20) : null;

          // If the account number already exists in COA, use that account (implicit match)
          if (accountNum && existingByNumber.has(accountNum)) {
            accountId = existingByNumber.get(accountNum)!;
            accountsMatched++;
            // "Create new" that lands on an existing number is a match in all
            // but name, and the file's name is exactly what the next import
            // will arrive with — so it earns an alias like any other match.
            aliasClaims.push({ accountId, name: match.csvAccountName.trim() });
          } else {
            // The analyze step already decided these and the preview showed
            // them; the fallback only covers a body assembled without it
            // (an older client, or the chat's revisedAnalysis) and MUST use
            // the same inference so it cannot disagree with the preview.
            const inferred = inferAccountType(accountNum, match.csvAccountName, statementHint(match.pnl));
            const category: string = match.newCategory ?? inferred.category;
            const normalBalance: string = match.newNormalBalance ?? inferred.normalBalance;

            const finalNum = accountNum || `IMP${Date.now().toString(36).slice(-6).toUpperCase()}`;
            const [newAccount] = await trx('chart_of_accounts')
              .insert({
                client_id: clientId,
                account_number: finalNum,
                account_name: match.csvAccountName,
                category,
                normal_balance: normalBalance,
                is_active: true,
              })
              .returning('id');
            accountId = newAccount.id;
            existingByNumber.set(finalNum, newAccount.id);
            accountsCreated++;
          }
        } else {
          accountsMatched++;
          // Queue alias update for matched rows
          if (accountId && match.csvAccountName?.trim()) {
            aliasClaims.push({ accountId, name: match.csvAccountName.trim() });
          }
        }

        if (!accountId) { rowsSkipped++; continue; }

        if (match.qboAccountId || match.qboAccountName) await stampQbo(accountId, match);

        await trx('trial_balance')
          .insert({
            period_id: periodId,
            account_id: accountId,
            unadjusted_debit: match.debitCents,
            unadjusted_credit: match.creditCents,
            updated_by: req.user!.userId,
            updated_at: db.fn.now(),
          })
          .onConflict(['period_id', 'account_id'])
          .merge(['unadjusted_debit', 'unadjusted_credit', 'updated_by', 'updated_at']);

        rowsImported++;
      }

      // Apply alias updates — add import name as alias for matched accounts where name differs
      // One text means one account: applyAliasClaims grants each alias to the
      // account the row imported into and strips it from whoever held it, so a
      // correction made in the preview is not undone by the next import.
      await applyAliasClaims(trx, clientId, aliasClaims);
      await trx('document_imports').insert({
        client_id: clientId,
        period_id: periodId,
        import_type: 'csv',
        document_type: 'trial_balance',
        status: 'confirmed',
        ai_extraction: JSON.stringify(aiExtraction ?? null),
        imported_by: req.user!.userId,
        imported_at: db.fn.now(),
      });

      return { accountsMatched, accountsCreated, rowsImported, rowsSkipped, qboIdsLinked };
    });

    res.json({
      data: {
        ...stats,
        accountsWithoutTaxCodes: stats.accountsCreated,
        total: matches.length,
        qboWarnings,
      },
      error: null,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked' } });
      return;
    }
    sendServerError(res, err, 'csv-import');
  }
});
