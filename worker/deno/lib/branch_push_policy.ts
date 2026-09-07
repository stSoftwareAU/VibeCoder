/**
 * Does a repository's default branch take **direct pushes**? (Issue #4356)
 *
 * A `required_status_checks` ruleset is right for a PR-driven code repo and
 * wrong for a data repo whose default branch is pushed to directly by the
 * fleet (FLEET workers check results straight in to `Develop`): there is never
 * a PR, so no check can ever be reported, and every push is refused with
 * `GH013 … required status checks are expected`. Six data repos stalled for
 * days that way after the ruleset configurator (Issue #4163) locked them.
 *
 * This module answers the question the configurator must ask **before** it
 * writes anything, from three signals:
 *
 *   1. **Explicit opt-out** — the repo carries the topic
 *      {@link DIRECT_PUSH_TOPIC}, or the marker file
 *      {@link NO_RULESET_MARKER_PATH} exists at the default branch head. The
 *      answer records which of the two fired (`source`), because only the
 *      admin-gated topic is strong enough to justify *removing* protection
 *      (Issue #1289).
 *   2. **Observed direct pushes** — any of the last
 *      {@link DIRECT_PUSH_SAMPLE_SIZE} commits on the branch is not the merge
 *      of a pull request: its subject carries no `(#N)` squash marker, it is
 *      not a `Merge pull request #N` commit, and
 *      `GET /repos/{repo}/commits/{sha}/pulls` names no **merged** PR.
 *   3. **Uncertainty** — when any of those reads fails the answer is
 *      `unknown`, and the caller must not lock the branch. Never lock on
 *      uncertainty (the same fail-safe stance as the check-name discovery in
 *      `reported_check_names.ts`).
 *
 * Rate-limit note: one topics read, one contents read, one commit-list read,
 * and one pulls read per sampled commit that lacks a PR marker — at most
 * `3 + DIRECT_PUSH_SAMPLE_SIZE` calls, short-circuiting on the first direct
 * commit. Setup-time only; never call this from a per-tick path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  defaultGhExec,
  type GhExec,
  isNotFoundError,
  isValidBranchName,
  isValidRepoSlug,
} from "./repo_rulesets.ts";

// ---------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------

/** How many recent default-branch commits are inspected. */
export const DIRECT_PUSH_SAMPLE_SIZE = 20;

/** Repository topic that opts a repo out of the default-branch ruleset. */
export const DIRECT_PUSH_TOPIC = "direct-push";

/** Marker file (at the default branch head) that opts a repo out. */
export const NO_RULESET_MARKER_PATH = ".vibe/no-default-branch-ruleset";

/** How the default branch is fed, as far as the worker can tell. */
export type BranchPushPolicy =
  /** Every sampled commit arrived through a merged pull request. */
  | { kind: "pr-only"; sampled: number }
  /**
   * The repo opted out explicitly. `source` says which signal fired, because
   * the two carry very different authority (Issue #1289): the topic is
   * repository *settings*, writable only with admin permission, while the
   * marker file is ordinary repository *content* anybody with write access —
   * or a merged PR — can land. A caller may suppress creating a ruleset on
   * either signal, but must never remove existing protection on `marker`.
   */
  | { kind: "opted-out"; source: "topic" | "marker"; detail: string }
  /** At least one sampled commit was pushed directly. */
  | { kind: "direct-push"; sha: string; subject: string; detail: string }
  /** A read failed, so the branch cannot be classified — treat as unsafe. */
  | { kind: "unknown"; detail: string };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * True when a commit subject marks the commit as the merge of a pull request:
 * a squash/rebase marker `(#N)` anywhere in the subject, or GitHub's own
 * `Merge pull request #N` merge-commit subject.
 */
