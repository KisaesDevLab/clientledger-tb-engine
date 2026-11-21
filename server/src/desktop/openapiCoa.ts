// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// OpenAPI for P13: chart of accounts templates (Tools › Chart of accounts
// templates…, and "Start from a template" on New client). The routes are
// upstream's (routes/coaTemplates.ts), unchanged; shapes are as recorded from
// a desktop engine (cltb-api/tests/record_p13.rs). Response objects are open:
// upstream may add columns, the desktop reads the fields listed as required.
//
// What the routes do, as recorded:
// - the system templates (one per industry) carry no tax codes and no units;
//   a template saved from a client carries the client's tax_line text;
// - apply writes tax_line only, never tax_code_id: the desktop gives the
//   added accounts their tax codes afterwards (tax-lines/bulk-confirm);
// - the import's confirm does not check the category and leaves out rows it
//   cannot use without saying so: the desktop sends only the preview's good rows;
// - an import's blank text fields come back "" (subcategory, workpaper_ref).

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const int: Schema = { type: 'integer' };
const str: Schema = { type: 'string' };
const bool: Schema = { type: 'boolean' };
const nstr: Schema = { type: ['string', 'null'] };
const nint: Schema = { type: ['integer', 'null'] };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const open = (required: string[], properties: Schema, description?: string): Schema => ({
  type: 'object', required, properties, ...(description ? { description } : {}),
});
const json = 'application/json';
const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function envelope(data: Schema, withMeta = false): Schema {
  const properties: Schema = { data, error: { type: 'null' } };
  if (withMeta) properties.meta = ref('ListMeta');
  return { type: 'object', required: ['data', 'error'], properties };
}
const ok = (description: string, data: Schema, withMeta = false): Schema => ({
  description, content: { [json]: { schema: envelope(data, withMeta) } },
});
const err = (description: string): Schema => ({
  description, content: { [json]: { schema: ref('ErrorEnvelope') } },
});
const common: Schema = { '401': err('Missing or wrong desktop session token'), '500': err('Server error') };
const idParam = (name: string, description: string): Schema => ({
  name, in: 'path', required: true, description, schema: { type: 'integer', minimum: 1 },
});
const jsonBody = (schema: Schema): Schema => ({ required: true, content: { [json]: { schema } } });
const tags = ['coa-templates'];

const category: Schema = { type: 'string', enum: ['assets', 'liabilities', 'equity', 'revenue', 'expenses'] };
const normalBalance: Schema = { type: 'string', enum: ['debit', 'credit'] };

