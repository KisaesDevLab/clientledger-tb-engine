// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Desktop: every client has a documents folder. The appliance makes linking an
// explicit admin act (a shared bucket, folders named by a firm); on one laptop
// with one local folder there is nothing to choose, and an unlinked client
// cannot store a document at all (CLIENT_NOT_LINKED). So the desktop links
// every unlinked client: at start-up and before any request that writes.

import type { Knex } from 'knex';
import { createClientFolder } from '../lib/clientFolders';

let running: Promise<number> | null = null;

/** Link every client that has no folder yet. Returns how many were linked. */
export async function ensureClientLinks(db: Knex): Promise<number> {
  // One pass at a time: two overlapping passes would race for one folder name.
  if (running) return running;
  running = (async () => {
    const missing = (await db('clients as c')
      .leftJoin('client_folder_links as l', 'l.client_id', 'c.id')
      .whereNull('l.id')
      .select('c.id')) as Array<{ id: number }>;
    let linked = 0;
    for (const { id } of missing) {
      try {
        const r = await createClientFolder(id, null, null);
        if (r.ok) linked += 1;
        else console.warn(`[desktop] client ${id} folder not linked: ${r.message}`);
      } catch (err) {
        console.warn(`[desktop] client ${id} folder not linked:`, err instanceof Error ? err.message : err);
      }
    }
    return linked;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}
