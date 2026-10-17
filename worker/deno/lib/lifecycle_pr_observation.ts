/** Record PR observations without changing the worker's merge decisions. */
import type { Logger } from "../types.ts";
import { determineCiStatus } from "./direct_merge.ts";
import {
  type PrRollup,
  rollupToCheckRunsResponse,
  rollupToCombinedStatusResponse,
} from "./check_runs_batch.ts";
import {
  appendLifecycleEvent,
  buildLifecycleEvent,
  type LifecycleEventInput,
  lifecycleLedgerPath,
  readLifecycleLedger,
} from "./lifecycle_ledger.ts";
import { assignmentIdFromBody, extractClosingIssueNumbers } from "./pr_body.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import { getHostname } from "./worker_identity.ts";
import { fetchClosedPRsByUser } from "./issue_query.ts";
import type { IssueCache } from "./issue_cache.ts";
import { defaultLogger } from "./logger.ts";
import { redactSecrets } from "./secret_redaction.ts";

export interface LifecyclePrSnapshot {
  body: string;
  headRefName: string;
  headRefOid: string;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  reviewDecision: string;
}

/**
 * Store observed gates on the current PR head. A merge seen later cannot
 * manufacture a pre-merge pass; missing observations remain unsuccessful.
 */
export async function recordLifecyclePrSnapshot(input: {
  ledgerPath: string;
  host: string;
  repo: string;
  prNumber: number;
  snapshot: LifecyclePrSnapshot;
  observedAt: string;
  rollup?: PrRollup;
  qualityObservedAt?: string;
}): Promise<void> {
  const { snapshot, prNumber, repo } = input;
  const assignmentId = assignmentIdFromBody(snapshot.body);
  if (!assignmentId) return;
  const refs = extractClosingIssueNumbers(snapshot.body);
  const issueNumber = issueNumberFromBranch(snapshot.headRefName) ??
    (refs.length === 1 ? refs[0] : undefined);
  if (issueNumber === undefined) {
    throw new Error(
      `Lifecycle PR ${repo}#${prNumber} has no unambiguous issue`,
    );
  }
  const base = {
    assignmentId,
    issueNumber,
    repo,
    prNumber,
    host: input.host,
    runId: `pr-${prNumber}-${snapshot.headRefOid}`,
    recordedAt: input.observedAt,
  };
  const append = (
    fields: {
      kind: "outcome";
      outcome: "pr_opened" | "merged" | "closed_unmerged";
      recordedAt: string;
    } | {
      kind: "gate";
      gate: string;
      result: "pass" | "fail" | "skipped";
      attempt: number;
      recordedAt?: string;
    },
  ) =>
    appendLifecycleEvent(
      input.ledgerPath,
      buildLifecycleEvent({ ...base, ...fields } as LifecycleEventInput),
    );
  await append({
    kind: "outcome",
    outcome: "pr_opened",
    recordedAt: snapshot.createdAt,
  });
  if (snapshot.state === "MERGED") {
    if (!snapshot.mergedAt) {
      throw new Error(
        `Lifecycle PR ${repo}#${prNumber} has no merge timestamp`,
      );
    }
    await append({
      kind: "outcome",
      outcome: "merged",
      recordedAt: snapshot.mergedAt,
    });
    return;
  }
  if (snapshot.state === "CLOSED") {
    if (!snapshot.closedAt) {
      throw new Error(
        `Lifecycle PR ${repo}#${prNumber} has no close timestamp`,
      );
    }
    await append({
      kind: "outcome",
      outcome: "closed_unmerged",
      recordedAt: snapshot.closedAt,
    });
    await append({
      kind: "gate",
      gate: "pr_open",
      result: "fail",
      attempt: Date.parse(snapshot.closedAt),
      recordedAt: snapshot.closedAt,
    });
    return;
  }
  if (snapshot.state !== "OPEN") {
    throw new Error(`Lifecycle PR ${repo}#${prNumber} has an unknown state`);
  }
  const attempt = Date.parse(input.observedAt);
  await append({ kind: "gate", gate: "pr_open", result: "pass", attempt });
  if (input.rollup?.headSha === snapshot.headRefOid) {
    const status = determineCiStatus(
      rollupToCheckRunsResponse(input.rollup),
      rollupToCombinedStatusResponse(input.rollup),
      input.rollup.rollupState,
    );
    await append({
      kind: "gate",
      gate: "quality",
      recordedAt: input.qualityObservedAt ?? input.observedAt,
      result: status === "passed"
        ? "pass"
        : status === "failed"
        ? "fail"
        : "skipped",
      attempt: Date.parse(input.qualityObservedAt ?? input.observedAt),
    });
  }
  await append({
    kind: "gate",
    gate: "review",
    result: snapshot.reviewDecision === "APPROVED"
      ? "pass"
      : snapshot.reviewDecision === "CHANGES_REQUESTED"
      ? "fail"
      : "skipped",
    attempt,
  });
}

