# DESKTOP.md — desktop mode for ClientLedger Trial Balance

Desktop mode (`DESKTOP_MODE=true`) runs this engine as a Node Single Executable Application (SEA) for one user on one machine, against an embedded PostgreSQL 16 on 127.0.0.1, started by the ClientLedger Trial Balance launcher. Desktop code lives in `server/src/desktop/`; upstream files get one-line hooks only.

## Build and run

```
cd server
npm ci                      # no GitHub Packages token needed; @kisaesdevlab/vibe-auth is optional (Q12)
npm run desktop:build       # dist-desktop/clientledger-tb-engine[.exe] + dist-desktop/resources/
npm run test:desktop        # desktop session gate
```

`desktop:build` regenerates `src/desktop/sources.generated.ts` (static lists of every migration and seed), bundles `src/desktop/main.ts` with esbuild into `dist-desktop/engine.cjs`, and injects it into a copy of the running Node binary (Node SEA, postject). Build on each target OS; Node 24.

Bundle fix-ups (all in `scripts/desktop/build.mjs`, no upstream file changes):
- `bcrypt` → `bcryptjs` alias (same API and hash format, no native module).
- pdfkit/fontkit/linebreak `readFileSync(__dirname + …)` data files are inlined.
- `@kisaesdevlab/vibe-auth` (private, single sign-on) is not used: the bundle resolves it to `src/desktop/vibeAuthStub.ts` (local mode: no SSO, no `/auth/*` routes, nothing revoked). It is an `optionalDependency`, so `npm ci` without a token skips it; with a token it is installed for type-checking and the upstream tests.
- Migration `20260916000001_vibe_auth.js` reads the vendored `src/desktop/vendor/vibe-auth-auth_identities.sql` instead of `require.resolve`, so desktop databases get the same sign-in tables as the appliance. `vibeAuthStub.test.ts` fails if `src/` starts using another runtime export of the package or the package's SQL changes.
- knex's unused SQL drivers are external.

Commands: `clientledger-tb-engine [serve]` (migrate, seed a new database, start), `migrate`, `version`.

Env from the launcher:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | embedded Postgres on 127.0.0.1 |
| `PORT` | loopback port to listen on |
| `JWT_SECRET`, `ENCRYPTION_KEY` | from the OS keychain |
| `CLTB_SESSION_TOKEN` | per-launch token; the UI sends it as `X-CLTB-Session` |
| `UPLOADS_DIR`, `BACKUPS_DIR` | app data folders |
| `KNOWLEDGE_DIR`, `FS_FONT_DIR` | `resources/knowledge`, `resources/fs-fonts` next to the engine |
| `SEED_DEMO_DATA` | default `true`: a new database gets the demo clients (Demo Company LLC, Summit Ridge Consulting LLC); `false` for a clean one |

