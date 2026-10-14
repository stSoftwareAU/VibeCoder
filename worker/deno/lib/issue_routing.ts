/**
 * Deterministic cross-repository issue routing (Issue #3691).
 *
 * The worker files issues in whichever repository it happened to be working
 * in, so a product gap seen while working on the Vibe Coder repository lands
 * in the wrong place (and vice versa). This module decides, from the draft
 * text alone and with no model call, which repository should own an issue,
 * then creates it there — or reuses an existing one — behind a permission
 * check, a duplicate search and a deterministic tie-break between concurrent
 * filers.
 *
 * Invariants:
 *
 * - **Diagnostics stay put (#2592).** A repo-scoped fast-failure diagnostic
 *   is filed in the repository it describes, whatever its text mentions.
 * - **Ambiguity closes nothing.** An ambiguous decision is filed where it
 *   was found with the basis recorded, and nothing is closed automatically.
 * - **Fail loud.** Permission problems throw {@link IssueRoutingPermissionError}
 *   and malformed `gh` output throws; nothing is swallowed. Every failure
 *   precedes the write it guards, so a retry is safe.
 * - **Labels are never silently migrated.** A cross-repository issue is
 *   created without labels and says so in its body.
 * - **Dry-run is read-only.**
 *
 * Every regex below is a flat alternation of literals with no nested or
 * overlapping quantifier, because the input is untrusted issue text.
 *
 * Australian English spelling used throughout.
 */

import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import {
  isRepoFastFailureIssue,
  isRepoFastFailureTallyIssue,
} from "./repo_fast_failure_issue.ts";
import type { Logger } from "../types.ts";

export type IssueKind = "implementation" | "diagnostic" | "cross-repo";

export interface IssueRoutingPart {
  repo: string;
  title: string;
  body: string;
  dependsOnRepos?: readonly string[];
}

export interface IssueRoutingDraft {
  title: string;
  body: string;
  labels: readonly string[];
  parts?: readonly IssueRoutingPart[];
}

export interface IssueRoutingContext {
  /** The worker's own repository, e.g. `stSoftwareAU/VibeCoder`. */
  vibeCoderRepo: string;
  /**
   * Full `owner/repo` names the worker may file in. A write to a repository
   * other than the target needs it listed here.
   */
  allowedRepos: readonly string[];
  dryRun: boolean;
  recentlyClosedDays: number;
  /** Injected clock (epoch milliseconds). */
  nowMs: number;
}

export interface RoutingDecision {
  owner_repository: string;
  subject_repository: string;
  issue_kind: IssueKind;
  reason: string;
  wrong_repo: boolean;
  ambiguous: boolean;
}

export type RoutingAction =
  | "created"
  | "reused"
  | "dry-run"
  | "filed-ambiguous"
  | "split";

export interface RoutedIssueRef {
  repo: string;
  number: number | null;
  url: string | null;
  state: "open" | "closed" | "dry-run";
}

export interface IssueRoutingAudit extends RoutingDecision {
  action: RoutingAction;
  issues: RoutedIssueRef[];
  labels_not_migrated: string[];
}

/** Raised when a write is not permitted. Never swallowed. */
export class IssueRoutingPermissionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IssueRoutingPermissionError";
  }
}

type Gh = (args: string[]) => Promise<string>;

const CALLER = "worker/deno/lib/issue_routing.ts";
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set([
  "WRITE",
  "MAINTAIN",
  "ADMIN",
  "TRIAGE",
]);
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/** Paths that only the worker repository owns. */
const VIBE_PATH_RE = /worker\/deno\/|prompts\/|prompt\.md/i;
/** Worker vocabulary. Flat alternation, one optional-free literal each. */
const VIBE_KEYWORD_RE =
  /vibe[ -]?coder|\bworker\b|\bfleet\b|orchestrat|container image|lane worktree|\bclaim|prompt template|\bprovider/i;
