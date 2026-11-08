// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// The desktop bundle replaces @kisaesdevlab/vibe-auth with vibeAuthStub.ts and
// the migration's SQL with a vendored copy (Q12). These tests catch upstream
// drift: a new runtime import from the package, or a changed SQL file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as stub from '../vibeAuthStub';

const server = path.resolve(__dirname, '../../..');

function runtimeImportsFromPackage(file: string): string[] {
  const src = fs.readFileSync(path.join(server, file), 'utf8');
  const names: string[] = [];
  const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'@kisaesdevlab\/vibe-auth'/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[1]) continue; // import type { ... }: erased
    for (const raw of m[2].split(',')) {
      const name = raw.trim();
      if (name && !name.startsWith('type ')) names.push(name.split(/\s+as\s+/)[0]);
    }
  }
  return names;
}

test('the stub exports every runtime name src/ imports from vibe-auth', () => {
  const srcDir = path.join(server, 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); }
      else if (e.name.endsWith('.ts')) files.push(path.relative(server, p));
    }
  };
  walk(srcDir);
  const needed = new Set(files.flatMap(runtimeImportsFromPackage));
  assert.ok(needed.has('createVibeAuth'), 'expected src/lib/vibeAuth.ts to import createVibeAuth');
  for (const name of needed) {
    assert.equal(typeof (stub as Record<string, unknown>)[name], 'function', `stub is missing ${name}`);
  }
});

test('stub runs in local mode: no SSO, local login allowed, nothing revoked, no routes', async () => {
  const auth = stub.createVibeAuth({ product: { slug: 'vibe-tb' } });
  await auth.start();
  assert.equal(auth.status().mode, 'local');
  assert.equal(auth.status().oidc.enabled, false);
  assert.deepEqual(auth.localLoginAllowed('admin'), { allowed: true });
  assert.equal(await auth.isRevoked({ userId: '1' }, Date.now()), false);
  assert.equal(await auth.handle({}), null);
});

test('vendored auth_identities.sql matches the package copy (when installed)', (t) => {
  let pkgSql: string;
  try {
    pkgSql = fs.readFileSync(require.resolve('@kisaesdevlab/vibe-auth/sql/auth_identities.sql'), 'utf8');
  } catch {
    t.skip('@kisaesdevlab/vibe-auth not installed (token-free install)');
    return;
  }
  const vendored = fs.readFileSync(path.join(server, 'src/desktop/vendor/vibe-auth-auth_identities.sql'), 'utf8');
  const body = vendored.replace(/\r\n/g, '\n').split('\n').slice(5).join('\n');
  assert.equal(body, pkgSql.replace(/\r\n/g, '\n'));
});
