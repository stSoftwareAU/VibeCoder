/**
 * Claim issue command for the Vibe Coder worker.
 *
 * Provides atomic issue claiming with verification and claim churn detection.
 * Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Sub-operations (--operation):
 *   - claim: Atomically claim an issue with verification
 *   - check-churn: Detect claim/release churn and escalate if threshold met
 *
 * Migrated from worker/shared/claim_issue.sh (Issue #911).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { getWorkerUniqueId } from "../lib/worker_identity.ts";
import { checkClaimChurn, claimIssue } from "../lib/claim_issue.ts";

export const claimIssueCommand: Command = {
  name: "claim-issue",
  description: "Atomic issue claiming with verification (Issue #433, #604)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "claim");

    switch (operation) {
      case "claim": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const githubUser = String(args["github-user"] ?? "");

        if (!repo || !issueNumber || !githubUser) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user",
          };
        }

        const workerId = getWorkerUniqueId(config.workerName);

        const result = await claimIssue({
          repo,
          issueNumber,
          githubUser,
          workerId,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        const { claimed, winnerId } = result.value;
        return {
          success: claimed,
          message: claimed ? "CLAIMED" : "LOST",
          data: { claimed, winnerId, workerId },
        };
      }

      case "check-churn": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const githubUser = String(args["github-user"] ?? "");
        const threshold = toNumber(args["threshold"], 5);
        const failedLabel = String(
          args["failed-label"] ?? config.failedLabel ?? "failed",
        );

        if (!repo || !issueNumber || !githubUser) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user",
          };
        }

        const result = await checkClaimChurn({
          repo,
          issueNumber,
          githubUser,
          threshold,
          failedLabel,
          allowedAuthors: config.allowedAuthors,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        const { churnCount, escalated } = result.value;
        return {
          success: true,
          message: escalated ? "ESCALATED" : "OK",
          data: { churnCount, escalated, threshold },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown claim-issue operation: ${operation}`,
        };
    }
  },
};

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}
