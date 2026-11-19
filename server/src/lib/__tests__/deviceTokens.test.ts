// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_ALPHABET, CODE_LENGTH, formatCode, isDeviceToken, newDeviceToken, newPairingCode, normaliseCode, sha256,
  tidyDeviceName,
} from '../sync/deviceTokens';

test('a device token is prefixed, random, and recognised; a JWT is not one', () => {
  const a = newDeviceToken();
  const b = newDeviceToken();
  assert.notEqual(a, b);
  assert.ok(isDeviceToken(a), a);
  assert.ok(a.startsWith('vtbsync_'));
  assert.equal(isDeviceToken('eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.x'), false);
  assert.equal(isDeviceToken(`${a}x`), false);
  assert.equal(isDeviceToken(''), false);
  assert.match(sha256(a), /^[0-9a-f]{64}$/);
});

test('a pairing code uses no look-alike characters and is shown as XXXX-XXXX', () => {
  for (let i = 0; i < 200; i++) {
    const c = newPairingCode();
    assert.equal(c.length, CODE_LENGTH);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch), ch);
  }
  for (const ch of '01OIL') assert.equal(CODE_ALPHABET.includes(ch), false, ch);
  assert.equal(formatCode('ABCD2345'), 'ABCD-2345');
});

test('a typed code is read whatever its case, spaces and dash', () => {
  assert.equal(normaliseCode('abcd-2345'), 'ABCD2345');
  assert.equal(normaliseCode(' ab cd 23 45 '), 'ABCD2345');
  assert.equal(normaliseCode('ABCD234'), null, 'too short');
  assert.equal(normaliseCode('ABCD-23O5'), null, 'O is not in the alphabet');
  assert.equal(normaliseCode(''), null);
});

test('a device name is tidied and a blank one refused', () => {
  assert.equal(tidyDeviceName('  Kurt’s   laptop '), 'Kurt’s laptop');
  assert.equal(tidyDeviceName('   '), null);
  assert.equal(tidyDeviceName(42), null);
  assert.equal(tidyDeviceName('x'.repeat(300))?.length, 100);
});
