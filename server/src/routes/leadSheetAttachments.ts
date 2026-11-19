// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Lead sheet attachments — supporting documents auto-named by ref code.
 *
 * Two things worth knowing before editing:
 *
 * 1. Allocation trusts the UNIQUE INDEX, not the SELECT. Two concurrent uploads
 *    can compute the same next code; the loser gets a 23505, deletes the object
 *    it just wrote, and retries.
 * 2. Annotations (tickmark stamps, notes, drawn lines) are burned into the
 *    stored PDF, so they cannot be removed. There is no un-stamp endpoint by
 *    design: one that appeared to remove a mark while the ink stayed would be
 *    worse than none.
 */

import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { assertNotCheckedOut, assertPeriodUnlocked, logAudit } from '../lib/periodGuard';
import { nextRefCode, refPrefix } from '../lib/leadSheetRef';
import {
  burnAnnotation, imageToPdf, isConvertibleImage, pdfPageCount,
  MAX_NOTE_TEXT, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH, type StampAnnotation,
} from '../lib/leadSheetPdf';
import {
  storeDocument,
  openDocument,
  readDocumentBuffer,
  replaceDocumentBytes,
  deleteDocument as removeDocument,
  workpaperSection,
  type DocumentRow,
} from '../lib/documentStore';
import crypto from 'crypto';

export const leadSheetAttachmentCollectionRouter = Router({ mergeParams: true });
export const leadSheetAttachmentItemRouter = Router({ mergeParams: true });
leadSheetAttachmentCollectionRouter.use(authMiddleware);
leadSheetAttachmentItemRouter.use(authMiddleware);

/** 10 MB. Do not raise: pdf-lib load+save on a scanned PDF transiently costs
 *  roughly 3-4x the file size in heap, and the Pi has 8 GB total. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ACCEPTED = new Set(['application/pdf', 'image/png', 'image/jpeg']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

/** Multer rejections must surface as 400s, not unhandled 500s. */
function uploadSingle(field: string) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    upload.single(field)(req, res, (err: unknown) => {
      if (!err) { next(); return; }
      const e = err as { code?: string; message?: string };
      const message = e.code === 'LIMIT_FILE_SIZE'
        ? `File is too large. The limit is ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`
        : e.message ?? 'Upload failed.';
      res.status(400).json({ data: null, error: { code: e.code ?? 'UPLOAD_FAILED', message } });
    });
  };
}

function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

function handleErr(err: unknown, res: Response): void {
  const e = err as { name?: string; code?: string; status?: number; message?: string };
  if (e?.name === 'StorageError' || (e?.status && e?.code)) {
    res.status(e.status ?? 500).json({ data: null, error: { code: e.code ?? 'ERROR', message: e.message ?? 'Error' } });
    return;
  }
  sendServerError(res, err, 'lead-sheet-attachments');
}

// ─── GET /periods/:periodId/lead-sheet-attachments ───────────────────────────

leadSheetAttachmentCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  try {
    const rows = await db('lead_sheet_attachments as a')
      .join('client_documents as d', 'd.id', 'a.document_id')
      .leftJoin('app_users as u', 'u.id', 'a.created_by')
      .where('a.period_id', periodId)
      .whereNull('a.deleted_at')
      .orderBy('a.ref_code', 'asc')
      .select(
        'a.id', 'a.period_id', 'a.lead_sheet_id', 'a.lead_sheet_code', 'a.account_id',
        'a.ref_code', 'a.document_id', 'a.source_file_name', 'a.annotations', 'a.created_at',
        'd.file_size', 'd.file_type',
        'u.display_name as created_by_name',
      );
    res.json({ data: rows, error: null, meta: { count: rows.length } });
  } catch (err: unknown) {
    handleErr(err, res);
  }
});

// ─── POST /periods/:periodId/lead-sheet-attachments ──────────────────────────

const uploadSchema = z.object({
  leadSheetId: z.coerce.number().int().positive().optional(),
  leadSheetCode: z.string().trim().max(10).optional(),
  accountId: z.coerce.number().int().positive().optional(),
});

