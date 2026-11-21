// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Sign-in. A correct password now lands in one of three stages (lib/loginStage.ts):
 *   ok    — full token, as before
 *   mfa   — a 5-minute token good only for the /mfa/* endpoints below
 *   enrol — a 15-minute token good only for enrolling a factor (firm policy)
 * Passkey sign-in (usernameless) lives in routes/passkeys.ts; TOTP enrolment in
 * routes/totp.ts; remembered browsers in routes/trustedBrowsers.ts.
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { db } from '../db';
import { authMiddleware, AuthRequest, assertStage, invalidateAuthCache } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { passwordSchema } from '../lib/passwordPolicy';
import { logAudit } from '../lib/periodGuard';
import { revokeUserDevices } from '../lib/sync/deviceRevoke';
import { resolveLoginStage } from '../lib/loginStage';
import { securitySettings } from '../lib/securitySettings';
import { getRelyingParty } from '../lib/publicUrl';
import { parseCookieHeader } from '../lib/cookies';
import {
  TRUSTED_BROWSER_COOKIE,
  TRUSTED_BROWSER_TTL_MS,
  buildTrustedBrowserCookie,
  generateTrustedBrowserToken,
  hashTrustedBrowserToken,
} from '../lib/trustedBrowser';
import { decryptTotpSecret, isReplay, verifyTotpCode } from '../lib/totp';
import { beginAuthentication, finishAuthentication, passkeyToJson } from '../lib/passkeyCeremony';
import {
  USER_ROW_COLUMNS,
  cookiesAreSecure,
  loadUserFactors,
  publicUser,
  signFullToken,
  signStageToken,
  type UserRow,
} from '../lib/sessionTokens';
import { rateLimitKey } from '../lib/rateLimitKey';
import { getVibeAuth, requireLocalLoginAllowed } from '../lib/vibeAuth';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again later.' } },
});

// Second-factor guesses are limited per ACCOUNT (the pending token names the
// user), so an attacker cannot spread guesses across IPs, and a shared office
// IP does not lock everyone out.
const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many verification attempts. Please wait 15 minutes and sign in again.' } },
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/** A valid, unrevoked, unexpired trusted-browser row for THIS user, if the request carries one. */
async function trustedBrowserFor(req: Request, userId: number): Promise<number | null> {
  const raw = parseCookieHeader(req.headers.cookie)[TRUSTED_BROWSER_COOKIE];
  if (!raw) return null;
  const row = await db('trusted_browsers')
    .where({ user_id: userId, token_hash: hashTrustedBrowserToken(raw) })
    .whereNull('revoked_at')
    .where('expires_at', '>', new Date())
    .first('id');
  if (!row) return null;
  await db('trusted_browsers').where({ id: row.id }).update({ last_used_at: db.fn.now() });
  return row.id as number;
}

/** Mint a trusted-browser row + cookie for a user who ticked "remember this browser". */
async function rememberBrowser(req: Request, res: Response, userId: number): Promise<void> {
  const { raw, hash } = generateTrustedBrowserToken();
  await db('trusted_browsers').insert({
    user_id: userId,
    token_hash: hash,
    expires_at: new Date(Date.now() + TRUSTED_BROWSER_TTL_MS),
    user_agent: (req.headers['user-agent'] ?? '').slice(0, 255) || null,
  });
  res.setHeader('Set-Cookie', buildTrustedBrowserCookie(raw, { secure: cookiesAreSecure() }));
}

// requireLocalLoginAllowed: in single-sign-on-only mode only the break-glass
// account may use a password (Vibe Auth); every other username gets a 403.
router.post('/login', loginLimiter, requireLocalLoginAllowed, async (req: Request, res: Response): Promise<void> => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      data: null,
      error: { code: 'VALIDATION_ERROR', message: 'Username and password required' },
    });
    return;
  }

  const { username, password } = result.data;

  try {
    const user = await db('app_users').where({ username, is_active: true }).first();

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({
        data: null,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' },
      });
      return;
    }

    // Audits a break-glass sign-in (no-op for everyone else).
    await getVibeAuth().afterLocalLogin({ userId: String(user.id), username: user.username, ip: req.ip });

    const factors = await loadUserFactors(user.id);
    const trusted = factors.hasTotp || factors.hasPasskey ? await trustedBrowserFor(req, user.id) : null;
    const { stage, methods } = resolveLoginStage({
      hasTotp: factors.hasTotp,
      hasPasskey: factors.hasPasskey,
      trustedBrowser: trusted !== null,
      requireTwoFactor: securitySettings().requireTwoFactor,
    });

    const token = stage === 'ok' ? signFullToken(user) : signStageToken(user, stage, methods);
    if (stage === 'ok' && trusted !== null) {
      await logAudit({ userId: user.id, periodId: null, entityType: 'user', entityId: user.id, action: 'login_trusted', description: `User "${user.username}" signed in on a remembered browser` });
    }

    res.json({
      data: {
        stage,
        token,
        methods,
        user: publicUser(user as UserRow, factors),
      },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'auth');
  }
});

