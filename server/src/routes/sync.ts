// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Desktop sync S2: pairing and the device routes.
 *
 *   POST /api/v1/sync/pair          public: a one-time code → a device token
 *   GET  /api/v1/sync/me            the device and the user it acts as
 *   GET  /api/v1/sync/clients       the clients a paired desktop may open (S3 widens it)
 *
 *   POST   /api/v1/desktop-sync/codes          (signed in) a code to pair a desktop
 *   GET    /api/v1/desktop-sync/devices        (signed in) my devices; an admin, everyone's with ?all=1
 *   DELETE /api/v1/desktop-sync/devices/:id    (signed in) revoke mine; an admin, anyone's
 *
 * A code is made from a signed-in session, so pairing works however that
 * session was made (password, passkey, single sign-on, `oidc_only` too): the
 * desktop never signs in itself.
 */

import { Router, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { authMiddleware, blockReviewerWrites, type AuthRequest } from '../middleware/auth';
import { logAudit } from '../lib/periodGuard';
import { sendServerError } from '../lib/safeError';
import {
  CODE_TTL_MS, formatCode, isDeviceToken, newDeviceToken, newPairingCode, normaliseCode, sha256, tidyDeviceName,
} from '../lib/sync/deviceTokens';
import { syncAuthMiddleware, type SyncRequest } from '../lib/sync/syncAuth';
import { releaseDeviceHolds } from '../lib/sync/deviceRevoke';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { createBackup, readManifest, readZipContents, restoreAsNew } from './backup';
import { currentStampFor } from '../lib/leadSheetStamp';
import { BackupRefusal, FORMAT_VERSION, appliedMigrations, checkArchive, syncManifestProblem } from '../lib/backupManifest';
import { checkedOutBy } from '../lib/periodGuard';
import { stampPeriod } from '../lib/sync/periodStampLoad';
import { SYNC_JOB_DIR, SyncJobError, assertDiskRoom, startJob } from '../lib/sync/jobs';
import { checkoutApi, checkoutWarnDays, daysOut, isoDate } from '../lib/sync/checkouts';
import { MAX_UPLOAD_BYTES, UploadError, joinState, openUpload, partBytes, putPart, receivedParts, startCompleteUpload, startUpload } from '../lib/sync/uploads';
import { asSyncError, dropReplacedDocuments, mergePeriod, readBaseline, readSendBack, removeDocuments, stageAttachmentFiles, type PullBaseline } from '../lib/sync/mergePeriod';
import { confineNewClient } from '../lib/sync/newClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const APP_VERSION = (require('../../package.json') as { version: string }).version;

const bad = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ data: null, error: { code, message } });
};

/** Live check-outs one device may hold (security review: one device freezing every period). */
const MAX_CHECKOUTS_PER_DEVICE = 25;

/** A job result as the desktop sees it: the pull's baseline is the server's own record. */
function withoutBaseline(result: Record<string, unknown>): Record<string, unknown> {
  const { baseline: _b, ...rest } = result;
  void _b;
  return rest;
}

/**
 * The server's record of this device's pull a send-back started from (by its
 * check-out, or by the stamp it pulled), or of its last pull of the client
 * (a new period). Null when there is none: client-level rows are then treated
 * as changed on the server (SQ3 keeps the server's and lists the difference).
 */
async function findBaseline(
  deviceId: number,
  clientId: number,
  by: { periodId?: number; checkoutId?: number; stamp?: string },
): Promise<PullBaseline | null> {
  const q = db('sync_jobs').where({ kind: 'pull', device_id: deviceId, state: 'done', client_id: clientId });
  if (by.periodId !== undefined) q.where({ period_id: by.periodId });
  if (by.checkoutId !== undefined) q.whereRaw("(result->>'checkoutId')::int = ?", [by.checkoutId]);
  if (by.stamp !== undefined) q.whereRaw("result->>'stamp' = ?", [by.stamp]);
  const row = await q.orderBy('created_at', 'desc').first('result');
  const b = (row?.result as { baseline?: PullBaseline } | undefined)?.baseline;
  return b ?? null;
}

const CODE_REFUSED = 'That code is not right or has expired. Make a new one in Vibe Trial Balance › Settings › Desktop sync.';

/**
 * Pairing is public: 10 failed tries per 15 minutes per ADDRESS. Not `rateLimitKey`,
 * which groups by an unverified JWT claim: on a public route a guesser could
 * send a made-up token per request and get a fresh bucket each time.
 */
const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator groups an IPv6 address by its /56, so a guesser cannot
  // rotate through the addresses of one network for fresh buckets.
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown')}`,
  // Guesses are what it is for: a code that pairs does not use up a try.
  skipSuccessfulRequests: true,
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many pairing attempts. Wait a few minutes and try again.' } },
});

// ───────────────────────────────────────────────────────── /api/v1/sync

export const syncRouter = Router();

