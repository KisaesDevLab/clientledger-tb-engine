// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// GET /api/v1/desktop/draft/<report route>
//
// The engine's own report PDF with DRAFT across every page (Q61, owner
// 2026-11-17). The report is asked of the engine itself over loopback, with
// the caller's session, so the figures and layout are exactly the engine's;
// this route only adds the word. Two families of routes are allowed:
//
//   reports/periods/<id>/<report>[/<id>]       (routes/pdfReports.ts)
//   periods/<id>/exports/bookkeeper-letter     (routes/exports.ts)
//
// The query string is passed on unchanged. Anything that is not a PDF (an
// error, a 404) comes back as the engine sent it, so the desktop's error
// words still work. Read-only, no desktop data.

import { Router, type Request, type Response } from 'express';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { SESSION_HEADER } from './env';
import { sendServerError } from '../lib/safeError';

const ALLOWED = [
  /^reports\/periods\/\d+\/[a-z0-9-]+(\/\d+)?$/,
  /^periods\/\d+\/exports\/bookkeeper-letter$/,
];

/** Whether `path` (after /api/v1/) is a report this route may stamp. */
export function isStampable(path: string): boolean {
  return ALLOWED.some((re) => re.test(path));
}

/** The word, light grey, corner to corner across each page, whatever its size. */
export async function stampDraft(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const word = 'DRAFT';
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const angle = Math.atan2(height, width);
    // Wide enough to cross most of the diagonal, never taller than the page.
    const diagonal = Math.hypot(width, height);
    const size = Math.min((diagonal * 0.55) / font.widthOfTextAtSize(word, 1), height * 0.4);
    const textWidth = font.widthOfTextAtSize(word, size);
    const textHeight = font.heightAtSize(size, { descender: false });
    // pdf-lib turns the text about its origin (bottom left): start from the
    // centre and step back half the width and half the height, turned.
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const x = width / 2 - (textWidth / 2) * cos + (textHeight / 2) * sin;
    const y = height / 2 - (textWidth / 2) * sin - (textHeight / 2) * cos;
    page.drawText(word, {
      x,
      y,
      size,
      font,
      color: rgb(0.55, 0.55, 0.55),
      opacity: 0.18,
      rotate: degrees((angle * 180) / Math.PI),
    });
  }
  return doc.save();
}

export const desktopDraftRouter = Router();

desktopDraftRouter.get(/^\/desktop\/draft\/(.+)$/, async (req: Request, res: Response): Promise<void> => {
  const path = (req.params as Record<string, string>)[0] ?? '';
  if (!isStampable(path)) {
    res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Not a report that can be marked as a draft' } });
    return;
  }
  try {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const session = req.headers[SESSION_HEADER];
    const engine = await fetch(`http://127.0.0.1:${process.env.PORT}/api/v1/${path}${query}`, {
      headers: typeof session === 'string' ? { [SESSION_HEADER]: session } : {},
    });
    const type = engine.headers.get('content-type') ?? '';
    const body = new Uint8Array(await engine.arrayBuffer());
    if (!engine.ok || !type.startsWith('application/pdf')) {
      res.status(engine.status);
      if (type) res.setHeader('Content-Type', type);
      res.send(Buffer.from(body));
      return;
    }
    const stamped = Buffer.from(await stampDraft(body));
    res.setHeader('Content-Type', 'application/pdf');
    const disposition = engine.headers.get('content-disposition');
    if (disposition) res.setHeader('Content-Disposition', disposition);
    res.setHeader('Content-Length', String(stamped.length));
    res.send(stamped);
  } catch (err: unknown) {
    sendServerError(res, err, 'desktop-draft');
  }
});
