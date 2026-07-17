#!/usr/bin/env bash
# Plan D — Stage 2: offline SWE-bench evaluator.  Scores captured predictions.jsonl -> resolved-rate.
#
# MODEL-FREE and CLUSTER-FREE: it applies each captured `model_patch` to the repo at base_commit
# and runs the gold FAIL_TO_PASS / PASS_TO_PASS tests inside the official per-instance Docker
# container, then reports how many bugs the patches actually fixed. No LLM, no OpenShift, no Knative.
#
# arm64 note: the official eval images are published x86_64-only (swebench/sweb.eval.x86_64.<id>).
# We pull those prebuilt images via `--namespace swebench` (no local build) and run them under
# Docker's amd64 emulation (DOCKER_DEFAULT_PLATFORM=linux/amd64). All instances in the captured
# deck are pure-python, so emulated test runs are correct (just slower); C-extension repos would
# need a native x86 host.
#
# Env knobs: RUN_ID, DATASET, MAX_WORKERS, INSTANCE_IDS (space-separated subset for a smoke),
#            PRED_A / PRED_B (input prediction files), LOG_DIR, VENV.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

LOG_DIR="${LOG_DIR:-/tmp/kagenti/planD}"; mkdir -p "$LOG_DIR"
VENV="${VENV:-$LOG_DIR/.venv-swebench}"
RUN_ID="${RUN_ID:-haiku-baseline}"
DATASET="${DATASET:-princeton-nlp/SWE-bench_Verified}"
MAX_WORKERS="${MAX_WORKERS:-2}"          # emulated x86 is slow -> keep concurrency low
PRED_A="${PRED_A:-/tmp/kagenti/planC/authrun/predictions.jsonl}"
PRED_B="${PRED_B:-/tmp/kagenti/planC/authrun/predictions-e1.jsonl}"
MERGED="${MERGED:-$LOG_DIR/predictions-merged.jsonl}"

echo "[evaluate] run_id=$RUN_ID dataset=$DATASET workers=$MAX_WORKERS log_dir=$LOG_DIR"

# 1. tooling: venv + official swebench harness
if [ ! -x "$VENV/bin/python" ]; then
  echo "[evaluate] creating venv $VENV"
  python3 -m venv "$VENV"
fi
if "$VENV/bin/pip" install -q --upgrade pip swebench >"$LOG_DIR/pip.log" 2>&1; then
  echo "[evaluate] swebench installed ($("$VENV/bin/python" -c 'import swebench; print(swebench.__version__)' 2>/dev/null || echo '?'))"
else
  echo "[evaluate] pip install FAILED (see $LOG_DIR/pip.log)"; exit 1
fi

# 2. merge + dedup captured predictions into one official-shape file
"$VENV/bin/python" "$SCRIPT_DIR/merge_predictions.py" "$MERGED" "$PRED_A" "$PRED_B"

# 3. docker must be up; use amd64 emulation for the x86 eval images
docker info >/dev/null 2>&1 || { echo "[evaluate] Docker daemon not running"; exit 1; }
export DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-linux/amd64}"
echo "[evaluate] DOCKER_DEFAULT_PLATFORM=$DOCKER_DEFAULT_PLATFORM"

# optional subset (smoke)
IID_ARGS=()
if [ -n "${INSTANCE_IDS:-}" ]; then
  # shellcheck disable=SC2206
  IID_ARGS=(--instance_ids ${INSTANCE_IDS})
  echo "[evaluate] subset: $INSTANCE_IDS"
fi

# 4. run the official evaluator from LOG_DIR so its report + logs/ land there (not in the repo)
echo "[evaluate] running swebench.harness.run_evaluation -> $LOG_DIR/eval-$RUN_ID.log"
( cd "$LOG_DIR" && "$VENV/bin/python" -m swebench.harness.run_evaluation \
    --dataset_name "$DATASET" \
    --predictions_path "$MERGED" \
    --run_id "$RUN_ID" \
    --namespace swebench \
    --max_workers "$MAX_WORKERS" \
    "${IID_ARGS[@]}" ) >"$LOG_DIR/eval-$RUN_ID.log" 2>&1
echo "EVAL_EXIT:$? (full log: $LOG_DIR/eval-$RUN_ID.log)"

# 5. summarize
"$VENV/bin/python" "$SCRIPT_DIR/summarize_report.py" "$RUN_ID" "$LOG_DIR"
