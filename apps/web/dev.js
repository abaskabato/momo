// Run Momo's website locally, without Vercel: node apps/web/dev.js [port]
// Same routes as vercel.json; the relay keeps its data in memory.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay, memoryStore } from "./lib/relay.js";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
// The same response headers (CSP etc.) Vercel adds, read from vercel.json.
const RULES = JSON.parse(await readFile(new URL("./vercel.json", import.meta.url), "utf8")).headers.map((h) => ({
  re: new RegExp(`^${h.source}$`),
  headers: Object.fromEntries(h.headers.map((x) => [x.key, x.value])),
}));
const vercelHeaders = (path) => Object.assign({}, ...RULES.filter((r) => r.re.test(path)).map((r) => r.headers));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".sh": "text/plain; charset=utf-8", ".ps1": "text/plain; charset=utf-8" };

export function startDev(port = 3000, relay = createRelay(memoryStore())) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/") || url.pathname === "/ics") {
      let body = "";
      for await (const c of req) body += c;
      const r = await relay(new Request(url, { method: req.method, headers: req.headers, body: req.method === "POST" ? body : undefined }));
      res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const file = url.pathname === "/" ? "index.html" : /^\/s\/[\w-]+$/.test(url.pathname) ? "s.html" : normalize(url.pathname).replace(/^[/\\]+/, "");
    try {
      const data = await readFile(join(PUBLIC, file));
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...vercelHeaders(url.pathname) }).end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 3000);
  await startDev(port);
  console.log(`Momo website: http://localhost:${port}`);
}
