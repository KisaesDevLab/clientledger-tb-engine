// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The desktop's MCP entry (desktop/mcp.ts): generate_report_url answered by
// the desktop and described as such, every other message passed through,
// and requests to the private API signed with its own session token. The
// whole connection is driven end to end by apps/clientledger-tb/tests/mcp.rs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopTransport, signOwnRequests } from '../mcp';

type Msg = { jsonrpc: '2.0'; id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

class Fake {
  sent: Msg[] = [];
  onmessage?: (m: Msg) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  async start(): Promise<void> {}
  async send(m: Msg): Promise<void> { this.sent.push(m); }
  async close(): Promise<void> {}
}

test('generate_report_url is answered here; other calls go to the server', async () => {
  const inner = new Fake();
  const asked: Record<string, unknown>[] = [];
  const t = new DesktopTransport(inner as never, async (args) => { asked.push(args); return { text: '{"file":"C:/x.pdf"}' }; });
  const server: Msg[] = [];
  t.onmessage = (m) => server.push(m as Msg);
  await t.start();
  inner.onmessage!({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'generate_report_url', arguments: { reportType: 'tb', periodId: 1 } } });
  inner.onmessage!({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_clients', arguments: {} } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, [{ reportType: 'tb', periodId: 1 }]);
  assert.equal(inner.sent[0].id, 7);
  assert.match(JSON.stringify(inner.sent[0].result), /x\.pdf/);
  assert.deepEqual(server.map((m) => m.id), [8]);
});

test('the tool list says reports are saved on this computer', async () => {
  const inner = new Fake();
  const t = new DesktopTransport(inner as never, async () => ({ text: '' }));
  await t.send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'generate_report_url', description: 'a URL' }, { name: 'list_clients', description: 'clients' }] } } as never);
  const tools = (inner.sent[0].result as { tools: Array<{ name: string; description: string }> }).tools;
  assert.match(tools[0].description, /PDF on this computer/);
  assert.equal(tools[1].description, 'clients');
});

test('requests to the private API carry its token and never a bearer', async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const plain = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    seen.push({ url: input, headers: new Headers(init?.headers) });
    return new Response('{}');
  }) as typeof fetch;
  try {
    signOwnRequests(4321, 'tok');
    await fetch('http://localhost:4321/api/v1/tax-lines/auto-assign', { headers: { Authorization: 'Bearer jwt' } });
    await fetch('http://example.com/x', { headers: { Authorization: 'Bearer keep' } });
    assert.equal(seen[0].url, 'http://127.0.0.1:4321/api/v1/tax-lines/auto-assign');
    assert.equal(seen[0].headers.get('X-CLTB-Session'), 'tok');
    assert.equal(seen[0].headers.get('Authorization'), null);
    assert.equal(seen[1].headers.get('Authorization'), 'Bearer keep', 'other hosts untouched');
  } finally {
    globalThis.fetch = plain;
  }
});
