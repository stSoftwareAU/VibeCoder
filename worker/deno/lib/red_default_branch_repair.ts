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
 *   branch whose head contains the default branch's tip, whose title or branch
 *   names a held check (or whose title, body or branch references a held PR),
 *   and whose own CI is green on every held check, or is still running with no
 *   held check failed (Issue #5437: a held check may not exist yet while CI is
 *   in flight). A fleet-authored or bot PR is never the fix, green or running.
 *   `postRedDefaultBranchStatusComment`
 *   then records the status there as one comment, edited in place when the
 *   tip or the held set changes, so the human's body is never overwritten.
 *   Only when no such PR exists does the worker open or adopt its repair PR.
 *   A PR adopted while its CI runs gets the pending wording.
 * - `withdrawSupersededFixStatuses` then edits a fleet status left on any
 *   other open PR against the default branch, naming the fix now waited on,
 *   so one "fix in #N" status stands.
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
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  isBotAuthorForMaintenance,
  normaliseGhAppLogin,
} from "./trust_exclusions.ts";

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
  /<!-- vibe-red-default-branch-hold sha="([0-9a-f]{40})" held="([0-9,]*)"( state="pending")? -->$/;

/**
 * The marker a withdrawn status comment ends with (Issue #5437): the PR it is
 * on is no longer the fix the fleet waits on. Anchored like
 * {@link TRAILING_MARKER_PATTERN}.
 */
const WITHDRAWN_MARKER_PATTERN =
  /<!-- vibe-red-default-branch-withdrawn sha="[0-9a-f]{40}" fix="\d*" -->$/;

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
  /**
   * `true` when the status is for a human PR whose CI is still running, not
   * one green on the held checks (Issue #5437). The wording then says the
   * fleet is waiting on it and cannot tell whether it fixes the failure, and
   * the marker records the state so a later green status replaces it.
   */
  pending?: boolean;
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

/**
 * The worker marker for `tipSha` and the held PRs (Issue #5437). A pending
 * status (a fix PR whose CI is still running) adds `state="pending"`.
 */
export function redDefaultBranchMarker(
  tipSha: string,
  heldPrNumbers: readonly number[],
  pending = false,
): string {
  const held = sortedHeld(heldPrNumbers).join(",");
  const state = pending ? ' state="pending"' : "";
  return `<!-- vibe-red-default-branch-hold sha="${tipSha}" held="${held}"${state} -->`;
}

/**
 * Whether a PR body already carries the marker for this tip, hold set and
 * pending state (Issue #5437).
 */
export function bodyCarriesRedDefaultBranchMarker(
  body: string | null | undefined,
  tipSha: string,
  heldPrNumbers: readonly number[],
  pending = false,
): boolean {
  const match = TRAILING_MARKER_PATTERN.exec((body ?? "").trimEnd());
  if (match === null) return false;
  return match[1] === tipSha &&
    match[2] === sortedHeld(heldPrNumbers).join(",") &&
    (match[3] !== undefined) === pending;
}

/**
 * The marker of a withdrawn status for `tipSha`, naming the fix now waited on
 * (Issue #5437). A later scan with another tip or fix edits the comment again.
 */
export function redDefaultBranchWithdrawnMarker(
  tipSha: string,
  fixPrNumber: number | null,
): string {
  return `<!-- vibe-red-default-branch-withdrawn sha="${tipSha}" fix="${
    fixPrNumber ?? ""
  }" -->`;
}

