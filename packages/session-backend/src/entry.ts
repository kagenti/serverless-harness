// packages/session-backend/src/entry.ts
import { createHash } from "node:crypto";

/**
 * A stored log record: a thin envelope around an opaque harness-native entry.
 * The store never interprets `entry` except via the denormalized `piType`.
 */
export interface StoredEntry<E = unknown> {
  position: number;        // monotonic 1-based offset; powers read(fromPosition)
  session_id: string;
  piType: string;          // denormalized copy of the entry's discriminant, for cheap filtering
  entry: E;                // harness-native entry, stored & returned verbatim
  content_sha256: string;  // integrity hash of `entry` (canonical JSON)
  timestamp: number;       // wall-clock ms; audit only, not ordering
}

export function makeStoredEntry<E>(args: {
  position: number;
  session_id: string;
  piType: string;
  entry: E;
  timestamp?: number;
}): StoredEntry<E> {
  const payload = JSON.stringify(args.entry ?? null);
  return {
    position: args.position,
    session_id: args.session_id,
    piType: args.piType,
    entry: args.entry,
    content_sha256: createHash("sha256").update(payload).digest("hex"),
    timestamp: args.timestamp ?? 0, // caller stamps real time; 0 keeps this pure/testable
  };
}
