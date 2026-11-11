// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Writes fixtures/old-client-20260320.tbak (Q33): a client .tbak made at
// schema 20260320000001_mcp_support.js, from a real database migrated only
// that far. Two later migrations break the engine's direct client restore of
// it:
// - 20260321000002 drops chart_of_accounts.sort_order (the insert fails on
//   the unknown column);
// - 20260322000001 renumbers duplicate entry numbers before adding a unique
//   index (the insert fails on the index).
// It also carries a firm-added tax code mapped to an account, and a document.
//
// Run by hand against an EMPTY server (it creates and drops its own
// database):
//   PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres \
//     npx tsx src/desktop/__tests__/makeOldClientFixture.ts
// The fixture is committed; the shell's acceptance test (acceptance_p04)
// restores it.

import path from 'path';
import knexFactory, { type Knex } from 'knex';
import { migrateTo, listTables } from '../fullBackup';
import { selectClientTables, writeClientArchive, type Tables } from '../extractClient';
import { FORMAT_VERSION } from '../../lib/backupManifest';

const SCHEMA = '20260320000001_mcp_support.js';
const DB = 'cltb_old_fixture';
const OUT = path.join(__dirname, 'fixtures', 'old-client-20260320.tbak');
export const DOCUMENT_TEXT = 'Engagement letter, signed 2025-01-15.\n';

async function main(): Promise<void> {
  const adminUrl = process.env.PG_ADMIN_URL;
  if (!adminUrl) throw new Error('set PG_ADMIN_URL');
  const admin = knexFactory({ client: 'pg', connection: adminUrl });
  await admin.raw(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.raw(`CREATE DATABASE ${DB}`);
  const url = new URL(adminUrl);
  url.pathname = `/${DB}`;
  const db = knexFactory({ client: 'pg', connection: url.toString() });
  try {
    await migrateTo(db, SCHEMA);
    await fill(db);
    const all: Tables = {};
    for (const t of await listTables(db)) all[t] = (await db(t).select('*')) as Tables[string];
    const client = all.clients.find((c) => c.name === 'Old Mill Bakery, LLC')!;
    const selected = selectClientTables(all, client.id as number);
    const doc = selected.client_documents[0];
    await writeClientArchive(
      OUT,
      {
        version: '1.0',
        formatVersion: FORMAT_VERSION,
        source: 'desktop',
        appVersion: '0.1.0-fixture',
        schemaVersion: SCHEMA,
        backupType: 'client',
        backupLevel: 'client',
        createdAt: '2025-02-01T17:00:00.000Z',
        createdBy: 'desktop',
        clientId: client.id,
        clientName: client.name,
        periodId: null,
        periodName: null,
      },
      selected,
      (d) => (d.id === doc.id ? async () => Buffer.from(DOCUMENT_TEXT, 'utf8') : null),
    );
    console.log(`wrote ${OUT}`);
  } finally {
    await db.destroy();
    await admin.raw(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.destroy();
  }
}

async function fill(db: Knex): Promise<void> {
  // A user the archive will not carry (entries name who made them).
  const [user] = await db('app_users')
    .insert({ username: 'preparer', password_hash: '!', display_name: 'Preparer', role: 'admin' })
    .returning('id');
  const userId = (user as { id: number }).id;
  const [c] = await db('clients')
    .insert({ name: 'Old Mill Bakery, LLC', entity_type: '1065', tax_year_end: '1231', activity_type: 'business' })
    .returning('id');
  const clientId = (c as { id: number }).id;
  const [p] = await db('periods')
    .insert({ client_id: clientId, period_name: 'FY2024', start_date: '2024-01-01', end_date: '2024-12-31' })
    .returning('id');
  const periodId = (p as { id: number }).id;

  // A code the firm added itself (system codes came from seed files then).
  const [own] = await db('tax_codes')
    .insert({ tax_code: '99001', description: 'Bakery equipment (firm code)', return_form: '1065', activity_type: 'business', is_system: false, is_active: true })
    .returning('id');
  const ownId = (own as { id: number }).id;

  const accounts: Array<[string, string, string, string, number, number | null]> = [
    ['1000', 'Cash', 'assets', 'debit', 30, null],
    ['1500', 'Ovens and mixers', 'assets', 'debit', 20, ownId],
    ['3000', "Partners' capital", 'equity', 'credit', 10, null],
    ['4000', 'Sales', 'revenue', 'credit', 40, null],
    ['5000', 'Flour', 'expenses', 'debit', 50, null],
  ];
  const ids: Record<string, number> = {};
  for (const [number, name, category, normal, sort, taxCodeId] of accounts) {
    const [a] = await db('chart_of_accounts')
      .insert({
        client_id: clientId,
        account_number: number,
        account_name: name,
        category,
        normal_balance: normal,
        sort_order: sort,
        tax_code_id: taxCodeId,
        is_active: true,
      })
      .returning('id');
    ids[number] = (a as { id: number }).id;
  }
  const tb: Array<[string, number, number]> = [
    ['1000', 1_250_000, 0],
    ['1500', 4_000_000, 0],
    ['3000', 0, 3_000_000],
    ['4000', 0, 9_000_000],
    ['5000', 6_750_000, 0],
  ];
  for (const [number, dr, cr] of tb) {
    await db('trial_balance').insert({
      period_id: periodId,
      account_id: ids[number],
      unadjusted_debit: dr,
      unadjusted_credit: cr,
      updated_by: userId,
    });
  }
  // Two book entries both numbered 1 (allowed before 20260322000001).
  for (const [desc, amount] of [['Accrue December flour', 150_000], ['Reclass oven repair', 80_000]] as const) {
    const [je] = await db('journal_entries')
      .insert({ period_id: periodId, entry_number: 1, entry_type: 'book', entry_date: '2024-12-31', description: desc, created_by: userId })
      .returning('id');
    const jeId = (je as { id: number }).id;
    await db('journal_entry_lines').insert([
      { journal_entry_id: jeId, account_id: ids['5000'], debit: amount, credit: 0 },
      { journal_entry_id: jeId, account_id: ids['1000'], debit: 0, credit: amount },
    ]);
  }
  await db('client_documents').insert({
    client_id: clientId,
    filename: 'engagement-letter.txt',
    file_type: 'text/plain',
    file_size: Buffer.byteLength(DOCUMENT_TEXT),
    file_path: 'uploads/engagement-letter.txt',
    uploaded_by: userId,
  });
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
