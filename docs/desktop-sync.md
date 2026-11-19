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
  password is reset, or it has not synced for 90 days.
- **Check-outs:** a period pulled with check-out is read-only in the web app and over MCP until it is sent back or
  an admin releases it on the Periods page (with a reason). Nothing is released automatically; one older than 14
  days (`settings` key `sync.checkout_warn_days`) is flagged on the Periods page and the admin dashboard.
- **Send-back:** accepted only when the archive is of this server's schema version, its checksums hold, the period
  is as it was at the pull (or held by that desktop), and the result matches what the desktop sent exactly.
- **Audit:** pairing, removals, check-outs, releases, send-backs, and every sync call that writes or hands out
  client data are in the audit log, naming the device.

## Files the server keeps

`backups/sync/<job>/` holds a pulled period's archive for a day; `backups/sync/uploads/<id>/` holds a send-back's
parts until it is used or a day has passed. Both are pruned every hour. The backups of the instance do not include
the device and check-out tables.