/** User-facing / product vocabulary. */
const PRODUCT_RE =
  /\b(?:pwa|scoring|ui|page|layout|chart|blank space|api endpoint|database|report)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortName(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Whether `text` names the repository, by short name on a name boundary. */
function mentionsRepo(text: string, repo: string): boolean {
  const name = escapeRegExp(shortName(repo));
  return new RegExp(`(?<![A-Za-z0-9_.-])${name}(?![A-Za-z0-9_-])`, "i").test(
    text,
  );
}

function vibeSignals(text: string, vibeRepo: string): string[] {
  const found: string[] = [];
  const path = VIBE_PATH_RE.exec(text);
  if (path) found.push(`path '${path[0]}'`);
  const keyword = VIBE_KEYWORD_RE.exec(text);
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
function partRepos(draft: IssueRoutingDraft): string[] {
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
function markerValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_./-]/g, "-");
}

/** Visible routing line plus the hidden machine-readable marker. */
export function formatRoutingAuditBlock(decision: RoutingDecision): string {
  const reason = decision.reason.replace(/\s+/g, " ").trim();
  return `Routing: owner \`${decision.owner_repository}\`, subject ` +
    `\`${decision.subject_repository}\`, kind ${decision.issue_kind} ` +
    `(${reason})\n` +
    `<!-- VIBE_ISSUE_ROUTING owner=${
      markerValue(decision.owner_repository)
    } subject=${markerValue(decision.subject_repository)} kind=${
      markerValue(decision.issue_kind)
    } -->`;
}

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

interface SearchRow {
  number: number;
  title: string;
  state: string;
  closedAt?: string | null;
  url?: string | null;
}

function normaliseTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseRows(raw: string, what: string): SearchRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed JSON from ${what}: ${err}`, { cause: err });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected (non-array) JSON from ${what}`);
  }
  return parsed.filter((r): r is SearchRow =>
    typeof r === "object" && r !== null &&
    typeof (r as SearchRow).number === "number" &&
    typeof (r as SearchRow).title === "string"
  );
}

/** A reusable existing issue or PR with this exact title, lowest first. */
async function findMatches(
  repo: string,
  title: string,
  ctx: IssueRoutingContext,
  gh: Gh,
): Promise<RoutedIssueRef[]> {
  const search = `${title} in:title`;
  const fields = "number,title,state,closedAt,url";
  const issues = parseRows(
    await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      search,
      "--json",
      fields,
      "--limit",
      "50",
    ]),
    `gh issue list (${repo})`,
  );
  const prs = parseRows(
    await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      search,
      "--json",
      fields,
    ]),
    `gh pr list (${repo})`,
  );
  const want = normaliseTitle(title);
  const windowMs = ctx.recentlyClosedDays * MS_PER_DAY;
  const matches: RoutedIssueRef[] = [];
  const consider = (row: SearchRow): void => {
    if (normaliseTitle(row.title) !== want) return;
    const open = row.state.toUpperCase() === "OPEN";
    if (!open) {
      const closedMs = Date.parse(row.closedAt ?? "");
      if (!Number.isFinite(closedMs) || ctx.nowMs - closedMs > windowMs) {
        return;
      }
    }
    matches.push({
      repo,
      number: row.number,
      url: row.url ?? null,
      state: open ? "open" : "closed",
    });
  };
  issues.forEach(consider);
  prs.forEach(consider);
  return matches.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

