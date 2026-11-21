#!/usr/bin/env node
// UserPromptSubmit hook: hands the latest prompt to this session's bridge MCP server,
// which turns it into a one-line task shown to other agents (see src/shared/task.ts).
// Like bridge-rewake, the hook and the MCP server share a parent Claude Code process,
// so process.ppid gives the same agentId in both. The file never leaves this machine;
// only the summarised label goes on the bus. BRIDGE_SHARE_TASK=0 turns it all off.
import { hookAgentId } from "./claude-pid.js";
import { writeActivity } from "./activity.js";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

writeActivity(hookAgentId(), "working");

const share = (process.env.BRIDGE_SHARE_TASK ?? "").trim().toLowerCase();
if (["0", "false", "no", "off"].includes(share)) process.exit(0);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const { prompt } = JSON.parse(input);
    if (typeof prompt !== "string" || !prompt.trim()) return;
    const agentId = hookAgentId();
    const dir = join(tmpdir(), "bridge-harness");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `task-${agentId.replace(/[^\w.-]/g, "_")}.txt`);
    writeFileSync(file, prompt.slice(0, 2000), { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // Never block or disturb the prompt: the task line is best-effort.
  }
});
