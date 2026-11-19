// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The engine keeps running when Puppeteer cannot yet delete the PDF
// browser's temporary profile, and stops on every other unhandled rejection.
// Run: npx tsx --test src/desktop/__tests__/pdfProfileGuard.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPdfProfileGuard, isPdfProfileCleanup, sweepPdfProfiles } from '../pdfProfileGuard';

const locked = (code: string, p: string) =>
  Object.assign(new Error(`${code}: resource busy or locked, unlink '${p}'`), { code, syscall: 'unlink', path: p });

test('only a temporary profile that could not be deleted is recognised', () => {
  const lockfile = 'C:\\Data\\engine-tmp\\puppeteer_dev_chrome_profile-UcZtuv\\lockfile';
  assert.ok(isPdfProfileCleanup(locked('EBUSY', lockfile)));
  assert.ok(isPdfProfileCleanup(locked('EPERM', '/tmp/puppeteer_dev_chrome_profile-Ab12/Default')));
  assert.ok(!isPdfProfileCleanup(locked('ENOSPC', lockfile)), 'another failure');
  assert.ok(!isPdfProfileCleanup(locked('EBUSY', 'C:\\Data\\uploads\\client-1\\report.pdf')), 'another folder');
  assert.ok(!isPdfProfileCleanup(new Error('Target closed')));
  assert.ok(!isPdfProfileCleanup(undefined));
  assert.ok(!isPdfProfileCleanup('EBUSY puppeteer_dev_chrome_profile-x'));
});

test('the guard keeps the engine running for that one failure and rethrows the rest', () => {
  const proc = new EventEmitter();
  installPdfProfileGuard(proc);
  const warn = console.warn;
  const said: string[] = [];
  console.warn = (m: string) => { said.push(m); };
  try {
    proc.emit('unhandledRejection', locked('EBUSY', 'C:\\t\\puppeteer_dev_chrome_profile-1\\lockfile'));
  } finally {
    console.warn = warn;
  }
  assert.equal(said.length, 1);
  assert.match(said[0]!, /temporary profile could not be removed yet \(EBUSY\)/);
  assert.throws(() => proc.emit('unhandledRejection', new Error('a real bug')), /a real bug/);
});

test('profiles left by earlier runs are removed at start, nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cltb-guard-'));
  try {
    fs.mkdirSync(path.join(dir, 'puppeteer_dev_chrome_profile-old', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'puppeteer_dev_chrome_profile-old', 'lockfile'), '');
    fs.mkdirSync(path.join(dir, 'keep-me'));
    fs.writeFileSync(path.join(dir, 'puppeteer_dev_chrome_profile-file.txt'), 'not a folder, still a leftover');
    assert.equal(sweepPdfProfiles(dir), 2);
    assert.deepEqual(fs.readdirSync(dir), ['keep-me']);
    assert.equal(sweepPdfProfiles(path.join(dir, 'missing')), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