leadSheetAttachmentCollectionRouter.post('/', uploadSingle('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  if (!req.file) { res.status(400).json({ data: null, error: { code: 'NO_FILE', message: 'No file uploaded' } }); return; }

  const parsed = uploadSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  if (!ACCEPTED.has(req.file.mimetype)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_FILE_TYPE', message: 'Attach a PDF, PNG or JPEG. Images are converted to PDF automatically.' } });
    return;
  }

  try {
    const period = await db('periods').where({ id: periodId }).first('id', 'client_id');
    if (!period) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } }); return; }
    await assertPeriodUnlocked(periodId);

    // Resolve the lead sheet code — the allocator's only real input.
    let leadSheetId = parsed.data.leadSheetId ?? null;
    let code = parsed.data.leadSheetCode ?? null;
    if (leadSheetId) {
      const ls = await db('lead_sheets').where({ id: leadSheetId, client_id: period.client_id }).first('id', 'code');
      if (!ls) {
        res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'That lead sheet belongs to a different client.' } });
        return;
      }
      code = (ls.code as string | null) ?? code;
    }
    const prefix = refPrefix(code);

    // Everything is stored as PDF so it stays stampable, ref-coded and
    // mergeable into the binder.
    let bytes = req.file.buffer;
    let mime = 'application/pdf';
    if (isConvertibleImage(req.file.mimetype)) {
      bytes = await imageToPdf(req.file.buffer, req.file.mimetype);
    } else {
      if (!looksLikePdf(bytes)) {
        res.status(400).json({ data: null, error: { code: 'CONTENT_MISMATCH', message: 'That file is not a valid PDF.' } });
        return;
      }
      mime = 'application/pdf';
    }

    const section = await workpaperSection();

    for (let attempt = 0; attempt < 3; attempt++) {
      // Deliberately NOT filtered by deleted_at: a retired code must never be
      // handed out again.
      const existing = await db('lead_sheet_attachments')
        .where({ period_id: periodId, lead_sheet_code: prefix })
        .pluck('ref_code') as string[];
      const refCode = nextRefCode(prefix, existing);

      // Store the bytes under the ref-code name, then record the row. The two
      // inserts share one transaction, so a ref-code race rolls the document
      // row back too and leaves nothing half-written.
      const doc = await storeDocument({
        clientId: period.client_id as number,
        periodId,
        section,
        subfolder: 'Lead Sheets',
        filename: `${refCode}.pdf`,
        mimeType: mime,
        buffer: bytes,
        uploadedBy: req.user?.userId ?? null,
        linkedAccountId: parsed.data.accountId ?? null,
      });

      try {
        // Again under the period row lock: a desktop may have checked the
        // period out while the bytes were stored (the catch removes them).
        const [row] = await db.transaction(async (trx) => {
          await assertNotCheckedOut(trx, [periodId]);
          return trx('lead_sheet_attachments').insert({
          client_id: period.client_id,
          period_id: periodId,
          lead_sheet_id: leadSheetId,
          lead_sheet_code: prefix,
          account_id: parsed.data.accountId ?? null,
          ref_code: refCode,
          document_id: doc.id,
          source_file_name: req.file!.originalname,
          created_by: req.user?.userId ?? null,
        }).returning('*');
        });

        await logAudit({
          userId: req.user?.userId ?? null, periodId, clientId: period.client_id as number,
          entityType: 'lead_sheet_attachment', entityId: row.id, action: 'create',
          description: `Attached ${refCode} ("${req.file.originalname}")`,
        });
        res.status(201).json({ data: { ...row, fileSize: bytes.length }, error: null });
        return;
      } catch (err) {
        // Undo the stored object, then retry only on a ref-code collision.
        await removeDocument(doc as unknown as DocumentRow).catch(() => undefined);
        const code23505 = (err as { code?: string }).code === '23505'
          || /unique|duplicate/i.test(String((err as Error).message));
        if (!code23505) throw err;
      }
    }

    res.status(409).json({ data: null, error: { code: 'REF_RACE', message: 'Could not allocate an attachment reference — try again.' } });
  } catch (err: unknown) {
    handleErr(err, res);
  }
});

// ─── GET /periods/:periodId/lead-sheet-attachments/by-account ────────────────

leadSheetAttachmentCollectionRouter.get('/by-account', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } }); return; }
  try {
    const rows = await db('lead_sheet_attachments')
      .where({ period_id: periodId })
      .whereNull('deleted_at')
      .whereNotNull('account_id')
      .orderBy('ref_code', 'asc')
      .select('account_id', 'ref_code', 'id');
    const map: Record<number, Array<{ id: number; refCode: string }>> = {};
    for (const r of rows as Array<{ account_id: number; ref_code: string; id: number }>) {
      (map[r.account_id] ??= []).push({ id: r.id, refCode: r.ref_code });
    }
    res.json({ data: map, error: null });
  } catch (err: unknown) {
    handleErr(err, res);
  }
});