syncRouter.post('/pair', pairLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as { code?: unknown; deviceName?: unknown };
  const code = typeof body.code === 'string' ? normaliseCode(body.code) : null;
  const name = tidyDeviceName(body.deviceName);
  if (!name) {
    bad(res, 400, 'VALIDATION_ERROR', 'Give this computer a name (up to 100 characters).');
    return;
  }
  if (!code) {
    bad(res, 400, 'SYNC_CODE_INVALID', CODE_REFUSED);
    return;
  }
  try {
    const result = await db.transaction(async (trx) => {
      // One use: the row is locked, so two desktops typing the same code
      // cannot both pair.
      const row = await trx('sync_pairing_codes')
        .where({ code_hash: sha256(code) })
        .whereNull('used_at')
        .where('expires_at', '>', trx.fn.now())
        .forUpdate()
        .first('id', 'user_id');
      if (!row) return null;
      const user = await trx('app_users').where({ id: row.user_id, is_active: true }).first('id', 'username', 'display_name', 'role');
      if (!user) return null;
      const token = newDeviceToken();
      const [device] = await trx('sync_devices')
        .insert({ user_id: user.id, name, token_hash: sha256(token) })
        .returning(['id', 'name', 'created_at']);
      await trx('sync_pairing_codes').where({ id: row.id }).update({ used_at: trx.fn.now(), device_id: device.id });
      await logAudit({
        userId: user.id, periodId: null, entityType: 'sync_device', entityId: device.id, action: 'pair',
        description: `Paired desktop "${name}"`,
      }, trx);
      return { token, device, user };
    });
    if (!result) {
      bad(res, 400, 'SYNC_CODE_INVALID', CODE_REFUSED);
      return;
    }
    res.status(201).json({
      data: {
        token: result.token,
        device: { id: result.device.id, name: result.device.name, createdAt: result.device.created_at },
        user: { username: result.user.username, displayName: result.user.display_name ?? null, role: result.user.role },
        server: { appVersion: APP_VERSION },
      },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'sync/pair');
  }
});

/**
 * Before the device check: 100 calls with an UNKNOWN token per 15 minutes
 * per address. A device token is checked by a database lookup, and the
 * global /api/ limiter skips anything shaped like one, so made-up tokens
 * would be unlimited otherwise. A revoked or expired desktop that keeps
 * retrying does not count (it would lock out the whole office).
 */
syncRouter.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `sync-fail:${ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown')}`,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  skipSuccessfulRequests: true,
  // A live desktop's token is never held back by refused calls from the same
  // address; a made-up, revoked or expired one counts.
  skip: async (req) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
    return isDeviceToken(token) && !!(await db('sync_devices').where({ token_hash: sha256(token) }).whereNull('revoked_at').first('id'));
  },
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many refused calls from this address. Wait a few minutes.' } },
}));

// Everything else under /api/v1/sync is a paired device's.
syncRouter.use(syncAuthMiddleware);

/**
 * Per device: 1200 calls per 15 minutes (job polling included). The global
 * /api/ limiter skips device calls (app.ts), so one office address with
 * several desktops is not one shared bucket.
 */
syncRouter.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `sync-device:${(req as SyncRequest).syncDevice?.id ?? 'none'}`,
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'This computer is syncing too often. Wait a few minutes.' } },
}));

syncRouter.get('/me', (req: SyncRequest, res: Response): void => {
  res.json({
    data: {
      device: req.syncDevice,
      // The id a desktop writes into the user columns of rows it makes (a
      // send-back keeps user ids this server has; the desktop's own mean nothing here).
      user: { id: req.user!.userId, username: req.user!.username, role: req.user!.role },
      server: { appVersion: APP_VERSION },
    },
    error: null,
  });
});

/** What this server speaks; the desktop checks it before anything else. */
syncRouter.get('/capabilities', async (_req: SyncRequest, res: Response): Promise<void> => {
  try {
    const applied = await appliedMigrations(db);
    res.json({
      data: {
        formatVersions: [FORMAT_VERSION],
        schemaVersion: applied[applied.length - 1] ?? null,
        appVersion: APP_VERSION,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        partBytes: partBytes(),
        features: ['checkout-v1', 'period-merge-v1'],
        checkoutWarnDays: await checkoutWarnDays(),
      },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'sync/capabilities');
  }
});

const clientListSchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  active: z.enum(['1', '0', 'all']).default('1'),
});

