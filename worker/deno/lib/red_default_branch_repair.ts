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
 * - `formatRedDefaultBranchStatus` writes the one visible status: which sync
 *   PRs are held, which PR carries the fix, and the worker marker that lets a
 *   later scan tell whether the status is already current.
 *
 * Only a `fix/red-default-branch-*` head targeting the default branch is ever
 * adopted. A human-authored fix PR is never adopted automatically.
 *
 * Australian English throughout.
 */

import type { Logger } from "../types.ts";

/** Head-branch prefix of the repair PR (Issue #5437). */
export const RED_DEFAULT_BRANCH_REPAIR_PREFIX = "fix/red-default-branch-";

/** The longest title the repair PR is opened with. */
const TITLE_MAX_LENGTH = 200;

/** A branch name GitHub accepts in these arguments, with no option-like start. */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** A full commit SHA as the REST API returns it. */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * The worker marker, anchored at the end of a body where the worker writes it
 * (Issue #5437). A marker quoted mid-text does not count.
 */
const TRAILING_MARKER_PATTERN =
  /<!-- vibe-red-default-branch-hold sha="([0-9a-f]{40})" held="([0-9,]*)" -->\s*$/;

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
  /** Checks red on the tip that the held sync PRs carry. */
  checkNames: readonly string[];
  /** The sync PRs held for this repair. */
  heldPrNumbers: readonly number[];
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
  const match = TRAILING_MARKER_PATTERN.exec(body ?? "");
  if (match === null) return false;
  return match[1] === tipSha &&
    match[2] === sortedHeld(heldPrNumbers).join(",");
}

/**
 * The status body of the repair PR (Issue #5437): the visible line naming the
 * held sync PRs and the fix, the failing checks, a sentence that makes the
 * failure this PR's to fix, and the worker marker.
 */
export function formatRedDefaultBranchStatus(
  input: RedDefaultBranchStatusInput,
): string {
  const held = sortedHeld(input.heldPrNumbers);
  const heldText = held.map((n) => `#${n}`).join(", ");
  const fixText = input.repairPrNumber === null
    ? "fix in this PR"
    : `fix in #${input.repairPrNumber}`;
  const names = input.checkNames.map((name) => `\`${name}\``).join(", ");
  const shortSha = input.tipSha.slice(0, 12);
  return [
    `**${input.defaultBranch} is red: holding sync PRs ${heldText}, ${fixText}.**`,
    "",
    `Failing on ${input.defaultBranch} at \`${shortSha}\`: ${names}.`,
    "",
    `This PR exists to repair ${input.defaultBranch} itself, so the failure ` +
    `is this PR's to fix, not a pre-existing base failure to defer.`,
    "",
    redDefaultBranchMarker(input.tipSha, held),
  ].join("\n");
}

/** A failure message, whatever the thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Collapse whitespace so a check name stays on one line in a title. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Make sure exactly one repair PR stands for the red default branch
 * (Issue #5437).
 *
 * An open repair PR listed by this scan is adopted (the lowest number wins).
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

  const existing = request.prs
    .filter((pr) => isRedDefaultBranchRepairPr(pr, defaultBranch))
    .sort((a, b) => a.number - b.number)[0];

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
    ghCommandFn,
    logger,
  });
}

/** Open the repair PR: an empty commit on the tip, a branch, then the PR. */
async function openRepairPr(input: {
  repo: string;
  defaultBranch: string;
  tipSha: string;
  checkNames: readonly string[];
  heldPrNumbers: readonly number[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}): Promise<RedDefaultBranchRepair | null> {
  const { repo, defaultBranch, tipSha, ghCommandFn, logger } = input;
  const fail = (step: string, error: unknown): null => {
    logger.warn(
      `Red default branch: could not open a repair PR on ${repo} (${step} failed: ${
        errorText(error)
      }); sync PRs stay held and the repair is retried next scan (Issue #5437)`,
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
  if (!FULL_SHA_PATTERN.test(tipSha)) {
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
  if (!FULL_SHA_PATTERN.test(tree)) {
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
  if (!FULL_SHA_PATTERN.test(commit)) {
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
