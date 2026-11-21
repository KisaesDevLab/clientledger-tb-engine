// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The desktop's own MCP tools (desktop/mcpTools.ts) against a fake engine:
// what each asks of the engine's routes and what it answers Claude. The
// real round trip (a statement posted and the trial balance moved) is
// apps/clientledger-tb/tests/mcp.rs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_TOOLS, runTool, type ApiAnswer, type ToolContext } from '../mcpTools';
import { DesktopTransport, appLabel, auditText } from '../mcp';

type Call = { method: string; path: string; body?: unknown };

function fake(answer: (c: Call) => ApiAnswer): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ctx: {
      async call(method, path, body) {
        const c = { method, path, body };
        calls.push(c);
        return answer(c);
      },
    },
  };
}

const tool = (name: string) => {
  const t = DESKTOP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const okData = (data: unknown): ApiAnswer => ({ status: 200, data, error: null });

test('every desktop tool has a unique name, words and a schema', () => {
  const names = DESKTOP_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of DESKTOP_TOOLS) {
    assert.ok(t.description.length > 40, t.name);
    assert.equal((t.inputSchema as { type: string }).type, 'object', t.name);
  }
});

test('list_tax_codes gives the client\'s codes with ids, narrowed by words', async () => {
  const { ctx, calls } = fake(() => okData([
    { id: 11, tax_code: '1001', description: 'Gross receipts or sales' },
    { id: 12, tax_code: '1210', description: 'Rents' },
  ]));
  const r = await runTool(tool('list_tax_codes'), ctx, { clientId: 3, search: 'rent' });
  assert.equal(calls[0].path, '/api/v1/tax-codes/available?clientId=3');
  const out = JSON.parse(r.text) as { count: number; codes: Array<{ id: number }> };
  assert.equal(out.count, 1);
  assert.equal(out.codes[0].id, 12);
});

test('add_bank_transactions imports, then categorizes only what it added, by account', async () => {
  const rows = [
    { id: 101, transaction_date: '2025-01-03T00:00:00.000Z', description: 'Rent', amount: '-150000', check_number: '1001', account_id: null },
    { id: 102, transaction_date: '2025-01-05', description: 'Deposit', amount: '250000', check_number: null, account_id: null },
    { id: 103, transaction_date: '2025-01-07', description: 'Office Depot', amount: '-4500', check_number: null, account_id: 77 },
    { id: 104, transaction_date: '2025-01-09', description: 'Office Depot', amount: '-3000', check_number: null, account_id: null },
  ];
  const { ctx, calls } = fake((c) => {
    if (c.path === '/api/v1/import/bank-statement-pdf/confirm') return okData({ imported: 3, duplicates: 1, total: 5 });
    if (c.path.includes('/bank-transactions?')) return okData(rows);
    if (c.path.endsWith('/batch-classify')) return okData({ updated: (c.body as { ids: number[] }).ids.length });
    return { status: 404, data: null, error: { message: 'no' } };
  });
  const r = await runTool(tool('add_bank_transactions'), ctx, {
    clientId: 3,
    periodId: 9,
    bankAccountId: 40,
    transactions: [
      { date: '2025-01-03', description: 'Rent', amountCents: -150000, checkNumber: '1001', accountId: 60 },
      { date: '2025-01-05', description: 'Deposit', amountCents: 250000, accountId: 50 },
      { date: '2025-01-07', description: 'Office Depot', amountCents: -4500, accountId: 61 },
      { date: '2025-01-09', description: 'Office Depot', amountCents: -3000, accountId: 61 },
      { date: '2025-01-11', description: 'No category', amountCents: -100 },
    ],
  });
  assert.equal(r.isError, undefined, r.text);
  const imp = calls[0];
  assert.equal(imp.path, '/api/v1/import/bank-statement-pdf/confirm');
  assert.deepEqual((imp.body as { transactions: unknown[] }).transactions[0], { date: '2025-01-03', description: 'Rent', amount: -150000, checkNumber: '1001' });
  const classified = calls.filter((c) => c.path.endsWith('/batch-classify')).map((c) => c.body);
  // One call per category account; the row that already had a category kept it.
  assert.deepEqual(classified, [{ ids: [101], accountId: 60 }, { ids: [102], accountId: 50 }, { ids: [104], accountId: 61 }]);
  const out = JSON.parse(r.text) as Record<string, unknown>;
  assert.equal(out.added, 3);
  assert.equal(out.alreadyThere, 1);
  assert.equal(out.categorized, 3);
  assert.equal(out.uncategorized, 1);
  assert.equal((out.keptTheirCategory as unknown[]).length, 1);
});

