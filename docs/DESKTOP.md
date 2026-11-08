# DESKTOP.md — desktop mode for ClientLedger Trial Balance

Desktop mode (`DESKTOP_MODE=true`) runs this engine as a Node Single Executable Application (SEA) for one user on one machine, against an embedded PostgreSQL 16 on 127.0.0.1, started by the ClientLedger Trial Balance launcher. Desktop code lives in `server/src/desktop/`; upstream files get one-line hooks only.

## Inventory at v0.1.56 (2026-11-08)

What blocks or complicates an SEA build. Paths are relative to `server/`.

### Native modules and external programs
- **bcrypt** (native prebuilds) — `src/routes/auth.ts`, `users.ts`, `settings.ts`, `passwordReset.ts`, `src/lib/stepUp.ts`, `src/lib/vibeAuthUsers.ts`, `src/mcp/auth.ts`, `seeds/001_default_admin.js`. Plan: `bcryptjs` (same API, same hash format).
- **puppeteer-core** — Statement Writer PDFs only, lazy (`src/lib/fs/pdfBrowser.ts`); missing browser = 503, rest works. The probe list includes Edge, present on Windows 10/11.
- **pdftoppm** (poppler) — `src/lib/pdfVision.ts`, used by PDF, bank-statement and scanned-sheet vision import; missing binary is handled. Plan (P06): the desktop app rasterizes with pdfium (`cltb-pdf`) and sends page images; the engine needs an image-input variant.
- **pdf-parse 1.1.4** — dynamic `require(\`./pdf.js/${version}/build/pdf.js\`)`; bundler must alias it to the concrete path.
- **pdfmake / pdfkit** — vfs fonts are fine; pdfkit reads `__dirname/data/*.afm` only for standard fonts.

### Dynamic loading
- `@kisaesdevlab/vibe-auth` is a hard static import (`src/lib/vibeAuth.ts`), started at boot (`src/app.ts`), from the private GitHub Packages registry. Migration `20260916000001_vibe_auth.js` does `require.resolve('@kisaesdevlab/vibe-auth/sql/auth_identities.sql')`.
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

### OpenAPI
- None exists. Tracked in the shell repo's QUESTIONS.md (Q11).

### Money on the wire
- Amounts are BIGINT cents as integers. The Rust client converts at the boundary to `Decimal`.
