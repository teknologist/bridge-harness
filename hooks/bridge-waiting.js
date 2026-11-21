#!/usr/bin/env node
// Waiting signal: Claude Code is blocked on the user (a permission prompt, a question,
// a plan to approve). The bridge MCP server publishes it so the board can flag the agent
// and the user can answer from there. Registered on Notification (permission_prompt),
// PreToolUse (AskUserQuestion, ExitPlanMode) and PostToolUse (clears it once answered).
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookAgentId } from "./claude-pid.js";
import { writeActivity } from "./activity.js";

let event = "";
try {
  event = JSON.parse(readFileSync(0, "utf8") || "{}").hook_event_name ?? "";
} catch {
  // Unreadable input: treat as a prompt (the only events we are registered on).
}

const id = hookAgentId();
if (event === "PostToolUse") {
  // The prompt was answered and the tool ran: back to work, unless already idle/working.
  try {
    const file = join(tmpdir(), "bridge-harness", `activity-${id.replace(/[^\w.-]/g, "_")}.txt`);
    if (readFileSync(file, "utf8").trim() === "waiting") writeActivity(id, "working");
  } catch {
    // No activity file yet: nothing to clear.
  }
} else {
  writeActivity(id, "waiting");
}
