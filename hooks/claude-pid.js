// Finds the Claude Code process a hook belongs to, so hooks derive the same agentId
// (`claude-code-<pid>`) as the bridge MCP server, which Claude spawns directly.
//
// Claude runs hook commands through `/bin/sh -c`. macOS sh (bash) execs the last
// command, so process.ppid is Claude; Linux dash does not, so process.ppid is the
// wrapping shell. That made the rewake hook on Linux watch bridge.dm.claude-code-<shell
// pid>, and DMs to the real session never woke it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Only the `sh -c` wrapper is skipped (one level), never a user shell like zsh.
const SHELLS = new Set(["sh", "dash", "bash", "ash", "busybox"]);

function parentAndName(pid) {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm may contain spaces/parens.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const name = stat.slice(stat.indexOf("(") + 1, close);
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    return { ppid, name };
  } catch {
    try {
      const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
      const m = out.match(/^(\d+)\s+(.*)$/);
      if (!m) return undefined;
      return { ppid: Number(m[1]), name: m[2].split("/").pop().replace(/^-/, "") };
    } catch {
      return undefined;
    }
  }
}

export function claudePid(start = process.ppid) {
  const info = parentAndName(start);
  return info && SHELLS.has(info.name) && info.ppid > 1 ? info.ppid : start;
}

export function hookAgentId() {
  return process.env.BRIDGE_AGENT_ID ?? `claude-code-${claudePid()}`;
}
