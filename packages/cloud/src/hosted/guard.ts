// Momo's web server on a person's own computer answers only that computer (it listens on 127.0.0.1). This also
// keeps websites open in the owner's browser from using it, as Tiles does for its local daemon
// (github.com/tilesprivacy/tiles): a page elsewhere can still make the browser send requests to 127.0.0.1.
//   - Host must be this computer's address, so a name that resolves to 127.0.0.1 (DNS rebinding) is turned away.
//   - Anything that changes something must be JSON. A browser only sends JSON to another site after asking it
//     first (CORS), and Momo never says yes, so another site's form or script can't get through.
//   - If the browser says where a request came from (Origin), it must be Momo's own page.
import type { MiddlewareHandler } from "hono";

export function localOnly(port: number): MiddlewareHandler {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return async (c, next) => {
    if (!hosts.has((c.req.header("host") ?? "").toLowerCase())) return c.text("Not here.", 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin && !origins.has(origin.toLowerCase())) return c.json({ error: "not from Momo's own page" }, 403);
      if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "send JSON" }, 415);
    }
    await next();
  };
}
