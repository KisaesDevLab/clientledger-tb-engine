// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// OpenAPI 3.1 description of the routes the ClientLedger Trial Balance desktop
// app calls. The desktop's typed Rust client (cltb-api) is generated from it.
// It grows phase by phase; a route the desktop starts calling gets added here
// in the same change. Shapes are what the routes return today (snake_case DB
// rows inside the { data, error, meta } envelope); amounts are integer cents.

import { Router } from 'express';
import { desktopBackupRouter } from './backupRoutes';
import { desktopTbRouter } from './tbTotals';
import { desktopClientSummaryRouter } from './clientSummary';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../package.json') as { version: string };

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: Schema = {}): Schema => ({ type: [type, 'null'], ...extra });
const cents = (description: string): Schema => ({ type: 'integer', format: 'int64', description: `${description} (cents)` });
const dateTime: Schema = { type: 'string', format: 'date-time' };

function envelope(data: Schema, withMeta = false): Schema {
  const properties: Schema = { data, error: { type: 'null' } };
  if (withMeta) properties.meta = ref('ListMeta');
  return { type: 'object', required: ['data', 'error'], properties };
}

function ok(description: string, data: Schema, withMeta = false): Schema {
  return { description, content: { 'application/json': { schema: envelope(data, withMeta) } } };
}

const errorResponse = (description: string): Schema => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope') } },
});

const commonErrors: Schema = {
  '401': errorResponse('Missing or wrong desktop session token'),
  '500': errorResponse('Server error'),
};

const idParam = (name: string, description: string): Schema => ({
  name, in: 'path', required: true, description, schema: { type: 'integer', minimum: 1 },
});

const jsonBody = (schema: Schema): Schema => ({
  required: true,
  content: { 'application/json': { schema } },
});

const entityType: Schema = { type: 'string', enum: ['1065', '1120', '1120S', '1040_C'] };
const taxSoftware: Schema = { type: 'string', enum: ['ultratax', 'cch', 'lacerte', 'gosystem'] };
const activityType: Schema = { type: 'string', enum: ['business', 'rental', 'farm', 'farm_rental'] };

