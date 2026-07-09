import { describe, it, expect } from "vitest";
import { Hello, Exec, End } from "../src/gen/sandbox/v1/sandbox";

describe("sandbox/v1 generated TypeScript stubs", () => {
  it("round-trips a Hello through binary encode/decode", () => {
    const bytes = Hello.encode({
      sandboxId: "sbx-1",
      labels: { team: "alpha" },
      capabilities: ["python3", "kubectl"],
      image: "img@sha256:abc",
      arch: "amd64",
      capacityMax: 4,
      trust: "trusted",
    }).finish();

    const back = Hello.decode(bytes);
    expect(back.sandboxId).toBe("sbx-1");
    expect(back.labels.team).toBe("alpha");
    expect(back.capabilities).toEqual(["python3", "kubectl"]);
    expect(back.capacityMax).toBe(4);
  });

  it("keeps req_id as a number and stdin as bytes", () => {
    const back = Exec.decode(
      Exec.encode({
        reqId: 7,
        command: "echo hi",
        stdin: new Uint8Array([1, 2, 3]),
        timeoutS: 30,
        streaming: true,
      }).finish(),
    );
    expect(back.reqId).toBe(7);
    expect(back.streaming).toBe(true);
    expect(Array.from(back.stdin)).toEqual([1, 2, 3]);
  });

  it("preserves a negative exit_code (sint32 zigzag)", () => {
    const back = End.decode(End.encode({ reqId: 7, exitCode: -9 }).finish());
    expect(back.exitCode).toBe(-9);
  });
});
