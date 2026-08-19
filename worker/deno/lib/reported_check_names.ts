/**
 * Discover the status-check names a repository **actually reports**
 * (Issue #4163).
 *
 * A required check is only enforceable if something reports it under exactly
 * that name. Requiring a name nothing reports is the "ghost context" failure:
 * the merge box shows *"Expected — Waiting for status to be reported"* forever
 * and no PR can ever merge. That is precisely what happened when a catalogue
 * entry demanded `gitleaks` / `semgrep` on repos whose Actions report `quality`
 * and `Semgrep SAST scan` instead.
 *
 * So the required-check set is never taken from the catalogue alone: the
 * catalogue's candidate names are intersected with the names GitHub has
 * genuinely reported on the repo. Two sources are unioned, because the
 * canonical workflows trigger on `pull_request` and therefore leave **no**
 * check runs on the default branch's head commit after a squash merge:
 *
 *   1. the default branch head (covers `push`-triggered workflows); and
 *   2. the head commit of the most recently updated closed pull request
 *      (covers the `pull_request`-triggered workflows — the common case).
 *
 * Fail-safe: when neither source can be read, the caller is told the discovery
 * failed and requires **nothing**, rather than guessing a name that may never
 * report.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  defaultGhExec,
  type GhExec,
  isValidBranchName,
  isValidRepoSlug,
} from "./repo_rulesets.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Outcome of a check-name discovery. */
export interface ReportedCheckNames {
  /** True when at least one source was read successfully. */
  ok: boolean;
  /** Distinct check-run names / status contexts seen, in discovery order. */
  names: string[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface CheckRunsResponse {
  check_runs?: Array<{ name?: string }>;
}

interface CombinedStatusResponse {
  statuses?: Array<{ context?: string }>;
}

/** Names reported against one git ref (check runs + legacy commit statuses). */
async function namesForRef(
  repo: string,
  ref: string,
  ghFn: GhExec,
): Promise<{ ok: boolean; names: string[] }> {
  const names: string[] = [];
  let ok = false;

  try {
    const raw = await ghFn([
      "api",
      `repos/${repo}/commits/${ref}/check-runs?per_page=100`,
    ]);
    const parsed = (raw ? JSON.parse(raw) : {}) as CheckRunsResponse;
    for (const run of parsed.check_runs ?? []) {
      if (typeof run.name === "string" && run.name.length > 0) {
        names.push(run.name);
      }
    }
    ok = true;
  } catch {
    // Unreadable ref — fall through to the commit-status source.
  }

  try {
    const raw = await ghFn(["api", `repos/${repo}/commits/${ref}/status`]);
    const parsed = (raw ? JSON.parse(raw) : {}) as CombinedStatusResponse;
    for (const status of parsed.statuses ?? []) {
      if (typeof status.context === "string" && status.context.length > 0) {
        names.push(status.context);
      }
    }
    ok = true;
  } catch {
    // Both sources unreadable for this ref — reported via `ok`.
  }

  return { ok, names };
}

/** Head SHA of the most recently updated closed PR, when there is one. */
async function latestClosedPrHeadSha(
  repo: string,
  ghFn: GhExec,
): Promise<string | undefined> {
  try {
    const raw = await ghFn([
      "api",
      `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=1`,
    ]);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const sha = parsed[0]?.head?.sha;
    return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha)
      ? sha
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Return the distinct status-check names the repo has genuinely reported.
 *
 * @param repo - `owner/repo` slug.
 * @param branch - Default branch name.
 * @param ghFn - Injected `gh` executor (defaults to a real `gh` spawn).
 * @returns `{ ok, names }`; `ok: false` means no source could be read, in
 *   which case `names` is empty and the caller must require nothing.
 */
export async function getReportedCheckNames(
  repo: string,
  branch: string,
  ghFn: GhExec = defaultGhExec,
): Promise<ReportedCheckNames> {
  if (!isValidRepoSlug(repo) || !isValidBranchName(branch)) {
    return { ok: false, names: [] };
  }

  const collected: string[] = [];
  let anyOk = false;

  const fromBranch = await namesForRef(repo, branch, ghFn);
  anyOk = anyOk || fromBranch.ok;
  collected.push(...fromBranch.names);

  const prSha = await latestClosedPrHeadSha(repo, ghFn);
  if (prSha) {
    const fromPr = await namesForRef(repo, prSha, ghFn);
    anyOk = anyOk || fromPr.ok;
    collected.push(...fromPr.names);
  }

  return { ok: anyOk, names: [...new Set(collected)] };
}
