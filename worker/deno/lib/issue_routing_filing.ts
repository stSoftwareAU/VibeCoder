import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import { formatRoutingAuditBlock } from "./issue_routing_audit.ts";
import {
  classifyIssueRouting,
  partRepos,
  sameRepo,
} from "./issue_routing_classifier.ts";
import { findMatches, requireWriteAccess } from "./issue_routing_github.ts";
import type {
  Gh,
  IssueRoutingAudit,
  IssueRoutingContext,
  IssueRoutingDraft,
  RoutedIssueRef,
  RoutingAction,
  RoutingDecision,
} from "./issue_routing_types.ts";
import type { Logger } from "../types.ts";

const CALLER = "worker/deno/lib/issue_routing.ts";

interface FilePlan {
  repo: string;
  title: string;
  body: string;
  labels: readonly string[];
}

interface FileResult {
  ref: RoutedIssueRef;
  created: boolean;
}

/** Search, create and converge on the lowest-numbered matching issue. */
async function fileOrReuse(
  plan: FilePlan,
  decision: RoutingDecision,
  targetRepo: string,
  ctx: IssueRoutingContext,
  gh: Gh,
  logger: Logger,
): Promise<FileResult> {
  const first = (await findMatches(plan.repo, plan.title, ctx, gh))[0];
  if (first) return { ref: first, created: false };

  // Concurrent filers: look again immediately before writing.
  const second = (await findMatches(plan.repo, plan.title, ctx, gh))[0];
  if (second) return { ref: second, created: false };

  const migrate = sameRepo(plan.repo, targetRepo);
  let body = plan.body;
  if (!migrate && plan.labels.length > 0) {
    body += `\n\nLabels not migrated: ${plan.labels.join(", ")}`;
  }
  body += `\n\n${formatRoutingAuditBlock(decision)}`;
  const labelArgs = migrate ? guardedLabelArgs(plan.labels, CALLER) : [];
  const out = await gh([
    "issue",
    "create",
    "--repo",
    plan.repo,
    "--title",
    plan.title,
    "--body",
    body,
    ...labelArgs,
  ]);
  const m = /\/issues\/(\d+)/.exec(out);
  if (!m) {
    throw new Error(
      `gh issue create in ${plan.repo} returned no issue number: ${out}`,
    );
  }
  const number = parseInt(m[1]!, 10);
  const ours: RoutedIssueRef = {
    repo: plan.repo,
    number,
    url: out.trim(),
    state: "open",
  };

  // Deterministic tie-break: the lowest number wins, so concurrent filers
  // converge on the same issue.
  const older = (await findMatches(plan.repo, plan.title, ctx, gh))
    .find((r) => (r.number ?? Infinity) < number);
  if (older) {
    await gh([
      "issue",
      "close",
      String(number),
      "--repo",
      plan.repo,
      "--comment",
      `Closing as a duplicate filed concurrently: ${plan.repo}#${older.number} ` +
      "has the same title and the lowest number, so it is the one kept.",
      "--reason",
      "not planned",
    ]);
    logger.info(
      `Issue routing: closed concurrent duplicate ${plan.repo}#${number} ` +
        `in favour of #${older.number}`,
    );
    return { ref: older, created: false };
  }
  return { ref: ours, created: true };
}

/** Dry-run: read-only search; report the issue a live run would reuse, if any. */
async function dryRunRef(
  repo: string,
  title: string,
  ctx: IssueRoutingContext,
  gh: Gh,
  logger: Logger,
): Promise<RoutedIssueRef> {
  const match = (await findMatches(repo, title, ctx, gh))[0];
  if (!match) {
    logger.info(`Issue routing: dry-run found no duplicate in ${repo}`);
    return { repo, number: null, url: null, state: "dry-run" };
  }
  logger.info(
    `Issue routing: dry-run would reuse ${match.repo}#${match.number} ` +
      `${match.url ?? ""}`.trimEnd(),
  );
  return match;
}

