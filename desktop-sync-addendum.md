# Desktop Sync Addendum — Vibe Trial Balance

**Status:** proposed 2026-11-18; owner decisions recorded the same day (marked **Decided**). S0 built on `feat/sync-s0-groundwork` (PR #28); PR #13 (manifest format 2) merged 2026-11-19. S1 built on `feat/sync-s1-identity` (draft PR #29), stacked on S0. S2 built on `feat/sync-s2-devices` (draft PR #31), stacked on S1 (device tokens end after 90 days unused and on a password reset, **Decided** 2026-11-19); the appliance manifest needs no change (`publicPaths` is used only with `edgeGate`, which Vibe TB has off). S3 built on `feat/sync-s3-pull` (draft PR #32), stacked on S2; S4 built on `feat/sync-s4-push` (draft PR #33), stacked on S3; S5 built on `feat/sync-s5-hardening` (operator notes `docs/desktop-sync.md`, help page `server/knowledge/desktop-sync.md`; `sync-e2e` runs every call through a proxy that cuts bodies and slow responses), stacked on S4; step 4's check found about thirty period writes the lock never gated (they now refuse a checked-out period; the lock gaps themselves are listed for the owner, not changed). Companion plan: `SYNC-ADDENDUM.md` in `KisaesDevLab/ClientLedger-Trial-Balance`.
**Goal:** a paired ClientLedger Trial Balance desktop can list this server's clients and periods, pull one client and period, send that period back, and send new clients and new periods here. Works on the LAN, over Tailscale and through a Cloudflare tunnel.

This file is the build plan. Follow the repo's Workflow Rules and License Compliance sections in `CLAUDE.md` (file headers, dependency licences, tests after each change).

## What exists today (checked against `server/src` at v0.1.56)

| Need | Today | Gap |
|---|---|---|
| List clients and periods | `GET /api/v1/clients`, `GET /api/v1/clients/:clientId/periods` | JWT only; no credential a desktop can hold |
| Export one period | `createBackup('period')` in `routes/backup.ts` | Admin only. Leaves out `tickmark_library`, which the period's `tb_tickmarks` point at |
| New client from a file | restore mode `as_new` | Admin only; renames on a name clash; no stable identity |
| Send a period back | nothing. `replace` runs `deleteClientData` and would remove the client's other periods | New mode needed |
| Stable identity | every key is `increments('id')`, re-keyed on restore | No id survives a round trip |
| One editor at a time | `periods.locked_at` + `assertPeriodUnlocked` (`lib/periodGuard.ts`) | That lock means "closed"; unlock is admin only. A separate check-out is needed |
| Restore fidelity | issue #18: restore drops `tickmark_library` and `tb_tickmarks` | Must be fixed first |
| Manifest | `version: '1.0'` only | PR #13 (format 2: checksums, source, schema version) is open |

## Decisions this plan builds on

- **SQ1 Identity.** `sync_uid uuid` on `clients`, `periods`, `chart_of_accounts` and `bank_transactions`. Lead sheets match by code, tax codes by form + activity + code (the existing resolver), tickmark library by symbol, lead sheet attachments by `ref_code` within the period. **Decided** (owner 2026-11-19).
- **SQ2 Check-out. Decided:** on by default; the desktop user may untick it at pull. A checked-out period is read-only in the web app and over MCP until it is sent back or released by its holder or an admin. **No automatic release.** A check-out older than 14 days is flagged to admins. A checked-out period cannot be rolled forward (**Decided** 2026-11-19). Device tokens have no fixed maximum lifetime; a user changing their own password also ends their desktops, without blocking a new pairing from that session (**Decided** 2026-11-19).
- **SQ3 Chart changes on send-back.** New accounts are added. A change to an existing account is applied only when the server's row has not changed since the pull; otherwise the server's value stays and the difference is listed in the result. Accounts are never deleted by a send-back. **Decided.** The same rule applies to a client's Statement Writer layouts (`fs_client_layouts`) that the period's sets use (**Decided** 2026-11-19). While any period of a client is checked out, a lead sheet's code and a tickmark's symbol cannot be changed, on the server or the desktop, so matching by them stays exact (**Decided** 2026-11-19).
- **SQ4 Scope of a period.** Trial balance, journal entries and lines, the period's bank transactions, variance notes, tickmarks, M-1 adjustments, engagement tasks, lead sheet notes and sign-offs, PY comparison data, Statement Writer sets, **lead sheet attachments with their files, and bank reconciliations with their items** (**Decided**). **Not in the first release:** other client documents and the QuickBooks connection. Their server rows are left untouched by a send-back.
- **SQ5 Who may sync. Decided:** a device acts as the user who paired it. Staff and admin may pull and send; a reviewer may pull only. No admin requirement.
- **SQ7 Prior year. Decided:** a pull carries the period's own prior-year balances only. The prior period is not pulled. **Decided 2026-11-19:** the rows of the pulled period that name another period's rows come along with those rows as references, without their data: a variance note's comparison period, and a reconciliation item's transaction from an earlier period (and that transaction's period). The manifest's `periodId` tells the archive's own period from a reference; S4's merge links a reference by `sync_uid` and never replaces it. Where a reference period is not already on the receiving side it arrives marked `is_reference` (**Decided** 2026-11-19): hidden from period lists and prior-period lookups, read-only; S4 fills it in and clears the flag when the real period arrives. The period stamp covers the notes and items.
- **SQ6 Licence.** Syncing by a firm's own staff is not client-facing access. Confirm `COMMERCIAL_LICENSE.md` and the desktop's `docs/ENGINE-GRANT.md` say so.

## Phases

Each phase ends with tests passing and a summary. Phases S1–S3 change upstream only; the desktop fork picks them up at its next upstream sync.

### S0 — Groundwork

1. Fix issue #18: both restore paths re-insert `tickmark_library` and `tb_tickmarks`, library ids and account and period ids remapped.
2. Merge PR #13 (manifest format 2). Sync refuses an archive without `formatVersion` and `schemaVersion`.
3. Add `tickmark_library` to the period-level dump.
4. Round-trip test (scratch Postgres, as `test:fs-e2e`): export client → restore as new → every client-scoped table equal apart from ids, adjusted totals equal. Same for a period archive.

**Acceptance:** the round-trip test passes for the demo client with tickmarks, AJEs, variance notes and a Statement Writer set.

### S1 — Identity and the period stamp

1. Migration: `sync_uid uuid not null default gen_random_uuid()` with a unique index on `clients`, `periods`, `chart_of_accounts`, `bank_transactions`. JS migration, backfills by default.
2. Restore keeps an archive's `sync_uid` when no row here holds it; `as_new` on an instance that already has it mints a new one (a copy is a different client). Tested both ways.
3. `lib/sync/periodStamp.ts` (pure, tested): SHA-256 over the period's SQ4 rows in a fixed order, account ids replaced by `sync_uid`, each attachment by its `ref_code` and file SHA-256. Same idea as `leadSheetBalanceStamp` and `fsSourceStamp`. No write path changes.

**Acceptance:** the stamp is equal before and after a backup and restore of the same period, and changes when any SQ4 row changes (one test per table).

### S2 — Devices and pairing

1. Table `sync_devices`: `id`, `user_id` FK, `name`, `token_hash` (SHA-256 of a 32-byte random token), `created_at`, `last_used_at`, `revoked_at`. Table `sync_pairing_codes`: hashed one-time code, `user_id`, `expires_at` (10 minutes), `used_at`.
2. Web: Settings → **Desktop sync** (every user; admins also see all devices): "Connect a desktop" shows a one-time code; list of devices with last used and Revoke. The code is created from a signed-in session, so it works under `oidc_only` and with 2FA.
3. `POST /api/v1/sync/pair` `{ code, deviceName }` → `{ token, user, server }`. Public, rate limited, constant-time compare, one use.
4. `syncAuthMiddleware`: `Authorization: Bearer vtbsync_…` accepted **only** on `/api/v1/sync/*`; loads the user, refuses a deactivated user or revoked device, applies `blockReviewerWrites`. **Check first** how the `/api/v1` gate at `app.ts:222` and `vibeAuthMiddleware()` order against a new router, and whether `.appliance/manifest.json` needs `/api/v1/sync/*` as a public path (it is vendored: edit in Vibe-Appliance, copy here).
5. Every sync call writes `audit_log` with the device name.

**Acceptance:** a paired token lists clients; a revoked token gets 401; the token is refused on any non-sync route; pairing works in the SSO e2e test with `oidc_only` on.

### S3 — Read and pull

1. `GET /sync/capabilities` → `{ formatVersions, schemaVersion, appVersion, maxUploadBytes, features: ['checkout-v1','period-merge-v1'] }`.
2. `GET /sync/clients` (paged, search) → `sync_uid`, name, `client_code`, entity type, active. `GET /sync/clients/:uid/periods` → `sync_uid`, name, dates, `locked_at`, check-out (who, device, since), stamp.
3. Table `period_checkouts`: `period_id` (one live row per period, partial unique index), `device_id`, `user_id`, `stamp_at_pull`, `created_at`, `released_at`, `released_by`, `release_reason`.
4. `assertPeriodUnlocked` also refuses a checked-out period (`409 PERIOD_CHECKED_OUT`, naming the user and device) unless the caller is the sync merge. **Check first** that every write route and every MCP tool that changes period data goes through the guard; add it where one does not, with a test that walks the route list.
5. Client-level edits (chart, lead sheets) stay open while a period is out; SQ3 covers them.
6. `POST /sync/periods/:uid/pull` `{ checkout }` → `{ jobId }`. `GET /sync/jobs/:id` → state, result or error. `GET /sync/jobs/:id/archive` streams the period `.tbak`. The archive's manifest carries the stamp and the check-out id.
7. `DELETE /sync/checkouts/:id` (the holder), and an admin Release on the Periods page with a reason. The web TB, JE and bank pages show a banner on a checked-out period.
8. Stale check-outs (SQ2): the Periods page shows how long each has been out; a check-out older than 14 days (setting `sync.checkout_warn_days`) appears as a warning on the admin dashboard and in `GET /sync/clients/:uid/periods`. Nothing is released automatically.

**Acceptance:** pull with check-out makes the period read-only in the web app and over MCP; release restores it; a second pull by another device is refused with the holder named.

### S4 — Send back, new period, new client

1. Uploads in parts, because attachment files can pass Cloudflare's 100 MB body cap: `POST /sync/uploads` `{ size, sha256 }` → `{ uploadId, partBytes }`; `PUT /sync/uploads/:id/parts/:n` (each part at most `partBytes`, default 50 MB, resumable); `POST /sync/uploads/:id/complete` checks the SHA-256. Bound to the device, expires in a day. Mounted so nginx's long `/import/` timeout does not matter: every later call returns at once with a job.
2. `lib/sync/mergePeriod.ts`, one transaction, advisory lock per client (as `restoreReplace`):
   - Refuse unless manifest `schemaVersion` equals this database's, and the archive's client `sync_uid` equals the target's.
   - Chart: match by `sync_uid`, then by account number. Insert new accounts. Apply SQ3 to changed ones (`updated_at` against the check-out time). Build the account id map.
   - Lead sheets by code, tax codes through the existing resolver, tickmark library by symbol; add what is missing.
   - Delete the period's SQ4 rows, insert the archive's with ids remapped. `audit_log` is never touched.
   - Lead sheet attachments (files under the archive's `files/`, manifest format 2): match by `ref_code`. New ones are written through the current storage driver into the client's workpaper folder (storage write before the DB row, as everywhere); a file whose SHA-256 changed (a stamp was burned in on the desktop) replaces the object; tombstones are kept so no ref code is reissued. A client with no folder link is refused before anything is written (`CLIENT_NOT_LINKED`), with the fix named.
   - Bank reconciliations and their items: replaced with the period. An item's bank transaction is matched by `sync_uid`. **Check first** whether an item can point at a transaction outside the period (an outstanding item from an earlier one); if so the pull carries those transactions for reference and the merge only links to them, never replaces them.
   - Recompute totals from `v_adjusted_trial_balance`; refuse (roll back) unless they equal the totals in the manifest.
3. `POST /sync/periods/:uid/push` `{ uploadId, checkoutId }` → job. Requires the live check-out held by this device; refuses a period with `locked_at` set. On success releases the check-out. Result: totals before and after, counts per table, accounts added, SQ3 differences.
4. Without a check-out (SQ2 off, or released by an admin): accepted only when the period's stamp still equals the archive's `stamp_at_pull`; otherwise `409 PERIOD_CHANGED`.
5. `POST /sync/clients/:uid/periods/push` `{ uploadId }` → job: a period whose `sync_uid` is not here; refuses overlapping dates; same merge.
6. `POST /sync/clients/push` `{ uploadId }` → job: `as_new` keeping the archive's `sync_uid`s; `409 CLIENT_EXISTS` when the client `sync_uid` is already here. No "(Restored)" suffix on this path; a name clash is allowed, as in the web app.
7. Jobs run in-process, one at a time per client, state in a `sync_jobs` table so a restart reports `failed` instead of losing the job.

**Acceptance (real server, scratch Postgres):** pull → change a balance, add an AJE, add an account, add a tickmark, attach a PDF to a lead sheet and stamp it, finish a reconciliation → send back: the period matches, other periods are byte-equal to before, totals tie, the check-out is released. A send-back after an admin release and a server edit is refused. A new client and a new period arrive with their `sync_uid`s. A wrong-schema archive is refused with a plain message.

**S4 implementation notes (2026-11-19, from the S3 review):**
- `lib/sync/mergePeriod.ts` is written from the period stamp's table specs (`periodStamp.ts` SPECS: which column points at which kind of row), not by seeding `restoreAsNew` (which inserts the chart, lead sheets, tickmarks and layouts a merge must match, and skips rows a merge must refuse). Leaf helpers only (zip read, batched insert, tax-code resolver).
- Rows other rows point at are updated in place, never deleted and re-made: bank transactions by `sync_uid` (a later period's reconciliation item may clear one; its FK cascades), journal entries relinked by type + number for `client_documents.linked_journal_entry_id` and other periods' bank rows, Statement Writer versions kept by report + `version_no` (`fs_report_version_files` holds issued PDFs that are in no archive). A test reads the inbound foreign keys from `pg_constraint` and fails on an unclassified one.
- `client_id` and `period_id` come from the server, never the archive. User columns keep ids this server has and blank the rest. `fs_reports.current_version_id` is set after the versions are matched.
- Layouts get `sync_uid` (SQ3 applies to them, owner 2026-11-19). The period stamp leaves out the client layout a set uses (a layout edit while a period is out must not move its stamp); a finalized version's frozen layout stays in. A lead sheet's code and a tickmark's symbol cannot change while a period of the client is held (owner 2026-11-19).
- Attachment files: a new or changed file is stored as a NEW document before the transaction; the transaction points the attachment at it; the old document is deleted after commit, the new ones on rollback.
- The archive is untrusted: read only the SQ4 and lookup tables; `manifest.sync` must name the live check-out held by this device and both uids; a row whose period is neither the manifest's nor a reference refuses the send-back.
- Acceptance inside the transaction: the server period's stamp after the merge equals the stamp computed from the archive's own tables (`periodStamp` is pure), every other period's stamp is unchanged, and totals tie; otherwise roll back.

**What a send-back archive must be (for the desktop, D-phases):** the server's own period `.tbak` format (manifest format 2, every entry's checksum, `schemaVersion` equal to the server's); whole rows as the server writes them (every column; DATE columns as `YYYY-MM-DD` or the ISO text of a local-midnight date); `manifest.sync` with `periodUid`, `clientUid`, `checkoutId` (or `stampAtPull` when sent without a check-out) and `totals { bookDebit, bookCredit }` (the adjusted trial balance as `v_adjusted_trial_balance` sums it: trial balance rows plus book and transfer entries on accounts that have a row); a journal line only on an account with a trial balance row in the archive. User columns: a row the desktop made carries the server id of the user who paired it (`GET /sync/me` → `user.id`); the server keeps ids it has and blanks the rest, so a desktop's own user numbers must never be sent. While a period is out, a lead sheet's code and a tickmark's symbol do not change on the desktop either.

**Review rules (2026-11-19, code and security review of S2-S5):**
- *Who did what.* A user id in a send-back stays only when it is the sender's or already appears in that column of the period on the server; anything else is blanked with its name. A sign-off that is not exactly one the server has becomes the sender's, with the balance stamp the server computes. Statements finalized on the desktop are refused: send the period back, then finalize on the server. A client sent from a desktop keeps no storage pointer, folder link, user or QuickBooks row, every user id in it is the sender's or none, and its sign-offs must be the sender's.
- *SQ3 by the server's own record.* A pull records, inside its snapshot, each account's and layout's `updated_at` and the lead sheet codes and tickmark symbols; a send-back is compared with that record, never with times in the archive. A client-level row the pull handed out that the server no longer has was deleted there and is not added back (a period that uses it is refused).
- *Never deleted, only marked.* An attachment the server has must be in the archive (tombstoned if removed); so must a statement set (archived if removed); the desktop keeps `fs_reports.front_matter_json` as pulled.
- *Limits.* 3 jobs and 3 open uploads per device; 25 periods held per device; a removed device's holds are released; archive entries are read through caps (manifest 8 MB, tables as a restore, attachments 50 MB each and 1 GB together) and an attachment file must be a PDF; a bank row already on the server (same import hash) is refused with `SYNC_DUPLICATE_IMPORT`; a constraint refusal is `SYNC_ARCHIVE_CONFLICT`, not "try again".

### S5 — Proxy and tunnel hardening

1. No sync request holds a connection for more than a few seconds apart from upload and download; everything else is job + poll. (Cloudflare returns 524 near 100 s.)
2. Every upload part stays below Cloudflare's 100 MB body cap; `partBytes` is sent in `capabilities`.
3. Sync routes get their own rate-limit bucket keyed by device.
4. `docs/desktop-sync.md`: LAN, Tailscale and Cloudflare tunnel setups; the Cloudflare Access service-token headers the desktop can send; the WAF skip rule for `/api/v1/sync/*`; HTTPS is required except for `localhost`.
5. Knowledge base page `server/knowledge/desktop-sync.md`.

**Acceptance:** the S4 test passes through a proxy that cuts responses at 100 s and bodies at 100 MB.

### S6 — Later, only if asked

Other client document files; pulling the prior period read-only; a dividing-date check-out; the hosted edition (tenant in the token).

## Out of scope

Two-way record merge. The server never calls the desktop. No change to the existing admin backup and restore screens beyond S0.

## Effort (autonomous agent; owner review separate)

| Phase | Agent time | Owner review |
|---|---|---|
| S0 | 2–3 days | half a day |
| S1 | 2 days | half a day |
| S2 | 3–4 days | 1 day (security) |
| S3 | 4–5 days | 1 day |
| S4 | 9–12 days | 2–3 days (merge rules, tie-out, attachments) |
| S5 | 2 days | half a day |

## Compatibility check against the desktop (2026-11-19, read of both trees, nothing run)

Compared: this branch at `60c1cb90` with ClientLedger-Trial-Balance `feat/p12-sync` (`bdf90f3` plus uncommitted work) and its engine `feat/p12-sync-engine` (`94a3a7a`, upstream merged at `7248f42`).

Agree: the migration list (schema version), `FORMAT_VERSION` 2, `lib/sync/*` including `periodStamp` and `mergePeriod` (byte-equal in the fork), every route path, method and request body the desktop's `cltb-sync` sends, and the answers it reads (pair, me, capabilities, clients, periods, pull, jobs, uploads, push, release).

To fix (all done 2026-11-21 on `feat/sync-s5-hardening`, below):

1. **`sync.totals` is required here and nobody writes it.** Done: the pull writes `totals` in its manifest and its job result; a pulled archive sent back unchanged is accepted (`sync-e2e`).
2. **Totals are integer cents as text** (`"12000"`). Done: `docs/desktop-sync.md`. The desktop's own comment (`"100.00"`) is its side to correct.
3. The fork is behind this branch. Merge at the next sync, with the changes below.

## The desktop's requests of 2026-11-21 (ClientLedger TB `docs/upstream-requests-2026-11-21.md`)

| Request | Done here |
|---|---|
| Q98 a push answer lost | A used upload answers `409 SYNC_UPLOAD_USED` with `error.jobId` on `GET`/`DELETE /sync/uploads/:id` and on a second push. A push claims its upload (the job's id is written) before the job starts, so two pushes of one upload at once start one job; the other is refused with that job's id. |
| Q101 uploads left open | `DELETE /sync/uploads/:id` cancels an unsent upload; "used" is checked before "expired"; a sent upload's row is kept 30 days past its day (its files still go at the day). A join's state stays in memory: after a restart, `POST …/complete` again (documented). |
| Q102 (1) pull totals | As item 1 above. |
| Q102 (2) a new client with sign-offs | Every sign-off is given to the sender (was refused); the job result counts them as `signoffsReassigned`. |
| Q102 (3) sign-offs re-attributed | A sent-back sign-off matches the server's by lead sheet, role, signing time and balance stamp, without the signer, and keeps the server's signer (and its unsigner when unsigned at the same moment). Only rows the server has can match, so nobody signs for another. Notes likewise: same text and creation time keep the server's author and resolver. |
| Q104 dates and time zones | Archives write DATE columns as `YYYY-MM-DD`. The period stamp reads an older archive's ISO text by its date part, which is what Postgres stores from it, so a UTC desktop's archive is taken by a server in any zone (`sync-e2e` passes under America/Chicago, UTC and Asia/Tokyo). |
| Q106 (1) `add_variance_note` | PR #36 merged into this branch: a note with no comparison period is kept against the period itself. |
| Q106 (2) "Admin > Settings" | The provider-not-configured errors no longer name a menu. |
| Q109 (1) the new client's folder | The result says `folder: null`: linking a storage folder stays an explicit admin step on this server, never made on its own. |
| Q109 (2) totals in the pull result | As item 1 above. |
| Q108 | Desktop side (`portableClient.ts`); nothing here. Q110 and compat item 3 (a re-pull's baseline) are desktop side. |

**For the fork's next sync:** `lib/sync/mergePeriod.ts`, `lib/sync/newClient.ts`, `lib/sync/periodStamp.ts` and `lib/sync/uploads.ts` changed, so the byte-equal check against the fork will differ until it merges; `routes/backup.ts` (plain dates) and `routes/sync.ts` changed too. No migration was added, so the schema version is unchanged. The desktop's `export-period` should write DATE columns as `YYYY-MM-DD` as well (the engine's `createBackup` does once merged). The desktop's Rust side reads only `clients` and `chart_of_accounts` from an archive, so plain dates break nothing there; its `appliance_compare` test diffs whole tables, and after the merge a desktop archive's dates (`2025-12-31`) will differ in form from a v0.1.56 appliance's (`2025-12-31T06:00:00.000Z`): compare DATE columns by their date part.

## Code review of the branch (2026-11-21), fixed

A pull that cannot start (job cap, full disk) no longer leaves its check-out behind, and a send-back under a check-out with no `stamp_at_pull` is refused (`SYNC_NOT_PULLED`). Deletes that cascade into a held period (a transaction its reconciliation clears, an entry its bank line names, a period its variance notes compare with) are refused (`periodsReachedByDelete` / `assertDeleteSparesHeldPeriods` in `lib/periodGuard.ts`). A part upload whose connection drops ends and removes its partial file (`stream.pipeline`). The hourly prune keeps a sent upload's archive while its job is queued or running. Removing a device, and ending an idle one, revoke + release + audit in one transaction. The desktop's period list reads every hold in one query and stamps four periods at a time. A statement set renamed on the desktop is matched through an issued version. All in `sync-e2e` ("Code review:" steps).

