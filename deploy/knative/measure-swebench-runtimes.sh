#!/usr/bin/env bash
# deploy/knative/measure-swebench-runtimes.sh
# Plan B Task 5: measure each SWE-bench deck instance's gold-test wall-clock inside a live
# `swebench` sandbox pool pod, then write test_runtime_ms + weight_bucket (terciles) back into
# experiments/swebench/deck.json. OCP-only (the baked sandbox image is x86_64 and lives only in
# the OCP internal registry -- see deploy/knative/build-swebench-sandbox.sh). Gated by
# MEASURE_LIVE=1 (default: print usage and exit 0, like the sibling *-smoke.sh / e*-*.sh drivers).
#
# Forced per-instance mechanism (from the live spike -- do not deviate):
#   1. git clone --no-hardlinks (NOT --local: /repos is a different filesystem from /workspace,
#      so hardlinking objects fails cross-device; NOT worktree -- worktree-from-baked-mirror fails
#      as uid 65532, /repos is read-only root-owned) the baked bare mirror at /repos/<repo>.git
#      into a scratch checkout, then checkout base_commit.
#   2. A per-instance venv --system-site-packages over the baked conda env
#      (/opt/miniconda3/envs/<env_dir>, env_dir = env_key with the trailing ":latest" tag
#      stripped, dots kept).
#   3. HOME=/workspace pip install -e <checkout> --no-build-isolation --no-cache-dir (the baked
#      env has the repo's deps but not the repo package itself; the venv inherits deps via
#      --system-site-packages; HOME=/workspace because / is unwritable as uid 65532).
#   4. Run + time `<test_cmd> <directives...>` under `timeout` (default 20 min), CWD = checkout
#      root, PATH prefixed with the venv then the baked env. The test's own stdout/stderr goes to
#      /dev/null on the pod -- we only want the wall-clock, not the output.
#
# CRITICAL exit-code semantics: at base_commit the FAIL_TO_PASS tests fail BY DEFINITION (they
# only pass once the real fix lands), so the gold-test command exits non-zero for essentially
# every instance. That non-zero exit is EXPECTED and is NOT a validity signal -- the measured
# wall-clock is still recorded. Only two outcomes are NOT a plain "ran":
#   - timeout (`timeout` returns 124): hit the cap. Record the cap (MEASURE_TIMEOUT_SEC * 1000 ms)
#     as a lower-bound estimate so the instance lands in the heavy bucket -- never null it.
#   - setup failure (clone / checkout / venv / pip install returned non-zero, so the test itself
#     never ran): record test_runtime_ms = null; excluded from the tercile computation.
#
# Usage:
#   MEASURE_LIVE=1 [NS=default] \
#     [KAGENTI_SANDBOX_POOL_SELECTOR=sh.kagenti.io/sandbox-pool=swebench] [MEASURE_SAMPLES=1] \
#     [MEASURE_TIMEOUT_SEC=1200] [MEASURE_LIMIT=0] [DECK=experiments/swebench/deck.json] \
#     [LOG_DIR=/tmp/kagenti/planB] bash deploy/knative/measure-swebench-runtimes.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091  # lib.sh is co-located; not resolvable at lint time in isolation
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
measure-swebench-runtimes.sh -- SWE-bench gold-test runtime measurement driver (Plan B Task 5).

Gated by MEASURE_LIVE=1 (this run is a no-op without it). Needs an OCP cluster with the swebench
sandbox pool deployed (deploy/knative/swebench-sandbox-pool.yaml) and reachable via kubectl.

  MEASURE_LIVE=1                       required to actually run
  NS                                    namespace (default: default)
  KAGENTI_SANDBOX_POOL_SELECTOR         pool pod selector (default: sh.kagenti.io/sandbox-pool=swebench)
  MEASURE_SAMPLES                       samples per instance, median-of-N (default: 1)
  MEASURE_TIMEOUT_SEC                   per-run timeout in seconds (default: 1200 = 20 min)
  MEASURE_LIMIT                         cap on number of instances measured, 0 = no limit (default: 0)
  DECK                                  path to deck.json (default: experiments/swebench/deck.json)
  LOG_DIR                               per-instance pod transcripts (default: /tmp/kagenti/planB)

Measures SEQUENTIALLY in one pool pod (isolated + quiet -> clean timing). Writes test_runtime_ms
and weight_bucket (tercile: light/medium/heavy) back into DECK. Re-runnable: overwrites both
fields for every instance it measures; leaves unmeasured instances (beyond MEASURE_LIMIT) as-is.
EOF
}

[ "${MEASURE_LIVE:-0}" = "1" ] || { usage; exit 0; }

NS="${NS:-default}"
KAGENTI_SANDBOX_POOL_SELECTOR="${KAGENTI_SANDBOX_POOL_SELECTOR:-sh.kagenti.io/sandbox-pool=swebench}"
MEASURE_SAMPLES="${MEASURE_SAMPLES:-1}"
MEASURE_TIMEOUT_SEC="${MEASURE_TIMEOUT_SEC:-1200}"
MEASURE_LIMIT="${MEASURE_LIMIT:-0}"
DECK="${DECK:-$REPO_ROOT/experiments/swebench/deck.json}"
LOG_DIR="${LOG_DIR:-/tmp/kagenti/planB}"
mkdir -p "$LOG_DIR"

