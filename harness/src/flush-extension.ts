import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { BufferedRedisBackend } from "./buffered-redis-backend.js";

/**
 * Returns a Pi ExtensionFactory that flushes the write-behind buffer at the two
 * durability barriers: after each completed turn, and on session shutdown (the
 * scale-to-zero exit point).
 *
 * Register by passing to DefaultResourceLoader's extensionFactories option.
 */
export function flushExtension(backend: BufferedRedisBackend): ExtensionFactory {
  return (pi) => {
    pi.on("turn_end", () => backend.flush());
    pi.on("session_shutdown", () => backend.flush());
  };
}
