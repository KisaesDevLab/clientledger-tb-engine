// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// OpenAPI for P09: the client's documents, the engagement checklist, lead
// sheets (rename, reorder, sign-off, notes, attachments) and the workpaper
// index and package. The routes are upstream's (routes/documents.ts,
// engagement.ts, leadSheets.ts, leadSheetAttachments.ts, pdfReports.ts) plus
// the desktop's own /desktop/me (me.ts, Q74). Response objects are open:
// upstream may add columns, the desktop reads the fields listed as required.

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: Schema = {}): Schema => ({ type: [type, 'null'], ...extra });
const int: Schema = { type: 'integer' };
const str: Schema = { type: 'string' };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const nullDateTime: Schema = { anyOf: [dateTime, { type: 'null' }] };
const centsText = (description: string): Schema => ({
  type: 'string', pattern: '^-?\\d+$', description: `${description} (cents, as decimal text)`,
});
const open = (required: string[], properties: Schema, description?: string): Schema => ({
  type: 'object', required, properties, ...(description ? { description } : {}),
});
const json = 'application/json';
const pdf = 'application/pdf';

function envelope(data: Schema, meta?: Schema): Schema {
  const properties: Schema = { data, error: { type: 'null' } };
  if (meta) properties.meta = meta;
  return { type: 'object', required: meta ? ['data', 'error', 'meta'] : ['data', 'error'], properties };
}
const ok = (description: string, data: Schema, meta?: Schema): Schema => ({
  description, content: { [json]: { schema: envelope(data, meta) } },
});
const err = (description: string): Schema => ({
  description, content: { [json]: { schema: ref('ErrorEnvelope') } },
});
const common: Schema = { '401': err('Missing or wrong desktop session token'), '500': err('Server error') };
const idParam = (name: string, description: string): Schema => ({
  name, in: 'path', required: true, description, schema: { type: 'integer', minimum: 1 },
});
const jsonBody = (schema: Schema): Schema => ({ required: true, content: { [json]: { schema } } });
const countMeta = (extra: Schema = {}, required: string[] = []): Schema =>
  open(['count', ...required], { count: { type: 'integer', minimum: 0 }, ...extra });
const pdfFile = (description: string): Schema => ({
  description,
  headers: {
    'X-Skipped-Attachments': {
      description: 'Ref codes of attachments that could not be read and were left out, comma separated',
      schema: str,
    },
  },
  content: { [pdf]: { schema: { type: 'string', format: 'binary' } } },
});
const multipart = (properties: Schema, description: string): Schema => ({
  required: true,
  description,
  content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, ...properties } } } },
});
const tags = (t: string): string[] => [t];

const signRole: Schema = { type: 'string', enum: ['preparer', 'reviewer'] };
const signStatus: Schema = { type: 'string', enum: ['signed', 'stale', 'unsigned'], description: 'stale: signed, but the balances moved since' };
const taskStatus: Schema = { type: 'string', enum: ['open', 'in_progress', 'review', 'completed', 'n_a'] };
const reportId: Schema = {
  type: 'string',
  enum: ['pdf-wp-index', 'pdf-lead-sheets', 'pdf-tb', 'pdf-is', 'pdf-bs', 'pdf-equity', 'pdf-je', 'pdf-aje',
    'pdf-gl', 'pdf-tax-code', 'pdf-tax-pl', 'pdf-tax-return', 'pdf-m1'],
};
const basis: Schema = { type: 'string', enum: ['unadjusted', 'book', 'tax'] };

const signoff = open(['id', 'lead_sheet_id', 'role', 'user_id', 'user_name', 'signed_at', 'balance_stamp'], {
  id: int, lead_sheet_id: int, period_id: int, role: signRole, user_id: int, user_name: str,
  signed_at: dateTime, balance_stamp: str, invalidated_at: nullDateTime, invalidated_by: nullable('integer'),
});
const signoffs = open([], { preparer: signoff, reviewer: signoff }, 'The live signature for each role, when there is one');
const statuses = open(['preparer', 'reviewer'], { preparer: signStatus, reviewer: signStatus });

