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
import type { Readable } from 'stream';

export const UPLOAD_DIR = path.join(SYNC_JOB_DIR, 'uploads');
/** The largest archive taken (as a restore's 2 GiB uncompressed cap). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
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
  constructor(public status: number, public code: string, message: string) {
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
  if (new Date(row.expires_at).getTime() < Date.now()) throw new UploadError(410, 'SYNC_UPLOAD_EXPIRED', 'This upload is more than a day old. Start it again.');
  if (row.job_id) throw new UploadError(409, 'SYNC_UPLOAD_USED', 'This upload has been sent already.');
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
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      body.on('data', (c: Buffer) => {
        got += c.length;
        if (got > want) {
          body.destroy();
          reject(new UploadError(400, 'SYNC_PART_SIZE', `Part ${n} must be ${want} bytes; more arrived.`));
          return;
        }
        if (!out.write(c)) {
          body.pause();
          out.once('drain', () => body.resume());
        }
      });
      body.on('end', () => out.end(() => resolve()));
      body.on('error', reject);
      out.on('error', reject);
    });
    if (got !== want) throw new UploadError(400, 'SYNC_PART_SIZE', `Part ${n} must be ${want} bytes; ${got} arrived.`);
    await fs.promises.rename(tmp, partPath(row.id, n));
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return receivedParts(row);
}

/** Uploads being joined now, and the last join error of each (this process only). */
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

/** Deletes uploads past their day (parts and joined files). */
export async function pruneUploads(now = Date.now()): Promise<void> {
  const old = (await db('sync_uploads').where('expires_at', '<', new Date(now)).select('id')) as Array<{ id: string }>;
  for (const u of old) {
    fs.rmSync(dirOf(u.id), { recursive: true, force: true });
    await db('sync_uploads').where({ id: u.id }).delete();
  }
}
