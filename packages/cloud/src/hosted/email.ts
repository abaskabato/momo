// Inbound email, provider-agnostic. Point any inbound-email service at
// POST /v1/hosted/email/<INBOUND_EMAIL_SECRET>:
//   - Postmark inbound (JSON: To, From, Subject, TextBody, HtmlBody)
//   - SendGrid Inbound Parse (form: to, from, subject, text, html)
//   - Mailgun routes (form: recipient, sender/from, subject, body-plain, body-html)
//   - anything else posting JSON {to, from, subject, text, html}
//     (e.g. a Cloudflare Email Worker)

export interface InboundEmail {
  to: string[];
  from: string;
  subject: string;
  text: string;
  html?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseInboundEmail(body: Record<string, unknown>): InboundEmail | null {
  const toRaw = str(body.To) || str(body.to) || str(body.recipient) || (Array.isArray(body.to) ? (body.to as unknown[]).map(str).join(",") : "");
  const to = [...toRaw.matchAll(/[\w.+-]+@[\w.-]+\.\w+/g)].map((m) => m[0].toLowerCase());
  if (!to.length) return null;
  return {
    to,
    from: str(body.From) || str(body.from) || str(body.sender),
    subject: str(body.Subject) || str(body.subject),
    text: str(body.TextBody) || str(body.text) || str(body["body-plain"]),
    html: str(body.HtmlBody) || str(body.html) || str(body["body-html"]) || undefined,
  };
}
