#!/usr/bin/env bash
# deploy/knative/solve-smoke.sh
# End-to-end gate for the solve leaf (Plan A): post a kind:solve envelope to /runs, have the agent
# create a file in its per-leaf worktree, and assert the captured patch adds that file.
# Gated by SOLVE_SMOKE_LIVE=1. Needs a running Kind harness (setup-kind.sh) + gitd 'work' ref + an
# LLM credential in the harness (llm-credentials secret) so the agent can run a turn.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./lib.sh

[ "${SOLVE_SMOKE_LIVE:-0}" = "1" ] || { echo "SKIP (set SOLVE_SMOKE_LIVE=1)"; exit 0; }

ensure_port_forward >/dev/null || true
wait_gitd 120 || { echo "gitd not ready"; exit 1; }

SID="solve-smoke-$$"
REPO="$(gitd_repo_url)"
PROMPT='Create a new file named NOTES.md at the repository root whose contents are exactly the single line: hello'
BODY="$(jq -nc --arg s "$SID" --arg p "$PROMPT" --arg r "$REPO" \
  '{sessionId:$s, kind:"solve", problemStatement:$p, repoUrl:$r, ref:"work"}')"

echo "--- solve-smoke: POST /runs (sid=$SID) ---"
RESP="$(curl -s "${CURL_OPTS[@]}" "${CURL_HDR[@]}" -X POST "$BASE/runs" \
  -H 'Content-Type: application/json' --max-time 300 -d "$BODY")"

STATUS="$(jq -r '.status // empty' <<<"$RESP")"
PATCH="$(jq -r '.patch // empty' <<<"$RESP")"

if [ "$STATUS" = "solved" ] && printf '%s' "$PATCH" | grep -q 'NOTES.md'; then
  echo "PASS: status=solved, patch adds NOTES.md"
  exit 0
fi
echo "FAIL: status='$STATUS' (expected solved); patch mentions NOTES.md? $(printf '%s' "$PATCH" | grep -c 'NOTES.md')"
echo "$RESP" | jq -r '{status, reason, message}' 2>/dev/null || true
exit 1
