// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// One client out of a desktop full backup (extractClient.ts, Q30). Two clients
// share every table here, so each way a row belongs to a client (client_id,
// period, account, journal entry, statement set, reconciliation) is shown to
// keep client 1's rows and drop client 2's. The comparison with the engine's
// own client backup against PostgreSQL is the shell's P03 acceptance test.
// Run: npx tsx --test src/desktop/__tests__/extractClient.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullEntryOf, selectClientTables, type Tables } from '../extractClient';

function fullBackupOfTwoClients(): Tables {
  return {
    tax_codes: [{ id: 1 }, { id: 2 }],
    tax_code_software_maps: [{ id: 1, tax_code_id: 1 }],
    clients: [{ id: 1, name: 'Harlan' }, { id: 2, name: 'Summit' }],
    periods: [{ id: 10, client_id: 1 }, { id: 20, client_id: 2 }],
    chart_of_accounts: [{ id: 100, client_id: 1 }, { id: 200, client_id: 2 }],
    trial_balance: [{ id: 1, period_id: 10 }, { id: 2, period_id: 20 }],
    journal_entries: [{ id: 1000, period_id: 10 }, { id: 2000, period_id: 20 }],
    journal_entry_lines: [{ id: 1, journal_entry_id: 1000 }, { id: 2, journal_entry_id: 2000 }],
    bank_transactions: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    classification_rules: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    variance_notes: [{ id: 1, account_id: 100 }, { id: 2, account_id: 200 }],
    document_imports: [{ id: 1, period_id: 10 }, { id: 2, period_id: 20 }],
    tickmark_library: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    lead_sheets: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    client_documents: [
      { id: 1, client_id: 1, storage_backend: 'local', object_key: 'Clients/Harlan/WP/2025/a.pdf' },
      { id: 2, client_id: 2, storage_backend: 'local', object_key: 'Clients/Summit/WP/2025/b.pdf' },
    ],
    client_folder_links: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    lead_sheet_attachments: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    qbo_connections: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    lead_sheet_notes: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    lead_sheet_signoffs: [{ id: 1, period_id: 10 }, { id: 2, period_id: 20 }],
    fs_client_layouts: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    fs_reports: [{ id: 50, client_id: 1 }, { id: 60, client_id: 2 }],
    fs_report_versions: [{ id: 1, report_id: 50 }, { id: 2, report_id: 60 }],
    fs_cash_flow_overrides: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    fs_equity_roles: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }],
    tb_tickmarks: [{ id: 1, period_id: 10 }, { id: 2, period_id: 20 }],
    engagement_tasks: [{ id: 1, period_id: 10 }, { id: 2, period_id: 20 }],
    m1_adjustments: [{ id: 1, period_id: 10 }, { id: 2, period_id: 20 }],
    bank_reconciliations: [{ id: 7, period_id: 10 }, { id: 8, period_id: 20 }],
    reconciliation_items: [{ id: 1, reconciliation_id: 7 }, { id: 2, reconciliation_id: 8 }],
    // Never in a client backup.
    app_users: [{ id: 1 }],
    audit_log: [{ id: 1, client_id: 1 }],
    fs_letters: [{ id: 1 }],
  };
}

test('every way a row belongs to a client keeps client 1 and drops client 2', () => {
  const out = selectClientTables(fullBackupOfTwoClients(), 1);
  const shared = new Set(['tax_codes', 'tax_code_software_maps']);
  for (const [table, rows] of Object.entries(out)) {
    if (shared.has(table)) continue;
    assert.equal(rows.length, 1, `${table}: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].id === 1 || rows[0].id === 10 || rows[0].id === 100 || rows[0].id === 1000
      || rows[0].id === 50 || rows[0].id === 7, true, `${table} kept client 1's row`);
  }
  // Shared catalogues ride along whole: the chart of accounts points into them.
  assert.equal(out.tax_codes.length, 2);
  assert.equal(out.tax_code_software_maps.length, 1);
});

test('the tables are exactly the client backup\'s, never firm-wide ones', () => {
  const out = selectClientTables(fullBackupOfTwoClients(), 1);
  assert.deepEqual(Object.keys(out).sort(), [
    'bank_reconciliations', 'bank_transactions', 'chart_of_accounts', 'classification_rules',
    'client_documents', 'client_folder_links', 'clients', 'document_imports', 'engagement_tasks',
    'fs_cash_flow_overrides', 'fs_client_layouts', 'fs_equity_roles', 'fs_report_versions', 'fs_reports',
    'journal_entries', 'journal_entry_lines', 'lead_sheet_attachments', 'lead_sheet_notes',
    'lead_sheet_signoffs', 'lead_sheets', 'm1_adjustments', 'periods', 'qbo_connections',
    'reconciliation_items', 'tax_code_software_maps', 'tax_codes', 'tb_tickmarks', 'tickmark_library',
    'trial_balance', 'variance_notes',
  ]);
});

test('a client with no periods gets the period tables the way the engine writes them', () => {
  const t = fullBackupOfTwoClients();
  t.clients.push({ id: 3, name: 'New' });
  const out = selectClientTables(t, 3);
  // Written empty by createBackup…
  for (const k of ['periods', 'trial_balance', 'journal_entries', 'journal_entry_lines', 'document_imports']) {
    assert.deepEqual(out[k], [], k);
  }
  // …and left out when the client has no periods.
  for (const k of ['lead_sheet_signoffs', 'tb_tickmarks', 'engagement_tasks', 'm1_adjustments', 'bank_reconciliations']) {
    assert.equal(k in out, false, k);
  }
});

test('a table the backup\'s database did not have is not invented', () => {
  const t = fullBackupOfTwoClients();
  delete t.fs_reports;
  delete t.qbo_connections;
  const out = selectClientTables(t, 1);
  assert.equal('fs_reports' in out, false);
  assert.equal('fs_client_layouts' in out, false);
  assert.equal('qbo_connections' in out, false);
});

test('a document\'s file is found by its storage key; other storage is not', () => {
  assert.equal(
    fullEntryOf({ storage_backend: 'local', object_key: 'Clients/Harlan/WP/2025/a.pdf' }),
    'files/Clients/Harlan/WP/2025/a.pdf',
  );
  assert.equal(fullEntryOf({ storage_backend: 'local', object_key: '\\Clients\\H\\a.pdf' }), 'files/Clients/H/a.pdf');
  assert.equal(fullEntryOf({ storage_backend: 'b2', object_key: 'Clients/H/a.pdf' }), null);
  assert.equal(fullEntryOf({ storage_backend: 'local', object_key: null, file_path: 'C:\\old\\a.pdf' }), null);
});
