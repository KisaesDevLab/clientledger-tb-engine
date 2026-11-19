/**
 * Desktop sync S4 (SQ3): a send-back applies a change to an existing
 * account or statement layout only when the server's row has not changed
 * since the pull, judged by `updated_at`. Not every writer sets it (tax-line
 * assignment, units, lead sheet assignment, imports, MCP, roll-forward), so
 * the database does: every UPDATE that changes one of these rows stamps
 * `updated_at = now()`, except inside a restore (`SET LOCAL vtb.keep_updated_at = 'on'`).
 */
const TABLES = ['chart_of_accounts', 'fs_client_layouts'];

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION vtb_touch_updated_at() RETURNS trigger AS $$
    BEGIN
      -- A restore keeps the archive's times (it sets vtb.keep_updated_at for its transaction).
      IF current_setting('vtb.keep_updated_at', true) = 'on' THEN RETURN NEW; END IF;
      -- A write that changes nothing is not a change.
      IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  for (const t of TABLES) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${t}_touch_updated_at ON ${t}`);
    await knex.raw(`CREATE TRIGGER ${t}_touch_updated_at BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION vtb_touch_updated_at()`);
  }
};

exports.down = async function (knex) {
  for (const t of TABLES) await knex.raw(`DROP TRIGGER IF EXISTS ${t}_touch_updated_at ON ${t}`);
  await knex.raw('DROP FUNCTION IF EXISTS vtb_touch_updated_at()');
};
