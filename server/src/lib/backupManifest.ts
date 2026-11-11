// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * `.tbak` manifest, format 2 — additive, so an older reader still restores a
 * format-2 archive and this reader still restores a format-1 one.
 *
 * Added fields:
 *   formatVersion  2
 *   source         where the archive was made: 'appliance' | 'desktop' | 'hosted'
 *                  (VIBE_BACKUP_SOURCE, default 'appliance')
 *   appVersion     server package version
 *   schemaVersion  name of the newest applied knex migration
 *   entries        { "<path in zip>": { sha256, size } } for every entry but the
 *                  manifest itself. manifest.json is written LAST so every hash
 *                  is known when it is.
 *   includesFiles / files / missingFiles
 *                  document bytes under files/<documentId>, only when the
 *                  backup was asked for them (client and period levels). By
 *                  default an archive still carries rows, not bytes.
 *
 * The old `version: '1.0'` and the self-referential `checksum` field (always ''
 * inside the file) are left exactly as they were.
 *
 * Restore uses the pure checks here: a format-2 archive whose entries do not
 * match is refused (BACKUP_DAMAGED), and so is one made by a newer schema than
 * this instance has (BACKUP_SCHEMA_TOO_NEW). Format-1 archives skip both.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import unzipper from 'unzipper';

export const FORMAT_VERSION = 2;
export const MANIFEST_PATH = 'manifest.json';

export type BackupSource = 'appliance' | 'desktop' | 'hosted';

/** Where this instance's archives say they came from. */
export function backupSource(env: NodeJS.ProcessEnv = process.env): BackupSource {
  const v = (env.VIBE_BACKUP_SOURCE ?? '').trim().toLowerCase();
  return v === 'desktop' || v === 'hosted' ? v : 'appliance';
}

export interface ManifestEntry {
  sha256: string;
  size: number;
}
export type ManifestEntries = Record<string, ManifestEntry>;

/** One entry as found in an archive. */
export interface ActualEntry {
  path: string;
  sha256: string;
  size: number;
}

export function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function entryFor(buf: Buffer | string): ManifestEntry {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return { sha256: sha256Hex(b), size: b.length };
}

/** The archive path a document's bytes travel under. */
export function documentFilePath(documentId: number): string {
  return `files/${documentId}`;
}

/** Entries the checksum list must cover: the data, never the manifest. */
function covered(path: string): boolean {
  return path.startsWith('tables/') || path.startsWith('files/');
}

export type VerifyResult =
  | { ok: true; legacy: boolean }
  | { ok: false; problems: string[] };

/**
 * Compare an archive's entries with its manifest. A manifest without
 * `entries` (format 1) passes as legacy. Otherwise every listed entry must be
 * present with the same hash and size, and every data entry (tables/, files/)
 * must be listed — an entry slipped into an archive is as wrong as one that
 * changed.
 */
export function verifyEntries(manifest: Record<string, unknown>, actual: ActualEntry[]): VerifyResult {
  const listed = manifest.entries;
  if (listed === undefined || listed === null) return { ok: true, legacy: true };
  if (typeof listed !== 'object' || Array.isArray(listed)) {
    return { ok: false, problems: ['the manifest checksum list is not readable'] };
  }
  const want = listed as Record<string, unknown>;
  const byPath = new Map(actual.map((a) => [a.path, a]));
  const problems: string[] = [];
  for (const [path, raw] of Object.entries(want)) {
    const e = raw as Partial<ManifestEntry> | null;
    const got = byPath.get(path);
    if (!got) {
      problems.push(`${path} is missing`);
    } else if (!e || e.sha256 !== got.sha256 || e.size !== got.size) {
      problems.push(`${path} does not match its checksum`);
    }
  }
  for (const a of actual) {
    if (covered(a.path) && !(a.path in want)) problems.push(`${a.path} is not listed in the manifest`);
  }
  return problems.length === 0 ? { ok: true, legacy: false } : { ok: false, problems };
}

export type SchemaComparison = 'unknown' | 'same' | 'older' | 'newer' | 'diverged';

/**
 * Where an archive's schema stands against this instance's applied
 * migrations (oldest first). Migration names start with a timestamp, so they
 * sort in the order they were written.
 */
export function compareSchema(archive: unknown, applied: string[]): SchemaComparison {
  if (typeof archive !== 'string' || archive === '') return 'unknown';
  const last = applied[applied.length - 1];
  if (archive === last) return 'same';
  if (applied.includes(archive)) return 'older';
  if (last === undefined || archive > last) return 'newer';
  // A migration this instance never ran but that sorts before its newest:
  // made by a branch with a migration we lack. Rows still restore through the
  // table guards, so this is allowed — the caller decides.
  return 'diverged';
}

/** Applied migrations, oldest first. */
export async function appliedMigrations(knex: Knex): Promise<string[]> {
  if (!(await knex.schema.hasTable('knex_migrations'))) return [];
  const rows = (await knex('knex_migrations').orderBy('id', 'asc').select('name')) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Hash every entry of a zip, streaming one at a time. */
export async function hashArchive(filePath: string): Promise<ActualEntry[]> {
  const dir = await unzipper.Open.file(filePath);
  const out: ActualEntry[] = [];
  for (const file of dir.files) {
    if (file.type === 'Directory' || file.path === MANIFEST_PATH) continue;
    const hash = crypto.createHash('sha256');
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      file.stream()
        .on('data', (c: Buffer) => {
          hash.update(c);
          size += c.length;
        })
        .on('end', () => resolve())
        .on('error', reject);
    });
    out.push({ path: file.path, sha256: hash.digest('hex'), size });
  }
  return out;
}

/** Plain-language refusals for the restore routes. */
export const DAMAGED_MESSAGE =
  'This backup file is damaged: its contents do not match the checksums recorded when it was made. Use another copy of the backup.';
export const TOO_NEW_MESSAGE =
  'This backup was made by a newer version of Vibe Trial Balance. Update this installation, then restore it.';

export class BackupRefusal extends Error {
  constructor(message: string, readonly code: 'BACKUP_DAMAGED' | 'BACKUP_SCHEMA_TOO_NEW', readonly details: string[] = []) {
    super(message);
  }
}

/**
 * Everything restore checks before reading rows: the entries against the
 * manifest, then the schema. Throws BackupRefusal; returns quietly for a
 * format-1 archive.
 */
export async function checkArchive(filePath: string, manifest: Record<string, unknown>, knex: Knex): Promise<void> {
  if (manifest.entries !== undefined) {
    const result = verifyEntries(manifest, await hashArchive(filePath));
    if (!result.ok) throw new BackupRefusal(DAMAGED_MESSAGE, 'BACKUP_DAMAGED', result.problems);
  }
  if (compareSchema(manifest.schemaVersion, await appliedMigrations(knex)) === 'newer') {
    throw new BackupRefusal(TOO_NEW_MESSAGE, 'BACKUP_SCHEMA_TOO_NEW');
  }
}
