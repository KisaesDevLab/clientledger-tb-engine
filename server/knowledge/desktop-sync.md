# Desktop Sync

## Overview
ClientLedger Trial Balance, the Windows desktop app, can connect to Vibe Trial Balance. You pull a client's period to the
desktop, work on it offline (on a laptop at a client's office, say), and send it back. While a desktop has the period
checked out, nobody can change it in the web app, so nothing is overwritten.

## Connecting a desktop
1. In Vibe Trial Balance, open **Settings › Desktop sync** and click **Connect a desktop**.
2. A code like `K7QM-3XRP` appears. It works once, for 10 minutes.
3. In ClientLedger Trial Balance, open **Settings › Firm server**, enter the server's address and the code.

The desktop then acts as you: it can do what your account can. A reviewer's desktop can pull periods to read them but
not check them out or send them back. **Settings › Desktop sync** lists your connected desktops, when each was last
used, and lets you remove one. An admin can tick **Every user** to see and remove anyone's.

A desktop's connection also ends when your password is reset, when your account is deactivated, or after 90 days
without syncing. Connect it again with a new code.

## Pulling and checking out a period
On the desktop, choose the client and period and pull it. With **Check out** ticked (the default), the period is held
for that desktop:
- The web app shows a banner on the Trial Balance, Journal Entries and Bank Transactions pages: *Checked out to …*.
- Every change to that period is refused in the web app and over MCP, saying who has it.
- Changes to the client itself (the chart of accounts, lead sheets) stay open. A lead sheet's code and a tickmark's
  symbol can't be changed while any period of that client is checked out.

Without **Check out**, you get a read-only copy and the period stays open on the server.

## Sending a period back
Send it back from the desktop. The server checks that the period hasn't changed since you pulled it, applies your
work, and ends the check-out. If someone changed an account on the server since your pull, the server's version is
kept and the difference is listed. New accounts, lead sheets and tickmarks you added on the desktop are added.

A period or a whole client made on the desktop can be sent too: it arrives as new, unless its dates overlap a period
already on the server or the client is already there.

## Releasing a check-out (admins)
If a desktop is lost or its user has left, open **Periods**, find the period marked **Checked out**, click **Release**
and say why. The reason goes in the audit log. Work that desktop hadn't sent stays on it; it can be sent back only if
the period hasn't changed on the server since.

A check-out older than 14 days is marked **stale** on the Periods page and listed on admins' dashboards. Nothing is
released automatically.

## Common Questions
- **"This period is checked out to …"** — someone pulled it to a desktop. Ask them to send it back, or an admin can
  release it.
- **"The period changed on the server since it was pulled"** — pull it again on the desktop and redo the work there.
- **The desktop can't reach the server from outside the office** — your administrator sets up Tailscale or a
  Cloudflare tunnel (see the operator notes, `docs/desktop-sync.md`).
