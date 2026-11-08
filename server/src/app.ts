// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import 'dotenv/config';
import express from 'express';
import type { Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import authRoutes from './routes/auth';
import passwordResetRoutes from './routes/passwordReset';
import { totpRouter } from './routes/totp';
import { passkeysRouter } from './routes/passkeys';
import { trustedBrowsersRouter } from './routes/trustedBrowsers';
import { loadSecuritySettings, securitySettings } from './lib/securitySettings';
import { getRelyingParty } from './lib/publicUrl';
import { rateLimitKey } from './lib/rateLimitKey';
import clientRoutes from './routes/clients';
import { coaCollectionRouter, coaItemRouter } from './routes/chartOfAccounts';
import { periodCollectionRouter, periodItemRouter } from './routes/periods';
import { tbPeriodRouter } from './routes/trialBalance';
import { glPeriodRouter } from './routes/generalLedger';
import { dashboardRouter } from './routes/dashboard';
import { rollForwardRouter } from './routes/rollForward';
import { usersRouter } from './routes/users';
import { jeCollectionRouter, jeItemRouter } from './routes/journalEntries';
import { btCollectionRouter, btRulesRouter } from './routes/bankTransactions';
import { settingsRouter, loadFirmIdentity } from './routes/settings';
import { diagnosticsRouter } from './routes/diagnostics';
import { reconciliationCollectionRouter, reconciliationItemRouter } from './routes/reconciliations';
import { m1CollectionRouter, m1ItemRouter } from './routes/taxWorkpapers';
import { engagementCollectionRouter, engagementItemRouter, engagementSummaryRouter } from './routes/engagement';
import { cashFlowRouter } from './routes/cashFlow';
import { tickmarkLibraryCollectionRouter, tickmarkLibraryItemRouter, tbTickmarkRouter, systemTickmarkCollectionRouter, systemTickmarkItemRouter } from './routes/tickmarks';
import { leadSheetCollectionRouter, leadSheetItemRouter, leadSheetPeriodRouter } from './routes/leadSheets';
import { storageRouter } from './routes/storage';
import { leadSheetAttachmentCollectionRouter, leadSheetAttachmentItemRouter } from './routes/leadSheetAttachments';
import { savedReportCollectionRouter, savedReportItemRouter } from './routes/savedReports';
import { fsClientRouter, fsFontsRouter, fsPeriodRouter, fsRouter } from './routes/fs';
import { varianceNotesRouter } from './routes/varianceNotes';
import { pdfReportsRouter } from './routes/pdfReports';
import { taxCodesRouter } from './routes/taxCodes';
import { comparisonRouter } from './routes/comparison';
import { exportsRouter } from './routes/exports';
import { taxLineAssignmentRouter } from './routes/taxLineAssignment';
import { csvImportRouter } from './routes/csvImport';
import { pdfImportRouter } from './routes/pdfImport';
import { bankStatementPdfRouter } from './routes/bankStatementPdfImport';
import { scannedSheetRouter } from './routes/scannedSheetImport';
import { documentsCollectionRouter, documentsItemRouter } from './routes/documents';
import { backupRouter, restoreRouter, startBackupScheduler } from './routes/backup';
import { auditLogRouter } from './routes/auditLog';
import { supportRouter } from './routes/support';
import { coaTemplatesRouter } from './routes/coaTemplates';
import { payeesRouter } from './routes/payees';
import { unitsRouter } from './routes/units';
import { pyComparisonRouter } from './routes/pyComparison';
import { mcpRouter } from './routes/mcpHttp';
import { qboIntegrationRouter } from './routes/qboIntegration';
import { qboImportRouter } from './routes/qboImport';
import { isQboConfigured } from './lib/qbo/settings';
import { startQboKeepalive } from './lib/qbo/keepalive';
import { db } from './db';
import { sendServerError } from './lib/safeError';
import { isAiConfigured } from './lib/aiClient';
import { registerTbTaskClasses, validateAiModeEnv } from './lib/routerProvider';
import { loadAiModeOverrides } from './lib/aiModeSettings';
import { isMailerConfigured } from './lib/mailService';
import { isRateLimitedAuthPath, startVibeAuth, vibeAuthMiddleware } from './lib/vibeAuth';
import { desktopSessionMiddleware } from './desktop/session';
import { isDesktopMode, skipRateLimit } from './desktop/env';

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.ALLOWED_ORIGIN) {
  console.error('\nFATAL: ALLOWED_ORIGIN environment variable is required in production.\n');
  process.exit(1);
}

