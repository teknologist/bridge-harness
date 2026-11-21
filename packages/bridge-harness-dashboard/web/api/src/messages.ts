import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChatMessage,
  MessagesResponse,
  ThreadKey,
  ThreadRef,
  ThreadSummary,
} from '../../../shared/contract.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One bridge message plus every thread it belongs to (a DM sits in both participants' threads). */
export type IncomingMessage = Pick<
  ChatMessage,
  'from' | 'to' | 'content' | 'timestamp'
> & { threads: ThreadRef[] };

/**
 * Durable message log behind the dashboard threads. Kept narrow so a Postgres
 * implementation can replace SQLite for a cloud deployment.
 */
export interface MessageStore {
  /** Stores a message once; returns it per thread, or [] when it was already stored (replays, own echoes). */
  insert(
    message: IncomingMessage,
    countUnread: boolean
  ): { messages: ChatMessage[]; threads: ThreadSummary[] };
  page(
    key: string,
    before: string | undefined,
    limit: number
  ): MessagesResponse;
  threads(): ThreadSummary[];
  markRead(key: string): ThreadSummary | undefined;
  prune(now?: number): void;
  close(): void;
}

export function openMessageStore(
  directory: string,
  retentionDays: number
): MessageStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'messages.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      UNIQUE (sender, recipient, timestamp, content)
    );
    CREATE TABLE IF NOT EXISTS threads (
      key TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      unread INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS thread_messages (
      thread TEXT NOT NULL REFERENCES threads(key) ON DELETE CASCADE,
      message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      PRIMARY KEY (thread, message)
    );
    CREATE INDEX IF NOT EXISTS thread_messages_page ON thread_messages (thread, timestamp, message);
    CREATE INDEX IF NOT EXISTS messages_age ON messages (timestamp);
  `);

  const insertMessage = db.prepare(
    'INSERT OR IGNORE INTO messages (sender, recipient, content, timestamp) VALUES (?, ?, ?, ?)'
  );
  const upsertThread = db.prepare(
    'INSERT INTO threads (key, ref) VALUES (?, ?) ON CONFLICT (key) DO NOTHING'
  );
  const link = db.prepare(
    'INSERT INTO thread_messages (thread, message, timestamp) VALUES (?, ?, ?)'
  );
  const bumpUnread = db.prepare(
    'UPDATE threads SET unread = unread + 1 WHERE key = ?'
  );
  const clearUnread = db.prepare('UPDATE threads SET unread = 0 WHERE key = ?');
  const summaryOf = db.prepare(`
    SELECT t.key, t.ref, t.unread, COUNT(tm.message) AS count, MAX(tm.timestamp) AS last
    FROM threads t LEFT JOIN thread_messages tm ON tm.thread = t.key
    WHERE t.key = ? GROUP BY t.key`);
  const allSummaries = db.prepare(`
    SELECT t.key, t.ref, t.unread, COUNT(tm.message) AS count, MAX(tm.timestamp) AS last
    FROM threads t JOIN thread_messages tm ON tm.thread = t.key
    GROUP BY t.key ORDER BY last DESC`);
  const cursorOf = db.prepare(
    'SELECT timestamp FROM thread_messages WHERE thread = ? AND message = ?'
  );
  const pageRows = db.prepare(`
    SELECT m.id, m.sender, m.recipient, m.content, m.timestamp FROM thread_messages tm
    JOIN messages m ON m.id = tm.message
    WHERE tm.thread = ? AND (tm.timestamp, tm.message) < (?, ?)
    ORDER BY tm.timestamp DESC, tm.message DESC LIMIT ?`);
  const deleteOld = db.prepare('DELETE FROM messages WHERE timestamp < ?');
  const deleteEmpty = db.prepare(
    'DELETE FROM threads WHERE key NOT IN (SELECT DISTINCT thread FROM thread_messages)'
  );
  const fixUnread = db.prepare(
    'UPDATE threads SET unread = MIN(unread, (SELECT COUNT(*) FROM thread_messages WHERE thread = threads.key))'
  );

  type SummaryRow = {
    key: string;
    ref: string;
    unread: number;
    count: number;
    last: number | null;
  };
  const summary = (row: SummaryRow): ThreadSummary => ({
    key: row.key as ThreadKey,
    ref: JSON.parse(row.ref) as ThreadRef,
    unread: row.unread,
    messageCount: row.count,
    lastMessageAt: row.last ?? undefined,
  });
  const keyOf = (ref: ThreadRef): ThreadKey =>
    ref.kind === 'room'
      ? `room:${ref.project}/${ref.room}`
      : `dm:${ref.agentId}`;
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const store: MessageStore = {
    insert(message, countUnread) {
      return transaction(() => {
        const result = insertMessage.run(
          message.from,
          message.to,
          message.content,
          message.timestamp
        );
        if (result.changes === 0) return { messages: [], threads: [] };
        const id = Number(result.lastInsertRowid);
        const messages: ChatMessage[] = [];
        const threads: ThreadSummary[] = [];
        for (const ref of message.threads) {
          const key = keyOf(ref);
          upsertThread.run(key, JSON.stringify(ref));
          link.run(key, id, message.timestamp);
          if (countUnread) bumpUnread.run(key);
          messages.push({
            id: String(id),
            thread: key,
            from: message.from,
            to: message.to,
            content: message.content,
            timestamp: message.timestamp,
          });
          threads.push(summary(summaryOf.get(key) as SummaryRow));
        }
        return { messages, threads };
      });
    },
    page(key, before, limit) {
      let cursor: [number, number] = [
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ];
      if (before !== undefined) {
        const row = cursorOf.get(key, Number(before)) as
          | { timestamp: number }
          | undefined;
        if (!row) return { messages: [], hasMore: false };
        cursor = [row.timestamp, Number(before)];
      }
      const rows = pageRows.all(key, cursor[0], cursor[1], limit + 1) as {
        id: number;
        sender: string;
        recipient: string;
        content: string;
        timestamp: number;
      }[];
      const hasMore = rows.length > limit;
      const messages = rows
        .slice(0, limit)
        .reverse()
        .map((row) => ({
          id: String(row.id),
          thread: key as ThreadKey,
          from: row.sender,
          to: row.recipient,
          content: row.content,
          timestamp: row.timestamp,
        }));
      return { messages, hasMore };
    },
    threads() {
      return (allSummaries.all() as SummaryRow[]).map(summary);
    },
    markRead(key) {
      clearUnread.run(key);
      const row = summaryOf.get(key) as SummaryRow | undefined;
      return row ? summary(row) : undefined;
    },
    prune(now = Date.now()) {
      transaction(() => {
        deleteOld.run(now - retentionDays * DAY_MS);
        deleteEmpty.run();
        fixUnread.run();
      });
    },
    close() {
      db.close();
    },
  };
  store.prune();
  return store;
}
