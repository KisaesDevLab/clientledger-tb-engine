// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// DRAFT on the engine's own PDF (Q61). That the word reads out of a stamped
// report, and the figures are unchanged, is checked by the desktop app's
// acceptance test against a real engine.
// Run: npx tsx --test src/desktop/__tests__/draftStamp.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { isStampable, stampDraft } from '../draftStamp';

test('only the engine\'s report routes may be stamped', () => {
  assert.ok(isStampable('reports/periods/12/balance-sheet'));
  assert.ok(isStampable('reports/periods/12/flux/11'));
  assert.ok(isStampable('reports/periods/12/m1'));
  assert.ok(isStampable('periods/12/exports/bookkeeper-letter'));
  assert.ok(!isStampable('periods/12/exports/tb-csv-x'));
  assert.ok(!isStampable('reports/periods/12/../../settings/firm'));
  assert.ok(!isStampable('settings/firm'));
  assert.ok(!isStampable('desktop/draft/reports/periods/12/m1'));
  assert.ok(!isStampable('reports/periods/x/m1'));
});

test('every page keeps its size and gets the word', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([792, 612]);
  const stamped = await PDFDocument.load(await stampDraft(await doc.save()));
  assert.equal(stamped.getPageCount(), 2);
  assert.deepEqual(stamped.getPage(0).getSize(), { width: 612, height: 792 });
  assert.deepEqual(stamped.getPage(1).getSize(), { width: 792, height: 612 });
  for (const page of stamped.getPages()) {
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
    assert.ok(fonts, 'a font for the word');
  }
});

test('a file that is not a PDF is refused', async () => {
  await assert.rejects(stampDraft(new TextEncoder().encode('{"error":"x"}')));
});
