/**
 * Independent verification of the fleet PR babysitter's review fixes (Issue #4657).
 *
 * Before a babysitter dismisses a review as fixed, every finding of that review
 * is judged by the pre-PR verifier against the live PR description at the head.
 * The repair agent's final reply is untrusted evidence: it is shown to the
 * verifier, never taken as the decision. The verifier model runs with a
 * read-only token and no Bash, never the runner's write token (see
 * {@link VerifierCredentials}); an outage is flagged `unavailable` so the caller
 * retries without re-running the agent.
 */
import type { Logger } from "../types.ts";
import {
  type EarlierVerdict,
  extractEarlierFindings,
} from "./earlier_findings.ts";
import {
  defaultPrePrVerifierDeps,
  type PrePrVerifierDeps,
  type PrePrVerifierResult,
  runPrePrVerifier,
} from "./pre_pr_verifier.ts";

/** Same summary path the worker's review-fix verifier uses (pr_feedback_verifier.ts). */
const SUMMARY_PATH = "docs/archive/pr-summaries/feedback-verifier-pr-body.md";
const NO_FINDINGS =
  "no findings could be read from the review, so nothing can be verified";

export interface ReviewToVerify {
  id: number;
  body?: string | null;
}

/** verified=true means every finding of that review was independently judged fixed; reason is the verdict notes or why it stays open. */
export interface ReviewVerificationOutcome {
  id: number;
  verified: boolean;
  reason: string;
  /**
   * True when the verifier could not judge (it was not checked, failed, or had
   * no credential), as opposed to judging the review not fixed. An outage is
   * retried without running the agent again; a judgement is not.
   */
  unavailable?: boolean;
}

export interface ReviewVerificationInput {
  repo: string;
  prNumber: number;
  repoPath: string;
  title: string;
  /** The live PR description as published at the head being verified. */
  body: string;
  /** e.g. origin/main */
  baseRef: string;
  reviews: readonly ReviewToVerify[];
  /** The repair agent's own final reply: untrusted evidence, never proof. */
  agentReply?: string;
  timeoutSeconds: number;
  logger: Logger;
}

/** What the verifier's Claude child is allowed to hold (Issue #4657). */
export interface VerifierCredentials {
  /** The child's parent environment, carrying a read-only token as GH_TOKEN. */
  parentEnv: Record<string, string>;
  /** Tools denied beyond the pre-PR verifier's own list. */
  disallowedTools: readonly string[];
}

export interface ReviewVerificationDeps {
  verify?: typeof runPrePrVerifier;
  verifierDeps?: PrePrVerifierDeps;
  /**
   * Mints the verifier's read-only credential. Required for the real verifier:
   * without it (and without a `verify` stand-in) the pass is an outage, so the
   * runner's own write token is never inherited by the model.
   */
  credentials?: () => Promise<VerifierCredentials>;
}

/** The verifier pass: its verdicts, or why it could not run (full reason text). */
type PassResult =
  | { kind: "unavailable"; reason: string }
  | { kind: "checked"; verdicts: readonly EarlierVerdict[] };

/** Judge one finding (verifier numbering) from the verdicts the pass returned. */
function judgeFinding(
  n: number,
  verdicts: readonly EarlierVerdict[],
): { fixed: true; note: string } | { fixed: false; problem: string } {
  const matches = verdicts.filter((v) => v.index === n);
  if (matches.length === 0) {
    return {
      fixed: false,
      problem: `the verifier returned no verdict for finding ${n}`,
    };
  }
  if (matches.length > 1) {
    return {
      fixed: false,
      problem: `the verifier returned more than one verdict for finding ${n}`,
    };
  }
  const v = matches[0]!;
  if (v.verdict === "fixed") return { fixed: true, note: v.note.trim() };
  return {
    fixed: false,
    problem: `finding ${n} verdict "${v.verdict}": ${v.note.trim()}`,
  };
}

/**
 * Run one verifier pass over every finding of every review. Returns the
 * verdicts, or the outage reason; never throws.
 */
