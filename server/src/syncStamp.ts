// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Prints the desktop-sync period stamp of each period id given (one per
// line), for operators and the backup round-trip test. Read only.
//
// Usage: npm run sync:stamp -- <periodId> [<periodId> …]

import 'dotenv/config';
import knex, { Knex } from 'knex';
import { stampPeriod } from './lib/sync/periodStampLoad';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require('../knexfile') as Record<string, Knex.Config>;

const ids = process.argv.slice(2).map(Number);
if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
  console.error('Usage: npm run sync:stamp -- <periodId> [<periodId> …]');
  process.exit(2);
}

const k = knex(config[process.env.NODE_ENV === 'production' ? 'production' : 'development']);
(async () => {
  for (const id of ids) {
    const stamp = await stampPeriod(k, id);
    console.log(`${id} ${stamp ?? 'no-such-period'}`);
  }
  await k.destroy();
})().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await k.destroy();
  process.exit(1);
});
