// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The Clients screen summary (clientSummary.ts): engagement status rules and
// the row → answer mapping. The SQL is checked against a real engine by the
// desktop app's tests (crates/cltb-api contract test).
// Run: npx tsx --test src/desktop/__tests__/clientSummary.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusOf, summaryFromRow } from '../clientSummary';

test('status: nothing yet, in progress, ready for review', () => {
  const base = { hasActivity: true, reviewerSigned: false, tasksTotal: 0, tasksDone: 0 };
  assert.equal(statusOf({ ...base, hasActivity: false }), 'not_started');
  assert.equal(statusOf({ ...base, hasActivity: false, reviewerSigned: true }), 'not_started');
  assert.equal(statusOf(base), 'in_progress');
  assert.equal(statusOf({ ...base, tasksTotal: 3, tasksDone: 2 }), 'in_progress');
  assert.equal(statusOf({ ...base, tasksTotal: 3, tasksDone: 3 }), 'ready_for_review');
  assert.equal(statusOf({ ...base, reviewerSigned: true }), 'ready_for_review');
});

test('a row reads as exact cents and balance flags', () => {
  const s = summaryFromRow({
    client_id: 2, period_id: 5, account_count: '59', active_accounts: '40',
    book_net: '0', tax_net: '-617500', aje_count: '5', entry_count: '6',
    reviewer_signoffs: '0', tasks_total: '0', tasks_done: '0',
    last_worked: new Date('2026-11-10T12:00:00Z'),
  });
  assert.deepEqual(s, {
    client_id: 2, period_id: 5, status: 'in_progress', account_count: 59,
    book_net: 0, tax_net: -617500, book_in_balance: true, tax_in_balance: false,
    aje_count: 5, last_worked: '2026-11-10T12:00:00.000Z',
  });
  const empty = summaryFromRow({ client_id: 1, period_id: 1, last_worked: null });
  assert.equal(empty.status, 'not_started');
  assert.equal(empty.last_worked, null);
  assert.ok(empty.book_in_balance && empty.tax_in_balance);
});
