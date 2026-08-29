/**
 * Stale-lineage detection and self-healing rebase (Issue #534).
 *
 * Two runs held one issue branch. Writer A rebased and force-pushed; writer B
 * never saw it, kept committing on the pre-rebase lineage, and after A's PR
 * squash-merged it **re-created the branch GitHub had just reaped** and opened
 * a duplicate PR. That PR could never merge: the squash means the branch's old
 * commits are not ancestors of the base, so identical content collides
 * (`CONFLICT (add/add)`), and a `git merge` can never resolve that shape. It
 * sat `CONFLICTING` on a two-attempt path to `needs-human` — and a wedge that
 * needs a human hand is itself the bug.
 *
 * The shape is detectable *before* the push, from one `gh` read and two
 * ancestry tests:
 *
 *   1. a **merged** PR was raised from this head ref;
 *   2. its merge commit is contained in the base branch;
 *   3. the branch tip does **not** contain that merge commit.
 *
 * (1)+(2) mean the base already carries a squash of this branch's work; (3)
 * means this branch never learnt about it. A branch that was rebased onto the
 * post-merge base contains the merge commit and is therefore never flagged, so
 * legitimate follow-up work on a reused branch name is untouched.
 *
 * The recovery replays content rather than picking sides. The branch is reset
 * to the current base and each of its commits is cherry-picked back; a commit
 * whose content is already in the base applies as an empty change and is
 * dropped, leaving only the genuinely unmerged work. Two post-conditions make
 * that safe:
 *
 *   - **No unexplained deletion.** If the result deletes a file the base has
 *     and no replayed commit deletes, the heal is refused and the branch is
 *     restored. On the original incident, resolving in favour of the PR side
 *     would have reverted a *different* issue's merged work — that check is
 *     what catches it.
 *   - **Lease-protected push.** The healed branch is pushed with
 *     `--force-with-lease` pinned to the remote SHA observed before the
 *     rebase, so a writer whose remote head moved underneath it stops instead
 *     of destroying the other writer's commits — the exact loss that started
 *     this.
 *
 * Every read failure yields `unknown`, never a silent "not stale": this guard
 * decides whether finished work is pushed, so an unreadable `gh` must not
 * withhold it — but it is always reported, never swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { GitRunner } from "./git_base_ref.ts";
import { resolveComparableBaseRef } from "./git_base_ref.ts";
import { ensureHistoryDepth } from "./git_history.ts";
import {
  assertSafeGitRef,
  buildFetchArgs,
  buildPushArgs,
} from "./git_ref_args.ts";
import { buildForceWithLeaseArgs } from "./git_push_lease_args.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A merged PR raised from the branch, with the ancestry facts about it. */
export interface MergedHeadRefPr {
  /** PR number, as `gh` reported it. */
  number: number;
  /** The commit the merge produced on the base (the squash, for a squash merge). */
  mergeCommit: string;
  /** Whether {@link mergeCommit} is an ancestor of the base ref. */
  inBase: boolean;
  /** Whether {@link mergeCommit} is an ancestor of the branch tip. */
  inBranch: boolean;
}

/** What the branch's lineage is, relative to the base it would merge into. */
export type LineageVerdict =
  /** Nothing on the base squashes this branch's work — push as normal. */
  | { kind: "current"; detail: string }
  /** The base already carries a squash of this branch, which never saw it. */
  | {
    kind: "stale-squashed";
    prNumber: number;
    mergeCommit: string;
    detail: string;
  }
  /** A read failed, so the lineage cannot be classified. */
  | { kind: "unknown"; detail: string };

/** What {@link healStaleBranchLineage} did. */
export type StaleLineageOutcome =
  /** Lineage is current (or unclassifiable) — the caller pushes as normal. */
  | { kind: "not-stale"; detail: string }
  | { kind: "unknown"; detail: string }
  /** The branch was rebased onto the base; `pushed` says whether it went up. */
  | {
    kind: "healed";
    detail: string;
    /** Original SHAs replayed onto the base, oldest first. */
    replayed: string[];
    /** Original SHAs dropped because the base already carries their content. */
    dropped: string[];
    previousHead: string;
    newHead: string;
    /** False when nothing was left to push (every commit was already in base). */
    pushed: boolean;
  }
  /** Stale, and could not be healed safely — a loud stop, never a silent push. */
  | { kind: "refused"; detail: string };

