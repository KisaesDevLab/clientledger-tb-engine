// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';
import {
  ClaudeProvider,
  OpenAICompatProvider,
  type LLMConfig,
  type LLMProvider,
  type VisionConfig,
} from './llmProvider';
import { decrypt, isEncrypted } from './encryption';
import { aiMode, routerProvider } from './routerProvider';

export const DEFAULT_FAST_MODEL    = 'claude-haiku-4-5-20251001';
export const DEFAULT_PRIMARY_MODEL = 'claude-sonnet-4-6';

// ── AI token limit settings ─────────────────────────────────────────────────

export interface AiTokenSettings {
  maxTokensDefault: number;
  maxTokensBankStatement: number;
  chunkCharLimit: number;
}

const AI_TOKEN_DEFAULTS: AiTokenSettings = {
  maxTokensDefault: 4096,
  maxTokensBankStatement: 32768,
  chunkCharLimit: 30000,
};

export async function getAiTokenSettings(): Promise<AiTokenSettings> {
  const keys = ['ai.max_tokens_default', 'ai.max_tokens_bank_statement', 'ai.chunk_char_limit'];
  const rows = await db('settings').whereIn('key', keys).select('key', 'value');
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key as string] = r.value as string;
  return {
    maxTokensDefault:       Number(s['ai.max_tokens_default'])        || AI_TOKEN_DEFAULTS.maxTokensDefault,
    maxTokensBankStatement: Number(s['ai.max_tokens_bank_statement']) || AI_TOKEN_DEFAULTS.maxTokensBankStatement,
    chunkCharLimit:         Number(s['ai.chunk_char_limit'])          || AI_TOKEN_DEFAULTS.chunkCharLimit,
  };
}

// ── New provider-agnostic entry point ─────────────────────────────────────────

/**
 * Reads LLM provider settings from the DB and returns a configured LLMProvider
 * plus the fast and primary model names for this provider.
 *
 * Provider selection order:
 *   1. settings: llm.provider  (claude | ollama | openai-compat)
 *   2. Defaults to 'claude' if key is missing or blank.
 */
export async function getLLMProvider(): Promise<LLMConfig> {
  // Router mode (MIG-1): every provider/model setting below is inert — task
  // classes + router policy pick the model; scrubbing, budgets, and cost live in
  // the router console. This never falls through to a direct provider: a router
  // outage must surface as an error, not silently ship prompts around the
  // scrubber and ledger.
  if (aiMode() === 'router') {
    const provider = routerProvider();
    // Model names here are labels only — call sites pass them back as
    // params.model, the driver ignores them, and ai_usage_log records the
    // model that actually served via result.servedModel.
    return {
      provider,
      fastModel: 'vibe-router',
      primaryModel: 'vibe-router',
      providerName: 'vibe_router',
      vision: { provider, model: 'vibe-router', providerName: 'vibe_router' },
    };
  }

  const s = await loadLLMSettings();

  const providerName = (s['llm.provider'] || 'claude') as 'claude' | 'ollama' | 'openai' | 'openai-compat';
  const timeoutMs = Number(s['llm.timeout_ms'] || '120000') || 120_000;

  let provider: LLMProvider;
  let fastModel: string;
  let primaryModel: string;

  /** Parse 'true'/'false'/'' override strings into boolean | undefined */
  function parseVisionOverride(val: string | undefined): boolean | undefined {
    if (val === 'true')  return true;
    if (val === 'false') return false;
    return undefined; // blank → let heuristic decide
  }

  if (providerName === 'ollama') {
    const baseURL = s['llm.ollama_base_url'];
    if (!baseURL) throw new Error('Ollama base URL not configured. An administrator sets it in the AI provider settings.');
    fastModel    = s['llm.ollama_vision_model']    || 'qwen3-vl:8b';
    primaryModel = s['llm.ollama_reasoning_model'] || 'qwq:32b';
    provider = new OpenAICompatProvider({
      providerName: 'ollama',
      baseURL,
      model: fastModel,
      timeoutMs,
      supportsVisionOverride: parseVisionOverride(s['llm.ollama_vision_override']),
    });
  } else if (providerName === 'openai') {
    const apiKey = s['llm.openai_api_key'];
    if (!apiKey) throw new Error('OpenAI API key not configured. An administrator sets it in the AI provider settings.');
    primaryModel = s['llm.openai_primary_model'] || 'gpt-4o';
    fastModel    = s['llm.openai_fast_model']    || primaryModel;
    provider = new OpenAICompatProvider({
      providerName: 'openai',
      baseURL: 'https://api.openai.com',
      apiKey,
      model: primaryModel,
      timeoutMs,
      supportsVisionOverride: true,
    });
  } else if (providerName === 'openai-compat') {
    const baseURL = s['llm.openai_compat_base_url'];
    if (!baseURL) throw new Error('OpenAI-compatible base URL not configured. An administrator sets it in the AI provider settings.');
    primaryModel = s['llm.openai_compat_model'] || '';
    // Separate fast model — falls back to primaryModel if not set
    fastModel    = s['llm.openai_compat_fast_model'] || primaryModel;
    provider = new OpenAICompatProvider({
      providerName: 'openai-compat',
      baseURL,
      apiKey: s['llm.openai_compat_api_key'] || undefined,
      model: primaryModel,
      timeoutMs,
      supportsVisionOverride: parseVisionOverride(s['llm.openai_compat_vision_override']),
    });
  } else {
    // Claude (default)
    const apiKey = s['claude_api_key'] ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Claude API key not configured. An administrator sets it in the AI provider settings.');
    fastModel    = s['ai_model_fast']    || DEFAULT_FAST_MODEL;
    primaryModel = s['ai_model_primary'] || DEFAULT_PRIMARY_MODEL;
    provider = new ClaudeProvider(new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 }));
  }

  // ── Vision config ──────────────────────────────────────────────────────────
  // When llm.vision_provider is blank or matches the main provider, reuse the
  // main provider instance with an optional vision-specific model override.
  // When different, construct a second provider from that type's stored creds.

  const visionProviderName = s['llm.vision_provider'] || '';
  const visionModelSetting = s['llm.vision_model'] || '';

  let vision: VisionConfig;

  if (!visionProviderName || visionProviderName === providerName) {
    // Same provider — pick a per-provider default if no explicit vision model
    const defaultVisionModel =
      providerName === 'claude' ? fastModel
        : providerName === 'ollama' ? fastModel   // ollama_vision_model already maps to fastModel
          : primaryModel;                          // openai / openai-compat
    vision = {
      provider,
      model: visionModelSetting || defaultVisionModel,
      providerName,
    };
  } else {
    // Different provider for vision — build a second provider instance
    vision = buildProviderFromSettings(visionProviderName, visionModelSetting, s, timeoutMs);
  }

  return { provider, fastModel, primaryModel, providerName, vision };
}

