import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain JS hook module
import { claim, ownsLock, release, lockPath, isAlive } from "../../hooks/rewake-lock.js";

// Claude starts a new rewake waiter every turn and never stops the old one; the lock is
// what keeps a session to a single waiter instead of dozens holding NATS connections.
describe("rewake lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "rewake-lock-"));
  const children: ChildProcess[] = [];
  afterEach(() => children.splice(0).forEach((c) => c.kill("SIGKILL")));

  // A stand-in waiter whose command line names bridge-rewake, like the real hook.
  function fakeWaiter(): ChildProcess {
    const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)", "bridge-rewake"], { stdio: "ignore" });
    children.push(c);
    return c;
  }

  it("a newer waiter takes the lock and stops the one it replaces", async () => {
    const old = fakeWaiter();
    const exited = new Promise((r) => old.once("exit", r));
    claim("agent-a", { pid: old.pid, dir });
    const path = claim("agent-a", { pid: process.pid, dir });
    await exited;
    expect(ownsLock(path)).toBe(true);
    expect(ownsLock(path, old.pid)).toBe(false);
  });

  it("never signals a recycled pid that is not a rewake waiter", () => {
    const stranger = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" });
    children.push(stranger);
    writeFileSync(lockPath("agent-b", dir), String(stranger.pid));
    claim("agent-b", { dir });
    expect(isAlive(stranger.pid)).toBe(true);
  });

  it("release only removes a lock the caller still holds", () => {
    const path = claim("agent-c", { pid: 999_999, dir });
    release(path); // we are not 999999
    expect(existsSync(path)).toBe(true);
    claim("agent-c", { dir });
    release(path);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps agents apart", () => {
    expect(lockPath("claude-code-1", dir)).not.toBe(lockPath("claude-code-2", dir));
  });

  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
});
