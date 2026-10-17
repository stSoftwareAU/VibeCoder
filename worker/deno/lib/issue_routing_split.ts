/**
 * Cross-repository split filing (Issue #3748, part of #3691).
 *
 * Work that spans several independently deployable codebases gets one issue
 * per codebase, each listing its siblings, instead of one issue in whichever
 * repository noticed it first. {@link fileSplitIssues} files each part
 * through `fileRoutedIssue` with the operator's explicit owner, then edits
 * every body to carry a sibling block naming the others.
 *
 * - A part that already exists is reused, so a re-run after a part-way
 *   failure completes the set without filing a part twice. "Exists" means an
 *   open issue in the part's repository with the same title that carries this
 *   tool's `<!-- issue-routing owner=<part repo> … kind=cross-repo -->`
 *   marker; any other same-titled issue or PR (closed, or filed by someone
 *   else) fails that part and is left unedited.
 * - A part that fails is reported with its error; the remaining parts are
 *   still filed, and siblings are linked only once every part exists.
 * - Labels apply only to the part in the drafting repository; no labels or
 *   assignees are copied between parts.
 * - A dry run makes no write call and reports every planned part.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger } from "../types.ts";
import { runGhCommand } from "./github.ts";
import type {
  IssueRoutingContext,
  RoutingDecision,
} from "./issue_routing_classifier.ts";
import {
  fileRoutedIssue,
  ISSUE_ROUTING_MARKER_PREFIX,
  type RoutedIssueAction,
} from "./issue_routing_filing.ts";
import type {
  GhCommandFn,
  IssueRoutingGithubDeps,
} from "./issue_routing_github.ts";
import { defaultLogger } from "./logger.ts";
import { isValidRepoSlug } from "./repo_slug.ts";

/** One codebase's share of the work. */
export interface SplitPart {
  repo: string;
  title: string;
}

/** What happened to one part. */
export interface SplitPartResult extends SplitPart {
  action: RoutedIssueAction | "failed";
  number: number | null;
  error?: string;
}

/** The outcome of a split filing. */
export interface SplitResult {
  /** True when every part exists (or, in a dry run, could be filed). */
  complete: boolean;
  /** True when every part's body lists its siblings. */
  linked: boolean;
  parts: SplitPartResult[];
  /** `owner/name` of each part with no issue yet. */
  missing: string[];
}

/** Options for {@link fileSplitIssues}. */
export interface SplitOptions extends IssueRoutingGithubDeps {
  /** The repository the work was drafted in (`owner/name`). */
  targetRepo: string;
  /** The shared body each part's issue starts with. */
  body: string;
  /** Labels for the part in `targetRepo` only. */
  labels?: readonly string[];
  context: IssueRoutingContext;
  dryRun?: boolean;
  extraReservedLabels?: readonly string[];
  logger?: Logger;
}

const SIBLINGS_START = "<!-- route-issue-siblings -->";
const SIBLINGS_END = "<!-- /route-issue-siblings -->";

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Refuse a part list that is not one issue per configured codebase: fewer
 * than two parts, a repository named twice, an invalid repository, or one
 * outside the worker's own and the configured product repositories.
 *
 * @returns An error message, or `null` when the parts are valid
 */
export function validateSplitParts(
  parts: readonly SplitPart[],
  ctx: IssueRoutingContext,
): string | null {
  if (parts.length < 2) {
    return "a split needs at least two --part entries, one per codebase";
  }
  const allowed = [ctx.vibeCoderRepo, ...ctx.productRepos];
  const seen: string[] = [];
  for (const part of parts) {
    if (!isValidRepoSlug(part.repo)) {
      return `--part repository is not owner/name: ${
        JSON.stringify(part.repo)
      }`;
    }
    if (part.title.trim() === "") return `--part ${part.repo} has no title`;
    if (!allowed.some((r) => sameRepo(r, part.repo))) {
      return `--part ${part.repo} is not ${ctx.vibeCoderRepo} or a ` +
        "configured repository";
    }
    if (seen.some((r) => sameRepo(r, part.repo))) {
      return `--part names ${part.repo} twice; one issue per codebase`;
    }
    seen.push(part.repo);
  }
  return null;
}

/** The explicit decision for one part: the operator named its owner. */
function partDecision(part: SplitPart, targetRepo: string): RoutingDecision {
  return {
    owner_repository: part.repo,
    subject_repository: targetRepo,
    issue_kind: "cross-repo",
    reason: `operator split (--part): one issue per independently ` +
      `deployable codebase, this part in ${part.repo}`,
  };
}

/** `body` with its sibling block set to `lines`, replacing any earlier one. */
export function withSiblingBlock(body: string, lines: string[]): string {
  const block = [
    SIBLINGS_START,
    "Sibling issues, one per codebase:",
    ...lines,
    SIBLINGS_END,
  ].join("\n");
  const start = body.indexOf(SIBLINGS_START);
  const end = body.indexOf(SIBLINGS_END);
  if (start !== -1 && end > start) {
    return body.slice(0, start) + block +
      body.slice(end + SIBLINGS_END.length);
  }
  return `${body.trimEnd()}\n\n${block}`;
}

