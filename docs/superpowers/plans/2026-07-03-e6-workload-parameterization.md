# E6 Workload-Parameterized Sandbox-Load — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace E6's trivial marker-check leaf with real Archetype-A code-review variants (L0/L1/L2), report the harness→sandbox sharing ratio N as a *curve over per-leaf sandbox work* (measured at C=1), and make the concurrency knee noise-robust by removing the harness `max-scale` confound, warming, multi-sampling, and using a sustained-decline `detectKnee`.

**Architecture:** Pure analysis in `experiments/src/sharing.ts` (unit-tested): a new `buildRatioCurve` and a `patience`-based `detectKnee`. The git-daemon serves a new `work` ref carrying three code fixtures of increasing size. The E6 bash driver runs two phases against a pinned sandbox — Phase 1 measures per-leaf duty at C=1 on a warm pod (exec-timing delta per leaf, median of N samples) across L0/L1/L2 → the N curve; Phase 2 sweeps concurrency at the heaviest variant with the harness un-capped (`max-scale` raised) → the knee as a floor. No harness/leaf code changes.

**Tech Stack:** TypeScript (ESM, vitest 2.x) for `@sh/experiments`; bash + `kubectl` + `jq` + `awk` drivers reusing `deploy/knative/lib.sh`; Knative Serving; `git daemon`; Redis.

## Global Constraints

- **DCO sign-off on every commit** (`git commit -s`); trailer `Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>` — **never** `Co-authored-by`.
- **Never `git add -A`** — stage explicit paths only (`experiments/RESULTS.md` and `.worktrees/` are intentionally dirty; `.superpowers/` is git-ignored).
- **Branch:** `feat/e6-workload-parameterization` (already created off main; spec + README already committed there at `b53dfdd`).
- **`gh pr merge` is denied to this agent** — the user merges PRs.
- **Off-by-default / gated:** the E6 driver no-ops (`SKIP`, exit 0, no cluster contact) unless `E6_LIVE=1`; exec timing stays behind `KAGENTI_EXEC_TIMING=1`.
- **FS-free / contract untouched:** no changes to `harness/` or `packages/` — intensity is emergent + measured, not injected (spec D5).
- **Model:** `SH_MODEL=claude-haiku-4-5` for live runs. **Cluster order:** Kind `sh-knative` (dev) → live OCP 4.20 (`KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig`, standing P3 stack).
- **tsx import path** from a driver (CWD `deploy/knative/`) is `../../experiments/src/sharing.ts`.
- **Context budget:** redirect long output to `/tmp/sh/*.log`; analyze via subagents.
- **Exact converge paths:** shared repo `/workspace/repo`, per-pod lock `/workspace/.sh-fetch.lock`, per-leaf worktree `/workspace/leaves/<runId>`; `/runs` body is a `LeafEnvelope` (`sessionId`, `item:{item_id,file,pattern}`, `repoUrl`, `ref`, `model`); converge activates only when `repoUrl`+`ref` are both set.

## File Structure

- `experiments/src/sharing.ts` — **modify**: add `WorkloadPoint`/`RatioCurvePoint` + `buildRatioCurve`; change `detectKnee` signature to add `patience` + sustained-decline logic. (Preserve existing `LadderPoint`, `dutyCycle`, `derivedRatio`, `sanityFloorPass`, `worktreeConsistent`.)
- `experiments/test/e6-saturation-structural.test.ts` — **modify**: update `detectKnee` tests to sustained-decline semantics; add `buildRatioCurve` tests.
- `deploy/knative/gitd.yaml` — **modify**: after the marker branches, seed a `work` ref with `small.py`/`medium.py`/`large.py`.
- `deploy/knative/lib.sh` — **modify**: add `count_exec_lines`, `median`, `set_scale`; extend `restore_ksvc_env` to reset scale annotations.
- `deploy/knative/e6-saturation.sh` — **rewrite**: Phase 1 (N-vs-workload curve) + Phase 2 (concurrency sweep at L2, un-capped).
- `deploy/knative/EXPERIMENTS.md` — **modify**: P3 section headline → N-vs-workload curve; supersede the single-N (L0 upper-bound) note.

---

## Task 1: `buildRatioCurve` + types (sharing.ts)

**Files:**
- Modify: `experiments/src/sharing.ts`
- Test: `experiments/test/e6-saturation-structural.test.ts`

**Interfaces:**
- Consumes: existing `dutyCycle(execBusyMs, wallMs)`, `derivedRatio(duty)` (both throw on ≤0).
- Produces:
  - `interface WorkloadPoint { label: string; execMs: number; execCount: number; wallMs: number }`
  - `interface RatioCurvePoint { label: string; execCount: number; duty: number; n: number }`
  - `buildRatioCurve(points: WorkloadPoint[]): RatioCurvePoint[]`