/** Whether a body ends with a withdrawn-status marker (Issue #5437). */
function bodyEndsWithWithdrawnMarker(body: string | null | undefined): boolean {
  return WITHDRAWN_MARKER_PATTERN.test((body ?? "").trimEnd());
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
  if (input.pending === true) {
    return [
      `**${input.defaultBranch} is red: holding ${heldKind} ${heldText}, ${fixText}, its CI still running.**`,
      "",
      `Failing on ${input.defaultBranch} at \`${shortSha}\`: ${names}.`,
      "",
      `The fleet waits on this PR's CI as the fix, so it opens no repair PR ` +
      `of its own while that CI runs. It cannot tell from GitHub whether this ` +
      `PR fixes the failure: if a held check fails here, or the CI stops ` +
      `running before the held checks pass, the fleet opens its own repair PR ` +
      `and this status is withdrawn.`,
      "",
      redDefaultBranchMarker(input.tipSha, held, true),
    ].join("\n");
  }
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

/** Inputs to {@link formatWithdrawnFixStatus}. */
export interface WithdrawnFixStatusInput {
  defaultBranch: string;
  /** The fix the fleet now waits on, or `null` when none stands yet. */
  fixPrNumber: number | null;
  checkNames: readonly string[];
  tipSha: string;
}

/**
 * The body a superseded fix status is edited to (Issue #5437): it says this
 * PR is no longer the fix the fleet waits on and names the one that is, so no
 * stale "fix in #N" status is left beside the current one.
 */
export function formatWithdrawnFixStatus(
  input: WithdrawnFixStatusInput,
): string {
  const fixText = input.fixPrNumber === null
    ? "no fix PR stands yet"
    : `fix in #${input.fixPrNumber}`;
  const names = input.checkNames.map((name) => `\`${name}\``).join(", ");
  return [
    `**${input.defaultBranch} is still red, and this PR is no longer taken as its fix: ${fixText}.**`,
    "",
    `Failing on ${input.defaultBranch} at \`${
      input.tipSha.slice(0, 12)
    }\`: ${names}.`,
    "",
    `The fleet no longer waits on this PR for the repair: a held check failed ` +
    `here, its CI stopped running, or it no longer contains ` +
    `${input.defaultBranch}'s tip. The first line names the fix it waits on now.`,
    "",
    redDefaultBranchWithdrawnMarker(input.tipSha, input.fixPrNumber),
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
  title: string;
  body: string;
}

/** Inputs to {@link findGreenFixPr}. */
export interface GreenFixPrRequest {
  repo: string;
  defaultBranch: string;
  /**
   * The held checks red on the tip. A fix must be green on every one, or, while
   * its CI is still running, none may have failed (Issue #5437).
   */
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
  /**
   * The logins of the fleet's own PRs. A PR by one of them is never the fix,
   * whether green or with its CI still running: it is not a human fix, a
   * diff-scoped check passes on it whatever it changes, and waiting on it would
   * starve the repair while fleet CI churns (Issue #5437). Bot accounts are
   * never the fix either, by `isBotAuthorForMaintenance`.
   */
  fleetLogins: readonly string[];
  /**
   * The check runs of a commit that bear on waiting (Issue #5437). `failed`
   * names the checks completed without `success`, `neutral` or `skipped`, so a
   * `timed_out` or `cancelled` check counts too. `running` names the checks
   * not yet completed whose start is within the wait window. Throws when the
   * check runs cannot be read.
   */
  readCheckRunStates: (
    sha: string,
  ) => Promise<{ failed: ReadonlySet<string>; running: ReadonlySet<string> }>;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}

/** The fix PR {@link findGreenFixPr} found. */
export interface GreenFixPr {
  number: number;
  headRefName: string;
  authorLogin: string;
  /**
   * `true` when the PR is adopted because its CI is still running, not
   * because it is green on every held check (Issue #5437).
   */
  pending: boolean;
}

/**
 * The open PRs in a
 * `gh pr list --json number,headRefName,headRefOid,author,title,body`
 * answer. Throws when the answer is not a JSON array, or when a row lacks its
 * number, head branch, head commit, author login, title or body, naming the
 * missing field (Issue #5437).
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
    if (typeof fields.title !== "string") {
      throw new Error(`PR #${fields.number} has no title`);
    }
    // gh answers "" for an empty body, so "" is valid; a missing key is not.
    if (typeof fields.body !== "string") {
      throw new Error(`PR #${fields.number} has no body`);
    }
    candidates.push({
      number: fields.number,
      headRefName: fields.headRefName,
      headRefOid: fields.headRefOid,
      authorLogin: login,
      title: fields.title,
      body: fields.body,
    });
  }
  return candidates;
}

/**
 * The open PRs against `defaultBranch`, as fix candidates (Issue #5437).
 * Throws when the list cannot be read or a row lacks a field.
 */
async function listOpenPrsAgainst(
  repo: string,
  defaultBranch: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<FixCandidate[]> {
  return parseFixCandidates(
    await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--base",
      defaultBranch,
      "--state",
      "open",
      "--json",
      "number,headRefName,headRefOid,author,title,body",
      "--limit",
      "30",
    ]),
  );
}

/**
 * Whether a fix candidate names a held check or a held PR. A PR that names the
 * failing check or a held PR is about the failure; one that names neither is
 * not taken as the fix, because a diff-scoped check (gitleaks) passes on any
 * PR that adds no finding (Issue #5437). A held check name counts only in the
 * title or the head branch: bodies routinely mention generic check words such
 * as "quality gate", so a body naming `gate` says nothing about the failure. A
 * held PR reference `#N`, not followed by a digit, counts in the title, body
 * or branch. Matching is case-insensitive and by whole token, using `indexOf`
 * rather than a pattern built from untrusted text.
 */
export function fixCandidateNamesHeldFailure(
  candidate: { title: string; body: string; headRefName: string },
  checkNames: readonly string[],
  heldPrNumbers: readonly number[],
): boolean {
  const namingText = `${candidate.title}\n${candidate.headRefName}`
    .toLowerCase();
  const text = `${candidate.title}\n${candidate.body}\n${candidate.headRefName}`
    .toLowerCase();
  const isAlnum = (ch: string | undefined): boolean =>
    ch !== undefined && /^[a-z0-9]$/.test(ch);
  const isDigit = (ch: string | undefined): boolean =>
    ch !== undefined && ch >= "0" && ch <= "9";
  for (const checkName of checkNames) {
    const name = checkName.toLowerCase();
    if (name === "") continue;
    let from = 0;
    for (;;) {
      const at = namingText.indexOf(name, from);
      if (at === -1) break;
      if (
        !isAlnum(namingText[at - 1]) &&
        !isAlnum(namingText[at + name.length])
      ) {
        return true;
      }
      from = at + 1;
    }
  }
  for (const number of heldPrNumbers) {
    const needle = `#${number}`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      if (!isDigit(text[at + needle.length])) return true;
      from = at + 1;
    }
  }
  return false;
}

