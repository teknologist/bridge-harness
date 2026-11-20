// One rewake waiter per agent. Claude starts a new asyncRewake Stop hook at the end of
// every turn and never stops the previous one, so with a 24h timeout the waiters piled
// up (dozens per session), each holding a NATS connection and pulling from the same
// durable consumer. The newest waiter wins: it takes over the pid file and signals the
// one it replaces; any waiter that finds it no longer owns the file, or whose Claude
// process is gone, exits quietly (code 0, so it never wakes anyone).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function lockPath(agentId, dir = join(tmpdir(), "bridge-harness")) {
  return join(dir, `rewake-${agentId.replace(/[^\w.-]/g, "_")}.pid`);
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function isRewakeWaiter(pid) {
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return cmd.includes("bridge-rewake");
  } catch {
    return false;
  }
}

function readOwner(path) {
  try {
    return Number(readFileSync(path, "utf8").trim());
  } catch {
    return undefined;
  }
}

/** Take the lock for `agentId`, signalling the waiter that held it. Returns the path. */
export function claim(agentId, { pid = process.pid, dir } = {}) {
  const path = lockPath(agentId, dir);
  mkdirSync(join(path, ".."), { recursive: true });
  const previous = readOwner(path);
  writeFileSync(path, String(pid));
  // A waiter killed hard leaves its pid behind, and the OS may reuse it: only signal a
  // process that is still a rewake waiter.
  if (
    previous &&
    previous !== pid &&
    isAlive(previous) &&
    isRewakeWaiter(previous)
  ) {
    try {
      process.kill(previous, "SIGTERM");
    } catch {
      // already gone, or not ours to signal: it exits on its next ownership check
    }
  }
  return path;
}

export function ownsLock(path, pid = process.pid) {
  return readOwner(path) === pid;
}

/** Remove the lock only if this waiter still holds it. */
export function release(path, pid = process.pid) {
  if (!ownsLock(path, pid)) return;
  try {
    unlinkSync(path);
  } catch {
    // already removed
  }
}
