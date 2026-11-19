// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Desktop sync S2: the device token a paired desktop holds and the one-time
 * code that pairs it. Pure.
 *
 * - A token is `vtbsync_` + 32 random bytes (base64url). Only its SHA-256 is
 *   stored. The prefix lets the sync middleware tell it from a JWT, and lets
 *   a secret scanner recognise a leaked one.
 * - A code is 8 characters from an alphabet without look-alikes (no 0/O,
 *   1/I/L), shown as XXXX-XXXX. It is typed by a person, so input is
 *   normalised: case, spaces and dashes do not matter. 31^8 ≈ 8.5e11
 *   codes, a 10-minute life, one use and a rate limit on pairing make
 *   guessing hopeless.
 */

import crypto from 'crypto';

export const TOKEN_PREFIX = 'vtbsync_';
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_NAME_MAX = 100;

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** A new device token. */
export function newDeviceToken(): string {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

/** The text looks like a device token (not a JWT, not anything else). */
export function isDeviceToken(s: string): boolean {
  return /^vtbsync_[A-Za-z0-9_-]{43}$/.test(s);
}

/** A new pairing code, as stored (no dash). */
export function newPairingCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/** The code as shown: XXXX-XXXX. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A typed code, normalised, or `null` when it cannot be one. */
export function normaliseCode(typed: string): string | null {
  const c = typed.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== CODE_LENGTH) return null;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return null;
  return c;
}

/** A device name as given, tidied: trimmed, single spaces, at most 100 characters; `null` when blank. */
export function tidyDeviceName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.replace(/\s+/g, ' ').trim().slice(0, DEVICE_NAME_MAX);
  return n.length > 0 ? n : null;
}
