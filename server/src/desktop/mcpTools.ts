// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Claude Desktop's tools beyond upstream's 18 (P10b, owner 2026-11-20, Q105):
// every area of the app. Each tool calls the engine's own routes through the
// MCP process's private API (desktop/mcp.ts), never the database, so period
// locks, check-outs, validation and the engine's own totals apply exactly as
// they do on the app's screens. Amounts go in and come out as the engine's
// integer cents. Not offered here (owner): deleting a client or a period,
// settings, AI keys and the firm server.

type Json = Record<string, unknown>;

/** The engine's answer: its `{ data, error }` envelope and the HTTP status. */
export interface ApiAnswer {
  status: number;
  data: unknown;
  error: { code?: string; message?: string } | null;
  /** Paging and counts, when the route sends them. */
  meta?: unknown;
}

/** How a tool reaches the engine. */
export interface ToolContext {
  call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiAnswer>;
  /** The raw answer, for files and form uploads (the private API, its token added). */
  fetch?(path: string, init: RequestInit): Promise<Response>;
}

/** What a tool answers Claude. */
export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** A tool as `tools/list` shows it, and its handler. */
export interface DesktopTool {
  name: string;
  /** Upstream's tool of this name is broken on the desktop: this one replaces it. */
  replacesUpstream?: boolean;
  /** Only reads (nothing changes): not written to the audit trail. */
  reads?: boolean;
  description: string;
  inputSchema: Json;
  run(ctx: ToolContext, args: Json): Promise<ToolResult>;
}

/** A refusal or bad input, said to Claude in words. */
export class ToolError extends Error {}

const ok = (data: unknown): ToolResult => ({ text: JSON.stringify(data, null, 2) });

function num(args: Json, key: string, required = true): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${key} is required.`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ToolError(`${key} must be a whole number.`);
  return n;
}

function str(args: Json, key: string, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${key} is required.`);
    return undefined;
  }
  return String(v);
}

/** The engine's data, or its refusal as a ToolError in its own words. */
async function expect(ctx: ToolContext, method: Parameters<ToolContext['call']>[0], path: string, body?: unknown): Promise<unknown> {
  const a = await ctx.call(method, path, body);
  if (a.error || a.status >= 400) {
    const why = a.error?.message ?? `the engine answered ${a.status}`;
    throw new ToolError(a.error?.code ? `${why} (${a.error.code})` : why);
  }
  return a.data;
}

/** A list the engine sent as an array, or as `{ rows }` / `{ data }`. */
function rowsOf(data: unknown): Json[] {
  if (Array.isArray(data)) return data as Json[];
  if (data && typeof data === 'object') {
    for (const k of ['rows', 'transactions', 'items', 'data']) {
      const v = (data as Json)[k];
      if (Array.isArray(v)) return v as Json[];
    }
  }
  return [];
}

/** A DATE as `YYYY-MM-DD`, whether the engine sent text or an ISO time (the desktop engine runs on UTC). */
export function dayOf(v: unknown): string {
  return String(v ?? '').slice(0, 10);
}

// ---------------------------------------------------------------- tax codes

