/** Completed issues are the delivery unit; partial PRs are not completions (#4942). */
import type { GhJson } from "./pr_completion_snapshot.ts";
import type { PrCompletionInput } from "./pr_completion_report.ts";

export interface IssueCompletionEvidence {
  complete: boolean;
  unknownClosures: number;
  excludedClosures: number;
  records: Array<{
    repo: string;
    number: number;
    createdAt: string;
    mergedAt: string;
    closingPr: number;
    relatedPrs: number[];
  }>;
}

/** GET-only collection. Manual closures and incomplete history stay unknown. */
export async function collectIssueCompletions(
  repos: string[],
  cohort: PrCompletionInput["cohort"],
  gh: GhJson,
): Promise<IssueCompletionEvidence> {
  const evidence: IssueCompletionEvidence = {
    complete: true,
    unknownClosures: 0,
    excludedClosures: 0,
    records: [],
  };
  const start = Date.parse(cohort.start), end = Date.parse(cohort.end);
  type Row = Record<string, unknown>;
  async function pages(path: string): Promise<Row[]> {
    const rows: Row[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await gh(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (
        !Array.isArray(batch) ||
        batch.some((row) => !row || typeof row !== "object")
      ) {
        throw new Error(`Invalid issue throughput response: ${path}`);
      }
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new Error(`Issue throughput pagination bound reached: ${path}`);
  }
  for (const repo of new Set(repos)) {
    const info = await gh(`repos/${repo}`) as { default_branch?: string };
    if (!info.default_branch) {
      throw new Error(`Unknown default branch: ${repo}`);
    }
    const issues = await pages(
      `repos/${repo}/issues?state=closed&since=${
        encodeURIComponent(cohort.start)
      }`,
    );
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const closed = Date.parse(String(issue.closed_at));
      if (!Number.isFinite(closed)) {
        throw new Error("Closed issue is missing its closure timestamp");
      }
      if (closed < start || closed >= end) continue;
      if (issue.state_reason === "not_planned") {
        evidence.excludedClosures++;
        continue;
      }
      const number = Number(issue.number);
      const timeline = await pages(`repos/${repo}/issues/${number}/timeline`);
      const closure = timeline.filter((event) => event.event === "closed").at(
        -1,
      );
      const sha = closure?.commit_id;
      // GitHub's closed event ties the issue to a commit. Mere mentions,
      // a matching title, or an issue someone closed by hand prove no delivery.
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
        evidence.unknownClosures++;
        continue;
      }
      const associated = await pages(`repos/${repo}/commits/${sha}/pulls`);
      const closing = associated.find((pr) => {
        const base = pr.base as
          | { ref?: string; repo?: { full_name?: string } }
          | undefined;
        const merged = Date.parse(String(pr.merged_at));
        return base?.ref === info.default_branch &&
          base?.repo?.full_name?.toLowerCase() === repo.toLowerCase() &&
          merged >= start && merged < end && merged <= closed;
      });
      if (!closing) {
        evidence.unknownClosures++;
        continue;
      }
      const related = new Set<number>([Number(closing.number)]);
      for (const event of timeline) {
        const source = event.source as {
          issue?: {
            number?: number;
            pull_request?: unknown;
            repository?: { full_name?: string };
          };
        } | undefined;
        if (
          source?.issue?.pull_request &&
          source.issue.repository?.full_name?.toLowerCase() ===
            repo.toLowerCase() &&
          Number.isSafeInteger(source.issue.number)
        ) related.add(source.issue.number!);
      }
      evidence.records.push({
        repo,
        number,
        createdAt: String(issue.created_at),
        mergedAt: String(closing.merged_at),
        closingPr: Number(closing.number),
        relatedPrs: [...related],
      });
    }
  }
  return evidence;
}

export function buildIssueCompletionMetrics(
  input: PrCompletionInput,
  attribution: ReadonlyMap<string, "unattended" | "human" | "unknown">,
) {
  const evidence = input.issueCompletions!;
  const records = [
    ...new Map(evidence.records.map((r) => [`${r.repo}#${r.number}`, r]))
      .values(),
  ];
  const related = new Set(
    records.flatMap((r) => r.relatedPrs.map((n) => `${r.repo}#${n}`)),
  );
  const histories = new Map(
    input.prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]),
  );
  const statuses = records.map((r) => {
    const values = r.relatedPrs.map((n) =>
      attribution.get(`${r.repo}#${n}`) ?? "unknown"
    );
    return values.includes("human")
      ? "human"
      : values.every((v) => v === "unattended")
      ? "unattended"
      : "unknown";
  });
  const hours = records.map((r) =>
    (Date.parse(r.mergedAt) - Date.parse(r.createdAt)) / 3_600_000
  ).sort((a, b) => a - b);
  if (hours.some((h) => !Number.isFinite(h) || h < 0)) {
    throw new Error("Invalid issue-to-merge duration");
  }
  const ciComplete = evidence.complete &&
    [...related].every((key) => histories.has(key)) &&
    !(input.ciIncompletePrs ?? []).some((pr) =>
      related.has(`${pr.repo}#${pr.prNumber}`)
    );
  const runs = new Map(
    input.ciRuns.filter((run) =>
      related.has(`${run.repo}#${run.prNumber}`) && run.kind === "workflow_run"
    ).map((run) => [`${run.repo}/${run.runId}/${run.attempt ?? 1}`, run]),
  );
  const quality = [...runs.values()].filter((run) =>
    /^quality(?:\s|$)/i.test(run.workflowName ?? "")
  );
  const qualityComplete = ciComplete &&
    [...runs.values()].every((run) => run.workflowName !== undefined);
  const noChangeRepairs = input.actions.filter((action) =>
    related.has(`${action.repo}#${action.prNumber}`) &&
    action.kind === "repair" &&
    action.verified && action.outcome === "confirmed" &&
    action.deliveredCommits?.length === 0
  );
  return {
    window: input.cohort,
    uniqueCompletedIssues: records.length,
    complete: evidence.complete,
    unknownClosures: evidence.unknownClosures,
    excludedClosures: evidence.excludedClosures,
    unattended: statuses.filter((s) => s === "unattended").length,
    humanAssisted: statuses.filter((s) => s === "human").length,
    unknownAttribution: statuses.filter((s) => s === "unknown").length,
    medianIssueToMergeHours: hours.length
      ? (hours[Math.floor((hours.length - 1) / 2)]! +
        hours[Math.floor(hours.length / 2)]!) / 2
      : null,
    p90IssueToMergeHours: hours.length
      ? hours[Math.ceil(hours.length * 0.9) - 1]!
      : null,
    qualityHistoryComplete: qualityComplete,
    observedQualityRuns: quality.length,
    observedQualityCancellations:
      quality.filter((run) => run.outcome === "cancelled").length,
    qualityRunsPerCompletedIssue: qualityComplete && records.length
      ? quality.length / records.length
      : null,
    qualityCancellationsPerCompletedIssue: qualityComplete && records.length
      ? quality.filter((run) => run.outcome === "cancelled").length /
        records.length
      : null,
    verifiedNoChangeRepairs:
      new Set(noChangeRepairs.map((action) => action.actionId)).size,
    // A PR absent from the completion evidence is not called a finished issue.
    defaultBranchPrsWithoutConfirmedIssueCompletion:
      input.prs.filter((pr) =>
        pr.state === "merged" &&
        pr.baseRef === pr.defaultBranch &&
        !related.has(`${pr.repo}#${pr.number}`)
      ).length,
  };
}
