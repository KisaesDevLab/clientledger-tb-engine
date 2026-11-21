// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop (Q108, owner 2026-11-21): a client .tbak the desktop writes leaves
// out the columns of upstream's unreleased sync work, so it restores on a
// Vibe Trial Balance appliance at the pinned version (v0.1.56), whose
// restore inserts every column an archive carries and has none of these.
//
// The engine pinned for P12 carries upstream's draft sync migrations
// (`feat/sync-s5-hardening`, Q99): `sync_uid` on clients, periods, accounts
// and bank transactions, `is_reference` on periods. A client backup is the
// one meant to travel (Q9), so it goes without them; a full backup (desktop
// to desktop) keeps them. Restored here, a client backup without sync ids
// gets new ones, as any restore as new does (`keepSyncUids`).
//
// Everything else in the archive is copied byte for byte; the manifest's
// checksum of each changed table is redone.

import crypto from 'crypto';
import fs from 'fs';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { MANIFEST_PATH, entryFor, type ManifestEntries } from '../lib/backupManifest';

type Row = Record<string, unknown>;

/** Columns a released Vibe Trial Balance does not have, by table. */
export const SYNC_ONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  clients: ['sync_uid'],
  periods: ['sync_uid', 'is_reference'],
  chart_of_accounts: ['sync_uid'],
  bank_transactions: ['sync_uid'],
};

/** `rows` without the sync-only columns of `table` (the same array when none). */
export function stripSyncColumns(table: string, rows: Row[]): Row[] {
  const drop = SYNC_ONLY_COLUMNS[table];
  if (!drop) return rows;
  return rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) if (!drop.includes(k)) out[k] = v;
    return out;
  });
}

/**
 * Rewrite the client .tbak at `file` in place (through `file.partial` and a
 * rename) without the sync-only columns. Answers the new size and whole-file
 * SHA-256 (hex). An archive with none of those columns is rewritten the same.
 */
export async function makePortable(file: string): Promise<{ size: number; sha256: string }> {
  const dir = await unzipper.Open.file(file);
  const manifestFile = dir.files.find((f) => f.path === MANIFEST_PATH);
  if (!manifestFile) throw new Error('not a backup file: no manifest');
  const manifest = JSON.parse((await manifestFile.buffer()).toString('utf8')) as Record<string, unknown>;
  const entries: ManifestEntries = { ...((manifest.entries as ManifestEntries | undefined) ?? {}) };

  const partial = `${file}.partial`;
  try {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(partial);
      const zip = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      zip.on('error', reject);
      zip.pipe(output);
      const build = async () => {
        for (const f of dir.files) {
          if (f.type !== 'File' || f.path === MANIFEST_PATH) continue;
          const body = await f.buffer();
          const m = /^tables\/(.+)\.json$/.exec(f.path);
          if (m && SYNC_ONLY_COLUMNS[m[1]]) {
            const rows = JSON.parse(body.toString('utf8')) as Row[];
            const text = JSON.stringify(stripSyncColumns(m[1], rows), null, 2);
            if (entries[f.path]) entries[f.path] = entryFor(text);
            zip.append(text, { name: f.path });
          } else {
            zip.append(body, { name: f.path });
          }
        }
        zip.append(JSON.stringify({ ...manifest, entries }, null, 2), { name: MANIFEST_PATH });
        await zip.finalize();
      };
      build().catch(reject);
    });
    const hash = crypto.createHash('sha256');
    for await (const c of fs.createReadStream(partial)) hash.update(c as Buffer);
    const size = fs.statSync(partial).size;
    fs.renameSync(partial, file);
    return { size, sha256: hash.digest('hex') };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}
