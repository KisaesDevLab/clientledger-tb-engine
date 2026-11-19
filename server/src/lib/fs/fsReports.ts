// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Statement sets: client layouts, drafts, and issuance.
 *
 * A statement set (`fs_reports`) belongs to ONE period and points at a client
 * layout, which is reused year after year. A draft computes live off the
 * trial balance. Finalizing freezes everything into an immutable
 * `fs_report_versions` row — the model that was issued plus the layout,
 * style, settings, letter and letterhead it was issued with — and stores the
 * PDF. Reopening makes the set a draft again; the next finalize is v2.
 *
 * A locked period does NOT gate any of this: statements are prepared after
 * the books are locked more often than before. What protects an issued
 * version is the freeze plus the stale check, not the lock.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import { db } from '../../db';
import { localToday } from '../../desktop/localDate';
import {
  bindLayout, buildDefaultLayout, computeFsReport, fsClientEntityKind, fsClientLayoutSchema, fsFrontMatterSchema,
  fsIncludedTitlesPhrase, fsReportSettingsSchema, fsStyleSchema, renderLetterBody, sanitizeFsLetterHtml, toPortableLayout,
  basisOfAccountingPhrase, formatLongDate, periodDescription,
  FS_DEFAULT_FRONT_MATTER, REPORT_LETTER_TITLES,
  type FsCreateReportInput, type FsDraftOverrides, type FsEntityKind, type FsFrontMatter, type FsLayout, type FsLetterhead,
  type FsRenderedReport, type FsReportSettings, type FsSourceData, type FsStyle, type FsUpdateReportInput, type ReportLetterType,
} from './engine';
import { isoDate, loadFsPeriodContext, loadFsSource, type FsPeriodContext } from './fsSource';
import { fsNumbersHash } from './fsStamp';
import * as library from './fsLibrary';
import { FsError } from './fsLibrary';
import { renderFsPdf } from './fsRender';
import { buildFsDocx } from './fsDocx';
import { buildFsXlsx } from './fsXlsx';
import { logAudit } from '../periodGuard';

// Rows come back untyped from knex.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Q = Knex | Knex.Transaction;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

// ─── Client layouts ──────────────────────────────────────────────────────

async function clientRow(clientId: number, q: Q = db): Promise<Row> {
  const c = await q('clients').where({ id: clientId }).first('id', 'name', 'entity_type');
  if (!c) throw new FsError('NOT_FOUND', 404, 'Client not found.');
  return c;
}

/** The client's lead sheets as the binder sees them (ids as strings — see engine/model.ts). */
export async function clientGroupings(clientId: number, q: Q = db) {
  const rows = (await q('lead_sheets').where({ client_id: clientId }).orderBy([{ column: 'sort_order' }, { column: 'id' }])
    .select('id', 'code', 'name')) as Array<{ id: number; code: string | null; name: string }>;
  return rows.map((g) => ({ id: String(g.id), code: g.code, name: g.name }));
}

export async function listLayouts(clientId: number) {
  const rows = await db('fs_client_layouts').where({ client_id: clientId }).whereNull('archived_at').orderBy('name')
    .select('id', 'name', 'updated_at', 'source_template_id');
  return (rows as Row[]).map((r) => ({ id: r.id as number, name: r.name as string, updatedAt: iso(r.updated_at), sourceTemplateId: r.source_template_id as number | null }));
}

export async function getLayoutRow(id: number, q: Q = db): Promise<Row> {
  const row = await q('fs_client_layouts').where({ id }).first();
  if (!row) throw new FsError('NOT_FOUND', 404, 'Layout not found.');
  return row;
}

export const layoutApi = (r: Row) => ({
  id: r.id as number, clientId: r.client_id as number, name: r.name as string,
  layout: r.layout_json as FsLayout, style: r.style_json as FsStyle, updatedAt: iso(r.updated_at),
});

export async function bindPreview(clientId: number, templateId: number | null) {
  const client = await clientRow(clientId);
  const groupings = await clientGroupings(clientId);
  const template = templateId ? await library.getTemplateLayout(templateId) : buildDefaultLayout(fsClientEntityKind(client.entity_type));
  const { unresolved } = bindLayout(template, groupings);
  return { unresolved, groupings };
}

