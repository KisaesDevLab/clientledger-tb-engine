// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * `.tbak` manifest format 2 (lib/backupManifest.ts): every entry carries a
 * SHA-256, a tampered or slipped-in entry is refused, a format-1 archive still
 * passes, and an archive from a newer schema is refused. Real zip files are
 * built with archiver, the same writer the backup route uses.
 * Run: npx tsx --test src/lib/__tests__/backupManifest.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import {
  backupSource,
  compareSchema,
  documentFilePath,
  entryFor,
  hashArchive,
  verifyEntries,
  MANIFEST_PATH,
  type ManifestEntries,
} from '../backupManifest';

async function writeZip(file: string, parts: Array<[string, string | Buffer]>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, body] of parts) zip.append(body, { name });
    void zip.finalize();
  });
}

function tmp(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tbak-')), name);
}

const clients = JSON.stringify([{ id: 7, name: 'Harlan Feed & Supply, Inc.' }], null, 2);
const periods = JSON.stringify([{ id: 3, client_id: 7, period_name: 'FY 2025' }], null, 2);
const pdf = Buffer.from('%PDF-1.7 fake document bytes');

function manifestFor(parts: Array<[string, string | Buffer]>): Record<string, unknown> {
  const entries: ManifestEntries = {};
  for (const [name, body] of parts) entries[name] = entryFor(body);
  return { version: '1.0', formatVersion: 2, entries, checksum: '' };
}

test('an untouched format-2 archive verifies, files included', async () => {
  const parts: Array<[string, string | Buffer]> = [
    ['tables/clients.json', clients],
    ['tables/periods.json', periods],
    [documentFilePath(41), pdf],
  ];
  const file = tmp('ok.tbak');
  const manifest = manifestFor(parts);
  await writeZip(file, [...parts, [MANIFEST_PATH, JSON.stringify(manifest)]]);
  const actual = await hashArchive(file);
  assert.equal(actual.length, 3, 'the manifest itself is not hashed');
  assert.deepEqual(verifyEntries(manifest, actual), { ok: true, legacy: false });
});

test('a changed table is refused and named', async () => {
  const parts: Array<[string, string | Buffer]> = [
    ['tables/clients.json', clients],
    ['tables/periods.json', periods],
  ];
  const manifest = manifestFor(parts);
  const file = tmp('tampered.tbak');
  await writeZip(file, [
    ['tables/clients.json', clients.replace('Harlan', 'Harlen')],
    ['tables/periods.json', periods],
    [MANIFEST_PATH, JSON.stringify(manifest)],
  ]);
  const r = verifyEntries(manifest, await hashArchive(file));
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.problems, ['tables/clients.json does not match its checksum']);
});

test('a missing entry and a slipped-in entry are both refused', async () => {
  const manifest = manifestFor([
    ['tables/clients.json', clients],
    ['tables/periods.json', periods],
  ]);
  const file = tmp('swapped.tbak');
  await writeZip(file, [
    ['tables/clients.json', clients],
    ['tables/app_users.json', '[{"username":"intruder"}]'],
    [MANIFEST_PATH, JSON.stringify(manifest)],
  ]);
  const r = verifyEntries(manifest, await hashArchive(file));
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.problems.sort(), [
    'tables/app_users.json is not listed in the manifest',
    'tables/periods.json is missing',
  ]);
});

test('a format-1 archive (no entries) still passes as legacy', async () => {
  const file = tmp('legacy.tbak');
  const manifest = { version: '1.0', backupLevel: 'client', checksum: '' };
  await writeZip(file, [['tables/clients.json', clients], [MANIFEST_PATH, JSON.stringify(manifest)]]);
  assert.deepEqual(verifyEntries(manifest, await hashArchive(file)), { ok: true, legacy: true });
});

test('an unreadable checksum list is refused', () => {
  const r = verifyEntries({ entries: ['tables/clients.json'] }, []);
  assert.equal(r.ok, false);
});

test('schema comparison: newer is the only refusal the routes act on', () => {
  const applied = ['20260315000000_initial_schema.js', '20260930000001_financial_statements.js'];
  assert.equal(compareSchema(undefined, applied), 'unknown');
  assert.equal(compareSchema('20260930000001_financial_statements.js', applied), 'same');
  assert.equal(compareSchema('20260315000000_initial_schema.js', applied), 'older');
  assert.equal(compareSchema('20261101000001_something_new.js', applied), 'newer');
  assert.equal(compareSchema('20260401000000_branch_only.js', applied), 'diverged');
  assert.equal(compareSchema('20260101000000_x.js', []), 'newer');
});

test('source comes from VIBE_BACKUP_SOURCE and defaults to appliance', () => {
  assert.equal(backupSource({}), 'appliance');
  assert.equal(backupSource({ VIBE_BACKUP_SOURCE: 'Desktop' }), 'desktop');
  assert.equal(backupSource({ VIBE_BACKUP_SOURCE: 'hosted' }), 'hosted');
  assert.equal(backupSource({ VIBE_BACKUP_SOURCE: 'laptop' }), 'appliance');
});
