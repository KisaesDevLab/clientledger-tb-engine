// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { db } from '../db';
import { getClients, getClient, getClientDashboard } from './services/clientService';
import { getPeriods, getPeriod, lockPeriod } from './services/periodService';
import { getTrialBalance, upsertTrialBalance } from './services/trialBalanceService';
import { getJournalEntries, createJournalEntry } from './services/journalEntryService';
import { getChartOfAccounts } from './services/coaService';
import { getTaxMappingStatus, confirmTaxAssignments } from './services/taxService';
import { runDiagnostics } from './services/diagnosticsService';
import { assertNotCheckedOut, logAudit } from '../lib/periodGuard';
import { getMcpAgentUserId, generateMcpAgentJwt } from './auth';

// ── Rate limiting ─────────────────────────────────────────────────────────────

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitBucket>();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Opportunistic sweep threshold: once the map grows past this many keys, drop
// every expired bucket on the next check. Keeps memory bounded without a
// setInterval that would prevent graceful shutdown. A dedicated MCP caller
// never needs more than a handful of live buckets; any growth past this is
// churn from short-lived SSE sessions.
const RATE_LIMIT_SWEEP_THRESHOLD = 1000;

function sweepExpiredBuckets(now: number): void {
  for (const [key, bucket] of rateLimitMap) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
}

function checkRateLimit(token: string): boolean {
  const now = Date.now();
  if (rateLimitMap.size > RATE_LIMIT_SWEEP_THRESHOLD) {
    sweepExpiredBuckets(now);
  }
  const bucket = rateLimitMap.get(token);

  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(token, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX) return false;

  bucket.count++;
  return true;
}

// ── Audit helper for MCP tool calls ──────────────────────────────────────────

async function auditMcpTool(toolName: string, description: string, userId?: number): Promise<void> {
  await logAudit({
    userId: userId ?? null,
    periodId: null,
    entityType: 'mcp_tool',
    entityId: null,
    action: toolName,
    description,
  });
}

// ── Create MCP Server ─────────────────────────────────────────────────────────