async function createLayout(
  trx: Knex.Transaction,
  clientId: number,
  src: { templateId?: number | null; resolutions?: Record<string, string | null>; name?: string; stylePresetId?: number | null; entityKind?: FsEntityKind | null },
  userId: number | null,
): Promise<Row> {
  const client = await clientRow(clientId, trx);
  const groupings = await clientGroupings(clientId, trx);
  const template: FsLayout = src.templateId
    ? await library.getTemplateLayout(src.templateId, trx)
    : buildDefaultLayout(src.entityKind ?? fsClientEntityKind(client.entity_type));
  // A resolution may only name one of THIS client's lead sheets.
  const own = new Set(groupings.map((g) => g.id));
  const resolutions: Record<string, string | null> = {};
  for (const [nodeId, target] of Object.entries(src.resolutions ?? {})) {
    if (target !== null && !own.has(target)) throw new FsError('VALIDATION_ERROR', 400, 'A lead sheet chosen for the layout does not belong to this client.');
    resolutions[nodeId] = target;
  }
  const { layout } = bindLayout(template, groupings, resolutions);
  const style = src.stylePresetId ? await library.getPresetStyle(src.stylePresetId, trx) : (await library.getDefaultStyle(trx)).style;
  const [row] = await trx('fs_client_layouts').insert({
    client_id: clientId,
    name: src.name || 'Financial statements',
    layout_json: JSON.stringify(fsClientLayoutSchema.parse(layout)),
    style_json: JSON.stringify(style),
    source_template_id: src.templateId ?? null,
    source_style_preset_id: src.stylePresetId ?? null,
    created_by: userId, updated_by: userId,
  }).returning('*');
  return row;
}

/**
 * Every account and lead sheet a layout names must be the client's own. The
 * engine would simply not resolve a foreign id, but a layout is also what a
 * backup remaps and what "save as template" strips — it must not be able to
 * carry another client's ids at all.
 */
async function assertLayoutOwnIds(clientId: number, layout: FsLayout, q: Q = db): Promise<void> {
  const accountIds = new Set<number>();
  const leadSheetIds = new Set<number>();
  const walk = (nodes: FsLayout['statements'][number]['body']) => {
    for (const n of nodes) {
      if (n.type === 'section') walk(n.children);
      else if (n.type === 'account') n.refs.forEach((r) => accountIds.add(Number(r.accountId)));
      else if (n.type === 'leadsheet') {
        if (n.ref.groupingId) leadSheetIds.add(Number(n.ref.groupingId));
        n.scheduleLines?.forEach((l) => l.accountRefs.forEach((r) => accountIds.add(Number(r.accountId))));
      }
    }
  };
  layout.statements.forEach((s) => {
    walk(s.body);
    Object.keys(s.equity?.columnCaptions ?? {}).forEach((k) => { if (/^\d+$/.test(k)) accountIds.add(Number(k)); });
  });
  accountIds.delete(-1);
  if (accountIds.size) {
    const own = await q('chart_of_accounts').where({ client_id: clientId }).whereIn('id', [...accountIds]).count<{ count: string }[]>('id as count');
    if (Number(own[0]?.count ?? 0) !== accountIds.size) throw new FsError('VALIDATION_ERROR', 400, 'The layout refers to an account that does not belong to this client.');
  }
  if (leadSheetIds.size) {
    const own = await q('lead_sheets').where({ client_id: clientId }).whereIn('id', [...leadSheetIds]).count<{ count: string }[]>('id as count');
    if (Number(own[0]?.count ?? 0) !== leadSheetIds.size) throw new FsError('VALIDATION_ERROR', 400, 'The layout refers to a lead sheet that does not belong to this client.');
  }
}

export async function updateLayout(
  id: number,
  input: { name?: string; layout?: FsLayout; style?: FsStyle; expectedUpdatedAt?: string },
  userId: number | null,
): Promise<Row> {
  return db.transaction(async (trx) => {
    const before = await trx('fs_client_layouts').where({ id }).forUpdate().first();
    if (!before) throw new FsError('NOT_FOUND', 404, 'Layout not found.');
    if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== new Date(before.updated_at).getTime()) {
      throw new FsError('FS_CONFLICT', 409, 'This layout was changed by someone else. Reload to see their changes.', { updatedAt: iso(before.updated_at) });
    }
    if (input.layout) await assertLayoutOwnIds(before.client_id, input.layout, trx);
    const [row] = await trx('fs_client_layouts').where({ id }).update({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.layout !== undefined ? { layout_json: JSON.stringify(input.layout) } : {}),
      ...(input.style !== undefined ? { style_json: JSON.stringify(input.style) } : {}),
      updated_by: userId, updated_at: trx.fn.now(),
    }).returning('*');
    await logAudit({
      userId, periodId: null, clientId: before.client_id, entityType: 'fs_client_layout', entityId: id, action: 'update',
      description: `Updated statement layout "${row.name}"`,
    }, trx);
    return row;
  });
}

