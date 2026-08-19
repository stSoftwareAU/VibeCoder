/**
 * Idle-task milestone merge gate (Issue #2060).
 *
 * Decides whether a completed `idle-task: <template>` milestone should
 * be promoted into a milestone-merge PR. For the `security-scan`
 * template the expected output is a batch of evidence-backed
 * `security`-labelled finding issues, each fixed in its own PR — the
 * milestone branch itself should never carry source-code fixes. So
 * when a security-scan idle-task milestone produces no source-code
 * changes (i.e. the scan turned up nothing real), no merge PR should
 * be raised. The framework instead posts a "no issues found" comment
 * on the wrapper idle-task issue and closes the GitHub milestone.
 *
 * The conceptual trigger is "the scan found no real issues" — we
 * realise that signal by inspecting the cumulative milestone-branch
 * diff against the default branch and accepting only a small,
 * intentional list of auto-generated bookkeeping files as "noise"
 * (the `docs/archive/pr-summaries/pr-summary-<n>.md` audit log — or the
 * legacy `docs/pr-summary-<n>.md` location, for older PRs — the version
 * bump pair, the cspell dictionary). Anything outside that list is
 * treated as real work and the standard milestone-merge flow proceeds.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Title prefix shared by every milestone created by the idle-task
 * framework, e.g. `idle-task: security-scan`.
 */
export const IDLE_TASK_MILESTONE_PREFIX = "idle-task:";

/**
 * Template slug whose merge gate is implemented here. The wider
 * "expected change shape" generalisation for other templates is
 * deliberately deferred (see Issue #2060 scope notes).
 */
export const SECURITY_SCAN_TEMPLATE = "security-scan";

// ---------------------------------------------------------------------------
// Title parsing
// ---------------------------------------------------------------------------

/**
 * Return true when the milestone title is one filed by the idle-task
 * framework. Matching is case-insensitive against the canonical
 * `idle-task:` prefix.
 */
export function isIdleTaskMilestone(title: string): boolean {
  return title.trim().toLowerCase().startsWith(IDLE_TASK_MILESTONE_PREFIX);
}

/**
 * Extract the template slug from a `idle-task: <template>` milestone
 * title. Returns `null` when the title does not match the prefix or
 * the suffix is empty.
 */
export function extractIdleTaskTemplate(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed.toLowerCase().startsWith(IDLE_TASK_MILESTONE_PREFIX)) {
    return null;
  }
  const slug = trimmed.slice(IDLE_TASK_MILESTONE_PREFIX.length).trim();
  return slug.length > 0 ? slug : null;
}

// ---------------------------------------------------------------------------
// Noise-file classification
// ---------------------------------------------------------------------------

/**
 * Files the security-scan idle-task is allowed to produce as a side
 * effect of the worker processing the wrapper issue, without that
 * counting as a real code change.
 *
 * Kept deliberately small — anything outside this list pushes the
 * gate into "raise the merge PR" mode. The intent is to recognise
 * auto-generated bookkeeping that always accompanies an idle-task
 * run, not to whitelist whole directories.
 */
function isNoiseFile(path: string): boolean {
  // PR summary files — current archive location (Issue #2173) and the
  // legacy loose docs/ location for older PRs.
  if (/^docs\/archive\/pr-summaries\/pr-summary-\d+\.md$/.test(path)) {
    return true;
  }
  if (/^docs\/pr-summary-\d+\.md$/.test(path)) return true;
  if (path === "deno.json" || path === "deno.lock") return true;
  if (path === "cspell.json" || path === ".cspell.json") return true;
  if (path === "Version.ts" || path.endsWith("/Version.ts")) return true;
  return false;
}

/**
 * Return true when every changed path is a recognised noise file
 * (or the change set is empty). When this returns true the milestone
 * branch has not delivered any substantive code change — the gate
 * skips the merge PR.
 */
export function isOnlyNoiseChanges(files: readonly string[]): boolean {
  if (files.length === 0) return true;
  return files.every(isNoiseFile);
}

// ---------------------------------------------------------------------------
// Diff lookup
// ---------------------------------------------------------------------------

export type GhCommandFn = (args: string[]) => Promise<string>;

/**
 * Fetch the list of file paths changed between `base` and `head` via
 * the GitHub compare API. Returns an empty list when the head branch
 * has no commits ahead of base, or when the API response is empty.
 *
 * Errors are returned as `Result.error` so the caller can decide
 * whether to fall back to the standard flow.
 */
