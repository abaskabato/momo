import { createRelay, storeFromEnv } from "../lib/relay.js";

const handle = createRelay(storeFromEnv(process.env), { env: process.env });

export function GET(request) {
  return handle(request);
}

export function POST(request) {
  return handle(request);
}
