import type { Activity, AgentPresence } from "./types.js";

export interface PresenceEvent {
  agent: string;
  status: string;
  project?: string;
  host?: string;
  /** Real repository name and current branch; `project` may be a worktree folder name. */
  repo?: string;
  branch?: string;
  /** Root of the agent's checkout and its working directory, on its host. */
  worktree?: string;
  cwd?: string;
  /** Whether the agent is in a turn right now; absent from agents that predate it. */
  activity?: Activity;
  /** Rex block id of the agent's terminal pane; absent outside Rex. */
  pane?: string;
  /** One-line summary of what the agent is doing; absent means none (clears a previous one). */
  task?: string;
  /** Model, thinking level and context fill; absent from agents that predate them. */
  model?: string;
  thinking?: string;
  ctxTokens?: number;
  ctxWindow?: number;
}

/**
 * Fold one presence heartbeat into the roster.
 *
 * Presence is a global broadcast, so an agent receives its OWN heartbeats. `self` must be
 * passed so they can be dropped: otherwise the agent invents a roster entry for itself
 * whose `rooms` stays empty forever — room membership only arrives via registry events,
 * and those already filter self. The visible symptom was `list_agents` reporting this
 * agent as being in no rooms while `whoami` correctly listed them.
 *
 * Pure apart from mutating the roster it is handed, so it can be unit-tested directly.
 * Returns true when the roster changed.
 */
export function applyPresenceEvent(
  roster: Map<string, AgentPresence>,
  event: PresenceEvent,
  self: string,
  now: number = Date.now()
): boolean {
  if (event.agent === self) return false;

  if (event.status === "offline") {
    return roster.delete(event.agent);
  }

  const existing = roster.get(event.agent);
  if (existing) {
    existing.lastSeen = now;
    if (event.project) existing.project = event.project;
    if (event.host) existing.host = event.host;
    if (event.repo) existing.repo = event.repo;
    if (event.branch) existing.branch = event.branch;
    if (event.worktree) existing.worktree = event.worktree;
    if (event.cwd) existing.cwd = event.cwd;
    if (event.activity) existing.activity = event.activity;
    if (event.pane) existing.pane = event.pane;
    if (event.model) {
      existing.model = event.model;
      existing.thinking = event.thinking;
      existing.ctxTokens = event.ctxTokens;
      existing.ctxWindow = event.ctxWindow;
    }
    existing.task = event.task;
    return true;
  }

  // First time we hear from this agent. Rooms/aliases stay empty until a registry event
  // fills them in; a heartbeat carries no membership information.
  roster.set(event.agent, {
    agentId: event.agent,
    displayName: event.agent,
    project: event.project,
    host: event.host,
    repo: event.repo,
    branch: event.branch,
    worktree: event.worktree,
    cwd: event.cwd,
    activity: event.activity,
    pane: event.pane,
    task: event.task,
    model: event.model,
    thinking: event.thinking,
    ctxTokens: event.ctxTokens,
    ctxWindow: event.ctxWindow,
    rooms: new Set(),
    aliases: new Set(),
    joinedAt: now,
    lastSeen: now,
  });
  return true;
}
