// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The desktop OpenAPI document must be valid OpenAPI 3.1, and responses
// recorded from a real desktop engine (fixtures/, demo seed data) must match
// the schemas it declares — so a route that changes shape fails here before
// the generated Rust client trips over it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { buildOpenApiSpec } from '../openapi';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SwaggerParser = require('@apidevtools/swagger-parser') as { validate(doc: unknown): Promise<unknown> };

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

test('document is valid OpenAPI 3.1', async () => {
  // validate() dereferences in place, so give it a copy.
  await SwaggerParser.validate(structuredClone(buildOpenApiSpec()));
});

test('every operation has a unique operationId', () => {
  const ids: string[] = [];
  for (const item of Object.values(buildOpenApiSpec().paths as Record<string, Record<string, unknown>>)) {
    for (const op of Object.values(item)) {
      if (op && typeof op === 'object' && 'operationId' in op) ids.push(String((op as { operationId: string }).operationId));
    }
  }
  assert.equal(new Set(ids).size, ids.length);
});

function responseValidator(pathKey: string, method: string, status: string) {
  const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>> };
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(spec, 'spec');
  const schema = spec.paths[pathKey][method].responses[status].content['application/json'].schema;
  const rewired = JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"spec#/components/'));
  return ajv.compile(rewired);
}

for (const [pathKey, file] of [
  ['/api/v1/health', 'health.json'],
  ['/api/v1/clients', 'clients.json'],
  ['/api/v1/clients/{clientId}/periods', 'periods.json'],
  ['/api/v1/clients/{clientId}/chart-of-accounts', 'chart-of-accounts.json'],
  ['/api/v1/periods/{periodId}/trial-balance', 'trial-balance.json'],
  ['/api/v1/desktop/periods/{periodId}/trial-balance/totals', 'trial-balance-totals.json'],
  ['/api/v1/periods/{periodId}/journal-entries', 'journal-entries.json'],
  ['/api/v1/periods/{periodId}/variance-notes', 'variance-notes.json'],
  ['/api/v1/desktop/clients/summary', 'clients-summary.json'],
  ['/api/v1/clients/{clientId}/tickmarks', 'tickmarks.json'],
  ['/api/v1/periods/{periodId}/tb-tickmarks', 'tb-tickmarks.json'],
  ['/api/v1/clients/{clientId}/lead-sheets', 'lead-sheets.json'],
  ['/api/v1/clients/{clientId}/bank-transactions', 'bank-transactions.json'],
  ['/api/v1/clients/{clientId}/reconciliations', 'reconciliations.json'],
  ['/api/v1/reconciliations/{id}', 'reconciliation.json'],
  ['/api/v1/features', 'features.json'],
  ['/api/v1/features', 'features-ai.json'],
  ['/api/v1/features', 'features-no-ai.json'],
  ['/api/v1/settings/llm-provider', 'llm-provider.json'],
] as const) {
  test(`recorded ${file} matches GET ${pathKey}`, () => {
    const validate = responseValidator(pathKey, 'get', '200');
    const ok = validate(fixture(file));
    assert.ok(ok, JSON.stringify(validate.errors, null, 2));
  });
}

test('recorded csv-analyze.json matches POST /api/v1/import/csv/analyze', () => {
  const validate = responseValidator('/api/v1/import/csv/analyze', 'post', '200');
  assert.ok(validate(fixture('csv-analyze.json')), JSON.stringify(validate.errors, null, 2));
});

