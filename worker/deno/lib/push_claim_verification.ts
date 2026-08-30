/**
 * Verifying that a push actually landed before claiming it did (Issue #579).
 *
 * PR #549 is the case this exists for. At 00:40:26Z the PR-feedback agent
 * posted, in full confidence:
 *
 *   > **Unblocked — both things holding this PR are fixed and pushed.**
 *
 * The last commit on that branch was 21:23:04Z. Nothing had been pushed. Git
 * authentication had failed silently (Issue #564), the head SHA never moved,
 * and the working tree was later reset to another issue — destroying work
 * that was, by its own description, correct.
 *
 * A run that fails loudly gets retried. A run that reports success is
 * *finished*: the claim goes on the PR, the attempt budget is spent, the lane
 * moves on, and the next reader believes the PR has been worked. Every
 * self-healing mechanism the fleet has is downstream of knowing whether the
 * work landed.
 *
 * So the claim is made against the remote, not against local state. Local
 * signals cannot answer the question:
 *
 * - A local commit moves HEAD whether or not the push ran.
 * - An unpushed count of zero is only meaningful when it was measured; a
 *   count that was never taken is not a count of zero, and reading it as one
 *   is how a failed push became a success claim.
 *
 * Fails closed: when the remote cannot be reached — which is exactly the
 * condition that caused the incident — the answer is "not verified", never
 * "landed".
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

import type { Result } from "../types.ts";
import { captureBranchHead } from "./branch_head_tracker.ts";
import {
  type RemoteBranchHead,
  resolveRemoteBranchHead,
} from "./git_remote_head.ts";

/** Injected so the verification can be tested without a repository. */
export interface PushVerificationDeps {
  captureBranchHead: (
    branchName: string,
    options?: { cwd?: string },
  ) => Promise<Result<string>>;
  resolveRemoteBranchHead: (
    branchName: string,
    options?: { cwd?: string },
  ) => Promise<Result<RemoteBranchHead>>;
}

/** Production wiring. */
export function createPushVerificationDeps(): PushVerificationDeps {
  return {
    captureBranchHead: (branchName, options) =>
      captureBranchHead(branchName, options ?? {}),
    resolveRemoteBranchHead: (branchName, options) =>
      resolveRemoteBranchHead(branchName, options ?? {}),
  };
}

/** The verdict on whether local work reached the remote. */
export interface PushVerification {
  /**
   * True only when the branch's remote head is known AND equals the local
   * head. Every other case — including every failure to find out — is false.
   */
  landed: boolean;
  /** Local head SHA, when it could be read. */
  localSha?: string;
  /** Remote head SHA, when the remote could be reached and has the branch. */
  remoteSha?: string;
  /**
   * Why the answer is what it is, in a form fit for a log field and a PR
   * comment. Never carries credentials or command output beyond git's own
   * short error text.
   */
  reason: string;
}

/**
 * Verify that `branchName`'s local head is what the remote has.
 *
 * @returns A verdict, never an error — an unreachable remote is a legitimate
 *   answer to "did it land?", and that answer is "no evidence that it did".
 */
export async function verifyPushLanded(
  branchName: string,
  options: { cwd?: string } = {},
  deps: PushVerificationDeps = createPushVerificationDeps(),
): Promise<PushVerification> {
  const localResult = await deps.captureBranchHead(branchName, options);
  if (!localResult.ok) {
    return {
      landed: false,
      reason:
        `could not read the local head of '${branchName}': ${localResult.error.message}`,
    };
  }
  const localSha = localResult.value;

  const remoteResult = await deps.resolveRemoteBranchHead(branchName, options);
  if (!remoteResult.ok) {
    // The incident's exact condition: git auth broken, so the remote cannot
    // be consulted. Reporting "pushed" here is the bug this module exists to
    // prevent, so an unreachable remote is never a success.
    return {
      landed: false,
      localSha,
      reason:
        `could not reach the remote to confirm '${branchName}' landed: ${remoteResult.error.message}`,
    };
  }

  const remote = remoteResult.value;
  if (remote.sha === null) {
    return {
      landed: false,
      localSha,
      reason: `'${branchName}' does not exist on the remote`,
    };
  }

  if (remote.sha !== localSha) {
    return {
      landed: false,
      localSha,
      remoteSha: remote.sha,
      reason:
        `'${branchName}' on the remote is at ${short(remote.sha)}, local is ` +
        `at ${short(localSha)} — the push did not land`,
    };
  }

  return {
    landed: true,
    localSha,
    remoteSha: remote.sha,
    reason: `'${branchName}' on the remote is at ${
      short(remote.sha)
    } (${remote.source})`,
  };
}

/**
 * The SHA a completion claim should carry, so a stale claim is falsifiable at
 * a glance (Issue #579).
 *
 * The incident took a human comparing a comment against `git log` to detect.
 * A comment naming the SHA it pushed can be checked in one look.
 */
export function formatVerifiedPushSuffix(
  verification: PushVerification,
): string {
  if (!verification.landed || verification.remoteSha === undefined) return "";
  return `\n\nVerified on the remote at \`${short(verification.remoteSha)}\`.`;
}

/** First 8 characters — enough to identify, short enough to read. */
function short(sha: string): string {
  return sha.slice(0, 8);
}
