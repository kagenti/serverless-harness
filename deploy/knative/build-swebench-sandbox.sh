#!/usr/bin/env bash
# deploy/knative/build-swebench-sandbox.sh
#
# Emits (and, in a follow-up live gate, drives the OCP build of) the baked
# SWE-bench sandbox image: one conda env per selected env-key plus bare repo
# mirrors, assembled into a single sandbox image.
#
# SWE-bench publishes ONLY per-instance eval images (no per-env images) — see
# docs/notes/swebench-image-facts.md. So instead of `FROM <env-image>`, each
# generated stage pulls that env-key's REPRESENTATIVE per-instance image
# (bake-list.json envs[].instance_image_key) and `conda create --clone`s the
# shared `testbed` conda env to an env-key-derived name at the same
# /opt/miniconda3 base; the assembled stage COPYs each cloned env to the exact
# same path so the envs coexist side by side. (An earlier conda-pack/unpack
# approach was abandoned: it shipped a corrupt numpy for mixed conda+pip envs
# — matplotlib/sklearn numpy import failed — per the Task-3b verify gate.)
#
# This script is offline/pure in --emit mode: it only reads the committed
# experiments/swebench/bake-list.json and prints a Dockerfile to stdout. It
# never invokes docker/oc itself — see --build below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BAKE_LIST="$REPO_ROOT/experiments/swebench/bake-list.json"

MODE=""
LIMIT=3
OFFSET=0
BASE=""
# Tri-state base-tools: "" = auto (on iff --base is unset, i.e. the ubuntu
# default), "1" = force on, "0" = force off. Auto keeps `--emit --limit 3`
# byte-identical to the pre-batch output while letting later batches (whose
# base is our prior image, which already has the tools) skip them.
BASE_TOOLS=""

usage() {
  cat <<'EOF'
Usage:
  build-swebench-sandbox.sh --emit      [--limit N] [--offset M] [--base IMG] [--base-tools|--no-base-tools]
  build-swebench-sandbox.sh --print-tag [--limit N] [--offset M]
  build-swebench-sandbox.sh --build ...   (Task 3b live gate; NOT implemented here)

  --emit           Print the generated multi-stage Dockerfile to stdout. Pure,
                   offline: reads only bake-list.json, invokes no docker/oc.
  --print-tag      Print the slice image tag "<deckHash>-<M+selected>of<total>"
                   (deckHash and total from bake-list.json). The build driver
                   uses this to patch the BuildConfig output tag so it always
                   matches the cumulative coverage after this batch.
  --limit N        Batch size: select N env-keys from the sorted-by-env_key list.
                   Default: 3.
  --offset M       Start the slice at index M (envs[M:M+N]). Default: 0. Enables
                   iterative accumulation in batches (e.g. 0/5/10 with --limit 5).
  --base IMG       Assembled-stage base image (FROM). Default: ubuntu:22.04.
                   For batches 2+, set this to the prior batch's pushed image so
                   envs accumulate on top of it.
  --base-tools     Force-emit the base tooling (apt-get git ripgrep
                   ca-certificates + git safe.directory). By default the tools
                   are emitted iff --base is unset (ubuntu default); a custom
                   --base is assumed to already carry them.
  --no-base-tools  Force-skip the base tooling even with the default base.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --emit)
      MODE="emit"
      shift
      ;;
    --print-tag)
      MODE="print-tag"
      shift
      ;;
    --build)
      MODE="build"
      shift
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    --offset)
      OFFSET="$2"
      shift 2
      ;;
    --base)
      BASE="$2"
      shift 2
      ;;
    --base-tools)
      BASE_TOOLS="1"
      shift
      ;;
    --no-base-tools)
      BASE_TOOLS="0"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

[ -f "$BAKE_LIST" ] || {
  echo "bake-list not found: $BAKE_LIST" >&2
  exit 1
}

