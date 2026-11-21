// Working/idle signal for this Claude session, read by its bridge MCP server and
// published in presence so viewers can put busy agents first. UserPromptSubmit and a
// bridge wake mean "working"; the Stop hook (bridge-rewake) means "idle".
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function writeActivity(agentId, activity) {
  try {
    const dir = join(tmpdir(), "bridge-harness");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `activity-${agentId.replace(/[^\w.-]/g, "_")}.txt`), activity, { mode: 0o600 });
  } catch {
    // Best-effort: never disturb the hook.
  }
}