- [ ] **Step 1: Write the failing test** — append to `experiments/test/e6-saturation-structural.test.ts`:

```typescript
import { buildRatioCurve, type WorkloadPoint } from "../src/sharing";

describe("buildRatioCurve — N as a function of per-leaf sandbox work", () => {
  it("maps each workload point to duty + N, N decreasing as sandbox work rises", () => {
    const pts: WorkloadPoint[] = [
      { label: "L0", execMs: 300, execCount: 2, wallMs: 12000 },
      { label: "L1", execMs: 1200, execCount: 6, wallMs: 12000 },
      { label: "L2", execMs: 3000, execCount: 14, wallMs: 12000 },
    ];
    const curve = buildRatioCurve(pts);
    expect(curve.map((c) => c.label)).toEqual(["L0", "L1", "L2"]);
    expect(curve[0].duty).toBeCloseTo(0.025, 3);
    expect(curve[0].n).toBe(40); // 1/0.025
    expect(curve[0].execCount).toBe(2);
    // heavier sandbox work at equal wall => higher duty => lower N
    expect(curve[2].duty).toBeGreaterThan(curve[0].duty);
    expect(curve[2].n).toBeLessThan(curve[0].n);
  });

  it("propagates the dutyCycle guard (wallMs <= 0 throws)", () => {
    expect(() => buildRatioCurve([{ label: "x", execMs: 1, execCount: 1, wallMs: 0 }])).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd experiments && npx vitest run test/e6-saturation-structural.test.ts -t buildRatioCurve`
Expected: FAIL — `buildRatioCurve` is not exported.

- [ ] **Step 3: Implement** — append to `experiments/src/sharing.ts`:

```typescript
export interface WorkloadPoint {
  label: string;
  execMs: number;    // sandbox-busy ms attributable to one leaf of this workload
  execCount: number; // number of sandbox execs the leaf issued
  wallMs: number;    // leaf wall-clock
}

export interface RatioCurvePoint {
  label: string;
  execCount: number;
  duty: number;
  n: number;
}

/** N ≈ 1/duty at each workload intensity — the sharing ratio as a curve over sandbox work. */
export function buildRatioCurve(points: WorkloadPoint[]): RatioCurvePoint[] {
  return points.map((p) => {
    const duty = dutyCycle(p.execMs, p.wallMs);
    return { label: p.label, execCount: p.execCount, duty, n: derivedRatio(duty) };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd experiments && npx vitest run test/e6-saturation-structural.test.ts -t buildRatioCurve`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add experiments/src/sharing.ts experiments/test/e6-saturation-structural.test.ts
git commit -s -m "feat: Add buildRatioCurve (N as a curve over per-leaf sandbox work)

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 2: sustained-decline `detectKnee` (sharing.ts)

**Files:**
- Modify: `experiments/src/sharing.ts`
- Test: `experiments/test/e6-saturation-structural.test.ts`

**Interfaces:**
- Produces: `detectKnee(points: LadderPoint[], degradeX: number, patience?: number): number` — `patience` defaults to 2. A rung is *healthy* if `p95Ms <= degradeX * baselineP95` **and** `throughput >=` the running-max throughput seen so far. The knee advances to each healthy rung; the scan breaks only after `patience` **consecutive** unhealthy rungs (so a single noisy dip does not collapse the knee). Still throws if no `c === 1` baseline.

- [ ] **Step 1: Replace the `detectKnee` tests** — in `experiments/test/e6-saturation-structural.test.ts`, replace the existing `detectKnee` describe block with:

