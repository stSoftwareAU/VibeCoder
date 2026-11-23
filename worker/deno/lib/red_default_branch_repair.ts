/**
 * Repair of a red default branch (Issue #5437).
 *
 * When the default branch is red, every `sync/milestone-*` PR inherits the
 * failure. The CI-fix scan used to hand each of those PRs to the CI-fix agent
 * separately, so the same fix was written onto a sync branch and onto the
 * default branch. This module owns the single PR that repairs the default
 * branch itself:
 *
 * - `ensureRedDefaultBranchRepairPr` adopts the open repair PR when one
 *   exists, and otherwise opens one (an empty commit on the default tip,
 *   because GitHub refuses a PR with no commits).
 * - `formatRedDefaultBranchStatus` writes the one visible status: which PRs
 *   are held, which PR carries the fix, and the worker marker that lets a
 *   later scan tell whether the status is already current.
 * - `findGreenFixPr` finds an open human-authored fix PR against the default
 *   branch whose head contains the default branch's tip and whose own CI is
 *   green on every held check. `postRedDefaultBranchStatusComment`
 *   then records the status there as one comment, edited in place when the
 *   tip or the held set changes, so the human's body is never overwritten.
 *   Only when no such PR exists does the worker open or adopt its repair PR.
 *
 * Only a `fix/red-default-branch-*` head targeting the default branch is ever
 * adopted as the repair PR. A human-authored fix PR is never edited, only
 * commented on, and it keeps one status comment, edited in place.
 *
 * Australian English throughout.
 */

import type { Logger } from "../types.ts";
import {
  type DefaultBranchAncestryResult,
  errorText,
  FULL_COMMIT_SHA_PATTERN,
} from "./default_branch_ancestry.ts";

/** Head-branch prefix of the repair PR (Issue #5437). */
export const RED_DEFAULT_BRANCH_REPAIR_PREFIX = "fix/red-default-branch-";

/** The longest title the repair PR is opened with. */
const TITLE_MAX_LENGTH = 200;

/** A branch name GitHub accepts in these arguments, with no option-like start. */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

/**
 * The worker marker, anchored at the end of a body where the worker writes it
 * (Issue #5437). A marker quoted mid-text does not count. Matched against the
 * body with its trailing whitespace trimmed, so the pattern needs no
 * whitespace quantifier before `$`.
 */
const TRAILING_MARKER_PATTERN =
  /<!-- vibe-red-default-branch-hold sha="([0-9a-f]{40})" held="([0-9,]*)" -->$/;

/** The fields a repair-PR decision reads from a listed PR. */
export interface RepairPrCandidate {
  number: number;
  headRefName: string;
  baseRefName?: string;
  body?: string | null;
}

/** The repair PR an ensure call settled on. */
export interface RedDefaultBranchRepair {
  number: number;
  headRefName: string;
  /** `true` when this call opened the PR, `false` when it adopted one. */
  opened: boolean;
}

