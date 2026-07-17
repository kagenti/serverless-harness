import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { VerdictCapture } from "./submit-verdict-tool.js";

export interface TurnCounter {
  turns: number;
}

// Envelopes don't always set `maxTurns` (it's optional on LeafEnvelope), but the runaway-loop
// bug this extension exists to prevent has no other guard — so fall back to a hard cap even when
// the caller omits one, rather than silently skipping turn-limiting for those leaves.
const DEFAULT_MAX_TURNS = 40;

/**
 * Backstop for the leaf agent loop: caps total turns even if a verdict is never submitted, and
 * blocks any further tool calls once a verdict HAS been captured (in case the model tries to call
 * more tools after submit_verdict, e.g. as part of a parallel batch that didn't all set
 * `terminate`). The primary fix lives in submit-verdict-tool.ts, which now sets `terminate: true`
 * on its own tool result — agent-loop.ts stops the turn loop as soon as every tool call in a batch
 * sets that flag (AgentToolResult.terminate). This extension exists because that primary fix only
 * covers the "model calls submit_verdict cleanly" path; without a cap, a model that never calls
 * submit_verdict (or calls it alongside other tools that don't terminate) can still spin forever —
 * one observed leaf called submit_verdict ~1,269 times before an external pod kill stopped it.
 *
 * `tool_call`'s `block` result is the only extension hook that can halt execution here —
 * `tool_result`/`turn_end` results carry no loop-control field (AgentSession.afterToolCall drops
 * any `terminate` an extension tries to set on `tool_result`). Blocking still costs one turn (the
 * model sees a "blocked" tool error and gets re-prompted) rather than stopping instantly, so this
 * is a safety net, not the fast path. `runLeaf` already treats a leaf with no captured verdict as
 * `no_verdict` (a normal, already-handled failure outcome), so hitting the turn cap without a
 * verdict fails cleanly instead of hanging the queue message forever.
 */
export function verdictTerminationExtension(
  capture: VerdictCapture,
  opts: { maxTurns?: number } = {},
): ExtensionFactory {
  const counter: TurnCounter = { turns: 0 };
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  return (pi: ExtensionAPI) => {
    pi.on("turn_start", () => {
      counter.turns += 1;
    });
    pi.on("tool_call", (event) => {
      if (capture.verdict) {
        return { block: true, reason: "Verdict already submitted for this item — task complete." };
      }
      if (typeof maxTurns === "number" && maxTurns > 0 && counter.turns > maxTurns) {
        return {
          block: true,
          reason: `Turn limit (${maxTurns}) reached without a submitted verdict — stopping.`,
        };
      }
      return {};
    });
  };
}
