// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.
/**
 * Desktop sync S4 step 6, made safe (security review): a client made on a
 * desktop is restored from an archive the desktop wrote, which is not a
 * backup an admin chose. Only the tables a client's work consists of are
 * taken (no users, folder links, QuickBooks connection, imports or saved
 * reports); every user id in them is the sender's or none, with the names
 * that go with them; a sign-off must be the sender's; and statements cannot
 * arrive issued (they are finalized on the server, through its checks).
 */
import { USER_FK_COLUMNS } from '../../routes/backup';
import { SyncJobError } from './jobs';

type Row = Record<string, unknown>;

/** What a client archive from a desktop may carry. */
export const NEW_CLIENT_TABLES = new Set([
  'clients', 'periods', 'chart_of_accounts', 'trial_balance', 'journal_entries', 'journal_entry_lines',
  'bank_transactions', 'classification_rules', 'variance_notes', 'tax_codes',
  'lead_sheets', 'lead_sheet_signoffs', 'lead_sheet_notes', 'lead_sheet_attachments', 'client_documents',
  'tickmark_library', 'tb_tickmarks', 'engagement_tasks', 'm1_adjustments', 'py_comparison_data',
  'bank_reconciliations', 'reconciliation_items',
  'fs_client_layouts', 'fs_reports', 'fs_cash_flow_overrides', 'fs_equity_roles',
]);

/** The name columns that say who a user column names. */
const NAMES: Record<string, Record<string, string>> = {
  lead_sheet_signoffs: { user_id: 'user_name' },
  lead_sheet_notes: { author_id: 'author_name', resolved_by: 'resolved_by_name' },
};

/**
 * The tables of a client archive from a desktop, as they may be restored.
 * Refuses issued statements and a sign-off by anyone but the sender.
 */
export function confineNewClient(tables: Record<string, unknown[]>, sender: { id: number; name: string }): Record<string, unknown[]> {
  if (((tables.fs_report_versions ?? []) as Row[]).length > 0) {
    throw new SyncJobError('SYNC_ARCHIVE_INVALID', 'Statements finalized on the desktop cannot be sent: send the client, then finalize them on the server.');
  }
  const out: Record<string, unknown[]> = {};
  for (const [t, rows] of Object.entries(tables)) {
    if (!NEW_CLIENT_TABLES.has(t) || !Array.isArray(rows)) continue;
    const cols = USER_FK_COLUMNS[t] ?? [];
    out[t] = (rows as Row[]).map((r) => {
      const row = { ...r };
      if (t === 'lead_sheet_signoffs' && Number(row.user_id) !== sender.id) {
        throw new SyncJobError('SYNC_ARCHIVE_INVALID', 'A lead sheet in the archive is signed by someone other than the person sending it.');
      }
      for (const col of cols) {
        if (row[col] == null) continue;
        const mine = Number(row[col]) === sender.id;
        const name = NAMES[t]?.[col];
        row[col] = mine ? sender.id : null;
        if (name) row[name] = mine ? sender.name : null;
      }
      return row;
    });
  }
  return out;
}
