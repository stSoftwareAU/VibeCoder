/**
 * Landing a milestone-branch sync through a pull request (Issue #589).
 *
 * `syncMilestoneBranchWithDefault` merges the default branch into each
 * milestone branch and pushes the result. That worked while milestone
 * branches were unprotected. Once `milestone/**` is gated by a
 * required-status-checks ruleset — which is what makes a milestone PR
 * auto-mergeable at all (Issue #586) — the push is rejected, measured as the
 * service account itself:
 *
 *     remote: - 2 of 2 required status checks are expected.
 *     ! [remote rejected] milestone/… (push declined due to repository rule violations)
 *
 * `required_status_checks` blocks a direct push even with no `pull_request`
 * rule, because the pushed merge commit has no checks yet: checks run *after*
 * a push. And the operator's policy is that the service account must NOT
 * bypass the gate — an admin may, the fleet may not. So the ruleset is right
 * and the sync is what has to change.
 *
 * The sync therefore lands the same merge through the same door as everything
 * else: a branch the ruleset does not cover, a PR into the milestone branch,
 * and auto-merge. The gate that broke the push is precisely what lets the PR
 * land unattended — GitHub arms auto-merge only when something blocks the
 * merge.
 *
 * Nothing here fires unless a push is actually rejected. A repository with
 * unprotected milestone branches keeps the direct push it has always had.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */ import { PRIMARY_QUOTA_SKIP_PREFIX } from "./primary_quota_latch.ts";
