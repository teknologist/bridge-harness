import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  History as HistoryIcon,
  LogOut,
  MessagesSquare,
  Pencil,
  Plus,
  Rows3,
  SendHorizontal,
  X,
} from 'lucide-preact';
import type {
  AgentView,
  ChatMessage,
  HistoryEvent,
  ThreadSummary,
} from '../../../shared/contract.ts';
import { threadKey } from '../../../shared/contract.ts';
import { api } from './api.ts';
import { Flap } from './flap.tsx';
import { useBoard, type BoardState } from './store.ts';

type View = 'board' | 'threads' | 'history';
const ALL = '*';

// ── time helpers ────────────────────────────────────────────────────────────

function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function ago(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const day = (ts: number) =>
  new Date(ts).toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

const kindLabel: Record<AgentView['kind'], string> = {
  claude: 'Claude Code',
  pi: 'Pi',
  human: 'Operator',
  other: 'Agent',
};

/** Tasks arrive truncated or carrying hook noise; show a clean one-liner. */
function cleanTask(task?: string) {
  if (!task) return '';
  if (task.trim().startsWith('<')) return '';
  return task.replace(/\s+/g, ' ').trim();
}

// ── root ────────────────────────────────────────────────────────────────────

export function App() {
  const board = useBoard();
  const { state } = board;

  if (state.auth === 'checking')
    return <Splash text={state.loadError ?? 'Connecting to the dashboard'} />;
  if (state.auth === 'needed') return <Login onLogin={board.login} />;
  return <Shell board={board} />;
}

function Splash({ text }: { text: string }) {
  return (
    <main class="splash">
      <p class="label">{text}</p>
    </main>
  );
}

function Login({ onLogin }: { onLogin: (token: string) => Promise<void> }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onLogin(token.trim());
    } catch (err) {
      setError(
        err instanceof Error && err.message !== 'Session expired'
          ? err.message
          : 'That token was not accepted.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="splash">
      <form class="login" onSubmit={submit}>
        <h1 class="brand">Bridge board</h1>
        <p class="muted">
          Paste the dashboard token, the value of BRIDGE_DASHBOARD_TOKEN on the
          machine running it.
        </p>
        <label class="field">
          <span class="label">Token</span>
          <input
            type="password"
            autocomplete="current-password"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            required
            autofocus
          />
        </label>
        {error ? (
          <p class="error" role="alert">
            {error}
          </p>
        ) : null}
        <button class="btn btn--primary" disabled={busy || !token.trim()}>
          {busy ? 'Checking' : 'Open the board'}
        </button>
      </form>
    </main>
  );
}

// ── shell ───────────────────────────────────────────────────────────────────

type Board = ReturnType<typeof useBoard>;

function Shell({ board }: { board: Board }) {
  const { state } = board;
  const now = useNow();
  const [view, setView] = useState<View>('board');
  const [project, setProject] = useState<string>(ALL);
  const [open, setOpen] = useState<string>(); // thread key in the drawer
  const [dialog, setDialog] = useState<'spawn' | 'self'>();

  const agents = useMemo(() => Object.values(state.agents), [state.agents]);
  const projects = useMemo(
    () =>
      [
        ...new Set(
          agents.map(repoOf).filter((p): p is string => !!p)
        ),
      ].sort(),
    [agents]
  );

  useEffect(() => {
    if (open) void board.openThread(open).catch(() => undefined);
  }, [open]);

  function openAgent(a: AgentView) {
    board.markSeen(a.agentId);
    setOpen(threadKey({ kind: 'dm', agentId: a.agentId }));
  }

  const status = state.status;
  const down = !state.streamUp || !status?.connected;

  return (
    <div class={`shell ${open ? 'shell--drawer' : ''}`}>
      <header class="topbar">
        <div class="topbar__brand">
          <span class="brand">Bridge board</span>
          <NatsLamp state={state} />
        </div>
        <nav class="tabs" aria-label="Views">
          <TabButton
            on={view === 'board'}
            onClick={() => setView('board')}
            icon={<Rows3 size={16} />}
          >
            Board
          </TabButton>
          <TabButton
            on={view === 'threads'}
            onClick={() => setView('threads')}
            icon={<MessagesSquare size={16} />}
          >
            Threads
            <UnreadTotal threads={state.threads} />
          </TabButton>
          <TabButton
            on={view === 'history'}
            onClick={() => setView('history')}
            icon={<HistoryIcon size={16} />}
          >
            History
          </TabButton>
        </nav>
        <div class="topbar__self">
          <button
            class="btn btn--ghost"
            onClick={() => setDialog('self')}
            title="Rename the dashboard or set its status"
          >
            <span class="self__name">
              {status?.self.displayName ?? 'Dashboard'}
            </span>
            <Pencil size={14} />
          </button>
          <button class="btn btn--primary" onClick={() => setDialog('spawn')}>
            <Plus size={16} />
            <span>Spawn agent</span>
          </button>
          <button
            class="btn btn--icon"
            onClick={board.logout}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {down ? (
        <div class="banner" role="status">
          {!state.streamUp
            ? 'Live updates paused. Reconnecting to the dashboard; the board shows the last known state.'
            : `The dashboard lost NATS at ${status?.natsUrl}${status?.error ? `: ${status.error}` : ''}. Retrying.`}
        </div>
      ) : null}

      <main class="work">
        {view === 'history' ? (
          <HistoryBoard
            events={state.history}
            agents={state.agents}
            now={now}
          />
        ) : (
          <>
            {view === 'board' ? (
              <ProjectTabs
                projects={projects}
                agents={agents}
                value={project}
                onChange={setProject}
              />
            ) : null}
            {view === 'board' ? (
              <AgentBoard
                agents={agents}
                project={project}
                state={state}
                now={now}
                selected={open}
                onOpen={openAgent}
              />
            ) : (
              <ThreadList state={state} selected={open} onOpen={setOpen} />
            )}
          </>
        )}
        {open && view !== 'history' ? (
          <Drawer
            key={open}
            threadKeyValue={open}
            state={state}
            now={now}
            onClose={() => setOpen(undefined)}
          />
        ) : null}
      </main>

      {dialog === 'spawn' ? (
        <SpawnDialog onClose={() => setDialog(undefined)} />
      ) : null}
      {dialog === 'self' ? (
        <SelfDialog state={state} onClose={() => setDialog(undefined)} />
      ) : null}
    </div>
  );
}

function TabButton(props: {
  on: boolean;
  onClick: () => void;
  icon: JSX.Element;
  children: preact.ComponentChildren;
}) {
  return (
    <button
      class={`tab ${props.on ? 'tab--on' : ''}`}
      aria-current={props.on ? 'page' : undefined}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.children}</span>
    </button>
  );
}

