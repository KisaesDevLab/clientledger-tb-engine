// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodStamp, STAMP_TABLES, type PeriodStampInput, type StampTable } from '../sync/periodStamp';

type Row = Record<string, unknown>;

/**
 * One period with a row in every table. `k` shifts every database id (as a
 * restore on another instance does) and `user` every user id; uids, codes
 * and symbols stay.
 */
function period(k = 0, user = 7): PeriodStampInput {
  const id = (n: number) => n + k;
  const acc = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const layout = {
    statements: [{
      kind: 'balance_sheet',
      body: [
        { id: 'ls1', type: 'leadsheet', ref: { groupingId: String(id(30)), leadsheetCode: 'A' } },
        { id: 'a1', type: 'account', refs: [{ accountId: String(id(1)) }] },
      ],
    }],
  };
  const rows: Partial<Record<StampTable, Row[]>> = {
    trial_balance: [{ id: id(100), period_id: id(10), account_id: id(1), unadjusted_debit: '1500', unadjusted_credit: '0', prior_year_debit: '0', prior_year_credit: '0', updated_by: user, updated_at: new Date(k * 1000) }],
    journal_entries: [{ id: id(200), period_id: id(10), entry_number: 1, entry_type: 'book', entry_date: new Date(2025, 11, 31), description: 'Accrue', is_recurring: false, workpaper_ref: null, source_tag: null, created_by: user, created_at: new Date(k) }],
    journal_entry_lines: [{ id: id(201), journal_entry_id: id(200), account_id: id(1), debit: '500', credit: '0' }],
    bank_transactions: [{ id: id(300), sync_uid: '00000000-0000-4000-9000-000000000001', client_id: id(5), period_id: id(10), transaction_date: new Date(2025, 5, 1), description: 'Deposit', amount: '2500', check_number: null, account_id: id(1), ai_suggested_account_id: null, ai_confidence: null, classification_status: 'manual', classified_by: user, imported_at: new Date(k), source_account_id: id(2), journal_entry_id: id(200), import_hash: 'h1', entry_source: 'csv' }],
    variance_notes: [{ id: id(400), account_id: id(1), period_id: id(10), compare_period_id: id(9), note: 'Up on volume', created_by: user, created_at: new Date(k) }],
    tb_tickmarks: [{ id: id(500), period_id: id(10), account_id: id(1), tickmark_id: id(40), created_by: user, created_at: new Date(k) }],
    m1_adjustments: [{ id: id(600), period_id: id(10), description: 'Meals', category: 'add', book_amount: '1000', tax_amount: '500', sort_order: 1, notes: null, created_by: user, created_at: new Date(k), updated_at: new Date(k) }],
    engagement_tasks: [{ id: id(700), period_id: id(10), title: 'Bank reconciled', description: null, category: 'Bank Reconciliation', status: 'completed', assignee_id: user, sort_order: 10, notes: null, completed_by: user, completed_at: new Date('2026-01-15T10:00:00Z'), created_by: user, created_at: new Date(k), updated_at: new Date(k) }],
    lead_sheet_notes: [{ id: id(800), client_id: id(5), period_id: id(10), lead_sheet_id: id(30), account_id: id(1), body: 'Agree to statement', author_id: user, author_name: 'KW', resolved_at: null, resolved_by: null, resolved_by_name: null, created_at: new Date(k), updated_at: new Date(k) }],
    lead_sheet_signoffs: [{ id: id(900), period_id: id(10), lead_sheet_id: id(30), role: 'preparer', user_id: user, user_name: 'KW', signed_at: new Date('2026-01-16T10:00:00Z'), balance_stamp: 'abc', invalidated_at: null, invalidated_by: null }],
    py_comparison_data: [{ id: id(1000), period_id: id(10), account_id: id(1), py_debit: '1200', py_credit: '0', source: 'upload', source_filename: 'py.csv', uploaded_at: new Date(k), uploaded_by: user }],
    lead_sheet_attachments: [{ id: id(1100), client_id: id(5), period_id: id(10), lead_sheet_id: id(30), lead_sheet_code: 'A', account_id: id(1), ref_code: 'A001', document_id: id(50), deleted_at: null, deleted_by: null, source_file_name: 'conf.pdf', annotations: [], created_by: user, created_at: new Date(k) }],
    bank_reconciliations: [{ id: id(1200), client_id: id(5), source_account_id: id(2), period_id: id(10), statement_date: new Date(2025, 11, 31), statement_ending_balance: '2500', beginning_book_balance: '0', status: 'completed', notes: null, created_by: user, completed_by: user, completed_at: new Date('2026-01-10T00:00:00Z'), created_at: new Date(k) }],
    reconciliation_items: [{ id: id(1300), reconciliation_id: id(1200), transaction_id: id(300), cleared_at: new Date('2026-01-10T00:00:00Z') }],
    fs_reports: [{ id: id(1400), client_id: id(5), period_id: id(10), client_layout_id: id(60), name: 'FS 2025', framework: 'gaap', columns_json: { mode: 'cy' }, entity_kind: 'llc', front_matter_json: {}, status: 'draft', current_version_id: id(1500), created_by: user, updated_by: user, created_at: new Date(k), updated_at: new Date(k), archived_at: null }],
    fs_report_versions: [{ id: id(1500), report_id: id(1400), version_no: 1, status: 'final', model_json: { k }, layout_json: layout, style_json: {}, settings_json: {}, front_matter_json: {}, letter_json: {}, letterhead_json: {}, source_stamp: 's', numbers_hash: 'n', pdf_sha256: 'p', pdf_size: 10, page_count: 2, validation_override: false, override_reason: null, finalized_by: user, finalized_by_name: 'KW', finalized_at: new Date('2026-01-20T00:00:00Z'), superseded_at: null, reopened_by: null, reopened_at: null }],
  };
  return {
    accounts: [{ id: id(1), sync_uid: acc(1) }, { id: id(2), sync_uid: acc(2) }],
    periods: [{ id: id(9), sync_uid: 'p-2024' }, { id: id(10), sync_uid: 'p-2025' }],
    leadSheets: [{ id: id(30), code: 'A' }],
    tickmarks: [{ id: id(40), symbol: 'T' }],
    documents: [{ id: id(50), sha256: 'filehash' }],
    bankTransactions: [],
    fsLayouts: [{ id: id(60), name: 'Default', layout_json: layout, style_json: { font: 'serif' }, archived_at: null, created_by: user }],
    rows,
  };
}

