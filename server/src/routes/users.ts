// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { db } from '../db';
import { authMiddleware, AuthRequest, invalidateAuthCache } from '../middleware/auth';
import { logAudit } from '../lib/periodGuard';
import { revokeUserDevices } from '../lib/sync/deviceRevoke';
import { sendServerError } from '../lib/safeError';
import { passwordSchema } from '../lib/passwordPolicy';
import { sendUserInvite, type InviteFailureReason, type InviteResult } from '../lib/inviteService';
import { resetTwoFactor } from '../lib/twoFactorReset';
import { breakglassChangeRefusal, mustChangeAfterAdminPasswordSet, type AccountChange } from '../lib/accountGuards';

export const usersRouter = Router();
usersRouter.use(authMiddleware);

/**
 * The break-glass account may not be deactivated, demoted or renamed by any
 * admin, in any sign-in mode (lib/accountGuards.ts). Answers 409 and audits
 * the attempt when the change is refused; returns whether it did.
 */
async function refusedAsBreakglass(
  req: AuthRequest,
  res: Response,
  target: { id: number; username: string },
  change: AccountChange,
): Promise<boolean> {
  const refusal = breakglassChangeRefusal(target.username, change);
  if (!refusal) return false;
  const attempted = [
    change.isActive === false ? 'deactivate' : null,
    change.role !== undefined ? `role → ${change.role}` : null,
    change.username !== undefined ? 'rename' : null,
  ].filter(Boolean).join(', ');
  await logAudit({ userId: req.user!.userId, periodId: null, entityType: 'user', entityId: target.id, action: 'breakglass_protected', description: `Refused change to break-glass account "${target.username}" (${attempted})` });
  res.status(409).json({ data: null, error: refusal });
  return true;
}

function adminOnly(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'Admin access required.' } });
    return;
  }
  next();
}

// Treat empty string as "not set" so the form can submit a blank email field
// without tripping the email-format validator.
const optionalEmail = z
  .union([z.literal(''), z.string().email().max(320)])
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v));

const userSchema = z
  .object({
    username: z.string().min(2).max(100),
    displayName: z.string().min(1).max(255),
    email: optionalEmail,
    // Optional only when an invite is sent instead — the invitee picks their
    // own password from the emailed link.
    password: passwordSchema.optional(),
    role: z.enum(['admin', 'reviewer', 'preparer']),
    sendInvite: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.password && !v.sendInvite) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Set a password, or tick "Send invite email" to let the user choose their own.',
      });
    }
    if (v.sendInvite && !v.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email'],
        message: 'An email address is required to send an invite.',
      });
    }
  });

// 20 invite sends per hour per admin session/IP. Generous for onboarding a
// team, tight enough that a compromised admin token can't be used to blast
// mail through our transport.
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    data: null,
    error: { code: 'RATE_LIMITED', message: 'Too many invites sent. Please try again later.' },
  },
});

// HTTP status per invite failure: a missing email or an inactive user is the
// caller's problem (400/409); an unconfigured mailer is the deployment's (503).
const INVITE_FAILURE: Record<InviteFailureReason, { status: number; code: string }> = {
  not_found: { status: 404, code: 'NOT_FOUND' },
  inactive: { status: 409, code: 'INVALID_INPUT' },
  no_email: { status: 400, code: 'NO_EMAIL' },
  mail_not_configured: { status: 503, code: 'MAIL_NOT_CONFIGURED' },
  send_failed: { status: 502, code: 'MAIL_SEND_FAILED' },
};

const USER_COLUMNS = [
  'id',
  'username',
  'display_name',
  'email',
  'role',
  'is_active',
  'invited_at',
  'invite_accepted_at',
  'created_at',
  'updated_at',
] as const;

