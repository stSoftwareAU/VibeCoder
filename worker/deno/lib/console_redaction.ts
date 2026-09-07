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
 * Deepest `cause` chain redacted. A cap rather than a cycle set: `cause` is
 * self-referential in the wild (a rethrow that reuses the same error), and a
 * fixed depth terminates on that without tracking identity.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * A redacted copy of `error` — the original is never mutated, because the
 * caller usually still needs the unmasked value for control flow.
 *
 * `message` and `stack` are both masked: the stack normally repeats the
 * message, so masking either alone still leaks. Own properties and the
 * prototype are carried over so a subclass keeps its identity and the
 * inspector renders the same shape.
 *
 * @param error - The error to copy.
 * @param depth - Current `cause` recursion depth.
 * @returns A copy with secret shapes masked.
 */
function redactError(error: Error, depth = 0): Error {
  const copy = Object.create(Object.getPrototypeOf(error)) as Error;
  for (const key of Object.getOwnPropertyNames(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor) Object.defineProperty(copy, key, descriptor);
  }

  const redactedText = (value: unknown): string | undefined =>
    typeof value === "string" ? redactSecrets(value) : undefined;

  for (const key of ["message", "stack"] as const) {
    const masked = redactedText(error[key]);
    if (masked !== undefined) {
      Object.defineProperty(copy, key, {
        value: masked,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  const maskedCause = cause instanceof Error
    ? (depth < MAX_CAUSE_DEPTH ? redactError(cause, depth + 1) : undefined)
    : redactedText(cause);
  if (maskedCause !== undefined) {
    Object.defineProperty(copy, "cause", {
      value: maskedCause,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  return copy;
}

/**
 * Mask one `console.*` argument: strings and errors are redacted, every other
 * value passes through so structured output is preserved.
 *
 * @param arg - The argument as the caller passed it.
 * @returns The argument, redacted when it carries text.
 */
function redactArgument(arg: unknown): unknown {
  if (typeof arg === "string") return redactSecrets(arg);
  if (arg instanceof Error) return redactError(arg);
  return arg;
}

/**
 * Route every `console.*` string argument — and every `Error` — through
 * `redactSecrets`.
 *
 * Idempotent: calling it twice does not double-wrap. Non-`Error` objects are
 * passed through untouched so `console.log(obj)` keeps its structured
 * formatting; an `Error` is rendered as text by the inspector anyway, so
 * masking its message and stack loses nothing (Issue #1260).
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
        args.map(redactArgument),
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
