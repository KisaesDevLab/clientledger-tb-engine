// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// A user-chosen CSV column mapping (lib/csvColumnMapping.ts) is checked before
// the analyze route uses it in place of its guess, and drives the same row
// parser: a debit/credit file with no header row, which the heuristic reads as
// all zeros, comes out with its amounts.
// Run: npx tsx --test src/lib/__tests__/csvColumnMapping.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColumnMapping, type ColumnMapping } from '../csvColumnMapping';
// The route module reads auth config at import time (as csvImport.test.ts).
process.env.JWT_SECRET ??= 'test'.repeat(16);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseAllRows } = require('../../routes/csvImport') as typeof import('../../routes/csvImport');

const drcr = {
  delimiter: ',',
  hasHeaders: false,
  headerRow: 0,
  dataStartRow: 0,
  amountFormat: 'separate_dr_cr',
  columns: { accountNumber: 0, accountName: 1, debit: 2, credit: 3, amount: null },
};

function ok(raw: unknown): ColumnMapping {
  const m = parseColumnMapping(raw);
  assert.ok(m && !('error' in m), JSON.stringify(m));
  return m as ColumnMapping;
}

function err(raw: unknown): string {
  const m = parseColumnMapping(raw);
  assert.ok(m && 'error' in m, `expected an error, got ${JSON.stringify(m)}`);
  return (m as { error: string }).error;
}

test('absent or empty means guess as before', () => {
  assert.equal(parseColumnMapping(undefined), null);
  assert.equal(parseColumnMapping(''), null);
  assert.equal(parseColumnMapping(null), null);
});

test('a JSON string (the multipart field) is read', () => {
  const m = ok(JSON.stringify(drcr));
  assert.equal(m.amountFormat, 'separate_dr_cr');
  assert.deepEqual(m.rowsToSkip, []);
  assert.equal(m.detectedFormat, null);
});

test('a headerless debit/credit file parses with its amounts', () => {
  const lines = ['1000,Cash,1234.56,0', '2000,Accounts Payable,0,500.00', '4000,Sales,0,734.56'];
  const m = ok(drcr);
  const rows = parseAllRows(lines, m.columns, m.delimiter, m.dataStartRow, m.amountFormat, m.rowsToSkip);
  assert.deepEqual(
    rows.map((r) => [r.csvAccountNumber, r.debitCents, r.creditCents, r.action]),
    [
      ['1000', 123456, 0, 'create_new'],
      ['2000', 0, 50000, 'create_new'],
      ['4000', 0, 73456, 'create_new'],
    ],
  );
});

test('one signed column ignores stale debit/credit columns', () => {
  const m = ok({ ...drcr, amountFormat: 'single_signed', columns: { accountNumber: 0, accountName: 1, debit: 2, credit: 3, amount: 4 } });
  assert.deepEqual(m.columns, { accountNumber: 0, accountName: 1, debit: null, credit: null, amount: 4 });
});

test('header row before data', () => {
  ok({ ...drcr, hasHeaders: true, headerRow: 2, dataStartRow: 3 });
  assert.match(err({ ...drcr, hasHeaders: true, headerRow: 2, dataStartRow: 2 }), /after the header/);
});

test('refusals name the problem', () => {
  assert.match(err('{nope'), /not valid JSON/);
  assert.match(err({ ...drcr, columns: { ...drcr.columns, accountNumber: null, accountName: null } }), /account number or an account name/);
  assert.match(err({ ...drcr, columns: { ...drcr.columns, credit: null } }), /needs both/);
  assert.match(err({ ...drcr, amountFormat: 'single_signed' }), /one amount column needs/);
  assert.match(err({ ...drcr, columns: { ...drcr.columns, credit: 2 } }), /two fields/);
  assert.match(err({ ...drcr, delimiter: 'x' }), /delimiter/);
  assert.match(err({ ...drcr, extra: 1 }), /columnMapping/);
  assert.match(err({ ...drcr, columns: { ...drcr.columns, debit: -1 } }), /columns\.debit/);
});

test('rowsToSkip is deduplicated and sorted', () => {
  assert.deepEqual(ok({ ...drcr, rowsToSkip: [5, 1, 5] }).rowsToSkip, [1, 5]);
});
