import { describe, it, expect } from "vitest";
import {
  leafWorkspaceRef, buildConvergeScript, buildCleanupScript, convergeWorkspace,
} from "../src/converge.js";

describe("leafWorkspaceRef", () => {
  it("is /workspace/leaves/<runId>", () => {
    expect(leafWorkspaceRef("run-a-item-1")).toBe("/workspace/leaves/run-a-item-1");
  });
});

describe("buildConvergeScript", () => {
  const s = buildConvergeScript("https://git.example/r.git", "abc123", "leaf-1");
  it("clones only when absent (idempotent) and fetches the ref under a flock", () => {
    expect(s).toContain('[ -d "$REPO/.git" ] || git clone');
    expect(s).toContain("flock 9");
    expect(s).toContain("fetch --quiet origin");
  });
  it("adds a per-leaf worktree at the fetched commit and prints the path", () => {
    expect(s).toContain("worktree add");
    expect(s).toContain("/workspace/leaves/leaf-1");
    expect(s).toContain('printf');
  });
  it("single-quote-escapes inputs to resist injection", () => {
    const evil = buildConvergeScript("https://x/r.git'; rm -rf /; '", "main", "leaf-1");
    expect(evil).toContain(`'https://x/r.git'\\''; rm -rf /; '\\'''`);
  });
});

describe("convergeWorkspace", () => {
  it("returns trimmed stdout as the workspace ref on success", async () => {
    const exec = async () => ({ stdout: Buffer.from("/workspace/leaves/leaf-1\n"), exitCode: 0 });
    expect(await convergeWorkspace(exec, "u", "r", "leaf-1")).toBe("/workspace/leaves/leaf-1");
  });
  it("throws on non-zero exit", async () => {
    const exec = async () => ({ stdout: Buffer.from(""), exitCode: 1 });
    await expect(convergeWorkspace(exec, "u", "r", "leaf-1")).rejects.toThrow(/converge failed/);
  });
});

describe("buildCleanupScript", () => {
  it("removes the leaf worktree and prunes", () => {
    const c = buildCleanupScript("leaf-1");
    expect(c).toContain("worktree remove");
    expect(c).toContain("/workspace/leaves/leaf-1");
    expect(c).toContain("worktree prune");
  });
});
