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
//   POST /api/v1/desktop/restore/client-files  (multipart: file, newClientId, documentIds)
//     After a client .tbak was restored AS NEW through /api/v1/restore/*,
//     write its carried document files into the new client's own folder
//     (clientFiles.ts, Q31). `documentIds` is the restore's
//     idMappings.client_documents as JSON. Answers { filesPlaced, filesNotPlaced }.
//
// Client backups and restores use the engine's own routes
// (/api/v1/backup/client/:id?includeFiles=1, /api/v1/restore/*). A full
// restore is not a route: the launcher stops the engine and runs
// `clientledger-tb-engine restore-full <file>` against a new database.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Router, type Response } from 'express';
import multer from 'multer';
import { db } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { localStorageRoot } from '../lib/storage';
import { writeFullBackup } from './fullBackup';
import { ClientFilesError, placeFilesForNewClient } from './clientFiles';

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

const archiveUpload = multer({
  dest: path.join(os.tmpdir(), 'cltb-client-files'),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});

desktopBackupRouter.post(
  '/desktop/restore/client-files',
  archiveUpload.single('file'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const upload = (req as AuthRequest & { file?: Express.Multer.File }).file;
    const removeUpload = () => {
      if (upload) fs.promises.unlink(upload.path).catch(() => undefined);
    };
    const body = (req.body ?? {}) as { newClientId?: unknown; documentIds?: unknown };
    const newClientId = Number(body.newClientId);
    let documentIds: Record<string, number> | null = null;
    try {
      const parsed: unknown = typeof body.documentIds === 'string' ? JSON.parse(body.documentIds) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.values(parsed).every((v) => Number.isInteger(v))) {
        documentIds = parsed as Record<string, number>;
      }
    } catch {
      documentIds = null;
    }
    if (!upload || !Number.isInteger(newClientId) || newClientId <= 0 || !documentIds) {
      removeUpload();
      res.status(400).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', message: 'file, newClientId and documentIds are required' },
      });
      return;
    }
    try {
      const r = await placeFilesForNewClient(db, upload.path, newClientId, documentIds);
      res.json({ data: { filesPlaced: r.placed, filesNotPlaced: r.notPlaced }, error: null });
    } catch (err: unknown) {
      if (err instanceof ClientFilesError) {
        res.status(err.code === 'CLIENT_NOT_FOUND' ? 404 : 400).json({
          data: null,
          error: { code: err.code, message: err.message },
        });
      } else {
        sendServerError(res, err, 'restore');
      }
    } finally {
      removeUpload();
    }
  },
);
