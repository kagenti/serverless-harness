import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateVerdict, type Verdict } from "./verdict.js";

export interface VerdictCapture {
  verdict?: Verdict;
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

export function submitVerdictExtension(capture: VerdictCapture): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "submit_verdict",
      label: "Submit verdict",
      description:
        "Submit your final verdict for the item. Call this exactly once when you are done. " +
        "After calling it, stop.",
      parameters: params,
      async execute(_id, args) {
        const r = validateVerdict(args);
        if (!r.ok) {
          return { isError: true, content: [{ type: "text", text: `Invalid verdict: ${r.error}` }] };
        }
        capture.verdict = r.value;
        return { content: [{ type: "text", text: "Verdict recorded." }] };
      },
    } as any);
  };
}