export const coaSchemas: Record<string, Schema> = {
  CoaTemplate: open(['id', 'name', 'business_type', 'is_system', 'is_active', 'account_count'], {
    id: int,
    name: str,
    description: nstr,
    business_type: { type: 'string', description: "The industry (a system template's own slug) or custom" },
    is_system: { type: 'boolean', description: 'Shipped with the program: read only, never deleted' },
    is_active: bool,
    account_count: int,
    created_by: nint,
    created_from_client_id: { type: ['integer', 'null'], description: 'The client whose chart it was saved from' },
    created_at: dateTime,
    updated_at: dateTime,
  }, 'A chart of accounts template: a system one (one per industry) or the firm\'s own.'),
  CoaTemplateAccount: open(['id', 'template_id', 'account_number', 'account_name', 'category', 'normal_balance'], {
    id: int,
    template_id: int,
    account_number: str,
    account_name: str,
    category: { type: 'string', description: 'assets, liabilities, equity, revenue or expenses (an import can store other words)' },
    subcategory: { type: ['string', 'null'], description: 'The parent account\'s name; "" after an import' },
    normal_balance: normalBalance,
    tax_line: { type: ['string', 'null'], description: 'The tax code text (tax_codes.tax_code); none on the system templates' },
    unit: nstr,
    workpaper_ref: nstr,
    sort_order: nint,
    is_active: bool,
  }),
  CoaTemplateWithAccounts: {
    allOf: [ref('CoaTemplate'), open(['accounts'], { accounts: { type: 'array', items: ref('CoaTemplateAccount') } })],
  },
  CoaTemplateInput: open([], {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    description: str,
    businessType: { type: 'string', maxLength: 50 },
    isActive: bool,
  }, 'A new template needs a name; a change sends only what changes.'),
  CoaTemplateAccountInput: open([], {
    accountNumber: { type: 'string', minLength: 1, maxLength: 20 },
    accountName: { type: 'string', minLength: 1, maxLength: 255 },
    category,
    subcategory: { type: 'string', maxLength: 50 },
    normalBalance,
    taxLine: { type: ['string', 'null'], maxLength: 50 },
    unit: { type: ['string', 'null'], maxLength: 100 },
    workpaperRef: { type: 'string', maxLength: 50 },
    sortOrder: int,
    isActive: bool,
  }, 'A new account needs number, name, category and normal balance; a change sends only what changes. A number already in the template is refused (409 on add, a server error on change).'),
  CoaTemplateFromClient: open(['name'], {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    description: str,
    businessType: { type: 'string', maxLength: 50 },
  }),
  CoaTemplateApply: open(['mode'], {
    mode: { type: 'string', enum: ['merge', 'replace'], description: 'merge adds the accounts the client does not have (by number); replace deletes the chart first (refused while the client has trial balance rows). The desktop sends merge only.' },
  }),
  CoaTemplateApplied: open(['added', 'skipped', 'total'], {
    added: { type: 'integer', description: 'Accounts added to the client' },
    skipped: { type: 'integer', description: 'Accounts the client already had (same number, active or not)' },
    total: { type: 'integer', description: "The template's active accounts" },
  }),
  CoaTemplateCsv: open(['csv'], {
    csv: { type: 'string', minLength: 1, description: 'A header row (account_number, account_name, category required; subcategory, normal_balance, tax_line, unit, workpaper_ref, sort_order optional) and rows, one per line' },
  }),
  CoaTemplateImportRow: open(['account_number', 'account_name', 'category', 'normal_balance', 'status'], {
    account_number: str,
    account_name: str,
    category: str,
    subcategory: str,
    normal_balance: { type: 'string', description: 'As in the file, or the category\'s usual side' },
    tax_line: str,
    unit: str,
    workpaper_ref: str,
    sort_order: int,
    status: { type: 'string', enum: ['new', 'error'] },
    error: { type: 'string', description: 'Why the row cannot be imported' },
  }),
  CoaTemplateImport: open(['csv'], {
    csv: { type: 'string', minLength: 1 },
    templateId: { type: 'integer', description: 'Add to this template of the firm\'s (accounts with the same number are changed)' },
    templateName: { type: 'string', minLength: 1, maxLength: 255, description: 'Or make a new template of this name' },
    description: str,
    businessType: { type: 'string', maxLength: 50 },
  }),
  CoaTemplateImported: open(['imported', 'templateId'], { imported: int, templateId: int }),
};

const templateParam = idParam('id', 'Template id');

