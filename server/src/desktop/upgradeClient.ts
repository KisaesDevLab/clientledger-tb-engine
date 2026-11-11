// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop (Q33): bring a client .tbak made by an older engine up to this
// engine's schema before it is restored.
//
// The engine's client restore (routes/backup.ts restoreAsNew) inserts the
// archive's rows into today's tables as they are. A column dropped or renamed
// since the backup was made fails the insert, and a value a migration would
// have worked out (a backfill) is never worked out. A full restore does not
// have the problem: it builds the database at the backup's schema and
// migrates it up (fullBackup.ts). This does the same for one client:
//
// 1. the empty scratch database behind `db` is migrated to the backup's
//    schema;
// 2. the client's rows go in with their own ids. Tax codes are matched by
//    (return form, activity type, code) to the ones the migrations seeded;
//    a code the firm added itself is added. A link to a row the archive does
//    not carry (a user, mostly) is cleared, as the engine's restore does;
// 3. the database is migrated to this engine's schema;
// 4. the client is written out again as a client .tbak at this schema,
//    with the same document files, for the ordinary restore. Tax code ids
//    are made negative so that restore matches them by code (see
//    awayFromLiveTaxCodeIds); a code the firm added that the restoring
//    database lacks comes out unmapped, as for any backup from another
//    computer (Q38).
//
// The launcher creates the scratch database for the run and drops it after;
// the engine's own database is never touched.

import unzipper from 'unzipper';
import type { Knex } from 'knex';
import { MANIFEST_PATH, appliedMigrations, compareSchema, documentFilePath, hashArchive, verifyEntries } from '../lib/backupManifest';
import { MIGRATIONS } from './sources.generated';
import { staticSource } from './database';
import { columnsOf, decodeRow, listTables, migrateTo, resetSequences, withDeferredForeignKeys } from './fullBackup';
import { selectClientTables, writeClientArchive, type Tables } from './extractClient';

type Row = Record<string, unknown>;

export class UpgradeError extends Error {
  constructor(
    message: string,
    readonly code: 'BACKUP_DAMAGED' | 'BACKUP_SCHEMA_UNKNOWN' | 'DATABASE_NOT_EMPTY' | 'UPGRADE_BROKEN_REF' | 'UPGRADE_FAILED',
  ) {
    super(message);
  }
}

export type UpgradeDecision =
  | { upgrade: true; from: string }
  | { upgrade: false; why: 'not_client' | 'no_schema' | 'same' | 'newer' | 'diverged' };

/**
 * Whether a client .tbak needs bringing up to `known` (this engine's
 * migrations, oldest first). Only an archive that names a schema this engine
 * has, older than its newest, is upgraded; anything else goes to the
 * engine's restore as before (which refuses a newer one in plain words, and
 * restores an archive with no schema version as it always has).
 */
export function upgradeDecision(manifest: Row, known: string[]): UpgradeDecision {
  if (manifest.backupLevel !== 'client') return { upgrade: false, why: 'not_client' };
  const s = manifest.schemaVersion;
  if (typeof s !== 'string' || s === '') return { upgrade: false, why: 'no_schema' };
  const c = compareSchema(s, known);
  if (c === 'older') return { upgrade: true, from: s };
  return { upgrade: false, why: c === 'unknown' ? 'no_schema' : c };
}

/** How a tax code is recognised across databases (the engine's restore uses the same key). */
export function taxCodeKey(r: Row): string {
  return `${r.return_form}|${r.activity_type}|${r.tax_code}`;
}

/**
 * Archive tax code id → id in this database: the same code where it exists,
 * otherwise `null` (the caller adds it). Pure; `here` is this database's rows.
 */
export function matchTaxCodes(archive: Row[], here: Row[]): Map<number, number | null> {
  const byKey = new Map(here.map((r) => [taxCodeKey(r), r.id as number]));
  return new Map(archive.map((r) => [r.id as number, byKey.get(taxCodeKey(r)) ?? null]));
}

interface ForeignKey {
  child: string;
  col: string;
  parent: string;
  pcol: string;
  notnull: boolean;
}

async function singleColumnForeignKeys(trx: Knex.Transaction): Promise<ForeignKey[]> {
  return (await trx.raw(`
    SELECT cl.relname AS child, a.attname AS col, pcl.relname AS parent, pa.attname AS pcol, a.attnotnull AS notnull
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_class pcl ON pcl.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND n.nspname = 'public' AND array_length(c.conkey, 1) = 1`)).rows as ForeignKey[];
}

