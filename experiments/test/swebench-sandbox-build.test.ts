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

  it("clones the shared testbed env to each env-key's env_dir (conda create --clone)", () => {
    // conda-pack was abandoned: it shipped a corrupt numpy for mixed conda+pip
    // envs (matplotlib/sklearn numpy import failed) per the Task-3b verify gate.
    // 'conda create --clone' copies all files faithfully with self-consistent
    // prefixes at the same /opt/miniconda3 base.
    const cloneCmds = [
      ...dockerfile.matchAll(/conda create --clone testbed -n \S+ -y/g),
    ];
    expect(cloneCmds).toHaveLength(3); // one per env stage
    for (const env of selected) {
      const dir = envDir(env.env_key);
      expect(dockerfile).toContain(
        `/opt/miniconda3/bin/conda create --clone testbed -n ${dir} -y`,
      );
    }
  });

  it("COPYs each cloned env to the exact same /opt/miniconda3/envs/<env_dir> path (no relocation)", () => {
    // conda clone already wrote correct prefixes for this path, so source==dest
    // and the env is usable as-is (activatable via
    // 'source /opt/miniconda3/envs/<env_dir>/bin/activate').
    const dirs = new Set<string>();
    selected.forEach((env: any, i: number) => {
      const dir = envDir(env.env_key);
      dirs.add(dir);
      expect(dockerfile).toContain(
        `COPY --from=env_${i} /opt/miniconda3/envs/${dir} /opt/miniconda3/envs/${dir}`,
      );
    });
    expect(dirs.size).toBe(3);
  });

  it("git config --system --add safe.directory is present (root-cloned repos, non-root pod)", () => {
    expect(dockerfile).toContain("git config --system --add safe.directory '*'");
  });

  it("contains NONE of the abandoned conda-pack machinery (regression guard)", () => {
    for (const banned of [
      "conda pack",
      "conda-unpack",
      "--ignore-editable-packages",
      "--ignore-missing-files",
      "tar -xzf",
    ]) {
      expect(dockerfile).not.toContain(banned);
    }
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
