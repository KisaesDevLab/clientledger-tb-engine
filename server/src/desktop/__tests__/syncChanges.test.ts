// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The Send back summary's counts (P12 D2.5): rows added, removed and
// changed in a period since it was pulled, by sync_uid where a row has one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableChanges } from '../syncChanges';
import type { PeriodStampInput } from '../../lib/sync/periodStamp';

const input = (entries: Array<Record<string, unknown>>, tb: Array<Record<string, unknown>> = []): PeriodStampInput => ({
  accounts: [{ id: 1, sync_uid: 'acct-1' }, { id: 2, sync_uid: 'acct-2' }],
  periods: [{ id: 9, sync_uid: 'per-9' }],
  leadSheets: [],
  tickmarks: [],
  documents: [],
  bankTransactions: [],
  fsLayouts: [],
  rows: { journal_entries: entries, trial_balance: tb },
});

test('entries added, changed and removed are counted once each', () => {
  const before = input([
    { id: 1, sync_uid: 'je-a', description: 'Accrual', entry_date: '2025-12-31' },
    { id: 2, sync_uid: 'je-b', description: 'Depreciation', entry_date: '2025-12-31' },
    { id: 3, sync_uid: 'je-c', description: 'Prepaid', entry_date: '2025-12-31' },
  ]);
  // Ids differ on the other computer: only contents and uids count.
  const after = input([
    { id: 11, sync_uid: 'je-a', description: 'Accrual', entry_date: '2025-12-31' },
    { id: 12, sync_uid: 'je-b', description: 'Depreciation, corrected', entry_date: '2025-12-31' },
    { id: 14, sync_uid: 'je-d', description: 'Bonus', entry_date: '2025-12-31' },
  ]);
  assert.deepEqual(tableChanges(before, after, 'journal_entries'), { added: 1, removed: 1, changed: 1 });
  assert.deepEqual(tableChanges(before, before, 'journal_entries'), { added: 0, removed: 0, changed: 0 });
});

test('a balance changed on an account reads as changed when the row keeps its uid', () => {
  const before = input([], [{ id: 1, sync_uid: 'tb-1', account_id: 1, unadjusted_debit: 100 }]);
  const after = input([], [{ id: 7, sync_uid: 'tb-1', account_id: 1, unadjusted_debit: 250 }]);
  assert.deepEqual(tableChanges(before, after, 'trial_balance'), { added: 0, removed: 0, changed: 1 });
});
