// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Claude Desktop's tools for every area of the app (P10b, Q105), made from
// the desktop's own API description (openapi.ts): each operation the app's
// screens use becomes a tool named after its operationId, described by its
// summary, taking its path and query parameters and its request body. Every
// operation is either a tool here or in EXCLUDED with the reason
// (mcpSpecTools.test.ts holds the two together), so a route added to the
// description is decided, never silently left out or silently exposed.
// A file the route answers with (a PDF, a workbook, a document) is saved on
// this computer and its place returned; a file a route takes is read from a
// path on this computer.

import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApiSpec } from './openapi';
import type { DesktopTool, ToolContext, ToolResult } from './mcpTools';
import { ToolError } from './mcpTools';
import { reportsExcluded } from './openapiReports';

type Json = Record<string, unknown>;
type Schema = Record<string, unknown>;

const COA_TEMPLATES = "chart of accounts templates are the firm's, set up on their screen (P13, Q112)";

/** Operations that are not tools, and why (owner 2026-11-20, Q105, unless said). */
export const EXCLUDED: Record<string, string> = {
  // The statement and report PDFs and M-1 (openapiReports.ts): the
  // desktop's own tools do them.
  ...reportsExcluded,
  // The app's own plumbing.
  ping: 'plumbing',
  health: 'plumbing',
  openapi: 'plumbing',
  getFeatures: 'plumbing',
  desktopMe: 'the name on this PC is set on its screen',
  setDesktopMe: 'the name on this PC is set on its screen',
  // Settings stay on the Settings screen; no secret goes through Claude (owner).
  saveFirm: 'settings (owner: not through Claude)',
  getLlmProvider: 'AI settings and keys (owner: not through Claude)',
  saveLlmProvider: 'AI settings and keys (owner: not through Claude)',
  listProviderModels: 'AI settings and keys (owner: not through Claude)',
  testLlm: 'AI settings and keys (owner: not through Claude)',
  setFsPdfEngine: 'settings (owner: not through Claude)',
  testFsPdfEngine: 'settings (owner: not through Claude)',
  // The firm server (owner: not through Claude).
  syncExportClient: 'firm server sync (owner: not through Claude)',
  syncExportPeriod: 'firm server sync (owner: not through Claude)',
  syncIds: 'firm server sync (owner: not through Claude)',
  syncImport: 'firm server sync (owner: not through Claude)',
  syncPeriodStamp: 'firm server sync (owner: not through Claude)',
  syncPeriodChanges: 'firm server sync (owner: not through Claude)',
  syncVersion: 'firm server sync (owner: not through Claude)',
  // Backups and restores are the app's (encryption, second copy, safety
  // backup, engine restart): through the running app, a later slice.
  writeFullBackup: "the engine's raw writer: back_up_now makes the app's backup (history, second copy, passphrase, check)",
  backupClient: 'backups are made by the app: back_up_now, list_backups, restore_backup (the relay)',
  desktopBackupClient: 'backups are made by the app: back_up_now, list_backups, restore_backup (the relay)',
  extractClient: 'restores are run by the app: restore_backup (the relay)',
  stageRestore: 'restores are run by the app: restore_backup (the relay)',
  executeRestore: 'restores are run by the app: restore_backup (the relay)',
  placeClientFiles: 'restores are run by the app: restore_backup (the relay)',
  // The app's own assistant.
  supportChat: "the app's own assistant",
  listConversations: "the app's own assistant",
  getConversation: "the app's own assistant",
  updateConversation: "the app's own assistant",
  deleteConversation: "the app's own assistant",
  toggleConversationBookmark: "the app's own assistant",
  // Reading a file with the app's AI: Claude reads the file itself and sends
  // what it read (load_trial_balance, add_bank_transactions).
  analyzeBankStatementPdf: 'Claude reads the statement itself: add_bank_transactions',
  analyzeCsvImport: 'Claude reads the report itself: load_trial_balance',
  analyzePdfTrialBalance: 'Claude reads the report itself: load_trial_balance',
  confirmPdfTrialBalance: 'Claude reads the report itself: load_trial_balance',
  confirmCsvImport: 'load_trial_balance',
  // Covered by a desktop tool with plainer inputs (mcpTools.ts).
  importBankRows: 'add_bank_transactions',
  listBankTransactions: 'list_bank_transactions',
  classifyBankTransactions: 'categorize_bank_transactions',
  updateBankTransaction: 'update_bank_transaction',
  deleteBankTransactions: 'delete_bank_transactions',
  setBankTransactionsSource: 'set_bank_account',
  listAvailableTaxCodes: 'list_tax_codes',
  // Upstream's tool of the same purpose (mcp/server.ts).
  listClients: "upstream's list_clients",
  getTrialBalance: "upstream's get_trial_balance",
  listJournalEntries: "upstream's list_journal_entries",
  createJournalEntry: "upstream's create_journal_entry",
  runDiagnostics: "upstream's run_diagnostics",
  suggestTaxCodes: "upstream's auto_assign_tax_codes",
  listEngagementTasks: "upstream's list_engagement_tasks",
  updateEngagementTask: "upstream's update_engagement_task",
  listTaxCodes: 'list_tax_codes (the codes a client can use, with ids)',
  getDraftReport: 'save_report (every report, final or DRAFT, with its options)',
  // Chart of accounts templates (P13). Not tools yet (Q112); Claude sets up a
  // client's chart with create_account. Apply's replace mode deletes a chart.
  listCoaTemplates: COA_TEMPLATES,
  createCoaTemplate: COA_TEMPLATES,
  getCoaTemplate: COA_TEMPLATES,
  updateCoaTemplate: COA_TEMPLATES,
  deleteCoaTemplate: COA_TEMPLATES,
  addCoaTemplateAccount: COA_TEMPLATES,
  updateCoaTemplateAccount: COA_TEMPLATES,
  deleteCoaTemplateAccount: COA_TEMPLATES,
  saveChartAsCoaTemplate: COA_TEMPLATES,
  exportCoaTemplate: COA_TEMPLATES,
  previewCoaTemplateImport: COA_TEMPLATES,
  importCoaTemplate: COA_TEMPLATES,
  applyCoaTemplate: `${COA_TEMPLATES}; its replace mode deletes a client's whole chart`,
};