test('bad rows are refused in words before anything reaches the engine', async () => {
  const { ctx, calls } = fake(() => okData({}));
  const r = await runTool(tool('add_bank_transactions'), ctx, {
    clientId: 3, periodId: 9, bankAccountId: 40,
    transactions: [{ date: '01/03/2025', description: 'Rent', amountCents: -1 }],
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /YYYY-MM-DD/);
  assert.equal(calls.length, 0);
  const cents = await runTool(tool('add_bank_transactions'), ctx, {
    clientId: 3, periodId: 9, bankAccountId: 40,
    transactions: [{ date: '2025-01-03', description: 'Rent', amountCents: 12.5 }],
  });
  assert.match(cents.text, /whole number of cents/);
});

test('the engine\'s refusal reaches Claude in its own words', async () => {
  const { ctx } = fake(() => ({ status: 409, data: null, error: { code: 'PERIOD_LOCKED', message: 'This period is locked.' } }));
  const r = await runTool(tool('categorize_bank_transactions'), ctx, { clientId: 3, assignments: [{ transactionId: 1, accountId: 2 }] });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'This period is locked. (PERIOD_LOCKED)');
});

test('update_bank_transaction sends only the fields given, in the route\'s names', async () => {
  const { ctx, calls } = fake(() => okData({ id: 5 }));
  await runTool(tool('update_bank_transaction'), ctx, { clientId: 3, transactionId: 5, date: '2025-02-01', amountCents: -2500, accountId: 61 });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].path, '/api/v1/clients/3/bank-transactions/5');
  assert.deepEqual(calls[0].body, { transactionDate: '2025-02-01', amount: -2500, accountId: 61 });
});

type Msg = { jsonrpc: '2.0'; id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

class Inner {
  sent: Msg[] = [];
  onmessage?: (m: Msg) => void;
  async start(): Promise<void> {}
  async send(m: Msg): Promise<void> { this.sent.push(m); }
  async close(): Promise<void> {}
}

test('the transport lists the desktop tools after upstream\'s and answers their calls here', async () => {
  const inner = new Inner();
  const { ctx } = fake(() => okData([{ id: 1, tax_code: '1001', description: 'Gross receipts' }]));
  const t = new DesktopTransport(inner as never, async () => ({ text: '' }), ctx);
  const server: Msg[] = [];
  t.onmessage = (m) => server.push(m as Msg);
  await t.start();
  await t.send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'list_clients', description: 'x' }] } } as never);
  const listed = (inner.sent[0].result as { tools: Array<{ name: string }> }).tools.map((x) => x.name);
  assert.equal(listed[0], 'list_clients');
  assert.ok(listed.includes('list_tax_codes') && listed.includes('add_bank_transactions'));
  inner.onmessage!({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tax_codes', arguments: { clientId: 1 } } });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(server.length, 0, 'not passed to upstream');
  assert.match(JSON.stringify(inner.sent[1].result), /Gross receipts/);
});

test('a change Claude makes is written to the audit trail; a read is not', async () => {
  const inner = new Inner();
  const { ctx } = fake((c) => (c.path.includes('/available') ? okData([]) : okData({ updated: 1 })));
  const audited: Array<{ tool: string; args: Record<string, unknown>; app: string }> = [];
  const t = new DesktopTransport(inner as never, async () => ({ text: '' }), ctx, DESKTOP_TOOLS, async (tool, args, app) => {
    audited.push({ tool, args, app });
  });
  await t.start();
  inner.onmessage!({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tax_codes', arguments: { clientId: 1 } } });
  inner.onmessage!({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'categorize_bank_transactions', arguments: { clientId: 1, assignments: [{ transactionId: 5, accountId: 6 }] } } });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(audited.map((a) => a.tool), ['categorize_bank_transactions']);
  assert.match(auditText('categorize_bank_transactions', audited[0].args), /^Claude Desktop: categorize_bank_transactions \{"clientId":1/);
  assert.equal(audited[0].app, 'Claude Desktop', 'no initialize seen: Claude Desktop, as before');
});

test('the audit trail names the app that made the change, Claude Desktop or another', async () => {
  assert.equal(appLabel('claude-ai'), 'Claude Desktop');
  assert.equal(appLabel(''), 'Claude Desktop');
  assert.equal(appLabel('Cursor'), 'Cursor (MCP)');
  const inner = new Inner();
  const { ctx } = fake(() => okData({ updated: 1 }));
  const apps: string[] = [];
  const t = new DesktopTransport(inner as never, async () => ({ text: '' }), ctx, DESKTOP_TOOLS, async (_tool, _args, app) => {
    apps.push(app);
  });
  await t.start();
  inner.onmessage!({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Visual Studio Code', version: '1' } } });
  inner.onmessage!({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'categorize_bank_transactions', arguments: { clientId: 1, assignments: [{ transactionId: 5, accountId: 6 }] } } });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(apps, ['Visual Studio Code (MCP)']);
});
