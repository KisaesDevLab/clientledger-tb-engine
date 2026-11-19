/**
 * Desktop sync S2: paired desktops and the one-time codes that pair them.
 *
 * - sync_devices.token_hash is the SHA-256 of the device token
 *   (`vtbsync_…`), the posture of trusted_browsers and password reset tokens:
 *   the token itself is shown to the desktop once and never stored.
 * - A device acts as the user who paired it (SQ5). Revoking keeps the row
 *   (revoked_at) so the audit trail can still name it.
 * - sync_pairing_codes.code_hash is the SHA-256 of the normalised code; a
 *   code lives 10 minutes and pairs once (used_at).
 * - Every FK from app_users cascades: deleting a user drops their devices.
 *   These rows are per installation and are not in backups.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sync_devices'))) {
    await knex.schema.createTable('sync_devices', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().notNullable().references('id').inTable('app_users').onDelete('CASCADE');
      t.string('name', 100).notNullable();
      t.specificType('token_hash', 'char(64)').notNullable().unique();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_used_at', { useTz: true }).nullable();
      t.timestamp('revoked_at', { useTz: true }).nullable();
      t.integer('revoked_by').unsigned().nullable().references('id').inTable('app_users').onDelete('SET NULL');
      t.index(['user_id'], 'sync_devices_user_id_idx');
    });
  }
  if (!(await knex.schema.hasTable('sync_pairing_codes'))) {
    await knex.schema.createTable('sync_pairing_codes', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().notNullable().references('id').inTable('app_users').onDelete('CASCADE');
      t.specificType('code_hash', 'char(64)').notNullable().unique();
      t.timestamp('expires_at', { useTz: true }).notNullable();
      t.timestamp('used_at', { useTz: true }).nullable();
      t.integer('device_id').unsigned().nullable().references('id').inTable('sync_devices').onDelete('SET NULL');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('sync_pairing_codes');
  await knex.schema.dropTableIfExists('sync_devices');
};
