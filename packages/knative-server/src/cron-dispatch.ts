import { readFileSync } from "node:fs";

/** Replace every __FIRE__ in each string field with fireId; non-strings pass through. Pure, non-mutating. */
export function applyFire(envelope: Record<string, unknown>, fireId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    out[k] = typeof v === "string" ? v.split("__FIRE__").join(fireId) : v;
  }
  return out;
}

/**
 * Dispatch every config item as an async leaf. Each item is fire-substituted and POSTed with
 * async:true via the injected `post` (returns true iff the dispatch was accepted). Every item is
 * attempted even if earlier ones fail; a thrown post counts as a failure.
 */
export async function dispatchAll(
  items: Record<string, unknown>[],
  fireId: string,
  post: (env: Record<string, unknown>) => Promise<boolean>,
): Promise<{ total: number; accepted: number; failed: number }> {
  let accepted = 0;
  let failed = 0;
  for (const item of items) {
    const env = { ...applyFire(item, fireId), async: true };
    try {
      (await post(env)) ? accepted++ : failed++;
    } catch {
      failed++;
    }
  }
  return { total: items.length, accepted, failed };
}

export function exitCodeFor(result: { failed: number }): number {
  return result.failed > 0 ? 1 : 0;
}

export function loadConfig(path: string): Record<string, unknown>[] {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed?.items)) throw new Error("cron config: 'items' must be an array");
  return parsed.items as Record<string, unknown>[];
}
