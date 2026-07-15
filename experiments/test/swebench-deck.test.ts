import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const load = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

describe("swebench deck", () => {
  const deck = load("../swebench/deck.json");
  const bake = load("../swebench/bake-list.json");

  it("has a stable hash shared by deck and bake-list", () => {
    expect(typeof deck.deckHash).toBe("string");
    expect(deck.deckHash.length).toBeGreaterThan(0);
    expect(bake.deckHash).toBe(deck.deckHash);
  });

  it("every instance's (repo, env_key) is present in the bake-list as a pair (drift guard)", () => {
    const repos = new Set(bake.repos);
    const keys = new Set(bake.envKeys);
    // The (env_key -> repo) pairing is recorded in bake-list.envs; a mismatched
    // (repo, env_key) pairing must fail, not just each field independently.
    const repoByEnvKey = new Map<string, string>(bake.envs.map((e: any) => [e.env_key, e.repo]));
    for (const inst of deck.instances) {
      expect(repos.has(inst.repo), `repo ${inst.repo} missing from bake-list`).toBe(true);
      expect(keys.has(inst.env_key), `env_key ${inst.env_key} missing from bake-list`).toBe(true);
      expect(
        repoByEnvKey.get(inst.env_key),
        `(repo, env_key) pair (${inst.repo}, ${inst.env_key}) not recorded together in bake-list.envs`,
      ).toBe(inst.repo);
    }
  });

  it("the bake-list carries no repo or env_key absent from the deck (reverse drift guard)", () => {
    const deckRepos = new Set(deck.instances.map((i: any) => i.repo));
    const deckEnvKeys = new Set(deck.instances.map((i: any) => i.env_key));
    for (const repo of bake.repos) {
      expect(deckRepos.has(repo), `bake-list repo ${repo} not present in the deck (stale entry)`).toBe(true);
    }
    for (const key of bake.envKeys) {
      expect(deckEnvKeys.has(key), `bake-list env_key ${key} not present in the deck (stale entry)`).toBe(true);
    }
    for (const e of bake.envs) {
      expect(deckEnvKeys.has(e.env_key), `bake-list.envs env_key ${e.env_key} not present in the deck (stale entry)`).toBe(true);
    }
  });

  it("each instance carries the required normalized fields", () => {
    for (const inst of deck.instances) {
      for (const f of ["instance_id", "repo", "base_commit", "environment_setup_commit", "version", "env_key", "problem_statement"]) {
        expect(inst[f], `${inst.instance_id} missing ${f}`).toBeTruthy();
      }
      expect(Array.isArray(inst.fail_to_pass)).toBe(true);
      expect(Array.isArray(inst.pass_to_pass)).toBe(true);
      // runtime/bucket may be null (pre-measurement) or populated (post Task 5)
      expect(["light", "medium", "heavy", null]).toContain(inst.weight_bucket);
    }
  });

  it("every deck env_key has a bake-list.envs entry whose representative_instance_id is a deck instance for that env_key", () => {
    expect(Array.isArray(bake.envs)).toBe(true);

    const instancesByEnvKey = new Map<string, Set<string>>();
    const repoByInstance = new Map<string, string>();
    for (const inst of deck.instances) {
      if (!instancesByEnvKey.has(inst.env_key)) instancesByEnvKey.set(inst.env_key, new Set());
      instancesByEnvKey.get(inst.env_key)!.add(inst.instance_id);
      repoByInstance.set(inst.instance_id, inst.repo);
    }

    const envsByKey = new Map<string, any>();
    for (const e of bake.envs) {
      for (const f of ["env_key", "repo", "representative_instance_id", "instance_image_key"]) {
        expect(e[f], `bake-list env entry missing ${f}: ${JSON.stringify(e)}`).toBeTruthy();
      }
      envsByKey.set(e.env_key, e);
    }

    for (const [envKey, instanceIds] of instancesByEnvKey) {
      const entry = envsByKey.get(envKey);
      expect(entry, `env_key ${envKey} missing from bake-list.envs`).toBeTruthy();
      expect(
        instanceIds.has(entry.representative_instance_id),
        `representative_instance_id ${entry.representative_instance_id} for env_key ${envKey} is not a deck instance sharing that env_key`,
      ).toBe(true);
      // representative must be the lexicographically smallest instance_id in the group (deterministic pick)
      expect(entry.representative_instance_id).toBe([...instanceIds].sort()[0]);
      // envs[].repo must match the repo of the group it represents (a wrong repo must fail)
      expect(
        entry.repo,
        `bake-list.envs repo ${entry.repo} for env_key ${envKey} does not match deck repo ${repoByInstance.get(entry.representative_instance_id)}`,
      ).toBe(repoByInstance.get(entry.representative_instance_id));
      // instance_image_key must embed the representative_instance_id; swebench maps "__" -> "_1776_"
      // in image tags (e.g. django__django-11555 -> ...django_1776_django-11555...).
      const imageId = entry.representative_instance_id.replace(/__/g, "_1776_");
      expect(
        entry.instance_image_key.includes(imageId),
        `instance_image_key ${entry.instance_image_key} does not embed representative id ${imageId}`,
      ).toBe(true);
    }
  });
});
