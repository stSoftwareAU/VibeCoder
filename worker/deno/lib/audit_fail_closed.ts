/**
 * Fail-closed properties of the scheduled dependency audit (Issue #3955).
 *
 * `deno audit --ignore-registry-errors` returns exit code 0 when the remote
 * advisory service responds with an error. On the weekly scheduled run that
 * turned an outage into a green job that had checked nothing: the
 * `Notify on scheduled audit failure` step is gated on `failure()`, so
 * nothing fired, and nothing else audits `deno.lock` — Renovate's deno
 * manager is deliberately disabled (Issue #2536). "Did not audit" was
 * indistinguishable from "audited, clean".
 *
 * Two pure helpers live here, both exported so they can be tested against
 * literal inputs:
 *
 *   - `auditOptOutFlags` / `isAuditFailClosed` — does an audit command line
 *     carry a flag that converts a registry error into a pass? Used by the
 *     config guard test to hold the invariant across `deno.json` and the
 *     workflow.
 *   - `classifyAuditFailure` — given the audit output, was the failure an
 *     unreachable advisory service ("did not audit") or a genuine advisory
 *     ("audited, vulnerable")? The notifier uses this so the tracking issue
 *     states which happened.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/**
 * Flags that make `deno audit` exit 0 when the advisory service errors.
 * Any of these on the audit command line breaks the fail-closed posture.
 */
export const REGISTRY_ERROR_OPT_OUT_FLAGS: readonly string[] = [
  "--ignore-registry-errors",
];

/**
 * Return every registry-error opt-out flag present in `command`, in the
 * order declared by `REGISTRY_ERROR_OPT_OUT_FLAGS`. An empty result means
 * the command is fail-closed.
 *
 * `command` may be a whole shell block (a workflow `run:` body), so the
 * search is token-based rather than anchored: `--ignore-registry-errors`,
 * `--ignore-registry-errors=true` and the same flag buried in a `&&` chain
 * all match, while a longer flag that merely shares the prefix does not.
 */
export function auditOptOutFlags(command: string): string[] {
  const tokens = command
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, "").split("=")[0] ?? "");
  return REGISTRY_ERROR_OPT_OUT_FLAGS.filter((flag) => tokens.includes(flag));
}

/** True when `command` runs the audit without a registry-error opt-out. */
export function isAuditFailClosed(command: string): boolean {
  return auditOptOutFlags(command).length === 0;
}

/**
 * Why a dependency audit failed.
 *
 * `advisory` — the audit ran and a committed dependency has a known
 * advisory. `registry-unreachable` — the advisory service did not answer,
 * so nothing was audited.
 */
export type AuditFailureMode = "advisory" | "registry-unreachable";

/** Substrings that positively identify an unreachable advisory service. */
const REGISTRY_ERROR_MARKERS: readonly string[] = [
  "failed to get data from the registry",
  "error sending request",
  "error trying to connect",
  "tcp connect error",
  "connection refused",
  "connection reset",
  "connection closed",
  "network is unreachable",
  "dns error",
  "timed out",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "internal server error",
  "too many requests",
];

/** An HTTP status line reporting a 429 or any 5xx from the service. */
const REGISTRY_STATUS_RE = /\b(?:status(?: code)?:?\s*)?(?:429|5\d{2})\b/i;

/**
 * Classify a failed audit from its combined stdout/stderr.
 *
 * Returns `registry-unreachable` only on positive evidence of a transport
 * or service failure; anything else — including empty or unrecognised
 * output — reads as `advisory`, the more urgent remediation. Either way the
 * job is already red, so the classification only decides which tracking
 * issue the notifier files.
 */
export function classifyAuditFailure(output: string): AuditFailureMode {
  const text = output.toLowerCase();
  if (REGISTRY_ERROR_MARKERS.some((marker) => text.includes(marker))) {
    return "registry-unreachable";
  }
  // A bare status code only counts alongside an explicit error line, so a
  // package version such as `1.503.0` in an advisory listing cannot be read
  // as a 5xx response.
  if (text.includes("response") && REGISTRY_STATUS_RE.test(text)) {
    return "registry-unreachable";
  }
  return "advisory";
}
