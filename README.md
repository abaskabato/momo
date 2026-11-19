<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/banner-dark.svg">
    <img src="docs/brand/banner.svg" alt="Momo: text it and it's done" width="640">
  </picture>
</p>

<p align="center">
  <a href="https://www.textmomo.app"><b>textmomo.app</b></a> ·
  <a href="docs/SETUP.md">Run it yourself</a> ·
  <a href="https://www.textmomo.app/privacy.html">Privacy</a> ·
  <a href="CHANGELOG.md">What's new</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-f0431c"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-1f7a3d">
  <img alt="Runs on Mac, Windows and Linux" src="https://img.shields.io/badge/runs%20on-Mac%20%C2%B7%20Windows%20%C2%B7%20Linux-141412">
</p>

# Momo

**A personal assistant you text, that does the errand instead of telling you how.**
It runs on your own computer, so what it knows about you stays there.

| You text | Momo |
|---|---|
| book a table for 4 at Nopa Friday at 7 | Books it on the restaurant's site, then texts you the confirmation. |
| order more oat milk | Orders it, and tells you what it cost and when it arrives. |
| what time does the Costco on 10th close today? | Looks it up live. It never answers from memory. |
| call the dentist and get me on the cancellation list | Phones them. If they ask something only you know, it texts you and passes your answer on. |
| remind me to call mom at 6 | Texts you at 6. |

You text it on Telegram or iMessage in plain language. It does the errand on
websites, on the phone, and, if you let it, in any app on your computer, then
texts you exactly what it did. It doesn't ask "are you sure?": the one thing it
checks with you first is a purchase over your spending limit ($200 unless you
change it). `STOP` cancels everything. `UNDO` reverses the last thing it did.

## Private by design

- **It lives on your computer.** Your conversations, what it remembers about
  you, and its browser stay in one folder on your computer (`~/.momo`), with
  what it knows about you encrypted. Delete the folder and it's gone; there's
  no copy of it anywhere else.
- **Secrets never go through chat.** Logins, cards and addresses arrive by a
  secure link that your phone's browser locks to your Momo. They're typed
  straight into the website that needs them, and the AI only ever sees a
  placeholder.
- **You choose the AI.** Use your own key from any provider, the hosted AI, or
  a local model through Ollama, in which case nothing leaves your computer for
  the AI at all.
- **No ads, no tracking, open source.** Every claim here can be checked in
  this repository. The [privacy policy](https://www.textmomo.app/privacy.html)
  lists every company your data passes through, and why.

## Use it, or run it yourself

- **[textmomo.app](https://www.textmomo.app)**: set up in a few minutes, no
  terminal. The hosted service supplies what's fiddly to set up yourself (the
  AI, a shared bot and iMessage number, phone calls, secure links). The first
  week is free, then it's $15 a month.
- **Run it yourself, free**: everything here is open source under the AGPL.
  Bring your own AI key (or a local model) and your own Telegram bot.

## Quick start

People set Momo up on its website ([textmomo.app](https://textmomo.app), from
`apps/web`), which downloads one file that installs it on their own computer
as a background service. Or, with your own deployment of the site:

```bash
curl -fsSL https://your-momo.example/install.sh | sh   # Mac, Linux
irm https://your-momo.example/install.ps1 | iex        # Windows
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
  fresh Linux desktop container per errand. By default it acts and reports what
  it did; `MOMO_ASK=money` makes sending, buying and deleting wait for a YES.
- **Approvals** (a purchase over the spending limit, or anything `MOMO_ASK`
  asks about): approvals are bound to a hash of the exact
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
  Small and local models get a lighter loop; with `MOMO_FRONTIER_MODEL` set, a
  local model does each step and the frontier model takes the ones beyond it
  (see [docs/SETUP.md](docs/SETUP.md#running-on-a-local-model-ollama)).

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

- `BLAND_API_KEY`: Momo phones businesses that can't be booked online
  (`BLAND_FROM` + `BLAND_TWILIO_KEY` to call from your own number).
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
npm test                      # unit, relay, real browser and end-to-end errand tests
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
docs/                     SETUP.md, INSTINCT-SCORECARD.md, evals, brand (the logo)
```

## Security and changes

Found a way around Momo's protections? Please report it privately: see [SECURITY.md](SECURITY.md).
What changed lately: [CHANGELOG.md](CHANGELOG.md).

## License

Momo is free software under the [GNU Affero General Public License v3.0](LICENSE):
use it, change it and share it. If you run a modified Momo as a service for
other people, you must offer them your changes' source code too.
