/**
 * Desktop sync S3: check-outs and sync jobs.
 *
 * period_checkouts — a desktop that pulled a period to work on it holds it
 * (SQ2): while the row is live (released_at null) the period refuses writes
 * from the web app and MCP (`assertPeriodUnlocked`, PERIOD_CHECKED_OUT), and
 * only that device's send-back (S4) may replace its data. One live row per
 * period (partial unique index). Nothing releases one automatically: the
 * holder, or an admin with a reason.
 *
 * sync_jobs — a pull (and, in S4, a send-back) runs as a job so the call
 * returns at once; the state lives here so a restart reports `failed`
 * instead of losing the job. A pull's archive file is kept for a day.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('period_checkouts'))) {
    await knex.schema.createTable('period_checkouts', (t) => {
      t.increments('id').primary();
      t.integer('period_id').notNullable().references('id').inTable('periods').onDelete('CASCADE');
      t.integer('device_id').notNullable().references('id').inTable('sync_devices').onDelete('CASCADE');
      t.integer('user_id').notNullable().references('id').inTable('app_users').onDelete('CASCADE');
      /** The period stamp in the archive the device pulled (S4 compares it). */
      t.string('stamp_at_pull', 64).nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('released_at', { useTz: true }).nullable();
      t.integer('released_by').nullable().references('id').inTable('app_users').onDelete('SET NULL');
      t.text('release_reason').nullable();
    });
    await knex.raw('CREATE UNIQUE INDEX period_checkouts_one_live ON period_checkouts (period_id) WHERE released_at IS NULL');
    await knex.raw('CREATE INDEX period_checkouts_device ON period_checkouts (device_id) WHERE released_at IS NULL');
  }
  if (!(await knex.schema.hasTable('sync_jobs'))) {
    await knex.schema.createTable('sync_jobs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.integer('device_id').notNullable().references('id').inTable('sync_devices').onDelete('CASCADE');
      t.integer('user_id').notNullable().references('id').inTable('app_users').onDelete('CASCADE');
      t.string('kind', 30).notNullable();
      t.integer('client_id').nullable().references('id').inTable('clients').onDelete('CASCADE');
      t.integer('period_id').nullable().references('id').inTable('periods').onDelete('CASCADE');
      t.integer('checkout_id').nullable().references('id').inTable('period_checkouts').onDelete('SET NULL');
      /** This job's pull took the check-out (a re-pull reuses one): only then does a failure release it. */
      t.boolean('checkout_created').notNullable().defaultTo(false);
      /** queued → running → done | failed */
      t.string('state', 10).notNullable().defaultTo('queued');
      t.jsonb('result').nullable();
      t.jsonb('error').nullable();
      t.text('file_path').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('started_at', { useTz: true }).nullable();
      t.timestamp('finished_at', { useTz: true }).nullable();
    });
    await knex.raw("CREATE INDEX sync_jobs_open ON sync_jobs (state) WHERE state IN ('queued', 'running')");
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('sync_jobs');
  await knex.schema.dropTableIfExists('period_checkouts');
};
