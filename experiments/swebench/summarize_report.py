#!/usr/bin/env python3
"""Summarize the official SWE-bench evaluation report → resolved-rate + per-instance verdicts.

Usage: summarize_report.py <run_id> [<report_dir>]

run_evaluation writes a final report JSON (e.g. "<model>.<run_id>.json") into its working
directory. We glob for it by run_id, then print the headline resolved-rate and the resolved /
unresolved / empty / error instance lists so a reader sees exactly what passed.
"""
import glob
import json
import os
import sys


def find_report(run_id, report_dir):
    cands = sorted(
        glob.glob(os.path.join(report_dir, f"*{run_id}*.json")),
        key=os.path.getmtime, reverse=True,
    )
    # prefer files that actually look like a report (have resolved_ids / total_instances)
    for p in cands:
        try:
            with open(p) as f:
                d = json.load(f)
            if isinstance(d, dict) and ("resolved_ids" in d or "total_instances" in d):
                return p, d
        except (json.JSONDecodeError, OSError):
            continue
    return (cands[0] if cands else None), None


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: summarize_report.py <run_id> [<report_dir>]")
    run_id = sys.argv[1]
    report_dir = sys.argv[2] if len(sys.argv) > 2 else "."

    path, d = find_report(run_id, report_dir)
    if d is None:
        print(f"NO REPORT found for run_id={run_id} in {report_dir} "
              f"(candidates: {path or 'none'})")
        sys.exit(2)

    total = d.get("total_instances", 0)
    submitted = d.get("submitted_instances", total)
    completed = d.get("completed_instances", 0)
    resolved = d.get("resolved_instances", len(d.get("resolved_ids", [])))
    unresolved = d.get("unresolved_instances", len(d.get("unresolved_ids", [])))
    empty = d.get("empty_patch_instances", len(d.get("empty_patch_ids", [])))
    errored = d.get("error_instances", len(d.get("error_ids", [])))

    # We score a SUBSET of SWE-bench Verified (only the instances our run produced patches for), so
    # total_instances = 500 (the full dataset) is NOT a meaningful denominator. The right base is
    # completed_instances — instances that actually ran to a pass/fail verdict. We also report
    # resolved/submitted (includes empty-patch instances) for full context.
    denom = completed or submitted or total or 1
    rate = 100.0 * resolved / denom
    sub_rate = 100.0 * resolved / submitted if submitted else 0.0

    print("=" * 60)
    print(f"SWE-bench report: {os.path.basename(path)}")
    print("=" * 60)
    print(f"RESOLVED_RATE = {resolved}/{denom}  ({rate:.1f}%)   [resolved / completed]")
    print(f"  also {resolved}/{submitted} ({sub_rate:.1f}%) of submitted (incl. empty-patch); "
          f"dataset total_instances={total}")
    print(f"  submitted={submitted} completed={completed} "
          f"resolved={resolved} unresolved={unresolved} empty_patch={empty} errored={errored}")
    for label, key in [("resolved", "resolved_ids"), ("unresolved", "unresolved_ids"),
                       ("empty_patch", "empty_patch_ids"), ("errored", "error_ids")]:
        ids = d.get(key, [])
        if ids:
            print(f"  {label}: {', '.join(sorted(ids))}")
    print("=" * 60)


if __name__ == "__main__":
    main()
