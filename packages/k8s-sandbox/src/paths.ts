/** Single-quote a string for safe interpolation into a `bash -c` command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrite an absolute head path into the pod's filesystem by swapping the
 * head cwd prefix for the pod cwd. Paths outside the head cwd are returned
 * unchanged (mirrors the SSH example's naive prefix replace).
 */
export function mapPath(p: string, headCwd: string, podCwd: string): string {
  if (p === headCwd) return podCwd;
  if (p.startsWith(headCwd + "/")) return podCwd + p.slice(headCwd.length);
  return p;
}