syncRouter.get('/clients', async (req: SyncRequest, res: Response): Promise<void> => {
  // Client names leave the server: audited (syncAuth.ts).
  res.locals.syncAudit = true;
  const q = clientListSchema.safeParse(req.query);
  if (!q.success) {
    bad(res, 400, 'VALIDATION_ERROR', 'search, limit (1-500), offset and active (1, 0, all) are the only options.');
    return;
  }
  try {
    const base = db('clients');
    if (q.data.active !== 'all') base.where({ is_active: q.data.active === '1' });
    if (q.data.search) {
      const like = `%${q.data.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      base.where((w) => w.whereILike('name', like).orWhereILike('client_code', like));
    }
    const [{ n }] = (await base.clone().count({ n: '*' })) as Array<{ n: string | number }>;
    const rows = await base
      .orderBy('name')
      .orderBy('id')
      .limit(q.data.limit)
      .offset(q.data.offset)
      .select('sync_uid', 'name', 'client_code', 'entity_type', 'is_active');
    res.json({ data: rows, error: null, meta: { count: rows.length, total: Number(n), limit: q.data.limit, offset: q.data.offset } });
  } catch (err: unknown) {
    sendServerError(res, err, 'sync/clients');
  }
});

const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

syncRouter.get('/clients/:uid/periods', async (req: SyncRequest, res: Response): Promise<void> => {
  res.locals.syncAudit = true;
  const uid = String(req.params.uid);
  if (!isUuid(uid)) {
    bad(res, 404, 'NOT_FOUND', 'No client with that id on this server.');
    return;
  }
  try {
    const client = await db('clients').where({ sync_uid: uid }).first('id');
    if (!client) {
      bad(res, 404, 'NOT_FOUND', 'No client with that id on this server.');
      return;
    }
    // A reference period (desktop sync) holds no data here: not offered.
    const periods = (await db('periods')
      .where({ client_id: client.id, is_reference: false })
      .orderBy('end_date', 'desc')
      .orderBy('id', 'desc')
      .select('id', 'sync_uid', 'period_name', 'start_date', 'end_date', 'locked_at', 'is_current')) as Array<Record<string, unknown> & { id: number }>;
    const warnDays = await checkoutWarnDays();
    const out = [];
    for (const p of periods) {
      const holder = await checkedOutBy(db, p.id);
      out.push({
        sync_uid: p.sync_uid,
        period_name: p.period_name,
        start_date: isoDate(p.start_date),
        end_date: isoDate(p.end_date),
        locked_at: p.locked_at,
        is_current: p.is_current,
        checkout: holder ? checkoutApi(holder, warnDays, req.syncDevice!.id) : null,
        stamp: await stampPeriod(db, p.id),
      });
    }
    res.json({ data: out, error: null, meta: { count: out.length, checkoutWarnDays: warnDays } });
  } catch (err: unknown) {
    sendServerError(res, err, 'sync/periods');
  }
});

/**
 * Pull a period: `{ checkout: true }` holds it for this device (SQ2) so the
 * web app and MCP cannot change it until it is sent back or released; a
 * reviewer, or `checkout: false`, takes a read-only copy. Returns a job; the
 * archive is at `GET /jobs/:id/archive` once the job is done. Mounted before
 * the reviewer write block: a reviewer may pull, without a check-out (SQ5).
 */
syncRouter.post('/periods/:uid/pull', async (req: SyncRequest, res: Response): Promise<void> => {
  const uid = String(req.params.uid);
  const body = z.object({ checkout: z.boolean().default(true) }).safeParse(req.body ?? {});
  if (!body.success) {
    bad(res, 400, 'VALIDATION_ERROR', '`checkout` must be true or false.');
    return;
  }
  const wantCheckout = body.data.checkout;
  if (wantCheckout && req.user!.role === 'reviewer') {
    bad(res, 403, 'READ_ONLY', 'A reviewer can pull a period to read it, not check it out. Pull it with check-out off.');
    return;
  }
  if (!isUuid(uid)) {
    bad(res, 404, 'NOT_FOUND', 'No period with that id on this server.');
    return;
  }
  try {
    const period = await db('periods as p')
      .join('clients as c', 'c.id', 'p.client_id')
      .where('p.sync_uid', uid)
      .first('p.id', 'p.client_id', 'p.locked_at', 'p.is_reference', 'c.sync_uid as client_uid');
    if (!period || period.is_reference) {
      bad(res, 404, 'NOT_FOUND', 'No period with that id on this server.');
      return;
    }
    const device = req.syncDevice!;
    let checkoutId: number | null = null;
    let checkoutCreated = false;
    if (wantCheckout) {
      if (period.locked_at) {
        bad(res, 409, 'PERIOD_LOCKED', 'This period is locked on the server. Pull it with check-out off to read it, or ask an admin to unlock it.');
        return;
      }
      const taken = await db.transaction(async (trx) => {
        // The period row lock orders this against a web write's guard, and a
        // lock taken meanwhile is seen here (code review).
        const now = await trx('periods').where({ id: period.id }).forUpdate().first('locked_at', 'is_reference');
        if (!now || now.is_reference) return { gone: true };
        if (now.locked_at) return { locked: true };
        const holder = await checkedOutBy(trx, period.id);
        if (holder && holder.deviceId !== device.id) return { holder };
        if (holder) return { id: holder.id, created: false };
        const held = await trx('period_checkouts').where({ device_id: device.id }).whereNull('released_at').count({ n: '*' }).first();
        if (Number(held?.n ?? 0) >= MAX_CHECKOUTS_PER_DEVICE) return { tooMany: true };
        const [row] = await trx('period_checkouts')
          .insert({ period_id: period.id, device_id: device.id, user_id: req.user!.userId })
          .returning('id');
        await logAudit({ userId: req.user!.userId, periodId: period.id, entityType: 'period_checkout', entityId: (row as { id: number }).id, action: 'checkout', description: `Checked out to desktop "${device.name}"` }, trx);
        return { id: (row as { id: number }).id, created: true };
      });
      if ('gone' in taken) {
        bad(res, 404, 'NOT_FOUND', 'No period with that id on this server.');
        return;
      }
      if ('locked' in taken) {
        bad(res, 409, 'PERIOD_LOCKED', 'This period is locked on the server. Pull it with check-out off to read it, or ask an admin to unlock it.');
        return;
      }
      if ('tooMany' in taken) {
        bad(res, 429, 'SYNC_TOO_MANY_CHECKOUTS', `This computer already holds ${MAX_CHECKOUTS_PER_DEVICE} periods. Send some back first.`);
        return;
      }
      if ('holder' in taken && taken.holder) {
        bad(res, 409, 'PERIOD_CHECKED_OUT', `This period is checked out to ${taken.holder.user} on "${taken.holder.device}" since ${taken.holder.since.toISOString().slice(0, 10)}. Pull it with check-out off to read it.`);
        return;
      }
      checkoutId = (taken as { id: number }).id;
      checkoutCreated = (taken as { created: boolean }).created;
    }
    // Only a check-out this call took is undone on failure: a re-pull keeps
    // the hold the desktop already had (it may hold unsent work).
    const createdCheckout = checkoutCreated ? checkoutId : null;
    assertDiskRoom(0);
    const jobId = await startJob(
      { kind: 'pull', deviceId: device.id, userId: req.user!.userId, clientId: period.client_id, periodId: period.id, checkoutId, checkoutCreated },
      async (id) => {
        const dir = path.join(SYNC_JOB_DIR, id);
        fs.mkdirSync(dir, { recursive: true });
        // Set inside the archive's snapshot (manifestExtra); widened so TS does not narrow it to null.
        let stamp = null as string | null;
        let pulledAt = new Date();
        let baseline = null as PullBaseline | null;
        const made = await createBackup('period', {
          clientId: period.client_id,
          periodId: period.id,
          includeFiles: true,
          outDir: dir,
          recordHistory: false,
          manifestExtra: async (trx) => {
            pulledAt = new Date((await trx.raw('SELECT now() AS t')).rows[0].t);
            stamp = await stampPeriod(trx, period.id);
            // What the send-back is compared with (SQ3), kept here, not trusted from the archive.
            baseline = await readBaseline(trx, period.client_id);
            return { sync: { periodUid: uid, clientUid: period.client_uid, stamp, checkoutId, pulledAt: pulledAt.toISOString(), deviceId: device.id } };
          },
        }, req.user!.userId);
        // Read inside the archive's snapshot: what the desktop now has, and when.
        if (checkoutId) await db('period_checkouts').where({ id: checkoutId }).update({ stamp_at_pull: stamp, pulled_at: pulledAt });
        return {
          result: { periodUid: uid, clientUid: period.client_uid, stamp, checkoutId, size: made.file_size, checksum: made.checksum, baseline },
          filePath: made.storage_local ?? undefined,
        };
      },
      // A pull that failed must not leave the period held.
      createdCheckout
        ? async () => {
          await db('period_checkouts').where({ id: createdCheckout }).whereNull('released_at')
            .update({ released_at: db.fn.now(), release_reason: 'The pull failed.' });
        }
        : undefined,
    );
    res.status(202).json({ data: { jobId, checkoutId }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'sync/pull');
  }
});

/** A job of this device's: its state, then its result or error. */
syncRouter.get('/jobs/:id', async (req: SyncRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!isUuid(id)) {
    bad(res, 404, 'NOT_FOUND', 'No such job.');
    return;
  }
  try {
    const job = await db('sync_jobs').where({ id, device_id: req.syncDevice!.id }).first();
    if (!job) {
      bad(res, 404, 'NOT_FOUND', 'No such job.');
      return;
    }
    res.json({
      data: {
        id: job.id, kind: job.kind, state: job.state, result: job.result ? withoutBaseline(job.result) : null, error: job.error ?? null,
        createdAt: job.created_at, finishedAt: job.finished_at, archiveReady: job.state === 'done' && !!job.file_path,
      },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'sync/jobs');
  }
});

/** The pulled period's .tbak, once the job is done (kept for a day). */
syncRouter.get('/jobs/:id/archive', async (req: SyncRequest, res: Response): Promise<void> => {
  res.locals.syncAudit = true;
  const id = String(req.params.id);
  if (!isUuid(id)) {
    bad(res, 404, 'NOT_FOUND', 'No such job.');
    return;
  }
  try {
    const job = await db('sync_jobs').where({ id, device_id: req.syncDevice!.id }).first('state', 'file_path');
    if (!job) {
      bad(res, 404, 'NOT_FOUND', 'No such job.');
      return;
    }
    if (job.state !== 'done') {
      bad(res, 409, 'SYNC_JOB_NOT_DONE', job.state === 'failed' ? 'This job failed; there is no archive.' : 'Not ready yet. Ask again in a moment.');
      return;
    }
    if (!job.file_path || !fs.existsSync(job.file_path)) {
      bad(res, 410, 'SYNC_ARCHIVE_GONE', 'This archive was kept for a day and has been deleted. Pull the period again.');
      return;
    }
    const size = fs.statSync(job.file_path).size;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(job.file_path)}"`);
    fs.createReadStream(job.file_path).on('error', (err) => {
      console.error('[sync] archive read failed', err.message);
      res.destroy(err);
    }).pipe(res);
  } catch (err: unknown) {
    sendServerError(res, err, 'sync/archive');
  }
});

