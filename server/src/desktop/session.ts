// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop session gate. The launcher generates a random token per launch and
// gives it to the engine (CLTB_SESSION_TOKEN) and to the desktop UI, which
// sends it as `X-CLTB-Session` on every request. A matching request gets an
// `Authorization: Bearer <JWT>` for the desktop's single admin user, so every
// existing check (authMiddleware, reviewer gate, rate-limit key) runs
// unchanged. Anything else is refused, apart from the liveness/readiness
// probes the launcher polls before it has a window.

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { signFullToken } from '../lib/sessionTokens';
import { SESSION_HEADER, isDesktopMode, launchToken } from './env';
import { ensureClientLinks } from './clientLinks';

const OPEN_PATHS = new Set(['/api/v1/ping', '/api/v1/health']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REMINT_MS = 60 * 60 * 1000; // well inside the JWT's own expiry

interface DesktopUser { id: number; username: string; role: string }

let desktopUser: DesktopUser | null = null;
let cached: { token: string; at: number } | null = null;

export function setDesktopUser(user: DesktopUser): void {
  desktopUser = user;
  cached = null;
}

function bearerFor(user: DesktopUser): string {
  const now = Date.now();
  if (!cached || now - cached.at > REMINT_MS) {
    cached = { token: signFullToken(user), at: now };
  }
  return cached.token;
}

export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  // Compare fixed-length digests so neither the length nor the content leaks.
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function refuse(res: Response): void {
  res.status(401).json({
    data: null,
    error: { code: 'DESKTOP_SESSION_REQUIRED', message: 'This engine only answers ClientLedger Trial Balance on this computer.' },
  });
}

export function desktopSessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isDesktopMode()) return next();

  // Never trust a caller-supplied Authorization header in desktop mode.
  delete req.headers.authorization;

  if (OPEN_PATHS.has(req.path)) return next();

  if (!tokenMatches(req.headers[SESSION_HEADER], launchToken()) || !desktopUser) {
    refuse(res);
    return;
  }
  req.headers.authorization = `Bearer ${bearerFor(desktopUser)}`;
  // Before anything that writes, every client has a documents folder (see
  // clientLinks.ts). A failure is logged there and never blocks the request.
  if (WRITE_METHODS.has(req.method)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('../db') as typeof import('../db');
    ensureClientLinks(db).then(() => next(), () => next());
    return;
  }
  next();
}
