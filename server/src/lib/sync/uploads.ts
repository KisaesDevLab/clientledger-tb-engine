// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.
/**
 * Desktop sync S4: a send-back arrives in parts. A period archive with its
 * attachment files can pass a proxy's body cap (Cloudflare: 100 MB), so the
 * desktop announces the size and SHA-256, sends parts of at most
 * `partBytes` (default 50 MB, resumable: a part sent again replaces itself),
 * then asks to complete: the parts are joined and the hash checked. An
 * upload is bound to its device, used once, and gone after a day.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../../db';
import { SYNC_JOB_DIR, assertDiskRoom, busy } from './jobs';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';

export const UPLOAD_DIR = path.join(SYNC_JOB_DIR, 'uploads');
/** The largest archive taken (as a restore's 2 GiB uncompressed cap). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a USED upload's row is kept after its day (its files go at the
 * day): a desktop whose push answer was lost can still ask, weeks later,
 * which job its upload became, rather than reading "expired" or "no such
 * upload" and not knowing whether it went through (Q98, Q101).
 */
export const USED_UPLOAD_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Uploads open at once per device (not sent yet, not expired). */
export const MAX_OPEN_UPLOADS_PER_DEVICE = 3;

export function partBytes(): number {
  const n = Number(process.env.SYNC_PART_BYTES);
  return Number.isInteger(n) && n >= 1024 * 1024 && n <= 95 * 1024 * 1024 ? n : 50 * 1024 * 1024;
}

export interface UploadRow {
  id: string;
  device_id: number;
  user_id: number;
  size: string | number;
  sha256: string;
  part_bytes: number;
  file_path: string | null;
  completed_at: Date | null;
  job_id: string | null;
  expires_at: Date;
}

export class UploadError extends Error {
  /** `jobId`: on SYNC_UPLOAD_USED, the job the upload became (Q98). */
  constructor(public status: number, public code: string, message: string, public jobId: string | null = null) {
    super(message);
  }
}

export const partCount = (size: number, part: number): number => Math.max(1, Math.ceil(size / part));
/** The length part `n` must have. */
export const partLength = (size: number, part: number, n: number): number =>
  (n < partCount(size, part) - 1 ? part : size - part * (partCount(size, part) - 1));

const dirOf = (id: string): string => path.join(UPLOAD_DIR, id);
const partPath = (id: string, n: number): string => path.join(dirOf(id), `part-${n}`);

