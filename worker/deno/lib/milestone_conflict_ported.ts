/**
 * The milestone sync's "ported" rung (Issue #2023).
 *
 * On 2026-09-12 the sync's agent rung spent 44 minutes and 800 tool calls on
 * a ninety-file conflict — twenty-five of them add/add pairs across whole
 * directories — merging the default branch into a milestone branch whose
 * content had already reached that default branch through another
 * milestone's squash. The three-way merge saw two branches editing the same
 * files from an ancient base and collided on every one, compatible or not.
 * No amount of reading hunks settles that: the question is not "which lines"
 * but "has the other side already absorbed this side's version and moved
 * on?" — and git can answer it from history, byte for byte.
 *
 * The rule: for a conflicted path where both sides have a version, if the
 * **default branch's history** contains a commit whose version of that path
 * is byte-identical to the milestone's current version (the stage-2 blob),
 * the default branch absorbed the milestone's version and has since changed
 * it; its current version is the milestone's plus everything after, so it is
 * taken. Symmetrically, if the milestone's history contains the default
 * branch's exact current version, the milestone moved on from it and the
 * milestone's version is taken. Neither is a side-pick: the side kept is the
 * one that provably contains the other. When neither history holds the other
 * side's version, the rung says nothing and the path climbs to the agent
 * exactly as before.
 *
 * The conflict's *shape* — how many files, how many add/add pairs across how
 * many directories — is read once and logged, so the sync's report can say
 * "wrong-base shape" in words; the rule itself runs on every path the rungs
 * above left, because its evidence is per file and costs one history lookup.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { runGitCommand } from "./git_timeout.ts";
import { assertSafeGitRef, assertSafeRefComponent } from "./git_ref_args.ts";
import type { FileDecision } from "./milestone_conflict_triage.ts";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** What a conflict set looks like, before anyone reads a hunk. */
export interface ConflictShape {
  /** Conflicted paths in total. */
  files: number;
  /** Paths with no merge-base stage: both sides added them. */
  addAdd: number;
  /** Distinct directories the add/add paths sit in. */
  addAddDirectories: number;
}

/** When a shape is read as "the base is wrong, not the hunks". */
export interface ShapeThresholds {
  /** More conflicted files than this is a wrong-base shape. */
  maxFiles: number;
  /** Add/add conflicts spread over more directories than this is one too. */
  maxAddAddDirectories: number;
}

/**
 * The defaults: twenty files, or add/add pairs in more than one directory.
 *
 * Twenty is far above any conflict the triage and rules have settled in the
 * ledger, and one directory of add/add pairs is what a single new feature
 * both sides happened to write looks like; two or more is a tree that exists
 * on both sides under different history.
 */
export const DEFAULT_SHAPE_THRESHOLDS: ShapeThresholds = {
  maxFiles: 20,
  maxAddAddDirectories: 1,
};

/** The directory a repository path sits in; `.` for the root. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

/**
 * Classify a conflict set from the index stages git reported for it.
 *
 * @param files - Each conflicted path with whether a merge-base stage exists
 * @returns The shape, counted — pure, so a test needs no git
 */
export function classifyConflictShape(
  files: readonly { path: string; hasBase: boolean }[],
): ConflictShape {
  const addAddDirectories = new Set<string>();
  let addAdd = 0;
  for (const file of files) {
    if (file.hasBase) continue;
    addAdd++;
    addAddDirectories.add(directoryOf(file.path));
  }
  return {
    files: files.length,
    addAdd,
    addAddDirectories: addAddDirectories.size,
  };
}

/**
 * Whether a shape says the branches do not share the history the merge
 * assumes — a wrong base, not a set of hunks to read.
 */
export function isWrongBaseShape(
  shape: ConflictShape,
  thresholds: ShapeThresholds = DEFAULT_SHAPE_THRESHOLDS,
): boolean {
  return shape.files > thresholds.maxFiles ||
    shape.addAddDirectories > thresholds.maxAddAddDirectories;
}

/** One line naming the shape, for the log and the sync's report. */
export function describeConflictShape(shape: ConflictShape): string {
  return `${shape.files} conflicted file(s), ${shape.addAdd} add/add across ` +
    `${shape.addAddDirectories} director${
      shape.addAddDirectories === 1 ? "y" : "ies"
    }`;
}

// ---------------------------------------------------------------------------
// Index stages
// ---------------------------------------------------------------------------

/** The blob each stage holds for one conflicted path; absent means no stage. */
export interface PathStages {
  base?: string;
  ours?: string;
  theirs?: string;
}

/**
 * Parse `git ls-files -u` output — `<mode> <sha> <stage>\t<path>` per line —
 * into the blob each stage holds, per path. Pure.
 */
