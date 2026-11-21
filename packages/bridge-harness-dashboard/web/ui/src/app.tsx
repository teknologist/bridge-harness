import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  History as HistoryIcon,
  LogOut,
  MessagesSquare,
  MessageCircleQuestion,
  Pencil,
  PlaneTakeoff,
  Plus,
  Power,
  Rows3,
  ScrollText,
  SendHorizontal,
  SquareTerminal,
  X,
  GitBranch,
  Volume2,
  VolumeX,
} from 'lucide-preact';
import type {
  AgentView,
  ChatMessage,
  HistoryEvent,
  PaneKey,
  ThreadSummary,
  TranscriptLine,
} from '../../../shared/contract.ts';
import {
  SPAWN_MODEL_CHOICES,
  SPAWN_MODELS,
  SPAWN_THINKING,
  threadKey,
} from '../../../shared/contract.ts';
import { ansiSpans } from './ansi.tsx';
import { api } from './api.ts';
import { KindMark } from './brand.tsx';
import { Flap, flapSoundOn, setFlapSound } from './flap.tsx';
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
  codex: 'Codex',
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
      [...new Set(agents.map(repoOf).filter((p): p is string => !!p))].sort(),
    [agents]
  );

  useEffect(() => {
    if (open) void board.openThread(open).catch(() => undefined);
  }, [open, board.state.epoch]);

  function openAgent(a: AgentView) {
    board.markSeen(a.agentId);
    setOpen(threadKey({ kind: 'dm', agentId: a.agentId }));
  }

  const status = state.status;
  const down = !state.streamUp || !status?.connected;

  return (
    <div
      class={`shell ${open ? 'shell--drawer' : ''} ${open?.startsWith('dm:') ? 'shell--split' : ''}`}
    >
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
          <SoundToggle />
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
            onTranscript={board.openTranscript}
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
/** Board order: waiting on the user first, then working, idle or unknown, then stale. */
function rank(a: AgentView): number {
  if (a.liveness === 'stale') return 2;
  if (a.activity === 'waiting') return -1;
  return a.activity === 'working' ? 0 : 1;
}

type Phase =
  | 'waiting'
  | 'takeoff'
  | 'flight'
  | 'landing'
  | 'taxi'
  | 'gate'
  | 'ontime'
  | 'delayed';

/** How long a take-off, landing or taxi stays on the board after the change. */
const MANOEUVRE_MS = 20_000;

const phases: Record<
  Phase,
  { label: string; tone: 'live' | 'stale' | 'muted' | 'mail' }
> = {
  waiting: { label: 'WAITING', tone: 'mail' }, // blocked on a prompt only the user can answer
  takeoff: { label: 'TAKE OFF', tone: 'live' },
  flight: { label: 'IN FLIGHT', tone: 'live' },
  landing: { label: 'LANDING', tone: 'live' },
  taxi: { label: 'TAXIING', tone: 'muted' },
  gate: { label: 'AT GATE', tone: 'muted' },
  ontime: { label: 'ON TIME', tone: 'muted' }, // agent predates the activity signal
  delayed: { label: 'DELAYED', tone: 'stale' },
};

/**
 * Where the agent is in its flight. Take-off and landing mark a turn that just
 * started or ended; taxiing marks an agent that just arrived on the bridge.
 * `since` is when this browser last saw the agent's activity change.
 */
function phaseOf(a: AgentView, since: number | undefined, now: number): Phase {
  if (a.liveness === 'stale') return 'delayed';
  if (a.activity === 'waiting') return 'waiting';
  const fresh = since !== undefined && now - since < MANOEUVRE_MS;
  if (a.activity === 'working') return fresh ? 'takeoff' : 'flight';
  if (a.activity === 'idle' && fresh) return 'landing';
  if (now - a.joinedAt < MANOEUVRE_MS) return 'taxi';
  return a.activity === 'idle' ? 'gate' : 'ontime';
}

/** Remembers when each agent's activity last changed, as seen by this browser. */
function useActivityChanges(
  agents: AgentView[],
  now: number
): Map<string, number> {
  const seen = useRef(
    new Map<string, { activity: AgentView['activity']; at?: number }>()
  );
  for (const a of agents) {
    const prev = seen.current.get(a.agentId);
    if (!prev) seen.current.set(a.agentId, { activity: a.activity });
    else if (prev.activity !== a.activity) {
      // idle → working is a take-off; working → idle a landing. A first signal is neither.
      const at = prev.activity ? now : undefined;
      seen.current.set(a.agentId, { activity: a.activity, at });
    }
  }
  const out = new Map<string, number>();
  for (const [id, v] of seen.current) if (v.at !== undefined) out.set(id, v.at);
  return out;
}

/** Side-profile airliner, nose right, in a 36×22 box whose ground line is y 19. */
const PLANE_BODY = (
  <>
    <path d="M11 9.6H26c2.6 0 4.5 1 4.5 1.8s-1.7 1.4-4.5 1.4H9.4L5 10.2l.6-5.8h1.8z" />
    <path d="M19.4 12.8l-3.2 3h1.5l4.3-3" />
    <path class="plane__windows" d="M12.5 11.1h11" />
    <path d="M27 10.7h1.5" />
  </>
);
const PLANE_GEAR = (
  <>
    <path d="M11.5 12.8v1.6M25 12.8v1.6" />
    <circle class="plane__wheel" cx="11.5" cy="15.2" r=".8" />
    <circle class="plane__wheel" cx="25" cy="15.2" r=".8" />
  </>
);
type Pose = { rot: number; dy: number; ground?: 'runway' | 'taxiway' };
const POSES: Record<'takeoff' | 'flight' | 'landing' | 'ground', Pose> = {
  takeoff: { rot: -12, dy: -1.2, ground: 'runway' },
  landing: { rot: 7, dy: -2.6, ground: 'runway' },
  flight: { rot: 0, dy: -1 },
  ground: { rot: 0, dy: 3, ground: 'taxiway' },
};

/** The plane in one pose, over a runway, a taxiway or nothing. */
const PlaneMark = (props: { pose: Pose; class: string; width: number }) => (
  <svg
    class={`plane ${props.class}`}
    viewBox="0 0 36 22"
    width={props.width}
    height={(props.width * 22) / 36}
    aria-hidden="true"
  >
    {props.pose.ground === 'runway' ? (
      <>
        <path class="plane__strip" d="M0 19h36" />
        <path class="plane__strip plane__centre" d="M2 20.8h32" />
      </>
    ) : props.pose.ground === 'taxiway' ? (
      <path class="plane__strip" d="M2 19h32" />
    ) : null}
    <g class="plane__fly">
      <g
        transform={`translate(0 ${props.pose.dy}) rotate(${props.pose.rot} 18 11)`}
      >
        {PLANE_BODY}
        {props.pose.ground ? PLANE_GEAR : null}
      </g>
    </g>
  </svg>
);

const PhaseIcon = (props: { phase: Phase }) => {
  if (props.phase === 'waiting')
    return (
      <MessageCircleQuestion
        class="phase phase--waiting"
        size={16}
        aria-hidden="true"
      />
    );
  const pose =
    props.phase === 'takeoff' || props.phase === 'landing'
      ? POSES[props.phase]
      : props.phase === 'flight' || props.phase === 'ontime'
        ? POSES.flight
        : POSES.ground;
  return (
    <PlaneMark pose={pose} class={`phase phase--${props.phase}`} width={40} />
  );
};

/** "claude-opus-5-5" → "Opus 5.5"; other ids lose only a provider prefix. */
function modelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : model.replace(/^.*\//, '');
}

/** Model and thinking level, e.g. "Opus 5.5 · medium". */
function modelOf(a: AgentView): string | undefined {
  return a.model ? [modelName(a.model), a.thinking].filter(Boolean).join(' · ') : undefined;
}

function tokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`;
}

/** Context fill, e.g. "119k / 1.0M · 12%", or just "119k" when the host gives no window. */
function ctxOf(a: AgentView): string | undefined {
  if (!a.ctxTokens) return undefined;
  if (!a.ctxWindow) return tokens(a.ctxTokens);
  return `${tokens(a.ctxTokens)} / ${tokens(a.ctxWindow)} · ${Math.round((a.ctxTokens / a.ctxWindow) * 100)}%`;
}

function repoOf(a: AgentView): string | undefined {
  return a.repo ?? a.project;
}

/** Branch, plus the worktree folder when it is not just the repo checkout itself. */
function whereOf(a: AgentView): string {
  const tree =
    a.repo && a.project && a.project !== a.repo ? a.project : undefined;
  return [
    a.branch,
    tree && tree !== a.branch?.replace(/\//g, '-') ? `in ${tree}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Home folder as ~ on macOS and Linux hosts. */
function homeless(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

/** Checkout root, then the working directory below it when the agent sits deeper. */
function pathOf(a: AgentView): { root: string; sub?: string } | undefined {
  if (!a.cwd && !a.worktree) return undefined;
  const root = a.worktree ?? a.cwd!;
  const sub =
    a.worktree && a.cwd && a.cwd.startsWith(a.worktree + '/')
      ? a.cwd.slice(a.worktree.length + 1)
      : a.worktree && a.cwd && a.cwd !== a.worktree
        ? a.cwd
        : undefined;
  return { root: homeless(root), sub: sub && homeless(sub) };
}

/** Branch with a branch icon, then checkout path and working directory. */
function Where(props: { a: AgentView }) {
  const { a } = props;
  const path = pathOf(a);
  const full = [a.worktree, a.cwd && a.cwd !== a.worktree ? `cwd ${a.cwd}` : undefined].filter(Boolean).join('\n');
  return (
    <>
      {a.branch && (
        <span class="where__branch">
          <GitBranch class="where__glyph" size={12} strokeWidth={2.25} aria-hidden="true" />
          {a.branch}
        </span>
      )}
      {path ? (
        <span class="where__path" title={full || undefined}>
          <bdi>
            {path.root}
            {path.sub && <span class="where__sub">/{path.sub}</span>}
          </bdi>
        </span>
      ) : (
        whereOf(a) && !a.branch && <span class="where__tree">{whereOf(a)}</span>
      )}
    </>
  );
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

  const changes = useActivityChanges(props.agents, Date.now());
  const waiting = rows.filter((a) => rank(a) === -1).length;
  const working = rows.filter((a) => rank(a) === 0).length;
  const stale = rows.filter((a) => rank(a) === 2).length;
  const idle = rows.filter(
    (a) => rank(a) === 1 && a.activity === 'idle'
  ).length;
  const unknown = rows.length - working - waiting - stale - idle; // agents without the signal yet

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
        <h2 class="board__title">
          <PlaneTakeoff size={22} aria-hidden="true" />
          Departures
        </h2>
        <Flap
          class="board__clock"
          cells={5}
          value={clock(now)}
          title="Local time"
        />
        <p class="board__counts">
          {waiting > 0 && (
            <span class="board__waiting">
              <b>{waiting}</b> waiting on you ·{' '}
            </span>
          )}
          <b>{working}</b> in flight · <b>{idle}</b> at gate
          {unknown > 0 && (
            <>
              {' '}
              · <b>{unknown}</b> on time
            </>
          )}{' '}
          · <b>{stale}</b> delayed
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
                class={`row row--${a.kind} ${a.liveness === 'stale' ? 'row--stale' : ''} ${rank(a) === 0 ? 'row--working' : ''} ${rank(a) === -1 ? 'row--waiting' : ''} ${props.selected === key ? 'row--on' : ''}`}
                onClick={() => !isSelf && props.onOpen(a)}
              >
                <th scope="row" class="cell-agent">
                  <KindMark kind={a.kind} title={kindLabel[a.kind]} />
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
                    {modelOf(a) ? <span class="agent__model">{modelOf(a)}</span> : null}
                  </span>
                </th>
                <td class="cell-project">
                  <span class="where__repo">{repoOf(a) ?? '·'}</span>
                  <Where a={a} />
                </td>
                <td class="cell-host col-host">{a.host ?? '·'}</td>
                <td class="cell-task">
                  <Flap
                    value={cleanTask(a.task) || '·'}
                    pending={pending.has('task')}
                  />
                </td>
                <td class="num cell-seen">
                  <Flap class="seen" still value={ago(a.lastSeen, now)} />
                </td>
                <td class="cell-status">
                  {rank(a) === 0 ? (
                    <span class="boarding" aria-hidden="true" />
                  ) : null}
                  {rank(a) === -1 ? (
                    <span
                      class="boarding boarding--waiting"
                      aria-hidden="true"
                    />
                  ) : null}
                  <PhaseIcon phase={phaseOf(a, changes.get(a.agentId), now)} />
                  <Flap
                    class="status"
                    cells={9}
                    tone={phases[phaseOf(a, changes.get(a.agentId), now)].tone}
                    value={
                      phases[phaseOf(a, changes.get(a.agentId), now)].label
                    }
                    pending={pending.has('liveness')}
                  />
                </td>
                <td class="num">
                  {unread > 0 ? (
                    <Flap
                      class="mail"
                      tone="mail"
                      cells={2}
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
              {t.ref.kind === 'dm' ? (
                <KindMark
                  kind={
                    props.state.agents[t.ref.agentId]?.kind ??
                    kindFromId(t.ref.agentId)
                  }
                  title={
                    kindLabel[
                      props.state.agents[t.ref.agentId]?.kind ??
                        kindFromId(t.ref.agentId)
                    ]
                  }
                />
              ) : (
                <KindMark kind="room" title="Room" />
              )}
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

/** Keys offered for a terminal prompt: pick an option, move, confirm or back out. */
const PROMPT_KEYS: { key: PaneKey; label: string }[] = [
  { key: '1', label: '1' },
  { key: '2', label: '2' },
  { key: '3', label: '3' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'enter', label: 'Enter' },
  { key: 'esc', label: 'Esc' },
];

/**
 * The agent's terminal, read through Rex, so a prompt it is blocked on can be
 * answered from here: keys go straight to the pane, text is typed then Enter.
 */
/**
 * The agent's real terminal, read and typed into through Rex. It is the
 * interactive face of the transcript pane, shown only while toggled on.
 */
function PaneTerminal(props: { agentId: string }) {
  const [screen, setScreen] = useState<string>();
  const [error, setError] = useState<string>();
  const [text, setText] = useState('');
  const pre = useRef<HTMLPreElement>(null);

  async function refresh() {
    try {
      setScreen((await api.pane(props.agentId)).text);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [props.agentId]);

  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [screen]);

  async function type(input: { text?: string; keys?: PaneKey[] }) {
    try {
      await api.type(props.agentId, input);
      setError(undefined);
      setTimeout(refresh, 300);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div class='console'>
      <pre ref={pre} class='prompt__screen console__screen' aria-label={`Terminal of ${props.agentId}`}>
        {screen === undefined ? 'Reading the terminal…' : ansiSpans(screen)}
      </pre>
      {error ? <p class='prompt__error'>{error}</p> : null}
      <div class='prompt__keys'>
        {PROMPT_KEYS.map((k) => (
          <button type='button' class='btn btn--key' key={k.key} onClick={() => type({ keys: [k.key] })}>
            {k.label}
          </button>
        ))}
      </div>
      <form
        class='prompt__form field'
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          type({ text, keys: ['enter'] });
          setText('');
        }}
      >
        <input
          class='input'
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          placeholder='Type into the terminal, sent with Enter'
          aria-label='Type into the terminal'
        />
        <button type='submit' class='btn' disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function Drawer(props: {
  threadKeyValue: string;
  state: BoardState;
  now: number;
  onClose: () => void;
  onTranscript: (agentId: string) => Promise<void>;
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
  const [confirming, setConfirming] = useState(false);
  const canShutDown = !!peer?.pane && peer.activity === 'idle';
  const waiting = peer?.activity === 'waiting';
  // Read-only transcript by default; the live terminal is one toggle away and
  // opens by itself when the agent is waiting on an answer.
  const [term, setTerm] = useState(waiting);
  useEffect(() => setTerm(waiting), [key]);
  useEffect(() => {
    if (waiting) setTerm(true);
  }, [waiting]);
  const showTerm = term && !!peer?.pane;

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
        <div class="drawer__actions">
          {canShutDown ? (
            <button
              class="btn btn--icon btn--danger"
              onClick={() => setConfirming(true)}
              aria-label="Shut down agent"
              title="Shut down this idle agent"
            >
              <Power size={18} />
            </button>
          ) : null}
          <button
            class="btn btn--icon"
            onClick={props.onClose}
            aria-label="Close thread"
          >
            <X size={18} />
          </button>
        </div>
      </header>
      {confirming && peer ? (
        <ShutDownDialog
          agent={peer}
          onCancel={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false);
            props.onClose();
          }}
        />
      ) : null}
      {peerId ? (
        <Split
          messages={
            <section class="pane" aria-label="Messages">
              <h3 class="pane__head">
                Messages <span class="pane__n">{messages?.length ?? 0}</span>
              </h3>
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
            </section>
          }
          transcript={
            <section
              class={`pane pane--term ${waiting ? "pane--waiting" : ""}`}
              aria-label={showTerm ? "Terminal" : "Transcript"}
            >
              <div class="pane__head">
                <h3 class="pane__title">
                  {showTerm ? "Terminal" : "Transcript"}
                  {showTerm ? null : <span class="pane__n">{state.transcripts[peerId]?.length ?? 0}</span>}
                </h3>
                {waiting ? <span class="pane__wait">waiting on you</span> : null}
                {peer?.liveness === "live" ? <span class="pane__live">live</span> : null}
                {peer?.pane ? (
                  <button
                    type="button"
                    class="pane__toggle"
                    aria-pressed={showTerm}
                    onClick={() => setTerm(!showTerm)}
                    title={showTerm ? "Back to the read-only transcript" : "Open the live terminal to type into it"}
                  >
                    {showTerm ? <ScrollText size={14} aria-hidden="true" /> : <SquareTerminal size={14} aria-hidden="true" />}
                    {showTerm ? "Transcript" : "Terminal"}
                  </button>
                ) : null}
              </div>
              {showTerm ? (
                <PaneTerminal agentId={peerId} />
              ) : (
                <Transcript agentId={peerId} epoch={state.epoch} lines={state.transcripts[peerId]} onOpen={props.onTranscript} />
              )}
              {!showTerm && peer && (modelOf(peer) || ctxOf(peer)) ? (
                <footer class="term__foot">
                  {modelOf(peer) ? <span>{modelOf(peer)}</span> : null}
                  {ctxOf(peer) ? <span title="Context the last request sent">ctx {ctxOf(peer)}</span> : null}
                </footer>
              ) : null}
            </section>
          }
        />
      ) : (
        <>
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
        </>
      )}
    </aside>
  );
}

const SPLIT_KEY = 'bridge.split';

function readSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= 20 && v <= 80 ? v : 50;
  } catch {
    return 50;
  }
}

/**
 * Messages and transcript at once: side by side when the drawer is wide, stacked
 * with a draggable divider when it is not. The divider position is remembered.
 */
function Split(props: { messages: JSX.Element; transcript: JSX.Element }) {
  const [at, setAt] = useState(readSplit);
  const box = useRef<HTMLDivElement>(null);

  const set = (v: number) => {
    const next = Math.round(Math.min(80, Math.max(20, v)));
    setAt(next);
    try {
      localStorage.setItem(SPLIT_KEY, String(next));
    } catch {
      /* private mode: the split just isn't remembered */
    }
  };

  const drag = (e: PointerEvent) => {
    const el = box.current;
    if (!el) return;
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      set(((ev.clientY - r.top) / r.height) * 100);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };

  return (
    <div class="split" ref={box} style={{ '--split-at': `${at}%` }}>
      {props.transcript}
      <div
        class="split__grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize transcript and messages"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={at}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') set(at - 5);
          else if (e.key === 'ArrowDown') set(at + 5);
          else return;
          e.preventDefault();
        }}
      />
      {props.messages}
    </div>
  );
}

