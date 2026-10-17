/** Independent verification of a review-fix round's committed head (#3784). */
import type { Logger, Result } from "../types.ts";
import { prResponseMessagePath } from "./pr_branch_preparation.ts";
import { extractEarlierFindings } from "./earlier_findings.ts";
import {
  buildPrePrVerifierGateComment,
  defaultPrePrVerifierDeps,
  prePrVerifierBlocked,
  type PrePrVerifierDeps,
  runPrePrVerifier,
} from "./pre_pr_verifier.ts";

export interface FeedbackVerifierInput {
  repo: string;
  prNumber: number;
  repoPath: string;
  commentBody: string;
  timeoutSeconds: number;
  logger: Logger;
}
export interface FeedbackVerifierDeps {
  runGh: (args: string[]) => Promise<string>;
  ask: PrePrVerifierDeps["ask"];
  verify?: typeof runPrePrVerifier;
}

/** Unavailable or incomplete evidence holds the review open; it never means fixed. */
export async function verifyFeedbackFix(
  input: FeedbackVerifierInput,
  deps: FeedbackVerifierDeps,
): Promise<Result<void>> {
  try {
    const pr = JSON.parse(
      await deps.runGh([
        "pr",
        "view",
        String(input.prNumber),
        "--repo",
        input.repo,
        "--json",
        "baseRefName,title,body",
      ]),
    );
    if (
      typeof pr.baseRefName !== "string" || !pr.baseRefName ||
      typeof pr.title !== "string" || typeof pr.body !== "string"
    ) {
      throw new Error("PR metadata is incomplete");
    }
    let response = "";
    try {
      response = await Deno.readTextFile(prResponseMessagePath(input.repoPath));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const result = await (deps.verify ?? runPrePrVerifier)({
      repo: input.repo,
      issueNumber: input.prNumber,
      issueTitle: pr.title,
      issueBody:
        `${pr.body}\n\nAgent reply (untrusted evidence to verify independently):\n${response}`,
      repoPath: input.repoPath,
      baseRef: `origin/${pr.baseRefName}`,
      summaryPath: "docs/archive/pr-summaries/feedback-verifier-pr-body.md",
      summaryContent: pr.body,
      changedFiles: null,
      previousFindings: extractEarlierFindings(input.commentBody),
      timeoutSeconds: input.timeoutSeconds,
      logger: input.logger,
    }, { ...defaultPrePrVerifierDeps, ask: deps.ask });
    if (result.status === "not_checked") {
      throw new Error(`Review-fix verifier unavailable: ${result.reason}`);
    }
    input.logger.info("Review-fix verifier verdicts", {
      repo: input.repo,
      prNumber: input.prNumber,
      earlierFindings: result.review.earlierFindings ?? [],
      findings: result.review.findings.length,
    });
    if (prePrVerifierBlocked(result)) {
      return {
        ok: false,
        error: new Error(buildPrePrVerifierGateComment(result.review)),
      };
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