// Refuse to boot on invalid AI-mode config (MIG-1): router mode without a router
// URL + app token would fail every AI request with a worse message later.
{
  const aiModeError = validateAiModeEnv();
  if (aiModeError) {
    console.error(`\nFATAL: ${aiModeError}\n`);
    process.exit(1);
  }
}

// Parse a comma-separated ALLOWED_ORIGIN list. Entries wrapped in / / are
// treated as regex (e.g. /^https:\/\/.*\.firm\.com$/). Empty or unset →
// dev-friendly localhost defaults.
function parseAllowedOrigins(raw: string | undefined): (string | RegExp)[] {
  if (!raw || !raw.trim()) return ['http://localhost:5173', 'http://localhost:3000'];
  return raw.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      // Treat as regex only when the body between the slashes is non-empty —
      // `//` would compile to an empty regex that matches every origin.
      if (entry.length > 2 && entry.startsWith('/') && entry.endsWith('/')) {
        try {
          return new RegExp(entry.slice(1, -1));
        } catch (err) {
          console.error(`[cors] invalid regex entry "${entry}":`, (err as Error).message);
          return entry; // fall back to literal match — safer than throwing at startup
        }
      }
      return entry;
    });
}

const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGIN);

// Respect X-Forwarded-For from a trusted reverse proxy (e.g. Nginx on the Pi).
// This lets rate-limit fall back to real client IP for unauthenticated paths
// instead of all requests sharing the proxy IP.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    // No Origin header (server-to-server, curl) — allow.
    if (!origin) return cb(null, true);
    const ok = allowedOrigins.some(o => o instanceof RegExp ? o.test(origin) : o === origin);
    if (ok) return cb(null, true);
    console.info(`[cors] rejected origin: ${origin}`);
    return cb(null, false);
  },
  credentials: true,
  // Downloads read their filename off this header; without exposing it the
  // browser hides it cross-origin and every PDF saves under the caller's
  // fallback name.
  exposedHeaders: ['Content-Disposition'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(desktopSessionMiddleware); // no-op unless DESKTOP_MODE=true

// Rate-limit bucketing key lives in lib/rateLimitKey.ts (shared with the
// per-account limiters on the second-factor endpoints).

// Statement Writer preview fonts: public, immutable, allowlisted static bytes
// (routes/fs.ts). Mounted ABOVE the limiter — one preview pulls up to four
// font files, and they must not spend the request budget of whoever shares
// the address.
app.use('/api/v1/fs-fonts', fsFontsRouter);

// Global rate limiter — 200 requests per 15 minutes per user (or per IP if unauth)
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  skip: skipRateLimit,
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } },
}));

// Vibe Auth's browser-facing steps live outside /api/ and so outside the
// limiter above. 100 per 15 minutes per address absorbs a sign-in storm
// without touching the identity provider's back-channel logout, which arrives
// from ONE address on behalf of every user (isRateLimitedAuthPath).
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  skip: (req) => !isRateLimitedAuthPath(req.path),
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Please try again later.' } },
}));

// Stricter limits for file upload / first-pass AI endpoints — 40 per hour per
// user. One of these is a whole document being uploaded and read, so the count
// tracks documents, not rows.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  skip: skipRateLimit,
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many upload/AI requests. Please try again later.' } },
});

// Follow-up work on a document that has already been uploaded. These do NOT
// cost one request per document: account numbering is chunked (one request per
// SUGGEST_CHUNK_SIZE rows, so the count scales with the size of the trial
// balance) and import chat is conversational. Confirm costs nothing at all —
// no upload, no AI, just the write. Sharing the 20/hour upload budget meant a
// few hundred accounts spent it on their own numbering and were then refused
// at confirm, which is the one request that must not fail.
const aiStepLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  skip: skipRateLimit,
  message: { data: null, error: { code: 'RATE_LIMITED', message: 'Too many import requests. Please try again later.' } },
});

// Anything under /import/ that isn't the upload+analyze pass. Matched on the
// path tail so it holds for every source (csv, pdf, bank-statement, scanned).
const IMPORT_FOLLOW_UP = /\/(confirm|suggest-numbers|suggest-matches|chat|categorize|imports)$/;

