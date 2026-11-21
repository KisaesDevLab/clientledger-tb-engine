// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Knex } from 'knex';
import { db } from '../db';

/** Throws a 409-coded error if the period is locked, or a 404 if the period doesn't exist.
 *
 *  When called with a transaction, takes a row-level FOR UPDATE lock on the `periods` row
 *  so the caller's subsequent writes cannot race a concurrent lock/unlock. This closes a
 *  TOCTOU window where another transaction would mark the period locked between our check
 *  and our write. Callers performing mutations MUST pass a trx.
 *
 *  When called without a trx, performs a plain read — acceptable only for read-only paths
 *  (reports / comparisons) where a stale answer is fine.
 */
export async function assertPeriodUnlocked(
  periodId: number,
  trx?: Knex.Transaction,
  opts: {
    /**
     * Desktop sync S4's merge, writing for the device that holds this
     * check-out: the one caller a checked-out period lets through.
     */
    syncCheckoutId?: number;
  } = {},
): Promise<void> {
  const q = trx ?? db;
  let query = q('periods').where({ id: periodId });
  if (trx) {
    query = query.forUpdate();
  }
  const period = await query.first('id', 'locked_at', 'is_reference');
  if (!period) {
    throw Object.assign(
      new Error('Period not found.'),
      { code: 'PERIOD_NOT_FOUND', status: 404 },
    );
  }
  if (period.is_reference) {
    // PERIOD_LOCKED, so every route that maps a locked period (about twenty)
    // answers 409 with this message rather than a 500; `reference` tells why.
    throw Object.assign(
      new Error('This period came along only as a reference for another period: it holds no data here and cannot be changed.'),
      { code: 'PERIOD_LOCKED', status: 409, reference: true, expose: true },
    );
  }
  if (period.locked_at) {
    throw Object.assign(
      new Error('This period is locked and cannot be modified. Unlock it first.'),
      // expose: a route that does not map PERIOD_LOCKED answers 409, not 500.
      { code: 'PERIOD_LOCKED', status: 409, expose: true },
    );
  }
  // Desktop sync (S3): a period a desktop has checked out is that desktop's
  // until it sends it back or an admin releases it. `expose` lets the code
  // and message through `sendServerError`, so a route that only maps
  // PERIOD_LOCKED still answers 409 PERIOD_CHECKED_OUT.
  const out = await checkedOutBy(q, periodId);
  if (out && out.id !== opts.syncCheckoutId) throw checkedOutError(out);
}

/** The refusal for a period a desktop holds: 409 PERIOD_CHECKED_OUT, naming who. */
export function checkedOutError(out: PeriodCheckoutHolder): Error {
  return Object.assign(
    new Error(`This period is checked out to ${out.user} on "${out.device}" since ${out.since.toISOString().slice(0, 10)}. It can be changed once they send it back, or an admin releases it.`),
    { code: 'PERIOD_CHECKED_OUT', status: 409, expose: true, checkout: out },
  );
}

/**
 * Desktop sync S3: refuses a write into any of these periods that a desktop
 * holds, for writes the lock does not cover (lock behaviour is unchanged).
 * Takes each period row FOR UPDATE, in id order, inside the write's
 * transaction, which orders the write against a pull's check-out. Null ids
 * (rows that belong to no period) are skipped.
 */
