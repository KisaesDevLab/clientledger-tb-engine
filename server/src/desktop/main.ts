// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Entry point of the desktop engine (Node SEA). Usage:
//
//   clientledger-tb-engine [serve]   migrate, seed a new database, start the API
//   clientledger-tb-engine migrate   apply pending migrations and exit
//   clientledger-tb-engine version   print the engine version and exit
//
// Env from the launcher: DATABASE_URL, PORT, JWT_SECRET, ENCRYPTION_KEY,
// CLTB_SESSION_TOKEN, UPLOADS_DIR, BACKUPS_DIR. Optional: KNOWLEDGE_DIR,
// FS_FONT_DIR (resource folders installed next to the engine).
//
// Every other module reads env at import time, so this file sets the desktop
// defaults first and loads the rest of the engine with require() afterwards.

/* eslint-disable @typescript-eslint/no-require-imports */
import type { Knex } from 'knex';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string };

const command = process.argv[2] ?? 'serve';

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function requireEnv(names: string[]): void {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) fatal(`missing environment variable(s): ${missing.join(', ')}`);
}

function applyDesktopEnv(): void {
  // The engine assumes the appliance's UTC clock: DATE columns become JS Dates
  // at local midnight, and a laptop east of UTC would serialize 2024-01-01 as
  // 2023-12-31. Must be set before anything creates a Date.
  process.env.TZ = 'UTC';
  process.env.DESKTOP_MODE = 'true';
  process.env.BIND_HOST = '127.0.0.1';
  process.env.NODE_ENV = 'production';
  process.env.MIGRATIONS_AUTO = 'true';
  process.env.ALLOWED_ORIGIN ??= 'http://127.0.0.1';
  process.env.npm_package_version = pkg.version;
}

async function withDb<T>(fn: (db: Knex) => Promise<T>): Promise<T> {
  const { db } = require('../db') as { db: Knex };
  return fn(db);
}

async function migrate(): Promise<void> {
  requireEnv(['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY']);
  const { migrateLatest } = require('./database') as typeof import('./database');
  await withDb(async (db) => {
    const applied = await migrateLatest(db);
    console.log(`[desktop] migrations applied: ${applied.length}`);
    await db.destroy();
  });
}

async function serve(): Promise<void> {
  requireEnv(['DATABASE_URL', 'PORT', 'JWT_SECRET', 'ENCRYPTION_KEY', 'CLTB_SESSION_TOKEN', 'UPLOADS_DIR', 'BACKUPS_DIR']);
  const desktopDb = require('./database') as typeof import('./database');
  const { setDesktopUser } = require('./session') as typeof import('./session');

  await withDb(async (db) => {
    const applied = await desktopDb.migrateLatest(db);
    console.log(`[desktop] migrations applied: ${applied.length}`);
    if (await desktopDb.seedIfEmpty(db)) console.log('[desktop] new database seeded');
    setDesktopUser(await desktopDb.bootstrapDesktopUser(db));
  });

  require('../app');
}

async function main(): Promise<void> {
  applyDesktopEnv();
  switch (command) {
    case 'version':
      console.log(pkg.version);
      return;
    case 'migrate':
      await migrate();
      process.exit(0);
      return;
    case 'serve':
      await serve();
      return;
    default:
      fatal(`unknown command "${command}" (expected serve, migrate or version)`);
  }
}

main().catch((err: unknown) => {
  console.error('FATAL: desktop engine failed to start:', err);
  process.exit(1);
});
