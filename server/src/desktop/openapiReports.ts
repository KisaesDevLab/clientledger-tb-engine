// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * The statement and report PDFs, the bookkeeper letter and M-1 adjustments
 * in the desktop's API description (P08, the M-1 tab): routes the desktop
 * calls (`cltb-api` `reports.rs`, `m1.rs`) that the description lacked.
 * `cltb-api/tests/openapi_coverage.rs` fails on any route the client calls
 * that is not described.
 */

type Schema = Record<string, unknown>;

const idParam = (name: string, description: string): Schema => ({
  name, in: 'path', required: true, description, schema: { type: 'integer', minimum: 1 },
});
const query = (name: string, description: string, schema: Schema): Schema => ({
  name, in: 'query', required: false, description, schema,
});
const pdf = (what: string): Schema => ({
  description: `The PDF; Content-Disposition names it <period>_<client>_${what}.pdf`,
  content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
});
const errorResponse = (description: string): Schema => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
});
const ok = (description: string, data: Schema): Schema => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object', required: ['data', 'error'],
        properties: { data, error: { type: 'null' }, meta: { type: 'object' } },
      },
    },
  },
});

const preview = query('preview', 'inline instead of attachment', { type: 'string', enum: ['1'] });
const basis = (values: string[]): Schema =>
  query('basis', 'which balances: book adjusted, tax, or before adjustments', { type: 'string', enum: values });
const priorYear = query('priorYear', 'prior-year columns ($ and % change); unset: shown when any row has one', { type: 'string', enum: ['true', 'false'] });
const byLeadSheet = query('groupByLeadSheet', 'subtotal by lead sheet', { type: 'string', enum: ['true', 'false'] });

/** One report PDF: GET with the query options its route reads. */
function report(name: string, operationId: string, summary: string, options: Schema[]): Schema {
  return {
    parameters: [idParam('periodId', 'Period id'), preview, ...options],
    get: {
      operationId, tags: ['reports'], summary,
      responses: { '200': pdf(name), '400': errorResponse('Invalid id or option'), '404': errorResponse('No such period') },
    },
  };
}

const M1Adjustment: Schema = {
  type: 'object',
  required: ['id', 'period_id', 'description', 'book_amount', 'tax_amount', 'sort_order'],
  properties: {
    id: { type: 'integer' },
    period_id: { type: 'integer' },
    description: { type: 'string' },
    category: { type: ['string', 'null'], description: "one of the engine's M-1 categories" },
    book_amount: { type: 'integer', description: 'cents' },
    tax_amount: { type: 'integer', description: 'cents' },
    sort_order: { type: 'integer' },
    notes: { type: ['string', 'null'] },
  },
};
const M1Input: Schema = {
  type: 'object',
  required: ['description', 'bookAmount', 'taxAmount'],
  properties: {
    description: { type: 'string', minLength: 1 },
    category: { type: ['string', 'null'] },
    bookAmount: { type: 'integer', description: 'cents' },
    taxAmount: { type: 'integer', description: 'cents' },
    sortOrder: { type: 'integer' },
    notes: { type: ['string', 'null'] },
  },
};

export const reportsSchemas: Record<string, Schema> = { M1Adjustment, M1Input };