// Writes from here on: a reviewer's device has none.
syncRouter.use(blockReviewerWrites);

const uploadFail = (res: Response, err: unknown, tag: string): void => {
  if (err instanceof UploadError) {
    bad(res, err.status, err.code, err.message);
    return;
  }
  sendServerError(res, err, tag);
};

/** Start a send-back upload: `{ size, sha256 }` → `{ uploadId, partBytes, parts }`. */
syncRouter.post('/uploads', async (req: SyncRequest, res: Response): Promise<void> => {
  const body = z.object({ size: z.number().int(), sha256: z.string().toLowerCase() }).safeParse(req.body ?? {});
  if (!body.success) {
    bad(res, 400, 'VALIDATION_ERROR', '`size` (bytes) and `sha256` (hex) are needed.');
    return;
  }
  try {
    res.status(201).json({ data: await startUpload(req.syncDevice!.id, req.user!.userId, body.data.size, body.data.sha256), error: null });
  } catch (err: unknown) {
    uploadFail(res, err, 'sync/uploads');
  }
});

/** One part, as raw bytes; sending a part again replaces it. */
syncRouter.put(
  '/uploads/:id/parts/:n',
  async (req: SyncRequest, res: Response): Promise<void> => {
    const id = String(req.params.id);
    if (!isUuid(id)) {
      bad(res, 404, 'NOT_FOUND', 'No such upload from this computer.');
      return;
    }
    try {
      const row = await openUpload(id, req.syncDevice!.id);
      // Streamed to disk as it arrives (not held in memory).
      const received = await putPart(row, Number(req.params.n), req);
      res.json({ data: { received }, error: null });
    } catch (err: unknown) {
      uploadFail(res, err, 'sync/uploads/part');
    }
  },
);

