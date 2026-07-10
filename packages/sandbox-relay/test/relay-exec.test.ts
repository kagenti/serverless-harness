import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createRelay } from "../src/relay.js";
import type { RecordStore } from "@sh/harness";

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };

function fakeAttach() {
  const s = new EventEmitter() as EventEmitter & { metadata: { get: () => string[] }; write: (f: any) => void; end: () => void; written: any[]; emitData: (f: any) => void };
  s.metadata = { get: () => [] };
  s.written = [];
  s.write = (f) => s.written.push(f);
  s.end = () => s.emit("end");
  s.emitData = (f) => s.emit("data", f);
  return s;
}

describe("relay Exec/Abort routing", () => {
  it("routes Exec to the worker and yields the worker's ExecEvents back", async () => {
    const relay = createRelay({ records, validateToken: () => true } as never);
    const s = fakeAttach();
    relay.onAttach(s as never);
    s.emitData({ hello: { sandboxId: "sbx-1", labels: {}, capabilities: [], image: "", arch: "amd64", capacityMax: 1, trust: "trusted" } });

    const events: any[] = [];
    const pump = (async () => {
      for await (const ev of relay.routeExec("sbx-1", 1, "echo hi", new Uint8Array(), 0, true)) events.push(ev);
    })();

    // The relay should have sent a ServerFrame{exec} to the worker.
    await vi.waitFor(() => expect(s.written.at(-1)?.exec?.reqId).toBe(1));
    // Worker replies with a chunk then end.
    s.emitData({ chunk: { reqId: 1, data: Buffer.from("hi"), stream: 1 } });
    s.emitData({ end: { reqId: 1, exitCode: 0 } });
    await pump;
    expect(events.map((e) => e.chunk?.data && Buffer.from(e.chunk.data).toString()).filter(Boolean)).toContain("hi");
    expect(events.at(-1).end.exitCode).toBe(0);
  });

  it("Abort sends ServerFrame{abort} to the worker", async () => {
    const relay = createRelay({ records, validateToken: () => true } as never);
    const s = fakeAttach();
    relay.onAttach(s as never);
    s.emitData({ hello: { sandboxId: "sbx-1", labels: {}, capabilities: [], image: "", arch: "amd64", capacityMax: 1, trust: "trusted" } });
    relay.routeAbort("sbx-1", 5);
    expect(s.written.at(-1)?.abort?.reqId).toBe(5);
  });

  it("Exec for an absent sandboxId throws", async () => {
    const relay = createRelay({ records, validateToken: () => true } as never);
    await expect(async () => {
      for await (const _ of relay.routeExec("ghost", 1, "x", new Uint8Array(), 0, true)) void _;
    }).rejects.toThrow(/no live worker/);
  });
});
