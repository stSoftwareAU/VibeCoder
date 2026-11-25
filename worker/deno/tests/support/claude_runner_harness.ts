/**
 * Shared helpers for the `runClaudeWithRetry` tests (Issues #4374, #4384,
 * #5529): a logger that keeps what it was told, a signal that resolves when
 * the runner has folded the agent's nth stdout chunk in, and a bounded wait
 * for a file the stub agent writes. Extracted from
 * claude_runner_killed_test.ts so memory_guard_5529_test.ts reuses them
 * instead of copying them. Not a test module (no `_test` suffix), so
 * `deno test` never collects it on its own.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../../types.ts";

/** A logger that records what the runner logged, for assertions. */
export function capturingLogger(onWarn?: (message: string) => void): {
  logger: Logger;
  security: Array<{ event: string; details: string }>;
  warns: string[];
  errors: string[];
} {
  const security: Array<{ event: string; details: string }> = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (message) => {
      warns.push(message);
      onWarn?.(message);
    },
    error: (message) => {
      errors.push(message);
    },
    debug: () => {},
    security: (event, details) => {
      security.push({ event, details });
    },
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, security, warns, errors };
}

/** Resolves when the runner has folded the agent's nth stdout chunk in. */
export function chunkSignals() {
  const chunks: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let seen = 0;
  const at = (index: number) => (chunks[index] ??= Promise.withResolvers());
  return {
    onActivity: () => at(seen++).resolve(),
    chunk: (n: number) => at(n - 1).promise,
  };
}

/** Wait for a file the stub writes, so "the child got that far" is provable. */
export async function waitForFile(path: string): Promise<string> {
  // Bounded so a stub that never writes fails the case rather than hanging
  // the suite; the poll is real time, which a busy host only lengthens.
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      const text = (await Deno.readTextFile(path)).trim();
      if (text.length > 0) return text;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the stub never wrote ${path}`);
}
