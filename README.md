# Momo

Text it and it's done. Your logins never leave your device.

You text Momo on Telegram or WhatsApp in plain language: "book a table for 4 at
Nopa Friday at 7", "remind me to call mom tomorrow at 6". Nothing to install.
It drives a real browser to get it done. Logins come in through a secure link,
encrypted on your phone, so they never pass through chat. Power users can link
their own Mac so everything runs there instead. Before anything
irreversible it texts you the exact terms and waits for `YES <code>`. `STOP`
cancels everything. `UNDO` reverses the last thing it did.

See [docs/INSTINCT-SCORECARD.md](docs/INSTINCT-SCORECARD.md) for what's built, what's
better than Instinct, and what isn't there yet.

## How it fits together

```
 you ──text──▶ iMessage on your Mac ─────────────────────────────┐
 you ──text──▶ Telegram ──▶ thin cloud (seal to device key,       │
                            Redis queue, wake device) ◀─/checkin──┤ your computer
                                                                  ▼
                       OpenClaw + Momo plugin: Assistant → skills → browser
                       local vault · approvals · tasks · timers · memory
```

- **Thin cloud** (`packages/cloud`): Hono + Redis. Stores only sealed envelopes
  (X25519 + AES-GCM to the device's key) and routing metadata. Devices
  authenticate with Ed25519-signed requests, so the cloud holds no secrets.
  `/checkin` long-polls; delivery is leased and redelivered until acked.
- **Wake-on-demand**: a held long-poll is notified instantly. Otherwise the cloud
  sends a content-free push to the device's wake URL, or, with no wake path,
  queues the work and batches it into the next check-in. Deferred jobs wake the
  device at their due time. The check-in interval tightens toward the next due
  item, so cloud load tracks work, not idle users.
- **Local agent** (`packages/agent-core`): the Assistant routes each owner
  message: control words, then approval replies, then answers to a pending
  question, then a new task. Skills (`Skill` interface) own one kind of errand
  end to end.
- **Confirm-before-commit**: approvals are bound to a hash of the exact
  arguments plus the amount, are single-use, and expire in 15 min. They are
  parsed by code, so a model, a web page, or an email can't approve.
- **Vault**: AES-256-GCM, with the key in the macOS Keychain or libsecret.
  Models see handles and hints only. Values are typed straight into the page,
  and only on the origin the login is bound to.
- **Computer use**: Playwright in a private headless Chromium by default, or
  your real browser launched through
  [agent-desktop](https://github.com/vercel-labs/agent-desktop) with a CDP
  hand-off. Native apps are driven through agent-desktop's accessibility refs.
- **Models**: any model. Set `MOMO_MODEL=provider/model`: `anthropic/claude-opus-5-5`
  (default), `openai/…`, `gemini/…`, `openrouter/<vendor>/<model>`, `groq/…`,
  `together/…`, `deepseek/…`, `mistral/…`, `xai/…`, `fireworks/…`, local
  `ollama/…` or `lmstudio/…`, or `custom/…` for any OpenAI-compatible server
  (`MOMO_MODEL_BASE_URL`, `MOMO_MODEL_API_KEY`). `MOMO_ANSWER_MODEL` can pick a
  cheaper model for plain questions. On a device, every frontier call goes through the
  privacy layer: identifiers become per-request placeholders, the local model
  can rewrite the query in neutral wording, the answer is rehydrated on the
  device, and a local receipt records what was sent. Payment and network
  layers are pluggable (anonymous credits, Tor/relays) and off by default.
- **OpenClaw** (`packages/openclaw-plugin`): Momo is an OpenClaw plugin. Its
  `before_dispatch` hook settles control words and approvals before the model
  runs. Outbound replies use the gateway's `send`. Task notes land in
  OpenClaw's memory folder.

## Hosted mode (the default product)

```bash
MOMO_MASTER_KEY=$(head -c32 /dev/urandom | base64) \
PUBLIC_URL=https://your-domain REDIS_URL=redis://... \
MOMO_MODEL=anthropic/claude-opus-5-5 ANTHROPIC_API_KEY=... \
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 16) \
WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_ACCESS_TOKEN=... WHATSAPP_APP_SECRET=... WHATSAPP_VERIFY_TOKEN=... \
npm run cloud
```

The server registers the Telegram webhook on startup. For WhatsApp, point the
Cloud API webhook at `/v1/hosted/whatsapp`. Each user's data is encrypted with
a key derived from `MOMO_MASTER_KEY` (use a KMS in production).

Optional: `BLAND_API_KEY` lets Momo phone businesses that can't be booked
online; `MOMO_WORKERS` (default 8) sets how many errands run at once.

What keeps errands moving: sign-in codes are asked for and typed in; CAPTCHAs
go to the person as a live view (`/l/…`) for that one step; card and address
are added once by secure link and filled at checkout after a YES; failing
sites fall back to another site or a phone call; bookings come with an
add-to-calendar link (`/ics`).

## Measure it

```bash
MOMO_MODEL=anthropic/claude-opus-5-5 ANTHROPIC_API_KEY=... npm run eval
```

Runs the real errands in `docs/evals/errands.json` on live sites and writes a
completion report to `docs/evals/results/`. It stops at every "Reply YES" and
answers NO, so nothing is bought or booked.

## Run it

Requires Node 24+ and Redis.

```bash
npm install
npm test                         # protocol + cloud + agent unit tests + end-to-end slice
node packages/agent-core/src/cli.ts demo   # chat with it against a local booking site
```

The end-to-end test and the demo need a Chromium for Playwright:
`npx playwright-core install --only-shell chromium`.

Real setup:

```bash
REDIS_URL=redis://... TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run cloud
momo pair https://your-cloud --push https://ntfy.sh/<random-topic>
momo owner +14155550123 <telegram-chat-id>
momo vault add-login https://site-you-book-on.com
momo run                         # or install packages/openclaw-plugin into OpenClaw
```

OpenClaw: `openclaw plugins install --link ./packages/openclaw-plugin`, then set
`plugins.entries.momo.config.ownerHandles` (and `cloudUrl`/`deviceId` if you use
the cloud) in `~/.openclaw/openclaw.json`.

## Layout

```
packages/protocol         wire types, sealed boxes, request signing, device client
packages/cloud            hosted runtime (Telegram/WhatsApp, per-user encryption, jobs, secure links),
                          plus the device relay (Redis queue, /checkin, wake)
packages/agent-core       Assistant, skills, vault, approvals, tasks, timers, privacy, CLI
packages/openclaw-plugin  OpenClaw adapter (hooks, tools, check-in service, skill)
skills/                   SKILL.md files for the local model
docs/                     scorecard
```