export const wpSchemas: Record<string, Schema> = {
  DesktopMe: open(['id', 'username', 'displayName'], {
    id: int, username: str, displayName: nullable('string', { description: 'Shown on sign-offs, notes and completed tasks' }),
  }),
  Document: open(['id', 'client_id', 'filename', 'file_size', 'file_type', 'uploaded_at', 'section'], {
    id: int,
    client_id: int,
    filename: str,
    file_size: int,
    file_type: str,
    section: nullable('string', { description: 'The folder section (Workpapers & Support, …)' }),
    period_id: nullable('integer'),
    linked_account_id: nullable('integer'),
    linked_journal_entry_id: nullable('integer'),
    uploaded_by: nullable('integer'),
    uploaded_at: dateTime,
    storage_backend: nullable('string'),
    object_key: nullable('string'),
    account_number: nullable('string'),
    account_name: nullable('string'),
    je_entry_number: { type: ['integer', 'string', 'null'] },
    uploader_name: nullable('string'),
  }, 'A stored file of the client (the list adds the linked account and entry and the uploader)'),
  DocumentLink: open([], { linkedAccountId: nullable('integer'), linkedJournalEntryId: nullable('integer') }),
  EngagementTask: open(['id', 'period_id', 'title', 'status', 'sort_order'], {
    id: int,
    period_id: int,
    title: str,
    description: nullable('string'),
    category: nullable('string'),
    status: taskStatus,
    assignee_id: nullable('integer'),
    sort_order: int,
    notes: nullable('string'),
    completed_by: nullable('integer'),
    completed_at: nullDateTime,
    created_by: nullable('integer'),
    created_at: dateTime,
    updated_at: dateTime,
    assignee_name: nullable('string'),
    completed_by_name: nullable('string'),
  }),
  EngagementTaskInput: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      description: nullable('string'),
      category: nullable('string', { maxLength: 100 }),
      status: taskStatus,
      assigneeId: nullable('integer'),
      sortOrder: int,
      notes: nullable('string'),
    },
  },
  OpenTask: open(['id', 'title', 'status', 'period_id', 'period_name', 'end_date', 'client_id', 'client_name'], {
    id: int, title: str, category: nullable('string'), status: taskStatus, notes: nullable('string'),
    period_id: int, period_name: str, end_date: str, client_id: int, client_name: str,
    assignee_id: nullable('integer'), assignee_name: nullable('string'),
  }, 'A task not completed or n/a, of any client'),
  LeadSheetRow: open(['id', 'client_id', 'code', 'name', 'sort_order'], {
    id: int, client_id: int, code: nullable('string'), name: str, sort_order: int,
    created_at: dateTime, created_by: nullable('integer'), updated_at: dateTime,
  }),
  LeadSheetInput: {
    type: 'object',
    properties: {
      code: { type: ['string', 'null'], minLength: 1, maxLength: 10 },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      sortOrder: int,
    },
  },
  LeadSheetForPeriod: open(['id', 'client_id', 'code', 'name', 'sort_order', 'account_count', 'current_stamp', 'signoffs', 'status'], {
    id: int, client_id: int, code: nullable('string'), name: str, sort_order: int,
    account_count: int, current_stamp: str, signoffs, status: statuses,
  }, 'A lead sheet with its sign-off status for one period (?periodId=)'),
  UnassignedAccount: open(['id', 'account_number', 'account_name', 'category'], {
    id: int, account_number: str, account_name: str, category: str, subcategory: nullable('string'),
  }),
  LeadSheetNote: open(['id', 'lead_sheet_id', 'period_id', 'body', 'author_name', 'created_at', 'resolved_at'], {
    id: int, client_id: int, lead_sheet_id: int, period_id: int, account_id: nullable('integer'),
    body: str, author_id: nullable('integer'), author_name: nullable('string'),
    created_at: dateTime, updated_at: dateTime,
    resolved_at: nullDateTime, resolved_by: nullable('integer'), resolved_by_name: nullable('string'),
    account_number: nullable('string'), account_name: nullable('string'),
  }),
  LeadSheetAccountRow: open([
    'account_id', 'account_number', 'account_name', 'category', 'normal_balance', 'is_active',
    'unadjusted_debit', 'unadjusted_credit', 'prior_year_debit', 'prior_year_credit',
    'book_adj_debit', 'book_adj_credit', 'tax_adj_debit', 'tax_adj_credit',
    'book_adjusted_debit', 'book_adjusted_credit', 'tax_adjusted_debit', 'tax_adjusted_credit',
    'tickmarks', 'attachments', 'notes',
  ], {
    period_id: int, account_id: int, account_number: str, account_name: str,
    category: { type: 'string', enum: ['assets', 'liabilities', 'equity', 'revenue', 'expenses'] },
    normal_balance: { type: 'string', enum: ['debit', 'credit'] },
    is_active: { type: 'boolean' },
    tax_line: nullable('string'), workpaper_ref: nullable('string'), unit: nullable('string'),
    preparer_notes: nullable('string'), reviewer_notes: nullable('string'),
    lead_sheet_id: nullable('integer'), lead_sheet_code: nullable('string'),
    lead_sheet_name: nullable('string'), lead_sheet_sort: nullable('integer'),
    row_updated_at: nullDateTime,
    unadjusted_debit: centsText('Unadjusted debit'), unadjusted_credit: centsText('Unadjusted credit'),
    prior_year_debit: centsText('Prior-year debit'), prior_year_credit: centsText('Prior-year credit'),
    trans_adj_debit: centsText('Transaction adjustments debit'), trans_adj_credit: centsText('Transaction adjustments credit'),
    post_trans_debit: centsText('After transaction adjustments, debit'), post_trans_credit: centsText('After transaction adjustments, credit'),
    book_adj_debit: centsText('Book AJE debit'), book_adj_credit: centsText('Book AJE credit'),
    tax_adj_debit: centsText('Tax AJE debit'), tax_adj_credit: centsText('Tax AJE credit'),
    book_adjusted_debit: centsText('Book adjusted debit'), book_adjusted_credit: centsText('Book adjusted credit'),
    tax_adjusted_debit: centsText('Tax basis debit'), tax_adjusted_credit: centsText('Tax basis credit'),
    tickmarks: { type: 'array', items: { type: 'object' }, description: 'As /periods/{periodId}/tb-tickmarks' },
    attachments: { type: 'array', items: open(['id', 'refCode'], { id: int, refCode: str, marks: int }) },
    notes: { type: 'array', items: ref('LeadSheetNote') },
  }, 'One account of a lead sheet for the period: the trial balance row plus its marks, attachments and notes'),
  LeadSheetSchedule: open(['leadSheet', 'rows', 'accountCount', 'currentStamp', 'signoffs', 'status', 'notes', 'openNoteCount'], {
    leadSheet: ref('LeadSheetRow'),
    rows: { type: 'array', items: ref('LeadSheetAccountRow') },
    accountCount: int,
    currentStamp: { type: 'string', description: 'SHA-256 of the sheet\'s balances; a signature with another stamp is stale' },
    signoffs,
    status: statuses,
    notes: { type: 'array', items: ref('LeadSheetNote'), description: 'Every note of the sheet, the account notes too' },
    openNoteCount: int,
  }),
  LeadSheetSigned: open(['signoff', 'status', 'currentStamp'], { signoff, status: { const: 'signed' }, currentStamp: str }),
  LeadSheetAttachment: open(['id', 'period_id', 'ref_code', 'source_file_name', 'created_at'], {
    id: int,
    client_id: int,
    period_id: int,
    lead_sheet_id: nullable('integer'),
    lead_sheet_code: nullable('string'),
    account_id: nullable('integer'),
    ref_code: { type: 'string', description: 'The sheet code\'s letters and a number (A001), never reused' },
    document_id: nullable('integer'),
    source_file_name: str,
    annotations: { type: 'array', items: { type: 'object' } },
    created_at: dateTime,
    created_by: nullable('integer'),
    created_by_name: nullable('string'),
    file_size: nullable('integer'),
    fileSize: int,
    file_type: nullable('string'),
    deleted_at: nullDateTime,
    deleted_by: nullable('integer'),
  }),
  WorkpaperSave: {
    type: 'object',
    required: ['reports'],
    properties: {
      reports: { type: 'array', minItems: 1, items: reportId },
      includeAttachments: { type: 'boolean' },
      basis,
      groupByLeadSheet: { type: 'boolean' },
    },
  },
  WorkpaperSaved: open(['documentId', 'filename', 'sizeBytes', 'skippedAttachments'], {
    documentId: int, filename: str, objectKey: str, sizeBytes: int,
    skippedAttachments: { type: 'array', items: open(['refCode', 'reason'], { refCode: str, reason: str }) },
  }),
};