```typescript
describe("detectKnee — sustained-decline (noise-tolerant)", () => {
  it("still returns the last healthy rung when the top rung blows past the latency bound", () => {
    const series: LadderPoint[] = [
      { c: 1, throughput: 1.0, p95Ms: 1000 },
      { c: 2, throughput: 1.9, p95Ms: 1050 },
      { c: 4, throughput: 3.6, p95Ms: 1200 },
      { c: 8, throughput: 5.0, p95Ms: 1900 },
      { c: 16, throughput: 5.1, p95Ms: 4200 }, // latency blowup (> 2x baseline)
    ];
    expect(detectKnee(series, 2)).toBe(8);
  });

  it("tolerates a single throughput dip within the latency bound (does not break early)", () => {
    const series: LadderPoint[] = [
      { c: 1, throughput: 1.0, p95Ms: 1000 },
      { c: 2, throughput: 2.0, p95Ms: 1100 },
      { c: 4, throughput: 1.8, p95Ms: 1200 }, // single dip below running-max 2.0
      { c: 8, throughput: 2.6, p95Ms: 1500 }, // recovers
    ];
    expect(detectKnee(series, 2)).toBe(8);
  });

  it("breaks on a sustained decline (patience consecutive unhealthy rungs)", () => {
    const series: LadderPoint[] = [
      { c: 1, throughput: 1.0, p95Ms: 1000 },
      { c: 2, throughput: 2.0, p95Ms: 1100 },
      { c: 4, throughput: 1.5, p95Ms: 1200 }, // unhealthy 1
      { c: 8, throughput: 1.4, p95Ms: 1300 }, // unhealthy 2 -> break
      { c: 16, throughput: 3.0, p95Ms: 1400 }, // never reached
    ];
    expect(detectKnee(series, 2)).toBe(2);
  });

  it("throws when there is no c=1 baseline", () => {
    expect(() => detectKnee([{ c: 2, throughput: 1, p95Ms: 1 }], 2)).toThrow(/baseline/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd experiments && npx vitest run test/e6-saturation-structural.test.ts -t detectKnee`
Expected: FAIL — the single-dip and sustained-decline cases fail against the current strict-break implementation.

- [ ] **Step 3: Replace `detectKnee`** in `experiments/src/sharing.ts`:

```typescript
/**
 * The knee = the highest concurrency still "healthy": p95 within `degradeX` of the single-leaf
 * baseline AND throughput at/above the running max. Tolerates transient dips — breaks only after
 * `patience` consecutive unhealthy rungs (per-leaf latency variance makes a single rung dip). The
 * knee that c is the recommended KAGENTI_SANDBOX_CAP (a floor when no break occurs).
 */
export function detectKnee(points: LadderPoint[], degradeX: number, patience = 2): number {
  const baseline = points.find((p) => p.c === 1);
  if (!baseline) throw new Error("detectKnee: no c=1 baseline point");
  const bound = baseline.p95Ms * degradeX;
  const sorted = [...points].sort((a, b) => a.c - b.c);
  let knee = 1;
  let best = baseline.throughput;
  let unhealthy = 0;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const healthy = cur.p95Ms <= bound && cur.throughput >= best;
    if (healthy) {
      knee = cur.c;
      best = cur.throughput;
      unhealthy = 0;
    } else if (++unhealthy >= patience) {
      break;
    }
  }
  return knee;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd experiments && npx vitest run test/e6-saturation-structural.test.ts`
Expected: PASS (all `detectKnee` + `buildRatioCurve` + existing duty/floor cases).

- [ ] **Step 5: Commit**

```bash
git add experiments/src/sharing.ts experiments/test/e6-saturation-structural.test.ts
git commit -s -m "fix: Make detectKnee noise-tolerant (sustained-decline, patience) (#62)

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 3: git-daemon `work` ref with code fixtures

**Files:**
- Modify: `deploy/knative/gitd.yaml`

**Interfaces:**
- Produces: a `work` ref on `git://gitd.<ns>.svc:9418/repo.git` containing `small.py` (contains `password`), `medium.py` (~80 lines, contains `eval(`), `large.py` (~240 lines, many `eval(`). Marker branches `branch-0..K-1` unchanged (E7 uses them).

- [ ] **Step 1: Add the `work` ref to the seed script.** In `deploy/knative/gitd.yaml`, immediately **after** the `while [ "$i" -lt "$K" ]; do … done` marker-branch loop and **before** the `exec git daemon …` line, insert:

```yaml
              # E6 workload ref: real code-review fixtures of increasing size (small/medium/large)
              # so leaf review scope (=> sandbox tool calls => duty) spans light..heavy.
              git checkout -q --orphan work || git checkout -q -b work
              git rm -rq --cached . 2>/dev/null || true
              rm -f marker.txt
              printf 'API_KEY = "abc123"\npassword = "hunter2"\n' > small.py
              { echo "import os"; i=0; while [ "$i" -lt 40 ]; do echo "def f$i(x):"; echo "    return eval(x)  # finding $i"; i=$((i+1)); done; } > medium.py
              { echo "import subprocess"; i=0; while [ "$i" -lt 120 ]; do echo "def g$i(x):"; echo "    return eval(x)  # scan $i"; i=$((i+1)); done; } > large.py
              git add small.py medium.py large.py
              git commit -qm "work fixtures"
              git push -q origin work
```

- [ ] **Step 2: Validate the manifest renders**