/** `classifyBankTransactions` → `classify_bank_transactions`. */
export function toolName(operationId: string): string {
  return operationId.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

/** Bytes past which a referenced object is named rather than written out. */
const INLINE_LIMIT = 2500;

/** A large object named rather than written out: Claude reads one with the
    matching get tool, changes it and sends it back; the engine checks it. */
function named(name: string, s: Schema): Schema {
  return {
    type: s.type ?? 'object',
    description: `A ${name} object in the shape the engine returns it (read one first with the matching get tool, change it and send it back); the engine checks it and says what is wrong.`,
  };
}

/** A schema with its `$ref`s written out (to a depth; deeper ones become plain objects). */
function inline(s: unknown, components: Record<string, Schema>, depth = 0): unknown {
  if (Array.isArray(s)) return s.map((x) => inline(x, components, depth));
  if (!s || typeof s !== 'object') return s;
  const o = s as Schema;
  if (typeof o.$ref === 'string') {
    const name = o.$ref.split('/').pop()!;
    const target = components[name] ?? { type: 'object' };
    if (depth > 6) return { type: target.type ?? 'object' };
    const full = inline(target, components, depth + 1);
    // A large object (a statement layout, a style) is named, not spelled out:
    // its full grammar would make every conversation carry tens of thousands
    // of tokens. Claude reads one with the matching get tool, changes it and
    // sends it back; the engine checks it and says what is wrong.
    if (JSON.stringify(full).length <= INLINE_LIMIT) return full;
    // Too large whole: its own fields kept, the large ones inside named.
    const props = (full as Schema).properties as Record<string, Schema> | undefined;
    if (props && depth < 2) {
      const kept: Record<string, Schema> = {};
      for (const [k, v] of Object.entries(props)) {
        kept[k] = JSON.stringify(v).length <= INLINE_LIMIT / 2 ? v : named(k, v);
      }
      return { ...(full as Schema), properties: kept };
    }
    return named(name, full as Schema);
  }
  const out: Schema = {};
  for (const [k, v] of Object.entries(o)) out[k] = inline(v, components, depth);
  return out;
}

interface Param { name: string; in: string; required?: boolean; description?: string; schema?: Schema }

interface Operation {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  params: Param[];
  jsonBody?: Schema;
  /** The route requires its body (otherwise it may be left out). */
  bodyRequired: boolean;
  multipart?: Schema;
  fileAnswer: boolean;
}

/** Every operation the desktop's API description lists. */
export function operations(spec: Schema = buildOpenApiSpec() as Schema): Operation[] {
  const components = ((spec.components as Schema)?.schemas ?? {}) as Record<string, Schema>;
  const out: Operation[] = [];
  for (const [p, item] of Object.entries(spec.paths as Record<string, Schema>)) {
    const shared = (item.parameters ?? []) as Param[];
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const o = item[m] as Schema | undefined;
      if (!o) continue;
      const content = ((o.requestBody as Schema | undefined)?.content ?? {}) as Record<string, { schema?: Schema }>;
      const answers = (((o.responses as Schema | undefined)?.['200'] as Schema | undefined)?.content ?? {}) as Record<string, unknown>;
      const answerTypes = Object.keys(answers);
      out.push({
        operationId: String(o.operationId),
        method: m.toUpperCase() as Operation['method'],
        path: p,
        summary: String(o.summary ?? ''),
        params: [...shared, ...((o.parameters ?? []) as Param[])].map((x) => inline(x, components) as Param),
        jsonBody: content['application/json']?.schema ? (inline(content['application/json'].schema, components) as Schema) : undefined,
        bodyRequired: (o.requestBody as Schema | undefined)?.required === true,
        multipart: content['multipart/form-data']?.schema ? (inline(content['multipart/form-data'].schema, components) as Schema) : undefined,
        fileAnswer: answerTypes.length > 0 && !answerTypes.includes('application/json'),
      });
    }
  }
  return out;
}

