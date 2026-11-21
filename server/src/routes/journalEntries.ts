// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { assertDeleteSparesHeldPeriods, assertPeriodUnlocked, logAudit } from '../lib/periodGuard';
import { ensureTrialBalanceRows } from '../lib/ensureTrialBalanceRows';
import { sendServerError } from '../lib/safeError';

export const jeCollectionRouter = Router({ mergeParams: true });
jeCollectionRouter.use(authMiddleware);

export const jeItemRouter = Router();
jeItemRouter.use(authMiddleware);

const lineSchema = z.object({
  accountId: z.number().int().positive(),
  debit: z.number().int().min(0),
  credit: z.number().int().min(0),
}).refine((l) => !(l.debit > 0 && l.credit > 0), {
  message: 'A journal entry line cannot carry both a debit and a credit',
}).refine((l) => l.debit > 0 || l.credit > 0, {
  message: 'A journal entry line must have a debit or credit amount',
});

const jeSchema = z.object({
  entryType: z.enum(['book', 'tax']),
  entryDate: z.string(),
  description: z.string().optional(),
  /** Workpaper supporting this entry — printed on the AJE listing. */
  workpaperRef: z.string().max(20).optional(),
  isRecurring: z.boolean().optional(),
  lines: z.array(lineSchema).min(2),
});

function parseBigIntLines(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.map((l) => ({
    ...l,
    debit: Number(l.debit),
    credit: Number(l.credit),
  }));
}

// GET /api/v1/periods/:periodId/journal-entries
jeCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid period ID' } });
    return;
  }
  const typeFilter = typeof req.query.type === 'string' ? req.query.type : null;
  const accountIdFilter = typeof req.query.accountId === 'string' ? Number(req.query.accountId) : null;

  try {
    let q = db('journal_entries').where({ period_id: periodId });
    if (typeFilter) q = q.where({ entry_type: typeFilter });
    if (accountIdFilter && !isNaN(accountIdFilter)) {
      q = q.whereIn('id', db('journal_entry_lines').where('account_id', accountIdFilter).select('journal_entry_id'));
    }
    const entries = await q.orderBy('entry_type').orderBy('entry_number');

    const entryIds = entries.map((e: { id: number }) => e.id);
    const lines = entryIds.length > 0
      ? await db('journal_entry_lines')
          .whereIn('journal_entry_id', entryIds)
          .join('chart_of_accounts', 'chart_of_accounts.id', 'journal_entry_lines.account_id')
          .select(
            'journal_entry_lines.*',
            'chart_of_accounts.account_number',
            'chart_of_accounts.account_name',
          )
      : [];

    const linesByEntry = lines.reduce((acc: Record<number, unknown[]>, l: Record<string, unknown>) => {
      const jeId = l.journal_entry_id as number;
      (acc[jeId] = acc[jeId] || []).push({ ...l, debit: Number(l.debit), credit: Number(l.credit) });
      return acc;
    }, {});

    const result = entries.map((e: Record<string, unknown>) => ({
      ...e,
      lines: linesByEntry[e.id as number] ?? [],
    }));

    res.json({ data: result, error: null, meta: { count: result.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'journal-entries');
  }
});

// POST /api/v1/journal-entries
jeItemRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  // periodId comes from body for POST
  const bodySchema = jeSchema.extend({ periodId: z.number().int().positive() });
  const result = bodySchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { periodId, entryType, entryDate, description, workpaperRef, isRecurring, lines } = result.data;

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) {
    res.status(400).json({
      data: null,
      error: { code: 'UNBALANCED', message: `Journal entry must balance. Debit: ${totalDebit}, Credit: ${totalCredit}` },
    });
    return;
  }

  try {
    await db.transaction(async (trx) => {
      await assertPeriodUnlocked(periodId, trx);

      // Lock the period row as a serialization point so concurrent JE creation
      // can't compute the same entry_number
      await trx.raw('SELECT id FROM periods WHERE id = ? FOR UPDATE', [periodId]);
      const lastEntry = await trx('journal_entries')
        .where({ period_id: periodId, entry_type: entryType })
        .max('entry_number as max')
        .first();
      const entryNumber = (lastEntry?.max ?? 0) + 1;

      const [entry] = await trx('journal_entries')
        .insert({
          period_id: periodId,
          entry_number: entryNumber,
          entry_type: entryType,
          entry_date: entryDate,
          description: description ?? null,
          workpaper_ref: workpaperRef?.trim() || null,
          is_recurring: isRecurring ?? false,
          created_by: req.user!.userId,
        })
        .returning('*');

      await trx('journal_entry_lines').insert(
        lines.map((l) => ({
          journal_entry_id: entry.id,
          account_id: l.accountId,
          debit: l.debit,
          credit: l.credit,
        })),
      );

      // Ensure trial_balance rows exist for all referenced accounts so the
      // v_adjusted_trial_balance view can pick up the JE aggregates
      await ensureTrialBalanceRows(trx, periodId, lines.map((l) => l.accountId));

      await logAudit({ userId: req.user!.userId, periodId, entityType: 'journal_entry', entityId: entry.id, action: 'create', description: `Created ${entryType} AJE #${entryNumber}${description ? ': ' + description : ''}` }, trx);
      res.status(201).json({ data: { ...entry, lines }, error: null });
    });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
      return;
    }
    sendServerError(res, err, 'journal-entries');
  }
});

