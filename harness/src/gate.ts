import { readFileSync } from "node:fs";

export type GateAction = "approve" | "reject" | "abort";

export interface GateRequest {
  gateId: number;
  summary: string;
  proposed_action: string;
}

export interface Decision {
  gateId: number;
  action: GateAction;
  feedback?: string;
}

/** Same shape as Decision; persisted as a durable custom entry to mark a gate consumed. */
export type GateDecision = Decision;

export const GATE_REQUEST_ENTRY_TYPE = "gate-request";
export const GATE_DECISION_ENTRY_TYPE = "gate-decision";

export function validateDecision(
  obj: unknown,
): { ok: true; value: Decision } | { ok: false; error: string } {
  if (typeof obj !== "object" || obj === null) return { ok: false, error: "decision must be an object" };
  const o = obj as Record<string, unknown>;
  if (typeof o.gateId !== "number" || !Number.isInteger(o.gateId) || o.gateId < 0) {
    return { ok: false, error: "gateId must be a non-negative integer" };
  }
  if (o.action !== "approve" && o.action !== "reject" && o.action !== "abort") {
    return { ok: false, error: 'action must be "approve", "reject", or "abort"' };
  }
  if (o.feedback !== undefined && typeof o.feedback !== "string") {
    return { ok: false, error: "feedback must be a string when present" };
  }
  return { ok: true, value: { gateId: o.gateId, action: o.action, feedback: o.feedback as string | undefined } };
}

/** Read + validate the orchestrator-written decision file. Null on missing/garbled/invalid. */
export function readDecision(decisionRef: string): Decision | null {
  try {
    const r = validateDecision(JSON.parse(readFileSync(decisionRef, "utf8")));
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

type CustomEntry = { type?: string; customType?: string; data?: unknown };

export function isGateRequestEntry(entry: unknown): boolean {
  const e = entry as CustomEntry | null;
  return !!e && e.type === "custom" && e.customType === GATE_REQUEST_ENTRY_TYPE;
}

export function isGateDecisionEntry(entry: unknown): boolean {
  const e = entry as CustomEntry | null;
  return !!e && e.type === "custom" && e.customType === GATE_DECISION_ENTRY_TYPE;
}

export function gateRequestFromEntry(entry: unknown): GateRequest | null {
  if (!isGateRequestEntry(entry)) return null;
  const d = (entry as CustomEntry).data as Record<string, unknown> | undefined;
  if (!d || typeof d.gateId !== "number" || typeof d.summary !== "string" || typeof d.proposed_action !== "string") {
    return null;
  }
  return { gateId: d.gateId, summary: d.summary, proposed_action: d.proposed_action };
}

export function gateDecisionFromEntry(entry: unknown): GateDecision | null {
  if (!isGateDecisionEntry(entry)) return null;
  const r = validateDecision((entry as CustomEntry).data);
  return r.ok ? r.value : null;
}