export function createMcpServer(rateLimitKey = 'default'): Server {
  // Each transport gets its own server instance; the caller passes a
  // per-session identifier (HTTP: token fingerprint; stdio: 'stdio') so the
  // rate-limit bucket is per-caller rather than a single global bucket that
  // one noisy client could exhaust for everyone.
  const server = new Server(
    { name: 'vibe-tb-mcp', version: '1.0.0' },
    { capabilities: { resources: {}, tools: {}, prompts: {} } },
  );

  // ── RESOURCES ─────────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'clients://all', name: 'All Clients', description: 'List of all clients', mimeType: 'application/json' },
      { uri: 'clients://{clientId}', name: 'Single Client', description: 'Get a client by ID', mimeType: 'application/json' },
      { uri: 'periods://{clientId}/all', name: "Client's Periods", description: 'All periods for a client', mimeType: 'application/json' },
      { uri: 'periods://{periodId}', name: 'Single Period', description: 'Get a period by ID', mimeType: 'application/json' },
      { uri: 'trial-balance://{periodId}', name: 'Trial Balance', description: 'Adjusted trial balance with totals', mimeType: 'application/json' },
      { uri: 'chart-of-accounts://{clientId}', name: 'Chart of Accounts', description: 'COA with tax codes for a client', mimeType: 'application/json' },
      { uri: 'journal-entries://{periodId}', name: 'Journal Entries', description: 'All journal entries for a period', mimeType: 'application/json' },
      { uri: 'dashboard://{periodId}', name: 'Period Dashboard', description: 'Dashboard stats for a period', mimeType: 'application/json' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;

    // clients://all
    if (uri === 'clients://all') {
      const clients = await getClients();
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(clients, null, 2),
        }],
      };
    }

    // clients://{clientId}
    const clientMatch = uri.match(/^clients:\/\/(\d+)$/);
    if (clientMatch) {
      const clientId = Number(clientMatch[1]);
      const client = await getClient(clientId);
      if (!client) throw new Error(`Client ${clientId} not found`);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(client, null, 2) }] };
    }

    // periods://{clientId}/all
    const periodsAllMatch = uri.match(/^periods:\/\/(\d+)\/all$/);
    if (periodsAllMatch) {
      const clientId = Number(periodsAllMatch[1]);
      const periods = await getPeriods(clientId);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(periods, null, 2) }] };
    }

    // periods://{periodId}
    const periodMatch = uri.match(/^periods:\/\/(\d+)$/);
    if (periodMatch) {
      const periodId = Number(periodMatch[1]);
      const period = await getPeriod(periodId);
      if (!period) throw new Error(`Period ${periodId} not found`);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(period, null, 2) }] };
    }

    // trial-balance://{periodId}
    const tbMatch = uri.match(/^trial-balance:\/\/(\d+)$/);
    if (tbMatch) {
      const periodId = Number(tbMatch[1]);
      const tb = await getTrialBalance(periodId);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(tb, null, 2) }] };
    }

    // chart-of-accounts://{clientId}
    const coaMatch = uri.match(/^chart-of-accounts:\/\/(\d+)$/);
    if (coaMatch) {
      const clientId = Number(coaMatch[1]);
      const coa = await getChartOfAccounts(clientId);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(coa, null, 2) }] };
    }

    // journal-entries://{periodId}
    const jeMatch = uri.match(/^journal-entries:\/\/(\d+)$/);
    if (jeMatch) {
      const periodId = Number(jeMatch[1]);
      const entries = await getJournalEntries(periodId);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(entries, null, 2) }] };
    }

    // dashboard://{periodId}
    const dashMatch = uri.match(/^dashboard:\/\/(\d+)$/);
    if (dashMatch) {
      const periodId = Number(dashMatch[1]);
      const dashboard = await getClientDashboard(periodId);
      if (!dashboard) throw new Error(`Period ${periodId} not found`);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(dashboard, null, 2) }] };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  });

  // ── TOOLS ─────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_clients',
        description: 'List all clients in the system',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'get_period_dashboard',
        description: 'Get dashboard stats and recent audit log for a period',
        inputSchema: {
          type: 'object',
          properties: { periodId: { type: 'number', description: 'The period ID' } },
          required: ['periodId'],
        },
      },
      {
        name: 'get_trial_balance',
        description: 'Get the adjusted trial balance for a period, optionally filtered by category',
        inputSchema: {
          type: 'object',
          properties: {
            periodId: { type: 'number', description: 'The period ID' },
            category: { type: 'string', description: 'Optional: filter by category (assets, liabilities, equity, revenue, expenses)' },
          },
          required: ['periodId'],
        },
      },
      {
        name: 'update_trial_balance_row',
        description: 'Update the unadjusted debit/credit balance for an account in a period',
        inputSchema: {
          type: 'object',
          properties: {
            periodId: { type: 'number', description: 'The period ID' },
            accountId: { type: 'number', description: 'The account ID' },
            debitCents: { type: 'number', description: 'Debit balance in cents (integer)' },
            creditCents: { type: 'number', description: 'Credit balance in cents (integer)' },
          },
          required: ['periodId', 'accountId', 'debitCents', 'creditCents'],
        },
      },
      {
        name: 'list_journal_entries',
        description: 'List journal entries for a period, optionally filtered by type',
        inputSchema: {
          type: 'object',
          properties: {
            periodId: { type: 'number', description: 'The period ID' },
            type: { type: 'string', description: 'Optional: filter by type (book, tax, trans)' },
          },
          required: ['periodId'],
        },
      },
      {
        name: 'create_journal_entry',
        description: 'Create a new journal entry (book or tax AJE)',
        inputSchema: {
          type: 'object',
          properties: {
            periodId: { type: 'number', description: 'The period ID' },
            entryType: { type: 'string', enum: ['book', 'tax'], description: 'Entry type' },
            entryDate: { type: 'string', description: 'Entry date in YYYY-MM-DD format' },
            description: { type: 'string', description: 'Optional description' },
            lines: {
              type: 'array',
              description: 'Journal entry lines (must balance)',
              items: {
                type: 'object',
                properties: {
                  accountId: { type: 'number', description: 'Account ID' },
                  debit: { type: 'number', description: 'Debit amount in cents' },
                  credit: { type: 'number', description: 'Credit amount in cents' },
                },
                required: ['accountId', 'debit', 'credit'],
              },
            },
          },
          required: ['periodId', 'entryType', 'entryDate', 'lines'],
        },
      },
      {
        name: 'get_chart_of_accounts',
        description: 'Get chart of accounts for a client, with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'number', description: 'The client ID' },
            category: { type: 'string', description: 'Optional: filter by category' },
            unmapped: { type: 'boolean', description: 'Optional: show only unmapped accounts' },
            search: { type: 'string', description: 'Optional: search by account name or number' },
          },
          required: ['clientId'],
        },
      },
      {
        name: 'get_tax_mapping_status',
        description: 'Get tax code mapping progress for a client',
        inputSchema: {
          type: 'object',
          properties: { clientId: { type: 'number', description: 'The client ID' } },
          required: ['clientId'],
        },
      },
      {
        name: 'auto_assign_tax_codes',
        description: 'Run the 5-step AI waterfall to suggest tax code assignments for unmapped accounts',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'number', description: 'The client ID' },
            accountIds: { type: 'array', items: { type: 'number' }, description: 'Optional: specific account IDs to process' },
            includeAll: { type: 'boolean', description: 'If true, process all accounts including already-mapped ones' },
          },
          required: ['clientId'],
        },
      },
      {
        name: 'confirm_tax_assignments',
        description: 'Bulk-confirm tax code assignments (write them to the database)',
        inputSchema: {
          type: 'object',
          properties: {
            assignments: {
              type: 'array',
              description: 'Array of assignments to confirm',
              items: {
                type: 'object',
                properties: {
                  accountId: { type: 'number', description: 'Account ID' },
                  taxCodeId: { type: ['number', 'null'], description: 'Tax code ID (or null to clear)' },
                  source: { type: 'string', description: 'Source of assignment (e.g., ai, manual)' },
                  confidence: { type: 'number', description: 'Confidence score 0-1' },
                },
                required: ['accountId', 'taxCodeId', 'source', 'confidence'],
              },
            },
          },
          required: ['assignments'],
        },
      },
      {
        name: 'run_diagnostics',
        description: 'Run AI-powered diagnostics on a period (balance check, variance analysis, etc.)',
        inputSchema: {
          type: 'object',
          properties: { periodId: { type: 'number', description: 'The period ID' } },
          required: ['periodId'],
        },
      },
      {
        name: 'lock_period',
        description: 'Lock a period (requires TB to be balanced)',
        inputSchema: {
          type: 'object',
          properties: { periodId: { type: 'number', description: 'The period ID' } },
          required: ['periodId'],
        },
      },
      // Phase 2 tools
      {
        name: 'search_accounts',
        description: 'Search chart of accounts by name fragment across a client',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'number', description: 'The client ID' },
            query: { type: 'string', description: 'Search term (name or account number)' },
          },
          required: ['clientId', 'query'],
        },
      },
      {
        name: 'get_period_comparison',
        description: 'Get multi-period variance comparison between two periods',
        inputSchema: {
          type: 'object',
          properties: {
            periodId: { type: 'number', description: 'Current period ID' },
            comparePeriodId: { type: 'number', description: 'Comparison period ID' },
          },
          required: ['periodId', 'comparePeriodId'],
        },
      },
      {
        name: 'add_variance_note',
        description: 'Add or update a variance note for an account in a period',
        inputSchema: {
          type: 'object',
          properties: {
            periodId: { type: 'number', description: 'The period ID' },
            accountId: { type: 'number', description: 'The account ID' },
            note: { type: 'string', description: 'The variance note text' },
          },
          required: ['periodId', 'accountId', 'note'],
        },
      },
      {
        name: 'list_engagement_tasks',
        description: 'List engagement checklist tasks for a period',
        inputSchema: {
          type: 'object',
          properties: {
            periodId: { type: 'number', description: 'The period ID' },
            status: { type: 'string', description: 'Optional: filter by status (open, in_progress, review, completed, n_a)' },
          },
          required: ['periodId'],
        },
      },
      {
        name: 'update_engagement_task',
        description: 'Update an engagement task status or notes',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'number', description: 'The task ID' },
            status: { type: 'string', description: 'New status (open, in_progress, review, completed, n_a)' },
            notes: { type: 'string', description: 'Optional notes' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'generate_report_url',
        description: 'Returns the URL to download a PDF report for a period',
        inputSchema: {
          type: 'object',
          properties: {
            periodId: { type: 'number', description: 'The period ID' },
            reportType: { type: 'string', description: 'Report type: tb, gl, aje, is, bs, cash-flow, tax-basis-pl, tax-return-order' },
          },
          required: ['periodId', 'reportType'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const mcpUserId = await getMcpAgentUserId();

    // Rate limit check — per-session bucket, so a noisy MCP client cannot
    // starve others. Previously used a single 'global' key; fixed now.
    if (!checkRateLimit(rateLimitKey)) {
      return { content: [{ type: 'text', text: 'Rate limit exceeded: max 100 tool calls per minute' }], isError: true };
    }

    try {
      switch (name) {

        case 'list_clients': {
          const clients = await getClients();
          await auditMcpTool('list_clients', `Listed ${clients.length} clients`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(clients, null, 2) }] };
        }

        case 'get_period_dashboard': {
          const periodId = Number((args as Record<string, unknown>).periodId);
          if (isNaN(periodId)) return { content: [{ type: 'text', text: 'Invalid periodId' }], isError: true };
          const dashboard = await getClientDashboard(periodId);
          if (!dashboard) return { content: [{ type: 'text', text: `Period ${periodId} not found` }], isError: true };
          await auditMcpTool('get_period_dashboard', `Retrieved dashboard for period ${periodId}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(dashboard, null, 2) }] };
        }

        case 'get_trial_balance': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          if (isNaN(periodId)) return { content: [{ type: 'text', text: 'Invalid periodId' }], isError: true };
          const category = typeof a.category === 'string' ? a.category : undefined;
          const tb = await getTrialBalance(periodId, category);
          await auditMcpTool('get_trial_balance', `Retrieved trial balance for period ${periodId}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(tb, null, 2) }] };
        }

        case 'update_trial_balance_row': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          const accountId = Number(a.accountId);
          const debitCents = Number(a.debitCents);
          const creditCents = Number(a.creditCents);
          if (isNaN(periodId) || isNaN(accountId) || isNaN(debitCents) || isNaN(creditCents)) {
            return { content: [{ type: 'text', text: 'Invalid parameters' }], isError: true };
          }
          const result = await upsertTrialBalance(periodId, accountId, debitCents, creditCents, mcpUserId);
          if (!result.success) return { content: [{ type: 'text', text: result.error ?? 'Update failed' }], isError: true };
          await auditMcpTool('update_trial_balance_row', `Updated TB row: period ${periodId}, account ${accountId}, debit ${debitCents} cents, credit ${creditCents} cents`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, periodId, accountId, debitCents, creditCents }) }] };
        }

        case 'list_journal_entries': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          if (isNaN(periodId)) return { content: [{ type: 'text', text: 'Invalid periodId' }], isError: true };
          const type = typeof a.type === 'string' ? a.type : undefined;
          const entries = await getJournalEntries(periodId, type);
          await auditMcpTool('list_journal_entries', `Listed ${entries.length} JEs for period ${periodId}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
        }

        case 'create_journal_entry': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          const entryType = a.entryType as 'book' | 'tax';
          const entryDate = a.entryDate as string;
          const description = typeof a.description === 'string' ? a.description : undefined;
          const lines = a.lines as Array<{ accountId: number; debit: number; credit: number }>;
          if (isNaN(periodId) || !entryType || !entryDate || !lines) {
            return { content: [{ type: 'text', text: 'Missing required parameters' }], isError: true };
          }
          const result = await createJournalEntry({ periodId, entryType, entryDate, description, lines }, mcpUserId);
          if (result.error) return { content: [{ type: 'text', text: result.error }], isError: true };
          await auditMcpTool('create_journal_entry', `Created ${entryType} JE for period ${periodId}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(result.entry, null, 2) }] };
        }

        case 'get_chart_of_accounts': {
          const a = args as Record<string, unknown>;
          const clientId = Number(a.clientId);
          if (isNaN(clientId)) return { content: [{ type: 'text', text: 'Invalid clientId' }], isError: true };
          const coa = await getChartOfAccounts(clientId, {
            category: typeof a.category === 'string' ? a.category : undefined,
            unmapped: typeof a.unmapped === 'boolean' ? a.unmapped : undefined,
            search: typeof a.search === 'string' ? a.search : undefined,
          });
          await auditMcpTool('get_chart_of_accounts', `Retrieved ${coa.length} COA accounts for client ${clientId}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(coa, null, 2) }] };
        }

        case 'get_tax_mapping_status': {
          const a = args as Record<string, unknown>;
          const clientId = Number(a.clientId);
          if (isNaN(clientId)) return { content: [{ type: 'text', text: 'Invalid clientId' }], isError: true };
          const status = await getTaxMappingStatus(clientId);
          if (!status) return { content: [{ type: 'text', text: `Client ${clientId} not found` }], isError: true };
          await auditMcpTool('get_tax_mapping_status', `Retrieved tax mapping status for client ${clientId}: ${status.mappingPercent}% mapped`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
        }

        case 'auto_assign_tax_codes': {
          const a = args as Record<string, unknown>;
          const clientId = Number(a.clientId);
          if (isNaN(clientId)) return { content: [{ type: 'text', text: 'Invalid clientId' }], isError: true };

          // Call the auto-assign logic via the existing route's internal logic
          // We'll use the tax line assignment service API
          const body: Record<string, unknown> = { clientId };
          if (Array.isArray(a.accountIds)) body.accountIds = a.accountIds;
          if (typeof a.includeAll === 'boolean') body.includeAll = a.includeAll;

          // Call the JWT-protected auto-assign endpoint using a short-lived mcp_agent JWT
          const baseUrl = `http://localhost:${process.env.PORT ?? 3001}`;
          const agentJwt = await generateMcpAgentJwt();

          if (!agentJwt) {
            return { content: [{ type: 'text', text: 'MCP agent user not found — run migration 20260320000001_mcp_support' }], isError: true };
          }

          const response = await fetch(`${baseUrl}/api/v1/tax-lines/auto-assign`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${agentJwt}`,
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const errText = await response.text();
            return { content: [{ type: 'text', text: `Auto-assign failed: ${errText}` }], isError: true };
          }

          const data = await response.json() as { data?: unknown; error?: unknown };
          await auditMcpTool('auto_assign_tax_codes', `Auto-assigned tax codes for client ${clientId}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(data.data, null, 2) }] };
        }

        case 'confirm_tax_assignments': {
          const a = args as Record<string, unknown>;
          const assignments = a.assignments as Array<{
            accountId: number;
            taxCodeId: number | null;
            source: string;
            confidence: number;
          }>;
          if (!Array.isArray(assignments) || assignments.length === 0) {
            return { content: [{ type: 'text', text: 'assignments array is required' }], isError: true };
          }
          const result = await confirmTaxAssignments(assignments, mcpUserId);
          await auditMcpTool('confirm_tax_assignments', `Confirmed ${result.updated} tax assignments via MCP`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'run_diagnostics': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          if (isNaN(periodId)) return { content: [{ type: 'text', text: 'Invalid periodId' }], isError: true };
          const result = await runDiagnostics(periodId);
          if ('error' in result) return { content: [{ type: 'text', text: result.error }], isError: true };
          await auditMcpTool('run_diagnostics', `Ran diagnostics for period ${periodId}: ${result.observations.length} observations`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'lock_period': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          if (isNaN(periodId)) return { content: [{ type: 'text', text: 'Invalid periodId' }], isError: true };
          const result = await lockPeriod(periodId, mcpUserId);
          if (result.error) return { content: [{ type: 'text', text: result.error }], isError: true };
          await auditMcpTool('lock_period', `Locked period ${periodId} via MCP`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(result.period, null, 2) }] };
        }

        // Phase 2 tools
        case 'search_accounts': {
          const a = args as Record<string, unknown>;
          const clientId = Number(a.clientId);
          const query = a.query as string;
          if (isNaN(clientId) || !query) return { content: [{ type: 'text', text: 'clientId and query are required' }], isError: true };
          const accounts = await getChartOfAccounts(clientId, { search: query });
          return { content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] };
        }

        case 'get_period_comparison': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          const comparePeriodId = Number(a.comparePeriodId);
          if (isNaN(periodId) || isNaN(comparePeriodId)) {
            return { content: [{ type: 'text', text: 'Invalid period IDs' }], isError: true };
          }

          const currentTB = await getTrialBalance(periodId);
          const compareTB = await getTrialBalance(comparePeriodId);

          const comparison = currentTB.rows.map((row) => {
            const compareRow = compareTB.rows.find((r) => r.account_id === row.account_id);
            const currentBkDr = parseFloat(row.book_adjusted_debit_dollars);
            const currentBkCr = parseFloat(row.book_adjusted_credit_dollars);
            const compareBkDr = parseFloat(compareRow?.book_adjusted_debit_dollars ?? '0');
            const compareBkCr = parseFloat(compareRow?.book_adjusted_credit_dollars ?? '0');

            const currentNet = currentBkDr - currentBkCr;
            const compareNet = compareBkDr - compareBkCr;
            const variance = currentNet - compareNet;
            const variancePct = compareNet !== 0 ? (variance / Math.abs(compareNet)) * 100 : null;

            return {
              account_id: row.account_id,
              account_number: row.account_number,
              account_name: row.account_name,
              category: row.category,
              current_net: currentNet.toFixed(2),
              compare_net: compareNet.toFixed(2),
              variance_dollars: variance.toFixed(2),
              variance_pct: variancePct !== null ? variancePct.toFixed(1) : null,
              is_significant: Math.abs(variance) > 1000,
            };
          });

          await auditMcpTool('get_period_comparison', `Compared periods ${periodId} vs ${comparePeriodId}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify({ comparison, currentTotals: currentTB.totals, compareTotals: compareTB.totals }, null, 2) }] };
        }

        case 'add_variance_note': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          const accountId = Number(a.accountId);
          const note = a.note as string;
          if (isNaN(periodId) || isNaN(accountId) || !note) {
            return { content: [{ type: 'text', text: 'periodId, accountId, and note are required' }], isError: true };
          }

          await db.transaction(async (trx) => {
            // Desktop sync: not in a period a desktop holds.
            await assertNotCheckedOut(trx, [periodId]);
            await trx('variance_notes')
              // No comparison period: kept against the period itself (compare_period_id is a
              // foreign key into periods; the 0 written before was always refused).
              .insert({ period_id: periodId, account_id: accountId, compare_period_id: periodId, note, created_by: mcpUserId })
              .onConflict(['account_id', 'period_id', 'compare_period_id'])
              .merge(['note']);
          });

          await auditMcpTool('add_variance_note', `Added variance note for period ${periodId}, account ${accountId}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, periodId, accountId }) }] };
        }

        case 'list_engagement_tasks': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          if (isNaN(periodId)) return { content: [{ type: 'text', text: 'Invalid periodId' }], isError: true };

          let q = db('engagement_tasks as t')
            .leftJoin('app_users as a2', 'a2.id', 't.assignee_id')
            .where('t.period_id', periodId)
            .select('t.*', 'a2.display_name as assignee_name')
            .orderBy([{ column: 't.sort_order', order: 'asc' }, { column: 't.id', order: 'asc' }]);

          if (typeof a.status === 'string') {
            q = q.where('t.status', a.status);
          }

          const tasks = await q;
          return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
        }

        case 'update_engagement_task': {
          const a = args as Record<string, unknown>;
          const taskId = Number(a.taskId);
          if (isNaN(taskId)) return { content: [{ type: 'text', text: 'Invalid taskId' }], isError: true };

          const updates: Record<string, unknown> = { updated_at: db.fn.now() };
          if (typeof a.status === 'string') {
            updates.status = a.status;
            if (a.status === 'completed') {
              updates.completed_at = db.fn.now();
              updates.completed_by = mcpUserId;
            } else {
              updates.completed_at = null;
              updates.completed_by = null;
            }
          }
          if (typeof a.notes === 'string') updates.notes = a.notes;

          const [updated] = await db.transaction(async (trx) => {
            await assertNotCheckedOut(trx, [(await trx('engagement_tasks').where({ id: taskId }).first('period_id'))?.period_id]);
            return trx('engagement_tasks').where({ id: taskId }).update(updates).returning('*');
          });
          if (!updated) return { content: [{ type: 'text', text: `Task ${taskId} not found` }], isError: true };

          await auditMcpTool('update_engagement_task', `Updated engagement task ${taskId} status: ${a.status ?? 'notes only'}`, mcpUserId);
          return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
        }

        case 'generate_report_url': {
          const a = args as Record<string, unknown>;
          const periodId = Number(a.periodId);
          const reportType = a.reportType as string;
          if (isNaN(periodId) || !reportType) {
            return { content: [{ type: 'text', text: 'periodId and reportType are required' }], isError: true };
          }

          const validTypes = ['tb', 'gl', 'aje', 'is', 'bs', 'cash-flow', 'tax-basis-pl', 'tax-return-order'];
          if (!validTypes.includes(reportType)) {
            return { content: [{ type: 'text', text: `Invalid reportType. Valid types: ${validTypes.join(', ')}` }], isError: true };
          }

          // Map short aliases to actual route segment names
          const routeSegment: Record<string, string> = {
            tb: 'trial-balance',
            gl: 'general-ledger',
            aje: 'aje-listing',
            is: 'income-statement',
            bs: 'balance-sheet',
            'cash-flow': 'cash-flow',
            'tax-basis-pl': 'tax-basis-pl',
            'tax-return-order': 'tax-return-order',
          };

          const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
          const segment = routeSegment[reportType];
          const url = `${baseUrl}/api/v1/reports/periods/${periodId}/${segment}`;
          return { content: [{ type: 'text', text: JSON.stringify({ url, reportType, periodId }) }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err: unknown) {
      // A guard's refusal (PERIOD_CHECKED_OUT, PERIOD_LOCKED) is for the caller to read.
      if ((err as { expose?: unknown })?.expose === true && err instanceof Error) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
      const internal = err instanceof Error ? err.message : String(err);
      console.error('[mcp-server]', internal);
      return { content: [{ type: 'text', text: 'An internal error occurred. Please try again.' }], isError: true };
    }
  });

  // ── PROMPTS ───────────────────────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'period_review',
        description: 'Comprehensive review workflow for a period: dashboard, TB, diagnostics',
        arguments: [
          { name: 'periodId', description: 'The period ID to review', required: true },
        ],
      },
      {
        name: 'tax_mapping_review',
        description: 'Review and complete tax code mapping for a client',
        arguments: [
          { name: 'clientId', description: 'The client ID', required: true },
        ],
      },
      {
        name: 'variance_investigation',
        description: 'Investigate large variances between two periods',
        arguments: [
          { name: 'periodId', description: 'Current period ID', required: true },
          { name: 'comparePeriodId', description: 'Comparison period ID', required: true },
        ],
      },
      {
        name: 'engagement_status',
        description: 'Review engagement task status and outstanding items',
        arguments: [
          { name: 'periodId', description: 'The period ID', required: true },
        ],
      },
      {
        name: 'full_period_close',
        description: 'Full period close workflow: dashboard → diagnostics → tax mapping → lock',
        arguments: [
          { name: 'periodId', description: 'The period ID to close', required: true },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, string>;

    switch (name) {
      case 'period_review':
        return {
          description: `Review period ${a.periodId}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please review period ID ${a.periodId} using these steps:
1. Call get_period_dashboard with periodId=${a.periodId} to see stats and recent activity
2. Call get_trial_balance with periodId=${a.periodId} to check the trial balance
3. Call run_diagnostics with periodId=${a.periodId} to get AI observations
4. Summarize: Is the TB balanced? Any errors/warnings? What actions are needed?`,
              },
            },
          ],
        };

      case 'tax_mapping_review':
        return {
          description: `Tax mapping review for client ${a.clientId}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Review and complete tax code mapping for client ID ${a.clientId}:
1. Call get_tax_mapping_status with clientId=${a.clientId} to see current progress
2. If unmapped accounts exist, call auto_assign_tax_codes with clientId=${a.clientId} to get AI suggestions
3. Review the suggestions. For high-confidence suggestions (>=0.80), confirm them using confirm_tax_assignments
4. Report the final mapping status`,
              },
            },
          ],
        };

      case 'variance_investigation':
        return {
          description: `Variance investigation: period ${a.periodId} vs ${a.comparePeriodId}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Investigate variances between period ${a.periodId} and period ${a.comparePeriodId}:
1. Call get_period_comparison with periodId=${a.periodId} and comparePeriodId=${a.comparePeriodId}
2. Identify accounts with significant variances (>$1,000 or >10%)
3. For each significant account, call add_variance_note to document your findings
4. Provide a summary of the key variances and recommended actions`,
              },
            },
          ],
        };

      case 'engagement_status':
        return {
          description: `Engagement status for period ${a.periodId}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Review engagement tasks for period ID ${a.periodId}:
1. Call list_engagement_tasks with periodId=${a.periodId} to see all tasks
2. Summarize open/in-progress/completed tasks by category
3. Identify any overdue or high-priority items
4. Report what percentage of tasks are complete`,
              },
            },
          ],
        };

      case 'full_period_close':
        return {
          description: `Full period close workflow for period ${a.periodId}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Execute the full period close workflow for period ID ${a.periodId}:

Step 1 - Dashboard check: Call get_period_dashboard with periodId=${a.periodId}
Step 2 - Run diagnostics: Call run_diagnostics with periodId=${a.periodId} and review all errors/warnings
Step 3 - Check TB balance: Call get_trial_balance with periodId=${a.periodId} and verify it is balanced
Step 4 - Get client ID from the dashboard, then call get_tax_mapping_status for that client
Step 5 - If tax mapping is incomplete (<100%), call auto_assign_tax_codes and confirm high-confidence suggestions
Step 6 - Review engagement tasks: Call list_engagement_tasks with periodId=${a.periodId}
Step 7 - Only if TB is balanced and no errors: Call lock_period with periodId=${a.periodId}

IMPORTANT: Do not lock the period if the TB is out of balance or if there are unresolved errors.
Report back the status of each step and whether the period was successfully locked.`,
              },
            },
          ],
        };

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });

  return server;
}
