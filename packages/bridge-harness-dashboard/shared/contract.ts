// HTTP + SSE contract between the dashboard API (web/api) and the UI (web/ui).
// Both sides import this file; change it here first, then both implementations.
//
// All routes are served under /api by the Watt gateway. Every route except
// POST /api/login requires auth: either `Authorization: Bearer <token>` or the
// `bh_session` cookie that /api/login sets. Unauthorized → 401 { error }.

/** How fresh an agent's last heartbeat is. Same thresholds as the Claude/Pi panes. */
export type Liveness = 'live' | 'stale'; // live: < 60s since lastSeen; stale: 60s..5min. Dropped after 5min.

export type AgentKind = 'claude' | 'pi' | 'human' | 'other'; // from the agentId prefix: claude-code-*, pi-*, dashboard-*

export interface AgentView {
  agentId: string;
  displayName: string;
  kind: AgentKind;
  project?: string; // bridge namespace = worktree folder name; may be a branch-like name
  repo?: string; // real repository name, shared by all its worktrees (older agents omit it)
  branch?: string;
  activity?: 'working' | 'idle'; // in a turn right now; absent for agents that predate the signal
  host?: string;
  task?: string;
  rooms: string[];
  aliases: string[];
  joinedAt: number; // ms epoch, first time the dashboard saw it
  lastSeen: number; // ms epoch
  liveness: Liveness;
}

/** A thread is either a room (project-scoped) or a DM conversation with one agent. */
export type ThreadRef =
  | { kind: 'room'; project: string; room: string }
  | { kind: 'dm'; agentId: string }; // DMs between the dashboard and that agent

/** Stable string key for a thread: "room:<project>/<room>" or "dm:<agentId>". */
export type ThreadKey = string;

export interface ChatMessage {
  id: string; // server-assigned, unique, monotonic within the process
  thread: ThreadKey;
  from: string; // agentId of sender (the dashboard's own id for messages it sent)
  to: string; // "room:<room>" or "agent:<id>"
  content: string;
  timestamp: number;
}

export type HistoryKind =
  | 'join'
  | 'leave'
  | 'stale'
  | 'drop'
  | 'back'
  | 'rename'
  | 'task'
  | 'room-join'
  | 'room-leave';

export interface HistoryEvent {
  id: string;
  kind: HistoryKind;
  agentId: string;
  displayName: string;
  project?: string;
  detail?: string; // e.g. new name, new task, room name
  timestamp: number;
}

export interface BridgeStatus {
  connected: boolean;
  natsUrl: string; // credentials stripped
  error?: string; // last connection error, when disconnected
  self: {
    agentId: string;
    displayName: string;
    project: string;
    status?: string;
  };
  startedAt: number;
}

// ── GET /api/state ─────────────────────────────────────────────────────────────
// Full snapshot. The UI loads this first, then applies SSE deltas.
export interface StateResponse {
  status: BridgeStatus;
  agents: AgentView[]; // live + stale; dropped agents are absent
  projects: string[]; // every project seen in the roster, sorted
  threads: ThreadSummary[];
}

export interface ThreadSummary {
  key: ThreadKey;
  ref: ThreadRef;
  lastMessageAt?: number;
  messageCount: number;
  unread: number; // server-side count since last POST /api/threads/read
}

// ── GET /api/threads/messages?key=<ThreadKey>&before=<id>&limit=<n≤200> ────────
// Newest last. Rooms are only captured while the dashboard is subscribed (rooms are
// not persisted on NATS); DMs backfill from the BRIDGE_DM JetStream stream (30min).
export interface MessagesResponse {
  messages: ChatMessage[];
  hasMore: boolean;
}

// ── POST /api/threads/read  { key } → { ok: true } ─────────────────────────────

// ── GET /api/history?since=<ms>&agentId=<id>&limit=<n≤1000> ───────────────────
// Newest last. Kept in memory and appended to a JSONL file (BRIDGE_DASHBOARD_DATA dir).
export interface HistoryResponse {
  events: HistoryEvent[];
}

// ── POST /api/send  { to: "agent:<id>" | "room:<room>", message } ─────────────
// Rooms are in the dashboard's current project (see /api/project). Echoes the stored
// message so the UI can reconcile its optimistic copy.
export interface SendRequest {
  to: string;
  message: string;
}
export interface SendResponse {
  ok: true;
  message: ChatMessage;
  warning?: string;
} // warning: recipient not visible

// ── POST /api/self  { name?, status? } → { ok: true, self } ───────────────────
// Renames the dashboard's own bridge identity (set_name) and/or its one-line task.
export interface SelfRequest {
  name?: string;
  status?: string;
}

// ── POST /api/project  { project } → { ok: true, project } ────────────────────
// Switches which project's rooms the dashboard subscribes to (use_bridge). DMs and
// the roster are global and unaffected.

// ── POST /api/spawn  { tool, name, task } → SpawnResponse ─────────────────────
// Spawns on the machine running the dashboard. The new agent DMs the dashboard.
export interface SpawnRequest {
  tool: 'pi' | 'claude';
  name: string;
  task: string;
}
export interface SpawnResponse {
  spawned: boolean;
  detail: string;
  manualCommand?: string;
}

// ── POST /api/login  { token } → sets bh_session cookie (HttpOnly, SameSite=Strict) ─
// 401 on a wrong token. POST /api/logout clears it.

// ── GET /api/events  (text/event-stream) ──────────────────────────────────────
// One SSE event per change. `event:` is the type, `data:` the JSON payload. A
// `: ping` comment every 15s keeps proxies open. On reconnect the UI refetches /api/state.
export type ServerEvent =
  | { type: 'status'; status: BridgeStatus }
  | { type: 'agent'; agent: AgentView } // upsert (new, changed, liveness flip)
  | { type: 'agent-drop'; agentId: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'thread'; thread: ThreadSummary } // counts / unread changed
  | { type: 'history'; event: HistoryEvent };

export interface ErrorResponse {
  error: string;
}

export function threadKey(ref: ThreadRef): ThreadKey {
  return ref.kind === 'room'
    ? `room:${ref.project}/${ref.room}`
    : `dm:${ref.agentId}`;
}
