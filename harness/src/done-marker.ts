import { writeFileSync, renameSync, readFileSync } from "node:fs";

export interface DoneMarker {
  status: "done" | "failed";
  sessionId: string;
  reason: string | null;
  ts: string;
}

export function deriveDoneMarkerPath(resultRef: string, override?: string): string {
  return override && override.length > 0 ? override : `${resultRef}.status`;
}

/** Write atomically (temp + rename) so a reader never observes a partial marker. */
export function writeDoneMarker(path: string, marker: DoneMarker): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, path);
}

export function readDoneMarker(path: string): DoneMarker | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DoneMarker;
  } catch {
    return null;
  }
}
