/**
 * Journals a babysitter repair attempt that delivered no push (Issue #4658).
 *
 * A repair attempt that ends without a push (agent failure, an infrastructure,
 * capability or race cooldown, or an agent that made no change) is recorded as
 * a verified, failed `repair` in the audit journal. The collector then measures
 * the wait until the next confirmed repair or verified fleet dismissal as a `repair-recovery` interval,
 * rather than leaving the cooldown unmeasured. Owner holds and failures after a
 * push are not journalled by the caller.
 *
 * Best-effort, like the other journalling hooks: this never throws, and a
 * refused append is logged loud rather than swallowed (Issue #3234). Invalid
 * input is refused and logged, so the journal never records garbage.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { recordMutation, resolveRunId } from "./audit_journal.ts";
import { type AuditHookOptions, isAuditJournalEnabled } from "./audit_hook.ts";
import { processEnvLookup } from "./env_lookup.ts";

/** The repair attempt's identity, as the babysitter knows it. */
export interface BabysitterAttempt {
  /** `owner/name` of the repository. */
  repo: string;
  /** The PR number the attempt was repairing. */
  prNumber: number;
  /** The head SHA the attempt started from. */
  headSha: string;
}

/** Same shape as `PR_REPO_PATTERN` in pr_completion_report.ts. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;
const CALLER = "worker/deno/commands/fleet_pr_babysitter.ts";
const VERB = "babysitter-attempt";

function refuse(message: string): void {
  console.error(`[SECURITY] [AUDIT_JOURNAL_REFUSED] ${VERB}: ${message}`);
}

/**
 * Journal a repair attempt that delivered no push as a failed repair.
 *
 * Recorded as `component: "babysitter"`, `actionKind: "repair"`,
 * `outcome: "error"`, so the collector reads it as a failed, verified repair
 * and measures the wait until the next confirmed repair.
 *
 * @param attempt - The repository, PR number and head the attempt started from.
 * @param opts - Injected gating, identity and storage location (Issue #963).
 *   Omit in production: every field defaults to the process environment.
 */
export async function journalBabysitterAttempt(
  attempt: BabysitterAttempt,
  opts: AuditHookOptions = {},
): Promise<void> {
  const env = opts.env ?? processEnvLookup;
  if (!isAuditJournalEnabled(env)) return;
  try {
    if (
      typeof attempt.repo !== "string" || !REPO_PATTERN.test(attempt.repo)
    ) {
      refuse(`invalid repo ${JSON.stringify(attempt.repo)}; not recorded`);
      return;
    }
    if (
      !Number.isSafeInteger(attempt.prNumber) || attempt.prNumber <= 0
    ) {
      refuse(`invalid PR number ${attempt.prNumber}; not recorded`);
      return;
    }
    if (
      typeof attempt.headSha !== "string" ||
      !HEAD_SHA_PATTERN.test(attempt.headSha)
    ) {
      refuse("invalid head SHA; not recorded");
      return;
    }
    const result = await recordMutation({
      actionId: crypto.randomUUID(),
      component: "babysitter",
      actionKind: "repair",
      caller: CALLER,
      repo: attempt.repo,
      prNumber: attempt.prNumber,
      headSha: attempt.headSha,
      verb: VERB,
      target: String(attempt.prNumber),
      outcome: "error",
      runId: opts.runId ?? resolveRunId(env),
    }, opts);
    if (!result.ok) {
      console.error(
        `[SECURITY] [AUDIT_JOURNAL_REFUSED] ${VERB}: ${result.error.message}`,
      );
    }
  } catch (err) {
    // Best-effort: never let journalling perturb the repair — but say so.
    console.error(
      `[SECURITY] [AUDIT_JOURNAL_REFUSED] ${VERB}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
