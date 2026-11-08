// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Storage driver resolution: settings row > env > local disk.
 *
 * Modelled on lib/mailService.ts (memoised async loader plus an explicit
 * invalidator), NOT on Time & Billing's boot-time approach of decrypting
 * credentials into process.env — that mutates global state and needs a restart
 * after every Settings save.
 *
 * Boot behaviour also differs deliberately. The reference fails fast at boot
 * when B2 vars are missing; here B2 is optional, so bricking an appliance over
 * an optional feature is unacceptable. Instead a misconfiguration surfaces as
 * `configError`: WRITES fail loudly with 503 listing what's missing, while
 * reads of existing local rows keep working. There is no silent fallback to
 * local for writes.
 */

import path from 'path';
import { db } from '../../db';
import { decrypt, isEncrypted } from '../encryption';
import { B2StorageDriver } from './b2Driver';
import { LocalStorageDriver } from './localDriver';
import type { StorageBackend, StorageDriver } from './types';
import { DEFAULT_CLIENT_FOLDER_FORMAT, DEFAULT_YEAR_FORMAT } from './keys';

export const STORAGE_SETTING_KEYS = [
  'storage.provider',
  'storage.prefix',
  'storage.b2_endpoint',
  'storage.b2_region',
  'storage.b2_bucket',
  'storage.b2_key_id',
  'storage.b2_application_key',
  'storage.install_id',
  'storage.year_format',
  'storage.client_folder_format',
] as const;

export type StorageSettingKey = (typeof STORAGE_SETTING_KEYS)[number];

export interface StorageConfig {
  provider: StorageBackend;
  prefix: string;
  /** Year-folder pattern, e.g. `{year}` or `FY{year}`. */
  yearFormat: string;
  /** Client-folder pattern, e.g. `{name}` or `{code} - {name}`. */
  clientFolderFormat: string;
  b2?: {
    endpoint: string;
    region: string;
    bucket: string;
    keyId: string;
    applicationKey: string;
  };
  /** Set when the provider is b2 but its settings are incomplete. */
  configError?: string;
  /** True when the effective values came from env rather than the DB. */
  envOverride: boolean;
}

export const DEFAULT_PREFIX = 'Clients';

/** Where the local driver writes. Same base documents.ts has always used. */
export function localStorageRoot(): string {
  return process.env.UPLOADS_DIR || path.resolve(__dirname, '../../../uploads');
}

async function loadDbSettings(): Promise<Partial<Record<StorageSettingKey, string>>> {
  try {
    const rows = await db('settings')
      .whereIn('key', STORAGE_SETTING_KEYS as readonly string[])
      .select('key', 'value');
    const out: Partial<Record<StorageSettingKey, string>> = {};
    for (const r of rows) {
      if (!r.value) continue;
      out[r.key as StorageSettingKey] = r.value as string;
    }
    return out;
  } catch (err) {
    // A settings read failure must not take storage down — fall back to env.
    console.error('[storage] failed to read settings:', (err as Error).message);
    return {};
  }
}

