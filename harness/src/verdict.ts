export type VerdictLabel = "FLAGGED" | "CLEAR";

export interface Verdict {
  item_id: string;
  verdict: VerdictLabel;
  reason: string;
}

export function validateVerdict(
  obj: unknown,
): { ok: true; value: Verdict } | { ok: false; error: string } {
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, error: "verdict must be an object" };
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.item_id !== "string" || o.item_id.length === 0) {
    return { ok: false, error: "item_id must be a non-empty string" };
  }
  if (o.verdict !== "FLAGGED" && o.verdict !== "CLEAR") {
    return { ok: false, error: 'verdict must be "FLAGGED" or "CLEAR"' };
  }
  if (typeof o.reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  return { ok: true, value: { item_id: o.item_id, verdict: o.verdict, reason: o.reason } };
}
