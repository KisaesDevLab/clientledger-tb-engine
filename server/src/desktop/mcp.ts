// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// `clientledger-tb-engine mcp`: the engine's MCP server on stdin/stdout for
// Claude Desktop (P10, owner Q78: every tool). ClientLedger Trial Balance
// starts it (`clientledger-tb mcp`) only while the app is open (Q79), with
// the same environment as the engine it runs, except PORT and
// CLTB_SESSION_TOKEN, which this process makes for itself.
//
// Three things make upstream's MCP server (mcp/server.ts, unchanged) work
// on the desktop:
//  1. stdout carries MCP messages only: every console method writes to
//     stderr, which Claude Desktop keeps as the server's log.
//  2. auto_assign_tax_codes calls the engine's own API over HTTP with a
//     bearer token. This process starts a private copy of the API on a
//     loopback port nobody else knows, and every request to it carries
//     this process's own session token (the desktop API takes nothing else).
//  3. generate_report_url builds a web address, which means nothing on a
//     desktop. Here the call saves the report as a PDF on this computer
//     and answers with where it is.

/* eslint-disable @typescript-eslint/no-require-imports */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import type { Knex } from 'knex';

type Json = Record<string, unknown>;
interface Message { jsonrpc: '2.0'; id?: string | number; method?: string; params?: Json; result?: Json; error?: unknown }
interface Transport {
  start(): Promise<void>;
  send(message: Message): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: Message) => void;
}

/** Every console method to stderr: stdout is the protocol. */
export function quietStdout(): void {
  const toErr = (...args: unknown[]): void => {
    process.stderr.write(`${util.format(...args)}\n`);
  };
  console.log = toErr;
  console.info = toErr;
  console.warn = toErr;
  console.debug = toErr;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Requests to this process's private API carry its token, never a bearer. */
export function signOwnRequests(port: number, token: string): void {
  const plain = globalThis.fetch;
  globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const own = (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && Number(url.port) === port;
    if (!own) return plain(input, init);
    url.hostname = '127.0.0.1';
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete('Authorization');
    headers.set('X-CLTB-Session', token);
    return plain(url.href, { ...init, headers });
  };
}

const REPORT_SEGMENT: Record<string, string> = {
  tb: 'trial-balance',
  gl: 'general-ledger',
  aje: 'aje-listing',
  is: 'income-statement',
  bs: 'balance-sheet',
  'cash-flow': 'cash-flow',
  'tax-basis-pl': 'tax-basis-pl',
  'tax-return-order': 'tax-return-order',
};

/**
 * Where saved reports go: CLTB_REPORTS_DIR, the app's own folder for opened
 * copies, which it empties when it starts (the engine's TEMP is another).
 */
export function reportFolder(): string {
  return process.env.CLTB_REPORTS_DIR || path.join(os.tmpdir(), 'ClientLedger TB', 'open', 'claude');
}

/** Wait until the private API answers its health check. */
async function untilHealthy(port: number, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the private API did not start');
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'report.pdf';
}

/** generate_report_url on the desktop: the PDF saved here, and where. */
export async function saveReport(port: number, args: Json): Promise<{ text: string; isError?: boolean }> {
  const periodId = Number(args.periodId);
  const segment = REPORT_SEGMENT[String(args.reportType)];
  if (!Number.isInteger(periodId) || periodId < 1 || !segment) {
    return { text: `periodId must be a period id and reportType one of: ${Object.keys(REPORT_SEGMENT).join(', ')}`, isError: true };
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/reports/periods/${periodId}/${segment}`);
  if (!res.ok) return { text: `The report could not be made (${res.status}): ${await res.text()}`, isError: true };
  const disposition = res.headers.get('content-disposition') ?? '';
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  const name = safeName(named ? decodeURIComponent(named) : `${segment}-${periodId}.pdf`);
  const dir = reportFolder();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return {
    text: JSON.stringify({
      file,
      reportType: args.reportType,
      periodId,
      note: 'ClientLedger Trial Balance is a desktop app with no web address: the report is saved as a PDF on this computer. The folder is emptied when the app starts.',
    }),
  };
}

/**
 * Claude Desktop's messages, with the desktop's own answer for
 * generate_report_url and its description saying so.
 */
export class DesktopTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: Message) => void;

  constructor(private readonly inner: Transport, private readonly report: (args: Json) => Promise<{ text: string; isError?: boolean }>) {}

  async start(): Promise<void> {
    this.inner.onmessage = (m) => { void this.receive(m); };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (e) => this.onerror?.(e);
    await this.inner.start();
  }

  async send(message: Message): Promise<void> {
    const tools = (message.result as { tools?: Array<{ name: string; description?: string }> } | undefined)?.tools;
    for (const t of tools ?? []) {
      if (t.name === 'generate_report_url') {
        t.description = 'Save a report (trial balance, general ledger, adjusting entries, income statement, balance sheet, cash flow, tax-basis P&L, tax return order) as a PDF on this computer and return where it is. ClientLedger Trial Balance has no web address.';
      }
    }
    await this.inner.send(message);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private async receive(m: Message): Promise<void> {
    if (m.method === 'tools/call' && m.id !== undefined && (m.params as Json | undefined)?.name === 'generate_report_url') {
      let answer: { text: string; isError?: boolean };
      try {
        answer = await this.report(((m.params as Json).arguments ?? {}) as Json);
      } catch (err) {
        console.error('[mcp] report', err instanceof Error ? err.message : String(err));
        answer = { text: 'The report could not be saved.', isError: true };
      }
      await this.inner.send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: answer.text }], ...(answer.isError ? { isError: true } : {}) } });
      return;
    }
    this.onmessage?.(m);
  }
}

/** Run the MCP server until Claude Desktop closes stdin. */
export async function runMcp(): Promise<void> {
  quietStdout();
  for (const n of ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY', 'UPLOADS_DIR', 'BACKUPS_DIR']) {
    if (!process.env[n]) {
      console.error(`FATAL: missing environment variable ${n}`);
      process.exit(1);
    }
  }
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PORT = String(port);
  process.env.CLTB_SESSION_TOKEN = token;
  signOwnRequests(port, token);

  const { db } = require('../db') as { db: Knex };
  const desktopDb = require('./database') as typeof import('./database');
  // The app migrates its database when it starts; one not yet brought up to
  // this engine is refused rather than changed from here.
  if ((await desktopDb.pendingMigrations(db)) > 0) {
    console.error('FATAL: the database is not up to date: open ClientLedger Trial Balance first');
    process.exit(4);
  }
  const { setDesktopUser } = require('./session') as typeof import('./session');
  setDesktopUser(await desktopDb.bootstrapDesktopUser(db));
  require('../app');
  // Tools that call the API must find it listening.
  await untilHealthy(port);

  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js') as { StdioServerTransport: new () => Transport };
  const { createMcpServer } = require('../mcp/server') as typeof import('../mcp/server');
  const server = createMcpServer('stdio');
  await server.connect(new DesktopTransport(new StdioServerTransport(), (args) => saveReport(port, args)) as never);
  process.stdin.on('close', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
  console.error(`[mcp] ready (private API on 127.0.0.1:${port})`);
}
