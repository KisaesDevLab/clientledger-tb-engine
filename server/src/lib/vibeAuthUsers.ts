// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * The two Vibe Auth adapters that only need the database: the UserAdapter
 * over `app_users` and the audit sink over `audit_log`. They live apart from
 * lib/vibeAuth.ts because the break-glass CLI (src/vibeAuthAdapter.ts) loads
 * them in a process that has no Express and must not import jwtConfig (which
 * exits without JWT_SECRET).
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import type { AuditSink, CreateLocalUserInput, CreateUserInput, UserAdapter, VibeUser } from '@kisaesdevlab/vibe-auth';
import { db } from '../db';
import { logAudit } from './periodGuard';
import { revokeUserDevices } from './sync/deviceRevoke';
import { ADMIN_ROLE, roleSyncRefusal } from './accountGuards';

/** audit_log.action for a role the identity provider pushed and this app declined to apply. */
export const ROLE_DEMOTION_REFUSED = 'vibe.auth.role.demotion_refused';

/** Same cost as routes/users.ts — one policy for every password hash. */
const BCRYPT_COST = 12;

interface AppUserRow {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
  role: string;
  is_active: boolean | null;
  password_hash: string | null;
}

const USER_COLUMNS = ['id', 'username', 'display_name', 'email', 'role', 'is_active', 'password_hash'] as const;

function toVibeUser(row: AppUserRow): VibeUser {
  return {
    id: String(row.id),
    email: row.email ?? '',
    name: row.display_name ?? undefined,
    role: row.role,
    active: !!row.is_active,
    local: !!row.password_hash,
    username: row.username,
  };
}

function userId(id: string): number {
  const n = Number(id);
  if (!Number.isInteger(n)) throw new Error(`vibe-auth: user id "${id}" is not an app_users id`);
  return n;
}

/**
 * A username for a just-in-time provisioned account: the email's local part,
 * reduced to the characters usernames already use, made unique with a numeric
 * suffix when it collides. `username` is NOT NULL UNIQUE on app_users.
 */
