// packages/session-backend/src/entry.ts
import { createHash } from "node:crypto";

export const ENTRY_TYPES = [
  "user_message", "inference_request", "inference_response",
  "intention", "vote", "commit", "abort",
  "tool_result", "compaction", "policy", "checkpoint",
] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

export interface LogEntry {
  position: number;
  timestamp: number;          // wall-clock ms; audit only, not ordering
  session_id: string;
  type: EntryType;
  data: unknown;
  content_sha256: string;
}

export interface NewEntry {
  position: number;
  session_id: string;
  type: EntryType;
  data: unknown;
  timestamp?: number;
}

export function makeEntry(e: NewEntry): LogEntry {
  if (!ENTRY_TYPES.includes(e.type)) throw new Error(`unknown entry type: ${e.type}`);
  const payload = JSON.stringify(e.data ?? null);
  return {
    position: e.position,
    timestamp: e.timestamp ?? 0, // caller stamps real time; 0 keeps makeEntry pure/testable
    session_id: e.session_id,
    type: e.type,
    data: e.data,
    content_sha256: createHash("sha256").update(payload).digest("hex"),
  };
}