The desktop entry forces `DESKTOP_MODE=true`, `BIND_HOST=127.0.0.1`, `NODE_ENV=production`, `TZ=UTC` (the engine assumes the appliance's UTC clock; DATE columns would otherwise shift a day east of UTC).

What desktop mode changes at run time:
- `X-CLTB-Session` gate (`src/desktop/session.ts`); a caller's own `Authorization` header is always dropped; `/api/v1/ping` and `/api/v1/health` stay open for the launcher.
- First start seeds a new database (no admin yet); every start replaces the seeded admin's published password with a random one, clears the forced password change and turns the two-factor requirement off.
- No MCP HTTP/SSE (stdio entry `src/mcp-stdio.ts` stays), no nightly backup cron, no QBO keepalive, no API rate limits.

OpenAPI: `src/desktop/openapi.ts` describes the routes the desktop app calls (OpenAPI 3.1, served at `/api/v1/openapi.json` in desktop mode). `npm run desktop:openapi` writes the committed `server/openapi.desktop.json`, which the desktop's Rust client is generated from. `npm run test:desktop` checks the document is valid, that responses recorded from a real desktop engine (`src/desktop/__tests__/fixtures/`, demo seed) match its schemas, and that the committed file is current. Add a route to the spec in the same change the desktop starts calling it.

Upstream files touched (one-line hooks): `src/app.ts` (session middleware, rate-limit `skip`, MCP mount, `BIND_HOST`, schedulers, desktop router), `src/routes/backup.ts` (`BACKUPS_DIR`), `src/lib/storage/index.ts` and `src/lib/documentStore.ts` (`UPLOADS_DIR`), `src/routes/support.ts` (`KNOWLEDGE_DIR`).

Verified 2026-11-08 on Windows 11 x64 against PostgreSQL 16.15: fresh database ready in about 6 s (87 migrations + seeds), `/health` ok, session-token TB read 200, no token 401, `/mcp/sse` 404, listening on 127.0.0.1 only, TB PDF renders, client backup written to `BACKUPS_DIR`, `/api/v1/openapi.json` served, PDF import parses a PDF (stops at "no AI key" as expected).

Known noise: express-rate-limit prints `ERR_ERL_KEY_GEN_IPV6` validation warnings at startup (upstream `rateLimitKey`); harmless, also on the appliance.

## Inventory at v0.1.56 (2026-11-08)

What blocks or complicates an SEA build. Paths are relative to `server/`.

### Native modules and external programs
- **bcrypt** (native prebuilds) — `src/routes/auth.ts`, `users.ts`, `settings.ts`, `passwordReset.ts`, `src/lib/stepUp.ts`, `src/lib/vibeAuthUsers.ts`, `src/mcp/auth.ts`, `seeds/001_default_admin.js`. Done: bundler alias to `bcryptjs`.
- **puppeteer-core** — Statement Writer PDFs only, lazy (`src/lib/fs/pdfBrowser.ts`); missing browser = 503, rest works. The probe list includes Edge, present on Windows 10/11.
- **pdftoppm** (poppler) — `src/lib/pdfVision.ts`, used by PDF, bank-statement and scanned-sheet vision import; missing binary is handled. Plan (P06): the desktop app rasterizes with pdfium (`cltb-pdf`) and sends page images; the engine needs an image-input variant.
- **pdf-parse 1.1.4** — dynamic `require(\`./pdf.js/${version}/build/pdf.js\`)`; bundler must alias it to the concrete path.
- **pdfmake / pdfkit** — vfs fonts are fine; pdfkit reads `__dirname/data/*.afm` only for standard fonts.

### Dynamic loading
- Done (Q12, see above). Was: `@kisaesdevlab/vibe-auth` is a hard static import (`src/lib/vibeAuth.ts`), started at boot (`src/app.ts`), from the private GitHub Packages registry. Migration `20260916000001_vibe_auth.js` does `require.resolve('@kisaesdevlab/vibe-auth/sql/auth_identities.sql')`.
- `knexfile.js` finds 87 migrations and 5 seeds by directory. Nothing in-process applies migrations (Docker's entrypoint runs `knex migrate:latest` + `seed:run`). Plan: static `migrationSource`/`seedSource` under `desktop/`, applied at desktop startup.
- knex resolves dialects with a dynamic require; bundle only `pg`, mark `pg-native` external.

### File paths
- Backups: `process.cwd()/backups`, `mkdirSync` at import (`src/routes/backup.ts`). Needs `BACKUPS_DIR`.
- Uploads: `src/lib/storage/index.ts`, `src/lib/documentStore.ts` (`__dirname`-relative). Needs `UPLOADS_DIR`.
- Fonts: `src/lib/fs/fsFonts.ts` (`FS_FONT_DIR` already supported; 38 TTFs, 17 MB).
- Knowledge base: `src/routes/support.ts` reads `knowledge/*.md`.
- `dotenv/config` reads `.env` from cwd; `/health` reads `npm_package_version`.

### Env and network
- `JWT_SECRET` (≥ 32 chars, exits at import), `ENCRYPTION_KEY` (required in production), `DATABASE_URL`, `PORT` (default 3001), `ALLOWED_ORIGIN` (required in production), `MIGRATIONS_AUTO`.
- `app.listen(PORT)` binds all interfaces; `trust proxy` = 1. Desktop: bind 127.0.0.1.

### Auth
- `authMiddleware` (`src/middleware/auth.ts`) verifies HS256 Bearer JWTs, re-reads the user (30 s cache), applies the 2FA / password-rotation gate. Bearer is also decoded in `app.ts` (reviewer write gate) and `src/lib/rateLimitKey.ts`.
- Plan: a desktop middleware mounted first checks `X-CLTB-Session` against `CLTB_LAUNCH_TOKEN` (constant-time) and sets `Authorization: Bearer <JWT for the implicit admin>`, so every existing check works unchanged. Desktop bootstrap clears `must_change_password` on the admin and keeps two-factor off (a startup step, never a migration).

### MCP
- HTTP/SSE at `/mcp/sse`, `/mcp/messages` (`src/routes/mcpHttp.ts`). Desktop: not mounted. stdio entry `src/mcp-stdio.ts` stays.

### Backup (`.tbak`)
- `src/routes/backup.ts`: ZIP with `manifest.json` (version `1.0`) + `tables/<name>.json`; full / settings / client / period; restore as new / replace / settings.
- **Gaps against the desktop promise:** the full archive does not include document files, and the SHA-256 is stored in `backup_history`, not in the archive. Tracked in the shell repo's QUESTIONS.md (Q10).
- No `pg_dump`. Nightly node-cron backup at 02:00 (desktop: the launcher schedules backups instead).
- Desktop additions (`src/desktop/`): `POST /api/v1/desktop/backup/full` writes a full backup of every table and document (Q21; restore is `clientledger-tb-engine restore-full <file>`). `POST /api/v1/desktop/restore/client-files` (`clientFiles.ts`, Q31): after a client `.tbak` is restored **as new** through `/restore/*`, writes its carried `files/` into the new client's own folder under new keys. It touches only rows of that client with no stored file. The appliance keeps upstream's behaviour: documents listed, files added again by hand. `POST /api/v1/desktop/backup/extract-client` (`extractClient.ts`, Q30): writes one client of a desktop full backup in `BACKUPS_DIR` as an ordinary client `.tbak` (the same tables and filters as `createBackup('client')`, documents re-keyed to `files/<documentId>`, the full backup's schema version), for the engine's own restore as new. The shell's `acceptance_p03` step 5 compares an extract with the engine's client backup row by row. A desktop full backup leaves out sign-in data (`SIGN_IN_TABLES` in `fullBackup.ts`: sessions, identities, second factors, reset tokens, SSO settings) and writes every `app_users.password_hash` as `'!'`, which can never sign in (Q32); a restore leaves those tables empty.

### OpenAPI
- None upstream. Desktop spec in `src/desktop/openapi.ts` (see above); grows per phase (shell repo Q11).

### Money on the wire
- Amounts are BIGINT cents as integers. The Rust client converts at the boundary to `Decimal`.
