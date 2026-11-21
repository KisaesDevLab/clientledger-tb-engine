# Vibe Trial Balance - Claude Code Project Memory

## License Compliance (PolyForm Small Business 1.0.0)

This project is licensed under the **PolyForm Small Business License 1.0.0**. Enforce these rules in every coding session:

### When adding dependencies
- Check the license before running `npm install`. Allowed: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, BlueOak-1.0.0, Unlicense.
- Review required before adding: LGPL-*, MPL-2.0, GPL-3.0-or-later, CC-BY-4.0.
- Never add: GPL-2.0-only, SSPL-1.0, AGPL-3.0 (copyleft incompatible with our license), Proprietary, Commercial.
- After installing, run `npx license-checker --excludePrivatePackages --summary` in the relevant workspace and confirm no new denied licenses appear.
- Update `scripts/license-policy.json` if a new package needs a `knownIssues` entry.

### Source file headers
- Every new `.ts` or `.tsx` file created under `client/src/` or `server/src/` must begin with:
  ```
  // Copyright 2025-2026 Kisaes LLC
  // Licensed under the PolyForm Small Business License 1.0.0.
  // Use is limited to qualifying small businesses. See LICENSE for terms.
  ```
- Do not add headers to generated files, migration files, or config files.

### Use limitation and notices
- The PolyForm Small Business License permits use only by companies with **fewer than 100 total individuals** (employees + contractors) and **under $1,000,000 USD (2019, inflation-adjusted) total revenue** in the prior tax year. Larger organizations need a Commercial License from Kisaes LLC — see `COMMERCIAL_LICENSE.md`.
- Distribution IS permitted under this license, but anyone who distributes copies must pass along the license terms (or their URL) and the `Required Notice: Copyright 2025-2026 Kisaes LLC` line from the LICENSE file. Do not remove or alter that Required Notice line, and preserve it in any packaging/build artifacts that ship license metadata.
- Official Docker images publish to `ghcr.io/kisaesdevlab/vibe-tb-*` via `.github/workflows/docker-publish.yml`; keep the image license label in that workflow in sync with LICENSE.
- Client-facing access (clients getting their own login to a hosted instance) requires a Commercial License from Kisaes LLC — see `COMMERCIAL_LICENSE.md`.

### Known open issues (see scripts/license-policy.json for detail)
- `buffers@0.1.1` — no license; transitive via exceljs. Do not upgrade exceljs without verifying this resolves.
- Run `./scripts/license-audit.sh` after adding dependencies or before tagging a release.
- Full audit: use `docs/LICENSE-AUDIT-PROMPT.md` with Claude Code before major releases.

## Workflow Rules
- Work autonomously through the full plan before stopping
- After each change, run tests and fix failures before proceeding
- Only stop to ask me if you hit a true ambiguity you can't resolve
- At the end, provide a summary of changes and testing instructions

## Stack
- Frontend: React 18 + TypeScript + Vite + TanStack Table + TanStack Query + Tailwind
- Backend: Node.js 20 + Express + TypeScript + Knex.js + PostgreSQL 16
- AI: Anthropic SDK for bank classification, diagnostics, tax assignment
- Hosting: Raspberry Pi 5 (8GB), Nginx, PM2

## Technical Standards
- TypeScript strict mode everywhere
- All money as BIGINT cents (never float)
- Knex.js for all DB queries and migrations (JS migration files for Windows compat)
- TanStack Query for server state in React, Zustand only for UI state
- Adjusted balances are NEVER stored, always computed via DB view
  (authoritative `v_adjusted_trial_balance` definition: `migrations/20260828000002_tb_view_lead_sheet.js` —
  a migration adding a column must copy THAT SQL, and must LEFT JOIN or it drops unassigned accounts)
- **Dormant accounts are hidden on reports:** an account with no beginning balance (`prior_year_*`),
  no activity (`unadjusted_*`, `trans_adj_*`, `book_adj_*`, `tax_adj_*` all zero) and therefore no
  ending balance is dropped from every report view, PDF and export. Shared predicate:
  `server/src/lib/tbActivity.ts` (`whereHasActivity` knex modifier + `hasReportableActivity`) and
  `client/src/utils/tbActivity.ts` (`hasReportableActivity` / `filterReportableRows`) — keep the two
  in sync. NOT applied to the editable TB grid, Tax Mapping, COA, JEs or PY Tie-Out: you can't type a
  balance into a row that isn't rendered.
- **Report amounts are signed by `category`, never by `normal_balance`:** use `categoryNet()` /
  `netIncomeContribution()` from `lib/accounting.ts` (client and server copies). `normal_balance` is a
  per-account COA flag the user can set independently of category, so signing by it inverts contra
  accounts and any account whose flag disagrees with its category.
- API routes return: { data, error, meta }
- Named exports, PascalCase components, camelCase utilities, snake_case DB columns