export async function saveLayoutAsTemplate(
  id: number,
  input: { name: string; description?: string | null; entityKind?: FsEntityKind | 'any' },
  userId: number | null,
) {
  const layoutRow = await getLayoutRow(id);
  const client = await clientRow(layoutRow.client_id);
  const groupings = await clientGroupings(layoutRow.client_id);
  const portable = toPortableLayout(fsClientLayoutSchema.parse(layoutRow.layout_json), groupings);
  return library.createTemplate({
    name: input.name, description: input.description ?? null,
    entityKind: input.entityKind ?? fsClientEntityKind(client.entity_type), layout: portable,
  }, userId);
}

// ─── Statement sets ──────────────────────────────────────────────────────

export function settingsOf(r: Row): FsReportSettings {
  return fsReportSettingsSchema.parse({ framework: r.framework, columns: r.columns_json, entityKind: r.entity_kind ?? null });
}

export function frontMatterOf(r: Row): FsFrontMatter {
  const parsed = fsFrontMatterSchema.safeParse(r.front_matter_json);
  return parsed.success ? parsed.data : FS_DEFAULT_FRONT_MATTER;
}

export async function getReportRow(id: number, q: Q = db): Promise<Row> {
  const row = await q('fs_reports').where({ id }).first();
  if (!row) throw new FsError('NOT_FOUND', 404, 'Financial statements not found.');
  return row;
}

/**
 * The current source stamp for a period under given settings, memoised for
 * one request: a list of statement sets asks the same question repeatedly.
 * A period whose dates were cleared after the fact reads as stale (null).
 */
function stampLoader() {
  const memo = new Map<string, Promise<string | null>>();
  return (periodId: number, settings: Pick<FsReportSettings, 'framework' | 'entityKind'>): Promise<string | null> => {
    const key = `${periodId}|${settings.framework}|${settings.entityKind ?? ''}`;
    if (!memo.has(key)) {
      memo.set(key, loadFsSource(db, periodId, settings).then((x) => x.source.sourceStamp).catch(() => null));
    }
    return memo.get(key)!;
  };
}

const frozenSettings = (v: Row): Pick<FsReportSettings, 'framework' | 'entityKind'> => {
  const s = fsReportSettingsSchema.safeParse(v.settings_json);
  return s.success ? s.data : { framework: 'gaap', entityKind: null };
};

export async function listReports(clientId: number) {
  const rows = (await db('fs_reports as r')
    .join('periods as p', 'p.id', 'r.period_id')
    .where('r.client_id', clientId)
    .whereNull('r.archived_at')
    .orderBy([{ column: 'p.end_date', order: 'desc', nulls: 'last' }, { column: 'r.updated_at', order: 'desc' }])
    .select('r.*', 'p.period_name', 'p.start_date', 'p.end_date', 'p.locked_at')) as Row[];
  const versionIds = rows.map((r) => r.current_version_id).filter(Boolean);
  const versions = versionIds.length
    ? ((await db('fs_report_versions').whereIn('id', versionIds)
      .select('id', 'version_no', 'source_stamp', 'finalized_at', 'settings_json', 'validation_override')) as Row[])
    : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  const stampOf = stampLoader();
  return Promise.all(rows.map(async (r) => {
    const v = r.status === 'final' && r.current_version_id ? byId.get(r.current_version_id) : undefined;
    return {
      id: r.id as number, name: r.name as string, status: r.status as 'draft' | 'final',
      periodId: r.period_id as number, periodName: r.period_name as string,
      periodStart: isoDate(r.start_date), periodEnd: isoDate(r.end_date), periodLocked: !!r.locked_at,
      framework: r.framework as string, columns: r.columns_json, updatedAt: iso(r.updated_at),
      currentVersion: v ? {
        versionNo: v.version_no as number, finalizedAt: iso(v.finalized_at), validationOverride: !!v.validation_override,
        stale: (await stampOf(r.period_id, frozenSettings(v))) !== v.source_stamp,
      } : null,
    };
  }));
}

function periodApi(p: FsPeriodContext) {
  return { id: p.periodId, clientId: p.clientId, clientName: p.clientName, name: p.periodName, start: p.periodStart, end: p.periodEnd, locked: !!p.lockedAt };
}