/** Result of the local rebase performed by {@link rebaseOntoBase}. */
export interface RebaseOntoBaseResult {
  /** The branch tip before the rebase, so the caller can name what moved. */
  previousHead: string;
  /** The branch tip after the rebase. */
  newHead: string;
  /** Original SHAs replayed, oldest first. */
  replayed: string[];
  /** Original SHAs whose content the base already carried. */
  dropped: string[];
}

/** Everything {@link healStaleBranchLineage} needs. */
export interface HealStaleBranchLineageOptions {
  /** `owner/repo` slug, for the merged-PR lookup. */
  repo: string;
  /** The branch this run is about to push. */
  branch: string;
  /** The branch the PR will target (default or milestone branch). */
  baseBranch: string;
  /** Git runner — the phase passes `deps.git.runGitCommand`. */
  runGit: GitRunner;
  /** `gh` runner — the phase passes `deps.github.runGhCommand`. */
  runGh: (args: string[]) => Promise<string>;
  /** Working directory of the clone. */
  cwd?: string;
  /** Optional log seam; every fallback is reported rather than swallowed. */
  warn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Pure decision helpers
// ---------------------------------------------------------------------------

/**
 * Decide the lineage from the merged PRs raised off this head ref.
 *
 * Pure, so every rule is testable without a network or a git tree. A branch is
 * stale exactly when some merged PR's merge commit is in the base but not in
 * the branch: the base carries a squash of work this branch never saw. The
 * newest such PR (highest number) is reported, because that is the merge the
 * branch must be rebased past.
 */
export function decideLineage(
  prs: readonly MergedHeadRefPr[],
): LineageVerdict {
  const stale = prs
    .filter((pr) => pr.inBase && !pr.inBranch)
    .sort((a, b) => b.number - a.number)[0];

  if (stale === undefined) {
    return {
      kind: "current",
      detail: prs.length === 0
        ? "no merged PR was raised from this branch"
        : `all ${prs.length} merged PR(s) from this branch are already in its ` +
          `history`,
    };
  }

  return {
    kind: "stale-squashed",
    prNumber: stale.number,
    mergeCommit: stale.mergeCommit,
    detail:
      `merged PR #${stale.number} squashed this branch's work into the base ` +
      `as ${stale.mergeCommit.slice(0, 7)}, and the branch tip does not ` +
      `contain it — its commits would replay content the base already has`,
  };
}

/**
 * Deletions in the healed tree that no replayed commit accounts for.
 *
 * `deletedFromBase` is what the healed branch removes relative to the base;
 * `deletedByReplay` is what the replayed commits genuinely delete. Anything in
 * the first and not the second is the branch reverting work the base added —
 * the failure mode that would have silently un-merged another issue.
 */
export function unexplainedDeletions(
  deletedFromBase: readonly string[],
  deletedByReplay: readonly string[],
): string[] {
  const explained = new Set(deletedByReplay);
  return deletedFromBase.filter((path) => !explained.has(path));
}

/**
 * Parse `gh pr list --json number,mergeCommit` output into merged-PR refs.
 *
 * Entries without a usable merge commit are skipped: a merged PR whose merge
 * commit `gh` did not report tells us nothing about ancestry, and guessing
 * would be worse than ignoring it.
 */
export function parseMergedPrList(
  raw: string,
): Result<{ number: number; mergeCommit: string }[]> {
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? [] : JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `unreadable 'gh pr list' payload: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error("'gh pr list' did not return a list"),
    };
  }

  const refs: { number: number; mergeCommit: string }[] = [];
  for (const entry of parsed) {
    const record = entry as { number?: unknown; mergeCommit?: unknown };
    const number = typeof record.number === "number" ? record.number : NaN;
    const oid = (record.mergeCommit as { oid?: unknown } | null | undefined)
      ?.oid;
    if (!Number.isFinite(number)) continue;
    if (typeof oid !== "string" || !/^[0-9a-f]{7,64}$/.test(oid)) continue;
    refs.push({ number, mergeCommit: oid });
  }
  return { ok: true, value: refs };
}

// ---------------------------------------------------------------------------
// Git readers
// ---------------------------------------------------------------------------

interface GitContext {
  runGit: GitRunner;
  cwd: string | undefined;
}

/** Trimmed stdout of a git command, or null when it did not exit 0. */
async function gitStdout(
  ctx: GitContext,
  args: string[],
): Promise<string | null> {
  const result = await ctx.runGit(args, { cwd: ctx.cwd });
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim();
}

/** Non-empty lines of a git command's stdout (empty when it failed). */
async function gitLines(ctx: GitContext, args: string[]): Promise<string[]> {
  const out = await gitStdout(ctx, args);
  if (out === null || out === "") return [];
  return out.split("\n").map((line) => line.trim()).filter((l) => l !== "");
}

/** Whether `ancestor` is an ancestor of `descendant` (exit 0 = yes). */
async function isAncestor(
  ctx: GitContext,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await ctx.runGit(
    ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant],
    { cwd: ctx.cwd },
  );
  return result.ok && result.value.code === 0;
}

/**
 * Resolve the base to the ref the PR will actually merge into.
 *
 * The clone's *local* base branch can lag origin by exactly the merge we are
 * looking for, so the remote-tracking ref is refreshed and preferred; the
 * shared resolver is the fallback when origin cannot be reached.
 */
async function resolveFreshBaseRef(
  ctx: GitContext,
  baseBranch: string,
): Promise<Result<string>> {
  assertSafeGitRef(baseBranch, "stale-lineage base branch");
  // Best-effort refresh — a failure just means we fall through to whatever
  // this clone already has, which the shared resolver reports honestly.
  await ctx.runGit(buildFetchArgs("origin", baseBranch), { cwd: ctx.cwd });
  const remoteRef = `origin/${baseBranch}`;
  const resolved = await ctx.runGit(
    ["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`],
    { cwd: ctx.cwd },
  );
  if (resolved.ok && resolved.value.code === 0) {
    return { ok: true, value: remoteRef };
  }
  return await resolveComparableBaseRef(ctx.runGit, baseBranch, {
    cwd: ctx.cwd,
  });
}

