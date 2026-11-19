// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Desktop sync S3: every write route and MCP tool is classified, read from
 * the source, so a new one cannot skip the question "does this change a
 * period's data?". A PERIOD route must refuse a period a desktop holds (409
 * PERIOD_CHECKED_OUT); `test/sync-e2e.mjs` fires each one against a held
 * period and checks the period stamp did not move. Everything else says why
 * it is not period data. Adding a route: put it in one list, and if it is a
 * PERIOD route, guard it (`assertPeriodUnlocked(id, trx)` or
 * `assertNotCheckedOut(trx, ids)`) and add it to the e2e walk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const ROUTES = path.join(__dirname, '..', '..', 'routes');
const MCP = path.join(__dirname, '..', '..', 'mcp', 'server.ts');

/** `file router METHOD path` → refuses a held period. */
export const PERIOD_ROUTES = [
  'bankTransactions.ts btCollectionRouter POST /',
  'bankTransactions.ts btCollectionRouter POST /import',
  'bankTransactions.ts btCollectionRouter POST /manual',
  'bankTransactions.ts btCollectionRouter POST /batch-delete',
  'bankTransactions.ts btCollectionRouter POST /batch-classify',
  'bankTransactions.ts btCollectionRouter POST /batch-update-source',
  'bankTransactions.ts btCollectionRouter POST /batch-confirm-ai',
  'bankTransactions.ts btCollectionRouter PATCH /:id',
  'bankTransactions.ts btCollectionRouter DELETE /:id',
  'bankStatementPdfImport.ts bankStatementPdfRouter POST /confirm',
  'csvImport.ts csvImportRouter POST /confirm',
  'pdfImport.ts pdfImportRouter POST /confirm',
  'qboImport.ts qboImportRouter POST /confirm',
  'documents.ts documentsItemRouter DELETE /:id',
  'fs.ts fsRouter PATCH /reports/:reportId',
  'fs.ts fsRouter DELETE /reports/:reportId',
  'fs.ts fsRouter POST /reports/:reportId/roll-forward',
  'fs.ts fsRouter POST /reports/:reportId/finalize',
  'fs.ts fsRouter POST /reports/:reportId/reopen',
  'fs.ts fsPeriodRouter POST /reports',
  'journalEntries.ts jeItemRouter POST /',
  'journalEntries.ts jeItemRouter PUT /:id/lines',
  'journalEntries.ts jeItemRouter PATCH /:id',
  'journalEntries.ts jeItemRouter DELETE /:id',
  'leadSheetAttachments.ts leadSheetAttachmentCollectionRouter POST /',
  'leadSheetAttachments.ts leadSheetAttachmentItemRouter POST /annotations',
  'leadSheetAttachments.ts leadSheetAttachmentItemRouter DELETE /',
  'leadSheets.ts leadSheetItemRouter DELETE /',
  'leadSheets.ts leadSheetPeriodRouter POST /:leadSheetId/signoff',
  'leadSheets.ts leadSheetPeriodRouter POST /:leadSheetId/unsign',
  'leadSheets.ts leadSheetPeriodRouter POST /:leadSheetId/notes',
  'leadSheets.ts leadSheetPeriodRouter POST /:leadSheetId/notes/:noteId/resolve',
  'periods.ts periodItemRouter PATCH /:id',
  'periods.ts periodItemRouter POST /:id/lock',
  'periods.ts periodItemRouter DELETE /:id',
  'pyComparison.ts pyComparisonRouter POST /manual',
  'pyComparison.ts pyComparisonRouter POST /confirm-csv',
  'pyComparison.ts pyComparisonRouter POST /confirm-pdf',
  'pyComparison.ts pyComparisonRouter DELETE /',
  'pyComparison.ts pyComparisonRouter POST /create-aje',
  'reconciliations.ts reconciliationCollectionRouter POST /',
  'reconciliations.ts reconciliationItemRouter PATCH /',
  'reconciliations.ts reconciliationItemRouter POST /toggle-item',
  'reconciliations.ts reconciliationItemRouter POST /complete',
  'reconciliations.ts reconciliationItemRouter POST /reopen',
  'reconciliations.ts reconciliationItemRouter DELETE /',
  'tickmarks.ts tickmarkLibraryItemRouter DELETE /',
  'tickmarks.ts tbTickmarkRouter POST /toggle',
  'trialBalance.ts tbPeriodRouter POST /initialize',
  'trialBalance.ts tbPeriodRouter POST /import',
  'trialBalance.ts tbPeriodRouter POST /import-prior-year',
  'trialBalance.ts tbPeriodRouter PUT /:accountId',
  'taxWorkpapers.ts m1CollectionRouter POST /',
  'taxWorkpapers.ts m1ItemRouter PATCH /',
  'taxWorkpapers.ts m1ItemRouter DELETE /',
  'engagement.ts engagementCollectionRouter POST /',
  'engagement.ts engagementItemRouter PATCH /',
  'engagement.ts engagementItemRouter DELETE /',
  'comparison.ts comparisonRouter PUT /variance-notes/:accountId',
  'varianceNotes.ts varianceNotesRouter PUT /:accountId',
  'backup.ts restoreRouter POST /execute',
];