router.get('/me', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await db('app_users')
      .where({ id: req.user!.userId, is_active: true })
      .select(...USER_ROW_COLUMNS)
      .first();

    if (!user) {
      res
        .status(404)
        .json({ data: null, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }

    const factors = await loadUserFactors(user.id);
    res.json({
      data: { ...publicUser(user as UserRow, factors), stage: req.user!.stage },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'auth');
  }
});

// POST /api/v1/auth/change-password — any authenticated user can rotate their own
// password. Clears the must_change_password flag so the forced-rotation UI goes away.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

router.post('/change-password', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    // Surface the first complexity violation so the user knows which rule failed
    // (uppercase / lowercase / digit / length). Zod returns these per-issue.
    const firstIssue = parsed.error.issues[0]?.message ?? 'Password does not meet complexity requirements.';
    res.status(400).json({
      data: null,
      error: { code: 'VALIDATION_ERROR', message: firstIssue },
    });
    return;
  }
  try {
    const me = await db('app_users').where({ id: req.user!.userId, is_active: true }).first();
    if (!me) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }
    if (!(await bcrypt.compare(parsed.data.currentPassword, me.password_hash))) {
      res.status(401).json({ data: null, error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' } });
      return;
    }
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      res.status(400).json({ data: null, error: { code: 'SAME_PASSWORD', message: 'New password must differ from the current one.' } });
      return;
    }
    const hash = await bcrypt.hash(parsed.data.newPassword, 12);
    await db.transaction(async (trx) => {
      await trx('app_users').where({ id: me.id }).update({
        password_hash: hash,
        must_change_password: false,
        // A real password now exists (see lib/accountGuards.ts).
        sso_only_since: null,
      });
      // Owner 2026-11-19: changing your own password also signs out your paired
      // desktops (desktop sync). Not a reset: this session, which just proved
      // the old password, may pair again at once.
      await revokeUserDevices(me.id, null, `"${me.username}" changed their own password`, { trx });
    });
    invalidateAuthCache(me.id);
    await logAudit({ userId: me.id, periodId: null, entityType: 'user', entityId: me.id, action: 'update', description: `User "${me.username}" changed their own password` });
    res.json({ data: { ok: true }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'auth');
  }
});

// ── Second-factor challenge (mfa-stage token only) ───────────────────────────

async function completeMfa(req: AuthRequest, res: Response, remember: boolean, how: string): Promise<void> {
  const user = (await db('app_users').where({ id: req.user!.userId, is_active: true }).select(...USER_ROW_COLUMNS).first()) as UserRow | undefined;
  if (!user) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Account is inactive.' } });
    return;
  }
  if (remember) await rememberBrowser(req, res, user.id);
  await logAudit({ userId: user.id, periodId: null, entityType: 'user', entityId: user.id, action: 'login_mfa', description: `User "${user.username}" completed two-factor sign-in (${how})${remember ? ', remembered this browser' : ''}` });
  const factors = await loadUserFactors(user.id);
  res.json({ data: { stage: 'ok', token: signFullToken(user), user: publicUser(user, factors) }, error: null });
}

const mfaTotpSchema = z.object({ code: z.string().min(1).max(16), rememberBrowser: z.boolean().optional() });

