// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Lead sheets — CRUD, auto-assignment, and per-period preparer/reviewer
 * sign-off.
 *
 * Three routers, following the tickmarks.ts idiom (mergeParams, handlers on
 * '/'), but unlike tickmarks every write that takes an id out of a request
 * body checks ownership first — tickmarks' item routers have a pre-existing
 * cross-client gap that must not be copied here.
 */

import { Router, Response } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendServerError } from '../lib/safeError';
import { assertClientKeysFrozen, assertNotCheckedOut, assertPeriodUnlocked, logAudit } from '../lib/periodGuard';
import { whereHasActivity } from '../lib/tbActivity';
import {
  DEFAULT_LEAD_SHEETS,
  suggestLeadSheet,
  signoffStatus,
  type SignoffStatus,
} from '../lib/leadSheets';
import { currentStampFor, currentStampsForClient, emptyStamp } from '../lib/leadSheetStamp';

// /api/v1/clients/:clientId/lead-sheets
export const leadSheetCollectionRouter = Router({ mergeParams: true });
leadSheetCollectionRouter.use(authMiddleware);

// /api/v1/lead-sheets/:id
export const leadSheetItemRouter = Router({ mergeParams: true });
leadSheetItemRouter.use(authMiddleware);

// /api/v1/periods/:periodId/lead-sheets
export const leadSheetPeriodRouter = Router({ mergeParams: true });
leadSheetPeriodRouter.use(authMiddleware);

const ROLES = ['preparer', 'reviewer'] as const;
type Role = (typeof ROLES)[number];

const leadSheetSchema = z.object({
  code: z.string().trim().min(1).max(10).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().optional(),
});

const assignSchema = z.object({
  accountIds: z.array(z.number().int().positive()).min(1).max(2000),
  leadSheetId: z.number().int().positive().nullable(),
});

const reorderSchema = z.object({
  order: z.array(z.object({
    id: z.number().int().positive(),
    sortOrder: z.number().int(),
  })).min(1).max(200),
});

const previewSchema = z.object({
  mode: z.enum(['unassigned_only', 'all']).default('unassigned_only'),
});

const confirmSchema = z.object({
  assignments: z.array(z.object({
    accountId: z.number().int().positive(),
    leadSheetId: z.number().int().positive().nullable(),
  })).min(1).max(2000),
});

const signoffSchema = z.object({ role: z.enum(ROLES) });

// ─── helpers ─────────────────────────────────────────────────────────────────

function badId(res: Response, what: string): void {
  res.status(400).json({ data: null, error: { code: 'INVALID_ID', message: `Invalid ${what} ID` } });
}

/** Every lead sheet id in the given list must belong to this client. */
async function leadSheetsOwned(
  clientId: number,
  ids: number[],
  q: Knex | Knex.Transaction = db,
): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  const rows = await q('lead_sheets').where({ client_id: clientId }).whereIn('id', unique).pluck('id');
  return (rows as number[]).length === unique.length;
}

/** Returns the account ids in the list that do NOT belong to this client. */
async function accountsNotOwned(
  clientId: number,
  ids: number[],
  q: Knex | Knex.Transaction = db,
): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const owned = await q('chart_of_accounts').where({ client_id: clientId }).whereIn('id', unique).pluck('id');
  const ownedSet = new Set(owned as number[]);
  return unique.filter((id) => !ownedSet.has(id));
}

async function periodClientId(periodId: number, q: Knex | Knex.Transaction = db): Promise<number | null> {
  const row = await q('periods').where({ id: periodId }).first('client_id');
  return (row?.client_id as number | undefined) ?? null;
}

interface SignoffRow {
  id: number;
  lead_sheet_id: number;
  role: Role;
  user_id: number | null;
  user_name: string | null;
  signed_at: string;
  balance_stamp: string;
}

type SignoffMap = Partial<Record<Role, SignoffRow>>;

/** Live sign-offs for a period, grouped by lead sheet then role. */
async function loadSignoffs(
  q: Knex | Knex.Transaction,
  periodId: number,
): Promise<Map<number, SignoffMap>> {
  const rows = await q('lead_sheet_signoffs')
    .where({ period_id: periodId })
    .whereNull('invalidated_at')
    .select('id', 'lead_sheet_id', 'role', 'user_id', 'user_name', 'signed_at', 'balance_stamp') as SignoffRow[];
  const out = new Map<number, SignoffMap>();
  for (const r of rows) {
    if (!out.has(r.lead_sheet_id)) out.set(r.lead_sheet_id, {});
    out.get(r.lead_sheet_id)![r.role] = r;
  }
  return out;
}

