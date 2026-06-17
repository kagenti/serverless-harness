// Wire protocol for the persistent in-pod bash channel. One long-lived `bash`
// reads commands from stdin and writes every command's output to one stdout
// stream, so each command's output is bracketed by nonce markers and
// base64-encoded. base64's alphabet ([A-Za-z0-9+/=] + "\n") cannot contain the
// \x01-prefixed markers, so framing is collision-proof and binary-safe.

const SOH = "\x01"; // marker lead byte; never appears in base64 output

export interface Frame {
  nonce: string;
  stdout: Buffer; // base64-decoded command stdout
  exitCode: number;
}

/**
 * Build the line(s) written to the session's stdin for one command.
 *
 * `command` is run verbatim; its stdout is base64-encoded between
 * `\x01B<nonce>` and `\x01E<nonce> <exit>` markers. The reported exit code is
 * the COMMAND's (`${PIPESTATUS[0]}`) — NOT base64's `$?`, which is ~always 0.
 *
 * When `stdin` is provided it is delivered to the command via a nonce-delimited
 * heredoc (a shared-stdin session can't pipe separate per-command stdin). The
 * heredoc body is emitted as latin1 so arbitrary bytes survive round-trip;
 * callers typically pass base64 payloads which are ASCII either way. The
 * command must be a single pipeline whose first stage consumes stdin (holds for
 * `base64 -d > <path>`). The heredoc delimiter uses `KAGENTI_EOF_<nonce>` — a
 * bash-safe word that contains `_`, which the standard base64 alphabet
 * (A-Za-z0-9+/=) never emits, so it cannot collide with a body line.
 */
export function wrapCommand(nonce: string, command: string, stdin?: Buffer): string {
  const begin = `printf '${SOH}B%s\\n' ${nonce}; `;
  const end = `printf '${SOH}E%s %d\\n' ${nonce} "\${PIPESTATUS[0]}"\n`;
  if (stdin) {
    // Heredoc delimiter must be bash-safe AND collision-proof. We CANNOT use the
    // \x01 stream marker here: bash strips control bytes from a heredoc delimiter
    // WORD, so <<'\x01H…' would register as 'H…' and the \x01-prefixed closing
    // line would never match (the heredoc would swallow the end marker). Instead
    // use a delimiter containing '_', which the standard base64 alphabet
    // (A-Za-z0-9+/=) never emits, so it can never collide with a body line.
    const h = `KAGENTI_EOF_${nonce}`;
    return `${begin}{ ${command} <<'${h}'\n${stdin.toString("latin1")}\n${h}\n} | base64; ${end}`;
  }
  return `${begin}{ ${command}; } | base64; ${end}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Chunk-fed parser that emits complete frames as bytes arrive. */
export class FrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      // latin1 keeps bytes 1:1 for the marker scan; payload is ASCII base64.
      const text = this.buf.toString("latin1");
      const begin = text.match(/\x01B(\S+)\n/);
      if (!begin) break;
      const nonce = begin[1];
      const bodyStart = begin.index! + begin[0].length;
      const endRe = new RegExp(`\\x01E${escapeRe(nonce)} (-?\\d+)\\n`);
      const after = text.slice(bodyStart);
      const end = after.match(endRe);
      if (!end) break; // frame not complete yet
      const b64 = after.slice(0, end.index!);
      frames.push({
        nonce,
        stdout: Buffer.from(b64.replace(/\s/g, ""), "base64"),
        exitCode: parseInt(end[1], 10),
      });
      this.buf = this.buf.subarray(bodyStart + end.index! + end[0].length);
    }
    return frames;
  }
}