/**
 * Whether `body` carries this tool's marker for `part`: the owner is the
 * part's repository and the kind is `cross-repo` (what {@link partDecision}
 * records).
 */
function hasPartMarker(body: string, part: SplitPart): boolean {
  let from = 0;
  for (;;) {
    const start = body.indexOf(ISSUE_ROUTING_MARKER_PREFIX, from);
    if (start === -1) return false;
    const end = body.indexOf("-->", start);
    if (end === -1) return false;
    const fields = body.slice(start + ISSUE_ROUTING_MARKER_PREFIX.length, end)
      .trim().split(" ");
    if (
      fields.includes("kind=cross-repo") &&
      fields.some((f) =>
        f.startsWith("owner=") && sameRepo(f.slice(6), part.repo)
      )
    ) {
      return true;
    }
    from = end;
  }
}

/**
 * Refuse to reuse (and later edit) a same-titled issue that is not this
 * tool's open part: the title search also returns PRs, issues closed in the
 * last 30 days and unrelated issues.
 *
 * @throws Error naming the issue when it is closed or lacks the marker
 */
async function requireReusablePart(
  gh: GhCommandFn,
  part: SplitPart,
  number: number,
): Promise<void> {
  const raw = await gh([
    "issue",
    "view",
    String(number),
    "--repo",
    part.repo,
    "--json",
    "body,state",
  ]);
  const parsed = JSON.parse(raw) as { body?: unknown; state?: unknown };
  const open = typeof parsed.state === "string" &&
    parsed.state.toUpperCase() === "OPEN";
  const marked = typeof parsed.body === "string" &&
    hasPartMarker(parsed.body, part);
  if (!open || !marked) {
    throw new Error(
      `${part.repo}#${number} has the same title but is not an open issue ` +
        `filed by route-issue --part for ${part.repo} (it is ${
          open ? "open" : "closed"
        }, ${marked ? "with" : "without"} the issue-routing marker); left ` +
        `unchanged, not reused. Close or retitle it, or choose another part title`,
    );
  }
}

/** Edit each part's body to list its siblings; skips a body already up to date. */
async function linkSiblings(
  gh: GhCommandFn,
  parts: SplitPartResult[],
): Promise<void> {
  for (const part of parts) {
    const lines = parts
      .filter((p) => p !== part)
      .map((p) => `- ${p.repo}#${p.number} — ${p.title}`);
    const raw = await gh([
      "issue",
      "view",
      String(part.number),
      "--repo",
      part.repo,
      "--json",
      "body",
    ]);
    const parsed = JSON.parse(raw) as { body?: unknown };
    const body = typeof parsed.body === "string" ? parsed.body : "";
    const next = withSiblingBlock(body, lines);
    if (next === body) continue;
    await gh([
      "issue",
      "edit",
      String(part.number),
      "--repo",
      part.repo,
      "--body",
      next,
    ]);
  }
}

/**
 * File one linked issue per part. See the module doc.
 *
 * @throws Error when the part list is invalid (before any gh call)
 */
export async function fileSplitIssues(
  parts: readonly SplitPart[],
  opts: SplitOptions,
): Promise<SplitResult> {
  const invalid = validateSplitParts(parts, opts.context);
  if (invalid !== null) throw new Error(invalid);
  const gh: GhCommandFn = opts.ghCommandFn ?? runGhCommand;
  const logger = opts.logger ?? defaultLogger;

  const results: SplitPartResult[] = [];
  for (const part of parts) {
    try {
      const filed = await fileRoutedIssue(
        { title: part.title, body: opts.body, labels: opts.labels },
        {
          targetRepo: opts.targetRepo,
          context: opts.context,
          decision: partDecision(part, opts.targetRepo),
          dryRun: opts.dryRun,
          extraReservedLabels: opts.extraReservedLabels,
          logger,
          ghCommandFn: gh,
          now: opts.now,
        },
      );
      if (
        filed.number !== null &&
        (filed.action === "reused" || filed.action === "would-reuse")
      ) {
        await requireReusablePart(gh, part, filed.number);
      }
      results.push({ ...part, action: filed.action, number: filed.number });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("route-issue could not file a split part", {
        repo: part.repo,
        error: message,
      });
      results.push({ ...part, action: "failed", number: null, error: message });
    }
  }

  const missing = results
    .filter((r) => r.action === "failed" || (!opts.dryRun && r.number === null))
    .map((r) => r.repo);
  const complete = missing.length === 0;
  if (!complete || opts.dryRun) {
    return { complete, linked: false, parts: results, missing };
  }
  try {
    await linkSiblings(gh, results);
  } catch (error) {
    throw new Error(
      `Every part exists, but linking the siblings failed (a re-run ` +
        `finishes it without filing again): ${
          error instanceof Error ? error.message : String(error)
        }`,
      { cause: error },
    );
  }
  return { complete, linked: true, parts: results, missing };
}
