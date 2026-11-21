#!/usr/bin/env node
// UserPromptSubmit hook: hands the latest prompt to this session's bridge MCP server,
// which turns it into a one-line task shown to other agents (see src/shared/task.ts).
// Like bridge-rewake, the hook and the MCP server share a parent Claude Code process,
// so process.ppid gives the same agentId in both. The file never leaves this machine;
// only the summarised label goes on the bus. BRIDGE_SHARE_TASK=0 turns it all off.
// It also records the session transcript path (BRIDGE_SHARE_TRANSCRIPT=0 turns that off).
// It also runs on SessionStart, so a resumed session shows its transcript before the
// first prompt; that run only records the path and leaves the activity alone.
import { hookAgentId } from "./claude-pid.js";
import { writeActivity } from "./activity.js";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * True when the env var `name` is set to a falsy word (0, false, no, off).
 * @param {string} name
 * @returns {boolean}
 */
const off = (name) => ["0", "false", "no", "off"].includes((process.env[name] ?? "").trim().toLowerCase());
const shareTask = !off("BRIDGE_SHARE_TASK");
// The MCP server tails this session's transcript file to stream the live conversation.
const shareTranscript = !off("BRIDGE_SHARE_TRANSCRIPT");

/**
 * Writes `text` to $TMPDIR/bridge-harness/<name>-<agentId>.txt, readable by this user only.
 * @param {string} name
 * @param {string} text
 */
function writePrivate(name, text) {
  const dir = join(tmpdir(), "bridge-harness");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}-${hookAgentId().replace(/[^\w.-]/g, "_")}.txt`);
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let event = {};
  try {
    event = JSON.parse(input) ?? {};
  } catch {
    // Unreadable input: still count it as a prompt below.
  }
  const sessionStart = event.hook_event_name === "SessionStart";
  if (!sessionStart) writeActivity(hookAgentId(), "working");
  try {
    const { prompt, transcript_path: transcriptPath } = event;
    if (shareTranscript && typeof transcriptPath === "string" && transcriptPath) {
      writePrivate("transcript", transcriptPath);
    }
    if (!sessionStart && shareTask && typeof prompt === "string" && prompt.trim()) {
      writePrivate("task", prompt.slice(0, 2000));
    }
  } catch {
    // Never block or disturb the prompt: the task line is best-effort.
  }
});