/** Tolerates legacy plaintext and a rotated key, same as mailService. */
function decryptIfNeeded(value: string | undefined): string {
  if (!value) return '';
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

export async function loadStorageConfig(): Promise<StorageConfig> {
  const dbVals = await loadDbSettings();
  const hasDbProvider = !!dbVals['storage.provider'];

  const provider = ((dbVals['storage.provider'] || process.env.STORAGE_PROVIDER || 'local')
    .trim().toLowerCase()) as StorageBackend;
  const prefix = (dbVals['storage.prefix'] ?? process.env.STORAGE_PREFIX ?? DEFAULT_PREFIX).trim();
  const yearFormat = (dbVals['storage.year_format'] || process.env.STORAGE_YEAR_FORMAT || DEFAULT_YEAR_FORMAT).trim();
  const clientFolderFormat =
    (dbVals['storage.client_folder_format'] || process.env.STORAGE_CLIENT_FOLDER_FORMAT || DEFAULT_CLIENT_FOLDER_FORMAT).trim();

  if (provider !== 'b2') {
    return { provider: 'local', prefix, yearFormat, clientFolderFormat, envOverride: !hasDbProvider };
  }

  const endpoint = (dbVals['storage.b2_endpoint'] || process.env.B2_ENDPOINT || '').trim();
  const region = (dbVals['storage.b2_region'] || process.env.B2_REGION || '').trim();
  const bucket = (dbVals['storage.b2_bucket'] || process.env.B2_BUCKET || '').trim();
  const keyId = decryptIfNeeded(dbVals['storage.b2_key_id']) || process.env.B2_KEY_ID || '';
  const applicationKey =
    decryptIfNeeded(dbVals['storage.b2_application_key']) || process.env.B2_APPLICATION_KEY || '';

  const missing: string[] = [];
  if (!endpoint) missing.push('endpoint');
  if (!region) missing.push('region');
  if (!bucket) missing.push('bucket');
  if (!keyId) missing.push('key ID');
  if (!applicationKey) missing.push('application key');

  return {
    provider: 'b2',
    prefix,
    yearFormat,
    clientFolderFormat,
    b2: { endpoint, region, bucket, keyId, applicationKey },
    configError: missing.length > 0
      ? `Object storage is selected but incomplete — missing: ${missing.join(', ')}.`
      : undefined,
    envOverride: !hasDbProvider,
  };
}

export function buildDriver(cfg: StorageConfig): StorageDriver {
  if (cfg.provider === 'b2' && !cfg.configError && cfg.b2) {
    return new B2StorageDriver({
      endpoint: cfg.b2.endpoint,
      region: cfg.b2.region,
      bucket: cfg.b2.bucket,
      accessKeyId: cfg.b2.keyId,
      secretAccessKey: cfg.b2.applicationKey,
    });
  }
  return new LocalStorageDriver(localStorageRoot());
}

let cachedConfig: StorageConfig | undefined;
let cachedDriver: StorageDriver | undefined;

async function ensureLoaded(): Promise<void> {
  if (cachedConfig === undefined) {
    cachedConfig = await loadStorageConfig();
    cachedDriver = buildDriver(cachedConfig);
  }
}

export async function getStorageConfig(): Promise<StorageConfig> {
  await ensureLoaded();
  return cachedConfig!;
}

/**
 * The driver for NEW writes, per the current configuration. Throws 503 when the
 * selected provider is misconfigured rather than silently writing somewhere
 * else — a silent fallback would scatter a client's documents across two
 * backends without anyone noticing.
 */
export async function getStorageDriver(): Promise<StorageDriver> {
  await ensureLoaded();
  if (cachedConfig!.configError) {
    const { StorageError } = await import('./types');
    throw new StorageError(cachedConfig!.configError, 'STORAGE_UNCONFIGURED', 503);
  }
  return cachedDriver!;
}

/**
 * The driver for READING a specific row, chosen by the backend that row was
 * written with.
 *
 * This is the addition the reference doesn't have and this app requires: with
 * B2 optional, a B2-backed row must keep reading from B2 after an admin flips
 * back to local, and a legacy local row must keep working after B2 is switched
 * on. Reads route by the row's backend; writes route by the current config.
 */
export async function getStorageDriverFor(backend: StorageBackend | null | undefined): Promise<StorageDriver> {
  await ensureLoaded();
  if (!backend || backend === 'local') return new LocalStorageDriver(localStorageRoot());
  if (cachedConfig!.provider === 'b2' && !cachedConfig!.configError) return cachedDriver!;

  // The row lives in B2 but the CURRENT provider is local. The stored B2
  // credentials usually survive that switch, so build a reader from them
  // directly rather than re-reading `provider` — which is the very setting that
  // was just changed, and which would make this branch unreachable.
  const b2 = await loadB2Credentials();
  if (b2) {
    return new B2StorageDriver({
      endpoint: b2.endpoint,
      region: b2.region,
      bucket: b2.bucket,
      accessKeyId: b2.keyId,
      secretAccessKey: b2.applicationKey,
    });
  }
  const { StorageError } = await import('./types');
  throw new StorageError(
    'This document is stored in object storage, whose credentials are no longer configured. Re-enter them under Settings → Document Storage to read it.',
    'STORAGE_UNCONFIGURED',
    503,
  );
}

/**
 * B2 credentials regardless of which provider is currently selected — used to
 * keep reading rows written while B2 was on.
 */
async function loadB2Credentials(): Promise<
  { endpoint: string; region: string; bucket: string; keyId: string; applicationKey: string } | null
> {
  const dbVals = await loadDbSettings();
  const endpoint = (dbVals['storage.b2_endpoint'] || process.env.B2_ENDPOINT || '').trim();
  const region = (dbVals['storage.b2_region'] || process.env.B2_REGION || '').trim();
  const bucket = (dbVals['storage.b2_bucket'] || process.env.B2_BUCKET || '').trim();
  const keyId = decryptIfNeeded(dbVals['storage.b2_key_id']) || process.env.B2_KEY_ID || '';
  const applicationKey =
    decryptIfNeeded(dbVals['storage.b2_application_key']) || process.env.B2_APPLICATION_KEY || '';
  if (!endpoint || !region || !bucket || !keyId || !applicationKey) return null;
  return { endpoint, region, bucket, keyId, applicationKey };
}

/** Call from any handler that mutates a `storage.*` setting. */
export function invalidateStorageCache(): void {
  cachedConfig = undefined;
  cachedDriver = undefined;
}

export * from './types';
export * from './paths';
export * from './keys';
