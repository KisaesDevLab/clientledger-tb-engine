// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The Statement Writer's OpenAPI entries (openapiFs.ts) against the engine's
// own zod contracts (lib/fs/engine/schemas.ts):
//   - every field the zod schemas know is described, so a field upstream
//     adds fails here instead of being dropped by the desktop on a save;
//   - the recorded layout that uses every node type and optional field is
//     what the engine's schema keeps (nothing stripped);
//   - the built-in default layouts are valid against the OpenAPI layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { z } from 'zod';
import { buildOpenApiSpec } from '../openapi';
import {
  FS_ENTITY_KINDS, buildDefaultLayout, fsCashFlowOverridesSchema, fsClientLayoutSchema, fsCreateReportSchema,
  fsDraftOverridesSchema, fsEquityRolesSchema, fsFinalizeSchema, fsFrontMatterSchema, fsLayoutTemplateSchema,
  fsLetterheadSchema, fsLetterSchema, fsReportSettingsSchema, fsStylePresetSchema, fsStyleSchema,
  fsUpdateClientLayoutSchema, fsUpdateReportSchema,
} from '../../lib/fs/engine';

type Schema = Record<string, unknown>;

const spec = buildOpenApiSpec() as { components: { schemas: Record<string, Schema> } };
const components = spec.components.schemas;
const fixture = (name: string): { data: Record<string, unknown> } =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

function deref(s: Schema): Schema {
  const r = s.$ref as string | undefined;
  return r ? deref(components[r.replace('#/components/schemas/', '')]!) : s;
}

function unwrap(t: z.ZodTypeAny): z.ZodTypeAny {
  for (;;) {
    if (t instanceof z.ZodOptional || t instanceof z.ZodNullable) t = t.unwrap();
    else if (t instanceof z.ZodDefault) t = t._def.innerType;
    else if (t instanceof z.ZodEffects) t = t.innerType();
    else if (t instanceof z.ZodLazy) t = t.schema;
    else return t;
  }
}

/** The OpenAPI alternatives of `s` (oneOf, or itself). */
function options(s: Schema): Schema[] {
  const d = deref(s);
  return Array.isArray(d.oneOf) ? (d.oneOf as Schema[]).map(deref) : [d];
}

function tagOf(o: Schema, key: string): unknown[] {
  const p = (o.properties as Record<string, Schema> | undefined)?.[key];
  if (!p) return [];
  return p.const !== undefined ? [p.const] : ((p.enum as unknown[] | undefined) ?? []);
}

/** Every key zod knows is a property of the OpenAPI schema, all the way down. */
function covered(zt: z.ZodTypeAny, oa: Schema, where: string, missing: string[], seen: Set<unknown>): void {
  // z.lazy builds a new schema on every read, so recursion (a section's
  // children) is stopped at the second visit of the same OpenAPI component.
  const r = oa.$ref as string | undefined;
  if (r) {
    if (seen.has(r)) return;
    seen.add(r);
  }
  const t = unwrap(zt);
  if (t instanceof z.ZodObject) {
    const target = options(oa).find((o) => o.properties) ?? deref(oa);
    const props = (target.properties ?? {}) as Record<string, Schema>;
    for (const [k, v] of Object.entries(t.shape as Record<string, z.ZodTypeAny>)) {
      if (!props[k]) missing.push(`${where}.${k}`);
      else covered(v, props[k], `${where}.${k}`, missing, seen);
    }
  } else if (t instanceof z.ZodArray) {
    covered(t.element, (deref(oa).items ?? {}) as Schema, `${where}[]`, missing, seen);
  } else if (t instanceof z.ZodRecord) {
    const ap = deref(oa).additionalProperties;
    if (ap && typeof ap === 'object') covered(t.valueSchema, ap as Schema, `${where}{}`, missing, seen);
  } else if (t instanceof z.ZodDiscriminatedUnion) {
    const key = t.discriminator as string;
    for (const option of t.options as z.ZodObject<z.ZodRawShape>[]) {
      const lit = unwrap(option.shape[key] as z.ZodTypeAny);
      const values: unknown[] = lit instanceof z.ZodLiteral ? [lit.value] : lit instanceof z.ZodEnum ? (lit.options as unknown[]) : [];
      const match = options(oa).find((o) => values.every((v) => tagOf(o, key).includes(v)));
      if (!match) missing.push(`${where}<${values.join('|')}>`);
      else covered(option, match, `${where}<${values.join('|')}>`, missing, seen);
    }
  }
}

for (const [name, zod, component] of [
  ['layout', fsClientLayoutSchema, 'FsLayout'],
  ['style', fsStyleSchema, 'FsStyle'],
  ['settings', fsReportSettingsSchema, 'FsReportSettings'],
  ['front matter', fsFrontMatterSchema, 'FsFrontMatter'],
  ['create report', fsCreateReportSchema, 'FsCreateReport'],
  ['update report', fsUpdateReportSchema, 'FsUpdateReport'],
  ['save layout', fsUpdateClientLayoutSchema, 'FsLayoutUpdate'],
  ['draft overrides', fsDraftOverridesSchema, 'FsDraftOverrides'],
  ['finalize', fsFinalizeSchema, 'FsFinalizeRequest'],
  ['letterhead', fsLetterheadSchema, 'FsLetterheadInput'],
  ['letter', fsLetterSchema, 'FsLetterInput'],
  ['style preset', fsStylePresetSchema, 'FsStylePresetInput'],
  ['layout template', fsLayoutTemplateSchema, 'FsLayoutTemplateInput'],
  ['cash flow overrides', fsCashFlowOverridesSchema, 'FsCashFlowOverridesInput'],
  ['equity roles', fsEquityRolesSchema, 'FsEquityRolesInput'],
] as const) {
  test(`every field of the engine's ${name} schema is in the OpenAPI ${component}`, () => {
    const missing: string[] = [];
    covered(zod as z.ZodTypeAny, { $ref: `#/components/schemas/${component}` }, component, missing, new Set());
    assert.deepEqual(missing, []);
  });
}

test('the recorded every-node layout and its style are what the engine keeps', () => {
  const saved = fixture('fs-layout-full.json').data.layout as { layout: unknown; style: unknown };
  assert.deepEqual(fsClientLayoutSchema.parse(saved.layout), saved.layout);
  assert.deepEqual(fsStyleSchema.parse(saved.style), saved.style);
  const types = new Set<string>();
  const walk = (nodes: Array<{ type: string; children?: unknown[] }>) => nodes.forEach((n) => {
    types.add(n.type);
    if (n.children) walk(n.children as typeof nodes);
  });
  (saved.layout as { statements: Array<{ body: Array<{ type: string }> }> }).statements.forEach((s) => walk(s.body));
  assert.deepEqual([...types].sort(), ['account', 'blank', 'leadsheet', 'page_break', 'section', 'text', 'total']);
});

test('the built-in default layouts are valid OpenAPI layouts', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(spec, 'spec');
  const validate = ajv.compile({ $ref: 'spec#/components/schemas/FsLayout' });
  for (const kind of FS_ENTITY_KINDS) {
    assert.ok(validate(buildDefaultLayout(kind)), `${kind}: ${JSON.stringify(validate.errors, null, 2)}`);
  }
});
