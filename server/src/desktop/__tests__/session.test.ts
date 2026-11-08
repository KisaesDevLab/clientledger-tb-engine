// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET ??= 'desktop-session-test-secret-0123456789abcdef';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const session = require('../session') as typeof import('../session');

interface FakeRes { statusCode: number; body: unknown; status(c: number): FakeRes; json(b: unknown): FakeRes }

function run(path: string, headers: Record<string, string>) {
  const req = { path, headers: { ...headers } } as unknown as import('express').Request;
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nextCalled = false;
  session.desktopSessionMiddleware(req, res as unknown as import('express').Response, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('tokenMatches compares exactly', () => {
  assert.equal(session.tokenMatches('abc', 'abc'), true);
  assert.equal(session.tokenMatches('abd', 'abc'), false);
  assert.equal(session.tokenMatches('ab', 'abc'), false);
  assert.equal(session.tokenMatches(undefined, 'abc'), false);
  assert.equal(session.tokenMatches('', ''), false); // no token configured = nothing matches
});

test('outside desktop mode the middleware does nothing', () => {
  delete process.env.DESKTOP_MODE;
  const { req, nextCalled } = run('/api/v1/clients', { authorization: 'Bearer keep-me' });
  assert.equal(nextCalled, true);
  assert.equal(req.headers.authorization, 'Bearer keep-me');
});

test('desktop mode: wrong or missing token is refused and a forged Bearer is dropped', () => {
  process.env.DESKTOP_MODE = 'true';
  process.env.CLTB_SESSION_TOKEN = 'launch-token';
  session.setDesktopUser({ id: 7, username: 'admin', role: 'admin' });

  for (const headers of [{}, { 'x-cltb-session': 'nope' }, { authorization: 'Bearer forged' }]) {
    const { req, res, nextCalled } = run('/api/v1/clients', headers);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(req.headers.authorization, undefined);
  }
});

test('desktop mode: probes are open, without credentials', () => {
  const { req, nextCalled } = run('/api/v1/health', { authorization: 'Bearer forged' });
  assert.equal(nextCalled, true);
  assert.equal(req.headers.authorization, undefined);
});

test('desktop mode: matching token becomes a Bearer JWT for the desktop user', () => {
  const { req, nextCalled } = run('/api/v1/clients', { 'x-cltb-session': 'launch-token' });
  assert.equal(nextCalled, true);
  const auth = String(req.headers.authorization);
  assert.match(auth, /^Bearer /);
  const claims = jwt.verify(auth.slice(7), process.env.JWT_SECRET as string) as { userId: number; role: string; stage?: string };
  assert.equal(claims.userId, 7);
  assert.equal(claims.role, 'admin');
  assert.equal(claims.stage, undefined);
});
