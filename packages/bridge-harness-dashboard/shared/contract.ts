// HTTP + SSE contract between the dashboard API (web/api) and the UI (web/ui).
// Both sides import this file; change it here first, then both implementations.
//
// All routes are served under /api by the Watt gateway. Every route except
// POST /api/login requires auth: either `Authorization: Bearer <token>` or the
// `bh_session` cookie that /api/login sets. Unauthorized → 401 { error }.

/** How fresh an agent's last heartbeat is. Same thresholds as the Claude/Pi panes. */
export type Liveness = 'live' | 'stale'; // live: < 60s since lastSeen; stale: 60s..5min. Dropped after 5min.

export type AgentKind = 'claude' | 'pi' | 'codex' | 'human' | 'other'; // from the agentId prefix: claude-code-*, pi-*, codex-*, dashboard-*

export interface AgentView {
  agentId: string;
  displayName: string;
  kind: AgentKind;
  project?: string; // bridge namespace = worktree folder name; may be a branch-like name
  repo?: string; // real repository name, shared by all its worktrees (older agents omit it)
  branch?: string;
  activity?: 'working' | 'idle' | 'waiting'; // in a turn, between turns, or blocked on a prompt for the user; absent for older agents
  pane?: string; // Rex block id of the agent's terminal; lets the board read and answer its prompt
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

// ── GET /api/transcript?agentId=<id>&before=<timestamp>&limit=<n≤500> ─────────
// The agent's own conversation (user prompts + assistant replies, no tool calls),
// streamed on bridge.transcript.<agentId>. Newest last; the last 500 lines per agent
// are kept for the message retention period.
export interface TranscriptLine {
  id: string;
  agentId: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface TranscriptResponse {
  lines: TranscriptLine[];
  hasMore: boolean;
}

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

// ── POST /api/spawn  { tool, name, task, cwd?, host?, model?, thinking? } → SpawnResponse ──
// Spawns on the machine running the dashboard, or on a Rex host (`host`, one of
// GET /api/hosts). `cwd` is the start directory on that machine (~ allowed).
// The new agent DMs the dashboard.
export interface SpawnRequest {
  tool: 'pi' | 'claude' | 'codex';
  name: string;
  task: string;
  cwd?: string;
  host?: string;
  /** Model to run; default SPAWN_MODELS[tool]. */
  model?: string;
  /** One of SPAWN_THINKING[tool]; default: the CLI's own. */
  thinking?: string;
}
// Mirrors src/spawn/command.ts DEFAULT_MODELS / THINKING_LEVELS (the API rejects others).
export const SPAWN_MODELS: Record<SpawnRequest['tool'], string> = {
  claude: 'claude-opus-5-5',
  pi: 'openai-codex/auto',
  codex: 'gpt-6.2-sol',
};
// Models the spawn dialog offers per agent; the default comes first.
export const SPAWN_MODEL_CHOICES: Record<SpawnRequest['tool'], readonly string[]> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
  pi: [
    'openai-codex/auto', 'openai-codex/gpt-6.2-sol', 'openai-codex/gpt-6.2-astra', 'openai-codex/gpt-6.1-sol',
    'openai-codex/gpt-6.1-terra', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5',
    'anthropic/claude-haiku-5-5', 'anthropic/claude-fable-5-2',
  ],
  codex: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'],
};
export const SPAWN_THINKING: Record<SpawnRequest['tool'], readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};
// ── GET /api/dirs?host=&path=&prefix= → DirsResponse — directories to browse for `cwd` ──
// `path` defaults to "~"; `prefix` filters names (hidden ones show only for a "." prefix).
// 502 when the host cannot be asked (e.g. it has no open Rex session).
export interface DirsResponse {
  /** Absolute path listed. */
  path: string;
  /** Home directory on that machine, to show paths as ~/… */
  home: string;
  exists: boolean;
  dirs: string[];
  truncated: boolean;
}
// ── GET /api/hosts → HostsResponse — Rex hosts usable as spawn targets ────────
export interface HostsResponse {
  hosts: string[];
}
// ── GET /api/pane/:agentId → PaneScreen — the agent's terminal as text (Rex only) ──
// ── POST /api/pane/:agentId  PaneInput → { ok } — type into it, as if at the keyboard ──
// ── POST /api/pane/:agentId/close → { ok } — shut an idle agent down by closing its pane ──
// 404 when the agent has no Rex pane, 502 when Rex cannot reach it, 409 (close only)
// unless the agent is idle. A closed agent leaves the roster at once.
export interface PaneScreen {
  text: string; // last lines of screen + scrollback, trimmed
  server?: string; // Rex host label when the pane lives on another machine
}
/** Text is typed first, then keys are pressed in order. Keys are a fixed set. */
export interface PaneInput {
  text?: string;
  keys?: PaneKey[];
}
export const PANE_KEYS = ['enter', 'esc', 'up', 'down', 'left', 'right', 'tab', 'shift+tab', 'space', 'backspace', 'ctrl+c', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export type PaneKey = (typeof PANE_KEYS)[number];

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
  | { type: 'history'; event: HistoryEvent }
  | { type: 'transcript'; line: TranscriptLine };

export interface ErrorResponse {
  error: string;
}

export function threadKey(ref: ThreadRef): ThreadKey {
  return ref.kind === 'room'
    ? `room:${ref.project}/${ref.room}`
    : `dm:${ref.agentId}`;
}