const refText = (r: RoutedIssueRef): string => `${r.repo}#${r.number}`;

async function fileSplit(
  draft: IssueRoutingDraft,
  decision: RoutingDecision,
  targetRepo: string,
  ctx: IssueRoutingContext,
  gh: Gh,
  logger: Logger,
): Promise<IssueRoutingAudit> {
  const parts = draft.parts ?? [];
  const notMigrated: string[] = [];
  for (const repo of partRepos(draft)) {
    if (!sameRepo(repo, targetRepo)) await requireWriteAccess(repo, ctx, gh);
  }
  for (const p of parts) {
    if (!sameRepo(p.repo, targetRepo)) notMigrated.push(...draft.labels);
  }
  const uniqueNotMigrated = [...new Set(notMigrated)];
  if (ctx.dryRun) {
    return {
      ...decision,
      action: "dry-run",
      issues: await Promise.all(
        parts.map((p) => dryRunRef(p.repo, p.title, ctx, gh, logger)),
      ),
      labels_not_migrated: uniqueNotMigrated,
    };
  }
  const refs: RoutedIssueRef[] = [];
  for (const p of parts) {
    const { ref } = await fileOrReuse(
      {
        repo: p.repo,
        title: p.title,
        body: p.body,
        labels: draft.labels,
      },
      decision,
      targetRepo,
      ctx,
      gh,
      logger,
    );
    refs.push(ref);
  }
  for (let i = 0; i < parts.length; i++) {
    const deps = parts[i]!.dependsOnRepos ?? [];
    const lines: string[] = [];
    refs.forEach((other, j) => {
      if (j === i) return;
      const dependsOn = deps.some((d) => sameRepo(d, other.repo));
      lines.push(`${dependsOn ? "Depends on" : "Related"}: ${refText(other)}`);
    });
    await gh([
      "issue",
      "comment",
      String(refs[i]!.number),
      "--repo",
      refs[i]!.repo,
      "--body",
      lines.join("\n"),
    ]);
  }
  return {
    ...decision,
    action: "split",
    issues: refs,
    labels_not_migrated: uniqueNotMigrated,
  };
}

/**
 * Route a draft to its owning repository and create (or reuse) the issue.
 * See the module header for the invariants.
 */
export async function routeIssueCreation(
  draft: IssueRoutingDraft,
  targetRepo: string,
  ctx: IssueRoutingContext,
  gh: Gh,
  logger: Logger,
): Promise<IssueRoutingAudit> {
  const decision = classifyIssueRouting(draft, targetRepo, ctx);
  logger.info(
    `Issue routing: owner=${decision.owner_repository} ` +
      `kind=${decision.issue_kind} wrong_repo=${decision.wrong_repo} ` +
      `ambiguous=${decision.ambiguous}: ${decision.reason}`,
  );

  if (
    decision.issue_kind === "cross-repo" && partRepos(draft).length >= 2
  ) {
    return await fileSplit(draft, decision, targetRepo, ctx, gh, logger);
  }

  const dest = decision.wrong_repo && !decision.ambiguous
    ? decision.owner_repository
    : targetRepo;
  if (!sameRepo(dest, targetRepo)) await requireWriteAccess(dest, ctx, gh);

  const migrated = sameRepo(dest, targetRepo);
  const notMigrated = migrated ? [] : [...draft.labels];
  if (ctx.dryRun) {
    return {
      ...decision,
      action: "dry-run",
      issues: [await dryRunRef(dest, draft.title, ctx, gh, logger)],
      labels_not_migrated: notMigrated,
    };
  }

  const { ref, created } = await fileOrReuse(
    { repo: dest, title: draft.title, body: draft.body, labels: draft.labels },
    decision,
    targetRepo,
    ctx,
    gh,
    logger,
  );
  const action: RoutingAction = !created
    ? "reused"
    : decision.ambiguous
    ? "filed-ambiguous"
    : "created";
  return {
    ...decision,
    action,
    issues: [ref],
    labels_not_migrated: created ? notMigrated : [],
  };
}
