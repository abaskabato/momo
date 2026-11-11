// Full access to the owner's own computer: files and commands, not just what's
// on screen. Off unless the owner turns it on (MOMO_ACCESS=full).
//
// The rule the code enforces, whatever the model says: looking is free,
// changing asks first. A command runs without approval only if every part of
// it is on a short list of read-only commands; anything else (deleting,
// moving, installing, sending, or simply something unrecognized) needs the
// owner's YES. Momo's own settings and keys are never readable.

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface PcAccess {
  /** "windows" | "mac" | "linux", and the shell commands are written for. */
  readonly platform: "windows" | "mac" | "linux";
  readonly shell: string;
  readonly home: string;
  run(command: string, timeoutMs?: number): Promise<{ code: number; output: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}

const MAX_OUTPUT = 8000;
const MAX_FILE = 200_000;

export class LocalPc implements PcAccess {
  readonly platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  readonly shell = process.platform === "win32" ? "PowerShell" : "sh";
  readonly home: string;

  constructor(home = homedir()) {
    this.home = home;
  }

  abs(path: string): string {
    const p = path.startsWith("~") ? join(this.home, path.slice(1)) : path;
    return isAbsolute(p) ? resolve(p) : resolve(this.home, p);
  }

  run(command: string, timeoutMs = 120_000): Promise<{ code: number; output: string }> {
    const [cmd, args] =
      process.platform === "win32"
        ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]]
        : ["/bin/sh", ["-c", command]];
    return new Promise((done) => {
      execFile(cmd, args as string[], { cwd: this.home, timeout: timeoutMs, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        const timedOut = err && (err as { killed?: boolean }).killed;
        done({ code, output: (timedOut ? `${out}\n(stopped after ${Math.round(timeoutMs / 1000)}s)` : out).slice(0, MAX_OUTPUT) || "(no output)" });
      });
    });
  }

  async readFile(path: string): Promise<string> {
    const p = this.abs(path);
    const s = await stat(p);
    if (s.size > MAX_FILE) return `${(await readFile(p, "utf8")).slice(0, MAX_FILE)}\n(file is ${s.size} bytes; showing the first ${MAX_FILE})`;
    return readFile(p, "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = this.abs(path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }

  async exists(path: string): Promise<boolean> {
    return stat(this.abs(path)).then(() => true, () => false);
  }

  async list(path: string): Promise<string[]> {
    const p = this.abs(path);
    const names = await readdir(p, { withFileTypes: true });
    return names.slice(0, 500).map((d) => (d.isDirectory() ? `${d.name}${sep}` : d.name));
  }
}

/** Commands that only look. Lower-case; PowerShell names and their common aliases included. */
const READ_ONLY = new Set([
  // sh
  "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "pwd", "echo", "printf", "date", "whoami", "hostname", "uname", "df", "du", "ps", "stat", "file",
  "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath", "which", "id", "uptime", "free", "env", "printenv", "tree", "nl", "column", "diff", "md5sum", "sha256sum", "shasum",
  "sw_vers", "mdfind", "mdls", "lsb_release", "ip", "ifconfig",
  // PowerShell
  "get-childitem", "gci", "dir", "get-content", "gc", "type", "get-item", "gi", "get-itemproperty", "get-process", "gps", "tasklist", "get-date", "get-location", "gl",
  "test-path", "select-string", "sls", "findstr", "where-object", "where", "?", "select-object", "select", "sort-object", "measure-object", "measure", "format-table", "ft",
  "format-list", "fl", "out-string", "get-command", "gcm", "get-service", "get-volume", "get-psdrive", "get-computerinfo", "systeminfo", "ver", "get-clipboard",
  "resolve-path", "split-path", "join-path", "get-filehash", "foreach-object", "%", "write-output", "group-object", "get-unique", "convertto-json", "convertfrom-json",
  "get-netipaddress", "ipconfig", "get-ciminstance", "get-wmiobject", "get-hotfix", "get-package", "winget",
]);
/** Read-only commands whose arguments can still change things. */
const UNSAFE_ARGS: Array<[RegExp, RegExp]> = [
  [/^(find)$/, /./], // find isn't on the list at all; kept here so nobody adds it without -delete/-exec in mind
  [/^winget$/, /\b(install|uninstall|upgrade|import|settings|source)\b/i],
  [/^(env|printenv|get-childitem|gci|dir)$/, /env:|\benv\b.*=/i],
  [/^(foreach-object|%|where-object|\?)$/, /\b(remove|delete|set-|new-|move|copy|rename|clear|stop|start|invoke|out-file|add-content|set-content)\b/i],
  [/^(ip|ifconfig)$/, /\b(add|del|set|up|down|flush)\b/i],
];

/** Momo's own keys and settings: never shown to the model, with or without approval. */
const PRIVATE = /\.momo\b|momo\.env|MOMO_MASTER_KEY|_API_KEY|BOT_TOKEN/i;

export function touchesMomoSecrets(text: string): boolean {
  return PRIVATE.test(text);
}

/**
 * True only when every part of the command is a known read-only command with
 * nothing that writes: no redirection, no command substitution, no script
 * blocks that could hide a change.
 */
export function isReadOnlyCommand(command: string): boolean {
  const c = command.trim();
  if (!c || c.length > 2000) return false;
  if (/[`]|\$\(|>|<\(|\bsudo\b|\brunas\b|\biex\b|invoke-expression|start-process|&\s*["'{(]/i.test(c)) return false;
  // Every segment of a pipeline or sequence must itself be read-only.
  for (const seg of c.split(/\|\||&&|[|;\n]/)) {
    const s = seg.trim();
    if (!s) continue;
    const m = /^([A-Za-z?%][\w.-]*|\?|%)/.exec(s);
    if (!m) return false;
    const name = m[1]!.toLowerCase().replace(/\.exe$/, "");
    if (!READ_ONLY.has(name)) return false;
    const rest = s.slice(m[1]!.length);
    for (const [who, bad] of UNSAFE_ARGS) if (who.test(name) && bad.test(rest)) return false;
  }
  return true;
}
