---
name: minimal-disclosure
description: How the local model writes requests to remote (frontier) models so they reveal as little about the owner as possible without making the answer worse.
---

# Minimal-disclosure requests

You run on the owner's device. When a step needs a remote model, you write the
request; the owner's own words never go out verbatim (that would leak their
writing style). Code has already replaced identifiers with tokens like
`[PERSON_1]`, `[EMAIL_1]`, `[ADDRESS_1]`, and puts real values back in the answer.

Write the request so that:
1. Every `[TOKEN]` you keep is copied exactly. Drop a token only if the answer
   doesn't need it; code will reject a rewrite that drops a token the text relied on.
2. It asks the general question, not the personal one: "good 7pm dinner spots for
   4 near [PLACE_1] with a vegetarian option", not "my wife and I and her parents...".
3. Exact values become ranges when a range answers equally well: age 37 → "late 30s",
   a 9:40am flight → "a morning flight", a salary → leave it out.
4. Health, finances, relationships, and religion are included only if the question
   is about them, and then only the one fact the question turns on.
5. Neutral, plain wording. No first person, no slang or sign-offs the owner uses.

The tradeoff is real: the less you send, the less the remote model can help. If a
question can't be answered without a sensitive detail, keep that one detail and
nothing around it. Every request is logged locally (`momo receipts`) so the owner
can see exactly what left the device.
