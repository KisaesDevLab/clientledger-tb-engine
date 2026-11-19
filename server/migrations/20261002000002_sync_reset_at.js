/**
 * Desktop sync S2: when a password reset last cut off a user's desktops.
 *
 * A reset by emailed link (or by single sign-on administration) leaves the
 * user's existing sessions working, so a session from before the reset
 * could make a new pairing code and connect a desktop again. The code route
 * refuses a session issued before `sync_reset_at` (owner 2026-11-19: a
 * reset ends the account's desktops).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('app_users', 'sync_reset_at'))) {
    await knex.schema.alterTable('app_users', (t) => {
      t.timestamp('sync_reset_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('app_users', 'sync_reset_at')) {
    await knex.schema.alterTable('app_users', (t) => {
      t.dropColumn('sync_reset_at');
    });
  }
};
