import { describe, it, expect, afterEach, vi } from "vitest";
import { getHost } from "../../src/shared/config.js";
import { applyPresenceEvent } from "../../src/shared/presence.js";
import type { AgentPresence } from "../../src/shared/types.js";

// When agents on several machines share one broker (a laptop and a server, say), the
// roster must say WHERE each agent runs; otherwise two "Claude Code" entries in the same
// project are indistinguishable and you DM the wrong one.
describe("getHost", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("node:os");
    vi.resetModules();
  });

  it("honors BRIDGE_HOST so a host can pick a friendlier label", () => {
    vi.stubEnv("BRIDGE_HOST", "  glod  ");
    expect(getHost()).toBe("glod");
  });

  it.each([
    ["Erics-MacBook-Pro.local", "Erics-MacBook-Pro"],
    ["glod.pixiebob-dubhe.ts.net", "glod"],
    ["glod", "glod"],
  ])("shortens the system hostname %s -> %s", async (raw, expected) => {
    vi.stubEnv("BRIDGE_HOST", "");
    vi.doMock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), hostname: () => raw }));
    vi.resetModules();
    const { getHost: fresh } = await import("../../src/shared/config.js");
    expect(fresh()).toBe(expected);
  });
});

describe("applyPresenceEvent — host", () => {
  it("records the host of an agent first seen via heartbeat", () => {
    const r = new Map<string, AgentPresence>();
    applyPresenceEvent(r, { agent: "pi-1", status: "active", project: "p", host: "glod" }, "self", 5);
    expect(r.get("pi-1")?.host).toBe("glod");
  });

  it("keeps a known host when a heartbeat from an older client omits it", () => {
    const r = new Map<string, AgentPresence>();
    applyPresenceEvent(r, { agent: "pi-1", status: "active", host: "glod" }, "self", 5);
    applyPresenceEvent(r, { agent: "pi-1", status: "active" }, "self", 6);
    expect(r.get("pi-1")?.host).toBe("glod");
  });
});