app.use('/api/v1/import/', (req, res, next) => {
  // GETs are reads (listing imports, cached verification results) — never an
  // upload, so they have no business spending the upload budget either.
  if (req.method === 'GET' || IMPORT_FOLLOW_UP.test(req.path)) {
    return aiStepLimiter(req, res, next);
  }
  return uploadLimiter(req, res, next);
});
app.use('/api/v1/support/chat', uploadLimiter);
app.use('/api/v1/periods/:periodId/diagnostics', uploadLimiter);

// Reviewer accounts are read-only. Block mutating HTTP methods at the API
// boundary using the JWT claim's role. Full auth validation still happens
// inside each router's authMiddleware — this is just a fast gate that prevents
// reviewers from reaching any write handler. We deliberately don't hit the DB
// here; if a reviewer was just promoted to staff, there is a ≤30s window
// (matching the auth cache TTL) before writes are accepted.
app.use('/api/v1', (req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next(); // let authMiddleware send 401
  try {
    const decoded = jwt.decode(authHeader.slice(7)) as { role?: string } | null;
    if (decoded?.role === 'reviewer') {
      res.status(403).json({
        data: null,
        error: { code: 'READ_ONLY', message: 'Reviewer accounts cannot modify data.' },
      });
      return;
    }
  } catch {
    // fall through — authMiddleware will handle bad tokens
  }
  next();
});

// Readiness probe: returns 503 when any required dependency (currently the
// database) is unhealthy. Used by Docker HEALTHCHECK and by the appliance's
// HAProxy backend probes.
app.get('/api/v1/health', async (_req, res) => {
  const checks: Record<string, { ok: boolean; ms?: number; error?: string }> = {};
  const start = Date.now();
  try {
    await db.raw('SELECT 1');
    checks.db = { ok: true, ms: Date.now() - start };
  } catch (err) {
    checks.db = { ok: false, error: (err as Error).message };
  }
  const ok = Object.values(checks).every(c => c.ok);
  res.status(ok ? 200 : 503).json({
    data: { ok, version: process.env.npm_package_version, checks },
    error: null,
  });
});

// Liveness probe: cheap, no DB touch. Used to distinguish "process is up"
// from "process is ready to serve traffic" — see /health for the latter.
app.get('/api/v1/ping', (_req, res) => {
  res.status(200).json({
    data: { ok: true, version: process.env.npm_package_version },
    error: null,
  });
});

// Public feature flags: the SPA reads this on boot to decide whether to
// render AI-dependent UI (chat bubble, support page link). Unauthenticated
// — no sensitive data exposed.
app.get('/api/v1/features', async (_req, res) => {
  let passwordResetEnabled = false;
  try {
    passwordResetEnabled = await isMailerConfigured();
  } catch {
    passwordResetEnabled = !!process.env.MAIL_TRANSPORT;
  }
  // Same underlying fact — a mail transport is configured — under a name that
  // reads right for every mail-dependent feature, not just password reset.
  const mailEnabled = passwordResetEnabled;
  // Sign-in flags come from in-memory snapshots (no extra DB call): the login
  // page shows the passkey button only when the relying party is derivable.
  const passkeys = getRelyingParty().ok;
  const requireTwoFactor = securitySettings().requireTwoFactor;
  const totp = true;
  try {
    const ai = await isAiConfigured();
    const quickbooks = await isQboConfigured();
    res.json({ data: { ai, passwordResetEnabled, mailEnabled, quickbooks, passkeys, totp, requireTwoFactor }, error: null });
  } catch {
    // If the settings table query fails (e.g., DB down), fall back to env.
    const quickbooks = !!process.env.QBO_CLIENT_ID && !!process.env.QBO_CLIENT_SECRET;
    res.json({ data: { ai: !!process.env.ANTHROPIC_API_KEY, passwordResetEnabled, mailEnabled, quickbooks, passkeys, totp, requireTwoFactor }, error: null });
  }
});

// Public operator identity for the unauthenticated /privacy and /terms pages
// (the URLs Intuit's production checklist asks for). Name, postal address and
// contact email only — the same lines already printed on every PDF header.
app.get('/api/v1/public/legal', async (_req, res) => {
  try {
    const firm = await loadFirmIdentity();
    res.json({ data: { firmName: firm.name, firmAddress: firm.address, contactEmail: firm.email }, error: null });
  } catch {
    res.json({ data: { firmName: '', firmAddress: '', contactEmail: '' }, error: null });
  }
});