function UnreadTotal({ threads }: { threads: Record<string, ThreadSummary> }) {
  const n = Object.values(threads).reduce((sum, t) => sum + t.unread, 0);
  return n > 0 ? <span class="count count--mail">{n}</span> : null;
}

function NatsLamp({ state }: { state: BoardState }) {
  const ok = state.streamUp && state.status?.connected;
  return (
    <span
      class={`lamp-pill ${ok ? 'lamp-pill--ok' : 'lamp-pill--down'}`}
      title={state.status?.natsUrl}
    >
      <span class="lamp" />
      {ok ? 'NATS live' : 'Reconnecting'}
    </span>
  );
}

// ── board ───────────────────────────────────────────────────────────────────

/** Real repository an agent works in; older agents only report their worktree folder. */
/** Board order: working first, then idle or unknown, then stale. */
function rank(a: AgentView): number {
  if (a.liveness === 'stale') return 2;
  return a.activity === 'working' ? 0 : 1;
}

function statusOf(a: AgentView): { label: string; tone: 'live' | 'stale' | 'muted' } {
  if (a.liveness === 'stale') return { label: 'STALE', tone: 'stale' };
  if (a.activity === 'working') return { label: 'WORKING', tone: 'live' };
  if (a.activity === 'idle') return { label: 'IDLE', tone: 'muted' };
  return { label: 'LIVE', tone: 'muted' }; // agent predates the activity signal
}

