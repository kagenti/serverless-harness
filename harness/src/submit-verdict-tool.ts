import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateVerdict, type Verdict } from "./verdict.js";

export interface VerdictCapture {
  verdict?: Verdict;
}

/** Custom session-entry type used to persist a captured verdict durably (for resume recovery). */
export const VERDICT_ENTRY_TYPE = "verdict";

/** Minimal slice of SessionManager the tool needs to persist the verdict durably. */
export interface VerdictSink {
  appendCustomEntry(customType: string, data?: unknown): string;
}

// Inline TypeBox-compatible schema (avoids importing typebox which is only in pi-fork's node_modules).
// The `as any` cast on registerTool bypasses the TSchema constraint at compile time.
const params = {
  type: "object",
  properties: {
    item_id: { type: "string", description: "The id of the item being judged (echo the input item_id)" },
    verdict: {
      anyOf: [{ const: "FLAGGED" }, { const: "CLEAR" }],
      description: "FLAGGED if the pattern is present and relevant; CLEAR otherwise",
    },
    reason: { type: "string", description: "One sentence justifying the verdict" },
  },
  required: ["item_id", "verdict", "reason"],
};

/**
 * Registers the `submit_verdict` tool. On a valid verdict it (1) captures it in-memory and
 * (2) — when a `sink` (the SessionManager) is provided — appends a durable `verdict` custom
 * session entry, so a session resumed after a crash can recover the verdict without re-running
 * the agent (mirrors the checkpoint-marker pattern).
 */
export function submitVerdictExtension(capture: VerdictCapture, sink?: VerdictSink): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "submit_verdict",
      label: "Submit verdict",
      description:
        "Submit your final verdict for the item. Call this exactly once when you are done. " +
        "After calling it, stop.",
      parameters: params,
      async execute(_id: string, args: unknown) {
        const r = validateVerdict(args);
        if (!r.ok) {
          return { isError: true, content: [{ type: "text", text: `Invalid verdict: ${r.error}` }] };
        }
        capture.verdict = r.value;
        sink?.appendCustomEntry(VERDICT_ENTRY_TYPE, r.value);
        return { content: [{ type: "text", text: "Verdict recorded." }] };
      },
    } as any);
  };
}
