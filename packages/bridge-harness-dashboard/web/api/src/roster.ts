import { PRESENCE_TTL_MS } from '../../../../../dist/shared/config.js';
import { applyPresenceEvent, type PresenceEvent } from '../../../../../dist/shared/presence.js';
import type { AgentPresence, RegistryEvent } from '../../../../../dist/shared/types.js';
import type { AgentView, HistoryKind, ServerEvent } from '../../../shared/contract.ts';

const DROP_MS = 300_000;

export class Roster {
  private readonly agents = new Map<string, AgentPresence>();
  private readonly stale = new Set<string>();
  private readonly self: string;
  private readonly emit: (event: ServerEvent) => void;
  private readonly record: (kind: HistoryKind, agent: AgentPresence, detail?: string) => void;

  constructor(self: string, emit: Roster['emit'], record: Roster['record']) {
    this.self = self;
    this.emit = emit;
    this.record = record;
  }

  private view(agent: AgentPresence): AgentView {
    const { agentId, rooms, aliases } = agent;
    const kind = agentId.startsWith('claude-code-') ? 'claude'
      : agentId.startsWith('pi-') ? 'pi' : agentId.startsWith('codex-') ? 'codex' : agentId.startsWith('dashboard-') ? 'human' : 'other';
    return { ...agent, kind, rooms: [...rooms], aliases: [...aliases], liveness: this.stale.has(agentId) ? 'stale' : 'live' };
  }

  snapshot(): AgentView[] {
    return [...this.agents.values()].map(agent => this.view(agent));
  }

  resolve(target: string): AgentPresence | undefined {
    return this.agents.get(target) ?? [...this.agents.values()].find(agent => agent.aliases.has(target));
  }

  /** Drops an agent the dashboard shut down: a killed process never says goodbye. */
  forget(agentId: string) {
    const agent = this.resolve(agentId);
    if (agent) this.remove(agent, 'leave');
  }

  private remove(agent: AgentPresence, kind: 'leave' | 'drop') {
    this.agents.delete(agent.agentId);
    this.stale.delete(agent.agentId);
    this.record(kind, agent);
    this.emit({ type: 'agent-drop', agentId: agent.agentId });
  }

  private seen(agent: AgentPresence) {
    if (this.stale.delete(agent.agentId)) this.record('back', agent);
    this.emit({ type: 'agent', agent: this.view(agent) });
  }

  presence(event: PresenceEvent, now = Date.now()) {
    if (event.agent === this.self) return;
    const previous = this.agents.get(event.agent);
    if (event.status === 'offline') {
      if (previous) this.remove(previous, 'leave');
      return;
    }
    const task = previous?.task;
    applyPresenceEvent(this.agents, event, this.self, now);
    const agent = this.agents.get(event.agent);
    if (!agent) return;
    if (!previous) this.record('join', agent);
    if (task !== agent.task) this.record('task', agent, agent.task);
    this.seen(agent);
  }

  registry(event: RegistryEvent, now = Date.now()) {
    if (event.agentId === this.self || event.type === 'who-there') return;
    const previous = this.agents.get(event.agentId);
    if (event.type === 'join' || event.type === 'here') {
      const agent: AgentPresence = {
        agentId: event.agentId,
        displayName: event.displayName,
        project: event.project ?? previous?.project,
        host: event.host ?? previous?.host,
        repo: event.repo ?? previous?.repo,
        branch: event.branch ?? previous?.branch,
        task: previous?.task,
        activity: previous?.activity,
        pane: previous?.pane,
        aliases: new Set(event.aliases),
        rooms: event.type === 'here' ? new Set(event.rooms) : previous?.rooms ?? new Set(),
        joinedAt: previous?.joinedAt ?? now,
        lastSeen: now,
      };
      this.agents.set(agent.agentId, agent);
      if (!previous) this.record('join', agent);
      else if (previous.displayName !== agent.displayName) this.record('rename', agent, agent.displayName);
      for (const room of agent.rooms) if (!previous?.rooms.has(room)) this.record('room-join', agent, room);
      if (previous) {
        for (const room of previous.rooms) if (!agent.rooms.has(room)) this.record('room-leave', previous, room);
      }
      this.seen(agent);
    } else if (previous && event.type === 'leave') {
      this.remove(previous, 'leave');
    } else if (previous && event.room) {
      const joined = event.type === 'room-join';
      if (joined === previous.rooms.has(event.room)) return;
      if (joined) previous.rooms.add(event.room);
      else previous.rooms.delete(event.room);
      this.record(joined ? 'room-join' : 'room-leave', previous, event.room);
      this.emit({ type: 'agent', agent: this.view(previous) });
    }
  }

  sweep(now = Date.now()) {
    for (const agent of this.agents.values()) {
      const age = now - agent.lastSeen;
      if (age > DROP_MS) this.remove(agent, 'drop');
      else if (age >= PRESENCE_TTL_MS && !this.stale.has(agent.agentId)) {
        this.stale.add(agent.agentId);
        this.record('stale', agent);
        this.emit({ type: 'agent', agent: this.view(agent) });
      }
    }
  }
}