/** Inputs to {@link ensureRedDefaultBranchRepairPr}. */
export interface RedDefaultBranchRepairRequest {
  repo: string;
  defaultBranch: string;
  /** The default branch's tip, the commit the repair is for. */
  tipSha: string;
  /** Checks red on the tip that the held PRs carry. */
  checkNames: readonly string[];
  /** The PRs held for this repair. */
  heldPrNumbers: readonly number[];
  /** `true` when every held PR is a sync PR, which sets the status wording. */
  allHeldAreSync: boolean;
  /** The PRs the current scan listed. */
  prs: readonly RepairPrCandidate[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}

/** Inputs to {@link formatRedDefaultBranchStatus}. */
export interface RedDefaultBranchStatusInput {
  defaultBranch: string;
  heldPrNumbers: readonly number[];
  /** The repair PR's number, or `null` when the PR is about to be opened. */
  repairPrNumber: number | null;
  checkNames: readonly string[];
  tipSha: string;
  /**
   * `true` when every held PR is a sync PR. Defaults to `true`; `false` says
   * "PRs" so a held PR that is not a sync PR is named accurately.
   */
  allHeldAreSync?: boolean;
}

/** Whether a listed PR is a repair PR for `defaultBranch` (Issue #5437). */
export function isRedDefaultBranchRepairPr(
  pr: { headRefName: string; baseRefName?: string },
  defaultBranch: string,
): boolean {
  return pr.baseRefName === defaultBranch &&
    pr.headRefName.startsWith(RED_DEFAULT_BRANCH_REPAIR_PREFIX);
}

/** Held PR numbers, de-duplicated and ascending. */
function sortedHeld(heldPrNumbers: readonly number[]): number[] {
  return [...new Set(heldPrNumbers)].sort((a, b) => a - b);
}

/** The worker marker for `tipSha` and the held PRs (Issue #5437). */
export function redDefaultBranchMarker(
  tipSha: string,
  heldPrNumbers: readonly number[],
): string {
  const held = sortedHeld(heldPrNumbers).join(",");
  return `<!-- vibe-red-default-branch-hold sha="${tipSha}" held="${held}" -->`;
}

/** Whether a PR body already carries the marker for this tip and hold set. */
export function bodyCarriesRedDefaultBranchMarker(
  body: string | null | undefined,
  tipSha: string,
  heldPrNumbers: readonly number[],
): boolean {
  const match = TRAILING_MARKER_PATTERN.exec((body ?? "").trimEnd());
  if (match === null) return false;
  return match[1] === tipSha &&
    match[2] === sortedHeld(heldPrNumbers).join(",");
}

/**
 * Whether a body ends with a worker marker for some tip and hold set
 * (Issue #5437). Same anchoring as {@link bodyCarriesRedDefaultBranchMarker}:
 * a marker quoted mid-text does not count.
 */
export function bodyEndsWithRedDefaultBranchMarker(
  body: string | null | undefined,
): boolean {
  return TRAILING_MARKER_PATTERN.test((body ?? "").trimEnd());
}

/**
 * The status body of the repair PR (Issue #5437): the visible line naming the
 * held PRs and the fix, the failing checks, a sentence that makes the
 * failure this PR's to fix, and the worker marker.
 */
export function formatRedDefaultBranchStatus(
  input: RedDefaultBranchStatusInput,
): string {
  const held = sortedHeld(input.heldPrNumbers);
  const heldText = held.map((n) => `#${n}`).join(", ");
  const heldKind = input.allHeldAreSync === false ? "PRs" : "sync PRs";
  const fixText = input.repairPrNumber === null
    ? "fix in this PR"
    : `fix in #${input.repairPrNumber}`;
  const names = input.checkNames.map((name) => `\`${name}\``).join(", ");
  const shortSha = input.tipSha.slice(0, 12);
  return [
    `**${input.defaultBranch} is red: holding ${heldKind} ${heldText}, ${fixText}.**`,
    "",
    `Failing on ${input.defaultBranch} at \`${shortSha}\`: ${names}.`,
    "",
    `This PR exists to repair ${input.defaultBranch} itself, so the failure ` +
    `is this PR's to fix, not a pre-existing base failure to defer.`,
    "",
    redDefaultBranchMarker(input.tipSha, held),
  ].join("\n");
}

/** Collapse whitespace so a check name stays on one line in a title. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Make sure exactly one repair PR stands for the red default branch
 * (Issue #5437).
 *
 * An open repair PR is adopted (the lowest number wins): one listed by this
 * scan, or else one found by a direct `gh pr list --search head:` lookup, so a
 * needs-human repair PR or a scan scoped to one PR never opens a second.
 * Its body is brought up to date only when the marker differs. Otherwise one
 * is opened: an empty commit on `tipSha`, a `fix/red-default-branch-<sha12>`
 * branch on it, and a PR against the default branch.
 *
 * Never throws. A step that fails is logged with its error and yields `null`,
 * and the next scan tries again.
 */
export async function ensureRedDefaultBranchRepairPr(
  request: RedDefaultBranchRepairRequest,
): Promise<RedDefaultBranchRepair | null> {
  const { repo, defaultBranch, tipSha, logger, ghCommandFn } = request;
  const heldPrNumbers = request.heldPrNumbers;
  const checkNames = request.checkNames.map(oneLine);

  let existing = request.prs
    .filter((pr) => isRedDefaultBranchRepairPr(pr, defaultBranch))
    .sort((a, b) => a.number - b.number)[0];

  // The scan's listing drops a needs-human PR and can be scoped to one PR, so
  // an open repair PR missing from it is looked up directly before another
  // is opened. An unreadable lookup opens nothing: a duplicate repair PR is
  // the failure this module exists to prevent (Issue #5437).
  if (existing === undefined) {
    try {
      existing = await findOpenRepairPr(repo, defaultBranch, ghCommandFn);
    } catch (error) {
      logger.warn(
        `Red default branch: could not look up an open repair PR on ${repo}: ${
          errorText(error)
        }; no repair PR is opened this scan (Issue #5437)`,
      );
      return null;
    }
  }

  if (existing !== undefined) {
    if (
      !bodyCarriesRedDefaultBranchMarker(existing.body, tipSha, heldPrNumbers)
    ) {
      const body = formatRedDefaultBranchStatus({
        defaultBranch,
        heldPrNumbers,
        repairPrNumber: existing.number,
        checkNames,
        tipSha,
        allHeldAreSync: request.allHeldAreSync,
      });
      try {
        await ghCommandFn([
          "pr",
          "edit",
          String(existing.number),
          "--repo",
          repo,
          "--body",
          body,
        ]);
      } catch (error) {
        logger.warn(
          `Red default branch: could not update the status of ${repo}#${existing.number}: ${
            errorText(error)
          } (Issue #5437)`,
        );
      }
    }
    return {
      number: existing.number,
      headRefName: existing.headRefName,
      opened: false,
    };
  }

  return openRepairPr({
    repo,
    defaultBranch,
    tipSha,
    checkNames,
    heldPrNumbers,
    allHeldAreSync: request.allHeldAreSync,
    ghCommandFn,
    logger,
  });
}

/**
 * The lowest-numbered open repair PR against `defaultBranch`, read straight
 * from GitHub rather than from the scan's listing (Issue #5437). Throws when
 * the listing cannot be read or a row lacks its number or head branch.
 */
async function findOpenRepairPr(
  repo: string,
  defaultBranch: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<RepairPrCandidate | undefined> {
  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--base",
    defaultBranch,
    "--state",
    "open",
    "--search",
    `head:${RED_DEFAULT_BRANCH_REPAIR_PREFIX}`,
    "--json",
    "number,headRefName,body",
    "--limit",
    "30",
  ]);
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) {
    throw new Error(`unexpected PR list "${output.trim().slice(0, 80)}"`);
  }
  const found: RepairPrCandidate[] = [];
  for (const row of rows) {
    const fields =
      (typeof row === "object" && row !== null ? row : {}) as Record<
        string,
        unknown
      >;
    if (typeof fields.number !== "number") {
      throw new Error(
        `a PR row without a numeric number: ${JSON.stringify(row)}`,
      );
    }
    if (typeof fields.headRefName !== "string") {
      throw new Error(`PR #${fields.number} has no headRefName`);
    }
    // `--search head:` is a prefix match on GitHub's side; re-check it here.
    if (!fields.headRefName.startsWith(RED_DEFAULT_BRANCH_REPAIR_PREFIX)) {
      continue;
    }
    found.push({
      number: fields.number,
      headRefName: fields.headRefName,
      baseRefName: defaultBranch,
      body: typeof fields.body === "string" ? fields.body : null,
    });
  }
  return found.sort((a, b) => a.number - b.number)[0];
}

