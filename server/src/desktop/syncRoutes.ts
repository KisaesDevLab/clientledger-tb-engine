// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop sync, the desktop's side (P12 D0, SYNC-ADDENDUM.md QS1, QS2). The
// desktop is a client of the firm server, never a server: the server's own
// /api/v1/sync routes are off here (app.ts). These routes let the desktop
// app (which talks to the firm server itself, cltb-sync) make and take the
// archives, with upstream's own code:
//
//   GET  /desktop/sync/version              this engine's archive format and schema
//   GET  /desktop/sync/ids                  each client's and period's sync_uid (what is linked)
//   GET  /desktop/sync/periods/:id/stamp    a period's stamp now
//   POST /desktop/sync/export-period        a period archive to send back (with its sync block)
//   POST /desktop/sync/export-client        a client archive to send as a new client
//   POST /desktop/sync/import               a period pulled from the firm server:
//                                           a client not here is restored as new keeping its
//                                           sync_uids; one here gets the period merged in
//
// QS2's merge is upstream's `mergePeriod`, run as a fresh merge (no
// check-out here and no stamp to compare with: the server's period replaces
// this computer's, after the app's safety backup), with no baseline, so the
// client-level rows already here stay and the server's differences are
// listed (SQ3 the other way round). Q100.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Router, type Response } from 'express';
import multer from 'multer';
import { db } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { createBackup, readManifest, readZipContents, restoreAsNew } from '../routes/backup';
import { BackupRefusal, FORMAT_VERSION, appliedMigrations, checkArchive, syncManifestProblem } from '../lib/backupManifest';
import { stampPeriod } from '../lib/sync/periodStampLoad';
import { SyncJobError } from '../lib/sync/jobs';
import { asSyncError, dropReplacedDocuments, mergePeriod, readSendBack, removeDocuments, stageAttachmentFiles } from '../lib/sync/mergePeriod';
import { placeFilesForNewClient } from './clientFiles';

export const desktopAppSyncRouter = Router();

const refuse = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ data: null, error: { code, message } });
};

/** An archive streamed back to the app, then removed from the temp folder. */
function sendFile(res: Response, file: string, name: string, headers: Record<string, string>): void {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Length', String(fs.statSync(file).size));
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  const done = () => fs.promises.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
  fs.createReadStream(file).on('error', done).on('close', done).pipe(res);
}

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cltb-sync-'));

desktopAppSyncRouter.get('/desktop/sync/version', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const applied = await appliedMigrations(db);
    res.json({ data: { formatVersion: FORMAT_VERSION, schemaVersion: applied[applied.length - 1] ?? null }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/version');
  }
});

desktopAppSyncRouter.get('/desktop/sync/ids', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const clients = (await db('clients').orderBy('id').select('id', 'sync_uid')) as Array<{ id: number; sync_uid: string }>;
    const periods = (await db('periods').orderBy('id').select('id', 'client_id', 'sync_uid', 'is_reference')) as Array<{ id: number; client_id: number; sync_uid: string; is_reference: boolean }>;
    res.json({
      data: clients.map((c) => ({
        clientId: c.id,
        clientUid: c.sync_uid,
        periods: periods.filter((p) => p.client_id === c.id && !p.is_reference).map((p) => ({ periodId: p.id, periodUid: p.sync_uid })),
      })),
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/ids');
  }
});

desktopAppSyncRouter.get('/desktop/sync/periods/:id/stamp', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    refuse(res, 400, 'INVALID_ID', 'Invalid period id');
    return;
  }
  try {
    const stamp = await stampPeriod(db, id);
    if (stamp === null) {
      refuse(res, 404, 'NOT_FOUND', 'No such period.');
      return;
    }
    res.json({ data: { periodId: id, stamp }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/stamp');
  }
});

/**
 * A period archive for the firm server: `{ periodId, checkoutId?, stampAtPull? }`.
 * Its manifest's `sync` block names the period and client by sync_uid, the
 * check-out it is sent under, and the stamp it started from (the server
 * refuses a send without a check-out whose period changed since).
 */