// GET /api/v1/users
usersRouter.get('/', adminOnly, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await db('app_users')
      .select(
        ...USER_COLUMNS,
        db.raw('EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = app_users.id AND t.confirmed_at IS NOT NULL) AS totp_enabled'),
        db.raw('(SELECT COUNT(*)::int FROM user_passkeys p WHERE p.user_id = app_users.id) AS passkey_count'),
        db.raw('(SELECT COUNT(*)::int FROM trusted_browsers b WHERE b.user_id = app_users.id AND b.revoked_at IS NULL AND b.expires_at > now()) AS trusted_browser_count'),
      )
      .orderBy('display_name');
    res.json({ data: users, error: null, meta: { count: users.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'users');
  }
});

// POST /api/v1/users
usersRouter.post('/', adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = userSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { username, displayName, email, password, role, sendInvite } = parsed.data;

  try {
    // Invite-only accounts get a random, un-communicated password: nothing can
    // log in until the invitee sets one through the emailed link.
    const initialPassword = password ?? crypto.randomBytes(48).toString('base64url');
    const hash = await bcrypt.hash(initialPassword, 12);
    const [user] = await db('app_users').insert({
      username,
      display_name: displayName,
      email: email ?? null,
      password_hash: hash,
      role,
      is_active: true,
      // Admin-provisioned accounts must rotate on first login — the creating admin
      // necessarily knows the initial password.
      must_change_password: true,
    }).returning([...USER_COLUMNS]);

    await logAudit({ userId: req.user!.userId, periodId: null, entityType: 'user', entityId: user.id, action: 'create', description: `Created user "${username}" (role: ${role})` });

    // The account exists either way — a failed invite is reported alongside it
    // rather than rolled back, so the admin can fix mail settings and resend.
    let invite: InviteResult | null = null;
    if (sendInvite) {
      invite = await sendUserInvite(user.id, {
        invitedByUserId: req.user!.userId,
        requesterIp: (req.ip ?? req.socket?.remoteAddress ?? null) as string | null,
      });
      if (invite.sent) user.invited_at = new Date().toISOString();
    }

    res.status(201).json({ data: { ...user, invite }, error: null });
  } catch (err: unknown) {
    const internal = err instanceof Error ? err.message : '';
    if (internal.includes('unique') || internal.includes('duplicate')) {
      res.status(409).json({ data: null, error: { code: 'DUPLICATE', message: 'Username already exists.' } });
      return;
    }
    sendServerError(res, err, 'users');
  }
});

// PATCH /api/v1/users/:id
usersRouter.patch('/:id', adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid user ID' } });
    return;
  }

  const patchSchema = z.object({
    displayName: z.string().min(1).max(255).optional(),
    email: optionalEmail,
    password: passwordSchema.optional(),
    role: z.enum(['admin', 'reviewer', 'preparer']).optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }

  if (id === req.user!.userId && parsed.data.isActive === false) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'You cannot deactivate your own account.' } });
    return;
  }

  try {
    const target = await db('app_users').where({ id }).first('id', 'username');
    if (!target) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }
    // `username` is not patchable at all (the schema strips it), so a rename
    // cannot reach this point; deactivation and demotion can.
    if (await refusedAsBreakglass(req, res, target, { isActive: parsed.data.isActive, role: parsed.data.role })) return;

    const updates: Record<string, unknown> = { updated_at: db.fn.now() };
    if (parsed.data.displayName !== undefined) updates.display_name = parsed.data.displayName;
    if (parsed.data.email !== undefined) updates.email = parsed.data.email;
    if (parsed.data.role !== undefined) updates.role = parsed.data.role;
    if (parsed.data.isActive !== undefined) updates.is_active = parsed.data.isActive;
    if (parsed.data.password) {
      updates.password_hash = await bcrypt.hash(parsed.data.password, 12);
      // Admin-initiated password reset: force target user to rotate on next login.
      // Exception: if the admin is resetting their own password here, the change-password
      // flow is a better fit — but this endpoint still requires rotation for safety.
      // Second exception: the break-glass account is never put into forced
      // rotation (see mustChangeAfterAdminPasswordSet).
      updates.must_change_password = mustChangeAfterAdminPasswordSet(target.username);
      // An admin giving a single-sign-on account a password makes it a local
      // account too: self-service reset applies from here on.
      updates.sso_only_since = null;
    }

    const [updated] = await db('app_users').where({ id }).update(updates)
      .returning([...USER_COLUMNS]);
    if (!updated) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }
    // Role or is_active change must take effect immediately for an already-
    // authenticated target user, so drop their cached auth lookup.
    invalidateAuthCache(id);
    const changedFields = Object.keys(updates).filter(k => k !== 'updated_at');
    const hasPasswordChange = changedFields.includes('password_hash');
    // A password reset ends the desktops the account paired (owner 2026-11-19).
    if (hasPasswordChange) await revokeUserDevices(id, req.user!.userId, `an admin reset the password of "${updated.username}"`, { reset: true });
    // Deactivation ends them for good: reactivating does not bring them back.
    if (parsed.data.isActive === false) await revokeUserDevices(id, req.user!.userId, `"${updated.username}" was deactivated`);
    await logAudit({ userId: req.user!.userId, periodId: null, entityType: 'user', entityId: id, action: 'update', description: `Updated user "${updated.username}" — ${hasPasswordChange ? 'password changed' : changedFields.join(', ')}` });
    res.json({ data: updated, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'users');
  }
});

