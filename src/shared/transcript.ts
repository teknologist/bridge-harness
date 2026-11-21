// Live transcript: the talk of an agent's session (user prompts and assistant
// replies, no tool calls or output) published on subjects.transcript(agentId).
// On by default; BRIDGE_SHARE_TRANSCRIPT=0 keeps an agent's transcript private.

export interface TranscriptLine {
  /** Stable per line, so replays after a restart dedupe. */
  id: string;
  agentId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export const TRANSCRIPT_TEXT_MAX = 8000;

export function shareTranscriptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.BRIDGE_SHARE_TRANSCRIPT ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

/** Strips harness noise from a user prompt; undefined when nothing human is left. */
export function cleanPromptText(raw: string): string | undefined {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(raw);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(raw)?.[1]?.trim();
    return [command[1].trim(), args].filter(Boolean).join(" ") || undefined;
  }
  if (/^\s*<(local-command-|task-notification|bash-|user-memory-input)/.test(raw)) return undefined;
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\[Image: source: [^\]]*\]/g, "")
    .trim();
  return text || undefined;
}

function clip(text: string): string {
  return text.length > TRANSCRIPT_TEXT_MAX ? `${text.slice(0, TRANSCRIPT_TEXT_MAX)}…` : text;
}

type Block = { type?: string; text?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Parses one line of a Claude Code session JSONL into a transcript line, or null. */
export function parseClaudeTranscriptLine(line: string, agentId: string): TranscriptLine | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || entry.isSidechain || entry.isMeta || typeof entry.uuid !== "string") return null;
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  const timestamp = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  const raw = textOf(entry.message?.content).trim();
  if (!raw) return null;
  const text = entry.type === "user" ? cleanPromptText(raw) : raw;
  if (!text) return null;
  return { id: entry.uuid, agentId, role: entry.type, text: clip(text), timestamp };
}
