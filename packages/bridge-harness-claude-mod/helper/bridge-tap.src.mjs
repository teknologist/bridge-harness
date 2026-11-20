#!/usr/bin/env node
// Session-long NATS tap for the bridge-pane mod. Prints one JSON object per line on
// stdout; the mod reads them. Start, signals and exit go to $CLAUDE_PLUGIN_DATA/tap.log.
// Source file: `npm run build:mod` bundles it (with nats) into helper/bridge-tap.mjs.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { connect, StringCodec } from "nats";

const sc = StringCodec();
const url = process.env.BRIDGE_NATS_URL ?? "nats://localhost:4222";
const agentId = process.env.CLAUDE_PID ? `claude-code-${process.env.CLAUDE_PID}` : undefined;
const logFile = process.env.CLAUDE_PLUGIN_DATA ? join(process.env.CLAUDE_PLUGIN_DATA, "tap.log") : undefined;
const startedAt = Date.now();

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (line) => {
  if (!logFile) return;
  try { appendFileSync(logFile, `${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} ${line}\n`); } catch {}
};
const parse = (m) => { try { return JSON.parse(sc.decode(m.data)); } catch { return undefined; } };

out({ t: "hello", pid: process.pid, ppid: process.ppid, agentId, url, startedAt });
log(`start agent=${agentId}`);
// The mod closing our stdout (reload, session end) must end us: no orphan taps.
process.stdout.on("error", () => { log("stdout closed"); process.exit(0); });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { log(`signal ${sig}`); process.exit(0); });
process.on("exit", (code) => log(`exit code=${code} uptime=${Math.round((Date.now() - startedAt) / 1000)}s`));

let nc;
try {
  nc = await connect({ servers: url, name: `bridge-pane-tap-${process.pid}` });
} catch (err) {
  out({ t: "error", message: `NATS connect failed: ${err.message}` });
  log(`connect failed ${err.message}`);
  process.exit(1);
}
out({ t: "connected" });

const pump = async (subject, kind) => {
  for await (const m of nc.subscribe(subject)) {
    const data = parse(m);
    if (data) out({ t: kind, subject: m.subject, data });
  }
};
pump("bridge.presence", "presence");
pump("bridge.registry", "registry");
if (agentId) pump(`bridge.dm.${agentId}`, "dm");

const whoThere = () =>
  nc.publish("bridge.registry", sc.encode(JSON.stringify({
    type: "who-there", agentId: agentId ?? `bridge-pane-tap-${process.pid}`, displayName: "bridge-pane", timestamp: Date.now(),
  })));
whoThere();
setInterval(whoThere, 60_000);

let ticks = 0;
setInterval(() => {
  ticks++;
  out({ t: "tick", ticks, uptimeS: Math.round((Date.now() - startedAt) / 1000) });
}, 10_000);

nc.closed().then((err) => {
  out({ t: "error", message: `NATS closed${err ? `: ${err.message}` : ""}` });
  log("nats closed");
  process.exit(2);
});
