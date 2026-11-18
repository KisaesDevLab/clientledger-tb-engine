// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The Statement Writer routes the desktop calls (P08b), for openapi.ts.
// Written from the engine's zod contracts (lib/fs/engine/schemas.ts) and the
// route handlers (routes/fs.ts, lib/fs/fsReports.ts, lib/fs/fsLibrary.ts).
// The layout and style objects are closed (additionalProperties: false) so a
// recorded layout with a field this document does not know fails the
// OpenAPI test; fsContract.test.ts checks the other direction (every field
// the zod schemas know is described here).

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: Schema = {}): Schema => ({ type: [type, 'null'], ...extra });
const str = (maxLength?: number, extra: Schema = {}): Schema => ({ type: 'string', ...(maxLength ? { maxLength } : {}), ...extra });
const bool: Schema = { type: 'boolean' };
const int: Schema = { type: 'integer' };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const isoDate: Schema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const fsId: Schema = { type: 'string', pattern: '^-?\\d{1,15}$', description: 'A database id as a decimal string; -1 is the virtual retained-earnings account' };
const nodeId: Schema = { type: 'string', minLength: 1, maxLength: 40 };
const caption = str(200);
const closed = (required: string[], properties: Schema, description?: string): Schema => ({
  type: 'object', additionalProperties: false, required, properties, ...(description ? { description } : {}),
});
const open = (required: string[], properties: Schema, description?: string): Schema => ({
  type: 'object', required, properties, ...(description ? { description } : {}),
});

const entityKind: Schema = { type: 'string', enum: ['corporation', 'partnership', 'llc', 'sole_prop'] };
const cfClass: Schema = { type: 'string', enum: ['cash', 'operating', 'noncash_adjustment', 'investing', 'financing', 'excluded'] };
const equityRole: Schema = { type: 'string', enum: ['retained', 'distributions', 'contributions', 'other'] };
const rule: Schema = { type: 'string', enum: ['none', 'single', 'double'] };
const ruleAbove: Schema = { type: 'string', enum: ['none', 'single'] };
const polarity: Schema = { type: 'string', enum: ['debit', 'credit'] };
const nodeRole: Schema = { type: 'string', enum: ['total_assets', 'total_liabilities_equity', 'net_income'] };
const statementKind: Schema = { type: 'string', enum: ['balance_sheet', 'income_statement', 'equity', 'cash_flows'] };
const fontKey: Schema = { type: 'string', description: 'A bundled font (lib/fs/engine/fonts.ts FS_FONT_KEYS)' };

const commonNode: Schema = {
  id: nodeId,
  style: ref('FsNodeStyle'),
  ruleAbove,
  ruleBelow: rule,
  hideWhenZero: { type: 'boolean', description: 'Hide when every rounded amount column is zero; unset follows the style' },
  breakBefore: { type: 'boolean', description: 'Start a new page before this line' },
};

const elementStyle = closed(['sizePt', 'bold', 'italic'], {
  sizePt: { type: 'number', minimum: 6, maximum: 28 },
  bold: bool, italic: bool, caps: bool,
  align: { type: 'string', enum: ['left', 'center', 'right'] },
});
const STYLE_ELEMENTS = ['companyName', 'statementTitle', 'dateLine', 'columnHeader', 'sectionHeading', 'detail', 'subtotal', 'total', 'text', 'footer'];

const ok: Schema = open(['ok'], { ok: { type: 'boolean', const: true } });
const idOnly = (key: string): Schema => open([key], { [key]: open(['id'], { id: int }) });

