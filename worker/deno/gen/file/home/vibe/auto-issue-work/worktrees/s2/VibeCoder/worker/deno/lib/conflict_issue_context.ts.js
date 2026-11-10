/**
 * Originating-issue context for both sides of a conflicting PR
 * (Issue #1113, parent #1076).
 *
 * The merge-conflict agent sees the conflicted working tree and nothing else,
 * so it reads "the same constant set to two different values" as a genuine
 * contradiction and stops. Often it is not one: one issue superseded the
 * other, and the answer is written down in an issue neither side of the merge
 * can see. This module answers the question the resolver cannot currently ask
 * — **what were the two sides trying to do?** — by resolving:
 *
 * - the **PR side**: the issue the conflicting PR itself came from, and
 * - the **base side**: for each conflicted path, the issues behind the
 *   base-branch commits that changed that path since the merge base.
 *
 * It reports; it does not decide. Nothing here judges whether one issue
 * supersedes the other, and nothing here is wired into the resolution path —
 * that is #1114.
 *
 * **Absence is a first-class result.** "No originating issue found" is
 * returned as a stated reason, never as an empty list: the resolver's
 * behaviour when it has no intent to consult differs materially from its
 * behaviour when both intents are known, and it cannot tell those apart from
 * `[]`.
 *
 * **Everything is bounded.** This runs inside a pass with a ten-minute
 * per-attempt budget and a shared rate limit, so an unbounded `git log` over a
 * long-lived base branch mapped commit-by-commit through the GitHub API is not
 * viable. Commits per path, issues returned, characters of issue text and
 * total `gh` calls all have documented defaults
 * ({@link DEFAULT_CONFLICT_ISSUE_CONTEXT_BOUNDS}), and every bound that bites
 * is declared in {@link ConflictIssueContext.truncation}.
 *
 * The base walk is `--first-parent`, so it sees the base branch's own merge
 * and squash commits rather than every commit each merged PR brought with it.
 * A base commit whose subject carries no PR reference is reported as
 * `"no-pr"` rather than mapped through a per-commit API lookup — one bounded
 * git call per path is the whole cost.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { resolveComparableBaseRef } from "./git_base_ref.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import { extractClosingIssueNumbers } from "./pr_body.ts";
/**
 * Documented defaults.
 *
 * Sized for one attempt inside the merge-conflict pass: 20 first-parent
 * commits is several months of a busy path's history, 8 issues at 4000
 * characters of body text is roughly a page of prompt, and 30 `gh` calls
 * keeps the shared rate limit intact even when every path resolves.
 */ export const DEFAULT_CONFLICT_ISSUE_CONTEXT_BOUNDS = {
  maxCommitsPerPath: 20,
  maxIssues: 8,
  maxIssueTextChars: 4000,
  maxGhCalls: 30
};
/** Field separator in the `git log` format — never appears in a subject. */ const LOG_FIELD_SEPARATOR = "\x1f";
/** `Merge pull request #99 from …` — GitHub's merge-commit subject. */ const MERGE_COMMIT_SUBJECT = /^Merge pull request #(\d+)\b/;
/** `Some title (#99)` — GitHub's squash-merge subject. */ const SQUASH_COMMIT_SUBJECT = /\(#(\d+)\)\s*$/;
/** A commit SHA as git prints it. */ const COMMIT_SHA = /^[0-9a-f]{7,64}$/;
/**
 * The PR number a base-branch commit subject names, or `null`.
 *
 * Recognises GitHub's two merge shapes and nothing else — `Fix issue #99`
 * names an issue, not a PR, and must not be read as one.
 */ export function prNumberFromCommitSubject(subject) {
  const merge = MERGE_COMMIT_SUBJECT.exec(subject);
  const squash = merge ? null : SQUASH_COMMIT_SUBJECT.exec(subject);
  const digits = merge?.[1] ?? squash?.[1];
  if (digits === undefined) return null;
  const prNumber = Number(digits);
  return Number.isSafeInteger(prNumber) && prNumber > 0 ? prNumber : null;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
/**
 * Run one `gh` call against the budget.
 *
 * A failure is recorded as a warning and returned as `ok: false` — never
 * swallowed into an empty result that reads as "nothing to find".
 */ async function runGh(state, args, what) {
  if (state.ghCallsUsed >= state.bounds.maxGhCalls) {
    state.truncation.ghCallCapHit = true;
    return {
      ok: false,
      error: {
        budgetExhausted: true
      }
    };
  }
  state.ghCallsUsed++;
  try {
    return {
      ok: true,
      value: await state.gh(args)
    };
  } catch (error) {
    state.warnings.push(`${what} failed: ${errorMessage(error)}`);
    return {
      ok: false,
      error: {
        budgetExhausted: false
      }
    };
  }
}
/** Take issue text from the shared character budget, cutting if needed. */ function takeIssueText(state, issueNumber, text) {
  const remaining = Math.max(0, state.bounds.maxIssueTextChars - state.textCharsUsed);
  if (text.length <= remaining) {
    state.textCharsUsed += text.length;
    return {
      body: text,
      truncated: false
    };
  }
  state.textCharsUsed += remaining;
  state.truncation.textTruncatedIssues.push(issueNumber);
  return {
    body: text.slice(0, remaining),
    truncated: true
  };
}
/** Fetch an issue's number, title, state and bounded body. */ async function fetchIssue(state, issueNumber) {
  const cached = state.issueCache.get(issueNumber);
  if (cached) return {
    ok: true,
    value: cached
  };
  if (state.issueCache.size >= state.bounds.maxIssues) {
    state.truncation.issueCapHit = true;
    return {
      ok: false,
      error: {
        budgetExhausted: true
      }
    };
  }
  const what = `gh issue view #${issueNumber}`;
  const output = await runGh(state, [
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    state.repo,
    "--json",
    "number,title,state,body"
  ], what);
  if (!output.ok) return output;
  let parsed;
  try {
    parsed = JSON.parse(output.value);
  } catch (error) {
    state.warnings.push(`${what} returned unparseable JSON: ${errorMessage(error)}`);
    return {
      ok: false,
      error: {
        budgetExhausted: false
      }
    };
  }
  const text = takeIssueText(state, issueNumber, String(parsed.body ?? ""));
  const issue = {
    number: issueNumber,
    title: String(parsed.title ?? ""),
    state: String(parsed.state ?? ""),
    body: text.body,
    bodyTruncated: text.truncated
  };
  state.issueCache.set(issueNumber, issue);
  return {
    ok: true,
    value: issue
  };
}
/**
 * Fetch a PR's title, body and closing-issue references in one call.
 *
 * Cached for the gather: one base PR commonly touches several conflicted
 * paths, and re-viewing it per path would spend the `gh` budget on repeats.
 */ async function fetchPrView(state, prNumber) {
  const cached = state.prCache.get(prNumber);
  if (cached) return {
    ok: true,
    value: cached
  };
  const what = `gh pr view #${prNumber}`;
  const output = await runGh(state, [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    state.repo,
    "--json",
    "number,title,body,closingIssuesReferences"
  ], what);
  if (!output.ok) return output;
  let parsed;
  try {
    parsed = JSON.parse(output.value);
  } catch (error) {
    state.warnings.push(`${what} returned unparseable JSON: ${errorMessage(error)}`);
    return {
      ok: false,
      error: {
        budgetExhausted: false
      }
    };
  }
  const closingIssues = [];
  for (const reference of parsed.closingIssuesReferences ?? []){
    const number = reference?.number;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0 && !closingIssues.includes(number)) {
      closingIssues.push(number);
    }
  }
  const view = {
    number: prNumber,
    title: String(parsed.title ?? ""),
    body: String(parsed.body ?? ""),
    closingIssues
  };
  state.prCache.set(prNumber, view);
  return {
    ok: true,
    value: view
  };
}
/** Turn a bounded-lookup failure into the matching PR-side reason. */ function prReasonFor(budgetExhausted) {
  return budgetExhausted ? "budget-exhausted" : "lookup-failed";
}
/**
 * Resolve the PR side, in precedence order: the `issue-<n>-…` branch shape,
 * then the body's closing keywords, then GitHub's own linkage. First hit
 * wins, and the winning signal is recorded.
 */ async function resolvePrSide(state, request) {
  const finish = async (issueNumber, signal)=>{
    const issue = await fetchIssue(state, issueNumber);
    return issue.ok ? {
      resolved: true,
      signal,
      issue: issue.value
    } : {
      resolved: false,
      reason: prReasonFor(issue.error.budgetExhausted)
    };
  };
  // 1. The branch shape — free, and the worker's own convention.
  const branchIssue = issueNumberFromBranch(request.prBranch);
  if (branchIssue !== null) return await finish(branchIssue, "branch");
  // The body and the linkage both come from one PR view.
  let view = null;
  if (request.prBody === undefined) {
    const fetched = await fetchPrView(state, request.prNumber);
    if (!fetched.ok) {
      return {
        resolved: false,
        reason: prReasonFor(fetched.error.budgetExhausted)
      };
    }
    view = fetched.value;
  }
  // 2. The body's closing keywords.
  const bodyIssue = extractClosingIssueNumbers(request.prBody ?? view.body)[0];
  if (bodyIssue !== undefined) return await finish(bodyIssue, "body");
  // 3. GitHub's own linkage.
  if (view === null) {
    const fetched = await fetchPrView(state, request.prNumber);
    if (!fetched.ok) {
      return {
        resolved: false,
        reason: prReasonFor(fetched.error.budgetExhausted)
      };
    }
    view = fetched.value;
  }
  const linkedIssue = view.closingIssues[0];
  if (linkedIssue !== undefined) return await finish(linkedIssue, "linkage");
  return {
    resolved: false,
    reason: "no-signal"
  };
}
/**
 * Resolve the merge base of the PR branch and the base branch.
 *
 * Returns `null` — with a warning naming the cause — when the walk cannot
 * start. Every caller turns that into an explicit per-path
 * `"merge-base-unavailable"` rather than an empty base side.
 */ async function resolveBaseWalkAnchor(state, request, git) {
  const cwd = request.cwd;
  const resolveRef = async (branch)=>{
    try {
      const resolved = await resolveComparableBaseRef(git, branch, {
        cwd
      });
      if (resolved.ok) return resolved.value;
      state.warnings.push(`merge base walk skipped: ${resolved.error.message}`);
    } catch (error) {
      state.warnings.push(`merge base walk skipped: '${branch}' is not a usable ref (${errorMessage(error)})`);
    }
    return null;
  };
  const baseRef = await resolveRef(request.baseBranch);
  if (baseRef === null) return null;
  const headRef = await resolveRef(request.prBranch);
  if (headRef === null) return null;
  const result = await git([
    "merge-base",
    baseRef,
    headRef
  ], {
    cwd
  });
  const sha = result.ok ? result.value.stdout.trim() : "";
  if (!result.ok || result.value.code !== 0 || !COMMIT_SHA.test(sha)) {
    const detail = result.ok ? `exit ${result.value.code}: ${result.value.stderr.trim()}` : result.error.message;
    state.warnings.push(`no merge base between '${baseRef}' and '${headRef}' (${detail})`);
    return null;
  }
  return {
    mergeBase: sha,
    baseRef
  };
}
/** An unresolved base-side entry — absence stated, never silence. */ function unresolvedPath(path, reason, commitsInspected = 0, prNumbers = []) {
  return {
    path,
    commitsInspected,
    prNumbers,
    issues: [],
    unresolved: reason,
    partial: false
  };
}
/** Base commits touching one path since the merge base, bounded. */ async function inspectPathCommits(state, request, git, anchor, path) {
  const cap = state.bounds.maxCommitsPerPath;
  // One more than the cap, so "capped" is a fact rather than a guess.
  const result = await git([
    "log",
    "--first-parent",
    `--max-count=${cap + 1}`,
    `--format=%H%x1f%s`,
    `${anchor.mergeBase}..${anchor.baseRef}`,
    "--",
    path
  ], {
    cwd: request.cwd
  });
  if (!result.ok || result.value.code !== 0) {
    const detail = result.ok ? `exit ${result.value.code}: ${result.value.stderr.trim()}` : result.error.message;
    state.warnings.push(`git log failed for '${path}' (${detail})`);
    return {
      ok: false,
      error: {
        budgetExhausted: false
      }
    };
  }
  const lines = result.value.stdout.split("\n").map((line)=>line.trim()).filter((line)=>line.length > 0);
  if (lines.length > cap) state.truncation.commitCapPaths.push(path);
  const subjects = lines.slice(0, cap).map((line)=>{
    const separator = line.indexOf(LOG_FIELD_SEPARATOR);
    return separator < 0 ? line : line.slice(separator + 1);
  });
  return {
    ok: true,
    value: {
      subjects
    }
  };
}
/** Resolve the base side for one conflicted path. */ async function gatherPathOrigin(state, request, git, anchor, path) {
  const commits = await inspectPathCommits(state, request, git, anchor, path);
  if (!commits.ok) return unresolvedPath(path, "git-error");
  const subjects = commits.value.subjects;
  if (subjects.length === 0) return unresolvedPath(path, "no-commits");
  const prNumbers = [];
  for (const subject of subjects){
    const prNumber = prNumberFromCommitSubject(subject);
    if (prNumber !== null && !prNumbers.includes(prNumber)) {
      prNumbers.push(prNumber);
    }
  }
  if (prNumbers.length === 0) {
    return unresolvedPath(path, "no-pr", subjects.length);
  }
  const issues = [];
  let budgetExhausted = false;
  let lookupFailed = false;
  for (const prNumber of prNumbers){
    const view = await fetchPrView(state, prNumber);
    if (!view.ok) {
      if (view.error.budgetExhausted) {
        budgetExhausted = true;
        break;
      }
      lookupFailed = true;
      continue;
    }
    // GitHub's linkage first, then the body's closing keywords — the same two
    // signals the PR side uses. The PR *title* is deliberately not consulted:
    // a trailing `(#N)` is the PR's own number in a squash subject and the
    // issue number in a worker PR title, and a wrong originating issue is
    // worse than none.
    const issueNumbers = view.value.closingIssues.length > 0 ? view.value.closingIssues : extractClosingIssueNumbers(view.value.body);
    for (const issueNumber of issueNumbers){
      const issue = await fetchIssue(state, issueNumber);
      if (!issue.ok) {
        if (issue.error.budgetExhausted) {
          budgetExhausted = true;
          break;
        }
        lookupFailed = true;
        continue;
      }
      if (!issues.some((known)=>known.number === issueNumber)) {
        issues.push(issue.value);
      }
    }
    if (budgetExhausted) break;
  }
  if (issues.length > 0) {
    return {
      path,
      commitsInspected: subjects.length,
      prNumbers,
      issues,
      unresolved: null,
      // Some issues resolved and some did not: the list is short, and saying
      // so here is what stops a partial answer reading as a whole one.
      partial: budgetExhausted || lookupFailed
    };
  }
  const reason = budgetExhausted ? "budget-exhausted" : lookupFailed ? "lookup-failed" : "no-issue";
  return unresolvedPath(path, reason, subjects.length, prNumbers);
}
/**
 * Gather the originating-issue context for both sides of a conflicting PR.
 *
 * Never throws and never returns a bare empty result: every side either names
 * its issues or states why it has none, and every bound that bit is declared
 * in {@link ConflictIssueContext.truncation}.
 */ export async function gatherConflictIssueContext(request, deps) {
  const state = {
    repo: request.repo,
    gh: deps.gh,
    bounds: {
      ...DEFAULT_CONFLICT_ISSUE_CONTEXT_BOUNDS,
      ...deps.bounds
    },
    ghCallsUsed: 0,
    textCharsUsed: 0,
    warnings: [],
    truncation: {
      commitCapPaths: [],
      issueCapHit: false,
      textTruncatedIssues: [],
      ghCallCapHit: false
    },
    issueCache: new Map(),
    prCache: new Map()
  };
  const prSide = await resolvePrSide(state, request);
  const paths = [];
  for (const path of request.conflictedPaths){
    if (path.length > 0 && !paths.includes(path)) paths.push(path);
  }
  const baseSide = [];
  if (paths.length > 0) {
    const anchor = await resolveBaseWalkAnchor(state, request, deps.git);
    for (const path of paths){
      baseSide.push(anchor === null ? unresolvedPath(path, "merge-base-unavailable") : await gatherPathOrigin(state, request, deps.git, anchor, path));
    }
  }
  return {
    repo: request.repo,
    prNumber: request.prNumber,
    prSide,
    baseSide,
    truncation: state.truncation,
    ghCallsUsed: state.ghCallsUsed,
    warnings: state.warnings
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25mbGljdF9pc3N1ZV9jb250ZXh0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogT3JpZ2luYXRpbmctaXNzdWUgY29udGV4dCBmb3IgYm90aCBzaWRlcyBvZiBhIGNvbmZsaWN0aW5nIFBSXG4gKiAoSXNzdWUgIzExMTMsIHBhcmVudCAjMTA3NikuXG4gKlxuICogVGhlIG1lcmdlLWNvbmZsaWN0IGFnZW50IHNlZXMgdGhlIGNvbmZsaWN0ZWQgd29ya2luZyB0cmVlIGFuZCBub3RoaW5nIGVsc2UsXG4gKiBzbyBpdCByZWFkcyBcInRoZSBzYW1lIGNvbnN0YW50IHNldCB0byB0d28gZGlmZmVyZW50IHZhbHVlc1wiIGFzIGEgZ2VudWluZVxuICogY29udHJhZGljdGlvbiBhbmQgc3RvcHMuIE9mdGVuIGl0IGlzIG5vdCBvbmU6IG9uZSBpc3N1ZSBzdXBlcnNlZGVkIHRoZVxuICogb3RoZXIsIGFuZCB0aGUgYW5zd2VyIGlzIHdyaXR0ZW4gZG93biBpbiBhbiBpc3N1ZSBuZWl0aGVyIHNpZGUgb2YgdGhlIG1lcmdlXG4gKiBjYW4gc2VlLiBUaGlzIG1vZHVsZSBhbnN3ZXJzIHRoZSBxdWVzdGlvbiB0aGUgcmVzb2x2ZXIgY2Fubm90IGN1cnJlbnRseSBhc2tcbiAqIOKAlCAqKndoYXQgd2VyZSB0aGUgdHdvIHNpZGVzIHRyeWluZyB0byBkbz8qKiDigJQgYnkgcmVzb2x2aW5nOlxuICpcbiAqIC0gdGhlICoqUFIgc2lkZSoqOiB0aGUgaXNzdWUgdGhlIGNvbmZsaWN0aW5nIFBSIGl0c2VsZiBjYW1lIGZyb20sIGFuZFxuICogLSB0aGUgKipiYXNlIHNpZGUqKjogZm9yIGVhY2ggY29uZmxpY3RlZCBwYXRoLCB0aGUgaXNzdWVzIGJlaGluZCB0aGVcbiAqICAgYmFzZS1icmFuY2ggY29tbWl0cyB0aGF0IGNoYW5nZWQgdGhhdCBwYXRoIHNpbmNlIHRoZSBtZXJnZSBiYXNlLlxuICpcbiAqIEl0IHJlcG9ydHM7IGl0IGRvZXMgbm90IGRlY2lkZS4gTm90aGluZyBoZXJlIGp1ZGdlcyB3aGV0aGVyIG9uZSBpc3N1ZVxuICogc3VwZXJzZWRlcyB0aGUgb3RoZXIsIGFuZCBub3RoaW5nIGhlcmUgaXMgd2lyZWQgaW50byB0aGUgcmVzb2x1dGlvbiBwYXRoIOKAlFxuICogdGhhdCBpcyAjMTExNC5cbiAqXG4gKiAqKkFic2VuY2UgaXMgYSBmaXJzdC1jbGFzcyByZXN1bHQuKiogXCJObyBvcmlnaW5hdGluZyBpc3N1ZSBmb3VuZFwiIGlzXG4gKiByZXR1cm5lZCBhcyBhIHN0YXRlZCByZWFzb24sIG5ldmVyIGFzIGFuIGVtcHR5IGxpc3Q6IHRoZSByZXNvbHZlcidzXG4gKiBiZWhhdmlvdXIgd2hlbiBpdCBoYXMgbm8gaW50ZW50IHRvIGNvbnN1bHQgZGlmZmVycyBtYXRlcmlhbGx5IGZyb20gaXRzXG4gKiBiZWhhdmlvdXIgd2hlbiBib3RoIGludGVudHMgYXJlIGtub3duLCBhbmQgaXQgY2Fubm90IHRlbGwgdGhvc2UgYXBhcnQgZnJvbVxuICogYFtdYC5cbiAqXG4gKiAqKkV2ZXJ5dGhpbmcgaXMgYm91bmRlZC4qKiBUaGlzIHJ1bnMgaW5zaWRlIGEgcGFzcyB3aXRoIGEgdGVuLW1pbnV0ZVxuICogcGVyLWF0dGVtcHQgYnVkZ2V0IGFuZCBhIHNoYXJlZCByYXRlIGxpbWl0LCBzbyBhbiB1bmJvdW5kZWQgYGdpdCBsb2dgIG92ZXIgYVxuICogbG9uZy1saXZlZCBiYXNlIGJyYW5jaCBtYXBwZWQgY29tbWl0LWJ5LWNvbW1pdCB0aHJvdWdoIHRoZSBHaXRIdWIgQVBJIGlzIG5vdFxuICogdmlhYmxlLiBDb21taXRzIHBlciBwYXRoLCBpc3N1ZXMgcmV0dXJuZWQsIGNoYXJhY3RlcnMgb2YgaXNzdWUgdGV4dCBhbmRcbiAqIHRvdGFsIGBnaGAgY2FsbHMgYWxsIGhhdmUgZG9jdW1lbnRlZCBkZWZhdWx0c1xuICogKHtAbGluayBERUZBVUxUX0NPTkZMSUNUX0lTU1VFX0NPTlRFWFRfQk9VTkRTfSksIGFuZCBldmVyeSBib3VuZCB0aGF0IGJpdGVzXG4gKiBpcyBkZWNsYXJlZCBpbiB7QGxpbmsgQ29uZmxpY3RJc3N1ZUNvbnRleHQudHJ1bmNhdGlvbn0uXG4gKlxuICogVGhlIGJhc2Ugd2FsayBpcyBgLS1maXJzdC1wYXJlbnRgLCBzbyBpdCBzZWVzIHRoZSBiYXNlIGJyYW5jaCdzIG93biBtZXJnZVxuICogYW5kIHNxdWFzaCBjb21taXRzIHJhdGhlciB0aGFuIGV2ZXJ5IGNvbW1pdCBlYWNoIG1lcmdlZCBQUiBicm91Z2h0IHdpdGggaXQuXG4gKiBBIGJhc2UgY29tbWl0IHdob3NlIHN1YmplY3QgY2FycmllcyBubyBQUiByZWZlcmVuY2UgaXMgcmVwb3J0ZWQgYXNcbiAqIGBcIm5vLXByXCJgIHJhdGhlciB0aGFuIG1hcHBlZCB0aHJvdWdoIGEgcGVyLWNvbW1pdCBBUEkgbG9va3VwIOKAlCBvbmUgYm91bmRlZFxuICogZ2l0IGNhbGwgcGVyIHBhdGggaXMgdGhlIHdob2xlIGNvc3QuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHR5cGUgR2l0UnVubmVyLCByZXNvbHZlQ29tcGFyYWJsZUJhc2VSZWYgfSBmcm9tIFwiLi9naXRfYmFzZV9yZWYudHNcIjtcbmltcG9ydCB7IGlzc3VlTnVtYmVyRnJvbUJyYW5jaCB9IGZyb20gXCIuL2lzc3VlX2JyYW5jaF9jYW5kaWRhdGVzLnRzXCI7XG5pbXBvcnQgeyBleHRyYWN0Q2xvc2luZ0lzc3VlTnVtYmVycyB9IGZyb20gXCIuL3ByX2JvZHkudHNcIjtcblxuLyoqIFdoaWNoIHNpZ25hbCBwcm9kdWNlZCB0aGUgUFItc2lkZSBvcmlnaW5hdGluZyBpc3N1ZS4gKi9cbmV4cG9ydCB0eXBlIFByT3JpZ2luU2lnbmFsID0gXCJicmFuY2hcIiB8IFwiYm9keVwiIHwgXCJsaW5rYWdlXCI7XG5cbi8qKiBXaHkgdGhlIFBSIHNpZGUgY291bGQgbm90IGJlIHJlc29sdmVkLiAqL1xuZXhwb3J0IHR5cGUgUHJVbnJlc29sdmVkUmVhc29uID1cbiAgLyoqIE5vIGJyYW5jaCBzaGFwZSwgY2xvc2luZyBrZXl3b3JkIG9yIEdpdEh1YiBsaW5rYWdlIG5hbWVkIGFuIGlzc3VlLiAqL1xuICB8IFwibm8tc2lnbmFsXCJcbiAgLyoqIEFuIGlzc3VlIHdhcyBuYW1lZCBidXQgYGdoYCBjb3VsZCBub3QgcmVhZCBpdC4gKi9cbiAgfCBcImxvb2t1cC1mYWlsZWRcIlxuICAvKiogQSBib3VuZCB3YXMgcmVhY2hlZCBiZWZvcmUgdGhlIGlzc3VlIGNvdWxkIGJlIHJlYWQuICovXG4gIHwgXCJidWRnZXQtZXhoYXVzdGVkXCI7XG5cbi8qKiBXaHkgYSBjb25mbGljdGVkIHBhdGgncyBiYXNlIHNpZGUgY291bGQgbm90IGJlIHJlc29sdmVkLiAqL1xuZXhwb3J0IHR5cGUgQmFzZVVucmVzb2x2ZWRSZWFzb24gPVxuICAvKiogVGhlIG1lcmdlIGJhc2Ugb2YgdGhlIFBSIGJyYW5jaCBhbmQgdGhlIGJhc2UgYnJhbmNoIGlzIHVudXNhYmxlLiAqL1xuICB8IFwibWVyZ2UtYmFzZS11bmF2YWlsYWJsZVwiXG4gIC8qKiBgZ2l0IGxvZ2AgZmFpbGVkIGZvciB0aGlzIHBhdGguICovXG4gIHwgXCJnaXQtZXJyb3JcIlxuICAvKiogTm8gYmFzZSBjb21taXQgdG91Y2hlZCB0aGlzIHBhdGggc2luY2UgdGhlIG1lcmdlIGJhc2UuICovXG4gIHwgXCJuby1jb21taXRzXCJcbiAgLyoqIEJhc2UgY29tbWl0cyBleGlzdCwgYnV0IG5vbmUgbmFtZXMgYSBQUi4gKi9cbiAgfCBcIm5vLXByXCJcbiAgLyoqIFBScyB3ZXJlIGlkZW50aWZpZWQsIGJ1dCBub25lIG5hbWVzIGFuIGlzc3VlLiAqL1xuICB8IFwibm8taXNzdWVcIlxuICAvKiogQSBgZ2hgIGNhbGwgZmFpbGVkIHdoaWxlIG1hcHBpbmcgUFJzIHRvIGlzc3Vlcy4gKi9cbiAgfCBcImxvb2t1cC1mYWlsZWRcIlxuICAvKiogQSBib3VuZCB3YXMgcmVhY2hlZCBiZWZvcmUgdGhpcyBwYXRoIGNvdWxkIGJlIHJlc29sdmVkLiAqL1xuICB8IFwiYnVkZ2V0LWV4aGF1c3RlZFwiO1xuXG4vKiogQW4gb3JpZ2luYXRpbmcgaXNzdWUsIHdpdGggaXRzIHRleHQgYm91bmRlZCBmb3IgcHJvbXB0IHVzZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgT3JpZ2luYXRpbmdJc3N1ZSB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB0aXRsZTogc3RyaW5nO1xuICAvKiogR2l0SHViIGlzc3VlIHN0YXRlLCBlLmcuIGBPUEVOYCAvIGBDTE9TRURgLiAqL1xuICBzdGF0ZTogc3RyaW5nO1xuICAvKiogSXNzdWUgYm9keSwgY3V0IHRvIGZpdCB0aGUgY2hhcmFjdGVyIGJ1ZGdldC4gKi9cbiAgYm9keTogc3RyaW5nO1xuICAvKiogVHJ1ZSB3aGVuIHtAbGluayBib2R5fSB3YXMgY3V0LiAqL1xuICBib2R5VHJ1bmNhdGVkOiBib29sZWFuO1xufVxuXG4vKiogVGhlIGlzc3VlIHRoZSBjb25mbGljdGluZyBQUiBpdHNlbGYgY2FtZSBmcm9tIOKAlCBvciB3aHkgdGhlcmUgaXMgbm9uZS4gKi9cbmV4cG9ydCB0eXBlIFByU2lkZU9yaWdpbiA9XG4gIHwgeyByZXNvbHZlZDogdHJ1ZTsgc2lnbmFsOiBQck9yaWdpblNpZ25hbDsgaXNzdWU6IE9yaWdpbmF0aW5nSXNzdWUgfVxuICB8IHsgcmVzb2x2ZWQ6IGZhbHNlOyByZWFzb246IFByVW5yZXNvbHZlZFJlYXNvbiB9O1xuXG4vKiogV2hhdCB0aGUgYmFzZSBicmFuY2ggd2FzIHRyeWluZyB0byBkbyB0byBvbmUgY29uZmxpY3RlZCBwYXRoLiAqL1xuZXhwb3J0IGludGVyZmFjZSBCYXNlUGF0aE9yaWdpbiB7XG4gIC8qKiBUaGUgY29uZmxpY3RlZCBwYXRoIHRoaXMgZW50cnkgaXMga2V5ZWQgdG8uICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIEJhc2UgY29tbWl0cyBhY3R1YWxseSBpbnNwZWN0ZWQgKGJvdW5kZWQgcGVyIHBhdGgpLiAqL1xuICBjb21taXRzSW5zcGVjdGVkOiBudW1iZXI7XG4gIC8qKiBQUnMgaWRlbnRpZmllZCBmcm9tIHRob3NlIGNvbW1pdHMnIHN1YmplY3RzLCBpbiBuZXdlc3QtZmlyc3Qgb3JkZXIuICovXG4gIHByTnVtYmVyczogbnVtYmVyW107XG4gIC8qKiBJc3N1ZXMgdGhvc2UgUFJzIG5hbWUuIEVtcHR5IHdoZW5ldmVyIHtAbGluayB1bnJlc29sdmVkfSBpcyBzZXQuICovXG4gIGlzc3VlczogT3JpZ2luYXRpbmdJc3N1ZVtdO1xuICAvKiogYG51bGxgIHdoZW4gYXQgbGVhc3Qgb25lIGlzc3VlIHdhcyByZXNvbHZlZDsgb3RoZXJ3aXNlIHdoeSBub3QuICovXG4gIHVucmVzb2x2ZWQ6IEJhc2VVbnJlc29sdmVkUmVhc29uIHwgbnVsbDtcbiAgLyoqXG4gICAqIFRydWUgd2hlbiBzb21lIOKAlCBidXQgbm90IGFsbCDigJQgb2YgdGhpcyBwYXRoJ3MgaXNzdWVzIHJlc29sdmVkOiBhIGxvb2t1cFxuICAgKiBmYWlsZWQgb3IgYSBib3VuZCBiaXQgcGFydC13YXkgdGhyb3VnaC4ge0BsaW5rIGlzc3Vlc30gaXMgdGhlbiBhIHNob3J0XG4gICAqIGxpc3QgcmF0aGVyIHRoYW4gdGhlIHdob2xlIG9uZS5cbiAgICovXG4gIHBhcnRpYWw6IGJvb2xlYW47XG59XG5cbi8qKiBXaGljaCBib3VuZHMgYml0LCBzbyBhIGNhbGxlciBuZXZlciBtaXN0YWtlcyBhIGN1dCByZXN1bHQgZm9yIGEgd2hvbGUgb25lLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb25mbGljdENvbnRleHRUcnVuY2F0aW9uIHtcbiAgLyoqIFBhdGhzIHdoZXJlIHRoZSBwZXItcGF0aCBjb21taXQgY2FwIHN0b3BwZWQgdGhlIHdhbGsuICovXG4gIGNvbW1pdENhcFBhdGhzOiBzdHJpbmdbXTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgdG90YWwtaXNzdWUgY2FwIGRyb3BwZWQgYW4gaWRlbnRpZmllZCBpc3N1ZS4gKi9cbiAgaXNzdWVDYXBIaXQ6IGJvb2xlYW47XG4gIC8qKiBJc3N1ZXMgd2hvc2UgYm9keSB0ZXh0IHdhcyBjdXQgdG8gZml0IHRoZSBjaGFyYWN0ZXIgYnVkZ2V0LiAqL1xuICB0ZXh0VHJ1bmNhdGVkSXNzdWVzOiBudW1iZXJbXTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgYGdoYCBjYWxsIGJ1ZGdldCByYW4gb3V0IGJlZm9yZSB0aGUgd2FsayBmaW5pc2hlZC4gKi9cbiAgZ2hDYWxsQ2FwSGl0OiBib29sZWFuO1xufVxuXG4vKiogVGhlIGdhdGhlcmVkIGNvbnRleHQgZm9yIG9uZSBjb25mbGljdGluZyBQUi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29uZmxpY3RJc3N1ZUNvbnRleHQge1xuICByZXBvOiBzdHJpbmc7XG4gIHByTnVtYmVyOiBudW1iZXI7XG4gIC8qKiBUaGUgUFIgc2lkZSdzIG9yaWdpbiwgcmVzb2x2ZWQgb3IgZXhwbGljaXRseSBub3QuICovXG4gIHByU2lkZTogUHJTaWRlT3JpZ2luO1xuICAvKiogT25lIGVudHJ5IHBlciBjb25mbGljdGVkIHBhdGgsIGluIHRoZSBvcmRlciBnaXZlbi4gKi9cbiAgYmFzZVNpZGU6IEJhc2VQYXRoT3JpZ2luW107XG4gIC8qKiBXaGljaCBib3VuZHMgYml0LiAqL1xuICB0cnVuY2F0aW9uOiBDb25mbGljdENvbnRleHRUcnVuY2F0aW9uO1xuICAvKiogYGdoYCBjYWxscyBhY3R1YWxseSBzcGVudC4gKi9cbiAgZ2hDYWxsc1VzZWQ6IG51bWJlcjtcbiAgLyoqIEZhaWx1cmVzIGVuY291bnRlcmVkLCBzdGF0ZWQgcmF0aGVyIHRoYW4gc3dhbGxvd2VkLiAqL1xuICB3YXJuaW5nczogc3RyaW5nW107XG59XG5cbi8qKiBCb3VuZHMgb24gdGhlIHdvcmsgdGhpcyBtb2R1bGUgd2lsbCBkby4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29uZmxpY3RJc3N1ZUNvbnRleHRCb3VuZHMge1xuICAvKiogQmFzZSBjb21taXRzIGluc3BlY3RlZCBwZXIgY29uZmxpY3RlZCBwYXRoLiAqL1xuICBtYXhDb21taXRzUGVyUGF0aDogbnVtYmVyO1xuICAvKiogRGlzdGluY3QgaXNzdWVzIGZldGNoZWQgYWNyb3NzIHRoZSB3aG9sZSByZXN1bHQuICovXG4gIG1heElzc3VlczogbnVtYmVyO1xuICAvKiogVG90YWwgY2hhcmFjdGVycyBvZiBpc3N1ZSBib2R5IHRleHQgYWNyb3NzIHRoZSB3aG9sZSByZXN1bHQuICovXG4gIG1heElzc3VlVGV4dENoYXJzOiBudW1iZXI7XG4gIC8qKiBUb3RhbCBgZ2hgIGludm9jYXRpb25zLiAqL1xuICBtYXhHaENhbGxzOiBudW1iZXI7XG59XG5cbi8qKlxuICogRG9jdW1lbnRlZCBkZWZhdWx0cy5cbiAqXG4gKiBTaXplZCBmb3Igb25lIGF0dGVtcHQgaW5zaWRlIHRoZSBtZXJnZS1jb25mbGljdCBwYXNzOiAyMCBmaXJzdC1wYXJlbnRcbiAqIGNvbW1pdHMgaXMgc2V2ZXJhbCBtb250aHMgb2YgYSBidXN5IHBhdGgncyBoaXN0b3J5LCA4IGlzc3VlcyBhdCA0MDAwXG4gKiBjaGFyYWN0ZXJzIG9mIGJvZHkgdGV4dCBpcyByb3VnaGx5IGEgcGFnZSBvZiBwcm9tcHQsIGFuZCAzMCBgZ2hgIGNhbGxzXG4gKiBrZWVwcyB0aGUgc2hhcmVkIHJhdGUgbGltaXQgaW50YWN0IGV2ZW4gd2hlbiBldmVyeSBwYXRoIHJlc29sdmVzLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DT05GTElDVF9JU1NVRV9DT05URVhUX0JPVU5EUzogQ29uZmxpY3RJc3N1ZUNvbnRleHRCb3VuZHMgPVxuICB7XG4gICAgbWF4Q29tbWl0c1BlclBhdGg6IDIwLFxuICAgIG1heElzc3VlczogOCxcbiAgICBtYXhJc3N1ZVRleHRDaGFyczogNDAwMCxcbiAgICBtYXhHaENhbGxzOiAzMCxcbiAgfTtcblxuLyoqIFdoYXQgdG8gZ2F0aGVyIGNvbnRleHQgZm9yLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb25mbGljdElzc3VlQ29udGV4dFJlcXVlc3Qge1xuICAvKiogUmVwb3NpdG9yeSBpbiBgb3duZXIvcmVwb2AgZm9ybS4gKi9cbiAgcmVwbzogc3RyaW5nO1xuICAvKiogVGhlIGNvbmZsaWN0aW5nIFBSJ3MgbnVtYmVyLiAqL1xuICBwck51bWJlcjogbnVtYmVyO1xuICAvKiogVGhlIFBSJ3MgaGVhZCBicmFuY2guICovXG4gIHByQnJhbmNoOiBzdHJpbmc7XG4gIC8qKiBUaGUgUFIncyBiYXNlIGJyYW5jaC4gKi9cbiAgYmFzZUJyYW5jaDogc3RyaW5nO1xuICAvKiogQ29uZmxpY3RlZCBwYXRocywgYXMgYGdpdCBkaWZmIC0tbmFtZS1vbmx5IC0tZGlmZi1maWx0ZXI9VWAgcmVwb3J0cyB0aGVtLiAqL1xuICBjb25mbGljdGVkUGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhlIFBSIGJvZHksIHdoZW4gdGhlIGNhbGxlciBhbHJlYWR5IGhhcyBpdCDigJQgc2F2ZXMgYSBgZ2hgIGNhbGwuICovXG4gIHByQm9keT86IHN0cmluZztcbiAgLyoqIFdvcmtpbmcgZGlyZWN0b3J5IG9mIHRoZSBjbG9uZS4gKi9cbiAgY3dkPzogc3RyaW5nO1xufVxuXG4vKiogSW5qZWN0ZWQgc2VhbXMuICovXG5leHBvcnQgaW50ZXJmYWNlIENvbmZsaWN0SXNzdWVDb250ZXh0RGVwcyB7XG4gIC8qKiBHaXQgcnVubmVyLCBtYXRjaGluZyBgZGVwcy5naXQucnVuR2l0Q29tbWFuZGAuICovXG4gIGdpdDogR2l0UnVubmVyO1xuICAvKiogYGdoYCBydW5uZXIgcmV0dXJuaW5nIHN0ZG91dDsgdGhyb3dzIG9uIGZhaWx1cmUuICovXG4gIGdoOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbiAgLyoqIEJvdW5kIG92ZXJyaWRlczsgYW55dGhpbmcgb21pdHRlZCB0YWtlcyBpdHMgZG9jdW1lbnRlZCBkZWZhdWx0LiAqL1xuICBib3VuZHM/OiBQYXJ0aWFsPENvbmZsaWN0SXNzdWVDb250ZXh0Qm91bmRzPjtcbn1cblxuLyoqIEZpZWxkIHNlcGFyYXRvciBpbiB0aGUgYGdpdCBsb2dgIGZvcm1hdCDigJQgbmV2ZXIgYXBwZWFycyBpbiBhIHN1YmplY3QuICovXG5jb25zdCBMT0dfRklFTERfU0VQQVJBVE9SID0gXCJcXHgxZlwiO1xuXG4vKiogYE1lcmdlIHB1bGwgcmVxdWVzdCAjOTkgZnJvbSDigKZgIOKAlCBHaXRIdWIncyBtZXJnZS1jb21taXQgc3ViamVjdC4gKi9cbmNvbnN0IE1FUkdFX0NPTU1JVF9TVUJKRUNUID0gL15NZXJnZSBwdWxsIHJlcXVlc3QgIyhcXGQrKVxcYi87XG5cbi8qKiBgU29tZSB0aXRsZSAoIzk5KWAg4oCUIEdpdEh1YidzIHNxdWFzaC1tZXJnZSBzdWJqZWN0LiAqL1xuY29uc3QgU1FVQVNIX0NPTU1JVF9TVUJKRUNUID0gL1xcKCMoXFxkKylcXClcXHMqJC87XG5cbi8qKiBBIGNvbW1pdCBTSEEgYXMgZ2l0IHByaW50cyBpdC4gKi9cbmNvbnN0IENPTU1JVF9TSEEgPSAvXlswLTlhLWZdezcsNjR9JC87XG5cbi8qKlxuICogVGhlIFBSIG51bWJlciBhIGJhc2UtYnJhbmNoIGNvbW1pdCBzdWJqZWN0IG5hbWVzLCBvciBgbnVsbGAuXG4gKlxuICogUmVjb2duaXNlcyBHaXRIdWIncyB0d28gbWVyZ2Ugc2hhcGVzIGFuZCBub3RoaW5nIGVsc2Ug4oCUIGBGaXggaXNzdWUgIzk5YFxuICogbmFtZXMgYW4gaXNzdWUsIG5vdCBhIFBSLCBhbmQgbXVzdCBub3QgYmUgcmVhZCBhcyBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwck51bWJlckZyb21Db21taXRTdWJqZWN0KHN1YmplY3Q6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtZXJnZSA9IE1FUkdFX0NPTU1JVF9TVUJKRUNULmV4ZWMoc3ViamVjdCk7XG4gIGNvbnN0IHNxdWFzaCA9IG1lcmdlID8gbnVsbCA6IFNRVUFTSF9DT01NSVRfU1VCSkVDVC5leGVjKHN1YmplY3QpO1xuICBjb25zdCBkaWdpdHMgPSBtZXJnZT8uWzFdID8/IHNxdWFzaD8uWzFdO1xuICBpZiAoZGlnaXRzID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICBjb25zdCBwck51bWJlciA9IE51bWJlcihkaWdpdHMpO1xuICByZXR1cm4gTnVtYmVyLmlzU2FmZUludGVnZXIocHJOdW1iZXIpICYmIHByTnVtYmVyID4gMCA/IHByTnVtYmVyIDogbnVsbDtcbn1cblxuLyoqIEEgUFIgYXMgYGdoIHByIHZpZXdgIHJlcG9ydHMgaXQuICovXG5pbnRlcmZhY2UgUHJWaWV3IHtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGJvZHk6IHN0cmluZztcbiAgLyoqIElzc3VlcyBHaXRIdWIgaXRzZWxmIGNvbnNpZGVycyB0aGlzIFBSIHRvIGNsb3NlLiAqL1xuICBjbG9zaW5nSXNzdWVzOiBudW1iZXJbXTtcbn1cblxuLyoqIFdoeSBhIGJvdW5kZWQgbG9va3VwIHByb2R1Y2VkIG5vdGhpbmcuICovXG5pbnRlcmZhY2UgTG9va3VwRmFpbHVyZSB7XG4gIC8qKiBUcnVlIHdoZW4gYSBib3VuZCBzdG9wcGVkIHRoZSBsb29rdXAsIGZhbHNlIHdoZW4gdGhlIGNhbGwgZmFpbGVkLiAqL1xuICBidWRnZXRFeGhhdXN0ZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBPdXRjb21lIG9mIGEgYm91bmRlZCBsb29rdXA6IHRoZSB2YWx1ZSwgb3Igd2h5IHRoZXJlIGlzIG5vbmUuICovXG50eXBlIExvb2t1cDxUPiA9IFJlc3VsdDxULCBMb29rdXBGYWlsdXJlPjtcblxuLyoqIE11dGFibGUgc3RhdGUgdGhyZWFkZWQgdGhyb3VnaCBvbmUgZ2F0aGVyLiAqL1xuaW50ZXJmYWNlIEdhdGhlclN0YXRlIHtcbiAgcmVwbzogc3RyaW5nO1xuICBnaDogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIGJvdW5kczogQ29uZmxpY3RJc3N1ZUNvbnRleHRCb3VuZHM7XG4gIGdoQ2FsbHNVc2VkOiBudW1iZXI7XG4gIHRleHRDaGFyc1VzZWQ6IG51bWJlcjtcbiAgd2FybmluZ3M6IHN0cmluZ1tdO1xuICB0cnVuY2F0aW9uOiBDb25mbGljdENvbnRleHRUcnVuY2F0aW9uO1xuICBpc3N1ZUNhY2hlOiBNYXA8bnVtYmVyLCBPcmlnaW5hdGluZ0lzc3VlPjtcbiAgcHJDYWNoZTogTWFwPG51bWJlciwgUHJWaWV3Pjtcbn1cblxuZnVuY3Rpb24gZXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuLyoqXG4gKiBSdW4gb25lIGBnaGAgY2FsbCBhZ2FpbnN0IHRoZSBidWRnZXQuXG4gKlxuICogQSBmYWlsdXJlIGlzIHJlY29yZGVkIGFzIGEgd2FybmluZyBhbmQgcmV0dXJuZWQgYXMgYG9rOiBmYWxzZWAg4oCUIG5ldmVyXG4gKiBzd2FsbG93ZWQgaW50byBhbiBlbXB0eSByZXN1bHQgdGhhdCByZWFkcyBhcyBcIm5vdGhpbmcgdG8gZmluZFwiLlxuICovXG5hc3luYyBmdW5jdGlvbiBydW5HaChcbiAgc3RhdGU6IEdhdGhlclN0YXRlLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgd2hhdDogc3RyaW5nLFxuKTogUHJvbWlzZTxMb29rdXA8c3RyaW5nPj4ge1xuICBpZiAoc3RhdGUuZ2hDYWxsc1VzZWQgPj0gc3RhdGUuYm91bmRzLm1heEdoQ2FsbHMpIHtcbiAgICBzdGF0ZS50cnVuY2F0aW9uLmdoQ2FsbENhcEhpdCA9IHRydWU7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogeyBidWRnZXRFeGhhdXN0ZWQ6IHRydWUgfSB9O1xuICB9XG4gIHN0YXRlLmdoQ2FsbHNVc2VkKys7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBhd2FpdCBzdGF0ZS5naChhcmdzKSB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHN0YXRlLndhcm5pbmdzLnB1c2goYCR7d2hhdH0gZmFpbGVkOiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCk7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogeyBidWRnZXRFeGhhdXN0ZWQ6IGZhbHNlIH0gfTtcbiAgfVxufVxuXG4vKiogVGFrZSBpc3N1ZSB0ZXh0IGZyb20gdGhlIHNoYXJlZCBjaGFyYWN0ZXIgYnVkZ2V0LCBjdXR0aW5nIGlmIG5lZWRlZC4gKi9cbmZ1bmN0aW9uIHRha2VJc3N1ZVRleHQoXG4gIHN0YXRlOiBHYXRoZXJTdGF0ZSxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgdGV4dDogc3RyaW5nLFxuKTogeyBib2R5OiBzdHJpbmc7IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgY29uc3QgcmVtYWluaW5nID0gTWF0aC5tYXgoXG4gICAgMCxcbiAgICBzdGF0ZS5ib3VuZHMubWF4SXNzdWVUZXh0Q2hhcnMgLSBzdGF0ZS50ZXh0Q2hhcnNVc2VkLFxuICApO1xuICBpZiAodGV4dC5sZW5ndGggPD0gcmVtYWluaW5nKSB7XG4gICAgc3RhdGUudGV4dENoYXJzVXNlZCArPSB0ZXh0Lmxlbmd0aDtcbiAgICByZXR1cm4geyBib2R5OiB0ZXh0LCB0cnVuY2F0ZWQ6IGZhbHNlIH07XG4gIH1cbiAgc3RhdGUudGV4dENoYXJzVXNlZCArPSByZW1haW5pbmc7XG4gIHN0YXRlLnRydW5jYXRpb24udGV4dFRydW5jYXRlZElzc3Vlcy5wdXNoKGlzc3VlTnVtYmVyKTtcbiAgcmV0dXJuIHsgYm9keTogdGV4dC5zbGljZSgwLCByZW1haW5pbmcpLCB0cnVuY2F0ZWQ6IHRydWUgfTtcbn1cblxuLyoqIEZldGNoIGFuIGlzc3VlJ3MgbnVtYmVyLCB0aXRsZSwgc3RhdGUgYW5kIGJvdW5kZWQgYm9keS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZldGNoSXNzdWUoXG4gIHN0YXRlOiBHYXRoZXJTdGF0ZSxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IFByb21pc2U8TG9va3VwPE9yaWdpbmF0aW5nSXNzdWU+PiB7XG4gIGNvbnN0IGNhY2hlZCA9IHN0YXRlLmlzc3VlQ2FjaGUuZ2V0KGlzc3VlTnVtYmVyKTtcbiAgaWYgKGNhY2hlZCkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBjYWNoZWQgfTtcblxuICBpZiAoc3RhdGUuaXNzdWVDYWNoZS5zaXplID49IHN0YXRlLmJvdW5kcy5tYXhJc3N1ZXMpIHtcbiAgICBzdGF0ZS50cnVuY2F0aW9uLmlzc3VlQ2FwSGl0ID0gdHJ1ZTtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiB7IGJ1ZGdldEV4aGF1c3RlZDogdHJ1ZSB9IH07XG4gIH1cblxuICBjb25zdCB3aGF0ID0gYGdoIGlzc3VlIHZpZXcgIyR7aXNzdWVOdW1iZXJ9YDtcbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgcnVuR2goc3RhdGUsIFtcbiAgICBcImlzc3VlXCIsXG4gICAgXCJ2aWV3XCIsXG4gICAgU3RyaW5nKGlzc3VlTnVtYmVyKSxcbiAgICBcIi0tcmVwb1wiLFxuICAgIHN0YXRlLnJlcG8sXG4gICAgXCItLWpzb25cIixcbiAgICBcIm51bWJlcix0aXRsZSxzdGF0ZSxib2R5XCIsXG4gIF0sIHdoYXQpO1xuICBpZiAoIW91dHB1dC5vaykgcmV0dXJuIG91dHB1dDtcblxuICBsZXQgcGFyc2VkOiB7IHRpdGxlPzogc3RyaW5nOyBzdGF0ZT86IHN0cmluZzsgYm9keT86IHN0cmluZyB9O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2Uob3V0cHV0LnZhbHVlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBzdGF0ZS53YXJuaW5ncy5wdXNoKFxuICAgICAgYCR7d2hhdH0gcmV0dXJuZWQgdW5wYXJzZWFibGUgSlNPTjogJHtlcnJvck1lc3NhZ2UoZXJyb3IpfWAsXG4gICAgKTtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiB7IGJ1ZGdldEV4aGF1c3RlZDogZmFsc2UgfSB9O1xuICB9XG5cbiAgY29uc3QgdGV4dCA9IHRha2VJc3N1ZVRleHQoc3RhdGUsIGlzc3VlTnVtYmVyLCBTdHJpbmcocGFyc2VkLmJvZHkgPz8gXCJcIikpO1xuICBjb25zdCBpc3N1ZTogT3JpZ2luYXRpbmdJc3N1ZSA9IHtcbiAgICBudW1iZXI6IGlzc3VlTnVtYmVyLFxuICAgIHRpdGxlOiBTdHJpbmcocGFyc2VkLnRpdGxlID8/IFwiXCIpLFxuICAgIHN0YXRlOiBTdHJpbmcocGFyc2VkLnN0YXRlID8/IFwiXCIpLFxuICAgIGJvZHk6IHRleHQuYm9keSxcbiAgICBib2R5VHJ1bmNhdGVkOiB0ZXh0LnRydW5jYXRlZCxcbiAgfTtcbiAgc3RhdGUuaXNzdWVDYWNoZS5zZXQoaXNzdWVOdW1iZXIsIGlzc3VlKTtcbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBpc3N1ZSB9O1xufVxuXG4vKipcbiAqIEZldGNoIGEgUFIncyB0aXRsZSwgYm9keSBhbmQgY2xvc2luZy1pc3N1ZSByZWZlcmVuY2VzIGluIG9uZSBjYWxsLlxuICpcbiAqIENhY2hlZCBmb3IgdGhlIGdhdGhlcjogb25lIGJhc2UgUFIgY29tbW9ubHkgdG91Y2hlcyBzZXZlcmFsIGNvbmZsaWN0ZWRcbiAqIHBhdGhzLCBhbmQgcmUtdmlld2luZyBpdCBwZXIgcGF0aCB3b3VsZCBzcGVuZCB0aGUgYGdoYCBidWRnZXQgb24gcmVwZWF0cy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZmV0Y2hQclZpZXcoXG4gIHN0YXRlOiBHYXRoZXJTdGF0ZSxcbiAgcHJOdW1iZXI6IG51bWJlcixcbik6IFByb21pc2U8TG9va3VwPFByVmlldz4+IHtcbiAgY29uc3QgY2FjaGVkID0gc3RhdGUucHJDYWNoZS5nZXQocHJOdW1iZXIpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGNhY2hlZCB9O1xuXG4gIGNvbnN0IHdoYXQgPSBgZ2ggcHIgdmlldyAjJHtwck51bWJlcn1gO1xuICBjb25zdCBvdXRwdXQgPSBhd2FpdCBydW5HaChzdGF0ZSwgW1xuICAgIFwicHJcIixcbiAgICBcInZpZXdcIixcbiAgICBTdHJpbmcocHJOdW1iZXIpLFxuICAgIFwiLS1yZXBvXCIsXG4gICAgc3RhdGUucmVwbyxcbiAgICBcIi0tanNvblwiLFxuICAgIFwibnVtYmVyLHRpdGxlLGJvZHksY2xvc2luZ0lzc3Vlc1JlZmVyZW5jZXNcIixcbiAgXSwgd2hhdCk7XG4gIGlmICghb3V0cHV0Lm9rKSByZXR1cm4gb3V0cHV0O1xuXG4gIGxldCBwYXJzZWQ6IHtcbiAgICB0aXRsZT86IHN0cmluZztcbiAgICBib2R5Pzogc3RyaW5nO1xuICAgIGNsb3NpbmdJc3N1ZXNSZWZlcmVuY2VzPzogQXJyYXk8eyBudW1iZXI/OiBudW1iZXIgfT47XG4gIH07XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShvdXRwdXQudmFsdWUpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHN0YXRlLndhcm5pbmdzLnB1c2goXG4gICAgICBgJHt3aGF0fSByZXR1cm5lZCB1bnBhcnNlYWJsZSBKU09OOiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCxcbiAgICApO1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHsgYnVkZ2V0RXhoYXVzdGVkOiBmYWxzZSB9IH07XG4gIH1cblxuICBjb25zdCBjbG9zaW5nSXNzdWVzOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJlZmVyZW5jZSBvZiBwYXJzZWQuY2xvc2luZ0lzc3Vlc1JlZmVyZW5jZXMgPz8gW10pIHtcbiAgICBjb25zdCBudW1iZXIgPSByZWZlcmVuY2U/Lm51bWJlcjtcbiAgICBpZiAoXG4gICAgICB0eXBlb2YgbnVtYmVyID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc1NhZmVJbnRlZ2VyKG51bWJlcikgJiZcbiAgICAgIG51bWJlciA+IDAgJiYgIWNsb3NpbmdJc3N1ZXMuaW5jbHVkZXMobnVtYmVyKVxuICAgICkge1xuICAgICAgY2xvc2luZ0lzc3Vlcy5wdXNoKG51bWJlcik7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgdmlldzogUHJWaWV3ID0ge1xuICAgIG51bWJlcjogcHJOdW1iZXIsXG4gICAgdGl0bGU6IFN0cmluZyhwYXJzZWQudGl0bGUgPz8gXCJcIiksXG4gICAgYm9keTogU3RyaW5nKHBhcnNlZC5ib2R5ID8/IFwiXCIpLFxuICAgIGNsb3NpbmdJc3N1ZXMsXG4gIH07XG4gIHN0YXRlLnByQ2FjaGUuc2V0KHByTnVtYmVyLCB2aWV3KTtcbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB2aWV3IH07XG59XG5cbi8qKiBUdXJuIGEgYm91bmRlZC1sb29rdXAgZmFpbHVyZSBpbnRvIHRoZSBtYXRjaGluZyBQUi1zaWRlIHJlYXNvbi4gKi9cbmZ1bmN0aW9uIHByUmVhc29uRm9yKGJ1ZGdldEV4aGF1c3RlZDogYm9vbGVhbik6IFByVW5yZXNvbHZlZFJlYXNvbiB7XG4gIHJldHVybiBidWRnZXRFeGhhdXN0ZWQgPyBcImJ1ZGdldC1leGhhdXN0ZWRcIiA6IFwibG9va3VwLWZhaWxlZFwiO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIFBSIHNpZGUsIGluIHByZWNlZGVuY2Ugb3JkZXI6IHRoZSBgaXNzdWUtPG4+LeKApmAgYnJhbmNoIHNoYXBlLFxuICogdGhlbiB0aGUgYm9keSdzIGNsb3Npbmcga2V5d29yZHMsIHRoZW4gR2l0SHViJ3Mgb3duIGxpbmthZ2UuIEZpcnN0IGhpdFxuICogd2lucywgYW5kIHRoZSB3aW5uaW5nIHNpZ25hbCBpcyByZWNvcmRlZC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVByU2lkZShcbiAgc3RhdGU6IEdhdGhlclN0YXRlLFxuICByZXF1ZXN0OiBDb25mbGljdElzc3VlQ29udGV4dFJlcXVlc3QsXG4pOiBQcm9taXNlPFByU2lkZU9yaWdpbj4ge1xuICBjb25zdCBmaW5pc2ggPSBhc3luYyAoXG4gICAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgICBzaWduYWw6IFByT3JpZ2luU2lnbmFsLFxuICApOiBQcm9taXNlPFByU2lkZU9yaWdpbj4gPT4ge1xuICAgIGNvbnN0IGlzc3VlID0gYXdhaXQgZmV0Y2hJc3N1ZShzdGF0ZSwgaXNzdWVOdW1iZXIpO1xuICAgIHJldHVybiBpc3N1ZS5va1xuICAgICAgPyB7IHJlc29sdmVkOiB0cnVlLCBzaWduYWwsIGlzc3VlOiBpc3N1ZS52YWx1ZSB9XG4gICAgICA6IHsgcmVzb2x2ZWQ6IGZhbHNlLCByZWFzb246IHByUmVhc29uRm9yKGlzc3VlLmVycm9yLmJ1ZGdldEV4aGF1c3RlZCkgfTtcbiAgfTtcblxuICAvLyAxLiBUaGUgYnJhbmNoIHNoYXBlIOKAlCBmcmVlLCBhbmQgdGhlIHdvcmtlcidzIG93biBjb252ZW50aW9uLlxuICBjb25zdCBicmFuY2hJc3N1ZSA9IGlzc3VlTnVtYmVyRnJvbUJyYW5jaChyZXF1ZXN0LnByQnJhbmNoKTtcbiAgaWYgKGJyYW5jaElzc3VlICE9PSBudWxsKSByZXR1cm4gYXdhaXQgZmluaXNoKGJyYW5jaElzc3VlLCBcImJyYW5jaFwiKTtcblxuICAvLyBUaGUgYm9keSBhbmQgdGhlIGxpbmthZ2UgYm90aCBjb21lIGZyb20gb25lIFBSIHZpZXcuXG4gIGxldCB2aWV3OiBQclZpZXcgfCBudWxsID0gbnVsbDtcbiAgaWYgKHJlcXVlc3QucHJCb2R5ID09PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBmZXRjaGVkID0gYXdhaXQgZmV0Y2hQclZpZXcoc3RhdGUsIHJlcXVlc3QucHJOdW1iZXIpO1xuICAgIGlmICghZmV0Y2hlZC5vaykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVzb2x2ZWQ6IGZhbHNlLFxuICAgICAgICByZWFzb246IHByUmVhc29uRm9yKGZldGNoZWQuZXJyb3IuYnVkZ2V0RXhoYXVzdGVkKSxcbiAgICAgIH07XG4gICAgfVxuICAgIHZpZXcgPSBmZXRjaGVkLnZhbHVlO1xuICB9XG5cbiAgLy8gMi4gVGhlIGJvZHkncyBjbG9zaW5nIGtleXdvcmRzLlxuICBjb25zdCBib2R5SXNzdWUgPSBleHRyYWN0Q2xvc2luZ0lzc3VlTnVtYmVycyhyZXF1ZXN0LnByQm9keSA/PyB2aWV3IS5ib2R5KVswXTtcbiAgaWYgKGJvZHlJc3N1ZSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gYXdhaXQgZmluaXNoKGJvZHlJc3N1ZSwgXCJib2R5XCIpO1xuXG4gIC8vIDMuIEdpdEh1YidzIG93biBsaW5rYWdlLlxuICBpZiAodmlldyA9PT0gbnVsbCkge1xuICAgIGNvbnN0IGZldGNoZWQgPSBhd2FpdCBmZXRjaFByVmlldyhzdGF0ZSwgcmVxdWVzdC5wck51bWJlcik7XG4gICAgaWYgKCFmZXRjaGVkLm9rKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICByZXNvbHZlZDogZmFsc2UsXG4gICAgICAgIHJlYXNvbjogcHJSZWFzb25Gb3IoZmV0Y2hlZC5lcnJvci5idWRnZXRFeGhhdXN0ZWQpLFxuICAgICAgfTtcbiAgICB9XG4gICAgdmlldyA9IGZldGNoZWQudmFsdWU7XG4gIH1cbiAgY29uc3QgbGlua2VkSXNzdWUgPSB2aWV3LmNsb3NpbmdJc3N1ZXNbMF07XG4gIGlmIChsaW5rZWRJc3N1ZSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gYXdhaXQgZmluaXNoKGxpbmtlZElzc3VlLCBcImxpbmthZ2VcIik7XG5cbiAgcmV0dXJuIHsgcmVzb2x2ZWQ6IGZhbHNlLCByZWFzb246IFwibm8tc2lnbmFsXCIgfTtcbn1cblxuLyoqIFRoZSBtZXJnZSBiYXNlIHRvIHdhbGsgdGhlIGJhc2UgYnJhbmNoIGZyb20uICovXG5pbnRlcmZhY2UgQmFzZVdhbGtBbmNob3Ige1xuICBtZXJnZUJhc2U6IHN0cmluZztcbiAgYmFzZVJlZjogc3RyaW5nO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIG1lcmdlIGJhc2Ugb2YgdGhlIFBSIGJyYW5jaCBhbmQgdGhlIGJhc2UgYnJhbmNoLlxuICpcbiAqIFJldHVybnMgYG51bGxgIOKAlCB3aXRoIGEgd2FybmluZyBuYW1pbmcgdGhlIGNhdXNlIOKAlCB3aGVuIHRoZSB3YWxrIGNhbm5vdFxuICogc3RhcnQuIEV2ZXJ5IGNhbGxlciB0dXJucyB0aGF0IGludG8gYW4gZXhwbGljaXQgcGVyLXBhdGhcbiAqIGBcIm1lcmdlLWJhc2UtdW5hdmFpbGFibGVcImAgcmF0aGVyIHRoYW4gYW4gZW1wdHkgYmFzZSBzaWRlLlxuICovXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQmFzZVdhbGtBbmNob3IoXG4gIHN0YXRlOiBHYXRoZXJTdGF0ZSxcbiAgcmVxdWVzdDogQ29uZmxpY3RJc3N1ZUNvbnRleHRSZXF1ZXN0LFxuICBnaXQ6IEdpdFJ1bm5lcixcbik6IFByb21pc2U8QmFzZVdhbGtBbmNob3IgfCBudWxsPiB7XG4gIGNvbnN0IGN3ZCA9IHJlcXVlc3QuY3dkO1xuICBjb25zdCByZXNvbHZlUmVmID0gYXN5bmMgKGJyYW5jaDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgcmVzb2x2ZUNvbXBhcmFibGVCYXNlUmVmKGdpdCwgYnJhbmNoLCB7IGN3ZCB9KTtcbiAgICAgIGlmIChyZXNvbHZlZC5vaykgcmV0dXJuIHJlc29sdmVkLnZhbHVlO1xuICAgICAgc3RhdGUud2FybmluZ3MucHVzaChcbiAgICAgICAgYG1lcmdlIGJhc2Ugd2FsayBza2lwcGVkOiAke3Jlc29sdmVkLmVycm9yLm1lc3NhZ2V9YCxcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHN0YXRlLndhcm5pbmdzLnB1c2goXG4gICAgICAgIGBtZXJnZSBiYXNlIHdhbGsgc2tpcHBlZDogJyR7YnJhbmNofScgaXMgbm90IGEgdXNhYmxlIHJlZiAoJHtcbiAgICAgICAgICBlcnJvck1lc3NhZ2UoZXJyb3IpXG4gICAgICAgIH0pYCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9O1xuXG4gIGNvbnN0IGJhc2VSZWYgPSBhd2FpdCByZXNvbHZlUmVmKHJlcXVlc3QuYmFzZUJyYW5jaCk7XG4gIGlmIChiYXNlUmVmID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgaGVhZFJlZiA9IGF3YWl0IHJlc29sdmVSZWYocmVxdWVzdC5wckJyYW5jaCk7XG4gIGlmIChoZWFkUmVmID09PSBudWxsKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBnaXQoW1wibWVyZ2UtYmFzZVwiLCBiYXNlUmVmLCBoZWFkUmVmXSwgeyBjd2QgfSk7XG4gIGNvbnN0IHNoYSA9IHJlc3VsdC5vayA/IHJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpIDogXCJcIjtcbiAgaWYgKCFyZXN1bHQub2sgfHwgcmVzdWx0LnZhbHVlLmNvZGUgIT09IDAgfHwgIUNPTU1JVF9TSEEudGVzdChzaGEpKSB7XG4gICAgY29uc3QgZGV0YWlsID0gcmVzdWx0Lm9rXG4gICAgICA/IGBleGl0ICR7cmVzdWx0LnZhbHVlLmNvZGV9OiAke3Jlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpfWBcbiAgICAgIDogcmVzdWx0LmVycm9yLm1lc3NhZ2U7XG4gICAgc3RhdGUud2FybmluZ3MucHVzaChcbiAgICAgIGBubyBtZXJnZSBiYXNlIGJldHdlZW4gJyR7YmFzZVJlZn0nIGFuZCAnJHtoZWFkUmVmfScgKCR7ZGV0YWlsfSlgLFxuICAgICk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIHsgbWVyZ2VCYXNlOiBzaGEsIGJhc2VSZWYgfTtcbn1cblxuLyoqIEFuIHVucmVzb2x2ZWQgYmFzZS1zaWRlIGVudHJ5IOKAlCBhYnNlbmNlIHN0YXRlZCwgbmV2ZXIgc2lsZW5jZS4gKi9cbmZ1bmN0aW9uIHVucmVzb2x2ZWRQYXRoKFxuICBwYXRoOiBzdHJpbmcsXG4gIHJlYXNvbjogQmFzZVVucmVzb2x2ZWRSZWFzb24sXG4gIGNvbW1pdHNJbnNwZWN0ZWQgPSAwLFxuICBwck51bWJlcnM6IG51bWJlcltdID0gW10sXG4pOiBCYXNlUGF0aE9yaWdpbiB7XG4gIHJldHVybiB7XG4gICAgcGF0aCxcbiAgICBjb21taXRzSW5zcGVjdGVkLFxuICAgIHByTnVtYmVycyxcbiAgICBpc3N1ZXM6IFtdLFxuICAgIHVucmVzb2x2ZWQ6IHJlYXNvbixcbiAgICBwYXJ0aWFsOiBmYWxzZSxcbiAgfTtcbn1cblxuLyoqIEJhc2UgY29tbWl0cyB0b3VjaGluZyBvbmUgcGF0aCBzaW5jZSB0aGUgbWVyZ2UgYmFzZSwgYm91bmRlZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGluc3BlY3RQYXRoQ29tbWl0cyhcbiAgc3RhdGU6IEdhdGhlclN0YXRlLFxuICByZXF1ZXN0OiBDb25mbGljdElzc3VlQ29udGV4dFJlcXVlc3QsXG4gIGdpdDogR2l0UnVubmVyLFxuICBhbmNob3I6IEJhc2VXYWxrQW5jaG9yLFxuICBwYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPExvb2t1cDx7IHN1YmplY3RzOiBzdHJpbmdbXSB9Pj4ge1xuICBjb25zdCBjYXAgPSBzdGF0ZS5ib3VuZHMubWF4Q29tbWl0c1BlclBhdGg7XG4gIC8vIE9uZSBtb3JlIHRoYW4gdGhlIGNhcCwgc28gXCJjYXBwZWRcIiBpcyBhIGZhY3QgcmF0aGVyIHRoYW4gYSBndWVzcy5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ2l0KFtcbiAgICBcImxvZ1wiLFxuICAgIFwiLS1maXJzdC1wYXJlbnRcIixcbiAgICBgLS1tYXgtY291bnQ9JHtjYXAgKyAxfWAsXG4gICAgYC0tZm9ybWF0PSVIJXgxZiVzYCxcbiAgICBgJHthbmNob3IubWVyZ2VCYXNlfS4uJHthbmNob3IuYmFzZVJlZn1gLFxuICAgIFwiLS1cIixcbiAgICBwYXRoLFxuICBdLCB7IGN3ZDogcmVxdWVzdC5jd2QgfSk7XG5cbiAgaWYgKCFyZXN1bHQub2sgfHwgcmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICBjb25zdCBkZXRhaWwgPSByZXN1bHQub2tcbiAgICAgID8gYGV4aXQgJHtyZXN1bHQudmFsdWUuY29kZX06ICR7cmVzdWx0LnZhbHVlLnN0ZGVyci50cmltKCl9YFxuICAgICAgOiByZXN1bHQuZXJyb3IubWVzc2FnZTtcbiAgICBzdGF0ZS53YXJuaW5ncy5wdXNoKGBnaXQgbG9nIGZhaWxlZCBmb3IgJyR7cGF0aH0nICgke2RldGFpbH0pYCk7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogeyBidWRnZXRFeGhhdXN0ZWQ6IGZhbHNlIH0gfTtcbiAgfVxuXG4gIGNvbnN0IGxpbmVzID0gcmVzdWx0LnZhbHVlLnN0ZG91dFxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuICAgIC5maWx0ZXIoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCk7XG5cbiAgaWYgKGxpbmVzLmxlbmd0aCA+IGNhcCkgc3RhdGUudHJ1bmNhdGlvbi5jb21taXRDYXBQYXRocy5wdXNoKHBhdGgpO1xuXG4gIGNvbnN0IHN1YmplY3RzID0gbGluZXMuc2xpY2UoMCwgY2FwKS5tYXAoKGxpbmUpID0+IHtcbiAgICBjb25zdCBzZXBhcmF0b3IgPSBsaW5lLmluZGV4T2YoTE9HX0ZJRUxEX1NFUEFSQVRPUik7XG4gICAgcmV0dXJuIHNlcGFyYXRvciA8IDAgPyBsaW5lIDogbGluZS5zbGljZShzZXBhcmF0b3IgKyAxKTtcbiAgfSk7XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBzdWJqZWN0cyB9IH07XG59XG5cbi8qKiBSZXNvbHZlIHRoZSBiYXNlIHNpZGUgZm9yIG9uZSBjb25mbGljdGVkIHBhdGguICovXG5hc3luYyBmdW5jdGlvbiBnYXRoZXJQYXRoT3JpZ2luKFxuICBzdGF0ZTogR2F0aGVyU3RhdGUsXG4gIHJlcXVlc3Q6IENvbmZsaWN0SXNzdWVDb250ZXh0UmVxdWVzdCxcbiAgZ2l0OiBHaXRSdW5uZXIsXG4gIGFuY2hvcjogQmFzZVdhbGtBbmNob3IsXG4gIHBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8QmFzZVBhdGhPcmlnaW4+IHtcbiAgY29uc3QgY29tbWl0cyA9IGF3YWl0IGluc3BlY3RQYXRoQ29tbWl0cyhzdGF0ZSwgcmVxdWVzdCwgZ2l0LCBhbmNob3IsIHBhdGgpO1xuICBpZiAoIWNvbW1pdHMub2spIHJldHVybiB1bnJlc29sdmVkUGF0aChwYXRoLCBcImdpdC1lcnJvclwiKTtcblxuICBjb25zdCBzdWJqZWN0cyA9IGNvbW1pdHMudmFsdWUuc3ViamVjdHM7XG4gIGlmIChzdWJqZWN0cy5sZW5ndGggPT09IDApIHJldHVybiB1bnJlc29sdmVkUGF0aChwYXRoLCBcIm5vLWNvbW1pdHNcIik7XG5cbiAgY29uc3QgcHJOdW1iZXJzOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHN1YmplY3Qgb2Ygc3ViamVjdHMpIHtcbiAgICBjb25zdCBwck51bWJlciA9IHByTnVtYmVyRnJvbUNvbW1pdFN1YmplY3Qoc3ViamVjdCk7XG4gICAgaWYgKHByTnVtYmVyICE9PSBudWxsICYmICFwck51bWJlcnMuaW5jbHVkZXMocHJOdW1iZXIpKSB7XG4gICAgICBwck51bWJlcnMucHVzaChwck51bWJlcik7XG4gICAgfVxuICB9XG4gIGlmIChwck51bWJlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHVucmVzb2x2ZWRQYXRoKHBhdGgsIFwibm8tcHJcIiwgc3ViamVjdHMubGVuZ3RoKTtcbiAgfVxuXG4gIGNvbnN0IGlzc3VlczogT3JpZ2luYXRpbmdJc3N1ZVtdID0gW107XG4gIGxldCBidWRnZXRFeGhhdXN0ZWQgPSBmYWxzZTtcbiAgbGV0IGxvb2t1cEZhaWxlZCA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgcHJOdW1iZXIgb2YgcHJOdW1iZXJzKSB7XG4gICAgY29uc3QgdmlldyA9IGF3YWl0IGZldGNoUHJWaWV3KHN0YXRlLCBwck51bWJlcik7XG4gICAgaWYgKCF2aWV3Lm9rKSB7XG4gICAgICBpZiAodmlldy5lcnJvci5idWRnZXRFeGhhdXN0ZWQpIHtcbiAgICAgICAgYnVkZ2V0RXhoYXVzdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBsb29rdXBGYWlsZWQgPSB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gR2l0SHViJ3MgbGlua2FnZSBmaXJzdCwgdGhlbiB0aGUgYm9keSdzIGNsb3Npbmcga2V5d29yZHMg4oCUIHRoZSBzYW1lIHR3b1xuICAgIC8vIHNpZ25hbHMgdGhlIFBSIHNpZGUgdXNlcy4gVGhlIFBSICp0aXRsZSogaXMgZGVsaWJlcmF0ZWx5IG5vdCBjb25zdWx0ZWQ6XG4gICAgLy8gYSB0cmFpbGluZyBgKCNOKWAgaXMgdGhlIFBSJ3Mgb3duIG51bWJlciBpbiBhIHNxdWFzaCBzdWJqZWN0IGFuZCB0aGVcbiAgICAvLyBpc3N1ZSBudW1iZXIgaW4gYSB3b3JrZXIgUFIgdGl0bGUsIGFuZCBhIHdyb25nIG9yaWdpbmF0aW5nIGlzc3VlIGlzXG4gICAgLy8gd29yc2UgdGhhbiBub25lLlxuICAgIGNvbnN0IGlzc3VlTnVtYmVycyA9IHZpZXcudmFsdWUuY2xvc2luZ0lzc3Vlcy5sZW5ndGggPiAwXG4gICAgICA/IHZpZXcudmFsdWUuY2xvc2luZ0lzc3Vlc1xuICAgICAgOiBleHRyYWN0Q2xvc2luZ0lzc3VlTnVtYmVycyh2aWV3LnZhbHVlLmJvZHkpO1xuXG4gICAgZm9yIChjb25zdCBpc3N1ZU51bWJlciBvZiBpc3N1ZU51bWJlcnMpIHtcbiAgICAgIGNvbnN0IGlzc3VlID0gYXdhaXQgZmV0Y2hJc3N1ZShzdGF0ZSwgaXNzdWVOdW1iZXIpO1xuICAgICAgaWYgKCFpc3N1ZS5vaykge1xuICAgICAgICBpZiAoaXNzdWUuZXJyb3IuYnVkZ2V0RXhoYXVzdGVkKSB7XG4gICAgICAgICAgYnVkZ2V0RXhoYXVzdGVkID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICBsb29rdXBGYWlsZWQgPSB0cnVlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmICghaXNzdWVzLnNvbWUoKGtub3duKSA9PiBrbm93bi5udW1iZXIgPT09IGlzc3VlTnVtYmVyKSkge1xuICAgICAgICBpc3N1ZXMucHVzaChpc3N1ZS52YWx1ZSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChidWRnZXRFeGhhdXN0ZWQpIGJyZWFrO1xuICB9XG5cbiAgaWYgKGlzc3Vlcy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGgsXG4gICAgICBjb21taXRzSW5zcGVjdGVkOiBzdWJqZWN0cy5sZW5ndGgsXG4gICAgICBwck51bWJlcnMsXG4gICAgICBpc3N1ZXMsXG4gICAgICB1bnJlc29sdmVkOiBudWxsLFxuICAgICAgLy8gU29tZSBpc3N1ZXMgcmVzb2x2ZWQgYW5kIHNvbWUgZGlkIG5vdDogdGhlIGxpc3QgaXMgc2hvcnQsIGFuZCBzYXlpbmdcbiAgICAgIC8vIHNvIGhlcmUgaXMgd2hhdCBzdG9wcyBhIHBhcnRpYWwgYW5zd2VyIHJlYWRpbmcgYXMgYSB3aG9sZSBvbmUuXG4gICAgICBwYXJ0aWFsOiBidWRnZXRFeGhhdXN0ZWQgfHwgbG9va3VwRmFpbGVkLFxuICAgIH07XG4gIH1cblxuICBjb25zdCByZWFzb246IEJhc2VVbnJlc29sdmVkUmVhc29uID0gYnVkZ2V0RXhoYXVzdGVkXG4gICAgPyBcImJ1ZGdldC1leGhhdXN0ZWRcIlxuICAgIDogbG9va3VwRmFpbGVkXG4gICAgPyBcImxvb2t1cC1mYWlsZWRcIlxuICAgIDogXCJuby1pc3N1ZVwiO1xuICByZXR1cm4gdW5yZXNvbHZlZFBhdGgocGF0aCwgcmVhc29uLCBzdWJqZWN0cy5sZW5ndGgsIHByTnVtYmVycyk7XG59XG5cbi8qKlxuICogR2F0aGVyIHRoZSBvcmlnaW5hdGluZy1pc3N1ZSBjb250ZXh0IGZvciBib3RoIHNpZGVzIG9mIGEgY29uZmxpY3RpbmcgUFIuXG4gKlxuICogTmV2ZXIgdGhyb3dzIGFuZCBuZXZlciByZXR1cm5zIGEgYmFyZSBlbXB0eSByZXN1bHQ6IGV2ZXJ5IHNpZGUgZWl0aGVyIG5hbWVzXG4gKiBpdHMgaXNzdWVzIG9yIHN0YXRlcyB3aHkgaXQgaGFzIG5vbmUsIGFuZCBldmVyeSBib3VuZCB0aGF0IGJpdCBpcyBkZWNsYXJlZFxuICogaW4ge0BsaW5rIENvbmZsaWN0SXNzdWVDb250ZXh0LnRydW5jYXRpb259LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2F0aGVyQ29uZmxpY3RJc3N1ZUNvbnRleHQoXG4gIHJlcXVlc3Q6IENvbmZsaWN0SXNzdWVDb250ZXh0UmVxdWVzdCxcbiAgZGVwczogQ29uZmxpY3RJc3N1ZUNvbnRleHREZXBzLFxuKTogUHJvbWlzZTxDb25mbGljdElzc3VlQ29udGV4dD4ge1xuICBjb25zdCBzdGF0ZTogR2F0aGVyU3RhdGUgPSB7XG4gICAgcmVwbzogcmVxdWVzdC5yZXBvLFxuICAgIGdoOiBkZXBzLmdoLFxuICAgIGJvdW5kczogeyAuLi5ERUZBVUxUX0NPTkZMSUNUX0lTU1VFX0NPTlRFWFRfQk9VTkRTLCAuLi5kZXBzLmJvdW5kcyB9LFxuICAgIGdoQ2FsbHNVc2VkOiAwLFxuICAgIHRleHRDaGFyc1VzZWQ6IDAsXG4gICAgd2FybmluZ3M6IFtdLFxuICAgIHRydW5jYXRpb246IHtcbiAgICAgIGNvbW1pdENhcFBhdGhzOiBbXSxcbiAgICAgIGlzc3VlQ2FwSGl0OiBmYWxzZSxcbiAgICAgIHRleHRUcnVuY2F0ZWRJc3N1ZXM6IFtdLFxuICAgICAgZ2hDYWxsQ2FwSGl0OiBmYWxzZSxcbiAgICB9LFxuICAgIGlzc3VlQ2FjaGU6IG5ldyBNYXAoKSxcbiAgICBwckNhY2hlOiBuZXcgTWFwKCksXG4gIH07XG5cbiAgY29uc3QgcHJTaWRlID0gYXdhaXQgcmVzb2x2ZVByU2lkZShzdGF0ZSwgcmVxdWVzdCk7XG5cbiAgY29uc3QgcGF0aHM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcGF0aCBvZiByZXF1ZXN0LmNvbmZsaWN0ZWRQYXRocykge1xuICAgIGlmIChwYXRoLmxlbmd0aCA+IDAgJiYgIXBhdGhzLmluY2x1ZGVzKHBhdGgpKSBwYXRocy5wdXNoKHBhdGgpO1xuICB9XG5cbiAgY29uc3QgYmFzZVNpZGU6IEJhc2VQYXRoT3JpZ2luW10gPSBbXTtcbiAgaWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBhbmNob3IgPSBhd2FpdCByZXNvbHZlQmFzZVdhbGtBbmNob3Ioc3RhdGUsIHJlcXVlc3QsIGRlcHMuZ2l0KTtcbiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHtcbiAgICAgIGJhc2VTaWRlLnB1c2goXG4gICAgICAgIGFuY2hvciA9PT0gbnVsbFxuICAgICAgICAgID8gdW5yZXNvbHZlZFBhdGgocGF0aCwgXCJtZXJnZS1iYXNlLXVuYXZhaWxhYmxlXCIpXG4gICAgICAgICAgOiBhd2FpdCBnYXRoZXJQYXRoT3JpZ2luKHN0YXRlLCByZXF1ZXN0LCBkZXBzLmdpdCwgYW5jaG9yLCBwYXRoKSxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICByZXBvOiByZXF1ZXN0LnJlcG8sXG4gICAgcHJOdW1iZXI6IHJlcXVlc3QucHJOdW1iZXIsXG4gICAgcHJTaWRlLFxuICAgIGJhc2VTaWRlLFxuICAgIHRydW5jYXRpb246IHN0YXRlLnRydW5jYXRpb24sXG4gICAgZ2hDYWxsc1VzZWQ6IHN0YXRlLmdoQ2FsbHNVc2VkLFxuICAgIHdhcm5pbmdzOiBzdGF0ZS53YXJuaW5ncyxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXdDQyxHQUdELFNBQXlCLHdCQUF3QixRQUFRLG9CQUFvQjtBQUM3RSxTQUFTLHFCQUFxQixRQUFRLCtCQUErQjtBQUNyRSxTQUFTLDBCQUEwQixRQUFRLGVBQWU7QUE0RzFEOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLE1BQU0sd0NBQ1g7RUFDRSxtQkFBbUI7RUFDbkIsV0FBVztFQUNYLG1CQUFtQjtFQUNuQixZQUFZO0FBQ2QsRUFBRTtBQThCSiwwRUFBMEUsR0FDMUUsTUFBTSxzQkFBc0I7QUFFNUIscUVBQXFFLEdBQ3JFLE1BQU0sdUJBQXVCO0FBRTdCLHdEQUF3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
// denoCacheMetadata=9693461898206550097,2292184754760018345