async function runPass(
  input: ReviewVerificationInput,
  deps: ReviewVerificationDeps,
  previousFindings: readonly string[],
): Promise<PassResult> {
  try {
    if (deps.verify === undefined && deps.credentials === undefined) {
      return {
        kind: "unavailable",
        reason:
          "verifier unavailable: no read-only credential was provided, so the model is not started with the runner's token",
      };
    }
    const credentials = await deps.credentials?.();
    const result: PrePrVerifierResult = await (deps.verify ??
      runPrePrVerifier)({
        repo: input.repo,
        issueNumber: input.prNumber,
        issueTitle: input.title,
        issueBody:
          `${input.body}\n\nAgent reply (untrusted evidence to verify independently):\n${
            input.agentReply ?? ""
          }`,
        repoPath: input.repoPath,
        baseRef: input.baseRef,
        summaryPath: SUMMARY_PATH,
        summaryContent: input.body,
        changedFiles: null,
        previousFindings,
        timeoutSeconds: input.timeoutSeconds,
        // Read-only: no shell, no edit, no project settings (Issue #4657).
        readOnly: true,
        ...(credentials === undefined ? {} : {
          parentEnv: credentials.parentEnv,
          extraDisallowedTools: credentials.disallowedTools,
        }),
        logger: input.logger,
      }, deps.verifierDeps ?? defaultPrePrVerifierDeps);
    if (result.status === "not_checked") {
      input.logger.warn(
        "Babysitter review verifier not checked: reviews stay open (Issue #4657)",
        {
          repo: input.repo,
          prNumber: input.prNumber,
          reason: result.reason,
        },
      );
      return {
        kind: "unavailable",
        reason: `verifier unavailable: ${result.reason}`,
      };
    }
    return { kind: "checked", verdicts: result.review.earlierFindings ?? [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logger.error(
      "Babysitter review verifier failed: reviews stay open (Issue #4657)",
      { repo: input.repo, prNumber: input.prNumber, error: message },
    );
    return { kind: "unavailable", reason: `verifier failed: ${message}` };
  }
}

/**
 * Judge each review independently (Issue #4657). A review is verified only when
 * it has at least one readable finding and every finding has exactly one
 * verdict, and that verdict is `fixed`. The verifier's own new findings never
 * un-verify a review. An outage (verifier not checked, or thrown) keeps every
 * readable review open, so this fails closed and never throws. Returns one
 * outcome per input review, in input order.
 */
export async function verifyBabysitterReviews(
  input: ReviewVerificationInput,
  deps: ReviewVerificationDeps = {},
): Promise<ReviewVerificationOutcome[]> {
  // Flatten every review's findings into one numbered list (1-based), keeping
  // the global numbers each review owns.
  const previousFindings: string[] = [];
  const ownedIndices: number[][] = input.reviews.map((review) => {
    const owned: number[] = [];
    for (const finding of extractEarlierFindings(review.body ?? "")) {
      previousFindings.push(finding);
      owned.push(previousFindings.length);
    }
    return owned;
  });

  const pass: PassResult | null = previousFindings.length > 0
    ? await runPass(input, deps, previousFindings)
    : null;

  return input.reviews.map((review, position) => {
    const owned = ownedIndices[position]!;
    if (owned.length === 0) {
      return { id: review.id, verified: false, reason: NO_FINDINGS };
    }
    if (pass === null || pass.kind === "unavailable") {
      return {
        id: review.id,
        verified: false,
        reason: pass?.kind === "unavailable"
          ? pass.reason
          : "verifier unavailable: no verifier pass ran",
        unavailable: true,
      };
    }
    const judgements = owned.map((n) => judgeFinding(n, pass.verdicts));
    const problems = judgements.flatMap((j) => j.fixed ? [] : [j.problem]);
    if (problems.length > 0) {
      return { id: review.id, verified: false, reason: problems.join("; ") };
    }
    const notes = judgements.flatMap((j) => j.fixed ? [j.note] : []);
    return { id: review.id, verified: true, reason: notes.join("; ") };
  });
}
