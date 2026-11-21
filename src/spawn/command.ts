// Builds the exact command line that launches a new agent (pi, claude or codex) with a
// startup prompt telling it to get on the bridge and report back. The SAME command is
// used two ways: fed to a multiplexer to spawn a tab, or printed for the human to run
// when we can't spawn (see spawn.ts). One source of truth, zero duplication.

export type AgentTool = "pi" | "claude" | "codex";

export interface SpawnRequest {
  /** Which agent CLI to launch. */
  tool: AgentTool;
  /** Memorable handle the new agent claims via set_name (how you'll address it). */
  name: string;
  /** What the new agent should do. */
  task: string;
  /** Who to report back to — the requester's agentId or set_name handle (DM target). */
  requester: string;
  /** Optional human-readable requester name, used only in the prose ("report to Carlos"). */
  requesterDisplay?: string;
  /** Override the launcher argv (default `[tool]`), e.g. ["pi-profile", "nats"]. The prompt is appended. */
  launcher?: string[];
  /** Directory to start the agent in, on the target machine. "~" / "~/x" expand there. */
  cwd?: string;
  /** Rex host label (`rex hosts`) to start the agent on instead of this machine. */
  host?: string;
  /** Model to run; defaults to DEFAULT_MODELS[tool]. */
  model?: string;
  /** Thinking / reasoning effort level, one of THINKING_LEVELS[tool]; default: the CLI's own. */
  thinking?: string;
}

/** The model each agent starts on unless the spawner picks another. */
export const DEFAULT_MODELS: Record<AgentTool, string> = {
  claude: "claude-opus-5-5",
  pi: "openai-codex/auto",
  codex: "gpt-6.2-sol",
};

/** Thinking levels each CLI accepts (claude --effort, pi --thinking, codex model_reasoning_effort). */
export const THINKING_LEVELS: Record<AgentTool, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

/** CLI flags selecting the model and thinking level; they go before the prompt. */
export function modelArgs(tool: AgentTool, model?: string, thinking?: string): string[] {
  const m = model?.trim() || DEFAULT_MODELS[tool];
  const t = thinking?.trim();
  if (t && !THINKING_LEVELS[tool].includes(t)) {
    throw new Error(`unknown thinking level "${t}" for ${tool} (use ${THINKING_LEVELS[tool].join(", ")})`);
  }
  switch (tool) {
    case "claude":
      return ["--model", m, ...(t ? ["--effort", t] : [])];
    case "pi":
      return ["--model", m, ...(t ? ["--thinking", t] : [])];
    case "codex":
      return ["-m", m, ...(t ? ["-c", `model_reasoning_effort="${t}"`] : [])];
  }
}

export interface AgentCommand {
  /** Executable + args, ready for execFile-style spawning (no shell parsing needed). */
  argv: string[];
  /** Same command as a single copy-pasteable shell string (for the manual fallback). */
  shell: string;
  /** The startup prompt embedded in argv — always a single line. */
  prompt: string;
  /** The agent's handle, reused as the tab/window title by the spawner. */
  label: string;
  /** Start directory, already folded into argv/shell; kept so spawners can skip their own cwd default. */
  cwd?: string;
  /** Rex host label to spawn on; undefined = this machine. */
  host?: string;
}

// The startup prompt MUST be a single line: it gets typed into a terminal via `send` /
// `send-keys`, and any embedded newline would fire Enter mid-command and run a partial
// line. Steps are numbered inline instead of on separate lines.
export function buildStartupPrompt(req: SpawnRequest): string {
  const reportTo = req.requesterDisplay?.trim()
    ? `${req.requesterDisplay.trim()} (agent:${req.requester})`
    : `agent:${req.requester}`;
  return (
    `You are joining a shared agent bridge as "${req.name}". ` +
    `Get online first: (1) activate bridge comms using the agent-bridge skill / bridge tool; ` +
    `(2) claim your handle by calling set_name "${req.name}"; ` +
    `(3) DM ${reportTo} to confirm you are active — send to="agent:${req.requester}" message="${req.name} online, ready". ` +
    `Then do this task and report progress and the final result back to ${reportTo} over the bridge: ${req.task}`
  );
}

// POSIX single-quote escaping: wrap in '...', and turn each ' into '\'' so the whole
// thing survives being pasted into a shell verbatim.
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Where an agent starts when the caller names no folder and has none of its own (the
 * dashboard, or any remote host). Not ~: Claude Code never remembers trusting the home
 * folder and asks again on every start, while this folder is trusted once per host.
 * Created on the target if missing.
 */
export const DEFAULT_AGENT_DIR = "~/bridge-agents";

// `cd` into dir. A leading ~ stays unquoted so the TARGET machine's shell expands it
// (a remote host's home differs from ours); the rest is single-quoted.
export function cdCommand(dir: string): string {
  if (dir === "~") return "cd ~";
  if (dir === DEFAULT_AGENT_DIR) return `mkdir -p ${DEFAULT_AGENT_DIR} && cd ${DEFAULT_AGENT_DIR}`;
  if (dir.startsWith("~/")) return `cd ~/${shSingleQuote(dir.slice(2))}`;
  return `cd ${shSingleQuote(dir)}`;
}

export function buildAgentCommand(req: SpawnRequest): AgentCommand {
  const prompt = buildStartupPrompt(req);
  // `pi`, `claude` and `codex` all take the prompt as a positional arg and start an INTERACTIVE
  // session by default (no -p), so the spawned agent stays alive to report back.
  const argv = [
    ...(req.launcher?.length ? req.launcher : [req.tool]),
    ...modelArgs(req.tool, req.model, req.thinking),
    prompt,
  ];
  const shell = `${argv[0]} ${argv.slice(1).map(shSingleQuote).join(" ")}`;
  const host = req.host?.trim() || undefined;
  const cwd = req.cwd?.trim() || (host ? DEFAULT_AGENT_DIR : undefined);
  if (!cwd) return { argv, shell, prompt, label: req.name, host };
  // argv-based spawners (rex, zellij) get a tiny sh wrapper so the cd (and ~) happens on
  // the target; the prompt still travels as a separate arg, never re-parsed by a shell.
  const cd = cdCommand(cwd);
  return {
    argv: ["sh", "-c", `${cd} && exec "$@"`, "sh", ...argv],
    shell: `${cd} && ${shell}`,
    prompt,
    label: req.name,
    cwd,
    host,
  };
}