export function isPrMergeSubject(subject: string): boolean {
  return /\(#\d+\)/.test(subject) || /^Merge pull request #\d+/.test(subject);
}

/** First line of a commit message, trimmed. */
export function commitSubject(message: unknown): string {
  if (typeof message !== "string") return "";
  return (message.split("\n")[0] ?? "").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Whether the opt-out topic is set; a failed read is reported, not guessed. */
async function hasDirectPushTopic(
  repo: string,
  ghFn: GhExec,
): Promise<{ ok: true; present: boolean } | { ok: false; error: string }> {
  try {
    const raw = await ghFn(["api", `repos/${repo}/topics`]);
    const parsed = raw ? JSON.parse(raw) : {};
    const names: unknown = parsed?.names;
    const present = Array.isArray(names) &&
      names.some((n) => n === DIRECT_PUSH_TOPIC);
    return { ok: true, present };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Marker file presence at the branch head; a 404 is a plain "absent". */
async function hasNoRulesetMarker(
  repo: string,
  branch: string,
  ghFn: GhExec,
): Promise<{ ok: true; present: boolean } | { ok: false; error: string }> {
  try {
    await ghFn([
      "api",
      `repos/${repo}/contents/${NO_RULESET_MARKER_PATH}?ref=${branch}`,
    ]);
    return { ok: true, present: true };
  } catch (error) {
    if (isNotFoundError(error)) return { ok: true, present: false };
    return { ok: false, error: errorMessage(error) };
  }
}

interface SampledCommit {
  sha: string;
  subject: string;
}

async function listRecentCommits(
  repo: string,
  branch: string,
  ghFn: GhExec,
): Promise<
  { ok: true; commits: SampledCommit[] } | { ok: false; error: string }
> {
  try {
    const raw = await ghFn([
      "api",
      `repos/${repo}/commits?sha=${branch}&per_page=${DIRECT_PUSH_SAMPLE_SIZE}`,
    ]);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "commit list is not an array" };
    }
    const commits: SampledCommit[] = [];
    for (const entry of parsed) {
      const sha = entry?.sha;
      if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/.test(sha)) {
        return { ok: false, error: `malformed commit sha: ${String(sha)}` };
      }
      commits.push({ sha, subject: commitSubject(entry?.commit?.message) });
    }
    return { ok: true, commits };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** True when `GET /commits/{sha}/pulls` names at least one merged PR. */
async function commitHasMergedPr(
  repo: string,
  sha: string,
  ghFn: GhExec,
): Promise<{ ok: true; merged: boolean } | { ok: false; error: string }> {
  try {
    const raw = await ghFn(["api", `repos/${repo}/commits/${sha}/pulls`]);
    const parsed = raw ? JSON.parse(raw) : [];
    const merged = Array.isArray(parsed) &&
      parsed.some((pr) =>
        typeof pr?.merged_at === "string" && pr.merged_at.length > 0
      );
    return { ok: true, merged };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Classify how a repository's default branch is fed.
 *
 * Order matters: the explicit opt-out is checked first (two cheap reads), then
 * the commit sample. Any read failure yields `unknown` — the caller must treat
 * that as "do not lock".
 *
 * @param repo - `owner/repo` slug.
 * @param branch - Default branch name.
 * @param ghFn - Injected `gh` executor (defaults to a real `gh` spawn).
 */
export async function assessBranchPushPolicy(
  repo: string,
  branch: string,
  ghFn: GhExec = defaultGhExec,
): Promise<BranchPushPolicy> {
  if (!isValidRepoSlug(repo)) {
    return { kind: "unknown", detail: `invalid repo slug: ${repo}` };
  }
  if (!isValidBranchName(branch)) {
    return { kind: "unknown", detail: `invalid branch name: ${branch}` };
  }

  // 1. Explicit opt-out — topic, then marker file.
  const topic = await hasDirectPushTopic(repo, ghFn);
  if (!topic.ok) {
    return { kind: "unknown", detail: `topics unreadable: ${topic.error}` };
  }
  if (topic.present) {
    return {
      kind: "opted-out",
      source: "topic",
      detail: `repository topic "${DIRECT_PUSH_TOPIC}" is set`,
    };
  }
  const marker = await hasNoRulesetMarker(repo, branch, ghFn);
  if (!marker.ok) {
    return {
      kind: "unknown",
      detail: `marker file unreadable: ${marker.error}`,
    };
  }
  if (marker.present) {
    return {
      kind: "opted-out",
      source: "marker",
      detail: `marker file ${NO_RULESET_MARKER_PATH} exists on ${branch}`,
    };
  }

  // 2. Observed history — any commit not associated with a merged PR is a
  //    direct push, and the first one found decides the answer.
  const history = await listRecentCommits(repo, branch, ghFn);
  if (!history.ok) {
    return {
      kind: "unknown",
      detail: `commit history unreadable: ${history.error}`,
    };
  }
  for (const commit of history.commits) {
    if (isPrMergeSubject(commit.subject)) continue;
    const pulls = await commitHasMergedPr(repo, commit.sha, ghFn);
    if (!pulls.ok) {
      return {
        kind: "unknown",
        detail: `pull requests for ${
          commit.sha.slice(0, 7)
        } unreadable: ${pulls.error}`,
      };
    }
    if (pulls.merged) continue;
    return {
      kind: "direct-push",
      sha: commit.sha,
      subject: commit.subject,
      detail:
        `${commit.sha.slice(0, 7)} "${commit.subject}" reached ${branch}` +
        " without a merged pull request",
    };
  }
  return { kind: "pr-only", sampled: history.commits.length };
}
