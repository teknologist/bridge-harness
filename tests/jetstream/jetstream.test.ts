import { describe, it, expect } from "vitest";
import { RetentionPolicy, StorageType } from "nats";
import {
  dmStreamConfig,
  DM_STREAM,
  DM_MAX_AGE_MS,
  DM_MAX_MSGS_PER_SUBJECT,
  DM_MAX_BYTES,
  transcriptStreamConfig,
  TRANSCRIPT_STREAM,
  TRANSCRIPT_MAX_AGE_MS,
  TRANSCRIPT_MAX_MSGS_PER_SUBJECT,
  TRANSCRIPT_MAX_BYTES,
} from "../../src/shared/jetstream.js";

describe("dmStreamConfig", () => {
  const cfg = dmStreamConfig();

  it("captures only DM subjects (rooms stay ephemeral)", () => {
    expect(cfg.subjects).toEqual(["bridge.dm.*"]);
    expect(cfg.name).toBe(DM_STREAM);
  });

  it("uses file storage with limits retention", () => {
    expect(cfg.storage).toBe(StorageType.File);
    expect(cfg.retention).toBe(RetentionPolicy.Limits);
  });

  it("bounds retention per-subject, by age, and by size", () => {
    expect(cfg.max_msgs_per_subject).toBe(DM_MAX_MSGS_PER_SUBJECT);
    expect(cfg.max_bytes).toBe(DM_MAX_BYTES);
    // max_age is expressed in nanoseconds
    expect(cfg.max_age).toBe(DM_MAX_AGE_MS * 1_000_000);
  });

  it("keeps the age bound at 30 minutes", () => {
    expect(DM_MAX_AGE_MS).toBe(30 * 60 * 1000);
  });
});

describe("transcriptStreamConfig", () => {
  const cfg = transcriptStreamConfig();

  // The dashboard replays this stream after a restart, so a line sent while it was down
  // is not lost; the bounds keep the NATS server's disk use small and fixed.
  it("captures transcript subjects only", () => {
    expect(cfg.name).toBe(TRANSCRIPT_STREAM);
    expect(cfg.subjects).toEqual(["bridge.transcript.*"]);
  });

  it("is bounded per agent, by age, and by size", () => {
    expect(cfg.storage).toBe(StorageType.File);
    expect(cfg.retention).toBe(RetentionPolicy.Limits);
    expect(cfg.max_msgs_per_subject).toBe(TRANSCRIPT_MAX_MSGS_PER_SUBJECT);
    expect(cfg.max_age).toBe(TRANSCRIPT_MAX_AGE_MS * 1_000_000);
    expect(cfg.max_bytes).toBe(TRANSCRIPT_MAX_BYTES);
  });
});
