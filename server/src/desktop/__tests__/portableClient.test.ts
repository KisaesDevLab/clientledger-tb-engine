// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { MANIFEST_PATH, entryFor, hashArchive, verifyEntries } from '../../lib/backupManifest';
import { SYNC_ONLY_COLUMNS, makePortable, stripSyncColumns } from '../portableClient';

async function writeZip(file: string, parts: Record<string, string | Buffer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = archiver('zip');
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, body] of Object.entries(parts)) zip.append(body, { name });
    void zip.finalize();
  });
}

test('stripSyncColumns drops only the sync-only columns of the tables that have them', () => {
  const rows = [{ id: 1, name: 'Acme', sync_uid: 'u1' }];
  assert.deepEqual(stripSyncColumns('clients', rows), [{ id: 1, name: 'Acme' }]);
  assert.deepEqual(stripSyncColumns('periods', [{ id: 2, sync_uid: 'u', is_reference: false, period_name: 'FY' }]), [{ id: 2, period_name: 'FY' }]);
  assert.equal(stripSyncColumns('journal_entries', rows), rows, 'other tables untouched');
  assert.deepEqual(Object.keys(SYNC_ONLY_COLUMNS).sort(), ['bank_transactions', 'chart_of_accounts', 'clients', 'periods']);
});

test('makePortable rewrites a client .tbak without the sync columns, files byte for byte, checksums still good', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cltb-portable-'));
  const file = path.join(dir, 'c.tbak');
  const clients = JSON.stringify([{ id: 1, name: 'Acme', sync_uid: 'u1' }], null, 2);
  const coa = JSON.stringify([{ id: 5, account_number: '1000', sync_uid: 'u5' }], null, 2);
  const entries = JSON.stringify([{ id: 9, description: 'x' }], null, 2);
  const doc = Buffer.from([0, 1, 2, 255, 254]);
  const manifest = {
    formatVersion: 2,
    backupLevel: 'client',
    schemaVersion: '20261004000002_x.js',
    entries: {
      'tables/clients.json': entryFor(clients),
      'tables/chart_of_accounts.json': entryFor(coa),
      'tables/journal_entries.json': entryFor(entries),
      'files/7': entryFor(doc),
    },
  };
  await writeZip(file, {
    'tables/clients.json': clients,
    'tables/chart_of_accounts.json': coa,
    'tables/journal_entries.json': entries,
    'files/7': doc,
    [MANIFEST_PATH]: JSON.stringify(manifest),
  });

  const { size, sha256 } = await makePortable(file);
  assert.equal(size, fs.statSync(file).size);
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.ok(!fs.existsSync(`${file}.partial`));

  const z = await unzipper.Open.file(file);
  const read = async (p: string) => (await z.files.find((f) => f.path === p)!.buffer());
  assert.deepEqual(JSON.parse((await read('tables/clients.json')).toString()), [{ id: 1, name: 'Acme' }]);
  assert.deepEqual(JSON.parse((await read('tables/chart_of_accounts.json')).toString()), [{ id: 5, account_number: '1000' }]);
  assert.equal((await read('tables/journal_entries.json')).toString(), entries, 'unchanged table copied as it was');
  assert.deepEqual(await read('files/7'), doc, 'document bytes untouched');
  const m = JSON.parse((await read(MANIFEST_PATH)).toString()) as Record<string, unknown>;
  assert.equal(m.schemaVersion, '20261004000002_x.js');
  const checked = verifyEntries(m, await hashArchive(file));
  assert.ok(checked.ok && !checked.legacy, JSON.stringify(checked));
  fs.rmSync(dir, { recursive: true, force: true });
});