/** Where a file a tool brings back is saved: the folder Claude names, else the default. */
function saveFolder(args: Json, fallback: string): string {
  const dir = typeof args.saveToFolder === 'string' && args.saveToFolder.trim() ? args.saveToFolder.trim() : fallback;
  if (!path.isAbsolute(dir)) throw new ToolError('saveToFolder must be a full path on this computer.');
  return dir;
}

/** A file's type by its extension, as a browser would send it. */
export function mimeOf(file: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.csv': 'text/csv', '.txt': 'text/plain',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function fileNameFrom(disposition: string | null, fallback: string): string {
  const star = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition?.match(/filename="?([^";]+)"?/i);
  const raw = star ? decodeURIComponent(star[1]) : plain?.[1] ?? fallback;
  // Never a path: the engine's name, made safe for this computer.
  return path.basename(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || fallback;
}

function makeTool(op: Operation, reportFolder: () => string): DesktopTool {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const p of op.params) {
    if (p.in !== 'path' && p.in !== 'query') continue;
    properties[p.name] = { ...(p.schema ?? { type: 'string' }), ...(p.description ? { description: p.description } : {}) };
    if (p.in === 'path' || p.required) required.push(p.name);
  }
  if (op.jsonBody) {
    properties.body = op.jsonBody;
    if (op.bodyRequired) required.push('body');
  }
  if (op.multipart) {
    const fields = ((op.multipart.properties ?? {}) as Record<string, Schema>);
    for (const [k, v] of Object.entries(fields)) {
      if ((v as Schema).format === 'binary') {
        properties.filePath = { type: 'string', description: 'The full path of the file on this computer' };
        required.push('filePath');
      } else {
        properties[k] = v;
      }
    }
  }
  if (op.fileAnswer) {
    properties.saveToFolder = { type: 'string', description: 'Optional: the full path of a folder on this computer to save the file in' };
  }
  const notes = [
    op.summary,
    'Amounts are integer cents.',
    op.fileAnswer ? 'The file is saved on this computer and its place is returned.' : '',
  ].filter(Boolean);
  return {
    name: toolName(op.operationId),
    reads: op.method === 'GET',
    description: notes.join(' '),
    inputSchema: { type: 'object', properties, required },
    async run(ctx: ToolContext, args: Json): Promise<ToolResult> {
      let url = op.path;
      const query = new URLSearchParams();
      for (const p of op.params) {
        const v = args[p.name];
        if (p.in === 'path') {
          if (v === undefined || v === null || v === '') throw new ToolError(`${p.name} is required.`);
          url = url.replace(`{${p.name}}`, encodeURIComponent(String(v)).replace(/%2F/gi, '/'));
        } else if (p.in === 'query' && v !== undefined && v !== null && v !== '') {
          query.set(p.name, Array.isArray(v) ? v.join(',') : String(v));
        }
      }
      if (query.size > 0) url += `?${query}`;
      if (!ctx.fetch) throw new ToolError('This tool needs the app running.');
      let init: RequestInit = { method: op.method };
      if (op.jsonBody && args.body !== undefined) {
        init = { ...init, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args.body) };
      } else if (op.jsonBody && op.bodyRequired) {
        throw new ToolError('body is required.');
      } else if (op.multipart) {
        const form = new FormData();
        const file = String(args.filePath ?? '');
        if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new ToolError('filePath must be the full path of a file on this computer.');
        for (const [k, v] of Object.entries((op.multipart.properties ?? {}) as Record<string, Schema>)) {
          if (v.format === 'binary') form.set(k, new Blob([fs.readFileSync(file)], { type: mimeOf(file) }), path.basename(file));
          else if (args[k] !== undefined) form.set(k, typeof args[k] === 'string' ? (args[k] as string) : JSON.stringify(args[k]));
        }
        init = { ...init, body: form };
      }
      const res = await ctx.fetch(url, init);
      const type = res.headers.get('content-type') ?? '';
      if (op.fileAnswer && res.ok && !type.includes('application/json')) {
        const dir = saveFolder(args, reportFolder());
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, fileNameFrom(res.headers.get('content-disposition'), `${toolName(op.operationId)}.bin`));
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        return { text: JSON.stringify({ file }, null, 2) };
      }
      const text = await res.text();
      let env: { data?: unknown; error?: { code?: string; message?: string } | null; meta?: unknown } = {};
      try {
        env = text ? JSON.parse(text) : {};
      } catch {
        if (!res.ok) throw new ToolError(`The engine answered ${res.status}.`);
        return { text };
      }
      if (!res.ok || env.error) {
        const why = env.error?.message ?? `The engine answered ${res.status}.`;
        throw new ToolError(env.error?.code ? `${why} (${env.error.code})` : why);
      }
      return { text: JSON.stringify(env.meta !== undefined ? { data: env.data, meta: env.meta } : env.data ?? null, null, 2) };
    },
  };
}

/** The tools made from the API description, all but the excluded operations. */
export function specTools(reportFolder: () => string, spec?: Schema): DesktopTool[] {
  return operations(spec).filter((op) => !(op.operationId in EXCLUDED)).map((op) => makeTool(op, reportFolder));
}