for (const [pathKey, method, status, file] of [
  ['/api/v1/journal-entries', 'post', '201', 'journal-entry-created.json'],
  ['/api/v1/journal-entries/{id}', 'patch', '200', 'journal-entry-updated.json'],
  ['/api/v1/journal-entries/{id}', 'delete', '200', 'journal-entry-deleted.json'],
  ['/api/v1/journal-entries', 'post', '400', 'journal-entry-unbalanced.json'],
  ['/api/v1/chart-of-accounts/{id}', 'patch', '200', 'account-updated.json'],
  ['/api/v1/clients/{clientId}/tickmarks', 'post', '201', 'tickmark-created.json'],
  ['/api/v1/system-tickmarks/apply/{clientId}', 'post', '200', 'tickmarks-applied.json'],
  ['/api/v1/periods/{periodId}/tb-tickmarks/toggle', 'post', '200', 'tb-tickmark-toggled.json'],
  ['/api/v1/clients/{clientId}/lead-sheets/seed', 'post', '201', 'lead-sheets-seeded.json'],
  ['/api/v1/clients/{clientId}/lead-sheets/auto-assign/preview', 'post', '200', 'fs-lead-sheets-auto-preview.json'],
  ['/api/v1/clients/{clientId}/lead-sheets/auto-assign/preview', 'post', '409', 'fs-lead-sheets-not-seeded.json'],
  ['/api/v1/clients/{clientId}/lead-sheets/auto-assign/confirm', 'post', '200', 'fs-lead-sheets-auto-assigned.json'],
  ['/api/v1/clients/{clientId}/bank-transactions/{id}', 'patch', '200', 'bank-transaction-updated.json'],
  ['/api/v1/clients/{clientId}/bank-transactions/batch-classify', 'post', '200', 'bank-batch-classified.json'],
  ['/api/v1/clients/{clientId}/bank-transactions/batch-confirm-ai', 'post', '200', 'bank-ai-confirmed.json'],
  ['/api/v1/clients/{clientId}/bank-transactions/batch-update-source', 'post', '200', 'bank-source-updated.json'],
  ['/api/v1/clients/{clientId}/bank-transactions/manual', 'post', '201', 'bank-manual-created.json'],
  ['/api/v1/clients/{clientId}/bank-transactions/batch-delete', 'post', '200', 'bank-batch-deleted.json'],
  ['/api/v1/clients/{clientId}/bank-transactions/ai-classify', 'post', '200', 'bank-ai-classified.json'],
  ['/api/v1/import/bank-statement-pdf/confirm', 'post', '200', 'bank-rows-imported.json'],
  ['/api/v1/clients/{clientId}/reconciliations', 'post', '201', 'reconciliation-created.json'],
  ['/api/v1/reconciliations/{id}/toggle-item', 'post', '200', 'reconciliation-toggled.json'],
  ['/api/v1/reconciliations/{id}/complete', 'post', '409', 'reconciliation-out-of-balance.json'],
  ['/api/v1/reconciliations/{id}/complete', 'post', '200', 'reconciliation-completed.json'],
  ['/api/v1/reconciliations/{id}/reopen', 'post', '200', 'reconciliation-reopened.json'],
  ['/api/v1/import/bank-statement-pdf/analyze', 'post', '200', 'bank-statement-analyzed.json'],
  ['/api/v1/import/pdf/analyze', 'post', '200', 'pdf-tb-analyzed.json'],
  ['/api/v1/import/pdf/confirm', 'post', '200', 'pdf-tb-confirmed.json'],
  ['/api/v1/settings/test-llm', 'post', '200', 'llm-tested.json'],
  ['/api/v1/settings/provider-models', 'post', '200', 'provider-models.json'],
  // P07: tax codes, their assignment to accounts, exports.
  ['/api/v1/tax-codes', 'get', '200', 'tax-codes.json'],
  ['/api/v1/tax-codes/available', 'get', '200', 'tax-codes-available.json'],
  ['/api/v1/tax-codes/{id}', 'get', '200', 'tax-code.json'],
  ['/api/v1/tax-codes', 'post', '201', 'tax-code-created.json'],
  ['/api/v1/tax-codes/{id}', 'put', '200', 'tax-code-updated.json'],
  ['/api/v1/tax-codes/{id}', 'delete', '200', 'tax-code-deactivated.json'],
  ['/api/v1/tax-codes/{id}', 'delete', '409', 'tax-code-in-use.json'],
  ['/api/v1/tax-codes/import/preview', 'post', '200', 'tax-codes-import-preview.json'],
  ['/api/v1/tax-codes/import', 'post', '200', 'tax-codes-imported.json'],
  ['/api/v1/tax-lines/auto-assign', 'post', '200', 'tax-lines-suggested.json'],
  ['/api/v1/tax-lines/bulk-confirm', 'put', '200', 'tax-lines-confirmed.json'],
  ['/api/v1/clients/{clientId}/chart-of-accounts', 'get', '200', 'chart-of-accounts-tax.json'],
  ['/api/v1/chart-of-accounts/{id}', 'patch', '200', 'account-tax-code-set.json'],
  ['/api/v1/periods/{periodId}/exports/validate', 'get', '200', 'export-validate-ultratax.json'],
  ['/api/v1/periods/{periodId}/exports/consolidation-settings', 'get', '200', 'export-consolidation.json'],
  ['/api/v1/periods/{periodId}/exports/consolidation-settings', 'put', '200', 'export-consolidation-saved.json'],
  ['/api/v1/periods/{periodId}/exports/{software}', 'get', '409', 'export-duplicate-account.json'],
  // P08b: the Statement Writer (record_p08b.rs on the demo seed).
  ['/api/v1/fs/status', 'get', '200', 'fs-status.json'],
  ['/api/v1/fs/pdf-engine', 'put', '200', 'fs-pdf-engine-missing.json'],
  ['/api/v1/fs/pdf-engine', 'put', '200', 'fs-pdf-engine-auto.json'],
  ['/api/v1/fs/pdf-engine/test', 'post', '503', 'fs-pdf-engine-test.json'],
  ['/api/v1/fs/library', 'get', '200', 'fs-library.json'],
  ['/api/v1/fs/library', 'get', '200', 'fs-library-after.json'],
  ['/api/v1/fs/library/letterhead', 'put', '200', 'fs-letterhead-saved.json'],
  ['/api/v1/fs/library/letters', 'post', '201', 'fs-letter-created.json'],
  ['/api/v1/fs/library/letters/{letterId}', 'put', '200', 'fs-letter-updated.json'],
  ['/api/v1/fs/library/letters/{letterId}', 'delete', '200', 'fs-letter-deleted.json'],
  ['/api/v1/fs/library/presets', 'post', '201', 'fs-preset-created.json'],
  ['/api/v1/fs/library/presets/{presetId}', 'put', '200', 'fs-preset-updated.json'],
  ['/api/v1/fs/library/presets/{presetId}', 'delete', '200', 'fs-preset-deleted.json'],
  ['/api/v1/fs/library/templates', 'post', '201', 'fs-template-created.json'],
  ['/api/v1/fs/library/templates/{templateId}', 'put', '200', 'fs-template-updated.json'],
  ['/api/v1/fs/library/templates/{templateId}', 'delete', '200', 'fs-template-deleted.json'],
  ['/api/v1/fs/layouts/{layoutId}', 'get', '200', 'fs-layout-default.json'],
  ['/api/v1/fs/layouts/{layoutId}', 'get', '200', 'fs-layout-full.json'],
  ['/api/v1/fs/layouts/{layoutId}', 'patch', '200', 'fs-layout-saved.json'],
  ['/api/v1/fs/layouts/{layoutId}', 'patch', '409', 'fs-layout-conflict.json'],
  ['/api/v1/fs/layouts/{layoutId}/save-as-template', 'post', '201', 'fs-saved-as-template.json'],
  ['/api/v1/fs/layouts/{layoutId}/save-as-template', 'post', '201', 'fs-saved-as-template-full.json'],
  ['/api/v1/fs/reports/{reportId}', 'get', '200', 'fs-report-new.json'],
  ['/api/v1/fs/reports/{reportId}', 'get', '200', 'fs-report.json'],
  ['/api/v1/fs/reports/{reportId}', 'get', '200', 'fs-report-final.json'],
  ['/api/v1/fs/reports/{reportId}', 'get', '404', 'fs-not-found.json'],
  ['/api/v1/fs/reports/{reportId}', 'patch', '200', 'fs-report-updated.json'],
  ['/api/v1/fs/reports/{reportId}', 'patch', '423', 'fs-report-final-locked.json'],
  ['/api/v1/fs/reports/{reportId}', 'delete', '200', 'fs-archived.json'],
  ['/api/v1/fs/reports/{reportId}/roll-forward', 'post', '201', 'fs-rolled-forward.json'],
  ['/api/v1/fs/reports/{reportId}/compute', 'post', '200', 'fs-compute.json'],
  ['/api/v1/fs/reports/{reportId}/preview.pdf', 'get', '503', 'fs-preview-unavailable.json'],
  ['/api/v1/fs/reports/{reportId}/finalize', 'post', '422', 'fs-finalize-refused.json'],
  ['/api/v1/fs/reports/{reportId}/finalize', 'post', '400', 'fs-finalize-no-reason.json'],
  ['/api/v1/fs/reports/{reportId}/finalize', 'post', '200', 'fs-finalized.json'],
  ['/api/v1/fs/reports/{reportId}/finalize', 'post', '423', 'fs-finalize-locked.json'],
  ['/api/v1/fs/reports/{reportId}/reopen', 'post', '200', 'fs-reopened.json'],
  ['/api/v1/fs/reports/{reportId}/reopen', 'post', '400', 'fs-reopen-refused.json'],
  ['/api/v1/fs/reports/{reportId}/versions/{versionNo}', 'get', '200', 'fs-version.json'],
  ['/api/v1/fs/reports/{reportId}/versions/{versionNo}/impact', 'get', '200', 'fs-impact.json'],
  ['/api/v1/fs/reports/{reportId}/versions/{versionNo}/save-to-folder', 'post', '201', 'fs-saved-to-folder.json'],
  ['/api/v1/clients/{clientId}/fs/reports', 'get', '200', 'fs-reports.json'],
  ['/api/v1/clients/{clientId}/fs/reports', 'get', '200', 'fs-reports-final.json'],
  ['/api/v1/clients/{clientId}/fs/layouts', 'get', '200', 'fs-layouts.json'],
  ['/api/v1/clients/{clientId}/fs/bind-preview', 'get', '200', 'fs-bind-preview.json'],
  ['/api/v1/clients/{clientId}/fs/bind-preview', 'get', '200', 'fs-bind-preview-template.json'],
  ['/api/v1/clients/{clientId}/fs/accounts', 'get', '200', 'fs-accounts.json'],
  ['/api/v1/clients/{clientId}/fs/cash-flow-overrides', 'get', '200', 'fs-cash-flow-overrides.json'],
  ['/api/v1/clients/{clientId}/fs/cash-flow-overrides', 'put', '200', 'fs-cash-flow-overrides-saved.json'],
  ['/api/v1/clients/{clientId}/fs/equity-roles', 'get', '200', 'fs-equity-roles.json'],
  ['/api/v1/clients/{clientId}/fs/equity-roles', 'put', '200', 'fs-equity-roles-saved.json'],
  ['/api/v1/periods/{periodId}/fs/reports', 'post', '201', 'fs-report-created.json'],
  // P09: documents, the checklist, lead sheets, workpapers (record_p09.rs on the demo seed).
  ['/api/v1/desktop/me', 'get', '200', 'desktop-me.json'],
  ['/api/v1/desktop/me', 'put', '200', 'desktop-me-saved.json'],
  ['/api/v1/desktop/me', 'put', '400', 'desktop-me-refused.json'],
  ['/api/v1/clients/{clientId}/documents', 'get', '200', 'documents-empty.json'],
  ['/api/v1/clients/{clientId}/documents', 'get', '200', 'documents.json'],
  ['/api/v1/clients/{clientId}/documents', 'post', '201', 'document-uploaded.json'],
  ['/api/v1/clients/{clientId}/documents', 'post', '201', 'document-uploaded-no-period.json'],
  ['/api/v1/clients/{clientId}/documents', 'post', '400', 'document-refused-type.json'],
  ['/api/v1/clients/{clientId}/documents', 'post', '400', 'document-refused-content.json'],
  ['/api/v1/documents/{id}/link', 'put', '200', 'document-linked.json'],
  ['/api/v1/documents/{id}', 'delete', '200', 'document-deleted.json'],
  ['/api/v1/documents/{id}/download', 'get', '404', 'document-not-found.json'],
  ['/api/v1/periods/{periodId}/engagement-tasks', 'get', '200', 'engagement-tasks-empty.json'],
  ['/api/v1/periods/{periodId}/engagement-tasks', 'get', '200', 'engagement-tasks.json'],
  ['/api/v1/periods/{periodId}/engagement-tasks', 'post', '201', 'engagement-task-created.json'],
  ['/api/v1/periods/{periodId}/engagement-tasks', 'post', '400', 'engagement-task-refused.json'],
  ['/api/v1/engagement-tasks/{id}', 'patch', '200', 'engagement-task-completed.json'],
  ['/api/v1/engagement-tasks/{id}', 'delete', '200', 'engagement-task-deleted.json'],
  ['/api/v1/engagement-summary', 'get', '200', 'engagement-summary.json'],
  ['/api/v1/clients/{clientId}/lead-sheets', 'get', '200', 'lead-sheets-period.json'],
  ['/api/v1/clients/{clientId}/lead-sheets', 'post', '201', 'lead-sheet-created.json'],
  ['/api/v1/clients/{clientId}/lead-sheets', 'post', '409', 'lead-sheet-duplicate.json'],
  ['/api/v1/clients/{clientId}/lead-sheets/unassigned', 'get', '200', 'lead-sheets-unassigned.json'],
  ['/api/v1/clients/{clientId}/lead-sheets/reorder', 'post', '200', 'lead-sheets-reordered.json'],
  ['/api/v1/clients/{clientId}/lead-sheets/assign', 'post', '200', 'lead-sheets-assigned.json'],
  ['/api/v1/lead-sheets/{id}', 'patch', '200', 'lead-sheet-renamed.json'],
  ['/api/v1/lead-sheets/{id}', 'delete', '200', 'lead-sheet-deleted.json'],
  ['/api/v1/periods/{periodId}/lead-sheets', 'get', '200', 'lead-sheets-period-view.json'],
  ['/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}', 'get', '200', 'lead-sheet.json'],
  ['/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/signoff', 'post', '201', 'lead-sheet-signed.json'],
  ['/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/unsign', 'post', '200', 'lead-sheet-unsigned.json'],
  ['/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/unsign', 'post', '404', 'lead-sheet-not-signed.json'],
  ['/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/notes', 'get', '200', 'lead-sheet-notes.json'],
  ['/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/notes', 'post', '201', 'lead-sheet-note-added.json'],
  ['/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/notes/{noteId}/resolve', 'post', '200', 'lead-sheet-note-resolved.json'],
  ['/api/v1/periods/{periodId}/lead-sheet-attachments', 'get', '200', 'lead-sheet-attachments.json'],
  ['/api/v1/periods/{periodId}/lead-sheet-attachments', 'post', '201', 'lead-sheet-attachment-added.json'],
  ['/api/v1/periods/{periodId}/lead-sheet-attachments', 'post', '201', 'lead-sheet-attachment-picture.json'],
  ['/api/v1/periods/{periodId}/lead-sheet-attachments', 'post', '400', 'lead-sheet-attachment-refused.json'],
  ['/api/v1/periods/{periodId}/lead-sheet-attachments/by-account', 'get', '200', 'lead-sheet-attachments-by-account.json'],
  ['/api/v1/lead-sheet-attachments/{id}', 'delete', '200', 'lead-sheet-attachment-deleted.json'],
  ['/api/v1/reports/periods/{periodId}/workpaper-merged/save', 'post', '201', 'workpaper-merged-saved.json'],
  ['/api/v1/reports/periods/{periodId}/workpaper-merged/save', 'post', '400', 'workpaper-merged-refused.json'],
  // P10: AI diagnostics and the support chat (record_p10.rs: no AI, then a fake Ollama on loopback).
  ['/api/v1/periods/{periodId}/diagnostics', 'post', '200', 'diagnostics.json'],
  ['/api/v1/periods/{periodId}/diagnostics', 'post', '500', 'diagnostics-no-ai.json'],
  ['/api/v1/periods/{periodId}/diagnostics', 'post', '404', 'diagnostics-not-found.json'],
  ['/api/v1/support/chat', 'post', '400', 'support-chat-refused.json'],
  ['/api/v1/support/conversations', 'get', '200', 'support-conversations.json'],
  ['/api/v1/support/conversations/{id}', 'get', '200', 'support-conversation.json'],
  ['/api/v1/support/conversations/{id}', 'get', '404', 'support-conversation-not-found.json'],
  ['/api/v1/support/conversations/{id}', 'put', '200', 'support-conversation-renamed.json'],
  ['/api/v1/support/conversations/{id}', 'put', '400', 'support-conversation-refused.json'],
  ['/api/v1/support/conversations/{id}', 'delete', '200', 'support-conversation-deleted.json'],
  ['/api/v1/support/conversations/{id}/bookmark', 'post', '200', 'support-conversation-bookmark.json'],
] as const) {
  test(`recorded ${file} matches ${method.toUpperCase()} ${pathKey} ${status}`, () => {
    const validate = responseValidator(pathKey, method, status);
    assert.ok(validate(fixture(file)), JSON.stringify(validate.errors, null, 2));
  });
}