function statusPair(signoffs: SignoffMap, stamp: string): Record<Role, SignoffStatus> {
  return {
    preparer: signoffStatus(signoffs.preparer, stamp),
    reviewer: signoffStatus(signoffs.reviewer, stamp),
  };
}

// ─── GET /clients/:clientId/lead-sheets ──────────────────────────────────────

leadSheetCollectionRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { badId(res, 'client'); return; }
  const periodId = req.query.periodId ? Number(req.query.periodId) : null;

  try {
    const sheets = await db('lead_sheets')
      .where({ client_id: clientId })
      .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'code', order: 'asc' }, { column: 'id', order: 'asc' }]);

    const counts = await db('chart_of_accounts')
      .where({ client_id: clientId, is_active: true })
      .whereNotNull('lead_sheet_id')
      .groupBy('lead_sheet_id')
      .select('lead_sheet_id')
      .count({ n: '*' }) as Array<{ lead_sheet_id: number; n: string | number }>;
    const countBy = new Map(counts.map((c) => [c.lead_sheet_id, Number(c.n)]));

    const unassigned = await db('chart_of_accounts')
      .where({ client_id: clientId, is_active: true })
      .whereNull('lead_sheet_id')
      .count({ n: '*' })
      .first() as { n: string | number } | undefined;

    let stamps: Map<number, string> | null = null;
    let signoffs: Map<number, SignoffMap> | null = null;
    if (periodId && !isNaN(periodId)) {
      stamps = await currentStampsForClient(db, periodId, clientId);
      signoffs = await loadSignoffs(db, periodId);
    }

    const data = sheets.map((s: Record<string, unknown>) => {
      const id = s.id as number;
      const base = { ...s, account_count: countBy.get(id) ?? 0 };
      if (!stamps || !signoffs) return base;
      const stamp = stamps.get(id) ?? emptyStamp();
      const live = signoffs.get(id) ?? {};
      return { ...base, current_stamp: stamp, signoffs: live, status: statusPair(live, stamp) };
    });

    res.json({
      data,
      error: null,
      meta: { count: data.length, unassignedCount: Number(unassigned?.n ?? 0) },
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── GET /clients/:clientId/lead-sheets/unassigned ───────────────────────────

leadSheetCollectionRouter.get('/unassigned', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { badId(res, 'client'); return; }
  try {
    const rows = await db('chart_of_accounts')
      .where({ client_id: clientId, is_active: true })
      .whereNull('lead_sheet_id')
      .orderBy('account_number', 'asc')
      .select('id', 'account_number', 'account_name', 'category', 'subcategory');
    res.json({ data: rows, error: null, meta: { count: rows.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── POST /clients/:clientId/lead-sheets/seed ────────────────────────────────
// Creates the A–O rows only. Idempotent, and deliberately does NOT assign any
// accounts — that is auto-assign's job, which is re-runnable and previewed.

leadSheetCollectionRouter.post('/seed', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { badId(res, 'client'); return; }
  try {
    const existing = await db('lead_sheets').where({ client_id: clientId }).first('id');
    if (existing) {
      res.json({ data: { seeded: false, created: 0 }, error: null });
      return;
    }
    await db.transaction(async (trx) => {
      await trx('lead_sheets').insert(DEFAULT_LEAD_SHEETS.map((d) => ({
        client_id: clientId,
        code: d.code,
        name: d.name,
        sort_order: d.sortOrder,
        created_by: req.user!.userId,
      })));
      await logAudit({
        userId: req.user!.userId, periodId: null, clientId,
        entityType: 'lead_sheet', entityId: null, action: 'create',
        description: `Seeded ${DEFAULT_LEAD_SHEETS.length} default lead sheets`,
      }, trx);
    });
    res.status(201).json({ data: { seeded: true, created: DEFAULT_LEAD_SHEETS.length }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── POST /clients/:clientId/lead-sheets ─────────────────────────────────────

leadSheetCollectionRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { badId(res, 'client'); return; }
  const parsed = leadSheetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  try {
    const max = await db('lead_sheets').where({ client_id: clientId }).max({ m: 'sort_order' }).first() as { m: number | null } | undefined;
    const [row] = await db('lead_sheets').insert({
      client_id: clientId,
      code: parsed.data.code ?? null,
      name: parsed.data.name,
      sort_order: parsed.data.sortOrder ?? Number(max?.m ?? 0) + 10,
      created_by: req.user!.userId,
    }).returning('*');
    await logAudit({
      userId: req.user!.userId, periodId: null, clientId,
      entityType: 'lead_sheet', entityId: row.id, action: 'create',
      description: `Created lead sheet ${row.code ?? ''} — ${row.name}`.trim(),
    });
    res.status(201).json({ data: row, error: null });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      res.status(409).json({ data: null, error: { code: 'DUPLICATE', message: 'That lead sheet code is already used for this client.' } });
      return;
    }
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── POST /clients/:clientId/lead-sheets/reorder ─────────────────────────────

leadSheetCollectionRouter.post('/reorder', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { badId(res, 'client'); return; }
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  try {
    if (!(await leadSheetsOwned(clientId, parsed.data.order.map((o) => o.id)))) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'One or more lead sheets belong to a different client.' } });
      return;
    }
    await db.transaction(async (trx) => {
      for (const o of parsed.data.order) {
        await trx('lead_sheets').where({ id: o.id, client_id: clientId })
          .update({ sort_order: o.sortOrder, updated_at: trx.fn.now() });
      }
    });
    res.json({ data: { updated: parsed.data.order.length }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── POST /clients/:clientId/lead-sheets/assign ──────────────────────────────
// Bulk manual set/clear. Also serves the per-row "Assign…" dropdown.

leadSheetCollectionRouter.post('/assign', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { badId(res, 'client'); return; }
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { accountIds, leadSheetId } = parsed.data;
  try {
    const strays = await accountsNotOwned(clientId, accountIds);
    if (strays.length > 0) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: `${strays.length} account(s) belong to a different client.` } });
      return;
    }
    if (leadSheetId !== null && !(await leadSheetsOwned(clientId, [leadSheetId]))) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'That lead sheet belongs to a different client.' } });
      return;
    }
    const updated = await db('chart_of_accounts')
      .where({ client_id: clientId })
      .whereIn('id', accountIds)
      .update({
        lead_sheet_id: leadSheetId,
        lead_sheet_source: leadSheetId === null ? null : 'manual',
        updated_at: db.fn.now(),
      });
    await logAudit({
      userId: req.user!.userId, periodId: null, clientId,
      entityType: 'chart_of_accounts', entityId: null, action: 'update',
      description: leadSheetId === null
        ? `Cleared lead sheet on ${updated} account(s)`
        : `Assigned ${updated} account(s) to a lead sheet`,
    });
    res.json({ data: { updated }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── POST /clients/:clientId/lead-sheets/auto-assign/preview ─────────────────
// Pure: writes nothing. Re-runnable, unlike MyBooks' seed-once assignment —
// this chart grows constantly (CSV/PDF import, COA templates, copy-from-client,
// Transaction Entry), so a one-shot pass would leave a permanently growing
// Ungrouped list.

interface Suggestion {
  accountId: number;
  accountNumber: string;
  accountName: string;
  category: string;
  subcategory: string | null;
  currentLeadSheetId: number | null;
  currentCode: string | null;
  suggestedLeadSheetId: number | null;
  suggestedCode: string | null;
  suggestedName: string | null;
  confidence: number;
  source: 'rule' | 'unmatched';
  changed: boolean;
}

leadSheetCollectionRouter.post('/auto-assign/preview', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { badId(res, 'client'); return; }
  const parsed = previewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  try {
    const sheets = await db('lead_sheets').where({ client_id: clientId }).select('id', 'code', 'name');
    if (sheets.length === 0) {
      res.status(409).json({
        data: null,
        error: { code: 'NOT_SEEDED', message: 'This client has no lead sheets yet. Create the defaults first.' },
      });
      return;
    }
    // suggestLeadSheet returns a CODE; resolve it against this client's own
    // rows so renamed/deleted letters simply produce no target.
    const byCode = new Map<string, { id: number; name: string }>(
      (sheets as Array<{ id: number; code: string | null; name: string }>)
        .filter((s) => !!s.code)
        .map((s) => [s.code!.trim().toUpperCase(), { id: s.id, name: s.name }]),
    );
    const codeById = new Map<number, string>(
      (sheets as Array<{ id: number; code: string | null }>).map((s) => [s.id, s.code ?? '']),
    );

    const q = db('chart_of_accounts').where({ client_id: clientId, is_active: true });
    if (parsed.data.mode === 'unassigned_only') q.whereNull('lead_sheet_id');
    const accounts = await q
      .orderBy('account_number', 'asc')
      .select('id', 'account_number', 'account_name', 'category', 'subcategory', 'lead_sheet_id');

    const suggestions: Suggestion[] = (accounts as Array<Record<string, unknown>>).map((a) => {
      const hit = suggestLeadSheet({
        category: a.category as string,
        subcategory: (a.subcategory as string | null) ?? null,
        accountNumber: a.account_number as string,
        accountName: a.account_name as string,
      });
      const target = hit ? byCode.get(hit.code.toUpperCase()) : undefined;
      const currentId = (a.lead_sheet_id as number | null) ?? null;
      return {
        accountId: a.id as number,
        accountNumber: a.account_number as string,
        accountName: a.account_name as string,
        category: a.category as string,
        subcategory: (a.subcategory as string | null) ?? null,
        currentLeadSheetId: currentId,
        currentCode: currentId !== null ? (codeById.get(currentId) ?? null) : null,
        suggestedLeadSheetId: target?.id ?? null,
        suggestedCode: hit?.code ?? null,
        suggestedName: target?.name ?? hit?.name ?? null,
        confidence: hit?.confidence ?? 0,
        source: target ? 'rule' : 'unmatched',
        changed: (target?.id ?? null) !== currentId,
      };
    });

    res.json({
      data: suggestions,
      error: null,
      meta: {
        count: suggestions.length,
        changed: suggestions.filter((s) => s.changed).length,
        unmatched: suggestions.filter((s) => s.source === 'unmatched').length,
        mode: parsed.data.mode,
      },
    });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── POST /clients/:clientId/lead-sheets/auto-assign/confirm ─────────────────

leadSheetCollectionRouter.post('/auto-assign/confirm', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = Number(req.params.clientId);
  if (isNaN(clientId)) { badId(res, 'client'); return; }
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { assignments } = parsed.data;
  try {
    const strays = await accountsNotOwned(clientId, assignments.map((a) => a.accountId));
    if (strays.length > 0) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: `${strays.length} account(s) belong to a different client.` } });
      return;
    }
    const targetIds = assignments.map((a) => a.leadSheetId).filter((v): v is number => v !== null);
    if (!(await leadSheetsOwned(clientId, targetIds))) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'One or more lead sheets belong to a different client.' } });
      return;
    }

    let applied = 0;
    await db.transaction(async (trx) => {
      for (const a of assignments) {
        applied += await trx('chart_of_accounts')
          .where({ id: a.accountId, client_id: clientId })
          .update({
            lead_sheet_id: a.leadSheetId,
            lead_sheet_source: a.leadSheetId === null ? null : 'auto',
            updated_at: trx.fn.now(),
          });
      }
      await logAudit({
        userId: req.user!.userId, periodId: null, clientId,
        entityType: 'chart_of_accounts', entityId: null, action: 'update',
        description: `Lead sheet auto-assign — ${applied} account(s) assigned`,
      }, trx);
    });
    res.json({ data: { applied }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── PATCH / DELETE /lead-sheets/:id ─────────────────────────────────────────

leadSheetItemRouter.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { badId(res, 'lead sheet'); return; }
  const parsed = leadSheetSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  try {
    const current = await db('lead_sheets').where({ id }).first('id', 'client_id');
    if (!current) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Lead sheet not found' } });
      return;
    }
    const updates: Record<string, unknown> = { updated_at: db.fn.now() };
    if (parsed.data.code !== undefined) updates.code = parsed.data.code;
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.sortOrder !== undefined) updates.sort_order = parsed.data.sortOrder;

    const [row] = await db.transaction(async (trx) => {
      // A send-back matches lead sheets by code (owner 2026-11-19).
      if (parsed.data.code !== undefined) {
        const was = await trx('lead_sheets').where({ id }).first('code');
        if ((was?.code ?? null) !== (parsed.data.code ?? null)) await assertClientKeysFrozen(trx, current.client_id as number, "a lead sheet's code");
      }
      return trx('lead_sheets').where({ id }).update(updates).returning('*');
    });
    await logAudit({
      userId: req.user!.userId, periodId: null, clientId: current.client_id as number,
      entityType: 'lead_sheet', entityId: id, action: 'update',
      description: `Updated lead sheet ${row.code ?? ''} — ${row.name}`.trim(),
    });
    res.json({ data: row, error: null });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      res.status(409).json({ data: null, error: { code: 'DUPLICATE', message: 'That lead sheet code is already used for this client.' } });
      return;
    }
    sendServerError(res, err, 'lead-sheets');
  }
});