Run: `mkdir -p /tmp/sh && kubectl kustomize deploy/knative > /tmp/sh/kustomize-base.log 2>&1; echo "BASE:$?"` and `kubectl kustomize deploy/knative/overlays/ocp > /tmp/sh/kustomize-ocp.log 2>&1; echo "OCP:$?"`
Expected: `BASE:0` and `OCP:0`. Confirm the seed change is present: `grep -c 'work fixtures' /tmp/sh/kustomize-base.log` ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add deploy/knative/gitd.yaml
git commit -s -m "feat: Seed a work ref with code fixtures for E6 workload variants

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 4: lib.sh helpers (exec count, median, scale) + scale reset

**Files:**
- Modify: `deploy/knative/lib.sh`

**Interfaces:**
- Produces:
  - `count_exec_lines <pod>` → echoes the number of `[exec-timing]` lines in the pod log.
  - `median` → filter: reads numbers on stdin (one per line), echoes the median.
  - `set_scale <min> <max>` → patches the ksvc min/max-scale annotations and waits Ready.
  - `restore_ksvc_env` (extended) → also resets scale annotations to `min-scale=0`/`max-scale=5`.

- [ ] **Step 1: Add `count_exec_lines`, `median`, `set_scale`.** Append after `sum_exec_ms` in `deploy/knative/lib.sh`:

```bash
# Count [exec-timing] lines in a harness pod log (needs KAGENTI_EXEC_TIMING=1). Usage: count_exec_lines <pod>
count_exec_lines() {
  kubectl -n "$NS" logs "$1" 2>/dev/null | grep -c '\[exec-timing\]'
}

# Median of integers read one-per-line on stdin (integer result). Usage: printf '%s\n' 3 1 2 | median
median() {
  sort -n | awk '{a[NR]=$1} END{ if(NR==0){print 0} else if(NR%2){print a[(NR+1)/2]} else {printf "%d", int((a[NR/2]+a[NR/2+1])/2)} }'
}

# Patch the ksvc min/max-scale annotations (a merge patch is safe for the annotations map) and wait
# Ready. Usage: set_scale <min> <max>
set_scale() {
  kubectl patch ksvc "$KSVC" -n "$NS" --type=merge -p \
    "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"autoscaling.knative.dev/min-scale\":\"$1\",\"autoscaling.knative.dev/max-scale\":\"$2\"}}}}}" >/dev/null
  wait_ksvc_ready
}
```

- [ ] **Step 2: Extend `restore_ksvc_env` to reset scale.** Replace the body of `restore_ksvc_env` in `deploy/knative/lib.sh` with:

```bash
restore_ksvc_env() {
  set_ksvc_env KAGENTI_SANDBOX_POD- KAGENTI_EXEC_TIMING- KAGENTI_SANDBOX_CAP- \
    KAGENTI_SANDBOX_POOL_SELECTOR=sh.kagenti.io/sandbox-pool=default >/dev/null 2>&1 || true
  # Reset the autoscaling annotations to the committed service.yaml defaults (min 0 / max 5).
  kubectl patch ksvc "$KSVC" -n "$NS" --type=merge -p \
    '{"spec":{"template":{"metadata":{"annotations":{"autoscaling.knative.dev/min-scale":"0","autoscaling.knative.dev/max-scale":"5"}}}}}' \
    >/dev/null 2>&1 || true
}
```

- [ ] **Step 3: Lint**

Run: `shellcheck -x deploy/knative/lib.sh > /tmp/sh/shellcheck-lib.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0` (or only pre-existing warnings — state which).

- [ ] **Step 4: Commit**

