// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Q33: which client backups are brought up to this engine's schema before a
// restore, and how tax codes are matched. The upgrade itself needs a real
// database; the shell's acceptance_p04 runs it on fixtures/old-client-20260320.tbak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import unzipper from 'unzipper';
import { awayFromLiveTaxCodeIds, matchTaxCodes, upgradeDecision } from '../upgradeClient';
import { MANIFEST_PATH, hashArchive, verifyEntries } from '../../lib/backupManifest';

const known = ['20260315000000_initial_schema.js', '20260320000001_mcp_support.js', '20260930000001_financial_statements.js'];

test('only a client backup from an older known schema is upgraded', () => {
  const client = (schemaVersion: unknown) => ({ backupLevel: 'client', schemaVersion });
  assert.deepEqual(upgradeDecision(client('20260320000001_mcp_support.js'), known), {
    upgrade: true,
    from: '20260320000001_mcp_support.js',
  });
  assert.deepEqual(upgradeDecision(client('20260930000001_financial_statements.js'), known), { upgrade: false, why: 'same' });
  assert.deepEqual(upgradeDecision(client('20991231000000_later.js'), known), { upgrade: false, why: 'newer' });
  assert.deepEqual(upgradeDecision(client('20260401000000_other_branch.js'), known), { upgrade: false, why: 'diverged' });
  // Upstream archives before manifest format 2 name no schema.
  assert.deepEqual(upgradeDecision(client(undefined), known), { upgrade: false, why: 'no_schema' });
  assert.deepEqual(upgradeDecision(client(''), known), { upgrade: false, why: 'no_schema' });
  assert.deepEqual(
    upgradeDecision({ backupLevel: 'desktop_full', schemaVersion: '20260320000001_mcp_support.js' }, known),
    { upgrade: false, why: 'not_client' },
  );
});

test('tax codes match by form, activity and code; others are added', () => {
  const code = (id: number, tax_code: string, return_form = '1065') => ({ id, return_form, activity_type: 'business', tax_code });
  const m = matchTaxCodes([code(7, '100'), code(8, '99001'), code(9, '100', '1120S')], [code(1, '100'), code(2, '200')]);
  assert.deepEqual([...m], [
    [7, 1],
    [8, null],
    [9, null],
  ]);
});

test('tax code ids leave the live range, so the restore matches codes by key', () => {
  const out = awayFromLiveTaxCodeIds(
    {
      tax_codes: [{ id: 1, tax_code: '99001' }],
      tax_code_software_maps: [{ id: 5, tax_code_id: 1 }],
      chart_of_accounts: [{ id: 2, tax_code_id: 1 }, { id: 3, tax_code_id: null }],
      periods: [{ id: 1 }],
    },
    [
      { child: 'chart_of_accounts', col: 'tax_code_id', parent: 'tax_codes' },
      { child: 'tax_code_software_maps', col: 'tax_code_id', parent: 'tax_codes' },
      { child: 'trial_balance', col: 'account_id', parent: 'chart_of_accounts' },
    ],
  );
  assert.deepEqual(out.tax_codes, [{ id: -1, tax_code: '99001' }]);
  assert.deepEqual(out.tax_code_software_maps, [{ id: 5, tax_code_id: -1 }]);
  assert.deepEqual(out.chart_of_accounts, [{ id: 2, tax_code_id: -1 }, { id: 3, tax_code_id: null }]);
  assert.deepEqual(out.periods, [{ id: 1 }], 'other ids untouched');
});

test('the committed old-schema fixture is intact and from schema 20260320000001', async () => {
  const file = path.join(__dirname, 'fixtures', 'old-client-20260320.tbak');
  const dir = await unzipper.Open.file(file);
  const manifest = JSON.parse((await dir.files.find((f) => f.path === MANIFEST_PATH)!.buffer()).toString('utf8'));
  assert.equal(manifest.schemaVersion, '20260320000001_mcp_support.js');
  assert.equal(manifest.backupLevel, 'client');
  const checked = verifyEntries(manifest, await hashArchive(file));
  assert.ok(checked.ok && !checked.legacy);
  const coa = JSON.parse((await dir.files.find((f) => f.path === 'tables/chart_of_accounts.json')!.buffer()).toString('utf8'));
  assert.ok(coa.every((a: Record<string, unknown>) => 'sort_order' in a), 'rows carry the column a later migration drops');
});