export const fsSchemas: Record<string, Schema> = {
  // ─── Layout ────────────────────────────────────────────────────────
  FsNodeStyle: closed([], {
    bold: bool, italic: bool,
    indent: { type: 'integer', minimum: -4, maximum: 6, description: 'Extra indent levels on top of the tree depth' },
    sizeDelta: { type: 'number', minimum: -4, maximum: 8, description: 'Points added to the element style' },
    caps: bool,
  }),
  FsAccountRef: closed(['accountId'], { accountId: fsId }),
  FsScheduleLine: closed(['id', 'accountRefs'], {
    id: nodeId,
    caption: { ...caption, description: 'Omitted: the account\'s own name' },
    accountRefs: { type: 'array', minItems: 1, maxItems: 200, items: ref('FsAccountRef') },
  }),
  FsSectionNode: closed(['type', 'id', 'caption', 'children'], {
    ...commonNode,
    type: { const: 'section' },
    caption,
    showHeading: bool,
    polarity,
    children: { type: 'array', maxItems: 300, items: ref('FsNode') },
    showTotal: bool,
    totalCaption: caption,
    role: nodeRole,
    anchor: { type: 'boolean', description: 'A rounding anchor' },
    revenueBase: { type: 'boolean', description: 'The base of % of revenue' },
    totalStyle: ref('FsNodeStyle'),
    totalRuleAbove: ruleAbove,
    totalRuleBelow: rule,
  }),
  FsLeadsheetNode: closed(['type', 'id', 'ref', 'display'], {
    ...commonNode,
    type: { const: 'leadsheet' },
    ref: closed([], { groupingId: fsId, leadsheetCode: str(10, { minLength: 1 }) }, 'One of the client\'s lead sheets (groupingId), or a code to bind (templates)'),
    caption,
    display: { type: 'string', enum: ['single_line', 'detail', 'summary_with_schedule'] },
    polarity,
    scheduleTitle: caption,
    scheduleLines: { type: 'array', maxItems: 300, items: ref('FsScheduleLine') },
    revenueBase: bool,
    anchor: bool,
  }),
  FsAccountNode: closed(['type', 'id', 'refs', 'caption'], {
    ...commonNode,
    type: { const: 'account' },
    refs: { type: 'array', minItems: 1, maxItems: 200, items: ref('FsAccountRef') },
    caption,
    polarity,
    revenueBase: bool,
  }),
  FsTotalNode: closed(['type', 'id', 'caption', 'terms'], {
    ...commonNode,
    type: { const: 'total' },
    caption,
    terms: {
      type: 'array', minItems: 1, maxItems: 50,
      items: closed(['nodeId', 'sign'], { nodeId, sign: { type: 'integer', enum: [1, -1] } }),
    },
    role: nodeRole,
    anchor: bool,
    revenueBase: bool,
  }),
  FsTextNode: closed(['type', 'id', 'text'], { ...commonNode, type: { const: 'text' }, text: str(2000) }),
  FsSpacerNode: closed(['type', 'id'], { ...commonNode, type: { type: 'string', enum: ['blank', 'page_break'] } }),
  FsNode: {
    description: 'A line of a statement. Ids are unique within a statement.',
    oneOf: ['FsSectionNode', 'FsLeadsheetNode', 'FsAccountNode', 'FsTotalNode', 'FsTextNode', 'FsSpacerNode'].map(ref),
  },
  FsMargins: closed(['top', 'right', 'bottom', 'left'], Object.fromEntries(
    ['top', 'right', 'bottom', 'left'].map((k) => [k, { type: 'number', minimum: 0.25, maximum: 3, description: 'Inches' }]),
  )),
  FsPageSetup: closed(['paper', 'orientation', 'margins'], {
    paper: { type: 'string', enum: ['letter', 'legal', 'a4'] },
    orientation: { type: 'string', enum: ['portrait', 'landscape'] },
    margins: ref('FsMargins'),
  }),
  FsStatementConfig: closed(['id', 'kind', 'enabled', 'body'], {
    id: nodeId,
    kind: statementKind,
    enabled: bool,
    titleOverride: caption,
    pageSetup: closed([], {
      paper: { type: 'string', enum: ['letter', 'legal', 'a4'] },
      orientation: { type: 'string', enum: ['portrait', 'landscape'] },
      margins: ref('FsMargins'),
    }, 'Overrides the style\'s page for this statement'),
    plugs: { type: 'object', additionalProperties: nodeId, description: 'Rounding plug: anchor node id to the line that takes the difference' },
    body: { type: 'array', maxItems: 300, items: ref('FsNode') },
    equity: closed([], {
      captions: closed([], Object.fromEntries(['beginning', 'netIncome', 'contributions', 'distributions', 'other', 'ending', 'total'].map((k) => [k, caption]))),
      columns: { type: 'string', enum: ['auto', 'single', 'by_account'] },
      columnCaptions: { type: 'object', additionalProperties: caption, description: 'By account id' },
    }),
    cashFlow: closed([], {
      captions: closed([], Object.fromEntries([
        'operatingHeading', 'netIncome', 'adjustmentsHeading', 'changesHeading', 'netOperating', 'investingHeading',
        'netInvesting', 'financingHeading', 'netFinancing', 'netChange', 'beginningCash', 'endingCash',
      ].map((k) => [k, caption]))),
      detailByAccount: bool,
    }),
  }),
  FsLayout: closed(['version', 'statements', 'schedules'], {
    version: { const: 1 },
    statements: { type: 'array', minItems: 1, maxItems: 8, items: ref('FsStatementConfig') },
    schedules: closed(['enabled', 'dividerTitle', 'numbering'], {
      enabled: bool, dividerTitle: caption, numbering: { type: 'string', enum: ['numeric', 'alpha'] },
    }),
  }, 'A statement layout. A client layout names the client\'s lead sheets and accounts; a firm template names lead sheet codes only.'),

  // ─── Style ─────────────────────────────────────────────────────────
  FsElementStyle: elementStyle,
  FsStyle: closed(['fontKey', 'baseSizePt', 'lineHeight', 'indentPt', 'amountColumnWidthIn', 'number', 'elements', 'page', 'titleBlock', 'footer'], {
    fontKey,
    baseSizePt: { type: 'number', minimum: 7, maximum: 16 },
    lineHeight: { type: 'number', minimum: 1, maximum: 2.2 },
    indentPt: { type: 'number', minimum: 4, maximum: 36 },
    amountColumnWidthIn: { type: 'number', minimum: 0.6, maximum: 2.5 },
    number: closed(['decimals', 'dollarSigns', 'negative', 'zero', 'hideZeroLines'], {
      decimals: { type: 'integer', enum: [0, 2] },
      dollarSigns: { type: 'string', enum: ['first_and_totals', 'none'] },
      negative: { type: 'string', enum: ['parens', 'minus'] },
      zero: { type: 'string', enum: ['dash', 'zero'] },
      hideZeroLines: bool,
    }),
    elements: closed(STYLE_ELEMENTS, Object.fromEntries(STYLE_ELEMENTS.map((k) => [k, ref('FsElementStyle')]))),
    page: ref('FsPageSetup'),
    titleBlock: closed(['align'], { align: { type: 'string', enum: ['left', 'center'] } }),
    footer: closed(['text', 'onStatements', 'onSchedules', 'pageNumber'], {
      text: str(300), onStatements: bool, onSchedules: bool,
      pageNumber: closed(['format', 'position'], {
        format: { type: 'string', enum: ['n', 'dash_n', 'page_n', 'page_n_of_total', 'none'] },
        position: { type: 'string', enum: ['bottom_center', 'bottom_right'] },
      }),
    }),
  }),

  // ─── Settings and front matter ─────────────────────────────────────
  FsReportSettings: closed(['framework', 'columns'], {
    framework: { type: 'string', enum: ['gaap', 'cash', 'tax'], description: 'gaap and cash read book balances (cash changes the wording); tax reads tax-adjusted balances' },
    columns: closed(['mode', 'pctOfRevenue', 'varianceAmt', 'variancePct'], {
      mode: { type: 'string', enum: ['single', 'cy_py'] },
      pctOfRevenue: bool, varianceAmt: bool, variancePct: bool,
    }),
    entityKind: { ...nullable('string'), enum: ['corporation', 'partnership', 'llc', 'sole_prop', null], description: 'Overrides the kind implied by the client\'s return type' },
  }),
  FsFrontMatter: closed(['cover', 'toc', 'letter'], {
    cover: closed(['enabled'], { enabled: bool, title: caption, subtitle: caption, showFirmName: bool }),
    toc: closed(['enabled'], { enabled: bool, title: caption }),
    letter: closed(['enabled'], {
      enabled: bool,
      letterId: nullable('integer', { minimum: 1, description: 'A library letter; null: the default one' }),
      titleOverride: { ...nullable('string'), maxLength: 200 },
      bodyHtmlOverride: { ...nullable('string'), maxLength: 3000000, description: 'This report\'s own wording (sanitized HTML with {{variables}}); null: the library letter\'s' },
      reportDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    }),
  }),

  // ─── Requests ──────────────────────────────────────────────────────
  FsCreateReport: closed(['name', 'settings', 'layoutSource'], {
    name: str(200, { minLength: 1 }),
    settings: ref('FsReportSettings'),
    layoutSource: {
      oneOf: [
        closed(['kind'], { kind: { const: 'default' }, layoutName: str(200, { minLength: 1 }) }),
        closed(['kind', 'clientLayoutId'], { kind: { const: 'client_layout' }, clientLayoutId: { type: 'integer', minimum: 1 } }),
        closed(['kind', 'templateId'], {
          kind: { const: 'template' },
          templateId: { type: 'integer', minimum: 1 },
          layoutName: str(200, { minLength: 1 }),
          resolutions: { type: 'object', additionalProperties: { type: ['string', 'null'], pattern: '^-?\\d{1,15}$' }, description: 'Unbound template line (node id) to one of the client\'s lead sheets, or null to leave it' },
        }),
      ],
    },
    stylePresetId: nullable('integer', { minimum: 1 }),
    frontMatter: ref('FsFrontMatter'),
  }),
  FsUpdateReport: closed([], { name: str(200, { minLength: 1 }), settings: ref('FsReportSettings'), frontMatter: ref('FsFrontMatter') }),
  FsLayoutUpdate: closed([], {
    name: str(200, { minLength: 1 }),
    layout: ref('FsLayout'),
    style: ref('FsStyle'),
    expectedUpdatedAt: { type: 'string', description: 'updatedAt as read. When it no longer matches, the save is refused (409 FS_CONFLICT). The desktop always sends it.' },
  }),
  FsDraftOverrides: closed([], {
    layout: ref('FsLayout'), style: ref('FsStyle'), settings: ref('FsReportSettings'), frontMatter: ref('FsFrontMatter'),
  }, 'Unsaved changes to compute or print instead of the saved ones'),
  FsFinalizeRequest: closed([], {
    overrideValidation: bool,
    reason: { type: 'string', maxLength: 1000, description: 'At least 5 characters when overriding failed checks' },
  }),

  // ─── Answers ───────────────────────────────────────────────────────
  FsPdfEngineStatus: open(['available', 'path', 'source', 'configuredPath', 'message'], {
    available: bool,
    path: nullable('string'),
    source: { type: ['string', 'null'], enum: ['setting', 'env', 'detected', null] },
    configuredPath: nullable('string'),
    message: { type: 'string', description: 'The engine\'s words (server wording; the desktop says its own)' },
  }),
  FsClientLayout: open(['id', 'clientId', 'name', 'layout', 'style', 'updatedAt'], {
    id: int, clientId: int, name: { type: 'string' },
    layout: ref('FsLayout'), style: ref('FsStyle'),
    updatedAt: { ...nullable('string'), description: 'Send back as expectedUpdatedAt, as read' },
  }, 'A client layout: shared by every statement set of the client that uses it'),
  FsLayoutSummary: open(['id', 'name', 'updatedAt', 'sourceTemplateId'], {
    id: int, name: { type: 'string' }, updatedAt: nullable('string'), sourceTemplateId: nullable('integer'),
  }),
  FsReportSummary: open(['id', 'name', 'status', 'periodId', 'periodName', 'periodStart', 'periodEnd', 'periodLocked', 'framework', 'columns', 'updatedAt', 'currentVersion'], {
    id: int, name: { type: 'string' }, status: { type: 'string', enum: ['draft', 'final'] },
    periodId: int, periodName: { type: 'string' }, periodStart: nullable('string'), periodEnd: nullable('string'), periodLocked: bool,
    framework: { type: 'string', enum: ['gaap', 'cash', 'tax'] },
    columns: { type: 'object' },
    updatedAt: nullable('string'),
    currentVersion: {
      oneOf: [{ type: 'null' }, open(['versionNo', 'finalizedAt', 'validationOverride', 'stale'], {
        versionNo: int, finalizedAt: nullable('string'), validationOverride: bool,
        stale: { type: 'boolean', description: 'Something the statements are built from changed since they were issued' },
      })],
    },
  }),
  FsVersion: open(['id', 'versionNo', 'status', 'finalizedAt', 'finalizedByName', 'validationOverride', 'overrideReason', 'pageCount', 'supersededAt', 'reopenedAt', 'hasFile', 'regenerated', 'stale'], {
    id: int, versionNo: int, status: { type: 'string', enum: ['final', 'superseded'] },
    finalizedAt: nullable('string'), finalizedByName: nullable('string'),
    validationOverride: bool, overrideReason: nullable('string'), pageCount: nullable('integer'),
    supersededAt: nullable('string'), reopenedAt: nullable('string'),
    hasFile: bool, regenerated: { type: 'boolean', description: 'The PDF was drawn again from the issued snapshot (after a restore)' }, stale: bool,
  }),
  FsReportDetail: open(['report', 'period', 'defaultEntityKind', 'layout', 'versions'], {
    report: open(['id', 'name', 'status', 'clientId', 'periodId', 'currentVersionId', 'settings', 'frontMatter', 'updatedAt'], {
      id: int, name: { type: 'string' }, status: { type: 'string', enum: ['draft', 'final'] },
      clientId: int, periodId: int, currentVersionId: nullable('integer'),
      settings: ref('FsReportSettings'), frontMatter: ref('FsFrontMatter'), updatedAt: nullable('string'),
    }),
    period: open(['id', 'clientId', 'clientName', 'name', 'start', 'end', 'locked'], {
      id: int, clientId: int, clientName: { type: 'string' }, name: { type: 'string' },
      start: { type: 'string' }, end: { type: 'string' }, locked: bool,
    }),
    defaultEntityKind: entityKind,
    layout: ref('FsClientLayout'),
    versions: { type: 'array', items: ref('FsVersion') },
  }),
  FsCheck: open(['code', 'severity', 'message'], {
    code: { type: 'string' },
    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
    message: { type: 'string' },
    statementId: { type: 'string' },
    nodeId: { type: 'string', description: 'The line to go to' },
    accountIds: { type: 'array', items: { type: 'string' } },
    amount: { type: 'number' },
  }),
  FsRenderedStatement: open(['id', 'kind', 'title', 'dateLine', 'pageSetup', 'columns', 'rows'], {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['balance_sheet', 'income_statement', 'equity', 'cash_flows', 'schedule'] },
    title: { type: 'string' }, dateLine: { type: 'string' }, scheduleNo: { type: 'string' },
    pageSetup: ref('FsPageSetup'),
    columns: { type: 'array', items: open(['key', 'label', 'kind'], { key: { type: 'string' }, label: { type: 'string' }, sublabel: { type: 'string' }, kind: { type: 'string', enum: ['amount', 'pct', 'variance_amt', 'variance_pct'] } }) },
    rows: {
      type: 'array',
      items: open(['key', 'kind', 'caption', 'level', 'styleRole', 'values', 'dollarSign', 'ruleAbove', 'ruleBelow'], {
        key: { type: 'string' }, nodeId: { type: 'string' },
        kind: { type: 'string', enum: ['heading', 'detail', 'subtotal', 'total', 'text', 'blank', 'page_break'] },
        caption: { type: 'string' }, level: int,
        styleRole: { type: 'string', enum: ['sectionHeading', 'detail', 'subtotal', 'total', 'text'] },
        values: { type: 'array', items: { type: ['number', 'null'] }, description: 'One per column: amounts rounded for display (dollars, or cents with 2 decimals), percents as 12.3' },
        dollarSign: bool, ruleAbove, ruleBelow: rule,
        scheduleRef: { type: 'string' }, plug: { type: 'array', items: { type: 'number' } }, breakBefore: bool,
      }),
    },
  }),
  FsRenderedReport: open(['meta', 'statements', 'schedules', 'checks'], {
    meta: open(['companyName', 'periodStart', 'periodEnd', 'framework', 'entityKind', 'columnMode', 'sourceStamp', 'decimals', 'bsDateLine'], {
      companyName: { type: 'string' }, periodStart: { type: 'string' }, periodEnd: { type: 'string' },
      framework: { type: 'string', enum: ['gaap', 'cash', 'tax'] }, entityKind,
      columnMode: { type: 'string', enum: ['single', 'cy_py'] }, sourceStamp: { type: 'string' },
      decimals: { type: 'integer', enum: [0, 2] }, bsDateLine: { type: 'string' },
    }),
    statements: { type: 'array', items: ref('FsRenderedStatement') },
    schedules: { type: 'array', items: ref('FsRenderedStatement') },
    checks: { type: 'array', items: ref('FsCheck') },
  }, 'What the engine computed: every figure and check. The desktop shows it; it never computes one.'),
  FsVersionDetail: open(['versionNo', 'status', 'finalizedAt', 'finalizedByName', 'validationOverride', 'overrideReason', 'pageCount', 'stale', 'model'], {
    versionNo: int, status: { type: 'string' }, finalizedAt: nullable('string'), finalizedByName: nullable('string'),
    validationOverride: bool, overrideReason: nullable('string'), pageCount: nullable('integer'), stale: bool,
    model: ref('FsRenderedReport'),
  }),
  FsFinalized: open(['versionNo', 'pageCount', 'validationOverride', 'periodUnlocked'], {
    versionNo: int, pageCount: int, validationOverride: bool,
    periodUnlocked: { type: 'boolean', description: 'The period is not locked; its balances can still change' },
  }),
  FsLetterhead: open(['displayName', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'phone', 'email', 'website', 'logoDataUri', 'accountantSignature', 'letterheadAlign', 'letterheadContent', 'logoSize', 'updatedAt'], {
    displayName: nullable('string'), addressLine1: nullable('string'), addressLine2: nullable('string'),
    city: nullable('string'), state: nullable('string'), postalCode: nullable('string'),
    phone: nullable('string'), email: nullable('string'), website: nullable('string'),
    logoDataUri: nullable('string'), accountantSignature: nullable('string'),
    letterheadAlign: { type: 'string', enum: ['left', 'center', 'right'] },
    letterheadContent: { type: 'string', enum: ['both', 'logo', 'text'] },
    logoSize: { type: 'string', enum: ['small', 'medium', 'content_width', 'full_bleed'] },
    updatedAt: nullable('string'),
  }),
  FsLetterheadInput: closed([], {
    displayName: { ...nullable('string'), maxLength: 200 }, addressLine1: { ...nullable('string'), maxLength: 200 },
    addressLine2: { ...nullable('string'), maxLength: 200 }, city: { ...nullable('string'), maxLength: 100 },
    state: { ...nullable('string'), maxLength: 50 }, postalCode: { ...nullable('string'), maxLength: 20 },
    phone: { ...nullable('string'), maxLength: 50 }, email: { ...nullable('string'), maxLength: 200 },
    website: { ...nullable('string'), maxLength: 200 },
    logoDataUri: { type: ['string', 'null'], pattern: '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$', description: 'A PNG or JPEG of about 700 KB at most' },
    accountantSignature: { ...nullable('string'), maxLength: 300 },
    letterheadAlign: { type: 'string', enum: ['left', 'center', 'right'] },
    letterheadContent: { type: 'string', enum: ['both', 'logo', 'text'] },
    logoSize: { type: 'string', enum: ['small', 'medium', 'content_width', 'full_bleed'] },
  }),
  FsLetter: open(['id', 'name', 'letterType', 'title', 'bodyHtml', 'isActive', 'isDefault', 'builtin', 'updatedAt'], {
    id: int, name: { type: 'string' }, letterType: { type: 'string', enum: ['compilation', 'preparation'] },
    title: nullable('string'), bodyHtml: { type: 'string' }, isActive: bool, isDefault: bool, builtin: bool, updatedAt: nullable('string'),
  }),
  FsLetterInput: closed([], {
    name: str(200, { minLength: 1 }), letterType: { type: 'string', enum: ['compilation', 'preparation'] },
    title: { ...nullable('string'), maxLength: 200 }, bodyHtml: str(3000000), isDefault: bool, isActive: bool,
  }, 'All of name, letterType and bodyHtml to create; any of them to change'),
  FsStylePreset: open(['id', 'name', 'style', 'isDefault', 'builtin', 'updatedAt'], {
    id: int, name: { type: 'string' }, style: ref('FsStyle'), isDefault: bool, builtin: bool, updatedAt: nullable('string'),
  }),
  FsStylePresetInput: closed([], { name: str(200, { minLength: 1 }), style: ref('FsStyle'), isDefault: bool }, 'name and style to create; any of them to change'),
  FsLayoutTemplate: open(['id', 'name', 'description', 'entityKind', 'layout', 'isDefault', 'updatedAt'], {
    id: int, name: { type: 'string' }, description: nullable('string'),
    entityKind: { type: 'string', enum: ['corporation', 'partnership', 'llc', 'sole_prop', 'any'] },
    layout: ref('FsLayout'), isDefault: bool, updatedAt: nullable('string'),
  }),
  FsLayoutTemplateInput: closed(['name', 'entityKind', 'layout'], {
    name: str(200, { minLength: 1 }), description: { ...nullable('string'), maxLength: 1000 },
    entityKind: { type: 'string', enum: ['corporation', 'partnership', 'llc', 'sole_prop', 'any'] },
    layout: ref('FsLayout'), isDefault: bool,
  }),
  FsLayoutTemplatePatch: closed([], {
    name: str(200, { minLength: 1 }), description: { ...nullable('string'), maxLength: 1000 },
    entityKind: { type: 'string', enum: ['corporation', 'partnership', 'llc', 'sole_prop', 'any'] }, isDefault: bool,
  }),
  FsLibrary: open(['letterhead', 'letters', 'presets', 'templates'], {
    letterhead: ref('FsLetterhead'),
    letters: { type: 'array', items: ref('FsLetter'), description: 'Active letters only' },
    presets: { type: 'array', items: ref('FsStylePreset') },
    templates: { type: 'array', items: ref('FsLayoutTemplate') },
  }, 'The firm library (seeded on first read)'),
  FsBindPreview: open(['unresolved', 'groupings'], {
    unresolved: {
      type: 'array',
      items: open(['nodeId', 'statementId', 'leadsheetCode', 'caption'], {
        nodeId: { type: 'string' }, statementId: { type: 'string' }, leadsheetCode: nullable('string'), caption: { type: 'string' },
      }),
    },
    groupings: { type: 'array', items: open(['id', 'code', 'name'], { id: { type: 'string' }, code: nullable('string'), name: { type: 'string' } }) },
  }, 'Template lines no lead sheet of the client matches, and the client\'s lead sheets to choose from'),
  FsPickAccount: open(['id', 'number', 'name', 'accountType', 'leadSheetId'], {
    id: { type: 'string' }, number: nullable('string'), name: { type: 'string' },
    accountType: { type: 'string', enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] },
    leadSheetId: nullable('string'),
  }),
  FsCashFlowClassification: open(['classes', 'leadSheets', 'accounts'], {
    classes: { type: 'array', items: cfClass },
    leadSheets: { type: 'array', items: open(['id', 'code', 'name', 'override'], { id: { type: 'string' }, code: nullable('string'), name: { type: 'string' }, override: { oneOf: [{ type: 'null' }, cfClass] } }) },
    accounts: {
      type: 'array',
      items: open(['id', 'number', 'name', 'accountType', 'leadSheetId', 'override', 'fallback', 'fallbackSource'], {
        id: { type: 'string' }, number: nullable('string'), name: { type: 'string' },
        accountType: { type: 'string', enum: ['asset', 'liability', 'equity'] }, leadSheetId: nullable('string'),
        override: { oneOf: [{ type: 'null' }, cfClass] },
        fallback: cfClass,
        fallbackSource: { type: 'string', enum: ['chart_of_accounts', 'lead_sheet', 'default'], description: 'Where the class without an override comes from' },
      }),
    },
  }, 'Balance sheet accounts and lead sheets with their Statement Writer cash flow class'),
  FsCashFlowOverridesInput: closed(['overrides'], {
    overrides: {
      type: 'array', maxItems: 1000,
      items: closed(['classification'], {
        accountId: { type: ['string', 'null'], pattern: '^-?\\d{1,15}$' },
        groupingId: { type: ['string', 'null'], pattern: '^-?\\d{1,15}$' },
        classification: { oneOf: [{ type: 'null' }, cfClass], description: 'null removes the override' },
      }, 'Exactly one of accountId and groupingId'),
    },
  }),
  FsEquityRoles: open(['accounts'], {
    accounts: {
      type: 'array',
      items: open(['id', 'number', 'name', 'role', 'defaultRole', 'isFold'], {
        id: { type: 'string' }, number: nullable('string'), name: { type: 'string' },
        role: { oneOf: [{ type: 'null' }, equityRole] }, defaultRole: equityRole,
        isFold: { type: 'boolean', description: 'Net income is closed into this account' },
      }),
    },
  }),
  FsEquityRolesInput: closed(['roles'], {
    roles: {
      type: 'array', maxItems: 500,
      items: closed(['accountId', 'role'], { accountId: fsId, role: { oneOf: [{ type: 'null' }, equityRole], description: 'null: back to the default by name' }, isFold: bool }),
    },
  }, 'At most one account receives net income'),
  FsSavedToFolder: open(['documentId', 'filename', 'objectKey', 'sizeBytes'], {
    documentId: int, filename: { type: 'string' }, objectKey: { type: 'string' }, sizeBytes: int,
  }),
};