export async function assertNotCheckedOut(
  trx: Knex.Transaction,
  periodIds: Iterable<number | string | null | undefined>,
  opts: { syncCheckoutId?: number } = {},
): Promise<void> {
  const ids = [...new Set([...periodIds].map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  for (const id of ids) {
    const row = await trx('periods').where({ id }).forUpdate().first('id', 'is_reference');
    // A reference period (desktop sync) holds no data here: no write of any kind.
    if (row?.is_reference) throw referenceError();
    const out = await checkedOutBy(trx, id);
    if (out && out.id !== opts.syncCheckoutId) throw checkedOutError(out);
  }
}

/**
 * The periods a delete reaches through foreign keys beyond the rows' own
 * periods (code review): deleting bank transactions cascades into the
 * reconciliations that cleared them, in whatever period; deleting journal
 * entries un-links the bank transactions that point at them; deleting a
 * period does both for its own transactions and entries, and cascades into
 * other periods' variance notes that compare with it. Any of those periods
 * a desktop holds would change under it and its send-back be refused.
 */
export async function periodsReachedByDelete(
  trx: Knex.Transaction,
  what: { periodIds?: number[]; transactionIds?: number[]; journalEntryIds?: number[] },
): Promise<number[]> {
  const periodIds = what.periodIds ?? [];
  const out = new Set<number>();
  const txIds = [...(what.transactionIds ?? [])];
  const jeIds = [...(what.journalEntryIds ?? [])];
  if (periodIds.length) {
    txIds.push(...((await trx('bank_transactions').whereIn('period_id', periodIds).pluck('id')) as number[]));
    jeIds.push(...((await trx('journal_entries').whereIn('period_id', periodIds).pluck('id')) as number[]));
    for (const id of (await trx('variance_notes').whereIn('compare_period_id', periodIds).distinct().pluck('period_id')) as number[]) out.add(Number(id));
  }
  for (let k = 0; k < txIds.length; k += 1000) {
    const rows = (await trx('reconciliation_items as i').join('bank_reconciliations as r', 'r.id', 'i.reconciliation_id')
      .whereIn('i.transaction_id', txIds.slice(k, k + 1000)).distinct().pluck('r.period_id')) as number[];
    for (const id of rows) out.add(Number(id));
  }
  for (let k = 0; k < jeIds.length; k += 1000) {
    const rows = (await trx('bank_transactions').whereIn('journal_entry_id', jeIds.slice(k, k + 1000)).whereNotNull('period_id')
      .distinct().pluck('period_id')) as number[];
    for (const id of rows) out.add(Number(id));
  }
  for (const id of periodIds) out.delete(id);
  return [...out].sort((a, b) => a - b);
}

/** Takes these period rows FOR UPDATE in one statement, in id order. */
export async function lockPeriodsInOrder(trx: Knex.Transaction, periodIds: Iterable<number | string | null | undefined>): Promise<void> {
  const ids = [...new Set([...periodIds].map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (ids.length) await trx('periods').whereIn('id', ids).orderBy('id').forUpdate().select('id');
}

/**
 * Refuses a delete whose cascades would change a period a desktop holds
 * (409 PERIOD_CHECKED_OUT). A reference period it reaches is not refused:
 * it holds no rows for the delete to change.
 */
export async function assertDeleteSparesHeldPeriods(
  trx: Knex.Transaction,
  what: { periodIds?: number[]; transactionIds?: number[]; journalEntryIds?: number[] },
  ownPeriodIds: Iterable<number | null | undefined> = [],
): Promise<void> {
  const reached = await periodsReachedByDelete(trx, what);
  // Every period the delete touches, its own and those it reaches, locked in
  // one ascending pass before any other guard locks one (code review: rounds
  // sorted separately could deadlock two deletes against each other). The
  // guards that follow lock rows this transaction already holds.
  await lockPeriodsInOrder(trx, [...ownPeriodIds, ...(what.periodIds ?? []), ...reached]);
  if (reached.length === 0) return;
  const held = new Set(await lockAndListHeld(trx, reached));
  for (const id of reached) {
    if (!held.has(id)) continue;
    const out = await checkedOutBy(trx, id);
    if (out) throw checkedOutError(out);
  }
}

/** The refusal for a period that came along only as a reference. */
export function referenceError(): Error {
  return Object.assign(
    new Error('This period came along only as a reference for another period: it holds no data here and cannot be changed.'),
    { code: 'PERIOD_LOCKED', status: 409, reference: true, expose: true },
  );
}

/**
 * For writes that should SKIP rows of a held period instead of refusing the
 * batch (AI suggestions): locks the periods, as `assertNotCheckedOut`, and
 * returns the ids a desktop holds.
 */
export async function lockAndListHeld(trx: Knex.Transaction, periodIds: Iterable<number | string | null | undefined>): Promise<Set<number>> {
  const ids = [...new Set([...periodIds].map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const refs: number[] = [];
  for (const id of ids) {
    const row = await trx('periods').where({ id }).forUpdate().first('id', 'is_reference');
    if (row?.is_reference) refs.push(id);
  }
  if (ids.length === 0) return new Set();
  const held = (await trx('period_checkouts').whereIn('period_id', ids).whereNull('released_at').pluck('period_id')) as number[];
  // A reference period is skipped like a held one.
  return new Set([...held.map(Number), ...refs]);
}

/**
 * Owner 2026-11-19: while any period of a client is checked out, a lead
 * sheet's code and a tickmark's symbol stay as they are (a send-back matches
 * by them). 409 PERIOD_CHECKED_OUT naming the first holder.
 */
export async function assertClientKeysFrozen(trx: Knex.Transaction, clientId: number, what: string): Promise<void> {
  const row = await trx('period_checkouts as c').join('periods as p', 'p.id', 'c.period_id')
    .where('p.client_id', clientId).whereNull('c.released_at').orderBy('c.id').first('c.period_id');
  if (!row) return;
  const holder = await checkedOutBy(trx, Number(row.period_id));
  if (!holder) return;
  throw Object.assign(
    new Error(`A period of this client is checked out to ${holder.user} on "${holder.device}", so ${what} cannot change until it is sent back or released.`),
    { code: 'PERIOD_CHECKED_OUT', status: 409, expose: true, checkout: holder },
  );
}

/** Refuses when any period of the client is held (a restore that replaces the client). */
export async function assertClientNotCheckedOut(trx: Knex.Transaction, clientId: number): Promise<void> {
  const ids = (await trx('period_checkouts as c').join('periods as p', 'p.id', 'c.period_id')
    .where('p.client_id', clientId).whereNull('c.released_at').pluck('c.period_id')) as number[];
  await assertNotCheckedOut(trx, ids);
}

export interface PeriodCheckoutHolder {
  id: number;
  user: string;
  device: string;
  deviceId: number;
  since: Date;
}

/** The live check-out of a period, if any (desktop sync S3). */
export async function checkedOutBy(q: Knex | Knex.Transaction, periodId: number): Promise<PeriodCheckoutHolder | null> {
  const row = await q('period_checkouts as c')
    .join('sync_devices as d', 'd.id', 'c.device_id')
    .join('app_users as u', 'u.id', 'c.user_id')
    .where('c.period_id', periodId)
    .whereNull('c.released_at')
    .first('c.id', 'c.created_at', 'd.id as device_id', 'd.name as device', 'u.display_name', 'u.username');
  if (!row) return null;
  return { id: row.id, user: row.display_name ?? row.username, device: row.device, deviceId: row.device_id, since: new Date(row.created_at) };
}

/** The live check-outs of many periods in one query (code review: one query per period before). */
export async function checkedOutByMany(q: Knex | Knex.Transaction, periodIds: number[]): Promise<Map<number, PeriodCheckoutHolder>> {
  const out = new Map<number, PeriodCheckoutHolder>();
  if (periodIds.length === 0) return out;
  const rows = await q('period_checkouts as c')
    .join('sync_devices as d', 'd.id', 'c.device_id')
    .join('app_users as u', 'u.id', 'c.user_id')
    .whereIn('c.period_id', periodIds)
    .whereNull('c.released_at')
    .select('c.id', 'c.period_id', 'c.created_at', 'd.id as device_id', 'd.name as device', 'u.display_name', 'u.username');
  for (const row of rows) {
    out.set(Number(row.period_id), { id: row.id, user: row.display_name ?? row.username, device: row.device, deviceId: row.device_id, since: new Date(row.created_at) });
  }
  return out;
}

interface AuditEntry {
  userId: number | null;
  periodId: number | null;
  /** Optional client_id. If not set and periodId is, it will be resolved automatically. */
  clientId?: number | null;
  entityType: string;
  entityId?: number | null;
  action: string;
  description?: string;
  tableName?: string;
}

/** Insert a row into audit_log. Fire-and-forget safe — errors are silently swallowed.
 *  When called within a transaction, uses a SAVEPOINT so that audit insert failures
 *  do not poison the parent transaction (PostgreSQL aborts the entire txn on any error). */
export async function logAudit(entry: AuditEntry, trx?: Knex.Transaction): Promise<void> {
  const q = trx ?? db;
  try {
    // If the caller didn't supply clientId but did supply periodId, resolve
    // it now so the audit row survives downstream period/client remapping.
    let clientId = entry.clientId ?? null;
    if (clientId === null && entry.periodId !== null) {
      try {
        const row = await q('periods').where({ id: entry.periodId }).first('client_id');
        clientId = (row?.client_id as number | undefined) ?? null;
      } catch {
        clientId = null;
      }
    }

    if (trx) {
      await trx.raw('SAVEPOINT audit_savepoint');
    }
    await q('audit_log').insert({
      user_id: entry.userId ?? null,
      period_id: entry.periodId ?? null,
      client_id: clientId,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      action: entry.action,
      description: entry.description ?? null,
      table_name: entry.tableName ?? entry.entityType,
    });
    if (trx) {
      await trx.raw('RELEASE SAVEPOINT audit_savepoint');
    }
  } catch {
    if (trx) {
      await trx.raw('ROLLBACK TO SAVEPOINT audit_savepoint').catch(() => {});
    }
    // Audit failures must never block the main operation
  }
}
