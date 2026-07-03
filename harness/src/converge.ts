import type { ExecInPod } from "@sh/k8s-sandbox";

/** Single-quote-escape a string for safe interpolation into a bash command. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The per-leaf worktree path inside the sandbox pod. */
export function leafWorkspaceRef(runId: string): string {
  return `/workspace/leaves/${runId}`;
}

/**
 * Ref-pinned lazy converge (spec §5): clone /workspace/repo once, fetch the target ref under a
 * per-pod flock (serializes concurrent converges), then add a per-leaf detached worktree at the
 * fetched commit. Idempotent — a pod already holding the ref and worktree is a no-op. Prints the
 * worktree path on stdout.
 */
export function buildConvergeScript(repoUrl: string, ref: string, runId: string): string {
  const LEAF = leafWorkspaceRef(runId);
  return [
    `set -eu`,
    `REPO=/workspace/repo; LOCK=/workspace/.sh-fetch.lock; LEAF=${sq(LEAF)}`,
    `mkdir -p /workspace/leaves`,
    `[ -d "$REPO/.git" ] || git clone --quiet ${sq(repoUrl)} "$REPO"`,
    `( flock 9; git -C "$REPO" fetch --quiet origin ${sq(ref)} ) 9>"$LOCK"`,
    `COMMIT=$(git -C "$REPO" rev-parse FETCH_HEAD)`,
    `[ -d "$LEAF" ] || git -C "$REPO" worktree add --quiet --detach "$LEAF" "$COMMIT"`,
    `printf '%s' "$LEAF"`,
  ].join("\n");
}

/** Remove the per-leaf worktree and prune orphans (best-effort; never fails the leaf). */
export function buildCleanupScript(runId: string): string {
  const LEAF = leafWorkspaceRef(runId);
  return [
    `set -u`,
    `REPO=/workspace/repo; LEAF=${sq(LEAF)}`,
    `git -C "$REPO" worktree remove --force "$LEAF" 2>/dev/null || rm -rf "$LEAF"`,
    `git -C "$REPO" worktree prune 2>/dev/null || true`,
  ].join("\n");
}

/** Run the converge script in the pod; return the worktree ref. Throws on non-zero exit. */
export async function convergeWorkspace(
  exec: ExecInPod, repoUrl: string, ref: string, runId: string,
): Promise<string> {
  const { stdout, exitCode } = await exec(buildConvergeScript(repoUrl, ref, runId), { timeout: 300 });
  if (exitCode !== 0) throw new Error(`converge failed (exit ${exitCode})`);
  return stdout.toString().trim() || leafWorkspaceRef(runId);
}

/** Best-effort worktree cleanup; swallows errors so it never masks a verdict. */
export async function cleanupWorkspace(exec: ExecInPod, runId: string): Promise<void> {
  try { await exec(buildCleanupScript(runId), { timeout: 60 }); } catch { /* ignore */ }
}
