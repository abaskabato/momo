# Changelog

What changed in Momo, newest first. Momo updates itself from `main` when its installer runs again.

## 2026-11-19

- Questions about something that changes (hours today, a price, stock, the weather, a delivery or a flight) are
  looked up on the web, never answered from the AI's memory. Before, "what time does Costco close today?" was
  answered with a guess.
- Momo notices when an errand goes round in circles (five searches in a row without opening a result, or a site
  that keeps refusing the browser) and changes course; in hybrid mode the frontier model takes over.
- `MOMO_MODEL=ollama/auto` picks a Gemma 4 size that fits the computer, and Momo downloads a missing local model
  itself, with progress in the log.
- On a person's own computer, Momo's web server only answers that computer and only Momo's own pages.
- Optional: stay awake with the laptop lid closed (`MOMO_LID=awake`; Windows while plugged in, and Linux).
- `SECURITY.md`: how to report a security problem privately.

## 2026-11-18

- Open source under the AGPL-3.0.
- The site's shared AI and calls are free for a week, then $15 a month through Stripe; your own AI key is free.
- Privacy and terms pages.
- Fewer tokens and faster steps: Claude caches the instructions and the errand so far; every browser action
  returns the page it led to; a light loop for small models; Ollama through its own API; hybrid mode.
- The free Gemini default is Flash-Lite (Flash's free tier allows 20 requests a day, about one errand).

## 2026-11-16

- Text and done: Momo does the errand and reports, instead of asking YES or NO. The one exception is a purchase
  over the spending limit ($200 unless changed).
- iMessage, through a shared line or a Mac of your own; phone calls without a calling account of your own.
- Onboarding sets everything up once: contact details, connections, card and address.
- The home page at textmomo.app.

## 2026-11-15

- Momo starts out signed in, with your Chrome or Edge sign-ins, in a real browser window on your computer.
- It keeps the computer awake, with a nightly rest on Windows.
- It asks for a password plainly and signs in when you text it back.
