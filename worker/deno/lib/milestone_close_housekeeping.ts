/**
 * Milestone-close housekeeping (Issue #2338).
 *
 * When a milestone closes its stream is over: the conversation will never be
 * resumed, the milestone branch will never be pushed again, and the child
 * issue branches are spent. Every host therefore sweeps that milestone's
 * local footprint on its next scan — the lane worktrees holding one of its
 * branches, the local `milestone/**` branch and the child issue branches, and
 * the stream's session record (`stream-<streamKey>.json`, Issue #2332) for
 * every provider.
 *
 * ## Once, then never again
 *
 * Listing closed milestones on every scan of every repository would be a `gh`
 * call per repository per scan for work that is finished after the first one.
 * So two things are persisted under the work root:
 *
 * - the **closed-milestone listing**, with a short TTL, so consecutive scans
 *   share one `gh` call; and
 * - the set of **already-swept titles**, forever, so a closed milestone is
 *   swept once and then never re-listed, re-matched or revisited.
 *
 * ## Never destructive, never fatal
 *
 * A worktree or branch that holds uncommitted or unpushed work is **not**
 * removed — it is logged as skipped and left to the existing time-based
 * cleanups (`worktree_cleanup.ts`, `branch_cleanup.ts`), which this module
 * complements rather than replaces. A removal that fails is logged loud and
 * the milestone is **not** recorded as swept, so the next scan retries it;
 * nothing here ever fails a run.
 *
 * This runs regardless of `enable_session_resume`: with the flag off there is
 * simply no stream session record to remove, and the worktree and branch sweep
 * is unchanged.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { createMilestoneBranchName } from "./git_branch.ts";
import { repoCheckoutPath } from "./repo_checkout_path.ts";
import { runGitCommand } from "./git_timeout.ts";
import {
  deleteStreamSession,
  streamSessionPath,
} from "./resume_state_store.ts";
import { parseWorktreeList } from "./worktree_cleanup.ts";

/** How a `gh` invocation is made — args in, stdout out, throws on failure. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Outcome of one git invocation, with a failed spawn folded into `code`. */
export interface GitRunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** A closed milestone, as this module needs it. */
export interface ClosedMilestone {
  /** GitHub's milestone number, used to list the milestone's children. */
  number: number;
  /** The milestone title — the stream's identity and the swept-set key. */
  title: string;
}

/**
 * How long a closed-milestone listing is reused before `gh` is asked again.
 *
 * Short by design: a milestone that closes mid-cycle is swept within the
 * quarter hour, and consecutive scans of the same repository share one call.
 */
export const DEFAULT_CLOSED_MILESTONE_LISTING_TTL_MS = 15 * 60_000;

/** Work-root directory holding this module's per-repository state. */
export const MILESTONE_CLOSE_STATE_DIRNAME = ".milestone-close-housekeeping";

/** Inputs for {@link sweepClosedMilestones}. */
export interface ClosedMilestoneSweepOptions {
  /** Repository in `owner/name` form. */
  repo: string;
  /** The worker's work root (`config.workDir`). */
  workDir: string;
  /** The shared clone. Defaults to `<workDir>/<repo name>`. */
  repoPath?: string;
  /** Listing cache lifetime. Defaults to {@link DEFAULT_CLOSED_MILESTONE_LISTING_TTL_MS}. */
  listingTtlMs?: number;
}

/** Injectable seam — every side effect this module has. */
export interface ClosedMilestoneSweepDeps {
  /** Run `gh`, returning stdout. */
  gh: GhCommandFn;
  /** Run git in `cwd`. */
  git(args: readonly string[], cwd: string): Promise<GitRunOutput>;
  /** Emit one log line. */
  log(message: string): void;
  /** Epoch milliseconds. */
  now(): number;
}

