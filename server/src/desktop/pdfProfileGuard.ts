// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The Statement Writer draws its PDFs with Edge or Chrome through Puppeteer
// (lib/fs/pdfBrowser.ts). Puppeteer gives each browser a temporary profile
// folder and deletes it when the browser process exits. On Windows that
// delete can fail while one of the browser's own child processes still holds
// the profile's lockfile (EBUSY). Puppeteer rethrows the failure from its
// process-exit handler, which nothing awaits, so Node treats it as an
// unhandled rejection and the whole engine stops: every request in flight is
// cut off and the launcher restarts it (seen on the desktop 2026-11-18, P08b).
//
// The guard keeps the engine running through that one failure and logs it;
// any other unhandled rejection still stops the engine, as Node's default
// does. Folders left behind are removed at the next start (the launcher gives
// the engine a temp folder of its own: TMP/TEMP).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE = /^puppeteer_dev_(chrome|firefox)_profile-/;
const CLEANUP_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/** The failure is Puppeteer not yet able to delete a temporary profile. */
export function isPdfProfileCleanup(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const e = reason as { code?: unknown; path?: unknown };
  if (typeof e.code !== 'string' || !CLEANUP_CODES.has(e.code)) return false;
  if (typeof e.path !== 'string') return false;
  return e.path.split(/[\\/]/).some((part) => PROFILE.test(part));
}

/** Keep the engine running when only a temporary profile could not be deleted. */
export function installPdfProfileGuard(proc: NodeJS.EventEmitter = process): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    if (isPdfProfileCleanup(reason)) {
      const code = (reason as { code: string }).code;
      console.warn(`[desktop] the PDF browser's temporary profile could not be removed yet (${code}); it is removed at the next start`);
      return;
    }
    // As Node's default: an unhandled rejection stops the engine.
    throw reason;
  });
}

/** Remove the temporary profiles earlier runs left in `dir`; how many. */
export function sweepPdfProfiles(dir: string = os.tmpdir()): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!PROFILE.test(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Still held by a browser that has not exited: the next start.
    }
  }
  return removed;
}