/** Which parts have arrived (to resume). */
syncRouter.get('/uploads/:id', async (req: SyncRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!isUuid(id)) {
    bad(res, 404, 'NOT_FOUND', 'No such upload from this computer.');
    return;
  }
  try {
    const row = await openUpload(id, req.syncDevice!.id, true);
    const join = joinState(id);
    res.json({
      data: { received: receivedParts(row), complete: !!row.completed_at, joining: join.joining, joinError: join.error, partBytes: row.part_bytes, size: Number(row.size) },
      error: null,
    });
  } catch (err: unknown) {
    uploadFail(res, err, 'sync/uploads/status');
  }
});

/**
 * Join the parts and check the SHA-256: 202, then poll `GET /uploads/:id`
 * until `complete` (or `joinError`). 200 when it is complete already.
 */
syncRouter.post('/uploads/:id/complete', async (req: SyncRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!isUuid(id)) {
    bad(res, 404, 'NOT_FOUND', 'No such upload from this computer.');
    return;
  }
  try {
    const row = await openUpload(id, req.syncDevice!.id, true);
    const state = startCompleteUpload(row);
    res.status(state.complete ? 200 : 202).json({ data: { uploadId: id, ...state }, error: null });
  } catch (err: unknown) {
    uploadFail(res, err, 'sync/uploads/complete');
  }
});

/**
 * Send a period back: `{ uploadId, checkoutId }` → 202 `{ jobId }`. The
 * upload must be complete and this device's; with a check-out it must be
 * the live one this device holds (released on success). Without one
 * (SQ2 off, or released by an admin) it is taken only if the period has
 * not changed since the pull (`manifest.sync.stampAtPull`).
 */
syncRouter.post('/periods/:uid/push', async (req: SyncRequest, res: Response): Promise<void> => {
  const uid = String(req.params.uid);
  const body = z.object({ uploadId: z.string().uuid(), checkoutId: z.number().int().positive().nullable().default(null) }).safeParse(req.body ?? {});
  if (!body.success) {
    bad(res, 400, 'VALIDATION_ERROR', '`uploadId` (a completed upload) is needed; `checkoutId` when the period is checked out.');
    return;
  }
  if (!isUuid(uid)) {
    bad(res, 404, 'NOT_FOUND', 'No period with that id on this server.');
    return;
  }
  try {
    const period = await db('periods').where({ sync_uid: uid }).first('id', 'client_id', 'locked_at', 'is_reference');
    if (!period || period.is_reference) {
      bad(res, 404, 'NOT_FOUND', 'No period with that id on this server.');
      return;
    }
    if (period.locked_at) {
      bad(res, 409, 'PERIOD_LOCKED', 'The period is locked on the server. An admin unlocks it, then send it again.');
      return;
    }
    const upload = await openUpload(body.data.uploadId, req.syncDevice!.id, true);
    if (!upload.completed_at || !upload.file_path) {
      bad(res, 409, 'SYNC_UPLOAD_INCOMPLETE', 'Complete the upload first.');
      return;
    }
    const device = req.syncDevice!;
    const target = {
      periodId: period.id as number, clientId: period.client_id as number, deviceId: device.id, deviceName: device.name,
      userId: req.user!.userId, checkoutId: body.data.checkoutId,
    };
    const filePath = upload.file_path;
    const jobId = await startJob(
      { kind: 'push', deviceId: device.id, userId: req.user!.userId, clientId: target.clientId, periodId: target.periodId, checkoutId: target.checkoutId },
      async () => {
        const uids = (await db('periods as p').join('clients as c', 'c.id', 'p.client_id').where('p.id', target.periodId)
          .first('p.sync_uid as period_uid', 'c.sync_uid as client_uid')) as { period_uid: string; client_uid: string };
        const { tables, manifest, files } = await readSendBack(filePath, { periodUid: uids.period_uid, clientUid: uids.client_uid, checkoutId: target.checkoutId });
        const stampAtPull = (manifest.sync as Record<string, unknown> | undefined)?.stampAtPull;
        const withBaseline = {
          ...target,
          baseline: await findBaseline(device.id, target.clientId, target.checkoutId !== null
            ? { periodId: target.periodId, checkoutId: target.checkoutId }
            : { periodId: target.periodId, stamp: typeof stampAtPull === 'string' ? stampAtPull : '-' }),
        };
        const staged = await stageAttachmentFiles(tables, files, withBaseline);
        let outcome;
        try {
          outcome = await db.transaction((trx) => mergePeriod(trx, withBaseline, tables, manifest, staged.docMap));
        } catch (err) {
          await removeDocuments(staged.created);
          throw asSyncError(err);
        }
        await dropReplacedDocuments(outcome.replacedDocs);
        return { result: outcome.result as unknown as Record<string, unknown> };
      },
    );
    // An upload is sent once, whatever the job's outcome.
    await db('sync_uploads').where({ id: upload.id }).update({ job_id: jobId });
    res.status(202).json({ data: { jobId }, error: null });
  } catch (err: unknown) {
    uploadFail(res, err, 'sync/push');
  }
});

