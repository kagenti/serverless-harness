import { describe, it, expect, vi } from "vitest";
import {
  envDirFromKey, buildSwebenchSetupScript, buildSwebenchDiffScript,
  swebenchCheckoutDir, buildSwebenchSolvePrompt,
} from "../src/swebench-setup.js";

describe("swebench-setup script builders", () => {
  const a = { repoUrl: "/repos/django/django.git", baseCommit: "abc1234", envKey: "sweb.env.py.x86_64.deadbeef:latest", runId: "run-1" };
  it("derives env_dir by stripping a trailing :latest", () => {
    expect(envDirFromKey("sweb.env.py.x86_64.deadbeef:latest")).toBe("sweb.env.py.x86_64.deadbeef");
    expect(envDirFromKey("sweb.env.py.x86_64.deadbeef")).toBe("sweb.env.py.x86_64.deadbeef");
  });
  it("clones with --no-hardlinks, checks out base_commit, builds a system-site venv, editable-installs with build-iso fallback under HOME=/workspace", () => {
    const s = buildSwebenchSetupScript(a);
    expect(s).toContain('git clone --no-hardlinks "/repos/django/django.git"');
    expect(s).toContain('checkout -q "abc1234"');
    expect(s).toContain('/opt/miniconda3/envs/sweb.env.py.x86_64.deadbeef/bin/python" -m venv --system-site-packages');
    expect(s).toContain("HOME=/workspace");
    expect(s).toContain("pip install -e");
    expect(s).toContain("--no-build-isolation");
    expect(s).toContain("--no-cache-dir");
    // fallback: a second pip install WITHOUT --no-build-isolation
    expect(s.match(/pip" install -e/g)?.length).toBeGreaterThanOrEqual(2);
    // prints the checkout dir on stdout so the caller can set podCwd
    expect(s).toContain(swebenchCheckoutDir("run-1"));
  });
  it("diff script stages all and prints the cached diff from the checkout dir", () => {
    const s = buildSwebenchDiffScript("run-1");
    expect(s).toContain(`git -C '${swebenchCheckoutDir("run-1")}' add -A`);
    expect(s).toContain("diff --cached");
  });
  it("solve prompt names the checkout root and the venv python", () => {
    const p = buildSwebenchSolvePrompt("fix the bug", "/workspace/co-run-1", "/workspace/venv-run-1/bin/python");
    expect(p).toContain("/workspace/co-run-1");
    expect(p).toContain("/workspace/venv-run-1/bin/python");
    expect(p).toContain("fix the bug");
  });
});
