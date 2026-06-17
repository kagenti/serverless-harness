import { describe, expect, it } from "vitest";
import { FrameParser, wrapCommand } from "../src/framing.js";

const SOH = "\x01";

describe("wrapCommand", () => {
  it("brackets base64 output with nonce markers and reports the command's exit code", () => {
    const line = wrapCommand("n1", "cat '/workspace/a.txt'");
    expect(line).toBe(
      `printf '${SOH}B%s\\n' n1; { cat '/workspace/a.txt'; } | base64; ` +
        `printf '${SOH}E%s %d\\n' n1 "\${PIPESTATUS[0]}"\n`,
    );
  });

  it("delivers stdin to the command via a nonce-delimited heredoc", () => {
    const line = wrapCommand("n2", "base64 -d > '/workspace/a.txt'", Buffer.from("aGk="));
    expect(line).toBe(
      `printf '${SOH}B%s\\n' n2; { base64 -d > '/workspace/a.txt' <<'${SOH}Hn2'\n` +
        `aGk=\n${SOH}Hn2\n} | base64; ` +
        `printf '${SOH}E%s %d\\n' n2 "\${PIPESTATUS[0]}"\n`,
    );
  });
});

describe("FrameParser", () => {
  const SOHb = SOH;
  function frame(nonce: string, payload: string, code: number): string {
    const b64 = Buffer.from(payload).toString("base64");
    return `${SOHb}B${nonce}\n${b64}\n${SOHb}E${nonce} ${code}\n`;
  }

  it("emits a complete frame in one chunk, base64-decoded", () => {
    const p = new FrameParser();
    const frames = p.push(Buffer.from(frame("n1", "hello", 0)));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ nonce: "n1", exitCode: 0 });
    expect(frames[0].stdout.toString()).toBe("hello");
  });

  it("waits for the end marker (no emit on a partial frame)", () => {
    const p = new FrameParser();
    const full = frame("n1", "hello", 0);
    expect(p.push(Buffer.from(full.slice(0, 10)))).toHaveLength(0);
    const rest = p.push(Buffer.from(full.slice(10)));
    expect(rest).toHaveLength(1);
    expect(rest[0].stdout.toString()).toBe("hello");
  });

  it("handles a split in the middle of the begin marker", () => {
    const p = new FrameParser();
    const full = frame("n7", "x", 0);
    const cut = 1; // mid "\x01B..."
    expect(p.push(Buffer.from(full.slice(0, cut)))).toHaveLength(0);
    expect(p.push(Buffer.from(full.slice(cut)))).toHaveLength(1);
  });

  it("emits multiple frames present in one chunk, preserving exit codes", () => {
    const p = new FrameParser();
    const frames = p.push(Buffer.from(frame("a", "one", 0) + frame("b", "two", 2)));
    expect(frames.map((f) => [f.nonce, f.stdout.toString(), f.exitCode])).toEqual([
      ["a", "one", 0],
      ["b", "two", 2],
    ]);
  });

  it("round-trips binary payloads (NUL and high bytes)", () => {
    const p = new FrameParser();
    const bin = Buffer.from([0x00, 0xff, 0x01, 0x42, 0x0a]);
    const b64 = bin.toString("base64");
    const frames = p.push(Buffer.from(`${SOHb}Bn1\n${b64}\n${SOHb}En1 0\n`));
    expect(frames[0].stdout.equals(bin)).toBe(true);
  });
});