export async function fetchMilestoneBranchChangedFiles(
  repo: string,
  base: string,
  head: string,
  ghCommandFn: GhCommandFn,
): Promise<Result<string[]>> {
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${base}...${head}`,
      "--jq",
      ".files[].filename",
    ]);
    const files = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { ok: true, value: files };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `fetchMilestoneBranchChangedFiles: ${repo} ${base}...${head}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Gate decision
// ---------------------------------------------------------------------------

/**
 * The decision the gate returns. `raise` — fall through to the
 * standard milestone-merge tracking-issue + PR flow. `skip-no-changes`
 * — the scan produced no real issues; suppress the merge PR and post
 * a "no issues found" comment on the wrapper idle-task issue.
 */
export type IdleTaskMergeGateDecision =
  | { decision: "raise" }
  | { decision: "skip-no-changes"; changedFiles: readonly string[] };

export interface IdleTaskMergeGateOptions {
  /** Milestone title — used to detect the idle-task template. */
  milestoneTitle: string;
  /** Repository in `owner/repo` form. */
  repo: string;
  /** Default branch of the repository. */
  defaultBranch: string;
  /** Milestone branch name. */
  milestoneBranch: string;
  /** Injected gh runner. */
  ghCommandFn: GhCommandFn;
}

/**
 * Decide whether to raise a milestone-merge PR for a completed
 * idle-task milestone. Non-idle-task milestones always fall through
 * to `raise` so the standard behaviour is untouched.
 *
 * Lookup failures (e.g. transient gh hiccups against the compare
 * endpoint) also fall through to `raise` — the standard flow has
 * its own idempotency safeguards and we prefer a noisy PR to a
 * silent skip when the gate cannot tell.
 */
export async function decideIdleTaskMerge(
  opts: IdleTaskMergeGateOptions,
): Promise<IdleTaskMergeGateDecision> {
  const template = extractIdleTaskTemplate(opts.milestoneTitle);
  if (template !== SECURITY_SCAN_TEMPLATE) {
    return { decision: "raise" };
  }

  const filesResult = await fetchMilestoneBranchChangedFiles(
    opts.repo,
    opts.defaultBranch,
    opts.milestoneBranch,
    opts.ghCommandFn,
  );
  if (!filesResult.ok) {
    return { decision: "raise" };
  }
  if (!isOnlyNoiseChanges(filesResult.value)) {
    return { decision: "raise" };
  }
  return { decision: "skip-no-changes", changedFiles: filesResult.value };
}

// ---------------------------------------------------------------------------
// "No issues found" comment
// ---------------------------------------------------------------------------

export interface NoIssuesFoundCommentOptions {
  repo: string;
  /** Issue numbers to comment on (the closed wrapper idle-task issues). */
  issueNumbers: readonly number[];
  /** Milestone title — included in the comment for traceability. */
  milestoneTitle: string;
  /** Changed-file list, included to make the decision auditable. */
  changedFiles: readonly string[];
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
}

/**
 * Render the "no issues found" comment body. Exported so tests can
 * assert against it directly.
 */
export function renderNoIssuesFoundComment(
  milestoneTitle: string,
  changedFiles: readonly string[],
): string {
  const summary = changedFiles.length === 0
    ? "Milestone branch has no commits ahead of the default branch."
    : "Milestone branch only contains auto-generated bookkeeping " +
      "(no source-code changes): " +
      changedFiles.map((f) => `\`${f}\``).join(", ") +
      ".";
  return [
    `## ${milestoneTitle}: no issues found`,
    "",
    "The security scan produced no real issues, so no milestone-merge " +
    "PR has been raised (Issue #2060).",
    "",
    summary,
  ].join("\n");
}

/**
 * Post the "no issues found" comment on every supplied issue
 * (typically the wrapper idle-task issues for the milestone). Each
 * comment failure is logged but does not abort the loop.
 */
export async function postNoIssuesFoundComments(
  opts: NoIssuesFoundCommentOptions,
): Promise<void> {
  const body = renderNoIssuesFoundComment(
    opts.milestoneTitle,
    opts.changedFiles,
  );
  for (const issueNumber of opts.issueNumbers) {
    try {
      await opts.ghCommandFn([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        opts.repo,
        "--body",
        body,
      ]);
      opts.log(
        `Posted no-issues-found comment on ${opts.repo}#${issueNumber} ` +
          `(Issue #2060)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.log(
        `WARNING: failed to post no-issues-found comment on ` +
          `${opts.repo}#${issueNumber}: ${message}`,
      );
    }
  }
}
