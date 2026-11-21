import { describe, expect, it } from "vitest";
import { applyPresenceEvent } from "../../src/shared/presence.js";
import { parseClaudeModelInfo } from "../../src/shared/transcript.js";
import type { AgentPresence } from "../../src/shared/types.js";

const reply = (o: object) =>
  JSON.stringify({
    type: "assistant",
    effort: "medium",
    message: {
      model: "claude-opus-5-5",
      usage: { input_tokens: 2, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 500, output_tokens: 90 },
    },
    ...o,
  });

// The board shows which model each agent runs and how full its context is, read from
// the agent's own session file. A subagent's reply must not relabel the parent.
describe("parseClaudeModelInfo", () => {
  it("reads model, effort and the prompt side of usage as context", () => {
    expect(parseClaudeModelInfo(reply({}))).toEqual({ model: "claude-opus-5-5", thinking: "medium", ctxTokens: 120_502 });
  });

  it("ignores subagent replies, synthetic messages and non-assistant lines", () => {
    expect(parseClaudeModelInfo(reply({ isSidechain: true }))).toBeNull();
    expect(parseClaudeModelInfo(reply({ message: { model: "<synthetic>" } }))).toBeNull();
    expect(parseClaudeModelInfo(JSON.stringify({ type: "user", message: { content: "hi" } }))).toBeNull();
    expect(parseClaudeModelInfo("not json")).toBeNull();
  });
});

describe("applyPresenceEvent model fields", () => {
  it("keeps the last known model when a heartbeat omits it", () => {
    const roster = new Map<string, AgentPresence>();
    applyPresenceEvent(roster, { agent: "a", status: "active", model: "claude-opus-5-5", thinking: "high", ctxTokens: 10 }, "me");
    applyPresenceEvent(roster, { agent: "a", status: "active" }, "me");
    expect(roster.get("a")).toMatchObject({ model: "claude-opus-5-5", thinking: "high", ctxTokens: 10 });
    applyPresenceEvent(roster, { agent: "a", status: "active", model: "claude-sonnet-5-5", ctxTokens: 20 }, "me");
    expect(roster.get("a")).toMatchObject({ model: "claude-sonnet-5-5", thinking: undefined, ctxTokens: 20 });
  });
});
