# Momo vs Instinct: does it get things done?

Instinct is loved because you text it and the thing happens. That is the only
score. Momo is better than Instinct when it finishes more of what people ask,
faster, with less back-and-forth. It has not been measured on real sites yet,
so Momo is **not proven better yet**.

## How we measure it

`npm run eval` sends 20 real errands through the real assistant, model and
browser. The sites are OpenTable, Resy, Amazon, Target, Home Depot, CVS,
Walgreens, Zocdoc, Eventbrite, Recreation.gov, Kayak, Booking, Airbnb,
Ticketmaster, AMC, USPS and the DMV, plus two plain questions.

It never buys or books anything: it stops at "Reply YES", records the terms,
and answers NO. It reports the completion rate, the time per errand, and why
each failure happened. Run it once per model and keep the model that finishes
the most. Then fix the most common failure and run it again.

## What someone can text Momo today (Telegram / WhatsApp, nothing to install)

| Request | Gets done? |
|---|---|
| "remind me to call mom tomorrow at 6pm" | Yes (tested) |
| "book a table for 2 at Nopa tonight at 7" | Yes on a test site. Real sites: run the eval |
| "order me oat milk" (login, texted code, "verify you're human", address, payment) | Yes on a test store, end to end (tested) |
| A restaurant with no online booking | Momo phones them, then sends an add-to-calendar link (tested with a stand-in voice provider) |
| A repeat errand on a site used before | Goes straight through: still signed in, address and card saved (tested) |
| Questions ("what time does Costco close?") | Works with any model; with Claude it also searches the web |

## What was blocking errands, and what's built

| Blocker | Now |
|---|---|
| Sites email a code or a "confirm your email" link | Momo reads its own inbox (each person gets a Momo email address) and carries on, no question asked |
| Sites text a sign-in code | Momo asks "what's the code?" and types it in |
| CAPTCHAs / "are you human" | Momo sends a live view of the page. You tap through that one step on your phone, and Momo carries on |
| Paying | You add your card once by secure link. Momo fills it in at checkout after your YES |
| Delivery address | You add it once by secure link. Momo fills it in after that |
| No website / site broken | Momo tries another site, or phones the business with a voice agent |
| Calendar | Every booking comes with an add-to-calendar link |
| Asking the same things again | Momo remembers preferences (party size, usual order) |
| Long errands feel dead | Momo texts "Still on it" |
| One errand holds up everyone else | Many errands run at once |
| Sites block the headless browser | It presents itself as ordinary desktop Chrome |

## Still to do (in order)

1. **Run the eval on real sites** and fix what it finds. This needs an API
   key for any model (`MOMO_MODEL`).
2. **Live email:** point a domain at an inbound-email service
   (`MOMO_EMAIL_DOMAIN`) and test with real sites' emails.
3. **Live phone calls:** set `BLAND_API_KEY` and test real calls. The
   integration is written but has not been run against Bland's live API.
4. **Production:** a sandboxed browser per errand, KMS for keys, rate limits,
   monitoring. Live views and browser pages currently live in one process, so
   scaling out needs sticky routing per user.

Table stakes, not selling points (built and tested): confirm before paying or
booking, STOP / UNDO, secrets only via secure links (never in chat), each
user's data encrypted separately, each user's browser isolated.
