export interface RegistryEvent {
  // who-there: active discovery query. here: identity response carrying full presence.
  type: "join" | "leave" | "room-join" | "room-leave" | "who-there" | "here";
  agentId: string;
  displayName: string;
  // The agent's project (git worktree). Discovery is global, so this tells you
  // WHERE each agent is even though you can reach them by ID regardless.
  project?: string;
  // Machine the agent runs on (see getHost).
  host?: string;
  // Real repository name and branch (see getRepoInfo); `project` may be a worktree folder.
  repo?: string;
  branch?: string;
  // Root of the agent's checkout and its working directory (absolute paths on its host).
  worktree?: string;
  cwd?: string;
  room?: string;
  // Present on "here" responses: every room the responder is in.
  rooms?: string[];
  // Memorable DM handles (set via set_name) this agent also answers to. Carried on
  // "join"/"here" so peers can resolve `agent:<alias>` to a live recipient.
  aliases?: string[];
  timestamp: number;
}

/** In a turn, between turns, or blocked on a prompt only the user can answer. */
export type Activity = "working" | "idle" | "waiting";

export interface AgentPresence {
  agentId: string;
  displayName: string;
  project?: string;
  host?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  cwd?: string;
  activity?: Activity;
  /** Rex block (terminal pane) the agent runs in, so a viewer can read and answer its prompts. */
  pane?: string;
  task?: string;
  model?: string;
  thinking?: string;
  ctxTokens?: number;
  ctxWindow?: number;
  rooms: Set<string>;
  // Memorable DM handles this agent also answers to (from set_name).
  aliases: Set<string>;
  joinedAt: number;
  lastSeen: number;
}