function Transcript(props: {
  agentId: string;
  /** Stream reconnect count: a reconnect refetches what the pane missed. */
  epoch: number;
  lines: TranscriptLine[] | undefined;
  onOpen: (agentId: string) => Promise<void>;
}) {
  const { lines } = props;
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const pinned = useRef(true);

  useEffect(() => {
    setError(undefined);
    props
      .onOpen(props.agentId)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      );
  }, [props.agentId, props.epoch]);

  // Follow the tail like a terminal, unless the reader scrolled up.
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight });
  }, [lines?.length]);

  return (
    <div
      class="term"
      ref={box}
      role="log"
      aria-live="polite"
      aria-label={`Live transcript of ${props.agentId}`}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {error ? (
        <p class="term__note term__note--err">
          Could not load the transcript: {error}
        </p>
      ) : lines === undefined ? (
        <p class="term__note">Loading the transcript</p>
      ) : lines.length === 0 ? (
        <p class="term__note">
          Nothing yet. Lines appear here as this agent talks. Agents started
          before 0.3.34, or with BRIDGE_SHARE_TRANSCRIPT=0, do not share theirs.
        </p>
      ) : (
        <>
          {lines.map((l) => (
            <div class={`term__line term__line--${l.role}`}>
              <span class="term__mark" aria-hidden="true">
                {l.role === 'user' ? '›' : '•'}
              </span>
              <span class="term__text">{l.text}</span>
              <time
                class="term__time"
                dateTime={new Date(l.timestamp).toISOString()}
              >
                {clock(l.timestamp)}
              </time>
            </div>
          ))}
          <span class="term__cursor" aria-hidden="true" />
        </>
      )}
    </div>
  );
}

