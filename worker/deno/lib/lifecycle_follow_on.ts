/** Attribute PR maintenance to the originating issue assignment (Issue #3720). */
import {
  appendLifecycleEvent,
  buildLifecycleEvent,
  type InvocationTelemetry,
  lifecycleLedgerPath,
} from "./lifecycle_ledger.ts";
import { assignmentIdFromBody } from "./pr_body.ts";
import { breakdownInvocationTelemetry } from "./run_callback_telemetry.ts";
import type { RunStats } from "./run_stats.ts";
import { getHostname } from "./worker_identity.ts";
import { generateRunId, readRunId } from "./run_id.ts";

/** Deterministic cycle identity comes from the check/review and its durable attempt count. */
export interface PrFollowOnInput {
  ledgerPath: string;
  runId: string;
  host: string;
  repo: string;
  prNumber: number;
  followOn: "ci_fix" | "pr_feedback";
  cycle: string;
  attempt: number;
  body: string;
  telemetry: readonly InvocationTelemetry[];
  recordedAt: string;
}

/** Append a replay-safe cycle; absent or partial costs stay unknown. */
export async function recordPrFollowOn(input: PrFollowOnInput): Promise<void> {
  const usageKnown = input.telemetry.length > 0 &&
    input.telemetry.every((t) => t.usage === "known");
  const pricingKnown = usageKnown &&
    input.telemetry.every((t) =>
      t.pricing === "known" && t.estimatedApiEquivalentUsd !== undefined
    );
  await appendLifecycleEvent(
    input.ledgerPath,
    buildLifecycleEvent({
      kind: "follow_on",
      assignmentId: assignmentIdFromBody(input.body) ?? "unknown",
      runId: input.runId,
      host: input.host,
      repo: input.repo,
      recordedAt: input.recordedAt,
      followOn: input.followOn,
      prNumber: input.prNumber,
      cycle: input.cycle,
      attempt: input.attempt,
      usage: usageKnown ? "known" : "unknown",
      pricing: pricingKnown ? "known" : "unknown",
      ...(pricingKnown
        ? {
          estimatedApiEquivalentUsd: input.telemetry.reduce(
            (sum, t) => sum + t.estimatedApiEquivalentUsd!,
            0,
          ),
        }
        : {}),
    }),
  );
}

/** The production adapter reads the live marker; a failed read never becomes "unknown". */
export async function recordPrFollowOnFromGithub(input: {
  workDir: string;
  repo: string;
  prNumber: number;
  followOn: "ci_fix" | "pr_feedback";
  cycle: string;
  attempt: number;
  runStats: readonly (RunStats | undefined)[];
}, runGh: (args: string[]) => Promise<string>): Promise<void> {
  const body = await runGh([
    "pr",
    "view",
    String(input.prNumber),
    "--repo",
    input.repo,
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  const host = getHostname();
  await recordPrFollowOn({
    ...input,
    body,
    host,
    ledgerPath: lifecycleLedgerPath(input.workDir, host),
    runId: readRunId() ?? generateRunId(),
    recordedAt: new Date().toISOString(),
    telemetry: input.runStats.map((runStats) =>
      breakdownInvocationTelemetry({ runStats }, "manager", runStats?.provider)
    ),
  });
}
