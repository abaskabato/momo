// From a real transcript: commands that only look must not need a YES, and
// the ways people actually say yes must work.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDestructiveCommand, isReadOnlyCommand } from "../src/pc.ts";
import { YES_TO_ALL } from "../src/skills/web/agent.ts";
import { ApprovalGate, type Approval } from "../src/approvals.ts";

test("look-only PowerShell runs without asking; anything that could change something still asks", () => {
  const looks = [
    `Get-ChildItem 'C:\\Program Files\\Google\\Chrome\\Application','C:\\Program Files (x86)\\Google\\Chrome\\Application',"$env:LOCALAPPDATA\\Google\\Chrome\\Application" -Filter chrome.exe -ErrorAction SilentlyContinue | Select-Object FullName; Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -First 3 Id,MainWindowTitle`,
    `$ls = Get-Content "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Local State" -Raw | ConvertFrom-Json; $ls.profile.info_cache.PSObject.Properties | ForEach-Object { "$($_.Name) | $($_.Value.name) | $($_.Value.user_name)" }`,
    `$p="$env:LOCALAPPDATA\\Google\\Chrome\\User Data"; $ls=Get-Content "$p\\Local State" -Raw | ConvertFrom-Json; $ls.profile.info_cache.PSObject.Properties | ForEach-Object { "$($_.Name) | $($_.Value.name) | $($_.Value.user_name)" }; Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle} | Select-Object Id,MainWindowTitle | Format-Table -AutoSize | Out-String`,
    `ls -la ~/Documents | grep "a | b"`,
  ];
  for (const c of looks) assert.ok(isReadOnlyCommand(c), c);
  const changes = [
    `Start-Process 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -ArgumentList 'https://example.com'`,
    `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(2316)`,
    `$x = Remove-Item C:\\Users\\me\\file.txt`,
    `Get-ChildItem | ForEach-Object { Remove-Item $_ }`,
    `Get-Content "$(Remove-Item x)"`,
    `$f = Get-Item a.txt; $f.Delete()`,
    `[IO.File]::Delete('a.txt')`,
    `dir env:`,
    `Get-ChildItem Env:`,
    `Get-Content a.txt > b.txt`,
    `echo "unclosed`,
    `$a = Get-Content x; $b = 1; Set-Content y $a`,
  ];
  for (const c of changes) assert.ok(!isReadOnlyCommand(c), c);

  // Even after "yes to all", these ask.
  for (const c of ["Remove-Item -Recurse C:\\Users\\me\\Documents", "rm -rf ~/x", "winget uninstall Foo", "shutdown /s", "reg delete HKCU\\Software\\X"]) assert.ok(isDestructiveCommand(c), c);
  for (const c of ["Start-Process chrome.exe", "[Microsoft.VisualBasic.Interaction]::AppActivate(2316)", "mkdir notes", "code ."]) assert.ok(!isDestructiveCommand(c), c);
});

test("the ways people say yes: a plain yes answers the newest ask; 'yes to all' and 'you decide' are understood", async () => {
  for (const yes of ["YES to all", "yes all", "ok to all", "always", "don't ask again", "stop asking me", "make your own decision", "I can’t answer question make your own decision".replace("’", "'"), "you decide"]) assert.ok(YES_TO_ALL.test(yes), yes);
  for (const no of ["yes", "YES ZZC7", "no", "use the other profile", "idk", "book all of them"]) assert.ok(!YES_TO_ALL.test(no), no);

  let all: Approval[] = [];
  let t = 1000;
  const gate = new ApprovalGate({ read: async () => structuredClone(all), write: async (v: Approval[]) => void (all = structuredClone(v)), update: async (fn: (v: Approval[]) => Approval[]) => void (all = fn(structuredClone(all))) } as never, () => t);
  const ask = (taskId: string, summary: string) => gate.request({ taskId, action: "x", args: { summary }, risk: "irreversible", summary });
  const first = await ask("task-1", "Open Notion in the Abas profile");
  t += 1000;
  const second = await ask("task-2", "Find the Chrome profile for akabas7");
  const owner = { fromOwner: true, directChannel: true };

  // "ok" with two things waiting: the newest one, and the stale one is dropped instead of piling up.
  const v = await gate.resolveReply("ok", owner);
  assert.equal(v.kind, "approved");
  assert.equal(v.kind === "approved" && v.approval.id, second.id);
  assert.deepEqual((await gate.pending()).map((a) => a.id), []);
  assert.equal(all.find((a) => a.id === first.id)!.status, "expired");

  // A code still picks exactly that one.
  const third = await ask("task-3", "A");
  t += 1000;
  await ask("task-4", "B");
  const byCode = await gate.resolveReply(`yes ${third.token}`, owner);
  assert.equal(byCode.kind === "approved" && byCode.approval.id, third.id);
  assert.equal((await gate.pending()).length, 1);

  // When money is involved, a bare yes is never guessed.
  await gate.request({ taskId: "task-5", action: "x", args: { n: 1 }, risk: "purchase", summary: "Buy the flight for $240", amountUsd: 240 });
  const unsure = await gate.resolveReply("ok", owner);
  assert.equal(unsure.kind, "ambiguous");
  assert.match(unsure.kind === "ambiguous" ? unsure.message : "", /I have 2 things waiting/);
});
