# ClientLedger Trial Balance (the desktop edition)

**Read this first: it overrides the rest of the knowledge base wherever they differ.**

The person asking is using **ClientLedger Trial Balance**, the desktop edition of Vibe Trial Balance for one practitioner on their own computer. It is not the web app, and the rest of this knowledge base was written for the web app: its menu paths (such as "Setup > Clients" or "Admin > Settings") and its sign-in, user and admin pages do not exist here. Answer for the desktop edition, using the screens below. When the user asks about something listed under "Not in the desktop edition", say plainly that this edition does not have it.

## How it differs from the web app

- **One person, one computer.** There is no sign-in, no password, no user accounts, roles, reviewers or admins, and no two-factor or single sign-on. Anyone using the computer can do everything.
- **Everything stays on this computer.** The database and documents are on the computer itself. The app works offline. The only things that leave the computer are what the user sends to an AI service they set up, and backups they save to a folder such as OneDrive.
- **The name on sign-offs** (lead sheet sign-offs, notes, completed checklist tasks) is set in **Settings › Your name**; the app asks for it the first time it is needed.

## Where things are

The left side of the window lists: **Clients**; then, for the open client and period, **Trial balance, Adjusting entries, Bank transactions, Tax codes, Statements, Statement Writer, Lead sheets, Documents, Checklist, Workpapers, AI review**; and at the bottom **Ask the assistant, Backup & restore, Settings**. The client and period being worked on are chosen with the switcher at the top of the window, or by opening a client on the Clients screen.

The menus are File, Edit, View, Client, Entries, Reports, Tools and Help.

- **New client, New period:** File and Client menus, or the Clients screen.
- **Chart of accounts templates:** Tools › Chart of accounts templates…. The program's templates (one per industry: account numbers, names and categories, no tax codes) and the firm's own. Every template's accounts can be added, changed and removed, the program's too (their names and descriptions stay the program's). A firm template can be made empty, saved from a client's chart (with its tax codes), copied from any template, renamed, deleted, exported to Excel and imported from Excel or CSV with a preview. **Apply to a client…** shows first which accounts would be added and which the client already has (same number); nothing is replaced. New client has **Start from a template**. Tax codes come along when the client's return has a code with the same number.
- **Trial balance:** balances are typed in the grid; **Import…** reads a CSV or Excel file (a PDF trial balance is read by the AI when one is set up). View options switch Book, Tax or both, the prior year, and a debit and a credit column.
- **Adjusting entries:** Entries › New adjusting entry (Ctrl+J). An entry cannot be saved until debits equal credits.
- **Bank transactions:** Import bank file (OFX, QFX, QBO, QIF, CSV, or a PDF statement read by the AI), Enter transactions… for checks and deposits by hand, Ask AI for accounts, and the Reconcile tab.
- **Tax codes:** Assign (with Suggest tax codes), Export to UltraTax CS, CCH Axcess, Lacerte, GoSystem Tax RS or a generic file, the Tax code list, and M-1 adjustments.
- **Statements and reports:** Statements in the left list, and the Reports menu. Each opens as a PDF preview that can be saved or printed.
- **Lead sheets:** sign-off, notes, tickmarks and attachments per lead sheet.
- **Workpapers:** the workpaper package and the workpaper index.
- **AI review:** the AI looks the open period over and lists what it notices. It only advises.

## Backups

**File › Back up now** (Ctrl+B), or the **Backup & restore** screen. The app also backs up when it closes and once a day while open, keeps the newest 14 by default, and can keep a second copy in a folder the user chooses (OneDrive, Dropbox, iCloud Drive, a USB drive), optionally protected with a passphrase. A lost passphrase means a lost backup. **Restore from a backup** saves a safety backup of the current work first, then restores everything or one client as a new copy. A client backup can also be restored into the firm's Vibe Trial Balance web app.

## AI

Set up in **Settings › AI**: the user's own Anthropic (Claude) key, Ollama, another AI server on the computer, or DigitalOcean. Ollama or a server on the computer keeps everything on the computer. Before client figures are sent to an internet AI service, the app asks once while it is open. The AI suggests; the user decides.

## Claude Desktop

**Settings › Claude Desktop › Connect Claude Desktop**, then quit Claude Desktop completely and open it again. While this app is open, Claude in Claude Desktop can do the work here when asked, through the same steps the screens use (a locked period stays locked): set up a client, its period, its chart of accounts and balances from a report given to it; post a bank statement's transactions to Bank transactions with their accounts, leaving out ones already there; post, change and delete entries; assign tax codes and export to tax software; work on lead sheets, notes, tickmarks, attachments and sign-offs; build, change and issue statements in the Statement Writer; work the checklist and documents; and save any report or the workpaper package as a file. It cannot delete a client or a period, or change Settings. What Claude reads goes to Anthropic as part of the conversation.

### Other AI apps

Any other app that runs MCP servers on this computer (Visual Studio Code, Cursor, Windsurf, Claude Code and others) can do the same work, with the same limits. **Settings › Other AI apps (MCP)** shows the program and arguments to add as a server in that app, and **Copy settings** copies a block to paste into its MCP settings file. It connects only while this app is open. What that app reads goes to the AI it uses. Changes it makes show in the audit trail under its name. AI on a website (ChatGPT or Claude in a browser) cannot reach this app.

## Not in the desktop edition

User management, roles and permissions; signing in, passwords, passkeys, two-factor and single sign-on; the QuickBooks Online connection; the audit log page; the AI usage log page; the public app URL and email settings; the custom report builder; the PY tie-out page; sharing with other users at the same time. The desktop does not connect to the firm's server.
