import { escapeRegExp } from "./regexp_escape.ts";
import {
  isRepoFastFailureIssue,
  isRepoFastFailureTallyIssue,
} from "./repo_fast_failure_issue.ts";
import type {
  IssueKind,
  IssueRoutingContext,
  IssueRoutingDraft,
  RoutingDecision,
} from "./issue_routing_types.ts";

/** Paths that only the worker repository owns. */
const WORKER_PATH_RE = /worker\/deno\/|prompts\/|prompt\.md/i;
/** Worker vocabulary. Flat alternation, one optional-free literal each. */
const WORKER_KEYWORD_RE =
  /vibe[ -]?coder|\bworker\b|\bfleet\b|orchestrat|container image|lane worktree|\bclaim|prompt template|\bprovider/i;
/** User-facing / product vocabulary. */
const PRODUCT_RE =
  /\b(?:pwa|scoring|ui|page|layout|chart|blank space|api endpoint|database|report)\b/i;

function shortName(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Whether `text` names the repository, by short name on a name boundary. */
function mentionsRepo(text: string, repo: string): boolean {
  const name = escapeRegExp(shortName(repo));
  // The name is escaped above and comes from a configured repository, never
  // from issue text, so the pattern is not attacker-controlled (Issue #3691).
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`(?<![A-Za-z0-9_.-])${name}(?![A-Za-z0-9_-])`, "i").test(
    text,
  );
}

function vibeSignals(text: string, vibeRepo: string): string[] {
  const found: string[] = [];
  const path = WORKER_PATH_RE.exec(text);
  if (path) found.push(`path '${path[0]}'`);
  const keyword = WORKER_KEYWORD_RE.exec(text);
  if (keyword) found.push(`keyword '${keyword[0]}'`);
  if (mentionsRepo(text, vibeRepo)) found.push(`mention of ${vibeRepo}`);
  return found;
}

function build(
  owner: string,
  subject: string,
  kind: IssueKind,
  reason: string,
  targetRepo: string,
  ambiguous = false,
): RoutingDecision {
  return {
    owner_repository: owner,
    subject_repository: subject,
    issue_kind: kind,
    reason,
    wrong_repo: !ambiguous && !sameRepo(owner, targetRepo),
    ambiguous,
  };
}

/** Distinct repositories named by the parts, in first-seen order. */
export function partRepos(draft: IssueRoutingDraft): string[] {
  const repos: string[] = [];
  for (const part of draft.parts ?? []) {
    if (!repos.some((r) => sameRepo(r, part.repo))) repos.push(part.repo);
  }
  return repos;
}

/**
 * Decide which repository should own a draft. Pure and deterministic; the
 * first matching rule wins.
 */
export function classifyIssueRouting(
  draft: IssueRoutingDraft,
  targetRepo: string,
  ctx: Pick<IssueRoutingContext, "vibeCoderRepo" | "allowedRepos">,
): RoutingDecision {
  const body = draft.body ?? "";

  // 1. #2592: a repo-scoped diagnostic stays in the repo it describes.
  if (
    isRepoFastFailureIssue(body, targetRepo) ||
    isRepoFastFailureTallyIssue(body, targetRepo)
  ) {
    return build(
      targetRepo,
      targetRepo,
      "diagnostic",
      `fast-failure marker for ${targetRepo}: repo-scoped diagnostic ` +
        "exception (#2592), always filed in the repository it describes",
      targetRepo,
    );
  }

  // 2. Explicit split across repositories.
  const repos = partRepos(draft);
  if (repos.length >= 2) {
    const owner = repos.find((r) => sameRepo(r, targetRepo)) ?? repos[0]!;
    return build(
      owner,
      targetRepo,
      "cross-repo",
      `parts span ${repos.length} repositories: ${repos.join(", ")}`,
      targetRepo,
    );
  }

  // 3. Signals.
  const text = `${draft.title ?? ""}\n${body}`;
  const vibe = vibeSignals(text, ctx.vibeCoderRepo);
  const product = PRODUCT_RE.exec(text);
  const named = ctx.allowedRepos.filter((r) =>
    !sameRepo(r, ctx.vibeCoderRepo) && mentionsRepo(text, r)
  );
  const foreign = named.filter((r) => !sameRepo(r, targetRepo));
  const vibeBasis = vibe.length > 0
    ? `Vibe Coder signals (${vibe.join(", ")})`
    : "no Vibe Coder signals";

  // 4. Decide.
  if (sameRepo(targetRepo, ctx.vibeCoderRepo)) {
    if (foreign.length >= 2) {
      return build(
        targetRepo,
        targetRepo,
        "implementation",
        `names several other repositories (${foreign.join(", ")}): ` +
          "ambiguous owner, close nothing automatically",
        targetRepo,
        true,
      );
    }
    if (foreign.length === 1) {
      const other = foreign[0]!;
      if (vibe.length === 0) {
        return build(
          other,
          other,
          "implementation",
          `names ${other} and has ${vibeBasis}: the work belongs to ${other}`,
          targetRepo,
        );
      }
      return build(
        targetRepo,
        other,
        "cross-repo",
        `names ${other} and has ${vibeBasis}: ambiguous, needs a split ` +
          "into one issue per repository; close nothing automatically",
        targetRepo,
        true,
      );
    }
    return build(
      targetRepo,
      targetRepo,
      "implementation",
      `names no other repository (${vibeBasis}): stays in ${targetRepo}`,
      targetRepo,
    );
  }

  if (foreign.length >= 1) {
    return build(
      targetRepo,
      targetRepo,
      "implementation",
      `names another repository besides ${targetRepo} ` +
        `(${foreign.join(", ")}): ambiguous owner, close nothing automatically`,
      targetRepo,
      true,
    );
  }
  if (vibe.length > 0 && product === null) {
    return build(
      ctx.vibeCoderRepo,
      targetRepo,
      "implementation",
      `${vibeBasis} and no product signals: the fix belongs to ` +
        ctx.vibeCoderRepo,
      targetRepo,
    );
  }
  if (vibe.length > 0 && product !== null) {
    return build(
      targetRepo,
      targetRepo,
      "implementation",
      `${vibeBasis} and product signal '${product[0]}': ambiguous owner ` +
        "(both bases apply), close nothing automatically",
      targetRepo,
      true,
    );
  }
  return build(
    targetRepo,
    targetRepo,
    "implementation",
    `${vibeBasis}: stays in ${targetRepo}`,
    targetRepo,
  );
}

/** Keep marker values inert: nothing that could close the comment. */
export function markerValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_./-]/g, "-");
}
