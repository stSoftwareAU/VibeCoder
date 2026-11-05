/**
 * Bound on rounds a lane spends while the repository's own gate keeps
 * deferring or rejecting its publication (Issue #4625, PR #4800 review).
 *
 * The spelling and feedback scanners have no retry cap of their own, so a
 * host that cannot run the gate (no Docker, a missing tool, a credential
 * fault) would otherwise start a full agent session every cycle for as long
 * as the fault lasts. Each lane counts one round per key; once the budget is
 * spent the lane skips the agent session and waits for the key to change. A
 * key names the thing that changes when the situation does (a new check run,
 * or a new head), so a push resets the budget. A state directory that cannot
 * be written fails open and loud, as the CI retry counter does.
 */

import { getCiCheckRetryCount, recordCiCheckRetry } from "./pr_ci_checks.ts";

/** Rounds a lane spends on one key before it stands down. */
export const MAX_PUBLICATION_DEFERRALS = 3;

function stateDirFor(workRoot: string): string {
  return `${workRoot}/.publication_deferrals`;
}

/** Keys become file names: keep a conservative alphabet. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Whether `key` has already used its rounds. */
export async function publicationDeferralBudgetSpent(
  workRoot: string,
  repo: string,
  key: string,
): Promise<boolean> {
  return (await getCiCheckRetryCount(
    stateDirFor(workRoot),
    repo,
    safeKey(key),
  )) >= MAX_PUBLICATION_DEFERRALS;
}

/** Charge one round to `key`; returns the rounds spent so far. */
export function recordPublicationDeferral(
  workRoot: string,
  repo: string,
  key: string,
): Promise<number> {
  return recordCiCheckRetry(stateDirFor(workRoot), repo, safeKey(key));
}

function failureFile(workRoot: string, repo: string, key: string): string {
  return `${stateDirFor(workRoot)}/${repo.replace("/", "_")}_${
    safeKey(key)
  }.failure`;
}

/**
 * Keep the output of a gate that rejected a head, so the next round for the
 * same key can show it to the agent. It is untrusted text: the reader fences it.
 */
export async function saveRejectedPublicationOutput(
  workRoot: string,
  repo: string,
  key: string,
  output: string,
): Promise<void> {
  try {
    await Deno.mkdir(stateDirFor(workRoot), { recursive: true });
    await Deno.writeTextFile(failureFile(workRoot, repo, key), output);
  } catch (error) {
    console.error(
      `[publication] could not keep the rejected gate output for ${repo} ` +
        `(${key}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The output kept by {@link saveRejectedPublicationOutput}, or undefined. */
export async function loadRejectedPublicationOutput(
  workRoot: string,
  repo: string,
  key: string,
): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(failureFile(workRoot, repo, key));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}