/**
 * A period made on the desktop (S4 step 5): `{ uploadId }` → job. Its
 * `sync_uid` must be new here, or name a period that came along only as a
 * reference (filled in, flag cleared, SQ7); dates may not overlap another
 * period of the client. Then the same merge.
 */
syncRouter.post('/clients/:uid/periods/push', async (req: SyncRequest, res: Response): Promise<void> => {
  const clientUid = String(req.params.uid);
  const body = z.object({ uploadId: z.string().uuid() }).safeParse(req.body ?? {});
  if (!body.success || !isUuid(clientUid)) {
    bad(res, 400, 'VALIDATION_ERROR', '`uploadId` (a completed upload) is needed.');
    return;
  }
  try {
    const client = await db('clients').where({ sync_uid: clientUid }).first('id');
    if (!client) {
      bad(res, 404, 'NOT_FOUND', 'No client with that id on this server.');
      return;
    }
    const upload = await openUpload(body.data.uploadId, req.syncDevice!.id, true);
    if (!upload.completed_at || !upload.file_path) {
      bad(res, 409, 'SYNC_UPLOAD_INCOMPLETE', 'Complete the upload first.');
      return;
    }
    const device = req.syncDevice!;
    const filePath = upload.file_path;
    const clientId = client.id as number;
    const jobId = await startJob(
      { kind: 'push', deviceId: device.id, userId: req.user!.userId, clientId },
      async () => {
        const { tables, manifest, files } = await readSendBack(filePath, { periodUid: null, clientUid, checkoutId: null });
        const sync = manifest.sync as Record<string, unknown>;
        const own = ((tables.periods ?? []) as Array<Record<string, unknown>>).find((p) => Number(p.id) === Number(manifest.periodId));
        if (!own) throw new SyncJobError('SYNC_ARCHIVE_INVALID', "The archive does not carry its own period's row.");
        const existing = await db('periods').where({ sync_uid: sync.periodUid }).first('id', 'client_id', 'is_reference');
        if (existing && (!existing.is_reference || existing.client_id !== clientId)) {
          throw new SyncJobError('SYNC_PERIOD_EXISTS', 'This period is on the server already: send it back to it instead.');
        }
        const overlap = await db('periods').where({ client_id: clientId, is_reference: false })
          .where('start_date', '<=', own.end_date as string).where('end_date', '>=', own.start_date as string).first('period_name');
        if (overlap) throw new SyncJobError('PERIOD_OVERLAPS', `Its dates overlap "${overlap.period_name}" on the server.`);
        // Files are stored before the transaction, so the period must exist first; a
        // failure below removes it with everything else.
        let periodId = existing ? Number(existing.id) : 0;
        if (!periodId) {
          const [ins] = await db('periods').insert({
            client_id: clientId, sync_uid: sync.periodUid, period_name: own.period_name, start_date: own.start_date, end_date: own.end_date,
            folder_year: own.folder_year ?? null, is_current: false, is_reference: true,
          }).returning('id');
          periodId = Number((ins as { id: number }).id);
        }
        const target = {
          periodId, clientId, deviceId: device.id, deviceName: device.name, userId: req.user!.userId, checkoutId: null, fresh: true,
          // A new period: the client as this device last pulled any of its periods.
          baseline: await findBaseline(device.id, clientId, {}),
        };
        let staged: Awaited<ReturnType<typeof stageAttachmentFiles>> | null = null;
        try {
          staged = await stageAttachmentFiles(tables, files, target);
          const docMap = staged.docMap;
          const outcome = await db.transaction(async (trx) => {
            // Made as a reference so nothing can write to it meanwhile; filled in here.
            await trx('periods').where({ id: periodId }).update({ is_reference: false, period_name: own.period_name, start_date: own.start_date, end_date: own.end_date });
            return mergePeriod(trx, target, tables, manifest, docMap);
          });
          await dropReplacedDocuments(outcome.replacedDocs);
          return { result: { periodUid: sync.periodUid, ...(outcome.result as unknown as Record<string, unknown>) } };
        } catch (err) {
          if (staged) await removeDocuments(staged.created);
          if (!existing) await db('periods').where({ id: periodId }).delete().catch(() => undefined);
          throw asSyncError(err);
        }
      },
    );
    await db('sync_uploads').where({ id: upload.id }).update({ job_id: jobId });
    res.status(202).json({ data: { jobId }, error: null });
  } catch (err: unknown) {
    uploadFail(res, err, 'sync/push-period');
  }
});

/**
 * A client made on the desktop (S4 step 6): `{ uploadId }` of a client
 * archive → job. Restored as new, keeping its `sync_uid`s and its name
 * (no " (Restored)"); 409 CLIENT_EXISTS when its uid is here already. Its
 * document files are not placed (it has no workpaper folder yet).
 */