export function parseStageBlobs(output: string): Map<string, PathStages> {
  const stages = new Map<string, PathStages>();
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [, sha, stage] = line.slice(0, tab).trim().split(/\s+/);
    const path = line.slice(tab + 1);
    if (!sha || !stage) continue;
    const entry = stages.get(path) ?? {};
    if (stage === "1") entry.base = sha;
    else if (stage === "2") entry.ours = sha;
    else if (stage === "3") entry.theirs = sha;
    stages.set(path, entry);
  }
  return stages;
}

/** Describe a git failure for a reason line. */
function describe(
  result: Result<{ code: number; stdout: string; stderr: string }>,
): string {
  if (!result.ok) return result.error.message;
  const detail = (result.value.stderr || result.value.stdout).trim();
  return detail || `git exited ${result.value.code}`;
}

/**
 * Read the stage blobs of the given conflicted paths.
 *
 * A listing git could not produce is an error, never an empty map: a rung
 * that read "no stages" as "nothing conflicted" would be the silent pass
 * the ladder exists to prevent.
 */
export async function readStageBlobs(
  paths: readonly string[],
  options: GitCommandOptions,
): Promise<Result<Map<string, PathStages>>> {
  if (paths.length === 0) return { ok: true, value: new Map() };
  const listed = await runGitCommand(
    ["ls-files", "-u", "--", ...paths],
    options,
  );
  if (!listed.ok || listed.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `the conflicted paths' stages could not be read: ${describe(listed)}`,
      ),
    };
  }
  return { ok: true, value: parseStageBlobs(listed.value.stdout) };
}

/** The shape of a set of stages, for the log. */
export function shapeOf(
  paths: readonly string[],
  stages: ReadonlyMap<string, PathStages>,
): ConflictShape {
  return classifyConflictShape(
    paths.map((path) => ({
      path,
      hasBase: stages.get(path)?.base !== undefined,
    })),
  );
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/**
 * The commit in `ref`'s history whose version of `path` is `blob`, or `""`.
 *
 * `--find-object` lists the commits that introduced or removed that exact
 * blob, so a hit is proof the branch carried this byte-identical version at
 * some point.
 */
async function commitCarrying(
  ref: string,
  path: string,
  blob: string,
  options: GitCommandOptions,
): Promise<Result<string>> {
  const found = await runGitCommand(
    [
      "log",
      "--format=%H",
      "--max-count=1",
      `--find-object=${blob}`,
      "--end-of-options",
      ref,
      "--",
      path,
    ],
    options,
  );
  if (!found.ok || found.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `the history of '${path}' on '${ref}' could not be searched: ${
          describe(found)
        }`,
      ),
    };
  }
  return { ok: true, value: found.value.stdout.trim() };
}

/** Why one path was, or was not, settled by the rule. */
export type PortedVerdict =
  /** The default branch carried the milestone's exact version; take theirs. */
  | { kind: "theirs"; carriedBy: string }
  /** The milestone carried the default branch's exact version; take ours. */
  | { kind: "ours"; carriedBy: string }
  /** No history holds the other side's version; not this rung's to decide. */
  | { kind: "undecided"; reason: string };

/**
 * Decide one conflicted path from history (Issue #2023).
 *
 * Both sides must hold a version; a path one side deleted is the
 * modify/delete rule's (Issue #1048) and is left undecided here. Identical
 * blobs never reach a conflicted index, so the two lookups cannot both hit.
 */
export async function decidePorted(
  path: string,
  stages: PathStages,
  milestoneRef: string,
  defaultBranch: string,
  options: GitCommandOptions,
): Promise<PortedVerdict> {
  if (!stages.ours || !stages.theirs) {
    return {
      kind: "undecided",
      reason: "one side has no version of it — the modify/delete rule's case",
    };
  }
  const onDefault = await commitCarrying(
    defaultBranch,
    path,
    stages.ours,
    options,
  );
  if (!onDefault.ok) {
    return { kind: "undecided", reason: onDefault.error.message };
  }
  if (onDefault.value) return { kind: "theirs", carriedBy: onDefault.value };
  const onMilestone = await commitCarrying(
    milestoneRef,
    path,
    stages.theirs,
    options,
  );
  if (!onMilestone.ok) {
    return { kind: "undecided", reason: onMilestone.error.message };
  }
  if (onMilestone.value) return { kind: "ours", carriedBy: onMilestone.value };
  return {
    kind: "undecided",
    reason: "neither branch's history carries the other side's version",
  };
}

// ---------------------------------------------------------------------------
// The rung
// ---------------------------------------------------------------------------