/** Open the repair PR: an empty commit on the tip, a branch, then the PR. */
async function openRepairPr(input: {
  repo: string;
  defaultBranch: string;
  tipSha: string;
  checkNames: readonly string[];
  heldPrNumbers: readonly number[];
  allHeldAreSync: boolean;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}): Promise<RedDefaultBranchRepair | null> {
  const { repo, defaultBranch, tipSha, ghCommandFn, logger } = input;
  const fail = (step: string, error: unknown): null => {
    logger.warn(
      `Red default branch: could not open a repair PR on ${repo} (${step} failed: ${
        errorText(error)
      }); held PRs stay held and the repair is retried next scan (Issue #5437)`,
    );
    return null;
  };

  if (
    !BRANCH_NAME_PATTERN.test(defaultBranch) || defaultBranch.includes("..") ||
    defaultBranch.startsWith("-")
  ) {
    logger.warn(
      `Red default branch: ${
        JSON.stringify(defaultBranch)
      } is not a branch name this worker will repair (Issue #5437)`,
    );
    return null;
  }
  if (!FULL_COMMIT_SHA_PATTERN.test(tipSha)) {
    logger.warn(
      `Red default branch: the tip of ${repo} is not a commit SHA, so no repair PR is opened (Issue #5437)`,
    );
    return null;
  }

  const shortSha = tipSha.slice(0, 12);
  const branch = `${RED_DEFAULT_BRANCH_REPAIR_PREFIX}${shortSha}`;
  const names = input.checkNames.join(", ");
  const title = `Repair red ${defaultBranch}: ${names} failing at ${shortSha}`
    .slice(0, TITLE_MAX_LENGTH);

  let tree: string;
  try {
    tree = (await ghCommandFn([
      "api",
      `repos/${repo}/git/commits/${tipSha}`,
      "--jq",
      ".tree.sha",
    ])).trim();
  } catch (error) {
    return fail("reading the tip's tree", error);
  }
  if (!FULL_COMMIT_SHA_PATTERN.test(tree)) {
    return fail("reading the tip's tree", `unexpected tree "${tree}"`);
  }

  let commit: string;
  try {
    commit = (await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/git/commits`,
      "-f",
      `message=Repair red ${defaultBranch} at ${shortSha} (Issue #5437)`,
      "-f",
      `tree=${tree}`,
      "-f",
      `parents[]=${tipSha}`,
      "--jq",
      ".sha",
    ])).trim();
  } catch (error) {
    return fail("creating the empty commit", error);
  }
  if (!FULL_COMMIT_SHA_PATTERN.test(commit)) {
    return fail("creating the empty commit", `unexpected sha "${commit}"`);
  }

  try {
    await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${commit}`,
    ]);
  } catch (error) {
    return fail(`creating branch ${branch}`, error);
  }

  const body = formatRedDefaultBranchStatus({
    defaultBranch,
    heldPrNumbers: input.heldPrNumbers,
    repairPrNumber: null,
    checkNames: input.checkNames,
    tipSha,
    allHeldAreSync: input.allHeldAreSync,
  });
  let output: string;
  try {
    output = await ghCommandFn([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      defaultBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);
  } catch (error) {
    return fail(`opening the PR from ${branch}`, error);
  }
  const number = /\/pull\/(\d+)/.exec(output)?.[1];
  if (number === undefined) {
    return fail(
      `opening the PR from ${branch}`,
      `no PR URL in "${output.trim()}"`,
    );
  }

  logger.info(
    `Red default branch: opened repair PR ${repo}#${number} for ${defaultBranch} at ${shortSha} (Issue #5437)`,
  );
  return { number: Number(number), headRefName: branch, opened: true };
}

