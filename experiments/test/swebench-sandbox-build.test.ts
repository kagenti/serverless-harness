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

  it("--print-tag derives <deckHash>-<N>of<total> from the bake-list for each --limit", () => {
    const printTag = (limit: number) =>
      execSync(`bash deploy/knative/build-swebench-sandbox.sh --print-tag --limit ${limit}`, {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
    const total = bake.envs.length;
    expect(printTag(3)).toBe(`${bake.deckHash}-3of${total}`);
    expect(printTag(total)).toBe(`${bake.deckHash}-${total}of${total}`);
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

describe("swebench-sandbox emitter — iterative accumulation (--offset / --base / base-tools)", () => {
  const bake = load("../swebench/bake-list.json");
  const sorted = [...bake.envs].sort((a: any, b: any) =>
    a.env_key < b.env_key ? -1 : a.env_key > b.env_key ? 1 : 0,
  );
  const total = bake.envs.length;

  const emit = (args: string) =>
    execSync(`bash deploy/knative/build-swebench-sandbox.sh --emit ${args}`, {
      cwd: repoRoot,
      encoding: "utf8",
    });
  const printTag = (args: string) =>
    execSync(`bash deploy/knative/build-swebench-sandbox.sh --print-tag ${args}`, {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

  it("--offset 5 --limit 5 selects envs[5:10] (correct instance_image_keys)", () => {
    const df = emit("--offset 5 --limit 5 --base prior");
    const stages = [...df.matchAll(/^FROM (\S+) AS env_(\d+)$/gm)];
    expect(stages).toHaveLength(5);
    const byIndex = new Map(stages.map((m) => [Number(m[2]), m[1]]));
    sorted.slice(5, 10).forEach((env: any, i: number) => {
      expect(byIndex.get(i)).toBe(env.instance_image_key);
    });
  });

  it("--base sets the assembled FROM image", () => {
    expect(emit("--offset 5 --limit 5 --base my/prior:img")).toContain(
      "FROM my/prior:img AS assembled",
    );
  });

  it("batch-2 style (base set, no base tools) OMITS apt + safe.directory", () => {
    const df = emit("--offset 5 --limit 5 --base prior");
    expect(df).not.toContain("apt-get install");
    expect(df).not.toContain("safe.directory");
    // still switches to root for the COPY/RUN steps and back to 65532 at the end
    expect(df).toContain("FROM prior AS assembled\nUSER 0");
    expect(df).toContain("USER 65532");
  });

  it("batch-1 default base still emits apt + safe.directory (auto base-tools)", () => {
    const df = emit("--offset 0 --limit 5");
    expect(df).toContain("FROM ubuntu:22.04 AS assembled");
    expect(df).toContain(
      "apt-get install -y --no-install-recommends git ripgrep ca-certificates " +
        "build-essential python3-dev pkg-config libfreetype6-dev libpng-dev",
    );
    expect(df).toContain("git config --system --add safe.directory '*'");
  });

  it("--no-base-tools force-skips tooling even on the default ubuntu base", () => {
    const df = emit("--offset 0 --limit 5 --no-base-tools");
    expect(df).toContain("FROM ubuntu:22.04 AS assembled");
    expect(df).not.toContain("apt-get install");
    expect(df).not.toContain("safe.directory");
  });

  it("repo clones use the idempotent 'test -d ... ||' form", () => {
    const df = emit("--offset 5 --limit 5 --base prior");
    const uniqueRepos = [...new Set(sorted.slice(5, 10).map((e: any) => e.repo))];
    expect(uniqueRepos.length).toBeGreaterThan(0);
    for (const repo of uniqueRepos) {
      expect(df).toContain(
        `RUN test -d /repos/${repo}.git || git clone --mirror https://github.com/${repo}.git /repos/${repo}.git`,
      );
    }
  });

  it("deck-slice label is CUMULATIVE (offset + selected) coverage", () => {
    expect(emit("--offset 5 --limit 5 --base prior")).toContain(
      `LABEL sh.kagenti.io/deck-slice="10of${total}"`,
    );
    expect(emit("--offset 10 --limit 5 --base prior")).toContain(
      `LABEL sh.kagenti.io/deck-slice="${total}of${total}"`,
    );
  });

  it("--print-tag honors --offset (cumulative)", () => {
    expect(printTag("--offset 0 --limit 5")).toBe(`${bake.deckHash}-5of${total}`);
    expect(printTag("--offset 5 --limit 5")).toBe(`${bake.deckHash}-10of${total}`);
    expect(printTag("--offset 10 --limit 5")).toBe(`${bake.deckHash}-${total}of${total}`);
  });
});