/** Writes that SKIP rows of a held period instead of refusing. */
export const PERIOD_SKIPPING_ROUTES = [
  'bankTransactions.ts btCollectionRouter POST /ai-classify',
];

/** Files none of whose write routes change a period's data, and why. */
const OTHER_FILES: Record<string, string> = {
  'auth.ts': "the caller's own account",
  'passkeys.ts': "the caller's own account",
  'passwordReset.ts': 'account passwords',
  'totp.ts': "the caller's own account",
  'trustedBrowsers.ts': "the caller's own account",
  'users.ts': 'users',
  'settings.ts': 'firm settings',
  'storage.ts': 'storage configuration and folder links',
  'support.ts': 'support conversations',
  'clients.ts': 'clients (deactivate is soft)',
  'chartOfAccounts.ts': 'the chart (client level; SQ3 covers changes while a period is out)',
  'coaTemplates.ts': 'firm templates; apply refuses a client with trial balance rows',
  'taxCodes.ts': 'tax codes',
  'taxLineAssignment.ts': "the chart's tax lines (client level)",
  'units.ts': "the chart's units (client level)",
  'savedReports.ts': 'saved report definitions',
  'qboIntegration.ts': 'QuickBooks connection',
  'mcpHttp.ts': 'the MCP transport; its tools are classified below',
  'sync.ts': "the desktop's own pairing, pulls, check-outs and uploads; its send-back (POST /periods/:uid/push) is the one writer a held period lets in, under that check-out (lib/sync/mergePeriod.ts)",
  'scannedSheetImport.ts': 'reads a scan; writes nothing',
  'diagnostics.ts': 'reads and asks the AI; writes nothing',
  'exports.ts': 'consolidation settings, by client',
  'pdfReports.ts': 'a merged workpaper PDF saved as a client document',
  'rollForward.ts': 'reads the source period (a held one too) and makes a new period',
};

/** Single write routes in mixed files that are not period data, and why. */
const OTHER_ROUTES: Record<string, string> = {
  'bankTransactions.ts btRulesRouter DELETE /:id': 'classification rules (client)',
  'bankStatementPdfImport.ts bankStatementPdfRouter POST /analyze': 'parses a statement; writes nothing',
  'csvImport.ts csvImportRouter POST /analyze': 'parse only',
  'csvImport.ts csvImportRouter POST /suggest-numbers': 'AI suggestion only',
  'csvImport.ts csvImportRouter POST /chat': 'AI chat only',
  'pdfImport.ts pdfImportRouter POST /analyze': 'parse only',
  'pdfImport.ts pdfImportRouter POST /suggest-numbers': 'AI suggestion only',
  'pdfImport.ts pdfImportRouter POST /chat': 'AI chat only',
  'pdfImport.ts pdfImportRouter POST /verify/:importId': "an import's verification fields",
  'qboImport.ts qboImportRouter POST /preview': 'a pending import row; confirm is guarded',
  'qboImport.ts qboImportRouter POST /suggest-matches': 'AI suggestion only',
  'qboImport.ts qboImportRouter POST /suggest-numbers': 'AI suggestion only',
  'documents.ts documentsCollectionRouter POST /': 'a client document (not period data)',
  'documents.ts documentsItemRouter PUT /:id/link': "a client document's link",
  'fs.ts fsRouter PUT /pdf-engine': 'server setting',
  'fs.ts fsRouter POST /pdf-engine/test': 'reads',
  'fs.ts fsRouter PUT /library/letterhead': 'firm library',
  'fs.ts fsRouter POST /library/letters': 'firm library',
  'fs.ts fsRouter PUT /library/letters/:letterId': 'firm library',
  'fs.ts fsRouter DELETE /library/letters/:letterId': 'firm library',
  'fs.ts fsRouter POST /library/presets': 'firm library',
  'fs.ts fsRouter PUT /library/presets/:presetId': 'firm library',
  'fs.ts fsRouter DELETE /library/presets/:presetId': 'firm library',
  'fs.ts fsRouter POST /library/templates': 'firm library',
  'fs.ts fsRouter PUT /library/templates/:templateId': 'firm library',
  'fs.ts fsRouter DELETE /library/templates/:templateId': 'firm library',
  'fs.ts fsRouter PATCH /layouts/:layoutId': 'client layout (client level)',
  'fs.ts fsRouter POST /layouts/:layoutId/save-as-template': 'firm library',
  'fs.ts fsRouter POST /reports/:reportId/preview-data': 'reads',
  'fs.ts fsRouter POST /reports/:reportId/compute': 'reads',
  'fs.ts fsRouter POST /reports/:reportId/preview.pdf': 'reads',
  'fs.ts fsRouter POST /reports/:reportId/versions/:versionNo/save-to-folder': 'an issued PDF saved as a client document',
  'fs.ts fsClientRouter PUT /cash-flow-overrides': 'client level',
  'fs.ts fsClientRouter PUT /equity-roles': 'client level',
  'leadSheets.ts leadSheetCollectionRouter POST /seed': 'client lead sheets',
  'leadSheets.ts leadSheetCollectionRouter POST /': 'client lead sheets',
  'leadSheets.ts leadSheetCollectionRouter POST /reorder': 'client lead sheets',
  'leadSheets.ts leadSheetCollectionRouter POST /assign': "the chart's lead sheets (client level)",
  'leadSheets.ts leadSheetCollectionRouter POST /auto-assign/preview': 'reads',
  'leadSheets.ts leadSheetCollectionRouter POST /auto-assign/confirm': "the chart's lead sheets (client level)",
  'leadSheets.ts leadSheetItemRouter PATCH /': 'a client lead sheet',
  'periods.ts periodCollectionRouter POST /': 'a new period (flips is_current on the others, which stays open)',
  'periods.ts periodItemRouter POST /:id/checkout/release': "the admin's release of a check-out",
  'periods.ts periodItemRouter POST /:id/unlock': 'admin unlock (a held period is never locked)',
  'tickmarks.ts tickmarkLibraryCollectionRouter POST /': 'client tickmark library',
  'tickmarks.ts tickmarkLibraryItemRouter PATCH /': 'client tickmark library',
  'tickmarks.ts systemTickmarkCollectionRouter POST /': 'system tickmarks',
  'tickmarks.ts systemTickmarkCollectionRouter POST /apply/:clientId': 'copies system tickmarks into a client library',
  'tickmarks.ts systemTickmarkItemRouter PATCH /': 'system tickmarks',
  'tickmarks.ts systemTickmarkItemRouter DELETE /': 'system tickmarks',
  'backup.ts backupRouter POST /full': 'reads',
  'backup.ts backupRouter POST /settings': 'reads',
  'backup.ts backupRouter POST /client/:clientId': 'reads',
  'backup.ts backupRouter POST /period/:periodId': 'reads',
  'backup.ts backupRouter DELETE /:backupId': 'a backup file',
  'backup.ts restoreRouter POST /upload': 'stages a file',
};

