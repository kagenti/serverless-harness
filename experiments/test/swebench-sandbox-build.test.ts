// experiments/test/swebench-sandbox-build.test.ts
// Hermetic structural test for the baked-sandbox Dockerfile emitter
// (deploy/knative/build-swebench-sandbox.sh --emit --limit 3).
//
// Asserts against the emitter's REAL stdout (not a hand-maintained copy):
// invokes the bash emitter via execSync and parses the emitted Dockerfile
// text. Reads only the committed bake-list.json; no network, docker, or oc.
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const load = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

// experiments/test/ -> repo root is two levels up.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Mirrors the env_dir() sanitizer documented in build-swebench-sandbox.sh:
// strip the trailing ":<tag>" suffix, then replace any remaining "/" or ":"
// with "-". Kept here ONLY to compute the expected value independently of
// the script under test; the script's own comment is the source of truth.
const envDir = (envKey: string) => envKey.replace(/:[^:]*$/, "").replace(/[/:]/g, "-");

describe("swebench-sandbox Dockerfile emitter (build-swebench-sandbox.sh --emit --limit 3)", () => {
  const bake = load("../swebench/bake-list.json");
  const selected = [...bake.envs]
    .sort((a: any, b: any) => (a.env_key < b.env_key ? -1 : a.env_key > b.env_key ? 1 : 0))
    .slice(0, 3);

  let dockerfile: string;

  beforeAll(() => {
    dockerfile = execSync("bash deploy/knative/build-swebench-sandbox.sh --emit --limit 3", {
      cwd: repoRoot,
      encoding: "utf8",
    });
  });

  it("selects exactly 3 distinct env-keys from the committed bake-list, sorted", () => {
    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((e: any) => e.env_key)).size).toBe(3);
  });

  it("emits exactly 3 env_N build stages, each FROM the correct instance_image_key", () => {
    const stageMatches = [...dockerfile.matchAll(/^FROM (\S+) AS env_(\d+)$/gm)];
    expect(stageMatches).toHaveLength(3);
    const byIndex = new Map(stageMatches.map((m) => [Number(m[2]), m[1]]));
    selected.forEach((env: any, i: number) => {
      expect(byIndex.get(i)).toBe(env.instance_image_key);
    });
  });

  it("packs each env with the Task-1-verified conda-pack recipe, never pip", () => {
    // docs/notes/swebench-image-facts.md §4 verified `conda install ... conda-pack`
    // end-to-end against a real swebench/sweb.eval.* image; `pip install conda-pack`
    // was never verified. Guard against silent regression to the pip form.
    const packInstalls = [
      ...dockerfile.matchAll(/conda install -n base -c conda-forge conda-pack/g),
    ];
    expect(packInstalls).toHaveLength(3); // one per env stage
    expect(dockerfile).toContain(
      "/opt/miniconda3/bin/conda pack -n testbed --ignore-editable-packages --ignore-missing-files -o /tmp/env.tar.gz",
    );
    expect(dockerfile).not.toMatch(/pip install conda-pack/);
  });

  it("tolerates the dirty conda+pip testbed env in every env stage's conda pack", () => {
    // SWE-bench testbed envs are mixed conda+pip: the repo is installed editable
    // (pip install -e /testbed) and pip clobbers conda-managed files. conda pack
    // needs BOTH tolerances or the OCP build dies on the matplotlib env stage —
    // --ignore-editable-packages (editable check) and --ignore-missing-files
    // (consistency check). The runtime worktree re-installs the repo (Task 5 /
    // Plan C), so a best-effort pack of the env as-is is what we want.
    const packCmds = [...dockerfile.matchAll(/conda pack -n testbed[^\n]*/g)];
    expect(packCmds).toHaveLength(3); // one per env stage
    for (const m of packCmds) {
      expect(m[0]).toContain("--ignore-editable-packages");
      expect(m[0]).toContain("--ignore-missing-files");
    }
  });

  it("unpacks each env-key to a distinct /opt/miniconda3/envs/<env_dir> path and runs conda-unpack via the relocated env python", () => {
    // conda-unpack MUST be invoked via the relocated env's own python, not
    // directly: conda-pack writes its shebang against the original
    // /opt/miniconda3/envs/testbed/bin/python (absent in the ubuntu assembled
    // base), so a direct call follows a dead shebang and exits 127. Calling the
    // new prefix's python explicitly runs from the correct sys.prefix.
    const dirs = new Set<string>();
    for (const env of selected) {
      const dir = envDir(env.env_key);
      dirs.add(dir);
      expect(dockerfile).toContain(`/opt/miniconda3/envs/${dir}`);
      expect(dockerfile).toContain(
        `/opt/miniconda3/envs/${dir}/bin/python /opt/miniconda3/envs/${dir}/bin/conda-unpack`,
      );
    }
    expect(dirs.size).toBe(3);
  });

  it("mirrors every unique slice repo with git clone --mirror", () => {
    const repos = [...new Set(selected.map((e: any) => e.repo))];
    expect(repos.length).toBeGreaterThan(0);
    for (const repo of repos) {
      expect(dockerfile).toContain(`git clone --mirror https://github.com/${repo}.git /repos/${repo}.git`);
    }
  });

  it("carries both deck labels with correct values", () => {
    expect(dockerfile).toContain(`LABEL sh.kagenti.io/deck-hash="${bake.deckHash}"`);
    expect(dockerfile).toContain(`LABEL sh.kagenti.io/deck-slice="3of${bake.envs.length}"`);
  });

  it("runs as non-root 65532 and its terminal CMD is sleep infinity", () => {
    expect(dockerfile).toContain("USER 65532");
    expect(dockerfile.trim().endsWith('CMD ["sleep","infinity"]')).toBe(true);
  });

  it("is pure/offline: mentions no docker/oc invocation in the emitted text", () => {
    expect(dockerfile).not.toMatch(/\boc start-build\b/);
    expect(dockerfile).not.toMatch(/\bdocker build\b/);
  });
});
