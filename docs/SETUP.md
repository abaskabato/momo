# Set up Momo in 10 minutes

When you're done, you text a Telegram bot and Momo does the errand: on
websites, and if you want, in any app on a computer, like a person sitting at
the screen. It always asks before it buys, books, sends or deletes anything.

## What you need

- A computer or server with **Node.js 24+** and **Redis**, or **Docker**.
- An **AI model key**. Any provider works. The quickest free one is
  Google Gemini: <https://aistudio.google.com/apikey>. Turn on billing for
  real use, because the free tier allows about 20 requests a day.
- A **Telegram bot**: in Telegram, open @BotFather, send `/newbot`, and
  copy the token it gives you.

## 1. Get the code and run setup

```bash
git clone https://github.com/abaskabato/momo.git
cd momo
npm install
npm run setup
```

Setup asks a few questions, checks each answer (it test-calls your model
and looks up your bot), and writes `.env`. Run it again any time; it keeps
your existing keys.

It asks where Momo should work:

| Choice | What Momo can do | Who can use it |
|---|---|---|
| 1. Private web browser (default) | Anything on websites | Many people |
| 2. This computer's screen | Any app on this computer, via [agent-desktop](https://github.com/vercel-labs/agent-desktop) | Only you (the first person to text it) |
| 3. A cloud computer per person | Any app, in a fresh Linux desktop made for each errand | Many people |

For choice 2: `npm install -g agent-desktop`. On a Mac, also run
`agent-desktop permissions --guide` to allow accessibility.

For choice 3: `docker build -f Dockerfile.desktop -t momo-desktop .`

## 2. Start it

```bash
redis-server --daemonize yes   # if Redis isn't already running
npm start
```

or, with Docker:

```bash
docker compose up -d
docker compose logs -f momo
```

It prints your bot's link (`Telegram: text https://t.me/your_bot`). Open it
and say hi. Momo asks your name and city, and then you can just text it
errands:

- "book a table for 2 at Nopa Friday at 7"
- "order more oat milk"
- "remind me to call mom at 6"
- "open the spreadsheet on my desktop and total column B" (choices 2–3)

## 3. Optional: a public address

Without one, Telegram still works (Momo polls it). But the secure links
Momo sends for logins and cards only open on the same computer. To open
them on your phone, give the server a public https address:

```bash
cloudflared tunnel --url http://localhost:8787   # prints https://….trycloudflare.com
```

Put that URL in `PUBLIC_URL` (`npm run setup` again), then restart.
A public address also enables WhatsApp; see `.env.example`.

## More

- `.env.example` documents every setting: phone calls (`BLAND_API_KEY`),
  a Momo email inbox per person (`MOMO_EMAIL_DOMAIN`), more workers,
  WhatsApp.
- `npm run eval` measures how many real errands get done (it never buys or
  books; it stops at every "Reply YES").
- `npm test` runs the test suite (needs Redis; the cloud-computer test also
  needs the `momo-desktop` image).