import { clearMilestoneReviewRequests } from "./milestone_pr_reviewers.ts";
import { isMilestoneSyncBranch, syncBranchFor } from "./milestone_sync_branch.ts";
import { logAt } from "./log_sink.ts";
export { isMilestoneSyncBranch, SYNC_BRANCH_PREFIX, syncBranchFor } from "./milestone_sync_branch.ts";
/**
 * Whether a push failed because a repository rule refused it.
 *
 * Distinguished from every other push failure — a race, a network fault, a
 * missing remote — because only this one is answered by raising a PR. Anything
 * else must keep failing as it always did.
 */ export function isRuleViolationPush(stderr) {
  const text = stderr.toLowerCase();
  return text.includes("repository rule violations") || // GH013 is *the* ruleset-violation code, and git does not always print
  // the prose alongside it (Issue #1772).
  text.includes("gh013") || text.includes("push declined") || text.includes("protected branch") || text.includes("required status checks are expected");
}
/**
 * Whether a `--force-with-lease` push was refused as `stale info`: another
 * actor updated the branch after this host fetched it. That is a race to
 * refetch and retry, never a repository rule (Issue #2613).
 */ export function isStaleInfoPush(stderr) {
  return /\bstale info\b/i.test(stderr);
}
/**
 * The `gh pr merge` method for a PR from this head branch (Issue #1048).
 *
 * Everything else squashes, and should: one commit per change keeps the
 * default branch readable. A **milestone sync is the exception**, because its
 * whole purpose is ancestry. Squashed, the sync commit carries the default
 * branch's content with a single parent, so the default branch is not an
 * ancestor of the milestone branch: every later merge computes its base from
 * before the sync, and a file the default branch deleted in the meantime comes
 * back as a modify/delete conflict rather than as a deletion. That is exactly
 * how `milestone/863` revived a deleted subsystem.
 *
 * A merge commit records the default branch as a parent, so its deletions are
 * genuinely in the branch's history and never have to be re-derived.
 */ export function mergeMethodFlagForHead(headRefName, headIsSameRepository = false) {
  // A head branch *name* is chosen by whoever pushed the branch, and a fork
  // PR's head lives in a repository the fleet does not control — so on a fork
  // the name is a claim, not evidence (Issue #1249, finding 10). Only a
  // same-repository head, which needed write access to create, can select the
  // merge-commit deviation; everything else squashes, which is the default
  // this repository's policy expects.
  //
  // The default is the **restrictive** one: a caller that has not established
  // where the head lives has not established that the deviation is safe. Every
  // caller that downgrades a sync-shaped head this way must say so out loud —
  // {@link forkSyncDowngradeWarning} is that sentence — because a silently
  // squashed sync is the exact defect Issue #1048 exists to prevent.
  return isMilestoneSyncBranch(headRefName) && headIsSameRepository ? "--merge" : "--squash";
}
/**
 * The warning a sync-shaped head earns when it is squashed because the head
 * could not be shown to live in this repository (Issue #1249, finding 10).
 *
 * The sibling of {@link squashedSyncWarning}, which covers the other reason a
 * sync squashes (the repository forbids merge commits). Both exist so the
 * downgrade is never quiet.
 *
 * @param repo - Repository in `owner/repo` form
 * @param prNumber - The PR being merged
 * @param headRefName - The sync-shaped head branch
 * @returns A single-line warning naming the PR and why it squashed
 */ export function forkSyncDowngradeWarning(repo, prNumber, headRefName) {
  return `${repo}#${prNumber} has a milestone-sync-shaped head ` + `'${headRefName}' whose repository could not be confirmed as ${repo}, so ` + `it is armed as a SQUASH rather than a merge commit. A fork may name its ` + `branch anything, so the name alone cannot select the merge-commit ` + `deviation (Issue #1249). If this is a genuine sync, check the PR's ` + `isCrossRepository field.`;
}
/**
 * Whether GitHub refused a merge because the repository does not permit merge
 * commits (`allow_merge_commit: false`, or a ruleset whose
 * `allowed_merge_methods` omits `merge`).
 *
 * This is the one refusal the sync answers by changing method rather than by
 * retrying: no number of retries turns a repository setting on.
 */ export function isMergeCommitNotAllowed(message) {
  const text = message.toLowerCase();
  return text.includes("merge commits are not allowed") || text.includes("merge commit is not allowed") || text.includes("merge method") && text.includes("not allowed") || text.includes("not allowed for this repository");
}
/**
 * The warning a squashed sync earns, naming the repository setting to change.
 *
 * A squashed sync is a real fault — it leaves the default branch outside the
 * milestone branch's ancestry — so it is never silent. It is not fatal either:
 * the `check-resurrected-files` gate on every milestone PR catches the
 * consequence, and a sync that refused to land would leave the branch drifting
 * instead.
 */ export function squashedSyncWarning(repo, milestoneBranch, detail) {
  return `the sync PR for '${milestoneBranch}' in ${repo} had to be ` + `armed as a SQUASH — ${repo} does not permit merge commits (${detail}). ` + `The default branch will not be an ancestor of '${milestoneBranch}', so ` + `its deletions can return as modify/delete conflicts. Enable merge ` + `commits on ${repo} (Settings → Pull Requests → Allow merge commits; ` + `setup does this, keeping the default branch squash-only — Issue #2690) to ` + `close this off; until then the check-resurrected-files gate is what ` + `catches the consequence (Issue #1048).`;
}
const FULL_SHA = /^[0-9a-f]{40}$/;
/**
 * Whether `refs/remotes/origin/<branch>` already carries the merge at HEAD
 * (Issue #3690).
 *
 * "carries" means the same tree and the same tips: HEAD is an ancestor of the
 * remote head, or every parent of HEAD is (a sibling host merged the same
 * milestone tip and default tip into a new commit with identical content).
 * "differs" means there is nothing to compare against or the content or tips
 * moved, so the push is as it always was. "unknown" means a read failed; the
 * caller fails towards syncing and pushes.
 */ export async function syncBranchAlreadyCarries(branch, git) {
  const remote = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${branch}`
  ]);
  // Absent on the remote: the ordinary first-run case, nothing to compare.
  if (remote.code !== 0) return "differs";
  const remoteHead = (remote.stdout ?? "").trim();
  if (!FULL_SHA.test(remoteHead)) return "unknown";
  const readSingle = async (args)=>{
    const result = await git(args);
    const out = (result.stdout ?? "").trim();
    return result.code === 0 && out ? out : null;
  };
  const headTree = await readSingle([
    "rev-parse",
    "HEAD^{tree}"
  ]);
  const remoteTree = await readSingle([
    "rev-parse",
    `${remoteHead}^{tree}`
  ]);
  if (!headTree || !remoteTree) return "unknown";
  if (headTree !== remoteTree) return "differs";
  const isAncestor = async (commit)=>{
    const result = await git([
      "merge-base",
      "--is-ancestor",
      commit,
      remoteHead
    ]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    return null;
  };
  const headAncestor = await isAncestor("HEAD");
  if (headAncestor === null) return "unknown";
  if (headAncestor) return "carries";
  const line = await readSingle([
    "rev-list",
    "--parents",
    "-n",
    "1",
    "HEAD"
  ]);
  if (!line) return "unknown";
  const parents = line.split(/\s+/).slice(1);
  if (parents.length === 0) return "unknown";
  for (const parent of parents){
    const ancestor = await isAncestor(parent);
    if (ancestor === null) return "unknown";
    if (!ancestor) return "differs";
  }
  return "carries";
}
/**
 * Arm auto-merge on a freshly-raised sync PR, as a merge commit (Issue #1048).
 *
 * A repository that forbids merge commits gets the squash it can take, with a
 * loud warning naming the setting — never a quiet downgrade. Any other failure
 * is reported on the PR once (Issue #2457), naming the reason and stating the
 * Auto-Merge sweep retries — the same contract as ordinary creation arming.
 * A latched quota refusal is named as such and never retried in-run.
 */ async function armSyncPrAutoMerge(repo, prNumber, branch, deps) {
  const arm = (method)=>deps.gh([
      "pr",
      "merge",
      prNumber,
      "--repo",
      repo,
      "--auto",
      method
    ]);
  const report = async (message)=>{
    logAt(deps.log, "warn", `the sync PR ${repo}#${prNumber} was not armed for auto-merge: ` + message.trim());
    const retryLine = message.includes(PRIMARY_QUOTA_SKIP_PREFIX) ? "The primary GitHub quota is exhausted, so no further auto-merge " + "attempt was made in this run; the Auto-Merge sweep retries once the " + "quota resets." : "The Auto-Merge sweep retries.";
    try {
      await deps.gh([
        "pr",
        "comment",
        prNumber,
        "--repo",
        repo,
        "--body",
        `Auto-merge was not armed on this sync PR: ${message.trim()}\n\n` + retryLine
      ]);
    } catch (commentError) {
      // Fail loud: the refusal must never become silent because the comment
      // could not be posted. The warning above named the reason; this names
      // the lost comment too.
      logAt(deps.log, "warn", `could not post the auto-merge reason comment on ${repo}#${prNumber}: ${commentError instanceof Error ? commentError.message : String(commentError)}`);
    }
  };
  try {
    // The worker pushed this branch into `repo` itself moments ago, so the
    // head is same-repository by construction (Issue #1249).
    await arm(mergeMethodFlagForHead(branch, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isMergeCommitNotAllowed(message)) {
      await report(message);
      return;
    }
    try {
      await arm("--squash");
      deps.log?.(squashedSyncWarning(repo, branch, message.trim()));
    } catch (squashError) {
      const squashMessage = squashError instanceof Error ? squashError.message : String(squashError);
      await report(squashMessage);
    }
  }
}
/**
 * Push the already-merged tree to a sync branch and raise a PR for it.
 *
 * The caller has merged the default branch into the milestone branch in its
 * clone and had the push refused; HEAD therefore already carries the merge
 * this PR is for.
 *
 * The push is skipped when the remote sync branch already holds this merge
 * (same tree, same milestone and default tips): a re-push would be a fresh
 * commit with identical content that restarts the open sync PR's required
 * checks for no change (Issue #3690). The comparison is only trusted after
 * the baseline fetch of the sync branch succeeded, because a failed fetch can
 * leave a stale remote-tracking ref for a branch deleted on the remote.
 * Otherwise the sync branch is force-pushed
 * with a lease.
 *
 * @param repo - `owner/repo`.
 * @param milestoneBranch - The branch the PR targets.
 * @param defaultBranch - Named in the PR body, so a reader knows what merged.
 */ export async function raiseMilestoneSyncPr(repo, milestoneBranch, defaultBranch, deps) {
  const branch = syncBranchFor(milestoneBranch);
  // Issue #1568: `--force-with-lease` with no explicit value verifies against
  // `refs/remotes/origin/<branch>`. A clone that has never fetched that ref
  // cannot offer git a baseline, so git refuses with `(stale info)` — not
  // because anything conflicts, but because it has nothing to compare. A
  // single-branch clone reaches that state for any sync branch another host
  // created: the narrow refspec never materialises it, and no later cycle
  // materialises it either, so the sync is wedged for good. NEAT-AI-Ockham's
  // milestone sync had been failing this way every cycle.
  //
  // Fetching the branch supplies the baseline. It is deliberately *not* a
  // fetch of everything, and deliberately best-effort: `git fetch origin
  // <branch>` fails when the branch does not exist on the remote yet, which
  // is the ordinary first-run case — a create needs no baseline, and the push
  // below handles it.
  //
  // This does not weaken the lease. The baseline is taken from whatever the
  // remote holds at this moment; if another host moves the branch after that,
  // the push is still refused, which is the case the lease exists for.
  const fetchBaseline = ()=>deps.git([
      "fetch",
      "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`
    ]);
  const pushBranch = ()=>deps.git([
      "push",
      "--force-with-lease",
      "origin",
      `HEAD:refs/heads/${branch}`
    ]);
  const baseline = await fetchBaseline();
  // Issue #3690: the remote sync branch is the fleet-wide record of what was
  // synced. If it already holds this merge, re-pushing only restarts checks.
  // Only trusted after a successful fetch: a failed fetch (branch deleted on
  // the remote, or first run) can leave a stale remote-tracking ref behind.
  const carried = baseline.code === 0 ? await syncBranchAlreadyCarries(branch, deps.git) : "differs";
  if (carried === "carries") {
    deps.log?.(`Milestone sync branch '${branch}' already holds this merge (same tree, ` + `same tips); nothing was pushed, so the open sync PR's checks keep ` + `running (Issue #3690)`);
  } else if (carried === "unknown") {
    deps.log?.(`Milestone sync branch '${branch}': the comparison with the remote ` + `branch could not be read; pushing as before (Issue #3690)`);
  }
  const skipPush = carried === "carries";
  // Force-with-lease: the sync branch is this function's alone, and a stale
  // one from an earlier cycle carries a merge that is no longer current.
  // `--force-with-lease` still refuses if somebody else moved it.
  const pushWithStaleRetry = async ()=>{
    let push = await pushBranch();
    const pushWasStale = ()=>push.code !== 0 && isStaleInfoPush(`${push.stderr}\n${push.stdout ?? ""}`);
    // `stale info` means another actor moved the branch after the fetch
    // above. Refetch the new baseline and retry once (Issue #2613).
    let staleRetried = false;
    if (pushWasStale()) {
      staleRetried = true;
      await fetchBaseline();
      push = await pushBranch();
    }
    if (push.code !== 0) {
      const detail = push.stderr.trim() || push.stdout?.trim() || `git exited ${push.code} and printed nothing`;
      const stale = staleRetried && pushWasStale();
      return new Error(stale ? `Could not push the milestone sync branch '${branch}': the push ` + `was rejected with stale info — another actor updated the branch ` + `— and was still rejected after it was refetched and retried: ${detail}` : `Could not push the milestone sync branch '${branch}': ${detail}`);
    }
    if (staleRetried) {
      deps.log?.(`Milestone sync branch '${branch}': the push was rejected with stale ` + `info (another actor moved the branch); refetched and retried — accepted.`);
    }
    return null;
  };
  const pushError = skipPush ? null : await pushWithStaleRetry();
  if (pushError !== null) return {
    ok: false,
    error: pushError
  };
  // One open PR per milestone branch: a sync that is still open is updated by
  // the push above, and re-filing would leave two PRs merging the same thing.
  try {
    const listed = await deps.gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--head",
      branch,
      "--base",
      milestoneBranch,
      "--json",
      "number"
    ]);
    const open = JSON.parse(listed || "[]");
    if (Array.isArray(open) && open.length > 0) {
      deps.log?.(`milestone sync: ${skipPush ? "left" : "updated"} the open sync PR #${open[0].number} for ` + `'${milestoneBranch}' (Issue #589)`);
      return {
        ok: true,
        value: {
          branch,
          opened: false,
          pushed: !skipPush
        }
      };
    }
  } catch  {
  // An unreadable listing falls through to creating one: a duplicate PR is
  // recoverable, a sync that never lands is not.
  }
  try {
    const body = [
      `Merges \`${defaultBranch}\` into \`${milestoneBranch}\`.`,
      "",
      "Raised as a pull request rather than pushed directly because " + `\`${milestoneBranch}\` is gated by a required-status-checks ruleset ` + "(Issue #586). That gate is what makes this PR auto-mergeable — GitHub " + "arms auto-merge only when something blocks the merge — so this lands " + "unattended once its checks are green.",
      "",
      `Lands as a **merge commit**, never a squash: the point of the sync is ` + `to put \`${defaultBranch}\` in this branch's *ancestry*, so its ` + `deletions are history here rather than conflicts later (Issue #1048).`,
      "",
      "Filed by the milestone branch sync (Issue #589)."
    ].join("\n");
    const created = await deps.gh([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      milestoneBranch,
      "--head",
      branch,
      "--title",
      `Sync ${defaultBranch} into ${milestoneBranch}`,
      "--body",
      body
    ]);
    // Best-effort: a PR that cannot be armed still lands through the fleet's
    // own auto-merge pass, so a failure here is not the sync's failure.
    const number = created.trim().split("/").pop() ?? "";
    if (number) {
      await armSyncPrAutoMerge(repo, number, branch, deps);
      // Issue #2438: the sync PR asks for no reviewer of its own, but
      // CODEOWNERS auto-requests one the moment it opens and nothing acts on
      // it — the review that matters sits on the milestone → default-branch
      // PR. Remove it once, here.
      await clearMilestoneReviewRequests({
        repo,
        prNumber: Number(number),
        base: milestoneBranch
      }, {
        ghCommandFn: deps.gh,
        ...deps.log ? {
          log: deps.log,
          warn: deps.log
        } : {}
      });
    }
    deps.log?.(`milestone sync: raised PR ${created.trim()} to merge ` + `'${defaultBranch}' into '${milestoneBranch}' — the branch is gated, ` + `so the push had to become a PR (Issue #589)`);
    return {
      ok: true,
      value: {
        branch,
        opened: true,
        pushed: !skipPush
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
/**
 * The sentence fragment describing how a sync landed, chosen from the four
 * `pushed` x `opened` outcomes of {@link raiseMilestoneSyncPr} (Issues #589,
 * #3690). Ends with " — " so the caller can append its own detail.
 */ export function syncPrLandingNote(outcome) {
  if (!outcome.pushed && !outcome.opened) {
    return `ALREADY IN the open sync PR from '${outcome.branch}' — its ` + `head holds this merge, so nothing was pushed and its checks were ` + `not restarted (Issue #3690) — `;
  }
  if (!outcome.pushed) {
    return `RAISED a sync PR from the existing '${outcome.branch}' head, ` + `which already held this merge — nothing was pushed (Issue #3690) — `;
  }
  if (outcome.opened) {
    return `RAISED a sync PR from '${outcome.branch}' — the branch is ` + `gated, so the push became a pull request (Issue #589) — `;
  }
  return `UPDATED the open sync PR from '${outcome.branch}' (Issue #589) — `;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfc3luY19wci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIExhbmRpbmcgYSBtaWxlc3RvbmUtYnJhbmNoIHN5bmMgdGhyb3VnaCBhIHB1bGwgcmVxdWVzdCAoSXNzdWUgIzU4OSkuXG4gKlxuICogYHN5bmNNaWxlc3RvbmVCcmFuY2hXaXRoRGVmYXVsdGAgbWVyZ2VzIHRoZSBkZWZhdWx0IGJyYW5jaCBpbnRvIGVhY2hcbiAqIG1pbGVzdG9uZSBicmFuY2ggYW5kIHB1c2hlcyB0aGUgcmVzdWx0LiBUaGF0IHdvcmtlZCB3aGlsZSBtaWxlc3RvbmVcbiAqIGJyYW5jaGVzIHdlcmUgdW5wcm90ZWN0ZWQuIE9uY2UgYG1pbGVzdG9uZS8qKmAgaXMgZ2F0ZWQgYnkgYVxuICogcmVxdWlyZWQtc3RhdHVzLWNoZWNrcyBydWxlc2V0IOKAlCB3aGljaCBpcyB3aGF0IG1ha2VzIGEgbWlsZXN0b25lIFBSXG4gKiBhdXRvLW1lcmdlYWJsZSBhdCBhbGwgKElzc3VlICM1ODYpIOKAlCB0aGUgcHVzaCBpcyByZWplY3RlZCwgbWVhc3VyZWQgYXMgdGhlXG4gKiBzZXJ2aWNlIGFjY291bnQgaXRzZWxmOlxuICpcbiAqICAgICByZW1vdGU6IC0gMiBvZiAyIHJlcXVpcmVkIHN0YXR1cyBjaGVja3MgYXJlIGV4cGVjdGVkLlxuICogICAgICEgW3JlbW90ZSByZWplY3RlZF0gbWlsZXN0b25lL+KApiAocHVzaCBkZWNsaW5lZCBkdWUgdG8gcmVwb3NpdG9yeSBydWxlIHZpb2xhdGlvbnMpXG4gKlxuICogYHJlcXVpcmVkX3N0YXR1c19jaGVja3NgIGJsb2NrcyBhIGRpcmVjdCBwdXNoIGV2ZW4gd2l0aCBubyBgcHVsbF9yZXF1ZXN0YFxuICogcnVsZSwgYmVjYXVzZSB0aGUgcHVzaGVkIG1lcmdlIGNvbW1pdCBoYXMgbm8gY2hlY2tzIHlldDogY2hlY2tzIHJ1biAqYWZ0ZXIqXG4gKiBhIHB1c2guIEFuZCB0aGUgb3BlcmF0b3IncyBwb2xpY3kgaXMgdGhhdCB0aGUgc2VydmljZSBhY2NvdW50IG11c3QgTk9UXG4gKiBieXBhc3MgdGhlIGdhdGUg4oCUIGFuIGFkbWluIG1heSwgdGhlIGZsZWV0IG1heSBub3QuIFNvIHRoZSBydWxlc2V0IGlzIHJpZ2h0XG4gKiBhbmQgdGhlIHN5bmMgaXMgd2hhdCBoYXMgdG8gY2hhbmdlLlxuICpcbiAqIFRoZSBzeW5jIHRoZXJlZm9yZSBsYW5kcyB0aGUgc2FtZSBtZXJnZSB0aHJvdWdoIHRoZSBzYW1lIGRvb3IgYXMgZXZlcnl0aGluZ1xuICogZWxzZTogYSBicmFuY2ggdGhlIHJ1bGVzZXQgZG9lcyBub3QgY292ZXIsIGEgUFIgaW50byB0aGUgbWlsZXN0b25lIGJyYW5jaCxcbiAqIGFuZCBhdXRvLW1lcmdlLiBUaGUgZ2F0ZSB0aGF0IGJyb2tlIHRoZSBwdXNoIGlzIHByZWNpc2VseSB3aGF0IGxldHMgdGhlIFBSXG4gKiBsYW5kIHVuYXR0ZW5kZWQg4oCUIEdpdEh1YiBhcm1zIGF1dG8tbWVyZ2Ugb25seSB3aGVuIHNvbWV0aGluZyBibG9ja3MgdGhlXG4gKiBtZXJnZS5cbiAqXG4gKiBOb3RoaW5nIGhlcmUgZmlyZXMgdW5sZXNzIGEgcHVzaCBpcyBhY3R1YWxseSByZWplY3RlZC4gQSByZXBvc2l0b3J5IHdpdGhcbiAqIHVucHJvdGVjdGVkIG1pbGVzdG9uZSBicmFuY2hlcyBrZWVwcyB0aGUgZGlyZWN0IHB1c2ggaXQgaGFzIGFsd2F5cyBoYWQuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgUFJJTUFSWV9RVU9UQV9TS0lQX1BSRUZJWCB9IGZyb20gXCIuL3ByaW1hcnlfcXVvdGFfbGF0Y2gudHNcIjtcbmltcG9ydCB7IGNsZWFyTWlsZXN0b25lUmV2aWV3UmVxdWVzdHMgfSBmcm9tIFwiLi9taWxlc3RvbmVfcHJfcmV2aWV3ZXJzLnRzXCI7XG5pbXBvcnQge1xuICBpc01pbGVzdG9uZVN5bmNCcmFuY2gsXG4gIHN5bmNCcmFuY2hGb3IsXG59IGZyb20gXCIuL21pbGVzdG9uZV9zeW5jX2JyYW5jaC50c1wiO1xuaW1wb3J0IHsgbG9nQXQgfSBmcm9tIFwiLi9sb2dfc2luay50c1wiO1xuXG5leHBvcnQge1xuICBpc01pbGVzdG9uZVN5bmNCcmFuY2gsXG4gIFNZTkNfQlJBTkNIX1BSRUZJWCxcbiAgc3luY0JyYW5jaEZvcixcbn0gZnJvbSBcIi4vbWlsZXN0b25lX3N5bmNfYnJhbmNoLnRzXCI7XG5cbi8qKlxuICogV2hldGhlciBhIHB1c2ggZmFpbGVkIGJlY2F1c2UgYSByZXBvc2l0b3J5IHJ1bGUgcmVmdXNlZCBpdC5cbiAqXG4gKiBEaXN0aW5ndWlzaGVkIGZyb20gZXZlcnkgb3RoZXIgcHVzaCBmYWlsdXJlIOKAlCBhIHJhY2UsIGEgbmV0d29yayBmYXVsdCwgYVxuICogbWlzc2luZyByZW1vdGUg4oCUIGJlY2F1c2Ugb25seSB0aGlzIG9uZSBpcyBhbnN3ZXJlZCBieSByYWlzaW5nIGEgUFIuIEFueXRoaW5nXG4gKiBlbHNlIG11c3Qga2VlcCBmYWlsaW5nIGFzIGl0IGFsd2F5cyBkaWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1J1bGVWaW9sYXRpb25QdXNoKHN0ZGVycjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHRleHQgPSBzdGRlcnIudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIHRleHQuaW5jbHVkZXMoXCJyZXBvc2l0b3J5IHJ1bGUgdmlvbGF0aW9uc1wiKSB8fFxuICAgIC8vIEdIMDEzIGlzICp0aGUqIHJ1bGVzZXQtdmlvbGF0aW9uIGNvZGUsIGFuZCBnaXQgZG9lcyBub3QgYWx3YXlzIHByaW50XG4gICAgLy8gdGhlIHByb3NlIGFsb25nc2lkZSBpdCAoSXNzdWUgIzE3NzIpLlxuICAgIHRleHQuaW5jbHVkZXMoXCJnaDAxM1wiKSB8fFxuICAgIHRleHQuaW5jbHVkZXMoXCJwdXNoIGRlY2xpbmVkXCIpIHx8XG4gICAgdGV4dC5pbmNsdWRlcyhcInByb3RlY3RlZCBicmFuY2hcIikgfHxcbiAgICB0ZXh0LmluY2x1ZGVzKFwicmVxdWlyZWQgc3RhdHVzIGNoZWNrcyBhcmUgZXhwZWN0ZWRcIik7XG59XG5cbi8qKlxuICogV2hldGhlciBhIGAtLWZvcmNlLXdpdGgtbGVhc2VgIHB1c2ggd2FzIHJlZnVzZWQgYXMgYHN0YWxlIGluZm9gOiBhbm90aGVyXG4gKiBhY3RvciB1cGRhdGVkIHRoZSBicmFuY2ggYWZ0ZXIgdGhpcyBob3N0IGZldGNoZWQgaXQuIFRoYXQgaXMgYSByYWNlIHRvXG4gKiByZWZldGNoIGFuZCByZXRyeSwgbmV2ZXIgYSByZXBvc2l0b3J5IHJ1bGUgKElzc3VlICMyNjEzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU3RhbGVJbmZvUHVzaChzdGRlcnI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gL1xcYnN0YWxlIGluZm9cXGIvaS50ZXN0KHN0ZGVycik7XG59XG5cbi8qKlxuICogVGhlIGBnaCBwciBtZXJnZWAgbWV0aG9kIGZvciBhIFBSIGZyb20gdGhpcyBoZWFkIGJyYW5jaCAoSXNzdWUgIzEwNDgpLlxuICpcbiAqIEV2ZXJ5dGhpbmcgZWxzZSBzcXVhc2hlcywgYW5kIHNob3VsZDogb25lIGNvbW1pdCBwZXIgY2hhbmdlIGtlZXBzIHRoZVxuICogZGVmYXVsdCBicmFuY2ggcmVhZGFibGUuIEEgKiptaWxlc3RvbmUgc3luYyBpcyB0aGUgZXhjZXB0aW9uKiosIGJlY2F1c2UgaXRzXG4gKiB3aG9sZSBwdXJwb3NlIGlzIGFuY2VzdHJ5LiBTcXVhc2hlZCwgdGhlIHN5bmMgY29tbWl0IGNhcnJpZXMgdGhlIGRlZmF1bHRcbiAqIGJyYW5jaCdzIGNvbnRlbnQgd2l0aCBhIHNpbmdsZSBwYXJlbnQsIHNvIHRoZSBkZWZhdWx0IGJyYW5jaCBpcyBub3QgYW5cbiAqIGFuY2VzdG9yIG9mIHRoZSBtaWxlc3RvbmUgYnJhbmNoOiBldmVyeSBsYXRlciBtZXJnZSBjb21wdXRlcyBpdHMgYmFzZSBmcm9tXG4gKiBiZWZvcmUgdGhlIHN5bmMsIGFuZCBhIGZpbGUgdGhlIGRlZmF1bHQgYnJhbmNoIGRlbGV0ZWQgaW4gdGhlIG1lYW50aW1lIGNvbWVzXG4gKiBiYWNrIGFzIGEgbW9kaWZ5L2RlbGV0ZSBjb25mbGljdCByYXRoZXIgdGhhbiBhcyBhIGRlbGV0aW9uLiBUaGF0IGlzIGV4YWN0bHlcbiAqIGhvdyBgbWlsZXN0b25lLzg2M2AgcmV2aXZlZCBhIGRlbGV0ZWQgc3Vic3lzdGVtLlxuICpcbiAqIEEgbWVyZ2UgY29tbWl0IHJlY29yZHMgdGhlIGRlZmF1bHQgYnJhbmNoIGFzIGEgcGFyZW50LCBzbyBpdHMgZGVsZXRpb25zIGFyZVxuICogZ2VudWluZWx5IGluIHRoZSBicmFuY2gncyBoaXN0b3J5IGFuZCBuZXZlciBoYXZlIHRvIGJlIHJlLWRlcml2ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZU1ldGhvZEZsYWdGb3JIZWFkKFxuICBoZWFkUmVmTmFtZT86IHN0cmluZyB8IG51bGwsXG4gIGhlYWRJc1NhbWVSZXBvc2l0b3J5OiBib29sZWFuID0gZmFsc2UsXG4pOiBcIi0tbWVyZ2VcIiB8IFwiLS1zcXVhc2hcIiB7XG4gIC8vIEEgaGVhZCBicmFuY2ggKm5hbWUqIGlzIGNob3NlbiBieSB3aG9ldmVyIHB1c2hlZCB0aGUgYnJhbmNoLCBhbmQgYSBmb3JrXG4gIC8vIFBSJ3MgaGVhZCBsaXZlcyBpbiBhIHJlcG9zaXRvcnkgdGhlIGZsZWV0IGRvZXMgbm90IGNvbnRyb2wg4oCUIHNvIG9uIGEgZm9ya1xuICAvLyB0aGUgbmFtZSBpcyBhIGNsYWltLCBub3QgZXZpZGVuY2UgKElzc3VlICMxMjQ5LCBmaW5kaW5nIDEwKS4gT25seSBhXG4gIC8vIHNhbWUtcmVwb3NpdG9yeSBoZWFkLCB3aGljaCBuZWVkZWQgd3JpdGUgYWNjZXNzIHRvIGNyZWF0ZSwgY2FuIHNlbGVjdCB0aGVcbiAgLy8gbWVyZ2UtY29tbWl0IGRldmlhdGlvbjsgZXZlcnl0aGluZyBlbHNlIHNxdWFzaGVzLCB3aGljaCBpcyB0aGUgZGVmYXVsdFxuICAvLyB0aGlzIHJlcG9zaXRvcnkncyBwb2xpY3kgZXhwZWN0cy5cbiAgLy9cbiAgLy8gVGhlIGRlZmF1bHQgaXMgdGhlICoqcmVzdHJpY3RpdmUqKiBvbmU6IGEgY2FsbGVyIHRoYXQgaGFzIG5vdCBlc3RhYmxpc2hlZFxuICAvLyB3aGVyZSB0aGUgaGVhZCBsaXZlcyBoYXMgbm90IGVzdGFibGlzaGVkIHRoYXQgdGhlIGRldmlhdGlvbiBpcyBzYWZlLiBFdmVyeVxuICAvLyBjYWxsZXIgdGhhdCBkb3duZ3JhZGVzIGEgc3luYy1zaGFwZWQgaGVhZCB0aGlzIHdheSBtdXN0IHNheSBzbyBvdXQgbG91ZCDigJRcbiAgLy8ge0BsaW5rIGZvcmtTeW5jRG93bmdyYWRlV2FybmluZ30gaXMgdGhhdCBzZW50ZW5jZSDigJQgYmVjYXVzZSBhIHNpbGVudGx5XG4gIC8vIHNxdWFzaGVkIHN5bmMgaXMgdGhlIGV4YWN0IGRlZmVjdCBJc3N1ZSAjMTA0OCBleGlzdHMgdG8gcHJldmVudC5cbiAgcmV0dXJuIGlzTWlsZXN0b25lU3luY0JyYW5jaChoZWFkUmVmTmFtZSkgJiYgaGVhZElzU2FtZVJlcG9zaXRvcnlcbiAgICA/IFwiLS1tZXJnZVwiXG4gICAgOiBcIi0tc3F1YXNoXCI7XG59XG5cbi8qKlxuICogVGhlIHdhcm5pbmcgYSBzeW5jLXNoYXBlZCBoZWFkIGVhcm5zIHdoZW4gaXQgaXMgc3F1YXNoZWQgYmVjYXVzZSB0aGUgaGVhZFxuICogY291bGQgbm90IGJlIHNob3duIHRvIGxpdmUgaW4gdGhpcyByZXBvc2l0b3J5IChJc3N1ZSAjMTI0OSwgZmluZGluZyAxMCkuXG4gKlxuICogVGhlIHNpYmxpbmcgb2Yge0BsaW5rIHNxdWFzaGVkU3luY1dhcm5pbmd9LCB3aGljaCBjb3ZlcnMgdGhlIG90aGVyIHJlYXNvbiBhXG4gKiBzeW5jIHNxdWFzaGVzICh0aGUgcmVwb3NpdG9yeSBmb3JiaWRzIG1lcmdlIGNvbW1pdHMpLiBCb3RoIGV4aXN0IHNvIHRoZVxuICogZG93bmdyYWRlIGlzIG5ldmVyIHF1aWV0LlxuICpcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBgb3duZXIvcmVwb2AgZm9ybVxuICogQHBhcmFtIHByTnVtYmVyIC0gVGhlIFBSIGJlaW5nIG1lcmdlZFxuICogQHBhcmFtIGhlYWRSZWZOYW1lIC0gVGhlIHN5bmMtc2hhcGVkIGhlYWQgYnJhbmNoXG4gKiBAcmV0dXJucyBBIHNpbmdsZS1saW5lIHdhcm5pbmcgbmFtaW5nIHRoZSBQUiBhbmQgd2h5IGl0IHNxdWFzaGVkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JrU3luY0Rvd25ncmFkZVdhcm5pbmcoXG4gIHJlcG86IHN0cmluZyxcbiAgcHJOdW1iZXI6IG51bWJlcixcbiAgaGVhZFJlZk5hbWU6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtyZXBvfSMke3ByTnVtYmVyfSBoYXMgYSBtaWxlc3RvbmUtc3luYy1zaGFwZWQgaGVhZCBgICtcbiAgICBgJyR7aGVhZFJlZk5hbWV9JyB3aG9zZSByZXBvc2l0b3J5IGNvdWxkIG5vdCBiZSBjb25maXJtZWQgYXMgJHtyZXBvfSwgc28gYCArXG4gICAgYGl0IGlzIGFybWVkIGFzIGEgU1FVQVNIIHJhdGhlciB0aGFuIGEgbWVyZ2UgY29tbWl0LiBBIGZvcmsgbWF5IG5hbWUgaXRzIGAgK1xuICAgIGBicmFuY2ggYW55dGhpbmcsIHNvIHRoZSBuYW1lIGFsb25lIGNhbm5vdCBzZWxlY3QgdGhlIG1lcmdlLWNvbW1pdCBgICtcbiAgICBgZGV2aWF0aW9uIChJc3N1ZSAjMTI0OSkuIElmIHRoaXMgaXMgYSBnZW51aW5lIHN5bmMsIGNoZWNrIHRoZSBQUidzIGAgK1xuICAgIGBpc0Nyb3NzUmVwb3NpdG9yeSBmaWVsZC5gO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgR2l0SHViIHJlZnVzZWQgYSBtZXJnZSBiZWNhdXNlIHRoZSByZXBvc2l0b3J5IGRvZXMgbm90IHBlcm1pdCBtZXJnZVxuICogY29tbWl0cyAoYGFsbG93X21lcmdlX2NvbW1pdDogZmFsc2VgLCBvciBhIHJ1bGVzZXQgd2hvc2VcbiAqIGBhbGxvd2VkX21lcmdlX21ldGhvZHNgIG9taXRzIGBtZXJnZWApLlxuICpcbiAqIFRoaXMgaXMgdGhlIG9uZSByZWZ1c2FsIHRoZSBzeW5jIGFuc3dlcnMgYnkgY2hhbmdpbmcgbWV0aG9kIHJhdGhlciB0aGFuIGJ5XG4gKiByZXRyeWluZzogbm8gbnVtYmVyIG9mIHJldHJpZXMgdHVybnMgYSByZXBvc2l0b3J5IHNldHRpbmcgb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc01lcmdlQ29tbWl0Tm90QWxsb3dlZChtZXNzYWdlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgdGV4dCA9IG1lc3NhZ2UudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIHRleHQuaW5jbHVkZXMoXCJtZXJnZSBjb21taXRzIGFyZSBub3QgYWxsb3dlZFwiKSB8fFxuICAgIHRleHQuaW5jbHVkZXMoXCJtZXJnZSBjb21taXQgaXMgbm90IGFsbG93ZWRcIikgfHxcbiAgICAodGV4dC5pbmNsdWRlcyhcIm1lcmdlIG1ldGhvZFwiKSAmJiB0ZXh0LmluY2x1ZGVzKFwibm90IGFsbG93ZWRcIikpIHx8XG4gICAgdGV4dC5pbmNsdWRlcyhcIm5vdCBhbGxvd2VkIGZvciB0aGlzIHJlcG9zaXRvcnlcIik7XG59XG5cbi8qKlxuICogVGhlIHdhcm5pbmcgYSBzcXVhc2hlZCBzeW5jIGVhcm5zLCBuYW1pbmcgdGhlIHJlcG9zaXRvcnkgc2V0dGluZyB0byBjaGFuZ2UuXG4gKlxuICogQSBzcXVhc2hlZCBzeW5jIGlzIGEgcmVhbCBmYXVsdCDigJQgaXQgbGVhdmVzIHRoZSBkZWZhdWx0IGJyYW5jaCBvdXRzaWRlIHRoZVxuICogbWlsZXN0b25lIGJyYW5jaCdzIGFuY2VzdHJ5IOKAlCBzbyBpdCBpcyBuZXZlciBzaWxlbnQuIEl0IGlzIG5vdCBmYXRhbCBlaXRoZXI6XG4gKiB0aGUgYGNoZWNrLXJlc3VycmVjdGVkLWZpbGVzYCBnYXRlIG9uIGV2ZXJ5IG1pbGVzdG9uZSBQUiBjYXRjaGVzIHRoZVxuICogY29uc2VxdWVuY2UsIGFuZCBhIHN5bmMgdGhhdCByZWZ1c2VkIHRvIGxhbmQgd291bGQgbGVhdmUgdGhlIGJyYW5jaCBkcmlmdGluZ1xuICogaW5zdGVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNxdWFzaGVkU3luY1dhcm5pbmcoXG4gIHJlcG86IHN0cmluZyxcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4gIGRldGFpbDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGB0aGUgc3luYyBQUiBmb3IgJyR7bWlsZXN0b25lQnJhbmNofScgaW4gJHtyZXBvfSBoYWQgdG8gYmUgYCArXG4gICAgYGFybWVkIGFzIGEgU1FVQVNIIOKAlCAke3JlcG99IGRvZXMgbm90IHBlcm1pdCBtZXJnZSBjb21taXRzICgke2RldGFpbH0pLiBgICtcbiAgICBgVGhlIGRlZmF1bHQgYnJhbmNoIHdpbGwgbm90IGJlIGFuIGFuY2VzdG9yIG9mICcke21pbGVzdG9uZUJyYW5jaH0nLCBzbyBgICtcbiAgICBgaXRzIGRlbGV0aW9ucyBjYW4gcmV0dXJuIGFzIG1vZGlmeS9kZWxldGUgY29uZmxpY3RzLiBFbmFibGUgbWVyZ2UgYCArXG4gICAgYGNvbW1pdHMgb24gJHtyZXBvfSAoU2V0dGluZ3Mg4oaSIFB1bGwgUmVxdWVzdHMg4oaSIEFsbG93IG1lcmdlIGNvbW1pdHM7IGAgK1xuICAgIGBzZXR1cCBkb2VzIHRoaXMsIGtlZXBpbmcgdGhlIGRlZmF1bHQgYnJhbmNoIHNxdWFzaC1vbmx5IOKAlCBJc3N1ZSAjMjY5MCkgdG8gYCArXG4gICAgYGNsb3NlIHRoaXMgb2ZmOyB1bnRpbCB0aGVuIHRoZSBjaGVjay1yZXN1cnJlY3RlZC1maWxlcyBnYXRlIGlzIHdoYXQgYCArXG4gICAgYGNhdGNoZXMgdGhlIGNvbnNlcXVlbmNlIChJc3N1ZSAjMTA0OCkuYDtcbn1cblxuLyoqIEluamVjdGVkIHNlYW1zIHNvIHRoZSB3aG9sZSBwYXRoIGlzIHRlc3RhYmxlIHdpdGhvdXQgZ2l0IG9yIEdpdEh1Yi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWlsZXN0b25lU3luY1ByRGVwcyB7XG4gIC8qKlxuICAgKiBSdW5zIGdpdCBpbiB0aGUgY2xvbmU7IHJlc29sdmVzIHdpdGggdGhlIGV4aXQgY29kZSBhbmQgYm90aCBzdHJlYW1zLlxuICAgKiBgc3Rkb3V0YCBpcyBvcHRpb25hbCBzbyBhIGNhbGxlciB0aGF0IG9ubHkgY2FwdHVyZWQgc3RkZXJyIHN0aWxsXG4gICAqIGNvbXBpbGVzLCBidXQgYSByZWZ1c2FsIGdpdCBwcmludGVkIG9uIHN0ZG91dCBpcyByZXBvcnRlZCB3aGVuIGl0IGlzXG4gICAqIHRoZXJlIChJc3N1ZSAjMTk2NCkuXG4gICAqL1xuICBnaXQ6IChcbiAgICBhcmdzOiBzdHJpbmdbXSxcbiAgKSA9PiBQcm9taXNlPHsgY29kZTogbnVtYmVyOyBzdGRlcnI6IHN0cmluZzsgc3Rkb3V0Pzogc3RyaW5nIH0+O1xuICAvKiogUnVucyBgZ2hgLCByZXR1cm5pbmcgc3Rkb3V0OyB0aHJvd3Mgb24gZmFpbHVyZS4gKi9cbiAgZ2g6IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+O1xuICBsb2c/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG4vKiogV2hhdCB7QGxpbmsgcmFpc2VNaWxlc3RvbmVTeW5jUHJ9IGRpZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWlsZXN0b25lU3luY1ByT3V0Y29tZSB7XG4gIC8qKiBCcmFuY2ggdGhlIFBSIHdhcyByYWlzZWQgZnJvbS4gKi9cbiAgYnJhbmNoOiBzdHJpbmc7XG4gIC8qKiBUcnVlIHdoZW4gdGhpcyBjYWxsIG9wZW5lZCB0aGUgUFIgcmF0aGVyIHRoYW4gdXBkYXRpbmcgYW4gb3BlbiBvbmUuICovXG4gIG9wZW5lZDogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRydWUgd2hlbiB0aGlzIGNhbGwgcHVzaGVkIHRoZSBzeW5jIGJyYW5jaDsgZmFsc2Ugd2hlbiB0aGUgcmVtb3RlIHN5bmNcbiAgICogYnJhbmNoIGFscmVhZHkgY2FycmllZCB0aGlzIGV4YWN0IG1lcmdlLCBzbyB0aGUgcHVzaCB3YXMgc2tpcHBlZCBhbmQgdGhlXG4gICAqIG9wZW4gc3luYyBQUidzIHJlcXVpcmVkIGNoZWNrcyB3ZXJlIG5vdCByZXN0YXJ0ZWQgKElzc3VlICMzNjkwKS5cbiAgICovXG4gIHB1c2hlZDogYm9vbGVhbjtcbn1cblxuLyoqIFdoZXRoZXIgdGhlIHJlbW90ZSBzeW5jIGJyYW5jaCBhbHJlYWR5IGhvbGRzIHRoZSBtZXJnZSBhdCBIRUFELiAqL1xuZXhwb3J0IHR5cGUgU3luY0JyYW5jaENvbXBhcmlzb24gPSBcImNhcnJpZXNcIiB8IFwiZGlmZmVyc1wiIHwgXCJ1bmtub3duXCI7XG5cbmNvbnN0IEZVTExfU0hBID0gL15bMC05YS1mXXs0MH0kLztcblxuLyoqXG4gKiBXaGV0aGVyIGByZWZzL3JlbW90ZXMvb3JpZ2luLzxicmFuY2g+YCBhbHJlYWR5IGNhcnJpZXMgdGhlIG1lcmdlIGF0IEhFQURcbiAqIChJc3N1ZSAjMzY5MCkuXG4gKlxuICogXCJjYXJyaWVzXCIgbWVhbnMgdGhlIHNhbWUgdHJlZSBhbmQgdGhlIHNhbWUgdGlwczogSEVBRCBpcyBhbiBhbmNlc3RvciBvZiB0aGVcbiAqIHJlbW90ZSBoZWFkLCBvciBldmVyeSBwYXJlbnQgb2YgSEVBRCBpcyAoYSBzaWJsaW5nIGhvc3QgbWVyZ2VkIHRoZSBzYW1lXG4gKiBtaWxlc3RvbmUgdGlwIGFuZCBkZWZhdWx0IHRpcCBpbnRvIGEgbmV3IGNvbW1pdCB3aXRoIGlkZW50aWNhbCBjb250ZW50KS5cbiAqIFwiZGlmZmVyc1wiIG1lYW5zIHRoZXJlIGlzIG5vdGhpbmcgdG8gY29tcGFyZSBhZ2FpbnN0IG9yIHRoZSBjb250ZW50IG9yIHRpcHNcbiAqIG1vdmVkLCBzbyB0aGUgcHVzaCBpcyBhcyBpdCBhbHdheXMgd2FzLiBcInVua25vd25cIiBtZWFucyBhIHJlYWQgZmFpbGVkOyB0aGVcbiAqIGNhbGxlciBmYWlscyB0b3dhcmRzIHN5bmNpbmcgYW5kIHB1c2hlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN5bmNCcmFuY2hBbHJlYWR5Q2FycmllcyhcbiAgYnJhbmNoOiBzdHJpbmcsXG4gIGdpdDogTWlsZXN0b25lU3luY1ByRGVwc1tcImdpdFwiXSxcbik6IFByb21pc2U8U3luY0JyYW5jaENvbXBhcmlzb24+IHtcbiAgY29uc3QgcmVtb3RlID0gYXdhaXQgZ2l0KFtcbiAgICBcInJldi1wYXJzZVwiLFxuICAgIFwiLS12ZXJpZnlcIixcbiAgICBcIi0tcXVpZXRcIixcbiAgICBgcmVmcy9yZW1vdGVzL29yaWdpbi8ke2JyYW5jaH1gLFxuICBdKTtcbiAgLy8gQWJzZW50IG9uIHRoZSByZW1vdGU6IHRoZSBvcmRpbmFyeSBmaXJzdC1ydW4gY2FzZSwgbm90aGluZyB0byBjb21wYXJlLlxuICBpZiAocmVtb3RlLmNvZGUgIT09IDApIHJldHVybiBcImRpZmZlcnNcIjtcbiAgY29uc3QgcmVtb3RlSGVhZCA9IChyZW1vdGUuc3Rkb3V0ID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCFGVUxMX1NIQS50ZXN0KHJlbW90ZUhlYWQpKSByZXR1cm4gXCJ1bmtub3duXCI7XG5cbiAgY29uc3QgcmVhZFNpbmdsZSA9IGFzeW5jIChhcmdzOiBzdHJpbmdbXSk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4gPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdpdChhcmdzKTtcbiAgICBjb25zdCBvdXQgPSAocmVzdWx0LnN0ZG91dCA/PyBcIlwiKS50cmltKCk7XG4gICAgcmV0dXJuIHJlc3VsdC5jb2RlID09PSAwICYmIG91dCA/IG91dCA6IG51bGw7XG4gIH07XG4gIGNvbnN0IGhlYWRUcmVlID0gYXdhaXQgcmVhZFNpbmdsZShbXCJyZXYtcGFyc2VcIiwgXCJIRUFEXnt0cmVlfVwiXSk7XG4gIGNvbnN0IHJlbW90ZVRyZWUgPSBhd2FpdCByZWFkU2luZ2xlKFtcInJldi1wYXJzZVwiLCBgJHtyZW1vdGVIZWFkfV57dHJlZX1gXSk7XG4gIGlmICghaGVhZFRyZWUgfHwgIXJlbW90ZVRyZWUpIHJldHVybiBcInVua25vd25cIjtcbiAgaWYgKGhlYWRUcmVlICE9PSByZW1vdGVUcmVlKSByZXR1cm4gXCJkaWZmZXJzXCI7XG5cbiAgY29uc3QgaXNBbmNlc3RvciA9IGFzeW5jIChcbiAgICBjb21taXQ6IHN0cmluZyxcbiAgKTogUHJvbWlzZTxib29sZWFuIHwgbnVsbD4gPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdpdChbXG4gICAgICBcIm1lcmdlLWJhc2VcIixcbiAgICAgIFwiLS1pcy1hbmNlc3RvclwiLFxuICAgICAgY29tbWl0LFxuICAgICAgcmVtb3RlSGVhZCxcbiAgICBdKTtcbiAgICBpZiAocmVzdWx0LmNvZGUgPT09IDApIHJldHVybiB0cnVlO1xuICAgIGlmIChyZXN1bHQuY29kZSA9PT0gMSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBudWxsO1xuICB9O1xuXG4gIGNvbnN0IGhlYWRBbmNlc3RvciA9IGF3YWl0IGlzQW5jZXN0b3IoXCJIRUFEXCIpO1xuICBpZiAoaGVhZEFuY2VzdG9yID09PSBudWxsKSByZXR1cm4gXCJ1bmtub3duXCI7XG4gIGlmIChoZWFkQW5jZXN0b3IpIHJldHVybiBcImNhcnJpZXNcIjtcblxuICBjb25zdCBsaW5lID0gYXdhaXQgcmVhZFNpbmdsZShbXCJyZXYtbGlzdFwiLCBcIi0tcGFyZW50c1wiLCBcIi1uXCIsIFwiMVwiLCBcIkhFQURcIl0pO1xuICBpZiAoIWxpbmUpIHJldHVybiBcInVua25vd25cIjtcbiAgY29uc3QgcGFyZW50cyA9IGxpbmUuc3BsaXQoL1xccysvKS5zbGljZSgxKTtcbiAgaWYgKHBhcmVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJ1bmtub3duXCI7XG4gIGZvciAoY29uc3QgcGFyZW50IG9mIHBhcmVudHMpIHtcbiAgICBjb25zdCBhbmNlc3RvciA9IGF3YWl0IGlzQW5jZXN0b3IocGFyZW50KTtcbiAgICBpZiAoYW5jZXN0b3IgPT09IG51bGwpIHJldHVybiBcInVua25vd25cIjtcbiAgICBpZiAoIWFuY2VzdG9yKSByZXR1cm4gXCJkaWZmZXJzXCI7XG4gIH1cbiAgcmV0dXJuIFwiY2Fycmllc1wiO1xufVxuXG4vKipcbiAqIEFybSBhdXRvLW1lcmdlIG9uIGEgZnJlc2hseS1yYWlzZWQgc3luYyBQUiwgYXMgYSBtZXJnZSBjb21taXQgKElzc3VlICMxMDQ4KS5cbiAqXG4gKiBBIHJlcG9zaXRvcnkgdGhhdCBmb3JiaWRzIG1lcmdlIGNvbW1pdHMgZ2V0cyB0aGUgc3F1YXNoIGl0IGNhbiB0YWtlLCB3aXRoIGFcbiAqIGxvdWQgd2FybmluZyBuYW1pbmcgdGhlIHNldHRpbmcg4oCUIG5ldmVyIGEgcXVpZXQgZG93bmdyYWRlLiBBbnkgb3RoZXIgZmFpbHVyZVxuICogaXMgcmVwb3J0ZWQgb24gdGhlIFBSIG9uY2UgKElzc3VlICMyNDU3KSwgbmFtaW5nIHRoZSByZWFzb24gYW5kIHN0YXRpbmcgdGhlXG4gKiBBdXRvLU1lcmdlIHN3ZWVwIHJldHJpZXMg4oCUIHRoZSBzYW1lIGNvbnRyYWN0IGFzIG9yZGluYXJ5IGNyZWF0aW9uIGFybWluZy5cbiAqIEEgbGF0Y2hlZCBxdW90YSByZWZ1c2FsIGlzIG5hbWVkIGFzIHN1Y2ggYW5kIG5ldmVyIHJldHJpZWQgaW4tcnVuLlxuICovXG5hc3luYyBmdW5jdGlvbiBhcm1TeW5jUHJBdXRvTWVyZ2UoXG4gIHJlcG86IHN0cmluZyxcbiAgcHJOdW1iZXI6IHN0cmluZyxcbiAgYnJhbmNoOiBzdHJpbmcsXG4gIGRlcHM6IE1pbGVzdG9uZVN5bmNQckRlcHMsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYXJtID0gKG1ldGhvZDogXCItLW1lcmdlXCIgfCBcIi0tc3F1YXNoXCIpID0+XG4gICAgZGVwcy5naChbXCJwclwiLCBcIm1lcmdlXCIsIHByTnVtYmVyLCBcIi0tcmVwb1wiLCByZXBvLCBcIi0tYXV0b1wiLCBtZXRob2RdKTtcblxuICBjb25zdCByZXBvcnQgPSBhc3luYyAobWVzc2FnZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgbG9nQXQoXG4gICAgICBkZXBzLmxvZyxcbiAgICAgIFwid2FyblwiLFxuICAgICAgYHRoZSBzeW5jIFBSICR7cmVwb30jJHtwck51bWJlcn0gd2FzIG5vdCBhcm1lZCBmb3IgYXV0by1tZXJnZTogYCArXG4gICAgICAgIG1lc3NhZ2UudHJpbSgpLFxuICAgICk7XG4gICAgY29uc3QgcmV0cnlMaW5lID0gbWVzc2FnZS5pbmNsdWRlcyhQUklNQVJZX1FVT1RBX1NLSVBfUFJFRklYKVxuICAgICAgPyBcIlRoZSBwcmltYXJ5IEdpdEh1YiBxdW90YSBpcyBleGhhdXN0ZWQsIHNvIG5vIGZ1cnRoZXIgYXV0by1tZXJnZSBcIiArXG4gICAgICAgIFwiYXR0ZW1wdCB3YXMgbWFkZSBpbiB0aGlzIHJ1bjsgdGhlIEF1dG8tTWVyZ2Ugc3dlZXAgcmV0cmllcyBvbmNlIHRoZSBcIiArXG4gICAgICAgIFwicXVvdGEgcmVzZXRzLlwiXG4gICAgICA6IFwiVGhlIEF1dG8tTWVyZ2Ugc3dlZXAgcmV0cmllcy5cIjtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGVwcy5naChbXG4gICAgICAgIFwicHJcIixcbiAgICAgICAgXCJjb21tZW50XCIsXG4gICAgICAgIHByTnVtYmVyLFxuICAgICAgICBcIi0tcmVwb1wiLFxuICAgICAgICByZXBvLFxuICAgICAgICBcIi0tYm9keVwiLFxuICAgICAgICBgQXV0by1tZXJnZSB3YXMgbm90IGFybWVkIG9uIHRoaXMgc3luYyBQUjogJHttZXNzYWdlLnRyaW0oKX1cXG5cXG5gICtcbiAgICAgICAgcmV0cnlMaW5lLFxuICAgICAgXSk7XG4gICAgfSBjYXRjaCAoY29tbWVudEVycm9yKSB7XG4gICAgICAvLyBGYWlsIGxvdWQ6IHRoZSByZWZ1c2FsIG11c3QgbmV2ZXIgYmVjb21lIHNpbGVudCBiZWNhdXNlIHRoZSBjb21tZW50XG4gICAgICAvLyBjb3VsZCBub3QgYmUgcG9zdGVkLiBUaGUgd2FybmluZyBhYm92ZSBuYW1lZCB0aGUgcmVhc29uOyB0aGlzIG5hbWVzXG4gICAgICAvLyB0aGUgbG9zdCBjb21tZW50IHRvby5cbiAgICAgIGxvZ0F0KFxuICAgICAgICBkZXBzLmxvZyxcbiAgICAgICAgXCJ3YXJuXCIsXG4gICAgICAgIGBjb3VsZCBub3QgcG9zdCB0aGUgYXV0by1tZXJnZSByZWFzb24gY29tbWVudCBvbiAke3JlcG99IyR7cHJOdW1iZXJ9OiAke1xuICAgICAgICAgIGNvbW1lbnRFcnJvciBpbnN0YW5jZW9mIEVycm9yXG4gICAgICAgICAgICA/IGNvbW1lbnRFcnJvci5tZXNzYWdlXG4gICAgICAgICAgICA6IFN0cmluZyhjb21tZW50RXJyb3IpXG4gICAgICAgIH1gLFxuICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgdHJ5IHtcbiAgICAvLyBUaGUgd29ya2VyIHB1c2hlZCB0aGlzIGJyYW5jaCBpbnRvIGByZXBvYCBpdHNlbGYgbW9tZW50cyBhZ28sIHNvIHRoZVxuICAgIC8vIGhlYWQgaXMgc2FtZS1yZXBvc2l0b3J5IGJ5IGNvbnN0cnVjdGlvbiAoSXNzdWUgIzEyNDkpLlxuICAgIGF3YWl0IGFybShtZXJnZU1ldGhvZEZsYWdGb3JIZWFkKGJyYW5jaCwgdHJ1ZSkpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgaWYgKCFpc01lcmdlQ29tbWl0Tm90QWxsb3dlZChtZXNzYWdlKSkge1xuICAgICAgYXdhaXQgcmVwb3J0KG1lc3NhZ2UpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgYXdhaXQgYXJtKFwiLS1zcXVhc2hcIik7XG4gICAgICBkZXBzLmxvZz8uKHNxdWFzaGVkU3luY1dhcm5pbmcocmVwbywgYnJhbmNoLCBtZXNzYWdlLnRyaW0oKSkpO1xuICAgIH0gY2F0Y2ggKHNxdWFzaEVycm9yKSB7XG4gICAgICBjb25zdCBzcXVhc2hNZXNzYWdlID0gc3F1YXNoRXJyb3IgaW5zdGFuY2VvZiBFcnJvclxuICAgICAgICA/IHNxdWFzaEVycm9yLm1lc3NhZ2VcbiAgICAgICAgOiBTdHJpbmcoc3F1YXNoRXJyb3IpO1xuICAgICAgYXdhaXQgcmVwb3J0KHNxdWFzaE1lc3NhZ2UpO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIFB1c2ggdGhlIGFscmVhZHktbWVyZ2VkIHRyZWUgdG8gYSBzeW5jIGJyYW5jaCBhbmQgcmFpc2UgYSBQUiBmb3IgaXQuXG4gKlxuICogVGhlIGNhbGxlciBoYXMgbWVyZ2VkIHRoZSBkZWZhdWx0IGJyYW5jaCBpbnRvIHRoZSBtaWxlc3RvbmUgYnJhbmNoIGluIGl0c1xuICogY2xvbmUgYW5kIGhhZCB0aGUgcHVzaCByZWZ1c2VkOyBIRUFEIHRoZXJlZm9yZSBhbHJlYWR5IGNhcnJpZXMgdGhlIG1lcmdlXG4gKiB0aGlzIFBSIGlzIGZvci5cbiAqXG4gKiBUaGUgcHVzaCBpcyBza2lwcGVkIHdoZW4gdGhlIHJlbW90ZSBzeW5jIGJyYW5jaCBhbHJlYWR5IGhvbGRzIHRoaXMgbWVyZ2VcbiAqIChzYW1lIHRyZWUsIHNhbWUgbWlsZXN0b25lIGFuZCBkZWZhdWx0IHRpcHMpOiBhIHJlLXB1c2ggd291bGQgYmUgYSBmcmVzaFxuICogY29tbWl0IHdpdGggaWRlbnRpY2FsIGNvbnRlbnQgdGhhdCByZXN0YXJ0cyB0aGUgb3BlbiBzeW5jIFBSJ3MgcmVxdWlyZWRcbiAqIGNoZWNrcyBmb3Igbm8gY2hhbmdlIChJc3N1ZSAjMzY5MCkuIFRoZSBjb21wYXJpc29uIGlzIG9ubHkgdHJ1c3RlZCBhZnRlclxuICogdGhlIGJhc2VsaW5lIGZldGNoIG9mIHRoZSBzeW5jIGJyYW5jaCBzdWNjZWVkZWQsIGJlY2F1c2UgYSBmYWlsZWQgZmV0Y2ggY2FuXG4gKiBsZWF2ZSBhIHN0YWxlIHJlbW90ZS10cmFja2luZyByZWYgZm9yIGEgYnJhbmNoIGRlbGV0ZWQgb24gdGhlIHJlbW90ZS5cbiAqIE90aGVyd2lzZSB0aGUgc3luYyBicmFuY2ggaXMgZm9yY2UtcHVzaGVkXG4gKiB3aXRoIGEgbGVhc2UuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBgb3duZXIvcmVwb2AuXG4gKiBAcGFyYW0gbWlsZXN0b25lQnJhbmNoIC0gVGhlIGJyYW5jaCB0aGUgUFIgdGFyZ2V0cy5cbiAqIEBwYXJhbSBkZWZhdWx0QnJhbmNoIC0gTmFtZWQgaW4gdGhlIFBSIGJvZHksIHNvIGEgcmVhZGVyIGtub3dzIHdoYXQgbWVyZ2VkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmFpc2VNaWxlc3RvbmVTeW5jUHIoXG4gIHJlcG86IHN0cmluZyxcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbiAgZGVwczogTWlsZXN0b25lU3luY1ByRGVwcyxcbik6IFByb21pc2U8UmVzdWx0PE1pbGVzdG9uZVN5bmNQck91dGNvbWU+PiB7XG4gIGNvbnN0IGJyYW5jaCA9IHN5bmNCcmFuY2hGb3IobWlsZXN0b25lQnJhbmNoKTtcblxuICAvLyBJc3N1ZSAjMTU2ODogYC0tZm9yY2Utd2l0aC1sZWFzZWAgd2l0aCBubyBleHBsaWNpdCB2YWx1ZSB2ZXJpZmllcyBhZ2FpbnN0XG4gIC8vIGByZWZzL3JlbW90ZXMvb3JpZ2luLzxicmFuY2g+YC4gQSBjbG9uZSB0aGF0IGhhcyBuZXZlciBmZXRjaGVkIHRoYXQgcmVmXG4gIC8vIGNhbm5vdCBvZmZlciBnaXQgYSBiYXNlbGluZSwgc28gZ2l0IHJlZnVzZXMgd2l0aCBgKHN0YWxlIGluZm8pYCDigJQgbm90XG4gIC8vIGJlY2F1c2UgYW55dGhpbmcgY29uZmxpY3RzLCBidXQgYmVjYXVzZSBpdCBoYXMgbm90aGluZyB0byBjb21wYXJlLiBBXG4gIC8vIHNpbmdsZS1icmFuY2ggY2xvbmUgcmVhY2hlcyB0aGF0IHN0YXRlIGZvciBhbnkgc3luYyBicmFuY2ggYW5vdGhlciBob3N0XG4gIC8vIGNyZWF0ZWQ6IHRoZSBuYXJyb3cgcmVmc3BlYyBuZXZlciBtYXRlcmlhbGlzZXMgaXQsIGFuZCBubyBsYXRlciBjeWNsZVxuICAvLyBtYXRlcmlhbGlzZXMgaXQgZWl0aGVyLCBzbyB0aGUgc3luYyBpcyB3ZWRnZWQgZm9yIGdvb2QuIE5FQVQtQUktT2NraGFtJ3NcbiAgLy8gbWlsZXN0b25lIHN5bmMgaGFkIGJlZW4gZmFpbGluZyB0aGlzIHdheSBldmVyeSBjeWNsZS5cbiAgLy9cbiAgLy8gRmV0Y2hpbmcgdGhlIGJyYW5jaCBzdXBwbGllcyB0aGUgYmFzZWxpbmUuIEl0IGlzIGRlbGliZXJhdGVseSAqbm90KiBhXG4gIC8vIGZldGNoIG9mIGV2ZXJ5dGhpbmcsIGFuZCBkZWxpYmVyYXRlbHkgYmVzdC1lZmZvcnQ6IGBnaXQgZmV0Y2ggb3JpZ2luXG4gIC8vIDxicmFuY2g+YCBmYWlscyB3aGVuIHRoZSBicmFuY2ggZG9lcyBub3QgZXhpc3Qgb24gdGhlIHJlbW90ZSB5ZXQsIHdoaWNoXG4gIC8vIGlzIHRoZSBvcmRpbmFyeSBmaXJzdC1ydW4gY2FzZSDigJQgYSBjcmVhdGUgbmVlZHMgbm8gYmFzZWxpbmUsIGFuZCB0aGUgcHVzaFxuICAvLyBiZWxvdyBoYW5kbGVzIGl0LlxuICAvL1xuICAvLyBUaGlzIGRvZXMgbm90IHdlYWtlbiB0aGUgbGVhc2UuIFRoZSBiYXNlbGluZSBpcyB0YWtlbiBmcm9tIHdoYXRldmVyIHRoZVxuICAvLyByZW1vdGUgaG9sZHMgYXQgdGhpcyBtb21lbnQ7IGlmIGFub3RoZXIgaG9zdCBtb3ZlcyB0aGUgYnJhbmNoIGFmdGVyIHRoYXQsXG4gIC8vIHRoZSBwdXNoIGlzIHN0aWxsIHJlZnVzZWQsIHdoaWNoIGlzIHRoZSBjYXNlIHRoZSBsZWFzZSBleGlzdHMgZm9yLlxuICBjb25zdCBmZXRjaEJhc2VsaW5lID0gKCkgPT5cbiAgICBkZXBzLmdpdChbXG4gICAgICBcImZldGNoXCIsXG4gICAgICBcIm9yaWdpblwiLFxuICAgICAgYHJlZnMvaGVhZHMvJHticmFuY2h9OnJlZnMvcmVtb3Rlcy9vcmlnaW4vJHticmFuY2h9YCxcbiAgICBdKTtcbiAgY29uc3QgcHVzaEJyYW5jaCA9ICgpID0+XG4gICAgZGVwcy5naXQoW1xuICAgICAgXCJwdXNoXCIsXG4gICAgICBcIi0tZm9yY2Utd2l0aC1sZWFzZVwiLFxuICAgICAgXCJvcmlnaW5cIixcbiAgICAgIGBIRUFEOnJlZnMvaGVhZHMvJHticmFuY2h9YCxcbiAgICBdKTtcbiAgY29uc3QgYmFzZWxpbmUgPSBhd2FpdCBmZXRjaEJhc2VsaW5lKCk7XG5cbiAgLy8gSXNzdWUgIzM2OTA6IHRoZSByZW1vdGUgc3luYyBicmFuY2ggaXMgdGhlIGZsZWV0LXdpZGUgcmVjb3JkIG9mIHdoYXQgd2FzXG4gIC8vIHN5bmNlZC4gSWYgaXQgYWxyZWFkeSBob2xkcyB0aGlzIG1lcmdlLCByZS1wdXNoaW5nIG9ubHkgcmVzdGFydHMgY2hlY2tzLlxuICAvLyBPbmx5IHRydXN0ZWQgYWZ0ZXIgYSBzdWNjZXNzZnVsIGZldGNoOiBhIGZhaWxlZCBmZXRjaCAoYnJhbmNoIGRlbGV0ZWQgb25cbiAgLy8gdGhlIHJlbW90ZSwgb3IgZmlyc3QgcnVuKSBjYW4gbGVhdmUgYSBzdGFsZSByZW1vdGUtdHJhY2tpbmcgcmVmIGJlaGluZC5cbiAgY29uc3QgY2FycmllZDogU3luY0JyYW5jaENvbXBhcmlzb24gPSBiYXNlbGluZS5jb2RlID09PSAwXG4gICAgPyBhd2FpdCBzeW5jQnJhbmNoQWxyZWFkeUNhcnJpZXMoYnJhbmNoLCBkZXBzLmdpdClcbiAgICA6IFwiZGlmZmVyc1wiO1xuICBpZiAoY2FycmllZCA9PT0gXCJjYXJyaWVzXCIpIHtcbiAgICBkZXBzLmxvZz8uKFxuICAgICAgYE1pbGVzdG9uZSBzeW5jIGJyYW5jaCAnJHticmFuY2h9JyBhbHJlYWR5IGhvbGRzIHRoaXMgbWVyZ2UgKHNhbWUgdHJlZSwgYCArXG4gICAgICAgIGBzYW1lIHRpcHMpOyBub3RoaW5nIHdhcyBwdXNoZWQsIHNvIHRoZSBvcGVuIHN5bmMgUFIncyBjaGVja3Mga2VlcCBgICtcbiAgICAgICAgYHJ1bm5pbmcgKElzc3VlICMzNjkwKWAsXG4gICAgKTtcbiAgfSBlbHNlIGlmIChjYXJyaWVkID09PSBcInVua25vd25cIikge1xuICAgIGRlcHMubG9nPy4oXG4gICAgICBgTWlsZXN0b25lIHN5bmMgYnJhbmNoICcke2JyYW5jaH0nOiB0aGUgY29tcGFyaXNvbiB3aXRoIHRoZSByZW1vdGUgYCArXG4gICAgICAgIGBicmFuY2ggY291bGQgbm90IGJlIHJlYWQ7IHB1c2hpbmcgYXMgYmVmb3JlIChJc3N1ZSAjMzY5MClgLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgc2tpcFB1c2ggPSBjYXJyaWVkID09PSBcImNhcnJpZXNcIjtcblxuICAvLyBGb3JjZS13aXRoLWxlYXNlOiB0aGUgc3luYyBicmFuY2ggaXMgdGhpcyBmdW5jdGlvbidzIGFsb25lLCBhbmQgYSBzdGFsZVxuICAvLyBvbmUgZnJvbSBhbiBlYXJsaWVyIGN5Y2xlIGNhcnJpZXMgYSBtZXJnZSB0aGF0IGlzIG5vIGxvbmdlciBjdXJyZW50LlxuICAvLyBgLS1mb3JjZS13aXRoLWxlYXNlYCBzdGlsbCByZWZ1c2VzIGlmIHNvbWVib2R5IGVsc2UgbW92ZWQgaXQuXG4gIGNvbnN0IHB1c2hXaXRoU3RhbGVSZXRyeSA9IGFzeW5jICgpOiBQcm9taXNlPEVycm9yIHwgbnVsbD4gPT4ge1xuICAgIGxldCBwdXNoID0gYXdhaXQgcHVzaEJyYW5jaCgpO1xuICAgIGNvbnN0IHB1c2hXYXNTdGFsZSA9ICgpID0+XG4gICAgICBwdXNoLmNvZGUgIT09IDAgJiZcbiAgICAgIGlzU3RhbGVJbmZvUHVzaChgJHtwdXNoLnN0ZGVycn1cXG4ke3B1c2guc3Rkb3V0ID8/IFwiXCJ9YCk7XG4gICAgLy8gYHN0YWxlIGluZm9gIG1lYW5zIGFub3RoZXIgYWN0b3IgbW92ZWQgdGhlIGJyYW5jaCBhZnRlciB0aGUgZmV0Y2hcbiAgICAvLyBhYm92ZS4gUmVmZXRjaCB0aGUgbmV3IGJhc2VsaW5lIGFuZCByZXRyeSBvbmNlIChJc3N1ZSAjMjYxMykuXG4gICAgbGV0IHN0YWxlUmV0cmllZCA9IGZhbHNlO1xuICAgIGlmIChwdXNoV2FzU3RhbGUoKSkge1xuICAgICAgc3RhbGVSZXRyaWVkID0gdHJ1ZTtcbiAgICAgIGF3YWl0IGZldGNoQmFzZWxpbmUoKTtcbiAgICAgIHB1c2ggPSBhd2FpdCBwdXNoQnJhbmNoKCk7XG4gICAgfVxuICAgIGlmIChwdXNoLmNvZGUgIT09IDApIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9IHB1c2guc3RkZXJyLnRyaW0oKSB8fCBwdXNoLnN0ZG91dD8udHJpbSgpIHx8XG4gICAgICAgIGBnaXQgZXhpdGVkICR7cHVzaC5jb2RlfSBhbmQgcHJpbnRlZCBub3RoaW5nYDtcbiAgICAgIGNvbnN0IHN0YWxlID0gc3RhbGVSZXRyaWVkICYmIHB1c2hXYXNTdGFsZSgpO1xuICAgICAgcmV0dXJuIG5ldyBFcnJvcihcbiAgICAgICAgc3RhbGVcbiAgICAgICAgICA/IGBDb3VsZCBub3QgcHVzaCB0aGUgbWlsZXN0b25lIHN5bmMgYnJhbmNoICcke2JyYW5jaH0nOiB0aGUgcHVzaCBgICtcbiAgICAgICAgICAgIGB3YXMgcmVqZWN0ZWQgd2l0aCBzdGFsZSBpbmZvIOKAlCBhbm90aGVyIGFjdG9yIHVwZGF0ZWQgdGhlIGJyYW5jaCBgICtcbiAgICAgICAgICAgIGDigJQgYW5kIHdhcyBzdGlsbCByZWplY3RlZCBhZnRlciBpdCB3YXMgcmVmZXRjaGVkIGFuZCByZXRyaWVkOiAke2RldGFpbH1gXG4gICAgICAgICAgOiBgQ291bGQgbm90IHB1c2ggdGhlIG1pbGVzdG9uZSBzeW5jIGJyYW5jaCAnJHticmFuY2h9JzogJHtkZXRhaWx9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChzdGFsZVJldHJpZWQpIHtcbiAgICAgIGRlcHMubG9nPy4oXG4gICAgICAgIGBNaWxlc3RvbmUgc3luYyBicmFuY2ggJyR7YnJhbmNofSc6IHRoZSBwdXNoIHdhcyByZWplY3RlZCB3aXRoIHN0YWxlIGAgK1xuICAgICAgICAgIGBpbmZvIChhbm90aGVyIGFjdG9yIG1vdmVkIHRoZSBicmFuY2gpOyByZWZldGNoZWQgYW5kIHJldHJpZWQg4oCUIGFjY2VwdGVkLmAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfTtcbiAgY29uc3QgcHVzaEVycm9yID0gc2tpcFB1c2ggPyBudWxsIDogYXdhaXQgcHVzaFdpdGhTdGFsZVJldHJ5KCk7XG4gIGlmIChwdXNoRXJyb3IgIT09IG51bGwpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHB1c2hFcnJvciB9O1xuXG4gIC8vIE9uZSBvcGVuIFBSIHBlciBtaWxlc3RvbmUgYnJhbmNoOiBhIHN5bmMgdGhhdCBpcyBzdGlsbCBvcGVuIGlzIHVwZGF0ZWQgYnlcbiAgLy8gdGhlIHB1c2ggYWJvdmUsIGFuZCByZS1maWxpbmcgd291bGQgbGVhdmUgdHdvIFBScyBtZXJnaW5nIHRoZSBzYW1lIHRoaW5nLlxuICB0cnkge1xuICAgIGNvbnN0IGxpc3RlZCA9IGF3YWl0IGRlcHMuZ2goW1xuICAgICAgXCJwclwiLFxuICAgICAgXCJsaXN0XCIsXG4gICAgICBcIi0tcmVwb1wiLFxuICAgICAgcmVwbyxcbiAgICAgIFwiLS1zdGF0ZVwiLFxuICAgICAgXCJvcGVuXCIsXG4gICAgICBcIi0taGVhZFwiLFxuICAgICAgYnJhbmNoLFxuICAgICAgXCItLWJhc2VcIixcbiAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgIFwiLS1qc29uXCIsXG4gICAgICBcIm51bWJlclwiLFxuICAgIF0pO1xuICAgIGNvbnN0IG9wZW4gPSBKU09OLnBhcnNlKGxpc3RlZCB8fCBcIltdXCIpIGFzIHsgbnVtYmVyOiBudW1iZXIgfVtdO1xuICAgIGlmIChBcnJheS5pc0FycmF5KG9wZW4pICYmIG9wZW4ubGVuZ3RoID4gMCkge1xuICAgICAgZGVwcy5sb2c/LihcbiAgICAgICAgYG1pbGVzdG9uZSBzeW5jOiAke3NraXBQdXNoID8gXCJsZWZ0XCIgOiBcInVwZGF0ZWRcIn0gdGhlIG9wZW4gc3luYyBQUiAjJHtcbiAgICAgICAgICBvcGVuWzBdIS5udW1iZXJcbiAgICAgICAgfSBmb3IgYCArXG4gICAgICAgICAgYCcke21pbGVzdG9uZUJyYW5jaH0nIChJc3N1ZSAjNTg5KWAsXG4gICAgICApO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGJyYW5jaCwgb3BlbmVkOiBmYWxzZSwgcHVzaGVkOiAhc2tpcFB1c2ggfSB9O1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gQW4gdW5yZWFkYWJsZSBsaXN0aW5nIGZhbGxzIHRocm91Z2ggdG8gY3JlYXRpbmcgb25lOiBhIGR1cGxpY2F0ZSBQUiBpc1xuICAgIC8vIHJlY292ZXJhYmxlLCBhIHN5bmMgdGhhdCBuZXZlciBsYW5kcyBpcyBub3QuXG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGJvZHkgPSBbXG4gICAgICBgTWVyZ2VzIFxcYCR7ZGVmYXVsdEJyYW5jaH1cXGAgaW50byBcXGAke21pbGVzdG9uZUJyYW5jaH1cXGAuYCxcbiAgICAgIFwiXCIsXG4gICAgICBcIlJhaXNlZCBhcyBhIHB1bGwgcmVxdWVzdCByYXRoZXIgdGhhbiBwdXNoZWQgZGlyZWN0bHkgYmVjYXVzZSBcIiArXG4gICAgICBgXFxgJHttaWxlc3RvbmVCcmFuY2h9XFxgIGlzIGdhdGVkIGJ5IGEgcmVxdWlyZWQtc3RhdHVzLWNoZWNrcyBydWxlc2V0IGAgK1xuICAgICAgXCIoSXNzdWUgIzU4NikuIFRoYXQgZ2F0ZSBpcyB3aGF0IG1ha2VzIHRoaXMgUFIgYXV0by1tZXJnZWFibGUg4oCUIEdpdEh1YiBcIiArXG4gICAgICBcImFybXMgYXV0by1tZXJnZSBvbmx5IHdoZW4gc29tZXRoaW5nIGJsb2NrcyB0aGUgbWVyZ2Ug4oCUIHNvIHRoaXMgbGFuZHMgXCIgK1xuICAgICAgXCJ1bmF0dGVuZGVkIG9uY2UgaXRzIGNoZWNrcyBhcmUgZ3JlZW4uXCIsXG4gICAgICBcIlwiLFxuICAgICAgYExhbmRzIGFzIGEgKiptZXJnZSBjb21taXQqKiwgbmV2ZXIgYSBzcXVhc2g6IHRoZSBwb2ludCBvZiB0aGUgc3luYyBpcyBgICtcbiAgICAgIGB0byBwdXQgXFxgJHtkZWZhdWx0QnJhbmNofVxcYCBpbiB0aGlzIGJyYW5jaCdzICphbmNlc3RyeSosIHNvIGl0cyBgICtcbiAgICAgIGBkZWxldGlvbnMgYXJlIGhpc3RvcnkgaGVyZSByYXRoZXIgdGhhbiBjb25mbGljdHMgbGF0ZXIgKElzc3VlICMxMDQ4KS5gLFxuICAgICAgXCJcIixcbiAgICAgIFwiRmlsZWQgYnkgdGhlIG1pbGVzdG9uZSBicmFuY2ggc3luYyAoSXNzdWUgIzU4OSkuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IGRlcHMuZ2goW1xuICAgICAgXCJwclwiLFxuICAgICAgXCJjcmVhdGVcIixcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWJhc2VcIixcbiAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgIFwiLS1oZWFkXCIsXG4gICAgICBicmFuY2gsXG4gICAgICBcIi0tdGl0bGVcIixcbiAgICAgIGBTeW5jICR7ZGVmYXVsdEJyYW5jaH0gaW50byAke21pbGVzdG9uZUJyYW5jaH1gLFxuICAgICAgXCItLWJvZHlcIixcbiAgICAgIGJvZHksXG4gICAgXSk7XG5cbiAgICAvLyBCZXN0LWVmZm9ydDogYSBQUiB0aGF0IGNhbm5vdCBiZSBhcm1lZCBzdGlsbCBsYW5kcyB0aHJvdWdoIHRoZSBmbGVldCdzXG4gICAgLy8gb3duIGF1dG8tbWVyZ2UgcGFzcywgc28gYSBmYWlsdXJlIGhlcmUgaXMgbm90IHRoZSBzeW5jJ3MgZmFpbHVyZS5cbiAgICBjb25zdCBudW1iZXIgPSBjcmVhdGVkLnRyaW0oKS5zcGxpdChcIi9cIikucG9wKCkgPz8gXCJcIjtcbiAgICBpZiAobnVtYmVyKSB7XG4gICAgICBhd2FpdCBhcm1TeW5jUHJBdXRvTWVyZ2UocmVwbywgbnVtYmVyLCBicmFuY2gsIGRlcHMpO1xuICAgICAgLy8gSXNzdWUgIzI0Mzg6IHRoZSBzeW5jIFBSIGFza3MgZm9yIG5vIHJldmlld2VyIG9mIGl0cyBvd24sIGJ1dFxuICAgICAgLy8gQ09ERU9XTkVSUyBhdXRvLXJlcXVlc3RzIG9uZSB0aGUgbW9tZW50IGl0IG9wZW5zIGFuZCBub3RoaW5nIGFjdHMgb25cbiAgICAgIC8vIGl0IOKAlCB0aGUgcmV2aWV3IHRoYXQgbWF0dGVycyBzaXRzIG9uIHRoZSBtaWxlc3RvbmUg4oaSIGRlZmF1bHQtYnJhbmNoXG4gICAgICAvLyBQUi4gUmVtb3ZlIGl0IG9uY2UsIGhlcmUuXG4gICAgICBhd2FpdCBjbGVhck1pbGVzdG9uZVJldmlld1JlcXVlc3RzKHtcbiAgICAgICAgcmVwbyxcbiAgICAgICAgcHJOdW1iZXI6IE51bWJlcihudW1iZXIpLFxuICAgICAgICBiYXNlOiBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICB9LCB7XG4gICAgICAgIGdoQ29tbWFuZEZuOiBkZXBzLmdoLFxuICAgICAgICAuLi4oZGVwcy5sb2cgPyB7IGxvZzogZGVwcy5sb2csIHdhcm46IGRlcHMubG9nIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICB9XG4gICAgZGVwcy5sb2c/LihcbiAgICAgIGBtaWxlc3RvbmUgc3luYzogcmFpc2VkIFBSICR7Y3JlYXRlZC50cmltKCl9IHRvIG1lcmdlIGAgK1xuICAgICAgICBgJyR7ZGVmYXVsdEJyYW5jaH0nIGludG8gJyR7bWlsZXN0b25lQnJhbmNofScg4oCUIHRoZSBicmFuY2ggaXMgZ2F0ZWQsIGAgK1xuICAgICAgICBgc28gdGhlIHB1c2ggaGFkIHRvIGJlY29tZSBhIFBSIChJc3N1ZSAjNTg5KWAsXG4gICAgKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgYnJhbmNoLCBvcGVuZWQ6IHRydWUsIHB1c2hlZDogIXNraXBQdXNoIH0gfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogVGhlIHNlbnRlbmNlIGZyYWdtZW50IGRlc2NyaWJpbmcgaG93IGEgc3luYyBsYW5kZWQsIGNob3NlbiBmcm9tIHRoZSBmb3VyXG4gKiBgcHVzaGVkYCB4IGBvcGVuZWRgIG91dGNvbWVzIG9mIHtAbGluayByYWlzZU1pbGVzdG9uZVN5bmNQcn0gKElzc3VlcyAjNTg5LFxuICogIzM2OTApLiBFbmRzIHdpdGggXCIg4oCUIFwiIHNvIHRoZSBjYWxsZXIgY2FuIGFwcGVuZCBpdHMgb3duIGRldGFpbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNQckxhbmRpbmdOb3RlKG91dGNvbWU6IE1pbGVzdG9uZVN5bmNQck91dGNvbWUpOiBzdHJpbmcge1xuICBpZiAoIW91dGNvbWUucHVzaGVkICYmICFvdXRjb21lLm9wZW5lZCkge1xuICAgIHJldHVybiBgQUxSRUFEWSBJTiB0aGUgb3BlbiBzeW5jIFBSIGZyb20gJyR7b3V0Y29tZS5icmFuY2h9JyDigJQgaXRzIGAgK1xuICAgICAgYGhlYWQgaG9sZHMgdGhpcyBtZXJnZSwgc28gbm90aGluZyB3YXMgcHVzaGVkIGFuZCBpdHMgY2hlY2tzIHdlcmUgYCArXG4gICAgICBgbm90IHJlc3RhcnRlZCAoSXNzdWUgIzM2OTApIOKAlCBgO1xuICB9XG4gIGlmICghb3V0Y29tZS5wdXNoZWQpIHtcbiAgICByZXR1cm4gYFJBSVNFRCBhIHN5bmMgUFIgZnJvbSB0aGUgZXhpc3RpbmcgJyR7b3V0Y29tZS5icmFuY2h9JyBoZWFkLCBgICtcbiAgICAgIGB3aGljaCBhbHJlYWR5IGhlbGQgdGhpcyBtZXJnZSDigJQgbm90aGluZyB3YXMgcHVzaGVkIChJc3N1ZSAjMzY5MCkg4oCUIGA7XG4gIH1cbiAgaWYgKG91dGNvbWUub3BlbmVkKSB7XG4gICAgcmV0dXJuIGBSQUlTRUQgYSBzeW5jIFBSIGZyb20gJyR7b3V0Y29tZS5icmFuY2h9JyDigJQgdGhlIGJyYW5jaCBpcyBgICtcbiAgICAgIGBnYXRlZCwgc28gdGhlIHB1c2ggYmVjYW1lIGEgcHVsbCByZXF1ZXN0IChJc3N1ZSAjNTg5KSDigJQgYDtcbiAgfVxuICByZXR1cm4gYFVQREFURUQgdGhlIG9wZW4gc3luYyBQUiBmcm9tICcke291dGNvbWUuYnJhbmNofScgKElzc3VlICM1ODkpIOKAlCBgO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTZCQyxHQUdELFNBQVMseUJBQXlCLFFBQVEsMkJBQTJCO0FBQ3JFLFNBQVMsNEJBQTRCLFFBQVEsOEJBQThCO0FBQzNFLFNBQ0UscUJBQXFCLEVBQ3JCLGFBQWEsUUFDUiw2QkFBNkI7QUFDcEMsU0FBUyxLQUFLLFFBQVEsZ0JBQWdCO0FBRXRDLFNBQ0UscUJBQXFCLEVBQ3JCLGtCQUFrQixFQUNsQixhQUFhLFFBQ1IsNkJBQTZCO0FBRXBDOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyxvQkFBb0IsTUFBYztFQUNoRCxNQUFNLE9BQU8sT0FBTyxXQUFXO0VBQy9CLE9BQU8sS0FBSyxRQUFRLENBQUMsaUNBQ25CLHVFQUF1RTtFQUN2RSx3Q0FBd0M7RUFDeEMsS0FBSyxRQUFRLENBQUMsWUFDZCxLQUFLLFFBQVEsQ0FBQyxvQkFDZCxLQUFLLFFBQVEsQ0FBQyx1QkFDZCxLQUFLLFFBQVEsQ0FBQztBQUNsQjtBQUVBOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVMsZ0JBQWdCLE1BQWM7RUFDNUMsT0FBTyxrQkFBa0IsSUFBSSxDQUFDO0FBQ2hDO0FBRUE7Ozs7Ozs7Ozs7Ozs7O0NBY0MsR0FDRCxPQUFPLFNBQVMsdUJBQ2QsV0FBMkIsRUFDM0IsdUJBQWdDLEtBQUs7RUFFckMsMEVBQTBFO0VBQzFFLDRFQUE0RTtFQUM1RSxzRUFBc0U7RUFDdEUsNEVBQTRFO0VBQzVF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
// denoCacheMetadata=5332843779672814407,2227749908426597903