## Key Architecture Decisions
- **AI dual-mode (MIG-1, permanent posture):** mode is `direct|router`, resolved with
  precedence DB setting (`ai.mode` row, admin-set via Settings UI / PUT /settings/ai-mode)
  > `VIBE_AI_MODE` env > `direct`. Router URL/token likewise: `ai.router_url`/`ai.router_token`
  (encrypted) rows > `VIBE_AI_ROUTER_URL`/`VIBE_AI_TOKEN` env (see
  `server/src/lib/aiModeSettings.ts` + `routerConnection()` in routerProvider.ts). `router`
  sends ALL AI traffic through the appliance's Vibe AI Router via
  `server/src/lib/routerProvider.ts` (`RouterLLMProvider` behind `getLLMProvider()`); every
  provider/model setting in the DB is then inert and the Settings UI shows a managed-by-router
  banner. Boot refuses env-set `router` without env URL+token; a DB-set mode must never brick
  boot (load failures only log). Mode switches are explicit only: admin-confirmed in the UI,
  router health-checked BEFORE persisting, audit-logged. NEVER add a silent fallback from
  router to direct — it would ship prompts around the router's scrubber and ledger. Every AI call site
  must pass `taskClass` (see `TB_TASK_CLASSES`); the router driver fails closed without it.
  `server/src/lib/vibeAiClient.ts` is VENDORED from the router repo — don't edit in place.
  Tests: `npm run test:router` (server/).
  **Keep any one HTTP request's AI work short.** There is a ~100s proxy timeout in front of the
  router; exceed it and the caller gets a 524 with no error from us. Never size one call at
  rows × tokens over an unbounded row count — batch server-side AND let the client page through.
  Both are done for csv+pdf `suggest-numbers` (`SUGGEST_BATCH_SIZE` / `SUGGEST_CHUNK_SIZE`, with
  `reservedNumbers` passed forward so chunks don't hand out the same number) and for
  `POST /tax-lines/auto-assign` (`AUTO_ASSIGN_CHUNK_SIZE` in TaxMappingPage pages by `accountIds`).
- **One task class per major AI step** (`TB_TASK_CLASSES` in `lib/routerProvider.ts`), so the router
  carries a separate sensitivity policy and model choice for each. Adding a step means adding a
  class AND declaring it in `registerTbTaskClasses()`; the router test asserts the declared set and
  the constants are identical, so neither can drift. Steps reached from two entry points share one
  class: account numbering and import chat are each driven from both the CSV and PDF dialogs, but
  send the same shape of data, so splitting them would be two knobs for one decision.
  A class the router has not seen before **starts local_only** until the operator widens it.
  The old catch-alls were retired in v0.1.13 — carry their policy across per step:
  | was | now |
  | --- | --- |
  | `tb_classification` | `tb_csv_analyze`, `tb_account_numbering`, `tb_import_chat`, `tb_bank_classify`, `tb_scanned_sheet_classify`, `tb_tax_code_assign` |
  | `tb_doc_extract` | `tb_pdf_extract`, `tb_pdf_verify`, `tb_scanned_sheet_extract`, `tb_import_chat` |
- **Cache freshness (query cache):** global `staleTime` is **30 s** with `refetchOnWindowFocus`
  (`main.tsx`) — it was 5 min, and this is a multi-user app whose data also moves from outside the
  browser (MCP agent, QBO import, another user), so pages showed old figures with nothing on screen to
  say so. Every page that loads server data carries `<RefreshButton />` inside its title heading
  (`components/RefreshButton.tsx`): one click runs `qc.invalidateQueries()` with NO filter, which
  refetches every query mounted on the current page and only marks the rest stale — no page lists
  its own keys. Mutations still invalidate: a JE goes through `invalidateAfterJournalEntry`, and a
  TB grid cell edit / balances import / row sync through `invalidateAfterBalanceChange` (both in
  `lib/queryInvalidation.ts`, one shared `BALANCE_DEPENDENTS` list) — a typed balance used to refresh
  only `['trial-balance']`, leaving Dashboard, GL, Cash Flow, Comparison and Lead Sheets stale.
  A new page title gets the button; a new screen that reads balances gets its key added to that list.
- **Security headers on the SPA come from nginx, on the API from helmet.** Express never serves the
  SPA, so `helmet()` in `app.ts` covers only `/api/`, `/auth/`, `/mcp/`; the static files get theirs
  from `add_header` lines in `deploy/nginx.conf` AND `deploy/nginx-docker.conf`, written **twice in
  each file**: at server level and again inside `location = /index.html`. A location with its own
  `add_header` inherits none from the server, and every SPA route lands in that location through
  `try_files` — so headers only at server level would miss the root document.
  `nginxSecurityHeaders.test.ts` pins the four copies to each other. Load-bearing values: COOP is
  `same-origin-allow-popups` (the SSO test popup crosses to the IdP and posts back — plain
  `same-origin` breaks it); Permissions-Policy keeps `publickey-credentials-get/create=(self)` for
  passkeys; HSTS is `$vibe_hsts`, a `map` on `X-Forwarded-Proto` that is empty (header omitted) over
  plain HTTP. **Never add an HTTP→HTTPS redirect to these configs**: TLS ends upstream (Cloudflare /
  Caddy talk plain HTTP to port 80, so it would loop) and the appliance's emergency port must keep
  answering over HTTP. CSP ships as `Content-Security-Policy-Report-Only`; it needs `worker-src blob:`
  (pdf.js worker) and `style-src 'unsafe-inline'` (Custom Report print popup). `client/public/robots.txt`
  is `Disallow: /` and `index.html` carries `noindex` — this is a private app, so no sitemap or llms.txt.
  Example text shown in the UI must not be credential-shaped (a `postgresql://user:pass@…` sample in
  the MCP snippet was reported by a scanner as a leaked database password).
- **Sign-in: password + optional second factor (TOTP or passkey).** `POST /auth/login` returns a
  `stage`: `ok` (full JWT, unchanged payload), `mfa` (5-min token with `stage:'mfa'`, good only for
  `/auth/mfa/*`) or `enrol` (15-min token with `stage:'enrol'`, good only for the enrolment endpoints
  while the admin policy `security.require_two_factor` is on). `gateForRequest` in
  `middleware/auth.ts` (pure, tested) enforces the allowlists; **only login mints a `stage` claim, so
  the MCP agent's JWT and every existing token are never gated** — never add a 2FA check keyed on the
  user row. Order is MFA → password rotation → enrolment. Passkeys (`@simplewebauthn/server`,
  `lib/passkeyCeremony.ts`) sign in fully and usernameless; a passkey-only user typing a password is
  still challenged (`lib/loginStage.ts`). TOTP seeds are ENCRYPTED with `lib/encryption.ts`
  (`user_totp.secret_enc`), never hashed. The relying party comes from `lib/publicUrl.ts`
  (`app.public_url` setting > `APP_BASE_URL` > first plain `ALLOWED_ORIGIN` > localhost; https or
  `http://localhost` only) and the same resolver now feeds `buildAppUrl` for reset/invite/QBO links.
  "Remember this browser" is an httpOnly cookie `vtb_trusted` (`Path=/` because of the multi-app base
  path) whose SHA-256 is a `trusted_browsers` row. No recovery codes: admin `POST
  /users/:id/reset-two-factor` or the operator CLI `npm run reset-2fa -- <username>` (`src/reset-2fa.ts`,
  same `lib/twoFactorReset.ts`). Enrolments are per installation and not in backups. Client: the `mfa`
  token lives only in LoginPage state, never in `useAuthStore`; `rotate`/`enrol` obligations are flags on
  the stored user and `ProtectedRoute` bounces on them; `apiFetch` turns a 403
  `TWO_FACTOR_ENROLMENT_REQUIRED` / `PASSWORD_CHANGE_REQUIRED` into that flag. Tests: `npm run test:twofactor`.
- **Single sign-on (Vibe Auth, `@kisaesdevlab/vibe-auth` from GitHub Packages).** Operator notes and
  the deviations list: `docs/sso.md`. The package owns the OIDC flow (`/auth/*` on the API, outside
  `/api/v1`, mounted in `app.ts` after the public probes and before every authenticated router); the
  product side is `lib/vibeAuth.ts` + `lib/vibeAuthUsers.ts` (+ `vibeAuthAdapter.ts` for the CLI).
  Sessions stay stateless JWTs: an SSO login mints the same 8 h token with a `sid` claim, hands it to
  the SPA on `/login#sso_token=`, and parks the identity in `auth_sessions_oidc`; `authMiddleware`
  asks `auth.isRevoked` on EVERY request ahead of its 30 s cache (back-channel logout). SSO tokens
  carry no `stage` claim, so the local 2FA policy and the password-rotation gate do not apply to them
  (`gateForRequest` `sso` flag). **Every local sign-in path must call `localLoginRefusal()`** —
  password login does as middleware, passkey `login/verify` after the ceremony — or `oidc_only` has a
  hole. The dependency is `^1.0.x` from `npm.pkg.github.com`, which refuses anonymous reads: source
  builds need a `read:packages` token (`~/.npmrc` for dev/Pi, a BuildKit secret in the Dockerfiles,
  `GITHUB_TOKEN` in Actions after the package grants this repo access); `.npmrc` files only map the
  scope. The first-party scope is excluded from the license audit's denied check. `.appliance/manifest.json`
  is a byte-for-byte vendored copy of `Vibe-Appliance/console/manifests/vibe-tb.json` (edit there, copy
  here); its `/auth/*` matcher is load-bearing and `breakglassCommand` runs with the image `WORKDIR`
  `/app`, hence the `server/node_modules/...` path plus `ENV VIBE_AUTH_ADAPTER` in `Dockerfile.server`.
  Tests: `npm test` (server, includes `vibeAuthWiring.test.ts`) and `npm run test:sso-e2e` (real server +
  scratch Postgres + fake IdP, `test/sso-e2e.mjs`; mode changes are restarts because a stored mode
  overrides env). Never add a silent fallback from `oidc_only` to local.
  **Account rules live in `lib/accountGuards.ts` (pure, `accountGuards.test.ts`):** the break-glass
  account (username = `VIBE_BREAKGLASS_USERNAME`, case-insensitive) cannot be deactivated, demoted or
  renamed in ANY mode (`409 BREAKGLASS_PROTECTED`) and is never given `must_change_password`; self-service
  password reset is refused — with the unknown-account answer — for it and for SSO-only accounts
  (`app_users.sso_only_since` set + an `auth_identities` row); role sync (`setRole`) never demotes the last
  active admin, break-glass not counted. **Every path that writes a real `password_hash` must clear
  `sso_only_since`.** The group → role map is the explicit `VIBE_TB_ROLE_MAP`, not the package default.
- Trial Balance Grid = editing balances ONLY, no category subtotals
- Tax Mapping View (Plan Phase 5) = SEPARATE page: assign tax codes, read-only balances, category subtotals, net income, balance check
- tax_line VARCHAR on chart_of_accounts: legacy field kept for compat. New system uses tax_code_id FK → tax_codes table. Dual-write: when tax_code_id assigned, also write tax_code string to tax_line.
- activity_type on clients: business / rental / farm / farm_rental (added Plan Phase 4)
- PDF strategy: server-side pdfmake (Plan Phase 6). All browser window.print() replaced with download/preview PDF endpoints.
- **Download filenames are `<period>_<client>_<report>.<ext>`** and nothing else — e.g.
  `FY2024_Acme Holdings LLC_trial-balance.pdf`. The internal period id used to trail the report name
  (`trial-balance-12.pdf`); it is gone from every PDF, every server Excel export (which now carry the
  engagement prefix too, via `fileDisposition`) and every browser-built SheetJS workbook. Server:
  `engagementFilename` in `lib/reportFilename.ts` (tested); client: an identical copy in
  `utils/reportFilename.ts` (tested) plus `hooks/useEngagementFilename.ts` for a page that does not
  already hold the client and period. The client's `downloadPdf` / `downloadExport` both prefer the
  server's Content-Disposition name; the name a page passes is only a fallback. The flux analysis PDF
  names the compare PERIOD (`flux-analysis-vs-FY2023.pdf`), not its id.
- Tax codes: two tables — tax_codes (canonical) + tax_code_software_maps (per-software UltraTax/CCH/Lacerte/GoSystem/Generic)

## Phase Numbering
Canonical phases from NEXT_PHASE.md (master plan). App-only features built before plan adoption are tracked separately.

## Current Phase
All planned phases complete. App is feature-complete.

## Completed — Plan Phases
- Plan Phase 1: Foundation — Auth, Clients, Chart of Accounts, Periods
- Plan Phase 2: Trial Balance Grid — inline editing, keyboard nav, v_adjusted_trial_balance view, CSV import
- Plan Phase 3: Journal Entries — Book & Tax AJEs, balance validation, filter by type
- Plan Phase 4: Tax Code Management — tax_codes + tax_code_software_maps tables, 500+ seeded codes (1065/1120/1120S/1040/common), full CRUD API, TaxCodesPage (admin) with software mappings, CSV import/export; activity_type on clients
  - System tax codes are **numeric only** and live in migrations (crosswalk set from `20260321000007` on). The legacy alpha seed files (`seeds/004–006`) were deleted and migration `20260817000002` purges any alpha system codes they left behind (they duplicated every line). `88888` = reporting only / no mapping (was `REPORTING_ONLY`). The same cleanup is available on demand via `server/src/lib/legacyTaxCodes.ts` (Settings → Tax Code Cleanup; `GET/POST /tax-codes/legacy-alpha/{status,purge}`, admin) — keep it in sync with the migration. Never re-add alpha system codes.
- Plan Phase 5: Tax Mapping View — TaxMappingPage (separate page): account table with tax code dropdowns, progress bar, category subtotals, net income row, balance sheet check, optimistic updates with flash; dual-write COA PATCH (tax_code_id → also sets tax_line for compat)
- Plan Phase 6: PDF Report Generation — pdfmake server-side PDFs for all 8 report types, PdfTemplateService (Roboto fonts, branded header/footer, formatCents), 8 PDF endpoints; client PDF buttons replace window.print() on all report pages
- Plan Phase 7: Financial Statements — Tax-Basis P&L (income/expense grouped by tax code AND category — a code holding both, e.g. 88888, splits into "code — Revenue"/"code — Expenses" so subtotals don't add revenue and expenses together; sort_order, per-code subtotals, net income), Tax Return Order (all accounts in tax return order with category filter); PDF + frontend for both; IS/BS/CashFlow already complete from prior phases
- Plan Phase 8: Multi-Period Comparison — comparison API (GET /periods/:id/compare/:compareId) with book-adjusted variance rows; per-account variance notes (PUT with compare_period_id); Flux Analysis PDF; MultiPeriodPage with category grouping, $ and % variance, significance threshold highlighting, inline note editing; added to Reports group in sidebar
- Plan Phase 9: Exports — UltraTax/CCH/Lacerte/GoSystem/Generic CSV+Excel exports, Working TB Excel export, Bookkeeper Letter PDF, ExportDialog with pre-export validation (unmapped accounts, out-of-balance check), ExportsPage under Reports sidebar group
- Plan Phase 11: AI Tax Line Auto-Assignment — POST /tax-lines/auto-assign (waterfall: existing→prior-period→cross-client→**firm-history**→AI→unmappable), bulk-confirm with dual-write, GET patterns endpoint, AssignmentPreviewModal with confidence color coding and override dropdowns, "Auto-assign Tax Codes" button wired to TaxMappingPage.
  **Firm history** (`lib/taxCodeHistory.ts`, pure, tested) sits between the exact cross-client match and the AI call: one grouped query per request (`loadFirmHistory`, same `entity_type`, loaded lazily) buckets every confirmed name→code by `normalizeAccountName` (leading account number, punctuation, plurals and filler like `expense/other/misc/account` dropped), and `rankHistoryMatches` votes by Dice ≥ 0.8 × row count; confidence is `similarity × n/(n+1)` over **distinct clients**, so one client's habit never exceeds 0.5. Codes outside the client's catalog are gated out by `allowedTaxCodeIds`. Source value `firm_history` is a real `tax_line_source` (badged teal on the modal and the mapping page).
  **AI step** (`lib/taxCodeShortlist.ts`, pure, tested): a client's catalog is ~100–135 seeded codes and goes into every batch whole; only a catalog past `CATALOG_CAP` (180) is trimmed by `selectCatalogForBatch` (each account's shortlist ∪ the head of the list — the old `slice(0, 200)` is gone). Each account carries `likely: [≤5 tax_codes]` from `shortlistCodes` — token overlap between the name and the line label (crosswalk abbreviations folded: `depr`, `mortg`, `pay`, `ins`, `exps`…) weighted by `codeStatement` (`Sch L` = BS, `Sch M-*`/`R/E Wrk` = M, else P&L) against the account's category — hints the prompt says to ignore when the name misleads. The reply is **sanitized**: a `suggested_tax_code` not in the batch's catalog is `unmappable` with the proposed code named in the reasoning, never source `ai` with a null id (which the confirm could not write). All of this is prompt content only — the call is still `aiComplete` with `TB_TASK_CLASSES.TAX_CODE_ASSIGN`, so router mode, policy and model choice are untouched.
  **The AI reply is treated as unreliable transport, not a contract.** Batches are `BATCH_SIZE = 15` with
  `maxTokens = n × 200 + 2048`, because a reasoning model (gpt-oss on the router) spends the same
  `max_tokens` on its thinking BEFORE the JSON — a 30-account batch at `n × 120` came back `finish=length`
  mid-array and the whole batch read "AI could not determine" while the router logged every call `ok`.
  A reply that fails strict parsing goes through `salvageJsonArray` (keeps every complete element of an
  unclosed array); replies are joined on a per-call `ref` (`r1`, `r2`, …) — NOT account_number, because the router's scrubber
  redacts COA account numbers to `[ACCOUNT]` before the model sees them (audit log: `scrubber_redacted
  {"account":25}` per batch), so 25 of 30 keys came back identical; account_number is only a fallback key; whatever is still missing is retried ONCE in batches of `RETRY_BATCH_SIZE`;
  and rows that never get a reply say so (reason names truncation / non-JSON and points at the AI usage
  log, where the call is marked `parse_error` with `finish=` and the first 500 chars) instead of the
  generic "could not determine".
  **Nothing in the pipeline waits in line.** AI batches (and the retry batches) run
  `AI_BATCH_CONCURRENCY = 3` at a time through `mapWithConcurrency` (`lib/concurrency.ts`, tested) —
  they are independent because each joins its own refs. The prior-period and cross-client tiers are
  **one query per request each** (`loadPriorPeriodMappings` / `loadCrossClientMappings`), not two
  queries per account: a 200-account COA used to make 400 sequential round trips before the AI even
  started. The page sends `AUTO_ASSIGN_CONCURRENCY = 3` chunks at once (`utils/concurrency.ts`, a copy
  of the server helper), slots results by chunk index so the preview keeps account order, and a
  failed chunk stops new ones from starting while in-flight ones finish and still count. The
  progress modal counts chunks as they *return*, not as they are sent.
- Plan Phase 13: Smart CSV Import — document_imports migration, POST /import/csv/analyze (AI column mapping + account matching), POST /import/csv/confirm (upsert TB rows), CsvImportDialog with drag-and-drop, confidence-coded preview table, "Import from CSV" button on TrialBalancePage
- Plan Phase 14: PDF Import with AI Extraction — pdf-parse installed, POST /import/pdf/analyze (text extraction → Claude AI extraction), POST /import/pdf/confirm, PdfImportDialog with consent dialog, "Import from PDF" button on TrialBalancePage
- Plan Phase 15: PDF Verification Engine — POST /import/pdf/verify (AI line-by-line comparison), GET verify/:importId (cached), GET imports?periodId, VerificationPanel component on TrialBalancePage showing match/discrepancy detail
- Plan Phase 16: Document Storage — client_documents CRUD API, file storage in server/uploads/, DocumentsPage with drag-and-drop upload, download, delete, link-to-account/JE modal
- Plan Phase 17: Backup & Restore — backup_history + restore_history migration, .tbak ZIP archives (full/settings/client/period), ID-remapping restore engine (as_new/replace/settings modes), nightly node-cron scheduler, BackupPage with history table and restore upload UI
- Plan Phase 18: Polish & Integration — audit_log viewer page (admin only, paginated, filterable), deploy scripts (setup-pi.sh, deploy.sh, nginx.conf, ecosystem.config.js)
- Plan Phase 23: AI Support Chat — support_conversations + support_messages tables, SSE streaming chat endpoint, knowledge base (16 .md files in server/knowledge/), ChatBubble floating widget, SupportPage with conversation history and bookmarks
- Plan Phase 24: COA Template Management — coa_templates + coa_template_accounts + coa_template_tax_codes tables, full CRUD API (from-client, apply merge/replace, CSV import/export), CoaTemplatesPage with System/Custom tabs and apply modal.
  **The 32 system templates are Vibe MyBooks' `BUSINESS_TEMPLATES`** (`myBooks/packages/shared/src/constants/coa-templates.ts`),
  minus MyBooks' Payments Clearing (10150) and Opening Balances (30000), which are bookkeeping mechanics.
  Loaded in `20260321000005`, re-synced to MyBooks `2fb8362` by `20260925000001` (adds General Business,
  the industry accounts and Sales Tax Payable 20900). When MyBooks' templates change again, sync with a
  new **upsert** migration like that one: headers are locked but system-template accounts are editable,
  so only delete numbers this app shipped, and keep `tax_line`/`unit`/`workpaper_ref`. `subcategory` is
  the parent account's name (MyBooks' source spreadsheet hierarchy; the TS has none), so carry it
  across by number+name, not by number alone — farm reuses numbers with other meanings — and take a
  round-hundred neighbour as parent only when it is an existing heading (farm numbers siblings).
  **Farm carries TB-only accounts (listed in that migration's header); a re-sync from MyBooks must
  keep them.** So every Schedule F line has one: 42610 CCC Loans Forfeited (5b), 42510 Crop Insurance
  Deferred from Prior Year (6d), 62530 Preproductive Period Expenses (32), 20810 CCC Loans Payable
  (loans not elected as income). Purchased breeding/dairy/draft stock is depreciable, not a 56xxx
  resale cost: 10810–10890 by class under 10800 Breeding Livestock, with 10895 its own accumulated
  depreciation; lead sheet rule D takes `livestock|breeding|herd|horses` assets so cost and contra
  share schedule D (livestock *inventory* is caught first by C). Horses and goats have the
  sales/cost pair every other class has (46610/46620, 56610/56620).
- Plan Phase 25: Manual Transaction Entry Register — bank_transactions.entry_source column (migration Batch 26), GET /clients/:id/payees + /search + /:payee/categories endpoints, POST /bank-transactions/manual (batch with rule upsert + JE sync), TransactionEntryPage with spreadsheet-style register, smart payee combo dropdown, smart category select (previously-used section), stat cards (debits/credits/net), unsaved row tint, duplicate/delete row actions, "Transaction Entry" added to Bookkeeping sidebar group
- Scanned-sheet import (Transaction Entry) — `POST /import/scanned-sheet/analyze` (`server/src/routes/scannedSheetImport.ts`): renders each PDF page (poppler), one `aiComplete` per page with `TB_TASK_CLASSES.DOC_EXTRACT` (vision), returns rows with per-row confidence + `uncertain` fields plus 100-dpi JPEG page previews; falls back to OCR text / PDF text layer / 422 `SCANNED_PDF` like the bank-statement route. `POST /import/scanned-sheet/categorize` = second pass with `TB_TASK_CLASSES.CLASSIFICATION` (same COA + rules prompt shape as bank ai-classify; returns per-row account suggestions, nothing written). Client: `ScannedSheetImportDialog` (side-by-side page image + editable rows; free-text payee = the transcription verbatim (known payees only suggested, never substituted); `utils/matchPayee.ts` for payee→category, AI fills the rest and never overwrites hand-set categories), `insertImportedRows` in `TransactionEntryPage` drops accepted rows in as unsaved rows — nothing is written until the register's Save.
  **Journal-report pages:** the extractor prompt has a `JOURNAL REPORTS` rule and a page-level `layout`
  (`'sheet' | 'journal'`); on a journal page each ENTRY becomes one row carrying `accountRef` /
  `sourceAccountRef` *as printed*, signed from the bank account's point of view. Resolution against the
  COA happens in the dialog (`utils/matchAccountRef.ts`: number, then exact name, then a containment
  match only when unique — a wrong account is worse than an empty one); a resolved category is
  `categorySource: 'journal'`, which the AI categorize pass never touches (not even "re-suggest all"),
  and a resolved bank line overrides the dialog's single source account for that row. The route pushes
  a per-page warning so a journal page is never silently different from a sheet page.
  **Tabular sheets:** the prompt's TABLES rule makes a printed Total Paid / Paid To / Description /
  Category page read as a normal sheet — the Paid To cell IS the description (an empty Description
  column once made every row blank and thus unpostable), and the sheet's own category column comes
  back verbatim as `categoryHint`, resolved via `matchAccountRef` (`categorySource: 'sheet'`, weaker
  than payee/journal — force re-suggest may replace it) or fed to the categorize pass as context.
- **Register drafts survive navigation** (`store/registerDraftStore.ts`, persisted as `register-drafts`,
  keyed `clientId:periodId`). `TransactionEntryPage` mirrors every unsaved non-blank row into it on
  change — but only after the seed effect has run, or the empty initial list would wipe the draft it
  is about to restore — and the seed effect appends the stored rows after the saved ones with a toast.
  Still nothing is written until Save; a `beforeunload` guard covers tab close. The register's saved-row
  query pages through the API (`pageSize: 500`, up to 40 pages) because the API is newest-first and the
  default single page of 100 silently dropped the OLDEST rows of a busy period.
- MCP Integration — @modelcontextprotocol/sdk; HTTP/SSE transport at /mcp/sse + /mcp/messages (mcpAuthMiddleware, Bearer MCP token); stdio transport at server/src/mcp-stdio.ts for Claude Desktop; mcp_agent system user (migration 20260320000001); 8 Resources, 18 Tools (list/get/update across clients/periods/TB/JE/COA/tax/diagnostics/engagement/comparison/reports), 5 Prompts; rate limiting 100 req/min; audit_log for all tool calls; Settings page MCP card (admin) with token generate/rotate/revoke + stdio/HTTP snippet tabs; "MCP Integration" link in sidebar

## Completed — App-Only Features (built before plan adoption, kept and maintained)
- Bank Transactions + AI Classification (OFX/CSV import, AI classify, rules, batch ops, source accounts, import dedup via SHA-256 hash, reclassify audit trail, pagination, sort_order priority)
- Financial Statements (IS, BS, Statement of Equity — CY+PY comparative columns, Change column, header skeleton).
  **The three PDFs are the screen on paper**: `generateIncomeStatementPdf` / `generateBalanceSheetPdf` /
  `generateEquityStatementPdf` share one comparative layout (`fsLayout`/`fsRow` in `pdf/reportGenerators.ts`)
  and take `FsPdfOptions { basis, priorYear }` — the page passes its View basis as `?basis=`, and
  `priorYear` left unset is **automatic** (columns on when any row has a PY balance, off for a first-year
  client so it doesn't print two dead columns). `fsChangePct` must stay identical to `fmtPct` on
  `FinancialStatementsPage.tsx`. The binder id is `pdf-equity`. Before this the IS route took
  `?priorYear=` that nothing sent, the BS had no PY code at all and the equity tab had no PDF.
  **pdfmake ignores `fillColor` on a bare text node** — use `svc.warningBanner()` (a one-cell table) for
  red top-of-report strips; the BS and cash-flow warnings were white-on-white for that reason.
- Cash Flow Statement (indirect method, account mapping config)
- TB Report, General Ledger, Tax Code Report, Workpaper Index, AJE Listing (browser-print — migrating to pdfmake in Plan Phase 6)
- Period Controls + Audit Trail + Dashboard (locking with TB balance check, admin-only unlock, roll-forward copies tickmarks)
- User Management (admin CRUD)
- COA import from CSV with column mapping, copy-from-client
- **Every file-import preview has a per-row include checkbox** so rows can be left out before
  committing: CsvImportDialog / PdfImportDialog (ticking off sets the row's `action` to `'skip'`,
  the same flag the AI puts on headers/subtotals and the server already drops on confirm; the
  pre-skip action is remembered so re-ticking restores it), ChartOfAccountsPage ImportModal
  (`excluded` index set; rows with parse errors are never tickable), plus the checkboxes that
  already existed on BankStatementPdfImportDialog, ScannedSheetImportDialog and the PY tie-out
  dialogs. Preview tables must render every row — you can't untick what isn't drawn.
- TB Import (current + prior year), PY comparison columns
- **PY Tie-Out AJE direction:** the rolled PY (this app's final prior year, AJEs included) is the
  truth and the upload is the bookkeeper's opening balance, so the entry's sign is **rolled − uploaded**
  — the OPPOSITE of the Variance column (uploaded − rolled). `AjePanel` preview and
  `POST .../py-comparison/create-aje` both do this and must stay mirrored. It shipped reversed once.
  **An account absent from the upload is uploaded ZERO, not "no data".** That is how the comparison
  GET computes its variance (`pyMap.get(id) ?? {dr:0,cr:0}`), and it is the commonest reason to need a
  true-up — the bookkeeper's file just omits the account. `create-aje` iterated the
  `py_comparison_data` rows instead, so selecting only such an account 404'd with "No PY comparison
  data found for selected accounts" while the panel showed a correct preview. It now iterates the
  (deduped) `accountIds` and loads the whole period's upload as a map; the 404 survives only for a
  period with **no** upload at all.
- **PY true-ups are tagged** (`journal_entries.source_tag = 'py_tieout'`, migration `20260903000003`).
  The entry must be posted in the CURRENT year — the prior one is closed — so the tag is the only way
  to answer "would my adjustments make the prior year tie?". The comparison GET sums the tagged
  entries' lines per account through `lib/pyTieOut.ts` (pure, tested) and returns `trueUpDebit/Credit`,
  `adjustedPy*` (= uploaded + true-up) and `remainingVarianceCents` (= adjusted − rolled) per account,
  plus a `summary.trueUp` block. **Balancing and tying are different questions and both are reported**:
  `adjustedNetCents === 0` means the adjusted prior year balances, `accountsStillOff === 0` means it
  ties to the rolled prior year account by account. A true-up whose offset went to Retained Earnings
  balances by construction while leaving RE off the rolled figure — that is real and must stay
  visible, not averaged away (`remainingAbsCents` sums magnitudes so opposite misses never cancel).
  An account only a true-up touched gets a comparison row so the plug is never hidden. The screen
  shows a True-up and a Remaining column (only once entries exist) plus a status strip; the JE list
  badges the entry "PY true-up".
- **TB grid has FOUR fixed leading columns** (Acct #, Name, Cat., LS) — `FIXED_COLS` in
  `TrialBalancePage.tsx` drives every leading `colSpan` (group header row + subtotal/total rows, both
  view modes). Adding a leading column means bumping that constant, not hunting literals. The
  Single / PY / Tax toggles are `tbView` in the persisted `ui-prefs` store, not component state.
- **Import preview shows the type the confirm writes.** Every match row leaves `/import/{csv,pdf}/analyze`
  (and the chat's `revisedAnalysis`) with `newCategory`/`newNormalBalance` filled by
  `fillNewAccountType()` in `server/src/lib/accountTypeInference.ts`; the confirm falls back to the
  SAME `inferAccountType()`. Before this, the preview displayed a `'expenses'` placeholder while the
  confirm inferred from the account number, so a row read Expense on screen and landed as an Asset.
  Inference is by **leading digit** (1/2/3/4 → assets/liabilities/equity/revenue, 5–9 expenses),
  never a numeric range — `10100` is not `< 2000`. Name keywords only when there is no digit.
- **Balances-export recognition on the TB CSV import** (`server/src/lib/balancesExport.ts`, pure;
  wired in `routes/csvImport.ts` as `detectKnownLayout()`). A file whose header carries all of
  `account_number, account_name, adjusted_balance, p_n_l` (any order, case-insensitive) is mapped
  **deterministically and the AI column pass is skipped** — `detectedFormat: 'balances_export'`,
  `adjusted_balance` as `single_signed` (positive = debit), and three carried fields per row: `pnl`,
  `qboAccountId`, `qboAccountName` (from `quickbooks_account_description`). The chat route re-merges
  those from the incoming matches by `csvRow`, or a correction would drop them. Zero-balance rows are
  still imported (they carry links; dormant filtering hides them on reports).
  `inferAccountType(number, name, hint)` takes a `StatementHint` (`'pnl' | 'bs'`) as a **constraint**:
  the leading digit stands when it is on that statement, else a name keyword on that statement, else
  the statement's default (assets / expenses). `3999 P & L Summary,N` therefore stays equity and
  `1500 Interest Income,Y` becomes revenue. No hint = unchanged behaviour.
  The confirm stamps `chart_of_accounts.qbo_account_id` + the new `qbo_account_name` column
  (migration `20260902000001`). Rules, each surfaced as a `qboWarnings[]` sentence in the dialog: an
  id on **two or more rows** of the file is linked to none of them (the export really does this —
  `2710` and `1600` both carry `72`); an id **already held by a different account** is left alone —
  a CSV never re-points a connector link, only the QBO import's `stampQboId` may move one; the name
  is always refreshed. Analyze also matches by stored QBO id (`matchType 'qbo_id'`, between exact
  number and alias) so a renumbered account still lands on its row.
  The QBO connector's matcher gained a **`qbo_name` tier** (`normalizeQboDisplayName`: strip a
  leading all-digit token from every `:` segment, then case/whitespace fold) between `acct_num` and
  the COA-name pass — the export prints `60400 Bank Service Charges:60450 Overdraft Fees` where the
  API says `Bank Service Charges:Overdraft Fees`. Same guards as the name pass (unique, unclaimed,
  not bound elsewhere, no category contradiction), badged **by QB name** (yellow), `writeQboId`.
  The QBO import writes `qbo_account_name` too, so a later name match sees QBO's current wording.
- **COA bulk edit** — `POST /clients/:id/chart-of-accounts/bulk-update` (`bulkUpdateColumns()` in
  `routes/chartOfAccounts.ts`, tested). Checkbox column + shift-click range on ChartOfAccountsPage,
  `BulkEditModal` with an opt-in tick per field (category, normal balance, subcategory, unit, tax
  code, lead sheet); unticked fields are never sent, an empty ticked text field clears. Selection
  persists across filter changes and the bar reports how many selected rows are hidden. One audit
  row per account. Number/name are deliberately not bulk-editable.
- AI Diagnostics page (Claude Haiku) with Spinner loading state
- Bank Reconciliation (full workspace, admin reopen)
- Tax Workpapers: M-1 Worksheet (with input validation), Tax Basis Schedule (SheetJS Excel)
- Engagement Management: Period Checklist, All Open Items with drill-down "View Checklist →"
- Custom Report Builder (saved_reports table)
- **Statement Writer** (report-ready financial statements; `/statement-writer`, `/fs-library`; ported from
  Vibe MyBooks' `FINANCIAL_STATEMENTS_V1`, commit `31d51af` + `724d488`/`fa4c0d4`). An outline editor over
  balance sheet / income statement / equity / indirect cash flow + supplementary schedules, built on
  **lead sheets**; style presets with 8 bundled fonts; firm library (letterhead, accountant's report
  letters, style presets, layout templates); cover + TOC; finalize into immutable versions; PDF / DOCX / XLSX.
  Separate from `FinancialStatementsPage` (fixed layout, pdfmake) and `CustomReportPage` — both untouched.
  **The engine exists twice and must stay byte-identical.** Canonical: `server/src/lib/fs/engine/**`
  (schemas, compute, HTML renderer; imports only `zod` and itself). Generated copy:
  `client/src/lib/fsEngine/**`, written by `node scripts/sync-fs-engine.mjs` (`npm run sync:fs-engine`) —
  never edit it by hand. `fsEngineSync.test.ts` compares file lists and SHA-256 (line endings normalised:
  `core.autocrlf` is on). The browser computes the live preview with it, the server computes everything
  stored or exported. Not a top-level `shared/`: server `tsconfig` has no `rootDir`, so an outside import
  moves the output to `dist/server/src/…` and breaks PM2, `Dockerfile.server` and `VIBE_AUTH_ADAPTER`.
  **Differences from MyBooks, all deliberate:** a statement set belongs to ONE period — column modes are
  `single` and `cy_py` only (no month/quarter/YTD/side-by-side; `periods.ts` is the trimmed two-mode
  planner); money is signed integer **cents** (`SCALE = 100`, MyBooks used 1/10,000 units from decimals);
  ids are the DB integer ids carried as **decimal strings** (`fsIdSchema`; they are object keys in the
  balances maps and layout JSON) with `FS_VIRTUAL_RE_ID = '-1'`; no `systemTag`, tags, book basis, portal
  publish, feature flag or tenant/firm owner pair. `gaap` and `cash` both read `book_adjusted_*` (cash
  changes wording only); `tax` reads `tax_adjusted_*`.
  **The source loader is the whole seam** (`lib/fs/fsSource.ts`: pure `buildFsSource`, tested, + `loadFsSource`).
  Up to three snapshots keyed by date: `periodEnd` (basis columns), `priorEnd` = the day before the period
  starts (this period's `prior_year_*`, pre-closing — the engine's fold closes it), and the day before
  `priorStart` (the PRIOR PERIOD's `prior_year_*`, only when that period is in the app —
  `priorYearRange()`). **Present-but-empty and absent are different**: the prior snapshot is always
  present, so a first-year client opens at a known zero; an absent opening makes `equity.ts` /
  `cash-flow.ts` SKIP that range (`ctx.hasSnapshot`) and compute raise `TB_FS_PY_OPENING_UNAVAILABLE` —
  MyBooks read a missing opening as zero, which reported all of equity as "other changes". So in
  `cy_py` the BS and IS show two years while equity and cash flows may show one, and their titles and
  date lines follow what they actually show. Rows are `is_active` with NO SQL dormancy filter (as
  `loadStampRows`): dormancy needs the prior period too, so `buildFsSource` drops dormant accounts
  itself. Signing is by **category** (`ACCOUNT_TYPE` map), never `normal_balance`. Cash-flow class
  precedence: Statement Writer account override > `chart_of_accounts.cash_flow_category` (the existing
  Cash Flow page's field; `non_cash` → `noncash_adjustment`) > lead-sheet override > the engine's
  default by lead sheet code, **guarded by category** (`CODE_ACCOUNT_TYPE` — letters are user data) >
  account-name heuristics. Equity roles: `fs_equity_roles` over `defaultEquityRole(name)`; the fold (where
  net income closes) is the `is_fold` row, else the lowest-numbered `retained` account, else the virtual one.
  **Tables** (`20260930000001`): firm `fs_firm_profile` (singleton via a unique index on `((true))`),
  `fs_letters`, `fs_style_presets`, `fs_layout_templates`; client `fs_client_layouts`,
  `fs_cash_flow_overrides`, `fs_equity_roles`; period `fs_reports` (period FK **CASCADE**),
  `fs_report_versions`, `fs_report_version_files` (`pdf bytea`). `fs_reports.client_layout_id` has NO delete
  action on purpose — RESTRICT is checked immediately and would abort the client-delete cascade that removes
  both rows in one statement. The library is seeded **lazily** (`ensureFsLibrarySeeded`, idempotent by
  `builtin_key`): the seed data is TypeScript and migrations are JS-only. Letters are deactivated, never deleted.
  **Issuance.** Finalize renders the PDF BEFORE its transaction, then re-checks status under `FOR UPDATE`.
  A version freezes model, layout, style, settings, letter and letterhead. Staleness is two questions:
  `source_stamp` (SHA-256 over everything the engine reads, `fsSourceStamp`) says something moved;
  `impact` recomputes with the FROZEN layout and compares `numbers_hash` to say whether the issued
  numbers moved. A locked period gates nothing here. Errors block finalize unless overridden with a
  ≥ 5-char reason (audit action `override`).
  **PDF is Chromium, not pdfmake** — the one exception in the app, because the HTML renderer is shared
  with the live preview. `lib/fs/pdfBrowser.ts`: `puppeteer-core` (never `puppeteer`: no download, and
  there is no linux-arm64 Chrome for Testing); path = `fs.chromium_path` setting (Settings → PDF engine) >
  `PUPPETEER_EXECUTABLE_PATH` > probe. **A configured path that is missing resolves to null** — it is
  not replaced by a detected browser. Never launched at boot; lazy singleton closed after 90 s idle; one
  job at a time, queue of 3 (`503 PDF_BUSY`), 120 s timeout; pages run with JS off and all network
  blocked. No Chromium = `503 PDF_ENGINE_UNAVAILABLE` on preview.pdf / PDF export / finalize, nothing
  written; DOCX, XLSX, the editor and the live preview keep working. `Dockerfile.server` installs
  `chromium` and deliberately does NOT set the path in ENV (Alpine has shipped both
  `/usr/bin/chromium-browser` and `/usr/bin/chromium`); `deploy/setup-pi.sh` apt-installs it, non-fatally.
  Fonts: `server/assets/fs-fonts` (38 TTFs, SIL OFL 1.1, licence texts beside them, listed in NOTICE and
  `license-policy.json` `bundledAssets`), embedded as data URIs in the PDF and served to the preview by the
  PUBLIC, allowlisted, extensionless `GET /api/v1/fs-fonts/:file` (mounted above the rate limiter; no
  `.ttf` in the URL so a proxy's static-file rule can never claim it).
  **Reviewer accounts** are read-only at the API boundary, so everything needed to LOOK is a GET:
  `GET …/preview-data` (saved state), `GET …/preview.pdf`, `GET …/export`, `GET …/bind-preview`. The
  POST forms carry an unsaved draft. The editor never overwrites unsaved edits with a background refetch.
  `['fs-preview-data']`, `['fs-reports']`, `['fs-report']` are in `BALANCE_DEPENDENTS`. The three pages are
  `React.lazy` (the engine + zod stay out of the main bundle); pdf.js is loaded through
  `utils/pdfjsWorker.ts`, shared with `LeadSheetPdfViewer` — in Vite **dev** it returns the worker URL,
  because the dev server injects an `/@vite/client` import that cannot resolve from a blob: URL.
  **Backups** (`lib/fs/fsBackup.ts`, called from `routes/backup.ts`): client/period archives carry
  layouts, statement sets, versions and classification; settings/full carry the library (restored IN
  PLACE by `builtin_key` / name so ids never change; letter HTML sanitized, styles/layouts schema-checked).
  `fs_report_version_files` is never dumped — a restored version re-renders its PDF from the frozen JSON on
  first download and is flagged `regenerated`. **Ids inside layout JSON are remapped** by
  `remapFsLayoutIds` (`lib/fs/fsLayoutRemap.ts`, pure, tested) for the live layout AND each version's
  frozen copy: an unmapped lead sheet id falls back to its code, an account line left with no accounts
  is dropped and scrubbed from totals/plugs. A version restored as a NEW client keeps its old
  `source_stamp` and so reads "balances changed" until `impact` says the numbers are unaffected —
  recomputing the stamp on restore would assert, unchecked, that nothing moved.
  Tests: `npm run test:fs` (server/: engine, sync, source, remap, PDF engine), `npm run test:fstree`
  (root), `npm run test:fs-e2e` (root; real server + scratch Postgres via `E2E_PG_ADMIN_URL`; passes with
  or without Chromium, asserting the degraded path when there is none). Knowledge base:
  `server/knowledge/statement-writer.md`.
- Workpaper Package + Tickmarks (tickmark_library + tb_tickmarks, TB superscripts + legend).
  PDF report options live in `PDF_REPORT_SECTIONS` (WorkpaperPackagePage) and `REPORT_GENERATORS`
  (routes/pdfReports.ts) — keep ids and labels in step. That array's order is binder order: it drives
  both the checkbox list and the merge sequence, and the Workpaper Index leads. `workpaper-merged`
  prepends a generated Table of Contents (`generateWorkpaperTocPdf`) listing each selected report and
  its page range in the merged file; the TOC counts itself as page 1, so the route rebuilds it if its
  own length changes the numbers.
- **Lead Sheets** (`lead_sheets` + `chart_of_accounts.lead_sheet_id` + `lead_sheet_signoffs`).
  One lead sheet per account; membership **persists across periods** because it lives on the COA row,
  so roll-forward carries it with no code and `keepWorkpaperRefs: false` must NOT clear it (a W/P ref
  is a per-year annotation, a lead sheet is structure). Seeded A–O from `DEFAULT_LEAD_SHEETS` in
  `server/src/lib/leadSheets.ts`, but **letters are data, not code** — users rename/reorder/delete/add
  them and `suggestLeadSheet()` returns a *code* the route resolves against the client's own rows.
  That constant's array order is **display** order; a separate `specificity` field drives
  first-match-wins, because this app's `category` has five values where MyBooks had nine (K/N share
  `revenue`; L/M/O share `expenses`). Signals are category + account-name keywords + the
  **leading digit** of the account number (never a numeric range — templates are 5-digit, seeds are
  4-digit). Two traps pinned by tests: rule O must not read `subcategory` (hundreds of template
  accounts carry `subcategory = "Other Expenses"` while being ordinary operating expenses), and its
  name test must be **anchored** (`Car & Truck Other Expenses` is an operating expense; `Other
  Expenses` is not). Auto-assign is **re-runnable** with a preview/confirm modal (default
  `unassigned_only`, so a re-run never stomps a hand-set assignment), not MyBooks' seed-once.
  `copy-from-client` remaps lead sheets **by code**, never by id.
  Sign-off: `preparer`/`reviewer`, **anyone may sign either line — no role gate, no order gate, no
  preparer→reviewer cascade**; a partial unique index `(lead_sheet_id, period_id, role) WHERE
  invalidated_at IS NULL` enforces one live signature per slot and unsign is soft. Staleness is a
  **SHA-256 content hash** of the members' raw TB amounts (`leadSheetBalanceStamp`), not a timestamp —
  a timestamp misses JE deletion (which *lowers* max(updated_at)) and goes false-positive on restore.
  Every stamp producer must use `loadStampRows()` in `lib/leadSheetStamp.ts` (`is_active` only, **no**
  `whereHasActivity`) or the PDF and the screen will disagree. Sign-off **warns, never blocks** —
  balances stay editable and the sheet just goes STALE. The Lead Sheets PDF sits between
  `pdf-wp-index` and `pdf-tb` in both binder arrays.
- **Document storage (pluggable: local disk or Backblaze B2)** — `server/src/lib/storage/`
  (`paths.ts` / `keys.ts` / `localDriver.ts` / `b2Driver.ts` / `sentinel.ts` / `index.ts`), ported from
  Vibe Time & Billing. Resolution is **settings row > env > local**, memoised like `mailService.ts`
  with `invalidateStorageCache()` — credentials are NEVER written into `process.env`. B2 being
  misconfigured is **not** a boot failure (it would brick an appliance over an optional feature): it
  surfaces as `configError`, writes fail 503, reads of existing rows still work.
  **`getStorageDriverFor(backend)` is load-bearing** — reads route by *the row's* `storage_backend`,
  writes by *current* config, so a B2 row keeps working after an admin flips back to local and a
  legacy row keeps working after B2 is switched on. A row with `object_key IS NULL` is LEGACY and is
  read from its absolute `file_path`; never rewrite those implicitly.
  B2 quirks that are load-bearing, each commented at its site: `CopySource` must encode **each path
  segment separately** (`encodeURIComponent` turns `/` into `%2F` and every nested key 404s);
  HEAD on a missing key throws; ETags come quoted and are **not** content hashes (hence the separate
  `sha256` column); the health probe leads with `list()` because a HEAD carries no response body and
  the SDK degrades to a bare `UnknownError`. Operators must set the bucket lifecycle to
  "keep only the last version" — that is B2-native, not settable over S3.
- **Client ↔ folder linking with sentinels** (`client_folder_links` + `lib/clientFolders.ts`).
  Linking is **explicit**: no auto-create, and an upload for an unlinked client is refused with
  `CLIENT_NOT_LINKED`. Identity lives in `<folder>/_Vibe/client.json`, **not the path**, which is what
  lets a folder renamed in the B2 console be re-bound by Verify instead of orphaning every key
  (`clients.name` has no unique index, so the sentinel is also what tells two same-named clients
  apart). `install_id` replaces the reference's `firm_id` — this app is single-tenant. `client_id`
  and `install_id` are immutable through `updateSentinel` (type + runtime throw + re-pin).
  **Storage write comes BEFORE the DB commit** everywhere: a failed DB write leaves an orphan
  sentinel a later verify adopts; the reverse loses the binding. Migration `20260828000004`
  **backfills a legacy link for every existing client**, or requiring a link would make every current
  client un-uploadable on upgrade.
  Key layout is `<prefix>/<client folder>/<Section>/<year>/<file>` — section BEFORE year — which for
  the shipped defaults reads `Clients/Jack Black LLC/Workpapers & Support/2025/file.pdf`. Both the
  client-folder and year patterns are **settings**, not constants (`storage.client_folder_format`,
  default `{name}`, placeholders `{name}`/`{code}`/`{id}`; `storage.year_format`, default `{year}`);
  each is rejected at the route unless it actually places its required placeholder, and that check
  runs BEFORE any `upsertSetting`, since those start their query the moment they are called.
  `{code}` is `clients.client_code` — the firm's own client number, the same idea as Vibe Time &
  Billing's `tax_software_id`; a pattern like `{code} - {name}` tidies its own seams when a client has
  no code. **The Client folders table is server-paged** (`GET /storage/links?page&limit&search&status`,
  `lib/clientLinksQuery.ts`, tested): search is a submitted ILIKE over name / `client_code` /
  `storage_path` (LIKE metacharacters escaped), status is `all|unlinked|attention|active`, and
  `meta.counts` is the WHOLE firm — never narrowed — so the header's "N unlinked / N need attention"
  stays a true health summary while searching (clicking either sets the filter). Page size is the
  persisted `storageLinksPageSize` ui-pref; search/status/page are per-visit state.
  The fiscal year comes from `periods.folder_year` when set, otherwise from
  `periods.end_date` adjusted by `clients.tax_year_end`, never from `period_name` (free text a user
  can rename). `folder_year` exists because derivation cannot know about a short year, a stub period
  or a firm's own naming. Sections come from the editable `storage_folder_template` (seeded as the
  single `Workpapers & Support`), with partial unique indexes enforcing exactly one workpaper target
  and one upload default. Keys are STORED, never re-derived, so renames move nothing.
- **Lead sheet attachments** (`lead_sheet_attachments`) — auto-named `A001`, `A002`, `B001`,
  **period-scoped** so a 12/31 file never surfaces in a 7/31 package. `UNIQUE (period_id, ref_code)`
  is the allocator's source of truth, not the SELECT; a 23505 triggers a compensating object delete
  and a retry. **Deleting an attachment leaves a TOMBSTONE** (`deleted_at`, `document_id` SET NULL) so
  its ref code is never reissued — a reissued code would collide with one already printed in a
  binder. `nextRefCode` therefore counts tombstones too. PDF, PNG and JPEG are accepted; images are
  converted to PDF on upload so every attachment stays stampable and mergeable.
  **Tickmark stamps are BURNED INTO the stored PDF**, not applied at download, because the bucket is
  browsable and an archive whose marks live only in the app is not an archive. The accepted
  consequence is that a stamp **cannot be removed** — the viewer confirms before placing and offers no
  delete. Only the NEW mark is drawn each time (re-drawing would double-ink). **pdf-lib's
  StandardFonts cannot encode the seeded `✓` (U+2713) and throw**, so a real TTF is embedded via
  `@pdf-lib/fontkit`, reusing the `ROBOTO_MEDIUM` buffer exported from `PdfTemplateService` — there is
  a test pinning that StandardFonts genuinely throws on `✓` but not on `†`.
  **But pdfmake's Roboto has no `✓` glyph either, and THAT failure is silent** — fontkit maps an
  unsupported code point to `.notdef`, which has a width and draws a hollow box, so `drawText` and
  `widthOfTextAtSize` both succeed while the stamp comes out as an empty rectangle. Coverage is
  therefore checked against `font.getCharacterSet()`, never by "it didn't throw", and anything Roboto
  lacks falls back to **ZapfDingbats** (a standard PDF font: `✓ ✔ ✗ ✘`, nothing embedded), then to
  `?`. The ZapfDingbats encodability probe runs against a module-level scratch document, because
  `embedFont` writes the font out at save whether or not anything drew with it. Notes stay in Roboto
  with per-character substitution — one stray glyph must not cost the preparer's whole note.
  **Three annotation kinds share one endpoint and one burner** (`POST .../annotations`,
  `burnAnnotation`): `tickmark` (library symbol + optional caption), `note` (free text ≤ 500 chars,
  drawn in a bordered box whose top-left is the click point, wrapped by `wrapText` and slid back
  onto the page near an edge; optional `widthPct` — a fraction of page width set by drag-drawing a
  box in the viewer — overrides the 220pt default that could lie across page text, and old records
  without it keep that default) and `line` (start/end as page fractions, `strokeWidth` in points,
  drag-to-draw in the viewer with an SVG preview overlay). The `annotations` jsonb is a
  discriminated union on `kind`; a record **without `kind` is a tickmark** (rows written before
  notes/lines existed), and the route's `z.preprocess` defaults a missing `kind` for the same
  reason — a `.default()` on the literal would not, because `discriminatedUnion` dispatches on the
  raw input before defaults apply. Notes and lines carry their own `color` from the tickmark
  palette; a tickmark's colour is snapshotted from the library row. All three are permanent.
  An attachment carries an optional `account_id`, so it hangs off **one row of the schedule** — the
  paperclip in each member row's Files cell — or off the schedule as a whole when it is null. The
  sheet-level Supporting files panel lists both, labelling the per-account ones with their account
  number; it is the index, not a second store.
  The workpaper binder can optionally merge attachments (`?includeAttachments=1`, default off), and
  `POST .../workpaper-merged/save` writes the same bytes into the client's workpaper folder.
  `buildWorkpaperPackage` in `lib/workpaperPackage.ts` is the single path both use.
  **pdfjs-dist is double-lazy** (React.lazy + dynamic import inside the effect) — a top-level import
  would add ~1 MB to the initial bundle. Its `?url` worker module is a `.js`, which is what lets
  `deploy/web-entrypoint.sh` rewrite the `__VIBE_BASE_PATH__` sentinel in it; the worker that shim
  points at is a **`.mjs`**, and nginx's bundled `mime.types` has no entry for that extension, so it
  falls through to `default_type application/octet-stream` and the browser refuses to execute the
  module ("Failed to fetch dynamically imported module"). Both nginx configs therefore carry a
  `location ~ \.mjs$ { default_type application/javascript; }` — as a LOCATION, because a
  `types { ... }` block at server level replaces the whole inherited table instead of adding to it.
  Fixing the server was **not enough**, because a browser that cached the bad response keeps its
  stored Content-Type forever: the entry revalidates with `If-Modified-Since` and a 304 carries no
  Content-Type to replace it with. So `LeadSheetPdfViewer` no longer hands pdfjs that URL at all —
  it fetches the worker, re-wraps the bytes in a `Blob` and sets `workerSrc` to the blob: URL, which
  makes the server's label irrelevant. Keep both: the nginx block is what a fresh browser needs, the
  blob is what an already-poisoned one needs. Note also that pdf.js memoizes its fake-worker
  fallback per page load (`PDFWorker._setupFakeWorkerGlobal`), so ONE failure disables the real
  worker for the whole session — a reload is required, and any test of this needs a fresh page.
  `location = /index.html { add_header Cache-Control "no-store" always; }` in both configs is the
  matching rule for the entry point: with no header at all a browser invents a lifetime from
  Last-Modified and can run a previous deploy's bundle for days.
- **Lead schedule notes** (`lead_sheet_notes`) — the review conversation on a lead sheet. **Per
  period**, unlike membership: a query about the 2024 cash reconciliation says nothing about 2025.
  `account_id` NULL means the note is about the schedule as a whole; set, it is the query on that one
  row (the Notes cell shows `open/total`). Notes are **resolved, never deleted** — a closed query is
  the evidence that review happened, which is the point of a workpaper — and both the page and the
  Lead Sheets PDF print resolved notes greyed rather than dropping them. The PDF renders them between
  the schedule's total row and the sign-off block, so a reviewer signs with the open queries in view.
- **QuickBooks Online connector** (`qbo_connections`, `qbo_oauth_states`, `chart_of_accounts.qbo_account_id`;
  `server/src/lib/qbo/*`, routes `qboIntegration.ts` + `qboImport.ts`; `QuickBooksPage.tsx` (Setup, per-client connections) +
  `QuickBooksSettingsPage.tsx` (Admin group, the Intuit credentials — admin-gated in the page AND on every
  `/settings*` route, so a non-admin never even issues the GET),
  **`['qbo-connections']` is fetched ONLY through `hooks/useQboConnections.ts`** — the key is shared by the
  QuickBooks, TB and PY Tie-Out pages and TanStack caches whichever shape the first page stored; when one
  stored `{rows, meta}` and another a bare array, navigating between them crashed with "x.find is not a
  function". **Intuit's production checklist** (EULA + privacy URLs, host domain, launch/disconnect/
  connect URLs, hosting IP) is covered by `intuitAppUrls()` in `lib/qbo/settings.ts` (shown with Copy
  buttons on the admin page and printed in the setup guide), by the PUBLIC, unauthenticated SPA routes
  `/privacy` and `/terms` (`pages/LegalPage.tsx`, operator named from `GET /api/v1/public/legal`), and by
  `?disconnected=1` on `/quickbooks`. `firm_name`/`firm_address`/`firm_email` are set on Settings → Firm
  identity (`GET/PUT /settings/firm`, `FirmIdentityCard`); the first two had been read by PdfTemplateService
  for every PDF header with no UI to set them. `QboImportDialog.tsx` on the TB page). Read-only, **one company per client** (`UNIQUE(client_id)`
  and `UNIQUE(environment, realm_id)` — two rows for one realm would race on refresh-token rotation).
  **Configuration is UI-only by design** (settings rows `qbo.client_id` / `qbo.client_secret` (encrypted) /
  `qbo.environment` / `qbo.redirect_uri` beat the `QBO_*` env fallbacks; `loadQboConfig()` memoised like
  `mailService.ts`, never throws at boot) and the page's "Setup guide (PDF)" is generated by
  `pdf/qboSetupGuide.ts` so it prints THIS instance's effective redirect URI. The OAuth handoff lives on
  the **states row**, not on `qbo_connections`: the callback consumes the nonce atomically, stores the
  encrypted token payload + realm as *pending*, and redirects to `/quickbooks?pending=<id>` where the
  admin who started it confirms the binding — so a re-auth for an already-connected client never collides
  with `UNIQUE(client_id)`, and a wrong company can be discarded (revoked) without touching the client.
  Binding a **different realm** to a client nulls every `qbo_account_id` on its COA; Disconnect keeps them.
  Matching is deterministic — stored qbo id, then QBO `AcctNum` against `account_number`, then (a
  SECOND pass, so a name can never take a row an id or number claims) an **exact** name match
  (`normalizeName`: case + whitespace; full name then leaf; only when exactly one unclaimed COA row
  has it and its `category` does not contradict QBO's Classification; badged **by name** in the
  preview, `writeQboId`), else create-new typed from `Classification`. The name pass exists because
  a company that never turned on QBO account numbers has no `AcctNum` at all and every account came
  back "Create new" — originally with a `QB<Id>` placeholder number, **now with NO number**: the
  placeholder was minted in `matcher.ts` and fell through two more fallbacks (`applyDecisions`, the
  confirm insert) onto real charts of accounts. All three are gone; `newAccountNumber` is null,
  `applyDecisions` throws `DecisionError` and the confirm returns `422 MISSING_ACCOUNT_NUMBER` for a
  new account without one, and the dialog's `canConfirm` already gated on `missingNumber`. Numbers
  come from **`POST /import/qbo/suggest-numbers`** (`{importId, rowKeys?, reservedNumbers?, useAi}`):
  the AI pass (`TB_TASK_CLASSES.ACCOUNT_NUMBERING`, the same class the CSV/PDF numbering uses;
  consent `AI_PII.qboNumbering`; rows referred to by `ref` = rowKey) and then
  `assignSequentialNumbers` in `lib/accountNumbering.ts` (pure, tested) for whatever the AI missed
  or for everything when `useAi` is false / the provider fails — the client's own band per category
  (whichever expense digit it favours), its own digit width, next multiple of ten above the band's
  highest. QBO's Classification beats the model's category. The dialog badges each number `AI` /
  `seq` (`numberSource`, cleared by a hand edit), highlights an empty Acct # in red, offers "Suggest
  account numbers with AI" + an "in sequence" link (just the button when AI is off), and has
  **view tabs** All / Matches / New accounts / Exceptions / Skipped over the same `rows` — filtered
  for display only, every edit still addresses the original index. Its `AccountSearchDropdown`
  carries `onCreateNew` → `QuickAddAccountModal`, the same flow as the AJE dialogs (a quick-added
  account becomes a plain match after `['accounts', clientId]` is invalidated).
  **Inactive accounts are invisible to the preview but not to the unique indexes.** `loadCoaForMatch`
  is `is_active` only, so a confirm that created an account with a retired account's number, or one
  whose QBO id a retired account still held, died on `chart_of_accounts_client_id_account_number_unique`
  / `chart_of_accounts_qbo_account_unique` as a bare 500 (reproduced end to end against a throwaway
  Postgres with the real server — `scratchpad/repro_qbo_confirm.sh` pattern: migrate, seed admin,
  rotate the bootstrap password via `/auth/change-password`, insert a `document_imports` row with a
  synthetic report, POST `/confirm`). Now `loadInactiveByNumber` feeds `matchRows(..., { inactiveNumbers })`
  at every call site (an AcctNum on a retired account is exception `ACCT_NUM_INACTIVE`), suggest-numbers
  treats retired numbers as taken, the confirm refuses a typed retired number with `422
  ACCOUNT_NUMBER_INACTIVE` naming the account, and a create-new insert first clears the QBO id from
  whatever row holds it (the reviewer chose "new", so the old link is stale — the same clearing
  `stampQboId` does for a match). Any 23505 that still escapes is a `409 IMPORT_CONFLICT` via
  `isUniqueViolation` / `uniqueViolationMessage` in `lib/pgErrors.ts`, never "internal error".
  **Still no fuzzy matching in code**: the leftovers
  go to the opt-in AI pass — `POST /import/qbo/suggest-matches` (`lib/qbo/suggest.ts`,
  `TB_TASK_CLASSES.QBO_MATCH` = `tb_qbo_match`, consent dialog `AI_PII.qboMatch`) sends QBO
  names + Classification and COA number/name/category only (no client name, no amounts; COA rows
  are referred to by per-call ordinal, so the reply can only pick an offered candidate), and
  `sanitizeSuggestions` drops unoffered ordinals, category contradictions and second claims on one
  account. Suggestions are badged `AI · high/medium/low` in the dialog and are **never written on
  their own** — the reviewer confirms; any hand edit clears the badge. Batched 40 rows per AI call
  server-side and 80 per request from the client (`QBO_SUGGEST_CHUNK_SIZE`) for the proxy timeout.
  The dialog's **Skip zero-balance accounts** (default on) skips debit=credit=0 rows via the same
  `preSkipDecision` memory as the include checkbox — QBO lists every account with activity, and a
  zero line has nothing to import. Anything ambiguous is an `exception` the reviewer resolves. `/preview` stores the raw report + sha256 in `document_imports`
  (`import_type:'qbo'`) and **`/confirm` re-derives every cent from that stored report** — decisions only
  route rows (`applyDecisions`, tested), the browser never supplies amounts. QBO omits zero-balance
  accounts, so the preview lists `absentNonzero` and zeroes them by default. Mounted at `/api/v1/import/qbo`
  so nginx's long `/import/` timeout and the upload/ai-step limiters apply; the VerificationPanel's
  `GET /import/pdf/imports` filters to csv/pdf so a QBO row never reaches it. `startQboKeepalive()`
  refreshes every active connection weekly (Intuit refresh tokens lapse from disuse) and prunes expired
  states; token refresh takes `pg_advisory_xact_lock(hashtext(realm_id))` because Intuit rotates the
  refresh token on every refresh. The only AI step is the opt-in match suggestion above — lead sheets
  come from `suggestLeadSheet()`, tax codes from the existing auto-assign. **`target: 'prior'`** on
  `/preview` reuses the whole flow for the PY Tie-Out: dates from `priorYearRange()`
  (`lib/qbo/priorRange.ts` — the adjacent period's own dates when one exists, else slid back a
  year, leap day → 28th), confirm writes `py_comparison_data` (`source:'qbo'`, replacing the
  period's PY data like `confirm-csv`) instead of `trial_balance`, never zeroes absent accounts,
  and still stamps `qbo_account_id`. The dialog warns that QBO reports the prior year
  **before its close**, so the retained-earnings/P&L offset is expected, not a variance. Backups carry the connection row and
  restore re-inserts it **only into the same client**, with the access token nulled.
- **Backups carry rows, not bytes.** `client_documents` was previously missing from backups entirely
  (it appeared only in `deleteClientData`). On restore, a document row whose client id CHANGED has its
  `object_key`/`bucket`/`file_path` nulled and a `client_folder_links` row is skipped altogether —
  otherwise a restored-as-new client would claim the original's objects and folder, and deleting
  either client's copy would destroy the other's bytes. **This applies to `replace` mode too**, which
  takes an arbitrary `targetClientId` and so cannot assume the archive came from that client; without
  the guard the insert dies on the partial unique index over `(bucket, object_key)`. Restoring into
  the SAME client keeps its keys and its link, which is the whole point of that mode.
- **A client archive must restore every client table it carries, and carry every table `deleteClientData`
  removes.** Until S0 (issue #18) restore dropped the tickmark library and TB tickmarks, engagement tasks,
  M-1 adjustments, reconciliations and their items (dumped, never re-inserted), and PY tie-out data, saved
  reports and export consolidation settings (deleted on replace, never dumped). Both restore paths now share
  `restoreClientWorkpapers` in `routes/backup.ts`; a row whose parent is not in the archive is skipped and
  counted, never pointed at another client. A period archive carries the whole tickmark library, and (desktop sync, owner
  2026-11-19) the other periods and bank transactions its own rows name, as plain rows without their data:
  a variance note's comparison period, a reconciliation item's earlier-period transaction and its period.
  So restoring a period archive as new also makes the prior period, empty and marked `periods.is_reference`
  (migration `20261001000003`); the manifest's `periodId` names the archive's own period. **A reference
  period is not a period to work in:** it is left out of `GET /clients/:id/periods`, the MCP period list
  and every prior-period lookup (`fsSource.ts`, the QuickBooks prior range), so statements read as if there
  were no prior period; `assertPeriodUnlocked` (and the bank-transaction and reconciliation lock checks)
  refuse writes into it as `PERIOD_LOCKED` with their own message. A new query that lists a client's
  periods or looks for "the prior one" must add `is_reference: false`. `npm run test:backup-e2e` (root) walks the schema's foreign keys from `clients` and
  compares every table after restore-as-new, replace and a period restore, so a NEW client table fails it
  until the backup carries it or `NOT_COMPARED` in `test/backup-e2e.mjs` says why not.
- **Rows a desktop sync must recognise carry `sync_uid` (S1, migration `20261001000001`).** `clients`,
  `periods`, `chart_of_accounts` and `bank_transactions` have `sync_uid uuid NOT NULL DEFAULT
  gen_random_uuid()` with a unique index; ids are re-keyed on every restore, the uid is not. Every
  restore path inserts these four through `keepSyncUids` (`routes/backup.ts`): the archive's uid stays
  unless a row here already holds it (a copy next to its original is a different client, so it gets new
  ones); an archive from before S1 gets new ones. **Never copy a row of these tables with `...row` outside
  that helper** — the unique index makes it a 500. Lead sheets (code), tax codes (resolver), the tickmark
  library (symbol) and attachments (ref code) need no uid.
  The **period stamp** (`lib/sync/periodStamp.ts`, pure; loader `periodStampLoad.ts`; `npm run sync:stamp
  -- <periodId>`) is one SHA-256 over the period's SQ4 rows with every id replaced by its natural key
  (uid, entry type+number, lead sheet code, tickmark symbol, attachment file SHA-256), user ids and
  write times left out, DATE columns as calendar dates. It must not change across a restore of the same
  period (`test:backup-e2e`) and must change when any of its rows does (`periodStamp.test.ts`, one test
  per table). A new period-scoped table joins `STAMP_TABLES` with a spec, or the desktop's send-back
  will not notice changes to it.
- **Desktop sync devices (S2, migration `20261002000001`).** A paired desktop holds a device token
  (`vtbsync_` + 32 random bytes; only its SHA-256 is in `sync_devices`), made by `POST /api/v1/sync/pair`
  from a one-time code (`sync_pairing_codes`, hashed, 10 minutes, one use, row-locked; 8 characters with
  no look-alikes, `lib/sync/deviceTokens.ts`). The code is made from a signed-in session
  (`POST /api/v1/desktop-sync/codes`), so pairing works under any sign-in, `oidc_only` included, and is not a
  local sign-in path (no `localLoginRefusal`). **The device token works ONLY on `/api/v1/sync/*`**
  (`syncAuthMiddleware`, `lib/sync/syncAuth.ts`): every other route's `authMiddleware` refuses it as a bad
  JWT, and the sync routes refuse a JWT. A device acts as its user: deactivated user or revoked device →
  401 at once; a reviewer's device reads only (`blockReviewerWrites`). **A device token ends** (owner
  2026-11-19, `lib/sync/deviceRevoke.ts`) on Remove, on deactivation (revoked then, so reactivating does
  not revive them: Users PATCH, Vibe Auth `setActive`), after 90 days unused (`SYNC_DEVICE_EXPIRED`), and on
  a password RESET (admin PATCH `/users/:id`, Vibe Auth `setLocalPassword`, an emailed reset or invite
  link): `revokeUserDevices`, which also deletes unused codes and, on a reset, stamps
  `app_users.sync_reset_at` (migration `20261002000002`) so a session issued before it gets 401
  `SIGN_IN_AGAIN` from `POST /desktop-sync/codes` (an emailed reset leaves old sessions working). A
  user's own password change (owner 2026-11-19) also calls `revokeUserDevices`, releasing their holds, but is
  not a reset: no `sync_reset_at`, so the session that changed it may pair again at once. Not on sign-out. Audit: every
  sync write, every refusal, and a GET only when the route sets `res.locals.syncAudit = true` (it hands out
  client data); polling reads are not audited. Making a code retires the user's unused ones.
  `POST /pair` has its own limiter (10 failed tries per 15 min per ADDRESS, not `rateLimitKey`, whose JWT
  claim is unverified). `npm run test:sync-e2e`;
  the `oidc_only` pairing step is in `sso-e2e.mjs`. The global reviewer gate in `app.ts` lets reviewers write
  to `/auth/*` (their own password, factors, passkeys, browsers) and `/desktop-sync/*` (their own desktops):
  without it a new reviewer could never finish the forced password change.
- **Desktop sync check-outs (S3, migration `20261003000001`).** `POST /api/v1/sync/periods/:uid/pull`
  `{ checkout }` takes a `period_checkouts` row (one live per period) and runs a job (`sync_jobs`,
  `lib/sync/jobs.ts`: in-process, one at a time per client, a restart fails open jobs) that writes the
  period `.tbak` with files into `backups/sync/<job>` (no `backup_history` row; `createBackup` options
  `outDir`, `recordHistory: false`, `manifestExtra` computed inside the archive's REPEATABLE READ
  snapshot: `manifest.sync { stamp, checkoutId, periodUid, clientUid }`). **While a period is checked
  out, every write to its data refuses with 409 `PERIOD_CHECKED_OUT` naming the user and device**:
  `assertPeriodUnlocked` (lock-gated writes) and `assertNotCheckedOut(trx, periodIds)` (writes the lock
  does not gate: Statement Writer reports, sign-offs, notes, tickmarks, engagement tasks, variance notes,
  reconciliations, bank rows by their OWN period, period name/dates, lock, delete, restore replace, and
  the lead sheet / tickmark / document deletes that cascade into a held period). Both take the period
  row FOR UPDATE **inside the write's transaction**; lock behaviour itself is unchanged. Guard errors
  carry `expose: true`, which `sendServerError`, the restore handler and the MCP tool wrapper pass
  through (so a route that maps only PERIOD_LOCKED still answers 409). **A new write route or MCP tool
  must be classified in `lib/__tests__/periodWriteRoutes.test.ts`** (the test reads the route list from
  the source) and, if it writes period data, guarded and added to the held-period walk in
  `test/sync-e2e.mjs`, which fires every period route and tool at a held period and checks the stamp
  did not move. Release: the holder (`DELETE /sync/checkouts/:id`) or an admin with a reason
  (`POST /periods/:id/checkout/release`, Periods page). Nothing releases automatically; older than
  `settings['sync.checkout_warn_days']` (14) is flagged stale (Periods page, dashboard for admins via
  `GET /desktop-sync/checkouts`). The web TB, JE and bank pages show `CheckoutBanner`.
- **Desktop sync send-back (S4, migrations `20261004000001`/`…02`).** Uploads in parts
  (`lib/sync/uploads.ts`: `POST /sync/uploads`, `PUT …/parts/:n`, `…/complete` checks the SHA-256; 50 MB
  parts, `SYNC_PART_BYTES`). `POST /sync/periods/:uid/push`, `POST /sync/clients/:uid/periods/push` (a new
  period, or a reference filled in) and `POST /sync/clients/push` (a new client, `restoreAsNew` with
  `keepName`) run as jobs. **`lib/sync/mergePeriod.ts`** replaces one period's SQ4 rows in one
  transaction, ids remapped by the stamp's `stampRefs`; bank rows in place by uid, Statement Writer
  versions kept by number, journal entries relinked by type + number; SQ3 for accounts and layouts by
  `updated_at` (a trigger stamps it on every changing UPDATE; restores `SET LOCAL vtb.keep_updated_at`).
  Accepted only if the period's stamp equals the archive's own (`archiveStamp`), every other period's
  stamp is unchanged and `sync.totals` tie; the server log names the differing tables. **A new foreign key
  into a period table** must be classified in the `sync-e2e` FK step and handled in the merge. What a
  desktop's archive must be is in `desktop-sync-addendum.md`.
  **Archives write DATE columns as plain `YYYY-MM-DD`** (`dateColumns`/`withCalendarDates` in `routes/backup.ts`);
  a node-pg Date is local midnight, so the old ISO text fell on the day before for a reader in another zone and
  every desktop (UTC) send-back to a server west of UTC was refused. The stamp's `dateText` reads old ISO text by
  its date part, which is what Postgres stores from it. A sent-back sign-off is matched WITHOUT its signer (the
  desktop's user ids are its own) and keeps the server's; a new client's sign-offs become the sender's. A used
  upload names its `jobId` on every refusal, and `DELETE /sync/uploads/:id` cancels an unsent one.
- Variance notes (per account per period, TB Report inline editing)
- **Every FK into `periods` must carry a delete action.** `DELETE /periods/:id` is a bare delete that
  trusts cascades; five references shipped with none (bank_transactions, document_imports,
  variance_notes ×2, bank_reconciliations, and the `rolled_forward_from` self-pointer), so deleting
  any period that had ever been used was a 23503 reported as a 500. Migration `20260903000001` sets
  CASCADE on the period-scoped ones and SET NULL on the roll-forward pointer (provenance, like
  backup_history). The route now runs in a transaction (audit row + delete together) and maps a
  remaining FK violation to `409 PERIOD_IN_USE` naming the blocking table via
  `lib/pgErrors.ts` (`isForeignKeyViolation` / `foreignKeyBlockMessage`, tested) — use that helper
  on any other delete route instead of letting `sendServerError` swallow it. A new table that
  references periods must say `onDelete(...)` explicitly. The PeriodsPage delete mutation reads
  `res.error` (apiFetch resolves, never throws), which it previously ignored.
  **That was not enough**: `audit_log.period_id` was already CASCADE, and `audit_log` is append-only
  via BEFORE UPDATE/DELETE triggers (`20260418000002`) — so the cascade itself RAISEd for any period
  with audit history, i.e. every real one, and a fresh test database (no audit rows) could not show
  it. Migration `20260903000002` makes it **SET NULL** (the trail outlives the period; rows keep
  `client_id`) and teaches the guard ONE exception: an UPDATE that changes nothing but `period_id`,
  to NULL (`to_jsonb(NEW) - 'period_id' = to_jsonb(OLD) - 'period_id'`). Everything else still
  raises; client delete/replace-restore keep using `SET LOCAL app.audit_log_mutation_allowed`. The
  route maps a P0001 (`isRaisedException`) to `409 PERIOD_DELETE_REFUSED` with the trigger's own
  text. **Test any delete path with audit rows present** — `logAudit` has been writing them for
  every action since Phase 1.
- QA Round 1 & 2: 30-item UX audit — period lock enforcement on TB grid, batch op toasts,
  reopen reconciliation feedback, engagement double-submit prevention, FS comparative layout,
  Spinner component, consistent error/success box styles, sidebar workflow ordering,
  demo seed data (003_demo_client.js — Demo Company LLC FY2024)
- QA Round 3: TB AJE column balance fix (ensureTrialBalanceRows helper + backfill migration), bank transaction source account column reorder, Excel import support on TB (exceljs buffer-to-CSV), New JE button on TB grid, JE edit dialog from GL and TB zoom views, AI stop_sequences fix, AI JSON extraction try/catch, LLM provider whitespace stop-sequence filtering, TB Report column visibility toggles (view/PDF/Excel), Financial Statements variance % column + wider layout + consistent column colors, Tax Code column read-only on TB grid, date format cleanup (remove time), font size consistency audit across all report pages, dark mode audit (27 fixes across 9 files), bank statement PDF import (vision + text fallback, account number masking), PII protection (client name removal from AI prompts, account number masking, AI data disclosure consent popups on all 6 AI features), bookkeeper letter preview auth fix, knowledge base updates
