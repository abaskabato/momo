# Set up Momo

When you're done, you text Momo on Telegram and it does the errand: on
websites, and if you want, in any app on your computer, like a person sitting
at the screen. It always asks before it buys, books, sends or deletes anything.

Momo has two halves:

- **The website** (`apps/web`, on Vercel). People get Momo there. It also does
  the few things that need a public address: it gives secure links and live
  views a place to open on a phone (holding only ciphertext and pictures), and,
  if the site's operator has set them up, it provides one shared Telegram bot
  and one shared AI key so people don't need their own.
- **Momo itself**, running on each person's own computer (Mac, Linux or
  Windows) as a background service. It needs no Redis or Docker; it keeps its
  state in `~/.momo`.

## For people getting Momo

With a site whose operator pre-filled the AI and the bot, it's three steps:

1. Open the Momo website and click **Download Momo**.
2. Open the file it saved (`Install Momo.zip` on a Mac, which unpacks to `Install Momo.command`; `Install Momo.cmd`
   on Windows, `install-momo.sh` on Linux). It installs everything into
   `~/.momo`, including its own Node.js if needed, starts Momo, and sets it to
   start whenever you log in. A Mac may say the file can't be opened: right-click
   it and choose Open. Windows may say it protected your PC: More info, Run anyway.
3. Tap the Telegram link the page shows and say hi.

Without a pre-filled site, the page also asks for an AI key (it links to where
to get one) and a Telegram bot token from @BotFather, checks both in your
browser, and puts them in the same downloaded file. Nothing you type reaches
the site.

Leave the computer on: Momo works while it's awake. Open the installer again
to update; your saved logins and settings are kept. Logs are in
`~/.momo/momo.log`.

## For whoever runs the website (once)

1. Import this repo in Vercel. Either leave Root Directory at the repo root
   or set it to `apps/web`; both deploy the site. There's no build step and
   no dependencies.
2. In the project's **Storage** tab, add **Upstash Redis** and connect it
   (`vercel integration add upstash/upstash-kv`). The relay keeps sealed
   answers, pictures and queued messages there, each for minutes to a day.
3. Optional but what makes it simple for people: environment variables for
   the shared parts.
   - `MOMO_MODEL=provider/model` plus that provider's key (`GEMINI_API_KEY`,
     `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Devices then call the model
     through the site; the key never leaves the server. Use a paid key: a free
     tier runs out after one errand.
   - `TELEGRAM_BOT_TOKEN` for one shared bot (make it once with @BotFather).
     The site points its webhook at itself and routes each chat to the Momo
     that paired with it. Set `MOMO_PUBLIC_URL` to the site's https address.
4. Deploy. The site's home page is the download page.

Costs: every device polls the site for messages (every 1.5 s during a
conversation, every 6 s when idle), and each poll is one Upstash command.
Upstash's free tier covers one or two devices; after that it's about
$0.20 per 100,000 commands. Model usage is billed to the shared key.
Anyone who can reach the site can create a device, so the relay rate-limits
model calls per device and device creation per IP.

Try the site locally without Vercel: `npm run web` (http://localhost:3000).
Set the same environment variables to try the shared bot and model.

## Other ways to run Momo

**By hand on your computer** (developers):

```bash
git clone https://github.com/abaskabato/momo.git && cd momo
npm install
npm run setup   # asks for a model key and bot token, checks them, writes .env
npm start       # prints your bot's link
```

**On a server for many people:** set `REDIS_URL` and a `PUBLIC_URL` (https),
or use `docker compose up -d`. With a public address, secure links, live views
and phone-call results come straight to the server, so no relay is needed.

Where Momo works (`MOMO_DESKTOP` in `momo.env`):

| Setting | What Momo can do | Who can use it |
|---|---|---|
| unset (default) | Anything on websites, in its own private browser | You (or many people, on a server) |
| `local` | Any app on this computer, via [agent-desktop](https://github.com/vercel-labs/agent-desktop). The installer walks through the Mac accessibility permission | Only you |
| `local` + `MOMO_ACCESS=full` | Everything on this computer: apps, plus reading files and running commands directly. It looks freely; every change (the exact command, or the file it would replace) is texted to you and waits for your YES. It can't read its own keys in `~/.momo` | Only you |
| `cloud` | Any app, in a fresh Linux desktop per errand (`docker build -f Dockerfile.desktop -t momo-desktop .`) | Many people |

## Good to know

- **Live view** (Momo shows you its browser so you can tap through a CAPTCHA)
  works everywhere: through the website when the computer has no public
  address, straight from the server when it has one.
- **Phone calls** (`BLAND_API_KEY`, optional on the setup page): for places
  with no online booking, a voice agent phones them with your request, only
  after your YES, and Momo texts you how it went. Works on a personal
  computer (Momo asks the provider how the call went) and on a server (the
  provider calls back). Billed by Bland per minute.
- **Inbound email** (`MOMO_EMAIL_DOMAIN`) needs a server with a public
  address. On a personal computer Momo asks you for emailed codes instead.
- `.env.example` documents every setting.
- `npm run eval` measures how many real errands get done. It never buys or
  books: it stops at every "Reply YES". It needs a paid model key.
- `npm test` runs the test suite. Some tests use Redis, and the cloud-computer
  test needs the `momo-desktop` image.
