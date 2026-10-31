// A computer for errands that aren't websites: anything a person could do in
// front of a screen, driven through vercel-labs/agent-desktop.
//
//   LocalComputer   the owner's own machine (macOS, Windows, Linux desktop).
//                   One owner only: it's their screen, files and accounts.
//   DockerComputers a fresh cloud desktop per errand (Dockerfile.desktop),
//                   so many people can use Momo without owning a computer.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { AgentDesktop } from "./desktop.ts";

const exec = promisify(execFile);

/** The agent-desktop calls the errand agent uses (a fake in tests). */
export type DesktopApi = Pick<AgentDesktop, "tree" | "listApps" | "launch" | "click" | "type" | "select" | "press" | "scroll" | "screenshot">;

export interface Computer {
  desktop: DesktopApi;
  /** Apps known to be installed, for the planner (empty: unknown, try by name). */
  apps: string[];
  close(): Promise<void>;
}

export interface ComputerFactory {
  /** Shown to the planner: "the owner's own computer" or "a cloud computer". */
  readonly describe: string;
  /** Apps known to be installed, for the planner (empty: unknown, try by name). */
  readonly apps: string[];
  open(taskId: string): Promise<Computer>;
}

export class LocalComputer implements ComputerFactory {
  readonly describe = "the owner's own computer (their real apps, files and accounts; be careful)";
  readonly apps: string[] = [];
  private readonly desktop: DesktopApi;

  constructor(desktop: DesktopApi = new AgentDesktop()) {
    this.desktop = desktop;
  }

  async open(): Promise<Computer> {
    return { desktop: this.desktop, apps: [], close: async () => {} };
  }
}

export interface DockerComputersOptions {
  image?: string;
  docker?: string;
  /** What the image has installed. */
  apps?: string[];
  /** docker run --memory. */
  memory?: string;
}

export class DockerComputers implements ComputerFactory {
  readonly describe = "a private cloud computer made for this errand (Linux desktop)";
  private readonly o: Required<DockerComputersOptions>;

  get apps(): string[] {
    return this.o.apps;
  }

  constructor(o: DockerComputersOptions = {}) {
    this.o = {
      image: o.image ?? "momo-desktop",
      docker: o.docker ?? "docker",
      apps: o.apps ?? ["gnome-calculator", "gnome-text-editor"],
      memory: o.memory ?? "2g",
    };
  }

  async open(taskId: string): Promise<Computer> {
    const name = `momo-desk-${taskId.replace(/[^\w-]/g, "").slice(0, 24)}-${randomBytes(3).toString("hex")}`;
    await exec(this.o.docker, [
      "run", "-d", "--rm", "--name", name,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", this.o.memory, "--pids-limit", "512",
      this.o.image,
    ]);
    const close = async () => {
      await exec(this.o.docker, ["rm", "-f", name]).catch(() => {});
    };
    try {
      // Ready when the session is up and agent-desktop can see the accessibility bus.
      const desktop = new AgentDesktop({ prefix: [this.o.docker, "exec", name] });
      for (let i = 0; ; i++) {
        const { stdout } = await exec(this.o.docker, ["logs", name]).catch(() => ({ stdout: "" }));
        if (stdout.includes("momo-desktop ready")) break;
        if (i > 100) throw new Error("cloud computer didn't start");
        await new Promise((r) => setTimeout(r, 150));
      }
      for (let i = 0; ; i++) {
        const ok = await desktop.listApps().then(() => true, () => false);
        if (ok) break;
        if (i > 40) throw new Error("cloud computer's accessibility bus didn't start");
        await new Promise((r) => setTimeout(r, 250));
      }
      return { desktop, apps: this.o.apps, close };
    } catch (e) {
      await close();
      throw e;
    }
  }
}