# env_dir <env_key> -> deterministic, directory-safe name.
#
# Rule (applied EVERYWHERE an env-key names a filesystem path below — the
# conda-unpack destination under /opt/miniconda3/envs/ and the per-stage
# tarball name): strip the trailing ":<tag>" suffix (SWE-bench env-keys are
# always tagged ":latest", e.g. "sweb.env.py.x86_64.<hash22>:latest"), then
# replace any remaining "/" or ":" with "-" (belt-and-suspenders; none survive
# the tag-strip for the current bake-list, but this keeps the rule safe if
# that ever changes). Dots are left as-is — they're valid in a directory
# name. Plan C activates an env under this SAME name via
# `source /opt/miniconda3/envs/<env_dir>/bin/activate`.
env_dir() {
  local key="${1%:*}"
  key="${key//\//-}"
  key="${key//:/-}"
  printf '%s' "$key"
}

# slice_tag -> "<deckHash>-<M+selected>of<total>", the single source of truth
# for the image tag. The count is CUMULATIVE coverage after this batch:
# offset M plus the actual number selected in envs[M:M+N] (both capped at
# total), so a tag can never over-claim coverage. The build driver reads this
# to patch the BuildConfig output tag per build (batches → 5of15/10of15/15of15).
slice_tag() {
  local deck_hash total n_selected cumulative
  deck_hash="$(jq -r '.deckHash' "$BAKE_LIST")"
  total="$(jq -r '.envs | length' "$BAKE_LIST")"
  n_selected="$(jq --argjson m "$OFFSET" --argjson n "$LIMIT" \
    '.envs | sort_by(.env_key) | .[$m:$m+$n] | length' "$BAKE_LIST")"
  cumulative=$((OFFSET + n_selected))
  printf '%s-%sof%s' "$deck_hash" "$cumulative" "$total"
}