function repoOf(a: AgentView): string | undefined {
  return a.repo ?? a.project;
}

/** Branch, plus the worktree folder when it is not just the repo checkout itself. */
function whereOf(a: AgentView): string {
  const tree = a.repo && a.project && a.project !== a.repo ? a.project : undefined;
  return [a.branch, tree && tree !== a.branch?.replace(/\//g, '-') ? `in ${tree}` : undefined]
    .filter(Boolean)
    .join(' ');
}

function ProjectTabs(props: {
  projects: string[];
  agents: AgentView[];
  value: string;
  onChange: (p: string) => void;
}) {
  const count = (p: string) =>
    props.agents.filter((a) => p === ALL || repoOf(a) === p).length;
  return (
    <div class="projects" role="tablist" aria-label="Filter by project">
      {[ALL, ...props.projects].map((p) => (
        <button
          role="tab"
          aria-selected={props.value === p}
          class={`chip ${props.value === p ? 'chip--on' : ''}`}
          onClick={() => props.onChange(p)}
        >
          {p === ALL ? 'All projects' : p}
          <span class="chip__n">{count(p)}</span>
        </button>
      ))}
    </div>
  );
}

function AgentBoard(props: {
  agents: AgentView[];
  project: string;
  state: BoardState;
  now: number;
  selected?: string;
  onOpen: (a: AgentView) => void;
}) {
  const { state, now } = props;
  const self = state.status?.self.agentId;
  const openAgentId = props.selected?.startsWith('dm:')
    ? props.selected.slice(3)
    : undefined;
  const rows = props.agents
    .filter((a) => props.project === ALL || repoOf(a) === props.project)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (repoOf(a) ?? '').localeCompare(repoOf(b) ?? '') ||
        (a.project ?? '').localeCompare(b.project ?? '') ||
        a.agentId.localeCompare(b.agentId)
    );

  const working = rows.filter((a) => rank(a) === 0).length;
  const stale = rows.filter((a) => rank(a) === 2).length;
  const idle = rows.filter((a) => rank(a) === 1 && a.activity === 'idle').length;
  const unknown = rows.length - working - stale - idle; // agents without the signal yet

  if (props.agents.length === 0) {
    return (
      <section class="board board--empty">
        <h2 class="board__title">No agents on the bridge</h2>
        <p class="muted">
          Nothing has sent a heartbeat in the last five minutes. Start Claude
          Code or Pi with the bridge enabled, or spawn one from here.
        </p>
      </section>
    );
  }

  return (
    <section class="board" aria-label="Agents">
      <div class="board__head">
        <h2 class="board__title">Departures</h2>
        <p class="board__counts">
          <b>{working}</b> working · <b>{idle}</b> idle
          {unknown > 0 && (
            <>
              {' '}
              · <b>{unknown}</b> live
            </>
          )}{' '}
          · <b>{stale}</b> stale
        </p>
      </div>
      <table class="rows">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Project</th>
            <th scope="col" class="col-host">
              Host
            </th>
            <th scope="col">Task</th>
            <th scope="col" class="num">
              Seen
            </th>
            <th scope="col">Status</th>
            <th scope="col" class="num">
              Mail
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const key = threadKey({ kind: 'dm', agentId: a.agentId });
            const unread = state.threads[key]?.unread ?? 0;
            const pending = new Set(
              openAgentId === a.agentId ? [] : (state.unseen[a.agentId] ?? [])
            );
            const isSelf = a.agentId === self;
            return (
              <tr
                class={`row row--${a.kind} ${a.liveness === 'stale' ? 'row--stale' : ''} ${rank(a) === 0 ? 'row--working' : ''} ${props.selected === key ? 'row--on' : ''}`}
                onClick={() => !isSelf && props.onOpen(a)}
              >
                <th scope="row" class="cell-agent">
                  <span
                    class={`kind kind--${a.kind}`}
                    title={kindLabel[a.kind]}
                  />
                  <span class="agent">
                    <button
                      class="agent__id"
                      disabled={isSelf}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onOpen(a);
                      }}
                    >
                      {a.agentId}
                    </button>
                    <Flap
                      class="agent__name"
                      tone="muted"
                      value={isSelf ? 'you' : a.displayName}
                      pending={pending.has('displayName')}
                    />
                  </span>
                </th>
                <td class="cell-project">
                  <span class="where__repo">{repoOf(a) ?? '·'}</span>
                  {whereOf(a) && <span class="where__tree">{whereOf(a)}</span>}
                </td>
                <td class="cell-host col-host">{a.host ?? '·'}</td>
                <td class="cell-task">
                  <Flap
                    value={cleanTask(a.task) || '·'}
                    pending={pending.has('task')}
                  />
                </td>
                <td class="num cell-seen">{ago(a.lastSeen, now)}</td>
                <td>
                  <Flap
                    class="status"
                    tone={statusOf(a).tone}
                    value={statusOf(a).label}
                    pending={pending.has('liveness')}
                  />
                </td>
                <td class="num">
                  {unread > 0 ? (
                    <Flap
                      class="mail"
                      tone="mail"
                      value={String(unread)}
                      pending={pending.has('mail')}
                    />
                  ) : (
                    <span class="muted">·</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ── threads ─────────────────────────────────────────────────────────────────

function threadTitle(t: ThreadSummary, agents: Record<string, AgentView>) {
  if (t.ref.kind === 'room') return `#${t.ref.room}`;
  const a = agents[t.ref.agentId];
  return a ? `${a.agentId}` : t.ref.agentId;
}

function ThreadList(props: {
  state: BoardState;
  selected?: string;
  onOpen: (key: string) => void;
}) {
  const list = Object.values(props.state.threads).sort(
    (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)
  );
  if (list.length === 0) {
    return (
      <section class="board board--empty">
        <h2 class="board__title">No threads yet</h2>
        <p class="muted">
          Rooms appear once someone posts while the dashboard listens. Open an
          agent on the board to start a direct thread.
        </p>
      </section>
    );
  }
  return (
    <section class="board" aria-label="Threads">
      <div class="board__head">
        <h2 class="board__title">Threads</h2>
        <p class="board__counts">
          Rooms in <b>{props.state.status?.self.project}</b> · direct messages
          from every project
        </p>
      </div>
      <ul class="threads">
        {list.map((t) => (
          <li>
            <button
              class={`thread ${props.selected === t.key ? 'thread--on' : ''}`}
              onClick={() => props.onOpen(t.key)}
            >
              <span
                class={`kind kind--${t.ref.kind === 'dm' ? (props.state.agents[t.ref.agentId]?.kind ?? 'other') : 'room'}`}
              />
              <span class="thread__title">
                {threadTitle(t, props.state.agents)}
              </span>
              <span class="thread__meta">
                {t.ref.kind === 'room'
                  ? t.ref.project
                  : (props.state.agents[t.ref.agentId]?.project ?? 'offline')}
              </span>
              <span class="num thread__when">
                {t.lastMessageAt ? clock(t.lastMessageAt) : ''}
              </span>
              {t.unread > 0 ? (
                <span class="count count--mail">{t.unread}</span>
              ) : (
                <span />
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Drawer(props: {
  threadKeyValue: string;
  state: BoardState;
  now: number;
  onClose: () => void;
}) {
  const { state } = props;
  const key = props.threadKeyValue;
  const isDm = key.startsWith('dm:');
  const peerId = isDm ? key.slice(3) : undefined;
  const peer = peerId ? state.agents[peerId] : undefined;
  const room = !isDm ? key.slice(key.indexOf('/') + 1) : undefined;
  const to = isDm ? `agent:${peerId}` : `room:${room}`;
  const messages = state.messages[key];
  const self = state.status?.self.agentId;
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages?.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <aside
      class="drawer"
      aria-label={isDm ? `Direct thread with ${peerId}` : `Room ${room}`}
    >
      <header class="drawer__head">
        <div>
          <h2 class="drawer__title">{isDm ? peerId : `#${room}`}</h2>
          <p class="muted drawer__meta">
            {isDm
              ? peer
                ? `${peer.displayName} · ${[repoOf(peer) ?? 'no project', whereOf(peer)].filter(Boolean).join(' ')} · ${peer.host ?? 'unknown host'} · ${
                    peer.liveness === 'live'
                      ? `live, seen ${ago(peer.lastSeen, props.now)} ago`
                      : `stale, seen ${ago(peer.lastSeen, props.now)} ago`
                  }`
                : 'Not on the bridge right now. Messages still queue for 30 minutes.'
              : `Room in ${key.slice(5, key.indexOf('/'))}. Only captured while the dashboard listens.`}
          </p>
          {peer && cleanTask(peer.task) ? (
            <p class="drawer__task">{cleanTask(peer.task)}</p>
          ) : null}
        </div>
        <button
          class="btn btn--icon"
          onClick={props.onClose}
          aria-label="Close thread"
        >
          <X size={18} />
        </button>
      </header>
      <ol class="messages" ref={list}>
        {messages === undefined ? (
          <li class="muted">Loading the thread</li>
        ) : messages.length === 0 ? (
          <li class="muted messages__empty">
            {isDm
              ? 'No messages with this agent yet. Say something below.'
              : 'Nothing posted since the dashboard joined.'}
          </li>
        ) : (
          messages.map((m) => <Message m={m} mine={m.from === self} />)
        )}
      </ol>
      <Composer to={to} disabled={!state.status?.connected} />
    </aside>
  );
}

function Message({ m, mine }: { m: ChatMessage; mine: boolean }) {
  return (
    <li class={`msg ${mine ? 'msg--mine' : ''}`}>
      <div class="msg__head">
        <span class="msg__from">
          {mine ? 'you' : m.from}
          <span class="msg__to"> → {m.to.replace(/^agent:/, '')}</span>
        </span>
        <time class="num" dateTime={new Date(m.timestamp).toISOString()}>
          {clock(m.timestamp)}
        </time>
      </div>
      <p class="msg__body">{m.content}</p>
    </li>
  );
}

function Composer({ to, disabled }: { to: string; disabled: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'error' | 'warn'; text: string }>();

  async function send() {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setNote(undefined);
    try {
      const res = await api.send(to, message);
      setText('');
      if (res.warning) setNote({ tone: 'warn', text: res.warning });
    } catch (err) {
      setNote({
        tone: 'error',
        text: `Not sent: ${err instanceof Error ? err.message : String(err)}. Your text is still here.`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {note ? (
        <p class={note.tone === 'error' ? 'error' : 'warn'} role="status">
          {note.text}
        </p>
      ) : null}
      <div class="composer__row">
        <textarea
          rows={2}
          value={text}
          placeholder={
            disabled
              ? 'NATS is down; sending resumes when it reconnects'
              : `Message ${to.replace(/^agent:|^room:/, '')}`
          }
          aria-label={`Message to ${to}`}
          disabled={disabled}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          class="btn btn--primary"
          disabled={disabled || busy || !text.trim()}
        >
          <SendHorizontal size={16} />
          <span>{busy ? 'Sending' : 'Send'}</span>
        </button>
      </div>
    </form>
  );
}

// ── history ─────────────────────────────────────────────────────────────────

const historyVerb: Record<HistoryEvent['kind'], string> = {
  join: 'Joined',
  leave: 'Left',
  stale: 'Went stale',
  drop: 'Dropped',
  back: 'Back',
  rename: 'Renamed',
  task: 'Task',
  'room-join': 'Joined room',
  'room-leave': 'Left room',
};

const historyTone: Partial<
  Record<HistoryEvent['kind'], 'live' | 'stale' | 'mail'>
> = {
  join: 'live',
  back: 'live',
  stale: 'stale',
  drop: 'stale',
  leave: 'stale',
};

function HistoryBoard(props: {
  events: HistoryEvent[];
  agents: Record<string, AgentView>;
  now: number;
}) {
  const days = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < 7; i++) out.push(day(props.now - i * 86_400_000));
    return out;
  }, [Math.floor(props.now / 86_400_000)]);
  const [selected, setSelected] = useState(days[0]);
  const [kinds, setKinds] = useState<'all' | 'presence' | 'work'>('all');

  const rows = props.events
    .filter((e) => day(e.timestamp) === selected)
    .filter((e) =>
      kinds === 'all'
        ? true
        : kinds === 'presence'
          ? ['join', 'leave', 'stale', 'drop', 'back'].includes(e.kind)
          : ['rename', 'task', 'room-join', 'room-leave'].includes(e.kind)
    )
    .slice()
    .reverse();

  return (
    <section class="board board--history" aria-label="History">
      <div class="board__head">
        <h2 class="board__title">Arrivals and departures</h2>
        <div class="filters">
          <div class="projects" role="tablist" aria-label="Day">
            {days.map((d, i) => (
              <button
                role="tab"
                aria-selected={selected === d}
                class={`chip ${selected === d ? 'chip--on' : ''}`}
                onClick={() => setSelected(d)}
              >
                {i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d}
              </button>
            ))}
          </div>
          <select
            class="select"
            value={kinds}
            onChange={(e) => setKinds(e.currentTarget.value as typeof kinds)}
            aria-label="Event type"
          >
            <option value="all">All events</option>
            <option value="presence">Presence only</option>
            <option value="work">Names, tasks and rooms</option>
          </select>
        </div>
      </div>
      {rows.length === 0 ? (
        <p class="muted board--empty">
          No events on this day. The dashboard records history only while it
          runs.
        </p>
      ) : (
        <table class="rows rows--history">
          <thead>
            <tr>
              <th scope="col" class="num">
                Time
              </th>
              <th scope="col">Event</th>
              <th scope="col">Agent</th>
              <th scope="col">Project</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr class="row">
                <td class="num">{clock(e.timestamp)}</td>
                <td>
                  <span
                    class={`flap tag flap--${historyTone[e.kind] ?? 'default'}`}
                  >
                    {historyVerb[e.kind]}
                  </span>
                </td>
                <th scope="row" class="cell-agent">
                  <span
                    class={`kind kind--${props.agents[e.agentId]?.kind ?? kindFromId(e.agentId)}`}
                  />
                  <span class="agent">
                    <span class="agent__id">{e.agentId}</span>
                    <span class="agent__name">{e.displayName}</span>
                  </span>
                </th>
                <td class="cell-project">{e.project ?? '·'}</td>
                <td class="cell-task">{e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function kindFromId(id: string): AgentView['kind'] {
  if (id.startsWith('claude-code-')) return 'claude';
  if (id.startsWith('pi-')) return 'pi';
  if (id.startsWith('dashboard-')) return 'human';
  return 'other';
}

// ── dialogs ─────────────────────────────────────────────────────────────────

function Modal(props: {
  title: string;
  onClose: () => void;
  children: preact.ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      class="modal"
      onClose={props.onClose}
      onCancel={props.onClose}
    >
      <header class="modal__head">
        <h2>{props.title}</h2>
        <button
          class="btn btn--icon"
          onClick={props.onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </header>
      {props.children}
    </dialog>
  );
}

function SpawnDialog({ onClose }: { onClose: () => void }) {
  const [tool, setTool] = useState<'pi' | 'claude'>('claude');
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    text: string;
    command?: string;
  }>();

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setResult(undefined);
    try {
      const res = await api.spawn({
        tool,
        name: name.trim(),
        task: task.trim(),
      });
      setResult({
        ok: res.spawned,
        text: res.detail,
        command: res.manualCommand,
      });
    } catch (err) {
      setResult({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Spawn an agent" onClose={onClose}>
      <form class="form" onSubmit={submit}>
        <p class="muted">
          Opens a new terminal tab on the machine running the dashboard. The
          agent registers on the bridge and DMs you when it starts.
        </p>
        <fieldset class="seg">
          <legend class="label">Agent</legend>
          {(['claude', 'pi'] as const).map((t) => (
            <label class={`seg__opt ${tool === t ? 'seg__opt--on' : ''}`}>
              <input
                type="radio"
                name="tool"
                value={t}
                checked={tool === t}
                onChange={() => setTool(t)}
              />
              <span class={`kind kind--${t}`} />
              {t === 'claude' ? 'Claude Code' : 'Pi'}
            </label>
          ))}
        </fieldset>
        <label class="field">
          <span class="label">Name</span>
          <input
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="reviewer"
            required
            maxLength={40}
          />
        </label>
        <label class="field">
          <span class="label">Task</span>
          <textarea
            rows={4}
            value={task}
            onInput={(e) => setTask(e.currentTarget.value)}
            placeholder="Review the open MR and DM me the risks"
            required
          />
        </label>
        {result ? (
          <div
            class={result.ok ? 'ok' : result.command ? 'warn' : 'error'}
            role="status"
          >
            <p>{result.text}</p>
            {result.command ? (
              <pre class="command">{result.command}</pre>
            ) : null}
          </div>
        ) : null}
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" onClick={onClose}>
            {result?.ok ? 'Done' : 'Cancel'}
          </button>
          <button
            class="btn btn--primary"
            disabled={busy || !name.trim() || !task.trim()}
          >
            {busy ? 'Spawning' : 'Spawn'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SelfDialog({
  state,
  onClose,
}: {
  state: BoardState;
  onClose: () => void;
}) {
  const self = state.status?.self;
  const [name, setName] = useState(self?.displayName ?? '');
  const [status, setStatus] = useState(self?.status ?? '');
  const [project, setProject] = useState(self?.project ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const projects = [
    ...new Set(
      Object.values(state.agents)
        .map((a) => a.project)
        .filter((p): p is string => !!p)
    ),
  ].sort();

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const req: { name?: string; status?: string } = {};
      if (name.trim() && name.trim() !== self?.displayName)
        req.name = name.trim();
      if (status.trim() !== (self?.status ?? '')) req.status = status.trim();
      if (req.name !== undefined || req.status !== undefined)
        await api.self(req);
      if (project && project !== self?.project) await api.project(project);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="The dashboard on the bridge" onClose={onClose}>
      <form class="form" onSubmit={submit}>
        <p class="muted">
          Agents see the dashboard as <b>{self?.agentId}</b>. They can DM it
          like any other agent.
        </p>
        <label class="field">
          <span class="label">Display name</span>
          <input
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            maxLength={60}
          />
        </label>
        <label class="field">
          <span class="label">Status line</span>
          <input
            value={status}
            onInput={(e) => setStatus(e.currentTarget.value)}
            placeholder="Reviewing the fleet"
            maxLength={120}
          />
        </label>
        <label class="field">
          <span class="label">Rooms of project</span>
          <select
            class="select"
            value={project}
            onChange={(e) => setProject(e.currentTarget.value)}
          >
            {[...new Set([self?.project ?? '', ...projects])]
              .filter(Boolean)
              .map((p) => (
                <option value={p}>{p}</option>
              ))}
          </select>
          <span class="hint">
            The dashboard listens to this project's rooms. Direct messages reach
            it from every project.
          </span>
        </label>
        {error ? (
          <p class="error" role="alert">
            {error}
          </p>
        ) : null}
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn btn--primary" disabled={busy}>
            {busy ? 'Saving' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