// ─── Paths ───────────────────────────────────────────────────────────

const env = (data: Schema, withMeta = false): Schema => {
  const properties: Schema = { data, error: { type: 'null' } };
  if (withMeta) properties.meta = ref('ListMeta');
  return { type: 'object', required: ['data', 'error'], properties };
};
const answer = (description: string, data: Schema, withMeta = false): Schema => ({
  description, content: { 'application/json': { schema: env(data, withMeta) } },
});
const err = (description: string): Schema => ({ description, content: { 'application/json': { schema: ref('ErrorEnvelope') } } });
const common: Schema = { '401': err('Missing or wrong desktop session token'), '500': err('Server error') };
const body = (schema: Schema): Schema => ({ required: true, content: { 'application/json': { schema } } });
const pathId = (name: string): Schema => ({ name, in: 'path', required: true, schema: { type: 'integer', minimum: 1 } });
const pdf = (description: string): Schema => ({ description, content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } });
const pdfErrors: Schema = {
  '503': err('PDF_ENGINE_UNAVAILABLE (no browser, or it could not be started), PDF_BUSY or PDF_TIMEOUT'),
};
const tags = ['statement-writer'];
const op = (operationId: string, summary: string, rest: Schema): Schema => ({ operationId, tags, summary, ...rest });
const v1 = '/api/v1';

