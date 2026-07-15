#!/usr/bin/env python3
"""Generate the SWE-bench Verified workload deck + bake-list for the serverless-harness experiments.

env_key derivation uses swebench's own TestSpec.env_image_key (via make_test_spec on the full
instance row), NOT a hand-rolled (repo, version) string — see docs/notes/swebench-image-facts.md
(Task 1 spike) for why the raw MAP_REPO_VERSION_TO_SPECS constant is insufficient on its own.

Sampling is seeded and deterministic. test_runtime_ms/weight_bucket are populated later by
deploy/knative/measure-swebench-runtimes.sh (Task 5).

This script is intentionally non-hermetic: it needs network access (HuggingFace dataset download,
and swebench's own per-repo environment.yml/requirements.txt fetch inside make_test_spec) and the
`swebench` + `datasets` packages. It is meant to be run once to produce the committed deck.json /
bake-list.json under experiments/swebench/. The CI-facing structural tests
(experiments/test/swebench-deck.test.ts) only read those committed JSON files and require neither
network nor Python.
"""
import argparse
import hashlib
import json
import random
from pathlib import Path

from swebench.harness.test_spec.test_spec import make_test_spec


def env_key_and_instance_key(row: dict, arch: str) -> tuple[str, str]:
    """Derive (env_image_key, instance_image_key) for a full SWE-bench instance row.

    Pinned in docs/notes/swebench-image-facts.md (Task 1): must go through
    make_test_spec(instance, namespace=..., arch=...) — it needs the full row (not just
    (repo, version)) because it internally resolves the per-repo environment script list,
    which for Python repos looks up a per-instance-id cached environment.yml / fetches it
    from GitHub at environment_setup_commit on a cache miss.
    """
    ts = make_test_spec(row, namespace="swebench", arch=arch)
    return ts.env_image_key, ts.instance_image_key


def load_rows(input_path: str | None) -> list[dict]:
    """Load SWE-bench instance rows, from a local JSONL fixture or the HuggingFace dataset.

    When ``input_path`` is given it must be JSONL, one full SWE-bench_Verified instance row
    per line, mirroring the ``princeton-nlp/SWE-bench_Verified`` "test" split schema. Fields
    consumed downstream (see main()):

        instance_id                str  e.g. "django__django-11555"
        repo                       str  "owner/name", e.g. "django/django"
        base_commit                str  40-char SHA
        environment_setup_commit   str  40-char SHA (optional; falls back to base_commit)
        version                    str  e.g. "3.0"
        problem_statement          str
        test_patch                 str  (optional)
        FAIL_TO_PASS               str|list  JSON-encoded list or list of test ids
        PASS_TO_PASS               str|list  JSON-encoded list or list of test ids

    NOTE: env_key derivation calls make_test_spec, which resolves each row's per-repo
    environment against ``environment_setup_commit`` (cache hit or GitHub fetch). A fixture
    with synthetic SHAs is therefore an input-shape example only; it cannot produce a real
    deck offline without a populated swebench environment cache.
    """
    if input_path:
        return [json.loads(line) for line in Path(input_path).read_text().splitlines() if line.strip()]
    from datasets import load_dataset

    return list(load_dataset("princeton-nlp/SWE-bench_Verified", split="test"))


def to_list(value) -> list[str]:
    if isinstance(value, str):
        return json.loads(value)
    return list(value or [])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slice", default="all")  # "all" or an int
    ap.add_argument("--seed", type=int, default=1776)
    ap.add_argument("--arch", default="x86_64")
    ap.add_argument("--input")  # local JSONL fixture (offline input example); else HF dataset
    ap.add_argument("--out-dir", default="experiments/swebench")
    args = ap.parse_args()

    rows = sorted(load_rows(args.input), key=lambda r: r["instance_id"])
    if args.slice != "all":
        rows = random.Random(args.seed).sample(rows, int(args.slice))
        rows.sort(key=lambda r: r["instance_id"])

    instances = []
    instance_image_keys: dict[str, str] = {}
    for row in rows:
        env_key, instance_image_key = env_key_and_instance_key(row, args.arch)
        instance_image_keys[row["instance_id"]] = instance_image_key
        instances.append(
            {
                "instance_id": row["instance_id"],
                "repo": row["repo"],
                "base_commit": row["base_commit"],
                "environment_setup_commit": row.get("environment_setup_commit") or row["base_commit"],
                "version": str(row["version"]),
                "env_key": env_key,
                "problem_statement": row["problem_statement"],
                "test_patch": row.get("test_patch", ""),
                "fail_to_pass": to_list(row.get("FAIL_TO_PASS")),
                "pass_to_pass": to_list(row.get("PASS_TO_PASS")),
                "test_runtime_ms": None,
                "weight_bucket": None,
            }
        )

    deck_hash = hashlib.sha256(
        json.dumps([[i["instance_id"], i["env_key"]] for i in instances], sort_keys=True).encode()
    ).hexdigest()[:16]

    # Group instances by env_key and deterministically pick the lexicographically smallest
    # instance_id in each group as the representative (stable across re-runs).
    by_env_key: dict[str, list[str]] = {}
    for inst in instances:
        by_env_key.setdefault(inst["env_key"], []).append(inst["instance_id"])

    envs = []
    for env_key in sorted(by_env_key):
        instance_ids = sorted(by_env_key[env_key])
        representative_instance_id = instance_ids[0]
        repo = next(i["repo"] for i in instances if i["instance_id"] == representative_instance_id)
        envs.append(
            {
                "env_key": env_key,
                "repo": repo,
                "representative_instance_id": representative_instance_id,
                "instance_image_key": instance_image_keys[representative_instance_id],
            }
        )

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "deck.json").write_text(
        json.dumps({"deckHash": deck_hash, "seed": args.seed, "instances": instances}, indent=2) + "\n"
    )
    (out / "bake-list.json").write_text(
        json.dumps(
            {
                "deckHash": deck_hash,
                "repos": sorted({i["repo"] for i in instances}),
                "envKeys": sorted({i["env_key"] for i in instances}),
                "envs": envs,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"wrote {len(instances)} instances, {len(envs)} env_keys, deckHash={deck_hash}")


if __name__ == "__main__":
    main()
