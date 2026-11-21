import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKFILL_LINES, createTranscriptTail } from "../../src/mcp-server/transcript-tail.js";
import type { TranscriptLine } from "../../src/shared/transcript.js";

const entry = (uuid: string, type: string, text: string) =>
  JSON.stringify({ uuid, type, timestamp: "2026-11-21T16:00:00Z", message: { content: type === "user" ? text : [{ type: "text", text }] } }) + "\n";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The tail must publish each conversation line exactly once as Claude appends to the
// session file, including a line whose bytes arrive across two polls.
describe("createTranscriptTail", () => {
  it("streams appended lines once, across partial writes", async () => {
    dir = mkdtempSync(join(tmpdir(), "tail-"));
    const session = join(dir, "s.jsonl");
    const pathFile = join(dir, "path.txt");
    writeFileSync(session, entry("a", "user", "hello"));
    writeFileSync(pathFile, session);
    const got: TranscriptLine[] = [];
    const tail = createTranscriptTail(pathFile, "claude-code-1", (l) => got.push(l));

    await tail.poll();
    expect(got.map((l) => l.id)).toEqual(["a"]);

    const next = entry("b", "assistant", "hi there");
    appendFileSync(session, next.slice(0, 20));
    await tail.poll();
    expect(got).toHaveLength(1);
    appendFileSync(session, next.slice(20));
    await tail.poll();
    await tail.poll();
    expect(got.map((l) => [l.id, l.role, l.text])).toEqual([["a", "user", "hello"], ["b", "assistant", "hi there"]]);
  });

  // Opening an agent must show what it was just saying, even though Claude session files
  // carry large tool-output entries between conversation lines.
  it("replays the last conversation lines of an existing session, then follows", async () => {
    dir = mkdtempSync(join(tmpdir(), "tail-"));
    const session = join(dir, "s.jsonl");
    const pathFile = join(dir, "path.txt");
    const bulk = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(300_000) }] } }) + "\n";
    let body = "";
    for (let i = 0; i < BACKFILL_LINES + 20; i++) body += entry(`m${i}`, "assistant", `line ${i}`) + (i % 10 === 0 ? bulk : "");
    const partial = entry("late", "user", "typed after");
    writeFileSync(session, body + partial.slice(0, 15));
    writeFileSync(pathFile, session);
    const got: TranscriptLine[] = [];
    const tail = createTranscriptTail(pathFile, "claude-code-1", (l) => got.push(l));

    await tail.poll();
    expect(got).toHaveLength(BACKFILL_LINES);
    expect(got.at(0)?.id).toBe("m20");
    expect(got.at(-1)?.id).toBe(`m${BACKFILL_LINES + 19}`);

    appendFileSync(session, partial.slice(15));
    await tail.poll();
    expect(got.at(-1)?.id).toBe("late");
    expect(got).toHaveLength(BACKFILL_LINES + 1);
  });
});
