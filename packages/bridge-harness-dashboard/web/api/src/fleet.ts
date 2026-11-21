import { setTimeout as delay } from 'node:timers/promises';
import { connect, Events, JSONCodec, type ConnectionOptions, type NatsConnection, type Subscription } from 'nats';
import { getHost, getProject, NATS_CONNECT_OPTIONS, NATS_URL, PRESENCE_INTERVAL_MS, PRESENCE_TTL_MS } from '../../../../../dist/shared/config.js';
import { subjects } from '../../../../../dist/shared/subjects.js';
import { DM_STREAM, ensureDmStream } from '../../../../../dist/shared/jetstream.js';
import type { PresenceEvent } from '../../../../../dist/shared/presence.js';
import type { RegistryEvent } from '../../../../../dist/shared/types.js';
import type { BridgeStatus, ChatMessage, SendResponse, ServerEvent, StateResponse, ThreadRef } from '../../../shared/contract.ts';
import { Roster } from './roster.ts';
import type { MessageStore } from './messages.ts';
import type { openHistory } from './history.ts';

type Connection = Pick<NatsConnection, 'subscribe' | 'publish' | 'status' | 'closed' | 'close' | 'drain' | 'jetstream' | 'jetstreamManager'>;
type WireMessage = Pick<ChatMessage, 'from' | 'content' | 'timestamp'>;
const codec = JSONCodec<unknown>();
export const subjectToken = '^[^.*>\\s/:\\x00-\\x1f\\x7f]+$';
const tokenPattern = new RegExp(subjectToken, 'u');