export async function getReport(id: number) {
  const report = await getReportRow(id);
  const layout = await getLayoutRow(report.client_layout_id);
  const period = await loadFsPeriodContext(db, report.period_id);
  const versions = (await db('fs_report_versions as v')
    .leftJoin('fs_report_version_files as f', 'f.version_id', 'v.id')
    .where('v.report_id', id)
    .orderBy('v.version_no', 'desc')
    .select(
      'v.id', 'v.version_no', 'v.status', 'v.source_stamp', 'v.settings_json', 'v.finalized_at', 'v.finalized_by_name',
      'v.validation_override', 'v.override_reason', 'v.page_count', 'v.superseded_at', 'v.reopened_at',
      db.raw('(f.version_id IS NOT NULL) as has_file'), 'f.regenerated',
    )) as Row[];
  const stampOf = stampLoader();
  return {
    report: {
      id: report.id as number, name: report.name as string, status: report.status as 'draft' | 'final',
      clientId: report.client_id as number, periodId: report.period_id as number,
      currentVersionId: report.current_version_id as number | null,
      settings: settingsOf(report), frontMatter: frontMatterOf(report), updatedAt: iso(report.updated_at),
    },
    period: periodApi(period),
    defaultEntityKind: fsClientEntityKind(period.entityType),
    layout: layoutApi(layout),
    versions: await Promise.all(versions.map(async (v) => ({
      id: v.id as number, versionNo: v.version_no as number, status: v.status as 'final' | 'superseded',
      finalizedAt: iso(v.finalized_at), finalizedByName: (v.finalized_by_name ?? null) as string | null,
      validationOverride: !!v.validation_override, overrideReason: (v.override_reason ?? null) as string | null,
      pageCount: (v.page_count ?? null) as number | null, supersededAt: iso(v.superseded_at), reopenedAt: iso(v.reopened_at),
      hasFile: !!v.has_file, regenerated: !!v.regenerated,
      stale: (await stampOf(report.period_id, frozenSettings(v))) !== v.source_stamp,
    }))),
  };
}

const cleanFrontMatter = (fm: FsFrontMatter): FsFrontMatter => ({
  ...fm,
  letter: { ...fm.letter, bodyHtmlOverride: fm.letter.bodyHtmlOverride ? sanitizeFsLetterHtml(fm.letter.bodyHtmlOverride) : null },
});

export async function createReport(periodId: number, input: FsCreateReportInput, userId: number | null): Promise<Row> {
  const period = await loadFsPeriodContext(db, periodId);
  const defaultLetter = await library.getDefaultLetterRow();
  return db.transaction(async (trx) => {
    let layoutId: number;
    if (input.layoutSource.kind === 'client_layout') {
      const l = await getLayoutRow(input.layoutSource.clientLayoutId, trx);
      if (l.client_id !== period.clientId) throw new FsError('NOT_FOUND', 404, 'Layout not found.');
      layoutId = l.id;
    } else {
      const src = input.layoutSource;
      const layout = await createLayout(trx, period.clientId, {
        templateId: src.kind === 'template' ? src.templateId : null,
        resolutions: src.kind === 'template' ? src.resolutions : undefined,
        name: src.layoutName,
        stylePresetId: input.stylePresetId ?? null,
        entityKind: input.settings.entityKind ?? null,
      }, userId);
      layoutId = layout.id;
    }
    const frontMatter: FsFrontMatter = input.frontMatter
      ? cleanFrontMatter(input.frontMatter)
      : { ...FS_DEFAULT_FRONT_MATTER, letter: { ...FS_DEFAULT_FRONT_MATTER.letter, letterId: defaultLetter?.id ?? null } };
    const s = input.settings;
    const [row] = await trx('fs_reports').insert({
      client_id: period.clientId, period_id: periodId, client_layout_id: layoutId, name: input.name,
      framework: s.framework, columns_json: JSON.stringify(s.columns), entity_kind: s.entityKind ?? null,
      front_matter_json: JSON.stringify(frontMatter), created_by: userId, updated_by: userId,
    }).returning('*');
    await logAudit({
      userId, periodId, clientId: period.clientId, entityType: 'fs_report', entityId: row.id, action: 'create',
      description: `Created financial statements "${row.name}"`,
    }, trx);
    return row;
  });
}

