// packages/session-backend/src/backend.ts
import type { LogEntry, NewEntry } from "./entry";

// Shaped to upstream Pi issue #2032 (SessionStorageBackend). Default = file; we add Redis.
export interface SessionStorageBackend {
  append(entry: NewEntry): Promise<LogEntry>;
  read(session_id: string, fromPosition?: number): Promise<LogEntry[]>;
  latestCheckpoint(session_id: string): Promise<LogEntry | null>;
  nextPosition(session_id: string): Promise<number>;
  list(): Promise<string[]>;
}
