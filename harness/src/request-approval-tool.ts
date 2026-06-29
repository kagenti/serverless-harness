// harness/src/request-approval-tool.ts
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { GATE_REQUEST_ENTRY_TYPE, type GateRequest } from "./gate.js";

export interface GateCapture {
  gate?: GateRequest;
  aborted?: boolean;
}

/** Minimal slice of SessionManager the tool needs to persist the gate request durably. */
export interface GateSink {
  appendCustomEntry(customType: string, data?: unknown): string;
}

// Inline TypeBox-compatible schema (avoids importing typebox which is only in pi-fork's node_modules).
// The `as any` cast on registerTool bypasses the TSchema constraint at compile time.
const params = {
  type: "object",
  properties: {
    summary: { type: "string", description: "A short summary of what you have done / decided so far (the human reads this)" },
    proposed_action: { type: "string", description: "The action you propose to take next, pending sign-off" },
  },
  required: ["summary", "proposed_action"],
};

/**
 * Registers the `request_approval` tool. On a valid call it (1) captures the gate in-memory with the
 * caller-supplied `nextGateId` and (2) — when a `sink` is provided — appends a durable `gate-request`
 * custom entry, so a resumed session can detect the pending gate. The tool returns a benign result so
 * the assistant turn ends well-formed (no dangling tool call); runLeaf parks at the loop boundary.
 */
export function requestApprovalExtension(
  capture: GateCapture,
  sink: GateSink | undefined,
  nextGateId: number,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "request_approval",
      label: "Request approval",
      description:
        "Request human approval before proceeding. Provide a summary of what you've done and the " +
        "action you propose. Call this at most once, then stop; the session pauses and resumes with " +
        "the human's decision.",
      parameters: params,
      async execute(_id: string, args: unknown) {
        const summary = (args as { summary?: unknown })?.summary;
        const proposed_action = (args as { proposed_action?: unknown })?.proposed_action;
        if (typeof summary !== "string" || summary.length === 0 ||
            typeof proposed_action !== "string" || proposed_action.length === 0) {
          return { isError: true, content: [{ type: "text", text: "Invalid request_approval: summary and proposed_action must be non-empty strings" }] };
        }
        const gate: GateRequest = { gateId: nextGateId, summary, proposed_action };
        capture.gate = gate;
        sink?.appendCustomEntry(GATE_REQUEST_ENTRY_TYPE, gate);
        return { content: [{ type: "text", text: "Approval requested; the session will pause and resume with the human decision." }] };
      },
    } as any);
  };
}
