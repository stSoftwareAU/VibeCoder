/**
 * Dispatch a `pr`-phase custom label against a raised PR (Issue #1011, part
 * of #938).
 *
 * A trusted account applies the operator's private label to an open PR; this
 * runs it. The PR head branch is checked out — a full working tree plus `gh`,
 * as a PR-feedback run has — the operator's prompt is built, an agent runs it,
 * and one outcome comment lands on the PR. What the run *does* is the private
 * prompt's business: comment, commit, push.
 *
 * ## One shot per label application
 *
 * Issue-phase custom dispatch has none of the `work-on` eligibility gates, so
 * a mapping that keeps matching keeps re-dispatching every cycle (Issue #937).
 * The PR-phase answer is to **consume** the label: removing it removes the
 * condition that caused the dispatch, so the loop cannot form.
 *
 * The label is consumed **before** the agent runs, and before the operator's
 * template is even read. A run that crashes, is killed by the watchdog, or
 * dies with the container must not leave the trigger in place for the next
 * cycle — that is the loop, reintroduced by the failure path. The worst case
 * is therefore one lost run the developer re-triggers by re-applying the
 * label, rather than an unbounded series of them; a persistently broken
 * operator prompt costs one refusal comment, not one every cycle.
 *
 * That ordering is the one place this module departs from the numbered steps
 * in #1011, which put template validation ahead of removal. Validating first
 * satisfies the same acceptance bullets but re-forms the loop on the failure
 * half — a broken prompt file would comment on the PR every cycle, forever.
 *
 * ## Fail loud, never fall back
 *
 * A missing, empty or placeholder-incomplete operator file refuses the run
 * naming the label and the path, and says so on the PR. The built-in
 * `pr_feedback` template is never substituted for it: the operator's label
 * must not silently run someone else's prompt. The PR comment *is* the
 * detection surface — the operator's prompt file lives outside this
 * repository, so no test here can catch its breakage.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Logger, Result } from "../types.ts";
import type { CustomLabelPrCandidate } from "./custom_label_pr_finder.ts";
import type { PreparePrBranchOutcome } from "./pr_branch_preparation.ts";
import type { PromptParts } from "./prompt_builder.ts";
import type { PushVerification } from "./push_claim_verification.ts";
import { formatVerifiedPushSuffix } from "./push_claim_verification.ts";
import { redactSecrets } from "./secret_redaction.ts";

/**
 * Dependencies for one PR-phase dispatch pass.
 *
 * Every external effect is a seam, so the suite drives the whole flow — and
 * its call ordering — without a network, a checkout or an agent.
 */
export interface CustomLabelPrDispatchDeps {
  logger: Logger;
  /** `gh` runner, used for the label removal and the outcome comment. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Discovery. Production: `findCustomLabelPrCandidates`. */
  findCandidates: () => Promise<CustomLabelPrCandidate[]>;
  /** Check out the PR head branch. Production: `preparePrBranch`. */
  checkout: (
    candidate: CustomLabelPrCandidate,
  ) => Promise<PreparePrBranchOutcome>;
  /**
   * Build the run's prompt. Production: `buildCustomPrPrompt`, which loads and
   * validates the operator's template, so a broken file surfaces here.
   */
  buildPrompt: (
    candidate: CustomLabelPrCandidate,
  ) => Promise<Result<PromptParts>>;
  /** Run the agent. Rejects on failure. */
  runAgent: (
    candidate: CustomLabelPrCandidate,
    parts: PromptParts,
  ) => Promise<void>;
  /** Confirm the branch's local head is what the remote has. */
  verifyPush: (
    candidate: CustomLabelPrCandidate,
  ) => Promise<PushVerification>;
  /** The calling handler's watchdog deadline, honoured before the agent runs. */
  deadlineEpochMs?: number;
}

/**
 * Work the first trusted `pr`-phase candidate, one shot.
 *
 * @param deps - Discovery, `gh`, checkout, prompt, agent and push seams
 * @returns Whether a candidate was worked this pass
 */