/**
 * Find an open fix PR against the default branch for the held checks (Issue
 * #5437), such as a human's fix. A candidate is any open PR against
 * `defaultBranch` with a head commit, other than a sync branch, a repair-prefix
 * branch or a held PR. A candidate qualifies only when its head contains the
 * default branch's tip (`contains-default`), so a stale branch that lacks the
 * red commit cannot pass for the fix. A candidate whose ancestry is
 * `on-default` or `diverged` is skipped silently; one whose ancestry is
 * `unknown` is skipped with a warning quoting the cause. A candidate whose
 * title or branch names none of the held checks, and whose title, body or
 * branch references none of the held PRs (`fixCandidateNamesHeldFailure`), is
 * skipped too, on both the green and the pending path, so an unrelated PR that
 * a diff-scoped check passes is not adopted (Issue #5437). A candidate whose
 * login is in `fleetLogins` or is a bot account (`isBotAuthorForMaintenance`)
 * is skipped on both paths as well, with an info line: a fleet or bot PR is
 * never the fix, green or running.
 *
 * A qualifying candidate whose successful check names include every name in
 * `checkNames` is the fix, and it wins at once. Otherwise, a candidate whose
 * CI is still running is remembered, when no held check has failed on it: a
 * held check may not exist yet while CI is in flight. Scanning continues past it, so a green candidate still wins.
 * The first remembered candidate is the fix when no green one is found, so the
 * caller opens no repair PR while it runs. The log records which case applied.
 *
 * Returns `null` when no candidate matches, or when the PR list or a candidate's
 * successful-check read fails. A failed read is logged with its error, and the
 * caller falls back to the worker's repair PR. A candidate whose check-run
 * states cannot be read is logged with its error and is not waited on; the
 * search goes on to the next candidate. Never throws.
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
    listed = await listOpenPrsAgainst(
      repo,
      defaultBranch,
      request.ghCommandFn,
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
  /** The first candidate whose CI is still running, with no held check failed. */
  let pendingFix: FixCandidate | null = null;
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
    if (!fixCandidateNamesHeldFailure(pr, checkNames, heldPrNumbers)) {
      logger.info(
        `Red default branch: ${repo}#${pr.number} (${pr.headRefName}) names none of the held checks (${
          checkNames.join(", ")
        }) in its title or branch, nor a held PR, so it is not taken as the fix (Issue #5437)`,
      );
      continue;
    }
    if (
      isFleetAuthor(pr.authorLogin, [...request.fleetLogins]) ||
      isBotAuthorForMaintenance(normaliseGhAppLogin(pr.authorLogin))
    ) {
      logger.info(
        `Red default branch: ${repo}#${pr.number} (${pr.headRefName}) is by ${pr.authorLogin}, a fleet or bot account, so it is not taken as the fix (Issue #5437)`,
      );
      continue;
    }

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
        pending: false,
      };
    }
    if (pendingFix !== null) continue;
    let states: { failed: ReadonlySet<string>; running: ReadonlySet<string> };
    try {
      states = await request.readCheckRunStates(pr.headRefOid);
    } catch (error) {
      logger.warn(
        `Red default branch: could not read the check runs on ${repo}#${pr.number} (${pr.headRefName}) to see whether its CI is still running: ${
          errorText(error)
        }; it is not waited on, and the search goes on (Issue #5437)`,
      );
      continue;
    }
    const heldFailed = checkNames.some((name) => states.failed.has(name));
    if (!heldFailed && states.running.size > 0) {
      pendingFix = pr;
    }
  }
  if (pendingFix !== null) {
    logger.info(
      `Red default branch: ${repo}#${pendingFix.number} (${pendingFix.headRefName}, by ${pendingFix.authorLogin}) has its CI still running on ${defaultBranch} and no held check has failed, so it is the pending fix; no repair PR is opened while its CI runs (Issue #5437)`,
    );
    return {
      number: pendingFix.number,
      headRefName: pendingFix.headRefName,
      authorLogin: pendingFix.authorLogin,
      pending: true,
    };
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
  /**
   * `true` when the fix PR is adopted while its CI is still running, which
   * selects the pending wording (Issue #5437). Defaults to `false`.
   */
  pending?: boolean;
  /** The scan's fleet login set. Only these authors' markers count. */
  fleetLogins: readonly string[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}

/** A PR comment, as the status reads it. */
interface StatusComment {
  id: number;
  login: string;
  body: string;
}

/**
 * The comments on `prNumber`, oldest first (Issue #5437). Throws when the list
 * cannot be read or a comment lacks its id or login.
 */
async function readPrComments(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<StatusComment[]> {
  const output = await ghCommandFn([
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--paginate",
    "--jq",
    ".[] | {id: .id, login: .user.login, body: .body} | tojson",
  ]);
  return output.split("\n").filter((line) => line.trim() !== "").map(
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
}

/**
 * The newest comment by a fleet login that ends with a worker status marker,
 * held or withdrawn (Issue #5437). GitHub lists comments oldest first.
 */
function newestFleetStatus(
  comments: readonly StatusComment[],
  fleetLogins: readonly string[],
): StatusComment | undefined {
  const fleet = new Set(fleetLogins.map((login) => login.toLowerCase()));
  return comments.filter((comment) =>
    fleet.has(comment.login.toLowerCase()) &&
    (bodyEndsWithRedDefaultBranchMarker(comment.body) ||
      bodyEndsWithWithdrawnMarker(comment.body))
  ).at(-1);
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

  const pending = request.pending === true;
  let comments: StatusComment[];
  try {
    comments = await readPrComments(repo, prNumber, ghCommandFn);
  } catch (error) {
    logger.warn(
      `Red default branch: could not read the comments on ${repo}#${prNumber}: ${
        errorText(error)
      }; falling back to the repair PR (Issue #5437)`,
    );
    return "read-failed";
  }

  // A withdrawn status counts too, so a PR adopted again keeps one comment.
  const status = newestFleetStatus(comments, fleetLogins);
  if (
    status !== undefined &&
    bodyCarriesRedDefaultBranchMarker(
      status.body,
      tipSha,
      heldPrNumbers,
      pending,
    )
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
    pending,
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

/** Inputs to {@link withdrawSupersededFixStatuses}. */
export interface WithdrawFixStatusRequest {
  repo: string;
  defaultBranch: string;
  tipSha: string;
  /** The held checks red on the tip. */
  checkNames: readonly string[];
  /**
   * The fix the fleet now waits on: the adopted fix PR or the worker's repair
   * PR, or `null` when neither stands. Its own status is left alone.
   */
  currentFixPr: number | null;
  /** Whether a head branch is a sync branch, which never carries a status. */
  isSyncBranch: (headRefName: string) => boolean;
  /** The scan's fleet login set. Only these authors' statuses count. */
  fleetLogins: readonly string[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}

/**
 * Withdraw a fix status the fleet left on an open PR that is no longer the fix
 * (Issue #5437), such as a human PR adopted while its CI ran whose held check
 * then failed. Every open PR against `defaultBranch` other than
 * `currentFixPr`, a sync branch or a repair-prefix branch is checked. When its
 * newest fleet status comment still carries the hold marker, or a withdrawn
 * marker for another tip or fix, that comment is edited in place to
 * {@link formatWithdrawnFixStatus}, naming the current fix, so only one
 * "fix in #N" status stands and a withdrawn one never points at an old fix. A
 * comment already withdrawn for this tip and fix is left alone. This reads the
 * comments of each listed PR (at most 30) on every red scan. A failed list,
 * read or edit is logged with its error and the rest go on; the next scan
 * tries again.
 *
 * @returns The PR numbers whose status was withdrawn. Never throws.
 */
export async function withdrawSupersededFixStatuses(
  request: WithdrawFixStatusRequest,
): Promise<number[]> {
  const { repo, defaultBranch, currentFixPr, ghCommandFn, logger } = request;
  if (!BRANCH_NAME_PATTERN.test(defaultBranch)) return [];
  let listed: FixCandidate[];
  try {
    listed = await listOpenPrsAgainst(repo, defaultBranch, ghCommandFn);
  } catch (error) {
    logger.warn(
      `Red default branch: could not list the open PRs against ${defaultBranch} on ${repo} to withdraw a superseded fix status: ${
        errorText(error)
      }; the next scan tries again (Issue #5437)`,
    );
    return [];
  }
  const body = formatWithdrawnFixStatus({
    defaultBranch,
    fixPrNumber: currentFixPr,
    checkNames: request.checkNames.map(oneLine),
    tipSha: request.tipSha,
  });
  const withdrawn: number[] = [];
  for (const pr of listed) {
    if (
      pr.number === currentFixPr ||
      request.isSyncBranch(pr.headRefName) ||
      pr.headRefName.startsWith(RED_DEFAULT_BRANCH_REPAIR_PREFIX)
    ) {
      continue;
    }
    let status: StatusComment | undefined;
    try {
      status = newestFleetStatus(
        await readPrComments(repo, pr.number, ghCommandFn),
        request.fleetLogins,
      );
    } catch (error) {
      logger.warn(
        `Red default branch: could not read the comments on ${repo}#${pr.number} to withdraw a superseded fix status: ${
          errorText(error)
        }; the next scan tries again (Issue #5437)`,
      );
      continue;
    }
    if (
      status === undefined ||
      status.body.trimEnd().endsWith(
        redDefaultBranchWithdrawnMarker(request.tipSha, currentFixPr),
      )
    ) {
      continue;
    }
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
        `Red default branch: could not withdraw the fix status on comment ${status.id} on ${repo}#${pr.number}: ${
          errorText(error)
        }; the next scan tries again (Issue #5437)`,
      );
      continue;
    }
    logger.info(
      `Red default branch: withdrew the fix status on ${repo}#${pr.number}, which is no longer the fix for ${defaultBranch}; ${
        currentFixPr === null
          ? "no fix PR stands yet"
          : `the fix is #${currentFixPr}`
      } (Issue #5437)`,
    );
    withdrawn.push(pr.number);
  }
  return withdrawn;
}
