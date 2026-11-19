// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Phase 16: Document Storage
 * GET    /api/v1/clients/:clientId/documents       -> list documents
 * POST   /api/v1/clients/:clientId/documents       -> upload file (multipart)
 * GET    /api/v1/documents/:id/download            -> download file
 * DELETE /api/v1/documents/:id                     -> delete file + DB row
 * PUT    /api/v1/documents/:id/link                -> link to account or JE
 */
import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { assertNotCheckedOut, logAudit } from '../lib/periodGuard';
import {
  storeDocument,
  openDocument,
  deleteDocument as removeDocument,
  defaultUploadSection,
  type DocumentRow,
} from '../lib/documentStore';

export const documentsCollectionRouter = Router({ mergeParams: true });
export const documentsItemRouter = Router({ mergeParams: true });

documentsCollectionRouter.use(authMiddleware);
documentsItemRouter.use(authMiddleware);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/tiff',
]);

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.dll', '.com',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.php', '.jsp', '.aspx', '.asp', '.cgi', '.py', '.rb', '.pl',
  '.html', '.htm', '.xhtml', '.svg',
  '.jar', '.war', '.class',
  '.scr', '.pif', '.vbs', '.vbe', '.wsf', '.wsh',
]);

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES },
});

/**
 * Wrap multer so its rejections become 400s with a readable reason. Left
 * unwrapped, an oversize file surfaces as an unhandled 500.
 */
function uploadSingle(field: string) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    upload.single(field)(req, res, (err: unknown) => {
      if (!err) { next(); return; }
      const e = err as { code?: string; message?: string };
      const message = e.code === 'LIMIT_FILE_SIZE'
        ? `File is too large. The limit is ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB.`
        : e.message ?? 'Upload failed.';
      res.status(400).json({ data: null, error: { code: e.code ?? 'UPLOAD_FAILED', message } });
    });
  };
}

/**
 * Cheap magic-byte check: the declared MIME type is attacker-controlled, and a
 * mismatch between extension, type and content is the classic upload dodge.
 * Only formats with an unambiguous signature are checked; anything else passes.
 */
function contentMatchesType(mime: string, buf: Buffer): boolean {
  const starts = (sig: number[]): boolean => sig.every((b, i) => buf[i] === b);
  if (mime === 'application/pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (mime === 'image/png') return starts([0x89, 0x50, 0x4e, 0x47]);
  if (mime === 'image/jpeg') return starts([0xff, 0xd8, 0xff]);
  if (mime === 'image/gif') return buf.subarray(0, 3).toString('latin1') === 'GIF';
  // OOXML containers are ZIPs.
  if (mime.startsWith('application/vnd.openxmlformats-')) return starts([0x50, 0x4b, 0x03, 0x04]);
  return true;
}

/** StorageError carries its own status; anything else is a genuine 500. */
function handleDocError(err: unknown, res: Response): void {
  const e = err as { name?: string; code?: string; status?: number; message?: string };
  if (e?.name === 'StorageError') {
    res.status(e.status ?? 500).json({ data: null, error: { code: e.code ?? 'STORAGE_ERROR', message: e.message ?? 'Storage error' } });
    return;
  }
  sendServerError(res, err, 'documents');
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// ─── GET /api/v1/clients/:clientId/documents ─────────────────────────────────

documentsCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
    return;
  }
  try {
    const rows = await db('client_documents as d')
      .leftJoin('chart_of_accounts as coa', 'coa.id', 'd.linked_account_id')
      .leftJoin('journal_entries as je', 'je.id', 'd.linked_journal_entry_id')
      .leftJoin('app_users as u', 'u.id', 'd.uploaded_by')
      .where('d.client_id', clientId)
      .whereNull('d.deleted_at')
      .select(
        'd.id',
        'd.client_id',
        'd.filename',
        'd.file_size',
        'd.file_type',
        'd.linked_account_id',
        'd.linked_journal_entry_id',
        'd.uploaded_by',
        'd.uploaded_at',
        'd.period_id',
        'd.section',
        'd.storage_backend',
        'd.object_key',
        'coa.account_number',
        'coa.account_name',
        'je.entry_number as je_entry_number',
        'u.display_name as uploader_name',
      )
      .orderBy('d.uploaded_at', 'desc');
    res.json({ data: rows, error: null, meta: { total: rows.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'documents');
  }
});

// ─── POST /api/v1/clients/:clientId/documents ────────────────────────────────

documentsCollectionRouter.post(
  '/',
  uploadSingle('file'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const clientId = Number(req.params.clientId);
    if (isNaN(clientId)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid client ID' } });
      return;
    }
    if (!req.file) {
      res.status(400).json({ data: null, error: { code: 'NO_FILE', message: 'No file uploaded' } });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_FILE_TYPE', message: `File extension "${ext}" is not allowed.` } });
      return;
    }
    if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_FILE_TYPE', message: `File type "${req.file.mimetype}" is not allowed.` } });
      return;
    }

    if (!contentMatchesType(req.file.mimetype, req.file.buffer)) {
      res.status(400).json({ data: null, error: { code: 'CONTENT_MISMATCH', message: `The file content does not match its declared type (${req.file.mimetype}).` } });
      return;
    }

    try {
      // periodId and section are optional; the store falls back to the folder
      // template's default upload section.
      const periodId = req.body?.periodId ? Number(req.body.periodId) : null;
      const section = typeof req.body?.section === 'string' && req.body.section
        ? req.body.section
        : await defaultUploadSection();

      const doc = await storeDocument({
        clientId,
        periodId: periodId && !isNaN(periodId) ? periodId : null,
        section,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        uploadedBy: req.user?.userId ?? null,
      });

      await logAudit({
        userId: req.user?.userId ?? null, periodId: null, clientId,
        entityType: 'client_document', entityId: doc.id as number, action: 'create',
        description: `Uploaded document "${req.file.originalname}"`,
      });

      res.status(201).json({ data: doc, error: null });
    } catch (err: unknown) {
      handleDocError(err, res);
    }
  },
);

