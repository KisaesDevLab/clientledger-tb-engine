// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { db } from '../../db';
import { assertNotCheckedOut, logAudit } from '../../lib/periodGuard';

export interface Period {
  id: number;
  client_id: number;
  period_name: string;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  locked_at: string | null;
  locked_by: number | null;
  created_at: string;
}

export async function getPeriods(clientId: number): Promise<Period[]> {
  // A period that came along only as a reference (desktop sync) is not listed.
  return db('periods').where({ client_id: clientId, is_reference: false }).orderBy('end_date', 'desc');
}

export async function getPeriod(id: number): Promise<Period | undefined> {
  return db('periods').where({ id }).first('*');
}

export async function lockPeriod(id: number, userId: number): Promise<{ period: Period; error?: string }> {
  // Desktop sync: a held period is not locked (its send-back would be
  // refused). Checked under the period row lock; the rest is unchanged.
  const held = await db.transaction(async (trx) => {
    await trx('periods').where({ id }).forUpdate().first('id');
    try {
      await assertNotCheckedOut(trx, [id]);
      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : 'This period is checked out.';
    }
  });
  if (held) return { period: {} as Period, error: held };
  // Check TB balanced
  const tbRows = await db('v_adjusted_trial_balance').where({ period_id: id });
  if (tbRows.length > 0) {
    const bkDr = tbRows.reduce((s: number, r: Record<string, unknown>) => s + Number(r.book_adjusted_debit), 0);
    const bkCr = tbRows.reduce((s: number, r: Record<string, unknown>) => s + Number(r.book_adjusted_credit), 0);
    if (Math.abs(bkDr - bkCr) > 0) {
      const diff = (Math.abs(bkDr - bkCr) / 100).toFixed(2);
      return { period: {} as Period, error: `Trial balance is out of balance by $${diff}. Resolve before locking.` };
    }
  }

  const [updated] = await db('periods')
    .where({ id })
    // A check-out taken since the check above still stops the lock.
    .whereNotExists(db('period_checkouts').where('period_id', id).whereNull('released_at').select(db.raw('1')))
    .update({ locked_at: db.fn.now(), locked_by: userId })
    .returning('*');

  if (!updated) return { period: {} as Period, error: 'Period not found, or a desktop checked it out just now.' };

  await logAudit({ userId, periodId: id, entityType: 'period', entityId: id, action: 'lock', description: `Locked period "${(updated as Period).period_name}" via MCP` });
  return { period: updated as Period };
}

export async function unlockPeriod(id: number, userId: number): Promise<{ period: Period; error?: string }> {
  const [updated] = await db('periods')
    .where({ id })
    .update({ locked_at: null, locked_by: null })
    .returning('*');

  if (!updated) return { period: {} as Period, error: 'Period not found' };

  await logAudit({ userId, periodId: id, entityType: 'period', entityId: id, action: 'unlock', description: `Unlocked period "${(updated as Period).period_name}" via MCP` });
  return { period: updated as Period };
}
