/**
 * The `.config.json` `callbacks` block — configuration surface of the public
 * post-run callback contract (Issue #806, parent #796).
 *
 * ```json
 * {
 *   "callbacks": {
 *     "success": "/absolute/path/to/success.sh",
 *     "failure": "/absolute/path/to/failure.sh",
 *     "always":  "/absolute/path/to/always.sh",
 *     "timeout_seconds": 60
 *   }
 * }
 * ```
 *
 * Every entry is optional and a configuration without the block behaves
 * exactly as before.
 *
 * ## Validation posture — fail loud at config load
 *
 * Unlike the warn-and-default `idle_task_cadence` parser, a malformed
 * `callbacks` block **stops the worker**. A hook an operator believes is
 * wired, but that silently never runs, is the precise failure this contract
 * exists to make impossible: the fleet's health and archival reporting hangs
 * off it, so "no explicit failure" must never pass for "the hook ran".
 *
 * ## Path rules — absolute only, in every mode
 *
 * A hook is an **executable path**, never a shell command string, and it must
 * be **absolute**. Relative paths are rejected rather than resolved: the
 * worker's working directory differs between the native and container modes
 * (and moves again per repository checkout), so a relative hook would resolve
 * differently run to run. One rule, identical in both modes.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";

/** Outcome conditions a callback may be registered against. */
export const CALLBACK_EVENTS = ["success", "failure", "always"] as const;

/** One of {@link CALLBACK_EVENTS}. */
export type CallbackEvent = typeof CALLBACK_EVENTS[number];

/** Seconds a callback may run before it is terminated. */
export const DEFAULT_CALLBACK_TIMEOUT_SECONDS = 60;

/** Ceiling on `callbacks.timeout_seconds` — one hour. */
export const MAX_CALLBACK_TIMEOUT_SECONDS = 3600;

/** Keys recognised inside the `callbacks` block. */
const KNOWN_KEYS: readonly string[] = [
  ...CALLBACK_EVENTS,
  "timeout_seconds",
];

/** The validated `callbacks` block. Absent hooks are simply undefined. */
export interface CallbacksConfig {
  /** Executable run after a terminal successful issue run. */
  success?: string;
  /** Executable run after a terminal failed issue run. */
  failure?: string;
  /** Executable run after the applicable outcome hook, in both cases. */
  always?: string;
  /** Wall-clock budget for one callback, in seconds. */
  timeoutSeconds: number;
}

/** A block with no hooks configured — the default for every existing config. */
export function noCallbacks(): CallbacksConfig {
  return { timeoutSeconds: DEFAULT_CALLBACK_TIMEOUT_SECONDS };
}

/** Whether any hook is configured. */
export function hasAnyCallback(config: CallbacksConfig): boolean {
  return CALLBACK_EVENTS.some((event) => config[event] !== undefined);
}

/** Short description of a value for an error message. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}

/**
 * Absolute-path test covering both POSIX (`/opt/hooks/x.sh`) and Windows
 * drive-absolute (`C:\hooks\x.cmd`) forms, so a Windows operator is not
 * forced into a path shape their platform cannot express.
 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Validate one hook path, returning the trimmed value or an error message. */
function parseHookPath(
  event: CallbackEvent,
  value: unknown,
): Result<string, string> {
  const field = `callbacks.${event}`;
  if (typeof value !== "string") {
    return {
      ok: false,
      error: `${field} must be a string path to an executable, got ${
        show(value)
      }`,
    };
  }
  if (value.includes("\u0000")) {
    return { ok: false, error: `${field} must not contain a NUL character` };
  }
  const path = value.trim();
  if (path === "") {
    return {
      ok: false,
      error: `${field} must be a non-empty path to an executable`,
    };
  }
  if (!isAbsolutePath(path)) {
    return {
      ok: false,
      error:
        `${field} must be an absolute path (got ${
          show(path)
        }); relative paths are rejected in both native and container modes ` +
        `because the worker's working directory changes between runs`,
    };
  }
  return { ok: true, value: path };
}

/** Validate `callbacks.timeout_seconds`. */
function parseTimeoutSeconds(value: unknown): Result<number, string> {
  const field = "callbacks.timeout_seconds";
  if (value === undefined) {
    return { ok: true, value: DEFAULT_CALLBACK_TIMEOUT_SECONDS };
  }
  if (
    typeof value !== "number" || !Number.isInteger(value) || value <= 0 ||
    value > MAX_CALLBACK_TIMEOUT_SECONDS
  ) {
    return {
      ok: false,
      error:
        `${field} must be a whole number of seconds between 1 and ${MAX_CALLBACK_TIMEOUT_SECONDS}, got ${
          show(value)
        }`,
    };
  }
  return { ok: true, value };
}

/**
 * Validate the raw `callbacks` block from `.config.json`.
 *
 * Absent or null yields {@link noCallbacks}; every other fault is reported,
 * never repaired.
 */
export function parseCallbacksConfig(
  raw: unknown,
): Result<CallbacksConfig, string> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: noCallbacks() };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: `callbacks must be an object of hook paths, got ${show(raw)}`,
    };
  }

  const block = raw as Record<string, unknown>;
  const unknown = Object.keys(block).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `callbacks has unknown key(s) ${
        unknown.map((key) => JSON.stringify(key)).join(", ")
      }; recognised keys are ${KNOWN_KEYS.join(", ")}`,
    };
  }

  const timeout = parseTimeoutSeconds(block.timeout_seconds);
  if (!timeout.ok) return timeout;

  const config: CallbacksConfig = { timeoutSeconds: timeout.value };
  for (const event of CALLBACK_EVENTS) {
    if (block[event] === undefined) continue;
    const hook = parseHookPath(event, block[event]);
    if (!hook.ok) return hook;
    config[event] = hook.value;
  }
  return { ok: true, value: config };
}

/**
 * {@link parseCallbacksConfig}, but throwing — the fail-loud entry point used
 * at config load so a malformed block stops the worker before any issue is
 * claimed against a hook that would never fire.
 */
export function assertCallbacksConfig(raw: unknown): CallbacksConfig {
  const parsed = parseCallbacksConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
