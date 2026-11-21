import { useCallback, useEffect, useReducer, useRef } from 'preact/hooks';
import type {
  AgentView,
  BridgeStatus,
  ChatMessage,
  HistoryEvent,
  ServerEvent,
  StateResponse,
  ThreadSummary,
  TranscriptLine,
  TranscriptResponse,
} from '../../../shared/contract.ts';
import { api, subscribe, Unauthorized } from './api.ts';

/** Fields of an agent row that flip on the board when they change. */
export type FlapField = 'task' | 'liveness' | 'displayName' | 'mail';

export interface BoardState {
  auth: 'checking' | 'needed' | 'ok';
  status?: BridgeStatus;
  streamUp: boolean;
  /** Bumps on every stream (re)connect, so open panes refetch what they missed. */
  epoch: number;
  agents: Record<string, AgentView>;
  threads: Record<string, ThreadSummary>;
  messages: Record<string, ChatMessage[]>;
  history: HistoryEvent[];
  /** agentId → transcript lines, only for agents whose transcript was opened. */
  transcripts: Record<string, TranscriptLine[]>;
  /** agentId → fields that changed since the operator last opened that row. */
  unseen: Record<string, FlapField[]>;
  loadError?: string;
}

type Action =
  | { t: 'snapshot'; s: StateResponse }
  | { t: 'event'; e: ServerEvent }
  | { t: 'auth'; auth: BoardState['auth'] }
  | { t: 'stream'; up: boolean }
  | { t: 'messages'; key: string; messages: ChatMessage[] }
  | { t: 'history'; events: HistoryEvent[] }
  | { t: 'transcript'; agentId: string; lines: TranscriptLine[] }
  | { t: 'seen'; agentId: string }
  | { t: 'error'; message?: string };

const initial: BoardState = {
  auth: 'checking',
  streamUp: false,
  epoch: 0,
  agents: {},
  threads: {},
  messages: {},
  history: [],
  transcripts: {},
  unseen: {},
};

const byKey = <T>(items: T[], key: (x: T) => string) =>
  Object.fromEntries(items.map((x) => [key(x), x])) as Record<string, T>;

function markUnseen(
  s: BoardState,
  agentId: string,
  fields: FlapField[]
): BoardState['unseen'] {
  if (fields.length === 0) return s.unseen;
  const prev = s.unseen[agentId] ?? [];
  return { ...s.unseen, [agentId]: [...new Set([...prev, ...fields])] };
}

function appendMessage(
  list: ChatMessage[] | undefined,
  m: ChatMessage
): ChatMessage[] {
  const cur = list ?? [];
  if (cur.some((x) => x.id === m.id)) return cur;
  return [...cur, m].slice(-500);
}

function reduce(s: BoardState, a: Action): BoardState {
  switch (a.t) {
    case 'snapshot':
      return {
        ...s,
        auth: 'ok',
        loadError: undefined,
        status: a.s.status,
        agents: byKey(a.s.agents, (x) => x.agentId),
        threads: byKey(a.s.threads, (x) => x.key),
      };
    case 'auth':
      return { ...s, auth: a.auth };
    case 'stream':
      return { ...s, streamUp: a.up, epoch: a.up && !s.streamUp ? s.epoch + 1 : s.epoch };
    case 'error':
      return { ...s, loadError: a.message };
    case 'messages':
      return { ...s, messages: { ...s.messages, [a.key]: a.messages } };
    case 'history':
      return { ...s, history: a.events };
    case 'transcript':
      return { ...s, transcripts: { ...s.transcripts, [a.agentId]: a.lines } };
    case 'seen': {
      if (!s.unseen[a.agentId]) return s;
      const { [a.agentId]: _drop, ...rest } = s.unseen;
      return { ...s, unseen: rest };
    }
    case 'event': {
      const e = a.e;
      switch (e.type) {
        case 'status':
          return { ...s, status: e.status };
        case 'agent': {
          const prev = s.agents[e.agent.agentId];
          const changed: FlapField[] = [];
          if (prev) {
            const task = e.agent.task ?? '';
            if ((prev.task ?? '') !== task && task && !task.startsWith('<'))
              changed.push('task');
            if (prev.liveness !== e.agent.liveness) changed.push('liveness');
            if (prev.displayName !== e.agent.displayName)
              changed.push('displayName');
          }
          return {
            ...s,
            agents: { ...s.agents, [e.agent.agentId]: e.agent },
            unseen: markUnseen(s, e.agent.agentId, changed),
          };
        }
        case 'agent-drop': {
          const { [e.agentId]: _gone, ...agents } = s.agents;
          return { ...s, agents };
        }
        case 'message': {
          const m = e.message;
          const peer = m.thread.startsWith('dm:')
            ? m.thread.slice(3)
            : undefined;
          const fromOther = s.status ? m.from !== s.status.self.agentId : true;
          return {
            ...s,
            messages: s.messages[m.thread]
              ? {
                  ...s.messages,
                  [m.thread]: appendMessage(s.messages[m.thread], m),
                }
              : s.messages,
            unseen:
              peer && fromOther ? markUnseen(s, peer, ['mail']) : s.unseen,
          };
        }
        case 'thread':
          return { ...s, threads: { ...s.threads, [e.thread.key]: e.thread } };
        case 'history':
          return { ...s, history: [...s.history, e.event].slice(-2000) };
        case 'transcript': {
          const lines = s.transcripts[e.line.agentId];
          if (!lines || lines.some((l) => l.id === e.line.id)) return s;
          return {
            ...s,
            transcripts: {
              ...s.transcripts,
              [e.line.agentId]: [...lines, e.line].slice(-500),
            },
          };
        }
      }
    }
  }
  return s;
}

export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function useBoard() {
  const [state, dispatch] = useReducer(reduce, initial);
  const stop = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    try {
      const snap = await api.state();
      dispatch({ t: 'snapshot', s: snap });
      const hist = await api.history(Date.now() - HISTORY_WINDOW_MS);
      dispatch({ t: 'history', events: hist.events });
      return true;
    } catch (err) {
      if (err instanceof Unauthorized) {
        stop.current?.();
        stop.current = null;
        dispatch({ t: 'auth', auth: 'needed' });
      } else {
        dispatch({
          t: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    }
  }, []);

  const connect = useCallback(async () => {
    if (!(await load())) return;
    stop.current?.();
    stop.current = subscribe(
      (e) => dispatch({ t: 'event', e }),
      () => {
        dispatch({ t: 'stream', up: true });
        void load();
      },
      () => dispatch({ t: 'stream', up: false })
    );
  }, [load]);

  useEffect(() => {
    void connect();
    return () => stop.current?.();
  }, [connect]);

  const openThread = useCallback(async (key: string) => {
    const res = await api.messages(key);
    dispatch({ t: 'messages', key, messages: res.messages });
    void api.markRead(key).catch(() => undefined);
  }, []);

  const openTranscript = useCallback(async (agentId: string) => {
    const res = await api.transcript(agentId);
    dispatch({ t: 'transcript', agentId, lines: res.lines });
  }, []);

  const markSeen = useCallback(
    (agentId: string) => dispatch({ t: 'seen', agentId }),
    []
  );

  const login = useCallback(
    async (token: string) => {
      await api.login(token);
      await connect();
    },
    [connect]
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    stop.current?.();
    stop.current = null;
    dispatch({ t: 'auth', auth: 'needed' });
  }, []);

  return { state, openThread, openTranscript, markSeen, login, logout, reload: load };
}
