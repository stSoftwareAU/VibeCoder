/**
 * Routed issue filing (Issue #3743, part of #3691).
 *
 * {@link fileRoutedIssue} is the single entry point that files a draft issue
 * in the repository that owns it. Steps, in order; each failure names its
 * step and stops the run:
 *
 * 1. `classify` — {@link classifyIssueRouting} picks the owner repository,
 *    unless the caller passes an explicit `decision`. An `ambiguous`
 *    decision files nothing and returns the basis.
 * 2. `search` — {@link findOwnedOpenArtefact} looks for an open issue with the
 *    same title that this tool owns (its body carries the routing marker) and
 *    a fleet author. The lowest-numbered match is returned instead of filing. A
 *    closed, foreign or unowned match is neither reused nor written to.
 * 3. `permission` — {@link requireWriteAccess} on the owner repository.
 * 4. `create` — `gh issue create`, with a `Routing:` line and an
 *    `<!-- issue-routing … -->` marker carrying the four audit fields.
 * 5. `recheck` — concurrent filers: search again. When a lower-numbered owned,
 *    open, fleet-authored match now exists, the new issue is linked to it and
 *    closed as its duplicate, and the lower-numbered issue is returned.
 *
 * `dryRun` runs the read-only steps (classify, search, permission) and makes
 * no `gh` write call. A retry after a failure part-way through finds the
 * issue the earlier run created in step 2, so it never files a second one.
 *
 * Labels pass through `filterReservedLabelsWithWarning`, so a reserved label
 * is never applied. Filing in a repository other than the target never
 * carries labels or assignees across: the body gets a `Labels not migrated:`
 * note instead.
 *
 * Direct `gh issue create` call sites (and `gh api` REST or GraphQL issue
 * creation) elsewhere in `worker/deno/lib` and
 * `worker/deno/commands` are gated by the `issue_create_routing_check.ts`
 * allowlist (Issue #3746): a new direct call site fails its test unless it is
 * routed through `fileRoutedIssue` or listed with a one-line reason.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger } from "../types.ts";
import { filterReservedLabelsWithWarning, runGhCommand } from "./github.ts";
import {
  classifyIssueRouting,
  type IssueRoutingContext,
  type RoutingDecision,
} from "./issue_routing_classifier.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import {
  type GhCommandFn,
  type IssueRoutingGithubDeps,
  normaliseRoutingTitle,
  requireWriteAccess,
} from "./issue_routing_github.ts";
import { defaultLogger } from "./logger.ts";
import { findOwnedOpenArtefact } from "./owned_open_artefact.ts";

/** A draft issue to file. */
export interface RoutedIssueDraft {
  title: string;
  body?: string;
  /** Labels requested for the issue; reserved ones are stripped. */
  labels?: readonly string[];
}

/** What {@link fileRoutedIssue} did, or would do in a dry run. */
export type RoutedIssueAction =
  | "created"
  | "reused"
  | "would-create"
  | "would-reuse"
  | "ambiguous";

/** The step of {@link fileRoutedIssue} that failed. */
export type RoutedIssueStep =
  | "classify"
  | "search"
  | "permission"
  | "create"
  | "recheck"
  | "close-duplicate";

/** The outcome of one routed filing. */
export interface RoutedIssueResult {
  decision: RoutingDecision;
  action: RoutedIssueAction;
  /** Repository the issue is (or would be) in. */
  repository: string;
  /** The issue number; `null` when nothing exists yet or nothing was filed. */
  number: number | null;
  /** Requested labels left behind because the issue is in another repository. */
  labels_not_migrated: string[];
  /** A concurrent copy this run created and then closed, if any. */
  closed_duplicate?: number;
}

/** Options for {@link fileRoutedIssue}. */
export interface FileRoutedIssueOptions extends IssueRoutingGithubDeps {
  /** The repository the draft was written against (`owner/name`). */
  targetRepo: string;
  context: IssueRoutingContext;
  /** When true, no `gh` write call is made. */
  dryRun?: boolean;
  /**
   * A decision the caller has already made, used instead of classifying the
   * draft. Only for an explicit operator choice, such as one `route-issue
   * --part` per codebase (Issue #3748); its owner must still pass the
   * permission check.
   */
  decision?: RoutingDecision;
  /** Configured custom labels, reserved like the built-in ones (Issue #847). */
  extraReservedLabels?: readonly string[];
  /** Fleet author set for the owned-artefact checks; omitted means configured identity. */
  authors?: AlertDedupAuthorOptions;
  logger?: Logger;
}

/** The hidden marker that makes an issue this tool's (the prefix is enough). */
const OWNED_ISSUE_MARKER = "<!-- issue-routing";

/** A failed step of a routed filing; the message names the step. */
export class RoutedIssueFilingError extends Error {
  readonly step: RoutedIssueStep;
  readonly repository: string;
  /** The routing decision, or `null` when the classify step itself failed. */
  readonly decision: RoutingDecision | null;