[ -f "$DECK" ] || { echo "FAIL: deck not found: $DECK" >&2; exit 1; }

echo "--- measure-swebench-runtimes: pool=$KAGENTI_SANDBOX_POOL_SELECTOR ns=$NS samples=$MEASURE_SAMPLES timeout=${MEASURE_TIMEOUT_SEC}s deck=$DECK ---"

POD="$(kubectl -n "$NS" get pod -l "$KAGENTI_SANDBOX_POOL_SELECTOR" \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[ -n "$POD" ] || { echo "FAIL: no Running pod matching -l $KAGENTI_SANDBOX_POOL_SELECTOR in ns $NS" >&2; exit 1; }
echo "pod=$POD"

# Single-quote a string for safe embedding as one shell word in the pod-side script. This alone
# defeats glob expansion of directive ids that contain "[param]" brackets even before the pod
# script's own `set -f` runs -- belt-and-braces, per the brief's quoting requirement.
qq() {
  local s=$1
  printf "'%s'" "${s//\'/\'\\\'\'}"
}

MANIFEST="$(mktemp "${LOG_DIR}/manifest.XXXXXX")"
RESULTS="$(mktemp "${LOG_DIR}/results.XXXXXX")"
trap 'rm -f "$MANIFEST" "$RESULTS"' EXIT

# Manifest: one line per instance, tab-separated: instance_id, repo, base_commit, env_key,
# test_cmd, base64(json array of test_directives). Built host-side in python3 (proper JSON
# parsing -- bash has no JSON support and deck.json fields can contain arbitrary text).
python3 - "$DECK" "$MEASURE_LIMIT" >"$MANIFEST" <<'PY'
import base64
import json
import sys

deck_path, limit = sys.argv[1], int(sys.argv[2])
with open(deck_path) as f:
    deck = json.load(f)
instances = deck["instances"]
if limit > 0:
    instances = instances[:limit]
for inst in instances:
    directives_b64 = base64.b64encode(json.dumps(inst["test_directives"]).encode()).decode()
    print(
        "\t".join(
            [
                inst["instance_id"],
                inst["repo"],
                inst["base_commit"],
                inst["env_key"],
                inst["test_cmd"],
                directives_b64,
            ]
        )
    )
PY

TOTAL=$(wc -l <"$MANIFEST" | tr -d ' ')
echo "instances to measure: $TOTAL"

N_RAN=0
N_TIMEOUT=0
N_SETUPFAIL=0
IDX=0

