# UPSTREAM.md — clientledger-tb-engine

This repo is the desktop fork of the Vibe Trial Balance engine, bundled in ClientLedger Trial Balance.

- Upstream: https://github.com/KisaesDevLab/Vibe-Trial-Balance (remote `upstream`)
- Pinned upstream tag: **v0.1.56** (`d84af737`, 2026-10-15)
- License: PolyForm Small Business License 1.0.0, plus the additional permission in the ClientLedger Trial Balance repo (`docs/ENGINE-GRANT.md`).

## Fork rules

- Desktop changes live under `server/src/desktop/`, switched on by `DESKTOP_MODE=true`. Upstream files get the smallest possible hooks; no reformatting or restructuring.
- Desktop never ships a database migration that upstream doesn't have (keeps `.tbak` compatible with the appliance).
- Every ClientLedger Trial Balance phase ends with a sync check: `git fetch upstream --tags`, list new commits and migrations, merge or record why not below.

## Sync log

| Date | Upstream tag / commit | Result |
|---|---|---|
| 2026-11-08 | v0.1.56 `d84af737` | Fork created from this tag. |
| 2026-11-10 | v0.1.56 `d84af737` | End-of-P03 check: upstream `main` unchanged, no new tags or migrations; nothing to merge. Only open upstream work is PR #13 (`.tbak` format 2, ours, Q17). |