function Message({ m, mine }: { m: ChatMessage; mine: boolean }) {
  return (
    <li class={`msg ${mine ? 'msg--mine' : ''}`}>
      <div class="msg__head">
        <span class="msg__from">
          <span class="msg__who">{mine ? 'you' : m.from}</span>
          <span class="msg__to">→ {m.to.replace(/^agent:/, '')}</span>
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
                  {e.kind === 'join' || e.kind === 'back' ? (
                    <PlaneMark
                      pose={POSES.landing}
                      class="phase phase--arrive"
                      width={30}
                    />
                  ) : e.kind === 'leave' || e.kind === 'drop' ? (
                    <PlaneMark
                      pose={POSES.takeoff}
                      class="phase phase--depart"
                      width={30}
                    />
                  ) : null}
                  <span
                    class={`flap tag flap--${historyTone[e.kind] ?? 'default'}`}
                  >
                    {historyVerb[e.kind]}
                  </span>
                </td>
                <th scope="row" class="cell-agent">
                  <KindMark
                    kind={
                      props.agents[e.agentId]?.kind ?? kindFromId(e.agentId)
                    }
                    title={
                      kindLabel[
                        props.agents[e.agentId]?.kind ?? kindFromId(e.agentId)
                      ]
                    }
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
  if (id.startsWith('codex-')) return 'codex';
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

/** "~/x" form of an absolute path, given that machine's home. */
function tilde(path: string, home: string): string {
  if (home && (path === home || path.startsWith(`${home}/`)))
    return `~${path.slice(home.length)}`;
  return path;
}

/**
 * Start directory: typed as a path, or picked by browsing that machine's folders.
 * The text after the last "/" filters the folder list, so typing searches it.
 */
function DirField({
  host,
  value,
  onChange,
}: {
  host: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{
    path: string;
    home: string;
    exists: boolean;
    dirs: string[];
    truncated: boolean;
  }>();
  const [error, setError] = useState('');
  const slash = value.lastIndexOf('/');
  const base = slash < 0 ? '~' : value.slice(0, slash) || '/';
  const leaf = slash < 0 ? value : value.slice(slash + 1);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(() => {
      api.dirs(host, base, leaf).then(
        (r) => {
          if (live) {
            setList(r);
            setError('');
          }
        },
        (err) => {
          if (live) {
            setList(undefined);
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, host, base, leaf]);
  const here = list ? tilde(list.path, list.home) : base;
  const join = (name: string) => `${here === '/' ? '' : here}/${name}/`;
  const up = here.includes('/')
    ? here.slice(0, here.lastIndexOf('/')) || '/'
    : '';
  return (
    <div class="field">
      <span class="label">Directory</span>
      <div class="dirfield">
        <input
          value={value}
          onInput={(e) => onChange(e.currentTarget.value)}
          onFocus={() => setOpen(true)}
          placeholder={host ? '~/bridge-agents (on that host)' : '~/bridge-agents'}
          aria-label="Directory"
          spellcheck={false}
          autocomplete="off"
        />
        <button
          type="button"
          class="btn"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? 'Hide' : 'Browse'}
        </button>
      </div>
      {open ? (
        <div class="dirs" role="listbox" aria-label={`Folders in ${here}`}>
          <div class="dirs__here">
            {here}
            {leaf ? <span class="muted"> · matching “{leaf}”</span> : null}
          </div>
          {error ? <div class="dirs__note dirs__note--bad">{error}</div> : null}
          {list && !list.exists ? (
            <div class="dirs__note">
              This folder does not exist on {host || 'this machine'}.
            </div>
          ) : null}
          {up ? (
            <button
              type="button"
              class="dirs__item"
              onClick={() => onChange(`${up}/`.replace('//', '/'))}
            >
              ..
            </button>
          ) : null}
          {list?.dirs.map((d) => (
            <button
              type="button"
              class="dirs__item"
              role="option"
              onClick={() => onChange(join(d))}
            >
              {d}/
            </button>
          ))}
          {list && list.exists && !list.dirs.length ? (
            <div class="dirs__note">
              No folders{leaf ? ` starting with “${leaf}”` : ''}.
            </div>
          ) : null}
          {list?.truncated ? (
            <div class="dirs__note">More folders exist; type to narrow.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SpawnDialog({ onClose }: { onClose: () => void }) {
  const [tool, setTool] = useState<'pi' | 'claude' | 'codex'>('claude');
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [cwd, setCwd] = useState('');
  const [host, setHost] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const [model, setModel] = useState(SPAWN_MODELS.claude);
  const [thinking, setThinking] = useState('');
  const [busy, setBusy] = useState(false);
  // Thinking levels differ per CLI: drop a pick the new agent would reject.
  // Models and thinking levels differ per CLI: start each agent on its default model
  // and drop a thinking pick the new agent would reject.
  useEffect(() => {
    setModel(SPAWN_MODELS[tool]);
    if (thinking && !SPAWN_THINKING[tool].includes(thinking)) setThinking('');
  }, [tool]);
  useEffect(() => {
    api.hosts().then(
      (r) => setHosts(r.hosts),
      () => setHosts([])
    );
  }, []);
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
        cwd: cwd.trim() || undefined,
        host: host || undefined,
        model: model.trim() || undefined,
        thinking: thinking || undefined,
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
          Opens a new terminal tab on the machine running the dashboard, or on a
          Rex host. The agent registers on the bridge and DMs you when it
          starts.
        </p>
        <fieldset class="seg">
          <legend class="label">Agent</legend>
          {(['claude', 'pi', 'codex'] as const).map((t) => (
            <label class={`seg__opt ${tool === t ? 'seg__opt--on' : ''}`}>
              <input
                type="radio"
                name="tool"
                value={t}
                checked={tool === t}
                onChange={() => setTool(t)}
              />
              <KindMark kind={t} title="" />
              {t === 'claude' ? 'Claude Code' : t === 'pi' ? 'Pi' : 'Codex'}
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
            placeholder="e.g. Review the open MR and DM me the risks"
            required
          />
        </label>
        {hosts.length ? (
          <label class="field">
            <span class="label">Host</span>
            <select
              class="select"
              value={host}
              onChange={(e) => setHost(e.currentTarget.value)}
            >
              <option value="">This machine</option>
              {hosts.map((h) => (
                <option value={h}>{h}</option>
              ))}
            </select>
          </label>
        ) : null}
        <DirField host={host} value={cwd} onChange={setCwd} />
        <div class="field-row">
          <label class="field">
            <span class="label">Model</span>
            <select
              class="select"
              value={model}
              onChange={(e) => setModel(e.currentTarget.value)}
            >
              {SPAWN_MODEL_CHOICES[tool].map((m) => (
                <option value={m}>
                  {m === SPAWN_MODELS[tool] ? `${m} (default)` : m}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="label">Thinking</span>
            <select
              class="select"
              value={thinking}
              onChange={(e) => setThinking(e.currentTarget.value)}
            >
              <option value="">Default</option>
              {SPAWN_THINKING[tool].map((t) => (
                <option value={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>
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
          {!busy && (!name.trim() || !task.trim()) ? (
            <span class="form__hint">
              Add a {!name.trim() ? 'name' : 'task'} to spawn
            </span>
          ) : null}
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

function ShutDownDialog(props: {
  agent: AgentView;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { agent } = props;

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await api.shutDown(agent.agentId);
      props.onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Shut down this agent?" onClose={props.onCancel}>
      <div class="form">
        <p>
          <b>{agent.displayName}</b> ({agent.agentId})
          {agent.host ? ` on ${agent.host}` : ''} is idle. Its terminal pane
          will be closed and the agent stops. This cannot be undone.
        </p>
        {error ? (
          <p class="error" role="alert">
            {error}
          </p>
        ) : null}
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn--danger-solid"
            disabled={busy}
            onClick={confirm}
          >
            <Power size={16} aria-hidden="true" />
            {busy ? 'Shutting down' : 'Shut down'}
          </button>
        </div>
      </div>
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

/** Mutes the flap clicks; the choice is kept per browser. */
function SoundToggle() {
  const [on, setOn] = useState(flapSoundOn);
  const label = on ? 'Mute flap sound' : 'Play flap sound';
  return (
    <button
      class="btn btn--icon"
      onClick={() => {
        setFlapSound(!on);
        setOn(!on);
      }}
      aria-label={label}
      aria-pressed={on}
      title={label}
    >
      {on ? <Volume2 size={16} /> : <VolumeX size={16} />}
    </button>
  );
}
