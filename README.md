# Momo

Text it and it's done.

You text Momo on Telegram (or WhatsApp) in plain language: "book a table for 4
at Nopa Friday at 7", "order more oat milk", "remind me to call mom at 6". It
does the errand on websites, and, if you let it, in any app on your computer,
like a person at the screen (through
[agent-desktop](https://github.com/vercel-labs/agent-desktop)). Before it buys,
books, sends or deletes anything, it texts you the exact terms and waits for
your YES. `STOP` cancels everything. `UNDO` reverses the last thing it did.

## Quick start

People set Momo up on its website (`apps/web`, deployed on Vercel), then paste
one line that installs it on their own computer as a background service:

```bash
curl -fsSL https://your-momo.vercel.app/install.sh | sh   # Mac, Linux
irm https://your-momo.vercel.app/install.ps1 | iex        # Windows
```

Or by hand, for developers:

```bash
npm install
npm run setup   # model key + Telegram bot token, checked; writes .env
npm start       # prints your bot's link: text it
```

Full guide: [docs/SETUP.md](docs/SETUP.md). Every setting: [.env.example](.env.example).
A server shared by many people: `docker compose up -d` (adds Redis).

See [docs/INSTINCT-SCORECARD.md](docs/INSTINCT-SCORECARD.md) for what's built,
what's measured, and what isn't.

## How it fits together

```
 you ──text──▶ Telegram ◀──long-poll── Momo on your computer (~/.momo)
                                        Assistant → skills → private Chromium / agent-desktop
                                        state file · per-user encryption · approvals · timers
 your phone ──▶ Momo website (Vercel) ◀──── secure links and live views, sealed end to end
```

- **Momo** (`packages/cloud` + `packages/agent-core`) runs where the person
  is: their own computer, or one server for many people. It long-polls
  Telegram, so it needs no public address. State lives in one file
  (`~/.momo/store.json`) or in Redis on a server. Each user's documents are
  encrypted with a key derived from `MOMO_MASTER_KEY`.
- **The website** (`apps/web`) does setup in the browser (keys are checked
  with the provider directly and written into a downloaded `momo.env`), and
  relays what needs a public address: secure links for logins and cards
  (sealed in the phone's browser to that person's Momo; the relay holds only
  ciphertext for 30 minutes) and live views (screenshots one way, taps the
  other, so the person can finish a CAPTCHA). Plain JavaScript, no build,
  Upstash Redis for storage.
- **Web agent**: a planner tool loop over a private headless Chromium: read the
  page as text plus numbered elements, click, type, select, scroll, sign in
  from the vault, enter texted codes, read emailed codes from the person's
  Momo inbox, fill card and address, hand a step to the person, phone a
  business, add to calendar, ask, request approval, finish.
- **Computer use**: with `MOMO_DESKTOP=local` Momo drives apps on the owner's
  screen through agent-desktop's accessibility tree; with `cloud` it gets a
  fresh Linux desktop container per errand. Sending, deleting and other
  irreversible actions still need a YES.
- **Confirm-before-commit**: approvals are bound to a hash of the exact
  arguments plus the amount, are single-use, and expire in 15 minutes. They
  are parsed by code, so a model, a web page or an email can't approve.
- **Secrets**: never in chat. Logins, cards and addresses arrive by secure
  link, are stored encrypted, and are typed straight into the page; the model
  sees handles only.
- **Models**: any. `MOMO_MODEL=provider/model`: `anthropic/…`, `openai/…`,
  `gemini/…`, `openrouter/<vendor>/<model>`, `groq/…`, `together/…`,
  `deepseek/…`, `mistral/…`, `xai/…`, `fireworks/…`, local `ollama/…` or
  `lmstudio/…`, or `custom/…` for any OpenAI-compatible server
  (`MOMO_MODEL_BASE_URL`, `MOMO_MODEL_API_KEY`). `MOMO_ANSWER_MODEL` can pick
  a cheaper model for plain questions. Rate limits and overloads are retried.

## On a server, for many people

```bash
MOMO_MASTER_KEY=$(head -c32 /dev/urandom | base64) \
PUBLIC_URL=https://your-domain REDIS_URL=redis://... \
MOMO_MODEL=anthropic/claude-opus-5-5 ANTHROPIC_API_KEY=... \
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 16) \
npm start
```

With a public https address the server registers the Telegram webhook itself,
serves secure links and live views directly (no relay), and can take WhatsApp
(`/v1/hosted/whatsapp`), phone-call results and inbound email:

- `BLAND_API_KEY`: Momo phones businesses that can't be booked online.
- `MOMO_EMAIL_DOMAIN` + `INBOUND_EMAIL_SECRET`: every user gets a Momo email
  address. Point the domain's MX at any inbound-email service (Postmark,
  SendGrid Inbound Parse, Mailgun, a Cloudflare Email Worker) posting to
  `/v1/hosted/email/<INBOUND_EMAIL_SECRET>`. Emailed codes and "confirm your
  email" links are then handled without asking the person.
- `MOMO_WORKERS` (default 8): how many errands run at once.
- `MOMO_DESKTOP=cloud` + `docker build -f Dockerfile.desktop -t momo-desktop .`:
  a desktop per errand.

## Measure it

```bash
MOMO_MODEL=anthropic/claude-opus-5-5 ANTHROPIC_API_KEY=... npm run eval
```

Runs the 20 real errands in `docs/evals/errands.json` on live sites and writes
a completion report to `docs/evals/results/`. It stops at every "Reply YES"
and answers NO, so nothing is bought or booked. It needs a paid model key: a
free-tier key runs out after the first errand.

## Develop

Node 24+ (native TypeScript, no build step). Redis only for the server tests.

```bash
npm install
npm run typecheck
npm test                      # 52 tests: unit, relay, real browser, end-to-end errands
npm run web                   # the website at http://localhost:3000, relay in memory
npm run web:assets            # regenerate apps/web/public/form-copy.js after changing the forms
node packages/agent-core/src/cli.ts demo   # chat with it against a local booking site
```

## Layout

```
apps/web                  Website on Vercel: setup page, installers, secure-link and live-view relay
packages/protocol         Sealed boxes (X25519 + AES-GCM), browser sealing code, shared types
packages/agent-core       Assistant, skills (web agent, reminders), browser, computer use, vault, eval
packages/cloud            Momo server: Telegram/WhatsApp, job queue (file or Redis), secure pages, setup wizard
packages/openclaw-plugin  Optional adapter for running the agent inside OpenClaw
desktop/, Dockerfile*     Docker images: the server, and a Linux desktop for cloud computer use
docs/                     SETUP.md, INSTINCT-SCORECARD.md, evals
```
