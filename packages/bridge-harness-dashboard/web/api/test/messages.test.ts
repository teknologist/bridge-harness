import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMessageStore, TRANSCRIPT_KEEP } from '../src/messages.ts';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-store-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const dm = (from: string, to: string, content: string, timestamp: number) => ({
  from,
  to: `agent:${to}`,
  content,
  timestamp,
  threads: [
    { kind: 'dm' as const, agentId: from },
    { kind: 'dm' as const, agentId: to },
  ],
});

describe('message store', () => {
  // The dashboard replays JetStream on every start; replays must not duplicate threads.
  it('stores a replayed message once', () => {
    const store = openMessageStore(tempDir(), 30);
    expect(
      store.insert(dm('pi-1', 'claude-1', 'hi', 1000), true).messages
    ).toHaveLength(2);
    expect(
      store.insert(dm('pi-1', 'claude-1', 'hi', 1000), true).messages
    ).toHaveLength(0);
    expect(store.page('dm:pi-1', undefined, 50).messages).toHaveLength(1);
    store.close();
  });

  // The point of the database: threads and unread counts outlive a dashboard restart.
  it('keeps threads and unread counts across a reopen', () => {
    const dir = tempDir();
    const first = openMessageStore(dir, 30);
    first.insert(dm('pi-1', 'claude-1', 'one', Date.now() - 2000), true);
    first.insert(dm('claude-1', 'pi-1', 'two', Date.now() - 1000), true);
    first.markRead('dm:pi-1');
    first.close();

    const second = openMessageStore(dir, 30);
    const threads = new Map(second.threads().map((t) => [t.key, t]));
    expect(threads.get('dm:pi-1')).toMatchObject({
      messageCount: 2,
      unread: 0,
    });
    expect(threads.get('dm:claude-1')).toMatchObject({
      messageCount: 2,
      unread: 2,
    });
    second.close();
  });

  // Older pages must continue exactly where the previous page stopped, in time order.
  it('pages older messages without gaps or overlap', () => {
    const store = openMessageStore(tempDir(), 30);
    const now = Date.now();
    for (let i = 0; i < 5; i++)
      store.insert(dm('pi-1', 'claude-1', `m${i}`, now - 5000 + i), false);
    const latest = store.page('dm:pi-1', undefined, 2);
    expect(latest.messages.map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(latest.hasMore).toBe(true);
    const older = store.page('dm:pi-1', latest.messages[0].id, 10);
    expect(older.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
    expect(older.hasMore).toBe(false);
    store.close();
  });

  // Retention keeps the file bounded; expired threads disappear from the list.
  it('prunes messages past retention', () => {
    const store = openMessageStore(tempDir(), 1);
    const now = Date.now();
    store.insert(dm('pi-1', 'claude-1', 'old', now - 3 * 86_400_000), true);
    store.insert(dm('pi-2', 'claude-1', 'new', now), true);
    store.prune(now);
    expect(
      store
        .threads()
        .map((t) => t.key)
        .sort()
    ).toEqual(['dm:claude-1', 'dm:pi-2']);
    expect(store.threads().find((t) => t.key === 'dm:claude-1')).toMatchObject({
      messageCount: 1,
      unread: 1,
    });
    store.close();
  });

  // Agents replay their recent tail on restart; the pane must not show lines twice,
  // and one chatty agent must not grow the database without bound.
  it('stores transcript lines once and keeps only the newest per agent', () => {
    const store = openMessageStore(tempDir(), 30);
    const line = (n: number, agentId = 'claude-code-a') => ({
      id: `l${n}`, agentId, role: 'assistant' as const, text: `line ${n}`, timestamp: 1_000 + n,
    });
    expect(store.insertTranscript(line(1))).toBe(true);
    expect(store.insertTranscript(line(1))).toBe(false);
    for (let n = 2; n <= TRANSCRIPT_KEEP + 5; n++) store.insertTranscript(line(n));
    store.insertTranscript(line(1, 'pi-b'));
    const page = store.transcript('claude-code-a', undefined, 1000);
    expect(page.lines).toHaveLength(TRANSCRIPT_KEEP);
    expect(page.lines.at(0)?.id).toBe('l6');
    expect(page.lines.at(-1)?.id).toBe(`l${TRANSCRIPT_KEEP + 5}`);
    expect(store.transcript('pi-b', undefined, 10).lines.map((l) => l.text)).toEqual(['line 1']);
    const older = store.transcript('claude-code-a', 1_000 + 10, 3);
    expect(older).toEqual({ lines: expect.any(Array), hasMore: true });
    expect(older.lines.map((l) => l.id)).toEqual(['l7', 'l8', 'l9']);
    store.close();
  });
  // Transcript catch-up after a restart replays from the newest stored line.
  it("reports the newest stored transcript line", () => {
    const store = openMessageStore(tempDir(), 30);
    const line = (n: number, agentId = "claude-code-a") => ({
      id: `l${n}`, agentId, role: "assistant" as const, text: `line ${n}`, timestamp: 1_000 + n,
    });
    expect(store.latestTranscript()).toBeUndefined();
    store.insertTranscript(line(5));
    store.insertTranscript(line(9, "pi-b"));
    store.insertTranscript(line(7));
    expect(store.latestTranscript()).toBe(line(9).timestamp);
  });
});
