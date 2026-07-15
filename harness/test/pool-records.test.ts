import { afterEach, describe, expect, it } from "vitest";
import { RedisRecordStore, type SandboxRecord } from "../src/pool-records.js";

const rec: SandboxRecord = {
  sandboxId: "sbx-remote-1",
  labels: { team: "t1" },
  capabilities: ["python3"],
  capacityMax: 4,
  transport: "grpc",
};

describe("RedisRecordStore", () => {
  const store = new RedisRecordStore();
  afterEach(async () => {
    await store.remove(rec.sandboxId);
  });

  it("put then list returns the record", async () => {
    await store.put(rec);
    const all = await store.list();
    expect(all.find((r) => r.sandboxId === rec.sandboxId)).toEqual(rec);
  });

  it("remove drops it from list", async () => {
    await store.put(rec);
    await store.remove(rec.sandboxId);
    const all = await store.list();
    expect(all.find((r) => r.sandboxId === rec.sandboxId)).toBeUndefined();
  });
});
