// The subset of the OpenClaw plugin SDK this plugin uses, transcribed from
// openclaw/src/plugins/{plugin-api.types,hook-types,plugin-registration.types}.ts
// so the package typechecks outside the OpenClaw monorepo. In the fork, delete
// this file and depend on "@openclaw/plugin-sdk": "workspace:*".
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  }
  export interface OpenClawPluginServiceContextV2 {
    stateDir: string;
    workspaceDir?: string;
    logger: PluginLogger;
    scheduler: { signal: AbortSignal };
  }
  export interface AgentTool {
    name: string;
    label?: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  }
  export interface BeforeDispatchEvent {
    content: string;
    channel?: string;
    senderId?: string;
    isGroup?: boolean;
    timestamp?: number;
  }
  export interface BeforeDispatchContext {
    channelId?: string;
    conversationId?: string;
    senderId?: string;
  }
  export interface BeforeToolCallEvent {
    toolName: string;
    params: Record<string, unknown>;
  }
  export interface OpenClawPluginApi {
    id: string;
    pluginConfig: unknown;
    registrationMode: "full" | "discovery" | string;
    logger: PluginLogger;
    resolvePath(p: string): string;
    runtime: {
      gateway: { isAvailable(): boolean; request(method: string, params: Record<string, unknown>): Promise<unknown> };
    };
    registerService(svc: {
      id: string;
      apiVersion: 2;
      start(ctx: OpenClawPluginServiceContextV2): void | Promise<void>;
      stop?(): void | Promise<void>;
    }): void;
    registerTool(tool: AgentTool, opts?: { optional?: boolean }): void;
    on(hook: "before_dispatch", fn: (e: BeforeDispatchEvent, c: BeforeDispatchContext) => Promise<{ handled: boolean; text?: string } | void>): void;
    on(hook: "before_tool_call", fn: (e: BeforeToolCallEvent) => Promise<{ block?: boolean; blockReason?: string } | void>): void;
  }
  export function definePluginEntry(def: {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
  }): unknown;
}
