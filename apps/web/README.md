# Momo website (Vercel)

The setup page, and a relay that gives secure links a public address so they
open on a phone. Momo itself runs on each person's computer; see
[docs/SETUP.md](../../docs/SETUP.md).

- Deploy: import the repo in Vercel, set **Root Directory** to `apps/web`, and
  add **Upstash Redis** in the Storage tab. There is no build step and there
  are no dependencies.
- Local: `node apps/web/dev.js` (same routes and headers, relay in memory).
- `public/form-copy.js` is generated from the device code:
  `node packages/cloud/src/webassets.ts`. A test fails if it's stale.

| Path | What |
|---|---|
| `/` | Setup page. Keys are checked from the browser with the provider and written to a downloaded `momo.env`; they never reach this site |
| `/install.sh`, `/install.ps1` | One-line install as a background service (Mac/Linux, Windows) |
| `/s/:id` | A secure link. The answer is sealed in the browser to that person's Momo |
| `/api/devices` | A relay token for a new Momo |
| `/api/forms…` | Open a link (device), read and answer it (phone), collect the sealed answer (device) |
| `/ics` | Add-to-calendar file |
