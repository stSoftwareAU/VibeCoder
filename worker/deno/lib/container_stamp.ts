/**
 * "Am I running inside the worker container image?" — one rule (Issue #1262).
 *
 * The container build stamps the provider set it installed into
 * {@linkcode CONTAINER_IMAGE_STAMP_ENV}, and no host run has it. Every
 * reader spelled the test as `env(...) !== undefined`, a *presence* test,
 * which `VIBE_IMAGE_AGENT_PROVIDERS=` (the empty string) satisfies.
 *
 * That is a mode switch a blank value must not flip. The sharpest case is
 * the `gh` credential fallback in `service_account_env.ts`: in container mode
 * a configured-but-missing `gh_config_dir` falls back to the staged copy,
 * whose first candidate is the ambient `GH_CONFIG_DIR` — so a blank stamp on
 * a HOST run turned a loud failure into a silent fall-through to whatever
 * credential the ambient environment carried (the Issue #3530 leak). The
 * setup suites already encode the intended reading of a blank value: they
 * set it to `""` precisely to simulate a host run.
 *
 * So the rule is value, not presence: the stamp counts only when it is
 * non-blank, and a blank stamp reads exactly like an absent one — host.
 *
 * Every container-mode reader in the worker now asks this module rather than
 * spelling the test itself (Issue #1493): `service_account_env.ts`,
 * `stuck_issue_detector.ts`, `agent_provider.ts`, `run_housekeeping.ts`,
 * `claude_env.ts`, `crash_notification.ts`, `disk_space.ts`,
 * `software_updates.ts`, `prompt_immutability.ts`, `unit_test_passes.ts`
 * and `commands/benchmark.ts`. The two modules that had their own name for
 * the variable — `IN_IMAGE_ENV` and `CONTAINER_MARKER_VAR` — alias
 * {@linkcode CONTAINER_IMAGE_STAMP_ENV} so they cannot drift from it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** The provider set the image was built with, stamped in by the build. */
export const CONTAINER_IMAGE_STAMP_ENV = "VIBE_IMAGE_AGENT_PROVIDERS";

/**
 * True when the run carries a non-blank container image stamp.
 *
 * @param env - Environment lookup (defaults to the process environment).
 * @returns `true` only for a stamp with non-whitespace content; `false` when
 *   the variable is absent, empty, or whitespace — all of which are a host
 *   run as far as every container-only behaviour is concerned.
 */
export function runningInContainerImage(
  env: EnvLookup = processEnvLookup,
): boolean {
  return (env(CONTAINER_IMAGE_STAMP_ENV) ?? "").trim() !== "";
}