// The chat answers as server-sent events: every `data:` line of each recorded
// stream is a ChatEvent, and the stream ends in done or error.
for (const file of ['support-chat.txt', 'support-chat-continued.txt', 'support-chat-no-ai.txt', 'support-chat-unknown-conversation.txt']) {
  test(`recorded ${file} is a stream of ChatEvent`, () => {
    const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>> };
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema(spec, 'spec');
    const schema = spec.paths['/api/v1/support/chat'].post.responses['200'].content['text/event-stream'].schema;
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"spec#/components/')));
    const events = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8')
      .split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean)
      .map((b) => JSON.parse(b.replace(/^data: /, '')) as { type: string });
    assert.ok(events.length > 0);
    for (const e of events) assert.ok(validate(e), `${JSON.stringify(e)}: ${JSON.stringify(validate.errors)}`);
    assert.ok(['done', 'error'].includes(events[events.length - 1].type), 'ends in done or error');
  });
}

test('the recorded layout save (every node type and optional field) matches the PATCH request schema', () => {
  const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, { requestBody: { content: Record<string, { schema: unknown }> } }>> };
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(spec, 'spec');
  const schema = spec.paths['/api/v1/fs/layouts/{layoutId}'].patch.requestBody.content['application/json'].schema;
  const validate = ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"spec#/components/')));
  assert.ok(validate(fixture('fs-layout-saved.request.json')), JSON.stringify(validate.errors, null, 2));
});

test('committed openapi.desktop.json is up to date (npm run desktop:openapi)', () => {
  const committed = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../openapi.desktop.json'), 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildOpenApiSpec())));
});