/** What the rung was asked to settle. */
export interface PortedRequest {
  /** The paths the rungs above left undecided. */
  paths: readonly string[];
  /** Git options; `cwd` is the clone holding the conflicted merge. */
  options: GitCommandOptions;
  milestoneBranch: string;
  defaultBranch: string;
  thresholds?: ShapeThresholds;
  /** Sink for the rung's diagnostics. */
  log?: (message: string) => void;
}

/** What the rung settled, path by path. */
export interface PortedOutcome {
  shape: ConflictShape;
  /** Paths staged from the side that provably contains the other. */
  resolved: { path: string; side: "ours" | "theirs"; carriedBy: string }[];
  /** Paths left for the next rung, each with why. */
  undecided: { path: string; reason: string }[];
}

/** The rung as the ladder calls it; injectable so a test needs no git. */
export type PortedFn = (request: PortedRequest) => Promise<PortedOutcome>;

/**
 * Settle every conflicted path whose other side provably absorbed it, and
 * stage the result (Issue #2023).
 *
 * Nothing is written for a path the rule cannot decide. A stage listing that
 * cannot be read leaves every path undecided with the reason, so the agent
 * rung below sees exactly what it would have seen without this module.
 *
 * @param request - The paths, the clone and the branches
 * @returns The shape, and what was settled
 */
export async function resolvePortedPaths(
  request: PortedRequest,
): Promise<PortedOutcome> {
  const {
    paths,
    options,
    milestoneBranch,
    defaultBranch,
    thresholds = DEFAULT_SHAPE_THRESHOLDS,
  } = request;
  const log = request.log ?? (() => {});
  const empty: ConflictShape = {
    files: paths.length,
    addAdd: 0,
    addAddDirectories: 0,
  };
  const undecidedAll = (reason: string): PortedOutcome => ({
    shape: empty,
    resolved: [],
    undecided: paths.map((path) => ({ path, reason })),
  });
  // The branch names reach git as positionals (Issue #12).
  try {
    assertSafeGitRef(milestoneBranch, "ported-rule milestone branch");
    assertSafeRefComponent(defaultBranch, "ported-rule default branch");
  } catch (err) {
    return undecidedAll(err instanceof Error ? err.message : String(err));
  }
  const stages = await readStageBlobs(paths, options);
  if (!stages.ok) return undecidedAll(stages.error.message);
  const shape = shapeOf(paths, stages.value);
  log(
    `Milestone sync: conflict shape on '${milestoneBranch}' is ${
      describeConflictShape(shape)
    }${
      isWrongBaseShape(shape, thresholds)
        ? " — a wrong-base shape, not hunks to read"
        : ""
    } (Issue #2023)`,
  );

  const resolved: PortedOutcome["resolved"] = [];
  const undecided: PortedOutcome["undecided"] = [];
  for (const path of paths) {
    const entry = stages.value.get(path);
    if (!entry) {
      undecided.push({ path, reason: "git no longer lists it as unmerged" });
      continue;
    }
    // HEAD is the milestone tip while the merge is in progress.
    const verdict = await decidePorted(
      path,
      entry,
      "HEAD",
      defaultBranch,
      options,
    );
    if (verdict.kind === "undecided") {
      undecided.push({ path, reason: verdict.reason });
      continue;
    }
    const took = await runGitCommand(
      ["checkout", `--${verdict.kind}`, "--", path],
      options,
    );
    const staged = took.ok && took.value.code === 0
      ? await runGitCommand(["add", "--", path], options)
      : took;
    if (!staged.ok || staged.value.code !== 0) {
      undecided.push({
        path,
        reason: `its ${verdict.kind} side could not be staged: ${
          describe(staged)
        }`,
      });
      continue;
    }
    resolved.push({ path, side: verdict.kind, carriedBy: verdict.carriedBy });
  }
  if (resolved.length > 0) {
    log(
      `Milestone sync: ported rule settled ${resolved.length} of ${paths.length} ` +
        `path(s) on '${milestoneBranch}' from history — ${
          resolved.map((r) =>
            `${r.path}: ${r.side} (${r.carriedBy.slice(0, 8)})`
          )
            .join(", ")
        } (Issue #2023)`,
    );
  }
  return { shape, resolved, undecided };
}

/** The decision the ladder records for one path the rule settled. */
export function portedDecision(
  decision: FileDecision,
  settled: PortedOutcome["resolved"][number],
  defaultBranch: string,
): FileDecision {
  const reason = settled.side === "theirs"
    ? `'${defaultBranch}' already carried this exact version at ` +
      `${settled.carriedBy.slice(0, 8)} and moved on; its version contains ours`
    : `the milestone already carried '${defaultBranch}''s exact version at ` +
      `${
        settled.carriedBy.slice(0, 8)
      } and moved on; our version contains theirs`;
  return { ...decision, action: "resolved", rung: "ported", reason };
}
