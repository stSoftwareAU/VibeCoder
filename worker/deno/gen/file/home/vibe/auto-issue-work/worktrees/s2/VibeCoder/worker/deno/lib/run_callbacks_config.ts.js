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
 */ /**
 * Events the worker invokes from **inside the container**, where every hook
 * path is a container path.
 */ export const CONTAINER_CALLBACK_EVENTS = [
  "success",
  "failure",
  "always",
  "cycle"
];
/**
 * Outcome conditions a callback may be registered against.
 *
 * `host_failure` is the host launcher's (Issue #2107): it is the one key
 * whose path is resolved on the host, and nothing inside the container
 * invokes it.
 */ export const CALLBACK_EVENTS = [
  ...CONTAINER_CALLBACK_EVENTS,
  "host_failure"
];
/**
 * Hooks that fire for one terminal issue run. `cycle` is a scan-loop
 * heartbeat, not a run hook, so the run dispatcher never includes it.
 */ export const RUN_CALLBACK_EVENTS = [
  "success",
  "failure",
  "always"
];
/** Seconds a callback may run before it is terminated. */ export const DEFAULT_CALLBACK_TIMEOUT_SECONDS = 60;
/** Ceiling on `callbacks.timeout_seconds` — one hour. */ export const MAX_CALLBACK_TIMEOUT_SECONDS = 3600;
/** Keys recognised inside the `callbacks` block. */ const KNOWN_KEYS = [
  ...CALLBACK_EVENTS,
  "timeout_seconds"
];
/** A block with no hooks configured — the default for every existing config. */ export function noCallbacks() {
  return {
    timeoutSeconds: DEFAULT_CALLBACK_TIMEOUT_SECONDS
  };
}
/** Whether any hook is configured. */ export function hasAnyCallback(config) {
  return CALLBACK_EVENTS.some((event)=>config[event] !== undefined);
}
/** Whether any per-issue-run hook is configured. */ export function hasAnyRunCallback(config) {
  return RUN_CALLBACK_EVENTS.some((event)=>config[event] !== undefined);
}
/** Whether the per-cycle heartbeat hook is configured. */ export function hasCycleCallback(config) {
  return config.cycle !== undefined;
}
/** Short description of a value for an error message. */ function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}
/** POSIX absolute path — the only shape the container's filesystem uses. */ function isAbsolutePath(path) {
  return path.startsWith("/");
}
/** Validate one hook path, returning the trimmed value or an error message. */ function parseHookPath(event, value) {
  const field = `callbacks.${event}`;
  if (typeof value !== "string") {
    return {
      ok: false,
      error: `${field} must be a string path to an executable, got ${show(value)}`
    };
  }
  if (value.includes("\u0000")) {
    return {
      ok: false,
      error: `${field} must not contain a NUL character`
    };
  }
  const path = value.trim();
  if (path === "") {
    return {
      ok: false,
      error: `${field} must be a non-empty path to an executable`
    };
  }
  if (!isAbsolutePath(path)) {
    return {
      ok: false,
      error: `${field} must be an absolute path on the worker's filesystem (got ${show(path)}); a relative path is rejected because the worker's working ` + `directory changes between runs`
    };
  }
  return {
    ok: true,
    value: path
  };
}
/** Validate `callbacks.timeout_seconds`. */ function parseTimeoutSeconds(value) {
  const field = "callbacks.timeout_seconds";
  if (value === undefined) {
    return {
      ok: true,
      value: DEFAULT_CALLBACK_TIMEOUT_SECONDS
    };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_CALLBACK_TIMEOUT_SECONDS) {
    return {
      ok: false,
      error: `${field} must be a whole number of seconds between 1 and ${MAX_CALLBACK_TIMEOUT_SECONDS}, got ${show(value)}`
    };
  }
  return {
    ok: true,
    value
  };
}
/**
 * Validate the raw `callbacks` block from `.config.json`.
 *
 * Absent or null yields {@link noCallbacks}; every other fault is reported,
 * never repaired.
 */ export function parseCallbacksConfig(raw) {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      value: noCallbacks()
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: `callbacks must be an object of hook paths, got ${show(raw)}`
    };
  }
  const block = raw;
  const unknown = Object.keys(block).filter((key)=>!KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `callbacks has unknown key(s) ${unknown.map((key)=>JSON.stringify(key)).join(", ")}; recognised keys are ${KNOWN_KEYS.join(", ")}`
    };
  }
  const timeout = parseTimeoutSeconds(block.timeout_seconds);
  if (!timeout.ok) return timeout;
  const config = {
    timeoutSeconds: timeout.value
  };
  for (const event of CALLBACK_EVENTS){
    if (block[event] === undefined) continue;
    const hook = parseHookPath(event, block[event]);
    if (!hook.ok) return hook;
    config[event] = hook.value;
  }
  return {
    ok: true,
    value: config
  };
}
/**
 * {@link parseCallbacksConfig}, but throwing — the fail-loud entry point used
 * at config load so a malformed block stops the worker before any issue is
 * claimed against a hook that would never fire.
 */ export function assertCallbacksConfig(raw) {
  const parsed = parseCallbacksConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
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
 */ export function parseHostFailureCallback(rawCallbacks) {
  if (rawCallbacks === undefined || rawCallbacks === null) {
    return {
      ok: true,
      value: {
        timeoutSeconds: DEFAULT_CALLBACK_TIMEOUT_SECONDS
      }
    };
  }
  if (typeof rawCallbacks !== "object" || Array.isArray(rawCallbacks)) {
    return {
      ok: false,
      error: `callbacks must be an object of hook paths, got ${show(rawCallbacks)}`
    };
  }
  const block = rawCallbacks;
  const timeout = parseTimeoutSeconds(block.timeout_seconds);
  if (!timeout.ok) return timeout;
  if (block.host_failure === undefined) {
    return {
      ok: true,
      value: {
        timeoutSeconds: timeout.value
      }
    };
  }
  const hook = parseHookPath("host_failure", block.host_failure);
  if (!hook.ok) return hook;
  return {
    ok: true,
    value: {
      path: hook.value,
      timeoutSeconds: timeout.value
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ydW5fY2FsbGJhY2tzX2NvbmZpZy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRoZSBgLmNvbmZpZy5qc29uYCBgY2FsbGJhY2tzYCBibG9jayDigJQgY29uZmlndXJhdGlvbiBzdXJmYWNlIG9mIHRoZSBwdWJsaWNcbiAqIHBvc3QtcnVuIGNhbGxiYWNrIGNvbnRyYWN0IChJc3N1ZSAjODA2LCBwYXJlbnQgIzc5NikuXG4gKlxuICogYGBganNvblxuICoge1xuICogICBcImNhbGxiYWNrc1wiOiB7XG4gKiAgICAgXCJzdWNjZXNzXCI6IFwiL2Fic29sdXRlL3BhdGgvdG8vc3VjY2Vzcy5zaFwiLFxuICogICAgIFwiZmFpbHVyZVwiOiBcIi9hYnNvbHV0ZS9wYXRoL3RvL2ZhaWx1cmUuc2hcIixcbiAqICAgICBcImFsd2F5c1wiOiAgXCIvYWJzb2x1dGUvcGF0aC90by9hbHdheXMuc2hcIixcbiAqICAgICBcImN5Y2xlXCI6ICAgXCIvYWJzb2x1dGUvcGF0aC90by9jeWNsZS5zaFwiLFxuICogICAgIFwiaG9zdF9mYWlsdXJlXCI6IFwiL2Fic29sdXRlL2hvc3QvcGF0aC90by9ob3N0LWZhaWx1cmUuc2hcIixcbiAqICAgICBcInRpbWVvdXRfc2Vjb25kc1wiOiA2MFxuICogICB9XG4gKiB9XG4gKiBgYGBcbiAqXG4gKiBFdmVyeSBlbnRyeSBpcyBvcHRpb25hbCBhbmQgYSBjb25maWd1cmF0aW9uIHdpdGhvdXQgdGhlIGJsb2NrIGJlaGF2ZXNcbiAqIGV4YWN0bHkgYXMgYmVmb3JlLlxuICpcbiAqICMjIFZhbGlkYXRpb24gcG9zdHVyZSDigJQgZmFpbCBsb3VkIGF0IGNvbmZpZyBsb2FkXG4gKlxuICogVW5saWtlIHRoZSB3YXJuLWFuZC1kZWZhdWx0IGBpZGxlX3Rhc2tfY2FkZW5jZWAgcGFyc2VyLCBhIG1hbGZvcm1lZFxuICogYGNhbGxiYWNrc2AgYmxvY2sgKipzdG9wcyB0aGUgd29ya2VyKiouIEEgaG9vayBhbiBvcGVyYXRvciBiZWxpZXZlcyBpc1xuICogd2lyZWQsIGJ1dCB0aGF0IHNpbGVudGx5IG5ldmVyIHJ1bnMsIGlzIHRoZSBwcmVjaXNlIGZhaWx1cmUgdGhpcyBjb250cmFjdFxuICogZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZTogXCJubyBleHBsaWNpdCBmYWlsdXJlXCIgbXVzdCBuZXZlciBwYXNzIGZvclxuICogXCJ0aGUgaG9vayByYW5cIi5cbiAqXG4gKiAjIyBQYXRoIHJ1bGVzIOKAlCBhYnNvbHV0ZSwgb24gdGhlIHdvcmtlcidzIG93biBmaWxlc3lzdGVtXG4gKlxuICogQSBob29rIGlzIGFuICoqZXhlY3V0YWJsZSBwYXRoKiosIG5ldmVyIGEgc2hlbGwgY29tbWFuZCBzdHJpbmcsIGFuZCBpdCBtdXN0XG4gKiBiZSAqKmFic29sdXRlKiouIFJlbGF0aXZlIHBhdGhzIGFyZSByZWplY3RlZCByYXRoZXIgdGhhbiByZXNvbHZlZDogdGhlXG4gKiB3b3JrZXIncyB3b3JraW5nIGRpcmVjdG9yeSBtb3ZlcyBwZXIgcmVwb3NpdG9yeSBjaGVja291dCwgc28gYSByZWxhdGl2ZVxuICogaG9vayB3b3VsZCByZXNvbHZlIGRpZmZlcmVudGx5IHJ1biB0byBydW4uXG4gKlxuICogVGhlIHBhdGggaXMgcmVzb2x2ZWQgb24gdGhlIGZpbGVzeXN0ZW0gdGhlICoqd29ya2VyIHByb2Nlc3MqKiBzZWVzLiBUaGVcbiAqIHdvcmtlciBydW5zIGluc2lkZSB0aGUgY29udGFpbmVyIChgcnVuX21vZGVgIGhhcyBvbmUgbWVtYmVyKSwgc28gYSBob29rXG4gKiBtdXN0IGJlIHByZXNlbnQgYXQgdGhhdCBhYnNvbHV0ZSBwYXRoIGluc2lkZSB0aGUgY29udGFpbmVyIOKAlCBhIGhvc3QgcGF0aFxuICogdGhhdCBpcyBub3QgbW91bnRlZCBpbiBpcyBub3QgdmlzaWJsZSB0byBpdC5cbiAqXG4gKiBgaG9zdF9mYWlsdXJlYCBpcyB0aGUgb25lIGV4Y2VwdGlvbiwgYW5kIHRoZSBkaXN0aW5jdGlvbiBtYXR0ZXJzOiBpdCBpcyBhXG4gKiAqKmhvc3QqKiBwYXRoIChJc3N1ZSAjMjEwNywgcGFyZW50ICMyMDg4KS4gTm90aGluZyBpbnNpZGUgdGhlIGNvbnRhaW5lclxuICogaW52b2tlcyBpdCDigJQgdGhlIGhvc3QgbGF1bmNoZXIgZG9lcywgYmVmb3JlIGEgY29udGFpbmVyIGV4aXN0cyDigJQgc28gaXQgbXVzdFxuICogYmUgcHJlc2VudCBvbiB0aGUgaG9zdCdzIG93biBmaWxlc3lzdGVtLCBub3QgdGhlIGNvbnRhaW5lcidzLiBFdmVyeSBvdGhlclxuICoga2V5IGlzIGEgY29udGFpbmVyIHBhdGguXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8qKlxuICogRXZlbnRzIHRoZSB3b3JrZXIgaW52b2tlcyBmcm9tICoqaW5zaWRlIHRoZSBjb250YWluZXIqKiwgd2hlcmUgZXZlcnkgaG9va1xuICogcGF0aCBpcyBhIGNvbnRhaW5lciBwYXRoLlxuICovXG5leHBvcnQgY29uc3QgQ09OVEFJTkVSX0NBTExCQUNLX0VWRU5UUyA9IFtcbiAgXCJzdWNjZXNzXCIsXG4gIFwiZmFpbHVyZVwiLFxuICBcImFsd2F5c1wiLFxuICBcImN5Y2xlXCIsXG5dIGFzIGNvbnN0O1xuXG4vKipcbiAqIE91dGNvbWUgY29uZGl0aW9ucyBhIGNhbGxiYWNrIG1heSBiZSByZWdpc3RlcmVkIGFnYWluc3QuXG4gKlxuICogYGhvc3RfZmFpbHVyZWAgaXMgdGhlIGhvc3QgbGF1bmNoZXIncyAoSXNzdWUgIzIxMDcpOiBpdCBpcyB0aGUgb25lIGtleVxuICogd2hvc2UgcGF0aCBpcyByZXNvbHZlZCBvbiB0aGUgaG9zdCwgYW5kIG5vdGhpbmcgaW5zaWRlIHRoZSBjb250YWluZXJcbiAqIGludm9rZXMgaXQuXG4gKi9cbmV4cG9ydCBjb25zdCBDQUxMQkFDS19FVkVOVFMgPSBbXG4gIC4uLkNPTlRBSU5FUl9DQUxMQkFDS19FVkVOVFMsXG4gIFwiaG9zdF9mYWlsdXJlXCIsXG5dIGFzIGNvbnN0O1xuXG4vKipcbiAqIEhvb2tzIHRoYXQgZmlyZSBmb3Igb25lIHRlcm1pbmFsIGlzc3VlIHJ1bi4gYGN5Y2xlYCBpcyBhIHNjYW4tbG9vcFxuICogaGVhcnRiZWF0LCBub3QgYSBydW4gaG9vaywgc28gdGhlIHJ1biBkaXNwYXRjaGVyIG5ldmVyIGluY2x1ZGVzIGl0LlxuICovXG5leHBvcnQgY29uc3QgUlVOX0NBTExCQUNLX0VWRU5UUyA9IFtcInN1Y2Nlc3NcIiwgXCJmYWlsdXJlXCIsIFwiYWx3YXlzXCJdIGFzIGNvbnN0O1xuXG4vKiogT25lIG9mIHtAbGluayBDQUxMQkFDS19FVkVOVFN9LiAqL1xuZXhwb3J0IHR5cGUgQ2FsbGJhY2tFdmVudCA9IHR5cGVvZiBDQUxMQkFDS19FVkVOVFNbbnVtYmVyXTtcblxuLyoqIFNlY29uZHMgYSBjYWxsYmFjayBtYXkgcnVuIGJlZm9yZSBpdCBpcyB0ZXJtaW5hdGVkLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0FMTEJBQ0tfVElNRU9VVF9TRUNPTkRTID0gNjA7XG5cbi8qKiBDZWlsaW5nIG9uIGBjYWxsYmFja3MudGltZW91dF9zZWNvbmRzYCDigJQgb25lIGhvdXIuICovXG5leHBvcnQgY29uc3QgTUFYX0NBTExCQUNLX1RJTUVPVVRfU0VDT05EUyA9IDM2MDA7XG5cbi8qKiBLZXlzIHJlY29nbmlzZWQgaW5zaWRlIHRoZSBgY2FsbGJhY2tzYCBibG9jay4gKi9cbmNvbnN0IEtOT1dOX0tFWVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICAuLi5DQUxMQkFDS19FVkVOVFMsXG4gIFwidGltZW91dF9zZWNvbmRzXCIsXG5dO1xuXG4vKiogVGhlIHZhbGlkYXRlZCBgY2FsbGJhY2tzYCBibG9jay4gQWJzZW50IGhvb2tzIGFyZSBzaW1wbHkgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDYWxsYmFja3NDb25maWcge1xuICAvKiogRXhlY3V0YWJsZSBydW4gYWZ0ZXIgYSB0ZXJtaW5hbCBzdWNjZXNzZnVsIGlzc3VlIHJ1bi4gKi9cbiAgc3VjY2Vzcz86IHN0cmluZztcbiAgLyoqIEV4ZWN1dGFibGUgcnVuIGFmdGVyIGEgdGVybWluYWwgZmFpbGVkIGlzc3VlIHJ1bi4gKi9cbiAgZmFpbHVyZT86IHN0cmluZztcbiAgLyoqIEV4ZWN1dGFibGUgcnVuIGFmdGVyIHRoZSBhcHBsaWNhYmxlIG91dGNvbWUgaG9vaywgaW4gYm90aCBjYXNlcy4gKi9cbiAgYWx3YXlzPzogc3RyaW5nO1xuICAvKipcbiAgICogRXhlY3V0YWJsZSBydW4gb25jZSBhdCB0aGUgZW5kIG9mIGV2ZXJ5IHNjYW4gY3ljbGUgKElzc3VlICMxOTU1KS5cbiAgICpcbiAgICogRGlzdGluY3QgZnJvbSB0aGUgdGhyZWUgcnVuIGhvb2tzOiBhIGhvc3QgdGhhdCBjbGFpbWVkIG5vdGhpbmcgc3RpbGxcbiAgICogZmlyZXMgdGhpcywgc28gYW4gYXJjaGl2ZSBjYW4gdGVsbCBpZGxlIGZyb20gZGVhZC4gUnVuIGhvb2tzIGFyZVxuICAgKiB1bmNoYW5nZWQuXG4gICAqL1xuICBjeWNsZT86IHN0cmluZztcbiAgLyoqXG4gICAqIEV4ZWN1dGFibGUgdGhlICoqaG9zdCBsYXVuY2hlcioqIHJ1bnMgd2hpbGUgYSBob3N0LWxldmVsIGZhaWx1cmUgcGVyc2lzdHNcbiAgICogKElzc3VlICMyMTA3LCBwYXJlbnQgIzIwODgpLlxuICAgKlxuICAgKiBVbmxpa2UgZXZlcnkgb3RoZXIga2V5IHRoaXMgaXMgYSBwYXRoIG9uIHRoZSAqKmhvc3QqKiwgbm90IGluc2lkZSB0aGVcbiAgICogY29udGFpbmVyOiBpdCBmaXJlcyBmb3IgZmFpbHVyZXMgdGhhdCBoYXBwZW4gYmVmb3JlIGEgY29udGFpbmVyIGV4aXN0cyxcbiAgICogc28gbm90aGluZyBpbiB0aGUgY29udGFpbmVyIGV2ZXIgaW52b2tlcyBpdC5cbiAgICovXG4gIGhvc3RfZmFpbHVyZT86IHN0cmluZztcbiAgLyoqIFdhbGwtY2xvY2sgYnVkZ2V0IGZvciBvbmUgY2FsbGJhY2ssIGluIHNlY29uZHMuICovXG4gIHRpbWVvdXRTZWNvbmRzOiBudW1iZXI7XG59XG5cbi8qKiBBIGJsb2NrIHdpdGggbm8gaG9va3MgY29uZmlndXJlZCDigJQgdGhlIGRlZmF1bHQgZm9yIGV2ZXJ5IGV4aXN0aW5nIGNvbmZpZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub0NhbGxiYWNrcygpOiBDYWxsYmFja3NDb25maWcge1xuICByZXR1cm4geyB0aW1lb3V0U2Vjb25kczogREVGQVVMVF9DQUxMQkFDS19USU1FT1VUX1NFQ09ORFMgfTtcbn1cblxuLyoqIFdoZXRoZXIgYW55IGhvb2sgaXMgY29uZmlndXJlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNBbnlDYWxsYmFjayhjb25maWc6IENhbGxiYWNrc0NvbmZpZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gQ0FMTEJBQ0tfRVZFTlRTLnNvbWUoKGV2ZW50KSA9PiBjb25maWdbZXZlbnRdICE9PSB1bmRlZmluZWQpO1xufVxuXG4vKiogV2hldGhlciBhbnkgcGVyLWlzc3VlLXJ1biBob29rIGlzIGNvbmZpZ3VyZWQuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzQW55UnVuQ2FsbGJhY2soY29uZmlnOiBDYWxsYmFja3NDb25maWcpOiBib29sZWFuIHtcbiAgcmV0dXJuIFJVTl9DQUxMQkFDS19FVkVOVFMuc29tZSgoZXZlbnQpID0+IGNvbmZpZ1tldmVudF0gIT09IHVuZGVmaW5lZCk7XG59XG5cbi8qKiBXaGV0aGVyIHRoZSBwZXItY3ljbGUgaGVhcnRiZWF0IGhvb2sgaXMgY29uZmlndXJlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNDeWNsZUNhbGxiYWNrKGNvbmZpZzogQ2FsbGJhY2tzQ29uZmlnKTogYm9vbGVhbiB7XG4gIHJldHVybiBjb25maWcuY3ljbGUgIT09IHVuZGVmaW5lZDtcbn1cblxuLyoqIFNob3J0IGRlc2NyaXB0aW9uIG9mIGEgdmFsdWUgZm9yIGFuIGVycm9yIG1lc3NhZ2UuICovXG5mdW5jdGlvbiBzaG93KHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gXCJhbiBhcnJheVwiO1xuICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiBcIm51bGxcIjtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikgcmV0dXJuIFwiYW4gb2JqZWN0XCI7XG4gIHJldHVybiBTdHJpbmcodmFsdWUpO1xufVxuXG4vKiogUE9TSVggYWJzb2x1dGUgcGF0aCDigJQgdGhlIG9ubHkgc2hhcGUgdGhlIGNvbnRhaW5lcidzIGZpbGVzeXN0ZW0gdXNlcy4gKi9cbmZ1bmN0aW9uIGlzQWJzb2x1dGVQYXRoKHBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gcGF0aC5zdGFydHNXaXRoKFwiL1wiKTtcbn1cblxuLyoqIFZhbGlkYXRlIG9uZSBob29rIHBhdGgsIHJldHVybmluZyB0aGUgdHJpbW1lZCB2YWx1ZSBvciBhbiBlcnJvciBtZXNzYWdlLiAqL1xuZnVuY3Rpb24gcGFyc2VIb29rUGF0aChcbiAgZXZlbnQ6IENhbGxiYWNrRXZlbnQsXG4gIHZhbHVlOiB1bmtub3duLFxuKTogUmVzdWx0PHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IGZpZWxkID0gYGNhbGxiYWNrcy4ke2V2ZW50fWA7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGAke2ZpZWxkfSBtdXN0IGJlIGEgc3RyaW5nIHBhdGggdG8gYW4gZXhlY3V0YWJsZSwgZ290ICR7XG4gICAgICAgIHNob3codmFsdWUpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG4gIGlmICh2YWx1ZS5pbmNsdWRlcyhcIlxcdTAwMDBcIikpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBgJHtmaWVsZH0gbXVzdCBub3QgY29udGFpbiBhIE5VTCBjaGFyYWN0ZXJgIH07XG4gIH1cbiAgY29uc3QgcGF0aCA9IHZhbHVlLnRyaW0oKTtcbiAgaWYgKHBhdGggPT09IFwiXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGAke2ZpZWxkfSBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggdG8gYW4gZXhlY3V0YWJsZWAsXG4gICAgfTtcbiAgfVxuICBpZiAoIWlzQWJzb2x1dGVQYXRoKHBhdGgpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOlxuICAgICAgICBgJHtmaWVsZH0gbXVzdCBiZSBhbiBhYnNvbHV0ZSBwYXRoIG9uIHRoZSB3b3JrZXIncyBmaWxlc3lzdGVtIChnb3QgJHtcbiAgICAgICAgICBzaG93KHBhdGgpXG4gICAgICAgIH0pOyBhIHJlbGF0aXZlIHBhdGggaXMgcmVqZWN0ZWQgYmVjYXVzZSB0aGUgd29ya2VyJ3Mgd29ya2luZyBgICtcbiAgICAgICAgYGRpcmVjdG9yeSBjaGFuZ2VzIGJldHdlZW4gcnVuc2AsXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHBhdGggfTtcbn1cblxuLyoqIFZhbGlkYXRlIGBjYWxsYmFja3MudGltZW91dF9zZWNvbmRzYC4gKi9cbmZ1bmN0aW9uIHBhcnNlVGltZW91dFNlY29uZHModmFsdWU6IHVua25vd24pOiBSZXN1bHQ8bnVtYmVyLCBzdHJpbmc+IHtcbiAgY29uc3QgZmllbGQgPSBcImNhbGxiYWNrcy50aW1lb3V0X3NlY29uZHNcIjtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IERFRkFVTFRfQ0FMTEJBQ0tfVElNRU9VVF9TRUNPTkRTIH07XG4gIH1cbiAgaWYgKFxuICAgIHR5cGVvZiB2YWx1ZSAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPD0gMCB8fFxuICAgIHZhbHVlID4gTUFYX0NBTExCQUNLX1RJTUVPVVRfU0VDT05EU1xuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6XG4gICAgICAgIGAke2ZpZWxkfSBtdXN0IGJlIGEgd2hvbGUgbnVtYmVyIG9mIHNlY29uZHMgYmV0d2VlbiAxIGFuZCAke01BWF9DQUxMQkFDS19USU1FT1VUX1NFQ09ORFN9LCBnb3QgJHtcbiAgICAgICAgICBzaG93KHZhbHVlKVxuICAgICAgICB9YCxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZSB9O1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIHRoZSByYXcgYGNhbGxiYWNrc2AgYmxvY2sgZnJvbSBgLmNvbmZpZy5qc29uYC5cbiAqXG4gKiBBYnNlbnQgb3IgbnVsbCB5aWVsZHMge0BsaW5rIG5vQ2FsbGJhY2tzfTsgZXZlcnkgb3RoZXIgZmF1bHQgaXMgcmVwb3J0ZWQsXG4gKiBuZXZlciByZXBhaXJlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ2FsbGJhY2tzQ29uZmlnKFxuICByYXc6IHVua25vd24sXG4pOiBSZXN1bHQ8Q2FsbGJhY2tzQ29uZmlnLCBzdHJpbmc+IHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdyA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogbm9DYWxsYmFja3MoKSB9O1xuICB9XG4gIGlmICh0eXBlb2YgcmF3ICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogYGNhbGxiYWNrcyBtdXN0IGJlIGFuIG9iamVjdCBvZiBob29rIHBhdGhzLCBnb3QgJHtzaG93KHJhdyl9YCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgYmxvY2sgPSByYXcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGNvbnN0IHVua25vd24gPSBPYmplY3Qua2V5cyhibG9jaykuZmlsdGVyKChrZXkpID0+ICFLTk9XTl9LRVlTLmluY2x1ZGVzKGtleSkpO1xuICBpZiAodW5rbm93bi5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgY2FsbGJhY2tzIGhhcyB1bmtub3duIGtleShzKSAke1xuICAgICAgICB1bmtub3duLm1hcCgoa2V5KSA9PiBKU09OLnN0cmluZ2lmeShrZXkpKS5qb2luKFwiLCBcIilcbiAgICAgIH07IHJlY29nbmlzZWQga2V5cyBhcmUgJHtLTk9XTl9LRVlTLmpvaW4oXCIsIFwiKX1gLFxuICAgIH07XG4gIH1cblxuICBjb25zdCB0aW1lb3V0ID0gcGFyc2VUaW1lb3V0U2Vjb25kcyhibG9jay50aW1lb3V0X3NlY29uZHMpO1xuICBpZiAoIXRpbWVvdXQub2spIHJldHVybiB0aW1lb3V0O1xuXG4gIGNvbnN0IGNvbmZpZzogQ2FsbGJhY2tzQ29uZmlnID0geyB0aW1lb3V0U2Vjb25kczogdGltZW91dC52YWx1ZSB9O1xuICBmb3IgKGNvbnN0IGV2ZW50IG9mIENBTExCQUNLX0VWRU5UUykge1xuICAgIGlmIChibG9ja1tldmVudF0gPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgY29uc3QgaG9vayA9IHBhcnNlSG9va1BhdGgoZXZlbnQsIGJsb2NrW2V2ZW50XSk7XG4gICAgaWYgKCFob29rLm9rKSByZXR1cm4gaG9vaztcbiAgICBjb25maWdbZXZlbnRdID0gaG9vay52YWx1ZTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGNvbmZpZyB9O1xufVxuXG4vKipcbiAqIHtAbGluayBwYXJzZUNhbGxiYWNrc0NvbmZpZ30sIGJ1dCB0aHJvd2luZyDigJQgdGhlIGZhaWwtbG91ZCBlbnRyeSBwb2ludCB1c2VkXG4gKiBhdCBjb25maWcgbG9hZCBzbyBhIG1hbGZvcm1lZCBibG9jayBzdG9wcyB0aGUgd29ya2VyIGJlZm9yZSBhbnkgaXNzdWUgaXNcbiAqIGNsYWltZWQgYWdhaW5zdCBhIGhvb2sgdGhhdCB3b3VsZCBuZXZlciBmaXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0Q2FsbGJhY2tzQ29uZmlnKHJhdzogdW5rbm93bik6IENhbGxiYWNrc0NvbmZpZyB7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlQ2FsbGJhY2tzQ29uZmlnKHJhdyk7XG4gIGlmICghcGFyc2VkLm9rKSB0aHJvdyBuZXcgRXJyb3IocGFyc2VkLmVycm9yKTtcbiAgcmV0dXJuIHBhcnNlZC52YWx1ZTtcbn1cblxuLyoqIFRoZSBob3N0LXNpZGUgdmlldyBvZiB0aGUgYmxvY2s6IGp1c3QgdGhlIGhvc3QgaG9vayBhbmQgaXRzIGJ1ZGdldC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEZhaWx1cmVDYWxsYmFja0NvbmZpZyB7XG4gIC8qKiBBYnNvbHV0ZSBob3N0IHBhdGggdG8gdGhlIGhvb2ssIHdoZW4gb25lIGlzIGNvbmZpZ3VyZWQuICovXG4gIHBhdGg/OiBzdHJpbmc7XG4gIC8qKiBXYWxsLWNsb2NrIGJ1ZGdldCBmb3IgdGhlIGhvb2ssIGluIHNlY29uZHMuICovXG4gIHRpbWVvdXRTZWNvbmRzOiBudW1iZXI7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgKipvbmx5KiogYGNhbGxiYWNrcy5ob3N0X2ZhaWx1cmVgIGFuZCBgY2FsbGJhY2tzLnRpbWVvdXRfc2Vjb25kc2BcbiAqIChJc3N1ZSAjMjEwNywgcGFyZW50ICMyMDg4KS5cbiAqXG4gKiBUaGUgaG9zdCBsYXVuY2hlciByZWFkcyB0aGUgY29uZmlnIGZpbGUgaXRzZWxmLCBiZWZvcmUgYW55IGNvbnRhaW5lclxuICogZXhpc3RzLCBhbmQgaXQgdXNlcyBleGFjdGx5IHRoZXNlIHR3byBrZXlzLiBWYWxpZGF0aW5nIHRoZSB3aG9sZSBibG9ja1xuICogdGhlcmUgd291bGQgZmFpbCB0aGUgaG9zdCBvbiBhIGNvbnRhaW5lci1vbmx5IGtleSBpdCBuZXZlciB0b3VjaGVzIOKAlCBhXG4gKiBgc3VjY2Vzc2AgaG9vayBwb2ludGluZyBhdCBhIHBhdGggb25seSB0aGUgY29udGFpbmVyIGNhbiBzZWUgaXMgY29ycmVjdFxuICogY29uZmlndXJhdGlvbiwgYW5kIG11c3Qgbm90IHN0b3AgdGhlIGhvc3QgaG9vayBmcm9tIGZpcmluZy4gU28gdGhlIHNhbWVcbiAqIHBhdGggYW5kIHRpbWVvdXQgcnVsZXMgYXJlIGFwcGxpZWQsIHRvIHRoZXNlIHR3byBrZXlzIGFsb25lLlxuICpcbiAqIEFuIGFic2VudCBgaG9zdF9mYWlsdXJlYCBpcyBub3QgYSBmYXVsdDogaXQgeWllbGRzIGBwYXRoOiB1bmRlZmluZWRgLCB3aGljaFxuICogdGhlIGNhbGxlciByZWFkcyBhcyBcIm5vIGhvc3QgaG9vayBjb25maWd1cmVkXCIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUhvc3RGYWlsdXJlQ2FsbGJhY2soXG4gIHJhd0NhbGxiYWNrczogdW5rbm93bixcbik6IFJlc3VsdDxIb3N0RmFpbHVyZUNhbGxiYWNrQ29uZmlnLCBzdHJpbmc+IHtcbiAgaWYgKHJhd0NhbGxiYWNrcyA9PT0gdW5kZWZpbmVkIHx8IHJhd0NhbGxiYWNrcyA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7IHRpbWVvdXRTZWNvbmRzOiBERUZBVUxUX0NBTExCQUNLX1RJTUVPVVRfU0VDT05EUyB9LFxuICAgIH07XG4gIH1cbiAgaWYgKHR5cGVvZiByYXdDYWxsYmFja3MgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShyYXdDYWxsYmFja3MpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgY2FsbGJhY2tzIG11c3QgYmUgYW4gb2JqZWN0IG9mIGhvb2sgcGF0aHMsIGdvdCAke1xuICAgICAgICBzaG93KHJhd0NhbGxiYWNrcylcbiAgICAgIH1gLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBibG9jayA9IHJhd0NhbGxiYWNrcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgdGltZW91dCA9IHBhcnNlVGltZW91dFNlY29uZHMoYmxvY2sudGltZW91dF9zZWNvbmRzKTtcbiAgaWYgKCF0aW1lb3V0Lm9rKSByZXR1cm4gdGltZW91dDtcblxuICBpZiAoYmxvY2suaG9zdF9mYWlsdXJlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgdGltZW91dFNlY29uZHM6IHRpbWVvdXQudmFsdWUgfSB9O1xuICB9XG4gIGNvbnN0IGhvb2sgPSBwYXJzZUhvb2tQYXRoKFwiaG9zdF9mYWlsdXJlXCIsIGJsb2NrLmhvc3RfZmFpbHVyZSk7XG4gIGlmICghaG9vay5vaykgcmV0dXJuIGhvb2s7XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHsgcGF0aDogaG9vay52YWx1ZSwgdGltZW91dFNlY29uZHM6IHRpbWVvdXQudmFsdWUgfSxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0ErQ0MsR0FJRDs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sNEJBQTRCO0VBQ3ZDO0VBQ0E7RUFDQTtFQUNBO0NBQ0QsQ0FBVTtBQUVYOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSxrQkFBa0I7S0FDMUI7RUFDSDtDQUNELENBQVU7QUFFWDs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sc0JBQXNCO0VBQUM7RUFBVztFQUFXO0NBQVMsQ0FBVTtBQUs3RSx3REFBd0QsR0FDeEQsT0FBTyxNQUFNLG1DQUFtQyxHQUFHO0FBRW5ELHVEQUF1RCxHQUN2RCxPQUFPLE1BQU0sK0JBQStCLEtBQUs7QUFFakQsa0RBQWtELEdBQ2xELE1BQU0sYUFBZ0M7S0FDakM7RUFDSDtDQUNEO0FBK0JELDhFQUE4RSxHQUM5RSxPQUFPLFNBQVM7RUFDZCxPQUFPO0lBQUUsZ0JBQWdCO0VBQWlDO0FBQzVEO0FBRUEsb0NBQW9DLEdBQ3BDLE9BQU8sU0FBUyxlQUFlLE1BQXVCO0VBQ3BELE9BQU8sZ0JBQWdCLElBQUksQ0FBQyxDQUFDLFFBQVUsTUFBTSxDQUFDLE1BQU0sS0FBSztBQUMzRDtBQUVBLGtEQUFrRCxHQUNsRCxPQUFPLFNBQVMsa0JBQWtCLE1BQXVCO0VBQ3ZELE9BQU8sb0JBQW9CLElBQUksQ0FBQyxDQUFDLFFBQVUsTUFBTSxDQUFDLE1BQU0sS0FBSztBQUMvRDtBQUVBLHdEQUF3RCxHQUN4RCxPQUFPLFNBQVMsaUJBQWlCLE1BQXVCO0VBQ3RELE9BQU8sT0FBTyxLQUFLLEtBQUs7QUFDMUI7QUFFQSx1REFBdUQsR0FDdkQsU0FBUyxLQUFLLEtBQWM7RUFDMUIsSUFBSSxPQUFPLFVBQVUsVUFBVSxPQUFPLEtBQUssU0FBUyxDQUFDO0VBQ3JELElBQUksTUFBTSxPQUFPLENBQUMsUUFBUSxPQUFPO0VBQ2pDLElBQUksVUFBVSxNQUFNLE9BQU87RUFDM0IsSUFBSSxPQUFPLFVBQVUsVUFBVSxPQUFPO0VBQ3RDLE9BQU8sT0FBTztBQUNoQjtBQUVBLDBFQUEwRSxHQUMxRSxTQUFTLGVBQWUsSUFBWTtFQUNsQyxPQUFPLEtBQUssVUFBVSxDQUFDO0FBQ3pCO0FBRUEsNkVBQTZFLEdBQzdFLFNBQVMsY0FDUCxLQUFvQixFQUNwQixLQUFjO0VBRWQsTUFBTSxRQUFRLENBQUMsVUFBVSxFQUFFLE9BQU87RUFDbEMsSUFBSSxPQUFPLFVBQVUsVUFBVTtJQUM3QixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sR0FBRyxNQUFNLDZDQUE2QyxFQUMzRCxLQUFLLFFBQ0w7SUFDSjtFQUNGO0VBQ0EsSUFBSSxNQUFNLFFBQVEsQ0FBQyxXQUFXO0lBQzVCLE9BQU87TUFBRSxJQUFJO01BQU8sT0FBTyxHQUFHLE1BQU0saUNBQWlDLENBQUM7SUFBQztFQUN6RTtFQUNBLE1BQU0sT0FBTyxNQUFNLElBQUk7RUFDdkIsSUFBSSxTQUFTLElBQUk7SUFDZixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sR0FBRyxNQUFNLDBDQUEwQyxDQUFDO0lBQzdEO0VBQ0Y7RUFDQSxJQUFJLENBQUMsZUFBZSxPQUFPO0lBQ3pCLE9BQU87TUFDTCxJQUFJO01BQ0osT0FDRSxHQUFHLE1BQU0sMERBQTBELEVBQ2pFLEtBQUssTUFDTiw0REFBNEQsQ0FBQyxHQUM5RCxDQUFDLDhCQUE4QixDQUFDO0lBQ3BDO0VBQ0Y7RUFDQSxPQUFPO0lBQUUsSUFBSTtJQUFNLE9BQU87RUFBSztBQUNqQztBQUVBLDBDQUEwQyxHQUMxQyxTQUFTLG9CQUFvQixLQUFjO0VBQ3pDLE1BQU0sUUFBUTtFQUNkLElBQUksVUFBVSxXQUFXO0lBQ3ZCLE9BQU87TUFBRSxJQUFJO01BQU0sT0FBTztJQUFpQztFQUM3RDtFQUNBLElBQ0UsT0FBTyxVQUFVLFlBQVksQ0FBQyxPQUFPLFNBQVMsQ0FBQyxVQUFVLFNBQVMsS0FDbEUsUUFBUSw4QkFDUjtJQUNBLE9BQU87TUFDTCxJQUFJO01BQ0osT0FDRSxHQUFHLE1BQU0saURBQWlELEVBQUUsNkJBQTZCLE1BQU0sRUFDN0YsS0FBSyxRQUNMO0lBQ047RUFDRjtFQUNBLE9BQU87SUFBRSxJQUFJO0lBQU07RUFBTTtBQUMzQjtBQUVBOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLHFCQUNkLEdBQVk7RUFFWixJQUFJLFFBQVEsYUFBYSxRQUFRLE1BQU07SUFDckMsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQWM7RUFDMUM7RUFDQSxJQUFJLE9BQU8sUUFBUSxZQUFZLE1BQU0sT0FBTyxDQUFDLE1BQU07SUFDakQsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLENBQUMsK0NBQStDLEVBQUUsS0FBSyxNQUFNO0lBQ3RFO0VBQ0Y7RUFFQSxNQUFNLFFBQVE7RUFDZCxNQUFNLFVBQVUsT0FBTyxJQUFJLENBQUMsT0FBTyxNQUFNLENBQUMsQ0FBQyxNQUFRLENBQUMsV0FBVyxRQUFRLENBQUM7RUFDeEUsSUFBSSxRQUFRLE1BQU0sR0FBRyxHQUFHO0lBQ3RCLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxDQUFDLDZCQUE2QixFQUNuQyxRQUFRLEdBQUcsQ0FBQyxDQUFDLE1BQVEsS0FBSyxTQUFTLENBQUMsTUFBTSxJQUFJLENBQUMsTUFDaEQsc0JBQXNCLEVBQUUsV0FBVyxJQUFJLENBQUMsT0FBTztJQUNsRDtFQUNGO0VBRUEsTUFBTSxVQUFVLG9CQUFvQixNQUFNLGVBQWU7RUFDekQsSUFBSSxDQUFDLFFBQVEsRUFBRSxFQUFFLE9BQU87RUFFeEIsTUFBTSxTQUEwQjtJQUFFLGdCQUFnQixRQUFRLEtBQUs7RUFBQztFQUNoRSxLQUFLLE1BQU0sU0FBUyxnQkFBaUI7SUFDbkMsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLFdBQVc7SUFDaEMsTUFBTSxPQUFPLGNBQWMsT0FBTyxLQUFLLENBQUMsTUFBTTtJQUM5QyxJQUFJLENBQUMsS0FBSyxFQUFFLEVBQUUsT0FBTztJQUNyQixNQUFNLENBQUMsTUFBTSxHQUFHLEtBQUssS0FBSztFQUM1QjtFQUNBLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztFQUFPO0FBQ25DO0FBRUE7Ozs7Q0FJQyxHQUNELE9BQU8sU0FBUyxzQkFBc0IsR0FBWTtFQUNoRCxNQUFNLFNBQVMscUJBQXFCO0VBQ3BDLElBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRSxNQUFNLElBQUksTUFBTSxPQUFPLEtBQUs7RUFDNUMsT0FBTyxPQUFPLEtBQUs7QUFDckI7QUFVQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxTQUFTLHlCQUNkLFlBQXFCO0VBRXJCLElBQUksaUJBQWlCLGFBQWEsaUJBQWlCLE1BQU07SUFDdkQsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPO1FBQUUsZ0JBQWdCO01BQWlDO0lBQzVEO0VBQ0Y7RUFDQSxJQUFJLE9BQU8saUJBQWlCLFlBQVksTUFBTSxPQUFPLENBQUMsZUFBZTtJQUNuRSxPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sQ0FBQywrQ0FBK0MsRUFDckQsS0FBSyxlQUNMO0lBQ0o7RUFDRjtFQUVBLE1BQU0sUUFBUTtFQUNkLE1BQU0sVUFBVSxvQkFBb0IsTUFBTSxlQUFlO0VBQ3pELElBQUksQ0FBQyxRQUFRLEVBQUUsRUFBRSxPQUFPO0VBRXhCLElBQUksTUFBTSxZQUFZLEtBQUssV0FBVztJQUNwQyxPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87UUFBRSxnQkFBZ0IsUUFBUSxLQUFLO01BQUM7SUFBRTtFQUM5RDtFQUNBLE1BQU0sT0FBTyxjQUFjLGdCQUFnQixNQUFNLFlBQVk7RUFDN0QsSUFBSSxDQUFDLEtBQUssRUFBRSxFQUFFLE9BQU87RUFDckIsT0FBTztJQUNMLElBQUk7SUFDSixPQUFPO01BQUUsTUFBTSxLQUFLLEtBQUs7TUFBRSxnQkFBZ0IsUUFBUSxLQUFLO0lBQUM7RUFDM0Q7QUFDRiJ9
// denoCacheMetadata=2766029298253767303,10851638414770574668