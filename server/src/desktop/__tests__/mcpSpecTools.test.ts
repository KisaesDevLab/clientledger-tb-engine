// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Claude Desktop's tools made from the desktop's API description
// (mcpSpecTools.ts): every operation is a tool or excluded with a reason,
// no tool name is taken twice, the owner's areas are all there (Q105), and
// a tool builds its request from the operation and saves a file answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXCLUDED, operations, specTools, toolName } from '../mcpSpecTools';
import { DESKTOP_TOOLS, runTool, type ToolContext } from '../mcpTools';

/** Upstream's tools (mcp/server.ts), which the desktop keeps. */
const UPSTREAM = [
  'list_clients', 'get_period_dashboard', 'get_trial_balance', 'update_trial_balance_row', 'list_journal_entries',
  'create_journal_entry', 'get_chart_of_accounts', 'get_tax_mapping_status', 'auto_assign_tax_codes',
  'confirm_tax_assignments', 'run_diagnostics', 'lock_period', 'search_accounts', 'get_period_comparison',
  'add_variance_note', 'list_engagement_tasks', 'update_engagement_task', 'generate_report_url',
];

const folder = () => path.join(os.tmpdir(), 'cltb-mcp-spec-test');

test('every operation in the API description is a tool or excluded with a reason', () => {
  const ops = operations();
  const ids = new Set(ops.map((o) => o.operationId));
  for (const id of Object.keys(EXCLUDED)) assert.ok(ids.has(id), `EXCLUDED names ${id}, which the description no longer has`);
  for (const [id, why] of Object.entries(EXCLUDED)) assert.ok(why.length > 3, id);
  const tools = specTools(folder);
  assert.equal(tools.length + Object.keys(EXCLUDED).length, ops.length);
});

test('no tool name is taken twice, nor one of upstream\'s', () => {
  // A desktop tool that replaces upstream's broken one takes its name.
  const kept = UPSTREAM.filter((n) => !DESKTOP_TOOLS.some((t) => t.replacesUpstream && t.name === n));
  const names = [...kept, ...DESKTOP_TOOLS.map((t) => t.name), ...specTools(folder).map((t) => t.name)];
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(twice, []);
});

test('the areas the owner asked for are all tools (Q105)', () => {
  const names = new Set([...UPSTREAM, ...DESKTOP_TOOLS.map((t) => t.name), ...specTools(folder).map((t) => t.name)]);
  for (const n of [
    // A new client from a report: client, period, chart, balances.
    'create_client', 'create_period', 'create_account', 'load_trial_balance', 'update_account',
    // Bank statements posted with their categories; reconciliations.
    'add_bank_transactions', 'categorize_bank_transactions', 'create_reconciliation', 'complete_reconciliation',
    // Tax codes, the M-1 and the exports.
    'list_tax_codes', 'assign_tax_codes', 'export_to_tax_software', 'export_working_trial_balance', 'validate_export',
    // Entries.
    'update_journal_entry', 'delete_journal_entry',
    // Lead sheets: sign-offs (owner: yes), notes, attachments, the PDF.
    'sign_lead_sheet', 'unsign_lead_sheet', 'add_lead_sheet_note', 'resolve_lead_sheet_note', 'add_lead_sheet_attachment', 'lead_sheet_pdf',
    // The Statement Writer: create and edit.
    'create_fs_report', 'update_fs_report', 'save_fs_layout', 'compute_fs_report', 'finalize_fs_report', 'reopen_fs_report',
    // Reports as PDF, the workpaper package, documents, the checklist.
    'save_report', 'workpaper_package_pdf', 'list_m1_adjustments', 'create_m1_adjustment', 'stamp_attachment', 'upload_document', 'download_document', 'create_engagement_task',
  ]) {
    assert.ok(names.has(n), `missing tool ${n}`);
  }
  // And what the owner kept out.
  for (const n of ['save_firm', 'save_llm_provider', 'sync_import', 'execute_restore']) assert.ok(!names.has(n), n);
});

test('names follow the operation ids', () => {
  assert.equal(toolName('classifyBankTransactions'), 'classify_bank_transactions');
  assert.equal(toolName('getFsPreviewPdf'), 'get_fs_preview_pdf');
});

test('a tool puts its path and query parameters and its body where the route wants them', async () => {
  const sent: Array<{ path: string; init: RequestInit }> = [];
  const ctx: ToolContext = {
    async call() { throw new Error('not used'); },
    async fetch(p, init) {
      sent.push({ path: p, init });
      return new Response(JSON.stringify({ data: { id: 9 }, error: null }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  };
  const tool = specTools(folder).find((t) => t.name === 'create_period')!;
  const r = await runTool(tool, ctx, { clientId: 4, body: { periodName: 'FY 2025', startDate: '2025-01-01', endDate: '2025-12-31' } });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(sent[0].path, '/api/v1/clients/4/periods');
  assert.equal(sent[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), { periodName: 'FY 2025', startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.match(r.text, /"id": 9/);
});

test('a refusal comes back in the engine\'s words', async () => {
  const ctx: ToolContext = {
    async call() { throw new Error('not used'); },
    async fetch() {
      return new Response(JSON.stringify({ data: null, error: { code: 'PERIOD_LOCKED', message: 'This period is locked.' } }), { status: 409 });
    },
  };
  const tool = specTools(folder).find((t) => t.name === 'update_journal_entry')!;
  const r = await runTool(tool, ctx, { id: 3, body: { description: 'x' } });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'This period is locked. (PERIOD_LOCKED)');
});

test('a file answer is saved under the engine\'s name and its place returned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cltb-mcp-file-'));
  const ctx: ToolContext = {
    async call() { throw new Error('not used'); },
    async fetch() {
      return new Response(Buffer.from('%PDF-1.7 x'), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''FY%202025_Summit_aje-listing.pdf" },
      });
    },
  };
  const tool = specTools(folder).find((t) => t.name === 'get_aje_listing_pdf')!;
  const r = await runTool(tool, ctx, { periodId: 2, saveToFolder: dir });
  const file = (JSON.parse(r.text) as { file: string }).file;
  assert.equal(path.basename(file), 'FY 2025_Summit_aje-listing.pdf');
  assert.equal(fs.readFileSync(file, 'utf8'), '%PDF-1.7 x');
  const rel = await runTool(tool, ctx, { periodId: 2, saveToFolder: 'relative/dir' });
  assert.equal(rel.isError, true, 'a folder must be a full path');
  fs.rmSync(dir, { recursive: true, force: true });
});