// GET /api/v1/journal-entries/:id
jeItemRouter.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  try {
    const entry = await db('journal_entries').where({ id }).first();
    if (!entry) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Journal entry not found' } });
      return;
    }
    const lines = await db('journal_entry_lines')
      .where({ journal_entry_id: id })
      .join('chart_of_accounts', 'chart_of_accounts.id', 'journal_entry_lines.account_id')
      .select('journal_entry_lines.*', 'chart_of_accounts.account_number', 'chart_of_accounts.account_name');

    res.json({ data: { ...entry, lines: parseBigIntLines(lines) }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'journal-entries');
  }
});

// PUT /api/v1/journal-entries/:id/lines  (replace all lines + validate balance)
jeItemRouter.put('/:id/lines', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  const result = z.object({ lines: z.array(lineSchema).min(2) }).safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { lines } = result.data;

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) {
    res.status(400).json({
      data: null,
      error: { code: 'UNBALANCED', message: `Journal entry must balance. Debit: ${totalDebit}, Credit: ${totalCredit}` },
    });
    return;
  }

  try {
    await db.transaction(async (trx) => {
      const je = await trx('journal_entries').where({ id }).first('period_id', 'entry_number', 'entry_type');
      if (!je) throw Object.assign(new Error('Journal entry not found'), { code: 'NOT_FOUND', status: 404 });
      await assertPeriodUnlocked(je.period_id, trx);
      await trx('journal_entry_lines').where({ journal_entry_id: id }).delete();
      await trx('journal_entry_lines').insert(
        lines.map((l) => ({
          journal_entry_id: id,
          account_id: l.accountId,
          debit: l.debit,
          credit: l.credit,
        })),
      );

      // Bump parent JE updated_at so downstream views / clients can see the change
      await trx('journal_entries').where({ id }).update({ updated_at: trx.fn.now() });

      // Ensure trial_balance rows exist for all referenced accounts
      await ensureTrialBalanceRows(trx, je.period_id, lines.map((l) => l.accountId));

      await logAudit({
        userId: req.user!.userId,
        periodId: je.period_id,
        entityType: 'journal_entry',
        entityId: id,
        action: 'update',
        description: `Replaced lines on ${je.entry_type} JE #${je.entry_number}`,
      }, trx);
    });
    res.json({ data: { id, lines }, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked' } });
      return;
    }
    if (e.code === 'NOT_FOUND') {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Journal entry not found' } });
      return;
    }
    sendServerError(res, err, 'journal-entries');
  }
});