/**
 * The working database numbered its tax codes itself, so an id here says
 * nothing about the database the backup is restored into, where the engine's
 * restore keeps an account's tax code id whenever that id exists. Every tax
 * code id (and every column pointing at one) is made negative, which no live
 * row has, so the restore matches each code by form, activity and code
 * instead, as for a backup from another computer. Pure.
 */
export function awayFromLiveTaxCodeIds(tables: Tables, fks: Array<Pick<ForeignKey, 'child' | 'col' | 'parent'>>): Tables {
  const flip = (v: unknown) => (typeof v === 'number' && v > 0 ? -v : v);
  const cols = new Map<string, string[]>();
  for (const fk of fks) {
    if (fk.parent === 'tax_codes') cols.set(fk.child, [...(cols.get(fk.child) ?? []), fk.col]);
  }
  const out: Tables = {};
  for (const [t, rows] of Object.entries(tables)) {
    const these = [...(t === 'tax_codes' ? ['id'] : []), ...(cols.get(t) ?? [])];
    out[t] = these.length === 0 ? rows : rows.map((r) => {
      const row = { ...r };
      for (const c of these) row[c] = flip(row[c]);
      return row;
    });
  }
  return out;
}

export interface UpgradeResult {
  from: string;
  to: string;
  rows: number;
  fileCount: number;
}

const INSERT_BATCH = 500;
/** Loaded with their own rules, not row for row. */
const TAX_TABLES = new Set(['tax_codes', 'tax_code_software_maps']);

/**
 * Upgrade the client .tbak `inPath` into `outPath` using the empty database
 * behind `db`. Returns `null` (and writes nothing) when the archive needs no
 * upgrade; see `upgradeDecision`.
 */
