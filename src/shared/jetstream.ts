import { RetentionPolicy, StorageType, type NatsConnection } from "nats";

// DMs are captured by this stream so a durable consumer (the rewake hook) can be
// redelivered anything it missed during its restart, and offline recipients can catch
// up within the retention window. Rooms are intentionally NOT captured (ephemeral).
export const DM_STREAM = "BRIDGE_DM";
export const DM_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
export const DM_MAX_MSGS_PER_SUBJECT = 100;
export const DM_MAX_BYTES = 64 * 1024 * 1024; // 64 MB

export function dmStreamConfig() {
  return {
    name: DM_STREAM,
    subjects: ["bridge.dm.*"],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    max_msgs_per_subject: DM_MAX_MSGS_PER_SUBJECT,
    max_age: DM_MAX_AGE_MS * 1_000_000, // JetStream expects nanoseconds
    max_bytes: DM_MAX_BYTES,
  };
}

// Idempotently ensure the DM stream exists. Throws if JetStream is not enabled on the
// server, so callers can decide to warn and fall back to core-only behavior.
export async function ensureDmStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(DM_STREAM);
  } catch {
    await jsm.streams.add(dmStreamConfig() as Parameters<typeof jsm.streams.add>[0]);
  }
}

// Transcript lines are captured too, so a dashboard that was down (restart, `wattpm dev`
// reload, laptop asleep) catches up on what agents said meanwhile. Agents keep publishing
// with plain core publish: the stream records them, no ack round-trip. Bounds: about
// 1,000 lines a day across all agents at ~400 B each, so these limits are never close in
// normal use; they only cap a runaway agent.
export const TRANSCRIPT_STREAM = "BRIDGE_TRANSCRIPT";
export const TRANSCRIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const TRANSCRIPT_MAX_MSGS_PER_SUBJECT = 500; // = the dashboard's per-agent keep
export const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024; // 64 MB

export function transcriptStreamConfig() {
  return {
    name: TRANSCRIPT_STREAM,
    subjects: ["bridge.transcript.*"],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    max_msgs_per_subject: TRANSCRIPT_MAX_MSGS_PER_SUBJECT,
    max_age: TRANSCRIPT_MAX_AGE_MS * 1_000_000, // nanoseconds
    max_bytes: TRANSCRIPT_MAX_BYTES,
  };
}

// Idempotently ensure the transcript stream exists. Throws without JetStream.
export async function ensureTranscriptStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(TRANSCRIPT_STREAM);
  } catch {
    await jsm.streams.add(transcriptStreamConfig() as Parameters<typeof jsm.streams.add>[0]);
  }
}