const schemas: Record<string, Schema> = {
  ErrorEnvelope: {
    type: 'object',
    required: ['data', 'error'],
    properties: {
      data: { type: 'null' },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
  ListMeta: {
    type: 'object',
    required: ['count'],
    properties: { count: { type: 'integer', minimum: 0 } },
  },
  Health: {
    type: 'object',
    required: ['ok', 'checks'],
    properties: {
      ok: { type: 'boolean' },
      version: { type: 'string' },
      checks: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean' }, ms: { type: 'integer' }, error: { type: 'string' } },
        },
      },
    },
  },
  Ping: {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' }, version: { type: 'string' } },
  },
  Client: {
    type: 'object',
    required: ['id', 'name', 'entity_type', 'tax_year_end', 'is_active', 'activity_type', 'created_at', 'updated_at'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      client_code: nullable('string'),
      entity_type: entityType,
      tax_year_end: { type: 'string', description: 'MMDD, e.g. 1231' },
      default_tax_software: { anyOf: [taxSoftware, { type: 'null' }] },
      tax_id: nullable('string'),
      activity_type: activityType,
      default_source_account_id: nullable('integer'),
      is_active: { type: 'boolean' },
      created_at: dateTime,
      updated_at: dateTime,
    },
  },
  ClientCreate: {
    type: 'object',
    required: ['name', 'entityType'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      clientCode: nullable('string', { maxLength: 50 }),
      entityType,
      taxYearEnd: { type: 'string', maxLength: 4, description: 'MMDD; default 1231' },
      defaultTaxSoftware: taxSoftware,
      taxId: nullable('string', { maxLength: 20 }),
      activityType,
      defaultSourceAccountId: nullable('integer', { minimum: 1 }),
    },
  },
  ClientUpdate: {
    type: 'object',
    additionalProperties: false,
    description: 'Any subset of ClientCreate.',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      clientCode: nullable('string', { maxLength: 50 }),
      entityType,
      taxYearEnd: { type: 'string', maxLength: 4 },
      defaultTaxSoftware: taxSoftware,
      taxId: nullable('string', { maxLength: 20 }),
      activityType,
      defaultSourceAccountId: nullable('integer', { minimum: 1 }),
    },
  },
  Period: {
    type: 'object',
    required: ['id', 'client_id', 'period_name', 'is_current', 'created_at'],
    properties: {
      id: { type: 'integer' },
      client_id: { type: 'integer' },
      period_name: { type: 'string' },
      start_date: { anyOf: [dateTime, { type: 'null' }], description: 'DATE column, serialized as UTC midnight' },
      end_date: { anyOf: [dateTime, { type: 'null' }], description: 'DATE column, serialized as UTC midnight' },
      is_current: { type: 'boolean' },
      rolled_forward_from: nullable('integer'),
      locked_at: { anyOf: [dateTime, { type: 'null' }] },
      locked_by: nullable('integer'),
      folder_year: nullable('string'),
      created_at: dateTime,
    },
  },
  PeriodCreate: {
    type: 'object',
    required: ['periodName'],
    additionalProperties: false,
    properties: {
      periodName: { type: 'string', minLength: 1, maxLength: 100 },
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      isCurrent: { type: 'boolean' },
      folderYear: nullable('string', { maxLength: 20 }),
    },
  },
  PeriodUpdate: {
    type: 'object',
    additionalProperties: false,
    description: 'Any subset of PeriodCreate.',
    properties: {
      periodName: { type: 'string', minLength: 1, maxLength: 100 },
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      isCurrent: { type: 'boolean' },
      folderYear: nullable('string', { maxLength: 20 }),
    },
  },
  TrialBalanceRow: {
    type: 'object',
    description: 'One account on the adjusted trial balance (view v_adjusted_trial_balance). Each stage is a debit/credit pair in cents.',
    required: [
      'period_id', 'account_id', 'account_number', 'account_name', 'category', 'normal_balance', 'is_active',
      'unadjusted_debit', 'unadjusted_credit', 'prior_year_debit', 'prior_year_credit',
      'trans_adj_debit', 'trans_adj_credit', 'post_trans_debit', 'post_trans_credit',
      'book_adj_debit', 'book_adj_credit', 'tax_adj_debit', 'tax_adj_credit',
      'book_adjusted_debit', 'book_adjusted_credit', 'tax_adjusted_debit', 'tax_adjusted_credit',
    ],
    properties: {
      period_id: { type: 'integer' },
      account_id: { type: 'integer' },
      account_number: { type: 'string' },
      account_name: { type: 'string' },
      category: { type: 'string', enum: ['assets', 'liabilities', 'equity', 'revenue', 'expenses'] },
      normal_balance: { type: 'string', enum: ['debit', 'credit'] },
      tax_line: nullable('string'),
      workpaper_ref: nullable('string'),
      unit: nullable('string'),
      is_active: { type: 'boolean' },
      preparer_notes: nullable('string'),
      reviewer_notes: nullable('string'),
      lead_sheet_id: nullable('integer'),
      lead_sheet_code: nullable('string'),
      lead_sheet_name: nullable('string'),
      lead_sheet_sort: nullable('integer'),
      row_updated_at: { anyOf: [dateTime, { type: 'null' }] },
      unadjusted_debit: cents('Unadjusted debit'),
      unadjusted_credit: cents('Unadjusted credit'),
      prior_year_debit: cents('Prior-year debit'),
      prior_year_credit: cents('Prior-year credit'),
      trans_adj_debit: cents('Transaction adjustments debit'),
      trans_adj_credit: cents('Transaction adjustments credit'),
      post_trans_debit: cents('After transaction adjustments, debit'),
      post_trans_credit: cents('After transaction adjustments, credit'),
      book_adj_debit: cents('Book AJE debit'),
      book_adj_credit: cents('Book AJE credit'),
      tax_adj_debit: cents('Tax AJE debit'),
      tax_adj_credit: cents('Tax AJE credit'),
      book_adjusted_debit: cents('Book adjusted debit'),
      book_adjusted_credit: cents('Book adjusted credit'),
      tax_adjusted_debit: cents('Tax basis debit'),
      tax_adjusted_credit: cents('Tax basis credit'),
    },
  },
  FullBackupRequest: {
    type: 'object',
    required: ['fileName'],
    additionalProperties: false,
    properties: { fileName: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\\.tbak$' } },
  },
  FullBackup: {
    type: 'object',
    required: ['path', 'fileName', 'size', 'sha256', 'schemaVersion', 'recordCounts', 'clientCount', 'fileCount'],
    properties: {
      path: { type: 'string', description: 'Absolute path inside BACKUPS_DIR' },
      fileName: { type: 'string' },
      size: { type: 'integer' },
      sha256: { type: 'string', description: 'SHA-256 of the whole file, hex' },
      schemaVersion: nullable('string'),
      recordCounts: { type: 'object', additionalProperties: { type: 'integer' } },
      clientCount: { type: 'integer' },
      fileCount: { type: 'integer', description: 'Document files included' },
    },
  },
  BackupRecord: {
    type: 'object',
    required: ['id', 'backup_level', 'filename', 'checksum', 'storage_local'],
    properties: {
      id: { type: 'integer' },
      backup_type: { type: 'string' },
      backup_level: { type: 'string', enum: ['full', 'settings', 'client', 'period'] },
      client_id: nullable('integer'),
      client_name: nullable('string'),
      period_id: nullable('integer'),
      period_name: nullable('string'),
      filename: { type: 'string' },
      file_size: nullable('integer'),
      checksum: nullable('string', { description: 'sha256:<hex> of the whole file' }),
      storage_local: nullable('string', { description: 'Absolute path inside BACKUPS_DIR' }),
      trigger_type: { type: 'string' },
      status: { type: 'string' },
      created_at: dateTime,
    },
  },
  RestoreUpload: {
    type: 'object',
    required: ['tempFile', 'uploadNonce', 'manifest'],
    properties: {
      tempFile: { type: 'string' },
      uploadNonce: { type: 'string' },
      manifest: { type: 'object', description: 'The archive manifest (format 1 or 2, lib/backupManifest.ts)' },
    },
  },
  RestoreRequest: {
    type: 'object',
    required: ['tempFile', 'uploadNonce', 'mode'],
    properties: {
      tempFile: { type: 'string' },
      uploadNonce: { type: 'string' },
      mode: { type: 'string', enum: ['as_new', 'replace'] },
      targetClientId: { type: 'integer' },
    },
  },
  RestoreResult: {
    type: 'object',
    required: ['success', 'mode', 'newClientId'],
    properties: {
      success: { type: 'boolean' },
      mode: { type: 'string' },
      newClientId: nullable('integer'),
      droppedLinks: { type: 'integer' },
      filesPlaced: { type: 'integer' },
      filesNotPlaced: { type: 'integer' },
      idMappings: {
        type: 'object',
        description: 'Per table, archive id -> restored id',
        additionalProperties: { type: 'object', additionalProperties: { type: 'integer' } },
      },
    },
  },
  ExtractClientRequest: {
    type: 'object',
    required: ['fileName', 'clientId', 'outName'],
    properties: {
      fileName: { type: 'string', description: 'A desktop full backup in BACKUPS_DIR' },
      clientId: { type: 'integer', description: 'The client id inside that backup' },
      outName: { type: 'string', description: 'The client .tbak to write in BACKUPS_DIR' },
    },
  },
  ExtractedClient: {
    type: 'object',
    required: ['path', 'fileName', 'size', 'sha256', 'fileCount', 'missingFiles'],
    properties: {
      path: { type: 'string' },
      fileName: { type: 'string' },
      size: { type: 'integer' },
      sha256: { type: 'string' },
      clientName: nullable('string'),
      fileCount: { type: 'integer' },
      missingFiles: { type: 'array', items: { type: 'integer' } },
    },
  },
  PlacedFiles: {
    type: 'object',
    required: ['filesPlaced', 'filesNotPlaced'],
    properties: {
      filesPlaced: { type: 'integer' },
      filesNotPlaced: { type: 'integer' },
    },
  },
  TbTotals: {
    type: 'object',
    description: 'Column totals of GET /periods/{periodId}/trial-balance, summed by PostgreSQL over the same rows.',
    required: ['period_id', 'account_count', 'stages', 'unadjusted_in_balance', 'book_in_balance', 'tax_in_balance'],
    properties: {
      period_id: { type: 'integer' },
      account_count: { type: 'integer', minimum: 0 },
      stages: {
        type: 'object',
        required: ['unadjusted', 'trans_adj', 'book_adj', 'tax_adj', 'book_adjusted', 'tax_adjusted', 'prior_year'],
        additionalProperties: false,
        properties: Object.fromEntries(
          ['unadjusted', 'trans_adj', 'book_adj', 'tax_adj', 'book_adjusted', 'tax_adjusted', 'prior_year'].map((s) => [
            s,
            { type: 'object', required: ['debit', 'credit'], properties: { debit: cents('Total debits'), credit: cents('Total credits') } },
          ]),
        ),
      },
      unadjusted_in_balance: { type: 'boolean' },
      book_in_balance: { type: 'boolean' },
      tax_in_balance: { type: 'boolean' },
    },
  },
  ClientSummary: {
    type: 'object',
    description: 'One period of an active client, as the Clients screen shows it (Q16).',
    required: ['client_id', 'period_id', 'status', 'account_count', 'book_net', 'tax_net', 'book_in_balance', 'tax_in_balance', 'aje_count', 'last_worked'],
    properties: {
      client_id: { type: 'integer' },
      period_id: { type: 'integer' },
      status: { type: 'string', enum: ['not_started', 'in_progress', 'ready_for_review'] },
      account_count: { type: 'integer', minimum: 0 },
      book_net: cents('Book adjusted debits less credits'),
      tax_net: cents('Tax basis debits less credits'),
      book_in_balance: { type: 'boolean' },
      tax_in_balance: { type: 'boolean' },
      aje_count: { type: 'integer', minimum: 0, description: 'Book and tax adjusting entries' },
      last_worked: { anyOf: [dateTime, { type: 'null' }], description: 'Newest change to the trial balance, an entry or a task' },
    },
  },
  TbCellSave: {
    type: 'object',
    required: ['unadjustedDebit', 'unadjustedCredit'],
    additionalProperties: false,
    properties: {
      unadjustedDebit: { type: 'integer', minimum: 0, description: 'cents' },
      unadjustedCredit: { type: 'integer', minimum: 0, description: 'cents' },
      expectedUpdatedAt: { ...dateTime, description: 'row_updated_at as read; 409 STALE_WRITE when the row changed since' },
    },
  },
  TbCellSaved: {
    type: 'object',
    required: ['periodId', 'accountId', 'unadjustedDebit', 'unadjustedCredit', 'updatedAt'],
    properties: {
      periodId: { type: 'integer' },
      accountId: { type: 'integer' },
      unadjustedDebit: cents('Unadjusted debit'),
      unadjustedCredit: cents('Unadjusted credit'),
      updatedAt: dateTime,
    },
  },
  JournalEntryLine: {
    type: 'object',
    required: ['id', 'journal_entry_id', 'account_id', 'debit', 'credit', 'account_number', 'account_name'],
    properties: {
      id: { type: 'integer' },
      journal_entry_id: { type: 'integer' },
      account_id: { type: 'integer' },
      debit: cents('Debit'),
      credit: cents('Credit'),
      account_number: { type: 'string' },
      account_name: { type: 'string' },
    },
  },
  JournalEntry: {
    type: 'object',
    required: ['id', 'period_id', 'entry_number', 'entry_type', 'entry_date', 'lines'],
    properties: {
      id: { type: 'integer' },
      period_id: { type: 'integer' },
      entry_number: { type: 'integer' },
      entry_type: { type: 'string', enum: ['book', 'tax', 'trans'] },
      entry_date: dateTime,
      description: nullable('string'),
      workpaper_ref: nullable('string'),
      is_recurring: { type: 'boolean' },
      source_tag: nullable('string'),
      created_at: dateTime,
      updated_at: dateTime,
      lines: { type: 'array', items: ref('JournalEntryLine') },
    },
  },
  VarianceNote: {
    type: 'object',
    required: ['id', 'account_id', 'period_id', 'compare_period_id', 'note'],
    properties: {
      id: { type: 'integer' },
      account_id: { type: 'integer' },
      period_id: { type: 'integer' },
      compare_period_id: { type: 'integer' },
      note: { type: 'string' },
      created_by: nullable('integer'),
      created_at: dateTime,
    },
  },
  VarianceNoteSave: {
    type: 'object',
    required: ['note'],
    additionalProperties: false,
    properties: { note: { type: 'string', maxLength: 2000, description: 'Empty deletes the note' } },
  },
  CsvColumns: {
    type: 'object',
    required: ['accountNumber', 'accountName', 'debit', 'credit', 'amount'],
    properties: Object.fromEntries(
      ['accountNumber', 'accountName', 'debit', 'credit', 'amount', 'pnl', 'qboAccountName', 'qboAccountId'].map((k) => [k, nullable('integer', { minimum: 0 })]),
    ),
  },
  CsvColumnMapping: {
    type: 'object',
    description: 'A mapping the user chose (lib/csvColumnMapping.ts); replaces the guess.',
    required: ['delimiter', 'hasHeaders', 'headerRow', 'dataStartRow', 'amountFormat', 'columns'],
    additionalProperties: false,
    properties: {
      delimiter: { type: 'string', enum: [',', ';', '\t', '|'] },
      hasHeaders: { type: 'boolean' },
      headerRow: { type: 'integer', minimum: 0 },
      dataStartRow: { type: 'integer', minimum: 0 },
      amountFormat: { type: 'string', enum: ['separate_dr_cr', 'single_signed', 'single_parentheses'] },
      columns: {
        type: 'object',
        required: ['accountNumber', 'accountName', 'debit', 'credit', 'amount'],
        additionalProperties: false,
        properties: Object.fromEntries(['accountNumber', 'accountName', 'debit', 'credit', 'amount'].map((k) => [k, nullable('integer', { minimum: 0 })])),
      },
      rowsToSkip: { type: 'array', items: { type: 'integer', minimum: 0 } },
    },
  },
  CsvMatchRow: {
    type: 'object',
    required: ['csvRow', 'csvAccountNumber', 'csvAccountName', 'matchedAccountId', 'matchType', 'action', 'debitCents', 'creditCents', 'confidence'],
    properties: {
      csvRow: { type: 'integer', description: 'Line index in the file, from 0' },
      csvAccountNumber: nullable('string'),
      csvAccountName: nullable('string'),
      csvDebit: nullable('string'),
      csvCredit: nullable('string'),
      matchedAccountId: nullable('integer'),
      matchedAccountNumber: nullable('string'),
      matchedAccountName: nullable('string'),
      confidence: { type: 'number' },
      matchType: { type: 'string', enum: ['exact', 'qbo_id', 'exact_name', 'fuzzy', 'alias', 'none'] },
      action: { type: 'string', enum: ['match', 'create_new', 'skip'] },
      debitCents: cents('Debit'),
      creditCents: cents('Credit'),
      newCategory: { type: 'string', enum: ['assets', 'liabilities', 'equity', 'revenue', 'expenses'] },
      newNormalBalance: { type: 'string', enum: ['debit', 'credit'] },
      pnl: {},
      qboAccountId: nullable('string'),
      qboAccountName: nullable('string'),
    },
  },
  CsvAnalysis: {
    type: 'object',
    required: ['delimiter', 'hasHeaders', 'headerRow', 'dataStartRow', 'amountFormat', 'columns', 'rowsToSkip', 'matches', 'fallbackMode', 'totalRows'],
    properties: {
      delimiter: { type: 'string' },
      hasHeaders: { type: 'boolean' },
      headerRow: { type: 'integer' },
      dataStartRow: { type: 'integer' },
      amountFormat: { type: 'string', enum: ['separate_dr_cr', 'single_signed', 'single_parentheses'] },
      columns: ref('CsvColumns'),
      rowsToSkip: { type: 'array', items: { type: 'integer' } },
      matches: { type: 'array', items: ref('CsvMatchRow') },
      detectedFormat: nullable('string'),
      fallbackMode: { type: 'boolean', description: 'The columns were guessed without AI' },
      totalRows: { type: 'integer' },
      rawPreview: {},
    },
  },
  CsvConfirmRequest: {
    type: 'object',
    required: ['periodId', 'clientId', 'matches'],
    properties: {
      periodId: { type: 'integer' },
      clientId: { type: 'integer' },
      matches: { type: 'array', items: ref('CsvMatchRow') },
      aiExtraction: {},
    },
  },
  CsvConfirmResult: {
    type: 'object',
    required: ['accountsMatched', 'accountsCreated', 'rowsImported', 'rowsSkipped'],
    properties: {
      accountsMatched: { type: 'integer' },
      accountsCreated: { type: 'integer' },
      rowsImported: { type: 'integer' },
      rowsSkipped: { type: 'integer' },
      qboIdsLinked: { type: 'integer' },
      accountsWithoutTaxCodes: { type: 'integer' },
      total: { type: 'integer' },
      qboWarnings: { type: 'array', items: { type: 'string' } },
    },
  },
};

