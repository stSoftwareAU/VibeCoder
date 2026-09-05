/**
 * Detect files the default branch deleted that a milestone branch still
 * carries (Issue #1048).
 *
 * A squash-style "Sync main into milestone/…" applies the default branch's
 * *content* without recording it as an **ancestor**. Every later merge then
 * computes its merge base from before the squash, so a deletion the default
 * branch made in the meantime comes back as a **modify/delete conflict**
 * instead of a deletion — and "keep the file" is the resolution that looks
 * conservative and is exactly wrong. On `milestone/863` that revived 1984
 * lines of a deliberately-removed subsystem, and it surfaced only because the
 * resurrected test happened to trip an unrelated gate.
 *
 * The check is the direct detector for that whole class:
 *
 *   1. Every file present on the branch and absent on the default branch.
 *   2. Of those, the ones the default branch's history **deleted**.
 *   3. Of those, the ones whose deleting commit is already an **ancestor** of
 *      the branch.
 *
 * Step 3 is what separates a resurrection from a branch that is merely
 * behind. A stale branch has not seen the deletion yet, so merging it loses
 * nothing; a branch that has the deleting commit in its ancestry and the file
 * in its tree has actively brought the file back.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { assertSafeGitRef } from "./git_ref_args.ts";

/** Outcome of one git invocation, as the injected runner reports it. */
export interface GitRunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git in the repository under check. */
export type ResurrectionGitFn = (args: string[]) => Promise<GitRunOutput>;

/** One file the branch resurrected. */
export interface ResurrectedFile {
  /** Repository-relative path, as git reports it. */
  path: string;
  /** Full SHA of the default-branch commit that deleted it. */
  deletedBySha: string;
  /** Subject line of that commit, so the report names it in prose. */
  deletedBySubject: string;
}

/** What {@link findResurrectedFiles} found. */
export interface ResurrectionReport {
  /** The branch that was checked. */
  branch: string;
  /** The branch its deletions were taken from. */
  defaultBranch: string;
  /** Files present on the branch and absent on the default branch. */
  branchOnlyFiles: number;
  /** The resurrections, in path order. Empty means the branch is clean. */
  resurrected: ResurrectedFile[];
}

/**
 * Pathspecs per `git log` invocation. Batched so a badly-diverged branch with
 * thousands of branch-only files cannot overflow the process argument limit.
 */
const PATHSPEC_BATCH = 400;

/**
 * Sentinel prefixing each commit header in the deletion log. NUL is the one
 * byte a path cannot contain, so a filename can never be read as a header.
 */
const COMMIT_MARKER = "\0";

/**
 * `git log --format` for the deletion log: a NUL, the full SHA, a tab, the
 * subject. The escapes stay `%x00`/`%x09` in the argv — a real NUL cannot be
 * passed to a process at all — and git expands them in its output.
 */
const COMMIT_FORMAT = "--format=%x00%H%x09%s";