export const reportsPaths: Record<string, Schema> = {
  '/api/v1/reports/periods/{periodId}/income-statement': report('income-statement', 'getIncomeStatementPdf', 'Income statement as a PDF', [basis(['book', 'tax']), priorYear, byLeadSheet]),
  '/api/v1/reports/periods/{periodId}/balance-sheet': report('balance-sheet', 'getBalanceSheetPdf', 'Balance sheet as a PDF', [basis(['book', 'tax']), priorYear, byLeadSheet]),
  '/api/v1/reports/periods/{periodId}/equity-statement': report('equity-statement', 'getEquityStatementPdf', 'Statement of changes in equity as a PDF', [basis(['book', 'tax']), priorYear]),
  '/api/v1/reports/periods/{periodId}/cash-flow': report('cash-flow', 'getCashFlowPdf', 'Statement of cash flows as a PDF', []),
  '/api/v1/reports/periods/{periodId}/tax-basis-pl': report('tax-basis-pl', 'getTaxBasisIncomePdf', 'Tax-basis income (by tax code and category) as a PDF', []),
  '/api/v1/reports/periods/{periodId}/trial-balance': report('trial-balance', 'getTrialBalancePdf', 'Trial balance as a PDF', [basis(['unadjusted', 'book', 'tax'])]),
  '/api/v1/reports/periods/{periodId}/general-ledger': report('general-ledger', 'getGeneralLedgerPdf', 'General ledger as a PDF', []),
  '/api/v1/reports/periods/{periodId}/journal-entries': report('journal-entries', 'getJournalEntriesPdf', 'Journal entries as a PDF', [query('type', 'which entries', { type: 'string', enum: ['all', 'book', 'tax', 'trans'] })]),
  '/api/v1/reports/periods/{periodId}/tax-code-report': report('tax-code-report', 'getTaxCodeReportPdf', 'Balances by tax code as a PDF', [query('columns', 'book and tax columns, or one', { type: 'string', enum: ['book', 'tax', 'both'] })]),
  '/api/v1/reports/periods/{periodId}/tax-return-order': report('tax-return-order', 'getTaxReturnOrderPdf', 'Accounts in tax return order as a PDF', []),
  '/api/v1/reports/periods/{periodId}/tax-basis-schedule': report('tax-basis-schedule', 'getTaxBasisSchedulePdf', 'Book and tax balances side by side as a PDF', []),
  '/api/v1/reports/periods/{periodId}/m1': report('m1', 'getM1ReconciliationPdf', 'M-1 reconciliation as a PDF', []),
  '/api/v1/reports/periods/{periodId}/flux/{comparePeriodId}': {
    parameters: [idParam('periodId', 'Period id'), idParam('comparePeriodId', 'Period compared with'), preview, basis(['book', 'tax']), byLeadSheet],
    get: {
      operationId: 'getFluxAnalysisPdf', tags: ['reports'],
      summary: 'Flux analysis against another period, with variance notes, as a PDF',
      responses: { '200': pdf('flux-analysis-vs-<period>'), '400': errorResponse('Invalid id or option'), '404': errorResponse('No such period') },
    },
  },
  '/api/v1/periods/{periodId}/exports/bookkeeper-letter': {
    parameters: [idParam('periodId', 'Period id'), preview],
    get: {
      operationId: 'getBookkeeperLetterPdf', tags: ['reports'],
      summary: "Letter to the bookkeeper listing the period's book adjusting entries, as a PDF",
      responses: { '200': pdf('bookkeeper-letter'), '400': errorResponse('Invalid id'), '404': errorResponse('No such period') },
    },
  },
  '/api/v1/periods/{periodId}/m1-adjustments': {
    parameters: [idParam('periodId', 'Period id')],
    get: {
      operationId: 'listM1Adjustments', tags: ['m1'],
      summary: "The period's book-to-tax (M-1) adjustments",
      responses: { '200': ok('Adjustments', { type: 'array', items: { $ref: '#/components/schemas/M1Adjustment' } }), '400': errorResponse('Invalid id') },
    },
    post: {
      operationId: 'createM1Adjustment', tags: ['m1'],
      summary: 'Add an M-1 adjustment (refused in a locked period)',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/M1Input' } } } },
      responses: {
        '201': ok('Added', { $ref: '#/components/schemas/M1Adjustment' }),
        '400': errorResponse('VALIDATION_ERROR'),
        '409': errorResponse('PERIOD_LOCKED'),
      },
    },
  },
  '/api/v1/m1-adjustments/{id}': {
    parameters: [idParam('id', 'M-1 adjustment id')],
    patch: {
      operationId: 'updateM1Adjustment', tags: ['m1'],
      summary: 'Change an M-1 adjustment (any of its fields; refused in a locked period)',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/M1Input' } } } },
      responses: {
        '200': ok('Changed', { $ref: '#/components/schemas/M1Adjustment' }),
        '404': errorResponse('Not found'),
        '409': errorResponse('PERIOD_LOCKED'),
      },
    },
    delete: {
      operationId: 'deleteM1Adjustment', tags: ['m1'],
      summary: 'Delete an M-1 adjustment (refused in a locked period)',
      responses: {
        '200': ok('Deleted', { type: 'object', properties: { id: { type: 'integer' } } }),
        '404': errorResponse('Not found'),
        '409': errorResponse('PERIOD_LOCKED'),
      },
    },
  },
};

/** These operations are not Claude's tools: the desktop's own tools do them. */
export const reportsExcluded: Record<string, string> = {
  getIncomeStatementPdf: 'save_report saves every report as a PDF',
  getBalanceSheetPdf: 'save_report saves every report as a PDF',
  getEquityStatementPdf: 'save_report saves every report as a PDF',
  getCashFlowPdf: 'save_report saves every report as a PDF',
  getTaxBasisIncomePdf: 'save_report saves every report as a PDF',
  getTrialBalancePdf: 'save_report saves every report as a PDF',
  getGeneralLedgerPdf: 'save_report saves every report as a PDF',
  getJournalEntriesPdf: 'save_report saves every report as a PDF',
  getTaxCodeReportPdf: 'save_report saves every report as a PDF',
  getTaxReturnOrderPdf: 'save_report saves every report as a PDF',
  getTaxBasisSchedulePdf: 'save_report saves every report as a PDF',
  getM1ReconciliationPdf: 'save_report saves every report as a PDF',
  getFluxAnalysisPdf: 'save_report saves every report as a PDF',
  getBookkeeperLetterPdf: 'save_report saves every report as a PDF',
  listM1Adjustments: 'list_m1_adjustments',
  createM1Adjustment: 'create_m1_adjustment',
  updateM1Adjustment: 'update_m1_adjustment',
  deleteM1Adjustment: 'delete_m1_adjustment',
};
