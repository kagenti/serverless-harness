// packages/session-backend/src/backend.ts
import type { StoredEntry } from "./entry";

/**
 * Generic append-only log store. Entry-agnostic: stores opaque `E` records keyed
 * by session_id. Shaped to upstream Pi issue #2032, but kept free of any Pi types
 * so this package has no dependency on the fork.
 */
export interface LogStore<E = unknown> {
  /** Append one entry; returns the stored envelope (with assigned position + hash). */
  append(session_id: string, entry: E, piType: string): Promise<StoredEntry<E>>;
  /** Read entries in append order, optionally from a 1-based position offset. */
  read(session_id: string, fromPosition?: number): Promise<StoredEntry<E>[]>;
  /** Most recent entry whose payload satisfies `predicate`, or null. */
  latestWhere(session_id: string, predicate: (entry: E) => boolean): Promise<StoredEntry<E> | null>;
  /** Next position index for a session (1-based; equals current count + 1). */
  nextPosition(session_id: string): Promise<number>;
  /** All known session ids. */
  list(): Promise<string[]>;
}