/** An open PR against the default branch, as a fix candidate (Issue #5437). */
interface FixCandidate {
  number: number;
  headRefName: string;
  headRefOid: string;
  authorLogin: string;
}

/** Inputs to {@link findGreenFixPr}. */
export interface GreenFixPrRequest {
  repo: string;
  defaultBranch: string;
  /** The held checks red on the tip. A fix must be green on every one. */
  checkNames: readonly string[];
  /** The held PRs, which are never the fix for themselves. */
  heldPrNumbers: readonly number[];
  /** Whether a head branch is a `sync/milestone-*` branch. */
  isSyncBranch: (headRefName: string) => boolean;
  /**
   * How a commit stands against the default branch. Only `contains-default`
   * qualifies a candidate; a stale head cut before the default tip does not.
   * Never throws: a failed read is `unknown`, with its cause.
   */
  readAncestry: (sha: string) => Promise<DefaultBranchAncestryResult>;
  /**
   * The names of the checks that succeeded on a commit. Throws when the
   * commit's check runs cannot be read.
   */
  readSuccessfulCheckNames: (sha: string) => Promise<ReadonlySet<string>>;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}

/** The fix PR {@link findGreenFixPr} found. */
export interface GreenFixPr {
  number: number;
  headRefName: string;
  authorLogin: string;
}

/**
 * The open PRs in a `gh pr list --json number,headRefName,headRefOid,author`
 * answer. Throws when the answer is not a JSON array, or when a row lacks its
 * number, head branch, head commit or author login, naming the missing field
 * (Issue #5437).
 */
function parseFixCandidates(output: string): FixCandidate[] {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) {
    throw new Error(`unexpected PR list "${output.trim().slice(0, 80)}"`);
  }
  const candidates: FixCandidate[] = [];
  for (const row of rows) {
    const fields =
      (typeof row === "object" && row !== null ? row : {}) as Record<
        string,
        unknown
      >;
    if (typeof fields.number !== "number") {
      throw new Error(
        `a PR row without a numeric number: ${JSON.stringify(row)}`,
      );
    }
    if (typeof fields.headRefName !== "string") {
      throw new Error(`PR #${fields.number} has no headRefName`);
    }
    if (typeof fields.headRefOid !== "string" || fields.headRefOid === "") {
      throw new Error(`PR #${fields.number} has no headRefOid`);
    }
    const author = fields.author;
    const login = typeof author === "object" && author !== null
      ? (author as Record<string, unknown>).login
      : undefined;
    if (typeof login !== "string") {
      throw new Error(`PR #${fields.number} has no author.login`);
    }
    candidates.push({
      number: fields.number,
      headRefName: fields.headRefName,
      headRefOid: fields.headRefOid,
      authorLogin: login,
    });
  }
  return candidates;
}

