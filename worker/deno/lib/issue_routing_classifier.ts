/**
 * Deterministic issue-routing classifier (Issue #3741, part of #3691).
 *
 * Decides which repository should own a draft issue, and records why. It
 * reads only the draft text and the context it is given — no network, no
 * clock, no filesystem — so every routing rule is testable from fixtures.
 *
 * Rules, in order; the first that applies wins:
 *
 * 1. A #2592 repo-scoped fast-failure diagnostic (a back-off or tally marker,
 *    confirmed by `isRepoFastFailureIssue` / `isRepoFastFailureTallyIssue`)
 *    stays in the monitored repository its marker names, whatever worker
 *    code it mentions. That repository must be the target or a configured
 *    product repository; a marker for any other name is `ambiguous`.
 * 2. A worker signal (worker, fleet, container, prompt, provider or
 *    orchestration code) with no product signal belongs in `vibeCoderRepo`.
 * 3. A product signal with no worker signal belongs in the repository that
 *    versions that code: the one product repository the draft names, or the
 *    target when it names none and the target is a product repository.
 * 4. A worker signal and a product signal with one product repository
 *    identified, drafted in either codebase, is `cross-repo`: it needs one
 *    issue per codebase, and the draft stays in its target.
 * 5. Anything else — no signal, several product repositories, a product
 *    signal with no product repository, conflicting markers — is
 *    `ambiguous`: the draft stays in its target, the reason states the
 *    basis, and nothing is closed.
 *
 * Repository names compare case-insensitively. A missing title or target
 * repository throws, naming the field; there is no default owner.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { escapeRegExp } from "./regexp_escape.ts";
import {
  isRepoFastFailureIssue,
  isRepoFastFailureTallyIssue,
  REPO_FAST_FAILURE_MARKER_PREFIX,
  REPO_FAST_FAILURE_TALLY_MARKER_PREFIX,
} from "./repo_fast_failure_issue.ts";

/** What kind of issue a draft is, for routing. */
export type IssueKind =
  | "implementation"
  | "diagnostic"
  | "cross-repo"
  | "ambiguous";

/** A routing decision and its audit trail; every field is always filled. */
export interface RoutingDecision {
  /** Repository the issue belongs in (`owner/name`). */
  owner_repository: string;
  /** Repository whose behaviour the issue describes (`owner/name`). */
  subject_repository: string;
  issue_kind: IssueKind;
  /** The basis for the decision, naming the signals it rests on. */
  reason: string;
}

/** The draft being routed. */
export interface IssueRoutingDraft {
  title: string;
  body?: string;
}

/** The repositories a draft can be routed to. */
export interface IssueRoutingContext {
  /** The worker's own repository, e.g. `stSoftwareAU/VibeCoder`. */
  vibeCoderRepo: string;
  /** Product repositories (`owner/name`) a draft can name as its owner. */
  productRepos: readonly string[];
}

/** Worker code paths. Literal alternation behind a fixed-width lookbehind. */
const WORKER_PATH_RE =
  /(?<![\w./-])(?:worker\/deno\/|prompts\/|container\/providers\/|container\/toolchains\/)/i;

/**
 * Worker vocabulary. Only worker-specific terms: a generic word such as
 * "worker", "provider" or "container" also names product code (a service
 * worker, a price provider, a Docker container).
 */
const WORKER_TERM_RE =
  /\b(?:fleet|orchestration|orchestrator|lane worktrees?|prompt templates?|agent providers?|coding[- ]agents?)\b/i;

/**
 * User-facing product vocabulary, as a word in prose: the lookarounds skip a
 * word inside a path or branch name such as `milestone/3127-web-pwa-refresh`.
 */
const PRODUCT_TERM_RE =
  /(?<![\w./-])(?:pwa|ui|user interface|layout|chart|scoring|leaderboard|blank space)(?![\w/-])/i;

/** Product source paths: a `web/` tree, a stylesheet or a page. */
const PRODUCT_PATH_RE = /(?<![\w./-])web\/|\.(?:css|scss|html)(?![\w-])/i;