/** What one scan of one repository did. */
export interface ClosedMilestoneSweepResult {
  /** Closed milestones this scan considered — already-swept ones excluded. */
  considered: string[];
  /** Titles recorded as swept by this scan; they are never revisited. */
  swept: string[];
  /** One entry per artefact removed. */
  removed: string[];
  /** One entry per artefact left alone because it holds unpushed work. */
  skipped: string[];
  /** One entry per failed removal — logged loud and retried on the next scan. */
  failures: string[];
  /** Whether the closed-milestone listing came from the cached copy. */
  listedFromCache: boolean;
  /** Non-fatal problems. A sweep never throws and never fails a run. */
  errors: string[];
}

/** Persisted per-repository state: the swept set plus the cached listing. */
interface PersistedHousekeepingState {
  swept: string[];
  listing?: { fetchedAtEpochMs: number; milestones: ClosedMilestone[] };
}

/** Where this repository's housekeeping state lives under the work root. */
export function milestoneCloseStatePath(
  workDir: string,
  repo: string,
): string {
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
  return `${workDir}/${MILESTONE_CLOSE_STATE_DIRNAME}/${slug}.json`;
}

/**
 * The issue number an issue branch belongs to, or `null` when the name is not
 * one of the worker's issue branches (`issue-<number>-<slug>`).
 */