/**
 * Find an open fix PR against the default branch that already passes the
 * held checks (Issue #5437), such as a human's fix. A candidate is any open
 * PR against `defaultBranch` with a head commit, other than a sync branch, a
 * repair-prefix branch or a held PR. A candidate qualifies only when its head
 * contains the default branch's tip (`contains-default`), so a stale branch
 * that lacks the red commit cannot pass for the fix. The first qualifying
 * candidate whose successful check names include every name in `checkNames`
 * is the fix. A candidate whose ancestry is `on-default` or `diverged` is
 * skipped silently; one whose ancestry is `unknown` is skipped with a warning
 * quoting the cause.
 *
 * Returns `null` when no candidate matches, or when the PR list or a check-run
 * read fails. A failed read is logged with its error, and the caller falls
 * back to the worker's repair PR. Never throws.
 */
export async function findGreenFixPr(
  request: GreenFixPrRequest,
): Promise<GreenFixPr | null> {
  const { repo, defaultBranch, checkNames, heldPrNumbers, logger } = request;
  if (checkNames.length === 0) return null;
  if (!BRANCH_NAME_PATTERN.test(defaultBranch)) {
    logger.warn(
      `Red default branch: ${
        JSON.stringify(defaultBranch)
      } is not a branch name this worker will look for a fix on (Issue #5437)`,
    );
    return null;
  }

  let listed: FixCandidate[];
  try {
    listed = parseFixCandidates(
      await request.ghCommandFn([
        "pr",
        "list",
        "--repo",
        repo,
        "--base",
        defaultBranch,
        "--state",
        "open",
        "--json",
        "number,headRefName,headRefOid,author",
        "--limit",
        "30",
      ]),
    );
  } catch (error) {
    logger.warn(
      `Red default branch: could not list the open PRs against ${defaultBranch} on ${repo} to look for a fix: ${
        errorText(error)
      }; falling back to the repair PR (Issue #5437)`,
    );
    return null;
  }

  const held = new Set(heldPrNumbers);
  const candidates = listed.filter((pr) =>
    !request.isSyncBranch(pr.headRefName) &&
    !pr.headRefName.startsWith(RED_DEFAULT_BRANCH_REPAIR_PREFIX) &&
    !held.has(pr.number)
  );
  for (const pr of candidates) {
    const ancestry = await request.readAncestry(pr.headRefOid);
    if (ancestry.status === "unknown") {
      logger.warn(
        `Red default branch: could not tell whether ${repo}#${pr.number} (${pr.headRefName}) contains ${defaultBranch}: ${
          ancestry.cause ?? "no cause given"
        }; it is not taken as the fix (Issue #5437)`,
      );
      continue;
    }
    if (ancestry.status !== "contains-default") continue;

    let passing: ReadonlySet<string>;
    try {
      passing = await request.readSuccessfulCheckNames(pr.headRefOid);
    } catch (error) {
      logger.warn(
        `Red default branch: could not read the checks that passed on ${repo}#${pr.number} (${pr.headRefName}): ${
          errorText(error)
        }; falling back to the repair PR (Issue #5437)`,
      );
      return null;
    }
    if (checkNames.every((name) => passing.has(name))) {
      logger.info(
        `Red default branch: ${repo}#${pr.number} (${pr.headRefName}, by ${pr.authorLogin}) passes ${
          checkNames.join(", ")
        } on ${defaultBranch}, so it is the fix; no repair PR is opened (Issue #5437)`,
      );
      return {
        number: pr.number,
        headRefName: pr.headRefName,
        authorLogin: pr.authorLogin,
      };
    }
  }
  return null;
}

/** How {@link postRedDefaultBranchStatusComment} settled (Issue #5437). */
export type FixStatusCommentOutcome =
  | "posted"
  | "edited"
  | "already-posted"
  | "read-failed"
  | "post-failed";