/** Require the write permission needed to file in `repo`. */
async function requireWriteAccess(
  repo: string,
  ctx: IssueRoutingContext,
  gh: Gh,
): Promise<void> {
  if (!ctx.allowedRepos.some((r) => sameRepo(r, repo))) {
    throw new IssueRoutingPermissionError(
      `Refusing to write to ${repo}: not in the allowed repositories`,
    );
  }
  let observed: string;
  try {
    observed = (await gh([
      "repo",
      "view",
      repo,
      "--json",
      "viewerPermission",
      "--jq",
      ".viewerPermission",
    ])).trim();
  } catch (err) {
    throw new IssueRoutingPermissionError(
      `Could not verify permission on ${repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  if (!WRITE_PERMISSIONS.has(observed.toUpperCase())) {
    throw new IssueRoutingPermissionError(
      `Refusing to write to ${repo}: viewer permission is '${observed}'`,
    );
  }
}

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
      issues: parts.map((p) => ({
        repo: p.repo,
        number: null,
        url: null,
        state: "dry-run" as const,
      })),
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
      issues: [{ repo: dest, number: null, url: null, state: "dry-run" }],
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

/**
 * Close a wrong-repository duplicate in favour of the correct issue.
 *
 * Strict order: verify the correct issue, check the wrong one is not a
 * diagnostic, check permission, comment on both, and only then close. Any
 * earlier failure throws with nothing closed. Nothing is deleted and no
 * label or assignee is touched.
 *
 * A dry run performs the same reads and permission checks and stops just
 * before the first write, so it reports what a live run would refuse.
 */
export async function resolveWrongRepoDuplicate(args: {
  wrong: { repo: string; number: number };
  correct: { repo: string; number: number };
  ctx: IssueRoutingContext;
  gh: Gh;
  logger: Logger;
}): Promise<{ closedWrong: boolean; reason: string }> {
  const { wrong, correct, ctx, gh, logger } = args;
  const wrongText = `${wrong.repo}#${wrong.number}`;
  const correctText = `${correct.repo}#${correct.number}`;

  // 1. The correct issue must exist.
  let correctRaw: string;
  try {
    correctRaw = await gh([
      "issue",
      "view",
      String(correct.number),
      "--repo",
      correct.repo,
      "--json",
      "number,state",
    ]);
  } catch (err) {
    throw new Error(
      `Correct issue ${correctText} could not be verified; ${wrongText} ` +
        `left open: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  let correctView: { number?: number };
  try {
    correctView = JSON.parse(correctRaw) as { number?: number };
  } catch (err) {
    throw new Error(
      `Malformed JSON from gh issue view (${correctText}): ${err}`,
      {
        cause: err,
      },
    );
  }
  if (correctView.number !== correct.number) {
    throw new Error(`Correct issue ${correctText} not found; nothing closed`);
  }

  // 2. A diagnostic is never closed (#2592).
  let wrongRaw: string;
  try {
    wrongRaw = await gh([
      "issue",
      "view",
      String(wrong.number),
      "--repo",
      wrong.repo,
      "--json",
      "body,state",
    ]);
  } catch (err) {
    throw new Error(
      `Could not read ${wrongText}; nothing closed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  let wrongView: { body?: string; state?: string };
  try {
    wrongView = JSON.parse(wrongRaw) as { body?: string; state?: string };
  } catch (err) {
    throw new Error(
      `Malformed JSON from gh issue view (${wrongText}): ${err}`,
      {
        cause: err,
      },
    );
  }
  const wrongBody = wrongView.body ?? "";
  if (
    isRepoFastFailureIssue(wrongBody, wrong.repo) ||
    isRepoFastFailureTallyIssue(wrongBody, wrong.repo)
  ) {
    return {
      closedWrong: false,
      reason: `${wrongText} carries a fast-failure marker: repo-scoped ` +
        "diagnostic exception (#2592), not closed",
    };
  }
  if ((wrongView.state ?? "").toUpperCase() === "CLOSED") {
    return { closedWrong: false, reason: `${wrongText} is already closed` };
  }

  // 3. Permission before any write.
  await requireWriteAccess(wrong.repo, ctx, gh);
  if (!sameRepo(correct.repo, wrong.repo)) {
    await requireWriteAccess(correct.repo, ctx, gh);
  }

  // 4. A dry run stops here, before the first write.
  if (ctx.dryRun) {
    return {
      closedWrong: false,
      reason: `dry-run: would link and close ${wrongText} in favour of ` +
        correctText,
    };
  }

  // 5. Link both, then close the wrong one last.
  await gh([
    "issue",
    "comment",
    String(correct.number),
    "--repo",
    correct.repo,
    "--body",
    `Duplicate filed in the wrong repository: ${wrongText}. This is the ` +
    "owning issue.",
  ]);
  await gh([
    "issue",
    "comment",
    String(wrong.number),
    "--repo",
    wrong.repo,
    "--body",
    `Filed in the wrong repository. Tracked in ${correctText}.`,
  ]);
  await gh([
    "issue",
    "close",
    String(wrong.number),
    "--repo",
    wrong.repo,
    "--comment",
    `Closing as a wrong-repository duplicate of ${correctText}.`,
    "--reason",
    "not planned",
  ]);
  logger.info(`Issue routing: closed ${wrongText} in favour of ${correctText}`);
  return {
    closedWrong: true,
    reason: `closed ${wrongText} as a wrong-repository duplicate of ` +
      correctText,
  };
}
