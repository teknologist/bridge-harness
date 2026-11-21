import type { AgentPresence } from "./types.js";

export interface PresenceEvent {
  agent: string;
  status: string;
  project?: string;
  host?: string;
  /** Real repository name and current branch; `project` may be a worktree folder name. */
  repo?: string;
  branch?: string;
  /** Whether the agent is in a turn right now; absent from agents that predate it. */
  activity?: "working" | "idle";
  /** One-line summary of what the agent is doing; absent means none (clears a previous one). */
  task?: string;
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
    if (event.activity) existing.activity = event.activity;
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
    activity: event.activity,
    task: event.task,
    rooms: new Set(),
    aliases: new Set(),
    joinedAt: now,
    lastSeen: now,
  });
  return true;
}