desktopAppSyncRouter.post('/desktop/sync/export-period', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as { periodId?: unknown; checkoutId?: unknown; stampAtPull?: unknown };
  const periodId = Number(body.periodId);
  const checkoutId = body.checkoutId === null || body.checkoutId === undefined ? null : Number(body.checkoutId);
  const stampAtPull = typeof body.stampAtPull === 'string' ? body.stampAtPull : null;
  if (!Number.isInteger(periodId) || periodId <= 0 || (checkoutId !== null && (!Number.isInteger(checkoutId) || checkoutId <= 0))) {
    refuse(res, 400, 'VALIDATION_ERROR', 'periodId is needed; checkoutId is a positive number or null.');
    return;
  }
  try {
    const period = await db('periods as p').join('clients as c', 'c.id', 'p.client_id').where('p.id', periodId)
      .first('p.id', 'p.client_id', 'p.sync_uid as period_uid', 'p.is_reference', 'c.sync_uid as client_uid');
    if (!period || period.is_reference) {
      refuse(res, 404, 'NOT_FOUND', 'No such period.');
      return;
    }
    const dir = tempDir();
    let stamp: string | null = null;
    const made = await createBackup('period', {
      clientId: period.client_id,
      periodId,
      includeFiles: true,
      outDir: dir,
      recordHistory: false,
      manifestExtra: async (trx) => {
        stamp = await stampPeriod(trx, periodId);
        return { sync: { periodUid: period.period_uid, clientUid: period.client_uid, stamp, checkoutId, stampAtPull } };
      },
    }, req.user?.userId ?? null);
    sendFile(res, made.storage_local!, path.basename(made.storage_local!), {
      'X-Period-Stamp': stamp ?? '',
      'X-Archive-Checksum': made.checksum ?? '',
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/export-period');
  }
});

/** A client archive for the firm server (`{ clientId }`): sent as a new client. */
desktopAppSyncRouter.post('/desktop/sync/export-client', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number((req.body ?? {}).clientId);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    refuse(res, 400, 'VALIDATION_ERROR', 'clientId is needed.');
    return;
  }
  try {
    if (!(await db('clients').where({ id: clientId }).first('id'))) {
      refuse(res, 404, 'NOT_FOUND', 'No such client.');
      return;
    }
    const dir = tempDir();
    const made = await createBackup('client', { clientId, outDir: dir, recordHistory: false }, req.user?.userId ?? null);
    sendFile(res, made.storage_local!, path.basename(made.storage_local!), { 'X-Archive-Checksum': made.checksum ?? '' });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/export-client');
  }
});

const pulledUpload = multer({
  dest: path.join(os.tmpdir(), 'cltb-sync-import'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 },
});

/** Checks every pulled archive passes before anything is written. */
async function checked(file: string): Promise<{ manifest: Record<string, unknown>; periodUid: string; clientUid: string }> {
  let manifest: Record<string, unknown>;
  try {
    manifest = await readManifest(file);
  } catch {
    throw new SyncJobError('SYNC_ARCHIVE_INVALID', 'The file is not a Vibe Trial Balance archive.');
  }
  const problem = syncManifestProblem(manifest);
  if (problem) throw new SyncJobError('SYNC_ARCHIVE_INVALID', problem);
  try {
    await checkArchive(file, manifest, db);
  } catch (err: unknown) {
    if (err instanceof BackupRefusal) throw new SyncJobError(err.code === 'BACKUP_DAMAGED' ? 'SYNC_ARCHIVE_DAMAGED' : 'SYNC_SCHEMA_MISMATCH', err.message);
    throw err;
  }
  const applied = await appliedMigrations(db);
  if (manifest.schemaVersion !== applied[applied.length - 1]) {
    throw new SyncJobError('SYNC_SCHEMA_MISMATCH', 'This period was made by a different version of Vibe Trial Balance. Update the older one, then open it again.');
  }
  const sync = (manifest.sync ?? {}) as Record<string, unknown>;
  if (manifest.backupLevel !== 'period' || typeof sync.periodUid !== 'string' || typeof sync.clientUid !== 'string') {
    throw new SyncJobError('SYNC_ARCHIVE_INVALID', 'The file is not a period pulled from a firm server.');
  }
  return { manifest, periodUid: sync.periodUid, clientUid: sync.clientUid };
}