/**
 * The branch's SHA on the remote, or `null` when the remote has no such ref.
 *
 * A failed lookup is an error, never a `null`: "the remote does not have this
 * branch" and "I could not ask" lead to opposite pushes, and conflating them is
 * how a lease gets skipped.
 */
async function remoteBranchSha(
  ctx: GitContext,
  branch: string,
): Promise<Result<string | null>> {
  const result = await ctx.runGit(
    ["ls-remote", "--heads", "--end-of-options", "origin", branch],
    { cwd: ctx.cwd },
  );
  if (!result.ok || result.value.code !== 0) {
    const detail = result.ok
      ? (result.value.stderr.trim() || `exit ${result.value.code}`)
      : result.error.message;
    return {
      ok: false,
      error: new Error(
        `could not read the remote head of '${branch}': ${detail}`,
      ),
    };
  }
  const out = result.value.stdout.trim();
  if (out === "") return { ok: true, value: null };
  const sha = out.split(/\s+/)[0] ?? "";
  return {
    ok: true,
    value: /^[0-9a-f]{7,64}$/.test(sha) ? sha : null,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Options for {@link classifyBranchLineage}. */
export interface ClassifyBranchLineageOptions {
  repo: string;
  branch: string;
  /** A ref that resolves to the current base tip (e.g. `origin/main`). */
  baseRef: string;
  runGit: GitRunner;
  runGh: (args: string[]) => Promise<string>;
  cwd?: string;
}

/**
 * Classify the branch's lineage against the base it would merge into.
 *
 * One `gh pr list` plus two ancestry tests per merged PR. Any failed read is
 * `unknown` — the caller proceeds, but with the reason logged.
 */
export async function classifyBranchLineage(
  options: ClassifyBranchLineageOptions,
): Promise<LineageVerdict> {
  const { repo, branch, baseRef, runGh } = options;
  const ctx: GitContext = { runGit: options.runGit, cwd: options.cwd };

  try {
    assertSafeGitRef(branch, "stale-lineage branch");
  } catch (err) {
    return {
      kind: "unknown",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let raw: string;
  try {
    raw = await runGh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "merged",
      "--limit",
      "10",
      "--json",
      "number,mergeCommit",
    ]);
  } catch (err) {
    return {
      kind: "unknown",
      detail: `merged-PR lookup for '${branch}' failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const parsed = parseMergedPrList(raw);
  if (!parsed.ok) {
    return { kind: "unknown", detail: parsed.error.message };
  }

  const facts: MergedHeadRefPr[] = [];
  for (const pr of parsed.value) {
    // A merge commit git does not have cannot be reasoned about: the clone is
    // shallow or the fetch did not reach it, so say so rather than guess.
    const known = await gitStdout(ctx, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${pr.mergeCommit}^{commit}`,
    ]);
    if (known === null) {
      return {
        kind: "unknown",
        detail: `merge commit ${
          pr.mergeCommit.slice(0, 7)
        } of PR #${pr.number} is not present in this clone`,
      };
    }
    facts.push({
      ...pr,
      inBase: await isAncestor(ctx, pr.mergeCommit, baseRef),
      inBranch: await isAncestor(ctx, pr.mergeCommit, branch),
    });
  }

  return decideLineage(facts);
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Reset the branch to `baseRef` and replay its commits, dropping any whose
 * content the base already carries.
 *
 * Refuses on a dirty working tree (a `reset --hard` would destroy it) and on a
 * cherry-pick conflict — a conflict here means the content genuinely diverged
 * and picking a side is the very thing that reverts someone else's merge. The
 * branch is restored to its previous tip before any refusal is returned.
 */
export async function rebaseOntoBase(
  options: {
    branch: string;
    baseRef: string;
    runGit: GitRunner;
    cwd?: string;
  },
): Promise<Result<RebaseOntoBaseResult>> {
  const { branch, baseRef } = options;
  const ctx: GitContext = { runGit: options.runGit, cwd: options.cwd };
  assertSafeGitRef(branch, "stale-lineage rebase branch");
  assertSafeGitRef(baseRef, "stale-lineage rebase base");

  const dirty = await gitStdout(ctx, ["status", "--porcelain"]);
  if (dirty === null) {
    return { ok: false, error: new Error("git status could not be read") };
  }
  if (dirty !== "") {
    return {
      ok: false,
      error: new Error(
        `the working tree carries uncommitted changes, so the branch cannot ` +
          `be rebased without destroying them: ${
            dirty.split("\n").length
          } path(s) modified`,
      ),
    };
  }

  // `--verify` is not optional here: a bare `git rev-parse --end-of-options
  // <ref>` echoes the separator back as its first output line, and the SHA
  // that comes back with it is not a ref anything can be reset to.
  const previousHead = await gitStdout(ctx, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${branch}^{commit}`,
  ]);
  if (previousHead === null) {
    return {
      ok: false,
      error: new Error(`branch '${branch}' does not resolve to a commit`),
    };
  }

  // Oldest first, so the replay preserves the branch's own order. Merges are
  // skipped for the same reason `git rebase` skips them: their content is
  // carried by the commits either side.
  const commits = await gitLines(ctx, [
    "rev-list",
    "--reverse",
    "--no-merges",
    "--end-of-options",
    `${baseRef}..${branch}`,
  ]);

  const checkout = await ctx.runGit(["checkout", "--end-of-options", branch], {
    cwd: ctx.cwd,
  });
  if (!checkout.ok || checkout.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`could not check out '${branch}' to rebase it`),
    };
  }

  const restore = async (): Promise<void> => {
    await ctx.runGit(["cherry-pick", "--abort"], { cwd: ctx.cwd });
    await ctx.runGit(["reset", "--hard", "--end-of-options", previousHead], {
      cwd: ctx.cwd,
    });
  };

  const reset = await ctx.runGit(
    ["reset", "--hard", "--end-of-options", baseRef],
    { cwd: ctx.cwd },
  );
  if (!reset.ok || reset.value.code !== 0) {
    await restore();
    return {
      ok: false,
      error: new Error(`could not reset '${branch}' onto '${baseRef}'`),
    };
  }

  const replayed: string[] = [];
  const dropped: string[] = [];
  for (const sha of commits) {
    const pick = await ctx.runGit(
      ["cherry-pick", "-n", "--end-of-options", sha],
      { cwd: ctx.cwd },
    );
    if (!pick.ok || pick.value.code !== 0) {
      const detail = pick.ok
        ? (pick.value.stderr.trim() || pick.value.stdout.trim())
        : pick.error.message;
      await restore();
      return {
        ok: false,
        error: new Error(
          `replaying ${sha.slice(0, 7)} onto '${baseRef}' conflicted, so the ` +
            `branch was restored unchanged: ${
              detail.split("\n").slice(-3).join(" | ")
            }`,
        ),
      };
    }

    // An empty staged diff means the base already carries this commit's
    // content — exactly what a squash merge produces. Drop it.
    const staged = await ctx.runGit(["diff", "--cached", "--quiet"], {
      cwd: ctx.cwd,
    });
    const unchanged = staged.ok && staged.value.code === 0;
    if (unchanged) {
      dropped.push(sha);
      await ctx.runGit(["reset", "--hard", "HEAD"], { cwd: ctx.cwd });
      continue;
    }

    // `-C` reuses the original author, date and message, so the replayed
    // commit keeps its run-id trailer and the pre-commit gates still apply.
    const commit = await ctx.runGit(
      ["commit", "-C", sha],
      { cwd: ctx.cwd },
    );
    if (!commit.ok || commit.value.code !== 0) {
      await restore();
      return {
        ok: false,
        error: new Error(
          `could not re-commit ${sha.slice(0, 7)} onto '${baseRef}'`,
        ),
      };
    }
    replayed.push(sha);
  }

  // Post-condition: the healed branch must not delete anything the base has
  // unless a replayed commit genuinely deletes it.
  const deletedFromBase = await gitLines(ctx, [
    "diff",
    "--diff-filter=D",
    "--name-only",
    "--end-of-options",
    baseRef,
    "HEAD",
  ]);
  const deletedByReplay: string[] = [];
  for (const sha of replayed) {
    deletedByReplay.push(
      ...await gitLines(ctx, [
        "show",
        "--format=",
        "--name-only",
        "--diff-filter=D",
        "--end-of-options",
        sha,
      ]),
    );
  }
  const unexplained = unexplainedDeletions(deletedFromBase, deletedByReplay);
  if (unexplained.length > 0) {
    await restore();
    return {
      ok: false,
      error: new Error(
        `the rebased branch would delete ${unexplained.length} file(s) that ` +
          `'${baseRef}' has and no replayed commit removes — refusing and ` +
          `restoring the branch: ${unexplained.slice(0, 5).join(", ")}`,
      ),
    };
  }

  const newHead = await gitStdout(ctx, ["rev-parse", "HEAD"]);
  if (newHead === null) {
    await restore();
    return {
      ok: false,
      error: new Error("could not read the rebased branch head"),
    };
  }

  return { ok: true, value: { previousHead, newHead, replayed, dropped } };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Detect a stale, already-squashed branch and rebase it onto the current base.
 *
 * The single call the completion phase makes before it pushes. Returns
 * `not-stale`/`unknown` when the caller should carry on unchanged, `healed`
 * when the branch was rebased (and pushed, unless nothing was left to push),
 * and `refused` when the branch is stale but could not be healed safely — a
 * loud stop, because pushing it would open the unmergeable PR this guard
 * exists to prevent.
 */
export async function healStaleBranchLineage(
  options: HealStaleBranchLineageOptions,
): Promise<StaleLineageOutcome> {
  const { repo, branch, baseBranch, runGit, runGh, cwd } = options;
  const warn = options.warn ?? (() => {});
  const ctx: GitContext = { runGit, cwd };

  const baseRef = await resolveFreshBaseRef(ctx, baseBranch);
  if (!baseRef.ok) {
    return {
      kind: "unknown",
      detail:
        `the stale-lineage guard could not resolve the base: ${baseRef.error.message}`,
    };
  }

  // Cheap local pre-filter, before any `gh` call: a branch that already
  // contains the base tip cannot be replaying content the base squashed, so
  // the common case costs one `merge-base` and no API quota. Shallow
  // truncation can only make this answer "no", never a false "yes".
  if (await isAncestor(ctx, baseRef.value, branch)) {
    return {
      kind: "not-stale",
      detail: `the branch already contains '${baseRef.value}'`,
    };
  }

  // Ancestry on a `--depth=1` clone is unanswerable, and an unanswerable
  // ancestry test reads as "not stale" — the silent miss this guard exists to
  // close. Deepen first (a no-op on a full clone).
  const depth = await ensureHistoryDepth([baseRef.value, branch], {
    cwd,
    gitRunner: runGit,
  });
  if (!depth.ok) {
    warn(
      `Stale-lineage guard could not deepen the shallow clone for ` +
        `'${branch}' — proceeding without it (Issue #534): ${depth.error.message}`,
    );
    return { kind: "unknown", detail: depth.error.message };
  }

  const verdict = await classifyBranchLineage({
    repo,
    branch,
    baseRef: baseRef.value,
    runGit,
    runGh,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  if (verdict.kind === "unknown") {
    warn(
      `Stale-lineage guard could not classify '${branch}' — proceeding ` +
        `without it (Issue #534): ${verdict.detail}`,
    );
    return { kind: "unknown", detail: verdict.detail };
  }
  if (verdict.kind === "current") {
    return { kind: "not-stale", detail: verdict.detail };
  }

  // Capture the remote head BEFORE the rebase, so the force-with-lease below
  // is pinned to what we actually saw rather than to a ref we just refreshed.
  const baseline = await remoteBranchSha(ctx, branch);
  if (!baseline.ok) {
    return {
      kind: "refused",
      detail: `${verdict.detail}; ${baseline.error.message}, so the branch ` +
        `cannot be republished safely`,
    };
  }

  const rebase = await rebaseOntoBase({
    branch,
    baseRef: baseRef.value,
    runGit,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  if (!rebase.ok) {
    return {
      kind: "refused",
      detail: `${verdict.detail}; rebasing it onto '${baseRef.value}' was ` +
        `refused: ${rebase.error.message}`,
    };
  }

  const { previousHead, newHead, replayed, dropped } = rebase.value;
  const summary = `${verdict.detail}; rebased onto '${baseRef.value}' — ` +
    `${replayed.length} commit(s) replayed, ${dropped.length} already in base`;

  // Nothing left to publish: the branch is now level with base, and the
  // caller's ahead-of-base guard turns that into a clean superseded stop. A
  // push here would re-create a reaped branch for no reason.
  if (replayed.length === 0) {
    return {
      kind: "healed",
      detail: `${summary}; nothing left to push`,
      replayed,
      dropped,
      previousHead,
      newHead,
      pushed: false,
    };
  }

  // The reaped-branch case: the merge deleted the branch, so there is nothing
  // to force past. Drop the now-lying remote-tracking ref (it still names the
  // pre-merge tip, and a bare `--force-with-lease` would lease against *that*,
  // failing on "stale info") and push plainly — a concurrent re-creation then
  // rejects this push as non-fast-forward, which is the outcome we want.
  const push = baseline.value === null
    ? await (async () => {
      await runGit(["update-ref", "-d", `refs/remotes/origin/${branch}`], {
        cwd,
      });
      return await runGit(
        buildPushArgs("origin", branch, { setUpstream: true }),
        { cwd },
      );
    })()
    : await runGit(buildForceWithLeaseArgs(branch, baseline.value), { cwd });
  if (!push.ok || push.value.code !== 0) {
    const detail = push.ok
      ? (push.value.stderr.trim() || push.value.stdout.trim())
      : push.error.message;
    return {
      kind: "refused",
      detail: `${summary}; but publishing it was refused — the remote head ` +
        `moved, so another writer holds this branch: ${
          detail.split("\n").slice(-3).join(" | ")
        }`,
    };
  }

  return {
    kind: "healed",
    detail: summary,
    replayed,
    dropped,
    previousHead,
    newHead,
    pushed: true,
  };
}