```bash
git add deploy/knative/lib.sh
git commit -s -m "feat: Add lib.sh helpers count_exec_lines/median/set_scale + scale reset

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 5: Rewrite `e6-saturation.sh` (N-curve + un-capped sweep)

**Files:**
- Modify (rewrite): `deploy/knative/e6-saturation.sh`

**Interfaces:**
- Consumes: `lib.sh` (`ensure_port_forward`, `wait_gitd`, `wait_ksvc_ready`, `set_ksvc_env`, `set_scale`, `restore_ksvc_env`, `dispatch_converge`, `sum_exec_ms`, `count_exec_lines`, `median`, `now_ms`, `ok`/`ko`, `FAIL`); `sharing.ts` (`buildRatioCurve`, `detectKnee`, `sanityFloorPass`) via `npx tsx`; the git-daemon `work` ref.
- Env: `E6_LIVE` (gate), `E6_SAMPLES` (default 3), `E6_LADDER` (default `1 2 4 8 16`), `E6_DEGRADE_X` (2), `E6_MIN_CONCURRENCY` (4), `E6_SWEEP_MAX_SCALE` (20), `KAGENTI_SANDBOX_POD` (pin, default `sandbox-0`), `SH_MODEL`, `KSVC`, `NS`, `KSVC_URL` (OCP Route).

- [ ] **Step 1: Replace the whole file** `deploy/knative/e6-saturation.sh` with:

```bash
#!/usr/bin/env bash
# deploy/knative/e6-saturation.sh
# E6 (workload-parameterized, spec 2026-07-03-e6-workload-parameterized-sandbox-load):
#  Phase 1 — N-vs-workload curve: per-leaf sandbox duty at C=1 on a WARM pod (exec-timing delta
#    per leaf, median of E6_SAMPLES) across real code-review variants L0/L1/L2 -> N = 1/duty as a
#    function of per-leaf sandbox work. This is confound-free (one leaf, no concurrency).
#  Phase 2 — concurrency sweep at the HEAVIEST variant (L2) with the harness UN-CAPPED
#    (max-scale raised so the sandbox, not the 5-pod harness cap, limits concurrency), warm,
#    multi-sampled, fed to the sustained-decline detectKnee. Knee reported as a floor.
# Gated by E6_LIVE=1. Records to EXPERIMENTS.md.
# Usage: E6_LIVE=1 [E6_SAMPLES=3] [E6_SWEEP_MAX_SCALE=20] bash deploy/knative/e6-saturation.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091  # lib.sh is co-located; not available to shellcheck at lint time
source ./lib.sh

[ "${E6_LIVE:-0}" = "1" ] || { echo "SKIP (set E6_LIVE=1)"; exit 0; }
# Restore ksvc env + scale on ANY exit; installed AFTER the gate so a SKIP run never touches the cluster.
trap 'restore_ksvc_env' EXIT

SAMPLES="${E6_SAMPLES:-3}"
LADDER="${E6_LADDER:-1 2 4 8 16}"
DEGRADE_X="${E6_DEGRADE_X:-2}"
MIN_C="${E6_MIN_CONCURRENCY:-4}"
SWEEP_MAX="${E6_SWEEP_MAX_SCALE:-20}"
PIN="${KAGENTI_SANDBOX_POD:-sandbox-0}"
WREF="work"
# Archetype-A code-review variants of increasing review scope: "label:file:pattern".
VARIANTS=("L0:small.py:password" "L1:medium.py:eval(" "L2:large.py:eval(")

echo "--- E6: workload curve + un-capped sweep (samples=$SAMPLES pin=$PIN sweepMax=$SWEEP_MAX) ---"
ensure_port_forward >/dev/null || true
wait_gitd 120 || { echo "gitd not ready"; exit 1; }

# Pin one sandbox, disable pool routing, enable exec timing; warm exactly one harness pod (min=max=1)
# so C=1 has no cold start and a single stable pod owns the [exec-timing] log across samples.
set_ksvc_env KAGENTI_SANDBOX_POD="$PIN" KAGENTI_SANDBOX_POOL_SELECTOR- KAGENTI_EXEC_TIMING=1 KAGENTI_SANDBOX_CAP=1000
set_scale 1 1

harness_pod() {
  kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | awk 'NR==1{print $1}'
}

# --- Phase 1: N-vs-workload curve (C=1, warm, exec-timing DELTA per leaf, median of SAMPLES) ---
CURVE_IN="[]"
for v in "${VARIANTS[@]}"; do
  IFS=: read -r label file pat <<<"$v"
  ms_s=""; cnt_s=""; wall_s=""
  for _ in $(seq 1 "$SAMPLES"); do
    pod="$(harness_pod)"
    before_ms="$(sum_exec_ms "$pod")"; before_cnt="$(count_exec_lines "$pod")"
    t0=$(now_ms)
    dispatch_converge "e6-$label-$RANDOM-$$" "$label" "$file" "$pat" "$WREF" >/dev/null 2>&1 || true
    wall=$(( $(now_ms) - t0 ))
    after_ms="$(sum_exec_ms "$pod")"; after_cnt="$(count_exec_lines "$pod")"
    ms_s="$ms_s$(( after_ms - before_ms ))
