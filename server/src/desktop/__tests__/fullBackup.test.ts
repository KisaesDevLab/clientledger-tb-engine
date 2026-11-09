// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The pure parts of the desktop full backup (fullBackup.ts): rows survive the
// trip through JSON whatever their column type, and nothing in an archive can
// unpack outside the documents folder. The round trip against PostgreSQL is
// the desktop app's acceptance test (crates/cltb-backup in the shell repo).
// Run: npx tsx --test src/desktop/__tests__/fullBackup.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXCLUDED_TABLES, decodeRow, encodeRow, safeRelative } from '../fullBackup';

const cols = [
  { name: 'id', dataType: 'integer', generated: false },
  { name: 'pdf', dataType: 'bytea', generated: false },
  { name: 'layout', dataType: 'jsonb', generated: false },
  { name: 'tags', dataType: 'json', generated: false },
  { name: 'amount', dataType: 'bigint', generated: false },
  { name: 'end_date', dataType: 'date', generated: false },
  { name: 'search', dataType: 'tsvector', generated: true },
];

test('bytea, json arrays and bigint cents round-trip through the archive JSON', () => {
  const row = {
    id: 7,
    pdf: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]),
    layout: { lines: [{ id: '12' }] },
    tags: ['a', 'b'],
    amount: '15000000', // pg returns int8 as a string; cents stay exact
    end_date: new Date('2025-12-31T00:00:00.000Z'),
    search: "'harlan'",
  };
  const back = JSON.parse(JSON.stringify(encodeRow(row))) as Record<string, unknown>;
  const ins = decodeRow(back, cols);
  assert.deepEqual(ins.pdf, row.pdf);
  assert.equal(ins.layout, '{"lines":[{"id":"12"}]}');
  assert.equal(ins.tags, '["a","b"]', 'a JSON array is sent as JSON text, not a Postgres array');
  assert.equal(ins.amount, '15000000');
  assert.equal(ins.end_date, '2025-12-31T00:00:00.000Z');
  assert.equal('search' in ins, false, 'generated columns are never inserted');
});

test('nulls stay null and a column the backup lacks is left to its default', () => {
  const ins = decodeRow({ id: 1, pdf: null }, cols);
  assert.deepEqual(ins, { id: 1, pdf: null });
});

test('only plain relative paths under files/ unpack', () => {
  assert.equal(safeRelative('files/Clients/Harlan Feed/Workpapers & Support/2025/tb.pdf'), 'Clients/Harlan Feed/Workpapers & Support/2025/tb.pdf');
  for (const bad of [
    'files/../engine.exe',
    'files/a/../../x',
    'files//etc/passwd',
    'files/C:/Windows/x.dll',
    'files/a\\..\\b',
    'files/',
    'tables/clients.json',
  ]) {
    assert.equal(safeRelative(bad), null, bad);
  }
});

test('only the migration bookkeeping is left out', () => {
  assert.deepEqual([...EXCLUDED_TABLES].sort(), ['knex_migrations', 'knex_migrations_lock']);
});
