import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import type { DenyRules } from "./decide.js";

// Comma-separated env var → trimmed, non-empty entries. `undefined` (unset) yields `undefined` so
// decide()'s `?? []` default applies, rather than an explicit empty array either way — the
// distinction doesn't matter to decide(), but keeps rulesFromEnv() honest about "unset" vs "set to
// nothing".
function listFromEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.length > 0 ? entries : undefined;
}

export function rulesFromEnv(env: NodeJS.ProcessEnv = process.env): DenyRules {
  return {
    denyTools: listFromEnv("IBAC_STUB_DENY_TOOLS"),
    denyUrlSubstrings: listFromEnv("IBAC_STUB_DENY_URLS"),
    denyArgMarkers: listFromEnv("IBAC_STUB_DENY_ARG_MARKERS"),
  };
}

export function portFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IBAC_STUB_PORT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8080;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  startServer(rulesFromEnv(), portFromEnv());
}
