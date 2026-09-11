/**
 * What did this branch change? — asked twice, never answered by silence
 * (Issue #1952).
 *
 * The pre-push workflow-scope check (Issue #1475) asked `git diff --name-only
 * origin/<base>...HEAD` and treated *any* failure as "no changed paths": a
 * base ref the clone had not fetched, a spawn timeout, a detached HEAD — all
 * read as "nothing to see", so the check no-opped without a word and the
 * branch went on to meet GitHub's refusal at the push. Absence of an answer
 * is not a pass.
 *
 * So this probe asks a second way — the commit list, which needs no merge
 * base — and logs both the fallback and, when neither can answer, the fact
 * that the check was skipped and why.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { WORKFLOWS_DIR } from "./workflow_scope.ts";

/** A git invocation, injected so the whole probe unit-tests. */
export type RunGitFn = (
  args: string[],
  options?: GitCommandOptions,
) => Promise<Result<{ code: number; stdout: string; stderr: string }>>;

/** Where the changed paths came from — or why there are none. */
export type ChangedPathSource = "diff" | "commit-log" | "unavailable";

/** What the probe found. */
export interface ChangedPathProbe {
  /** Repo-relative paths the branch touched, de-duplicated. */
  paths: string[];
  /** Which question answered, or `"unavailable"` when neither did. */
  source: ChangedPathSource;
  /** Git's own words when an attempt failed; empty when all was well. */
  detail: string;
}

/** Inputs for {@link probeChangedWorkflowPaths}. */
export interface ChangedPathProbeRequest {
  /** The base to compare against, e.g. `origin/main`. */
  baseRef: string;
  /** Working directory of the repo clone. */
  cwd: string;
  /** Git runner (production passes the phase's own). */
  runGit: RunGitFn;
  /** Where a skipped or degraded check is reported. */
  warn: (message: string) => void;
}

/** Git's own words, whichever way the command failed. */
function failureDetail(
  result: Result<{ code: number; stdout: string; stderr: string }>,
): string {
  if (!result.ok) return result.error.message.trim();
  return (result.value.stderr.trim() || result.value.stdout.trim()) ||
    `git exited ${result.value.code}`;
}

/** Non-empty, de-duplicated, order preserved. */
function cleanPaths(stdout: string): string[] {
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const path = line.trim();
    if (path) seen.add(path);
  }
  return [...seen];
}

/**
 * The paths this branch changed, asked two ways (Issue #1952).
 *
 * @param request - See {@link ChangedPathProbeRequest}
 * @returns The paths and which question answered; `"unavailable"` with the
 *   reason when neither could, having warned that the check was skipped
 */
export async function probeChangedWorkflowPaths(
  request: ChangedPathProbeRequest,
): Promise<ChangedPathProbe> {
  const { baseRef, cwd, runGit, warn } = request;

  const diff = await runGit(
    ["diff", "--name-only", `${baseRef}...HEAD`],
    { cwd },
  );
  if (diff.ok && diff.value.code === 0) {
    return { paths: cleanPaths(diff.value.stdout), source: "diff", detail: "" };
  }

  const diffDetail = failureDetail(diff);
  warn(
    `Workflow-scope pre-push check: 'git diff --name-only ${baseRef}...HEAD' ` +
      `could not answer (${diffDetail}) — falling back to the commit list ` +
      `(Issue #1952)`,
  );

  // `git log` walks this branch's own commits, so it answers even when the
  // three-dot merge base cannot be resolved.
  const log = await runGit(
    ["log", "--name-only", "--pretty=format:", `${baseRef}..HEAD`],
    { cwd },
  );
  if (log.ok && log.value.code === 0) {
    return {
      paths: cleanPaths(log.value.stdout),
      source: "commit-log",
      detail: diffDetail,
    };
  }

  const logDetail = failureDetail(log);
  warn(
    `Workflow-scope pre-push check skipped: neither the diff nor the commit ` +
      `list could be read (diff: ${diffDetail}; log: ${logDetail}) — a ` +
      `branch touching ${WORKFLOWS_DIR} will be refused by GitHub at the ` +
      `push instead (Issue #1952)`,
  );
  return {
    paths: [],
    source: "unavailable",
    detail: `diff: ${diffDetail}; log: ${logDetail}`,
  };
}