/** Inputs to {@link postRedDefaultBranchStatusComment}. */
export interface FixStatusCommentRequest {
  repo: string;
  defaultBranch: string;
  /** The default branch's tip, the commit the status is for. */
  tipSha: string;
  /** The held checks red on the tip. */
  checkNames: readonly string[];
  heldPrNumbers: readonly number[];
  /** `true` when every held PR is a sync PR, which sets the status wording. */
  allHeldAreSync: boolean;
  /** The adopted fix PR, which the status names. */
  prNumber: number;
  /** The scan's fleet login set. Only these authors' markers count. */
  fleetLogins: readonly string[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}

/**
 * Record the status on an adopted fix PR as one comment, never by editing its
 * body (Issue #5437). The status is one comment: the newest comment by a
 * fleet login (`fleetLogins`) whose body ends with a worker marker. If that
 * comment carries the identical marker it is already current (`already-posted`).
 * If it carries a different marker it is edited in place (`edited`). With no
 * such comment one is posted (`posted`). Comments from other logins never
 * count. A read failure is logged and yields `read-failed`, which tells the
 * caller to fall back to the repair PR. A failed post or edit is logged and
 * yields `post-failed`. Never throws.
 */
export async function postRedDefaultBranchStatusComment(
  request: FixStatusCommentRequest,
): Promise<FixStatusCommentOutcome> {
  const {
    repo,
    defaultBranch,
    tipSha,
    heldPrNumbers,
    prNumber,
    fleetLogins,
    ghCommandFn,
    logger,
  } = request;
  const checkNames = request.checkNames.map(oneLine);

  let comments: Array<{ id: number; login: string; body: string }>;
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--paginate",
      "--jq",
      ".[] | {id: .id, login: .user.login, body: .body} | tojson",
    ]);
    comments = output.split("\n").filter((line) => line.trim() !== "").map(
      (line) => {
        const fields = JSON.parse(line) as Record<string, unknown>;
        if (typeof fields.id !== "number") {
          throw new Error(`a comment without a numeric id: ${line}`);
        }
        if (typeof fields.login !== "string") {
          throw new Error(`a comment without a user.login: ${line}`);
        }
        return {
          id: fields.id,
          login: fields.login,
          body: typeof fields.body === "string" ? fields.body : "",
        };
      },
    );
  } catch (error) {
    logger.warn(
      `Red default branch: could not read the comments on ${repo}#${prNumber}: ${
        errorText(error)
      }; falling back to the repair PR (Issue #5437)`,
    );
    return "read-failed";
  }

  // GitHub lists comments oldest first, so the newest status is the last one.
  const fleet = new Set(fleetLogins.map((login) => login.toLowerCase()));
  const statuses = comments.filter((comment) =>
    fleet.has(comment.login.toLowerCase()) &&
    bodyEndsWithRedDefaultBranchMarker(comment.body)
  );
  const status = statuses.at(-1);
  if (
    status !== undefined &&
    bodyCarriesRedDefaultBranchMarker(status.body, tipSha, heldPrNumbers)
  ) {
    return "already-posted";
  }

  const body = formatRedDefaultBranchStatus({
    defaultBranch,
    heldPrNumbers,
    repairPrNumber: prNumber,
    checkNames,
    tipSha,
    allHeldAreSync: request.allHeldAreSync,
  });
  if (status !== undefined) {
    try {
      await ghCommandFn([
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/issues/comments/${status.id}`,
        "-f",
        `body=${body}`,
      ]);
    } catch (error) {
      logger.warn(
        `Red default branch: could not edit the status on comment ${status.id} on ${repo}#${prNumber}: ${
          errorText(error)
        }; the fix PR is adopted and the status is retried next scan (Issue #5437)`,
      );
      return "post-failed";
    }
    logger.info(
      `Red default branch: edited the status on ${repo}#${prNumber} in place, the fix for ${defaultBranch} at ${
        tipSha.slice(0, 12)
      } (Issue #5437)`,
    );
    return "edited";
  }
  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
  } catch (error) {
    logger.warn(
      `Red default branch: could not post the status on ${repo}#${prNumber}: ${
        errorText(error)
      }; the fix PR is adopted and the status is retried next scan (Issue #5437)`,
    );
    return "post-failed";
  }
  logger.info(
    `Red default branch: posted the status on ${repo}#${prNumber}, the fix for ${defaultBranch} at ${
      tipSha.slice(0, 12)
    } (Issue #5437)`,
  );
  return "posted";
}
