// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The desktop OpenAPI document must be valid OpenAPI 3.1, and responses
// recorded from a real desktop engine (fixtures/, demo seed data) must match
// the schemas it declares — so a route that changes shape fails here before
// the generated Rust client trips over it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { buildOpenApiSpec } from '../openapi';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SwaggerParser = require('@apidevtools/swagger-parser') as { validate(doc: unknown): Promise<unknown> };

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

test('document is valid OpenAPI 3.1', async () => {
  // validate() dereferences in place, so give it a copy.
  await SwaggerParser.validate(structuredClone(buildOpenApiSpec()));
});

test('every operation has a unique operationId', () => {
  const ids: string[] = [];
  for (const item of Object.values(buildOpenApiSpec().paths as Record<string, Record<string, unknown>>)) {
    for (const op of Object.values(item)) {
      if (op && typeof op === 'object' && 'operationId' in op) ids.push(String((op as { operationId: string }).operationId));
    }
  }
  assert.equal(new Set(ids).size, ids.length);
});

function responseValidator(pathKey: string, method: string, status: string) {
  const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>> };
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(spec, 'spec');
  const schema = spec.paths[pathKey][method].responses[status].content['application/json'].schema;
  const rewired = JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"spec#/components/'));
  return ajv.compile(rewired);
}

for (const [pathKey, file] of [
  ['/api/v1/health', 'health.json'],
  ['/api/v1/clients', 'clients.json'],
  ['/api/v1/clients/{clientId}/periods', 'periods.json'],
  ['/api/v1/periods/{periodId}/trial-balance', 'trial-balance.json'],
  ['/api/v1/desktop/periods/{periodId}/trial-balance/totals', 'trial-balance-totals.json'],
  ['/api/v1/periods/{periodId}/journal-entries', 'journal-entries.json'],
  ['/api/v1/periods/{periodId}/variance-notes', 'variance-notes.json'],
] as const) {
  test(`recorded ${file} matches GET ${pathKey}`, () => {
    const validate = responseValidator(pathKey, 'get', '200');
    const ok = validate(fixture(file));
    assert.ok(ok, JSON.stringify(validate.errors, null, 2));
  });
}

test('recorded csv-analyze.json matches POST /api/v1/import/csv/analyze', () => {
  const validate = responseValidator('/api/v1/import/csv/analyze', 'post', '200');
  assert.ok(validate(fixture('csv-analyze.json')), JSON.stringify(validate.errors, null, 2));
});

test('committed openapi.desktop.json is up to date (npm run desktop:openapi)', () => {
  const committed = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../openapi.desktop.json'), 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildOpenApiSpec())));
});