const base = periodStamp(period());

test('the stamp does not depend on database ids, user ids or when rows were written', () => {
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(periodStamp(period(1000, 99)), base, 'every id shifted, as on another instance');
});

test('the rows come in any order', () => {
  const p = period();
  p.rows.trial_balance!.push({ ...p.rows.trial_balance![0], id: 101, account_id: 2, unadjusted_debit: '7' });
  const q = period();
  q.rows.trial_balance!.unshift({ ...q.rows.trial_balance![0], id: 101, account_id: 2, unadjusted_debit: '7' });
  assert.equal(periodStamp(p), periodStamp(q));
});

/** One content change per table; each must move the stamp. */
const CHANGES: Record<StampTable, (r: Row) => void> = {
  trial_balance: (r) => { r.unadjusted_debit = '1501'; },
  journal_entries: (r) => { r.entry_date = new Date(2025, 11, 30); },
  journal_entry_lines: (r) => { r.debit = '501'; },
  bank_transactions: (r) => { r.account_id = 2; },
  variance_notes: (r) => { r.note = 'Down'; },
  tb_tickmarks: (r) => { r.account_id = 2; },
  m1_adjustments: (r) => { r.tax_amount = '0'; },
  engagement_tasks: (r) => { r.status = 'open'; },
  lead_sheet_notes: (r) => { r.resolved_at = new Date('2026-02-01T00:00:00Z'); },
  lead_sheet_signoffs: (r) => { r.invalidated_at = new Date('2026-02-01T00:00:00Z'); },
  py_comparison_data: (r) => { r.py_debit = '1'; },
  lead_sheet_attachments: (r) => { r.annotations = [{ kind: 'tickmark', page: 1 }]; },
  bank_reconciliations: (r) => { r.status = 'open'; },
  reconciliation_items: (r) => { r.cleared_at = new Date('2026-01-11T00:00:00Z'); },
  fs_reports: (r) => { r.name = 'FS 2025 v2'; },
  fs_report_versions: (r) => { r.numbers_hash = 'm'; },
};

