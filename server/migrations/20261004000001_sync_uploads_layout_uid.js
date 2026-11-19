/**
 * Desktop sync S4: send-back uploads, and an identity for statement layouts.
 *
 * sync_uploads — a desktop sends a period archive in parts (attachment files
 * can pass a proxy's body cap, e.g. Cloudflare's 100 MB): one row per upload,
 * bound to the device, expiring after a day. The parts live on disk under
 * backups/sync/uploads/<id>/; `complete` joins them and checks the SHA-256.
 *
 * fs_client_layouts.sync_uid — a client's statement layout is client-level
 * and may be edited on the desktop while a period is out; a send-back
 * matches it by this uid and applies the SQ3 rule (owner 2026-11-19).
 */
exports.up = async function (knex) {
  // When the holder last pulled the period (a re-pull keeps the check-out):
  // SQ3 judges "changed on the server since the pull" from it.
  if (!(await knex.schema.hasColumn('period_checkouts', 'pulled_at'))) {
    await knex.schema.alterTable('period_checkouts', (t) => {
      t.timestamp('pulled_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('fs_client_layouts', 'sync_uid'))) {
    await knex.raw('ALTER TABLE fs_client_layouts ADD COLUMN sync_uid uuid NOT NULL DEFAULT gen_random_uuid()');
    await knex.raw('CREATE UNIQUE INDEX fs_client_layouts_sync_uid_unique ON fs_client_layouts (sync_uid)');
  }
  if (!(await knex.schema.hasTable('sync_uploads'))) {
    await knex.schema.createTable('sync_uploads', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.integer('device_id').notNullable().references('id').inTable('sync_devices').onDelete('CASCADE');
      t.integer('user_id').notNullable().references('id').inTable('app_users').onDelete('CASCADE');
      t.bigInteger('size').notNullable();
      t.string('sha256', 64).notNullable();
      t.integer('part_bytes').notNullable();
      /** Set once the parts are joined and the hash matched. */
      t.text('file_path').nullable();
      t.timestamp('completed_at', { useTz: true }).nullable();
      /** A job that took this upload (it is used once). */
      t.uuid('job_id').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('expires_at', { useTz: true }).notNullable();
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('period_checkouts', 'pulled_at')) {
    await knex.schema.alterTable('period_checkouts', (t) => t.dropColumn('pulled_at'));
  }
  await knex.schema.dropTableIfExists('sync_uploads');
  if (await knex.schema.hasColumn('fs_client_layouts', 'sync_uid')) {
    await knex.raw('DROP INDEX IF EXISTS fs_client_layouts_sync_uid_unique');
    await knex.raw('ALTER TABLE fs_client_layouts DROP COLUMN sync_uid');
  }
};