/**
 * Cheap check used by GET /api/v1/features so the SPA can hide AI-dependent
 * UI when no provider is configured. Tries to build a provider; treats any
 * throw (missing key, missing baseURL, etc.) as "AI unavailable".
 */
export async function isAiConfigured(): Promise<boolean> {
  // Router mode: URL + token presence is boot-validated; the SPA should show AI
  // features and let a router outage surface per-request rather than hiding UI.
  if (aiMode() === 'router') return true;
  try {
    await getLLMProvider();
    return true;
  } catch {
    return false;
  }
}

/**
 * Load all LLM-related settings from the database.
 * Exported so other modules (e.g. settings routes) can build ad-hoc providers.
 */
export async function loadLLMSettings(): Promise<Record<string, string>> {
  const LLM_KEYS = [
    'llm.provider', 'llm.ollama_base_url', 'llm.ollama_vision_model',
    'llm.ollama_reasoning_model', 'llm.ollama_vision_override',
    'llm.openai_api_key', 'llm.openai_primary_model', 'llm.openai_fast_model',
    'llm.openai_compat_base_url', 'llm.openai_compat_api_key',
    'llm.openai_compat_model', 'llm.openai_compat_fast_model',
    'llm.openai_compat_vision_override', 'llm.vision_provider', 'llm.vision_model',
    'llm.timeout_ms', 'claude_api_key', 'ai_model_fast', 'ai_model_primary',
  ];
  const ENCRYPTED_KEYS = new Set(['claude_api_key', 'llm.openai_api_key', 'llm.openai_compat_api_key']);
  const rows = await db('settings').whereIn('key', LLM_KEYS).select('key', 'value');
  const s: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key as string;
    let val = r.value as string;
    if (ENCRYPTED_KEYS.has(key) && val && isEncrypted(val)) {
      try { val = decrypt(val); } catch { /* treat as plaintext if decryption fails (legacy data) */ }
    }
    s[key] = val;
  }
  return s;
}

/** Construct a separate provider instance for a given provider type using stored creds. */
export function buildProviderFromSettings(
  vpName: string,
  model: string,
  s: Record<string, string>,
  timeoutMs: number,
): VisionConfig {
  if (vpName === 'claude') {
    const apiKey = s['claude_api_key'] ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Vision provider is Claude but no API key is configured.');
    return {
      provider: new ClaudeProvider(new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 })),
      model: model || s['ai_model_fast'] || DEFAULT_FAST_MODEL,
      providerName: 'claude',
    };
  }
  if (vpName === 'openai') {
    const apiKey = s['llm.openai_api_key'];
    if (!apiKey) throw new Error('Vision provider is OpenAI but no API key is configured.');
    const m = model || s['llm.openai_primary_model'] || 'gpt-4o';
    return {
      provider: new OpenAICompatProvider({
        providerName: 'openai',
        baseURL: 'https://api.openai.com',
        apiKey,
        model: m,
        timeoutMs,
        supportsVisionOverride: true,
      }),
      model: m,
      providerName: 'openai',
    };
  }
  if (vpName === 'ollama') {
    const baseURL = s['llm.ollama_base_url'];
    if (!baseURL) throw new Error('Vision provider is Ollama but no base URL is configured.');
    const m = model || s['llm.ollama_vision_model'] || 'qwen3-vl:8b';
    return {
      provider: new OpenAICompatProvider({
        providerName: 'ollama',
        baseURL,
        model: m,
        timeoutMs,
        supportsVisionOverride: true,
      }),
      model: m,
      providerName: 'ollama',
    };
  }
  if (vpName === 'openai-compat') {
    const baseURL = s['llm.openai_compat_base_url'];
    if (!baseURL) throw new Error('Vision provider is OpenAI-compatible but no base URL is configured.');
    const m = model || s['llm.openai_compat_model'] || '';
    return {
      provider: new OpenAICompatProvider({
        providerName: 'openai-compat',
        baseURL,
        apiKey: s['llm.openai_compat_api_key'] || undefined,
        model: m,
        timeoutMs,
        supportsVisionOverride: true,
      }),
      model: m,
      providerName: 'openai-compat',
    };
  }
  throw new Error(`Unknown vision provider: ${vpName}`);
}

