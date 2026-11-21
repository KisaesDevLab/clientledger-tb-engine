# Desktop sync — operator notes

ClientLedger Trial Balance (the Windows desktop app) can connect to this server, pull a client's period, work on it
offline, and send it back. This page is for whoever runs the server: how a desktop reaches it, what to allow through
a proxy or tunnel, and what the server enforces. The design is in `desktop-sync-addendum.md`.

## What the desktop calls

Everything is under `/api/v1/sync/*` and carries `Authorization: Bearer vtbsync_…`, a device token made when a user
pairs the desktop (Settings › Desktop sync › Connect a desktop, then a one-time code typed on the desktop). A device
token works on no other route, and a browser session does not work on these. A desktop acts as the user who paired
it; a reviewer's desktop can pull to read but not check out or send back.

| Call | Holds the connection for |
|---|---|
| `GET /sync/capabilities`, `/me`, `/clients`, `/clients/:uid/periods`, `/jobs/:id` | well under a second |
| `POST /sync/periods/:uid/pull`, `…/push`, `/clients/:uid/periods/push`, `/clients/push` | under a second: they start a job and return its id |
| `GET /sync/jobs/:id/archive` | the time to download the archive |
| `PUT /sync/uploads/:id/parts/:n` | the time to upload one part (at most `partBytes`, 50 MB by default) |
| `POST /sync/uploads/:id/complete` | a few seconds (it joins the parts and checks the SHA-256) |
| `DELETE /sync/uploads/:id` | well under a second (cancels an upload not sent yet) |

No call waits for work to finish: a pull or a send-back is a job the desktop polls. That keeps every request inside
Cloudflare's ~100-second response limit (a 524 otherwise), and every request body inside its 100 MB cap: a send-back
travels in parts of `partBytes` (reported by `GET /sync/capabilities`; set `SYNC_PART_BYTES` in bytes, 1–95 MB, to
change it).

## Ways to reach the server

The desktop requires **HTTPS**, except for `http://localhost` (a server on the same PC).

- **On the office network.** Use the server's HTTPS address as the browser does (the appliance's Caddy serves
  it). Nothing else to set.