// ─── GET /lead-sheet-attachments/:id/file ────────────────────────────────────
// Always the stored (already stamped) file — there is no pristine variant.

leadSheetAttachmentItemRouter.get('/file', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid attachment ID' } }); return; }
  try {
    const att = await loadAttachment(id);
    if (!att) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Attachment not found' } }); return; }
    const { body, sizeBytes } = await openDocument(att.doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${att.row.ref_code}.pdf"`);
    if (sizeBytes) res.setHeader('Content-Length', sizeBytes);
    body.on('error', (e) => sendServerError(res, e, 'lead-sheet-attachments'));
    body.pipe(res);
  } catch (err: unknown) {
    handleErr(err, res);
  }
});

// ─── POST /lead-sheet-attachments/:id/annotations ────────────────────────────

const annotationBase = {
  page: z.number().int().min(1).max(2000),
  xPct: z.number().min(0).max(1),
  yPct: z.number().min(0).max(1),
};

/** The same vocabulary the burner maps to RGB; unknown values fall back to gray there. */
const annotationColor = z.enum(['gray', 'blue', 'green', 'red', 'purple', 'amber']);

// A payload without `kind` is a tickmark, so the pre-notes client shape still
// validates. (A .default() on the literal would not do it: discriminatedUnion
// dispatches on the raw input value before defaults apply.)
const annotationSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !('kind' in v) ? { ...v, kind: 'tickmark' } : v),
  z.discriminatedUnion('kind', [
  z.object({
    ...annotationBase,
    kind: z.literal('tickmark'),
    tickmarkId: z.number().int().positive(),
    note: z.string().max(200).optional(),
  }),
  z.object({
    ...annotationBase,
    kind: z.literal('note'),
    text: z.string().trim().min(1).max(MAX_NOTE_TEXT),
    color: annotationColor.default('red'),
    /** Box width as a fraction of the page width (drag-drawn); omitted = default width. */
    widthPct: z.number().min(0.03).max(1).optional(),
  }),
  z.object({
    ...annotationBase,
    kind: z.literal('line'),
    x2Pct: z.number().min(0).max(1),
    y2Pct: z.number().min(0).max(1),
    strokeWidth: z.number().min(MIN_STROKE_WIDTH).max(MAX_STROKE_WIDTH).default(1.5),
    color: annotationColor.default('red'),
  }),
  ]),
);