export function childIssueBranchNumber(branch: string): number | null {
  const match = /^issue-(\d+)(?:-|$)/.exec(branch);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Parse a `gh api --paginate` response into closed milestones.
 *
 * `--paginate` concatenates one top-level array per page, so the pages are
 * split on the `][` boundary before parsing. Unparseable output yields no
 * milestones — the caller then sweeps nothing this scan rather than acting on
 * a half-read listing.
 */
export function parseClosedMilestones(raw: string): ClosedMilestone[] {
  return parseJsonArrayPages(raw).flatMap((item) => {
    const number = (item as { number?: unknown }).number;
    const title = (item as { title?: unknown }).title;
    return typeof number === "number" && Number.isSafeInteger(number) &&
        number > 0 && typeof title === "string" && title.trim() !== ""
      ? [{ number, title }]
      : [];
  });
}

/** Issue numbers from a `gh api --paginate` issues response. */
function parseIssueNumbers(raw: string): number[] {
  return parseJsonArrayPages(raw).flatMap((item) => {
    const number = (item as { number?: unknown }).number;
    return typeof number === "number" && Number.isSafeInteger(number) &&
        number > 0
      ? [number]
      : [];
  });
}

/** Split concatenated `--paginate` pages and parse each as a JSON array. */
function parseJsonArrayPages(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const out: unknown[] = [];
  for (const chunk of trimmed.split(/\]\s*\[/)) {
    const opened = chunk.startsWith("[") ? chunk : `[${chunk}`;
    const closed = opened.endsWith("]") ? opened : `${opened}]`;
    try {
      const parsed = JSON.parse(closed);
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch {
      // A page that does not parse contributes nothing; the caller sweeps
      // only what it could actually read.
    }
  }
  return out;
}

/** The production dependency set. */
export function createDefaultSweepDeps(): ClosedMilestoneSweepDeps {
  return {
    gh: async (args) => {
      const command = new Deno.Command("gh", {
        args,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await command.output();
      if (!output.success) {
        throw new Error(
          `gh ${args.join(" ")} failed: ${
            new TextDecoder().decode(output.stderr).trim()
          }`,
        );
      }
      return new TextDecoder().decode(output.stdout);
    },
    git: async (args, cwd) => {
      const result = await runGitCommand([...args], { cwd });
      return result.ok
        ? result.value
        : { code: -1, stdout: "", stderr: result.error.message };
    },
    log: (message) => console.log(message),
    now: () => Date.now(),
  };
}

/**
 * Sweep every closed milestone of one repository that this host still holds
 * artefacts for. Run once per scan per monitored repository.
 *
 * Never throws: every fault is recorded in {@link ClosedMilestoneSweepResult}
 * and logged, and the milestone stays unswept so the next scan retries it.
 */
export async function sweepClosedMilestones(
  options: ClosedMilestoneSweepOptions,
  depsOverride: Partial<ClosedMilestoneSweepDeps> = {},
): Promise<ClosedMilestoneSweepResult> {
  const deps: ClosedMilestoneSweepDeps = {
    ...createDefaultSweepDeps(),
    ...depsOverride,
  };
  const result: ClosedMilestoneSweepResult = {
    considered: [],
    swept: [],
    removed: [],
    skipped: [],
    failures: [],
    listedFromCache: false,
    errors: [],
  };

  const { repo, workDir } = options;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    result.errors.push(
      `milestone-close housekeeping needs a repository of the form ` +
        `owner/name, got: ${JSON.stringify(repo)}`,
    );
    deps.log(`SELF-HEALING: ${result.errors[0]}`);
    return result;
  }
  const repoPath = options.repoPath ?? repoCheckoutPath(workDir, repo);
  const ttlMs = options.listingTtlMs ??
    DEFAULT_CLOSED_MILESTONE_LISTING_TTL_MS;

  const state = await readState(workDir, repo, deps);
  const swept = new Set(state.swept);

  const cached = state.listing;
  let milestones: ClosedMilestone[];
  if (cached !== undefined && deps.now() - cached.fetchedAtEpochMs < ttlMs) {
    milestones = cached.milestones;
    result.listedFromCache = true;
  } else {
    try {
      milestones = parseClosedMilestones(
        await deps.gh([
          "api",
          "--paginate",
          `repos/${repo}/milestones?state=closed&per_page=100`,
        ]),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(
        `Could not list the closed milestones of ${repo}: ${message}`,
      );
      deps.log(
        `milestone-close housekeeping: could not list the closed milestones ` +
          `of ${repo} (retrying next scan): ${message}`,
      );
      return result;
    }
  }

  const pending = milestones.filter((m) => !swept.has(m.title));
  result.considered = pending.map((m) => m.title);

  for (const milestone of pending) {
    const outcome = await sweepMilestone(
      { repo, workDir, repoPath, milestone },
      deps,
    );
    result.removed.push(...outcome.removed);
    result.skipped.push(...outcome.skipped);
    result.failures.push(...outcome.failures);
    result.errors.push(...outcome.errors);
    if (outcome.failures.length === 0) {
      swept.add(milestone.title);
      result.swept.push(milestone.title);
    }
  }

  await writeState(workDir, repo, {
    swept: [...swept],
    listing: {
      fetchedAtEpochMs: result.listedFromCache && cached !== undefined
        ? cached.fetchedAtEpochMs
        : deps.now(),
      // A swept milestone never re-appears in the listed set.
      milestones: milestones.filter((m) => !swept.has(m.title)),
    },
  }, deps);

  return result;
}

/** What sweeping one milestone did. */
interface MilestoneOutcome {
  removed: string[];
  skipped: string[];
  failures: string[];
  errors: string[];
}

/** Remove one closed milestone's worktrees, local branches and stream session. */
async function sweepMilestone(
  context: {
    repo: string;
    workDir: string;
    repoPath: string;
    milestone: ClosedMilestone;
  },
  deps: ClosedMilestoneSweepDeps,
): Promise<MilestoneOutcome> {
  const { repo, workDir, repoPath, milestone } = context;
  const title = milestone.title;
  const outcome: MilestoneOutcome = {
    removed: [],
    skipped: [],
    failures: [],
    errors: [],
  };

  const removedLine = (what: string) => {
    outcome.removed.push(`${what} (closed milestone ${title})`);
    deps.log(`SELF-HEALING: ${what} for closed milestone ${title}`);
  };
  const failedLine = (what: string, detail: string) => {
    outcome.failures.push(`${what} (closed milestone ${title}): ${detail}`);
    deps.log(
      `SELF-HEALING: failed to remove ${what} for closed milestone ` +
        `${title}: ${detail} — retrying next scan`,
    );
  };
  const skippedLine = (subject: string) => {
    outcome.skipped.push(`${subject} (closed milestone ${title})`);
    deps.log(`SELF-HEALING: skipped ${subject} (uncommitted work)`);
  };

  // 1. Which local branches belong to this milestone?
  const targets = await milestoneBranches(context, deps, outcome);

  // 2. Worktrees holding one of them. Removed before the branches, because a
  //    branch a worktree has checked out cannot be deleted.
  const blocked = new Set<string>();
  if (targets.size > 0) {
    const listed = await deps.git(
      ["worktree", "list", "--porcelain"],
      repoPath,
    );
    if (listed.code !== 0) {
      outcome.errors.push(
        `Could not list the worktrees of ${repoPath}: ${
          listed.stderr.trim() || `exit ${listed.code}`
        }`,
      );
    } else {
      for (const worktree of parseWorktreeList(listed.stdout)) {
        if (worktree.isMain || worktree.branch === null) continue;
        const branch = worktree.branch.replace(/^refs\/heads\//, "");
        if (!targets.has(branch)) continue;

        const held = await holdsUnfinishedWork(
          { repoPath, worktreePath: worktree.path, branch },
          deps,
        );
        if (held) {
          blocked.add(branch);
          skippedLine(worktree.path);
          continue;
        }
        const removed = await deps.git(
          ["worktree", "remove", "--force", worktree.path],
          repoPath,
        );
        if (removed.code !== 0) {
          blocked.add(branch);
          failedLine(
            `worktree ${worktree.path}`,
            removed.stderr.trim() || `exit ${removed.code}`,
          );
          continue;
        }
        removedLine(`worktree ${worktree.path}`);
      }
    }
  }

  // 3. The local branches themselves.
  for (const branch of targets) {
    // A branch whose worktree was skipped or could not be removed is still
    // checked out; it goes with that worktree on a later scan.
    if (blocked.has(branch)) continue;
    if (await hasUnpushedCommits(repoPath, branch, deps)) {
      skippedLine(branch);
      continue;
    }
    const deleted = await deps.git(["branch", "-D", branch], repoPath);
    if (deleted.code !== 0) {
      failedLine(
        `local branch ${branch}`,
        deleted.stderr.trim() || `exit ${deleted.code}`,
      );
      continue;
    }
    removedLine(`local branch ${branch}`);
  }

  // 4. The stream's session record — every provider's, in one file. Absent
  //    whenever session resume is off, which is not a fault.
  try {
    const stream = { repo, milestoneTitle: title };
    const path = streamSessionPath(workDir, stream);
    if (await pathExists(path)) {
      await deleteStreamSession(workDir, stream);
      if (await pathExists(path)) {
        failedLine(`stream session ${path}`, "the record is still on disk");
      } else {
        removedLine(`stream session ${path}`);
      }
    }
  } catch (err) {
    failedLine(
      "stream session",
      err instanceof Error ? err.message : String(err),
    );
  }

  return outcome;
}

/**
 * The local branches belonging to `milestone`: its `milestone/**` branch and
 * the issue branches of its children.
 *
 * The children come from GitHub because a branch name alone cannot say which
 * milestone an issue belongs to. A child listing that fails leaves the
 * milestone branch alone to be swept and records the fault, so the child
 * branches are retried rather than silently abandoned.
 */
async function milestoneBranches(
  context: { repo: string; repoPath: string; milestone: ClosedMilestone },
  deps: ClosedMilestoneSweepDeps,
  outcome: MilestoneOutcome,
): Promise<Set<string>> {
  const { repo, repoPath, milestone } = context;
  const listed = await deps.git(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    repoPath,
  );
  if (listed.code !== 0) {
    outcome.errors.push(
      `Could not list the local branches of ${repoPath}: ${
        listed.stderr.trim() || `exit ${listed.code}`
      }`,
    );
    return new Set();
  }
  const local = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const targets = new Set<string>();
  const milestoneBranch = createMilestoneBranchName(milestone.title);
  if (local.includes(milestoneBranch)) targets.add(milestoneBranch);

  // Only ask GitHub for the children when an issue branch could match one.
  const issueBranches = local.filter((b) => childIssueBranchNumber(b) !== null);
  if (issueBranches.length === 0) return targets;

  let children: Set<number>;
  try {
    children = new Set(
      parseIssueNumbers(
        await deps.gh([
          "api",
          "--paginate",
          `repos/${repo}/issues?milestone=${milestone.number}` +
          `&state=all&per_page=100`,
        ]),
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outcome.errors.push(
      `Could not list the children of milestone '${milestone.title}' in ` +
        `${repo}: ${message}`,
    );
    outcome.failures.push(
      `child issue branches of '${milestone.title}': ${message}`,
    );
    deps.log(
      `SELF-HEALING: failed to remove child issue branches for closed ` +
        `milestone ${milestone.title}: ${message} — retrying next scan`,
    );
    return targets;
  }
  for (const branch of issueBranches) {
    const number = childIssueBranchNumber(branch);
    if (number !== null && children.has(number)) targets.add(branch);
  }
  return targets;
}

/**
 * True when a worktree must be left alone: it has uncommitted changes, its
 * branch has commits no remote holds, or git could not be asked. Unreadable
 * counts as held — keeping a directory costs disk, removing one loses work.
 */
async function holdsUnfinishedWork(
  context: { repoPath: string; worktreePath: string; branch: string },
  deps: ClosedMilestoneSweepDeps,
): Promise<boolean> {
  const status = await deps.git(
    ["status", "--porcelain"],
    context.worktreePath,
  );
  if (status.code !== 0 || status.stdout.trim().length > 0) return true;
  return await hasUnpushedCommits(context.repoPath, context.branch, deps);
}

/**
 * True when `branch` carries commits that no remote-tracking ref holds, or
 * when git could not answer.
 *
 * Deliberately measured against **every** remote ref rather than
 * `origin/<branch>`: a merged milestone branch is routinely deleted on the
 * remote, and its commits then live on the default branch — fully pushed, and
 * invisible to a comparison that only knows `origin/<branch>`.
 */
async function hasUnpushedCommits(
  repoPath: string,
  branch: string,
  deps: ClosedMilestoneSweepDeps,
): Promise<boolean> {
  const unpushed = await deps.git(
    ["log", branch, "--not", "--remotes", "--oneline", "-1"],
    repoPath,
  );
  if (unpushed.code !== 0) return true;
  return unpushed.stdout.trim().length > 0;
}

/** Read this repository's persisted state; a missing or corrupt file is empty. */
async function readState(
  workDir: string,
  repo: string,
  deps: ClosedMilestoneSweepDeps,
): Promise<PersistedHousekeepingState> {
  const path = milestoneCloseStatePath(workDir, repo);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return { swept: [] };
  }
  try {
    const parsed = JSON.parse(raw) as PersistedHousekeepingState;
    const swept = Array.isArray(parsed?.swept)
      ? parsed.swept.filter((t): t is string => typeof t === "string")
      : [];
    const listing = parsed?.listing;
    const usable = typeof listing?.fetchedAtEpochMs === "number" &&
        Array.isArray(listing.milestones)
      ? {
        fetchedAtEpochMs: listing.fetchedAtEpochMs,
        milestones: listing.milestones.filter(
          (m): m is ClosedMilestone =>
            typeof m?.number === "number" && typeof m?.title === "string",
        ),
      }
      : undefined;
    return { swept, ...(usable !== undefined ? { listing: usable } : {}) };
  } catch {
    // A corrupt cache re-lists and re-sweeps, which is idempotent — but it is
    // announced rather than swallowed.
    deps.log(
      `milestone-close housekeeping: ${path} is unreadable JSON — rebuilding ` +
        `it, so already-swept milestones are re-checked once`,
    );
    return { swept: [] };
  }
}

/** Persist this repository's state. A write failure costs a re-sweep, not work. */
async function writeState(
  workDir: string,
  repo: string,
  state: PersistedHousekeepingState,
  deps: ClosedMilestoneSweepDeps,
): Promise<void> {
  const path = milestoneCloseStatePath(workDir, repo);
  try {
    await Deno.mkdir(`${workDir}/${MILESTONE_CLOSE_STATE_DIRNAME}`, {
      recursive: true,
    });
    await Deno.writeTextFile(path, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    deps.log(
      `milestone-close housekeeping: could not persist ${path}: ${
        err instanceof Error ? err.message : String(err)
      } — the next scan re-lists and re-sweeps`,
    );
  }
}

/** True when `path` exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
