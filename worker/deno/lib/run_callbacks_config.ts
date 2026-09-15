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
 *     "cycle":   "/absolute/path/to/cycle.sh",
 *     "host_failure": "/absolute/host/path/to/host-failure.sh",
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
 * exists to make impossible: "no explicit failure" must never pass for
 * "the hook ran".
 *
 * ## Path rules — absolute, on the worker's own filesystem
 *
 * A hook is an **executable path**, never a shell command string, and it must
 * be **absolute**. Relative paths are rejected rather than resolved: the
 * worker's working directory moves per repository checkout, so a relative
 * hook would resolve differently run to run.
 *
 * The path is resolved on the filesystem the **worker process** sees. The
 * worker runs inside the container (`run_mode` has one member), so a hook
 * must be present at that absolute path inside the container — a host path
 * that is not mounted in is not visible to it.
 *
 * `host_failure` is the one exception, and the distinction matters: it is a
 * **host** path (Issue #2107, parent #2088). Nothing inside the container
 * invokes it — the host launcher does, before a container exists — so it must
 * be present on the host's own filesystem, not the container's. Every other
 * key is a container path.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";

/** Outcome conditions a callback may be registered against. */
export const CALLBACK_EVENTS = [
  "success",
  "failure",
  "always",
  "cycle",
  "host_failure",
] as const;

/**
 * Hooks that fire for one terminal issue run. `cycle` is a scan-loop
 * heartbeat, not a run hook, so the run dispatcher never includes it.
 */
export const RUN_CALLBACK_EVENTS = ["success", "failure", "always"] as const;

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
  /**
   * Executable run once at the end of every scan cycle (Issue #1955).
   *
   * Distinct from the three run hooks: a host that claimed nothing still
   * fires this, so an archive can tell idle from dead. Run hooks are
   * unchanged.
   */
  cycle?: string;
  /**
   * Executable the **host launcher** runs while a host-level failure persists
   * (Issue #2107, parent #2088).
   *
   * Unlike every other key this is a path on the **host**, not inside the
   * container: it fires for failures that happen before a container exists,
   * so nothing in the container ever invokes it.
   */
  host_failure?: string;
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

/** Whether any per-issue-run hook is configured. */
export function hasAnyRunCallback(config: CallbacksConfig): boolean {
  return RUN_CALLBACK_EVENTS.some((event) => config[event] !== undefined);
}

/** Whether the per-cycle heartbeat hook is configured. */
export function hasCycleCallback(config: CallbacksConfig): boolean {
  return config.cycle !== undefined;
}

/** Short description of a value for an error message. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}

/** POSIX absolute path — the only shape the container's filesystem uses. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
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
        `${field} must be an absolute path on the worker's filesystem (got ${
          show(path)
        }); a relative path is rejected because the worker's working ` +
        `directory changes between runs`,
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

/** The host-side view of the block: just the host hook and its budget. */
export interface HostFailureCallbackConfig {
  /** Absolute host path to the hook, when one is configured. */
  path?: string;
  /** Wall-clock budget for the hook, in seconds. */
  timeoutSeconds: number;
}

/**
 * Validate **only** `callbacks.host_failure` and `callbacks.timeout_seconds`
 * (Issue #2107, parent #2088).
 *
 * The host launcher reads the config file itself, before any container
 * exists, and it uses exactly these two keys. Validating the whole block
 * there would fail the host on a container-only key it never touches — a
 * `success` hook pointing at a path only the container can see is correct
 * configuration, and must not stop the host hook from firing. So the same
 * path and timeout rules are applied, to these two keys alone.
 *
 * An absent `host_failure` is not a fault: it yields `path: undefined`, which
 * the caller reads as "no host hook configured".
 */
export function parseHostFailureCallback(
  rawCallbacks: unknown,
): Result<HostFailureCallbackConfig, string> {
  if (rawCallbacks === undefined || rawCallbacks === null) {
    return {
      ok: true,
      value: { timeoutSeconds: DEFAULT_CALLBACK_TIMEOUT_SECONDS },
    };
  }
  if (typeof rawCallbacks !== "object" || Array.isArray(rawCallbacks)) {
    return {
      ok: false,
      error: `callbacks must be an object of hook paths, got ${
        show(rawCallbacks)
      }`,
    };
  }

  const block = rawCallbacks as Record<string, unknown>;
  const timeout = parseTimeoutSeconds(block.timeout_seconds);
  if (!timeout.ok) return timeout;

  if (block.host_failure === undefined) {
    return { ok: true, value: { timeoutSeconds: timeout.value } };
  }
  const hook = parseHookPath("host_failure", block.host_failure);
  if (!hook.ok) return hook;
  return {
    ok: true,
    value: { path: hook.value, timeoutSeconds: timeout.value },
  };
}
