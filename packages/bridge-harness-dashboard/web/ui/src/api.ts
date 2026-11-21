import type {
  HistoryResponse,
  MessagesResponse,
  SelfRequest,
  SendResponse,
  ServerEvent,
  DirsResponse,
  HostsResponse,
  PaneInput,
  PaneScreen,
  SpawnRequest,
  SpawnResponse,
  StateResponse,
  TranscriptLine,
  TranscriptResponse,
} from '../../../shared/contract.ts';

export class Unauthorized extends Error {}

async function call<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers:
      init?.body === undefined
        ? undefined
        : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) throw new Unauthorized('Session expired');
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', body });

export const api = {
  login: (token: string) => post<{ ok: true }>('/login', { token }),
  logout: () => post<{ ok: true }>('/logout', {}),
  state: () => call<StateResponse>('/state'),
  messages: (key: string, before?: string) =>
    call<MessagesResponse>(
      `/threads/messages?key=${encodeURIComponent(key)}&limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`
    ),
  transcript: (agentId: string) =>
    call<TranscriptResponse>(`/transcript?agentId=${encodeURIComponent(agentId)}&limit=500`),
  markRead: (key: string) => post<{ ok: true }>('/threads/read', { key }),
  history: (since: number) =>
    call<HistoryResponse>(`/history?since=${since}&limit=1000`),
  send: (to: string, message: string) =>
    post<SendResponse>('/send', { to, message }),
  self: (req: SelfRequest) => post<{ ok: true }>('/self', req),
  project: (project: string) =>
    post<{ ok: true; project: string }>('/project', { project }),
  spawn: (req: SpawnRequest) => post<SpawnResponse>('/spawn', req),
  hosts: () => call<HostsResponse>('/hosts'),
  dirs: (host: string, path: string, prefix: string) =>
    call<DirsResponse>(`/dirs?${new URLSearchParams({ host, path, prefix })}`),
  pane: (agentId: string) => call<PaneScreen>(`/pane/${encodeURIComponent(agentId)}`),
  type: (agentId: string, input: PaneInput) =>
    post<{ ok: true }>(`/pane/${encodeURIComponent(agentId)}`, input),
  shutDown: (agentId: string) =>
    post<{ ok: true }>(`/pane/${encodeURIComponent(agentId)}/close`, {}),
};

const EVENT_TYPES: ServerEvent['type'][] = [
  'status',
  'agent',
  'agent-drop',
  'message',
  'thread',
  'history',
  'transcript',
];

/**
 * Subscribes to /api/events. `onOpen` fires on every (re)connect so the caller can
 * refetch /api/state, as the contract requires. EventSource retries a dropped stream
 * by itself, but gives up for good on an error response (a 500 while `wattpm dev`
 * restarts the API), so a closed stream is reopened here with backoff. A 401 shows
 * up the same way; the caller's state fetch on reopen detects it.
 */
export function subscribe(
  onEvent: (e: ServerEvent) => void,
  onOpen: () => void,
  onDown: () => void
) {
  let es: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_000;
  let stopped = false;
  const open = () => {
    es = new EventSource('/api/events', { withCredentials: true });
    es.onopen = () => {
      delay = 1_000;
      onOpen();
    };
    es.onerror = () => {
      onDown();
      if (stopped || es?.readyState !== EventSource.CLOSED) return;
      es.close();
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (msg) => {
        try {
          onEvent(JSON.parse((msg as MessageEvent<string>).data) as ServerEvent);
        } catch {
          /* malformed frame: ignore, next /state refetch repairs */
        }
      });
    }
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    es?.close();
  };
}