function assertDraft(r: Row): void {
  if (r.status === 'final') {
    throw new FsError('FS_FINAL_LOCKED', 423, 'These statements are final. Reopen them to make changes (a new version will be created).');
  }
}

export async function updateReport(id: number, input: FsUpdateReportInput, userId: number | null): Promise<Row> {
  return db.transaction(async (trx) => {
    const before = await trx('fs_reports').where({ id }).forUpdate().first();
    if (!before) throw new FsError('NOT_FOUND', 404, 'Financial statements not found.');
    assertDraft(before);
    const s = input.settings;
    const [row] = await trx('fs_reports').where({ id }).update({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(s ? { framework: s.framework, columns_json: JSON.stringify(s.columns), entity_kind: s.entityKind ?? null } : {}),
      ...(input.frontMatter !== undefined ? { front_matter_json: JSON.stringify(cleanFrontMatter(input.frontMatter)) } : {}),
      updated_by: userId, updated_at: trx.fn.now(),
    }).returning('*');
    await logAudit({
      userId, periodId: before.period_id, clientId: before.client_id, entityType: 'fs_report', entityId: id, action: 'update',
      description: `Updated financial statements "${row.name}"`,
    }, trx);
    return row;
  });
}

/** Soft: an archived set keeps its issued versions on file. */
export async function archiveReport(id: number, userId: number | null): Promise<void> {
  const before = await getReportRow(id);
  await db.transaction(async (trx) => {
    await trx('fs_reports').where({ id }).update({ archived_at: trx.fn.now(), updated_by: userId, updated_at: trx.fn.now() });
    await logAudit({
      userId, periodId: before.period_id, clientId: before.client_id, entityType: 'fs_report', entityId: id, action: 'delete',
      description: `Archived financial statements "${before.name}"`,
    }, trx);
  });
}

/** A new draft in another of the client's periods, on the same layout. */
export async function rollForward(id: number, input: { periodId: number; name?: string }, userId: number | null): Promise<Row> {
  const src = await getReportRow(id);
  const target = await db('periods').where({ id: input.periodId }).first('id', 'client_id', 'period_name', 'end_date');
  if (!target || target.client_id !== src.client_id) throw new FsError('NOT_FOUND', 404, 'That period does not belong to this client.');
  if (target.id === src.period_id) throw new FsError('VALIDATION_ERROR', 400, 'Choose a different period to roll these statements into.');
  const fm = frontMatterOf(src);
  const year = isoDate(target.end_date)?.slice(0, 4);
  return db.transaction(async (trx) => {
    const [row] = await trx('fs_reports').insert({
      client_id: src.client_id, period_id: target.id, client_layout_id: src.client_layout_id,
      name: input.name ?? (year ? String(src.name).replace(/\b(19|20)\d{2}\b/, year) : src.name),
      framework: src.framework, columns_json: JSON.stringify(src.columns_json), entity_kind: src.entity_kind,
      // The report date and any hand-edited wording belong to the year they were written for.
      front_matter_json: JSON.stringify({ ...fm, letter: { ...fm.letter, reportDate: null, bodyHtmlOverride: null } }),
      created_by: userId, updated_by: userId,
    }).returning('*');
    await logAudit({
      userId, periodId: target.id, clientId: src.client_id, entityType: 'fs_report', entityId: row.id, action: 'create',
      description: `Rolled financial statements "${src.name}" forward into ${target.period_name}`,
    }, trx);
    return row;
  });
}

// ─── Drafts: compute + front matter ──────────────────────────────────────

export interface ResolvedDraft {
  report: Row;
  settings: FsReportSettings;
  layout: FsLayout;
  style: FsStyle;
  frontMatter: FsFrontMatter;
}

export async function resolveDraft(id: number, overrides: FsDraftOverrides = {}): Promise<ResolvedDraft> {
  const report = await getReportRow(id);
  const layoutRow = await getLayoutRow(report.client_layout_id);
  return {
    report,
    settings: overrides.settings ?? settingsOf(report),
    layout: overrides.layout ?? fsClientLayoutSchema.parse(layoutRow.layout_json),
    style: overrides.style ?? fsStyleSchema.parse(layoutRow.style_json),
    frontMatter: overrides.frontMatter ?? frontMatterOf(report),
  };
}