// PATCH /api/v1/journal-entries/:id  (update header fields + optionally replace lines)
jeItemRouter.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  let existing: { entry_type: string } | undefined;
  try {
    existing = await db('journal_entries').where({ id }).first('entry_type');
    if (!existing) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Journal entry not found' } });
      return;
    }
  } catch (err: unknown) {
    sendServerError(res, err, 'journal-entries');
    return;
  }
  const patchSchema = z.object({
    entryType: z.enum(['book', 'tax']).optional(),
    entryDate: z.string().optional(),
    description: z.string().nullable().optional(),
    workpaperRef: z.string().max(20).nullable().optional(),
    lines: z.array(lineSchema).min(2).optional(),
  });
  const result = patchSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    return;
  }
  const { entryType, entryDate, description, workpaperRef, lines } = result.data;

  if (lines) {
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    if (totalDebit !== totalCredit) {
      res.status(400).json({
        data: null,
        error: { code: 'UNBALANCED', message: `Journal entry must balance. Debit: ${totalDebit}, Credit: ${totalCredit}` },
      });
      return;
    }
  }

  try {
    const updatedEntry = await db.transaction(async (trx) => {
      const existing2 = await trx('journal_entries').where({ id }).first('period_id');
      if (existing2) await assertPeriodUnlocked(existing2.period_id, trx);

      const headerUpdates: Record<string, unknown> = { updated_at: trx.fn.now() };
      // Don't allow changing entry_type for trans entries
      if (entryType !== undefined && existing.entry_type !== 'trans') headerUpdates.entry_type = entryType;
      if (entryDate !== undefined) headerUpdates.entry_date = entryDate;
      if (description !== undefined) headerUpdates.description = description;
      if (workpaperRef !== undefined) headerUpdates.workpaper_ref = workpaperRef?.trim() || null;

      const [entry] = await trx('journal_entries').where({ id }).update(headerUpdates).returning('*');
      if (!entry) throw new Error('NOT_FOUND');

      if (lines) {
        await trx('journal_entry_lines').where({ journal_entry_id: id }).delete();
        await trx('journal_entry_lines').insert(
          lines.map((l) => ({ journal_entry_id: id, account_id: l.accountId, debit: l.debit, credit: l.credit })),
        );

        // Ensure trial_balance rows exist for all referenced accounts
        await ensureTrialBalanceRows(trx, entry.period_id, lines.map((l) => l.accountId));
      }

      // Sync changes back to the linked bank transaction
      if (existing.entry_type === 'trans') {
        const btUpdates: Record<string, unknown> = {};
        if (entryDate !== undefined) btUpdates.transaction_date = entryDate;
        if (description !== undefined) btUpdates.description = description;
        if (lines) {
          // Derive signed amount from the source account's side. Sign convention:
          //   amount > 0 → source is debited (money IN to bank)
          //   amount < 0 → source is credited (money OUT)
          // Summing debits alone always yields a positive magnitude and loses the sign
          // after a direction flip.
          const bt = await trx('bank_transactions').where({ journal_entry_id: id }).first('source_account_id');
          if (bt?.source_account_id) {
            // Sum across all lines hitting the source account (splits can touch
            // it more than once); net > 0 means the bank account was debited.
            const srcLines = lines.filter((l) => l.accountId === bt.source_account_id);
            if (srcLines.length > 0) {
              btUpdates.amount = srcLines.reduce((s, l) => s + l.debit - l.credit, 0);
            }
            // Source account no longer referenced: the edit no longer describes
            // bank-account movement, so leave the stored amount untouched rather
            // than overwrite it with an unsigned debit total.
          }
        }
        if (Object.keys(btUpdates).length > 0) {
          await trx('bank_transactions').where({ journal_entry_id: id }).update(btUpdates);
        }
      }

      await logAudit({ userId: req.user!.userId, periodId: entry.period_id, entityType: 'journal_entry', entityId: id, action: 'update', description: `Updated JE #${entry.entry_number}` }, trx);
      return entry;
    });
    res.json({ data: updatedEntry, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
      return;
    }
    const internal = err instanceof Error ? err.message : '';
    if (internal === 'NOT_FOUND') {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Journal entry not found' } });
    } else {
      sendServerError(res, err, 'journal-entries');
    }
  }
});

// DELETE /api/v1/journal-entries/:id
jeItemRouter.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: 'Invalid ID' } });
    return;
  }
  try {
    const deleted = await db.transaction(async (trx) => {
      const existing = await trx('journal_entries').where({ id }).first('entry_type', 'period_id', 'entry_number');
      if (!existing) {
        throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
      }
      // Desktop sync: a bank line of a held period that points at this entry is
      // refused, and its period and the entry's are locked in one ascending pass (code review).
      await assertDeleteSparesHeldPeriods(trx, { journalEntryIds: [id] }, [existing.period_id]);
      await assertPeriodUnlocked(existing.period_id, trx);
      // Cascade: lines, then any bank_transactions link, then the JE itself.
      await trx('journal_entry_lines').where({ journal_entry_id: id }).delete();
      await trx('bank_transactions').where({ journal_entry_id: id }).update({ journal_entry_id: null });
      const [row] = await trx('journal_entries').where({ id }).delete().returning('id');
      if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
      await logAudit({
        userId: req.user!.userId,
        periodId: existing.period_id,
        entityType: 'journal_entry',
        entityId: id,
        action: 'delete',
        description: `Deleted ${existing.entry_type} JE #${existing.entry_number}`,
      }, trx);
      return row.id as number;
    });
    res.json({ data: { id: deleted }, error: null });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'PERIOD_LOCKED') {
      res.status(409).json({ data: null, error: { code: 'PERIOD_LOCKED', message: e.message ?? 'Period is locked.' } });
      return;
    }
    if (e.code === 'NOT_FOUND') {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Journal entry not found' } });
      return;
    }
    sendServerError(res, err, 'journal-entries');
  }
});