- **Tailscale.** Install Tailscale on the server and on the laptop and use the server's tailnet name with HTTPS
  (`tailscale cert`, or the appliance's tailnet address). Nothing is exposed to the internet.
- **Cloudflare Tunnel.** The appliance's tunnel serves `/api/v1/sync/*` like every other route. Two things to set
  in Cloudflare:
  1. **Access.** If the hostname is behind Cloudflare Access, make an Access *service token* and give it to the
     desktop (in its Firm server settings). The desktop sends it as the
     `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on every call; add an Access policy with the action
     **Service Auth** that includes that token. A person still signs in to the browser app as before.
  2. **WAF and bots.** Challenges answer a desktop with a page it cannot solve. Add a custom rule with the action
     **Skip** (all remaining custom rules, rate limiting, managed rules, Super Bot Fight Mode) for
     `http.request.uri.path starts_with "/api/v1/sync/"`. The server checks the device token on each of these calls.
     **Bot Fight Mode (the free plan's) cannot be skipped by any rule**: it runs outside the rules engine
     ([Cloudflare: Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)). With it on, a
     desktop may be challenged; turn Bot Fight Mode off for the zone, or use Super Bot Fight Mode (Pro and up), which
     the Skip rule above covers.

## What the server enforces

- **Pairing:** a code works once, for 10 minutes; 10 failed tries per 15 minutes per address.
- **Rate limits:** each device has its own bucket (1200 calls per 15 minutes), so many desktops behind one office
  address do not share one; calls with an unknown token are limited per address (100 per 15 minutes).
- **A device stops working** when it is removed (Settings › Desktop sync), its user is deactivated, its user's
  password is reset or changed, or it has not synced for 90 days. A held period cannot be rolled forward.
- **Check-outs:** a period pulled with check-out is read-only in the web app and over MCP until it is sent back or
  an admin releases it on the Periods page (with a reason). Nothing is released automatically; one older than 14
  days (`settings` key `sync.checkout_warn_days`) is flagged on the Periods page and the admin dashboard.
- **Deletes that reach a held period** are refused too (409 `PERIOD_CHECKED_OUT`): deleting a bank transaction that a
  held period's reconciliation clears, a journal entry that a held period's bank line points at, or a period that a
  held period's variance notes compare with.
- **A pull that cannot start** (the computer already has 3 syncs running, or the disk is full) takes no check-out.
  A send-back under a check-out whose pull never finished is refused (`SYNC_NOT_PULLED`): pull again first.
- **Send-back:** accepted only when the archive is of this server's schema version, its checksums hold, the period
  is as it was at the pull (or held by that desktop), and the result matches what the desktop sent exactly.
- **Audit:** pairing, removals, check-outs, releases, send-backs, and every sync call that writes or hands out
  client data are in the audit log, naming the device.

## Files the server keeps

`backups/sync/<job>/` holds a pulled period's archive for a day; `backups/sync/uploads/<id>/` holds a send-back's
parts until it is used or a day has passed. Both are pruned every hour. An upload's row goes with its files unless
it was sent: a sent upload's row is kept 30 more days so the desktop can still ask which job it became. The backups of the instance do not include
the device and check-out tables.

## What a period archive sent back must carry

A send-back is a format 2 period `.tbak` whose `manifest.json` has a `sync` block:

| Field | Meaning |
|---|---|
| `periodUid`, `clientUid` | the `sync_uid` of the period and its client |
| `checkoutId` | the check-out it was pulled under, or `null` |
| `stampAtPull` | the period's stamp when it was pulled; required when `checkoutId` is `null` |
| `totals` | `{ "bookDebit": "…", "bookCredit": "…" }`: the period's adjusted book totals from `v_adjusted_trial_balance`, **in whole cents as text** (`"12000"` is 120.00). Required; the merge is rolled back unless the server's totals equal these afterwards |

An archive this server hands out on a pull carries the same block, so one sent back unchanged is accepted. The pull
job's result carries `totals` too.

DATE columns (period start and end, entry, transaction and statement dates) are written as plain `YYYY-MM-DD`.
An older archive that wrote them as ISO timestamps is still taken: the date part of the text is the date, which is
what Postgres stores from it, whatever time zone the server runs in.

## Uploads

Each computer may have three uploads open at once (not sent, not past their day); a fourth is `429 SYNC_BUSY`.
`DELETE /sync/uploads/:id` cancels one not sent yet. An upload that was sent answers `409 SYNC_UPLOAD_USED` on every
call, with `error.jobId` naming the job it became, for as long as its row is kept (checked before "expired"). Two pushes of one upload at once start one job: the
other is refused the same way. Whether
a join is running lives in the server's memory: after a server restart an upload reads `complete: false, joining:
false` with no error, and `POST /sync/uploads/:id/complete` starts the join again.

## Statement sets

Sets are matched by name. A set renamed on the desktop is still the same set when it has an issued version: the
version (number, finalized at the same moment, same numbers) names the set, which takes the new name. A set renamed
with no issued version cannot be told from a new one, and the send-back is refused naming the server's set: give it
its server name back (and rename it on the server), or archive it on the desktop instead of deleting it.

## Who signed

A sign-off sent back that the server already has (same lead sheet, role, signing time and balance stamp) keeps the
signer the server has; a note the server has (same text, written at the same moment) keeps its author, and its
resolver when resolved at the same moment. Any other sign-off is the sender's. A new client sent from a desktop has
every sign-off given to the sender (`signoffsReassigned` in the job result counts those that named someone else),
and arrives with no storage folder (`folder: null`): an admin links one on the Document Storage page (Client folders).
