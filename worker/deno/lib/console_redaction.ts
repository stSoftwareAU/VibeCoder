/**
 * Process-wide secret redaction for direct `console.*` output (Issue #3661,
 * SEC-f684a9d954ff).
 *
 * `createLogger` wraps its sink in `redactSecrets` and its docstring claims
 * masking happens "regardless of which caller produced the string". That
 * invariant did not hold: roughly a hundred direct `console.log/warn/error`
 * calls across `worker/deno/lib/` write to the same stderr — captured into
 * `worker-*.log` — without passing through the logger. Several of them
 * interpolate raw subprocess error text (`quality_gate.ts`,
 * `repo_failure_tracker.ts`, `shared_cooldown.ts`), which is exactly the
 * shape that carries a tokenised clone URL or an `export FOO_TOKEN=…` line.
 *
 * Rather than rewrite every call site — a churn-heavy change that the next
 * new `console.log` would immediately undo — install the redaction at the
 * real chokepoint: the console itself. One call at process start makes the
 * guarantee structural, so a future direct `console.error` is covered by
 * construction.
 *
 * Redaction is conservative (specific secret shapes only), so ordinary log
 * text is untouched; see `secret_redaction.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";

/** Console methods that write to stdout/stderr and so may leak a secret. */
const PATCHED_METHODS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
] as const;

type PatchedMethod = typeof PATCHED_METHODS[number];

/** Original methods, kept so {@link restoreConsole} can undo the patch. */
let originals: Partial<Record<PatchedMethod, (...args: unknown[]) => void>> =
  {};

/**
 * Route every `console.*` string argument through `redactSecrets`.
 *
 * Idempotent: calling it twice does not double-wrap. Non-string arguments are
 * passed through untouched so `console.log(obj)` keeps its structured
 * formatting — string interpolation is where secrets actually reach the log.
 *
 * @returns true when the patch was installed, false when already active.
 */
export function installConsoleRedaction(): boolean {
  if (Object.keys(originals).length > 0) return false;

  const target = globalThis.console as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;

  const captured: typeof originals = {};
  for (const method of PATCHED_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    captured[method] = original;
    target[method] = (...args: unknown[]): void => {
      original.apply(
        globalThis.console,
        args.map((arg) => typeof arg === "string" ? redactSecrets(arg) : arg),
      );
    };
  }
  originals = captured;
  return true;
}

/**
 * Restore the unpatched console methods.
 *
 * Exists for tests — production installs the patch once and leaves it.
 *
 * @returns true when a patch was removed, false when none was active.
 */
export function restoreConsole(): boolean {
  if (Object.keys(originals).length === 0) return false;

  const target = globalThis.console as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  for (const [method, original] of Object.entries(originals)) {
    target[method] = original;
  }
  originals = {};
  return true;
}
