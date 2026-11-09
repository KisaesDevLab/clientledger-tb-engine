// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop backup routes (mounted under /api/v1 by the desktop router).
//
//   POST /api/v1/desktop/backup/full  { "fileName": "ClientLedgerTB_….tbak" }
//     Write a full backup (fullBackup.ts) into BACKUPS_DIR under that name and
//     answer with its size, hash and contents summary. The app copies,
//     encrypts and verifies it from there; nothing here writes elsewhere.
//
// Client backups and restores use the engine's own routes
// (/api/v1/backup/client/:id?includeFiles=1, /api/v1/restore/*). A full
// restore is not a route: the launcher stops the engine and runs
// `clientledger-tb-engine restore-full <file>` against a new database.

import path from 'path';
import { Router, type Response } from 'express';
import { db } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { localStorageRoot } from '../lib/storage';
import { writeFullBackup } from './fullBackup';

/** The only names the route writes: plain .tbak names in the backups folder. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.tbak$/;

export function backupsDir(): string {
  return process.env.BACKUPS_DIR || path.resolve(__dirname, '../../backups');
}

export const desktopBackupRouter = Router();

desktopBackupRouter.post('/desktop/backup/full', async (req: AuthRequest, res: Response): Promise<void> => {
  const fileName = (req.body as { fileName?: unknown } | undefined)?.fileName;
  if (typeof fileName !== 'string' || !NAME_RE.test(fileName) || fileName.includes('..')) {
    res.status(400).json({
      data: null,
      error: { code: 'VALIDATION_ERROR', message: 'fileName must be a plain .tbak file name' },
    });
    return;
  }
  try {
    const result = await writeFullBackup(
      db,
      path.join(backupsDir(), fileName),
      localStorageRoot(),
      process.env.npm_package_version ?? 'unknown',
    );
    res.json({ data: { ...result, fileName }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'backup');
  }
});
