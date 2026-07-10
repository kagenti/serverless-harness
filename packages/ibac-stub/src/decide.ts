// Canned IBAC judge decision logic for the RC1 AuthBridge PoC. A real judge would call an LLM;
// this stub deterministically denies actions whose text matches a configured denylist (tool name,
// URL substring, or arg marker) and allows everything else. Matching is case-sensitive substring
// containment, per the RC1 spec — no normalization, no partial-word boundaries.

export type DenyRules = {
  denyTools?: string[];
  denyUrlSubstrings?: string[];
  denyArgMarkers?: string[];
};

export type Verdict = { verdict: "allow" | "deny"; reason: string };

type RuleKind = "tool" | "url" | "arg marker";

function findMatch(actionText: string, kind: RuleKind, entries: string[] | undefined): Verdict | undefined {
  for (const entry of entries ?? []) {
    if (entry !== "" && actionText.includes(entry)) {
      return { verdict: "deny", reason: `denied: ${kind} '${entry}'` };
    }
  }
  return undefined;
}

export function decide(actionText: string, rules: DenyRules): Verdict {
  return (
    findMatch(actionText, "tool", rules.denyTools) ??
    findMatch(actionText, "url", rules.denyUrlSubstrings) ??
    findMatch(actionText, "arg marker", rules.denyArgMarkers) ?? {
      verdict: "allow",
      reason: "no matching deny rule",
    }
  );
}