async function uniqueUsername(email: string): Promise<string> {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, '') ?? '';
  const base = (local.length >= 2 ? local : `sso-${local}`).slice(0, 90);
  let candidate = base;
  for (let i = 2; i < 1000; i++) {
    const clash = await db('app_users').where({ username: candidate }).first('id');
    if (!clash) return candidate;
    candidate = `${base}${i}`;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

/** A bcrypt hash of random bytes nobody knows: satisfies NOT NULL, can never be logged in with. */
async function unusablePasswordHash(): Promise<string> {
  return bcrypt.hash(crypto.randomBytes(48).toString('base64url'), BCRYPT_COST);
}

export interface VibeUsersOptions {
  /**
   * Called with the app_users id after a role / password / active change.
   * The server passes middleware/auth's invalidateAuthCache so the change
   * lands within the request, not after the 30 s cache; the CLI passes nothing.
   */
  onUserChanged?: (userId: number) => void;
}

export function createVibeUsers(opts: VibeUsersOptions = {}): UserAdapter {
  const changed = (id: number) => opts.onUserChanged?.(id);
  return {
    async findById(id) {
      const n = Number(id);
      if (!Number.isInteger(n)) return null;
      const row = await db('app_users').where({ id: n }).first(...USER_COLUMNS);
      return row ? toVibeUser(row as AppUserRow) : null;
    },

    async findByEmail(email) {
      const row = await db('app_users').whereRaw('LOWER(email) = ?', [email.trim().toLowerCase()]).first(...USER_COLUMNS);
      return row ? toVibeUser(row as AppUserRow) : null;
    },

    async findByUsername(username) {
      const row = await db('app_users').whereRaw('LOWER(username) = ?', [username.trim().toLowerCase()]).first(...USER_COLUMNS);
      return row ? toVibeUser(row as AppUserRow) : null;
    },

    /** Just-in-time provisioning from a verified IdP identity. */
    async create(input: CreateUserInput) {
      const email = input.email.trim().toLowerCase();
      const [row] = await db('app_users')
        .insert({
          username: await uniqueUsername(email),
          display_name: (input.name ?? email).slice(0, 255),
          email,
          email_verified_at: input.emailVerified ? db.fn.now() : null,
          password_hash: await unusablePasswordHash(),
          role: input.role,
          is_active: true,
          // The IdP is the credential; there is no temporary password to rotate.
          must_change_password: false,
          // No usable local password: self-service reset is refused until an
          // admin sets one (lib/accountGuards.ts, routes/passwordReset.ts).
          sso_only_since: db.fn.now(),
        })
        .returning([...USER_COLUMNS]);
      return toVibeUser(row as AppUserRow);
    },

    /**
     * Role sync from the identity provider's groups. A demotion that would
     * leave the firm with no active admin (the break-glass account does not
     * count), or that targets the break-glass account, is NOT applied: the
     * role stays and the refusal is audited. It never throws — that would
     * fail the sign-in. The package cannot be told, so its own
     * `vibe.auth.role.changed` row still follows; the refusal row next to it
     * is the truth, and mintSsoToken() reads the role back from the database.
     * The active-admin rows are locked so two concurrent demotions cannot
     * each see the other as the remaining admin.
     */
    async setRole(id, role) {
      const n = userId(id);
      const refused = await db.transaction(async (trx) => {
        if (role !== ADMIN_ROLE) {
          const target = await trx('app_users').where({ id: n }).forUpdate().first('id', 'username', 'role');
          if (target && target.role === ADMIN_ROLE) {
            const activeAdmins = await trx('app_users')
              .where({ role: ADMIN_ROLE, is_active: true })
              .orderBy('id')
              .forUpdate()
              .select('id', 'username');
            const reason = roleSyncRefusal({
              target: { id: n, username: target.username as string, role: target.role as string },
              newRole: role,
              activeAdmins: activeAdmins as Array<{ id: number; username: string }>,
            });
            if (reason) return { reason, username: target.username as string };
          }
        }
        await trx('app_users').where({ id: n }).update({ role, updated_at: trx.fn.now() });
        return null;
      });
      if (refused) {
        await logAudit({
          userId: n,
          periodId: null,
          entityType: 'auth',
          entityId: n,
          action: ROLE_DEMOTION_REFUSED,
          description: JSON.stringify({
            user_id: String(n),
            username: refused.username,
            from: ADMIN_ROLE,
            to: role,
            reason: refused.reason,
            kept: ADMIN_ROLE,
          }),
        });
        console.warn(`[vibe-auth] role sync refused: "${refused.username}" stays ${ADMIN_ROLE} (${refused.reason}); the identity provider asked for ${role}`);
        return;
      }
      changed(n);
    },

    /** Break-glass provisioning: an ACTIVE local admin with a real password. */
    async createLocalUser(input: CreateLocalUserInput) {
      const [row] = await db('app_users')
        .insert({
          username: input.username,
          display_name: input.name.slice(0, 255),
          email: input.email.trim().toLowerCase(),
          email_verified_at: db.fn.now(),
          password_hash: await bcrypt.hash(input.password, BCRYPT_COST),
          role: input.role,
          is_active: true,
          must_change_password: false,
        })
        .returning([...USER_COLUMNS]);
      return toVibeUser(row as AppUserRow);
    },

    async setLocalPassword(id, password) {
      const n = userId(id);
      await db('app_users').where({ id: n }).update({
        password_hash: await bcrypt.hash(password, BCRYPT_COST),
        must_change_password: false,
        sso_only_since: null,
        updated_at: db.fn.now(),
      });
      // A password set by an admin is a reset: paired desktops end (owner 2026-11-19).
      await revokeUserDevices(n, null, 'the password was set from single sign-on administration', { reset: true });
      changed(n);
    },

    async setActive(id, active) {
      const n = userId(id);
      await db('app_users').where({ id: n }).update({ is_active: active, updated_at: db.fn.now() });
      // Deactivation ends paired desktops for good (owner 2026-11-19).
      if (!active) await revokeUserDevices(n, null, 'the account was deactivated from single sign-on administration');
      changed(n);
    },
  };
}

// audit_log.action / entity_type are varchar(50); the longest package event
// type ("vibe.auth.mfa.enforcement.disabled") fits, but clamp anyway.
const ACTION_WIDTH = 50;

function numericId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
}

/**
 * Every package event lands in audit_log as one row: action = the event type,
 * entity_type = 'auth', description = the event payload as JSON (never
 * contains tokens or secrets — see the package's audit schema).
 */
export const vibeAuditSink: AuditSink = {
  async emit(event) {
    const { type, at, ...rest } = event;
    const actor = numericId(rest.user_id) ?? numericId(rest.actor);
    await logAudit({
      userId: actor,
      periodId: null,
      entityType: 'auth',
      entityId: numericId(rest.user_id),
      action: type.slice(0, ACTION_WIDTH),
      description: JSON.stringify({ ...rest, at }),
    });
  },
};
