import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface GateMarker {
  status: "awaiting_approval";
  sessionId: string;
  gateId: number;
  gate: { summary: string; proposed_action: string };
  ts: string;
}

export function deriveGateRef(resultRef: string, override?: string): string {
  return override && override.length > 0 ? override : `${resultRef}.gate`;
}

/** Write atomically (temp + rename) so a reader never observes a partial marker. */
export function writeGateMarker(path: string, marker: GateMarker): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, path);
}

export function readGateMarker(path: string): GateMarker | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GateMarker;
  } catch {
    return null;
  }
}
