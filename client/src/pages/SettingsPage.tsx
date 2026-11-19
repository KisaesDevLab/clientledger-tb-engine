// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, saveSettings, deleteClaudeApiKey, testClaudeKey, getLLMProviderSettings, saveLLMProviderSettings, testLLM, testOcr, fetchOpenAIModels, fetchProviderModels, getMailSettings, saveMailSettings, testMail, saveAiMode, testAiRouter, MAIL_SECRET_KEEP, type LLMProvider, type LLMProviderSettings, type OpenAIModelInfo, type MailSettingsPatch, type MailTransport } from '../api/settings';
import { getMcpTokenStatus, generateMcpToken, revokeMcpToken } from '../api/mcpSettings';
import { getLegacyTaxCodeStatus, purgeLegacyTaxCodes, type LegacyTaxCodePurgeResult } from '../api/taxCodes';
import { getAiPricing, saveAiPricing, fetchAiPricingFromClaude, getAiUsage, getAiModels, saveAiModels, getAvailableModels, type AiPricingMap } from '../api/aiUsage';
import { useAuthStore } from '../store/uiStore';
import { confirmAction } from '../components/ConfirmDialog';
import { PasswordInput } from '../components/PasswordInput';
import { FirmIdentityCard } from '../components/FirmIdentityCard';
import { PdfEngineCard } from '../components/PdfEngineCard';
import { AccountSecurityCard } from '../components/security/AccountSecurityCard';
import { DesktopSyncCard } from '../components/DesktopSyncCard';
import { SecurityPolicyCard } from '../components/security/SecurityPolicyCard';
import { ROUTER_BASENAME } from '../lib/baseConfig';
import { RefreshButton } from '../components/RefreshButton';

