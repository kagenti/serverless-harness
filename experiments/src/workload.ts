import { readFileSync } from "node:fs";

export interface DeckInstance {
  instance_id: string; repo: string; base_commit: string; env_key: string;
  problem_statement: string; weight_bucket: "light" | "medium" | "heavy" | null;
  test_runtime_ms: number | null;
}
export interface Deck { deckHash: string; seed: number; instances: DeckInstance[] }

export interface WorkItem { instanceId: string; label: string; post: Record<string, unknown> }
export interface SliceOpts { perBucket: number; buckets?: string[]; seed?: number }
export interface WorkloadProvider {
  readonly name: "synthetic" | "swebench";
  curveItems(): WorkItem[];
  sweepItem(): WorkItem;
  sliceItems(opts: SliceOpts): WorkItem[];
}

export function loadDeck(path: string): Deck {
  return JSON.parse(readFileSync(path, "utf8")) as Deck;
}

// Deterministic PRNG (mulberry32) so a (seed) reproduces the same selection without a dependency.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const BUCKETS = ["light", "medium", "heavy"] as const;

class SyntheticProvider implements WorkloadProvider {
  readonly name = "synthetic" as const;
  private readonly variants = [
    { label: "L0", file: "small.py", pattern: "password" },
    { label: "L1", file: "medium.py", pattern: "eval(" },
    { label: "L2", file: "large.py", pattern: "eval(" },
  ];
  private toItem(v: { label: string; file: string; pattern: string }): WorkItem {
    return { instanceId: v.label, label: v.label,
      post: { item: { item_id: v.label, file: v.file, pattern: v.pattern } } };
  }
  curveItems(): WorkItem[] { return this.variants.map((v) => this.toItem(v)); }
  sweepItem(): WorkItem { return this.toItem(this.variants[this.variants.length - 1]); }
  sliceItems(opts: SliceOpts): WorkItem[] {
    // Synthetic has one item per "bucket" (variant); replicate perBucket times for a slice run.
    return this.variants.flatMap((v) => Array.from({ length: opts.perBucket }, () => this.toItem(v)));
  }
}

class SwebenchProvider implements WorkloadProvider {
  readonly name = "swebench" as const;
  constructor(private readonly deck: Deck) {}
  private byBucket(bucket: string): DeckInstance[] {
    // Sort by instance_id for a stable base order independent of deck ordering.
    return this.deck.instances
      .filter((i) => i.weight_bucket === bucket)
      .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  }
  private toItem(inst: DeckInstance): WorkItem {
    return {
      instanceId: inst.instance_id,
      label: inst.weight_bucket ?? "unknown",
      post: {
        kind: "solve",
        problemStatement: inst.problem_statement,
        repoUrl: `/repos/${inst.repo}.git`,
        ref: inst.base_commit,
        env_key: inst.env_key,
      },
    };
  }
  // Returns byBucket(bucket)[0] but throws a helpful error instead of letting toItem(undefined) blow up
  // on an empty bucket.
  private representative(bucket: string): DeckInstance {
    const inst = this.byBucket(bucket)[0];
    if (!inst) throw new Error(`swebench deck has no instances in bucket: ${bucket}`);
    return inst;
  }
  curveItems(): WorkItem[] {
    // One representative per bucket: the lexicographically smallest instance_id (deterministic).
    return BUCKETS.map((b) => this.toItem(this.representative(b)));
  }
  sweepItem(): WorkItem {
    // The heaviest single instance = largest test_runtime_ms in the heavy bucket (null treated as -1),
    // tie-broken by instance_id ascending for determinism.
    this.representative("heavy"); // throws a helpful error if the heavy bucket is empty
    const heavy = this.byBucket("heavy");
    const best = heavy.reduce((a, b) => {
      const ar = a.test_runtime_ms ?? -1;
      const br = b.test_runtime_ms ?? -1;
      if (br > ar) return b;
      if (br < ar) return a;
      return b.instance_id < a.instance_id ? b : a;
    });
    return this.toItem(best);
  }
  sliceItems(opts: SliceOpts): WorkItem[] {
    const buckets = opts.buckets ?? [...BUCKETS];
    const rand = rng(opts.seed ?? this.deck.seed ?? 1);
    return buckets.flatMap((b) => shuffle(this.byBucket(b), rand).slice(0, opts.perBucket).map((i) => this.toItem(i)));
  }
}

// Official SWE-bench predictions.jsonl record shape (one line per solved instance).
export function predictionRecord(instanceId: string, model: string, patch: string) {
  return { instance_id: instanceId, model_name_or_path: model, model_patch: patch };
}

export function getWorkloadProvider(
  env: Record<string, string | undefined>,
  deckPath?: string,
): WorkloadProvider {
  const which = (env.WORKLOAD ?? "synthetic").toLowerCase();
  if (which === "swebench") {
    const path = deckPath ?? env.DECK ?? "experiments/swebench/deck.json";
    return new SwebenchProvider(loadDeck(path));
  }
  return new SyntheticProvider();
}