"; cnt_s="$cnt_s$(( after_cnt - before_cnt ))
"; wall_s="$wall_s$wall
"
  done
  medMs=$(printf '%s' "$ms_s"   | grep -v '^$' | median)
  medCnt=$(printf '%s' "$cnt_s" | grep -v '^$' | median)
  medWall=$(printf '%s' "$wall_s" | grep -v '^$' | median); [ "$medWall" -lt 1 ] && medWall=1
  echo "  $label file=$file execCount=$medCnt execMs=$medMs wallMs=$medWall"
  CURVE_IN=$(jq -c --arg l "$label" --argjson m "$medMs" --argjson c "$medCnt" --argjson w "$medWall" \
    '. + [{label:$l, execMs:$m, execCount:$c, wallMs:$w}]' <<<"$CURVE_IN")
done

# shellcheck disable=SC2016  # single-quoted TypeScript literal, not bash expansion
CURVE=$(npx tsx -e '
  import { buildRatioCurve } from "../../experiments/src/sharing.ts";
  process.stdout.write(JSON.stringify(buildRatioCurve(JSON.parse(process.argv[1]))));
' "$CURVE_IN")
echo "  RATIO_CURVE=$CURVE"

# --- Phase 2: concurrency sweep at L2 (heaviest), harness UN-CAPPED + warm ---
IFS=: read -r hl hf hp <<<"${VARIANTS[2]}"
set_scale 1 "$SWEEP_MAX"

run_rung() {  # $1=c ; echoes "<medianThroughput> <medianP95>"
  local c="$1" thr_s="" p95_s="" i pids d t0 wall
  for _ in $(seq 1 "$SAMPLES"); do
    d="$(mktemp -d)"; pids=""; i=0; t0=$(now_ms)
    while [ "$i" -lt "$c" ]; do
      ( ts=$(now_ms); dispatch_converge "e6sw-$c-$RANDOM-$i-$$" "$hl" "$hf" "$hp" "$WREF" >/dev/null 2>&1 || true
        echo $(( $(now_ms) - ts )) > "$d/$i.ms" ) & pids="$pids $!"
      i=$((i + 1))
    done
    # shellcheck disable=SC2086
    wait $pids
    wall=$(( $(now_ms) - t0 )); [ "$wall" -lt 1 ] && wall=1
    thr_s="$thr_s$(awk -v c="$c" -v w="$wall" 'BEGIN{printf "%.3f", c/(w/1000.0)}')
"
    if ls "$d"/*.ms >/dev/null 2>&1; then
      p95_s="$p95_s$(cat "$d"/*.ms | sort -n | awk '{a[NR]=$1} END{printf "%d", a[int(NR*0.95+0.999)]?a[int(NR*0.95+0.999)]:a[NR]}')
"
    else p95_s="${p95_s}999999
"; fi
    rm -rf "$d"
  done
  # median throughput is a float; median() is integer-only, so pick the middle sorted float via awk.
  local mthr mp95
  mthr=$(printf '%s' "$thr_s" | grep -v '^$' | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[(NR+1)/2]:a[NR/2]}')
  mp95=$(printf '%s' "$p95_s" | grep -v '^$' | median)
  echo "$mthr $mp95"
}

POINTS="[]"
for c in $LADDER; do
  read -r thr p95 <<<"$(run_rung "$c")"
  echo "  sweep c=$c throughput=$thr p95Ms=$p95"
  POINTS=$(jq -c --argjson c "$c" --argjson t "$thr" --argjson p "$p95" \
    '. + [{c:$c, throughput:$t, p95Ms:$p}]' <<<"$POINTS")
done

# shellcheck disable=SC2016
read -r KNEE FLOOR <<<"$(npx tsx -e '
  import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
  const pts = JSON.parse(process.argv[1]);
  const knee = detectKnee(pts, Number(process.argv[2]));
  process.stdout.write(`${knee} ${sanityFloorPass(knee, Number(process.argv[3]))}`);
' "$POINTS" "$DEGRADE_X" "$MIN_C")"
echo "  knee(CAP floor)=$KNEE floorPass=$FLOOR maxScale=$SWEEP_MAX"

echo "E6_RESULT ratioCurve=$CURVE knee=$KNEE floorPass=$FLOOR maxScale=$SWEEP_MAX pass=$([ "$FAIL" = 0 ] && echo yes || echo no)"
{
  echo ""
  echo "### E6 run $(hostname 2>/dev/null || echo host)"
  echo "- N-vs-workload curve (C=1, samples=$SAMPLES): $CURVE"
  echo "- sweep points (L2 '$hf', max-scale=$SWEEP_MAX): $POINTS"
  echo "- knee floor: $KNEE (floorPass=$FLOOR)"
} >> EXPERIMENTS.md

[ "$FAIL" = 0 ] || exit 1
```

- [ ] **Step 2: Lint**

Run: `shellcheck -x deploy/knative/e6-saturation.sh > /tmp/sh/shellcheck-e6.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0` (scoped `# shellcheck disable=` comments are already inline for the known SC1091/SC2016/SC2086 cases).

- [ ] **Step 3: Gate no-op check**

Run: `bash deploy/knative/e6-saturation.sh; echo "EXIT:$?"`
Expected: prints `SKIP (set E6_LIVE=1)` and `EXIT:0`, contacting no cluster (the trap is installed after the gate, so nothing is restored on the SKIP path).

- [ ] **Step 4: Prove the tsx calls resolve** (deterministic, no cluster)

Run:
```
cd deploy/knative && npx tsx -e 'import { buildRatioCurve, detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts"; console.log(typeof buildRatioCurve, typeof detectKnee, typeof sanityFloorPass)' 2>&1 | tail -2; echo "EXIT:${PIPESTATUS[0]}"
```
Expected: `function function function` and `EXIT:0`.

- [ ] **Step 5: Commit**

```bash
git add deploy/knative/e6-saturation.sh
git commit -s -m "feat: Rewrite E6 driver — N-vs-workload curve + un-capped noise-robust sweep

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 6: EXPERIMENTS.md headline update

**Files:**
- Modify: `deploy/knative/EXPERIMENTS.md`

- [ ] **Step 1: Update the E6 subsection + supersede note.** In `deploy/knative/EXPERIMENTS.md`, replace the `## E6 — saturation curve (→ CAP + derived N)` subsection body (the descriptive paragraph under that heading, not the recorded run blocks) with:

```markdown
## E6 — sandbox-load characterization (N-vs-workload curve + knee floor)

Reports the harness→sandbox sharing ratio **N as a curve over per-leaf sandbox work**, measured at
C=1 on a warm pod across real Archetype-A code-review variants L0/L1/L2 (increasing review scope over
the git-daemon `work` fixtures), each point tagged with the leaf's measured sandbox exec count. N is
workload-dependent: the light L0 leaf is a near-empty-leaf **upper bound**; heavier leaves drive more
sandbox execs → higher duty → lower N. A separate concurrency sweep at the heaviest variant, with the
harness un-capped (`max-scale` raised so the sandbox — not the 5-pod harness cap — limits
concurrency), warm and multi-sampled, feeds the sustained-decline `detectKnee`; the knee is reported
as a floor. **Supersedes** the earlier single-N figure (N ≈ 29–48:1), which was the L0 (near-empty-leaf)
upper bound measured with a trivial `marker.txt` leaf.
```

- [ ] **Step 2: Commit**

```bash
git add deploy/knative/EXPERIMENTS.md
git commit -s -m "docs: Reframe E6 results as N-vs-workload curve (supersede single-N)

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 7: Gated live re-run (Kind → OCP) + record + PR

Not a CI task — runs the new E6 on real clusters and records the curve. Both clusters have the P3 stack standing; the git-daemon needs re-applying to pick up the `work` ref.

- [ ] **Step 1: Kind — refresh gitd, rebuild harness image, run E6 + E7**

```bash
kubectl config use-context kind-sh-knative
kubectl apply -f deploy/knative/gitd.yaml && kubectl rollout restart deploy/gitd && kubectl rollout status deploy/gitd --timeout=120s
# rebuild harness image with the current branch (exec-timing hook is already in main, but rebuild to be safe) — or reuse if unchanged
# verify work ref serves the fixtures:
kubectl exec sandbox-0 -- git ls-remote git://gitd.default.svc:9418/repo.git | grep -c 'refs/heads/work'   # expect 1
mkdir -p /tmp/sh/live
E6_LIVE=1 bash deploy/knative/e6-saturation.sh > /tmp/sh/live/e6-kind.log 2>&1; echo "E6:$?"
E7_LIVE=1 bash deploy/knative/e7-converge-contention.sh > /tmp/sh/live/e7-kind.log 2>&1; echo "E7:$?"
```
Expected: `work` ref present; `E6:0`; `E7:0`. Dispatch a subagent to extract `RATIO_CURVE`/`E6_RESULT`/`E7_RESULT` and any `FAIL` from the logs (do not read full logs inline). Confirm the curve shows increasing `execCount` and decreasing N from L0→L2.

- [ ] **Step 2: OCP — refresh gitd, run authoritative E6 + E7**

```bash
export KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig
kubectl apply -f deploy/knative/gitd.yaml && kubectl rollout restart deploy/gitd -n default && kubectl rollout status deploy/gitd -n default --timeout=180s
kubectl exec sandbox-0 -n default -- git ls-remote git://gitd.default.svc:9418/repo.git | grep -c 'refs/heads/work'   # expect 1
export KSVC_URL="https://serverless-harness-default.apps.rosso1.kubestellar.org"
E6_LIVE=1 bash deploy/knative/e6-saturation.sh > /tmp/sh/live/e6-ocp.log 2>&1; echo "E6:$?"
E7_LIVE=1 bash deploy/knative/e7-converge-contention.sh > /tmp/sh/live/e7-ocp.log 2>&1; echo "E7:$?"
```
Expected: `E6:0`, `E7:0`; a clean N-vs-workload curve (L0 high N → L2 lower N) and a stable knee floor (no single-dip collapse). Analyze via subagent. If `/runs` errors with "Connection error", re-provision `llm-credentials` api-key-only.

- [ ] **Step 2b: If OCP results already appended cleanly to `deploy/knative/EXPERIMENTS.md`,** trim to the authoritative OCP run + a one-line takeaway (the curve + the knee floor). Then commit:

```bash
git add deploy/knative/EXPERIMENTS.md
git commit -s -m "docs: Record E6 N-vs-workload curve (Kind + authoritative OCP)

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/e6-workload-parameterization
gh pr create --base main --head feat/e6-workload-parameterization \
  --title "P3.1: E6 workload-parameterized sandbox-load (N-vs-workload curve, #62)" \
  --body "$(cat <<'EOF'
Hardens P3's E6 (spec `docs/specs/2026-07-03-e6-workload-parameterized-sandbox-load-design.md`), resolving #62 and the workload-realism gap.

- Real Archetype-A code-review variants L0/L1/L2 (git-daemon `work` fixtures) replace the trivial marker check.
- N reported as a **curve over per-leaf sandbox work** (measured at C=1, warm, multi-sampled), each point tagged with exec count — supersedes the single optimistic N.
- Concurrency sweep un-caps the harness (`max-scale`) so the sandbox is the limiter; warm + multi-sample + sustained-decline `detectKnee` remove the noise/max-scale confounds.
- Live-verified on Kind + OCP.

Assisted-By: Claude Code
EOF
)"
```
Then the user merges. Report the PR number and the recorded curve.

---

## Self-Review

**1. Spec coverage:**

| Spec item | Task |
|-----------|------|
| §2 D1 N-vs-workload curve at C=1 | Task 1 (`buildRatioCurve`) + Task 5 Phase 1 |
| §2 D2 / §3 L0/L1/L2 real code-review variants | Task 3 (fixtures) + Task 5 `VARIANTS` |
| §4 instrumentation (exec count/ms/wall, warm, median) | Task 4 (`count_exec_lines`/`median`) + Task 5 Phase 1 (delta, warm min=max=1) |
| §5 `buildRatioCurve` | Task 1 |
| §5 sustained-decline `detectKnee` (`patience`) | Task 2 |
| §6 raise max-scale / warm / multi-sample / heaviest variant | Task 4 (`set_scale`) + Task 5 Phase 2 |
| §6 restore scale on exit | Task 4 (`restore_ksvc_env` extended) |
| §6 E7 unchanged, marker refs kept | honored (Task 3 leaves `branch-*`; E7 untouched) |
| §7 EXPERIMENTS.md headline = curve, supersede note | Task 6 + Task 7 Step 2b |
| §8 unit + integration + gated live | Tasks 1/2 (unit) + Task 7 (live) |
| §10 README registration | already committed (`b53dfdd`) |

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to Task N". Every code step shows complete code. Fixture sizes (40/120 lines) are concrete.

**3. Type consistency:** `WorkloadPoint{label,execMs,execCount,wallMs}` (Task 1) is exactly what Task 5 Phase 1 builds into `CURVE_IN` and feeds to `buildRatioCurve`. `LadderPoint{c,throughput,p95Ms}` (existing) is what Task 5 Phase 2 builds into `POINTS` and feeds to `detectKnee(points, degradeX, patience?)` (Task 2). `set_scale <min> <max>`, `count_exec_lines <pod>`, `median` (Task 4) are called with those signatures in Task 5. `dispatch_converge <sid> <item_id> <file> <pattern> <ref>` matches the existing lib.sh helper. tsx path `../../experiments/src/sharing.ts` consistent with CWD `deploy/knative/`.

**Deviation flagged:** Task 5 drops P3's old "feed-back check" (pool spread at derived CAP) — the new sweep pins one sandbox with a raised max-scale (not pool mode), per spec §6, which does not carry the feed-back check forward. If a reviewer wants pool-spread re-verified, that belongs in a separate pool test, not this workload-characterization driver.