function AdminBadge() {
  return (
    <span className="ml-2 px-1.5 py-0.5 text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded font-medium">
      Admin only
    </span>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [testResult, setTestResult] = useState<{ valid: boolean; message?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // AI model state
  const [fastModelInput, setFastModelInput] = useState('');
  const [primaryModelInput, setPrimaryModelInput] = useState('');
  const [fastModelCustom, setFastModelCustom] = useState('');
  const [primaryModelCustom, setPrimaryModelCustom] = useState('');
  const [modelsSaved, setModelsSaved] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // AI pricing state
  const [pricingEdits, setPricingEdits] = useState<AiPricingMap | null>(null);
  const [pricingSaved, setPricingSaved] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [fetchingPricing, setFetchingPricing] = useState(false);
  const [fetchDisclaimer, setFetchDisclaimer] = useState<string | null>(null);

  // AI mode state (router vs direct, MIG-1 dual-mode)
  const [aiModeSel, setAiModeSel] = useState<'direct' | 'router' | null>(null); // null = server value
  const [routerUrlInput, setRouterUrlInput] = useState<string | null>(null);    // null = untouched
  const [routerTokenInput, setRouterTokenInput] = useState('');                 // '' = keep stored token
  const [aiModeSaving, setAiModeSaving] = useState(false);
  const [aiModeError, setAiModeError] = useState<string | null>(null);
  const [aiModeSaved, setAiModeSaved] = useState(false);
  const [routerTesting, setRouterTesting] = useState(false);
  const [routerTestResult, setRouterTestResult] = useState<{ valid: boolean; message?: string } | null>(null);

  // LLM provider state
  const [llmEdits, setLlmEdits] = useState<Partial<LLMProviderSettings> | null>(null);
  const [llmSaved, setLlmSaved] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ valid: boolean; message?: string } | null>(null);
  const [ocrTesting, setOcrTesting] = useState(false);
  const [ocrTestResult, setOcrTestResult] = useState<{ valid: boolean; message?: string } | null>(null);

  // OpenAI model fetch state
  const [openaiModels, setOpenaiModels] = useState<OpenAIModelInfo[] | null>(null);
  const [openaiModelsFetching, setOpenaiModelsFetching] = useState(false);
  const [openaiModelsError, setOpenaiModelsError] = useState<string | null>(null);

  // Vision model fetch state
  const [visionModels, setVisionModels] = useState<OpenAIModelInfo[] | null>(null);
  const [visionModelsFetching, setVisionModelsFetching] = useState(false);
  const [visionModelsError, setVisionModelsError] = useState<string | null>(null);

  // MCP state
  const [mcpActiveTab, setMcpActiveTab] = useState<'stdio' | 'http'>('stdio');
  const [newMcpToken, setNewMcpToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  // Mail-provider state
  const [mailEdits, setMailEdits] = useState<MailSettingsPatch | null>(null);
  const [mailSaved, setMailSaved] = useState(false);
  const [mailError, setMailError] = useState<string | null>(null);
  const [mailTesting, setMailTesting] = useState(false);
  const [mailTestResult, setMailTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await getSettings();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
  });

  const saveMutation = useMutation({
    mutationFn: (key: string) => saveSettings({ claudeApiKey: key }),
    onSuccess: (res) => {
      if (res.error) { setSaveError(res.error.message); return; }
      qc.invalidateQueries({ queryKey: ['settings'] });
      setApiKeyInput('');
      setShowInput(false);
      setSaveError(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteClaudeApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setSaveSuccess(false);
    },
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testClaudeKey();
    setTesting(false);
    if (res.data) setTestResult(res.data);
  };

  // AI models query — all users can view
  const { data: modelsData } = useQuery({
    queryKey: ['ai-models'],
    queryFn: getAiModels,
  });

  // Available models from Anthropic API — fetched on demand via button, admin only
  const { data: availableModels, isFetching: availableLoading, error: availableError, refetch: refreshAvailableModels } = useQuery({
    queryKey: ['ai-models-available'],
    queryFn: getAvailableModels,
    enabled: false,
  });

  const handleSaveModels = async () => {
    setModelsError(null);
    const resolvedFast    = fastModelInput    === '__other__' ? fastModelCustom.trim()    : fastModelInput;
    const resolvedPrimary = primaryModelInput === '__other__' ? primaryModelCustom.trim() : primaryModelInput;
    const patch: { fastModel?: string; primaryModel?: string } = {};
    if (resolvedFast)    patch.fastModel    = resolvedFast;
    if (resolvedPrimary) patch.primaryModel = resolvedPrimary;
    if (Object.keys(patch).length === 0) return;
    try {
      await saveAiModels(patch);
      qc.invalidateQueries({ queryKey: ['ai-models'] });
      setFastModelInput('');
      setPrimaryModelInput('');
      setFastModelCustom('');
      setPrimaryModelCustom('');
      setModelsSaved(true);
      setTimeout(() => setModelsSaved(false), 3000);
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  // AI pricing query — all users can view
  const { data: pricingData } = useQuery({
    queryKey: ['ai-pricing'],
    queryFn: getAiPricing,
  });

  // AI usage query — all users can view
  const { data: usageData } = useQuery({
    queryKey: ['ai-usage'],
    queryFn: getAiUsage,
  });

  const effectivePricing = pricingEdits ?? pricingData ?? {};

  const handlePricingInput = (model: string, field: 'input' | 'output', raw: string) => {
    const val = parseFloat(raw);
    setPricingEdits((prev) => ({
      ...(prev ?? pricingData ?? {}),
      [model]: { ...(effectivePricing[model] ?? { input: 0, output: 0 }), [field]: isNaN(val) ? 0 : val },
    }));
  };

  const handleSavePricing = async () => {
    if (!pricingEdits) return;
    setPricingError(null);
    try {
      await saveAiPricing(pricingEdits);
      qc.invalidateQueries({ queryKey: ['ai-pricing'] });
      setPricingSaved(true);
      setTimeout(() => setPricingSaved(false), 3000);
    } catch (e) {
      setPricingError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const handleFetchPricing = async () => {
    setFetchingPricing(true);
    setFetchDisclaimer(null);
    setPricingError(null);
    try {
      const fetched = await fetchAiPricingFromClaude();
      setPricingEdits(fetched);
      setFetchDisclaimer('Prices populated from Claude\'s knowledge. Verify at anthropic.com/pricing before saving — knowledge cutoff may not reflect current rates.');
    } catch (e) {
      setPricingError(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setFetchingPricing(false);
    }
  };

  // LLM provider settings query (admin only)
  const { data: llmData } = useQuery({
    queryKey: ['llm-provider'],
    queryFn: async () => {
      if (!isAdmin) return null;
      const res = await getLLMProviderSettings();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: isAdmin,
  });

  const effectiveLlm: LLMProviderSettings = {
    provider: 'claude',
    ollamaBaseUrl: '',
    ollamaVisionModel: 'qwen3-vl:8b',
    ollamaReasoningModel: 'qwq:32b',
    ollamaVisionOverride: '',
    openaiApiKey: '',
    openaiPrimaryModel: '',
    openaiFastModel: '',
    visionProvider: '',
    visionModel: '',
    openaiCompatBaseUrl: '',
    openaiCompatApiKey: '',
    openaiCompatModel: '',
    openaiCompatFastModel: '',
    openaiCompatVisionOverride: '',
    timeoutMs: 120000,
    ocrEnabled: false,
    ocrProvider: 'llamacpp' as const,
    ocrBaseUrl: 'http://vibe-glm-ocr:8090',
    ocrModel: 'glm-ocr',
    ocrTimeoutMs: 120000,
    maxTokensDefault: 4096,
    maxTokensBankStatement: 32768,
    chunkCharLimit: 30000,
    ...(llmData ?? {}),
    ...(llmEdits ?? {}),
  };

  // Router mode (MIG-1): provider/model settings are managed in the router
  // console; the sections below render inert with an explanatory banner.
  const routerManaged = llmData?.aiMode === 'router';

  // AI mode card: the radio reflects unsaved selection, falling back to server state
  const effectiveAiMode: 'direct' | 'router' = aiModeSel ?? llmData?.aiMode ?? 'direct';
  const aiModeDirty =
    (aiModeSel !== null && aiModeSel !== (llmData?.aiMode ?? 'direct')) ||
    routerUrlInput !== null || routerTokenInput !== '';

  const routerFormValues = () => ({
    ...(routerUrlInput !== null ? { routerUrl: routerUrlInput } : {}),
    ...(routerTokenInput !== '' ? { routerToken: routerTokenInput } : {}),
  });

  const handleTestRouter = async () => {
    setRouterTesting(true);
    setRouterTestResult(null);
    const res = await testAiRouter(routerFormValues());
    setRouterTesting(false);
    if (res.error) setRouterTestResult({ valid: false, message: res.error.message });
    else if (res.data) setRouterTestResult(res.data);
  };

  const handleApplyAiMode = async () => {
    const targetMode = effectiveAiMode;
    const changingMode = targetMode !== (llmData?.aiMode ?? 'direct');
    if (changingMode && targetMode === 'direct') {
      const ok = await confirmAction({
        message: 'Switch to Direct API? AI requests will go straight to the provider configured below, bypassing the router’s scrubbing, per-class data-boundary policy, and cost ledger.',
        tone: 'danger',
        confirmLabel: 'Switch to Direct',
      });
      if (!ok) return;
    } else if (changingMode) {
      const ok = await confirmAction({
        message: 'Switch to Vibe AI Router? All AI traffic will flow through the router (verified with a health check first); the provider settings below become inactive.',
        confirmLabel: 'Switch to Router',
      });
      if (!ok) return;
    }
    setAiModeSaving(true);
    setAiModeError(null);
    const res = await saveAiMode({ mode: targetMode, ...routerFormValues() });
    setAiModeSaving(false);
    if (res.error) { setAiModeError(res.error.message); return; }
    qc.invalidateQueries({ queryKey: ['llm-provider'] });
    setAiModeSel(null);
    setRouterUrlInput(null);
    setRouterTokenInput('');
    setRouterTestResult(null);
    setAiModeSaved(true);
    setTimeout(() => setAiModeSaved(false), 3000);
  };

  const handleSaveLLM = async () => {
    if (!llmEdits) return;
    setLlmError(null);
    try {
      await saveLLMProviderSettings(llmEdits);
      qc.invalidateQueries({ queryKey: ['llm-provider'] });
      setLlmEdits(null);
      setLlmSaved(true);
      setTimeout(() => setLlmSaved(false), 3000);
    } catch (e) {
      setLlmError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const handleTestLLM = async () => {
    // Save pending edits first so the health check uses current values
    if (llmEdits) await handleSaveLLM();
    setLlmTesting(true);
    setLlmTestResult(null);
    const res = await testLLM();
    setLlmTesting(false);
    if (res.data) setLlmTestResult(res.data);
  };

  const handleTestOcr = async () => {
    if (llmEdits) {
      await handleSaveLLM();
      // If save failed, don't proceed with test against stale settings
      if (llmError) {
        setOcrTestResult({ valid: false, message: 'Save failed — fix settings errors first.' });
        return;
      }
    }
    setOcrTesting(true);
    setOcrTestResult(null);
    try {
      const res = await testOcr();
      if (res.error) {
        setOcrTestResult({ valid: false, message: res.error.message });
      } else {
        setOcrTestResult({ valid: true, message: `Connected to ${res.data?.model ?? 'OCR model'}` });
      }
    } catch (e) {
      setOcrTestResult({ valid: false, message: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setOcrTesting(false);
    }
  };

  // Mail provider settings query (admin only). The server masks secrets and
  // exposes hasX flags so the UI can show "(stored)" indicators without ever
  // round-tripping the actual credentials.
  const { data: mailData, isLoading: mailLoading } = useQuery({
    queryKey: ['mail-settings'],
    queryFn: async () => {
      if (!isAdmin) return null;
      const res = await getMailSettings();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: isAdmin,
  });

  // Effective view = persisted DB values + admin's pending edits. Secret-field
  // edits live separately (see buildMailPayload below) so the input can stay
  // empty without nuking the stored secret.
  const effectiveMail = {
    transport: (mailEdits?.transport ?? mailData?.transport ?? '') as MailTransport,
    from: mailEdits?.from ?? mailData?.from ?? '',
    smtpHost: mailEdits?.smtpHost ?? mailData?.smtp.host ?? '',
    smtpPort: String(mailEdits?.smtpPort ?? mailData?.smtp.port ?? '587'),
    smtpUser: mailEdits?.smtpUser ?? mailData?.smtp.user ?? '',
    smtpSecure: mailEdits?.smtpSecure ?? mailData?.smtp.secure ?? false,
    emailitApiUrl: mailEdits?.emailitApiUrl ?? mailData?.emailit.apiUrl ?? '',
    smtpPasswordInput: mailEdits?.smtpPassword === MAIL_SECRET_KEEP ? '' : (mailEdits?.smtpPassword ?? ''),
    postmarkTokenInput: mailEdits?.postmarkToken === MAIL_SECRET_KEEP ? '' : (mailEdits?.postmarkToken ?? ''),
    emailitApiKeyInput: mailEdits?.emailitApiKey === MAIL_SECRET_KEEP ? '' : (mailEdits?.emailitApiKey ?? ''),
  };

  // Build the request body. Untouched secrets get the KEEP sentinel so the
  // server preserves them; an empty edit goes through as an explicit clear.
  function buildMailPayload(): MailSettingsPatch {
    const p: MailSettingsPatch = {};
    if (mailEdits?.transport !== undefined) p.transport = mailEdits.transport;
    if (mailEdits?.from !== undefined) p.from = mailEdits.from;
    if (mailEdits?.smtpHost !== undefined) p.smtpHost = mailEdits.smtpHost;
    if (mailEdits?.smtpPort !== undefined) p.smtpPort = String(mailEdits.smtpPort);
    if (mailEdits?.smtpUser !== undefined) p.smtpUser = mailEdits.smtpUser;
    if (mailEdits?.smtpSecure !== undefined) p.smtpSecure = mailEdits.smtpSecure;
    if (mailEdits?.emailitApiUrl !== undefined) p.emailitApiUrl = mailEdits.emailitApiUrl;
    p.smtpPassword = mailEdits?.smtpPassword !== undefined ? mailEdits.smtpPassword : MAIL_SECRET_KEEP;
    p.postmarkToken = mailEdits?.postmarkToken !== undefined ? mailEdits.postmarkToken : MAIL_SECRET_KEEP;
    p.emailitApiKey = mailEdits?.emailitApiKey !== undefined ? mailEdits.emailitApiKey : MAIL_SECRET_KEEP;
    return p;
  }

  const handleSaveMail = async () => {
    setMailError(null);
    if (!mailEdits) return;
    const res = await saveMailSettings(buildMailPayload());
    if (res.error) {
      setMailError(res.error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ['mail-settings'] });
    qc.invalidateQueries({ queryKey: ['features'] });
    setMailEdits(null);
    setMailSaved(true);
    setTimeout(() => setMailSaved(false), 3000);
  };

  const handleTestMail = async () => {
    setMailTesting(true);
    setMailTestResult(null);
    // Test uses the form values when present, otherwise the persisted config.
    const res = await testMail(mailEdits ? buildMailPayload() : undefined);
    setMailTesting(false);
    if (res.error) {
      setMailTestResult({ ok: false, message: res.error.message });
      return;
    }
    setMailTestResult({ ok: true, message: `Sent to ${res.data.to} via ${res.data.transport}.` });
  };

  // Legacy alpha tax codes — one-time cleanup (admin). The card retires itself
  // once the status endpoint reports nothing left to remove.
  const [legacyPurgeResult, setLegacyPurgeResult] = useState<LegacyTaxCodePurgeResult | null>(null);
  const [legacyPurgeError, setLegacyPurgeError] = useState<string | null>(null);
  const { data: legacyTaxStatus, isLoading: legacyTaxLoading } = useQuery({
    queryKey: ['legacy-tax-code-status'],
    queryFn: async () => {
      const res = await getLegacyTaxCodeStatus();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: isAdmin,
  });
  const legacyPurgeMutation = useMutation({
    mutationFn: purgeLegacyTaxCodes,
    onSuccess: (res) => {
      if (res.error) { setLegacyPurgeError(res.error.message); return; }
      setLegacyPurgeError(null);
      setLegacyPurgeResult(res.data);
      qc.invalidateQueries({ queryKey: ['legacy-tax-code-status'] });
      // Every tax-code consumer must refetch: dropdowns, mapping page, COA.
      for (const key of ['tax-code', 'tax-codes', 'tax-codes-all', 'tax-codes-available', 'tax-codes-for-client']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      qc.invalidateQueries({ queryKey: ['chart-of-accounts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['coa'] });
    },
    onError: (err) => setLegacyPurgeError(err instanceof Error ? err.message : 'Cleanup failed'),
  });
  const handleLegacyPurge = async () => {
    if (!legacyTaxStatus) return;
    const n = legacyTaxStatus.accountsReferencing;
    const ok = await confirmAction({
      title: 'Remove legacy alpha tax codes?',
      message:
        `This permanently deletes ${legacyTaxStatus.legacyCodes} legacy system tax codes ` +
        `(and ${legacyTaxStatus.softwareMaps} software mappings). ` +
        `${n} account${n === 1 ? '' : 's'} currently use${n === 1 ? 's' : ''} one of them: each is moved to its ` +
        `numeric equivalent where that is unambiguous, otherwise it is left unmapped for you to reassign on ` +
        `Tax Mapping. Take a backup first if you want a way back.`,
      confirmLabel: 'Remove codes',
      tone: 'danger',
    });
    if (ok) legacyPurgeMutation.mutate();
  };

  // MCP token queries — all users can view status; mutations are admin only
  const { data: mcpData, isLoading: mcpLoading } = useQuery({
    queryKey: ['mcp-token'],
    queryFn: async () => {
      const res = await getMcpTokenStatus();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
  });

  const generateMcpMutation = useMutation({
    mutationFn: generateMcpToken,
    onSuccess: (res) => {
      if (res.error) return;
      qc.invalidateQueries({ queryKey: ['mcp-token'] });
      setNewMcpToken(res.data?.token ?? null);
    },
  });

  const revokeMcpMutation = useMutation({
    mutationFn: revokeMcpToken,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-token'] });
      setNewMcpToken(null);
    },
  });

  const handleCopyToken = async (token: string) => {
    await navigator.clipboard.writeText(token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  // MCP clients (Claude Desktop, etc.) connect to this app over HTTP. The
  // proxy chain is: client → web nginx → api:3001. So the public-facing URL is
  // window.location.origin + the SPA's base path. In single-app mode that's
  // https://host/mcp/sse; in multi-app it's https://host/tb/mcp/sse.
  const mcpHttpUrl = `${window.location.origin}${ROUTER_BASENAME}`;

  const stdioSnippet = `{
  "mcpServers": {
    "trial-balance": {
      "command": "node",
      "args": ["/path/to/trial-balance-app/server/dist/mcp-stdio.js"],
      "env": {
        "DATABASE_URL": "<your-postgres-connection-string>",
        "ANTHROPIC_API_KEY": "<your-anthropic-api-key>"
      }
    }
  }
}`;

  const httpSnippet = `{
  "mcpServers": {
    "trial-balance-http": {
      "url": "${mcpHttpUrl}/mcp/sse",
      "headers": {
        "Authorization": "Bearer ${newMcpToken ?? mcpData?.masked ?? '<your-mcp-token>'}"
      }
    }
  }
}`;

  const currentKey = data?.claude_api_key;

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Settings<RefreshButton /></h2>

      {/* Account & security: password, authenticator app, passkeys, trusted browsers — every user */}
      <AccountSecurityCard />

      {/* Desktop sync: pair ClientLedger Trial Balance on a computer — every user */}
      <DesktopSyncCard />

      {/* Firm identity: PDF headers + the public legal pages (admin) */}
      {isAdmin && <FirmIdentityCard />}

      {/* Statement Writer PDFs: the server-side Chromium (admin) */}
      {isAdmin && <PdfEngineCard />}

      {/* Sign-in security: public URL (passkey relying party) + require-2FA policy (admin) */}
      {isAdmin && <SecurityPolicyCard />}

      {/* AI Mode (MIG-1 dual-mode): admin-selectable router vs direct */}
      {isAdmin && llmData && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-5 py-4">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">AI Mode</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Choose how this installation sends AI requests: through the appliance&apos;s Vibe AI
            Router (central per-task-class policy, scrubbing, budgets, cost ledger) or directly
            to the provider configured in the AI Provider card below.
            {llmData.aiModeSource === 'env' && llmData.envAiMode && (
              <> Current mode comes from the <code>VIBE_AI_MODE={llmData.envAiMode}</code> environment
              variable; a choice applied here overrides it.</>
            )}
          </p>

          <div className="flex items-center gap-5 mb-3">
            {(['direct', 'router'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="radio"
                  name="ai-mode"
                  checked={effectiveAiMode === m}
                  onChange={() => { setAiModeSel(m); setRouterTestResult(null); setAiModeError(null); }}
                />
                {m === 'direct' ? 'Direct API' : 'Vibe AI Router'}
              </label>
            ))}
            <span className="text-xs text-gray-400 dark:text-gray-500">
              active: {llmData.aiMode ?? 'direct'}
              {llmData.aiModeSource === 'setting' ? ' (set in-app)' : llmData.aiModeSource === 'env' ? ' (from env)' : ' (default)'}
            </span>
          </div>

          {effectiveAiMode === 'router' && (
            <div className="space-y-3 mb-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Router URL</label>
                <input
                  type="text"
                  value={routerUrlInput ?? llmData.routerUrl ?? ''}
                  onChange={(e) => setRouterUrlInput(e.target.value)}
                  placeholder="http://vibe-ai-router:8220"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  App Token{llmData.routerTokenMasked ? ` — saved: ${llmData.routerTokenMasked}` : ''}
                </label>
                <PasswordInput
                  value={routerTokenInput}
                  onChange={(e) => setRouterTokenInput(e.target.value)}
                  placeholder={llmData.routerTokenMasked ? 'Leave blank to keep the existing token' : 'Token minted by the appliance ("vibe enable")'}
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleApplyAiMode}
              disabled={aiModeSaving || !aiModeDirty}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {aiModeSaving ? 'Applying…' : 'Apply Mode'}
            </button>
            {effectiveAiMode === 'router' && (
              <button
                onClick={handleTestRouter}
                disabled={routerTesting}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                {routerTesting ? 'Testing…' : 'Test Connection'}
              </button>
            )}
          </div>

          {routerTestResult && (
            <div className={`mt-3 px-3 py-2 rounded text-xs ${routerTestResult.valid ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'}`}>
              {routerTestResult.valid ? '✓ ' : '✗ '}{routerTestResult.message}
            </div>
          )}
          {aiModeError && (
            <div className="mt-3 px-3 py-2 rounded text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400">{aiModeError}</div>
          )}
          {aiModeSaved && (
            <div className="mt-3 px-3 py-2 rounded text-xs bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400">AI mode applied.</div>
          )}
        </div>
      )}

      {/* Managed by Vibe AI Router (MIG-1): provider settings are inert in router mode */}
      {isAdmin && routerManaged && (
        <div className="rounded-lg border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-900/20 px-5 py-4">
          <h3 className="text-sm font-semibold text-sky-800 dark:text-sky-300 mb-1">Managed by Vibe AI Router</h3>
          <p className="text-xs text-sky-700 dark:text-sky-400">
            This installation sends all AI requests through the appliance&apos;s Vibe AI Router.
            Model choice, data-boundary policy, scrubbing, budgets, and cost tracking are
            configured per task class in the router console — the provider settings below are
            inactive while router mode is active. Use the AI Mode card above to switch this
            installation to Direct API.
          </p>
        </div>
      )}

      {/* LLM Provider */}
      {isAdmin && (
        <div className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700${routerManaged ? ' pointer-events-none opacity-50' : ''}`}>
          <div className="px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">AI Provider</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Choose where AI requests are sent. Ollama and OpenAI-compatible providers keep all data on your own infrastructure.
            </p>

            {/* Provider selector */}
            <div className="mb-4">
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Provider</label>
              <select
                value={effectiveLlm.provider}
                onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), provider: e.target.value as LLMProvider }))}
                className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              >
                <option value="claude">Claude (Anthropic API)</option>
                <option value="openai">OpenAI (GPT-4o, o3, etc.)</option>
                <option value="ollama">Ollama (self-hosted)</option>
                <option value="openai-compat">OpenAI-Compatible (vLLM, LM Studio, etc.)</option>
              </select>
              {effectiveLlm.provider === 'claude' && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Cloud-hosted. Requires Anthropic API key below.</p>
              )}
              {effectiveLlm.provider === 'openai' && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">Cloud-hosted. Requires OpenAI API key.</p>
              )}
              {effectiveLlm.provider === 'ollama' && (
                <p className="text-xs text-teal-600 dark:text-teal-400 mt-1">Self-hosted — data never leaves your infrastructure.</p>
              )}
              {effectiveLlm.provider === 'openai-compat' && (
                <p className="text-xs text-purple-600 dark:text-purple-400 mt-1">Any endpoint speaking the OpenAI chat completions API.</p>
              )}
            </div>

            {/* Ollama fields */}
            {effectiveLlm.provider === 'ollama' && (
              <div className="space-y-3 mb-4 border border-teal-200 dark:border-teal-800 rounded p-3 bg-teal-50/30 dark:bg-teal-900/10">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Ollama Base URL</label>
                  <input
                    value={effectiveLlm.ollamaBaseUrl}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), ollamaBaseUrl: e.target.value }))}
                    placeholder="http://192.168.1.50:11434"
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-teal-500 dark:bg-gray-700 dark:text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Vision / Fast Model</label>
                    <input
                      value={effectiveLlm.ollamaVisionModel}
                      onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), ollamaVisionModel: e.target.value }))}
                      placeholder="qwen3-vl:8b"
                      className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-teal-500 dark:bg-gray-700 dark:text-white"
                    />
                    <p className="text-[10px] text-gray-400 mt-0.5">PDF extraction, classification</p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Reasoning / Primary Model</label>
                    <input
                      value={effectiveLlm.ollamaReasoningModel}
                      onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), ollamaReasoningModel: e.target.value }))}
                      placeholder="qwq:32b"
                      className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-teal-500 dark:bg-gray-700 dark:text-white"
                    />
                    <p className="text-[10px] text-gray-400 mt-0.5">Support chat, complex tasks</p>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Vision capability</label>
                  <select
                    value={effectiveLlm.ollamaVisionOverride}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), ollamaVisionOverride: e.target.value as '' | 'true' | 'false' }))}
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:bg-gray-700 dark:text-white"
                  >
                    <option value="">Auto-detect from model name</option>
                    <option value="true">Enabled (vision model)</option>
                    <option value="false">Disabled (text-only)</option>
                  </select>
                  <p className="text-[10px] text-gray-400 mt-0.5">Override if model name isn't recognized by auto-detection</p>
                </div>
              </div>
            )}

            {/* OpenAI fields */}
            {effectiveLlm.provider === 'openai' && (
              <div className="space-y-3 mb-4 border border-green-200 dark:border-green-800 rounded p-3 bg-green-50/30 dark:bg-green-900/10">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">OpenAI API Key</label>
                  <PasswordInput
                    value={effectiveLlm.openaiApiKey}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiApiKey: e.target.value }))}
                    placeholder="sk-..."
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 pr-9 text-sm w-full focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">Get your key from platform.openai.com/api-keys</p>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-xs text-gray-500 dark:text-gray-400">Models</label>
                    <button
                      onClick={async () => {
                        const key = effectiveLlm.openaiApiKey;
                        if (!key || key.startsWith('••••')) {
                          setOpenaiModelsError('Enter or save your API key first, then fetch models.');
                          return;
                        }
                        setOpenaiModelsFetching(true);
                        setOpenaiModelsError(null);
                        try {
                          const res = await fetchOpenAIModels(key);
                          if (res.error) throw new Error(res.error.message);
                          setOpenaiModels(res.data ?? []);
                        } catch (e) {
                          setOpenaiModelsError(e instanceof Error ? e.message : 'Failed to fetch models');
                        } finally {
                          setOpenaiModelsFetching(false);
                        }
                      }}
                      disabled={openaiModelsFetching}
                      className="px-2 py-0.5 text-xs border border-green-300 dark:border-green-700 rounded hover:bg-green-50 dark:hover:bg-green-900/30 text-green-700 dark:text-green-400 disabled:opacity-50"
                    >
                      {openaiModelsFetching ? 'Fetching…' : openaiModels ? 'Refresh Models' : 'Fetch Available Models'}
                    </button>
                    {openaiModelsError && <span className="text-xs text-red-500">{openaiModelsError}</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Primary Model</label>
                      {openaiModels ? (
                        <select
                          value={effectiveLlm.openaiPrimaryModel}
                          onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiPrimaryModel: e.target.value }))}
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
                        >
                          <option value="">Select a model…</option>
                          {openaiModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={effectiveLlm.openaiPrimaryModel}
                          onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiPrimaryModel: e.target.value }))}
                          placeholder="gpt-4o"
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
                        />
                      )}
                      <p className="text-[10px] text-gray-400 mt-0.5">Support chat, complex tasks</p>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Fast Model <span className="text-gray-400">(optional)</span></label>
                      {openaiModels ? (
                        <select
                          value={effectiveLlm.openaiFastModel}
                          onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiFastModel: e.target.value }))}
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
                        >
                          <option value="">Use Primary Model</option>
                          {openaiModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={effectiveLlm.openaiFastModel}
                          onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiFastModel: e.target.value }))}
                          placeholder="Leave blank to use Primary Model"
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
                        />
                      )}
                      <p className="text-[10px] text-gray-400 mt-0.5">Classification, PDF extraction, diagnostics</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* OpenAI-compat fields */}
            {effectiveLlm.provider === 'openai-compat' && (
              <div className="space-y-3 mb-4 border border-purple-200 dark:border-purple-800 rounded p-3 bg-purple-50/30 dark:bg-purple-900/10">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Base URL</label>
                  <input
                    value={effectiveLlm.openaiCompatBaseUrl}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiCompatBaseUrl: e.target.value }))}
                    placeholder="http://localhost:8000"
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key <span className="text-gray-400">(optional)</span></label>
                    <PasswordInput
                      value={effectiveLlm.openaiCompatApiKey}
                      onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiCompatApiKey: e.target.value }))}
                      placeholder="sk-..."
                      className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 pr-9 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Primary Model</label>
                    <input
                      value={effectiveLlm.openaiCompatModel}
                      onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiCompatModel: e.target.value }))}
                      placeholder="mistral-7b"
                      className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                    />
                    <p className="text-[10px] text-gray-400 mt-0.5">Support chat, complex tasks</p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Fast Model <span className="text-gray-400">(optional)</span></label>
                    <input
                      value={effectiveLlm.openaiCompatFastModel}
                      onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiCompatFastModel: e.target.value }))}
                      placeholder="Leave blank to use Primary Model"
                      className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                    />
                    <p className="text-[10px] text-gray-400 mt-0.5">Classification, PDF extraction</p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Vision capability</label>
                    <select
                      value={effectiveLlm.openaiCompatVisionOverride}
                      onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), openaiCompatVisionOverride: e.target.value as '' | 'true' | 'false' }))}
                      className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                    >
                      <option value="">Auto-detect from model name</option>
                      <option value="true">Enabled (vision model)</option>
                      <option value="false">Disabled (text-only)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Vision Processing */}
            {(() => {
              const effectiveVisionProvider = effectiveLlm.visionProvider || effectiveLlm.provider;
              const visionPlaceholder =
                effectiveVisionProvider === 'claude' ? 'Default: fast model'
                  : effectiveVisionProvider === 'ollama' ? 'Default: vision/fast model'
                    : 'Default: primary model';

              const handleFetchVisionModels = async () => {
                setVisionModelsFetching(true);
                setVisionModelsError(null);
                try {
                  const res = await fetchProviderModels(effectiveVisionProvider);
                  if (res.error) throw new Error(res.error.message);
                  setVisionModels(res.data ?? []);
                } catch (e) {
                  setVisionModelsError(e instanceof Error ? e.message : 'Failed to fetch models');
                } finally {
                  setVisionModelsFetching(false);
                }
              };

              return (
                <div className="mb-4 border border-blue-200 dark:border-blue-800 rounded p-3 bg-blue-50/30 dark:bg-blue-900/10">
                  <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">Vision Processing (Scanned / Handwritten PDFs)</p>
                  <p className="text-[10px] text-gray-400 dark:text-gray-500 mb-3">
                    When a PDF has no text layer, images are sent to a vision-capable AI. You can use a different provider or model for this.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Vision Provider</label>
                      <select
                        value={effectiveLlm.visionProvider}
                        onChange={(e) => {
                          setLlmEdits((p) => ({ ...(p ?? {}), visionProvider: e.target.value, visionModel: '' }));
                          setVisionModels(null);
                          setVisionModelsError(null);
                        }}
                        className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                      >
                        <option value="">Same as main provider</option>
                        <option value="claude">Claude (Anthropic)</option>
                        <option value="openai">OpenAI</option>
                        <option value="ollama">Ollama</option>
                        <option value="openai-compat">OpenAI-Compatible</option>
                      </select>
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <label className="text-xs text-gray-500 dark:text-gray-400">Vision Model <span className="text-gray-400">(optional)</span></label>
                        <button
                          onClick={handleFetchVisionModels}
                          disabled={visionModelsFetching}
                          className="px-2 py-0.5 text-[10px] border border-blue-300 dark:border-blue-700 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 text-blue-700 dark:text-blue-400 disabled:opacity-50"
                        >
                          {visionModelsFetching ? 'Fetching…' : visionModels ? 'Refresh' : 'Fetch Models'}
                        </button>
                        {visionModelsError && <span className="text-[10px] text-red-500">{visionModelsError}</span>}
                      </div>
                      {visionModels ? (
                        <select
                          value={effectiveLlm.visionModel}
                          onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), visionModel: e.target.value }))}
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                        >
                          <option value="">{visionPlaceholder}</option>
                          {visionModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={effectiveLlm.visionModel}
                          onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), visionModel: e.target.value }))}
                          placeholder={visionPlaceholder}
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                        />
                      )}
                    </div>
                  </div>
                  {effectiveLlm.visionProvider && effectiveLlm.visionProvider !== effectiveLlm.provider && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-2">
                      {effectiveLlm.visionProvider === 'claude' && 'Uses the Claude API key configured below.'}
                      {effectiveLlm.visionProvider === 'openai' && 'Uses the OpenAI API key from the OpenAI provider section. Switch to OpenAI as main provider to configure credentials, then switch back.'}
                      {effectiveLlm.visionProvider === 'ollama' && 'Uses the Ollama base URL from the Ollama provider section.'}
                      {effectiveLlm.visionProvider === 'openai-compat' && 'Uses the base URL and API key from the OpenAI-Compatible provider section.'}
                    </p>
                  )}
                </div>
              );
            })()}

            {/* OCR Pre-processing */}
            <div className="mb-4 border border-purple-200 dark:border-purple-800 rounded p-3 bg-purple-50/30 dark:bg-purple-900/10">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-gray-600 dark:text-gray-400">OCR Pre-processing</p>
                <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={effectiveLlm.ocrEnabled}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), ocrEnabled: e.target.checked }))}
                    className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                  />
                  Enable
                </label>
              </div>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mb-3">
                Use a local vision model (e.g. GLM-OCR) to extract text from PDF images before sending to the main AI.
                Improves accuracy for scanned documents and keeps image data local. Both backends speak the OpenAI
                <code className="mx-1 px-1 rounded bg-purple-100 dark:bg-purple-900/40 text-[10px]">/v1/chat/completions</code>
                wire format.
              </p>
              <div className="grid grid-cols-2 gap-3 mb-2">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">OCR Backend</label>
                  <select
                    value={effectiveLlm.ocrProvider}
                    onChange={(e) => {
                      const value = e.target.value as 'llamacpp' | 'ollama-openai';
                      setLlmEdits((p) => {
                        const prev = p ?? {};
                        const next: Partial<typeof effectiveLlm> = { ...prev, ocrProvider: value };
                        // Seed a sensible default URL when switching if the field is empty.
                        if (!effectiveLlm.ocrBaseUrl) {
                          next.ocrBaseUrl = value === 'llamacpp' ? 'http://vibe-glm-ocr:8090' : 'http://localhost:11434';
                        }
                        return next;
                      });
                    }}
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                  >
                    <option value="llamacpp">llama.cpp server</option>
                    <option value="ollama-openai">Ollama (OpenAI-compatible)</option>
                  </select>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {effectiveLlm.ocrProvider === 'llamacpp'
                      ? 'llama-server from llama.cpp (recommended for GLM-OCR)'
                      : 'Ollama exposes /v1/chat/completions on the same port as its native API'}
                  </p>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">OCR Model</label>
                  <input
                    value={effectiveLlm.ocrModel}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), ocrModel: e.target.value }))}
                    placeholder="glm-ocr"
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {effectiveLlm.ocrProvider === 'llamacpp'
                      ? 'Often ignored by llama.cpp (one model per server). Used for logging.'
                      : 'Ollama tag name (e.g. glm-ocr, minicpm-v). Default: glm-ocr'}
                  </p>
                </div>
              </div>
              <div className="mb-2">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">OCR Base URL</label>
                <input
                  value={effectiveLlm.ocrBaseUrl}
                  onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), ocrBaseUrl: e.target.value }))}
                  placeholder={effectiveLlm.ocrProvider === 'llamacpp' ? 'http://vibe-glm-ocr:8090' : 'http://localhost:11434'}
                  className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Requests are POSTed to <code className="px-1 rounded bg-purple-100 dark:bg-purple-900/40">{'{base}/v1/chat/completions'}</code>.
                </p>
                {effectiveLlm.ocrBaseUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|vibe-glm-ocr)(:|\/|$)/.test(effectiveLlm.ocrBaseUrl) && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                    Non-localhost URL: PDF page images will be sent over the network to this server. Ensure this is a trusted endpoint on a secure network.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 mb-2">
                <label className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">Per-page timeout (ms)</label>
                <input
                  type="number"
                  value={effectiveLlm.ocrTimeoutMs}
                  onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), ocrTimeoutMs: Number(e.target.value) || 120000 }))}
                  className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                />
                <span className="text-[10px] text-gray-400">Default: 120000 (2 min)</span>
              </div>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mb-2">
                OCR is CPU-intensive. Expect ~30-60 seconds per page on typical hardware. GPU acceleration significantly improves speed.
              </p>
              {effectiveLlm.ocrEnabled && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleTestOcr}
                    disabled={ocrTesting || !effectiveLlm.ocrBaseUrl}
                    className="px-3 py-1 text-xs border border-purple-300 dark:border-purple-700 rounded hover:bg-purple-50 dark:hover:bg-purple-900/30 dark:text-gray-300 disabled:opacity-50"
                  >
                    {ocrTesting ? 'Testing…' : 'Test OCR Connection'}
                  </button>
                  {ocrTestResult && (
                    <span className={`text-xs ${ocrTestResult.valid ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {ocrTestResult.valid ? ocrTestResult.message : `Failed: ${ocrTestResult.message}`}
                    </span>
                  )}
                </div>
              )}
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-2">
                Independent from the main AI provider. You can use Claude/OpenAI for data extraction while using a local llama.cpp or Ollama server for OCR.
              </p>
            </div>

            {/* Timeout */}
            <div className="mb-4 flex items-center gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">Timeout (ms)</label>
              <input
                type="number"
                value={effectiveLlm.timeoutMs}
                onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), timeoutMs: Number(e.target.value) || 120000 }))}
                className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              />
              <span className="text-xs text-gray-400">Default: 120000 (2 min)</span>
            </div>

            {/* AI Token Limits */}
            <div className="mb-4">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">AI Output Token Limits</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Default Max Tokens</label>
                  <input
                    type="number"
                    value={effectiveLlm.maxTokensDefault}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), maxTokensDefault: Number(e.target.value) || 4096 }))}
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  />
                  <span className="text-xs text-gray-400">General AI calls (default: 4096)</span>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Bank Statement Max Tokens</label>
                  <input
                    type="number"
                    value={effectiveLlm.maxTokensBankStatement}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), maxTokensBankStatement: Number(e.target.value) || 16384 }))}
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  />
                  <span className="text-xs text-gray-400">Per-chunk for large PDFs (default: 32768)</span>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Chunk Char Limit</label>
                  <input
                    type="number"
                    value={effectiveLlm.chunkCharLimit}
                    onChange={(e) => setLlmEdits((p) => ({ ...(p ?? {}), chunkCharLimit: Number(e.target.value) || 30000 }))}
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  />
                  <span className="text-xs text-gray-400">Split threshold for large docs (default: 30000)</span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleSaveLLM}
                disabled={!llmEdits}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
              >
                Save Provider Settings
              </button>
              <button
                onClick={handleTestLLM}
                disabled={llmTesting}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300 disabled:opacity-50"
              >
                {llmTesting ? 'Testing…' : 'Test Connection'}
              </button>
              {llmSaved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
              {llmError && <span className="text-xs text-red-600 dark:text-red-400">{llmError}</span>}
            </div>
            {llmTestResult && (
              <div className={`mt-2 text-xs px-3 py-2 rounded ${llmTestResult.valid ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400'}`}>
                {llmTestResult.valid ? 'Connection successful' : `Connection failed: ${llmTestResult.message}`}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Claude API Key — only shown when Claude is the active provider */}
      {effectiveLlm.provider === 'claude' && <div className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700${routerManaged ? ' pointer-events-none opacity-50' : ''}`}>
        <div className="px-5 py-4">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">
            Claude API Key
            {!isAdmin && <AdminBadge />}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Used for AI-powered transaction classification. The key is stored on the server and never exposed in full after saving.
            If not set here, the server falls back to the <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">ANTHROPIC_API_KEY</code> environment variable.
          </p>

          {isLoading ? (
            <div className="text-sm text-gray-400 dark:text-gray-500">Loading…</div>
          ) : (
            <div className="space-y-3">
              {currentKey ? (
                <div className="flex items-center gap-3">
                  <code className="text-sm bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded font-mono text-gray-700 dark:text-gray-300 flex-1">
                    {currentKey.masked}
                  </code>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => { setShowInput(true); setSaveError(null); }}
                        className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300"
                      >
                        Replace
                      </button>
                      <button
                        onClick={async () => { if (await confirmAction({ message: 'Remove the stored API key?', tone: 'danger' })) deleteMutation.mutate(); }}
                        disabled={deleteMutation.isPending}
                        className="px-3 py-1.5 text-sm text-red-500 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
                      >
                        {deleteMutation.isPending ? 'Removing…' : 'Remove'}
                      </button>
                    </>
                  )}
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300 disabled:opacity-50"
                  >
                    {testing ? 'Testing…' : 'Test'}
                  </button>
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400 italic">No API key stored.</p>
              )}

              {isAdmin && (!currentKey || showInput) && (
                <div className="space-y-2">
                  <PasswordInput
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="sk-ant-…"
                    autoComplete="new-password"
                    className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 pr-9 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  />
                  {saveError && (
                    <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-4 py-3 rounded text-sm">{saveError}</div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        if (!apiKeyInput.trim()) return;
                        setSaveError(null);
                        saveMutation.mutate(apiKeyInput.trim());
                      }}
                      disabled={saveMutation.isPending || !apiKeyInput.trim()}
                      className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      {saveMutation.isPending ? 'Saving…' : 'Save Key'}
                    </button>
                    {showInput && (
                      <button
                        onClick={() => { setShowInput(false); setApiKeyInput(''); setSaveError(null); }}
                        className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}

              {saveSuccess && (
                <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 text-green-700 dark:text-green-400 px-4 py-3 rounded text-sm">API key saved successfully.</div>
              )}
              {testResult && (
                testResult.valid
                  ? <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 text-green-700 dark:text-green-400 px-3 py-2 rounded text-sm">✓ API key is valid and connected to Claude.</div>
                  : <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-3 py-2 rounded text-sm">✗ Invalid API key: {testResult.message ?? 'Connection failed.'}</div>
              )}
            </div>
          )}
        </div>
      </div>}

      {/* AI Usage & Pricing */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
        <div className="px-5 py-4">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">
            AI Usage & Pricing
            {!isAdmin && <AdminBadge />}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Per-model token prices used to estimate API costs. Prices are in USD per million tokens.
          </p>

          {/* Model name configuration — only for Claude; other providers configure models in their own section */}
          {effectiveLlm.provider === 'claude' && (() => {
            const KNOWN_MODELS = availableModels?.map((m) => ({ id: m.id, label: m.displayName })) ?? [
              { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
              { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
              { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6' },
            ];
            const knownIds = new Set(KNOWN_MODELS.map((m) => m.id));

            const savedFast    = modelsData?.fastModel    ?? '';
            const savedPrimary = modelsData?.primaryModel ?? '';

            const selectFast    = fastModelInput    !== '' ? fastModelInput    : (knownIds.has(savedFast)    ? savedFast    : (savedFast    ? '__other__' : ''));
            const selectPrimary = primaryModelInput !== '' ? primaryModelInput : (knownIds.has(savedPrimary) ? savedPrimary : (savedPrimary ? '__other__' : ''));

            const isDirty = fastModelInput !== '' || primaryModelInput !== '';
            const canSave = isDirty &&
              (fastModelInput    !== '__other__' || fastModelCustom.trim()    !== '') &&
              (primaryModelInput !== '__other__' || primaryModelCustom.trim() !== '');

            const ModelSelect = ({
              value, onChangeSelect, customValue, onChangeCustom, current,
            }: {
              value: string;
              onChangeSelect: (v: string) => void;
              customValue: string;
              onChangeCustom: (v: string) => void;
              current: string;
            }) => (
              <div className="space-y-1">
                {isAdmin ? (
                  <>
                    <select
                      value={value}
                      onChange={(e) => onChangeSelect(e.target.value === current ? '' : e.target.value)}
                      className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white dark:bg-gray-700 dark:text-white"
                    >
                      {availableLoading && <option value="">Loading models…</option>}
                      {availableError && !availableLoading && !value && <option value="">Failed to load — using defaults</option>}
                      {KNOWN_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>{m.id} — {m.label}</option>
                      ))}
                      <option value="__other__">Other (enter model ID…)</option>
                    </select>
                    {value === '__other__' && (
                      <input
                        type="text"
                        value={customValue}
                        onChange={(e) => onChangeCustom(e.target.value)}
                        placeholder="e.g. claude-sonnet-4-7"
                        className="w-full border border-blue-300 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                        autoFocus
                      />
                    )}
                  </>
                ) : (
                  <code className="block text-xs bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 font-mono text-gray-700 dark:text-gray-300">
                    {current || '—'}
                  </code>
                )}
              </div>
            );

            return (
              <div className="mb-5 space-y-3">
                <div className="flex items-center gap-3">
                  <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Configured Models</p>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => void refreshAvailableModels()}
                        disabled={availableLoading}
                        className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300 disabled:opacity-50"
                      >
                        {availableLoading ? 'Fetching…' : availableModels ? 'Refresh Models' : 'Fetch Available Models'}
                      </button>
                      {availableError && <span className="text-xs text-red-500">Error: {availableError instanceof Error ? availableError.message : String(availableError)}</span>}
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Fast model <span className="text-gray-400 dark:text-gray-500">(classification, import, diagnostics)</span>
                    </label>
                    <ModelSelect
                      value={selectFast}
                      onChangeSelect={setFastModelInput}
                      customValue={fastModelCustom}
                      onChangeCustom={setFastModelCustom}
                      current={savedFast}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Primary model <span className="text-gray-400 dark:text-gray-500">(support chat)</span>
                    </label>
                    <ModelSelect
                      value={selectPrimary}
                      onChangeSelect={setPrimaryModelInput}
                      customValue={primaryModelCustom}
                      onChangeCustom={setPrimaryModelCustom}
                      current={savedPrimary}
                    />
                  </div>
                </div>
                {modelsError && <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-3 py-2 rounded text-xs">{modelsError}</div>}
                {modelsSaved && <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 text-green-700 dark:text-green-400 px-3 py-2 rounded text-xs">Models updated.</div>}
                {isAdmin && isDirty && (
                  <button
                    onClick={handleSaveModels}
                    disabled={!canSave}
                    className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    Save Models
                  </button>
                )}
              </div>
            );
          })()}

          {/* Pricing table */}
          <div className="overflow-x-auto mb-3">
            <table className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-gray-500 dark:text-gray-400 uppercase">
                  <th className="px-3 py-2 text-left">Model</th>
                  <th className="px-3 py-2 text-right">Input ($/M tokens)</th>
                  <th className="px-3 py-2 text-right">Output ($/M tokens)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {Object.keys(effectivePricing).map((model) => (
                  <tr key={model}>
                    <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">{model}</td>
                    <td className="px-3 py-2 text-right">
                      {isAdmin ? (
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={effectivePricing[model]?.input ?? 0}
                          onChange={(e) => handlePricingInput(model, 'input', e.target.value)}
                          className="w-24 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                        />
                      ) : (
                        <span className="text-xs text-gray-700 dark:text-gray-300">${effectivePricing[model]?.input?.toFixed(2) ?? '0.00'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isAdmin ? (
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={effectivePricing[model]?.output ?? 0}
                          onChange={(e) => handlePricingInput(model, 'output', e.target.value)}
                          className="w-24 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                        />
                      ) : (
                        <span className="text-xs text-gray-700 dark:text-gray-300">${effectivePricing[model]?.output?.toFixed(2) ?? '0.00'}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {Object.keys(effectivePricing).length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-xs text-gray-400 dark:text-gray-500">No pricing configured</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {isAdmin && (
            <>
              {fetchDisclaimer && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-400 px-3 py-2 rounded text-xs mb-2">
                  ⚠️ {fetchDisclaimer}
                </div>
              )}
              {pricingError && (
                <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-400 px-3 py-2 rounded text-xs mb-2">{pricingError}</div>
              )}
              {pricingSaved && (
                <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 text-green-700 dark:text-green-400 px-3 py-2 rounded text-xs mb-2">Pricing saved.</div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleFetchPricing}
                  disabled={fetchingPricing}
                  className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300 disabled:opacity-50"
                >
                  {fetchingPricing ? 'Fetching…' : 'Fetch Current Pricing'}
                </button>
                {pricingEdits && (
                  <button
                    onClick={handleSavePricing}
                    className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    Save Pricing
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Usage summary */}
        <div className="px-5 py-4">
          <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-3">Usage Summary (Current & Prior Month)</h4>
          {!usageData || usageData.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500 italic">No usage recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 uppercase">
                    <th className="px-3 py-2 text-left">Month</th>
                    <th className="px-3 py-2 text-left">Model</th>
                    <th className="px-3 py-2 text-right">Calls</th>
                    <th className="px-3 py-2 text-right">Input Tokens</th>
                    <th className="px-3 py-2 text-right">Output Tokens</th>
                    <th className="px-3 py-2 text-right">Est. Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {usageData.map((row, i) => (
                    <tr key={i} className="dark:text-gray-300">
                      <td className="px-3 py-2">{row.month}</td>
                      <td className="px-3 py-2 font-mono">{row.model}</td>
                      <td className="px-3 py-2 text-right">{Number(row.calls).toLocaleString()}</td>
                      <td className="px-3 py-2 text-right">{Number(row.input_tokens).toLocaleString()}</td>
                      <td className="px-3 py-2 text-right">{Number(row.output_tokens).toLocaleString()}</td>
                      <td className="px-3 py-2 text-right">
                        {row.estimated_cost_usd != null
                          ? `$${Number(row.estimated_cost_usd).toFixed(4)}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Email / Password Reset Provider */}
      {isAdmin && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">
              Email Provider
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Send password-reset emails. When configured, the &quot;Forgot password?&quot; link appears on the
              login page. Users without an email on file can still be reset by an admin under{' '}
              <strong>Admin &gt; Users</strong>. Secrets are encrypted at rest using your{' '}
              <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">ENCRYPTION_KEY</code>.
            </p>

            {mailLoading ? (
              <div className="text-sm text-gray-400 dark:text-gray-500">Loading…</div>
            ) : (
              <div className="space-y-4">
                {mailData?.envOverride && effectiveMail.transport === '' && (
                  <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-400 px-3 py-2 rounded text-xs">
                    Mail-related environment variables are set on the server. They&apos;ll be used until you save
                    a transport here.
                  </div>
                )}

                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Transport</label>
                  <select
                    value={effectiveMail.transport}
                    onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), transport: e.target.value as MailTransport }))}
                    className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full max-w-xs focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  >
                    <option value="">Disabled (no self-service reset)</option>
                    <option value="smtp">SMTP</option>
                    <option value="postmark">Postmark</option>
                    <option value="emailit">Emailit v2</option>
                  </select>
                </div>

                {effectiveMail.transport && (
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">From address</label>
                    <input
                      value={effectiveMail.from}
                      onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), from: e.target.value }))}
                      placeholder="Vibe TB <noreply@yourfirm.com>"
                      className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                    />
                  </div>
                )}

                {effectiveMail.transport === 'smtp' && (
                  <div className="space-y-3 border border-blue-200 dark:border-blue-800 rounded p-3 bg-blue-50/30 dark:bg-blue-900/10">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Host</label>
                        <input
                          value={effectiveMail.smtpHost}
                          onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), smtpHost: e.target.value }))}
                          placeholder="smtp.example.com"
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Port</label>
                        <input
                          value={effectiveMail.smtpPort}
                          onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), smtpPort: e.target.value }))}
                          placeholder="587"
                          inputMode="numeric"
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Username</label>
                        <input
                          value={effectiveMail.smtpUser}
                          onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), smtpUser: e.target.value }))}
                          autoComplete="off"
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                          Password {mailData?.smtp.hasPassword && <span className="text-gray-400">(stored — leave blank to keep)</span>}
                        </label>
                        <PasswordInput
                          value={effectiveMail.smtpPasswordInput}
                          onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), smtpPassword: e.target.value }))}
                          placeholder={mailData?.smtp.hasPassword ? '••••••••' : ''}
                          autoComplete="new-password"
                          className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 pr-9 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="inline-flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                        <input
                          type="checkbox"
                          checked={effectiveMail.smtpSecure}
                          onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), smtpSecure: e.target.checked }))}
                        />
                        Use TLS-on-connect (port 465). Leave off for STARTTLS on 587.
                      </label>
                    </div>
                  </div>
                )}

                {effectiveMail.transport === 'postmark' && (
                  <div className="space-y-3 border border-amber-200 dark:border-amber-800 rounded p-3 bg-amber-50/30 dark:bg-amber-900/10">
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                        Server token {mailData?.postmark.hasToken && <span className="text-gray-400">(stored — leave blank to keep)</span>}
                      </label>
                      <PasswordInput
                        value={effectiveMail.postmarkTokenInput}
                        onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), postmarkToken: e.target.value }))}
                        placeholder={mailData?.postmark.hasToken ? '••••••••' : ''}
                        autoComplete="new-password"
                        className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 pr-9 text-sm w-full focus:outline-none focus:ring-2 focus:ring-amber-500 dark:bg-gray-700 dark:text-white"
                      />
                      <p className="text-[11px] text-gray-400 mt-0.5">From your Postmark server settings (Server API tokens).</p>
                    </div>
                  </div>
                )}

                {effectiveMail.transport === 'emailit' && (
                  <div className="space-y-3 border border-purple-200 dark:border-purple-800 rounded p-3 bg-purple-50/30 dark:bg-purple-900/10">
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                        API key {mailData?.emailit.hasApiKey && <span className="text-gray-400">(stored — leave blank to keep)</span>}
                      </label>
                      <PasswordInput
                        value={effectiveMail.emailitApiKeyInput}
                        onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), emailitApiKey: e.target.value }))}
                        placeholder={mailData?.emailit.hasApiKey ? '••••••••' : ''}
                        autoComplete="new-password"
                        className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 pr-9 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API URL <span className="text-gray-400">(optional)</span></label>
                      <input
                        value={effectiveMail.emailitApiUrl}
                        onChange={(e) => setMailEdits((p) => ({ ...(p ?? {}), emailitApiUrl: e.target.value }))}
                        placeholder="https://api.emailit.com/v1"
                        className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleSaveMail}
                    disabled={!mailEdits}
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
                  >
                    Save Email Settings
                  </button>
                  <button
                    onClick={handleTestMail}
                    disabled={mailTesting || (effectiveMail.transport === '' && !mailData?.transport)}
                    title={!user?.email ? 'Add an email to your own user account first' : 'Send a test email to your account'}
                    className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:text-gray-300 disabled:opacity-50"
                  >
                    {mailTesting ? 'Sending…' : 'Send Test Email'}
                  </button>
                  {mailSaved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
                  {mailError && <span className="text-xs text-red-600 dark:text-red-400">{mailError}</span>}
                </div>
                {mailTestResult && (
                  <div className={`text-xs px-3 py-2 rounded ${mailTestResult.ok ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400'}`}>
                    {mailTestResult.ok ? `Test sent — ${mailTestResult.message}` : `Test failed: ${mailTestResult.message}`}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Legacy tax code cleanup — one-time, admin only */}
      {isAdmin && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">Tax Code Cleanup</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              System tax codes are numeric only. Older installs also carry a legacy set of alpha codes
              (<code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">GROSS_RECEIPTS</code>,{' '}
              <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">REPORTING_ONLY</code>, …) that duplicates
              every line in the tax code dropdowns. This one-time action removes them and re-points any accounts
              that used them.
            </p>

            {legacyTaxLoading ? (
              <div className="text-sm text-gray-400 dark:text-gray-500">Checking…</div>
            ) : legacyPurgeResult ? (
              <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 text-green-800 dark:text-green-400 px-3 py-2 rounded text-xs">
                <div className="font-medium mb-1">Removed {legacyPurgeResult.deletedCodes} legacy tax codes.</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>
                    Accounts: {legacyPurgeResult.accountsRemapped} moved to numeric equivalents
                    {legacyPurgeResult.accountsCleared > 0 && (
                      <>, <strong>{legacyPurgeResult.accountsCleared} left unmapped</strong> — reassign them on Tax Mapping</>
                    )}
                  </li>
                  {(legacyPurgeResult.templateRowsRemapped + legacyPurgeResult.templateRowsCleared) > 0 && (
                    <li>COA template rows: {legacyPurgeResult.templateRowsRemapped} remapped, {legacyPurgeResult.templateRowsCleared} cleared</li>
                  )}
                  {(legacyPurgeResult.consolidationRowsRemapped + legacyPurgeResult.consolidationRowsDeleted) > 0 && (
                    <li>Export consolidation rows: {legacyPurgeResult.consolidationRowsRemapped} remapped, {legacyPurgeResult.consolidationRowsDeleted} removed</li>
                  )}
                </ul>
              </div>
            ) : !legacyTaxStatus || legacyTaxStatus.legacyCodes === 0 ? (
              <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                Nothing to clean up — all system tax codes are numeric.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-300 px-3 py-2 rounded text-xs">
                  <div className="font-medium">
                    {legacyTaxStatus.legacyCodes} legacy alpha tax codes found
                    {legacyTaxStatus.accountsReferencing > 0 && ` · used by ${legacyTaxStatus.accountsReferencing} account${legacyTaxStatus.accountsReferencing === 1 ? '' : 's'}`}
                  </div>
                  {legacyTaxStatus.sample.length > 0 && (
                    <div className="mt-1 font-mono text-[11px] text-amber-700 dark:text-amber-400">
                      e.g. {legacyTaxStatus.sample.map((c) => c.taxCode).join(', ')}
                      {legacyTaxStatus.legacyCodes > legacyTaxStatus.sample.length && ' …'}
                    </div>
                  )}
                </div>
                {legacyPurgeError && (
                  <div className="text-xs text-red-600 dark:text-red-400">{legacyPurgeError}</div>
                )}
                <button
                  onClick={handleLegacyPurge}
                  disabled={legacyPurgeMutation.isPending}
                  className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {legacyPurgeMutation.isPending ? 'Removing…' : 'Remove legacy alpha tax codes'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MCP / Claude Desktop Integration */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
        <div className="px-5 py-4">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">
            MCP / Claude Desktop Integration
            {!isAdmin && <AdminBadge />}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Connect Claude Desktop (or any MCP-compatible client) to this app. Generate a token to authenticate,
            then use the snippets below to configure your client.
          </p>

          {mcpLoading ? (
            <div className="text-sm text-gray-400 dark:text-gray-500">Loading…</div>
          ) : (
            <div className="space-y-4">
              {/* Token status */}
              <div className="flex items-center gap-3">
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${mcpData?.configured ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${mcpData?.configured ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-500'}`} />
                  {mcpData?.configured ? 'Token configured' : 'No token configured'}
                </span>
                {mcpData?.configured && (
                  <code className="text-sm bg-gray-100 dark:bg-gray-700 px-3 py-1 rounded font-mono text-gray-700 dark:text-gray-300">
                    {newMcpToken ?? mcpData.masked}
                  </code>
                )}
              </div>

              {/* New token banner — admin only */}
              {isAdmin && newMcpToken && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded p-3 space-y-2">
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-400">Save this token — it will not be shown again</p>
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-amber-100 dark:bg-amber-900/40 px-2 py-1 rounded font-mono text-amber-900 dark:text-amber-300 flex-1 break-all">
                      {newMcpToken}
                    </code>
                    <button
                      onClick={() => handleCopyToken(newMcpToken)}
                      className="px-3 py-1.5 text-xs border border-amber-300 dark:border-amber-600 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap"
                    >
                      {tokenCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {/* Actions — admin only */}
              {isAdmin && (
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      if (mcpData?.configured && !await confirmAction({ message: 'This will invalidate the existing token. Continue?', confirmLabel: 'Rotate' })) return;
                      setNewMcpToken(null);
                      generateMcpMutation.mutate();
                    }}
                    disabled={generateMcpMutation.isPending}
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    {generateMcpMutation.isPending ? 'Generating…' : (mcpData?.configured ? 'Rotate Token' : 'Generate Token')}
                  </button>
                  {mcpData?.configured && (
                    <button
                      onClick={async () => { if (await confirmAction({ message: 'Revoke the MCP token? All connected clients will be disconnected.', tone: 'danger' })) revokeMcpMutation.mutate(); }}
                      disabled={revokeMcpMutation.isPending}
                      className="px-3 py-1.5 text-sm text-red-500 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
                    >
                      {revokeMcpMutation.isPending ? 'Revoking…' : 'Revoke Token'}
                    </button>
                  )}
                </div>
              )}

              {/* Integration snippets — visible to all if token is configured */}
              {mcpData?.configured && (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Claude Desktop configuration snippet:</p>
                  <div className="flex border border-gray-200 dark:border-gray-700 rounded-t overflow-hidden">
                    {(['stdio', 'http'] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setMcpActiveTab(tab)}
                        className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${mcpActiveTab === tab ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
                      >
                        {tab === 'stdio' ? 'stdio (local)' : 'HTTP/SSE (remote)'}
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <pre className="text-xs bg-gray-900 text-gray-100 p-3 rounded-b overflow-x-auto whitespace-pre-wrap border border-t-0 border-gray-200">
                      {mcpActiveTab === 'stdio' ? stdioSnippet : httpSnippet}
                    </pre>
                    <button
                      onClick={() => handleCopyToken(mcpActiveTab === 'stdio' ? stdioSnippet : httpSnippet)}
                      className="absolute top-2 right-2 px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                    >
                      {tokenCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    Add this to your <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">claude_desktop_config.json</code> file.
                    {mcpActiveTab === 'stdio' && ' Update the path and database credentials before using.'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
