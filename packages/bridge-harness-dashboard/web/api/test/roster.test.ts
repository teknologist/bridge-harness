import { expect, it, vi } from 'vitest';
import type { RegistryEvent } from '../../../../../dist/shared/types.js';
import { Roster } from '../src/roster.ts';

it('preserves rooms and task on rename, then emits stale, back, and drop transitions', () => {
  const emit = vi.fn();
  const record = vi.fn();
  const roster = new Roster('dashboard-1', emit, record);
  const identity: RegistryEvent = { type: 'here', agentId: 'pi-1', displayName: 'Pi', rooms: ['lobby'], timestamp: 0 };
  roster.registry({ ...identity, agentId: 'dashboard-1' }, 0);
  roster.registry(identity, 0);
  const heartbeat = { agent: 'pi-1', status: 'active', task: 'check' };
  roster.presence(heartbeat, 10);
  roster.registry({ ...identity, type: 'join', displayName: 'review', aliases: ['review'], rooms: undefined }, 20);
  expect(roster.snapshot()).toEqual([expect.objectContaining({ displayName: 'review', task: 'check', rooms: ['lobby'], kind: 'pi', joinedAt: 0 })]);
  expect(roster.resolve('review')?.agentId).toBe('pi-1');
  roster.sweep(60_019);
  expect(roster.snapshot()[0].liveness).toBe('live');
  roster.sweep(60_020);
  expect(emit).toHaveBeenLastCalledWith({ type: 'agent', agent: expect.objectContaining({ liveness: 'stale' }) });
  roster.sweep(65_000);
  roster.presence(heartbeat, 65_010);
  expect(roster.snapshot()[0].liveness).toBe('live');
  roster.registry({ ...identity, type: 'room-leave', room: 'lobby' }, 65_020);
  expect(roster.snapshot()[0].rooms).toEqual([]);
  roster.sweep(365_011);
  expect(roster.snapshot()).toEqual([]);
  expect(emit).toHaveBeenLastCalledWith({ type: 'agent-drop', agentId: 'pi-1' });
  expect(record.mock.calls.map(([kind]) => kind)).toEqual(['join', 'room-join', 'task', 'rename', 'stale', 'back', 'room-leave', 'drop']);
});

it('forgets an agent the dashboard shut down, since a killed process never says goodbye', () => {
  const emit = vi.fn();
  const record = vi.fn();
  const roster = new Roster('dashboard-1', emit, record);
  roster.registry({ type: 'here', agentId: 'pi-1', displayName: 'Pi', rooms: ['lobby'], timestamp: 0 }, 0);
  roster.forget('pi-1');
  expect(roster.snapshot()).toEqual([]);
  expect(emit).toHaveBeenLastCalledWith({ type: 'agent-drop', agentId: 'pi-1' });
  expect(record.mock.calls.at(-1)?.[0]).toBe('leave');
});
