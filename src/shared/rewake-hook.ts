import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code has no push transport of its own: the MCP server can only hand over messages
// when the model calls `read`. What actually wakes an idle session is the `bridge-rewake`
// Stop hook. Without it the bridge still *connects* and still *receives* — messages pile up
// in the in-memory inbox and nobody ever looks. The failure is completely silent, which is
// why it went unnoticed: every diagnostic (whoami, list_agents, send) reports success.
//
// These helpers let the MCP server detect the gap at startup and say so out loud.

export const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/**
 * Seconds Claude Code lets the rewake hook live. The hook must stay up for as long as the
 * session sits idle, but a hook without `timeout` is killed after Claude Code's default
 * 600 s — after that nothing listens until the next turn ends, so a session left idle for
 * 10 minutes silently stops waking. 24 h covers any realistic idle stretch.
 */
export const REWAKE_HOOK_TIMEOUT_S = 86_400;

/** Shape we care about; everything else in settings.json is ignored. */
interface ClaudeSettings {
  hooks?: {
    Stop?: Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>;
  };
}

/**
 * True when a Stop hook whose command mentions `bridge-rewake` is configured.
 *
 * Pure and settings-object based so it can be tested without touching the real home
 * directory. Matches on the command string rather than an exact path because the hook may
 * be installed from a local checkout or from the npm global root.
 */
export function hasRewakeHook(settings: unknown): boolean {
  return findRewakeHook(settings) !== undefined;
}

/** The configured bridge-rewake hook entry, if any (same matching as hasRewakeHook). */
export function findRewakeHook(settings: unknown): Record<string, unknown> | undefined {
  const stop = (settings as ClaudeSettings | null)?.hooks?.Stop;
  if (!Array.isArray(stop)) return undefined;
  for (const group of stop) {
    if (!Array.isArray(group?.hooks)) continue;
    const hook = group.hooks.find((h) => {
      const cmd = (h as { command?: unknown }).command;
      return typeof cmd === "string" && cmd.includes("bridge-rewake");
    });
    if (hook) return hook;
  }
  return undefined;
}

/** True when the hook would be killed before REWAKE_HOOK_TIMEOUT_S (incl. no timeout set). */
export function rewakeTimeoutTooShort(hook: Record<string, unknown>): boolean {
  const t = hook.timeout;
  return typeof t !== "number" || t < REWAKE_HOOK_TIMEOUT_S;
}

/** Reads ~/.claude/settings.json, returning null when absent or unparseable. */
export function readClaudeSettings(path: string = CLAUDE_SETTINGS_PATH): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether THIS process can be woken by an incoming message.
 *
 * Only meaningful for the Claude Code side. Under any other host (Pi, a bare `node`
 * invocation, a test) the Stop hook is irrelevant — Pi pushes natively — so we report
 * `null` rather than a misleading `false`.
 */
export function rewakeStatus(
  settings: unknown = readClaudeSettings()
): { installed: boolean; warning: string } | null {
  if (settings === null) {
    return {
      installed: false,
      warning:
        "No ~/.claude/settings.json found, so the bridge-rewake Stop hook is not installed. " +
        "Incoming messages will sit unread until you call `read` manually. Fix: npx @cocodrino/bridge-harness setup",
    };
  }
  const hook = findRewakeHook(settings);
  if (hook && rewakeTimeoutTooShort(hook)) {
    return {
      installed: false,
      warning:
        `The bridge-rewake Stop hook has no long \`timeout\`, so Claude Code kills it after its ` +
        `default 600 s: once this session idles for ~10 minutes, incoming messages stop waking ` +
        `it. Fix: npx @cocodrino/bridge-harness setup (sets timeout: ${REWAKE_HOOK_TIMEOUT_S}).`,
    };
  }
  if (hook) return { installed: true, warning: "" };
  return {
    installed: false,
    warning:
      "The bridge-rewake Stop hook is NOT installed in ~/.claude/settings.json. Messages will " +
      "arrive but will never wake this session — you will only see them if you call `read` " +
      "yourself. Fix: npx @cocodrino/bridge-harness setup",
  };
}
