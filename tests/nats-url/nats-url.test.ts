import { describe, it, expect, afterEach, vi } from "vitest";
import { isLocalNatsUrl } from "../../src/shared/config.js";

// The README promises BRIDGE_NATS_URL points agents at a remote broker, but the MCP
// server used to hardcode localhost: it auto-started an idle local nats-server and
// talked to it, while the rewake hook and the Pi extension listened on the remote one —
// so Claude never saw messages from remote agents.
describe("NATS_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("honors BRIDGE_NATS_URL", async () => {
    vi.stubEnv("BRIDGE_NATS_URL", "nats://remote.example:4222");
    vi.resetModules();
    const cfg = await import("../../src/shared/config.js");
    expect(cfg.NATS_URL).toBe("nats://remote.example:4222");
    expect(cfg.NATS_CONNECT_OPTIONS.servers).toBe("nats://remote.example:4222");
  });

  it("defaults to the local broker", async () => {
    vi.stubEnv("BRIDGE_NATS_URL", undefined);
    vi.resetModules();
    const cfg = await import("../../src/shared/config.js");
    expect(cfg.NATS_URL).toBe("nats://localhost:4222");
  });
});

// Only a local broker may be auto-started; a remote URL must never spawn nats-server here.
describe("isLocalNatsUrl", () => {
  it.each([
    "nats://localhost:4222",
    "nats://127.0.0.1:4222",
    "localhost:4222",
    "nats://localhost",
  ])("treats %s as local", (url) => {
    expect(isLocalNatsUrl(url)).toBe(true);
  });

  it.each([
    "nats://glod.example.ts.net:4222",
    "nats://192.168.1.10:4222",
    "nats://localhost.evil.com:4222",
    "nats://a:4222,nats://localhost:4222",
  ])("treats %s as remote", (url) => {
    expect(isLocalNatsUrl(url)).toBe(false);
  });
});