leadSheetAttachmentItemRouter.post('/annotations', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = annotationSchema.safeParse(req.body);
  if (isNaN(id) || !parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.success ? 'Invalid attachment ID' : parsed.error.message } });
    return;
  }
  try {
    const att = await loadAttachment(id);
    if (!att) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Attachment not found' } }); return; }
    await assertPeriodUnlocked(att.row.period_id as number);

    const input = parsed.data;
    const base = {
      id: crypto.randomUUID(),
      page: input.page,
      xPct: input.xPct,
      yPct: input.yPct,
      createdBy: req.user?.userId ?? null,
      createdAt: new Date().toISOString(),
    };

    // Serialise burning per attachment. It is read-modify-write on the stored
    // bytes, so two concurrent requests would each read the pre-burn file and
    // the second put would erase the first mark — while the annotations jsonb
    // recorded both, leaving the archive claiming a mark that is not in the
    // PDF. Permanent marks cannot be re-applied, so this must not race.
    let annotation: StampAnnotation;
    let description: string;
    if (input.kind === 'tickmark') {
      // Resolve from the client's own library, not system_tickmarks — the
      // library is what a client's workpapers actually use. Symbol and colour
      // are SNAPSHOT into the record so deleting the library tickmark later
      // never orphans what was actually stamped.
      const tm = await db('tickmark_library')
        .where({ id: input.tickmarkId, client_id: att.row.client_id })
        .first('id', 'symbol', 'color', 'description');
      if (!tm) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Tickmark not found for this client.' } }); return; }
      annotation = {
        ...base, kind: 'tickmark',
        symbol: tm.symbol as string,
        color: (tm.color as string) ?? 'gray',
        note: input.note ?? null,
      };
      description = `Stamped "${tm.symbol}" on ${att.row.ref_code} p${input.page}`;
    } else if (input.kind === 'note') {
      annotation = { ...base, kind: 'note', text: input.text, color: input.color, ...(input.widthPct !== undefined ? { widthPct: input.widthPct } : {}) };
      const preview = input.text.length > 40 ? `${input.text.slice(0, 40)}…` : input.text;
      description = `Noted "${preview}" on ${att.row.ref_code} p${input.page}`;
    } else {
      annotation = {
        ...base, kind: 'line',
        x2Pct: input.x2Pct, y2Pct: input.y2Pct,
        strokeWidth: input.strokeWidth, color: input.color,
      };
      description = `Drew a line on ${att.row.ref_code} p${input.page}`;
    }

    await db.transaction(async (trx) => {
      await trx('lead_sheet_attachments').where({ id }).forUpdate().first('id');
      // Again under the period row lock: the stamp was burned in meanwhile.
      await assertNotCheckedOut(trx, [att.row.period_id as number]);

      // Re-read inside the lock: a concurrent stamp may have replaced the bytes
      // (and the row's size/hash) since loadAttachment ran.
      const fresh = await trx('client_documents').where({ id: att.doc.id }).first();
      const doc = (fresh ?? att.doc) as DocumentRow;

      const bytes = await readDocumentBuffer(doc);
      const pages = await pdfPageCount(bytes);
      if (input.page > pages) {
        throw Object.assign(new Error(`This PDF has ${pages} page(s).`), {
          status: 400, code: 'VALIDATION_ERROR',
        });
      }

      const stamped = await burnAnnotation(bytes, annotation);
      await replaceDocumentBytes(doc, stamped);

      // jsonb concat rather than read-modify-write on the array.
      await trx('lead_sheet_attachments')
        .where({ id })
        .update({ annotations: trx.raw('annotations || ?::jsonb', [JSON.stringify([annotation])]) });

      await logAudit({
        userId: req.user?.userId ?? null, periodId: att.row.period_id as number, clientId: att.row.client_id as number,
        entityType: 'lead_sheet_attachment', entityId: id, action: 'update',
        description,
      }, trx);
    });

    res.status(201).json({ data: { annotation, permanent: true }, error: null });
  } catch (err: unknown) {
    handleErr(err, res);
  }
});

// ─── DELETE /lead-sheet-attachments/:id ──────────────────────────────────────

leadSheetAttachmentItemRouter.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid attachment ID' } }); return; }
  try {
    const att = await loadAttachment(id);
    if (!att) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Attachment not found' } }); return; }
    await assertPeriodUnlocked(att.row.period_id as number);

    const isAdmin = req.user?.role === 'admin';
    const isUploader = req.user?.userId === (att.row.created_by as number | null);
    if (!isAdmin && !isUploader) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Only the person who attached this, or an admin, can remove it.' } });
      return;
    }

    // Remove the bytes and the document row, but keep this row as a tombstone
    // so its ref code stays reserved. document_id is SET NULL by the FK.
    // The attachment row changes under the period lock (desktop sync: a pull
    // cannot slip in between and take a row that is about to change); the
    // storage delete, which no transaction can undo, follows. If it fails the
    // row is put back, so nothing is hidden while its file still exists.
    await db.transaction(async (trx) => {
      await assertNotCheckedOut(trx, [att.row.period_id as number]);
      await trx('lead_sheet_attachments').where({ id }).update({
        deleted_at: trx.fn.now(),
        deleted_by: req.user?.userId ?? null,
        document_id: null,
      });
    });
    try {
      await removeDocument(att.doc);
    } catch (err) {
      await db('lead_sheet_attachments').where({ id }).update({ deleted_at: null, deleted_by: null, document_id: att.doc.id });
      throw err;
    }
    await logAudit({
      userId: req.user?.userId ?? null, periodId: att.row.period_id as number, clientId: att.row.client_id as number,
      entityType: 'lead_sheet_attachment', entityId: id, action: 'delete',
      description: `Removed attachment ${att.row.ref_code}`,
    });
    res.json({ data: { id, refCode: att.row.ref_code }, error: null });
  } catch (err: unknown) {
    handleErr(err, res);
  }
});

async function loadAttachment(
  id: number,
): Promise<{ row: Record<string, unknown>; doc: DocumentRow } | null> {
  const row = await db('lead_sheet_attachments').where({ id }).whereNull('deleted_at').first();
  if (!row) return null;
  const doc = await db('client_documents').where({ id: row.document_id }).first();
  if (!doc) return null;
  return { row, doc: doc as DocumentRow };
}