/** Variables an accountant's report may use — see LETTER_VARIABLES in the engine. */
export async function resolveLetter(draft: ResolvedDraft, source: FsSourceData): Promise<{ title: string; bodyHtml: string } | null> {
  const fm = draft.frontMatter.letter;
  if (!fm.enabled) return null;
  // A letter that has since been retired falls back to the default one
  // rather than printing a report with no accountant's letter at all.
  const chosen = fm.letterId ? await library.getLetterRow(fm.letterId) : null;
  const letter = chosen ?? (await library.getDefaultLetterRow());
  if (!letter && !fm.bodyHtmlOverride) return null;
  const letterType = ((letter?.letter_type as string | undefined) ?? 'compilation') as ReportLetterType;
  const profile = await library.getLetterheadRow();
  const firm = (await db('settings').where({ key: 'firm_name' }).first('value'))?.value as string | undefined;
  const firmName = (profile?.display_name as string | null)?.trim() || firm?.trim() || '';
  const city = (profile?.city as string | null)?.trim() || '';
  const state = (profile?.state as string | null)?.trim() || '';
  // Desktop fork (Q71): today in the PC's zone, not the UTC day the engine runs on.
  const reportDate = fm.reportDate ?? localToday();
  const framework = draft.settings.framework;
  const kinds = draft.layout.statements.filter((s) => s.enabled).map((s) => s.kind);
  const values: Record<string, string> = {
    client_name: source.companyName,
    firm_name: firmName,
    firm_city: city,
    firm_state: state,
    firm_city_state: [city, state].filter(Boolean).join(', '),
    accountant_signature: (profile?.accountant_signature as string | null)?.trim() || firmName,
    period_start_date: formatLongDate(source.periodStart),
    period_end_date: formatLongDate(source.periodEnd),
    as_of_date: formatLongDate(source.periodEnd),
    period_description: periodDescription(source.periodStart, source.periodEnd),
    basis_of_accounting: basisOfAccountingPhrase(framework),
    financial_statement_titles: fsIncludedTitlesPhrase(kinds, {
      framework, entityKind: source.entityKind, comparative: draft.settings.columns.mode === 'cy_py',
    }),
    letter_date: formatLongDate(reportDate),
    report_date: formatLongDate(reportDate),
    report_title: REPORT_LETTER_TITLES[letterType] ?? '',
  };
  const body = fm.bodyHtmlOverride ?? (letter?.body_html as string | undefined) ?? '';
  const title = fm.titleOverride?.trim() || (letter?.title as string | null)?.trim() || REPORT_LETTER_TITLES[letterType] || 'Accountant’s Report';
  return { title, bodyHtml: sanitizeFsLetterHtml(renderLetterBody(body, values)) };
}

/** What the browser needs to compute and render the live preview itself. */
export async function previewData(id: number, overrides: FsDraftOverrides = {}) {
  const draft = await resolveDraft(id, overrides);
  const { source } = await loadFsSource(db, draft.report.period_id, draft.settings);
  const letterhead = library.letterheadOf(await library.getLetterheadRow());
  const letter = await resolveLetter(draft, source);
  return { source, letterhead, letter };
}

export interface ComputedDraft extends ResolvedDraft {
  source: FsSourceData;
  period: FsPeriodContext;
  model: FsRenderedReport;
}

export async function computeDraft(id: number, overrides: FsDraftOverrides = {}): Promise<ComputedDraft> {
  const draft = await resolveDraft(id, overrides);
  const { source, period } = await loadFsSource(db, draft.report.period_id, draft.settings);
  const model = computeFsReport(draft.settings, draft.layout, draft.style, source);
  return { ...draft, source, period, model };
}

// ─── Issuance ────────────────────────────────────────────────────────────

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function userDisplayName(userId: number | null): Promise<string | null> {
  if (!userId) return null;
  const u = await db('app_users').where({ id: userId }).first('display_name', 'username');
  return (u?.display_name as string | undefined)?.trim() || (u?.username as string | undefined) || null;
}

