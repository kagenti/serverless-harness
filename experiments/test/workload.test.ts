import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { getWorkloadProvider } from "../src/workload.js";

const deckPath = fileURLToPath(new URL("../swebench/deck.json", import.meta.url));

describe("synthetic provider", () => {
  const p = getWorkloadProvider({ WORKLOAD: "synthetic" });
  it("is the default when WORKLOAD is unset", () => {
    expect(getWorkloadProvider({}).name).toBe("synthetic");
  });
  it("yields L0/L1/L2 code-review items", () => {
    const items = p.curveItems();
    expect(items.map((i) => i.label)).toEqual(["L0", "L1", "L2"]);
    expect(items[0].post).toEqual({ item: { item_id: "L0", file: "small.py", pattern: "password" } });
    expect(p.sweepItem().label).toBe("L2");
  });
});

describe("swebench provider", () => {
  const p = getWorkloadProvider({ WORKLOAD: "swebench" }, deckPath);
  it("curveItems has exactly the three buckets, deterministic representatives", () => {
    const items = p.curveItems();
    expect(items.map((i) => i.label).sort()).toEqual(["heavy", "light", "medium"]);
    const again = getWorkloadProvider({ WORKLOAD: "swebench" }, deckPath).curveItems();
    expect(items.map((i) => i.instanceId)).toEqual(again.map((i) => i.instanceId)); // stable
  });
  it("emits a well-formed solve envelope per item", () => {
    const it0 = p.curveItems().find((i) => i.label === "heavy")!;
    expect(it0.post.kind).toBe("solve");
    expect(typeof it0.post.problemStatement).toBe("string");
    expect((it0.post.problemStatement as string).length).toBeGreaterThan(0);
    expect(it0.post.ref).toMatch(/^[0-9a-f]{7,40}$/);                 // base_commit
    expect(it0.post.repoUrl).toMatch(/^\/repos\/.+\.git$/);           // baked bare mirror path
    expect(it0.post.env_key).toMatch(/:latest$/);                    // passed through verbatim
  });
  it("sweepItem is a heavy instance", () => {
    expect(p.sweepItem().label).toBe("heavy");
  });
  it("sliceItems is deterministic and bucket-balanced", () => {
    const a = p.sliceItems({ perBucket: 2, seed: 7 });
    const b = p.sliceItems({ perBucket: 2, seed: 7 });
    expect(a.map((i) => i.instanceId)).toEqual(b.map((i) => i.instanceId));
    const c = p.sliceItems({ perBucket: 2, seed: 99 });
    expect(a.map((i) => i.instanceId)).not.toEqual(c.map((i) => i.instanceId)); // seed changes selection
    expect(a.filter((i) => i.label === "light").length).toBe(2);
  });
});