const periodParam = idParam('periodId', 'Period id');
const clientParam = idParam('clientId', 'Client id');

export const wpPaths: Record<string, Schema> = {
  '/api/v1/desktop/me': {
    get: {
      operationId: 'desktopMe', tags: tags('desktop'),
      summary: 'The name of the person at this PC (the desktop\'s one engine user)',
      responses: { '200': ok('The user', ref('DesktopMe')), '404': err('The desktop user is missing'), ...common },
    },
    put: {
      operationId: 'setDesktopMe', tags: tags('desktop'),
      summary: 'Set the name shown on sign-offs, notes and completed tasks (Q74)',
      requestBody: jsonBody({ type: 'object', required: ['displayName'], properties: { displayName: { type: 'string', minLength: 1, maxLength: 255 } } }),
      responses: { '200': ok('Saved', ref('DesktopMe')), '400': err('Blank or longer than 255'), ...common },
    },
  },
  '/api/v1/clients/{clientId}/documents': {
    parameters: [clientParam],
    get: {
      operationId: 'listDocuments', tags: tags('documents'), summary: 'The client\'s documents, newest first',
      responses: { '200': ok('Documents', { type: 'array', items: ref('Document') }, open(['total'], { total: int })), ...common },
    },
    post: {
      operationId: 'uploadDocument', tags: tags('documents'),
      summary: 'Store a file in the client\'s folder (25 MB at most; PDF, CSV, TXT, Excel, Word, PNG, JPEG, GIF, WEBP, TIFF; the content must match the type)',
      requestBody: multipart({
        periodId: { type: 'string', pattern: '^\\d+$', description: 'Files it under that period\'s fiscal year' },
        section: { type: 'string', description: 'A folder section; the default upload section when absent' },
      }, 'The file as field `file`'),
      responses: {
        '201': ok('Stored', ref('Document')),
        '400': err('No file, a type not allowed (INVALID_FILE_TYPE) or content that does not match (CONTENT_MISMATCH)'),
        '409': err('CLIENT_NOT_LINKED: the client has no folder'),
        '413': err('Larger than 25 MB'),
        ...common,
      },
    },
  },
  '/api/v1/documents/{id}/download': {
    parameters: [idParam('id', 'Document id')],
    get: {
      operationId: 'downloadDocument', tags: tags('documents'), summary: 'The stored file, as an attachment',
      responses: {
        '200': { description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        '404': err('No such document'),
        ...common,
      },
    },
  },
  '/api/v1/documents/{id}': {
    parameters: [idParam('id', 'Document id')],
    delete: {
      operationId: 'deleteDocument', tags: tags('documents'), summary: 'Delete a document and its file',
      responses: { '200': ok('Deleted', open(['id'], { id: int })), '403': err('Neither the uploader nor an admin'), '404': err('No such document'), ...common },
    },
  },
  '/api/v1/documents/{id}/link': {
    parameters: [idParam('id', 'Document id')],
    put: {
      operationId: 'linkDocument', tags: tags('documents'), summary: 'Link a document to an account or a journal entry (null unlinks)',
      requestBody: jsonBody(ref('DocumentLink')),
      responses: { '200': ok('Linked', ref('Document')), '400': err('Validation error'), '404': err('No such document'), ...common },
    },
  },
  '/api/v1/periods/{periodId}/engagement-tasks': {
    parameters: [periodParam],
    get: {
      operationId: 'listEngagementTasks', tags: tags('checklist'), summary: 'The period\'s checklist, in order',
      responses: { '200': ok('Tasks', { type: 'array', items: ref('EngagementTask') }, countMeta()), ...common },
    },
    post: {
      operationId: 'createEngagementTask', tags: tags('checklist'), summary: 'Add a task',
      requestBody: jsonBody({ ...ref('EngagementTaskInput'), required: ['title'] }),
      responses: { '201': ok('Added', ref('EngagementTask')), '400': err('Validation error'), ...common },
    },
  },
  '/api/v1/engagement-tasks/{id}': {
    parameters: [idParam('id', 'Task id')],
    patch: {
      operationId: 'updateEngagementTask', tags: tags('checklist'),
      summary: 'Change a task; completed stamps who and when, any other status clears them',
      requestBody: jsonBody(ref('EngagementTaskInput')),
      responses: { '200': ok('Saved', ref('EngagementTask')), '400': err('Validation error'), '404': err('No such task'), ...common },
    },
    delete: {
      operationId: 'deleteEngagementTask', tags: tags('checklist'), summary: 'Delete a task',
      responses: { '200': ok('Deleted', open(['id'], { id: int })), '404': err('No such task'), ...common },
    },
  },
  '/api/v1/engagement-summary': {
    get: {
      operationId: 'openEngagementTasks', tags: tags('checklist'), summary: 'Every client\'s tasks not completed or n/a',
      responses: { '200': ok('Open tasks', { type: 'array', items: ref('OpenTask') }, countMeta()), ...common },
    },
  },
  '/api/v1/clients/{clientId}/lead-sheets/unassigned': {
    parameters: [clientParam],
    get: {
      operationId: 'unassignedAccounts', tags: tags('lead-sheets'), summary: 'Active accounts on no lead sheet',
      responses: { '200': ok('Accounts', { type: 'array', items: ref('UnassignedAccount') }, countMeta()), ...common },
    },
  },
  '/api/v1/clients/{clientId}/lead-sheets/reorder': {
    parameters: [clientParam],
    post: {
      operationId: 'reorderLeadSheets', tags: tags('lead-sheets'), summary: 'Set each lead sheet\'s place',
      requestBody: jsonBody({ type: 'object', required: ['order'], properties: { order: { type: 'array', minItems: 1, maxItems: 200, items: open(['id', 'sortOrder'], { id: int, sortOrder: int }) } } }),
      responses: { '200': ok('Saved', open(['updated'], { updated: int })), '400': err('Validation error'), ...common },
    },
  },
  '/api/v1/clients/{clientId}/lead-sheets/assign': {
    parameters: [clientParam],
    post: {
      operationId: 'assignLeadSheet', tags: tags('lead-sheets'), summary: 'Put accounts on a lead sheet (null takes them off)',
      requestBody: jsonBody({ type: 'object', required: ['accountIds', 'leadSheetId'], properties: { accountIds: { type: 'array', minItems: 1, maxItems: 2000, items: int }, leadSheetId: nullable('integer') } }),
      responses: { '200': ok('Saved', open(['updated'], { updated: int })), '400': err('Validation error'), '404': err('No such lead sheet'), ...common },
    },
  },
  '/api/v1/lead-sheets/{id}': {
    parameters: [idParam('id', 'Lead sheet id')],
    patch: {
      operationId: 'updateLeadSheet', tags: tags('lead-sheets'), summary: 'Rename a lead sheet or move it',
      requestBody: jsonBody(ref('LeadSheetInput')),
      responses: { '200': ok('Saved', ref('LeadSheetRow')), '400': err('Validation error'), '404': err('No such lead sheet'), '409': err('DUPLICATE: the code is used'), ...common },
    },
    delete: {
      operationId: 'deleteLeadSheet', tags: tags('lead-sheets'),
      summary: 'Delete a lead sheet: its accounts become unassigned, its sign-offs and notes go with it, its attachments stay',
      responses: { '200': ok('Deleted', open(['id', 'orphanedAccounts'], { id: int, orphanedAccounts: int })), '404': err('No such lead sheet'), ...common },
    },
  },
  '/api/v1/periods/{periodId}/lead-sheets': {
    parameters: [periodParam],
    get: {
      operationId: 'leadSheetSchedules', tags: tags('lead-sheets'), summary: 'Every lead sheet of the period with its accounts, sign-offs and notes',
      responses: { '200': ok('Schedules', { type: 'array', items: ref('LeadSheetSchedule') }, countMeta()), ...common },
    },
  },
  '/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}': {
    parameters: [periodParam, idParam('leadSheetId', 'Lead sheet id')],
    get: {
      operationId: 'leadSheetSchedule', tags: tags('lead-sheets'), summary: 'One lead sheet of the period',
      responses: { '200': ok('Schedule', ref('LeadSheetSchedule')), '404': err('No such lead sheet'), ...common },
    },
  },
  '/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/signoff': {
    parameters: [periodParam, idParam('leadSheetId', 'Lead sheet id')],
    post: {
      operationId: 'signLeadSheet', tags: tags('lead-sheets'), summary: 'Sign as preparer or reviewer (a new signature replaces the live one)',
      requestBody: jsonBody({ type: 'object', required: ['role'], properties: { role: signRole } }),
      responses: { '201': ok('Signed', ref('LeadSheetSigned')), '400': err('Validation error'), '404': err('No such lead sheet'), ...common },
    },
  },
  '/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/unsign': {
    parameters: [periodParam, idParam('leadSheetId', 'Lead sheet id')],
    post: {
      operationId: 'unsignLeadSheet', tags: tags('lead-sheets'), summary: 'Remove the live signature of a role',
      requestBody: jsonBody({ type: 'object', required: ['role'], properties: { role: signRole } }),
      responses: {
        '200': ok('Removed', open(['removed', 'status'], { removed: int, status: { const: 'unsigned' } })),
        '404': err('NOT_SIGNED: no live signature'),
        '423': err('The period is locked'),
        ...common,
      },
    },
  },
  '/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/notes': {
    parameters: [periodParam, idParam('leadSheetId', 'Lead sheet id')],
    get: {
      operationId: 'leadSheetNotes', tags: tags('lead-sheets'), summary: 'The sheet\'s notes, the account notes too',
      responses: { '200': ok('Notes', { type: 'array', items: ref('LeadSheetNote') }, open(['open'], { open: int })), ...common },
    },
    post: {
      operationId: 'addLeadSheetNote', tags: tags('lead-sheets'), summary: 'Add a note to the sheet or one of its accounts',
      requestBody: jsonBody({ type: 'object', required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 4000 }, accountId: nullable('integer') } }),
      responses: { '201': ok('Added', ref('LeadSheetNote')), '400': err('Validation error'), ...common },
    },
  },
  '/api/v1/periods/{periodId}/lead-sheets/{leadSheetId}/notes/{noteId}/resolve': {
    parameters: [periodParam, idParam('leadSheetId', 'Lead sheet id'), idParam('noteId', 'Note id')],
    post: {
      operationId: 'resolveLeadSheetNote', tags: tags('lead-sheets'), summary: 'Resolve a note, or open it again',
      requestBody: jsonBody({ type: 'object', required: ['resolved'], properties: { resolved: { type: 'boolean' } } }),
      responses: { '200': ok('Saved', ref('LeadSheetNote')), '404': err('No such note'), ...common },
    },
  },
  '/api/v1/periods/{periodId}/lead-sheet-attachments': {
    parameters: [periodParam],
    get: {
      operationId: 'leadSheetAttachments', tags: tags('lead-sheets'), summary: 'The period\'s attachments, by ref code',
      responses: { '200': ok('Attachments', { type: 'array', items: ref('LeadSheetAttachment') }, countMeta()), ...common },
    },
    post: {
      operationId: 'addLeadSheetAttachment', tags: tags('lead-sheets'),
      summary: 'Attach a PDF, PNG or JPEG (10 MB at most; pictures become PDF) to a lead sheet or one of its accounts',
      requestBody: multipart({
        leadSheetId: { type: 'string', pattern: '^\\d+$' },
        leadSheetCode: { type: 'string', description: 'Its letters start the ref code' },
        accountId: { type: 'string', pattern: '^\\d+$' },
      }, 'The file as field `file`'),
      responses: {
        '201': ok('Attached', ref('LeadSheetAttachment')),
        '400': err('No file or not a PDF, PNG or JPEG (INVALID_FILE_TYPE)'),
        '409': err('CLIENT_NOT_LINKED: the client has no folder'),
        '413': err('Larger than 10 MB'),
        '423': err('The period is locked'),
        ...common,
      },
    },
  },
  '/api/v1/periods/{periodId}/lead-sheet-attachments/by-account': {
    parameters: [periodParam],
    get: {
      operationId: 'leadSheetAttachmentsByAccount', tags: tags('lead-sheets'), summary: 'Each account\'s attachment ref codes',
      responses: {
        '200': ok('By account id', { type: 'object', additionalProperties: { type: 'array', items: open(['id', 'refCode'], { id: int, refCode: str }) } }),
        ...common,
      },
    },
  },
  '/api/v1/lead-sheet-attachments/{id}/file': {
    parameters: [idParam('id', 'Attachment id')],
    get: {
      operationId: 'leadSheetAttachmentFile', tags: tags('lead-sheets'), summary: 'The attachment as PDF (inline)',
      responses: { '200': pdfFile('The PDF'), '404': err('No such attachment'), ...common },
    },
  },
  '/api/v1/lead-sheet-attachments/{id}': {
    parameters: [idParam('id', 'Attachment id')],
    delete: {
      operationId: 'deleteLeadSheetAttachment', tags: tags('lead-sheets'), summary: 'Delete an attachment; its ref code is never reused',
      responses: {
        '200': ok('Deleted', open(['id', 'refCode'], { id: int, refCode: str })),
        '403': err('Neither the uploader nor an admin'),
        '404': err('No such attachment'),
        '423': err('The period is locked'),
        ...common,
      },
    },
  },
  '/api/v1/reports/periods/{periodId}/workpaper-index': {
    parameters: [periodParam, { name: 'pageBreak', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: 'A new page for each workpaper reference' }],
    get: {
      operationId: 'workpaperIndexPdf', tags: tags('workpapers'), summary: 'The workpaper index (accounts by workpaper reference) as PDF',
      responses: { '200': pdfFile('The PDF'), ...common },
    },
  },
  '/api/v1/reports/periods/{periodId}/lead-sheets/{leadSheetId}': {
    parameters: [periodParam, idParam('leadSheetId', 'Lead sheet id'), { name: 'includeAttachments', in: 'query', schema: { type: 'string', enum: ['0', '1', 'true', 'false'] } }],
    get: {
      operationId: 'leadSheetPdf', tags: tags('workpapers'), summary: 'One lead sheet schedule as PDF, its attachments after it when asked',
      responses: { '200': pdfFile('The PDF'), '404': err('No such lead sheet'), ...common },
    },
  },
  '/api/v1/reports/periods/{periodId}/workpaper-merged': {
    parameters: [
      periodParam,
      { name: 'reports', in: 'query', required: true, schema: str, description: 'Report ids, comma separated, in the order they print (pdf-wp-index, pdf-lead-sheets, pdf-tb, pdf-is, pdf-bs, pdf-equity, pdf-je, pdf-aje, pdf-gl, pdf-tax-code, pdf-tax-pl, pdf-tax-return, pdf-m1)' },
      { name: 'includeAttachments', in: 'query', schema: { type: 'string', enum: ['0', '1', 'true', 'false'] } },
      { name: 'basis', in: 'query', schema: basis },
      { name: 'groupByLeadSheet', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
    ],
    get: {
      operationId: 'workpaperPackagePdf', tags: tags('workpapers'), summary: 'The workpaper package: a contents page, the reports, then the attachments',
      responses: { '200': pdfFile('The PDF'), '400': err('No report asked for'), ...common },
    },
  },
  '/api/v1/reports/periods/{periodId}/workpaper-merged/save': {
    parameters: [periodParam],
    post: {
      operationId: 'saveWorkpaperPackage', tags: tags('workpapers'), summary: 'Build the package and store it in the client\'s workpapers',
      requestBody: jsonBody(ref('WorkpaperSave')),
      responses: {
        '201': ok('Stored', ref('WorkpaperSaved')),
        '400': err('Validation error'),
        '409': err('CLIENT_NOT_LINKED: the client has no folder'),
        ...common,
      },
    },
  },
};
