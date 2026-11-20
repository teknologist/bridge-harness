import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Claude Code runs hooks as `/bin/sh -c "<command>"`. The hooks must resolve the Claude
// process itself (here: this test process), not the sh wrapper, or on Linux (dash does not
// exec) the rewake hook watches the wrong DM subject and messages never wake the session.
describe("hook agent id", () => {
  it("resolves the process that spawned the hook through /bin/sh -c, not the shell", () => {
    const helper = resolve("hooks/claude-pid.js");
    const script = `import(${JSON.stringify(helper)}).then(m => process.stdout.write(String(m.claudePid())))`;
    const out = execFileSync("/bin/sh", ["-c", `node --input-type=module -e '${script}'; true`], {
      encoding: "utf8",
    });
    expect(Number(out)).toBe(process.pid);
  });
});
