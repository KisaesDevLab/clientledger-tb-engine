// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// In-process migrate / seed / bootstrap for desktop mode. The appliance runs
// `knex migrate:latest` and `knex seed:run` from its entrypoint against the
// migrations/ and seeds/ folders; a bundled desktop engine has no folders, so
// it uses the static lists in sources.generated.ts. Migration names are the
// file names, exactly as knex records them, so a desktop database and an
// appliance database agree on what has been applied.

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { Knex } from 'knex';
import { MIGRATIONS, SEEDS, type ModuleThunk } from './sources.generated';

type Entry = readonly [string, ModuleThunk];

export function staticSource(entries: ReadonlyArray<Entry>) {
  return {
    getMigrations: async () => [...entries],
    getMigrationName: (e: Entry) => e[0],
    getMigration: async (e: Entry) => e[1]() as Knex.Migration,
  };
}

function staticSeedSource(entries: ReadonlyArray<Entry>) {
  return {
    getSeeds: async () => [...entries],
    getSeed: async (e: Entry) => e[1]() as Knex.Seed,
  };
}

export async function migrateLatest(db: Knex): Promise<string[]> {
  const [, applied] = (await db.migrate.latest({
    migrationSource: staticSource(MIGRATIONS),
  })) as [number, string[]];
  return applied;
}

/**
 * Seeds run only on a brand-new database: no admin user yet. (Not "no users":
 * a migration creates the `mcp_agent` system user.) Upstream seeds are written
 * to be no-ops on populated databases, but a desktop file the user has worked
 * in should never be touched by them.
 */
export async function seedIfEmpty(db: Knex): Promise<boolean> {
  const admin = await db('app_users').where({ role: 'admin' }).first('id');
  if (admin) return false;
  // knex's typings only allow a directory-based seed config; the runtime
  // accepts a seedSource the same way migrate accepts a migrationSource.
  await db.seed.run({ seedSource: staticSeedSource(SEEDS) } as unknown as Knex.SeederConfig);
  return true;
}

export interface DesktopUserRow { id: number; username: string; role: string }

/**
 * Desktop has no sign-in. The seeded `admin` account becomes the one user:
 * its published bootstrap password is replaced by a random one nobody knows,
 * the forced password change is cleared, and the two-factor requirement is off.
 * Runs on every start; each step is idempotent.
 */
export async function bootstrapDesktopUser(db: Knex): Promise<DesktopUserRow> {
  const user = await db('app_users')
    .where({ role: 'admin', is_active: true })
    .orderBy('id')
    .first<DesktopUserRow & { must_change_password: boolean }>('id', 'username', 'role', 'must_change_password');
  if (!user) throw new Error('No active admin user in the database.');

  if (user.must_change_password) {
    const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('base64'), 12);
    await db('app_users').where({ id: user.id }).update({ password_hash: unusable, must_change_password: false });
  }

  await db('settings')
    .insert({ key: 'security.require_two_factor', value: 'false' })
    .onConflict('key')
    .merge();

  return { id: user.id, username: user.username, role: user.role };
}
