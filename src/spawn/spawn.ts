import { execFileSync } from "node:child_process";
import { probeSpawnCapability, type SpawnCapability, type SpawnBackend } from "./probe.js";
import { type AgentCommand } from "./command.js";

export interface SpawnResult {
  /** True when we opened a tab/pane programmatically; false means the human must run it. */
  spawned: boolean;
  backend: SpawnBackend;
  detail: string;
  /** Present when spawned=false — the exact command for the human to paste and run. */
  manualCommand?: string;
}

// A runner is injectable so tests never touch a real terminal. It mirrors execFileSync:
// takes an executable + args and returns stdout.
export type Runner = (file: string, args: string[]) => string;

const defaultRunner: Runner = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// Rex sets REX_BIN_DIR in its terminals; prefer it so a non-login PATH still finds the CLI.
export function rexBin(env: NodeJS.ProcessEnv): string {
  return env.REX_BIN_DIR ? `${env.REX_BIN_DIR}/rex` : "rex";
}

/** Label of the Rex session that holds agents spawned on a remote host. */
export const REMOTE_SESSION = "bridge-agents";

/** Id of the REMOTE_SESSION on a rex host, if it exists. */
export function findRemoteSession(run: Runner, bin: string, host: string): string | undefined {
  const out = run(bin, ["-S", host, "session", "list", "--json"]);
  const sessions = (JSON.parse(out).sessions ?? []) as { session_id: string; label?: string }[];
  return sessions.find((s) => s.label === REMOTE_SESSION)?.session_id;
}

// Local: a tab in the caller's session, defaulting to our cwd. Remote (cmd.host): a tab
// on that host's Rex server (its active session; our REX_SESSION means nothing there).
// --keep-open so a failed cd or an agent crash stays readable instead of vanishing.
export function rexWindowArgs(cmd: AgentCommand, env: NodeJS.ProcessEnv, cwd: string = process.cwd(), remoteSession?: string): string[] {
  if (cmd.host) {
    // A remote server with several sessions refuses an untargeted `window new` (ambiguous),
    // so remote agents go into one dedicated session: reuse it, or create it with this tab.
    // --interactive: agent CLIs are often put on PATH only by ~/.zshrc (e.g. ~/.local/bin on
    // Linux), which a plain login environment misses ("command not found: claude").
    if (remoteSession) return ["-S", cmd.host, "window", "new", "-s", remoteSession, cmd.label, "--keep-open", "--interactive", "--", ...cmd.argv];
    return ["-S", cmd.host, "session", "new", REMOTE_SESSION, "--window", cmd.label, "--keep-open", "--interactive", "--", ...cmd.argv];
  }
  const session = env.REX_SESSION ? ["-s", env.REX_SESSION] : [];
  const dir = cmd.cwd ? [] : ["-c", cwd];
  return ["window", "new", ...session, cmd.label, ...dir, "--keep-open", "--", ...cmd.argv];
}

// Open a new tab/pane running `cmd`, using whatever the current terminal supports.
// Always returns a result — on any failure or an unsupported host it degrades to the
// manual command instead of throwing, so the caller can always tell the user what to do.
export function spawnAgentTab(
  cmd: AgentCommand,
  cap: SpawnCapability = probeSpawnCapability(),
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = defaultRunner,
): SpawnResult {
  const manual = (detail: string): SpawnResult => ({
    spawned: false,
    backend: cap.backend,
    detail,
    manualCommand: cmd.shell,
  });

  // A remote host is reached through the Rex CLI whatever multiplexer we sit in locally.
  if (cmd.host) {
    try {
      const bin = rexBin(env);
      run(bin, rexWindowArgs(cmd, env, undefined, findRemoteSession(run, bin, cmd.host)));
      return { spawned: true, backend: "rex", detail: `opened rex tab "${cmd.label}" in session ${REMOTE_SESSION} on ${cmd.host}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { spawned: false, backend: "rex", detail: `could not reach rex host ${cmd.host} (${msg}) — run this there yourself`, manualCommand: cmd.shell };
    }
  }

  if (!cap.canSpawnTab) {
    return manual(`${cap.detail} — run this command in a new tab yourself`);
  }

  try {
    switch (cap.backend) {
      case "cmux": {
        const bin = env.CMUX_BUNDLED_CLI_PATH ?? "cmux";
        // Two-step (like tmux send-keys): create the terminal, then type the command.
        const out = run(bin, ["new-pane", "--type", "terminal", "--direction", "down", "--focus", "true"]);
        const ref = /surface:\d+/.exec(out)?.[0];
        if (!ref) return manual(`cmux new-pane returned no surface ref (${out.trim()}) — run it yourself`);
        run(bin, ["send", "--surface", ref, cmd.shell]);
        run(bin, ["send-key", "--surface", ref, "Enter"]);
        return { spawned: true, backend: "cmux", detail: `opened cmux pane ${ref} running "${cmd.label}"` };
      }
      case "tmux": {
        // new-window runs the command via sh -c; one shot, no send-keys needed.
        run("tmux", ["new-window", "-n", cmd.label, cmd.shell]); // shell already cds
        return { spawned: true, backend: "tmux", detail: `opened tmux window "${cmd.label}"` };
      }
      case "zellij": {
        // `zellij run` takes the argv directly after `--`, so no shell quoting is involved.
        run("zellij", ["run", "--name", cmd.label, "--", ...cmd.argv]);
        return { spawned: true, backend: "zellij", detail: `opened zellij pane "${cmd.label}"` };
      }
      case "rex": {
        // `rex window new` takes the argv after `--` (no shell quoting) and opens a tab.
        run(rexBin(env), rexWindowArgs(cmd, env));
        return { spawned: true, backend: "rex", detail: `opened rex tab "${cmd.label}"` };
      }
      default:
        return manual(`${cap.detail} — run this command yourself`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return manual(`could not spawn a tab (${msg}) — run this command yourself`);
  }
}