emit_dockerfile() {
  local deck_hash total selected n_selected cumulative base_image tools_enabled
  deck_hash="$(jq -r '.deckHash' "$BAKE_LIST")"
  total="$(jq -r '.envs | length' "$BAKE_LIST")"
  # Deterministic slice: env-keys sorted lexicographically by env_key, then the
  # window envs[OFFSET : OFFSET+LIMIT] (default OFFSET 0 → the first LIMIT keys).
  selected="$(jq -c --argjson m "$OFFSET" --argjson n "$LIMIT" \
    '.envs | sort_by(.env_key) | .[$m:$m+$n]' "$BAKE_LIST")"
  n_selected="$(jq 'length' <<<"$selected")"
  cumulative=$((OFFSET + n_selected)) # cumulative coverage after this batch

  base_image="${BASE:-ubuntu:22.04}"
  # Resolve tri-state base-tools: explicit wins; else auto = on iff --base unset.
  if [ -n "$BASE_TOOLS" ]; then
    tools_enabled="$BASE_TOOLS"
  elif [ -z "$BASE" ]; then
    tools_enabled=1
  else
    tools_enabled=0
  fi

  cat <<EOF
# syntax=docker/dockerfile:1
# GENERATED by deploy/knative/build-swebench-sandbox.sh --emit --limit ${LIMIT}.
# Do not hand-edit; re-run the emitter to regenerate.
#
# env_dir(env_key) sanitizer rule: strip the trailing ":<tag>" suffix, then
# replace any remaining "/" or ":" with "-" (dots left as-is). Used as the
# cloned conda env name and its /opt/miniconda3/envs/<env_dir> path — see
# env_dir() in this script for the authoritative implementation and rationale.
#
# Deck hash: ${deck_hash}   Slice: ${cumulative}of${total}

# --- BEGIN GENERATED ENV STAGES ---
EOF

  local i=0
  while IFS= read -r row; do
    local image key dir
    image="$(jq -r '.instance_image_key' <<<"$row")"
    key="$(jq -r '.env_key' <<<"$row")"
    dir="$(env_dir "$key")"
    cat <<EOF
FROM ${image} AS env_${i}
# Clone the shared 'testbed' conda env to <env_dir> at the SAME /opt/miniconda3
# base. 'conda create --clone' rewrites prefixes to the new env name in place
# (self-consistent) and copies ALL files faithfully, including pip-installed
# ones. This replaces the earlier conda-pack approach, which shipped a
# corrupt numpy for mixed conda+pip envs (matplotlib/sklearn: numpy import
# failed post-relocation) — see the Task-3b verify gate. No pack/unpack/tar.
RUN /opt/miniconda3/bin/conda create --clone testbed -n ${dir} -y

EOF
    i=$((i + 1))
  done < <(jq -c '.[]' <<<"$selected")
  echo "# --- END GENERATED ENV STAGES ---"
  echo

  # Assembled stage. base_image is ubuntu:22.04 by default, or the prior batch's
  # pushed image for iterative accumulation (batches 2+). USER 0 for the RUN/COPY
  # steps regardless of base; USER 65532 restored at the end.
  printf 'FROM %s AS assembled\n' "$base_image"
  echo "USER 0"
  # Base tooling only for the ubuntu base (batch 1); later batches inherit it
  # from the prior image. Quoted heredoc keeps the backslash continuations and
  # the '*' literal.
  if [ "$tools_enabled" = "1" ]; then
    cat <<'EOF'
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Repos are cloned as root below, but the pod runs as UID 65532; without this
# git refuses to operate on them with 'detected dubious ownership'.
RUN git config --system --add safe.directory '*'
EOF
  fi
  echo
  echo "# --- BEGIN GENERATED ENV COPIES ---"

  i=0
  while IFS= read -r row; do
    local key dir
    key="$(jq -r '.env_key' <<<"$row")"
    dir="$(env_dir "$key")"
    # Copy the cloned env to the EXACT SAME path it was created at in the env
    # stage (/opt/miniconda3/envs/<env_dir>). No relocation: conda clone already
    # wrote correct prefixes for this path, so the env is usable as-is and
    # activatable via 'source /opt/miniconda3/envs/<env_dir>/bin/activate'.
    cat <<EOF
COPY --from=env_${i} /opt/miniconda3/envs/${dir} /opt/miniconda3/envs/${dir}

EOF
    i=$((i + 1))
  done < <(jq -c '.[]' <<<"$selected")
  echo "# --- END GENERATED ENV COPIES ---"
  echo

  echo "# --- BEGIN GENERATED REPO MIRRORS ---"
  local repo
  # Idempotent: a repo can recur across batches, and later batches build FROM a
  # prior image that already has the mirror — skip the clone if it exists.
  while IFS= read -r repo; do
    cat <<EOF
RUN test -d /repos/${repo}.git || git clone --mirror https://github.com/${repo}.git /repos/${repo}.git

EOF
  done < <(jq -r '[.[].repo] | unique | .[]' <<<"$selected")
  echo "# --- END GENERATED REPO MIRRORS ---"
  echo

  # deck-slice is CUMULATIVE coverage after this batch (OFFSET + selected). The
  # final batch writes the highest count, and LABEL last-wins, so the final
  # accumulated image reads <total>of<total>.
  cat <<EOF
LABEL sh.kagenti.io/deck-hash="${deck_hash}"
LABEL sh.kagenti.io/deck-slice="${cumulative}of${total}"
RUN install -d -o 65532 -g 0 /workspace
WORKDIR /workspace
USER 65532
CMD ["sleep","infinity"]
EOF
}

case "$MODE" in
  emit)
    emit_dockerfile
    ;;
  print-tag)
    slice_tag
    echo
    ;;
  build)
    # Task 3b (live gate) is controller-driven, not this script, and is out of
    # scope for Task 3a. Guarded so nothing here ever shells out to docker/oc.
    echo "ERROR: --build is reserved for the Task 3b live build gate and is" >&2
    echo "intentionally not implemented in Task 3a. Use --emit to generate the" >&2
    echo "Dockerfile, then drive 'oc start-build' separately (Task 3b)." >&2
    exit 1
    ;;
  *)
    usage
    exit 1
    ;;
esac
