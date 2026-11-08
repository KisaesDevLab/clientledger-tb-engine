// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop mode (ClientLedger Trial Balance). One user, one machine, started by
// the desktop launcher, bound to 127.0.0.1. See docs/DESKTOP.md.

export const SESSION_HEADER = 'x-cltb-session';

export function isDesktopMode(): boolean {
  return process.env.DESKTOP_MODE === 'true';
}

/** The per-launch token the launcher hands to both the engine and the UI. */
export function launchToken(): string {
  return process.env.CLTB_SESSION_TOKEN ?? '';
}

/** Rate limiters exist to protect a shared server; desktop has one user. */
export function skipRateLimit(): boolean {
  return isDesktopMode();
}