// Vibe Auth (single sign-on): GET /auth/status, the /auth/oidc/* flow and the
// admin /auth/settings API, all outside /api/v1 (the package's paths are what
// the appliance registers with the identity provider). Mounted after the
// public probes and body parser and before every router that applies
// authMiddleware; it only answers /auth/* and passes everything else through,
// so /mcp and the QuickBooks callback are untouched. See lib/vibeAuth.ts.
app.use(vibeAuthMiddleware());

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/auth', passwordResetRoutes);
app.use('/api/v1/auth', totpRouter);
app.use('/api/v1/auth', passkeysRouter);
app.use('/api/v1/auth', trustedBrowsersRouter);
app.use('/api/v1/clients', clientRoutes);
app.use('/api/v1/clients/:clientId/chart-of-accounts', coaCollectionRouter);
app.use('/api/v1/chart-of-accounts', coaItemRouter);
app.use('/api/v1/clients/:clientId/periods', periodCollectionRouter);
app.use('/api/v1/periods', periodItemRouter);
app.use('/api/v1/periods/:periodId/trial-balance', tbPeriodRouter);
app.use('/api/v1/periods/:periodId/general-ledger', glPeriodRouter);
app.use('/api/v1/periods/:periodId/dashboard', dashboardRouter);
app.use('/api/v1/periods/:id/roll-forward', rollForwardRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/journal-entries', jeItemRouter);
app.use('/api/v1/periods/:periodId/journal-entries', jeCollectionRouter);
app.use('/api/v1/clients/:clientId/bank-transactions', btCollectionRouter);
app.use('/api/v1/clients/:clientId/classification-rules', btRulesRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/periods/:periodId/diagnostics', diagnosticsRouter);
app.use('/api/v1/clients/:clientId/reconciliations', reconciliationCollectionRouter);
app.use('/api/v1/reconciliations/:id', reconciliationItemRouter);
app.use('/api/v1/periods/:periodId/m1-adjustments', m1CollectionRouter);
app.use('/api/v1/m1-adjustments/:id', m1ItemRouter);
app.use('/api/v1/periods/:periodId/engagement-tasks', engagementCollectionRouter);
app.use('/api/v1/engagement-tasks/:id', engagementItemRouter);
app.use('/api/v1/engagement-summary', engagementSummaryRouter);
app.use('/api/v1/periods/:periodId/cash-flow', cashFlowRouter);
app.use('/api/v1/clients/:clientId/tickmarks', tickmarkLibraryCollectionRouter);
app.use('/api/v1/tickmarks/:id', tickmarkLibraryItemRouter);
app.use('/api/v1/periods/:periodId/tb-tickmarks', tbTickmarkRouter);
app.use('/api/v1/system-tickmarks', systemTickmarkCollectionRouter);
app.use('/api/v1/system-tickmarks/:id', systemTickmarkItemRouter);
app.use('/api/v1/clients/:clientId/lead-sheets', leadSheetCollectionRouter);
app.use('/api/v1/lead-sheets/:id', leadSheetItemRouter);
app.use('/api/v1/periods/:periodId/lead-sheets', leadSheetPeriodRouter);
app.use('/api/v1/storage', storageRouter);
app.use('/api/v1/periods/:periodId/lead-sheet-attachments', leadSheetAttachmentCollectionRouter);
app.use('/api/v1/lead-sheet-attachments/:id', leadSheetAttachmentItemRouter);
app.use('/api/v1/clients/:clientId/saved-reports', savedReportCollectionRouter);
app.use('/api/v1/saved-reports/:id', savedReportItemRouter);
app.use('/api/v1/fs', fsRouter);
app.use('/api/v1/clients/:clientId/fs', fsClientRouter);
app.use('/api/v1/periods/:periodId/fs', fsPeriodRouter);
app.use('/api/v1/periods/:periodId/variance-notes', varianceNotesRouter);
app.use('/api/v1/reports', pdfReportsRouter);
app.use('/api/v1/tax-codes', taxCodesRouter);
app.use('/api/v1/periods/:periodId/compare/:comparePeriodId', comparisonRouter);
app.use('/api/v1/periods/:periodId/exports', exportsRouter);
app.use('/api/v1/tax-lines', taxLineAssignmentRouter);
app.use('/api/v1/import/csv', csvImportRouter);
app.use('/api/v1/import/pdf', pdfImportRouter);
app.use('/api/v1/import/bank-statement-pdf', bankStatementPdfRouter);
app.use('/api/v1/import/scanned-sheet', scannedSheetRouter);
// Under /import/ so nginx's long timeout and the upload/ai-step limiters apply.
app.use('/api/v1/import/qbo', qboImportRouter);
app.use('/api/v1/integrations/qbo', qboIntegrationRouter);
app.use('/api/v1/clients/:clientId/documents', documentsCollectionRouter);
app.use('/api/v1/documents', documentsItemRouter);
app.use('/api/v1/backup', backupRouter);
app.use('/api/v1/restore', restoreRouter);
app.use('/api/v1/audit-log', auditLogRouter);
app.use('/api/v1/support', supportRouter);
app.use('/api/v1/coa-templates', coaTemplatesRouter);
app.use('/api/v1/clients/:clientId/payees', payeesRouter);
app.use('/api/v1/clients/:clientId/units', unitsRouter);
app.use('/api/v1/periods/:periodId/py-comparison', pyComparisonRouter);
if (!isDesktopMode()) app.use('/mcp', mcpRouter); // desktop: MCP over stdio only

// 404 for any /api/* path not matched above.
app.use('/api', (req, res) => {
  res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}` } });
});

// Global error handler — last line of defense for any handler that either
// throws synchronously or escapes an async try/catch. Express 4 will not
// auto-catch async rejections; routes must either use try/catch or next(err).
// This keeps us from hanging the socket and from leaking stack traces.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) {
    // Stream already started; nothing useful to send. Just destroy.
    res.destroy(err);
    return;
  }
  sendServerError(res, err, 'global');
});

// When MIGRATIONS_AUTO=false (appliance mode), refuse to start with pending
// migrations — running with a partial schema causes hard-to-debug failures.
// In default mode (true), the entrypoint or upstream `migrate.ts` already
// applied them, so this check is a no-op.
async function checkPendingMigrations(): Promise<void> {
  if (process.env.MIGRATIONS_AUTO !== 'false') return;
  try {
    const [, pending] = (await db.migrate.list()) as [unknown, unknown[]];
    if (pending.length > 0) {
      console.error(
        `\nFATAL: ${pending.length} pending migration(s) detected with MIGRATIONS_AUTO=false.\n` +
        `Run \`node dist/migrate.js\` before starting the server, or set MIGRATIONS_AUTO=true.\n`
      );
      process.exit(1);
    }
  } catch (err) {
    console.error('FATAL: failed to check migration status:', err);
    process.exit(1);
  }
}