export async function upgradeClientBackup(
  db: Knex,
  inPath: string,
  outPath: string,
  appVersion: string,
): Promise<UpgradeResult | null> {
  const dir = await unzipper.Open.file(inPath);
  const manifestFile = dir.files.find((f) => f.path === MANIFEST_PATH);
  if (!manifestFile) return null;
  const manifest = JSON.parse((await manifestFile.buffer()).toString('utf8')) as Row;
  const known = MIGRATIONS.map(([name]) => name);
  const decision = upgradeDecision(manifest, known);
  if (!decision.upgrade) return null;
  const from = decision.from;
  const to = known[known.length - 1];

  const checked = verifyEntries(manifest, await hashArchive(inPath));
  if (!checked.ok) {
    throw new UpgradeError(
      'This backup file is damaged: its contents do not match the checksums recorded when it was made.',
      'BACKUP_DAMAGED',
    );
  }
  if ((await appliedMigrations(db)).length > 0) {
    throw new UpgradeError('The working database is not empty.', 'DATABASE_NOT_EMPTY');
  }

  const archive: Tables = {};
  for (const f of dir.files) {
    const m = /^tables\/(.+)\.json$/.exec(f.path);
    if (m) archive[m[1]] = JSON.parse((await f.buffer()).toString('utf8')) as Row[];
  }
  const clientId = typeof manifest.clientId === 'number' ? manifest.clientId : (archive.clients?.[0]?.id as number | undefined);
  if (typeof clientId !== 'number' || !(archive.clients ?? []).some((c) => c.id === clientId)) {
    throw new UpgradeError('This backup does not hold its client.', 'BACKUP_DAMAGED');
  }

  // 1. The backup's own schema.
  await migrateTo(db, from);

  // 2. Its rows, ids kept.
  await withDeferredForeignKeys(db, async (trx) => {
    const here = new Set(await listTables(trx));
    for (const t of Object.keys(archive)) {
      if (!here.has(t)) {
        throw new UpgradeError(`The backup has a table its own version does not: ${t}.`, 'BACKUP_SCHEMA_UNKNOWN');
      }
    }
    const fks = await singleColumnForeignKeys(trx);

    // Tax codes: the seeded ones by key, the firm's own added.
    const taxMap = matchTaxCodes(archive.tax_codes ?? [], (await trx('tax_codes').select('*')) as Row[]);
    const taxCols = await columnsOf(trx, 'tax_codes');
    const added = new Map<number, number>();
    for (const r of archive.tax_codes ?? []) {
      if (taxMap.get(r.id as number) !== null) continue;
      const { id: _old, ...rest } = decodeRow(r, taxCols);
      const [ins] = (await trx('tax_codes').insert(rest).returning('id')) as Array<{ id: number }>;
      taxMap.set(r.id as number, ins.id);
      added.set(r.id as number, ins.id);
    }
    if (added.size > 0 && archive.tax_code_software_maps) {
      const mapCols = await columnsOf(trx, 'tax_code_software_maps');
      for (const r of archive.tax_code_software_maps) {
        const newCode = added.get(r.tax_code_id as number);
        if (newCode === undefined) continue;
        const { id: _old, ...rest } = decodeRow({ ...r, tax_code_id: newCode }, mapCols);
        await trx('tax_code_software_maps').insert(rest);
      }
    }
    const taxCodeCols = new Map<string, string[]>();
    for (const fk of fks) {
      if (fk.parent === 'tax_codes' && !TAX_TABLES.has(fk.child)) {
        taxCodeCols.set(fk.child, [...(taxCodeCols.get(fk.child) ?? []), fk.col]);
      }
    }

    for (const [t, rows] of Object.entries(archive)) {
      if (TAX_TABLES.has(t) || rows.length === 0) continue;
      const cols = await columnsOf(trx, t);
      const remap = taxCodeCols.get(t) ?? [];
      const prepared = rows.map((r) => {
        const row = { ...r };
        for (const c of remap) {
          const v = row[c];
          if (typeof v === 'number' && taxMap.has(v)) row[c] = taxMap.get(v);
        }
        return decodeRow(row, cols);
      });
      try {
        for (let i = 0; i < prepared.length; i += INSERT_BATCH) {
          await trx(t).insert(prepared.slice(i, i + INSERT_BATCH));
        }
      } catch (err) {
        throw new UpgradeError(`The rows of ${t} could not be loaded (${(err as Error).message}).`, 'UPGRADE_FAILED');
      }
    }

    // Links to rows the archive does not carry: cleared where the column
    // allows it; a required user link goes to a user of this database.
    const loaded = new Set(Object.keys(archive).filter((t) => !TAX_TABLES.has(t)));
    for (const fk of fks) {
      if (!loaded.has(fk.child)) continue;
      const dangling = trx(fk.child)
        .whereNotNull(fk.col)
        .whereNotExists(function () {
          this.select(1).from(`${fk.parent} as p`).whereRaw('?? = ??', [`p.${fk.pcol}`, `${fk.child}.${fk.col}`]);
        });
      if (!fk.notnull) {
        await dangling.update({ [fk.col]: null });
        continue;
      }
      const [{ n }] = (await dangling.clone().count({ n: '*' })) as Array<{ n: string | number }>;
      if (Number(n) === 0) continue;
      const fallback = fk.parent === 'app_users' ? ((await trx('app_users').min({ id: 'id' }).first()) as { id: number | null } | undefined)?.id : null;
      if (fallback === null || fallback === undefined) {
        throw new UpgradeError(`The backup is missing rows that ${fk.child} needs.`, 'UPGRADE_BROKEN_REF');
      }
      await dangling.update({ [fk.col]: fallback });
    }
    await resetSequences(trx);
  });

  // 3. This engine's schema.
  await db.migrate.latest({ migrationSource: staticSource(MIGRATIONS) });

  // 4. The client again, at this schema.
  const all: Tables = {};
  for (const t of await listTables(db)) all[t] = (await db(t).select('*')) as Row[];
  const selected = awayFromLiveTaxCodeIds(
    selectClientTables(all, clientId),
    await db.transaction((trx) => singleColumnForeignKeys(trx)),
  );
  const fileEntries = new Map(dir.files.map((f) => [f.path, f]));
  const { recordCounts: _c, files: _f, missingFiles: _m, entries: _e, checksum: _s, ...kept } = manifest;
  const written = await writeClientArchive(
    outPath,
    { ...kept, schemaVersion: to, appVersion, upgradedFrom: from },
    selected,
    (doc) => {
      const entry = fileEntries.get(documentFilePath(doc.id as number));
      return entry ? () => entry.buffer() : null;
    },
  );
  const rows = Object.values(selected).reduce((a, r) => a + r.length, 0);
  return { from, to, rows, fileCount: written.fileCount };
}
