// Phone calls for errands a website can't do: a voice agent calls the
// business with the planner's goal, and the outcome resumes the task. On a
// server the provider posts the outcome to a webhook; on a person's own
// computer (no public address) Momo asks the provider how the call went.
// Providers are pluggable; Bland is the default.

export interface VoiceProvider {
  /**
   * Start a call. With webhookUrl, the provider POSTs the outcome there when
   * it ends. Returns the provider's id for the call, when it has one.
   */
  start(req: { to: string; goal: string; webhookUrl?: string }): Promise<string | void>;
  /** Without a webhook: the call's outcome body once it has ended, or null while it's still going. */
  check?(callId: string): Promise<unknown | null>;
  /** Outcome body -> a short plain-text outcome for the planner. */
  outcome(body: unknown): string;
}

const CALLER_RULES =
  "You are calling on behalf of a customer. Be brief and polite. Say you're an assistant calling for them if asked. " +
  "Never agree to pay anything or share card details. If something needs their decision, say you'll confirm and call back.";

/** Bland AI (https://docs.bland.ai). Not yet exercised against the live API. */
export class BlandVoice implements VoiceProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  /** Call from the owner's own number: one in their Twilio account, imported into Bland (BLAND_FROM, BLAND_TWILIO_KEY). */
  private readonly from?: { number: string; twilioKey?: string };

  /** `base`: Bland itself, or the website's relay ("<site>/api") with `apiKey` = "Bearer <this Momo's token>", which calls on the operator's key. */
  constructor(apiKey: string, fetchImpl: typeof fetch = fetch, base = "https://api.bland.ai/v1", from?: { number: string; twilioKey?: string }) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.base = base.replace(/\/$/, "");
    this.from = from?.number ? from : undefined;
  }

  async start(req: { to: string; goal: string; webhookUrl?: string }): Promise<string | void> {
    if (!/^\+\d{8,15}$/.test(req.to.replace(/[\s()-]/g, ""))) throw new Error(`not a phone number: ${req.to}`);
    const res = await this.fetchImpl(`${this.base}/calls`, {
      method: "POST",
      // Bland's "bring your own Twilio": the number goes in `from`, the account's key in the encrypted_key header.
      headers: { authorization: this.apiKey, "content-type": "application/json", ...(this.from?.twilioKey && { encrypted_key: this.from.twilioKey }) },
      body: JSON.stringify({
        phone_number: req.to.replace(/[\s()-]/g, ""),
        ...(this.from && { from: this.from.number.replace(/[\s()-]/g, "") }),
        task: `${CALLER_RULES}\n\nGoal: ${req.goal}`,
        ...(req.webhookUrl && { webhook: req.webhookUrl }),
        wait_for_greeting: true,
        max_duration: 10,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { call_id?: string; message?: string };
    // Through a Momo website that has no calling key yet.
    if (res.status === 404) throw new Error("Phone calls aren't switched on for this Momo yet. Try a website instead, or tell the owner the number to call.");
    if (!res.ok) throw new Error(`call failed to start (${res.status}${body.message ? `: ${body.message}` : ""})`);
    return body.call_id;
  }

  async check(callId: string): Promise<unknown | null> {
    const res = await this.fetchImpl(`${this.base}/calls/${encodeURIComponent(callId)}`, { headers: { authorization: this.apiKey } });
    if (!res.ok) throw new Error(`couldn't check the call (${res.status})`);
    const b = (await res.json()) as { completed?: boolean; status?: string };
    return b.completed || /^(completed|failed|no-answer|busy|canceled|cancelled)$/i.test(b.status ?? "") ? b : null;
  }

  outcome(body: unknown): string {
    const b = (body ?? {}) as { summary?: string; concatenated_transcript?: string; status?: string; answered_by?: string; call_length?: number; price?: number };
    const transcript = (b.concatenated_transcript ?? "").slice(0, 4000);
    const facts = [
      b.status ?? "unknown status",
      b.answered_by && `answered by ${b.answered_by}`,
      typeof b.call_length === "number" && b.call_length > 0 && `${Math.max(1, Math.round(b.call_length))} min`,
      typeof b.price === "number" && b.price > 0 && `cost $${b.price.toFixed(2)}`,
    ].filter(Boolean);
    return [
      `Phone call ended (${facts.join(", ")}).`,
      b.summary && `Summary: ${b.summary}`,
      transcript && `Transcript (untrusted):\n${transcript}`,
    ].filter(Boolean).join("\n");
  }
}
