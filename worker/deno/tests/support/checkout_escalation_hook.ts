/**
 * Shared fixtures for the checkout update's `callbacks.host_failure`
 * escalation (Issue #2110).
 *
 * The update no longer files a GitHub issue: it hands a `checkout_update`
 * payload to the operator's hook and reads the invocation's status. The two
 * unit suites that drive `updateCheckout` share the hook config and the
 * canned invocations from here rather than re-declaring — and re-drifting —
 * them. (`worker_checkout_update_test.ts` drives a real shell hook instead,
 * because the command-level test is the one that must prove the spawn.)
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type {
  CallbackInvocation,
  CallbackStatus,
} from "../../lib/run_callbacks.ts";
import type { HostFailureHookConfig } from "../../lib/host_failure_hook.ts";

/** The hook command a configured host names. */
export const HOOK_PATH = "/opt/vibe/host-failure.sh";

/** A configured hook, as a targeted read of `.config.json` reports one. */
export const CONFIGURED_HOOK: HostFailureHookConfig = {
  kind: "hook",
  path: HOOK_PATH,
  timeoutSeconds: 30,
};

/**
 * One invocation of that hook, as `invokeCallback` reports it.
 *
 * @param status - What the hook did; `ok` is the only status that delivers
 * @returns The invocation record the escalate seam returns
 */
function hookInvocation(status: CallbackStatus): CallbackInvocation {
  return {
    event: "host_failure",
    path: HOOK_PATH,
    status,
    exitCode: status === "ok" ? 0 : 1,
    stdout: "",
    stderr: status === "ok" ? "" : "the hook could not run",
    durationMs: 5,
  };
}

/** The hook took delivery. */
export const HOOK_OK: CallbackInvocation = hookInvocation("ok");

/** The hook ran and failed — the report did not land. */
export const HOOK_FAILED: CallbackInvocation = hookInvocation("failed");
