import { describe, expect, it } from "vitest";
import { cleanPromptText, parseClaudeTranscriptLine } from "../../src/shared/transcript.js";

const line = (o: object) => JSON.stringify({ uuid: "u1", timestamp: "2026-11-21T16:00:00.000Z", ...o });

// The pane shows only what a human would call the conversation: no tool traffic,
// no harness reminders, no sidechains (subagents), so watching it stays readable.
describe("parseClaudeTranscriptLine", () => {
  it("keeps a user prompt and strips system reminders", () => {
    const l = parseClaudeTranscriptLine(
      line({ type: "user", message: { content: "<system-reminder>x</system-reminder>\nfix the bug" } }),
      "claude-code-1",
    );
    expect(l).toMatchObject({ id: "u1", agentId: "claude-code-1", role: "user", text: "fix the bug" });
  });

  it("keeps assistant text and drops thinking/tool_use", () => {
    const l = parseClaudeTranscriptLine(
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Done." }] } }),
      "a",
    );
    expect(l?.text).toBe("Done.");
    expect(parseClaudeTranscriptLine(line({ type: "assistant", message: { content: [{ type: "tool_use" }] } }), "a")).toBeNull();
  });

  it("drops tool results, meta, sidechains and non-message entries", () => {
    expect(parseClaudeTranscriptLine(line({ type: "user", message: { content: [{ type: "tool_result", content: "secret" }] } }), "a")).toBeNull();
    expect(parseClaudeTranscriptLine(line({ type: "user", isMeta: true, message: { content: "x" } }), "a")).toBeNull();
    expect(parseClaudeTranscriptLine(line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "x" }] } }), "a")).toBeNull();
    expect(parseClaudeTranscriptLine(line({ type: "system" }), "a")).toBeNull();
    expect(parseClaudeTranscriptLine("not json", "a")).toBeNull();
  });
});

describe("cleanPromptText", () => {
  it("renders slash commands as typed and hides command output", () => {
    expect(cleanPromptText("<command-name>/impeccable</command-name><command-args>init</command-args>")).toBe("/impeccable init");
    expect(cleanPromptText("<local-command-stdout>ok</local-command-stdout>")).toBeUndefined();
    expect(cleanPromptText("<task-notification>x</task-notification>")).toBeUndefined();
  });
});