/**
 * Repository names written after a fast-failure marker prefix (back-off or
 * tally). Loose on purpose: the owner helpers then confirm the full marker,
 * so a prefix quoted in prose is not a diagnostic. Bounded class, no nested
 * quantifier: the input is untrusted issue text.
 */
const MARKER_CANDIDATE_RE = new RegExp(
  // Built from the owner module's constants, never from issue text.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  `(?:${escapeRegExp(REPO_FAST_FAILURE_TALLY_MARKER_PREFIX)}|${
    escapeRegExp(REPO_FAST_FAILURE_MARKER_PREFIX)
  }):([A-Za-z0-9_./-]{1,200})`,
  "g",
);

/**
 * SIMPLE-ON-PURPOSE: confirms at most 8 distinct marker names, each a scan of
 * the body — upgrade when a real diagnostic carries more than 8 markers.
 */
const MAX_MARKER_CANDIDATES = 8;

/** A repository as `owner/name`, each part a GitHub-safe name. */
const REPO_NAME_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** GitHub repository names are case-insensitive. */
function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Validate a repository argument, naming the field when it is missing. */
function requireRepo(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`classifyIssueRouting: ${field} is missing`);
  }
  const repo = value.trim();
  if (!REPO_NAME_RE.test(repo)) {
    throw new Error(
      `classifyIssueRouting: ${field} is not an owner/name repository: ${
        JSON.stringify(repo.slice(0, 120))
      }`,
    );
  }
  return repo;
}

/** Whether `text` names `repo` by its short name, on a name boundary. */
function mentionsRepo(text: string, repo: string): boolean {
  const name = escapeRegExp(repo.slice(repo.lastIndexOf("/") + 1));
  // The name comes from validated configuration and is escaped, never from
  // issue text, so the pattern is not attacker-controlled.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`(?<![\\w.-])${name}(?![\\w-])`, "i").test(text);
}

/**
 * The distinct repositories whose fast-failure marker `body` carries, or
 * `null` when it names more candidates than can be checked.
 */
function fastFailureRepos(body: string): string[] | null {
  const candidates = [
    ...new Set([...body.matchAll(MARKER_CANDIDATE_RE)].map((m) => m[1]!)),
  ];
  if (candidates.length > MAX_MARKER_CANDIDATES) return null;
  const repos: string[] = [];
  for (const repo of candidates) {
    const marked = isRepoFastFailureIssue(body, repo) ||
      isRepoFastFailureTallyIssue(body, repo);
    if (marked && !repos.some((r) => sameRepo(r, repo))) repos.push(repo);
  }
  return repos;
}

/** The matched text of each pattern that matches, in pattern order. */
function signals(text: string, patterns: readonly RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) found.push(match[0]);
  }
  return found;
}

function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.map((i) => `'${i}'`).join(", ") : "none";
}

/**
 * Decide which repository should own `draft`, drafted against `targetRepo`.
 * Pure and deterministic. See the module doc for the rules.
 *
 * @throws Error naming the field when the title, the target repository or a
 *   context repository is missing or not `owner/name`
 */
export function classifyIssueRouting(
  draft: IssueRoutingDraft,
  targetRepo: string,
  ctx: IssueRoutingContext,
): RoutingDecision {
  if (typeof draft?.title !== "string" || draft.title.trim() === "") {
    throw new Error("classifyIssueRouting: draft.title is missing");
  }
  const target = requireRepo(targetRepo, "targetRepo");
  const vibe = requireRepo(ctx.vibeCoderRepo, "ctx.vibeCoderRepo");
  const products = ctx.productRepos.map((r, i) =>
    requireRepo(r, `ctx.productRepos[${i}]`)
  );
  const body = draft.body ?? "";

  const decide = (
    owner: string,
    subject: string,
    kind: IssueKind,
    reason: string,
  ): RoutingDecision => ({
    owner_repository: owner,
    subject_repository: subject,
    issue_kind: kind,
    reason,
  });
  const ambiguous = (basis: string): RoutingDecision =>
    decide(
      target,
      target,
      "ambiguous",
      `ambiguous owner: ${basis}; stays in ${target}, close nothing automatically`,
    );

  // 1. #2592: a repo-scoped diagnostic stays in the repository it describes.
  const marked = fastFailureRepos(body);
  if (marked === null) {
    return ambiguous(
      `more than ${MAX_MARKER_CANDIDATES} fast-failure marker names to check`,
    );
  }
  if (marked.some((r) => sameRepo(r, target))) {
    return decide(
      target,
      target,
      "diagnostic",
      `fast-failure marker for ${target}: a repo-scoped diagnostic (#2592) ` +
        "stays in the repository it describes",
    );
  }
  // A marker can only send a draft to a configured product repository: any
  // other name comes from untrusted text, so it conflicts. A configured name
  // is already a validated owner/name, so a match is one too.
  const monitoredRepos = marked.map((r) =>
    products.find((p) => !sameRepo(p, vibe) && sameRepo(p, r))
  );
  if (monitoredRepos.some((r) => r === undefined)) {
    return ambiguous(
      `fast-failure marker for a repository that is not a configured ` +
        `product repository (${marked.join(", ")})`,
    );
  }
  if (marked.length === 1) {
    const monitored = monitoredRepos[0]!;
    return decide(
      monitored,
      monitored,
      "diagnostic",
      `fast-failure marker for ${monitored}, drafted against ${target}: a ` +
        "repo-scoped diagnostic (#2592) stays in the repository it describes",
    );
  }
  if (marked.length > 1) {
    return ambiguous(
      `fast-failure markers for several repositories (${marked.join(", ")})`,
    );
  }

  // 2–5. Worker and product signals.
  const text = `${draft.title}\n${body}`;
  const worker = signals(text, [WORKER_PATH_RE, WORKER_TERM_RE]);
  const product = signals(text, [PRODUCT_TERM_RE, PRODUCT_PATH_RE]);
  const named = products.filter((r) =>
    !sameRepo(r, vibe) && mentionsRepo(text, r)
  );
  const basis = `worker signals: ${listOrNone(worker)}; product signals: ${
    listOrNone(product)
  }; product repositories named: ${listOrNone(named)}`;

  if (worker.length > 0 && product.length === 0) {
    return decide(
      vibe,
      named.length === 1 ? named[0]! : target,
      "implementation",
      `a worker change with no product signal (${basis}): belongs in ${vibe}`,
    );
  }

  const productRepo = identifyProductRepo(named, target, vibe, products);
  if (worker.length === 0 && product.length > 0 && productRepo !== null) {
    return decide(
      productRepo,
      productRepo,
      "implementation",
      `a product change with no worker signal (${basis}): belongs in ` +
        `${productRepo}, which versions that code`,
    );
  }
  const draftedInEither = productRepo !== null &&
    (sameRepo(target, vibe) || sameRepo(target, productRepo));
  if (worker.length > 0 && draftedInEither) {
    return decide(
      target,
      sameRepo(target, vibe) ? productRepo! : vibe,
      "cross-repo",
      `both a worker change and a product change (${basis}): needs one ` +
        `issue per codebase, ${vibe} and ${productRepo}`,
    );
  }

  // A worker signal with no product signal returned above, so no product
  // signal here means no signal at all.
  if (product.length === 0) {
    return ambiguous(`no worker or product signal (${basis})`);
  }
  if (named.length > 1) {
    return ambiguous(`names several product repositories (${basis})`);
  }
  if (productRepo === null) {
    return ambiguous(`a product signal but no product repository (${basis})`);
  }
  return ambiguous(
    `worker and product signals, but ${target} is neither codebase (${basis})`,
  );
}

/**
 * The product repository a draft's product signal points at: the one it
 * names, else the target when that is a product repository; `null` when it
 * names several or none can be identified.
 */
function identifyProductRepo(
  named: readonly string[],
  target: string,
  vibe: string,
  products: readonly string[],
): string | null {
  if (named.length > 1) return null;
  if (named.length === 1) return named[0]!;
  const isProduct = !sameRepo(target, vibe) &&
    products.some((r) => sameRepo(r, target));
  return isProduct ? target : null;
}