const json = 'application/json';

export function buildOpenApiSpec(): Schema {
  return {
    openapi: '3.1.0',
    info: {
      title: 'ClientLedger Trial Balance engine',
      version: pkg.version,
      description: 'Desktop-mode API of the Vibe Trial Balance engine. Every response uses the { data, error, meta } envelope. Amounts are integer cents.',
      license: { name: 'PolyForm Small Business License 1.0.0', url: 'https://polyformproject.org/licenses/small-business/1.0.0' },
    },
    servers: [{ url: 'http://127.0.0.1:{port}', variables: { port: { default: '3001' } } }],
    security: [{ desktopSession: [] }],
    components: {
      securitySchemes: {
        desktopSession: { type: 'apiKey', in: 'header', name: 'X-CLTB-Session', description: 'Per-launch token from the launcher' },
      },
      schemas,
    },
    paths: {
      '/api/v1/ping': {
        get: {
          operationId: 'ping', tags: ['system'], security: [],
          summary: 'Liveness probe (no database)',
          responses: { '200': ok('Process is up', ref('Ping')) },
        },
      },
      '/api/v1/health': {
        get: {
          operationId: 'health', tags: ['system'], security: [],
          summary: 'Readiness probe (database)',
          responses: {
            '200': ok('Ready', ref('Health')),
            '503': { description: 'A dependency is down', content: { [json]: { schema: envelope(ref('Health')) } } },
          },
        },
      },
      '/api/v1/openapi.json': {
        get: {
          operationId: 'openapi', tags: ['system'],
          summary: 'This document',
          responses: { '200': { description: 'OpenAPI document', content: { [json]: { schema: { type: 'object' } } } }, ...commonErrors },
        },
      },
      '/api/v1/clients': {
        get: {
          operationId: 'listClients', tags: ['clients'],
          summary: 'Active clients, by name',
          responses: { '200': ok('Clients', { type: 'array', items: ref('Client') }, true), ...commonErrors },
        },
        post: {
          operationId: 'createClient', tags: ['clients'],
          requestBody: jsonBody(ref('ClientCreate')),
          responses: { '201': ok('Created', ref('Client')), '400': errorResponse('Validation error'), ...commonErrors },
        },
      },
      '/api/v1/clients/{id}': {
        parameters: [idParam('id', 'Client id')],
        get: {
          operationId: 'getClient', tags: ['clients'],
          responses: { '200': ok('Client', ref('Client')), '400': errorResponse('Invalid id'), '404': errorResponse('Not found'), ...commonErrors },
        },
        patch: {
          operationId: 'updateClient', tags: ['clients'],
          requestBody: jsonBody(ref('ClientUpdate')),
          responses: { '200': ok('Updated', ref('Client')), '400': errorResponse('Validation error'), '404': errorResponse('Not found'), ...commonErrors },
        },
      },
      '/api/v1/clients/{clientId}/periods': {
        parameters: [idParam('clientId', 'Client id')],
        get: {
          operationId: 'listPeriods', tags: ['periods'],
          responses: { '200': ok('Periods', { type: 'array', items: ref('Period') }, true), ...commonErrors },
        },
        post: {
          operationId: 'createPeriod', tags: ['periods'],
          requestBody: jsonBody(ref('PeriodCreate')),
          responses: { '201': ok('Created', ref('Period')), '400': errorResponse('Validation error'), ...commonErrors },
        },
      },
      '/api/v1/periods/{id}': {
        parameters: [idParam('id', 'Period id')],
        patch: {
          operationId: 'updatePeriod', tags: ['periods'],
          requestBody: jsonBody(ref('PeriodUpdate')),
          responses: { '200': ok('Updated', ref('Period')), '400': errorResponse('Validation error'), '404': errorResponse('Not found'), ...commonErrors },
        },
      },
      '/api/v1/periods/{periodId}/trial-balance': {
        parameters: [idParam('periodId', 'Period id')],
        get: {
          operationId: 'getTrialBalance', tags: ['trial-balance'],
          summary: 'Adjusted trial balance, active accounts, by account number',
          responses: { '200': ok('Rows', { type: 'array', items: ref('TrialBalanceRow') }, true), '400': errorResponse('Invalid id'), ...commonErrors },
        },
      },
      '/api/v1/desktop/backup/full': {
        post: {
          operationId: 'writeFullBackup', tags: ['backup'],
          summary: 'Write a desktop full backup (every table and every document) into BACKUPS_DIR',
          requestBody: jsonBody(ref('FullBackupRequest')),
          responses: { '200': ok('Written', ref('FullBackup')), '400': errorResponse('Bad file name'), ...commonErrors },
        },
      },
      '/api/v1/backup/client/{clientId}': {
        parameters: [
          idParam('clientId', 'Client id'),
          { name: 'includeFiles', in: 'query', required: false, schema: { type: 'string', enum: ['1', 'true'] }, description: 'Carry document bytes under files/' },
        ],
        post: {
          operationId: 'backupClient', tags: ['backup'],
          summary: 'Write a client .tbak (appliance-compatible) into BACKUPS_DIR',
          responses: { '200': ok('Written', ref('BackupRecord')), '400': errorResponse('Invalid id'), ...commonErrors },
        },
      },
      '/api/v1/restore/upload': {
        post: {
          operationId: 'stageRestore', tags: ['backup'],
          summary: 'Stage a .tbak for restore; checks its entries and schema',
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } },
          responses: { '200': ok('Staged', ref('RestoreUpload')), '400': errorResponse('Damaged, too new or not a backup'), ...commonErrors },
        },
      },
      '/api/v1/restore/execute': {
        post: {
          operationId: 'executeRestore', tags: ['backup'],
          summary: 'Restore a staged client .tbak as a new client or over one',
          requestBody: jsonBody(ref('RestoreRequest')),
          responses: { '200': ok('Restored', ref('RestoreResult')), '400': errorResponse('Damaged or invalid'), '403': errorResponse('Not this session'), ...commonErrors },
        },
      },
      '/api/v1/desktop/backup/extract-client': {
        post: {
          operationId: 'extractClient', tags: ['backup'],
          summary: 'Write one client of a desktop full backup as a client .tbak in BACKUPS_DIR (Q30)',
          requestBody: jsonBody(ref('ExtractClientRequest')),
          responses: { '200': ok('Written', ref('ExtractedClient')), '400': errorResponse('Not a full backup, damaged, or bad names'), '404': errorResponse('Backup or client not found'), ...commonErrors },
        },
      },
      '/api/v1/desktop/restore/client-files': {
        post: {
          operationId: 'placeClientFiles', tags: ['backup'],
          summary: 'After a client restore as new, write the archive document files into the new client folder (Q31)',
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'newClientId', 'documentIds'], properties: { file: { type: 'string', format: 'binary' }, newClientId: { type: 'integer' }, documentIds: { type: 'string', description: 'JSON: idMappings.client_documents from the restore' } } } } } },
          responses: { '200': ok('Placed', ref('PlacedFiles')), '400': errorResponse('Damaged, not a client backup, or invalid'), '404': errorResponse('Client not found'), ...commonErrors },
        },
      },
      '/api/v1/desktop/periods/{periodId}/trial-balance/totals': {
        parameters: [idParam('periodId', 'Period id')],
        get: {
          operationId: 'getTrialBalanceTotals', tags: ['trial-balance'],
          summary: 'Column totals of the trial balance, summed by the database (the grid checks its own against these)',
          responses: { '200': ok('Totals', ref('TbTotals')), '400': errorResponse('Invalid id'), '404': errorResponse('Period not found'), ...commonErrors },
        },
      },
      '/api/v1/desktop/clients/summary': {
        get: {
          operationId: 'getClientsSummary', tags: ['clients'],
          summary: 'Status, balance state, AJE count and last worked for every period of every active client',
          responses: { '200': ok('Summaries', { type: 'array', items: ref('ClientSummary') }, true), ...commonErrors },
        },
      },
      '/api/v1/periods/{periodId}/trial-balance/{accountId}': {
        parameters: [idParam('periodId', 'Period id'), idParam('accountId', 'Account id')],
        put: {
          operationId: 'saveTrialBalanceCell', tags: ['trial-balance'],
          summary: 'Save the unadjusted debit and credit of one account (both sides, cents)',
          requestBody: jsonBody(ref('TbCellSave')),
          responses: {
            '200': ok('Saved', ref('TbCellSaved')),
            '400': errorResponse('Validation error'),
            '409': errorResponse('PERIOD_LOCKED, or STALE_WRITE when the row changed since it was read'),
            ...commonErrors,
          },
        },
      },
      '/api/v1/periods/{periodId}/journal-entries': {
        parameters: [
          idParam('periodId', 'Period id'),
          { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['book', 'tax', 'trans'] } },
          { name: 'accountId', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'Only entries with a line on this account (every line of each entry is returned)' },
        ],
        get: {
          operationId: 'listJournalEntries', tags: ['journal-entries'],
          summary: 'Adjusting entries of a period, by type then number, with their lines',
          responses: { '200': ok('Entries', { type: 'array', items: ref('JournalEntry') }, true), '400': errorResponse('Invalid id'), ...commonErrors },
        },
      },
      '/api/v1/periods/{periodId}/variance-notes': {
        parameters: [idParam('periodId', 'Period id')],
        get: {
          operationId: 'listVarianceNotes', tags: ['variance-notes'],
          summary: 'Variance notes of a period, for every comparison period',
          responses: { '200': ok('Notes', { type: 'array', items: ref('VarianceNote') }), '400': errorResponse('Invalid id'), ...commonErrors },
        },
      },
      '/api/v1/periods/{periodId}/compare/{comparePeriodId}/variance-notes/{accountId}': {
        parameters: [idParam('periodId', 'Period id'), idParam('comparePeriodId', 'Comparison (prior-year) period id'), idParam('accountId', 'Account id')],
        put: {
          operationId: 'saveVarianceNote', tags: ['variance-notes'],
          summary: 'Save, or with an empty note delete, the variance note of an account against a comparison period',
          requestBody: jsonBody(ref('VarianceNoteSave')),
          responses: {
            '200': ok('Saved, or deleted', { anyOf: [ref('VarianceNote'), { type: 'object', required: ['deleted'], properties: { deleted: { const: true } } }] }),
            '400': errorResponse('Validation error'),
            '409': errorResponse('PERIOD_LOCKED'),
            ...commonErrors,
          },
        },
      },
      '/api/v1/import/csv/analyze': {
        post: {
          operationId: 'analyzeCsvImport', tags: ['import'],
          summary: 'Read a trial balance CSV or Excel file: the column mapping (guessed, or columnMapping) and every row matched to an account',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'periodId', 'clientId'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    periodId: { type: 'integer' },
                    clientId: { type: 'integer' },
                    columnMapping: { type: 'string', description: 'JSON CsvColumnMapping; replaces the guess' },
                  },
                },
              },
            },
          },
          responses: {
            '200': ok('Analysis', ref('CsvAnalysis')),
            '400': errorResponse('NO_FILE, INVALID_PARAMS or INVALID_COLUMN_MAPPING'),
            ...commonErrors,
          },
        },
      },
      '/api/v1/import/csv/confirm': {
        post: {
          operationId: 'confirmCsvImport', tags: ['import'],
          summary: 'Write the reviewed rows as unadjusted balances (create_new rows add accounts)',
          requestBody: jsonBody(ref('CsvConfirmRequest')),
          responses: {
            '200': ok('Imported', ref('CsvConfirmResult')),
            '400': errorResponse('Missing fields'),
            '404': errorResponse('Period not found for this client'),
            '409': errorResponse('PERIOD_LOCKED'),
            '422': errorResponse('INVALID_ACCOUNT_ID or DUPLICATE_ACCOUNT_NUMBER'),
            ...commonErrors,
          },
        },
      },
    },
  };
}

export const desktopRouter = Router();
desktopRouter.use(desktopBackupRouter);
desktopRouter.use(desktopTbRouter);
desktopRouter.use(desktopClientSummaryRouter);
desktopRouter.get('/openapi.json', (_req, res) => {
  res.json(buildOpenApiSpec());
});