export async function finalize(id: number, input: { overrideValidation?: boolean; reason?: string }, userId: number | null) {
  const report = await getReportRow(id);
  if (report.status === 'final') throw new FsError('FS_FINAL_LOCKED', 423, 'These statements are already final.');
  const draft = await computeDraft(id);
  const errors = draft.model.checks.filter((c) => c.severity === 'error');
  if (errors.length && !input.overrideValidation) {
    throw new FsError('FS_VALIDATION', 422, 'Resolve the validation errors, or finalize with an override reason.', { checks: errors });
  }
  const letterhead = library.letterheadOf(await library.getLetterheadRow());
  const letter = await resolveLetter(draft, draft.source);
  // Rendered BEFORE the transaction: Chromium can take seconds, and a missing
  // engine must fail here, with nothing written.
  const pdf = await renderFsPdf({ report: draft.model, style: draft.style, frontMatter: draft.frontMatter, letterhead, letter });
  const byName = await userDisplayName(userId);

  const version = await db.transaction(async (trx) => {
    // Re-check under the lock: of two concurrent finalizes, one loses.
    const fresh = await trx('fs_reports').where({ id }).forUpdate().first('status');
    if (fresh?.status === 'final') throw new FsError('FS_FINAL_LOCKED', 423, 'These statements were finalized by someone else.');
    const last = await trx('fs_report_versions').where({ report_id: id }).max<{ n: number | null }>('version_no as n').first();
    const versionNo = (last?.n ?? 0) + 1;
    await trx('fs_report_versions').where({ report_id: id, status: 'final' }).update({ status: 'superseded', superseded_at: trx.fn.now() });
    const [v] = await trx('fs_report_versions').insert({
      report_id: id, version_no: versionNo, status: 'final',
      model_json: JSON.stringify(draft.model), layout_json: JSON.stringify(draft.layout), style_json: JSON.stringify(draft.style),
      settings_json: JSON.stringify(draft.settings), front_matter_json: JSON.stringify(draft.frontMatter),
      letter_json: letter ? JSON.stringify(letter) : null, letterhead_json: letterhead ? JSON.stringify(letterhead) : null,
      source_stamp: draft.source.sourceStamp, numbers_hash: fsNumbersHash(draft.model),
      pdf_sha256: sha256(pdf.bytes), pdf_size: pdf.bytes.length, page_count: pdf.pageCount,
      validation_override: errors.length > 0, override_reason: errors.length ? (input.reason ?? null) : null,
      finalized_by: userId, finalized_by_name: byName,
    }).returning('*');
    await trx('fs_report_version_files').insert({ version_id: v.id, pdf: pdf.bytes });
    await trx('fs_reports').where({ id }).update({ status: 'final', current_version_id: v.id, updated_by: userId, updated_at: trx.fn.now() });
    await logAudit({
      userId, periodId: report.period_id, clientId: report.client_id, entityType: 'fs_report', entityId: id,
      action: errors.length ? 'override' : 'finalize',
      description: errors.length
        ? `Finalized financial statements "${report.name}" v${versionNo} OVERRIDING ${errors.map((e) => e.code).join(', ')}: ${input.reason ?? ''}`
        : `Finalized financial statements "${report.name}" v${versionNo} (${pdf.pageCount} pages)`,
    }, trx);
    return v;
  });
  return {
    versionNo: version.version_no as number, pageCount: version.page_count as number,
    validationOverride: !!version.validation_override, periodUnlocked: !draft.period.lockedAt,
  };
}

export async function reopen(id: number, userId: number | null): Promise<void> {
  await db.transaction(async (trx) => {
    const report = await trx('fs_reports').where({ id }).forUpdate().first();
    if (!report) throw new FsError('NOT_FOUND', 404, 'Financial statements not found.');
    if (report.status !== 'final') throw new FsError('FS_NOT_FINAL', 400, 'Only final statements can be reopened.');
    if (report.current_version_id) {
      await trx('fs_report_versions').where({ id: report.current_version_id }).update({ reopened_by: userId, reopened_at: trx.fn.now() });
    }
    await trx('fs_reports').where({ id }).update({ status: 'draft', updated_by: userId, updated_at: trx.fn.now() });
    await logAudit({
      userId, periodId: report.period_id, clientId: report.client_id, entityType: 'fs_report', entityId: id, action: 'reopen',
      description: `Reopened financial statements "${report.name}"`,
    }, trx);
  });
}

async function getVersionRow(reportId: number, versionNo: number): Promise<Row> {
  const v = await db('fs_report_versions').where({ report_id: reportId, version_no: versionNo }).first();
  if (!v) throw new FsError('NOT_FOUND', 404, 'Version not found.');
  return v;
}

export async function versionDetail(reportId: number, versionNo: number) {
  const report = await getReportRow(reportId);
  const v = await getVersionRow(reportId, versionNo);
  const stamp = await stampLoader()(report.period_id, frozenSettings(v));
  return {
    versionNo: v.version_no as number, status: v.status as string, finalizedAt: iso(v.finalized_at),
    finalizedByName: (v.finalized_by_name ?? null) as string | null,
    validationOverride: !!v.validation_override, overrideReason: (v.override_reason ?? null) as string | null,
    pageCount: (v.page_count ?? null) as number | null, stale: stamp !== v.source_stamp,
    model: v.model_json as FsRenderedReport,
  };
}

