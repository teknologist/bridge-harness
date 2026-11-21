import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanSummary,
  clipTask,
  pickTask,
  shareTaskEnabled,
  taskFromPrompt,
  taskModel,
  TASK_MAX_CHARS,
} from "../../src/shared/task.js";
import * as piTask from "../../packages/bridge-harness-pi/src/task.js";
import { applyPresenceEvent } from "../../src/shared/presence.js";
import type { AgentPresence } from "../../src/shared/types.js";

describe("task line shown to other agents", () => {
  it("never exceeds 40 characters, so it fits one panel row", () => {
    const t = clipTask("Refactor the whole invoice reconciliation pipeline for multi-currency")!;
    expect(t.length).toBe(TASK_MAX_CHARS);
    expect(t.endsWith("…")).toBe(true);
  });

  it("uses only the first non-empty line, collapsing whitespace", () => {
    expect(clipTask("\n\n  Fix   rounding\nmore details")).toBe("Fix rounding");
  });

  it("ignores acknowledgements and commands, so a real task stays visible", () => {
    expect(taskFromPrompt("go ahead")).toBeUndefined();
    expect(taskFromPrompt("/bridge planner")).toBeUndefined();
    expect(taskFromPrompt("!ls -la something long")).toBeUndefined();
    expect(taskFromPrompt("Fix the BR-FR-12 rounding bug")).toBe("Fix the BR-FR-12 rounding bug");
  });

  it("prefers what the agent declared, then the session name, then the prompt", () => {
    expect(pickTask({ explicit: "Reviewing MR", sessionName: "s", prompt: "p" })).toBe("Reviewing MR");
    expect(pickTask({ explicit: " ", sessionName: "invoice-fix", prompt: "p" })).toBe("invoice-fix");
    expect(pickTask({ prompt: "Fix rounding" })).toBe("Fix rounding");
  });

  it("BRIDGE_SHARE_TASK=0 opts out; anything else shares", () => {
    for (const v of ["0", "false", "NO", "off"]) expect(shareTaskEnabled({ BRIDGE_SHARE_TASK: v })).toBe(false);
    expect(shareTaskEnabled({})).toBe(true);
    expect(shareTaskEnabled({ BRIDGE_SHARE_TASK: "1" })).toBe(true);
  });

  it("summarises with gpt-6.1-terra (low) via openai-codex unless overridden or off", () => {
    expect(taskModel({})).toEqual({ provider: "openai-codex", model: "gpt-6.1-terra", thinking: "low" });
    expect(taskModel({ BRIDGE_TASK_MODEL: "openai/gpt-5.6-terra" })).toEqual({ provider: "openai", model: "gpt-5.6-terra", thinking: "low" });
    expect(taskModel({ BRIDGE_TASK_MODEL: "off" })).toBeUndefined();
  });

  it("cleans model replies into a bare label", () => {
    expect(cleanSummary('Task: "Fix multi-currency rounding."')).toBe("Fix multi-currency rounding");
    expect(cleanSummary("")).toBeUndefined();
    expect(cleanSummary("x".repeat(80))!.length).toBe(TASK_MAX_CHARS);
  });

  it("the Pi package copy behaves identically (it ships separately)", () => {
    expect(piTask.taskModel({})).toEqual(taskModel({}));
    expect(piTask.clipTask("a\nb")).toBe(clipTask("a\nb"));
    expect(piTask.TASK_SUMMARY_SYSTEM_PROMPT).toBeTruthy();
  });
});

describe("task in presence heartbeats", () => {
  it("updates the roster and clears when a heartbeat no longer carries one", () => {
    const roster = new Map<string, AgentPresence>();
    applyPresenceEvent(roster, { agent: "a", status: "active", task: "Fix rounding" }, "me");
    expect(roster.get("a")!.task).toBe("Fix rounding");
    applyPresenceEvent(roster, { agent: "a", status: "active" }, "me");
    expect(roster.get("a")!.task).toBeUndefined();
  });
});

describe("hooks/bridge-task.js", () => {
  const hook = join(__dirname, "../../hooks/bridge-task.js");
  const run = (env: Record<string, string>, prompt: string) => {
    const tmp = mkdtempSync(join(tmpdir(), "bt-"));
    execFileSync("node", [hook], {
      input: JSON.stringify({ prompt }),
      env: { ...process.env, TMPDIR: tmp, BRIDGE_AGENT_ID: "claude-code-test", ...env },
    });
    return join(tmp, "bridge-harness", "task-claude-code-test.txt");
  };

  it("hands the prompt to the MCP server through a private file", () => {
    const f = run({}, "Fix the rounding bug");
    expect(readFileSync(f, "utf8")).toBe("Fix the rounding bug");
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("writes nothing when the user opted out", () => {
    expect(existsSync(run({ BRIDGE_SHARE_TASK: "0" }, "Fix the rounding bug"))).toBe(false);
  });
  // A resumed session must show its transcript before the first prompt, without
  // looking busy: SessionStart records the path but not the activity.
  it("on SessionStart records the transcript path and leaves activity alone", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bt-"));
    execFileSync("node", [hook], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "resume", transcript_path: "/x/s.jsonl" }),
      env: { ...process.env, TMPDIR: tmp, BRIDGE_AGENT_ID: "claude-code-test" },
    });
    const dir = join(tmp, "bridge-harness");
    expect(readFileSync(join(dir, "transcript-claude-code-test.txt"), "utf8")).toBe("/x/s.jsonl");
    expect(existsSync(join(dir, "activity-claude-code-test.txt"))).toBe(false);
    expect(existsSync(join(dir, "task-claude-code-test.txt"))).toBe(false);
  });
});