export async function dispatchCustomLabelPrPrompts(
  deps: CustomLabelPrDispatchDeps,
): Promise<{ processed: boolean }> {
  const { logger } = deps;

  const candidates = await deps.findCandidates();
  const candidate = candidates[0];
  if (candidate === undefined) return { processed: false };

  const { repo, prNumber, mapping } = candidate;
  logger.info(
    `Dispatching ${repo}#${prNumber} for the '${mapping.label}' PR-phase ` +
      `custom label (${mapping.promptPath})`,
  );

  // Consume the label first — see the module comment. Everything after this
  // point reports its outcome as a PR comment, because the trigger is gone.
  await removeLabel(candidate, deps);

  if (
    deps.deadlineEpochMs !== undefined && Date.now() >= deps.deadlineEpochMs
  ) {
    await comment(
      candidate,
      deps,
      failureBody(
        candidate,
        "the handler's watchdog deadline passed before the run could start",
      ),
    );
    return { processed: true };
  }

  const prompt = await deps.buildPrompt(candidate);
  if (!prompt.ok) {
    logger.error(
      `Refusing to run ${repo}#${prNumber} for custom label ` +
        `'${mapping.label}': ${prompt.error.message}`,
    );
    await comment(
      candidate,
      deps,
      failureBody(
        candidate,
        `the prompt file could not be used — ${prompt.error.message}`,
      ),
    );
    return { processed: true };
  }

  const checkout = await deps.checkout(candidate);
  if (!checkout.ok) {
    await comment(
      candidate,
      deps,
      failureBody(
        candidate,
        `the PR head branch '${candidate.headRefName}' could not be prepared ` +
          `(${checkout.reason}): ${checkout.detail}`,
      ),
    );
    return { processed: true };
  }

  try {
    await deps.runAgent(candidate, prompt.value);
  } catch (error) {
    await comment(
      candidate,
      deps,
      failureBody(
        candidate,
        `the run failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return { processed: true };
  }

  // A commit the agent made but did not push leaves the local head ahead of
  // the remote, so this answers "did anything it claimed actually land?"
  // without local state being allowed to vouch for itself (Issue #579).
  const verification = await deps.verifyPush(candidate);
  if (!verification.landed) {
    await comment(
      candidate,
      deps,
      failureBody(
        candidate,
        `the run finished but its work is not on the remote: ` +
          `${verification.reason}`,
      ),
    );
    return { processed: true };
  }

  await comment(
    candidate,
    deps,
    `✅ Ran the \`${mapping.label}\` custom prompt against this PR.` +
      formatVerifiedPushSuffix(verification) +
      `\n\nThe label was consumed by this run — re-apply it to run again.`,
  );
  return { processed: true };
}

/**
 * Remove the dispatching label from the PR.
 *
 * `GitHubClient.removeLabel` shells `gh issue edit`, which does not resolve a
 * PR number, so this uses the labels endpoint directly — the same call
 * `clearMergeConflictLabel` makes. A PR *is* an issue to that endpoint.
 */
async function removeLabel(
  candidate: CustomLabelPrCandidate,
  deps: CustomLabelPrDispatchDeps,
): Promise<void> {
  const { repo, prNumber, mapping } = candidate;
  try {
    await deps.ghCommandFn([
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/${prNumber}/labels/${mapping.label}`,
    ]);
  } catch (error) {
    // Surfaced, never swallowed: a removal that failed means the next cycle
    // may re-dispatch, which is exactly what the operator needs to know.
    deps.logger.error(
      `Could not consume the '${mapping.label}' label on ${repo}#${prNumber} ` +
        `— the next cycle may dispatch it again: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
}

/** The failure comment body, naming the label and how to retry. */
function failureBody(
  candidate: CustomLabelPrCandidate,
  detail: string,
): string {
  return `❌ The \`${candidate.mapping.label}\` custom prompt did not run to ` +
    `completion: ${detail}\n\nThe label was consumed by this attempt — ` +
    `re-apply \`${candidate.mapping.label}\` to retry once the cause is fixed.`;
}

/** Post one outcome comment on the PR, redacted like every outbound sink. */
async function comment(
  candidate: CustomLabelPrCandidate,
  deps: CustomLabelPrDispatchDeps,
  body: string,
): Promise<void> {
  const { repo, prNumber } = candidate;
  try {
    await deps.ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      redactSecrets(body),
    ]);
  } catch (error) {
    deps.logger.error(
      `Could not comment the outcome of the '${candidate.mapping.label}' run ` +
        `on ${repo}#${prNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
}