// ─── GET /api/v1/documents/:id/download ─────────────────────────────────────

documentsItemRouter.get('/:id/download', async (req: AuthRequest, res: Response): Promise<void> => {
  const docId = Number(req.params.id);
  if (isNaN(docId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid document ID' } });
    return;
  }
  try {
    const doc = await db('client_documents').where({ id: docId }).first();
    if (!doc) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Document not found' } });
      return;
    }

    // Backend and era are the store's problem: a legacy row reads from its
    // absolute disk path, a driver-era row from local or B2 by its own backend.
    const { body, sizeBytes } = await openDocument(doc as DocumentRow);
    res.setHeader('Content-Type', (doc.file_type as string) ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.filename as string)}"`);
    if (sizeBytes) res.setHeader('Content-Length', sizeBytes);
    body.on('error', (streamErr) => sendServerError(res, streamErr, 'documents'));
    body.pipe(res);
  } catch (err: unknown) {
    handleDocError(err, res);
  }
});

// ─── DELETE /api/v1/documents/:id ───────────────────────────────────────────

documentsItemRouter.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const docId = Number(req.params.id);
  if (isNaN(docId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid document ID' } });
    return;
  }
  try {
    const doc = await db('client_documents').where({ id: docId }).first();
    if (!doc) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Document not found' } });
      return;
    }

    // Only the uploader or an admin can delete. Reviewers/preparers shouldn't
    // be able to nuke another preparer's workpapers by guessing IDs.
    const isAdmin = req.user?.role === 'admin';
    const isUploader = req.user?.userId === (doc.uploaded_by as number | null);
    if (!isAdmin && !isUploader) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Only the uploader or an admin can delete this document.' } });
      return;
    }

    // Storage first, then the row: if the object cannot be removed, the row
    // must not be hidden, or an admin believes the file is gone while it still
    // exists and still bills.
    // Desktop sync: a lead sheet attachment of a period a desktop holds keeps
    // its file until the period is sent back (checked before the storage
    // delete, which no transaction can undo).
    // The attachments that show it are unlinked under their periods' lock (a
    // pull cannot slip in between), then the storage delete; if that fails
    // they are linked again.
    const linked = await db.transaction(async (trx) => {
      const rows = (await trx('lead_sheet_attachments').where({ document_id: docId }).select('id', 'period_id')) as Array<{ id: number; period_id: number }>;
      await assertNotCheckedOut(trx, rows.map((r) => r.period_id));
      if (rows.length) await trx('lead_sheet_attachments').whereIn('id', rows.map((r) => r.id)).update({ document_id: null });
      return rows.map((r) => r.id);
    });
    try {
      await removeDocument(doc as DocumentRow);
    } catch (err) {
      if (linked.length) await db('lead_sheet_attachments').whereIn('id', linked).update({ document_id: docId });
      throw err;
    }

    await logAudit({
      userId: req.user?.userId ?? null, periodId: null, clientId: doc.client_id as number,
      entityType: 'client_document', entityId: docId, action: 'delete',
      description: `Deleted document "${doc.filename}"`,
    });

    res.json({ data: { id: docId }, error: null });
  } catch (err: unknown) {
    handleDocError(err, res);
  }
});

// ─── PUT /api/v1/documents/:id/link ─────────────────────────────────────────

documentsItemRouter.put('/:id/link', async (req: AuthRequest, res: Response): Promise<void> => {
  const docId = Number(req.params.id);
  if (isNaN(docId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid document ID' } });
    return;
  }
  try {
    const doc = await db('client_documents').where({ id: docId }).first();
    if (!doc) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Document not found' } });
      return;
    }

    const { z } = await import('zod');
    const linkSchema = z.object({
      linkedAccountId: z.number().int().positive().nullable().optional(),
      linkedJournalEntryId: z.number().int().positive().nullable().optional(),
    });
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid input' } });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.linkedAccountId !== undefined) updates.linked_account_id = parsed.data.linkedAccountId ?? null;
    if (parsed.data.linkedJournalEntryId !== undefined) updates.linked_journal_entry_id = parsed.data.linkedJournalEntryId ?? null;

    const [updated] = await db('client_documents')
      .where({ id: docId })
      .update(updates)
      .returning('*');

    res.json({ data: updated, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'documents');
  }
});
