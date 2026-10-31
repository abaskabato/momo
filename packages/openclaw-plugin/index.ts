// Momo as an OpenClaw plugin.
//
// - before_dispatch: owner messages hit Momo's Assistant BEFORE the model.
//   Control words (STOP/UNDO), approval replies, and answers to a task's
//   question are settled by code here, so the model can never approve.
// - Tools: the general agent can hand a request to a skill and read status,
//   but no tool can commit, pay, or read a secret.
// - Service: the thin-cloud check-in loop (optional; local-only works too).
// - Outbound: the gateway's `send`, so replies use OpenClaw's own channels.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  AgentDesktop,
  CheckinWorker,
  DesktopBrowser,
  HeadlessBrowser,
  JsonFile,
  RestaurantSkill,
  TableNowProvider,
  createLocalAgent,
  loadOrCreateDeviceKeys,
  type Outbound,
} from "@momo/agent-core";
import { CloudClient, type Channel } from "@momo/protocol";

interface MomoConfig {
  cloudUrl?: string;
  deviceId?: string;
  stateDir?: string;
  ownerHandles: string[];
  tablenowOrigin?: string;
  headedBrowser?: boolean;
}

const CHANNELS = new Set<Channel>(["imessage", "telegram", "whatsapp", "sms", "signal"]);

export default definePluginEntry({
  id: "momo",
  name: "Momo",
  description: "Task skills with a local vault and confirm-before-commit.",
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") return;
    const cfg = api.pluginConfig as MomoConfig;

    const outbound: Outbound = {
      async send(channel, to, message) {
        await api.runtime.gateway.request("send", { channel, to, message, idempotencyKey: randomUUID() });
      },
    };

    let agentPromise: ReturnType<typeof boot> | null = null;
    const boot = async (stateDir: string, workspaceDir?: string) => {
      const browser = cfg.headedBrowser ? new DesktopBrowser(new AgentDesktop()) : new HeadlessBrowser();
      const agent = await createLocalAgent({
        stateDir,
        skills: () => [new RestaurantSkill(new TableNowProvider(cfg.tablenowOrigin ?? "https://tablenow.example", browser))],
        outbound,
        ownerHandles: cfg.ownerHandles,
        // Notes land where OpenClaw's memory search indexes them.
        memoryNotesDir: workspaceDir ? join(workspaceDir, "memory") : undefined,
      });
      return { ...agent, browser };
    };
    const agent = () => (agentPromise ??= boot(cfg.stateDir ?? api.resolvePath("~/.momo")));

    api.on("before_dispatch", async (event, ctx) => {
      const channel = (event.channel ?? ctx.channelId) as Channel;
      const from = event.senderId ?? ctx.senderId;
      // Group chats never drive tasks or approvals.
      if (!from || event.isGroup || !CHANNELS.has(channel)) return;
      const { assistant } = await agent();
      const res = await assistant.handle({ channel, from, threadId: from, text: event.content, receivedAt: event.timestamp ?? Date.now() });
      return res.handled ? { handled: true } : undefined;
    });

    api.registerTool({
      name: "momo_start_task",
      label: "Start a Momo task",
      description:
        "Hand an errand to Momo (e.g. restaurant bookings). Pass the owner's request as one plain sentence with every detail they gave. Momo asks the owner itself for anything missing and for approval before committing.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          request: { type: "string" },
          channel: { type: "string", enum: [...CHANNELS] },
          ownerHandle: { type: "string" },
        },
        required: ["request", "channel", "ownerHandle"],
      },
      async execute(_id, p) {
        const { assistant } = await agent();
        // Only the owner's own thread; the model can't aim tasks at anyone else.
        if (!cfg.ownerHandles.includes(String(p.ownerHandle))) return { ok: false, error: "not the owner" };
        const res = await assistant.handle({
          channel: p.channel as Channel,
          from: String(p.ownerHandle),
          threadId: String(p.ownerHandle),
          text: String(p.request),
          receivedAt: Date.now(),
        });
        return res.handled ? { ok: true, taskId: res.taskId, note: "Momo is texting the owner directly; don't repeat its messages." } : { ok: false, error: "no Momo skill handles this" };
      },
    });

    api.registerTool({
      name: "momo_tasks",
      label: "Momo task status",
      description: "List Momo's tasks and skills. Read-only.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const { tasks } = await agent();
        const all = await tasks.all();
        return {
          skills: ["restaurant: book, change, or cancel restaurant reservations"],
          tasks: all.slice(-20).map((t) => ({ id: t.id, request: t.request, status: t.status, log: t.log.slice(-3) })),
        };
      },
    });

    api.registerTool({
      name: "momo_vault_list",
      label: "Saved logins and cards",
      description: "What the owner has saved in the local vault: labels and hints only. Secret values are never available to you.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        return { items: await (await agent()).vault.list() };
      },
    });

    let worker: CheckinWorker | null = null;
    api.registerService({
      id: "momo-checkin",
      apiVersion: 2,
      async start(ctx: OpenClawPluginServiceContextV2) {
        const stateDir = cfg.stateDir ?? join(ctx.stateDir, "momo");
        agentPromise = boot(stateDir, ctx.workspaceDir);
        if (!cfg.cloudUrl || !cfg.deviceId) {
          ctx.logger.info("momo: no cloudUrl; running local-only (iMessage on this Mac still works)");
          return;
        }
        const keys = await loadOrCreateDeviceKeys(stateDir);
        const { assistant } = await agentPromise;
        worker = new CheckinWorker({
          client: new CloudClient(cfg.cloudUrl, cfg.deviceId, keys),
          keys,
          assistant,
          seen: new JsonFile(join(stateDir, "seen.json"), () => []),
          log: (m) => ctx.logger.warn(`momo: ${m}`),
        });
        ctx.scheduler.signal.addEventListener("abort", () => worker?.stop(), { once: true });
        void worker.run();
      },
      async stop() {
        worker?.stop();
        const a = await agentPromise;
        if (a?.browser instanceof HeadlessBrowser) await a.browser.dispose();
      },
    });
  },
});