syncRouter.post('/clients/push', async (req: SyncRequest, res: Response): Promise<void> => {
  const body = z.object({ uploadId: z.string().uuid() }).safeParse(req.body ?? {});
  if (!body.success) {
    bad(res, 400, 'VALIDATION_ERROR', '`uploadId` (a completed upload) is needed.');
    return;
  }
  try {
    const upload = await openUpload(body.data.uploadId, req.syncDevice!.id, true);
    if (!upload.completed_at || !upload.file_path) {
      bad(res, 409, 'SYNC_UPLOAD_INCOMPLETE', 'Complete the upload first.');
      return;
    }
    const filePath = upload.file_path;
    const device = req.syncDevice!;
    const userId = req.user!.userId;
    // Everything that reads the archive runs in the job (it may be large).
    const jobId = await startJob(
      { kind: 'push', deviceId: device.id, userId, clientId: null },
      async () => {
        const manifest = await readManifest(filePath).catch(() => null);
        const problem = manifest ? syncManifestProblem(manifest) : 'The file sent is not a Vibe Trial Balance archive.';
        if (problem || !manifest) throw new SyncJobError('SYNC_ARCHIVE_INVALID', problem ?? 'Not an archive.');
        try {
          await checkArchive(filePath, manifest, db);
        } catch (err: unknown) {
          if (err instanceof BackupRefusal) throw new SyncJobError('SYNC_ARCHIVE_DAMAGED', err.message);
          throw err;
        }
        const applied = await appliedMigrations(db);
        if (manifest.schemaVersion !== applied[applied.length - 1]) {
          throw new SyncJobError('SYNC_SCHEMA_MISMATCH', 'This archive was made for a different version of the server. Update the desktop (or the server) so both match, then send it again.');
        }
        const tables = await readZipContents(filePath, 5000);
        const clientRow = ((tables.clients ?? []) as Array<Record<string, unknown>>)[0];
        if (manifest.backupLevel !== 'client' || !clientRow || typeof clientRow.sync_uid !== 'string') {
          throw new SyncJobError('SYNC_ARCHIVE_INVALID', 'The file sent is not a client archive.');
        }
        // Only what a client archive from a desktop may carry, and every user id the
        // sender's or none (security review).
        const sender = await db('app_users').where({ id: userId }).first('id', 'display_name', 'username');
        const out = await db.transaction(async (trx) => {
          // Two sends of one client wait for each other; the second finds the first.
          await trx.raw('SELECT pg_advisory_xact_lock(44, hashtext(?))', [String(clientRow.sync_uid)]);
          if (await trx('clients').where({ sync_uid: clientRow.sync_uid }).first('id')) {
            throw new SyncJobError('CLIENT_EXISTS', 'This client is on the server already: send its periods back to it instead.');
          }
          // A restore would quietly give a held uid a new one; a desktop's new client must not.
          for (const t of ['periods', 'chart_of_accounts', 'bank_transactions', 'fs_client_layouts']) {
            const uids = ((tables[t] ?? []) as Array<Record<string, unknown>>).map((r) => r.sync_uid).filter((u): u is string => typeof u === 'string');
            for (let k = 0; k < uids.length; k += 1000) {
              if (await trx(t).whereIn('sync_uid', uids.slice(k, k + 1000)).first('id')) {
                throw new SyncJobError('SYNC_UID_EXISTS', `Some of this client's ${t.replace(/_/g, ' ')} are on the server already under another client.`);
              }
            }
          }
          const allowedTables = confineNewClient(tables, { id: userId, name: String(sender?.display_name ?? sender?.username ?? '') });
          const r = await restoreAsNew(allowedTables, trx, true, { keepName: true, untrusted: true });
          // Its sign-offs are the sender's, at the balances it arrived with.
          const signs = (await trx('lead_sheet_signoffs as s').join('periods as p', 'p.id', 's.period_id').where('p.client_id', r.newClientId)
            .select('s.id', 's.period_id', 's.lead_sheet_id')) as Array<{ id: number; period_id: number; lead_sheet_id: number }>;
          for (const sg of signs) {
            await trx('lead_sheet_signoffs').where({ id: sg.id }).update({ balance_stamp: await currentStampFor(trx, sg.period_id, sg.lead_sheet_id) });
          }
          await logAudit({ userId, periodId: null, clientId: r.newClientId, entityType: 'client', entityId: r.newClientId, action: 'sync_create', description: `Client "${String(clientRow.name)}" sent from desktop "${device.name}"` }, trx);
          return r;
        });
        const files = Array.isArray(manifest.files) ? manifest.files.length : 0;
        return { result: { clientUid: clientRow.sync_uid, clientId: out.newClientId, filesNotPlaced: files } };
      },
    );
    await db('sync_uploads').where({ id: upload.id }).update({ job_id: jobId });
    res.status(202).json({ data: { jobId }, error: null });
  } catch (err: unknown) {
    uploadFail(res, err, 'sync/push-client');
  }
});

/** The holder gives a check-out back without sending anything. */
syncRouter.delete('/checkouts/:id', async (req: SyncRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    bad(res, 404, 'NOT_FOUND', 'No such check-out.');
    return;
  }
  try {
    const done = await db.transaction(async (trx) => {
      const row = await trx('period_checkouts').where({ id, device_id: req.syncDevice!.id }).whereNull('released_at').forUpdate().first('id', 'period_id');
      if (!row) return false;
      await trx('period_checkouts').where({ id }).update({ released_at: trx.fn.now(), released_by: req.user!.userId, release_reason: 'Given back by the desktop.' });
      await logAudit({ userId: req.user!.userId, periodId: row.period_id, entityType: 'period_checkout', entityId: id, action: 'release', description: `Check-out given back by desktop "${req.syncDevice!.name}"` }, trx);
      return true;
    });
    if (!done) {
      bad(res, 404, 'NOT_FOUND', 'This computer holds no such check-out.');
      return;
    }
    res.json({ data: { released: true }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'sync/checkouts');
  }
});