async function start(): Promise<void> {
  await checkPendingMigrations();
  // Admin-set AI mode (settings table) overrides VIBE_AI_MODE env; load it
  // before anything consults aiMode(). A DB read failure only logs — env keeps
  // working — unlike bad env config, which is a fatal misconfiguration above.
  await loadAiModeOverrides();
  // Sign-in policy + public URL (passkey relying party). Failures only log.
  await loadSecuritySettings();
  // Single sign-on: needs the public URL above for its redirect URIs. An
  // unreachable identity provider only logs and retries; the one fatal case
  // is VIBE_AUTH_MODE=oidc_only with no break-glass account, whose message
  // says how to fix it — let it abort the boot.
  await startVibeAuth();
  // BIND_HOST unset = every interface (appliance, behind nginx); desktop sets 127.0.0.1.
  const bindHost = process.env.BIND_HOST;
  const onListening = () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
    // Desktop: the app's own backup scheduler runs backups; QBO is out of scope.
    if (!isDesktopMode()) {
      startBackupScheduler();
      startQboKeepalive();
    }
    // Router mode only; non-blocking with retry — requests made before
    // registration completes fail closed at the router, which is correct.
    registerTbTaskClasses();
  };
  const server = bindHost ? app.listen(Number(PORT), bindHost, onListening) : app.listen(PORT, onListening);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nError: Port ${PORT} is already in use.`);
      console.error(`Another process is listening on this port. Either:`);
      console.error(`  1. Stop the other process using port ${PORT}`);
      console.error(`  2. Set a different port: PORT=3002 npm run dev\n`);
      process.exit(1);
    }
    throw err;
  });
}

start().catch((err) => {
  console.error('FATAL: server failed to start:', err);
  process.exit(1);
});

export { app, db };
