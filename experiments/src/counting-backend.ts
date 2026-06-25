import type { FileEntry, SessionStorageBackend } from "@earendil-works/pi-coding-agent";

export interface ReadCounts {
  reads: number;
  entriesRead: number;
  bytesRead: number;
  checkpointLookups: number;
}

/**
 * SessionStorageBackend decorator that tallies the read volume the session loaders
 * consume. Headline metric = entries + bytes returned by read() (the slice the loader
 * reconstructs from): full for openFromBackend, tail for openFromCheckpoint.
 * latestCheckpoint lookups are counted separately (each returns <= 1 entry).
 */
export class CountingBackend implements SessionStorageBackend {
  private _reads = 0;
  private _entries = 0;
  private _bytes = 0;
  private _checkpointLookups = 0;

  constructor(private readonly inner: SessionStorageBackend) {}

  async append(sessionId: string, entry: FileEntry): Promise<void> {
    await this.inner.append(sessionId, entry);
  }

  async read(sessionId: string, fromPosition?: number): Promise<FileEntry[]> {
    const result = await this.inner.read(sessionId, fromPosition);
    this._reads += 1;
    this._entries += result.length;
    for (const e of result) this._bytes += Buffer.byteLength(JSON.stringify(e));
    return result;
  }

  async latestCheckpoint(sessionId: string): Promise<FileEntry | null> {
    this._checkpointLookups += 1;
    return this.inner.latestCheckpoint(sessionId);
  }

  async list(): Promise<string[]> {
    return this.inner.list();
  }

  counts(): ReadCounts {
    return {
      reads: this._reads,
      entriesRead: this._entries,
      bytesRead: this._bytes,
      checkpointLookups: this._checkpointLookups,
    };
  }

  reset(): void {
    this._reads = 0;
    this._entries = 0;
    this._bytes = 0;
    this._checkpointLookups = 0;
  }
}
