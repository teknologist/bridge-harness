import type {
  HistoryResponse,
  MessagesResponse,
  SelfRequest,
  SendResponse,
  ServerEvent,
  SpawnRequest,
  SpawnResponse,
  StateResponse,
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
  markRead: (key: string) => post<{ ok: true }>('/threads/read', { key }),
  history: (since: number) =>
    call<HistoryResponse>(`/history?since=${since}&limit=1000`),
  send: (to: string, message: string) =>
    post<SendResponse>('/send', { to, message }),
  self: (req: SelfRequest) => post<{ ok: true }>('/self', req),
  project: (project: string) =>
    post<{ ok: true; project: string }>('/project', { project }),
  spawn: (req: SpawnRequest) => post<SpawnResponse>('/spawn', req),
};

const EVENT_TYPES: ServerEvent['type'][] = [
  'status',
  'agent',
  'agent-drop',
  'message',
  'thread',
  'history',
];

/**
 * Subscribes to /api/events. `onOpen` fires on every (re)connect so the caller can
 * refetch /api/state, as the contract requires. EventSource reconnects by itself;
 * a 401 surfaces as a closed stream, which the caller detects with a state fetch.
 */
export function subscribe(
  onEvent: (e: ServerEvent) => void,
  onOpen: () => void,
  onDown: () => void
) {
  const es = new EventSource('/api/events', { withCredentials: true });
  es.onopen = onOpen;
  es.onerror = onDown;
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (msg) => {
      try {
        onEvent(JSON.parse((msg as MessageEvent<string>).data) as ServerEvent);
      } catch {
        /* malformed frame: ignore, next /state refetch repairs */
      }
    });
  }
  return () => es.close();
}
