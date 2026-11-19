/**
 * Desktop sync S1: a stable identity for the rows a desktop pull and
 * send-back must recognise on both sides (SQ1).
 *
 * Every key in this database is `increments('id')` and is re-keyed on every
 * restore, so no id survives a round trip. `sync_uid` does: a restore keeps
 * the archive's value unless a row here already holds it (a copy restored
 * next to its original mints a new one; `keepSyncUids` in routes/backup.ts).
 *
 * Only these four tables need one. Lead sheets match by code, tax codes by
 * form + activity + code, the tickmark library by symbol and lead sheet
 * attachments by ref code, all of which already exist.
 *
 * `gen_random_uuid()` is built into PostgreSQL 13+; a volatile default fills
 * every existing row with its own value when the column is added.
 */
const TABLES = ['clients', 'periods', 'chart_of_accounts', 'bank_transactions'];

exports.up = async function (knex) {
  for (const t of TABLES) {
    await knex.raw(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS sync_uid uuid NOT NULL DEFAULT gen_random_uuid()`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_sync_uid_unique ON ${t} (sync_uid)`);
  }
};

exports.down = async function (knex) {
  for (const t of TABLES) {
    await knex.raw(`DROP INDEX IF EXISTS ${t}_sync_uid_unique`);
    await knex.raw(`ALTER TABLE ${t} DROP COLUMN IF EXISTS sync_uid`);
  }
};