// ───────────────────────────────────────────────────────── /api/v1/desktop-sync

export const desktopSyncRouter = Router();
desktopSyncRouter.use(authMiddleware);

/**
 * GET /api/v1/desktop-sync/checkouts — the periods desktops hold: every one
 * for an admin (dashboard, stale warning), the user's own otherwise.
 */
desktopSyncRouter.get('/checkouts', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const q = db('period_checkouts as c')
      .join('periods as p', 'p.id', 'c.period_id')
      .join('clients as cl', 'cl.id', 'p.client_id')
      .join('sync_devices as d', 'd.id', 'c.device_id')
      .join('app_users as u', 'u.id', 'c.user_id')
      .whereNull('c.released_at')
      .orderBy('c.created_at')
      .select('c.id', 'c.created_at', 'p.id as period_id', 'p.period_name', 'cl.id as client_id', 'cl.name as client_name',
        'd.name as device', 'u.display_name', 'u.username');
    if (req.user!.role !== 'admin') q.where('c.user_id', req.user!.userId);
    const warnDays = await checkoutWarnDays();
    const rows = (await q) as Array<Record<string, unknown>>;
    res.json({
      data: rows.map((r) => {
        const since = new Date(r.created_at as string);
        const days = daysOut(since);
        return {
          id: r.id, periodId: r.period_id, periodName: r.period_name, clientId: r.client_id, clientName: r.client_name,
          user: (r.display_name as string | null) ?? r.username, device: r.device, since: since.toISOString(), days, stale: days >= warnDays,
        };
      }),
      error: null,
      meta: { count: rows.length, checkoutWarnDays: warnDays },
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/checkouts');
  }
});

desktopSyncRouter.post('/codes', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // A password reset ends the account's desktops; a session from before it
    // must not connect one again (an emailed reset leaves sessions working).
    const issued = (jwt.decode(req.headers.authorization?.slice(7) ?? '') as { iat?: number } | null)?.iat ?? 0;
    const user = await db('app_users').where({ id: req.user!.userId }).first('sync_reset_at');
    // `iat` is whole seconds: a session from the second of the reset counts as after it.
    if (user?.sync_reset_at && issued < Math.floor(new Date(user.sync_reset_at).getTime() / 1000)) {
      res.status(401).json({ data: null, error: { code: 'SIGN_IN_AGAIN', message: 'Your password was reset since you signed in. Sign in again to connect a desktop.' } });
      return;
    }
    const code = newPairingCode();
    const expires = new Date(Date.now() + CODE_TTL_MS);
    await db.transaction(async (trx) => {
      // One live code per user: a new one retires the earlier, unused ones.
      await trx('sync_pairing_codes').where({ user_id: req.user!.userId }).whereNull('used_at').delete();
      // Unused codes that expired a day ago are of no use to anyone.
      await trx('sync_pairing_codes').whereNull('used_at').where('expires_at', '<', trx.raw("now() - interval '1 day'")).delete();
      await trx('sync_pairing_codes').insert({ user_id: req.user!.userId, code_hash: sha256(code), expires_at: expires });
    });
    await logAudit({
      userId: req.user!.userId, periodId: null, entityType: 'sync_device', action: 'pairing_code',
      description: 'Made a code to pair a desktop',
    });
    res.status(201).json({ data: { code: formatCode(code), expiresAt: expires.toISOString() }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/codes');
  }
});

desktopSyncRouter.get('/devices', async (req: AuthRequest, res: Response): Promise<void> => {
  const all = req.query.all === '1' && req.user!.role === 'admin';
  try {
    const q = db('sync_devices as d')
      .join('app_users as u', 'u.id', 'd.user_id')
      .whereNull('d.revoked_at')
      .orderBy('d.created_at', 'desc')
      .select('d.id', 'd.user_id', 'd.name', 'd.created_at', 'd.last_used_at', 'u.username', 'u.display_name');
    if (!all) q.where('d.user_id', req.user!.userId);
    const rows = await q;
    res.json({
      data: rows.map((r) => ({
        id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at,
        user: r.display_name ?? r.username,
        mine: r.user_id === req.user!.userId,
      })),
      error: null,
      meta: { count: rows.length, all },
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/devices');
  }
});

desktopSyncRouter.delete('/devices/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    bad(res, 400, 'INVALID_ID', 'Invalid device id');
    return;
  }
  try {
    const device = await db('sync_devices').where({ id }).whereNull('revoked_at').first('id', 'user_id', 'name');
    // Someone else's device is "not found" to a non-admin, not "forbidden".
    if (!device || (device.user_id !== req.user!.userId && req.user!.role !== 'admin')) {
      bad(res, 404, 'NOT_FOUND', 'Device not found');
      return;
    }
    await db('sync_devices').where({ id }).update({ revoked_at: db.fn.now(), revoked_by: req.user!.userId });
    // The periods it held are released with it.
    await releaseDeviceHolds(db, [id], req.user!.userId, 'its desktop was removed');
    await logAudit({
      userId: req.user!.userId, periodId: null, entityType: 'sync_device', entityId: id, action: 'revoke',
      description: `Removed desktop "${device.name}"`,
    });
    res.json({ data: { id }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-sync/devices');
  }
});
