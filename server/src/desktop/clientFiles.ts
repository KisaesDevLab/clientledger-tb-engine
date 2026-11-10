// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop (Q31): document files for a client restored as a NEW copy.
//
// A client .tbak made with includeFiles carries each document's bytes under
// files/<documentId>. The engine's restore puts them back only on a
// same-client replace; a restore as new keeps the rows and clears their
// storage pointers, so two clients never share one stored file. On one laptop
// the copy should still open its documents, so after that restore the app
// calls this: each carried file is written as a NEW object in the new
// client's own folder, under a new key, and the row is pointed at it.
//
// Only rows of `newClientId` that have no stored file are touched, so this
// can never re-point a document that already has one. Upstream code is
// unchanged; the appliance keeps its behaviour.

import crypto from 'crypto';
import type { Knex } from 'knex';
import unzipper from 'unzipper';
import { requireLink } from '../lib/clientFolders';
import { defaultUploadSection } from '../lib/documentStore';
import { getStorageConfig, getStorageDriver } from '../lib/storage';
import { buildUniqueDocumentKeyUnder, fiscalYearFolder } from '../lib/storage/keys';
import { hashArchive, verifyEntries } from '../lib/backupManifest';
import { ensureClientLinks } from './clientLinks';

export interface PlaceResult {
  placed: number;
  notPlaced: number;
}

export class ClientFilesError extends Error {
  constructor(message: string, readonly code: 'BACKUP_DAMAGED' | 'NOT_A_CLIENT_BACKUP' | 'CLIENT_NOT_FOUND') {
    super(message);
  }
}

interface ListedFile {
  documentId: number;
  path: string;
}

/**
 * Place the document files of `archivePath` (a checked client .tbak) for the
 * client restored from it as `newClientId`. `documentIds` maps the archive's
 * document ids to the restored rows' ids (the restore's idMappings).
 */
export async function placeFilesForNewClient(
  db: Knex,
  archivePath: string,
  newClientId: number,
  documentIds: Record<string, number>,
): Promise<PlaceResult> {
  const dir = await unzipper.Open.file(archivePath);
  const manifestFile = dir.files.find((f) => f.path === 'manifest.json');
  if (!manifestFile) throw new ClientFilesError('This is not a backup file.', 'NOT_A_CLIENT_BACKUP');
  const manifest = JSON.parse((await manifestFile.buffer()).toString('utf8')) as Record<string, unknown>;
  if (manifest.backupLevel !== 'client') {
    throw new ClientFilesError('This backup does not hold one client.', 'NOT_A_CLIENT_BACKUP');
  }
  const checked = verifyEntries(manifest, await hashArchive(archivePath));
  if (!checked.ok) {
    throw new ClientFilesError(
      'This backup file is damaged: its contents do not match the checksums recorded when it was made.',
      'BACKUP_DAMAGED',
    );
  }
  const listed = (Array.isArray(manifest.files) ? manifest.files : []) as ListedFile[];
  if (listed.length === 0) return { placed: 0, notPlaced: 0 };

  const client = await db('clients').where({ id: newClientId }).first('id', 'tax_year_end');
  if (!client) throw new ClientFilesError('The restored client was not found.', 'CLIENT_NOT_FOUND');
  // A restored-as-new client arrives unlinked; the desktop links every client.
  await ensureClientLinks(db);
  const link = await requireLink(newClientId, db);

  const cfg = await getStorageConfig();
  const driver = await getStorageDriver();
  const fallbackSection = await defaultUploadSection(db);
  const entries = new Map(dir.files.map((f) => [f.path, f]));

  let placed = 0;
  let notPlaced = 0;
  for (const { documentId, path: entryPath } of listed) {
    const newId = documentIds[String(documentId)];
    const entry = entries.get(entryPath);
    const row = newId
      ? await db('client_documents')
          .where({ id: newId, client_id: newClientId })
          .whereNull('object_key')
          .whereNull('file_path')
          .first()
      : undefined;
    if (!row || !entry) {
      notPlaced += 1;
      continue;
    }
    let key: string | null = null;
    try {
      const body = await entry.buffer();
      let fy = 'unknown-year';
      if (row.period_id) {
        const period = await db('periods')
          .where({ id: row.period_id })
          .first('start_date', 'end_date', 'period_name', 'folder_year');
        if (period) {
          fy = fiscalYearFolder({
            folderYear: period.folder_year as string | null,
            endDate: period.end_date as string | null,
            startDate: period.start_date as string | null,
            periodName: period.period_name as string | null,
            taxYearEnd: client.tax_year_end as string | null,
          }, cfg.yearFormat);
        }
      }
      const section = (row.section as string | null) ?? fallbackSection;
      key = await buildUniqueDocumentKeyUnder(
        link.storage_path,
        {
          section: link.is_legacy_layout ? null : section,
          fiscalYear: link.is_legacy_layout ? null : fy,
          subfolder: null,
          filename: row.filename as string,
        },
        async (k) => (await driver.head(k)) !== null,
      );
      const meta = await driver.put(key, body, { contentType: (row.file_type as string | null) ?? undefined });
      const updated = await db('client_documents')
        .where({ id: row.id, client_id: newClientId })
        .whereNull('object_key')
        .update({
          storage_backend: driver.kind,
          object_key: key,
          bucket: driver.kind === 'b2' ? cfg.b2?.bucket ?? null : null,
          file_path: null,
          file_size: body.length,
          sha256: crypto.createHash('sha256').update(body).digest('hex'),
          etag: meta.etag,
          section,
        });
      if (updated !== 1) throw new Error('the document row changed while its file was placed');
      placed += 1;
    } catch (err) {
      // Never leave an object no row points at.
      if (key) await driver.delete(key).catch(() => undefined);
      console.warn(`[desktop] document ${documentId} file not placed:`, err instanceof Error ? err.message : err);
      notPlaced += 1;
    }
  }
  return { placed, notPlaced };
}
