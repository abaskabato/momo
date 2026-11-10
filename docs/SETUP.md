# Set up Momo

When you're done, you text a Telegram bot and Momo does the errand: on
websites, and if you want, in any app on your computer, like a person sitting
at the screen. It always asks before it buys, books, sends or deletes anything.

Momo has two halves:

- **The website** (`apps/web`, on Vercel). People set Momo up there in their
  browser. It also gives secure links (for logins and cards) a public address,
  so they open on a phone. It never sees keys or passwords: the setup page
  checks keys directly with the provider, and secure links are sealed on the
  phone to the person's own Momo.
- **Momo itself**, running on each person's own computer (Mac, Linux or
  Windows) as a background service. It needs no Redis or Docker; it keeps its
  state in `~/.momo`.

## For people using Momo

1. Open your Momo website (for example `https://your-momo.vercel.app`).
2. Paste an AI key (the page links to where to get a free one), make a
   Telegram bot with @BotFather, and download your settings (`momo.env`).
3. Paste the one line the page shows into Terminal (Mac/Linux) or PowerShell
   (Windows):

   ```bash
   curl -fsSL https://your-momo.vercel.app/install.sh | sh      # Mac, Linux
   irm https://your-momo.vercel.app/install.ps1 | iex           # Windows
   ```

   It installs everything into `~/.momo` (including its own Node.js if you
   don't have Node 24+), starts Momo in the background, and sets it to start
   whenever you log in. Then it prints your bot's link.
4. Text your bot. Only you can use it: the first person to text it becomes its
   owner.

Leave the computer on, because Momo works while it's awake. Run the same line
again to update; your saved logins and settings are kept. Logs are in
`~/.momo/momo.log`.

## For whoever runs the website (once)

1. Import this repo in Vercel and set **Root Directory** to `apps/web`.
   There's no build step and no dependencies, and `apps/web/vercel.json`
   holds the routes and security headers.
2. In the project's **Storage** tab, add **Upstash Redis** (free tier is
   fine) and connect it. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
   The relay stores only sealed secure-link answers, each for 30 minutes.
3. Deploy. Open the site: that's the setup page.

Try it locally without Vercel: `npm run web` (http://localhost:3000).

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
("tap through this one step on your phone") and phone-call results come
straight to the server, so no relay is needed.

Where Momo works (`MOMO_DESKTOP` in `momo.env`):

| Setting | What Momo can do | Who can use it |
|---|---|---|
| unset (default) | Anything on websites, in its own private browser | You (or many people, on a server) |
| `local` | Any app on this computer, via [agent-desktop](https://github.com/vercel-labs/agent-desktop). On a Mac, run `~/.momo/tools/node_modules/.bin/agent-desktop permissions --guide` once to allow accessibility | Only you |
| `cloud` | Any app, in a fresh Linux desktop per errand (`docker build -f Dockerfile.desktop -t momo-desktop .`) | Many people |

## Good to know

- **Live view** (Momo shows you its browser so you can tap through a CAPTCHA)
  works everywhere: through the website when the computer has no public
  address, straight from the server when it has one.
- **Phone calls** (`BLAND_API_KEY`) and **inbound email**
  (`MOMO_EMAIL_DOMAIN`) need a server with a public address, because outside
  services have to call it back. On a personal computer, texted codes and
  secure links still work; Momo asks you for a code instead of reading it
  from an inbox.
- `.env.example` documents every setting.
- `npm run eval` measures how many real errands get done. It never buys or
  books: it stops at every "Reply YES". It needs a paid model key.
- `npm test` runs the test suite. Some tests use Redis, and the cloud-computer
  test needs the `momo-desktop` image.
