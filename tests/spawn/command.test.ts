import { describe, it, expect } from "vitest";
import { buildStartupPrompt, buildAgentCommand } from "../../src/spawn/command.js";

const base = { tool: "pi" as const, name: "test-verifier", task: "verify the login flow", requester: "claude-code-42" };

describe("buildStartupPrompt", () => {
  it("is a single line (no newlines — it gets typed into a terminal)", () => {
    const p = buildStartupPrompt(base);
    expect(p).not.toContain("\n");
  });

  it("tells the agent to set_name and DM the requester", () => {
    const p = buildStartupPrompt(base);
    expect(p).toContain('set_name "test-verifier"');
    expect(p).toContain("agent:claude-code-42");
    expect(p).toContain("verify the login flow");
  });

  it("uses the human display name in the prose when provided", () => {
    const p = buildStartupPrompt({ ...base, requesterDisplay: "Carlos" });
    expect(p).toContain("Carlos (agent:claude-code-42)");
  });
});

describe("buildAgentCommand", () => {
  it("launches pi with a positional prompt (NOT --prompt)", () => {
    const cmd = buildAgentCommand(base);
    expect(cmd.argv[0]).toBe("pi");
    expect(cmd.argv.at(-1)).toBe(cmd.prompt);
    expect(cmd.shell).not.toContain("--prompt");
    expect(cmd.shell.startsWith("pi '")).toBe(true);
  });

  it("launches claude with a positional prompt", () => {
    const cmd = buildAgentCommand({ ...base, tool: "claude" });
    expect(cmd.argv[0]).toBe("claude");
    expect(cmd.shell.startsWith("claude '")).toBe(true);
  });

  // `codex "<prompt>"` opens an interactive session, so the agent stays up to report back.
  it("launches codex with a positional prompt", () => {
    const cmd = buildAgentCommand({ ...base, tool: "codex" });
    expect(cmd.argv).toEqual(["codex", "-m", "gpt-6.2-sol", cmd.prompt]);
    expect(cmd.shell.startsWith("codex '")).toBe(true);
  });

  // Each agent gets the agreed default model unless the spawner picks one, so a spawned
  // agent never silently runs on whatever its CLI happens to default to.
  it("starts each agent on its default model", () => {
    expect(buildAgentCommand({ ...base, tool: "claude" }).argv.slice(0, 3)).toEqual(["claude", "--model", "claude-opus-5-5"]);
    expect(buildAgentCommand({ ...base, tool: "pi" }).argv.slice(0, 3)).toEqual(["pi", "--model", "openai-codex/auto"]);
  });

  it("passes the chosen model and thinking level in each CLI's own flags", () => {
    const flags = (tool: "pi" | "claude" | "codex") =>
      buildAgentCommand({ ...base, tool, model: "m1", thinking: "high" }).argv.slice(1, -1);
    expect(flags("claude")).toEqual(["--model", "m1", "--effort", "high"]);
    expect(flags("pi")).toEqual(["--model", "m1", "--thinking", "high"]);
    expect(flags("codex")).toEqual(["-m", "m1", "-c", 'model_reasoning_effort="high"']);
  });

  it("rejects a thinking level the CLI does not know", () => {
    expect(() => buildAgentCommand({ ...base, tool: "claude", thinking: "ultra" })).toThrow(/thinking level/);
  });

  it("single-quotes the prompt so it survives a shell paste", () => {
    const cmd = buildAgentCommand({ ...base, task: "handle O'Brien's case" });
    // the embedded apostrophe must be escaped as '\'' and not break out of quoting
    expect(cmd.shell).toContain(`'\\''`);
  });

  it("reuses the name as the tab label", () => {
    expect(buildAgentCommand(base).label).toBe("test-verifier");
  });
});