export const coaPaths: Record<string, Schema> = {
  '/api/v1/coa-templates': {
    get: {
      operationId: 'listCoaTemplates', tags,
      summary: "The chart of accounts templates: the system ones (one per industry) first, then the firm's own, by name",
      responses: { '200': ok('The templates', { type: 'array', items: ref('CoaTemplate') }, true), ...common },
    },
    post: {
      operationId: 'createCoaTemplate', tags,
      summary: 'Make an empty template of the firm\'s',
      requestBody: jsonBody(ref('CoaTemplateInput')),
      responses: { '201': ok('Made', ref('CoaTemplate')), '400': err('VALIDATION_ERROR'), ...common },
    },
  },
  '/api/v1/coa-templates/{id}': {
    parameters: [templateParam],
    get: {
      operationId: 'getCoaTemplate', tags,
      summary: 'A template and its accounts, in order',
      responses: { '200': ok('The template', ref('CoaTemplateWithAccounts')), '400': err('INVALID_ID'), '404': err('NOT_FOUND'), ...common },
    },
    put: {
      operationId: 'updateCoaTemplate', tags,
      summary: "Rename a template of the firm's or change its description or industry",
      requestBody: jsonBody(ref('CoaTemplateInput')),
      responses: {
        '200': ok('Changed', ref('CoaTemplate')), '400': err('VALIDATION_ERROR'),
        '403': err('FORBIDDEN: a system template'), '404': err('NOT_FOUND'), ...common,
      },
    },
    delete: {
      operationId: 'deleteCoaTemplate', tags,
      summary: "Delete a template of the firm's and its accounts (clients' charts are copies and stay)",
      responses: {
        '200': ok('Deleted', open(['id'], { id: int })), '403': err('FORBIDDEN: a system template'),
        '404': err('NOT_FOUND'), ...common,
      },
    },
  },
  '/api/v1/coa-templates/{id}/accounts': {
    parameters: [templateParam],
    post: {
      operationId: 'addCoaTemplateAccount', tags,
      summary: 'Add an account to a template (the desktop adds to the firm\'s own only)',
      requestBody: jsonBody(ref('CoaTemplateAccountInput')),
      responses: {
        '201': ok('Added', ref('CoaTemplateAccount')), '400': err('VALIDATION_ERROR'),
        '404': err('NOT_FOUND'), '409': err('DUPLICATE: the number is already in the template'), ...common,
      },
    },
  },
  '/api/v1/coa-templates/accounts/{accountId}': {
    parameters: [idParam('accountId', 'Template account id')],
    put: {
      operationId: 'updateCoaTemplateAccount', tags,
      summary: "Change a template's account (only what is sent)",
      requestBody: jsonBody(ref('CoaTemplateAccountInput')),
      responses: { '200': ok('Changed', ref('CoaTemplateAccount')), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), ...common },
    },
    delete: {
      operationId: 'deleteCoaTemplateAccount', tags,
      summary: "Take an account out of a template",
      responses: { '200': ok('Taken out', open(['id'], { id: int })), '404': err('NOT_FOUND'), ...common },
    },
  },
  '/api/v1/coa-templates/from-client/{clientId}': {
    parameters: [idParam('clientId', 'Client id')],
    post: {
      operationId: 'saveChartAsCoaTemplate', tags,
      summary: "Save a client's active accounts (number, name, category, normal balance, tax code text, unit, W/P ref) as a new template of the firm's",
      requestBody: jsonBody(ref('CoaTemplateFromClient')),
      responses: { '201': ok('Saved', ref('CoaTemplate')), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND: no such client'), ...common },
    },
  },
  '/api/v1/coa-templates/{id}/apply/{clientId}': {
    parameters: [templateParam, idParam('clientId', 'Client id')],
    post: {
      operationId: 'applyCoaTemplate', tags,
      summary: "Give a client a template's accounts. Writes the tax code text only (not tax_code_id)",
      requestBody: jsonBody(ref('CoaTemplateApply')),
      responses: {
        '200': ok('What was added and skipped', ref('CoaTemplateApplied')),
        '400': err('VALIDATION_ERROR, or HAS_TB_DATA (replace while the client has balances)'),
        '404': err('NOT_FOUND: no such template or client'), ...common,
      },
    },
  },
  '/api/v1/coa-templates/{id}/export': {
    parameters: [templateParam],
    get: {
      operationId: 'exportCoaTemplate', tags,
      summary: "A template's accounts as an Excel workbook (one sheet, the import's column names as headings)",
      responses: {
        '200': { description: 'The workbook, named <template>_template.xlsx', content: { [xlsx]: { schema: { type: 'string', format: 'binary' } } } },
        '404': err('NOT_FOUND'), ...common,
      },
    },
  },
  '/api/v1/coa-templates/import/preview': {
    post: {
      operationId: 'previewCoaTemplateImport', tags,
      summary: 'Read a template CSV; nothing is written. Each row says whether it can be imported',
      requestBody: jsonBody(ref('CoaTemplateCsv')),
      responses: {
        '200': ok('The rows', { type: 'array', items: ref('CoaTemplateImportRow') }),
        '400': err('VALIDATION_ERROR, or INVALID_CSV (no rows, or a required column missing)'), ...common,
      },
    },
  },
  '/api/v1/coa-templates/import': {
    post: {
      operationId: 'importCoaTemplate', tags,
      summary: "Import a template CSV into a new template of the firm's (templateName) or one of its own (templateId)",
      requestBody: jsonBody(ref('CoaTemplateImport')),
      responses: {
        '200': ok('Imported', ref('CoaTemplateImported')),
        '400': err('VALIDATION_ERROR, or INVALID_CSV'), '403': err('FORBIDDEN: a system template'),
        '404': err('NOT_FOUND'), ...common,
      },
    },
  },
};
