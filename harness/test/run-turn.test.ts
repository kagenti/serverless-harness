import { describe, it, expect, afterAll } from "vitest";
import { RedisSessionBackend } from "@sh/session-backend";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { runTurn } from "../src/run-turn.js";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const store = new RedisSessionBackend<FileEntry>(REDIS);
const createdSessions: string[] = [];

afterAll(async () => {
  for (const sid of createdSessions) {
    await store.reset(sid);
  }
  await store.close();
});

describe("runTurn()", () => {
  it("creates a new session when sessionId is undefined", async () => {
    const result = await runTurn("Say exactly: PONG", undefined, {
      redisUrl: REDIS,
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.response).toContain("PONG");
    expect(result.stopReason).toBe("end_turn");
    createdSessions.push(result.sessionId);
  });

  it("resumes an existing session from Redis", async () => {
    // Create a session first
    const first = await runTurn("Remember the code word: ZEBRA42", undefined, {
      redisUrl: REDIS,
    });
    createdSessions.push(first.sessionId);

    // Resume and ask for recall
    const second = await runTurn(
      "What was the code word I told you?",
      first.sessionId,
      { redisUrl: REDIS },
    );

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.response).toContain("ZEBRA42");
  });

  it("throws when sessionId does not exist in Redis", async () => {
    await expect(
      runTurn("hello", "nonexistent-session-id-12345", { redisUrl: REDIS }),
    ).rejects.toThrow("no session in backend");
  });
});
