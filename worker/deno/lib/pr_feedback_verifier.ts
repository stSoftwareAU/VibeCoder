/** Independent verification of a review-fix round's committed head (#3784). */
import {
  buildSyncedPrBodyCandidate,
  type SyncPrBodyInput,
} from "./pr_body_sync.ts";
import { runGitCommand } from "./git_timeout.ts";
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

export interface FeedbackVerifierInput extends
  Pick<
    SyncPrBodyInput,
    "branchName" | "workerName" | "githubUser" | "runId"
  > {
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
  runGitCommand?: typeof runGitCommand;
  buildCandidate?: typeof buildSyncedPrBodyCandidate;
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
        "baseRefName,headRefName,title,body,files",
      ]),
    );
    if (
      typeof pr.baseRefName !== "string" || !pr.baseRefName ||
      typeof pr.title !== "string" || typeof pr.body !== "string" ||
      typeof pr.headRefName !== "string" || !pr.headRefName
    ) {
      throw new Error("PR metadata is incomplete");
    }
    let summaryContent = pr.body;
    try {
      const candidate =
        await (deps.buildCandidate ?? buildSyncedPrBodyCandidate)(
          { ...input, beforeSha: undefined },
          {
            logger: input.logger,
            runGitCommand: deps.runGitCommand ?? runGitCommand,
          },
          pr,
        );
      if (!candidate.ok) throw candidate.error;
      if (candidate.value.kind === "candidate") {
        summaryContent = candidate.value.body;
      } else {
        input.logger.info("Review-fix verifier retains the live PR body", {
          prNumber: input.prNumber,
          reason: candidate.value.reason,
        });
      }
    } catch (error) {
      throw new Error(
        `Cannot build review-fix body for PR #${input.prNumber} on ${input.branchName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
        `${summaryContent}\n\nAgent reply (untrusted evidence to verify independently):\n${response}`,
      repoPath: input.repoPath,
      baseRef: `origin/${pr.baseRefName}`,
      summaryPath: "docs/archive/pr-summaries/feedback-verifier-pr-body.md",
      summaryContent,
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
