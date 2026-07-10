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
  it("fetches the per-leaf repoUrl+ref explicitly (never a fixed 'origin')", () => {
    // #67: fetch must target the URL from this leaf's envelope, so one pooled
    // sandbox can serve many repos. It must NOT fetch a fixed `origin`.
    expect(s).toContain("fetch --quiet 'https://git.example/r.git' 'abc123'");
    expect(s).not.toContain("fetch --quiet origin");
    // No `git clone` — init+fetch replaces it (clone binds origin to the first URL).
    expect(s).not.toContain("git clone");
  });
  it("does init+fetch inside the flocked subshell (no clone race)", () => {
    // #67 defect 2: the whole init+fetch must run under the flock, in order:
    // flock → init → fetch → close the lock fd.
    expect(s).toMatch(/flock 9[\s\S]*git init[\s\S]*fetch[\s\S]*9>"\$LOCK"/);
  });
  it("self-heals a missing or corrupt repo (init under lock, retry on fetch failure)", () => {
    // Missing/non-git /workspace/repo → rm -rf + git init (closes #59).
    expect(s).toContain('[ -d "$REPO/.git" ] || { rm -rf "$REPO"; git init');
    // A failed fetch (e.g. corrupt .git) re-inits and fetches once more.
    expect(s).toMatch(/fetch --quiet '[^']*' '[^']*' \|\| \{ rm -rf "\$REPO"; git init/);
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
    const transport = {
      exec: async () => ({ stdout: Buffer.from("/workspace/leaves/leaf-1\n"), exitCode: 0 }),
      close: async () => {},
    };
    expect(await convergeWorkspace(transport, "u", "r", "leaf-1")).toBe("/workspace/leaves/leaf-1");
  });
  it("throws on non-zero exit", async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(""), exitCode: 1 }),
      close: async () => {},
    };
    await expect(convergeWorkspace(transport, "u", "r", "leaf-1")).rejects.toThrow(/converge failed/);
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
