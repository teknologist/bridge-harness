import { open, readFile, stat } from "node:fs/promises";
import { parseClaudeTranscriptLine, type TranscriptLine } from "../shared/transcript.js";

/** Conversation lines to replay when a transcript is first found (the dashboard dedupes by id). */
export const BACKFILL_LINES = 100;
/**
 * Claude session files hold ~100 KB of tool output and request blobs per conversation
 * line, so the replay scans back this far at most, once per session.
 */
const BACKFILL_MAX_BYTES = 16 * 1024 * 1024;
const READ_MAX_BYTES = 1024 * 1024;

/**
 * Follows the session transcript whose path hooks/bridge-task.js writes to `pathFile`,
 * handing each new conversation line to `publish`. Call poll() on an interval.
 */
export function createTranscriptTail(pathFile: string, agentId: string, publish: (line: TranscriptLine) => void) {
  let path: string | undefined;
  let offset = 0;
  let rest = "";
  let busy = false;

  /** Publishes the last conversation lines and returns where the forward read resumes. */
  async function backfill(file: string, size: number): Promise<number> {
    const start = Math.max(0, size - BACKFILL_MAX_BYTES);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const raws = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start > 0) raws.shift(); // partial first line
      raws.pop(); // partial (or empty) last line: the forward read picks it up
      const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      const found: TranscriptLine[] = [];
      for (const raw of raws) {
        const line = parseClaudeTranscriptLine(raw, agentId);
        if (line) found.push(line);
      }
      for (const line of found.slice(-BACKFILL_LINES)) publish(line);
      return lastNewline >= 0 ? start + lastNewline + 1 : start;
    } finally {
      await handle.close();
    }
  }

  async function poll(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const next = (await readFile(pathFile, "utf8").catch(() => "")).trim();
      if (!next) return;
      const size = (await stat(next)).size;
      if (next !== path || size < offset) {
        // New session (or /clear rewrote it): replay its last conversation lines, then follow.
        path = next;
        rest = "";
        offset = await backfill(path, size);
      }
      if (size === offset) return;
      const handle = await open(path, "r");
      try {
        const length = Math.min(size - offset, READ_MAX_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        offset += bytesRead;
        const lines = (rest + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
        rest = lines.pop() ?? "";
        for (const raw of lines) {
          const line = parseClaudeTranscriptLine(raw, agentId);
          if (line) publish(line);
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Transcript missing or unreadable: try again next tick.
    } finally {
      busy = false;
    }
  }

  return { poll };
}
