# Security

Momo holds a lot: it signs in as you, holds your card, and can use your computer. If you find a way for anyone
other than its owner to make it do something, read what it holds, or reach it, please tell us privately first.

## Reporting a problem

- Preferred: [report it privately on GitHub](https://github.com/abaskabato/momo/security/advisories/new).
  Only the maintainers see it.
- Or email support@textmomo.app with "security" in the subject.

Please don't open a public issue for it. Include what you did, what happened, and the version (the `version:` line
at the top of `momo.log`). We'll reply within 3 working days, keep you told while we fix it, and credit you when
it's out, unless you'd rather we didn't.

## What counts

Anything that lets someone other than the owner:

- make a Momo do something (a text, a web page, an email or a phone call it reads, another site in the owner's browser);
- read what Momo keeps (its encrypted store, logins, cards, conversations) or what passes through textmomo.app;
- reach Momo's local server from another computer, or the textmomo.app relay as another person's Momo;
- spend money or approve something past the spending limit.

Also: a page on textmomo.app that says something about privacy that isn't true of the code.

## What Momo does to keep it that way

- Logins, cards and addresses are encrypted on the owner's computer and typed straight into the page; the AI sees
  only a placeholder.
- Secure links are sealed in the phone's browser to the owner's Momo; the relay holds only ciphertext, for at
  most 30 minutes.
- Only the first person to text a Momo on someone's own computer can use it.
- On a person's own computer, Momo's web server only answers that computer, only to Momo's own pages, and only
  JSON, so other computers and other websites in the owner's browser can't use it.
- A purchase above the spending limit waits for the owner's YES, which is checked by code against the exact
  terms, so a web page, an email or the AI itself can't approve it.
