# UPSTREAM.md — clientledger-tb-engine

This repo is the desktop fork of the Vibe Trial Balance engine, bundled in ClientLedger Trial Balance.

- Upstream: https://github.com/KisaesDevLab/Vibe-Trial-Balance (remote `upstream`)
- Pinned upstream tag: **v0.1.56** (`d84af737`, 2026-10-15)
- License: PolyForm Small Business License 1.0.0, plus the additional permission in the ClientLedger Trial Balance repo (`docs/ENGINE-GRANT.md`).

## Fork rules

- Desktop changes live under `server/src/desktop/`, switched on by `DESKTOP_MODE=true`. Upstream files get the smallest possible hooks; no reformatting or restructuring.
- Hooks in upstream files: `server/src/lib/fs/fsReports.ts`, the accountant's report's default date is `localToday()` from `desktop/localDate.ts` (Q71; the same day as before when no PC zone is set, so the appliance is unchanged). Upstream issue KisaesDevLab/Vibe-Trial-Balance#26.
- Desktop never ships a database migration that upstream doesn't have (keeps `.tbak` compatible with the appliance).
- Every ClientLedger Trial Balance phase ends with a sync check: `git fetch upstream --tags`, list new commits and migrations, merge or record why not below.

## Sync log

| Date | Upstream tag / commit | Result |
|---|---|---|
| 2026-11-08 | v0.1.56 `d84af737` | Fork created from this tag. |
| 2026-11-10 | v0.1.56 `d84af737` | End-of-P03 check: upstream `main` unchanged, no new tags or migrations; nothing to merge. Only open upstream work is PR #13 (`.tbak` format 2, ours, Q17). |
| 2026-11-19 | v0.1.56 `d84af737` | End-of-P09 check: `git fetch upstream --tags`; upstream `main` has one new merge, `e1ff19a` (PR #13, `07573c6`): `.tbak` manifest format 2 (per-entry checksums, source, app and schema version, optional document files; `lib/backupManifest.ts`, `routes/backup.ts`, `package.json`). Additive (format 1 still restores; an older reader restores format 2), and the format the fork's desktop already reads and writes. Not merged in P09: to take in its own change with the P03 and P04 backup acceptance rerun (QUESTIONS Q77). No new tag; no migration. The fork's P09 changes: `server/src/desktop/` only (`openapiWp.ts`, `me.ts`, `currentUser.ts`, `session.ts`, fixtures). |
| 2026-11-19 | v0.1.56 `d84af737` | End-of-P08b check: `git fetch upstream --tags`; upstream `main` unchanged since v0.1.56, no new tags or migrations; nothing to merge. The fork's P08b changes: `server/src/desktop/` (OpenAPI for the Statement Writer and lead sheet auto-assign, `pdfProfileGuard.ts`, `localDate.ts` `localToday`), and one hook in `server/src/lib/fs/fsReports.ts` (Q71). Filed upstream: #25 (Q69 Excel sheet name), #26 (Q71 letter date), #27 (Q73 divider title). |
| 2026-11-14 | v0.1.56 `d84af737` | End-of-P07 check: upstream `main` unchanged, no new tags or migrations; nothing to merge. P07 (tax codes, exports) changed no route: `git diff v0.1.56 -- server/migrations server/seeds server/src/routes/exports.ts server/src/routes/taxCodes.ts server/src/routes/taxLineAssignment.ts server/src/routes/chartOfAccounts.ts server/src/lib/exportUnit.ts server/src/lib/reportFilename.ts server/src/lib/tbActivity.ts server/src/pdf` is empty, so a desktop export has the appliance's contents for the same data. Only `server/src/desktop/openapi.ts`, its fixtures and `openapi.desktop.json` changed. |
| 2026-11-15 | v0.1.56 `d84af737` | Bank: OpenAPI and recorded answers for `bank-transactions/batch-update-source` and `bank-transactions/manual` (the desktop's Assign bank account and Enter transactions). No route changed. Upstream `main` checked: still v0.1.56, nothing to merge. |
| 2026-11-15 | v0.1.56 `d84af737` | AI: OpenAPI for `settings/provider-models` and `openaiCompatApiKey` on the AI settings (the desktop's DigitalOcean choice). No route changed. The `provider-models` answer was seen from a real engine against a loopback stub (acceptance_p06) and written out by hand. |
| 2026-11-19 | v0.1.56 `d84af737` | End-of-P10 check: `git fetch upstream --tags`; upstream `main` unchanged since the P09 check (PR #13, `.tbak` format 2, still the only new merge; no tag, no migration). Format 2 is taken after P10 (owner, Q77). The fork's P10 changes: `server/src/desktop/` only (`openapiAi.ts`, `mcp.ts`, `knowledge/`, `main.ts`'s `mcp` command, `database.ts`'s `pendingMigrations`, tests and fixtures), `scripts/desktop/build.mjs` (the knowledge folder, Q82), `package.json`'s `test:desktop`, `docs/DESKTOP.md`. No upstream route changed. |
| 2026-11-19 | upstream `main` `e1ff19a` | Q77 (owner: format 2 now): merged upstream `main` (PR #13, `.tbak` format 2). The fork already carried the same change (`e17a22e`), so the merge brings no code; `git diff HEAD upstream/main -- server/src` is only the fork's `BACKUPS_DIR` hook in `routes/backup.ts`. Still to take: upstream's client restore fix (PR #28, server sync S0) once it is on upstream `main`, in a second merge. No migration. |