// POST /api/v1/users/:id/invite
// Sends the invite email — and is also the resend. One handler because the
// server-side work is identical; only the copy and the audit action differ,
// both derived from whether the user has been invited before. Every call
// supersedes any outstanding link for that user.
usersRouter.post('/:id/invite', adminOnly, inviteLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid user ID' } });
    return;
  }

  try {
    const result = await sendUserInvite(id, {
      invitedByUserId: req.user!.userId,
      requesterIp: (req.ip ?? req.socket?.remoteAddress ?? null) as string | null,
    });

    if (!result.sent) {
      const { status, code } = INVITE_FAILURE[result.reason];
      res.status(status).json({ data: null, error: { code, message: result.message } });
      return;
    }

    res.json({ data: result, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'users/invite');
  }
});

// DELETE /api/v1/users/:id  (deactivate — never hard delete)
usersRouter.delete('/:id', adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid user ID' } });
    return;
  }
  if (id === req.user!.userId) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'You cannot deactivate your own account.' } });
    return;
  }
  try {
    const target = await db('app_users').where({ id }).first('id', 'username');
    if (target && (await refusedAsBreakglass(req, res, target, { isActive: false }))) return;
    const [updated] = await db('app_users').where({ id })
      .update({ is_active: false, updated_at: db.fn.now() })
      .returning([...USER_COLUMNS]);
    if (!updated) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }
    invalidateAuthCache(id);
    await logAudit({ userId: req.user!.userId, periodId: null, entityType: 'user', entityId: id, action: 'delete', description: `Deactivated user "${updated.username}"` });
    res.json({ data: updated, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'users');
  }
});

// ── Two-factor (admin) ───────────────────────────────────────────────────────

// POST /api/v1/users/:id/reset-two-factor — remove the user's authenticator
// app, passkeys and remembered browsers. Their next sign-in is password-only
// (and, if the firm requires 2FA, lands on the enrolment screen).
usersRouter.post('/:id/reset-two-factor', adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid user id' } });
    return;
  }
  try {
    const user = await db('app_users').where({ id }).first('id', 'username');
    if (!user) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }
    const r = await resetTwoFactor(id, { actorUserId: req.user!.userId, via: 'admin' });
    res.json({
      data: { totpEnabled: false, passkeyCount: 0, trustedBrowserCount: 0, totpRemoved: r.totpRemoved, passkeysRemoved: r.passkeysRemoved, trustedBrowsersRevoked: r.trustedBrowsersRevoked },
      error: null,
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'users');
  }
});
