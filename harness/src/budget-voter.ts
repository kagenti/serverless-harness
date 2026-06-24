import type { ExtensionContext, ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";

export interface BudgetState {
  spent: number;
  estimated: number;
  limit: number;
}
export type BudgetDecision =
  | { decision: "commit" }
  | { decision: "abort"; reason: "budget_exceeded" };

/** Pure policy. Disabled (always commits) when limit is non-finite or <= 0. */
export function decideBudget(s: BudgetState): BudgetDecision {
  if (!Number.isFinite(s.limit) || s.limit <= 0) return { decision: "commit" };
  return s.spent + s.estimated > s.limit
    ? { decision: "abort", reason: "budget_exceeded" }
    : { decision: "commit" };
}

/**
 * Cumulative token spend = sum of assistant message usage over the current branch
 * (same total as AgentSession.getSessionStats().tokens.total). Mirrors the
 * custom-footer example's read of ctx.sessionManager.getBranch().
 * Returns 0 for an empty branch (a valid baseline); null only when the branch is unavailable.
 */
export function sessionSpendTotal(ctx: ExtensionContext): number | null {
  const sm = ctx.sessionManager as { getBranch?: () => unknown[] } | undefined;
  if (!sm || typeof sm.getBranch !== "function") return null;
  let total = 0;
  for (const entry of sm.getBranch() as Array<{
    type?: string;
    message?: { role?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
  }>) {
    if (entry?.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      const u = entry.message.usage;
      total += u.input + u.output + u.cacheRead + u.cacheWrite;
    }
  }
  return total;
}

/**
 * Meters per-turn token spend (delta from the per-process baseline captured at
 * session_start) and blocks tool calls once the cap is breached, appending a single
 * `abort` custom entry. Inert when limit <= 0.
 */
export function budgetVoterExtension(
  sm: SessionManager,
  opts: { limit: number; margin?: number },
): ExtensionFactory {
  return (pi) => {
    let baseline: number | null = null;
    pi.on("session_start", (_e, ctx) => {
      baseline = sessionSpendTotal(ctx);
    });
    pi.on("tool_call", (_e, ctx) => {
      const total = sessionSpendTotal(ctx);
      if (baseline == null || total == null) return {}; // defensive: don't block on unknown
      const spent = total - baseline;
      const d = decideBudget({ spent, estimated: opts.margin ?? 0, limit: opts.limit });
      if (d.decision === "abort") {
        sm.appendCustomEntry("abort", { reason: d.reason, spent, limit: opts.limit });
        return { block: true, reason: "Session token budget exceeded" };
      }
      return {};
    });
  };
}
