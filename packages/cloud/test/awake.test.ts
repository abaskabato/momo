// Keeping the owner's computer awake: held while Momo runs, let go in the
// nightly maintenance window (unless an errand is in progress), held again after.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { KeepAwake, awakeFromEnv, holdCommand, inWindow, parseWindow, showWindow } from "../src/awake.ts";

const at = (h: number, m = 0) => new Date(2026, 10, 15, h, m);

function helpers() {
  const made: Array<EventEmitter & { killed: boolean; cmd: string }> = [];
  const spawn = (cmd: string) => {
    const c = Object.assign(new EventEmitter(), { killed: false, cmd, kill() { c.killed = true; c.emit("exit"); return true; } });
    made.push(c);
    return c as unknown as ChildProcess;
  };
  return { made, spawn };
}

test("maintenance window: read as written, across midnight too; nonsense means none", () => {
  assert.deepEqual(parseWindow("03:00-05:00"), { start: 180, end: 300 });
  assert.deepEqual(parseWindow("3-5"), { start: 180, end: 300 });
  assert.equal(showWindow(parseWindow(" 23:30 - 1:00 ")!), "23:30-01:00");
  for (const bad of [undefined, "", "off", "25:00-26:00", "03:00", "04:00-04:00"]) assert.equal(parseWindow(bad), undefined, String(bad));
  const night = parseWindow("03:00-05:00")!;
  assert.deepEqual([at(2, 59), at(3), at(4, 59), at(5)].map((d) => inWindow(night, d)), [false, true, true, false]);
  const late = parseWindow("23:30-01:00")!;
  assert.deepEqual([at(23, 29), at(23, 30), at(0, 30), at(1)].map((d) => inWindow(late, d)), [false, true, true, false]);
});

test("the computer is held awake, let go for the window, and held again when it ends", () => {
  const { made, spawn } = helpers();
  let now = at(14);
  const k = new KeepAwake({ platform: "win32", window: parseWindow("03:00-05:00"), now: () => now, spawn });
  assert.equal(k.tick(), true);
  assert.equal(made.length, 1);
  assert.equal(made[0].cmd, "powershell.exe");
  k.tick();
  assert.equal(made.length, 1, "one helper, not one per look");
  now = at(3, 1);
  assert.equal(k.tick(), false, "the window: the computer may sleep, update, restart");
  assert.equal(made[0].killed, true);
  now = at(5);
  assert.equal(k.tick(), true, "the window is over");
  assert.equal(made.length, 2);
  k.stop();
  assert.equal(made[1].killed, true, "nothing is left holding the computer when Momo stops");
});

test("an errand in progress is finished before the computer may rest", () => {
  const { made, spawn } = helpers();
  let busy = true;
  const k = new KeepAwake({ platform: "darwin", window: parseWindow("03:00-05:00"), now: () => at(3, 30), busy: () => busy, spawn });
  assert.equal(k.tick(), true, "still working at 3:30");
  busy = false;
  assert.equal(k.tick(), false);
  assert.equal(made[0].killed, true);
});

test("a helper that dies is replaced; a computer with no helper is left alone after saying so once", () => {
  const { made, spawn } = helpers();
  const k = new KeepAwake({ platform: "linux", now: () => at(12), spawn });
  k.tick();
  made[0].emit("exit");
  assert.equal(k.holding, false);
  assert.equal(k.tick(), true);
  assert.equal(made.length, 2);

  const said: string[] = [];
  const none = helpers();
  const k2 = new KeepAwake({ platform: "linux", now: () => at(12), spawn: none.spawn, log: (m) => said.push(m) });
  k2.tick();
  none.made[0].emit("error", new Error("spawn systemd-inhibit ENOENT"));
  assert.equal(k2.tick(), false);
  assert.equal(none.made.length, 1, "not tried again every half minute");
  assert.equal(said.length, 1);
  assert.match(said[0], /sleep as it usually does/);

  // The helper exists but is refused (no session to hold): same thing.
  const refused = helpers();
  const k3 = new KeepAwake({ platform: "linux", now: () => at(12), spawn: refused.spawn, log: (m) => said.push(m) });
  k3.tick();
  refused.made[0].emit("exit", 1);
  assert.equal(k3.tick(), false);
  assert.equal(refused.made.length, 1);
  assert.equal(said.length, 2);
});

