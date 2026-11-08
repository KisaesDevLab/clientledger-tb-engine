// Writes openapi.desktop.json (committed) from src/desktop/openapi.ts.
// The desktop app generates its Rust client (cltb-api) from this file.
// Run: npm run desktop:openapi
import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApiSpec } from '../../src/desktop/openapi';

const out = path.resolve(__dirname, '../../openapi.desktop.json');
fs.writeFileSync(out, JSON.stringify(buildOpenApiSpec(), null, 2) + '\n');
console.log(`[desktop:openapi] wrote ${path.basename(out)}`);