desktopAppSyncRouter.post('/desktop/sync/import', pulledUpload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  const upload = (req as AuthRequest & { file?: Express.Multer.File }).file;
  const remove = () => {
    if (upload) fs.promises.unlink(upload.path).catch(() => undefined);
  };
  if (!upload) {
    refuse(res, 400, 'VALIDATION_ERROR', 'file is needed.');
    return;
  }
  try {
    const { manifest, periodUid, clientUid } = await checked(upload.path);
    const userId = req.user!.userId;
    const client = await db('clients').where({ sync_uid: clientUid }).first('id');
    if (!client) {
      // QS2: not on this computer: a new client, keeping its sync_uids.
      const tables = await readZipContents(upload.path, 5000);
      const r = await db.transaction((trx) => restoreAsNew(tables, trx, false, { keepName: true, untrusted: true }));
      const docs = Object.fromEntries(Object.entries(r.idMappings.client_documents ?? {}).map(([k, v]) => [k, Number(v)]));
      const files = await placeFilesForNewClient(db, upload.path, r.newClientId, docs);
      const period = await db('periods').where({ sync_uid: periodUid }).first('id');
      res.json({
        data: { mode: 'new', clientId: r.newClientId, periodId: period?.id ?? null, filesPlaced: files.placed, filesNotPlaced: files.notPlaced, stamp: period ? await stampPeriod(db, period.id) : null },
        error: null,
      });
      return;
    }
    // QS2: on this computer: the period merged in (made first when it is new here).
    const clientId = Number(client.id);
    const { tables, files } = await readSendBack(upload.path, { periodUid, clientUid, checkoutId: null });
    const own = ((tables.periods ?? []) as Array<Record<string, unknown>>).find((p) => Number(p.id) === Number(manifest.periodId));
    if (!own) throw new SyncJobError('SYNC_ARCHIVE_INVALID', "The archive does not carry its own period's row.");
    const existing = await db('periods').where({ sync_uid: periodUid }).first('id', 'client_id');
    if (existing && Number(existing.client_id) !== clientId) {
      throw new SyncJobError('SYNC_PERIOD_ELSEWHERE', 'This period belongs to another client on this computer.');
    }
    let periodId = existing ? Number(existing.id) : 0;
    const made = !existing;
    if (made) {
      const [ins] = await db('periods').insert({
        client_id: clientId, sync_uid: periodUid, period_name: own.period_name, start_date: own.start_date, end_date: own.end_date,
        folder_year: own.folder_year ?? null, is_current: false, is_reference: true,
      }).returning('id');
      periodId = Number((ins as { id: number }).id);
    }
    const target = {
      periodId, clientId, deviceId: 0, deviceName: 'firm server', userId, checkoutId: null, fresh: true, baseline: null,
    };
    let staged: Awaited<ReturnType<typeof stageAttachmentFiles>> | null = null;
    try {
      staged = await stageAttachmentFiles(tables, files, target);
      const docMap = staged.docMap;
      const outcome = await db.transaction(async (trx) => {
        if (made) await trx('periods').where({ id: periodId }).update({ is_reference: false });
        return mergePeriod(trx, target, tables, manifest, docMap);
      });
      await dropReplacedDocuments(outcome.replacedDocs);
      res.json({ data: { mode: 'merged', clientId, periodId, ...outcome.result }, error: null });
    } catch (err) {
      if (staged) await removeDocuments(staged.created);
      if (made) await db('periods').where({ id: periodId }).delete().catch(() => undefined);
      throw asSyncError(err);
    }
  } catch (err: unknown) {
    if (err instanceof SyncJobError) {
      refuse(res, err.code === 'SYNC_SCHEMA_MISMATCH' ? 409 : 400, err.code, err.message);
    } else {
      sendServerError(res, err, 'desktop-sync/import');
    }
  } finally {
    remove();
  }
});
