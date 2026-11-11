// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The trial balance totals route (tbTotals.ts) turns PostgreSQL's sums into
// exact cents and in-balance flags. The sums themselves are checked against
// the grid's rows by the desktop app's acceptance test against a real engine.
// Run: npx tsx --test src/desktop/__tests__/tbTotals.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, centsFromSum, totalsFromSums } from '../tbTotals';

test('sums arrive as numeric strings and stay exact', () => {
  assert.equal(centsFromSum('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.equal(centsFromSum('-12345'), -12345);
  assert.equal(centsFromSum(null), 0);
  assert.equal(centsFromSum(42), 42);
  assert.throws(() => centsFromSum('9007199254740992'), /out of range/);
});

test('every stage, and the three balance flags', () => {
  const sums: Record<string, unknown> = { account_count: '3' };
  for (const s of STAGES) {
    sums[`${s}_debit`] = '1000';
    sums[`${s}_credit`] = '1000';
  }
  sums.unadjusted_credit = '999';
  sums.tax_adjusted_debit = '1001';
  const t = totalsFromSums(7, sums);
  assert.equal(t.period_id, 7);
  assert.equal(t.account_count, 3);
  assert.deepEqual(Object.keys(t.stages), [...STAGES]);
  assert.deepEqual(t.stages.unadjusted, { debit: 1000, credit: 999 });
  assert.equal(t.unadjusted_in_balance, false);
  assert.equal(t.book_in_balance, true);
  assert.equal(t.tax_in_balance, false);
});

test('an empty period totals zero and balances', () => {
  const t = totalsFromSums(1, { account_count: '0' });
  assert.equal(t.account_count, 0);
  for (const s of STAGES) assert.deepEqual(t.stages[s], { debit: 0, credit: 0 });
  assert.ok(t.unadjusted_in_balance && t.book_in_balance && t.tax_in_balance);
});
