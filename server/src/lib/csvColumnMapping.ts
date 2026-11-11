// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// A column mapping the user chose for POST /import/csv/analyze.
//
// Without one the route guesses the file's shape (a known layout, the AI, or a
// heuristic). The heuristic reads a debit/credit file with no header row as all
// zeros, so a person who can see the file must be able to say which column is
// which. When the multipart field `columnMapping` (JSON) is present the route
// uses it instead of guessing, then parses and matches every row exactly as it
// would have. Nothing here touches the database.

import { z } from 'zod';
import type { AiAnalysisResult } from '../routes/csvImport';

export type ColumnMapping = Omit<AiAnalysisResult, 'matches'>;

const col = z.number().int().min(0).max(499).nullable();

const mappingSchema = z.object({
  delimiter: z.enum([',', ';', '\t', '|']),
  hasHeaders: z.boolean(),
  headerRow: z.number().int().min(0).max(100_000),
  dataStartRow: z.number().int().min(0).max(100_000),
  amountFormat: z.enum(['separate_dr_cr', 'single_signed', 'single_parentheses']),
  columns: z.object({
    accountNumber: col,
    accountName: col,
    debit: col,
    credit: col,
    amount: col,
  }).strict(),
  rowsToSkip: z.array(z.number().int().min(0).max(100_000)).max(10_000).default([]),
}).strict();

/**
 * The mapping in `raw` (the multipart field, a JSON string), `null` when the
 * field is absent or empty, or `{ error }` naming what is wrong with it.
 */
export function parseColumnMapping(raw: unknown): ColumnMapping | null | { error: string } {
  if (raw === undefined || raw === null || raw === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: 'columnMapping is not valid JSON' };
    }
  }
  const parsed = mappingSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: `columnMapping ${first.path.join('.') || 'value'}: ${first.message}` };
  }
  const m = parsed.data;
  const c = m.columns;
  if (c.accountNumber === null && c.accountName === null) {
    return { error: 'columnMapping needs an account number or an account name column' };
  }
  if (m.amountFormat === 'separate_dr_cr') {
    if (c.debit === null || c.credit === null) {
      return { error: 'columnMapping with separate debit and credit columns needs both' };
    }
  } else if (c.amount === null) {
    return { error: 'columnMapping with one amount column needs that column' };
  }
  const used = [c.accountNumber, c.accountName, c.debit, c.credit, c.amount].filter((n): n is number => n !== null);
  if (new Set(used).size !== used.length) {
    return { error: 'columnMapping uses one column for two fields' };
  }
  if (m.hasHeaders && m.dataStartRow <= m.headerRow) {
    return { error: 'columnMapping: the first data row must come after the header row' };
  }
  return {
    delimiter: m.delimiter,
    hasHeaders: m.hasHeaders,
    headerRow: m.headerRow,
    dataStartRow: m.dataStartRow,
    amountFormat: m.amountFormat,
    columns: {
      accountNumber: c.accountNumber,
      accountName: c.accountName,
      // Only the columns the format reads, so the preview shows nothing stale.
      debit: m.amountFormat === 'separate_dr_cr' ? c.debit : null,
      credit: m.amountFormat === 'separate_dr_cr' ? c.credit : null,
      amount: m.amountFormat === 'separate_dr_cr' ? null : c.amount,
    },
    rowsToSkip: [...new Set(m.rowsToSkip)].sort((a, b) => a - b),
    detectedFormat: null,
  };
}
