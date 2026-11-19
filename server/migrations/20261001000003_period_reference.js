/**
 * Desktop sync: a period that came along only as a reference.
 *
 * A period archive carries, without their data, the other periods its own
 * rows name: a variance note's comparison period, an earlier period's
 * transaction that a reconciliation clears (owner 2026-11-19, SQ7). Where
 * that period is not already here it arrives as a real row so those notes
 * and items have something to point at. `is_reference` marks it (owner
 * 2026-11-19):
 *
 *   - it is left out of period lists (web, MCP) and of every prior-period
 *     lookup (Statement Writer, QuickBooks), so figures are as they would be
 *     with no prior period at all;
 *   - `assertPeriodUnlocked` refuses any write into it (as PERIOD_LOCKED, with
 *     its own message, so every route answers 409);
 *   - when the real period arrives later (a pull of that period), the
 *     reference is filled in and the flag cleared (sync S4).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('periods', 'is_reference'))) {
    await knex.schema.alterTable('periods', (t) => {
      t.boolean('is_reference').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('periods', 'is_reference')) {
    await knex.schema.alterTable('periods', (t) => {
      t.dropColumn('is_reference');
    });
  }
};
