// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { before, test } from 'node:test';
import assert from 'node:assert/strict';

// newClient reads the user columns from routes/backup, whose imports want a
// secret at load; nothing here signs or connects.
process.env.JWT_SECRET ??= 'unit-test-secret-unit-test-secret-unit-test-secret-0000';
let confineNewClient: typeof import('../sync/newClient').confineNewClient;
before(async () => {
  ({ confineNewClient } = await import('../sync/newClient'));
});

const sender = { id: 7, name: 'Kurt' };

test('a new client from a desktop: every sign-off is the sender\'s, and says how many were given to them (Q102)', () => {
  const tables = {
    clients: [{ id: 1, name: 'Acme' }],
    lead_sheet_signoffs: [
      { id: 1, period_id: 2, lead_sheet_id: 3, role: 'preparer', user_id: 1, user_name: 'Desktop user', signed_at: '2026-01-01T00:00:00Z', balance_stamp: 'x', invalidated_at: null, invalidated_by: null },
      { id: 2, period_id: 2, lead_sheet_id: 3, role: 'reviewer', user_id: 7, user_name: 'Kurt', signed_at: '2026-01-02T00:00:00Z', balance_stamp: 'x', invalidated_at: '2026-01-03T00:00:00Z', invalidated_by: 1 },
    ],
    app_users: [{ id: 1 }],
  };
  const out = confineNewClient(tables, sender);
  const signs = out.tables.lead_sheet_signoffs as Array<Record<string, unknown>>;
  assert.equal(out.signoffsReassigned, 1);
  assert.deepEqual(signs.map((s) => [s.user_id, s.user_name]), [[7, 'Kurt'], [7, 'Kurt']]);
  // Who unsigned it on the desktop is not someone here.
  assert.equal(signs[1]!.invalidated_by, null);
  assert.equal(out.tables.app_users, undefined, 'users never come from a desktop');
});

test('a new client from a desktop: statements finalized there are refused', () => {
  assert.throws(() => confineNewClient({ fs_report_versions: [{ id: 1 }] }, sender), /finalized on the desktop/);
});