const listTaxCodes: DesktopTool = {
  name: 'list_tax_codes',
  reads: true,
  description:
    "The tax codes a client's return can use (its return form and activity), with each code's id, which confirm_tax_assignments and the account tools need. Optional search narrows by code or description words.",
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'number', description: 'The client ID' },
      search: { type: 'string', description: 'Optional words or a code number to narrow the list' },
    },
    required: ['clientId'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    const search = str(args, 'search', false)?.toLowerCase();
    const codes = rowsOf(await expect(ctx, 'GET', `/api/v1/tax-codes/available?clientId=${clientId}`));
    const words = search ? search.split(/\s+/).filter(Boolean) : [];
    const shown = codes.filter((c) => {
      if (words.length === 0) return true;
      const text = `${c.tax_code ?? c.code ?? ''} ${c.description ?? ''} ${c.form_line ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    return ok({ count: shown.length, codes: shown });
  },
};

// ---------------------------------------------------------------- bank transactions

const STATUSES = ['unclassified', 'ai_suggested', 'confirmed', 'manual'];

const listBankTransactions: DesktopTool = {
  name: 'list_bank_transactions',
  reads: true,
  description:
    "A client's bank transactions, newest first: date, description, amount in cents (positive money in, negative money out), check number, bank account (source_account_id), category account (account_id), period and status. Filter by period, bank account and status (unclassified, ai_suggested, confirmed, manual). Pages of up to 500.",
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'number', description: 'The client ID' },
      periodId: { type: 'number', description: 'Optional: only this period' },
      bankAccountId: { type: 'number', description: 'Optional: only this bank account (a chart of accounts id)' },
      status: { type: 'string', enum: STATUSES, description: 'Optional: only rows with this status' },
      page: { type: 'number', description: 'Page, from 1' },
      pageSize: { type: 'number', description: 'Rows per page, 10 to 500 (default 100)' },
    },
    required: ['clientId'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    const q = new URLSearchParams();
    const periodId = num(args, 'periodId', false);
    const bank = num(args, 'bankAccountId', false);
    const status = str(args, 'status', false);
    if (status && !STATUSES.includes(status)) throw new ToolError(`status must be one of ${STATUSES.join(', ')}.`);
    if (periodId !== undefined) q.set('periodId', String(periodId));
    if (bank !== undefined) q.set('sourceAccountId', String(bank));
    if (status) q.set('status', status);
    q.set('page', String(num(args, 'page', false) ?? 1));
    q.set('pageSize', String(num(args, 'pageSize', false) ?? 100));
    const a = await ctx.call('GET', `/api/v1/clients/${clientId}/bank-transactions?${q}`);
    if (a.error || a.status >= 400) throw new ToolError(a.error?.message ?? `the engine answered ${a.status}`);
    return ok({ rows: rowsOf(a.data), meta: a.meta });
  },
};

/** One statement row as Claude sends it. */
interface InRow {
  date: string;
  description: string;
  amountCents: number;
  checkNumber?: string | null;
  accountId?: number | null;
}

function readRows(v: unknown): InRow[] {
  if (!Array.isArray(v) || v.length === 0) throw new ToolError('transactions must be a list of at least one row.');
  if (v.length > 2000) throw new ToolError('Send at most 2,000 rows at a time.');
  return v.map((r, i) => {
    const row = r as Json;
    const date = String(row.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolError(`Row ${i + 1}: date must be YYYY-MM-DD.`);
    const description = String(row.description ?? '').trim();
    if (!description) throw new ToolError(`Row ${i + 1}: description is required.`);
    const amount = Number(row.amountCents);
    if (!Number.isInteger(amount) || amount === 0) throw new ToolError(`Row ${i + 1}: amountCents must be a whole number of cents, not 0.`);
    const check = row.checkNumber === undefined || row.checkNumber === null || row.checkNumber === '' ? null : String(row.checkNumber);
    const acct = row.accountId === undefined || row.accountId === null || row.accountId === '' ? null : Number(row.accountId);
    if (acct !== null && !Number.isInteger(acct)) throw new ToolError(`Row ${i + 1}: accountId must be an account id.`);
    return { date, description, amountCents: amount, checkNumber: check, accountId: acct };
  });
}

/** Every row of a client's bank account in a period, all pages. */
async function allRows(ctx: ToolContext, clientId: number, periodId: number, bankAccountId: number): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 1; page <= 40; page++) {
    const q = new URLSearchParams({ periodId: String(periodId), sourceAccountId: String(bankAccountId), page: String(page), pageSize: '500' });
    const rows = rowsOf(await expect(ctx, 'GET', `/api/v1/clients/${clientId}/bank-transactions?${q}`));
    out.push(...rows);
    if (rows.length < 500) break;
  }
  return out;
}

const keyOf = (date: string, description: string, amount: unknown, check: unknown): string =>
  `${date}|${description}|${Number(amount)}|${check ?? ''}`;

/** Set categories, grouped by account (the engine's batch-classify posts each row's entry). */
async function classify(ctx: ToolContext, clientId: number, pairs: Array<{ id: number; accountId: number }>): Promise<number> {
  const byAccount = new Map<number, number[]>();
  for (const p of pairs) byAccount.set(p.accountId, [...(byAccount.get(p.accountId) ?? []), p.id]);
  let n = 0;
  for (const [accountId, ids] of byAccount) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await expect(ctx, 'POST', `/api/v1/clients/${clientId}/bank-transactions/batch-classify`, { ids: chunk, accountId });
      n += chunk.length;
    }
  }
  return n;
}

const addBankTransactions: DesktopTool = {
  name: 'add_bank_transactions',
  description:
    "Post rows read from a client's bank statement to Bank transactions, on one bank account and in one period. Each row: date (YYYY-MM-DD), description as printed, amountCents (positive money in, negative money out), optional checkNumber, and optional accountId: the category account it posts to (find ids with search_accounts or get_chart_of_accounts). Rows already there (same date, description, amount and check) are left out, as the app's statement import does. A row with a category posts to the trial balance at once and teaches the client's payee rule; a row without one waits as unclassified for categorize_bank_transactions. A category a row already has is never changed here. Refused in a locked period.",
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'number', description: 'The client ID' },
      periodId: { type: 'number', description: 'The period the rows belong to' },
      bankAccountId: { type: 'number', description: "The bank account on the client's chart of accounts (an account id)" },
      transactions: {
        type: 'array',
        description: 'The statement rows',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            description: { type: 'string' },
            amountCents: { type: 'number', description: 'Cents: positive money in (deposit), negative money out (payment)' },
            checkNumber: { type: 'string' },
            accountId: { type: 'number', description: 'Optional: the category account this row posts to' },
          },
          required: ['date', 'description', 'amountCents'],
        },
      },
    },
    required: ['clientId', 'periodId', 'bankAccountId', 'transactions'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    const periodId = num(args, 'periodId')!;
    const bankAccountId = num(args, 'bankAccountId')!;
    const rows = readRows(args.transactions);
    const imported = (await expect(ctx, 'POST', '/api/v1/import/bank-statement-pdf/confirm', {
      clientId,
      periodId,
      sourceAccountId: bankAccountId,
      transactions: rows.map((r) => ({ date: r.date, description: r.description, amount: r.amountCents, checkNumber: r.checkNumber })),
    })) as { imported?: number; duplicates?: number };
    // The import does not say which rows it made: find each one by what it is.
    const wanted = rows.filter((r) => r.accountId !== null);
    let categorized = 0;
    const kept: Array<{ date: string; description: string; amountCents: number; category: unknown }> = [];
    const missing: InRow[] = [];
    if (wanted.length > 0) {
      const here = await allRows(ctx, clientId, periodId, bankAccountId);
      const pool = new Map<string, Json[]>();
      for (const h of here) {
        const k = keyOf(dayOf(h.transaction_date), String(h.description ?? ''), h.amount, h.check_number);
        pool.set(k, [...(pool.get(k) ?? []), h]);
      }
      const pairs: Array<{ id: number; accountId: number }> = [];
      for (const r of wanted) {
        const list = pool.get(keyOf(r.date, r.description, r.amountCents, r.checkNumber)) ?? [];
        const h = list.shift();
        if (!h) {
          missing.push(r);
          continue;
        }
        if (h.account_id !== null && h.account_id !== undefined && Number(h.account_id) !== r.accountId) {
          kept.push({ date: r.date, description: r.description, amountCents: r.amountCents, category: h.account_id });
          continue;
        }
        if (h.account_id === null || h.account_id === undefined) pairs.push({ id: Number(h.id), accountId: r.accountId! });
      }
      categorized = await classify(ctx, clientId, pairs);
    }
    return ok({
      sent: rows.length,
      added: imported.imported ?? null,
      alreadyThere: imported.duplicates ?? null,
      categorized,
      uncategorized: rows.length - wanted.length,
      keptTheirCategory: kept,
      notFoundAfterImport: missing,
    });
  },
};

const categorizeBankTransactions: DesktopTool = {
  name: 'categorize_bank_transactions',
  description:
    'Set the category account of bank transactions (by transaction id): each posts to the trial balance at once, replacing any category it had, and teaches the client\'s payee rule. Use list_bank_transactions for ids and search_accounts for account ids. Refused in a locked period.',
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'number', description: 'The client ID' },
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { transactionId: { type: 'number' }, accountId: { type: 'number', description: 'The category account id' } },
          required: ['transactionId', 'accountId'],
        },
      },
    },
    required: ['clientId', 'assignments'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    if (!Array.isArray(args.assignments) || args.assignments.length === 0) throw new ToolError('assignments must list at least one row.');
    const pairs = (args.assignments as Json[]).map((a, i) => {
      const id = Number(a.transactionId);
      const accountId = Number(a.accountId);
      if (!Number.isInteger(id) || !Number.isInteger(accountId)) throw new ToolError(`Assignment ${i + 1}: transactionId and accountId are ids.`);
      return { id, accountId };
    });
    return ok({ categorized: await classify(ctx, clientId, pairs) });
  },
};

const updateBankTransaction: DesktopTool = {
  name: 'update_bank_transaction',
  description:
    'Change one bank transaction: date (YYYY-MM-DD), description, amountCents (positive in, negative out), checkNumber, category accountId, bank account (bankAccountId) or periodId. Only the fields given change; a posted row\'s entry follows. Refused in a locked period.',
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'number' },
      transactionId: { type: 'number' },
      date: { type: 'string' },
      description: { type: 'string' },
      amountCents: { type: 'number' },
      checkNumber: { type: 'string' },
      accountId: { type: 'number' },
      bankAccountId: { type: 'number' },
      periodId: { type: 'number' },
    },
    required: ['clientId', 'transactionId'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    const id = num(args, 'transactionId')!;
    const body: Json = {};
    if (args.date !== undefined) body.transactionDate = str(args, 'date');
    if (args.description !== undefined) body.description = str(args, 'description');
    if (args.amountCents !== undefined) body.amount = num(args, 'amountCents');
    if (args.checkNumber !== undefined) body.checkNumber = args.checkNumber === null ? null : String(args.checkNumber);
    if (args.accountId !== undefined) body.accountId = args.accountId === null ? null : num(args, 'accountId');
    if (args.bankAccountId !== undefined) body.sourceAccountId = num(args, 'bankAccountId');
    if (args.periodId !== undefined) body.periodId = num(args, 'periodId');
    if (Object.keys(body).length === 0) throw new ToolError('Give at least one field to change.');
    return ok(await expect(ctx, 'PATCH', `/api/v1/clients/${clientId}/bank-transactions/${id}`, body));
  },
};

const deleteBankTransactions: DesktopTool = {
  name: 'delete_bank_transactions',
  description: 'Delete bank transactions by id, with the entries they posted. Cannot be undone except by adding them again. Refused in a locked period.',
  inputSchema: {
    type: 'object',
    properties: { clientId: { type: 'number' }, transactionIds: { type: 'array', items: { type: 'number' } } },
    required: ['clientId', 'transactionIds'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    const ids = Array.isArray(args.transactionIds) ? (args.transactionIds as unknown[]).map(Number) : [];
    if (ids.length === 0 || ids.some((i) => !Number.isInteger(i))) throw new ToolError('transactionIds must list transaction ids.');
    return ok(await expect(ctx, 'POST', `/api/v1/clients/${clientId}/bank-transactions/batch-delete`, { ids }));
  },
};

const setBankAccount: DesktopTool = {
  name: 'set_bank_account',
  description:
    'Put bank transactions (by id) on a bank account (a chart of accounts id). Rows that also have a category and a period then post to the trial balance.',
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'number' },
      transactionIds: { type: 'array', items: { type: 'number' } },
      bankAccountId: { type: 'number' },
    },
    required: ['clientId', 'transactionIds', 'bankAccountId'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    const bank = num(args, 'bankAccountId')!;
    const ids = Array.isArray(args.transactionIds) ? (args.transactionIds as unknown[]).map(Number) : [];
    if (ids.length === 0 || ids.some((i) => !Number.isInteger(i))) throw new ToolError('transactionIds must list transaction ids.');
    return ok(await expect(ctx, 'POST', `/api/v1/clients/${clientId}/bank-transactions/batch-update-source`, { ids, sourceAccountId: bank }));
  },
};

// ---------------------------------------------------------------- accounts and balances

const CATEGORIES = ['assets', 'liabilities', 'equity', 'revenue', 'expenses'];

const createAccount: DesktopTool = {
  name: 'create_account',
  description:
    "Add an account to a client's chart of accounts: accountNumber, accountName, category (assets, liabilities, equity, revenue, expenses) and normalBalance (debit or credit); optional subcategory, taxCodeId (from list_tax_codes), leadSheetId, workpaperRef, unit, cashFlowCategory (operating, investing, financing, non_cash, cash). Refused when the number is already used.",
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'number' },
      accountNumber: { type: 'string' },
      accountName: { type: 'string' },
      category: { type: 'string', enum: CATEGORIES },
      normalBalance: { type: 'string', enum: ['debit', 'credit'] },
      subcategory: { type: 'string' },
      taxCodeId: { type: 'number' },
      leadSheetId: { type: 'number' },
      workpaperRef: { type: 'string' },
      unit: { type: 'string' },
      cashFlowCategory: { type: 'string', enum: ['operating', 'investing', 'financing', 'non_cash', 'cash'] },
    },
    required: ['clientId', 'accountNumber', 'accountName', 'category', 'normalBalance'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    const body: Json = {};
    for (const k of ['accountNumber', 'accountName', 'category', 'normalBalance', 'subcategory', 'workpaperRef', 'unit', 'cashFlowCategory']) {
      if (args[k] !== undefined && args[k] !== null && args[k] !== '') body[k] = String(args[k]);
    }
    for (const k of ['taxCodeId', 'leadSheetId']) if (args[k] !== undefined && args[k] !== null) body[k] = num(args, k);
    return ok(await expect(ctx, 'POST', `/api/v1/clients/${clientId}/chart-of-accounts`, body));
  },
};

/** One line of a trial balance as Claude read it. */
interface TbLine {
  accountNumber: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  category?: string;
  normalBalance?: string;
}

function readTbLines(v: unknown): TbLine[] {
  if (!Array.isArray(v) || v.length === 0) throw new ToolError('accounts must list at least one account.');
  if (v.length > 5000) throw new ToolError('Send at most 5,000 accounts at a time.');
  const seen = new Set<string>();
  return v.map((r, i) => {
    const row = r as Json;
    const accountNumber = String(row.accountNumber ?? '').trim();
    const accountName = String(row.accountName ?? '').trim();
    if (!accountNumber || !accountName) throw new ToolError(`Account ${i + 1}: accountNumber and accountName are required.`);
    if (seen.has(accountNumber)) throw new ToolError(`Account number ${accountNumber} is listed twice.`);
    seen.add(accountNumber);
    const cents = (k: string): number => {
      const x = row[k] === undefined || row[k] === null || row[k] === '' ? 0 : Number(row[k]);
      if (!Number.isInteger(x) || x < 0) throw new ToolError(`Account ${accountNumber}: ${k} must be whole cents, 0 or more.`);
      return x;
    };
    let debitCents = cents('debitCents');
    let creditCents = cents('creditCents');
    if (row.balanceCents !== undefined && row.balanceCents !== null && row.balanceCents !== '') {
      const b = Number(row.balanceCents);
      if (!Number.isInteger(b)) throw new ToolError(`Account ${accountNumber}: balanceCents must be whole cents.`);
      if (debitCents || creditCents) throw new ToolError(`Account ${accountNumber}: give balanceCents or debitCents/creditCents, not both.`);
      debitCents = b > 0 ? b : 0;
      creditCents = b < 0 ? -b : 0;
    }
    const category = row.category ? String(row.category) : undefined;
    if (category && !CATEGORIES.includes(category)) throw new ToolError(`Account ${accountNumber}: category must be one of ${CATEGORIES.join(', ')}.`);
    const normalBalance = row.normalBalance ? String(row.normalBalance) : undefined;
    if (normalBalance && normalBalance !== 'debit' && normalBalance !== 'credit') throw new ToolError(`Account ${accountNumber}: normalBalance is debit or credit.`);
    return { accountNumber, accountName, debitCents, creditCents, category, normalBalance };
  });
}

const loadTrialBalance: DesktopTool = {
  name: 'load_trial_balance',
  description:
    "Load a trial balance read from a report (a PDF, a spreadsheet, a ledger) into a period as its unadjusted balances, through the app's own trial balance import. Each account: accountNumber, accountName, and its balance as debitCents and creditCents (or balanceCents: positive debit, negative credit); optional category (assets, liabilities, equity, revenue, expenses) and normalBalance (debit, credit) for accounts not on the chart yet. An account whose number is already on the client's chart gets the balance; any other is added to the chart first (its category, when not given, from the engine's own rule on the number's first digit). Accounts left out keep the balance they have. Check that debits equal credits before loading; the answer gives the totals written. Refused in a locked period.",
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'number' },
      periodId: { type: 'number' },
      accounts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            accountNumber: { type: 'string' },
            accountName: { type: 'string' },
            debitCents: { type: 'number' },
            creditCents: { type: 'number' },
            balanceCents: { type: 'number', description: 'Instead of debit and credit: positive debit, negative credit' },
            category: { type: 'string', enum: CATEGORIES },
            normalBalance: { type: 'string', enum: ['debit', 'credit'] },
          },
          required: ['accountNumber', 'accountName'],
        },
      },
    },
    required: ['clientId', 'periodId', 'accounts'],
  },
  async run(ctx, args) {
    const clientId = num(args, 'clientId')!;
    const periodId = num(args, 'periodId')!;
    const lines = readTbLines(args.accounts);
    const chart = rowsOf(await expect(ctx, 'GET', `/api/v1/clients/${clientId}/chart-of-accounts`));
    const byNumber = new Map(chart.map((a) => [String(a.account_number ?? '').trim(), a]));
    let added = 0;
    const matches = lines.map((l, i) => {
      const here = byNumber.get(l.accountNumber);
      if (!here) added++;
      return {
        csvRow: i,
        csvAccountNumber: l.accountNumber,
        csvAccountName: l.accountName,
        csvDebit: (l.debitCents / 100).toFixed(2),
        csvCredit: (l.creditCents / 100).toFixed(2),
        matchedAccountId: here ? Number(here.id) : null,
        matchedAccountNumber: here ? String(here.account_number) : null,
        matchedAccountName: here ? String(here.account_name) : null,
        confidence: 1,
        matchType: here ? 'exact' : 'none',
        action: here ? 'match' : 'create_new',
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        ...(here ? {} : { ...(l.category ? { newCategory: l.category } : {}), ...(l.normalBalance ? { newNormalBalance: l.normalBalance } : {}) }),
      };
    });
    const written = await expect(ctx, 'POST', '/api/v1/import/csv/confirm', { clientId, periodId, matches });
    const debits = lines.reduce((t, l) => t + l.debitCents, 0);
    const credits = lines.reduce((t, l) => t + l.creditCents, 0);
    return ok({
      accounts: lines.length,
      addedToChart: added,
      debitsCents: debits,
      creditsCents: credits,
      inBalance: debits === credits,
      engine: written,
    });
  },
};

// ---------------------------------------------------------------- M-1 adjustments

const M1_FIELDS = {
  description: { type: 'string', description: 'What the difference is' },
  category: { type: 'string', description: "One of the engine's M-1 categories (e.g. Meals & Entertainment, Depreciation Difference); optional" },
  bookAmountCents: { type: 'number', description: 'The book amount, in cents' },
  taxAmountCents: { type: 'number', description: 'The tax amount, in cents' },
  notes: { type: 'string' },
};

function m1Body(args: Json, all: boolean): Json {
  const body: Json = {};
  if (args.description !== undefined || all) body.description = str(args, 'description');
  if (args.category !== undefined) body.category = args.category === null ? null : String(args.category);
  if (args.bookAmountCents !== undefined || all) body.bookAmount = num(args, 'bookAmountCents');
  if (args.taxAmountCents !== undefined || all) body.taxAmount = num(args, 'taxAmountCents');
  if (args.notes !== undefined) body.notes = args.notes === null ? null : String(args.notes);
  return body;
}

const listM1: DesktopTool = {
  name: 'list_m1_adjustments',
  reads: true,
  description: "A period's M-1 (book-to-tax) adjustments: description, category, book and tax amounts in cents, notes. The reconciliation itself is save_report with report m1.",
  inputSchema: { type: 'object', properties: { periodId: { type: 'number' } }, required: ['periodId'] },
  async run(ctx, args) {
    return ok(await expect(ctx, 'GET', `/api/v1/periods/${num(args, 'periodId')}/m1-adjustments`));
  },
};

const createM1: DesktopTool = {
  name: 'create_m1_adjustment',
  description: 'Add an M-1 (book-to-tax) adjustment to a period. Refused in a locked period.',
  inputSchema: { type: 'object', properties: { periodId: { type: 'number' }, ...M1_FIELDS }, required: ['periodId', 'description', 'bookAmountCents', 'taxAmountCents'] },
  async run(ctx, args) {
    return ok(await expect(ctx, 'POST', `/api/v1/periods/${num(args, 'periodId')}/m1-adjustments`, m1Body(args, true)));
  },
};

const updateM1: DesktopTool = {
  name: 'update_m1_adjustment',
  description: 'Change an M-1 adjustment (by id); only the fields given change. Refused in a locked period.',
  inputSchema: { type: 'object', properties: { id: { type: 'number' }, ...M1_FIELDS }, required: ['id'] },
  async run(ctx, args) {
    const body = m1Body(args, false);
    if (Object.keys(body).length === 0) throw new ToolError('Give at least one field to change.');
    return ok(await expect(ctx, 'PATCH', `/api/v1/m1-adjustments/${num(args, 'id')}`, body));
  },
};

const deleteM1: DesktopTool = {
  name: 'delete_m1_adjustment',
  description: 'Delete an M-1 adjustment (by id). Refused in a locked period.',
  inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  async run(ctx, args) {
    return ok(await expect(ctx, 'DELETE', `/api/v1/m1-adjustments/${num(args, 'id')}`));
  },
};

// ---------------------------------------------------------------- reports

/** The reports the Statements screen offers, as the engine names them (cltb-api reports.rs). */
const REPORTS: Record<string, { prior?: boolean; leadSheets?: boolean; basis?: boolean }> = {
  'income-statement': { prior: true, leadSheets: true, basis: true },
  'balance-sheet': { prior: true, leadSheets: true, basis: true },
  'equity-statement': { prior: true, basis: true },
  'cash-flow': { basis: true },
  'tax-basis-pl': {},
  flux: { leadSheets: true, basis: true },
  'trial-balance': { basis: true },
  'general-ledger': { basis: true },
  'journal-entries': {},
  'aje-listing': {},
  'bookkeeper-letter': {},
  'tax-code-report': {},
  'tax-return-order': {},
  'tax-basis-schedule': {},
  m1: {},
};

/** Where saved files go when Claude names no folder (as generate_report_url). */
export function defaultSaveFolder(): string {
  return process.env.CLTB_REPORTS_DIR || require('node:path').join(require('node:os').tmpdir(), 'ClientLedger TB', 'open', 'claude');
}

/** A file answer saved under the engine's name in `dir`; its full path. */
export async function saveAnswer(res: Response, dir: string, fallback: string): Promise<string> {
  const path = require('node:path') as typeof import('node:path');
  const fs = require('node:fs') as typeof import('node:fs');
  if (!path.isAbsolute(dir)) throw new ToolError('saveToFolder must be a full path on this computer.');
  const disposition = res.headers.get('content-disposition');
  const star = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition?.match(/filename="?([^";]+)"?/i);
  const raw = star ? decodeURIComponent(star[1]) : plain?.[1] ?? fallback;
  const name = path.basename(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || fallback;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** The engine's refusal of a file request, in its words. */
async function refusal(res: Response): Promise<ToolError> {
  const text = await res.text();
  try {
    const env = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (env.error?.message) return new ToolError(env.error.code ? `${env.error.message} (${env.error.code})` : env.error.message);
  } catch {
    // not JSON
  }
  return new ToolError(`The engine answered ${res.status}.`);
}

const saveReport: DesktopTool = {
  name: 'save_report',
  reads: true,
  description:
    "Save one of the app's reports as the engine's PDF, as the Statements screen does: income-statement, balance-sheet, equity-statement, cash-flow, tax-basis-pl, flux (with comparePeriodId), trial-balance, general-ledger, journal-entries (entries: all, book, tax, trans), aje-listing, bookkeeper-letter, tax-code-report, tax-return-order, tax-basis-schedule, m1. Options where the report takes them: basis (unadjusted, book, tax), priorYear (true/false; left out, the engine decides), byLeadSheet. draft: true puts DRAFT across every page. Saved under the engine's file name in saveToFolder (a full path) or the app's folder for opened copies; the place is returned.",
  inputSchema: {
    type: 'object',
    properties: {
      periodId: { type: 'number' },
      report: { type: 'string', enum: Object.keys(REPORTS) },
      comparePeriodId: { type: 'number', description: 'flux only: the period compared with' },
      basis: { type: 'string', enum: ['unadjusted', 'book', 'tax'] },
      priorYear: { type: 'boolean' },
      byLeadSheet: { type: 'boolean' },
      entries: { type: 'string', enum: ['all', 'book', 'tax', 'trans'] },
      draft: { type: 'boolean' },
      saveToFolder: { type: 'string' },
    },
    required: ['periodId', 'report'],
  },
  async run(ctx, args) {
    const periodId = num(args, 'periodId')!;
    const report = str(args, 'report')!;
    const spec = REPORTS[report];
    if (!spec) throw new ToolError(`report must be one of ${Object.keys(REPORTS).join(', ')}.`);
    let route: string;
    if (report === 'bookkeeper-letter') route = `/api/v1/periods/${periodId}/exports/bookkeeper-letter`;
    else if (report === 'flux') route = `/api/v1/reports/periods/${periodId}/flux/${num(args, 'comparePeriodId')}`;
    else route = `/api/v1/reports/periods/${periodId}/${report}`;
    const q = new URLSearchParams();
    const basis = str(args, 'basis', false);
    if (basis && !['unadjusted', 'book', 'tax'].includes(basis)) throw new ToolError('basis is unadjusted, book or tax.');
    if (report === 'tax-code-report') q.set('columns', basis && basis !== 'book' ? 'tax' : 'book');
    else if (spec.basis && basis) q.set('basis', basis);
    if (spec.prior && typeof args.priorYear === 'boolean') q.set('priorYear', String(args.priorYear));
    if (spec.leadSheets && args.byLeadSheet === true) q.set('groupByLeadSheet', 'true');
    if (report === 'journal-entries') q.set('type', str(args, 'entries', false) ?? 'all');
    if (args.draft === true) route = route.replace('/api/v1/', '/api/v1/desktop/draft/');
    if (q.size > 0) route += `?${q}`;
    if (!ctx.fetch) throw new ToolError('This tool needs the app running.');
    const res = await ctx.fetch(route, { method: 'GET' });
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('application/json')) throw await refusal(res);
    const dir = typeof args.saveToFolder === 'string' && args.saveToFolder.trim() ? args.saveToFolder.trim() : defaultSaveFolder();
    return ok({ file: await saveAnswer(res, dir, `${report}.pdf`) });
  },
};

// ---------------------------------------------------------------- stamping attachments

const stampAttachment: DesktopTool = {
  name: 'stamp_attachment',
  description:
    "PERMANENT: burn a mark into a lead sheet attachment's PDF (owner: allowed, Q105). It cannot be removed afterwards, so stamp only when the user asks. kind tickmark (tickmarkId from list_tickmarks, optional note), note (text, optional color, optional widthPct of the page) or line (to x2Pct, y2Pct, optional strokeWidth and color). page from 1; xPct and yPct place it as fractions of the page from the top left. Colors: gray, blue, green, red, purple, amber.",
  inputSchema: {
    type: 'object',
    properties: {
      attachmentId: { type: 'number' },
      kind: { type: 'string', enum: ['tickmark', 'note', 'line'] },
      page: { type: 'number' },
      xPct: { type: 'number' },
      yPct: { type: 'number' },
      tickmarkId: { type: 'number' },
      note: { type: 'string', description: 'tickmark: a caption (up to 200 characters)' },
      text: { type: 'string', description: 'note: its text' },
      widthPct: { type: 'number' },
      x2Pct: { type: 'number' },
      y2Pct: { type: 'number' },
      strokeWidth: { type: 'number' },
      color: { type: 'string', enum: ['gray', 'blue', 'green', 'red', 'purple', 'amber'] },
    },
    required: ['attachmentId', 'kind', 'page', 'xPct', 'yPct'],
  },
  async run(ctx, args) {
    const id = num(args, 'attachmentId')!;
    const body: Json = { kind: str(args, 'kind'), page: num(args, 'page'), xPct: Number(args.xPct), yPct: Number(args.yPct) };
    for (const k of ['tickmarkId', 'note', 'text', 'widthPct', 'x2Pct', 'y2Pct', 'strokeWidth', 'color']) {
      if (args[k] !== undefined && args[k] !== null && args[k] !== '') body[k] = args[k];
    }
    return ok(await expect(ctx, 'POST', `/api/v1/lead-sheet-attachments/${id}/annotations`, body));
  },
};

// ---------------------------------------------------------------- variance notes

/** Upstream's add_variance_note wrote compare_period_id 0, which no period
    has, so it always failed (found 2026-11-20, P10b QA). Upstream fixed it
    (PR #36, Q106(1)) by keeping a note with no comparison period against the
    period itself; its tool still takes no comparison period, so this one
    stays: it saves the note against the period compared with (as the
    trial balance's Prior year columns show it), through the route's own
    locked- and held-period checks. */
const addVarianceNote: DesktopTool = {
  name: 'add_variance_note',
  replacesUpstream: true,
  description:
    "Add or change the variance note on an account: why its balance moved between this period and the one compared with (comparePeriodId, usually the prior year's period; list_periods gives ids). Refused in a locked period.",
  inputSchema: {
    type: 'object',
    properties: {
      periodId: { type: 'number' },
      comparePeriodId: { type: 'number', description: 'The period compared with' },
      accountId: { type: 'number' },
      note: { type: 'string' },
    },
    required: ['periodId', 'comparePeriodId', 'accountId', 'note'],
  },
  async run(ctx, args) {
    const p = num(args, 'periodId')!;
    const c = num(args, 'comparePeriodId')!;
    const a = num(args, 'accountId')!;
    return ok(await expect(ctx, 'PUT', `/api/v1/periods/${p}/compare/${c}/variance-notes/${a}`, { note: str(args, 'note') }));
  },
};

/** Every desktop tool, in the order `tools/list` shows them. */
// ---------------------------------------------------------------- chart of accounts templates

/**
 * The tax code of `text` on a client's return: its own form's code before a
 * code common to every return; two of the same kind is no match (as the
 * app's templates::carry_plan).
 */
export function codeForTemplateLine(text: string, codes: Json[]): number | null {
  const t = text.trim();
  const same = codes.filter((c) => String(c.tax_code ?? '').trim() === t);
  const own = same.filter((c) => c.return_form !== 'common');
  if (own.length === 1) return Number(own[0].id);
  if (own.length === 0 && same.length === 1) return Number(same[0].id);
  return null;
}

const applyCoaTemplate: DesktopTool = {
  name: 'apply_coa_template',
  description:
    "Add a chart of accounts template's accounts to a client, as the app's Apply to a client does: only accounts whose number the client does not have are added (accounts already there, their names and balances are never touched; nothing is ever replaced or deleted). Each added account gets the tax code of the template's tax line on the client's return when there is exactly one; the answer lists the accounts left without one. Template ids come from list_coa_templates.",
  inputSchema: {
    type: 'object',
    properties: {
      templateId: { type: 'number', description: 'The template (list_coa_templates)' },
      clientId: { type: 'number', description: 'The client' },
    },
    required: ['templateId', 'clientId'],
  },
  async run(ctx, args) {
    const templateId = num(args, 'templateId')!;
    const clientId = num(args, 'clientId')!;
    const chart = `/api/v1/clients/${clientId}/chart-of-accounts`;
    const before = new Set(rowsOf(await expect(ctx, 'GET', chart)).map((a) => String(a.account_number)));
    // Merge only: the engine's replace mode deletes a client's whole chart.
    const applied = (await expect(ctx, 'POST', `/api/v1/coa-templates/${templateId}/apply/${clientId}`, { mode: 'merge' })) as Json;
    const added = rowsOf(await expect(ctx, 'GET', chart)).filter((a) => !before.has(String(a.account_number)));
    const wanting = added.filter((a) => a.tax_code_id == null && String(a.tax_line ?? '').trim() !== '');
    let taxCodes = 0;
    const noCode: string[] = [];
    if (wanting.length > 0) {
      const codes = rowsOf(await expect(ctx, 'GET', `/api/v1/tax-codes/available?clientId=${clientId}`));
      const assignments = wanting.map((a) => {
        const id = codeForTemplateLine(String(a.tax_line), codes);
        if (id === null) noCode.push(String(a.account_number));
        return { accountId: Number(a.id), taxCodeId: id, source: 'template', confidence: null };
      });
      const real = assignments.filter((x) => x.taxCodeId !== null);
      if (real.length > 0) {
        await expect(ctx, 'PUT', '/api/v1/tax-lines/bulk-confirm', { clientId, assignments: real });
        taxCodes = real.length;
      }
    }
    return ok({
      added: applied.added ?? added.length,
      skipped: applied.skipped ?? null,
      accountsAdded: added.map((a) => `${a.account_number} ${a.account_name}`),
      taxCodesGiven: taxCodes,
      withoutTaxCode: noCode,
    });
  },
};

export const DESKTOP_TOOLS: DesktopTool[] = [
  listTaxCodes,
  listBankTransactions,
  addBankTransactions,
  categorizeBankTransactions,
  updateBankTransaction,
  deleteBankTransactions,
  setBankAccount,
  createAccount,
  loadTrialBalance,
  listM1,
  createM1,
  updateM1,
  deleteM1,
  saveReport,
  stampAttachment,
  addVarianceNote,
  applyCoaTemplate,
];

/** Run a desktop tool: its answer, or its refusal in words (never a thrown error). */
export async function runTool(tool: DesktopTool, ctx: ToolContext, args: Json): Promise<ToolResult> {
  try {
    return await tool.run(ctx, args);
  } catch (err) {
    if (err instanceof ToolError) return { text: err.message, isError: true };
    console.error(`[mcp] ${tool.name}`, err instanceof Error ? err.message : String(err));
    return { text: `${tool.name} could not finish. The app's log has the detail.`, isError: true };
  }
}
