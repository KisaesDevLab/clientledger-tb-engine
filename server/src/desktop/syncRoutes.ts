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
//                                           sync_uids; one here gets the period merged in.
//                                           With `expectStamp` (the server's pull stamp) the
//                                           period must stamp the same once opened, or
//                                           nothing is kept (D2.2's tie-out)
//   POST /desktop/sync/periods/:id/changes  what changed in a period since a pulled archive
//                                           (the Send back summary, D2.5)
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
import type { Knex } from 'knex';
import multer from 'multer';
import { db } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { createBackup, readManifest, readZipContents, restoreAsNew } from '../routes/backup';
import { BackupRefusal, FORMAT_VERSION, appliedMigrations, checkArchive, syncManifestProblem } from '../lib/backupManifest';
import { loadPeriodStampInput, stampPeriod } from '../lib/sync/periodStampLoad';
import { STAMP_TABLES } from '../lib/sync/periodStamp';
import { archiveInput, tableChanges } from './syncChanges';
import { SyncJobError } from '../lib/sync/jobs';
import { MAX_UPLOAD_BYTES } from '../lib/sync/uploads';
import { asSyncError, dropReplacedDocuments, mergePeriod, readSendBack, removeDocuments, stageAttachmentFiles } from '../lib/sync/mergePeriod';
import { placeFiles } from './clientFiles';
import { currentUserId } from './currentUser';

export const desktopAppSyncRouter = Router();

const refuse = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ data: null, error: { code, message } });
};

/**
 * Make an archive in a temp folder and stream it back to the app; the
 * folder is removed once sent, or when making it failed.
 */