// POST /api/v1/auth/mfa/totp
router.post('/mfa/totp', mfaLimiter, authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!assertStage(req, res, 'mfa')) return;
  const parsed = mfaTotpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'A verification code is required.' } });
    return;
  }
  try {
    const row = await db('user_totp').where({ user_id: req.user!.userId }).whereNotNull('confirmed_at').first();
    if (!row) {
      res.status(400).json({ data: null, error: { code: 'INVALID_CODE', message: 'No authenticator app is set up for this account.' } });
      return;
    }
    const check = await verifyTotpCode({ secret: decryptTotpSecret(row.secret_enc as string), code: parsed.data.code });
    if (!check.valid || isReplay(row.last_used_step as number | null, check.step!)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_CODE', message: 'That code is not valid. Check your authenticator app and try again.' } });
      return;
    }
    await db('user_totp').where({ user_id: req.user!.userId }).update({ last_used_step: check.step, updated_at: db.fn.now() });
    await completeMfa(req, res, !!parsed.data.rememberBrowser, 'authenticator app');
  } catch (err: unknown) {
    sendServerError(res, err, 'auth');
  }
});

// POST /api/v1/auth/mfa/passkey/options
router.post('/mfa/passkey/options', mfaLimiter, authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!assertStage(req, res, 'mfa')) return;
  const rp = getRelyingParty();
  if (!rp.ok) {
    res.status(503).json({ data: null, error: { code: 'PASSKEYS_UNAVAILABLE', message: rp.reason } });
    return;
  }
  try {
    const data = await beginAuthentication('mfa', req.user!.userId);
    res.json({ data, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'auth');
  }
});

const mfaPasskeySchema = z.object({
  challengeId: z.string().min(1).max(128),
  response: z.custom<AuthenticationResponseJSON>((v) => !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string'),
  rememberBrowser: z.boolean().optional(),
});

// POST /api/v1/auth/mfa/passkey/verify
router.post('/mfa/passkey/verify', mfaLimiter, authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!assertStage(req, res, 'mfa')) return;
  const parsed = mfaPasskeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'A challenge id and a passkey response are required.' } });
    return;
  }
  try {
    const outcome = await finishAuthentication({
      kind: 'mfa',
      userId: req.user!.userId,
      challengeId: parsed.data.challengeId,
      response: parsed.data.response,
    });
    if (!outcome.ok) {
      const status = outcome.code === 'PASSKEYS_UNAVAILABLE' ? 503 : outcome.code === 'INVALID_CREDENTIALS' ? 401 : 400;
      res.status(status).json({ data: null, error: { code: outcome.code, message: outcome.message } });
      return;
    }
    await completeMfa(req, res, !!parsed.data.rememberBrowser, `passkey "${passkeyToJson(outcome.passkey).name}"`);
  } catch (err: unknown) {
    sendServerError(res, err, 'auth');
  }
});

// ── Account security status (full or enrol token) ────────────────────────────

// GET /api/v1/auth/two-factor
router.get('/two-factor', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!assertStage(req, res, 'full-or-enrol')) return;
  try {
    const userId = req.user!.userId;
    const raw = parseCookieHeader(req.headers.cookie)[TRUSTED_BROWSER_COOKIE];
    const currentHash = raw ? hashTrustedBrowserToken(raw) : null;
    const [totp, passkeys, browsers] = await Promise.all([
      db('user_totp').where({ user_id: userId }).first('confirmed_at', 'created_at'),
      db('user_passkeys').where({ user_id: userId }).orderBy('created_at', 'asc').select('*'),
      db('trusted_browsers')
        .where({ user_id: userId })
        .whereNull('revoked_at')
        .where('expires_at', '>', new Date())
        .orderBy('created_at', 'desc')
        .select('id', 'user_agent', 'created_at', 'last_used_at', 'expires_at', 'token_hash'),
    ]);
    const rp = getRelyingParty();
    res.json({
      data: {
        totpEnabled: !!totp?.confirmed_at,
        totpEnabledAt: (totp?.confirmed_at as string | null) ?? null,
        totpPendingEnrolment: !!totp && !totp.confirmed_at,
        passkeys: passkeys.map((p) => passkeyToJson(p)),
        trustedBrowsers: browsers.map((b) => ({
          id: b.id,
          userAgent: b.user_agent,
          createdAt: b.created_at,
          lastUsedAt: b.last_used_at,
          expiresAt: b.expires_at,
          current: currentHash !== null && b.token_hash === currentHash,
        })),
        requireTwoFactor: securitySettings().requireTwoFactor,
        passkeysAvailable: rp.ok,
        passkeyBlockReason: rp.ok ? null : rp.reason,
      },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'auth');
  }
});

export default router;