/** Run git and fail loud — a check that cannot read the repo reports nothing. */
async function git(
  gitFn: ResurrectionGitFn,
  args: string[],
  what: string,
): Promise<Result<string>> {
  const out = await gitFn(args);
  if (out.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Could not ${what} (git ${args.join(" ")} exited ${out.code}): ${
          out.stderr.trim() || "git reported no stderr"
        }`,
      ),
    };
  }
  return { ok: true, value: out.stdout };
}

/** Split NUL-delimited `git ls-tree -z` output into paths. */
export function parseTreePaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

/**
 * Parse `git log --diff-filter=D --name-only` output into the most recent
 * deleting commit per path.
 *
 * `git log` reports newest first, so the first sighting of a path wins: a file
 * deleted, re-added and deleted again is attributed to the deletion that
 * currently stands.
 */
export function parseDeletionLog(
  output: string,
): Map<string, { sha: string; subject: string }> {
  const deletions = new Map<string, { sha: string; subject: string }>();
  let sha = "";
  let subject = "";
  for (const line of output.split("\n")) {
    if (line.startsWith(COMMIT_MARKER)) {
      const header = line.slice(COMMIT_MARKER.length);
      const tab = header.indexOf("\t");
      sha = tab === -1 ? header.trim() : header.slice(0, tab).trim();
      subject = tab === -1 ? "" : header.slice(tab + 1).trim();
      continue;
    }
    const path = line.trim();
    if (path.length === 0 || sha.length === 0) continue;
    if (!deletions.has(path)) deletions.set(path, { sha, subject });
  }
  return deletions;
}

/**
 * Find files the default branch deleted that `branch` still carries.
 *
 * @param branch - The branch under check (a milestone branch, or `HEAD`).
 * @param defaultBranch - The branch whose deletions are authoritative.
 * @param gitFn - Runs git in the repository under check.
 * @returns The report, or an error when git could not be read. A git failure
 *   is never reported as a clean branch.
 */
export async function findResurrectedFiles(
  branch: string,
  defaultBranch: string,
  gitFn: ResurrectionGitFn,
): Promise<Result<ResurrectionReport>> {
  try {
    assertSafeGitRef(branch, "branch under check");
    assertSafeGitRef(defaultBranch, "default branch");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const branchTree = await git(
    gitFn,
    ["ls-tree", "-r", "--name-only", "-z", branch],
    `list the files on '${branch}'`,
  );
  if (!branchTree.ok) return branchTree;

  const defaultTree = await git(
    gitFn,
    ["ls-tree", "-r", "--name-only", "-z", defaultBranch],
    `list the files on '${defaultBranch}'`,
  );
  if (!defaultTree.ok) return defaultTree;

  const onDefault = new Set(parseTreePaths(defaultTree.value));
  const candidates = parseTreePaths(branchTree.value)
    .filter((path) => !onDefault.has(path));

  const report: ResurrectionReport = {
    branch,
    defaultBranch,
    branchOnlyFiles: candidates.length,
    resurrected: [],
  };
  if (candidates.length === 0) return { ok: true, value: report };

  // Which of the branch-only files the default branch's history deleted.
  const deletions = new Map<string, { sha: string; subject: string }>();
  for (let i = 0; i < candidates.length; i += PATHSPEC_BATCH) {
    const batch = candidates.slice(i, i + PATHSPEC_BATCH);
    const log = await git(
      gitFn,
      [
        // Unquoted paths, so a non-ASCII filename matches the tree listing.
        "-c",
        "core.quotePath=false",
        "log",
        "--diff-filter=D",
        "--name-only",
        COMMIT_FORMAT,
        defaultBranch,
        "--",
        ...batch,
      ],
      `read the deletions on '${defaultBranch}'`,
    );
    if (!log.ok) return log;
    for (const [path, commit] of parseDeletionLog(log.value)) {
      if (!deletions.has(path)) deletions.set(path, commit);
    }
  }
  if (deletions.size === 0) return { ok: true, value: report };

  // Only a deletion the branch has already integrated is a resurrection —
  // a branch that is merely behind has not seen it yet.
  const ancestry = new Map<string, boolean>();
  for (const [path, commit] of deletions) {
    let integrated = ancestry.get(commit.sha);
    if (integrated === undefined) {
      const probe = await gitFn([
        "merge-base",
        "--is-ancestor",
        commit.sha,
        branch,
      ]);
      // 0 = ancestor, 1 = not; anything else is a genuine git failure.
      if (probe.code !== 0 && probe.code !== 1) {
        return {
          ok: false,
          error: new Error(
            `Could not test whether ${commit.sha} is an ancestor of ` +
              `'${branch}' (git exited ${probe.code}): ${
                probe.stderr.trim() || "git reported no stderr"
              }`,
          ),
        };
      }
      integrated = probe.code === 0;
      ancestry.set(commit.sha, integrated);
    }
    if (integrated) {
      report.resurrected.push({
        path,
        deletedBySha: commit.sha,
        deletedBySubject: commit.subject,
      });
    }
  }
  report.resurrected.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, value: report };
}

/**
 * Render a report for a human, naming every file and the commit that deleted
 * it — the two facts needed to decide between a re-delete and a deliberate
 * re-add.
 */
export function formatResurrectionReport(report: ResurrectionReport): string {
  if (report.resurrected.length === 0) {
    return `No resurrected files on '${report.branch}': ${report.branchOnlyFiles} ` +
      `file(s) are on it and not on '${report.defaultBranch}', and ` +
      `'${report.defaultBranch}' deleted none of them (Issue #1048)`;
  }
  const lines = report.resurrected.map((file) =>
    `  - ${file.path} — deleted by ${file.deletedBySha.slice(0, 8)} ${
      file.deletedBySubject || "(no subject)"
    }`
  );
  return `'${report.branch}' carries ${report.resurrected.length} file(s) that ` +
    `'${report.defaultBranch}' deleted (Issue #1048):\n${
      lines.join("\n")
    }\n\n` +
    `Each deletion is already in this branch's ancestry, so the file came ` +
    `back after the branch had it removed — almost always a modify/delete ` +
    `conflict resolved by keeping the file. Delete it on the branch, or, if ` +
    `it is genuinely needed, re-add it in a commit that says why.`;
}