/** Keep telemetry faults visible at ERROR without blocking PR maintenance. */
export async function recordLifecyclePrFromGithub(
  input: {
    workDir: string;
    repo: string;
    prNumber: number;
    rollup?: PrRollup;
    snapshot?: LifecyclePrSnapshot;
    observedAt?: string;
  },
  runGh: (args: string[]) => Promise<string>,
  logger: Pick<Logger, "error"> = defaultLogger,
): Promise<void> {
  try {
    const snapshot: LifecyclePrSnapshot = input.snapshot ?? JSON.parse(
      await runGh([
        "pr",
        "view",
        String(input.prNumber),
        "--repo",
        input.repo,
        "--json",
        "body,headRefName,headRefOid,state,createdAt,closedAt,mergedAt,reviewDecision",
      ]),
    );
    const host = getHostname();
    await recordLifecyclePrSnapshot({
      ...input,
      snapshot,
      host,
      ledgerPath: lifecycleLedgerPath(input.workDir, host),
      observedAt: input.snapshot && input.observedAt
        ? input.observedAt
        : new Date().toISOString(),
      qualityObservedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(
      `Lifecycle PR observation failed for ${input.repo}#${input.prNumber}: ${
        redactSecrets(error instanceof Error ? error.message : String(error))
      }`,
    );
  }
}

/** Recorded terminal PRs need no second GitHub snapshot on subsequent sweeps. */
export async function observedLifecycleTerminalPrs(
  workDir: string,
): Promise<Set<string>> {
  const events = await readLifecycleLedger(lifecycleLedgerPath(workDir));
  const observed = new Set<string>();
  for (const event of events) {
    if (!("prNumber" in event) || event.prNumber === undefined) continue;
    const pr = `${event.repo}#${event.prNumber}`;
    if (event.kind === "outcome" && event.outcome === "merged") {
      observed.add(`${pr}:merged`);
    } else if (
      (event.kind === "outcome" && event.outcome === "closed_unmerged") ||
      (event.kind === "gate" && event.gate === "pr_open" &&
        event.result === "fail")
    ) {
      observed.add(`${pr}:closed_unmerged:${event.recordedAt}`);
    }
  }
  return observed;
}

/** Reuse the closed-PR listing at the existing recovery pass. */
export async function recordClosedLifecyclePrs(
  input: {
    workDir: string;
    repos: string[];
    githubUser: string;
    cache?: IssueCache;
  },
  runGh: (args: string[]) => Promise<string>,
  logger: Pick<Logger, "error"> = defaultLogger,
): Promise<void> {
  try {
    const observed = await observedLifecycleTerminalPrs(input.workDir);
    for (const repo of input.repos) {
      const closed = await fetchClosedPRsByUser(
        repo,
        input.githubUser,
        100,
        input.cache,
        runGh,
      );
      for (const pr of closed) {
        if (
          !pr.mergedAt && pr.lifecycleAssignmentId !== null &&
          !observed.has(`${repo}#${pr.number}:closed_unmerged:${pr.closedAt}`)
        ) {
          await recordLifecyclePrFromGithub(
            { workDir: input.workDir, repo, prNumber: pr.number },
            runGh,
            logger,
          );
        }
      }
    }
  } catch (error) {
    logger.error(
      `Lifecycle closed-PR observation failed: ${
        redactSecrets(error instanceof Error ? error.message : String(error))
      }`,
    );
  }
}
