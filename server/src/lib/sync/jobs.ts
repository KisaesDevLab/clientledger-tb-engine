// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.
/**
 * Desktop sync S3: jobs. A pull (S3) and a send-back (S4) can take longer
 * than a proxy waits, so the call returns a job id at once and the desktop
 * polls `GET /sync/jobs/:id`. Jobs run in this process, one at a time per
 * client, in arrival order. Their state lives in `sync_jobs`, so a restart
 * marks a job that was queued or running as failed rather than losing it.
 * A pull's archive is deleted a day after it was made.
 */
import fs from 'fs';
import path from 'path';
import { db } from '../../db';

export const SYNC_JOB_DIR = path.join(process.cwd(), 'backups', 'sync');
export const JOB_FILE_TTL_MS = 24 * 60 * 60 * 1000;

export type JobKind = 'pull' | 'push';
export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface JobError {
  code: string;
  message: string;
}

/** What a job's work returns: a result for the desktop, and a file to serve, if any. */
export interface JobOutcome {
  result: Record<string, unknown>;
  filePath?: string;
}

/** A refusal or failure the desktop is shown as it is. */
export class SyncJobError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const chains = new Map<number | string, Promise<void>>();

/** At most this many jobs queued or running per device (security review: queue and disk). */
export const MAX_OPEN_JOBS_PER_DEVICE = 3;
/** Free space kept on the disk the sync files live on. */
export const DISK_RESERVE_BYTES = 1024 * 1024 * 1024;

/** A 429 the routes pass through as it is (`expose`). */
export function busy(message: string): Error {
  return Object.assign(new Error(message), { code: 'SYNC_BUSY', status: 429, expose: true });
}

/** Refuses when the disk the sync files live on would keep less than the reserve. */
export function assertDiskRoom(bytes: number): void {
  try {
    fs.mkdirSync(SYNC_JOB_DIR, { recursive: true });
    const st = fs.statfsSync(SYNC_JOB_DIR);
    if (Number(st.bavail) * Number(st.bsize) < bytes + DISK_RESERVE_BYTES) {
      throw Object.assign(new Error('The server is short of disk space for this. Tell your administrator.'), { code: 'SYNC_NO_SPACE', status: 409, expose: true });
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'SYNC_NO_SPACE') throw err;
    // statfs not available: no check.
  }
}

/**
 * Records a job and runs `work` after any earlier job of the same client.
 * `onFail` undoes what the call set up (a pull's check-out) when the work
 * fails. Returns the job id at once.
 */
export async function startJob(
  input: { kind: JobKind; deviceId: number; userId: number; clientId: number | null; periodId?: number; checkoutId?: number | null; checkoutCreated?: boolean },
  work: (jobId: string) => Promise<JobOutcome>,
  onFail?: () => Promise<void>,
): Promise<string> {
  const open = await db('sync_jobs').where({ device_id: input.deviceId }).whereIn('state', ['queued', 'running']).count({ n: '*' }).first();
  if (Number(open?.n ?? 0) >= MAX_OPEN_JOBS_PER_DEVICE) {
    throw busy('This computer has other syncs still running. Wait for them to finish.');
  }
  const [row] = await db('sync_jobs')
    .insert({
      kind: input.kind,
      device_id: input.deviceId,
      user_id: input.userId,
      client_id: input.clientId,
      period_id: input.periodId ?? null,
      checkout_id: input.checkoutId ?? null,
      checkout_created: input.checkoutCreated === true,
    })
    .returning('id');
  const jobId = String((row as { id: string }).id);
  // A client new to the server queues with that device's other new ones.
  const key: number | string = input.clientId ?? `new-client:${input.deviceId}`;
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(() => runJob(jobId, work, onFail));
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return jobId;
}

async function runJob(jobId: string, work: (jobId: string) => Promise<JobOutcome>, onFail?: () => Promise<void>): Promise<void> {
  try {
    await db('sync_jobs').where({ id: jobId }).update({ state: 'running', started_at: db.fn.now() });
    const out = await work(jobId);
    await db('sync_jobs').where({ id: jobId }).update({
      state: 'done',
      result: JSON.stringify(out.result),
      file_path: out.filePath ?? null,
      finished_at: db.fn.now(),
    });
  } catch (err: unknown) {
    const error: JobError = err instanceof SyncJobError
      ? { code: err.code, message: err.message }
      : { code: 'SYNC_JOB_FAILED', message: 'The server could not finish this. Try again; if it keeps failing, tell your administrator.' };
    if (!(err instanceof SyncJobError)) console.error('[sync] job failed', jobId, err instanceof Error ? err.message : err);
    try {
      if (onFail) await onFail();
    } catch (undo: unknown) {
      console.error('[sync] job undo failed', jobId, undo instanceof Error ? undo.message : undo);
    }
    await db('sync_jobs').where({ id: jobId }).update({ state: 'failed', error: JSON.stringify(error), finished_at: db.fn.now() }).catch(() => {});
  }
}

/**
 * At start-up: a job left queued or running was cut off by a restart. Mark it
 * failed, and release the check-out a failed pull had TAKEN (not one it
 * reused: that desktop still holds work).
 */
export async function failInterruptedJobs(): Promise<void> {
  const open = (await db('sync_jobs').whereIn('state', ['queued', 'running']).select('id', 'kind', 'checkout_id', 'checkout_created')) as Array<{ id: string; kind: string; checkout_id: number | null; checkout_created: boolean }>;
  for (const j of open) {
    await db.transaction(async (trx) => {
      await trx('sync_jobs').where({ id: j.id }).update({
        state: 'failed',
        error: JSON.stringify({ code: 'SYNC_JOB_INTERRUPTED', message: 'The server restarted before this finished. Start it again.' }),
        finished_at: trx.fn.now(),
      });
      if (j.kind === 'pull' && j.checkout_id && j.checkout_created) {
        await trx('period_checkouts').where({ id: j.checkout_id }).whereNull('released_at')
          .update({ released_at: trx.fn.now(), release_reason: 'The pull was cut off by a server restart.' });
      }
    });
  }
}

/** Deletes pull archives older than a day (the desktop has fetched it or must pull again). */
export async function pruneJobFiles(now = Date.now()): Promise<void> {
  const cutoff = new Date(now - JOB_FILE_TTL_MS);
  const old = (await db('sync_jobs').whereNotNull('file_path').where('created_at', '<', cutoff).select('id', 'file_path')) as Array<{ id: string; file_path: string }>;
  for (const j of old) {
    try {
      fs.rmSync(j.file_path, { force: true });
    } catch {
      // Gone already, or not ours to delete: forget it either way.
    }
    await db('sync_jobs').where({ id: j.id }).update({ file_path: null });
  }
}

let pruneTimer: NodeJS.Timeout | null = null;

/** Start-up: fail interrupted jobs, then prune old archives now and every hour. */
export function startSyncJobHousekeeping(): void {
  fs.mkdirSync(SYNC_JOB_DIR, { recursive: true });
  void failInterruptedJobs().catch((err: unknown) => console.error('[sync] could not mark interrupted jobs', err instanceof Error ? err.message : err));
  const prune = () => {
    void pruneJobFiles().catch((err: unknown) => console.error('[sync] could not prune job files', err instanceof Error ? err.message : err));
    // Imported here: uploads.ts takes its folder from this module.
    void import('./uploads').then((m) => m.pruneUploads())
      .catch((err: unknown) => console.error('[sync] could not prune uploads', err instanceof Error ? err.message : err));
  };
  prune();
  if (!pruneTimer) {
    pruneTimer = setInterval(prune, 60 * 60 * 1000);
    pruneTimer.unref();
  }
}