export async function startUpload(deviceId: number, userId: number, size: number, sha256: string): Promise<{ uploadId: string; partBytes: number; parts: number }> {
  if (!Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    throw new UploadError(400, 'SYNC_UPLOAD_TOO_LARGE', `An upload is 1 byte to ${MAX_UPLOAD_BYTES} bytes.`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new UploadError(400, 'VALIDATION_ERROR', 'sha256 is 64 lowercase hex characters.');
  const open = await db('sync_uploads').where({ device_id: deviceId }).whereNull('job_id').where('expires_at', '>', new Date()).count({ n: '*' }).first();
  if (Number(open?.n ?? 0) >= MAX_OPEN_UPLOADS_PER_DEVICE) throw busy('This computer has other uploads open. Send or wait for them first.');
  // The parts and the joined file (twice the size) must fit.
  assertDiskRoom(size * 2);
  const part = partBytes();
  const [row] = await db('sync_uploads').insert({
    device_id: deviceId, user_id: userId, size, sha256, part_bytes: part, expires_at: new Date(Date.now() + UPLOAD_TTL_MS),
  }).returning('id');
  const id = String((row as { id: string }).id);
  fs.mkdirSync(dirOf(id), { recursive: true });
  return { uploadId: id, partBytes: part, parts: partCount(size, part) };
}

/** This device's upload, still open (not expired, not completed unless `completedOk`). */
export async function openUpload(id: string, deviceId: number, completedOk = false): Promise<UploadRow> {
  const row = (await db('sync_uploads').where({ id, device_id: deviceId }).first()) as UploadRow | undefined;
  if (!row) throw new UploadError(404, 'NOT_FOUND', 'No such upload from this computer.');
  // "Used" before "expired" (Q101): an upload that was sent says so, with its
  // job, for as long as its row is kept, never "start it again".
  if (row.job_id) throw new UploadError(409, 'SYNC_UPLOAD_USED', 'This upload has been sent already.', row.job_id);
  if (new Date(row.expires_at).getTime() < Date.now()) throw new UploadError(410, 'SYNC_UPLOAD_EXPIRED', 'This upload is more than a day old. Start it again.');
  if (row.completed_at && !completedOk) throw new UploadError(409, 'SYNC_UPLOAD_COMPLETE', 'This upload is complete; send it back with it.');
  return row;
}

export function receivedParts(row: UploadRow): number[] {
  const size = Number(row.size);
  const out: number[] = [];
  for (let n = 0; n < partCount(size, row.part_bytes); n++) {
    try {
      if (fs.statSync(partPath(row.id, n)).size === partLength(size, row.part_bytes, n)) out.push(n);
    } catch {
      // not here yet
    }
  }
  return out;
}

/**
 * One part, streamed from the request to disk (never held in memory whole:
 * security review), refused as soon as it runs past its length.
 */
export async function putPart(row: UploadRow, n: number, body: Readable): Promise<number[]> {
  const size = Number(row.size);
  const count = partCount(size, row.part_bytes);
  if (!Number.isInteger(n) || n < 0 || n >= count) throw new UploadError(400, 'VALIDATION_ERROR', `Parts are numbered 0 to ${count - 1}.`);
  const want = partLength(size, row.part_bytes, n);
  fs.mkdirSync(dirOf(row.id), { recursive: true });
  const tmp = `${partPath(row.id, n)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let got = 0;
  // Counted on the way through, refused as soon as it runs past its length.
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      if (got > want) cb(new UploadError(400, 'SYNC_PART_SIZE', `Part ${n} must be ${want} bytes; more arrived.`));
      else cb(null, chunk);
    },
  });
  try {
    // pipeline ends on every outcome, a dropped connection included (it rejects
    // with ERR_STREAM_PREMATURE_CLOSE), and destroys every stream: no request
    // left waiting and no file left open (code review).
    await pipeline(body, limit, fs.createWriteStream(tmp));
    if (got !== want) throw new UploadError(400, 'SYNC_PART_SIZE', `Part ${n} must be ${want} bytes; ${got} arrived.`);
    await fs.promises.rename(tmp, partPath(row.id, n));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return receivedParts(row);
}

/**
 * Marks an upload as sent, at once and only once (Q98): the job it will
 * become gets its id here, before the job starts, so two pushes of one
 * upload (a desktop asking again while its first push is still being
 * answered) can never both start a job. The second is refused with the
 * first one's job. `unclaimUpload` undoes it when the job could not start.
 */
export async function claimUpload(id: string, deviceId: number): Promise<string> {
  const jobId = crypto.randomUUID();
  const n = await db('sync_uploads').where({ id, device_id: deviceId }).whereNull('job_id').update({ job_id: jobId });
  if (n === 0) {
    const now = (await db('sync_uploads').where({ id }).first('job_id')) as { job_id: string | null } | undefined;
    throw new UploadError(409, 'SYNC_UPLOAD_USED', 'This upload has been sent already.', now?.job_id ?? null);
  }
  return jobId;
}

export async function unclaimUpload(id: string, jobId: string): Promise<void> {
  await db('sync_uploads').where({ id, job_id: jobId }).update({ job_id: null });
}

/**
 * Cancels an upload this device has not sent (Q101): its row and its files
 * go, and it no longer counts against the open uploads. A sent one is
 * refused with its job; one being joined right now waits for the join.
 */
export async function cancelUpload(id: string, deviceId: number): Promise<void> {
  const row = (await db('sync_uploads').where({ id, device_id: deviceId }).first()) as UploadRow | undefined;
  if (!row) throw new UploadError(404, 'NOT_FOUND', 'No such upload from this computer.');
  if (row.job_id) throw new UploadError(409, 'SYNC_UPLOAD_USED', 'This upload has been sent already; it cannot be cancelled.', row.job_id);
  if (joining.has(id)) throw new UploadError(409, 'SYNC_UPLOAD_JOINING', 'The server is joining the parts of this upload. Ask again in a moment.');
  // Only while still unsent: a push that took it meanwhile wins.
  const n = await db('sync_uploads').where({ id, device_id: deviceId }).whereNull('job_id').delete();
  if (n === 0) {
    const now = (await db('sync_uploads').where({ id }).first('job_id')) as { job_id: string | null } | undefined;
    throw new UploadError(409, 'SYNC_UPLOAD_USED', 'This upload has been sent already; it cannot be cancelled.', now?.job_id ?? null);
  }
  joinErrors.delete(id);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
}

/**
 * Uploads being joined now, and the last join error of each (this process only). */
const joining = new Set<string>();
const joinErrors = new Map<string, UploadError>();

export function joinState(id: string): { joining: boolean; error: { code: string; message: string } | null } {
  const e = joinErrors.get(id);
  return { joining: joining.has(id), error: e ? { code: e.code, message: e.message } : null };
}

/**
 * Starts joining the parts (a background task: up to 2 GiB is read and
 * hashed, longer than a proxy waits). Refuses at once when parts are
 * missing. The desktop polls `GET /uploads/:id` until `complete` (or an
 * error). Calling it again while it runs, or after, is harmless.
 */
export function startCompleteUpload(row: UploadRow): { complete: boolean; joining: boolean } {
  if (row.completed_at && row.file_path && fs.existsSync(row.file_path)) return { complete: true, joining: false };
  if (joining.has(row.id)) return { complete: false, joining: true };
  const size = Number(row.size);
  const count = partCount(size, row.part_bytes);
  const have = receivedParts(row);
  if (have.length !== count) {
    const missing = [...Array(count).keys()].filter((n) => !have.includes(n));
    throw new UploadError(409, 'SYNC_UPLOAD_INCOMPLETE', `Parts still to send: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}.`);
  }
  joining.add(row.id);
  joinErrors.delete(row.id);
  void completeUpload(row)
    .catch((err: unknown) => {
      joinErrors.set(row.id, err instanceof UploadError ? err : new UploadError(500, 'SYNC_UPLOAD_FAILED', 'The server could not join the upload. Send it again.'));
      if (!(err instanceof UploadError)) console.error('[sync] upload join failed', row.id, err instanceof Error ? err.message : err);
    })
    .finally(() => joining.delete(row.id));
  return { complete: false, joining: true };
}

/** Joins the parts, checks size and SHA-256, and records the file. */
export async function completeUpload(row: UploadRow): Promise<{ size: number; sha256: string }> {
  if (row.completed_at && row.file_path && fs.existsSync(row.file_path)) return { size: Number(row.size), sha256: row.sha256 };
  const size = Number(row.size);
  const count = partCount(size, row.part_bytes);
  const have = receivedParts(row);
  if (have.length !== count) {
    const missing = [...Array(count).keys()].filter((n) => !have.includes(n));
    throw new UploadError(409, 'SYNC_UPLOAD_INCOMPLETE', `Parts still to send: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}.`);
  }
  const out = path.join(dirOf(row.id), 'archive.tbak');
  // Written beside, then renamed: a finished archive is never truncated.
  const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const hash = crypto.createHash('sha256');
  const fd = await fs.promises.open(tmp, 'w');
  try {
    for (let n = 0; n < count; n++) {
      const buf = await fs.promises.readFile(partPath(row.id, n));
      hash.update(buf);
      await fd.write(buf);
    }
    await fd.sync();
  } finally {
    await fd.close();
  }
  const got = hash.digest('hex');
  if (got !== row.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new UploadError(400, 'SYNC_UPLOAD_HASH', 'The parts do not add up to the file announced (its SHA-256 differs). Send it again.');
  }
  await fs.promises.rename(tmp, out);
  for (let n = 0; n < count; n++) fs.rmSync(partPath(row.id, n), { force: true });
  await db('sync_uploads').where({ id: row.id }).update({ file_path: out, completed_at: db.fn.now() });
  return { size, sha256: got };
}

/**
 * Past its day an upload's files go (not while its push job waits or runs).
 * An unsent upload's row goes with them;
 * a sent one's row stays `USED_UPLOAD_KEEP_MS` longer, so it can still name
 * its job (Q101).
 */
export async function pruneUploads(now = Date.now()): Promise<void> {
  const old = (await db('sync_uploads').where('expires_at', '<', new Date(now)).select('id', 'job_id', 'expires_at')) as Array<{ id: string; job_id: string | null; expires_at: Date }>;
  // A push still waiting its turn (jobs of one client run one at a time) or
  // running reads its archive: its files stay until the job is over (code review).
  const jobIds = old.map((u) => u.job_id).filter((j): j is string => !!j);
  const states = new Map(jobIds.length
    ? ((await db('sync_jobs').whereIn('id', jobIds).select('id', 'state')) as Array<{ id: string; state: string }>).map((j) => [j.id, j.state])
    : []);
  for (const u of old) {
    const kept = new Date(u.expires_at).getTime() + USED_UPLOAD_KEEP_MS >= now;
    const state = u.job_id ? states.get(u.job_id) : undefined;
    // A claimed id with no job row yet is a push starting this moment (but not for 30 days).
    if (u.job_id && (state === 'queued' || state === 'running' || (state === undefined && kept))) continue;
    fs.rmSync(dirOf(u.id), { recursive: true, force: true });
    if (!u.job_id || !kept) {
      await db('sync_uploads').where({ id: u.id }).delete();
    }
  }
}