/** MCP tools: refuse a held period, or why not. */
export const MCP_PERIOD_TOOLS = ['update_trial_balance_row', 'create_journal_entry', 'lock_period', 'add_variance_note', 'update_engagement_task'];
const MCP_OTHER: Record<string, string> = {
  list_clients: 'reads', get_period_dashboard: 'reads', get_trial_balance: 'reads', list_journal_entries: 'reads',
  get_chart_of_accounts: 'reads', get_tax_mapping_status: 'reads', auto_assign_tax_codes: "the chart's tax codes (client level)",
  confirm_tax_assignments: "the chart's tax codes (client level)", run_diagnostics: 'reads', search_accounts: 'reads',
  get_period_comparison: 'reads', list_engagement_tasks: 'reads', generate_report_url: 'reads',
  period_review: 'a prompt', tax_mapping_review: 'a prompt', variance_investigation: 'a prompt', engagement_status: 'a prompt',
  full_period_close: 'a prompt',
};

function writeRoutes(): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(ROUTES).filter((n) => n.endsWith('.ts')).sort()) {
    const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');
    const re = /\b(\w+)\.(post|put|patch|delete)\(\s*(['`])([^'`]*)\3/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(`${f} ${m[1]} ${m[2].toUpperCase()} ${m[4]}`);
  }
  return out;
}

test('every write route is classified as period data or not, exactly once', () => {
  const found = writeRoutes();
  assert.ok(found.length > 150, `found ${found.length} write routes: the pattern still matches`);
  const unclassified = found.filter((r) => {
    const file = r.split(' ')[0]!;
    const listed = [PERIOD_ROUTES.includes(r), PERIOD_SKIPPING_ROUTES.includes(r), r in OTHER_ROUTES, file in OTHER_FILES].filter(Boolean).length;
    return listed !== 1;
  });
  assert.deepEqual(unclassified, [], 'classify each in periodWriteRoutes.test.ts (once)');
  const stale = [...PERIOD_ROUTES, ...PERIOD_SKIPPING_ROUTES, ...Object.keys(OTHER_ROUTES)].filter((r) => !found.includes(r));
  assert.deepEqual(stale, [], 'listed routes that no longer exist');
});

test('every MCP tool is classified', () => {
  const src = fs.readFileSync(MCP, 'utf8');
  const tools = [...src.matchAll(/case '(\w+)':/g)].map((m) => m[1]!);
  assert.ok(tools.length >= 20);
  const unclassified = tools.filter((t) => [MCP_PERIOD_TOOLS.includes(t), t in MCP_OTHER].filter(Boolean).length !== 1);
  assert.deepEqual(unclassified, []);
});
