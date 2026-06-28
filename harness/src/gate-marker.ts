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

/** Read + shape-validate a gate marker. Returns null on missing/garbled/off-shape input. */
export function readGateMarker(path: string): GateMarker | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      !o ||
      o.status !== "awaiting_approval" ||
      typeof o.sessionId !== "string" ||
      typeof o.gateId !== "number" ||
      typeof o.ts !== "string" ||
      typeof o.gate !== "object" ||
      o.gate === null ||
      typeof (o.gate as Record<string, unknown>).summary !== "string" ||
      typeof (o.gate as Record<string, unknown>).proposed_action !== "string"
    ) {
      return null;
    }
    return o as unknown as GateMarker;
  } catch {
    return null;
  }
}