/**
 * The stamp says something the statements are built from moved. Recompute
 * with the FROZEN layout, style and settings to see whether the issued
 * numbers moved with it.
 */
export async function impact(reportId: number, versionNo: number): Promise<{ stale: boolean; changed: boolean }> {
  const report = await getReportRow(reportId);
  const v = await getVersionRow(reportId, versionNo);
  const settings = fsReportSettingsSchema.parse(v.settings_json);
  let source: FsSourceData;
  try {
    source = (await loadFsSource(db, report.period_id, settings)).source;
  } catch {
    return { stale: true, changed: true };
  }
  if (source.sourceStamp === v.source_stamp) return { stale: false, changed: false };
  const live = computeFsReport(settings, fsClientLayoutSchema.parse(v.layout_json), fsStyleSchema.parse(v.style_json), source);
  return { stale: true, changed: fsNumbersHash(live) !== v.numbers_hash };
}

/**
 * The issued PDF. Backups carry rows, not bytes, so after a restore the file
 * row is gone: the PDF is rendered again from the frozen snapshot and marked
 * `regenerated` — the same statements, but not the file that was issued.
 */
async function versionPdf(v: Row): Promise<Buffer> {
  const file = await db('fs_report_version_files').where({ version_id: v.id }).first('pdf');
  if (file?.pdf) return Buffer.isBuffer(file.pdf) ? file.pdf : Buffer.from(file.pdf);
  const pdf = await renderFsPdf({
    report: v.model_json as FsRenderedReport,
    style: fsStyleSchema.parse(v.style_json),
    frontMatter: fsFrontMatterSchema.parse(v.front_matter_json),
    letterhead: (v.letterhead_json ?? null) as FsLetterhead | null,
    letter: (v.letter_json ?? null) as { title: string; bodyHtml: string } | null,
  });
  await db('fs_report_version_files')
    .insert({ version_id: v.id, pdf: pdf.bytes, regenerated: true })
    .onConflict('version_id').ignore();
  return pdf.bytes;
}

export type FsExportFormat = 'pdf' | 'docx' | 'xlsx';
export const FS_EXPORT_MIME: Record<FsExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface FsExport { buffer: Buffer; baseName: string; mimeType: string; report: Row; versionNo: number | null }

export async function exportReport(id: number, format: FsExportFormat, versionNo: number | null, overrides: FsDraftOverrides = {}): Promise<FsExport> {
  const report = await getReportRow(id);
  const mimeType = FS_EXPORT_MIME[format];
  if (versionNo !== null) {
    const v = await getVersionRow(id, versionNo);
    const baseName = `financial-statements-v${v.version_no}.${format}`;
    if (format === 'pdf') return { buffer: await versionPdf(v), baseName, mimeType, report, versionNo };
    const model = v.model_json as FsRenderedReport;
    const style = fsStyleSchema.parse(v.style_json);
    if (format === 'xlsx') return { buffer: await buildFsXlsx(model, style), baseName, mimeType, report, versionNo };
    const buffer = await buildFsDocx({
      report: model, style, frontMatter: fsFrontMatterSchema.parse(v.front_matter_json),
      letterhead: (v.letterhead_json ?? null) as FsLetterhead | null,
      letter: (v.letter_json ?? null) as { title: string; bodyHtml: string } | null,
    });
    return { buffer, baseName, mimeType, report, versionNo };
  }
  const draft = await computeDraft(id, overrides);
  const baseName = `financial-statements-draft.${format}`;
  if (format === 'xlsx') return { buffer: await buildFsXlsx(draft.model, draft.style), baseName, mimeType, report, versionNo };
  const letterhead = library.letterheadOf(await library.getLetterheadRow());
  const letter = await resolveLetter(draft, draft.source);
  if (format === 'docx') {
    const buffer = await buildFsDocx({ report: draft.model, style: draft.style, frontMatter: draft.frontMatter, letterhead, letter });
    return { buffer, baseName, mimeType, report, versionNo };
  }
  const pdf = await renderFsPdf({ report: draft.model, style: draft.style, frontMatter: draft.frontMatter, letterhead, letter, draft: true });
  return { buffer: pdf.bytes, baseName, mimeType, report, versionNo };
}
