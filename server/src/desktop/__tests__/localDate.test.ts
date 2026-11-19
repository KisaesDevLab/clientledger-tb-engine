// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Today's date on a PDF is the PC's date, stored dates stay UTC (Q63).
// Run: npx tsx --test src/desktop/__tests__/localDate.test.ts

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { localToday, readLocalZone, useLocalDates } from '../localDate';

process.env.TZ = 'UTC';
after(() => useLocalDates(undefined));

// 2026-11-17 01:00 UTC is still 2026-11-16 in Chicago (7 pm CST).
const evening = new Date(Date.UTC(2026, 10, 17, 1, 0, 0));

test('with no arguments, the date is the one in the PC\'s zone', () => {
  useLocalDates('America/Chicago');
  assert.equal(evening.toLocaleDateString(), evening.toLocaleDateString(undefined, { timeZone: 'America/Chicago' }));
  assert.match(evening.toLocaleDateString(), /16/);
  assert.doesNotMatch(evening.toLocaleDateString(), /17/);
});

test('a call with a locale or options is left alone', () => {
  useLocalDates('America/Chicago');
  // reportGenerators.ts fmtDate: a DATE column read as UTC midnight.
  const periodEnd = new Date('2025-12-31');
  assert.equal(
    periodEnd.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
    'Dec 31, 2025',
  );
  assert.equal(evening.toLocaleDateString('en-US'), '11/17/2026');
});

test('no zone puts the original back', () => {
  useLocalDates(undefined);
  assert.match(evening.toLocaleDateString(), /17/);
});

test('an unknown zone is refused at start-up', () => {
  assert.throws(() => useLocalDates('Not/AZone'));
});

test('UTC itself is not a local zone', () => {
  const zone = readLocalZone();
  assert.ok(zone === undefined || (zone !== 'UTC' && zone !== 'Etc/UTC'));
});

test('today for the accountant\'s report is the PC\'s day, not the UTC one (Q71)', () => {
  // 01:30 UTC on Nov 19 is still Nov 18 in Chicago.
  const evening = new Date('2026-11-19T01:30:00Z');
  useLocalDates('America/Chicago');
  try {
    assert.equal(localToday(evening), '2026-11-18');
  } finally {
    useLocalDates(undefined);
  }
  assert.equal(localToday(evening), '2026-11-19', 'no zone known: UTC');
});
