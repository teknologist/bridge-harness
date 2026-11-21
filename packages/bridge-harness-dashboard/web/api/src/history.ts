import { randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentPresence } from '../../../../../dist/shared/types.js';
import type { HistoryEvent, HistoryKind } from '../../../shared/contract.ts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function openHistory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'history.jsonl');
  let events: HistoryEvent[] = [];
  const cutoff = Date.now() - WEEK_MS;
  try {
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      try {
        const event: HistoryEvent = JSON.parse(line);
        if (event.timestamp >= cutoff && typeof event.agentId === 'string' && typeof event.id === 'string') events.push(event);
      } catch {
        // Ignore a partial record left by an interrupted write.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  let separator = '\n'; // Separate the first append from a possible partial final line.

  return {
    append(kind: HistoryKind, agent: Pick<AgentPresence, 'agentId' | 'displayName' | 'project'>, detail?: string) {
      const { agentId, displayName, project } = agent;
      const event: HistoryEvent = { id: randomUUID(), kind, agentId, displayName, project, detail, timestamp: Date.now() };
      appendFileSync(path, `${separator}${JSON.stringify(event)}\n`, { mode: 0o600 });
      separator = '';
      events.push(event);
      return event;
    },
    list(since: number, agentId: string | undefined, limit: number) {
      const cutoff = Date.now() - WEEK_MS;
      events = events.filter(event => event.timestamp >= cutoff);
      return events.filter(event => event.timestamp >= since && (!agentId || event.agentId === agentId)).slice(-limit);
    },
  };
}
