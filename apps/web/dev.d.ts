import type { Server } from "node:http";
export function startDev(port?: number, relay?: (req: Request) => Promise<Response>): Promise<Server>;