test("each kind of computer has its own way of staying awake, tied to Momo's life", () => {
  assert.match(holdCommand("win32", 42)!.args.join(" "), /SetThreadExecutionState.*ReadLine/);
  assert.deepEqual(holdCommand("darwin", 42), { cmd: "caffeinate", args: ["-i", "-s", "-w", "42"] });
  assert.ok(holdCommand("linux", 42)!.args.includes("--pid=42"));
  assert.equal(holdCommand("aix", 42), undefined);
});

test("settings: on by default; the window only where the computer wakes itself; off means off", () => {
  const win = awakeFromEnv({}, "win32");
  assert.deepEqual([win.on, win.window], [true, { start: 180, end: 300 }]);
  assert.match(win.note, /between 03:00 and 05:00/);
  assert.equal(awakeFromEnv({ MOMO_MAINTENANCE: "off" }, "win32").window, undefined);
  assert.deepEqual(awakeFromEnv({ MOMO_MAINTENANCE: "01:00-02:00" }, "win32").window, { start: 60, end: 120 });
  const mac = awakeFromEnv({ MOMO_MAINTENANCE: "01:00-02:00" }, "darwin");
  assert.equal(mac.window, undefined);
  assert.match(mac.note, /can't wake itself/);
  assert.equal(awakeFromEnv({ MOMO_AWAKE: "off" }, "win32").on, false);
});

test("MOMO_LID=awake: Windows ignores the lid while plugged in and puts its setting back; Linux holds the lid switch; a Mac is left be", () => {
  const win = holdCommand("win32", 42, true, "C:\\Users\\a\\.momo\\lid-setting.txt")!.args.at(-1)!;
  // Remembers the setting first (or keeps one remembered from a run that was cut off), then changes it, then holds.
  assert.match(win, /\$f = 'C:\\Users\\a\\\.momo\\lid-setting\.txt'; \$was = if \(Test-Path \$f\) \{ Get-Content \$f \} else \{ .*LIDACTION.*\}; if \(\$was\) \{ Set-Content \$f \$was; powercfg \/setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0;/);
  assert.ok(!/setdcvalueindex/.test(win), "on battery, a closed lid still sleeps");
  // ...and when Momo goes away (its stdin closes), puts it back and forgets it.
  assert.match(win, /ReadLine\(\); if \(\$was\) \{ powercfg \/setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION \(\[Convert\]::ToInt32\(\$was, 16\)\); powercfg \/setactive SCHEME_CURRENT; Remove-Item \$f \}$/);
  assert.ok(!/LIDACTION/.test(holdCommand("win32", 42)!.args.join(" ")), "off unless asked");
  assert.ok(holdCommand("linux", 42, true)!.args.includes("--what=sleep:idle:handle-lid-switch"));
  assert.ok(holdCommand("linux", 42)!.args.includes("--what=sleep:idle"));
  assert.deepEqual(holdCommand("darwin", 42, true), { cmd: "caffeinate", args: ["-i", "-s", "-w", "42"] });

  assert.equal(awakeFromEnv({ MOMO_LID: "awake" }, "win32").lid, true);
  assert.match(awakeFromEnv({ MOMO_LID: "awake" }, "win32").note, /lid closed too while plugged in/);
  assert.equal(awakeFromEnv({ MOMO_LID: "awake" }, "darwin").lid, false);
  assert.match(awakeFromEnv({ MOMO_LID: "awake" }, "darwin").note, /needs an administrator/);
  assert.equal(awakeFromEnv({}, "linux").lid, false);
});