async function sendArchive(
  res: Response,
  make: (outDir: string) => Promise<{ filename: string; storage_local?: string | null }>,
): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cltb-sync-'));
  const drop = () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  let made: { filename: string; storage_local?: string | null };
  try {
    made = await make(dir);
  } catch (err) {
    await drop();
    throw err;
  }
  res.download(made.storage_local!, made.filename, () => { void drop(); });
}

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
    const periods = (await db('periods').where({ is_reference: false }).orderBy('id')
      .select('id', 'client_id', 'sync_uid')) as Array<{ id: number; client_id: number; sync_uid: string }>;
    const byClient = new Map<number, Array<{ periodId: number; periodUid: string }>>();
    for (const p of periods) {
      const list = byClient.get(p.client_id) ?? [];
      list.push({ periodId: p.id, periodUid: p.sync_uid });
      byClient.set(p.client_id, list);
    }
    res.json({
      data: clients.map((c) => ({ clientId: c.id, clientUid: c.sync_uid, periods: byClient.get(c.id) ?? [] })),
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
      .first('p.client_id', 'p.sync_uid as period_uid', 'p.is_reference', 'c.sync_uid as client_uid');
    if (!period || period.is_reference) {
      refuse(res, 404, 'NOT_FOUND', 'No such period.');
      return;
    }
    await sendArchive(res, async (outDir) => {
      let stamp: string | null = null;
      const made = await createBackup('period', {
        clientId: period.client_id,
        periodId,
        includeFiles: true,
        outDir,
        recordHistory: false,
        manifestExtra: async (trx) => {
          stamp = await stampPeriod(trx, periodId);
          // The server's merge refuses a send-back without these (whole cents
          // as text, the same sum as mergePeriod's own check after the merge).
          const sums = await trx('v_adjusted_trial_balance').where({ period_id: periodId })
            .sum({ d: 'book_adjusted_debit', c: 'book_adjusted_credit' }).first();
          const totals = { bookDebit: String(sums?.d ?? 0), bookCredit: String(sums?.c ?? 0) };
          return { sync: { periodUid: period.period_uid, clientUid: period.client_uid, stamp, checkoutId, stampAtPull, totals } };
        },
      }, currentUserId());
      res.setHeader('X-Period-Stamp', stamp ?? '');
      return made;
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
    await sendArchive(res, (outDir) => createBackup('client', { clientId, outDir, recordHistory: false }, currentUserId()));
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/export-client');
  }
});

const pulledUpload = multer({
  dest: path.join(os.tmpdir(), 'cltb-sync-import'),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

const SCHEMA_TEXT = 'This period was made by a different version of Vibe Trial Balance. Update the older one, then open it again.';

/**
 * Upstream's merge words its refusals for the server receiving a send-back
 * ("locked on the server", "send it again", "tell your administrator");
 * here the desktop is receiving the firm server's period, so they are said
 * from this side. Codes stay as they are.
 */
function desktopSide(err: unknown): unknown {
  if (!(err instanceof SyncJobError)) return err;
  const unchanged = 'Nothing on this computer was changed.';
  const words: Record<string, string> = {
    SYNC_SCHEMA_MISMATCH: SCHEMA_TEXT,
    PERIOD_LOCKED: `This period is locked on this computer. Unlock it here, then open it from the firm server again. ${unchanged}`,
    SYNC_UID_EXISTS: `Part of this period belongs to another client on this computer, so it was not opened. ${unchanged}`,
    SYNC_DUPLICATE_IMPORT: `A bank transaction in this period is already on this computer in another period. ${unchanged}`,
    SYNC_DELETED_ON_SERVER: `The period uses something that was deleted on this computer. ${unchanged}`,
    SYNC_ARCHIVE_CONFLICT: `The period from the firm server conflicts with what is on this computer. ${unchanged}`,
    SYNC_MERGE_MISMATCH: `The period would not have matched the firm server's once opened here. ${unchanged} Open it again.`,
    SYNC_TOTALS_MISMATCH: `The trial balance totals would not have matched the firm server's. ${unchanged} Open it again.`,
  };
  const text = words[err.code] ?? `The period from the firm server could not be opened here (${err.message}) ${unchanged}`;
  return new SyncJobError(err.code, text);
}

/** The uids a pulled archive names (nothing checked yet). */
async function namedUids(file: string): Promise<{ periodUid: string; clientUid: string }> {
  let manifest: Record<string, unknown>;
  try {
    manifest = await readManifest(file);
  } catch {
    throw new SyncJobError('SYNC_ARCHIVE_INVALID', 'The file is not a Vibe Trial Balance archive.');
  }
  const sync = (manifest.sync ?? {}) as Record<string, unknown>;
  if (manifest.backupLevel !== 'period' || typeof sync.periodUid !== 'string' || typeof sync.clientUid !== 'string') {
    throw new SyncJobError('SYNC_ARCHIVE_INVALID', 'The file is not a period pulled from a firm server.');
  }
  return { periodUid: sync.periodUid, clientUid: sync.clientUid };
}

/**
 * A new client's archive, checked as `readSendBack` checks a merge's (it
 * keeps only the period's tables, so it is not used for this one).
 */
async function checkedForNewClient(file: string): Promise<Record<string, unknown>> {
  const manifest = await readManifest(file);
  const problem = syncManifestProblem(manifest);
  if (problem) throw new SyncJobError('SYNC_ARCHIVE_INVALID', problem);
  try {
    await checkArchive(file, manifest, db);
  } catch (err: unknown) {
    if (err instanceof BackupRefusal) throw new SyncJobError(err.code === 'BACKUP_DAMAGED' ? 'SYNC_ARCHIVE_DAMAGED' : 'SYNC_SCHEMA_MISMATCH', err.message);
    throw err;
  }
  const applied = await appliedMigrations(db);
  if (manifest.schemaVersion !== applied[applied.length - 1]) throw new SyncJobError('SYNC_SCHEMA_MISMATCH', SCHEMA_TEXT);
  return manifest;
}

desktopAppSyncRouter.post('/desktop/sync/import', pulledUpload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  const upload = (req as AuthRequest & { file?: Express.Multer.File }).file;
  if (!upload) {
    refuse(res, 400, 'VALIDATION_ERROR', 'file is needed.');
    return;
  }
  const expectStamp = typeof (req.body ?? {}).expectStamp === 'string' && req.body.expectStamp ? String(req.body.expectStamp) : null;
  // Inside the transaction, so a period that would not match is never kept.
  const tieOut = async (trx: Knex.Transaction, periodId: number): Promise<void> => {
    if (expectStamp === null) return;
    const here = await stampPeriod(trx, periodId);
    if (here !== expectStamp) {
      throw new SyncJobError('SYNC_STAMP_MISMATCH', "The period would not have matched the firm server's once opened here, so it was not kept. Nothing on this computer was changed. Open it again.");
    }
  };
  try {
    const { periodUid, clientUid } = await namedUids(upload.path);
    // The desktop's one user, as the session knows it: the desktop routes
    // run without authMiddleware, so req.user is never set here.
    const userId = currentUserId();
    if (userId == null) {
      refuse(res, 503, 'NOT_READY', 'The engine is still starting. Try again in a moment.');
      return;
    }
    const client = await db('clients').where({ sync_uid: clientUid }).first('id');
    if (!client) {
      // QS2: not on this computer: a new client, keeping its sync_uids.
      const manifest = await checkedForNewClient(upload.path);
      const tables = await readZipContents(upload.path, 5000);
      const r = await db.transaction(async (trx) => {
        const restored = await restoreAsNew(tables, trx, false, { keepName: true, untrusted: true });
        // The period restored from this archive, by the restore's own map (not
        // by uid: a uid already held here is given a new one on restore).
        const newPeriodId = restored.idMappings.periods?.[Number(manifest.periodId)];
        const c = await trx('clients').where({ id: restored.newClientId }).first('sync_uid');
        const p = newPeriodId ? await trx('periods').where({ id: newPeriodId }).first('sync_uid') : undefined;
        // Both must keep the firm server's uids, or a later send-back would
        // go to the wrong place: rolled back before any file is placed.
        if (c?.sync_uid !== clientUid || p?.sync_uid !== periodUid) {
          throw new SyncJobError('SYNC_UID_TAKEN', 'Part of this client is already on this computer under another client, so it was not opened again. Open that client instead.');
        }
        await tieOut(trx, Number(newPeriodId));
        return { newClientId: restored.newClientId, idMappings: restored.idMappings, periodId: Number(newPeriodId) };
      });
      const docs = Object.fromEntries(Object.entries(r.idMappings.client_documents ?? {}).map(([k, v]) => [k, Number(v)]));
      const files = await placeFiles(db, upload.path, manifest, r.newClientId, docs);
      res.json({
        data: { mode: 'new', clientId: r.newClientId, periodId: r.periodId, filesPlaced: files.placed, filesNotPlaced: files.notPlaced, stamp: await stampPeriod(db, r.periodId) },
        error: null,
      });
      return;
    }
    // QS2: on this computer: the period merged in, made first when it is new
    // here, as upstream's POST /sync/clients/:uid/periods/push does.
    const clientId = Number(client.id);
    const { tables, manifest, files } = await readSendBack(upload.path, { periodUid, clientUid, checkoutId: null })
      .catch((err: unknown) => { throw desktopSide(err); });
    const own = ((tables.periods ?? []) as Array<Record<string, unknown>>).find((p) => Number(p.id) === Number(manifest.periodId));
    if (!own) throw new SyncJobError('SYNC_ARCHIVE_INVALID', "The archive does not carry its own period's row.");
    const existing = await db('periods').where({ sync_uid: periodUid }).first('id', 'client_id', 'is_reference');
    if (existing && Number(existing.client_id) !== clientId) {
      throw new SyncJobError('SYNC_PERIOD_ELSEWHERE', 'This period belongs to another client on this computer.');
    }
    // New here, or only a reference so far: filled in by the merge.
    const fill = !existing || existing.is_reference;
    if (fill) {
      const overlap = await db('periods').where({ client_id: clientId, is_reference: false })
        .where('start_date', '<=', own.end_date as string).where('end_date', '>=', own.start_date as string).first('period_name');
      if (overlap) throw new SyncJobError('PERIOD_OVERLAPS', `Its dates overlap "${overlap.period_name}" on this computer.`);
    }
    let periodId = existing ? Number(existing.id) : 0;
    if (!periodId) {
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
      const { docMap } = staged;
      const outcome = await db.transaction(async (trx) => {
        if (fill) {
          await trx('periods').where({ id: periodId })
            .update({ is_reference: false, period_name: own.period_name, start_date: own.start_date, end_date: own.end_date });
        }
        const merged = await mergePeriod(trx, target, tables, manifest, docMap);
        await tieOut(trx, periodId);
        return merged;
      });
      await dropReplacedDocuments(outcome.replacedDocs);
      res.json({ data: { mode: 'merged', clientId, periodId, ...outcome.result }, error: null });
    } catch (err) {
      if (staged) await removeDocuments(staged.created);
      if (!existing) await db('periods').where({ id: periodId }).delete().catch(() => undefined);
      throw desktopSide(asSyncError(err));
    }
  } catch (err: unknown) {
    if (err instanceof SyncJobError) {
      refuse(res, err.code === 'SYNC_SCHEMA_MISMATCH' ? 409 : 400, err.code, err.message);
    } else {
      sendServerError(res, err, 'desktop-sync/import');
    }
  } finally {
    fs.promises.unlink(upload.path).catch(() => undefined);
  }
});

// ---- What changed since the pull (the Send back summary, D2.5) ----------

type Rows = Record<string, unknown>[];
const tableRows = (tables: Record<string, unknown[]>, t: string): Rows => (tables[t] ?? []) as Rows;

/**
 * `{ file }` (the archive the period was pulled as, kept by the app) →
 * `{ tables: { <table>: { added, removed, changed } }, accountsAdded,
 * otherDocuments, totals }`: what a send-back would carry, for the owner to
 * read first. Read only.
 */
desktopAppSyncRouter.post('/desktop/sync/periods/:id/changes', pulledUpload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  const upload = (req as AuthRequest & { file?: Express.Multer.File }).file;
  const id = Number(req.params.id);
  if (!upload || !Number.isInteger(id) || id <= 0) {
    refuse(res, 400, 'VALIDATION_ERROR', 'A period id and the pulled archive (file) are needed.');
    if (upload) fs.promises.unlink(upload.path).catch(() => undefined);
    return;
  }
  try {
    const manifest = await readManifest(upload.path).catch(() => null);
    if (!manifest || manifest.backupLevel !== 'period') {
      refuse(res, 400, 'SYNC_ARCHIVE_INVALID', 'The file is not a period pulled from a firm server.');
      return;
    }
    const tables = await readZipContents(upload.path, 5000);
    const after = await loadPeriodStampInput(db, id);
    if (!after) {
      refuse(res, 404, 'NOT_FOUND', 'No such period.');
      return;
    }
    const before = archiveInput(tables as Record<string, unknown[]>, Number(manifest.periodId));
    const changes = Object.fromEntries(STAMP_TABLES.map((t) => [t, tableChanges(before, after, t)]));
    const period = await db('periods').where({ id }).first('client_id');
    const known = new Set(tableRows(tables as Record<string, unknown[]>, 'chart_of_accounts').map((r) => String(r.sync_uid)));
    const accounts = (await db('chart_of_accounts').where({ client_id: period.client_id }).orderBy('account_number')
      .select('sync_uid', 'account_number')) as Array<{ sync_uid: string; account_number: string }>;
    const attached = new Set(((after.rows.lead_sheet_attachments ?? []) as Rows).map((a) => Number(a.document_id)));
    const docs = (await db('client_documents').where({ client_id: period.client_id }).pluck('id')) as number[];
    const sums = await db('v_adjusted_trial_balance').where({ period_id: id })
      .sum({ d: 'book_adjusted_debit', c: 'book_adjusted_credit' }).first();
    res.json({
      data: {
        tables: changes,
        accountsAdded: accounts.filter((a) => !known.has(String(a.sync_uid))).map((a) => a.account_number),
        otherDocuments: docs.filter((d) => !attached.has(Number(d))).length,
        totals: { bookDebit: String(sums?.d ?? 0), bookCredit: String(sums?.c ?? 0) },
      },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/changes');
  } finally {
    fs.promises.unlink(upload.path).catch(() => undefined);
  }
});