export const fsPaths: Record<string, Schema> = {
  [`${v1}/fs/status`]: {
    get: op('getFsStatus', 'Whether a browser to draw PDFs with was found', { responses: { '200': answer('Status', open(['pdfEngine'], { pdfEngine: ref('FsPdfEngineStatus') })), ...common } }),
  },
  [`${v1}/fs/pdf-engine`]: {
    put: op('setFsPdfEngine', 'The browser to draw PDFs with (admin); null finds one', {
      requestBody: body(closed(['chromiumPath'], { chromiumPath: { ...nullable('string'), maxLength: 500 } })),
      responses: { '200': answer('Status', open(['pdfEngine'], { pdfEngine: ref('FsPdfEngineStatus') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), ...common },
    }),
  },
  [`${v1}/fs/pdf-engine/test`]: {
    post: op('testFsPdfEngine', 'Start the browser and print one page (admin)', {
      responses: { '200': answer('Printed', open(['ok', 'bytes'], { ok: { const: true }, bytes: int })), '403': err('FORBIDDEN'), ...pdfErrors, ...common },
    }),
  },
  [`${v1}/fs/library`]: {
    get: op('getFsLibrary', 'Letterhead, letters, style presets and layout templates', { responses: { '200': answer('Library', ref('FsLibrary')), ...common } }),
  },
  [`${v1}/fs/library/letterhead`]: {
    put: op('saveFsLetterhead', 'Save the letterhead (admin); a field left out is kept, null or an empty string clears it', {
      requestBody: body(ref('FsLetterheadInput')),
      responses: { '200': answer('Saved', open(['letterhead'], { letterhead: ref('FsLetterhead') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), ...common },
    }),
  },
  [`${v1}/fs/library/letters`]: {
    post: op('createFsLetter', 'A new accountant\'s report letter (admin)', {
      requestBody: body(ref('FsLetterInput')),
      responses: { '201': answer('Created', open(['letter'], { letter: ref('FsLetter') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), ...common },
    }),
  },
  [`${v1}/fs/library/letters/{letterId}`]: {
    parameters: [pathId('letterId')],
    put: op('updateFsLetter', 'Change a letter (admin)', {
      requestBody: body(ref('FsLetterInput')),
      responses: { '200': answer('Saved', open(['letter'], { letter: ref('FsLetter') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), '404': err('NOT_FOUND'), ...common },
    }),
    delete: op('retireFsLetter', 'Retire a letter (admin); reports that chose it fall back to the default one', {
      responses: { '200': answer('Retired', ok), '403': err('FORBIDDEN'), '404': err('NOT_FOUND'), ...common },
    }),
  },
  [`${v1}/fs/library/presets`]: {
    post: op('createFsPreset', 'A new firm style (admin)', {
      requestBody: body(ref('FsStylePresetInput')),
      responses: { '201': answer('Created', open(['preset'], { preset: ref('FsStylePreset') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), ...common },
    }),
  },
  [`${v1}/fs/library/presets/{presetId}`]: {
    parameters: [pathId('presetId')],
    put: op('updateFsPreset', 'Change a firm style (admin)', {
      requestBody: body(ref('FsStylePresetInput')),
      responses: { '200': answer('Saved', open(['preset'], { preset: ref('FsStylePreset') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), '404': err('NOT_FOUND'), ...common },
    }),
    delete: op('deleteFsPreset', 'Delete a firm style (admin); layouts keep their own copy of the style', {
      responses: { '200': answer('Deleted', ok), '403': err('FORBIDDEN'), '404': err('NOT_FOUND'), ...common },
    }),
  },
  [`${v1}/fs/library/templates`]: {
    post: op('createFsTemplate', 'A new layout template (admin); lead sheet codes only', {
      requestBody: body(ref('FsLayoutTemplateInput')),
      responses: { '201': answer('Created', open(['template'], { template: ref('FsLayoutTemplate') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), ...common },
    }),
  },
  [`${v1}/fs/library/templates/{templateId}`]: {
    parameters: [pathId('templateId')],
    put: op('updateFsTemplate', 'Rename or describe a template (admin)', {
      requestBody: body(ref('FsLayoutTemplatePatch')),
      responses: { '200': answer('Saved', open(['template'], { template: ref('FsLayoutTemplate') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), '404': err('NOT_FOUND'), ...common },
    }),
    delete: op('deleteFsTemplate', 'Delete a template (admin)', {
      responses: { '200': answer('Deleted', ok), '403': err('FORBIDDEN'), '404': err('NOT_FOUND'), ...common },
    }),
  },
  [`${v1}/fs/layouts/{layoutId}`]: {
    parameters: [pathId('layoutId')],
    get: op('getFsLayout', 'A client layout and its style', { responses: { '200': answer('Layout', open(['layout'], { layout: ref('FsClientLayout') })), '404': err('NOT_FOUND'), ...common } }),
    patch: op('saveFsLayout', 'Save a client layout; every statement set that uses it changes', {
      requestBody: body(ref('FsLayoutUpdate')),
      responses: {
        '200': answer('Saved', open(['layout'], { layout: ref('FsClientLayout') })),
        '400': err('VALIDATION_ERROR (also: an account or lead sheet that is not the client\'s)'),
        '404': err('NOT_FOUND'),
        '409': err('FS_CONFLICT: changed since it was read; details.updatedAt is the time now'),
        ...common,
      },
    }),
  },
  [`${v1}/fs/layouts/{layoutId}/save-as-template`]: {
    parameters: [pathId('layoutId')],
    post: op('saveFsLayoutAsTemplate', 'Copy a client layout into the firm library (admin); accounts and lead sheets become codes', {
      requestBody: body(closed(['name'], {
        name: str(200, { minLength: 1 }), description: { ...nullable('string'), maxLength: 1000 },
        entityKind: { type: 'string', enum: ['corporation', 'partnership', 'llc', 'sole_prop', 'any'] },
      })),
      responses: { '201': answer('Created', open(['template'], { template: ref('FsLayoutTemplate') })), '400': err('VALIDATION_ERROR'), '403': err('FORBIDDEN'), '404': err('NOT_FOUND'), ...common },
    }),
  },
  [`${v1}/fs/reports/{reportId}`]: {
    parameters: [pathId('reportId')],
    get: op('getFsReport', 'A statement set: settings, front matter, its layout, its period and its versions', { responses: { '200': answer('Report', ref('FsReportDetail')), '404': err('NOT_FOUND'), ...common } }),
    patch: op('updateFsReport', 'Change a draft\'s name, settings or front matter', {
      requestBody: body(ref('FsUpdateReport')),
      responses: { '200': answer('Report', ref('FsReportDetail')), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), '423': err('FS_FINAL_LOCKED: final; reopen first'), ...common },
    }),
    delete: op('archiveFsReport', 'Archive a statement set; its issued versions are kept', { responses: { '200': answer('Archived', ok), '404': err('NOT_FOUND'), ...common } }),
  },
  [`${v1}/fs/reports/{reportId}/roll-forward`]: {
    parameters: [pathId('reportId')],
    post: op('rollFsReportForward', 'A new draft in another period of the client, on the same layout', {
      requestBody: body(closed(['periodId'], { periodId: { type: 'integer', minimum: 1 }, name: str(200, { minLength: 1 }) })),
      responses: { '201': answer('Created', idOnly('report')), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), ...common },
    }),
  },
  [`${v1}/fs/reports/{reportId}/compute`]: {
    parameters: [pathId('reportId')],
    post: op('computeFsReport', 'Every figure and check, from the saved report or the unsaved changes sent', {
      requestBody: body(ref('FsDraftOverrides')),
      responses: { '200': answer('Computed', open(['model'], { model: ref('FsRenderedReport') })), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), ...common },
    }),
  },
  [`${v1}/fs/reports/{reportId}/preview.pdf`]: {
    parameters: [pathId('reportId')],
    get: op('getFsPreviewPdf', 'The exact PDF of the saved draft (DRAFT on every page)', {
      responses: { '200': pdf('The proof'), '404': err('NOT_FOUND'), ...pdfErrors, ...common },
    }),
    post: op('postFsPreviewPdf', 'The exact PDF with the unsaved changes sent', {
      requestBody: body(ref('FsDraftOverrides')),
      responses: { '200': pdf('The proof'), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), ...pdfErrors, ...common },
    }),
  },
  [`${v1}/fs/reports/{reportId}/export`]: {
    parameters: [
      pathId('reportId'),
      { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['pdf', 'docx', 'xlsx'], default: 'pdf' } },
      { name: 'version', in: 'query', required: false, description: 'An issued version (its stored PDF); without it, the draft', schema: { type: 'integer', minimum: 1 } },
    ],
    get: op('exportFsReport', 'Download as PDF, Word or Excel', {
      responses: {
        '200': {
          description: 'The file',
          content: Object.fromEntries([
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ].map((t) => [t, { schema: { type: 'string', format: 'binary' } }])),
        },
        '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), ...pdfErrors, ...common,
      },
    }),
  },
  [`${v1}/fs/reports/{reportId}/finalize`]: {
    parameters: [pathId('reportId')],
    post: op('finalizeFsReport', 'Issue the next version: the PDF is drawn first, then the version is written', {
      requestBody: body(ref('FsFinalizeRequest')),
      responses: {
        '200': answer('Finalized', ref('FsFinalized')),
        '400': err('VALIDATION_ERROR (an override without a reason)'),
        '404': err('NOT_FOUND'),
        '422': err('FS_VALIDATION: checks failed; details.checks lists them'),
        '423': err('FS_FINAL_LOCKED: already final'),
        ...pdfErrors, ...common,
      },
    }),
  },
  [`${v1}/fs/reports/{reportId}/reopen`]: {
    parameters: [pathId('reportId')],
    post: op('reopenFsReport', 'Make a final statement set a draft again; the next finalize is the next version', {
      responses: { '200': answer('Reopened', ok), '400': err('FS_NOT_FINAL'), '404': err('NOT_FOUND'), ...common },
    }),
  },
  [`${v1}/fs/reports/{reportId}/versions/{versionNo}`]: {
    parameters: [pathId('reportId'), pathId('versionNo')],
    get: op('getFsVersion', 'An issued version and what it said', { responses: { '200': answer('Version', ref('FsVersionDetail')), '404': err('NOT_FOUND'), ...common } }),
  },
  [`${v1}/fs/reports/{reportId}/versions/{versionNo}/impact`]: {
    parameters: [pathId('reportId'), pathId('versionNo')],
    get: op('getFsVersionImpact', 'Whether the books changed since it was issued, and whether its figures would', {
      responses: { '200': answer('Impact', open(['stale', 'changed'], { stale: bool, changed: bool })), '404': err('NOT_FOUND'), ...common },
    }),
  },
  [`${v1}/fs/reports/{reportId}/versions/{versionNo}/save-to-folder`]: {
    parameters: [pathId('reportId'), pathId('versionNo')],
    post: op('saveFsVersionToDocuments', 'Copy the issued PDF into the client\'s documents (workpapers)', {
      responses: { '201': answer('Saved', ref('FsSavedToFolder')), '404': err('NOT_FOUND'), ...pdfErrors, ...common },
    }),
  },
  [`${v1}/clients/{clientId}/fs/reports`]: {
    parameters: [pathId('clientId')],
    get: op('listFsReports', 'The client\'s statement sets, newest period first', {
      responses: { '200': answer('Reports', open(['reports'], { reports: { type: 'array', items: ref('FsReportSummary') } }), true), ...common },
    }),
  },
  [`${v1}/clients/{clientId}/fs/layouts`]: {
    parameters: [pathId('clientId')],
    get: op('listFsLayouts', 'The client\'s layouts', { responses: { '200': answer('Layouts', open(['layouts'], { layouts: { type: 'array', items: ref('FsLayoutSummary') } })), ...common } }),
  },
  [`${v1}/clients/{clientId}/fs/bind-preview`]: {
    parameters: [pathId('clientId'), { name: 'templateId', in: 'query', required: false, description: 'Without it: the built-in default layout', schema: { type: 'integer', minimum: 1 } }],
    get: op('previewFsBinding', 'Which lines of a template find no lead sheet of the client', { responses: { '200': answer('Binding', ref('FsBindPreview')), '400': err('INVALID_ID'), '404': err('NOT_FOUND'), ...common } }),
  },
  [`${v1}/clients/{clientId}/fs/accounts`]: {
    parameters: [pathId('clientId')],
    get: op('listFsAccounts', 'The client\'s active accounts, for the editor\'s pickers', {
      responses: { '200': answer('Accounts', open(['accounts'], { accounts: { type: 'array', items: ref('FsPickAccount') } })), ...common },
    }),
  },
  [`${v1}/clients/{clientId}/fs/cash-flow-overrides`]: {
    parameters: [pathId('clientId')],
    get: op('getFsCashFlowClasses', 'The cash flow class of each balance sheet account and lead sheet', { responses: { '200': answer('Classes', ref('FsCashFlowClassification')), ...common } }),
    put: op('saveFsCashFlowClasses', 'Set or remove overrides', {
      requestBody: body(ref('FsCashFlowOverridesInput')),
      responses: { '200': answer('Saved', ok), '400': err('VALIDATION_ERROR'), ...common },
    }),
  },
  [`${v1}/clients/{clientId}/fs/equity-roles`]: {
    parameters: [pathId('clientId')],
    get: op('getFsEquityRoles', 'The role of each equity account, and where net income goes', { responses: { '200': answer('Roles', ref('FsEquityRoles')), ...common } }),
    put: op('saveFsEquityRoles', 'Set roles', {
      requestBody: body(ref('FsEquityRolesInput')),
      responses: { '200': answer('Saved', ok), '400': err('VALIDATION_ERROR'), ...common },
    }),
  },
  [`${v1}/periods/{periodId}/fs/reports`]: {
    parameters: [pathId('periodId')],
    post: op('createFsReport', 'A new statement set for the period', {
      requestBody: body(ref('FsCreateReport')),
      responses: { '201': answer('Created', idOnly('report')), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), ...common },
    }),
  },
};
