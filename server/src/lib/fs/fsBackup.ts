// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * The Statement Writer's part of backup and restore (routes/backup.ts calls
 * in here so that file does not have to know these tables' shapes).
 *
 * What travels:
 *   client / period archive  layouts, statement sets, finalized versions,
 *                            cash-flow overrides, equity roles
 *   full / settings archive  the firm library (letterhead, letters, styles,
 *                            layout templates)
 *
 * What does NOT travel: `fs_report_version_files`, the issued PDF bytes.
 * Backups carry rows, not bytes (CLAUDE.md), and an archive is JSON. A
 * restored version re-renders its PDF from the frozen snapshot on first
 * download and is flagged `regenerated`.
 *
 * Ids inside JSON. A layout names accounts and lead sheets by id, and a
 * restore renumbers both, so every layout — the client's live one AND the
 * frozen copy inside each finalized version — goes through
 * `remapFsLayoutIds`. A finalized version's `source_stamp` is left as it was:
 * it hashes the old ids, so a version restored as a NEW client reads
 * "balances changed" until someone looks, and the impact check — which
 * compares the issued numbers, not the ids — then says they are unaffected.
 * Recomputing the stamp here would instead assert, without checking, that
 * nothing had moved.
 */

import type { Knex } from 'knex';
import { fsStyleSchema, fsTemplateLayoutSchema, sanitizeFsLetterHtml } from './engine';
import { remapFsLayoutIds, type FsIdMaps } from './fsLayoutRemap';

type Row = Record<string, unknown>;
type Trx = Knex.Transaction;

export const FS_CLIENT_TABLES = ['fs_client_layouts', 'fs_reports', 'fs_report_versions', 'fs_cash_flow_overrides', 'fs_equity_roles'] as const;
export const FS_LIBRARY_TABLES = ['fs_firm_profile', 'fs_letters', 'fs_style_presets', 'fs_layout_templates'] as const;

/** User-attribution columns, for routes/backup.ts USER_FK_COLUMNS. */
export const FS_USER_FK_COLUMNS: Record<string, string[]> = {
  fs_client_layouts: ['created_by', 'updated_by'],
  fs_reports: ['created_by', 'updated_by'],
  fs_report_versions: ['finalized_by', 'reopened_by'],
};

const rows = (tables: Record<string, unknown[]>, name: string): Row[] => (tables[name] as Row[] | undefined) ?? [];
const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

// ─── Dump ────────────────────────────────────────────────────────────────

/**
 * `periodId` set = a period-level archive: only that period's statement
 * sets, plus the layouts they use. The client-level classification always
 * comes along (it is small, and the statements do not compute the same
 * without it).
 */
export async function dumpFsClientTables(trx: Trx, clientId: number, periodId: number | null = null): Promise<Record<string, Row[]>> {
  if (!(await trx.schema.hasTable('fs_reports'))) return {};
  const reportsQ = trx('fs_reports').where('client_id', clientId);
  if (periodId !== null) reportsQ.where('period_id', periodId);
  const reports = (await reportsQ.select('*')) as Row[];
  const reportIds = reports.map((r) => r.id as number);
  const layoutsQ = trx('fs_client_layouts').where('client_id', clientId);
  if (periodId !== null) layoutsQ.whereIn('id', reports.map((r) => r.client_layout_id as number));
  return {
    fs_client_layouts: (await layoutsQ.select('*')) as Row[],
    fs_reports: reports,
    fs_report_versions: reportIds.length ? ((await trx('fs_report_versions').whereIn('report_id', reportIds).select('*')) as Row[]) : [],
    fs_cash_flow_overrides: (await trx('fs_cash_flow_overrides').where('client_id', clientId).select('*')) as Row[],
    fs_equity_roles: (await trx('fs_equity_roles').where('client_id', clientId).select('*')) as Row[],
  };
}

export async function dumpFsLibrary(trx: Trx): Promise<Record<string, Row[]>> {
  if (!(await trx.schema.hasTable('fs_letters'))) return {};
  const out: Record<string, Row[]> = {};
  for (const t of FS_LIBRARY_TABLES) out[t] = (await trx(t).select('*')) as Row[];
  return out;
}

// ─── Delete ──────────────────────────────────────────────────────────────

