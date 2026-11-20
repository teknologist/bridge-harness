import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { Agent, Probe } from '../types';

// Bridge roster pane for Claude Code, like Pi's /bridge overlay. The module has no
// sockets: a session-long Node helper (helper/bridge-tap.mjs, bundled with nats) taps
// presence, registry and this agent's DMs and prints one JSON line per event.

const PANE = 'bridge';
const STALE_MS = 60_000;
const DROP_MS = 5 * 60_000;
const RESTART_MS = 5_000;

const roster = atom(
  { plugin: 'bridge-pane', key: 'roster' } as const,
  {} as Record<string, Agent>,
  {
    shape: 'roster-1',
  }
);
const probe = atom(
  { plugin: 'bridge-pane', key: 'probe' } as const,
  { connected: false, ticks: 0, starts: 0, dms: 0, wake: false } as Probe,
  { shape: 'probe-1' }
);

type Line = { t: string; [k: string]: any };

function kind(id: string): string {
  if (id.startsWith('claude-code')) return 'claude';
  if (id.startsWith('pi')) return 'pi';
  return 'agent';
}

function label(a: Agent): string {
  return (
    a.aliases[0] ??
    (a.displayName && a.displayName !== a.agentId ? a.displayName : a.agentId)
  );
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

function applyPresence(
  list: Record<string, Agent>,
  d: any,
  now: number
): Record<string, Agent> {
  if (!d?.agent) return list;
  const next = { ...list };
  if (d.status === 'offline') {
    delete next[d.agent];
    return next;
  }
  const prev = next[d.agent];
  next[d.agent] = {
    agentId: d.agent,
    displayName: prev?.displayName ?? d.agent,
    project: d.project ?? prev?.project,
    host: d.host ?? prev?.host,
    task: d.task,
    rooms: prev?.rooms ?? [],
    aliases: prev?.aliases ?? [],
    lastSeen: now,
  };
  return next;
}

function applyRegistry(
  list: Record<string, Agent>,
  d: any,
  now: number
): Record<string, Agent> {
  if (!d?.agentId || d.type === 'who-there') return list;
  const next = { ...list };
  const prev = next[d.agentId];
  if (d.type === 'leave') {
    delete next[d.agentId];
    return next;
  }
  let rooms = prev?.rooms ?? [];
  if (d.type === 'here' && d.rooms) rooms = d.rooms;
  if (d.type === 'room-join' && d.room && !rooms.includes(d.room))
    rooms = [...rooms, d.room];
  if (d.type === 'room-leave' && d.room)
    rooms = rooms.filter((r) => r !== d.room);
  next[d.agentId] = {
    agentId: d.agentId,
    displayName: d.displayName ?? prev?.displayName ?? d.agentId,
    project: d.project ?? prev?.project,
    host: d.host ?? prev?.host,
    task: prev?.task,
    rooms,
    aliases: d.aliases ?? prev?.aliases ?? [],
    lastSeen: now,
  };
  return next;
}

// Bumped on every (re)start of the module: a loop from an older copy stops restarting.
let generation = 0;

async function handle($: EngineInterface, line: Line) {
  const now = await $.clock.now();
  switch (line.t) {
    case 'hello':
      await update($, probe, (p) => ({
        ...p,
        selfId: line.agentId,
        natsUrl: line.url,
        helperPid: line.pid,
        helperPpid: line.ppid,
        startedAt: line.startedAt,
        starts: p.starts + 1,
        error: undefined,
      }));
      break;
    case 'connected':
      await update($, probe, (p) => ({ ...p, connected: true }));
      break;
    case 'error':
      await update($, probe, (p) => ({
        ...p,
        connected: false,
        error: line.message,
      }));
      break;
    case 'tick':
      await update($, probe, (p) => ({
        ...p,
        ticks: p.ticks + 1,
        lastTickAt: now,
      }));
      await update($, roster, (list) =>
        Object.fromEntries(
          Object.entries(list).filter(([, a]) => now - a.lastSeen < DROP_MS)
        )
      );
      break;
    case 'presence':
      await update($, roster, (list) => applyPresence(list, line.data, now));
      break;
    case 'registry':
      await update($, roster, (list) => applyRegistry(list, line.data, now));
      break;
    case 'dm': {
      const p = await update($, probe, (p) => ({ ...p, dms: p.dms + 1 }));
      const from = line.data?.from ?? line.data?.sender ?? 'someone';
      $.ui.toast(`bridge: DM from ${from}`);
      if (p.wake) {
        const text =
          typeof line.data?.content === 'string'
            ? line.data.content
            : JSON.stringify(line.data);
        void $.prompt.submit({
          text: `[bridge] DM from ${from}: ${text}`,
        });
      }
      break;
    }
  }
}

async function runHelper($: EngineInterface, gen: number) {
  const env = await $.process.hookEnv();
  const root = env.CLAUDE_PLUGIN_ROOT;
  const child = $.process.spawn({
    argv: ['node', `${root}/helper/bridge-tap.mjs`],
    env,
  });
  let buf = '';
  let ended = 'stream ended';
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        $.ui.log(`bridge-tap: ${text.trim()}`, { to: 'debug' });
        continue;
      }
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          await handle($, JSON.parse(raw));
        } catch {
          // a malformed line is skipped
        }
      }
    }
  } catch (err) {
    ended = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  await update($, probe, (p) => ({
    ...p,
    connected: false,
    lastExit: ended,
  }));
  if (gen === generation)
    $.clock.after(RESTART_MS, () => void runHelper($, gen));
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bridge',
      description:
        'Bridge roster pane. Args: close, restart, wake on|off (experimental DM wake)',
    });
    const started = await next(e);
    const gen = ++generation;
    void runHelper($, gen);
    return started;
  });

  on('command.run', { command: 'bridge' }, async ($, e) => {
    const args = e.args.trim();
    if (args === 'wake on' || args === 'wake off') {
      const wake = args === 'wake on';
      await update($, probe, (p) => ({ ...p, wake }));
      return { text: `bridge-pane: DM wake ${wake ? 'on' : 'off'}` };
    }
    if (args === 'restart') {
      const gen = ++generation;
      void runHelper($, gen);
      return {
        text: 'bridge-pane: started a new tap (the old one keeps running until its stream ends)',
      };
    }
    if (args === 'close') {
      await $.ui.close({ id: PANE });
      return { text: 'Bridge pane closed.' };
    }
    await $.ui.open({ id: PANE, title: 'Bridge' });
    return { text: 'Bridge pane opened. /bridge close to close it.' };
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const p = await read($, probe);
    const list = Object.values(await read($, roster));
    const now = await $.clock.now();
    const self = list.find((a) => a.agentId === p.selfId);
    const selfHost = self?.host;

    const hosts = new Map<string, Agent[]>();
    for (const a of list) {
      const h = a.host ?? 'unknown host';
      if (!hosts.has(h)) hosts.set(h, []);
      hosts.get(h)!.push(a);
    }
    const groups = [...hosts.entries()]
      .sort(([a], [b]) =>
        a === selfHost ? -1 : b === selfHost ? 1 : a.localeCompare(b)
      )
      .map(([host, agents]) => ({
        host,
        agents: agents.sort((x, y) =>
          x.agentId === p.selfId
            ? -1
            : y.agentId === p.selfId
              ? 1
              : label(x).localeCompare(label(y))
        ),
      }));

    const uptime = p.startedAt ? age(now - p.startedAt) : '-';
    const lastTick = p.lastTickAt ? `${age(now - p.lastTickAt)} ago` : 'never';

    return (
      <Box flexDirection="column">
        <Text>
          <Text color={p.connected ? 'green' : 'red'}>
            {p.connected ? '●' : '○'}
          </Text>{' '}
          {p.selfId ?? 'no CLAUDE_PID'} <Text dimColor>{p.natsUrl ?? ''}</Text>
        </Text>
        {p.error && <Text color="red">{p.error}</Text>}
        <Text dimColor>
          tap pid {p.helperPid ?? '-'} (ppid {p.helperPpid ?? '-'}) · up{' '}
          {uptime} · tick {lastTick} · starts {p.starts} · DMs {p.dms}
          {p.wake ? ' · wake on' : ''}
        </Text>
        {p.lastExit && <Text dimColor>last exit: {p.lastExit}</Text>}
        <Text> </Text>
        {list.length === 0 && <Text dimColor>No agents heard yet.</Text>}
        {groups.map((g) => (
          <Box flexDirection="column">
            <Text bold>{g.host}</Text>
            {g.agents.map((a) => {
              const stale = now - a.lastSeen > STALE_MS;
              const isSelf = a.agentId === p.selfId;
              return (
                <Box flexDirection="column">
                  <Text dimColor={stale}>
                    {isSelf ? '▶ ' : '  '}
                    <Text bold={isSelf}>{label(a)}</Text>{' '}
                    <Text dimColor>
                      {kind(a.agentId)} · {a.project ?? '?'} ·{' '}
                      {age(now - a.lastSeen)}
                    </Text>
                  </Text>
                  {a.task && <Text dimColor> {a.task}</Text>}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    );
  });
};