while IFS=$'\t' read -r instance_id repo base_commit env_key test_cmd directives_b64; do
  IDX=$((IDX + 1))
  # env_dir: env_key with the trailing ":latest" tag stripped (dots kept).
  env_dir="${env_key%:latest}"

  mapfile -t directives < <(python3 -c '
import base64, json, sys
for d in json.loads(base64.b64decode(sys.argv[1])):
    print(d)
' "$directives_b64")

  # Build the test invocation: test_cmd is spliced VERBATIM (unquoted, un-tokenized) so that
  # inline shell syntax such as sympy's `PYTHONWARNINGS='...' bin/test -C --verbose` env-var
  # prefix is parsed by the pod shell as intended, rather than being word-split and re-quoted
  # into a bogus argv[0]. Only each directive (a file/node path that may contain "[param]"
  # globs) is individually single-quoted via qq() so it can never be re-interpreted as a glob
  # or option boundary.
  cmd_line="$test_cmd"
  for d in "${directives[@]+"${directives[@]}"}"; do
    cmd_line="$cmd_line $(qq "$d")"
  done

  co="/workspace/co-${instance_id}"
  venv="/workspace/venv-${instance_id}"
  pod_log="${LOG_DIR}/${instance_id}.pod.log"
  : >"$pod_log"

  sample_mss=()
  sample_status="setupfail"
  for _ in $(seq 1 "$MEASURE_SAMPLES"); do
    # NOTE: inside this heredoc, ${...} tokens are host-expanded (repo, base_commit, env_dir,
    # instance_id, cmd_line, MEASURE_TIMEOUT_SEC -- all known on the host); \$-escaped tokens
    # (\$CO, \$VENV, \$ENV_PY, \$RC, \$PATH, \$( date ... ), \$((END - START))) are pod-side and
    # must only be evaluated once this text is executed as a script inside the pod. A pod-side
    # `trap ... EXIT` guarantees the checkout+venv are removed on every exit path (setup failure,
    # timeout, or normal completion) without duplicating the rm -rf in each branch.
    pod_script="$(cat <<PODEOF
set -u
CO="${co}"
VENV="${venv}"
ENV_PY="/opt/miniconda3/envs/${env_dir}/bin/python"
rm -rf "\$CO" "\$VENV"
trap 'rm -rf "\$CO" "\$VENV"' EXIT
if ! git clone --no-hardlinks "/repos/${repo}.git" "\$CO"; then
  echo "RESULT ${instance_id} setupfail NA"
  exit 0
fi
if ! git -C "\$CO" checkout -q "${base_commit}"; then
  echo "RESULT ${instance_id} setupfail NA"
  exit 0
fi
if ! "\$ENV_PY" -m venv --system-site-packages "\$VENV"; then
  echo "RESULT ${instance_id} setupfail NA"
  exit 0
fi
if ! HOME=/workspace "\$VENV/bin/pip" install -e "\$CO" --no-build-isolation --no-cache-dir; then
  if ! HOME=/workspace "\$VENV/bin/pip" install -e "\$CO" --no-cache-dir; then
    echo "RESULT ${instance_id} setupfail NA"
    exit 0
  fi
fi
export PATH="\$VENV/bin:/opt/miniconda3/envs/${env_dir}/bin:\$PATH"
cd "\$CO"
set -f
START=\$(date +%s%3N)
timeout ${MEASURE_TIMEOUT_SEC} bash -c $(qq "set -f; ${cmd_line}") >/dev/null 2>&1
RC=\$?
END=\$(date +%s%3N)
set +f
if [ "\$RC" -eq 124 ]; then
  echo "RESULT ${instance_id} timeout $((MEASURE_TIMEOUT_SEC * 1000))"
else
  echo "RESULT ${instance_id} ran \$((END - START))"
fi
PODEOF
)"

    out="$(kubectl -n "$NS" exec -i "$POD" -c sandbox -- bash -s <<<"$pod_script" 2>&1 || true)"
    printf '%s\n' "$out" >>"$pod_log"

    line="$(printf '%s\n' "$out" | grep '^RESULT ' | tail -n1 || true)"
    read -r _ _ status ms <<<"${line:-}"
    if [ "${status:-}" = "ran" ] || [ "${status:-}" = "timeout" ]; then
      sample_status="$status"
      sample_mss+=("$ms")
    fi
  done

  if [ "${#sample_mss[@]}" -eq 0 ]; then
    ms_final="NA"
    N_SETUPFAIL=$((N_SETUPFAIL + 1))
    echo "[$IDX/$TOTAL] ${instance_id} ${repo} setupfail (see ${pod_log})"
  else
    ms_final="$(printf '%s\n' "${sample_mss[@]}" | median)"
    if [ "$sample_status" = "timeout" ]; then
      N_TIMEOUT=$((N_TIMEOUT + 1))
    else
      N_RAN=$((N_RAN + 1))
    fi
    echo "[$IDX/$TOTAL] ${instance_id} ${repo} ms=${ms_final} (${sample_status})"
  fi

  printf '%s\t%s\n' "$instance_id" "$ms_final" >>"$RESULTS"
done <"$MANIFEST"

echo "--- writing test_runtime_ms + weight_bucket into $DECK ---"
python3 - "$DECK" "$RESULTS" <<'PY'
import json
import sys

deck_path, results_path = sys.argv[1], sys.argv[2]

runtimes = {}
with open(results_path) as f:
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        instance_id, ms = line.split("\t")
        runtimes[instance_id] = None if ms == "NA" else int(ms)

with open(deck_path) as f:
    deck = json.load(f)

for inst in deck["instances"]:
    if inst["instance_id"] in runtimes:
        inst["test_runtime_ms"] = runtimes[inst["instance_id"]]

# Terciles over ALL instances in the deck with non-null test_runtime_ms (timeouts included, at
# their cap value; not just the ones measured this run -- a re-run with MEASURE_LIMIT set should
# not wipe buckets for instances measured in a prior run). Deterministic: sort ascending by ms,
# split by RANK into 3 as-equal-as-possible groups (rank * 3 // n -> 0/1/2 -> light/medium/heavy).
# Instances with a null runtime keep weight_bucket = null.
timed = sorted(
    (inst for inst in deck["instances"] if inst["test_runtime_ms"] is not None),
    key=lambda inst: inst["test_runtime_ms"],
)
n = len(timed)
labels = ["light", "medium", "heavy"]
for rank, inst in enumerate(timed):
    inst["weight_bucket"] = labels[rank * 3 // n]
for inst in deck["instances"]:
    if inst["test_runtime_ms"] is None:
        inst["weight_bucket"] = None

with open(deck_path, "w") as f:
    f.write(json.dumps(deck, indent=2) + "\n")

buckets = {"light": 0, "medium": 0, "heavy": 0}
nulls = 0
for inst in deck["instances"]:
    if inst["weight_bucket"] is None:
        nulls += 1
    else:
        buckets[inst["weight_bucket"]] += 1
print(f"buckets: light={buckets['light']} medium={buckets['medium']} heavy={buckets['heavy']} null={nulls}")
PY

echo "--- summary: ran=$N_RAN timeout=$N_TIMEOUT setupfail=$N_SETUPFAIL total=$TOTAL ---"