export function createFleet(
  history: Awaited<ReturnType<typeof openHistory>>,
  store: MessageStore,
  emit: (event: ServerEvent) => void,
  warn: (message: string) => void,
  dial: (options: ConnectionOptions) => Promise<Connection> = connect,
) {
  const host = getHost();
  // A stable id keeps the dashboard's own DM thread (and its JetStream replay) across restarts.
  const agentId = process.env.BRIDGE_DASHBOARD_ID || `dashboard-${host.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
  // 'all' records every DM and room on the bridge, 'self' only what reaches the dashboard.
  const watchAll = process.env.BRIDGE_DASHBOARD_WATCH !== 'self';
  const self: BridgeStatus['self'] = { agentId, displayName: `Dashboard (${host})`, project: getProject() };
  if (![self.project, agentId].every(value => tokenPattern.test(value))) throw new Error('Invalid bridge project or dashboard agent ID');
  const safeUrl = NATS_URL.replace(/(^|\/\/)[^/@\s]+@/g, '$1');
  const status: BridgeStatus = { connected: false, natsUrl: safeUrl, error: 'Connecting to NATS', self, startedAt: Date.now() };
  const record = (...args: Parameters<typeof history.append>) => {
    try { emit({ type: 'history', event: history.append(...args) }); }
    catch { warn('Could not append dashboard history'); }
  };
  const roster = new Roster(agentId, emit, record);
  const aliases = new Set<string>();
  const stop = new AbortController();
  let nc: Connection | undefined;
  let room: Subscription | undefined;
  let joined = false;

  function append(refs: ThreadRef[], to: string, message: WireMessage): ChatMessage | undefined {
    const { messages, threads } = store.insert({ ...message, to, threads: refs }, message.from !== agentId);
    for (const stored of messages) emit({ type: 'message', message: stored });
    for (const thread of threads) emit({ type: 'thread', thread });
    return messages[0];
  }
  const own = (id: string) => id === agentId || aliases.has(id);
  const peer = (id: string) => roster.resolve(id)?.agentId ?? id;

  function publish(subject: string, data: unknown) {
    nc?.publish(subject, codec.encode(data));
  }
  function registry(type: RegistryEvent['type'], extra: Pick<RegistryEvent, 'room' | 'rooms'> = {}) {
    publish(subjects.registry(), { type, agentId, displayName: self.displayName, project: self.project, host, aliases: [...aliases], timestamp: Date.now(), ...extra } satisfies RegistryEvent);
  }
  function presence() {
    publish(subjects.presence(), { agent: agentId, status: 'active', project: self.project, host, task: self.status } satisfies PresenceEvent);
  }
  function statusChanged(connected: boolean, error?: string) {
    if (status.connected === connected && status.error === error) return;
    Object.assign(status, { connected, error });
    emit({ type: 'status', status });
  }

  function subscribe(connection: Connection, subject: string, receive: (data: Uint8Array, subject: string) => void) {
    return connection.subscribe(subject, { callback: (error, message) => {
      if (error || stop.signal.aborted) return;
      try { receive(message.data, message.subject); }
      catch { warn(`Ignored invalid bridge message on ${subject}`); }
    } });
  }
  function readMessage(data: Uint8Array): WireMessage {
    const message = codec.decode(data) as WireMessage;
    if (typeof message?.from !== 'string' || typeof message.content !== 'string' || !Number.isFinite(message.timestamp)) throw new Error('Invalid bridge message');
    return { from: message.from, content: message.content, timestamp: message.timestamp };
  }
  function dm(data: Uint8Array, subject: string) {
    const message = readMessage(data);
    const recipient = subject.slice(subjects.dm('').length);
    if (!tokenPattern.test(recipient)) return;
    const refs = [message.from, recipient].filter(id => !own(id)).map(id => ({ kind: 'dm', agentId: peer(id) }) satisfies ThreadRef);
    append([...new Map(refs.map(ref => [ref.agentId, ref])).values()], `agent:${recipient}`, message);
  }
  function roomMessage(data: Uint8Array, subject: string) {
    const [, project, , name] = subject.split('.');
    if (!project || !name) return;
    append([{ kind: 'room', project, room: name }], `room:${name}`, readMessage(data));
  }
  function subscribeRoom(connection: Connection) {
    if (!watchAll) room = subscribe(connection, subjects.room(self.project, self.project), roomMessage);
  }
  function announce() {
    registry('join');
    registry('room-join', { room: self.project });
    registry('who-there');
    presence();
  }
  async function backfill(connection: Connection, ids: string[]) {
    if (watchAll) ids = ['*'];
    try {
      await ensureDmStream(connection as NatsConnection);
      if (stop.signal.aborted || nc !== connection) return;
      await Promise.all(ids.map(async id => {
        const consumer = await connection.jetstream().consumers.get(DM_STREAM, { filterSubjects: subjects.dm(id) });
        try {
          const { num_pending } = await consumer.info();
          if (!num_pending || stop.signal.aborted) return;
          const messages = await consumer.fetch({ max_messages: num_pending, expires: 2_000 });
          for await (const message of messages) {
            if (stop.signal.aborted || nc !== connection) break;
            try { dm(message.data, message.subject); } catch { warn('Ignored invalid stored DM'); }
          }
        } finally {
          await consumer.delete();
        }
      }));
    } catch { if (!stop.signal.aborted) warn('DM backfill unavailable'); }
  }
  async function watch(connection: Connection) {
    for await (const event of connection.status()) {
      if (stop.signal.aborted) break;
      if (event.type === Events.Disconnect) statusChanged(false, 'Disconnected from NATS');
      if (event.type === Events.Reconnect) {
        statusChanged(true);
        announce();
        void backfill(connection, [agentId, ...aliases]);
      }
    }
  }
  async function run() {
    while (!stop.signal.aborted) {
      try {
        // A rejected initial dial lets HTTP report the outage while the outer loop retries.
        const connection = await dial({ ...NATS_CONNECT_OPTIONS, waitOnFirstConnect: false });
        if (stop.signal.aborted) { await connection.close(); return; }
        nc = connection;
        subscribe(connection, subjects.registry(), data => {
          const event = codec.decode(data) as RegistryEvent;
          if (typeof event?.agentId !== 'string' || !tokenPattern.test(event.agentId) || event.agentId === agentId) return;
          if (event.type === 'who-there') registry('here', { rooms: [self.project] });
          else if (typeof event.displayName === 'string' && ['join', 'here', 'leave', 'room-join', 'room-leave'].includes(event.type)) roster.registry(event);
        });
        subscribe(connection, subjects.presence(), data => {
          const event = codec.decode(data) as PresenceEvent;
          if (typeof event?.agent === 'string' && tokenPattern.test(event.agent) && typeof event.status === 'string') roster.presence(event);
        });
        if (watchAll) {
          subscribe(connection, subjects.dm('*'), dm);
          subscribe(connection, 'bridge.*.room.*', roomMessage);
        } else for (const id of [agentId, ...aliases]) subscribe(connection, subjects.dm(id), dm);
        subscribeRoom(connection);
        void watch(connection).catch(() => statusChanged(false, 'NATS status unavailable'));
        announce();
        if (!joined) {
          joined = true;
          record('join', self);
          record('room-join', self, self.project);
        }
        statusChanged(true);
        void backfill(connection, [agentId, ...aliases]);
        await connection.closed();
      } catch {
        await nc?.close();
      } finally {
        nc = undefined;
      }
      if (stop.signal.aborted) break;
      statusChanged(false, 'Could not connect to NATS');
      await delay(NATS_CONNECT_OPTIONS.reconnectTimeWait, undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  const heartbeat = setInterval(() => { if (status.connected) presence(); }, PRESENCE_INTERVAL_MS);
  const sweep = setInterval(() => roster.sweep(), 5_000);
  const prune = setInterval(() => {
    try { store.prune(); } catch { warn('Could not prune stored messages'); }
  }, 60 * 60 * 1000);
  const running = run();

  return {
    self,
    state(): StateResponse {
      const agents = roster.snapshot();
      const projects = [...new Set(agents.flatMap(agent => agent.project ? [agent.project] : []))].sort();
      return { status, agents, projects, threads: store.threads() };
    },
    messages(key: string, before: string | undefined, limit: number) {
      return store.page(key, before, limit);
    },
    read(key: string) {
      const thread = store.markRead(key);
      if (thread) emit({ type: 'thread', thread });
    },
    send(to: string, content: string): SendResponse | undefined {
      if (!status.connected) return;
      const [kind, target] = to.split(':');
      const recipient = kind === 'agent' ? roster.resolve(target) : undefined;
      const id = recipient?.agentId ?? target;
      const project = self.project;
      const message = { from: agentId, content, timestamp: Date.now() };
      publish(kind === 'room' ? subjects.room(project, target) : subjects.dm(id), message);
      const warning = kind === 'agent' && (!recipient || Date.now() - recipient.lastSeen >= PRESENCE_TTL_MS)
        ? `Agent "${target}" is not visible on the bridge.` : undefined;
      const ref: ThreadRef = kind === 'room' ? { kind, project, room: target } : { kind: 'dm', agentId: id };
      const stored = append([ref], `${kind}:${id}`, message)
        ?? { ...message, id: '', thread: ref.kind === 'room' ? `room:${project}/${target}` as const : `dm:${id}` as const, to: `${kind}:${id}` };
      return { ok: true, message: stored, warning };
    },
    updateSelf(name?: string, task?: string) {
      if (name !== undefined && name !== self.displayName) {
        self.displayName = name;
        if (name !== agentId && !aliases.has(name)) {
          aliases.add(name);
          if (nc) {
            if (!watchAll) subscribe(nc, subjects.dm(name), dm);
            if (status.connected) void backfill(nc, [name]);
          }
        }
        if (status.connected) registry('join');
        record('rename', self, name);
      }
      if (task !== undefined && (task || undefined) !== self.status) {
        self.status = task || undefined;
        if (status.connected) presence();
        record('task', self, self.status);
      }
      emit({ type: 'status', status });
    },
    switchProject(project: string) {
      if (project === self.project) return;
      if (status.connected) {
        registry('room-leave', { room: self.project });
        registry('leave');
      }
      record('room-leave', self, self.project);
      room?.unsubscribe();
      self.project = project;
      if (nc) subscribeRoom(nc);
      if (status.connected) announce();
      record('room-join', self, project);
      emit({ type: 'status', status });
    },
    async close() {
      stop.abort();
      clearInterval(heartbeat);
      clearInterval(sweep);
      clearInterval(prune);
      if (joined) {
        record('room-leave', self, self.project);
        record('leave', self);
      }
      if (status.connected && nc) {
        registry('room-leave', { room: self.project });
        registry('leave');
        try { await nc.drain(); } catch { await nc?.close(); }
      } else await nc?.close();
      await running;
      store.close();
    },
  };
}
