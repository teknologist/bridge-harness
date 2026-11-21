import { describe, it, expect } from "vitest";
import { spawnAgentTab, type Runner } from "../../src/spawn/spawn.js";
import { buildAgentCommand } from "../../src/spawn/command.js";
import { type SpawnCapability } from "../../src/spawn/probe.js";

const cmd = buildAgentCommand({ tool: "pi", name: "verifier", task: "check X", requester: "claude-code-1" });

// Records every (file, args) the dispatcher runs, and returns canned stdout.
function recorder(stdout = ""): { run: Runner; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: Runner = (file, args) => { calls.push({ file, args }); return stdout; };
  return { run, calls };
}

const cap = (backend: SpawnCapability["backend"], canSpawnTab: boolean): SpawnCapability =>
  ({ backend, canSpawnTab, method: "cmux-cli", detail: `${backend} test` });

describe("buildAgentCommand launcher", () => {
  it("prefixes the prompt with a custom launcher (dashboard runs pi via pi-profile)", () => {
    const c = buildAgentCommand({ tool: "pi", name: "v", task: "t", requester: "r", launcher: ["pi-profile", "nats"] });
    expect(c.argv).toEqual(["pi-profile", "nats", c.prompt]);
    expect(c.shell.startsWith("pi-profile 'nats' '")).toBe(true);
  });
});

describe("buildAgentCommand cwd", () => {
  // The cd must happen on the TARGET machine, so ~ is left for its shell to expand.
  it("wraps argv in sh -c cd, keeping ~ unquoted and the rest quoted", () => {
    const c = buildAgentCommand({ tool: "pi", name: "v", task: "t", requester: "r", cwd: "~/my dir" });
    expect(c.argv.slice(0, 3)).toEqual(["sh", "-c", `cd ~/'my dir' && exec "$@"`]);
    expect(c.argv.slice(4)).toEqual(["pi", c.prompt]);
    expect(c.shell.startsWith("cd ~/'my dir' && pi '")).toBe(true);
  });
});

describe("spawnAgentTab", () => {
  it("cmux: creates a pane, parses the surface ref, then types the command + Enter", () => {
    const { run, calls } = recorder("OK surface:89 pane:28 workspace:3");
    const res = spawnAgentTab(cmd, cap("cmux", true), { CMUX_BUNDLED_CLI_PATH: "/bin/cmux" }, run);
    expect(res.spawned).toBe(true);
    expect(calls[0]).toEqual({ file: "/bin/cmux", args: ["new-pane", "--type", "terminal", "--direction", "down", "--focus", "true"] });
    expect(calls[1]).toEqual({ file: "/bin/cmux", args: ["send", "--surface", "surface:89", cmd.shell] });
    expect(calls[2]).toEqual({ file: "/bin/cmux", args: ["send-key", "--surface", "surface:89", "Enter"] });
  });

  it("cmux: degrades to manual when new-pane returns no surface ref", () => {
    const { run } = recorder("weird output, no ref");
    const res = spawnAgentTab(cmd, cap("cmux", true), {}, run);
    expect(res.spawned).toBe(false);
    expect(res.manualCommand).toBe(cmd.shell);
  });

  it("rex: opens a named tab in the caller's session via the bundled CLI, argv after --", () => {
    const { run, calls } = recorder();
    const env = { REX_BIN_DIR: "/rex/bin", REX_SESSION: "session:abc" };
    const res = spawnAgentTab(cmd, cap("rex", true), env, run);
    expect(res.spawned).toBe(true);
    expect(calls[0]).toEqual({ file: "/rex/bin/rex", args: ["window", "new", "-s", "session:abc", "verifier", "-c", process.cwd(), "--keep-open", "--", ...cmd.argv] });
  });

  // Remote servers with several sessions reject an untargeted window (ambiguous), so
  // remote agents always land in a dedicated session, never our local REX_SESSION.
  const remote = buildAgentCommand({ tool: "pi", name: "r", task: "t", requester: "x", host: "spark1", cwd: "~/Dev/app" });
  const sessions = (list: object[]) => {
    const calls: { file: string; args: string[] }[] = [];
    const run = (file: string, args: string[]) => { calls.push({ file, args }); return args.includes("list") ? JSON.stringify({ sessions: list }) : ""; };
    return { run, calls };
  };

  it("rex host: creates the bridge-agents session when missing, even from tmux", () => {
    const { run, calls } = sessions([{ session_id: "session:a", label: "other" }, { session_id: "session:b", label: "x" }]);
    const res = spawnAgentTab(remote, cap("tmux", true), { REX_SESSION: "session:local" }, run);
    expect(res.spawned).toBe(true);
    expect(calls[1]).toEqual({ file: "rex", args: ["-S", "spark1", "session", "new", "bridge-agents", "--window", "r", "--keep-open", "--", ...remote.argv] });
  });

  it("rex host: reuses the existing bridge-agents session", () => {
    const { run, calls } = sessions([{ session_id: "session:a", label: "other" }, { session_id: "session:ba", label: "bridge-agents" }]);
    spawnAgentTab(remote, cap("rex", true), {}, run);
    expect(calls[1].args).toEqual(["-S", "spark1", "window", "new", "-s", "session:ba", "r", "--keep-open", "--", ...remote.argv]);
  });

  it("tmux: opens a named window in one shot", () => {
    const { run, calls } = recorder();
    const res = spawnAgentTab(cmd, cap("tmux", true), {}, run);
    expect(res.spawned).toBe(true);
    expect(calls[0]).toEqual({ file: "tmux", args: ["new-window", "-n", "verifier", cmd.shell] });
  });

  it("zellij: passes argv after -- (no shell quoting)", () => {
    const { run, calls } = recorder();
    const res = spawnAgentTab(cmd, cap("zellij", true), {}, run);
    expect(res.spawned).toBe(true);
    expect(calls[0]).toEqual({ file: "zellij", args: ["run", "--name", "verifier", "--", ...cmd.argv] });
  });

  it("emulator: never runs anything, returns the manual command", () => {
    const { run, calls } = recorder();
    const res = spawnAgentTab(cmd, cap("emulator", false), {}, run);
    expect(res.spawned).toBe(false);
    expect(res.manualCommand).toBe(cmd.shell);
    expect(calls).toHaveLength(0);
  });

  it("degrades to manual (never throws) when the runner fails", () => {
    const run: Runner = () => { throw new Error("cmux socket down"); };
    const res = spawnAgentTab(cmd, cap("cmux", true), {}, run);
    expect(res.spawned).toBe(false);
    expect(res.manualCommand).toBe(cmd.shell);
    expect(res.detail).toContain("cmux socket down");
  });
});