/**
 * Before lead_sheets and chart_of_accounts in deleteClientData. Statement
 * sets first: fs_reports.client_layout_id has no delete action, so the
 * layouts cannot go while a set still points at them.
 */
export async function deleteFsClientData(trx: Trx, clientId: number): Promise<void> {
  if (!(await trx.schema.hasTable('fs_reports'))) return;
  await trx('fs_reports').where('client_id', clientId).delete(); // versions and their files cascade
  await trx('fs_client_layouts').where('client_id', clientId).delete();
  await trx('fs_cash_flow_overrides').where('client_id', clientId).delete();
  await trx('fs_equity_roles').where('client_id', clientId).delete();
}

// ─── Restore: client data ────────────────────────────────────────────────

export interface FsRestoreContext extends FsIdMaps {
  /** The client the rows land in (new, or the replace target). */
  clientId: number;
  period: (oldId: number) => number | undefined;
  sanitizeUserFks: (table: string, row: Row) => Row;
  /**
   * The archive was written by THIS installation, so a library id in it
   * (a template, a style preset, an accountant's letter) means the same row
   * here — if it still exists. For an uploaded archive those ids are another
   * firm's and are dropped.
   */
  trustLibraryIds: boolean;
}

export async function restoreFsClientTables(trx: Trx, tables: Record<string, unknown[]>, ctx: FsRestoreContext): Promise<void> {
  const layouts = rows(tables, 'fs_client_layouts');
  const reports = rows(tables, 'fs_reports');
  if (!layouts.length && !reports.length && !rows(tables, 'fs_cash_flow_overrides').length && !rows(tables, 'fs_equity_roles').length) return;
  if (!(await trx.schema.hasTable('fs_reports'))) return;

  const live = async (table: string): Promise<Set<number>> =>
    (ctx.trustLibraryIds ? new Set((await trx(table).pluck('id')) as number[]) : new Set<number>());
  const liveTemplates = await live('fs_layout_templates');
  const livePresets = await live('fs_style_presets');
  const liveLetters = await live('fs_letters');
  const keep = (set: Set<number>, id: unknown): number | null => (typeof id === 'number' && set.has(id) ? id : null);

  const layoutMap = new Map<number, number>();
  const hasUid = await trx.schema.hasColumn('fs_client_layouts', 'sync_uid');
  for (const row of layouts) {
    const clean = ctx.sanitizeUserFks('fs_client_layouts', row);
    // Desktop sync: keep the archive's layout uid unless a layout here holds
    // it already (as keepSyncUids does for the other synced tables).
    const uid = typeof row.sync_uid === 'string' && /^[0-9a-f-]{36}$/i.test(row.sync_uid) ? row.sync_uid : null;
    const keepUid = hasUid && uid !== null && !(await trx('fs_client_layouts').where({ sync_uid: uid }).first('id'));
    const [ins] = await trx('fs_client_layouts').insert({
      ...(keepUid ? { sync_uid: uid } : {}),
      client_id: ctx.clientId,
      name: clean.name,
      layout_json: json(remapFsLayoutIds(clean.layout_json, ctx)),
      style_json: json(clean.style_json),
      source_template_id: keep(liveTemplates, clean.source_template_id),
      source_style_preset_id: keep(livePresets, clean.source_style_preset_id),
      created_by: clean.created_by ?? null,
      updated_by: clean.updated_by ?? null,
      created_at: clean.created_at, updated_at: clean.updated_at, archived_at: clean.archived_at ?? null,
    }).returning('id');
    layoutMap.set(row.id as number, (ins as { id: number }).id);
  }

  const reportMap = new Map<number, number>();
  const currentVersionOf = new Map<number, number>(); // new report id → OLD current version id
  for (const row of reports) {
    const periodId = ctx.period(row.period_id as number);
    const layoutId = layoutMap.get(row.client_layout_id as number);
    // A set whose period or layout did not come along has nothing to stand on.
    if (periodId === undefined || layoutId === undefined) continue;
    const clean = ctx.sanitizeUserFks('fs_reports', row);
    const fm = (clean.front_matter_json ?? {}) as { letter?: { letterId?: unknown } };
    const frontMatter = fm.letter ? { ...fm, letter: { ...fm.letter, letterId: keep(liveLetters, fm.letter.letterId) } } : fm;
    const [ins] = await trx('fs_reports').insert({
      client_id: ctx.clientId, period_id: periodId, client_layout_id: layoutId,
      name: clean.name, framework: clean.framework, columns_json: json(clean.columns_json), entity_kind: clean.entity_kind ?? null,
      front_matter_json: json(frontMatter), status: clean.status, current_version_id: null,
      created_by: clean.created_by ?? null, updated_by: clean.updated_by ?? null,
      created_at: clean.created_at, updated_at: clean.updated_at, archived_at: clean.archived_at ?? null,
    }).returning('id');
    const newId = (ins as { id: number }).id;
    reportMap.set(row.id as number, newId);
    if (typeof row.current_version_id === 'number') currentVersionOf.set(newId, row.current_version_id);
  }

  const versionMap = new Map<number, number>();
  for (const row of rows(tables, 'fs_report_versions')) {
    const reportId = reportMap.get(row.report_id as number);
    if (reportId === undefined) continue;
    const clean = ctx.sanitizeUserFks('fs_report_versions', row);
    const [ins] = await trx('fs_report_versions').insert({
      report_id: reportId, version_no: clean.version_no, status: clean.status,
      model_json: json(clean.model_json),
      // The frozen layout is what the stale check recomputes with.
      layout_json: json(remapFsLayoutIds(clean.layout_json, ctx)),
      style_json: json(clean.style_json), settings_json: json(clean.settings_json),
      front_matter_json: json(clean.front_matter_json), letter_json: json(clean.letter_json), letterhead_json: json(clean.letterhead_json),
      source_stamp: clean.source_stamp, numbers_hash: clean.numbers_hash,
      pdf_sha256: clean.pdf_sha256 ?? null, pdf_size: clean.pdf_size ?? null, page_count: clean.page_count ?? null,
      validation_override: clean.validation_override ?? false, override_reason: clean.override_reason ?? null,
      finalized_by: clean.finalized_by ?? null, finalized_by_name: clean.finalized_by_name ?? null, finalized_at: clean.finalized_at,
      superseded_at: clean.superseded_at ?? null, reopened_by: clean.reopened_by ?? null, reopened_at: clean.reopened_at ?? null,
    }).returning('id');
    versionMap.set(row.id as number, (ins as { id: number }).id);
  }

  for (const [reportId, oldVersionId] of currentVersionOf) {
    const versionId = versionMap.get(oldVersionId);
    if (versionId !== undefined) await trx('fs_reports').where({ id: reportId }).update({ current_version_id: versionId });
    // "Final" with no version to be final AT would lock the set for nothing.
    else await trx('fs_reports').where({ id: reportId }).update({ status: 'draft' });
  }
  // The same for a set that claims to be final but never named a version.
  const orphanFinal = [...reportMap.values()].filter((id) => !currentVersionOf.has(id));
  if (orphanFinal.length) await trx('fs_reports').whereIn('id', orphanFinal).where({ status: 'final' }).update({ status: 'draft' });

  for (const row of rows(tables, 'fs_cash_flow_overrides')) {
    const accountId = row.account_id === null || row.account_id === undefined ? null : ctx.account(row.account_id as number);
    const leadSheetId = row.lead_sheet_id === null || row.lead_sheet_id === undefined ? null : ctx.leadSheet(row.lead_sheet_id as number);
    if (accountId === undefined || leadSheetId === undefined) continue; // its target was not restored
    if ((accountId === null) === (leadSheetId === null)) continue;      // exactly one target, or the CHECK refuses it
    await trx('fs_cash_flow_overrides')
      .insert({ client_id: ctx.clientId, account_id: accountId, lead_sheet_id: leadSheetId, classification: row.classification })
      .onConflict().ignore();
  }

  let foldTaken = false;
  for (const row of rows(tables, 'fs_equity_roles')) {
    const accountId = ctx.account(row.account_id as number);
    if (accountId === undefined) continue;
    const isFold = row.is_fold === true && !foldTaken;
    if (isFold) foldTaken = true;
    await trx('fs_equity_roles')
      .insert({ client_id: ctx.clientId, account_id: accountId, role: row.role, is_fold: isFold })
      .onConflict().ignore();
  }
}

