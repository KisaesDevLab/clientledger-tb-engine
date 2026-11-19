// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The desktop's knowledge base for the support chat (Q82): upstream's pages
// less those about the web app only (knowledge/leave-out.json), with the
// desktop's own page first. A page left out that upstream renames or
// removes fails here, so the list never silently stops matching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const server = path.resolve(__dirname, '../../..');
const leaveOut = JSON.parse(
  fs.readFileSync(path.join(server, 'src/desktop/knowledge/leave-out.json'), 'utf8'),
) as { files: string[] };

test('every page left out is one upstream has', () => {
  const upstream = new Set(fs.readdirSync(path.join(server, 'knowledge')));
  for (const f of leaveOut.files) assert.ok(upstream.has(f), `knowledge/${f} is not upstream any more`);
});

test('the desktop page sorts first and names the edition', () => {
  const name = '00-clientledger-desktop.md';
  const upstream = fs.readdirSync(path.join(server, 'knowledge')).filter((f) => f.endsWith('.md'));
  assert.ok(upstream.every((f) => name < f), 'read before every upstream page');
  const text = fs.readFileSync(path.join(server, 'src/desktop/knowledge', name), 'utf8');
  assert.match(text, /ClientLedger Trial Balance/);
  assert.match(text, /no sign-in/);
});

test('the packaged knowledge folder has no page left out', () => {
  const built = path.join(server, 'dist-desktop/resources/knowledge');
  if (!fs.existsSync(built)) return; // not built here
  const files = fs.readdirSync(built);
  assert.ok(files.includes('00-clientledger-desktop.md'));
  for (const f of leaveOut.files) assert.ok(!files.includes(f), `${f} was packaged`);
});
