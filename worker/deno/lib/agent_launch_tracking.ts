/**
 * Records every agent launch an issue run makes through the runner seam, so
 * the post-run callback can name the provider that served it (Issue #5163).
 *
 * `trackAgentLaunches` wraps `deps.claude.runClaudeWithRetry`, the one seam
 * the execute phase, quality-gate fix agent and gate retries launch through.
 * Orchestrated runs get the wrapped function passed in, so each call counts
 * once. A launch that fails or throws is still recorded, with no provider
 * unless the error carries a billed result.
 *
 * Deliberately not counted, as they do not go through that seam: the pre-PR
 * verifier (`runPrePrVerifier`), the clarity assessment (a direct import in
 * `lib/clarity_assessment.ts`) and a resumed stream session's `/compact` prime
 * (`primeStreamCompaction`). They are review, assessment and housekeeping
 * runs, not issue work.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { WorkerDeps } from "./issue_worker_wiring.ts";
import type { AgentLaunch } from "./run_callback_telemetry.ts";
import { billedResultOfError } from "./failed_invocation_result.ts";

/** A shallow copy of `deps` that appends each runner launch to `launches`. */
export function trackAgentLaunches(
  deps: WorkerDeps,
  launches: AgentLaunch[],
): WorkerDeps {
  const run = deps.claude.runClaudeWithRetry;
  const record = (provider: string | undefined) =>
    launches.push(provider === undefined ? {} : { provider });
  const wrapped = (async (...args: Parameters<typeof run>) => {
    let result;
    try {
      result = await run(...args);
    } catch (error) {
      record(undefined);
      throw error;
    }
    record(
      result.ok
        ? result.value.runStats?.provider
        : billedResultOfError(result.error)?.runStats?.provider,
    );
    return result;
  }) as typeof run;
  return { ...deps, claude: { ...deps.claude, runClaudeWithRetry: wrapped } };
}