for (const table of STAMP_TABLES) {
  test(`a change in ${table} changes the stamp`, () => {
    const p = period();
    const rows = p.rows[table]!;
    assert.ok(rows.length > 0, `the fixture has a ${table} row`);
    CHANGES[table](rows[0]);
    assert.notEqual(periodStamp(p), base);
  });
}

test('a row added or removed changes the stamp', () => {
  const p = period();
  p.rows.engagement_tasks!.push({ ...p.rows.engagement_tasks![0], id: 701, title: 'Payroll reconciled' });
  assert.notEqual(periodStamp(p), base);
  const q = period();
  q.rows.journal_entry_lines = [];
  assert.notEqual(periodStamp(q), base);
});

test('an attachment is its file: a stamped file changes the stamp', () => {
  const p = period();
  p.documents[0].sha256 = 'other';
  assert.notEqual(periodStamp(p), base);
});

test("a finalized version's layout counts, with its ids taken as the accounts and lead sheets they name; the client's layout does not", () => {
  const p = period();
  // Its own copy: the fixture's version shares the same object.
  p.fsLayouts[0].layout_json = JSON.parse(JSON.stringify(p.fsLayouts[0].layout_json));
  (p.fsLayouts[0].layout_json as { statements: Array<{ body: Row[] }> }).statements[0].body.pop();
  assert.equal(periodStamp(p), base, "the client's layout is client-level (SQ3), not the period's");
  const q = period();
  const v = q.rows.fs_report_versions![0];
  // The account line now names the other account.
  v.layout_json = JSON.parse(JSON.stringify(v.layout_json).replace('"accountId":"1"', '"accountId":"2"'));
  assert.notEqual(periodStamp(q), base);
});

test('a new account or lead sheet elsewhere in the client moves nothing (layouts name keys, not positions)', () => {
  const p = period();
  // Sorts before every other uid and code.
  p.accounts.push({ id: 3, sync_uid: '00000000-0000-4000-8000-000000000000' });
  p.leadSheets.push({ id: 31, code: '0' });
  assert.equal(periodStamp(p), base);
});

test('model_json, derived from the numbers, is left out', () => {
  const p = period();
  p.rows.fs_report_versions![0].model_json = { anything: true };
  assert.equal(periodStamp(p), base);
});

test('an account named by a reference counts by its sync_uid', () => {
  const p = period();
  p.accounts[0].sync_uid = '00000000-0000-4000-8000-000000000009';
  assert.notEqual(periodStamp(p), base);
});

test('a period and its archive stamp alike: a DATE read back from JSON is the same calendar date', () => {
  const p = period();
  // Archives write DATE columns as YYYY-MM-DD (Q104); everything else as JSON makes it.
  const pad = (n: number) => String(n).padStart(2, '0');
  const plain = (d: unknown) => (d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : d);
  const written = period();
  written.rows.journal_entries![0].entry_date = plain(written.rows.journal_entries![0].entry_date);
  written.rows.bank_transactions![0].transaction_date = plain(written.rows.bank_transactions![0].transaction_date);
  written.rows.bank_reconciliations![0].statement_date = plain(written.rows.bank_reconciliations![0].statement_date);
  const fromJson = JSON.parse(JSON.stringify(written)) as typeof p;
  // Layouts and maps survive as plain data.
  assert.equal(periodStamp(fromJson), base);
  const q = period();
  q.rows.journal_entries![0].entry_date = '2025-12-31';
  const r = period();
  r.rows.journal_entries![0].entry_date = new Date(2025, 11, 31);
  assert.equal(periodStamp(q), periodStamp(r), 'YYYY-MM-DD text and a local-midnight Date are one date');
});

test("an older archive's ISO date is the date Postgres stores from it, in any zone of this server (Q104)", () => {
  const r = period();
  r.rows.journal_entries![0].entry_date = new Date(2025, 11, 31);
  // Written by a server on UTC (the desktop, the appliance), and by one on US Central time.
  for (const text of ['2025-12-31T00:00:00.000Z', '2025-12-31T06:00:00.000Z']) {
    const q = period();
    q.rows.journal_entries![0].entry_date = text;
    assert.equal(periodStamp(q), periodStamp(r), text);
  }
});
