// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// OpenAPI for P12 D0: desktop sync, this computer's side (syncRoutes.ts).
// The firm server is reached by the desktop app itself; these routes make
// and take the archives that go to and from it. Response objects are open:
// the desktop reads the fields listed as required.

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const int: Schema = { type: 'integer' };
const str: Schema = { type: 'string' };
const open = (required: string[], properties: Schema, description?: string): Schema => ({
  type: 'object', required, properties, ...(description ? { description } : {}),
});
const json = 'application/json';

function envelope(data: Schema): Schema {
  return { type: 'object', required: ['data', 'error'], properties: { data, error: { type: 'null' } } };
}
const ok = (description: string, data: Schema): Schema => ({
  description, content: { [json]: { schema: envelope(data) } },
});
const err = (description: string): Schema => ({
  description, content: { [json]: { schema: ref('ErrorEnvelope') } },
});
const common: Schema = { '401': err('Missing or wrong desktop session token'), '500': err('Server error') };
const jsonBody = (schema: Schema): Schema => ({ required: true, content: { [json]: { schema } } });
const archive = (description: string): Schema => ({
  description,
  content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
});
const tags = (t: string): string[] => [t];

export const syncSchemas: Record<string, Schema> = {
  SyncVersion: open(['formatVersion', 'schemaVersion'], {
    formatVersion: int,
    schemaVersion: { type: ['string', 'null'], description: 'The newest migration (a firm server must be on the same one)' },
  }),
  SyncClientIds: open(['clientId', 'clientUid', 'periods'], {
    clientId: int,
    clientUid: str,
    periods: {
      type: 'array',
      description: 'Its periods (reference periods left out)',
      items: open(['periodId', 'periodUid'], { periodId: int, periodUid: str }),
    },
  }),
  SyncStamp: open(['periodId', 'stamp'], { periodId: int, stamp: str }),
  SyncExportPeriod: open(['periodId'], {
    periodId: { type: 'integer', minimum: 1 },
    checkoutId: { type: ['integer', 'null'], description: 'The firm server check-out it goes back under' },
    stampAtPull: { type: ['string', 'null'], description: "The period stamp in the firm server's pull result" },
  }),
  SyncExportClient: open(['clientId'], { clientId: { type: 'integer', minimum: 1 } }),
  SyncImport: open(['mode', 'clientId', 'periodId'], {
    mode: { type: 'string', enum: ['new', 'merged'], description: 'new: the client was not here (restored as new, its uids kept); merged: the period put into the client here' },
    clientId: int,
    periodId: { type: ['integer', 'null'] },
    stamp: { type: ['string', 'null'], description: "The period's stamp here after opening it (new mode)" },
    filesPlaced: int,
    filesNotPlaced: int,
    totalsBefore: { type: 'object' },
    totalsAfter: { type: 'object' },
    differences: { type: 'array', items: { type: 'object' }, description: 'Client-level rows here that differ from the firm server (kept as they are here)' },
    counts: { type: 'object', additionalProperties: int },
  }, 'What opening a pulled period did. A merge also carries upstream mergePeriod\'s result fields.'),
};

export const syncPaths: Record<string, Schema> = {
  '/api/v1/desktop/sync/version': {
    get: {
      operationId: 'syncVersion', tags: tags('sync'), summary: "This engine's archive format and schema version",
      responses: { '200': ok('The versions', ref('SyncVersion')), ...common },
    },
  },
  '/api/v1/desktop/sync/ids': {
    get: {
      operationId: 'syncIds', tags: tags('sync'), summary: "Every client's and period's sync_uid (the same on every computer)",
      responses: { '200': ok('The ids', { type: 'array', items: ref('SyncClientIds') }), ...common },
    },
  },
  '/api/v1/desktop/sync/periods/{id}/stamp': {
    parameters: [{ name: 'id', in: 'path', required: true, description: 'Period id', schema: { type: 'integer', minimum: 1 } }],
    get: {
      operationId: 'syncPeriodStamp', tags: tags('sync'), summary: "A period's stamp now (it changes with any of the period's rows)",
      responses: { '200': ok('The stamp', ref('SyncStamp')), '400': err('INVALID_ID'), '404': err('NOT_FOUND'), ...common },
    },
  },
  '/api/v1/desktop/sync/export-period': {
    post: {
      operationId: 'syncExportPeriod', tags: tags('sync'),
      summary: 'A period archive to send back to the firm server: its manifest names the period and client by uid, the check-out, the stamp it started from and its book totals',
      requestBody: jsonBody(ref('SyncExportPeriod')),
      responses: {
        '200': archive('The .tbak (header X-Period-Stamp: the stamp written into it)'),
        '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND: no such period, or a reference period'), ...common,
      },
    },
  },
  '/api/v1/desktop/sync/export-client': {
    post: {
      operationId: 'syncExportClient', tags: tags('sync'), summary: 'A client archive to send to the firm server as a new client',
      requestBody: jsonBody(ref('SyncExportClient')),
      responses: { '200': archive('The .tbak'), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), ...common },
    },
  },
  '/api/v1/desktop/sync/import': {
    post: {
      operationId: 'syncImport', tags: tags('sync'),
      summary: 'Open a period pulled from the firm server: a client not here is restored as new keeping its uids; one here gets the period merged in',
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: open(['file'], { file: { type: 'string', format: 'binary' } }) } },
      },
      responses: {
        '200': ok('What it did', ref('SyncImport')),
        '400': err('SYNC_ARCHIVE_INVALID, SYNC_ARCHIVE_DAMAGED, SYNC_UID_TAKEN, SYNC_PERIOD_ELSEWHERE, PERIOD_OVERLAPS, PERIOD_LOCKED and the merge\'s other refusals, in words for this computer'),
        '409': err('SYNC_SCHEMA_MISMATCH: made by a different version'),
        ...common,
      },
    },
  },
};
