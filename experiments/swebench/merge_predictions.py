#!/usr/bin/env python3
"""Merge + dedup captured SWE-bench predictions into one official-shape file for evaluation.

Usage: merge_predictions.py <out.jsonl> <in1.jsonl> [<in2.jsonl> ...]

The harness solve leaf emits one record per solved leaf as {instance_id, model_name_or_path,
model_patch}. E6 (sharing sweep) repeats the same sweep instance across samples and E1 samples
per bucket, so the same instance_id can appear many times. The official evaluator wants exactly
one prediction per instance_id, so we dedup: a non-empty patch always beats an empty one, and
among non-empty patches the last-seen (longest, on tie) wins.
"""
import json
import sys


def load(path):
    recs = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                recs.append(json.loads(line))
    except FileNotFoundError:
        print(f"  (skip missing {path})", file=sys.stderr)
    return recs


def patch_of(r):
    return r.get("model_patch") or r.get("patch") or ""


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: merge_predictions.py <out.jsonl> <in1.jsonl> [<in2.jsonl> ...]")
    out_path, in_paths = sys.argv[1], sys.argv[2:]

    best = {}  # instance_id -> normalized record
    seen = 0
    for p in in_paths:
        for r in load(p):
            seen += 1
            iid = r.get("instance_id")
            if not iid:
                continue
            mp = patch_of(r)
            # The harness solve-leaf captured `git diff` WITHOUT a trailing newline; GNU patch then
            # rejects it ("patch unexpectedly ends in middle of line"). A unified diff must end in a
            # newline, so restore it here. (Upstream fix: append "\n" at capture time in run-leaf.ts.)
            if mp and not mp.endswith("\n"):
                mp += "\n"
            norm = {
                "instance_id": iid,
                "model_name_or_path": r.get("model_name_or_path") or "unknown",
                "model_patch": mp,
            }
            prev = best.get(iid)
            if prev is None:
                best[iid] = norm
                continue
            # non-empty beats empty; among non-empty keep the longer patch
            if len(norm["model_patch"]) > len(patch_of(prev)):
                best[iid] = norm

    recs = sorted(best.values(), key=lambda r: r["instance_id"])
    with open(out_path, "w") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")

    non_empty = sum(1 for r in recs if r["model_patch"])
    print(f"merged {seen} rows -> {len(recs)} unique instances "
          f"({non_empty} non-empty patch, {len(recs) - non_empty} empty) -> {out_path}")


if __name__ == "__main__":
    main()