// ─── Restore: firm library ───────────────────────────────────────────────

export interface FsLibraryRestoreReport { letterhead: boolean; letters: number; presets: number; templates: number; skipped: number }

/**
 * Settings-mode restore. Existing rows are UPDATED in place — matched by
 * `builtin_key` for the seeded ones, otherwise by name — so their ids, which
 * statement sets and client layouts point at, never change. Nothing is
 * deleted: a letter that exists here and not in the archive stays.
 *
 * An archive is untrusted input (an admin can upload one): letter HTML is
 * sanitized and every style / layout is validated against its schema, and
 * skipped when it does not pass.
 */
export async function restoreFsLibrary(trx: Trx, tables: Record<string, unknown[]>): Promise<FsLibraryRestoreReport> {
  const report: FsLibraryRestoreReport = { letterhead: false, letters: 0, presets: 0, templates: 0, skipped: 0 };
  if (!FS_LIBRARY_TABLES.some((t) => rows(tables, t).length) || !(await trx.schema.hasTable('fs_letters'))) return report;

  const profile = rows(tables, 'fs_firm_profile')[0];
  if (profile) {
    const { id: _id, updated_by: _by, created_at: _c, updated_at: _u, ...values } = profile;
    const logo = values.logo_data_uri;
    if (typeof logo === 'string' && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logo)) values.logo_data_uri = null;
    const existing = await trx('fs_firm_profile').first('id');
    if (existing) await trx('fs_firm_profile').where({ id: existing.id }).update({ ...values, updated_at: trx.fn.now() });
    else await trx('fs_firm_profile').insert(values);
    report.letterhead = true;
  }

  // Match an archive row to a live one, update it or insert it, and say which id it has now.
  const upsert = async (table: string, row: Row, values: Row): Promise<number> => {
    const match = row.builtin_key
      ? await trx(table).where({ builtin_key: row.builtin_key }).first('id')
      : await trx(table).where({ name: row.name }).modify((q) => { if (table !== 'fs_layout_templates') q.whereNull('builtin_key'); }).first('id');
    if (match) {
      await trx(table).where({ id: match.id }).update({ ...values, updated_at: trx.fn.now() });
      return match.id as number;
    }
    const [ins] = await trx(table).insert({ ...values, is_default: false }).returning('id');
    return (ins as { id: number }).id;
  };
  // One default per table (a partial unique index): clear, then set.
  const setDefault = async (table: string, id: number | null) => {
    if (id === null) return;
    await trx(table).where({ is_default: true }).whereNot({ id }).update({ is_default: false });
    await trx(table).where({ id }).update({ is_default: true });
  };

  let defaultId: number | null = null;
  for (const row of rows(tables, 'fs_letters')) {
    if (typeof row.name !== 'string' || typeof row.body_html !== 'string' || !['compilation', 'preparation'].includes(String(row.letter_type))) { report.skipped++; continue; }
    const id = await upsert('fs_letters', row, {
      name: row.name, letter_type: row.letter_type, title: row.title ?? null, body_html: sanitizeFsLetterHtml(row.body_html),
      is_active: row.is_active !== false, builtin_key: row.builtin_key ?? null, sort_order: row.sort_order ?? 0,
    });
    if (row.is_default === true && row.is_active !== false) defaultId = id;
    report.letters++;
  }
  await setDefault('fs_letters', defaultId);

  defaultId = null;
  for (const row of rows(tables, 'fs_style_presets')) {
    const style = fsStyleSchema.safeParse(row.style_json);
    if (typeof row.name !== 'string' || !style.success) { report.skipped++; continue; }
    const id = await upsert('fs_style_presets', row, {
      name: row.name, style_json: JSON.stringify(style.data), builtin_key: row.builtin_key ?? null, sort_order: row.sort_order ?? 0,
    });
    if (row.is_default === true) defaultId = id;
    report.presets++;
  }
  await setDefault('fs_style_presets', defaultId);

  defaultId = null;
  for (const row of rows(tables, 'fs_layout_templates')) {
    const layout = fsTemplateLayoutSchema.safeParse(row.layout_json);
    if (typeof row.name !== 'string' || !layout.success) { report.skipped++; continue; }
    const id = await upsert('fs_layout_templates', row, {
      name: row.name, description: row.description ?? null, entity_kind: row.entity_kind ?? 'any',
      layout_json: JSON.stringify(layout.data), sort_order: row.sort_order ?? 0,
    });
    if (row.is_default === true) defaultId = id;
    report.templates++;
  }
  await setDefault('fs_layout_templates', defaultId);
  return report;
}
