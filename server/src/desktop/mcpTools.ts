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
}

/** What a tool answers Claude. */
export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** A tool as `tools/list` shows it, and its handler. */
export interface DesktopTool {
  name: string;
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

/** Every desktop tool, in the order `tools/list` shows them. */
export const DESKTOP_TOOLS: DesktopTool[] = [
  listTaxCodes,
  listBankTransactions,
  addBankTransactions,
  categorizeBankTransactions,
  updateBankTransaction,
  deleteBankTransactions,
  setBankAccount,
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