leadSheetItemRouter.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { badId(res, 'lead sheet'); return; }
  try {
    const current = await db('lead_sheets').where({ id }).first('id', 'client_id', 'code', 'name');
    if (!current) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Lead sheet not found' } });
      return;
    }
    // Count before deleting — the FK's ON DELETE SET NULL returns these
    // accounts to "unassigned", and the UI wants to say how many moved.
    const orphaned = await db('chart_of_accounts')
      .where({ lead_sheet_id: id, is_active: true }).count({ n: '*' }).first() as { n: string | number } | undefined;

    await db.transaction(async (trx) => {
      // Desktop sync: the delete cascades to sign-offs and notes in every
      // period; not while a desktop holds one of them.
      const touched = [
        ...(await trx('lead_sheet_signoffs').where({ lead_sheet_id: id }).distinct().pluck('period_id')),
        ...(await trx('lead_sheet_notes').where({ lead_sheet_id: id }).distinct().pluck('period_id')),
        ...(await trx('lead_sheet_attachments').where({ lead_sheet_id: id }).distinct().pluck('period_id')),
      ];
      await assertNotCheckedOut(trx, touched);
      await trx('lead_sheets').where({ id }).delete();
    });
    await logAudit({
      userId: req.user!.userId, periodId: null, clientId: current.client_id as number,
      entityType: 'lead_sheet', entityId: id, action: 'delete',
      description: `Deleted lead sheet ${current.code ?? ''} — ${current.name}`.trim(),
    });
    res.json({ data: { id, orphanedAccounts: Number(orphaned?.n ?? 0) }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── GET /periods/:periodId/lead-sheets[/:leadSheetId] ───────────────────────

async function buildPeriodView(periodId: number, leadSheetId: number | null) {
  const clientId = await periodClientId(periodId);
  if (clientId === null) return null;

  const sheetQuery = db('lead_sheets').where({ client_id: clientId });
  if (leadSheetId !== null) sheetQuery.where('id', leadSheetId);
  const sheets = await sheetQuery
    .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'code', order: 'asc' }]);

  // Report surface, so dormant accounts are suppressed for DISPLAY. The stamp
  // deliberately uses a different (unfiltered) row set — see leadSheetStamp.ts.
  const rows = await db('v_adjusted_trial_balance as vtb')
    .where('vtb.period_id', periodId)
    .where('vtb.is_active', true)
    .modify(whereHasActivity, 'vtb')
    .orderBy('vtb.account_number', 'asc')
    .select('vtb.*');

  const tickmarks = await db('tb_tickmarks as tt')
    .join('tickmark_library as tl', 'tl.id', 'tt.tickmark_id')
    .where('tt.period_id', periodId)
    .select('tt.account_id', 'tl.id as tickmark_id', 'tl.symbol', 'tl.description', 'tl.color');
  const marksBy = new Map<number, Array<Record<string, unknown>>>();
  for (const t of tickmarks as Array<Record<string, unknown>>) {
    const aid = t.account_id as number;
    if (!marksBy.has(aid)) marksBy.set(aid, []);
    marksBy.get(aid)!.push({ id: t.tickmark_id, symbol: t.symbol, description: t.description, color: t.color });
  }

  // Attachments per ACCOUNT, so each member row can show its own ref codes and
  // its own paperclip — the way MyBooks does it.
  const attachBy = new Map<number, Array<{ id: number; refCode: string; marks: number }>>();
  if (await db.schema.hasTable('lead_sheet_attachments')) {
    const atts = await db('lead_sheet_attachments')
      .where({ period_id: periodId })
      .whereNull('deleted_at')
      .orderBy('ref_code', 'asc')
      .select('id', 'account_id', 'ref_code', 'annotations');
    for (const a of atts as Array<Record<string, unknown>>) {
      const aid = a.account_id as number | null;
      if (aid === null) continue;
      if (!attachBy.has(aid)) attachBy.set(aid, []);
      const marks = Array.isArray(a.annotations) ? a.annotations.length : 0;
      attachBy.get(aid)!.push({ id: a.id as number, refCode: a.ref_code as string, marks });
    }
  }

  // Notes, split the same way: per account for the row, plus the sheet-level
  // ones the page lists underneath.
  const notesBy = new Map<number, Array<Record<string, unknown>>>();
  const sheetNotes = new Map<number, Array<Record<string, unknown>>>();
  if (await db.schema.hasTable('lead_sheet_notes')) {
    const notes = await db('lead_sheet_notes')
      .where({ period_id: periodId })
      .orderBy([{ column: 'resolved_at', order: 'asc' }, { column: 'created_at', order: 'desc' }])
      .select('*');
    for (const n of notes as Array<Record<string, unknown>>) {
      const aid = n.account_id as number | null;
      const lsId = n.lead_sheet_id as number | null;
      if (aid !== null) {
        if (!notesBy.has(aid)) notesBy.set(aid, []);
        notesBy.get(aid)!.push(n);
      }
      if (lsId !== null) {
        if (!sheetNotes.has(lsId)) sheetNotes.set(lsId, []);
        sheetNotes.get(lsId)!.push(n);
      }
    }
  }

  const stamps = await currentStampsForClient(db, periodId, clientId);
  const signoffs = await loadSignoffs(db, periodId);

  return sheets.map((s: Record<string, unknown>) => {
    const id = s.id as number;
    const members = (rows as Array<Record<string, unknown>>)
      .filter((r) => r.lead_sheet_id === id)
      .map((r) => ({
        ...r,
        tickmarks: marksBy.get(r.account_id as number) ?? [],
        attachments: attachBy.get(r.account_id as number) ?? [],
        notes: notesBy.get(r.account_id as number) ?? [],
      }));
    const stamp = stamps.get(id) ?? emptyStamp();
    const live = signoffs.get(id) ?? {};
    const allNotes = sheetNotes.get(id) ?? [];
    return {
      leadSheet: s,
      rows: members,
      accountCount: members.length,
      currentStamp: stamp,
      signoffs: live,
      status: statusPair(live, stamp),
      notes: allNotes,
      openNoteCount: allNotes.filter((n) => !n.resolved_at).length,
    };
  });
}

leadSheetPeriodRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  if (isNaN(periodId)) { badId(res, 'period'); return; }
  try {
    const data = await buildPeriodView(periodId, null);
    if (data === null) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } });
      return;
    }
    res.json({ data, error: null, meta: { count: data.length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

leadSheetPeriodRouter.get('/:leadSheetId', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  const leadSheetId = Number(req.params.leadSheetId);
  if (isNaN(periodId) || isNaN(leadSheetId)) { badId(res, 'period or lead sheet'); return; }
  try {
    const data = await buildPeriodView(periodId, leadSheetId);
    if (data === null || data.length === 0) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Lead sheet not found for this period' } });
      return;
    }
    res.json({ data: data[0], error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── Sign-off ────────────────────────────────────────────────────────────────
// Anyone may sign either line: no role gate, no identity restriction, and the
// same user may sign both. Deliberately diverges from MyBooks, which requires
// a preparer signature before the reviewer's.
//
// There is also NO preparer -> reviewer invalidation cascade: both signatures
// share one stamp basis, so when amounts move they go STALE together, and a
// cascade would smuggle the role ordering back in.

leadSheetPeriodRouter.post('/:leadSheetId/signoff', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  const leadSheetId = Number(req.params.leadSheetId);
  if (isNaN(periodId) || isNaN(leadSheetId)) { badId(res, 'period or lead sheet'); return; }
  const parsed = signoffSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { role } = parsed.data;

  try {
    let inserted: Record<string, unknown> | null = null;
    let stamp = '';

    await db.transaction(async (trx) => {
      // Deliberately NOT period-lock-gated. A period is locked when the
      // engagement is finished, which is exactly when a reviewer signs; making
      // them get an admin unlock first would also re-open every balance for
      // editing — the opposite of what the lock is for. Adding evidence to a
      // closed period is safe; removing it is not, so /unsign IS gated.
      // A period a desktop holds is different (desktop sync): its send-back
      // would replace this signature, so it waits.
      await assertNotCheckedOut(trx, [periodId]);
      const clientId = await periodClientId(periodId, trx);
      if (clientId === null) throw Object.assign(new Error('Period not found'), { status: 404, code: 'NOT_FOUND' });
      if (!(await leadSheetsOwned(clientId, [leadSheetId], trx))) {
        throw Object.assign(new Error('That lead sheet belongs to a different client.'), { status: 403, code: 'FORBIDDEN' });
      }

      stamp = await currentStampFor(trx, periodId, leadSheetId);

      const user = await trx('app_users').where({ id: req.user!.userId }).first('display_name', 'username');

      // Retire any live signature for this slot first, so the partial unique
      // index is satisfied at commit.
      await trx('lead_sheet_signoffs')
        .where({ lead_sheet_id: leadSheetId, period_id: periodId, role })
        .whereNull('invalidated_at')
        .update({ invalidated_at: trx.fn.now(), invalidated_by: req.user!.userId });

      const [row] = await trx('lead_sheet_signoffs').insert({
        period_id: periodId,
        lead_sheet_id: leadSheetId,
        role,
        user_id: req.user!.userId,
        user_name: (user?.display_name as string | undefined) ?? (user?.username as string | undefined) ?? null,
        balance_stamp: stamp,
      }).returning('*');
      inserted = row;

      await logAudit({
        userId: req.user!.userId, periodId, clientId,
        entityType: 'lead_sheet_signoff', entityId: row.id, action: 'create',
        description: `Signed lead sheet ${leadSheetId} as ${role}`,
      }, trx);
    });

    res.status(201).json({ data: { signoff: inserted, status: 'signed', currentStamp: stamp }, error: null });
  } catch (err: unknown) {
    const e = err as { status?: number; code?: string; message?: string };
    if (e?.status && e?.code) {
      res.status(e.status).json({ data: null, error: { code: e.code, message: e.message ?? 'Sign-off failed.' } });
      return;
    }
    sendServerError(res, err, 'lead-sheets');
  }
});

leadSheetPeriodRouter.post('/:leadSheetId/unsign', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  const leadSheetId = Number(req.params.leadSheetId);
  if (isNaN(periodId) || isNaN(leadSheetId)) { badId(res, 'period or lead sheet'); return; }
  const parsed = signoffSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { role } = parsed.data;

  try {
    let affected = 0;
    await db.transaction(async (trx) => {
      // Gated, unlike /signoff: a signature may be added to a locked period but
      // never withdrawn from one. Passing the trx takes the FOR UPDATE row lock
      // (the documented TOCTOU guard).
      await assertPeriodUnlocked(periodId, trx);
      const clientId = await periodClientId(periodId, trx);
      if (clientId === null) throw Object.assign(new Error('Period not found'), { status: 404, code: 'NOT_FOUND' });

      // Soft, never a delete: the history is the point.
      affected = await trx('lead_sheet_signoffs')
        .where({ lead_sheet_id: leadSheetId, period_id: periodId, role })
        .whereNull('invalidated_at')
        .update({ invalidated_at: trx.fn.now(), invalidated_by: req.user!.userId });

      if (affected === 0) {
        throw Object.assign(new Error('No live signature to remove.'), { status: 404, code: 'NOT_SIGNED' });
      }

      await logAudit({
        userId: req.user!.userId, periodId, clientId,
        entityType: 'lead_sheet_signoff', entityId: leadSheetId, action: 'delete',
        description: `Removed ${role} sign-off on lead sheet ${leadSheetId}`,
      }, trx);
    });
    res.json({ data: { removed: affected, status: 'unsigned' }, error: null });
  } catch (err: unknown) {
    const e = err as { status?: number; code?: string; message?: string };
    if (e?.status && e?.code) {
      res.status(e.status).json({ data: null, error: { code: e.code, message: e.message ?? 'Unsign failed.' } });
      return;
    }
    sendServerError(res, err, 'lead-sheets');
  }
});

// ─── Notes ───────────────────────────────────────────────────────────────────
// Per period, unlike lead sheet membership: a query about the 2024 cash
// reconciliation has nothing to say about 2025. A note hangs off the lead sheet
// as a whole (accountId omitted) or off one account on it.
//
// Resolvable, never deletable by design — a resolved query is evidence that
// review happened, which is the point of a workpaper.

const noteSchema = z.object({
  leadSheetId: z.number().int().positive().nullable().optional(),
  accountId: z.number().int().positive().nullable().optional(),
  body: z.string().trim().min(1).max(4000),
});

leadSheetPeriodRouter.get('/:leadSheetId/notes', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  const leadSheetId = Number(req.params.leadSheetId);
  if (isNaN(periodId) || isNaN(leadSheetId)) { badId(res, 'period or lead sheet'); return; }
  try {
    const rows = await db('lead_sheet_notes as n')
      .leftJoin('chart_of_accounts as coa', 'coa.id', 'n.account_id')
      .where({ 'n.period_id': periodId, 'n.lead_sheet_id': leadSheetId })
      .orderBy([{ column: 'n.resolved_at', order: 'asc' }, { column: 'n.created_at', order: 'desc' }])
      .select('n.*', 'coa.account_number', 'coa.account_name');
    res.json({ data: rows, error: null, meta: { open: rows.filter((r) => !r.resolved_at).length } });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheet-notes');
  }
});

leadSheetPeriodRouter.post('/:leadSheetId/notes', async (req: AuthRequest, res: Response): Promise<void> => {
  const periodId = Number(req.params.periodId);
  const leadSheetId = Number(req.params.leadSheetId);
  if (isNaN(periodId) || isNaN(leadSheetId)) { badId(res, 'period or lead sheet'); return; }
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  try {
    const clientId = await periodClientId(periodId);
    if (clientId === null) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Period not found' } }); return; }
    if (!(await leadSheetsOwned(clientId, [leadSheetId]))) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'That lead sheet belongs to a different client.' } });
      return;
    }
    if (parsed.data.accountId) {
      const strays = await accountsNotOwned(clientId, [parsed.data.accountId]);
      if (strays.length > 0) {
        res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'That account belongs to a different client.' } });
        return;
      }
    }

    const user = await db('app_users').where({ id: req.user!.userId }).first('display_name', 'username');
    const [row] = await db.transaction(async (trx) => {
      // Desktop sync: not in a period a desktop holds.
      await assertNotCheckedOut(trx, [periodId]);
      return trx('lead_sheet_notes').insert({
      client_id: clientId,
      period_id: periodId,
      lead_sheet_id: leadSheetId,
      account_id: parsed.data.accountId ?? null,
      body: parsed.data.body,
      author_id: req.user!.userId,
      author_name: (user?.display_name as string | undefined) ?? (user?.username as string | undefined) ?? null,
    }).returning('*');
    });

    await logAudit({
      userId: req.user!.userId, periodId, clientId,
      entityType: 'lead_sheet_note', entityId: row.id, action: 'create',
      description: `Added a note on lead sheet ${leadSheetId}`,
    });
    res.status(201).json({ data: row, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheet-notes');
  }
});