  constructor(
    step: RoutedIssueStep,
    repository: string,
    cause: unknown,
    decision: RoutingDecision | null,
  ) {
    super(
      `Routed issue filing failed at step "${step}" for ${repository}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "RoutedIssueFilingError";
    this.step = step;
    this.repository = repository;
    this.decision = decision;
  }
}

/** The `<!-- issue-routing … -->` marker's prefix. */
export const ISSUE_ROUTING_MARKER_PREFIX = "<!-- issue-routing ";

/** GitHub repository names are case-insensitive. */
function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The visible `Routing:` line and the hidden marker for a decision. The
 * repositories are validated `owner/name` slugs and the kind is a fixed
 * word, so the marker needs no escaping; the reason goes only in the
 * visible line, on one line.
 */
export function formatRoutingAudit(decision: RoutingDecision): string {
  const reason = decision.reason.replace(/\s+/g, " ").trim();
  return [
    `Routing: owner \`${decision.owner_repository}\`, subject ` +
    `\`${decision.subject_repository}\`, kind \`${decision.issue_kind}\` ` +
    `— ${reason}`,
    `${ISSUE_ROUTING_MARKER_PREFIX}owner=${decision.owner_repository} ` +
    `subject=${decision.subject_repository} ` +
    `kind=${decision.issue_kind} -->`,
  ].join("\n");
}

/** The issue number at the end of the URL `gh issue create` prints. */
function parseCreatedNumber(output: string): number {
  const match = /\/issues\/(\d+)\s*$/.exec(output.trim());
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(
      `gh issue create printed no issue URL: ${
        JSON.stringify(output.trim().slice(0, 200))
      }`,
    );
  }
  return number;
}

/** Run `fn`, rethrowing any failure as a {@link RoutedIssueFilingError}. */
async function step<T>(
  name: RoutedIssueStep,
  repository: string,
  decision: RoutingDecision | null,
  fn: () => Promise<T> | T,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new RoutedIssueFilingError(name, repository, error, decision);
  }
}

/**
 * File `draft` in the repository that owns it, or report what would be
 * done. See the module doc for the steps.
 *
 * @throws RoutedIssueFilingError naming the failed step and repository; its
 *   `cause` is the underlying error (an `IssueRoutingPermissionError` for a
 *   refused write) and its `decision` is the routing decision, or `null` when
 *   classify failed
 */
export async function fileRoutedIssue(
  draft: RoutedIssueDraft,
  opts: FileRoutedIssueOptions,
): Promise<RoutedIssueResult> {
  const logger = opts.logger ?? defaultLogger;
  const deps: IssueRoutingGithubDeps = {
    ghCommandFn: opts.ghCommandFn,
    now: opts.now,
  };
  const gh: GhCommandFn = opts.ghCommandFn ?? runGhCommand;
  // Search and recheck share one lookup: owned, open, fleet-authored, same title.
  const findOwned = (repo: string, title: string) =>
    findOwnedOpenArtefact({
      repo,
      kind: "issue",
      marker: OWNED_ISSUE_MARKER,
      search: `"${title.replace(/"/g, "")}" in:title`,
      accept: (row) =>
        normaliseRoutingTitle(row.title ?? "") === normaliseRoutingTitle(title),
      ghCommandFn: gh,
      authors: opts.authors,
      log: (message) => logger.warn(message, { repo }),
    });

  const decision = await step(
    "classify",
    opts.targetRepo,
    null,
    () =>
      opts.decision ??
        classifyIssueRouting(draft, opts.targetRepo, opts.context),
  );
  const repository = decision.owner_repository;
  const requested = [...(draft.labels ?? [])];
  const crossRepo = !sameRepo(repository, opts.targetRepo);
  const labelsNotMigrated = crossRepo ? requested : [];
  const result = (
    action: RoutedIssueAction,
    number: number | null,
  ): RoutedIssueResult => ({
    decision,
    action,
    repository,
    number,
    labels_not_migrated: labelsNotMigrated,
  });

  if (decision.issue_kind === "ambiguous") {
    logger.warn("Issue routing filed nothing: the owner is ambiguous", {
      repo: opts.targetRepo,
      reason: decision.reason,
    });
    return result("ambiguous", null);
  }

  const existing = await step(
    "search",
    repository,
    decision,
    () => findOwned(repository, draft.title),
  );
  if (existing !== null) {
    return result(opts.dryRun ? "would-reuse" : "reused", existing.number);
  }

  await step(
    "permission",
    repository,
    decision,
    () => requireWriteAccess(repository, deps),
  );
  if (opts.dryRun) return result("would-create", null);

  const labels = crossRepo ? [] : filterReservedLabelsWithWarning(
    requested,
    `${repository} routed issue`,
    logger,
    opts.extraReservedLabels ?? [],
  );
  const bodyParts = [draft.body ?? ""];
  if (labelsNotMigrated.length > 0) {
    bodyParts.push(`Labels not migrated: ${labelsNotMigrated.join(", ")}`);
  }
  bodyParts.push(formatRoutingAudit(decision));
  const body = bodyParts.filter((p) => p.trim() !== "").join("\n\n");

  const number = await step(
    "create",
    repository,
    decision,
    async () =>
      parseCreatedNumber(
        await gh([
          "issue",
          "create",
          "--repo",
          repository,
          "--title",
          draft.title,
          "--body",
          body,
          ...labels.flatMap((l) => ["--label", l]),
        ]),
      ),
  );

  // Concurrent filers converge on the lowest-numbered owned, open match.
  const after = await step(
    "recheck",
    repository,
    decision,
    () => findOwned(repository, draft.title),
  );
  const older = after !== null && after.number < number ? after.number : undefined;
  if (older === undefined) return result("created", number);

  await step("close-duplicate", repository, decision, () =>
    gh([
      "issue",
      "close",
      String(number),
      "--repo",
      repository,
      "--reason",
      "not planned",
      "--comment",
      `Duplicate of #${older}, filed concurrently with the same title. ` +
      `#${older} has the lower number, so it is the one kept.`,
    ]));
  logger.info("Issue routing closed a concurrent duplicate", {
    repo: repository,
    closed: number,
    kept: older,
  });
  return { ...result("reused", older), closed_duplicate: number };
}
