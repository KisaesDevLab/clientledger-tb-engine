// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop: the id of the one engine user every request runs as, set at
// start-up by session.ts. Kept apart from session.ts so a route (me.ts) can
// read it without loading the token signer, which needs JWT_SECRET at load.

let userId: number | null = null;

export function setCurrentUserId(id: number): void {
  userId = id;
}

export function currentUserId(): number | null {
  return userId;
}