// Resolve / reopen. Not a delete: the note itself is the audit trail.
leadSheetPeriodRouter.post('/:leadSheetId/notes/:noteId/resolve', async (req: AuthRequest, res: Response): Promise<void> => {
  const noteId = Number(req.params.noteId);
  if (isNaN(noteId)) { badId(res, 'note'); return; }
  const parsed = z.object({ resolved: z.boolean() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  try {
    const note = await db('lead_sheet_notes').where({ id: noteId }).first();
    if (!note) { res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Note not found' } }); return; }

    const user = await db('app_users').where({ id: req.user!.userId }).first('display_name', 'username');
    const [row] = await db.transaction(async (trx) => {
      await assertNotCheckedOut(trx, [note.period_id as number]);
      return trx('lead_sheet_notes').where({ id: noteId }).update(
      parsed.data.resolved
        ? {
            resolved_at: db.fn.now(),
            resolved_by: req.user!.userId,
            resolved_by_name: (user?.display_name as string | undefined) ?? (user?.username as string | undefined) ?? null,
            updated_at: db.fn.now(),
          }
        : { resolved_at: null, resolved_by: null, resolved_by_name: null, updated_at: db.fn.now() },
    ).returning('*');
    });

    await logAudit({
      userId: req.user!.userId, periodId: note.period_id as number, clientId: note.client_id as number,
      entityType: 'lead_sheet_note', entityId: noteId, action: 'update',
      description: parsed.data.resolved ? 'Resolved a lead sheet note' : 'Reopened a lead sheet note',
    });
    res.json({ data: row, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'lead-sheet-notes');
  }
});
