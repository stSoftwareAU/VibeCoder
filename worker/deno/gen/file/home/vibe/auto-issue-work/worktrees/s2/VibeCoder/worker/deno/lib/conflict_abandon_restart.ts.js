/**
 * Abandon-and-restart — the last automatic rung of the merge-conflict
 * escalation ladder (Issue #1115, parent #1076).
 *
 * Two intent-aware merge attempts have concluded and failed. Before #1115 the
 * ladder ended there, at `needs-human`. A branch that has diverged far enough
 * to defeat two real merges is usually cheaper to **redo** than to reconcile,
 * and redoing it needs no human: the conflicting PR is closed with an
 * explanatory comment and its originating issue is re-queued, so the pipeline
 * raises a fresh PR off the current base. There is no restart cap and no
 * further rung after this one — the ladder ends here, and every redo starts
 * clean (Issue #3033).
 *
 * **"Start again" never means force-push.** The abandoned PR is *closed*, not
 * merged, and its branch is left alone — a regenerated branch force-pushed
 * over the same PR would destroy its commits and its review history, which is
 * the same class of harm as the side-picking the conflict contract forbids
 * (#1076). Closing and re-raising keeps the abandoned work readable and
 * linked; branch cleanup owns the branch's lifecycle from here
 * (`branch_cleanup.ts`).
 *
 * **Preconditions are checked before anything is destroyed.** The order below
 * is the safety property, not an implementation detail:
 *
 * 0. the shared {@link CONFLICT_RESOLUTION_BUDGET} has actually been spent —
 *    `failedAttempts < CONFLICT_RESOLUTION_BUDGET` declines the abandon
 *    outright, before anything else runs (Issue #3000). The stale-verdict
 *    ladder's own rung-failed count used to be the only gate standing between
 *    a single judged attempt and a close-and-redo; this reads the same
 *    PR-side tally {@link spentConflictAttempts} does, so abandon-and-redo
 *    never runs ahead of the budget it is supposed to follow. Exempt: a
 *    `stalled` reason (the stall-repair pass's second trip, Issue #2802) is
 *    not a conflict-resolution outcome at all and has its own two-trip bound;
 * 1. the PR's originating issue is known — and when it is not, the PR is still
 *    closed, but only after the `merge-fallback` flag issue has been filed as
 *    the re-do item, carrying `idle-task` and the PR's diff summary
 *    (Issue #2310). The rule this replaces was "no issue, no abandon", on the
 *    grounds that closing a PR the fleet cannot re-raise loses the work; the
 *    reasoning holds, and the flag is what the fleet re-raises from. What is
 *    forbidden is closing with **no findable record**, so a flag that could not
 *    be filed leaves the PR open naming the `fallback-flag` step;
 * 2. there is no cap on how many times the issue may be restarted
 *    (Issue #3033). The first fresh PR is raised off a base that has often
 *    moved again by the time it conflicts, and every further redo is the same
 *    bet — a PR that conflicts repeatedly is never handed to a human; it is
 *    simply redone again. Only a claim naming **this** PR declines the
 *    abandon: it means an earlier abandon of this very PR claimed the restart
 *    and did not finish, and closing it twice is not a retry. The claim
 *    counts only when a **fleet account** wrote it (Issue #1247): a comment
 *    body is text any GitHub account may write, and both directions were
 *    exploitable — an outsider's restart marker stalled the rung for ever,
 *    and outsider failure markers on the PR thread spent the budget that
 *    brings the rung here at all. A claim whose author cannot be established
 *    refuses the abandon, and the next pass retries it, rather than relaxing
 *    that check;
 * 3. the issue has no *other* PR of its own.
 *
 * **The re-queue never costs the issue its place in the queue** (Issue #2277).
 * A pickup label the issue already carries is kept exactly as it is — a
 * `top-priority` issue restarted as `work-on` would be demoted by its own
 * fix — and an issue carrying none gains `idle-task`, the one pickup label
 * `worker_label_guard.ts` lets the worker apply. `needs-human` is never part
 * of this route: #1773 sent an issue there because the worker may not apply
 * `work-on`, but `idle-task` re-queues it without a human at all.
 *
 * **The redo starts on a fresh branch, never a resumed one.** The re-queued
 * issue's next run cuts its branch from the base branch's then-current tip;
 * its setup phase skips any branch named in a trusted restart marker on the
 * issue, so it never resumes the abandoned head (see
 * `lib/conflict_redo_branch.ts`).
 *
 * The restart marker is recorded **on the issue**, not on the PR: the PR being
 * counted is closed moments later and a new one takes its place, so a PR-keyed
 * marker would pass a single-cycle test and loop in production. It is posted
 * *before* the close for the same reason the attempt marker is posted before
 * the merge — it is the claim two hosts race for, and the loser must lose
 * before anything is closed.
 *
 * Every step that fails returns the step's name, and the caller records it: a
 * partial abandon — worst of all "PR closed, issue not re-queued" — must be
 * visible rather than where this quietly stops.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { gatherConflictIssueContext } from "./conflict_issue_context.ts";
import { CONFLICT_ATTEMPT_MARKER, CONFLICT_FAILED_MARKER, CONFLICT_RESOLUTION_BUDGET, MERGE_CONFLICT_LABEL, readResolutionAttempts, spentConflictAttempts } from "./merge_conflict_markers.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { parseStageTimingsLine, readPrDiffSummary, readPrDivergence } from "./conflict_fallback_context.ts";
import { createFallbackFlagFiler, MERGE_FALLBACK_TARGET_REPO } from "./merge_fallback_issue.ts";
import { CONSULTED_ISSUES_HEADING } from "./conflict_intent_audit.ts";
import { DISCOVERY_LABELS } from "./config_defaults.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { prTitleMatchesIssue } from "./pr_title_issue_ref.ts";
import { sanitiseIssueText } from "./conflict_intent_context.ts";
import { addLabelToIssue } from "./label_operations.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { partitionConflictComments } from "./conflict_marker_trust.ts";
// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------
/**
 * Marker recorded on the **originating issue** when it is restarted.
 *
 * Canonical `vibe-*` grammar — a bare `vibe-` prefix and `key="value"`
 * attributes (Issue #842). The older `vibe-coder:merge-conflict-*` markers
 * beside it are frozen only because they are already in live comment threads;
 * a new marker has no such data to stay compatible with.
 *
 * There is no cap on how many of these an issue may carry (Issue #3033): its
 * presence is what makes two hosts scanning the same exhausted PR produce one
 * abandon, and it records the abandoned branch so the redo's setup phase can
 * skip resuming it (see `lib/conflict_redo_branch.ts`).
 */ export const CONFLICT_RESTART_MARKER = "<!-- vibe-merge-conflict-restart";
/**
 * The marker comment line for one abandoned PR.
 *
 * `branchName` is appended as a `branch="…"` attribute only when it matches
 * the safe branch-name shape (no `..`, no shell- or markup-hostile
 * characters) — an unsafe or omitted name simply leaves the attribute off
 * rather than emitting a value nothing downstream can trust.
 */ const SAFE_BRANCH_NAME = /^[A-Za-z0-9._\/-]{1,255}$/;
export function conflictRestartMarker(repo, prNumber, branchName) {
  const branchAttr = branchName !== undefined && SAFE_BRANCH_NAME.test(branchName) && !branchName.includes("..") ? ` branch="${branchName}"` : "";
  return `${CONFLICT_RESTART_MARKER} pr="${repo}#${prNumber}"${branchAttr} -->`;
}
/** Whether a raw comment carries a restart claim at all. */ export function carriesRestartMarker(raw) {
  if (typeof raw !== "object" || raw === null) return false;
  const body = raw.body;
  return typeof body === "string" && body.includes(CONFLICT_RESTART_MARKER);
}
/**
 * The PRs a thread's restart markers name, in the order they appear.
 *
 * A marker naming *this* PR means an earlier abandon of it claimed the
 * restart and then did not finish — a different fact from "the work was
 * restarted and its replacement failed too", and the human-facing text has to
 * tell them apart. An unparseable marker still counts as a restart: it is a
 * claim, and the bound must fail towards not abandoning twice.
 *
 * **Author-blind by construction** (Issue #1247): this marker *suppresses* the
 * destructive step, so discarding one that cannot be attributed would relax a
 * safety check rather than tighten it. {@link abandonAndRestart} therefore
 * attributes the thread first and refuses outright when a claim cannot be
 * attributed, instead of quietly proceeding. Pass the trusted comments only.
 */ export function restartMarkerPrNumbers(comments) {
  const found = [];
  for (const raw of comments){
    if (!carriesRestartMarker(raw)) continue;
    const body = raw.body;
    const index = body.indexOf(CONFLICT_RESTART_MARKER);
    const match = /pr="[^"#]*#(\d+)"/.exec(body.slice(index));
    const number = match ? Number(match[1]) : NaN;
    found.push(Number.isSafeInteger(number) && number > 0 ? number : null);
  }
  return found;
}
// ---------------------------------------------------------------------------
// Attempt history, read back off the PR
// ---------------------------------------------------------------------------
/** Characters of one recorded failure kept for the abandon comment. */ const MAX_ATTEMPT_DETAIL_CHARS = 500;
/** Conflicted paths listed in the abandon comment. */ const MAX_CONFLICTED_PATHS = 20;
/** `- \`path\`` as {@link CONFLICT_FAILED_MARKER} comments list them. */ const CONFLICTED_PATH_LINE = /^-\s+`([^`]+)`\s*$/;
/** Issues named in one attempt comment's consulted-issues section. */ function consultedIssuesFrom(body) {
  const start = body.indexOf(CONSULTED_ISSUES_HEADING);
  if (start < 0) return [];
  const numbers = [];
  for (const match of body.slice(start).matchAll(/#(\d{1,9})\b/g)){
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0) numbers.push(number);
  }
  return numbers;
}
/** The attempt number a failure marker names, or `null`. */ function attemptNumberFrom(body) {
  const match = /merge-conflict-failed\s+n="(\d+)"/.exec(body);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
/**
 * Read the concluded failures out of a PR's comment thread.
 *
 * The reasons are the failure comments' own words rather than a re-derivation:
 * the abandon comment must say what the fleet actually recorded, and only the
 * comments know that once the run that wrote them is gone.
 *
 * @param comments - The PR's thread, oldest first.
 * @param trustedAuthors - Fleet logins (Issue #1247) — also what
 *   {@link readResolutionAttempts} attributes {@link ConflictResolutionAttempt}
 *   markers against for {@link FailedAttemptHistory.resolutionAttempts}.
 */ export function summariseFailedAttempts(comments, trustedAuthors) {
  const attempts = [];
  const conflictedPaths = [];
  const consultedIssues = [];
  for (const raw of comments){
    if (typeof raw !== "object" || raw === null) continue;
    const body = raw.body;
    if (typeof body !== "string") continue;
    // The consulted-issues record rides the *attempt* comment (Issue #1114),
    // not the failure conclusion, so it is collected from the whole thread.
    if (body.includes(CONFLICT_ATTEMPT_MARKER)) {
      for (const issueNumber of consultedIssuesFrom(body)){
        if (!consultedIssues.includes(issueNumber)) {
          consultedIssues.push(issueNumber);
        }
      }
    }
    if (!body.includes(CONFLICT_FAILED_MARKER)) continue;
    const lines = body.split("\n");
    for (const line of lines){
      const match = CONFLICTED_PATH_LINE.exec(line.trim());
      const path = match?.[1]?.trim();
      if (path !== undefined && path.length > 0 && !conflictedPaths.includes(path)) {
        conflictedPaths.push(path);
      }
    }
    const detail = lines.filter((line)=>!line.trim().startsWith("<!--")).join("\n").trim().slice(0, MAX_ATTEMPT_DETAIL_CHARS);
    const timings = parseStageTimingsLine(body);
    attempts.push({
      attempt: attemptNumberFrom(body),
      detail,
      ...timings !== undefined ? {
        timings
      } : {}
    });
  }
  return {
    attempts,
    conflictedPaths: conflictedPaths.slice(0, MAX_CONFLICTED_PATHS),
    consultedIssues,
    resolutionAttempts: readResolutionAttempts(comments, (login)=>isFleetAuthor(login, [
        ...trustedAuthors
      ]))
  };
}
/**
 * Both runs as the `merge-fallback` flag issue records them (Issue #2310).
 *
 * Every field comes off one {@link FailedAttemptSummary} — the agent's own
 * words, and the stage timings and host the same comment carried — so a run's
 * minutes can never be attributed to a different run. The run that measured
 * them is long gone by the time a fallback runs, so the thread is the only
 * surviving source for either.
 *
 * @param history - What {@link summariseFailedAttempts} read off the PR's
 *   thread, which the callers have already reduced to the fleet's own comments
 * @returns One run per concluded failure, in the order the thread records them
 */ export function mergeFallbackRunsFromHistory(history) {
  return history.attempts.map((attempt, index)=>({
      run: attempt.attempt ?? index + 1,
      ...attempt.detail.length > 0 ? {
        analysis: attempt.detail
      } : {},
      ...attempt.timings !== undefined && attempt.timings.timings.length > 0 ? {
        timings: attempt.timings.timings
      } : {},
      ...attempt.timings?.host !== undefined ? {
        host: attempt.timings.host
      } : {}
    }));
}
// ---------------------------------------------------------------------------
// The re-queue label
// ---------------------------------------------------------------------------
/**
 * The pickup labels, highest priority first (Issue #2277).
 *
 * The three hardwired discovery labels in their canonical order, then
 * `idle-task` — the lowest pickup signal, and the only one of the four the
 * worker may apply itself (`worker_label_guard.ts`).
 */ const PICKUP_LABELS = [
  ...DISCOVERY_LABELS,
  IDLE_TASK_LABEL
];
/**
 * Decide the re-queue label from the issue's own labels.
 *
 * Keeping what is there is the point: an issue a human raised as
 * `top-priority` must come back as `top-priority`, not be relabelled down to
 * whatever the worker happens to be permitted to apply. Only an issue with no
 * pickup label at all is labelled, and then with `idle-task`, so no route
 * through this rung needs a human to re-queue the work.
 *
 * The kept name is the canonical pickup label rather than the repository's
 * own spelling of it, so a label whose text is attacker-controlled cannot
 * reach the public comments this decision feeds.
 */ export function planRequeueLabel(labels) {
  const carried = new Set(labels.map((label)=>label.toLowerCase()));
  for (const pickup of PICKUP_LABELS){
    if (carried.has(pickup.toLowerCase())) return {
      kept: pickup
    };
  }
  return {
    applied: IDLE_TASK_LABEL
  };
}
/** The label a re-queued issue carries, for comment and log use. */ export function requeueLabelName(label) {
  return "kept" in label ? label.kept : label.applied;
}
/**
 * What the thread actually records about concluded attempts (Issue #2280).
 *
 * The comments this rung posts are permanent and public, so the count they
 * quote is read off the thread rather than assumed. The stale-verdict ladder
 * reaches this rung with **no** attempt opened at all, and even the
 * budget-spent caller can arrive one conclusion short when a failure comment
 * could not be posted.
 */ export function describeConcludedAttempts(history) {
  const count = history.attempts.length;
  if (count === 0) {
    return "No concluded merge-conflict resolution attempt is recorded on " + "this PR";
  }
  return `${count} merge-conflict resolution attempt${count === 1 ? "" : "s"} on this PR concluded and failed`;
}
/** One attempt's time, as `YYYY-MM-DD HH:MM UTC`, or `unknown` when unset. */ function attemptTimeCell(atMs) {
  if (atMs === undefined) return "unknown";
  return `${new Date(atMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
/** One attempt's outcome, as a table cell. */ function attemptOutcomeCell(outcome) {
  return outcome === "open" ? "open (never concluded)" : outcome;
}
/**
 * A markdown table of every resolution attempt across a restart chain
 * (Issue #3000) — one row per attempt, counted from one within each PR.
 *
 * `repo` is config, not user-controlled text, and every other cell comes off
 * a closed union ({@link ConflictResolutionPass}, the outcome word) or a
 * formatted epoch ms — nothing here needs {@link sanitiseIssueText}.
 *
 * @param repo - Repository in `owner/repo` form, shared by every link.
 * @param chain - Every PR's attempts, oldest PR first. A PR with no recorded
 *   attempts still gets one row, saying so.
 */ export function renderAttemptTable(repo, chain) {
  const rows = [
    "| PR | Attempt | Pass | Time (UTC) | Outcome |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const link of chain){
    const prCell = `${repo}#${link.prNumber}`;
    if (link.attempts.length === 0) {
      rows.push(`| ${prCell} | — | — | — | no attempt recorded |`);
      continue;
    }
    link.attempts.forEach((attempt, index)=>{
      rows.push(`| ${prCell} | ${index + 1} | ${attempt.pass} | ` + `${attemptTimeCell(attempt.atMs)} | ` + `${attemptOutcomeCell(attempt.outcome)} |`);
    });
  }
  return rows;
}
/**
 * Which escalation route an abandon that did not happen produced.
 *
 * Exhaustive over both non-abandoning outcomes, so a decline reason added
 * without a route here fails the type check rather than reaching a human as an
 * unexplained `needs-human`.
 */ export function exhaustedEscalationRoute(outcome) {
  if (outcome.outcome === "closed-without-issue") {
    // Only the stall route produces this (Issue #2802); recorded, not routed.
    return {
      kind: "abandon-declined",
      detail: "This PR names no originating issue " + `(${outcome.reason}), so it was closed with nothing re-queued.`
    };
  }
  if (outcome.outcome === "failed") {
    return {
      kind: "abandon-failed",
      step: outcome.step,
      detail: sanitiseIssueText(outcome.message)
    };
  }
  const reason = outcome.reason;
  switch(reason.kind){
    case "no-originating-issue":
      return {
        kind: "abandon-declined",
        detail: "This PR names no originating issue " + `(${reason.detail}): neither its branch name, nor a closing ` + "keyword in its body, nor GitHub's own linkage points at one. " + "Closing a PR the fleet cannot re-raise would lose the work " + "outright, so it was left open."
      };
    case "already-restarted":
      // Issue #3033: there is no restart cap, so this member is only ever
      // produced for a claim naming this very PR — the `!samePr` text below
      // is kept only for outcomes an injected rung constructs itself.
      return {
        kind: "abandon-declined",
        detail: reason.samePr ? `An earlier abandon of this PR claimed issue ` + `#${reason.issueNumber} and did not finish. The restart claim is ` + "on the issue, so this PR is not closed a second time — it is " + "left open on `merge-conflict`." : `Issue #${reason.issueNumber} already records ` + `${reason.restartCount} restart claim(s) and this abandon was ` + "declined, so this PR is left open on `merge-conflict` and the " + "next pass decides it again."
      };
    case "restart-claim-unverifiable":
      return {
        kind: "abandon-declined",
        detail: `Issue #${reason.issueNumber} carries ${reason.claimCount} ` + "merge-conflict restart claim(s) whose author could not be " + "established — the comment names no author, or this host has no " + "fleet identity configured (`service_accounts` / " + "`fleet_pr_authors`) to compare it against. That claim is the only " + "bound on how often the fleet closes and re-raises this work, so " + "the PR was left open rather than abandoned on a bound that could " + "not be checked."
      };
    case "other-open-pr":
      return {
        kind: "abandon-declined",
        detail: `Issue #${reason.issueNumber} already has another open PR ` + `(${sanitiseIssueText(reason.prUrl)}), so re-queuing it would have ` + "raced that one."
      };
    case "attempts-not-spent":
      return {
        kind: "abandon-declined",
        detail: `This PR has ${reason.failedAttempts} failed merge-conflict ` + `resolution attempt(s) recorded of the ${reason.budget} the shared ` + "budget allows, so it was not abandoned: abandon-and-redo runs " + "only after every attempt has been spent and failed. It stays " + "open on `merge-conflict` for the next attempt."
      };
  }
  const unhandled = reason;
  throw new Error(`Unhandled abandon decline reason: ${JSON.stringify(unhandled)}`);
}
/**
 * The route, as the paragraphs the comment recording it carries — the
 * decline's own explanation, or the ladder's own rung-failed comment
 * (Issue #2280). Neither route ever hands the issue to a human
 * (Issue #3033).
 */ export function describeExhaustedRoute(route) {
  switch(route.kind){
    case "abandon-declined":
      return [
        "**The automatic restart was declined, so nothing was closed.** " + route.detail
      ];
    case "abandon-failed":
      return [
        "**The automatic restart failed part-way through, at the " + `\`${route.step}\` step.** ${route.detail}`,
        "",
        "Check what that step leaves behind before doing anything else: this " + "PR may already carry the abandon comment, and its issue may already " + "be re-queued."
      ];
  }
  const unhandled = route;
  throw new Error(`Unhandled exhausted escalation route: ${JSON.stringify(unhandled)}`);
}
/**
 * The `escalateToHuman` dedup key for a route.
 *
 * A failed abandon gets its own key: the shared `merge-conflict-<pr>` key is
 * also the processor's, and a landed escalation suppresses further comments
 * for a day — which would swallow the one comment naming the step that broke.
 */ export function exhaustedEscalationDedupKey(prNumber, route) {
  return route.kind === "abandon-failed" ? `merge-conflict-abandon-failed-${prNumber}` : `merge-conflict-${prNumber}`;
}
/**
 * What was tried before the abandon, as a whole clause with its own subject
 * (Issue #4304): not every route here is the stall-repair pass's.
 */ function describeStallRepair(tried, base) {
  switch(tried){
    case "ladder-rerun":
      return "The stall-repair pass already reran the merge-conflict ladder once";
    case "sync-and-lane-rerun":
      return `The stall-repair pass already synced it with \`${base}\` and ` + "reran its owning lane once";
    case "ci-fix-cap":
      return "The CI-fix lane already spent every automatic fix attempt on " + "this same failure";
    case "review-retry":
      return "The PR-feedback lane already retried the review in a later " + "cycle";
    case "retarget-back":
      return "The worker already tried to move it back onto the base it was " + "opened against, and could not";
    case "route-closed-hold":
      return `The worker already disarmed its auto-merge on \`${base}\`, ` + "and it never moves a PR off a milestone branch";
  }
}
/**
 * The git runner the scan does not have.
 *
 * The abandon decision needs only the PR side of #1113's context, which is
 * resolved from the branch name, the PR body and GitHub's linkage — no clone.
 * Offering no conflicted path means the base-side walk never runs; if it ever
 * did, this fails loud rather than reporting an empty base side as a fact.
 */ const NO_CLONE_GIT = ()=>Promise.resolve({
    ok: false,
    error: new Error("no clone is available here — the base-side walk must not run from " + "the merge-conflict scan")
  });
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
/** Open PRs listed per lookup — the same bound `findExistingPrForIssue` uses. */ const OPEN_PR_LOOKUP_LIMIT = 50;
/**
 * Whether a PR body carries the legacy `vibe-worker-issue-<n>` marker for
 * this issue — and not for #16 when the issue is #1.
 *
 * Scanned as a string rather than built into a `RegExp`: an interpolated
 * pattern is a ReDoS surface the SAST gate rejects outright, and this needs no
 * pattern at all.
 */ function bodyNamesIssue(body, issueNumber) {
  const marker = `vibe-worker-issue-${issueNumber}`;
  for(let at = body.indexOf(marker); at >= 0; at = body.indexOf(marker, at + 1)){
    const next = body.charAt(at + marker.length);
    if (next === "" || next < "0" || next > "9") return true;
  }
  return false;
}
/**
 * Every **open** PR for an issue except one, newest first.
 *
 * Deliberately not {@link findExistingPrForIssue}, whose shape is wrong for a
 * precondition on a destructive step in three ways: it swallows every `gh`
 * failure into the same "no PR found" it returns for a genuine absence, it
 * returns only the first match, and it also matches merged and
 * recently-closed PRs. Here an API failure must **throw** — reading an outage
 * as "no other PR" would let the close proceed — and *every* match must be
 * seen, since the one PR that matters may not be the newest.
 *
 * The matcher is the fleet's own {@link prTitleMatchesIssue} plus the legacy
 * body marker, so this and the fleet's PR dedup agree on what "the issue's PR"
 * means. A fork-headed PR proves nothing (Issue #1124): its title is text
 * anybody may write, so it is ignored rather than allowed to block a restart.
 *
 * @throws when the listing cannot be read or parsed.
 */ export async function findOtherPrsForIssue(repo, issueNumber, excludePrNumber, gh) {
  const raw = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,title,body,url,isCrossRepository",
    "--limit",
    String(OPEN_PR_LOOKUP_LIMIT)
  ]);
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // `gh pr list --json` prints `[]` when there is nothing; empty output
    // means the call answered with nothing at all, which is not an absence.
    throw new Error(`Empty PR listing for ${repo} issue #${issueNumber} — an unanswered ` + "lookup must not be read as 'no other PR'");
  }
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a PR array for ${repo} issue #${issueNumber}, got ` + `${parsed === null ? "null" : typeof parsed}`);
  }
  const others = [];
  for (const entry of parsed){
    if (typeof entry !== "object" || entry === null) continue;
    const pr = entry;
    const number = typeof pr.number === "number" ? pr.number : NaN;
    if (!Number.isSafeInteger(number) || number === excludePrNumber) continue;
    if (pr.isCrossRepository === true) continue;
    const title = typeof pr.title === "string" ? pr.title : "";
    const body = typeof pr.body === "string" ? pr.body : "";
    if (!prTitleMatchesIssue(title, issueNumber) && !bodyNamesIssue(body, issueNumber)) {
      continue;
    }
    others.push({
      number,
      url: typeof pr.url === "string" && pr.url.length > 0 ? pr.url : `https://github.com/${repo}/pull/${number}`
    });
  }
  return others;
}
// ---------------------------------------------------------------------------
// Comment bodies
// ---------------------------------------------------------------------------
/** The conflicted paths, rendered for a comment — or the stated absence. */ function conflictedPathLines(history) {
  return history.conflictedPaths.length > 0 ? history.conflictedPaths.map((path)=>`- \`${sanitiseIssueText(path)}\``) : [
    "- (no conflicted path was recorded)"
  ];
}
/**
 * The issues consulted, as comment lines (Issues #1113/#1114).
 *
 * Two sources, because neither alone is the answer: the context this rung
 * gathered names the PR side (and the base side, when the caller had a clone),
 * while the attempts' own comments name every issue the resolver was actually
 * shown — a record no later run can re-derive once the clone is gone.
 */ function consultedIssueLines(context, history) {
  const known = [];
  if (context.prSide.resolved) known.push(context.prSide.issue);
  for (const path of context.baseSide){
    for (const issue of path.issues){
      if (!known.some((seen)=>seen.number === issue.number)) {
        known.push(issue);
      }
    }
  }
  const lines = known.map((issue)=>`- #${issue.number} — ${sanitiseIssueText(issue.title)}`);
  for (const issueNumber of history.consultedIssues){
    if (known.some((seen)=>seen.number === issueNumber)) continue;
    lines.push(`- #${issueNumber} — recorded on an attempt comment`);
  }
  return lines.length > 0 ? lines : [
    "- (none — no originating issue was resolvable for either side)"
  ];
}
/**
 * The comment posted on the PR before it is closed.
 *
 * It has to stand on its own months later: what was tried, what it tripped on,
 * what was consulted, what happens next, and the branch name, so the abandoned
 * work stays findable after the PR leaves the open queue.
 */ export function buildAbandonPrComment(args) {
  const { request, history, context, issueNumber } = args;
  const labelName = requeueLabelName(args.label);
  // Every quoted string below came off GitHub — a failure comment the agent
  // wrote, a path, an issue title — and this comment is a public outbound
  // sink, so each goes through the same sanitiser the intent audit uses:
  // secrets redacted, delimiters defused, HTML comments neutralised so a
  // quoted body cannot forge a marker (Issue #1114).
  const attempts = history.attempts.length > 0 ? history.attempts.flatMap((attempt, index)=>[
      "",
      `**Attempt ${attempt.attempt ?? index + 1}**`,
      "",
      ...sanitiseIssueText(attempt.detail).split("\n").map((line)=>`> ${line}`)
    ]) : [
    "",
    "_(no failure comment survives in this thread)_"
  ];
  const paths = conflictedPathLines(history);
  const consulted = consultedIssueLines(context, history);
  const branch = sanitiseIssueText(request.branchName);
  const base = sanitiseIssueText(request.baseBranch);
  // No restart marker here: the marker is the issue's (Issue #1115). This PR
  // is closed moments later and a replacement takes its place, so a claim
  // recorded on it would be read back against the wrong PR.
  return [
    "♻️ **Abandoning this PR and restarting the work**",
    "",
    // Counted from the thread, never assumed: the stale-verdict ladder reaches
    // this rung having opened **no** attempt at all (Issue #2280), and a
    // failure conclusion that could not be posted leaves one attempt short
    // either way. "Two attempts failed" on a PR that recorded none is a
    // fabricated fact on a permanent comment.
    `${describeConcludedAttempts(history)}, and GitHub still will not merge ` + `\`${branch}\` into \`${base}\`. Redoing the work off the current base ` + "is cheaper than reconciling it, and needs no human.",
    "",
    "**What the attempts recorded**",
    ...attempts,
    "",
    "**Conflicted paths**",
    "",
    ...paths,
    "",
    "**Issues consulted**",
    "",
    ...consulted,
    "",
    "_Base-side issues are resolvable only with a clone to walk " + "(Issue #1113); where the caller had none, the list above is the PR side " + "plus whatever the attempt comments recorded._",
    "",
    "**What happens now**",
    "",
    `This PR is being **closed** — not merged — and issue ` + `#${issueNumber} is being re-queued (${"kept" in args.label ? `\`${labelName}\`, the pickup label it already carries` : `\`${labelName}\`, applied by the worker`}) so the fleet raises a fresh PR off \`${base}\`.`,
    "",
    `The branch \`${branch}\` is **not** deleted and has **not** ` + "been force-pushed: every commit on it stays exactly as its author " + "pushed it, so the abandoned work remains readable and linked from here."
  ].join("\n");
}
/**
 * The comment posted on the originating issue — and the restart marker.
 *
 * Present tense on purpose: it is posted before the close, as the claim that
 * stops a second host abandoning the same PR, so it must not assert a
 * completed state it has not reached yet.
 */ export function buildRestartIssueComment(args) {
  const { request, history } = args;
  const restartNumber = args.restartNumber ?? 1;
  const labelName = requeueLabelName(args.label);
  const paths = conflictedPathLines(history);
  // Which label, and why it is that one: an issue that already carried a
  // pickup label keeps it, so a `top-priority` issue is not silently demoted
  // by its own restart (Issue #2277).
  const labelClause = "kept" in args.label ? `it keeps the \`${labelName}\` label it already carries` : `\`${labelName}\` is being applied to it, since it carried no pickup ` + "label";
  const whatHappensNow = `That PR is being closed and this issue re-queued — ${labelClause} — so ` + "the work is redone off the current base rather than reconciled against " + "it. The abandoned branch is kept, not deleted, and was never " + `force-pushed — read it at ${request.repo}#${request.prNumber} if the ` + "earlier work is useful.";
  const base = sanitiseIssueText(request.baseBranch);
  return [
    conflictRestartMarker(request.repo, request.prNumber, request.branchName),
    "♻️ **Re-queued: the PR for this issue conflicted irreconcilably**",
    "",
    `${request.repo}#${request.prNumber} put this issue's work on ` + `\`${sanitiseIssueText(request.branchName)}\`, and GitHub will not merge ` + `that branch into \`${base}\`. ` + `${describeConcludedAttempts(history)}.`,
    "",
    "Conflicted paths:",
    "",
    ...paths,
    "",
    "**Resolution attempts on this PR**",
    "",
    ...renderAttemptTable(request.repo, [
      {
        prNumber: request.prNumber,
        attempts: history.resolutionAttempts
      }
    ]),
    "",
    whatHappensNow,
    "",
    `This is restart **${restartNumber}** for this issue. There is no cap: ` + "if the fresh PR conflicts too, the work is redone again on a fresh " + `branch cut from the then-current tip of \`${base}\` — never from an ` + "abandoned head."
  ].join("\n");
}
/**
 * Marker on the one comment recording that a no-issue PR's fallback was filed
 * in VibeCoder (Issue #4456), so a later cycle does not file it again.
 */ export const NO_ISSUE_FALLBACK_RECORDED_MARKER = "<!-- vibe-merge-fallback-recorded -->";
/** Cause recorded for a PR whose conflict ladder ran out (Issue #4456). */ export const PR_LADDER_EXHAUSTED_CAUSE = "the PR conflict ladder was exhausted";
/**
 * The comment on a conflicting PR with no originating issue (Issues #2310,
 * #4456): it stays open, and its fallback is a VibeCoder failure.
 *
 * Closing it and filing a re-do issue in its place created new work instead
 * of finishing this work, so the PR is left open for the ladder to keep
 * working, and the fallback is filed in VibeCoder for the worker to be fixed.
 */ export function buildNoIssueKeptOpenPrComment(args) {
  const { request, history, recordIssueNumber } = args;
  const branch = sanitiseIssueText(request.branchName);
  const base = sanitiseIssueText(request.baseBranch);
  const record = recordIssueNumber > 0 ? `${MERGE_FALLBACK_TARGET_REPO}#${recordIssueNumber}` : `a \`merge-fallback\` issue in ${MERGE_FALLBACK_TARGET_REPO} whose ` + "number could not be read";
  return [
    NO_ISSUE_FALLBACK_RECORDED_MARKER,
    "🚩 **This PR stays open — the fallback is recorded as a worker failure**",
    "",
    `${describeConcludedAttempts(history)}, and GitHub still will not merge ` + `\`${branch}\` into \`${base}\`.`,
    "",
    `This PR names **no originating issue** (${args.reason}). It is not ` + "closed and no new issue is filed to redo it: the conflict ladder keeps " + `working this PR. The worker's failure to settle it is recorded in ${record}.`,
    "",
    "**Conflicted paths**",
    "",
    ...conflictedPathLines(history)
  ].join("\n");
}
/** Where a re-queued issue's pickup label came from, for a comment. */ function describeRequeueLabel(label) {
  const name = requeueLabelName(label);
  return "kept" in label ? `\`${name}\`, the pickup label it already carries` : `\`${name}\`, applied by the worker`;
}
/**
 * The PR comment for a stalled PR abandoned with an originating issue
 * (Issue #2802). Stands alone months later: what stalled, that one repair was
 * tried, what happens now, and where the branch is.
 */ export function buildStalledAbandonPrComment(args) {
  const branch = sanitiseIssueText(args.request.branchName);
  const base = sanitiseIssueText(args.request.baseBranch);
  return [
    "♻️ **Abandoning this stalled PR and restarting the work**",
    "",
    `This PR ${sanitiseIssueText(args.detail)}. ` + `${describeStallRepair(args.tried, base)}, and it is still ` + "stalled, so the work is redone rather than nursed further.",
    "",
    `This PR is being **closed** — not merged — and issue ` + `#${args.issueNumber} is being re-queued ` + `(${describeRequeueLabel(args.label)}) so the fleet raises a fresh PR ` + // A closed route's branch is the one place the redo must not go back to
    // (Issue #4304): the next run picks its base afresh.
    (args.tried === "route-closed-hold" ? "against whatever base its milestone now routes to." : `off \`${base}\`.`),
    "",
    `The branch \`${branch}\` is **not** deleted and has **not** been ` + "force-pushed, so the abandoned work remains readable and linked from here."
  ].join("\n");
}
/**
 * The originating-issue comment for a stalled PR (Issue #2802). Carries the
 * same restart marker as the merge-conflict route, and the same uncapped
 * restart count (Issue #3033).
 */ export function buildStalledRestartIssueComment(args) {
  const { request } = args;
  return [
    conflictRestartMarker(request.repo, request.prNumber, request.branchName),
    "♻️ **Re-queued: the PR for this issue stalled**",
    "",
    `${request.repo}#${request.prNumber} ${sanitiseIssueText(args.detail)}. ` + `${describeStallRepair(args.tried, sanitiseIssueText(request.baseBranch))}, and it is still stalled.`,
    "",
    `That PR is being closed and this issue re-queued ` + `(${describeRequeueLabel(args.label)}) so the work is redone. The ` + `abandoned branch \`${sanitiseIssueText(request.branchName)}\` is kept, ` + "not deleted.",
    "",
    `This is restart **${args.restartNumber}** for this issue.`
  ].join("\n");
}
export async function fetchIssueSnapshot(repo, issueNumber, gh) {
  const raw = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "state,labels"
  ]);
  const parsed = JSON.parse(raw.trim() || "{}");
  // An unreadable issue must not become `{ state: "", labels: [] }`: that
  // reads as "open and unlabelled", which silently skips the reopen and can
  // let the close proceed on an issue nobody could see.
  if (typeof parsed.state !== "string" || !Array.isArray(parsed.labels)) {
    throw new Error(`Unusable issue view for ${repo}#${issueNumber}: no state/labels in ` + "the response");
  }
  const labels = [];
  for (const label of parsed.labels){
    const name = label?.name;
    if (typeof name === "string") labels.push(name);
  }
  return {
    state: parsed.state,
    labels
  };
}
/**
 * Leave a conflicting PR that names no originating issue open, and record its
 * fallback in VibeCoder (Issues #2310, #4456).
 *
 * Closing it and filing a re-do issue in the source repository made new work
 * instead of finishing this work, so neither happens: the PR stays open for
 * the ladder to keep working, and the result is the `no-originating-issue`
 * decline. A stalled PR (Issue #2802) stays open the same way. The record is
 * filed once per PR — the marker comment says it was — and a record that
 * cannot be filed never changes the decline: it is logged, and the next cycle
 * tries again.
 */ async function abandonWithoutOriginatingIssue(request, deps, reason, failed) {
  const { repo, prNumber } = request;
  const gh = deps.gh;
  const logger = deps.logger;
  const declined = {
    outcome: "declined",
    reason: {
      kind: "no-originating-issue",
      detail: reason
    }
  };
  if (request.reason?.kind === "stalled") {
    logger?.warn?.(`Stalled PR #${prNumber} names no originating issue (${reason}) — left ` + "open; a PR is never closed and redone through a new issue " + "(Issue #4456)", {
      repo,
      prNumber
    });
    return declined;
  }
  let comments;
  try {
    // Attributed like every other read of this thread (Issue #1247): the
    // record quotes it, so an outsider's text must never be filed as the
    // fleet's own account of what the runs found.
    comments = partitionConflictComments(request.prComments ?? await fetchIssueCommentPages(repo, prNumber, gh), deps.trustedAuthors).trusted;
  } catch (error) {
    return failed("pr-thread", error);
  }
  const alreadyRecorded = comments.some((comment)=>typeof comment.body === "string" && comment.body.includes(NO_ISSUE_FALLBACK_RECORDED_MARKER));
  if (alreadyRecorded) return declined;
  const history = summariseFailedAttempts(comments, deps.trustedAuthors);
  // Best-effort context: a read that failed renders as `not recorded` in the
  // record rather than as a guess, and never stops the fallback.
  const divergence = await readPrDivergence({
    repo,
    prNumber,
    baseBranch: request.baseBranch,
    headBranch: request.branchName,
    queueLabel: MERGE_CONFLICT_LABEL,
    gh,
    ...logger !== undefined ? {
      logger
    } : {}
  });
  const diff = await readPrDiffSummary({
    repo,
    prNumber,
    gh,
    ...logger !== undefined ? {
      logger
    } : {}
  });
  const filer = deps.fileFallbackFlag ?? createFallbackFlagFiler({
    gh,
    ...logger !== undefined ? {
      logger
    } : {},
    fleetAuthors: deps.trustedAuthors
  });
  const filed = await filer({
    target: {
      kind: "pr",
      repo,
      prNumber,
      headBranch: request.branchName,
      baseBranch: request.baseBranch
    },
    cause: PR_LADDER_EXHAUSTED_CAUSE,
    conflictedFiles: history.conflictedPaths,
    runs: mergeFallbackRunsFromHistory(history),
    ...divergence,
    ...diff !== undefined ? {
      diffSummary: diff.files,
      diffSummaryOmitted: diff.omitted
    } : {},
    fallbackAction: `Left ${repo}#${prNumber} open: it names no originating ` + `issue (${reason}), so the ladder keeps working the same PR.`
  });
  if (!filed.ok) {
    logger?.warn?.(`PR #${prNumber} names no originating issue (${reason}) — left open; ` + "its fallback could not be recorded in VibeCoder this cycle", {
      repo,
      prNumber,
      error: filed.error.message
    });
    return declined;
  }
  try {
    await gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      buildNoIssueKeptOpenPrComment({
        request,
        history,
        reason,
        recordIssueNumber: filed.value.issueNumber
      })
    ]);
  } catch (error) {
    logger?.warn?.(`PR #${prNumber}: its fallback is recorded in VibeCoder but the PR ` + "comment saying so could not be posted", {
      repo,
      prNumber,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  logger?.warn?.(`PR #${prNumber} names no originating issue (${reason}) — left open and ` + `recorded as ${MERGE_FALLBACK_TARGET_REPO}#${filed.value.issueNumber} — ` + describeConcludedAttempts(history), {
    repo,
    prNumber,
    recordIssueNumber: filed.value.issueNumber
  });
  return declined;
}
/**
 * Close the conflicting PR and re-queue its originating issue.
 *
 * Never throws: every failure is returned as `{ outcome: "failed", step }` so
 * the caller can escalate naming the step that stopped it.
 */ export async function abandonAndRestart(request, deps) {
  const { repo, prNumber } = request;
  const gh = deps.gh;
  const logger = deps.logger;
  const failed = (step, error, issueNumber)=>{
    const message = errorMessage(error);
    logger?.error?.("Abandon-and-restart failed", {
      repo,
      prNumber,
      step,
      ...issueNumber !== undefined ? {
        issueNumber
      } : {},
      error: message
    });
    return {
      outcome: "failed",
      step,
      message,
      ...issueNumber !== undefined ? {
        issueNumber
      } : {}
    };
  };
  // --- Precondition 0: the shared budget has actually been spent
  // (Issue #3000). Read once, at the very top, before anything else —
  // including the originating-issue lookup — runs. A read failure here means
  // nothing has changed yet, so it fails as `pr-thread` rather than reaching
  // a later step under a half-read thread.
  let trustedThread;
  try {
    trustedThread = partitionConflictComments(request.prComments ?? await fetchIssueCommentPages(repo, prNumber, gh), deps.trustedAuthors).trusted;
  } catch (error) {
    return failed("pr-thread", error);
  }
  const attempts = readResolutionAttempts(trustedThread, (login)=>isFleetAuthor(login, [
      ...deps.trustedAuthors
    ]));
  const failedAttempts = spentConflictAttempts(attempts);
  // A `stalled` reason is exempt (Issue #2802): the stall-repair pass's
  // second trip is not a conflict-resolution outcome at all, and has its own
  // two-trip bound — this guard only ever applies to the merge-conflict route.
  //
  // With no fleet identity resolved (`deps.trustedAuthors` empty),
  // `partitionConflictComments` can never call anything "trusted" — so a
  // computed `failedAttempts` of 0 would be a false "not spent yet" rather
  // than a genuine read of the thread. Decline no earlier than the
  // restart-marker check further down, which already declines an
  // unattributable claim explicitly (Issue #1247) instead of silently
  // reading it as a healthy zero.
  if (deps.trustedAuthors.length > 0 && request.reason?.kind !== "stalled" && failedAttempts < CONFLICT_RESOLUTION_BUDGET) {
    logger?.info?.(`PR #${prNumber} has ${failedAttempts} failed merge-conflict ` + `resolution attempt(s) recorded of the ${CONFLICT_RESOLUTION_BUDGET} ` + "the shared budget allows — not abandoned yet", {
      repo,
      prNumber,
      failedAttempts,
      budget: CONFLICT_RESOLUTION_BUDGET
    });
    return {
      outcome: "declined",
      reason: {
        kind: "attempts-not-spent",
        failedAttempts,
        budget: CONFLICT_RESOLUTION_BUDGET
      }
    };
  }
  // --- Precondition 1: the originating issue. No issue, no *re-queue* — the
  // PR is still closed, against a flag issue filed as the re-do item in its
  // place (Issue #2310).
  let context;
  try {
    context = deps.resolveContext ? await deps.resolveContext(request) : await gatherConflictIssueContext({
      repo,
      prNumber,
      prBranch: request.branchName,
      baseBranch: request.baseBranch,
      conflictedPaths: []
    }, {
      gh,
      git: NO_CLONE_GIT
    });
  } catch (error) {
    return failed("originating-issue", error);
  }
  if (!context.prSide.resolved) {
    // Issue #2310: no longer a decline. The PR is closed and the
    // `merge-fallback` flag issue — `idle-task`, with this PR's diff summary —
    // becomes the re-do item, because a PR parked for a human who never comes
    // loses the work just as surely as closing one with no record.
    return await abandonWithoutOriginatingIssue({
      ...request,
      prComments: trustedThread
    }, deps, context.prSide.reason, failed);
  }
  const issueNumber = context.prSide.issue.number;
  // --- Precondition 2: a claim naming this PR declines. -------------------
  let issueComments;
  try {
    issueComments = await fetchIssueCommentPages(repo, issueNumber, gh);
  } catch (error) {
    return failed("restart-marker", error, issueNumber);
  }
  // Issue #1247: the claim is only a bound if the fleet wrote it. An
  // outsider's marker is discarded — otherwise one planted comment stalls
  // every conflicted PR for this issue for ever — but a claim that cannot be
  // attributed at all refuses the abandon, because discarding *that* would
  // relax the bound on a step that closes a PR.
  const claimComments = issueComments.filter(carriesRestartMarker);
  const attribution = partitionConflictComments(claimComments, deps.trustedAuthors);
  if (attribution.unattributable > 0) {
    return {
      outcome: "declined",
      reason: {
        kind: "restart-claim-unverifiable",
        issueNumber,
        claimCount: attribution.unattributable
      }
    };
  }
  const outsiderClaims = claimComments.length - attribution.trusted.length;
  if (outsiderClaims > 0) {
    logger?.warn?.(`Ignored ${outsiderClaims} merge-conflict restart claim(s) on issue ` + `#${issueNumber} authored outside the fleet — a marker anyone can ` + "post must not stall the restart", {
      repo,
      prNumber,
      issueNumber,
      outsiderClaims
    });
  }
  const claimed = restartMarkerPrNumbers(attribution.trusted);
  // A claim naming this PR means an earlier abandon of *it* did not finish —
  // a different story to tell than "the replacement failed too", and closing
  // the same PR twice is not a retry, so it declines whatever the count says.
  // There is no cap on how many times this issue may be restarted (#3033): a
  // claim naming a *different* PR never declines.
  const samePr = claimed.includes(prNumber);
  if (samePr) {
    return {
      outcome: "declined",
      reason: {
        kind: "already-restarted",
        issueNumber,
        samePr,
        restartCount: claimed.length
      }
    };
  }
  // --- Precondition 3: the issue has no other open PR of its own. ---------
  let others;
  try {
    const findOtherPrs = deps.findOtherPrs ?? ((prRepo, number, exclude)=>findOtherPrsForIssue(prRepo, number, exclude, gh));
    others = await findOtherPrs(repo, issueNumber, prNumber);
  } catch (error) {
    // A lookup that failed is not an absence: reading an outage as "no other
    // PR" would let the close proceed on an issue somebody else is on.
    return failed("existing-pr", error, issueNumber);
  }
  const other = others[0];
  if (other !== undefined) {
    return {
      outcome: "declined",
      reason: {
        kind: "other-open-pr",
        issueNumber,
        prUrl: other.url
      }
    };
  }
  // --- The issue's own state: is it closed, and what does it carry? -------
  let snapshot;
  try {
    snapshot = await fetchIssueSnapshot(repo, issueNumber, gh);
  } catch (error) {
    return failed("issue-state", error, issueNumber);
  }
  // Issue #2277: keep whatever pickup label the issue already carries, else
  // apply `idle-task`. No route here hands the issue to a human — an issue
  // waiting on a label a person must apply is not re-queued at all.
  const requeueLabel = planRequeueLabel(snapshot.labels);
  // Read once, at the top of this call (Issue #3000) — not re-fetched here.
  const history = summariseFailedAttempts(trustedThread, deps.trustedAuthors);
  // --- Step 1: claim the restart on the issue, marker first. --------------
  try {
    await gh([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      request.reason?.kind === "stalled" ? buildStalledRestartIssueComment({
        request,
        detail: request.reason.detail,
        tried: request.reason.tried,
        label: requeueLabel,
        restartNumber: claimed.length + 1
      }) : buildRestartIssueComment({
        request,
        history,
        label: requeueLabel,
        // Read off the thread, never assumed: the comment is permanent, and
        // "this is your last restart" must be true when it says so.
        restartNumber: claimed.length + 1
      })
    ]);
  } catch (error) {
    return failed("issue-comment", error, issueNumber);
  }
  // --- Step 2: say on the PR why it is being closed. ----------------------
  try {
    await gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      request.reason?.kind === "stalled" ? buildStalledAbandonPrComment({
        request,
        detail: request.reason.detail,
        tried: request.reason.tried,
        issueNumber,
        label: requeueLabel
      }) : buildAbandonPrComment({
        request,
        history,
        context,
        issueNumber,
        label: requeueLabel
      })
    ]);
  } catch (error) {
    return failed("pr-comment", error, issueNumber);
  }
  // --- Step 3: close it. Closed, not merged; the branch stays. ------------
  try {
    // No `--delete-branch`: branch cleanup owns that lifecycle, and the
    // abandoned commits must stay readable (#1076).
    await gh([
      "pr",
      "close",
      String(prNumber),
      "--repo",
      repo
    ]);
  } catch (error) {
    return failed("pr-close", error, issueNumber);
  }
  // --- Step 4: re-queue the issue — reopen it if it is closed. ------------
  if (snapshot.state.toUpperCase() === "CLOSED") {
    try {
      await gh([
        "issue",
        "reopen",
        String(issueNumber),
        "--repo",
        repo
      ]);
    } catch (error) {
      return failed("issue-reopen", error, issueNumber);
    }
  }
  // --- Step 5: …and label it, but only where there is nothing to keep. A
  // pickup label the issue already carries is left exactly as it is, so the
  // restart cannot demote the work a human prioritised (Issue #2277).
  if ("applied" in requeueLabel) {
    try {
      const labelled = deps.addLabel ? await deps.addLabel(repo, issueNumber, requeueLabel.applied) : await addLabelToIssue(repo, issueNumber, requeueLabel.applied, {
        ghCommandFn: gh
      });
      if (!labelled.ok) {
        return failed("issue-label", labelled.error, issueNumber);
      }
    } catch (error) {
      return failed("issue-label", error, issueNumber);
    }
  }
  logger?.warn?.(`PR #${prNumber} was abandoned and issue #${issueNumber} re-queued ` + `(\`${requeueLabelName(requeueLabel)}\`) — ` + `${describeConcludedAttempts(history)}`, {
    repo,
    prNumber,
    issueNumber,
    label: requeueLabelName(requeueLabel),
    labelApplied: "applied" in requeueLabel
  });
  return {
    outcome: "abandoned",
    issueNumber,
    label: requeueLabel
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25mbGljdF9hYmFuZG9uX3Jlc3RhcnQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBYmFuZG9uLWFuZC1yZXN0YXJ0IOKAlCB0aGUgbGFzdCBhdXRvbWF0aWMgcnVuZyBvZiB0aGUgbWVyZ2UtY29uZmxpY3RcbiAqIGVzY2FsYXRpb24gbGFkZGVyIChJc3N1ZSAjMTExNSwgcGFyZW50ICMxMDc2KS5cbiAqXG4gKiBUd28gaW50ZW50LWF3YXJlIG1lcmdlIGF0dGVtcHRzIGhhdmUgY29uY2x1ZGVkIGFuZCBmYWlsZWQuIEJlZm9yZSAjMTExNSB0aGVcbiAqIGxhZGRlciBlbmRlZCB0aGVyZSwgYXQgYG5lZWRzLWh1bWFuYC4gQSBicmFuY2ggdGhhdCBoYXMgZGl2ZXJnZWQgZmFyIGVub3VnaFxuICogdG8gZGVmZWF0IHR3byByZWFsIG1lcmdlcyBpcyB1c3VhbGx5IGNoZWFwZXIgdG8gKipyZWRvKiogdGhhbiB0byByZWNvbmNpbGUsXG4gKiBhbmQgcmVkb2luZyBpdCBuZWVkcyBubyBodW1hbjogdGhlIGNvbmZsaWN0aW5nIFBSIGlzIGNsb3NlZCB3aXRoIGFuXG4gKiBleHBsYW5hdG9yeSBjb21tZW50IGFuZCBpdHMgb3JpZ2luYXRpbmcgaXNzdWUgaXMgcmUtcXVldWVkLCBzbyB0aGUgcGlwZWxpbmVcbiAqIHJhaXNlcyBhIGZyZXNoIFBSIG9mZiB0aGUgY3VycmVudCBiYXNlLiBUaGVyZSBpcyBubyByZXN0YXJ0IGNhcCBhbmQgbm9cbiAqIGZ1cnRoZXIgcnVuZyBhZnRlciB0aGlzIG9uZSDigJQgdGhlIGxhZGRlciBlbmRzIGhlcmUsIGFuZCBldmVyeSByZWRvIHN0YXJ0c1xuICogY2xlYW4gKElzc3VlICMzMDMzKS5cbiAqXG4gKiAqKlwiU3RhcnQgYWdhaW5cIiBuZXZlciBtZWFucyBmb3JjZS1wdXNoLioqIFRoZSBhYmFuZG9uZWQgUFIgaXMgKmNsb3NlZCosIG5vdFxuICogbWVyZ2VkLCBhbmQgaXRzIGJyYW5jaCBpcyBsZWZ0IGFsb25lIOKAlCBhIHJlZ2VuZXJhdGVkIGJyYW5jaCBmb3JjZS1wdXNoZWRcbiAqIG92ZXIgdGhlIHNhbWUgUFIgd291bGQgZGVzdHJveSBpdHMgY29tbWl0cyBhbmQgaXRzIHJldmlldyBoaXN0b3J5LCB3aGljaCBpc1xuICogdGhlIHNhbWUgY2xhc3Mgb2YgaGFybSBhcyB0aGUgc2lkZS1waWNraW5nIHRoZSBjb25mbGljdCBjb250cmFjdCBmb3JiaWRzXG4gKiAoIzEwNzYpLiBDbG9zaW5nIGFuZCByZS1yYWlzaW5nIGtlZXBzIHRoZSBhYmFuZG9uZWQgd29yayByZWFkYWJsZSBhbmRcbiAqIGxpbmtlZDsgYnJhbmNoIGNsZWFudXAgb3ducyB0aGUgYnJhbmNoJ3MgbGlmZWN5Y2xlIGZyb20gaGVyZVxuICogKGBicmFuY2hfY2xlYW51cC50c2ApLlxuICpcbiAqICoqUHJlY29uZGl0aW9ucyBhcmUgY2hlY2tlZCBiZWZvcmUgYW55dGhpbmcgaXMgZGVzdHJveWVkLioqIFRoZSBvcmRlciBiZWxvd1xuICogaXMgdGhlIHNhZmV0eSBwcm9wZXJ0eSwgbm90IGFuIGltcGxlbWVudGF0aW9uIGRldGFpbDpcbiAqXG4gKiAwLiB0aGUgc2hhcmVkIHtAbGluayBDT05GTElDVF9SRVNPTFVUSU9OX0JVREdFVH0gaGFzIGFjdHVhbGx5IGJlZW4gc3BlbnQg4oCUXG4gKiAgICBgZmFpbGVkQXR0ZW1wdHMgPCBDT05GTElDVF9SRVNPTFVUSU9OX0JVREdFVGAgZGVjbGluZXMgdGhlIGFiYW5kb25cbiAqICAgIG91dHJpZ2h0LCBiZWZvcmUgYW55dGhpbmcgZWxzZSBydW5zIChJc3N1ZSAjMzAwMCkuIFRoZSBzdGFsZS12ZXJkaWN0XG4gKiAgICBsYWRkZXIncyBvd24gcnVuZy1mYWlsZWQgY291bnQgdXNlZCB0byBiZSB0aGUgb25seSBnYXRlIHN0YW5kaW5nIGJldHdlZW5cbiAqICAgIGEgc2luZ2xlIGp1ZGdlZCBhdHRlbXB0IGFuZCBhIGNsb3NlLWFuZC1yZWRvOyB0aGlzIHJlYWRzIHRoZSBzYW1lXG4gKiAgICBQUi1zaWRlIHRhbGx5IHtAbGluayBzcGVudENvbmZsaWN0QXR0ZW1wdHN9IGRvZXMsIHNvIGFiYW5kb24tYW5kLXJlZG9cbiAqICAgIG5ldmVyIHJ1bnMgYWhlYWQgb2YgdGhlIGJ1ZGdldCBpdCBpcyBzdXBwb3NlZCB0byBmb2xsb3cuIEV4ZW1wdDogYVxuICogICAgYHN0YWxsZWRgIHJlYXNvbiAodGhlIHN0YWxsLXJlcGFpciBwYXNzJ3Mgc2Vjb25kIHRyaXAsIElzc3VlICMyODAyKSBpc1xuICogICAgbm90IGEgY29uZmxpY3QtcmVzb2x1dGlvbiBvdXRjb21lIGF0IGFsbCBhbmQgaGFzIGl0cyBvd24gdHdvLXRyaXAgYm91bmQ7XG4gKiAxLiB0aGUgUFIncyBvcmlnaW5hdGluZyBpc3N1ZSBpcyBrbm93biDigJQgYW5kIHdoZW4gaXQgaXMgbm90LCB0aGUgUFIgaXMgc3RpbGxcbiAqICAgIGNsb3NlZCwgYnV0IG9ubHkgYWZ0ZXIgdGhlIGBtZXJnZS1mYWxsYmFja2AgZmxhZyBpc3N1ZSBoYXMgYmVlbiBmaWxlZCBhc1xuICogICAgdGhlIHJlLWRvIGl0ZW0sIGNhcnJ5aW5nIGBpZGxlLXRhc2tgIGFuZCB0aGUgUFIncyBkaWZmIHN1bW1hcnlcbiAqICAgIChJc3N1ZSAjMjMxMCkuIFRoZSBydWxlIHRoaXMgcmVwbGFjZXMgd2FzIFwibm8gaXNzdWUsIG5vIGFiYW5kb25cIiwgb24gdGhlXG4gKiAgICBncm91bmRzIHRoYXQgY2xvc2luZyBhIFBSIHRoZSBmbGVldCBjYW5ub3QgcmUtcmFpc2UgbG9zZXMgdGhlIHdvcms7IHRoZVxuICogICAgcmVhc29uaW5nIGhvbGRzLCBhbmQgdGhlIGZsYWcgaXMgd2hhdCB0aGUgZmxlZXQgcmUtcmFpc2VzIGZyb20uIFdoYXQgaXNcbiAqICAgIGZvcmJpZGRlbiBpcyBjbG9zaW5nIHdpdGggKipubyBmaW5kYWJsZSByZWNvcmQqKiwgc28gYSBmbGFnIHRoYXQgY291bGQgbm90XG4gKiAgICBiZSBmaWxlZCBsZWF2ZXMgdGhlIFBSIG9wZW4gbmFtaW5nIHRoZSBgZmFsbGJhY2stZmxhZ2Agc3RlcDtcbiAqIDIuIHRoZXJlIGlzIG5vIGNhcCBvbiBob3cgbWFueSB0aW1lcyB0aGUgaXNzdWUgbWF5IGJlIHJlc3RhcnRlZFxuICogICAgKElzc3VlICMzMDMzKS4gVGhlIGZpcnN0IGZyZXNoIFBSIGlzIHJhaXNlZCBvZmYgYSBiYXNlIHRoYXQgaGFzIG9mdGVuXG4gKiAgICBtb3ZlZCBhZ2FpbiBieSB0aGUgdGltZSBpdCBjb25mbGljdHMsIGFuZCBldmVyeSBmdXJ0aGVyIHJlZG8gaXMgdGhlIHNhbWVcbiAqICAgIGJldCDigJQgYSBQUiB0aGF0IGNvbmZsaWN0cyByZXBlYXRlZGx5IGlzIG5ldmVyIGhhbmRlZCB0byBhIGh1bWFuOyBpdCBpc1xuICogICAgc2ltcGx5IHJlZG9uZSBhZ2Fpbi4gT25seSBhIGNsYWltIG5hbWluZyAqKnRoaXMqKiBQUiBkZWNsaW5lcyB0aGVcbiAqICAgIGFiYW5kb246IGl0IG1lYW5zIGFuIGVhcmxpZXIgYWJhbmRvbiBvZiB0aGlzIHZlcnkgUFIgY2xhaW1lZCB0aGUgcmVzdGFydFxuICogICAgYW5kIGRpZCBub3QgZmluaXNoLCBhbmQgY2xvc2luZyBpdCB0d2ljZSBpcyBub3QgYSByZXRyeS4gVGhlIGNsYWltXG4gKiAgICBjb3VudHMgb25seSB3aGVuIGEgKipmbGVldCBhY2NvdW50Kiogd3JvdGUgaXQgKElzc3VlICMxMjQ3KTogYSBjb21tZW50XG4gKiAgICBib2R5IGlzIHRleHQgYW55IEdpdEh1YiBhY2NvdW50IG1heSB3cml0ZSwgYW5kIGJvdGggZGlyZWN0aW9ucyB3ZXJlXG4gKiAgICBleHBsb2l0YWJsZSDigJQgYW4gb3V0c2lkZXIncyByZXN0YXJ0IG1hcmtlciBzdGFsbGVkIHRoZSBydW5nIGZvciBldmVyLFxuICogICAgYW5kIG91dHNpZGVyIGZhaWx1cmUgbWFya2VycyBvbiB0aGUgUFIgdGhyZWFkIHNwZW50IHRoZSBidWRnZXQgdGhhdFxuICogICAgYnJpbmdzIHRoZSBydW5nIGhlcmUgYXQgYWxsLiBBIGNsYWltIHdob3NlIGF1dGhvciBjYW5ub3QgYmUgZXN0YWJsaXNoZWRcbiAqICAgIHJlZnVzZXMgdGhlIGFiYW5kb24sIGFuZCB0aGUgbmV4dCBwYXNzIHJldHJpZXMgaXQsIHJhdGhlciB0aGFuIHJlbGF4aW5nXG4gKiAgICB0aGF0IGNoZWNrO1xuICogMy4gdGhlIGlzc3VlIGhhcyBubyAqb3RoZXIqIFBSIG9mIGl0cyBvd24uXG4gKlxuICogKipUaGUgcmUtcXVldWUgbmV2ZXIgY29zdHMgdGhlIGlzc3VlIGl0cyBwbGFjZSBpbiB0aGUgcXVldWUqKiAoSXNzdWUgIzIyNzcpLlxuICogQSBwaWNrdXAgbGFiZWwgdGhlIGlzc3VlIGFscmVhZHkgY2FycmllcyBpcyBrZXB0IGV4YWN0bHkgYXMgaXQgaXMg4oCUIGFcbiAqIGB0b3AtcHJpb3JpdHlgIGlzc3VlIHJlc3RhcnRlZCBhcyBgd29yay1vbmAgd291bGQgYmUgZGVtb3RlZCBieSBpdHMgb3duXG4gKiBmaXgg4oCUIGFuZCBhbiBpc3N1ZSBjYXJyeWluZyBub25lIGdhaW5zIGBpZGxlLXRhc2tgLCB0aGUgb25lIHBpY2t1cCBsYWJlbFxuICogYHdvcmtlcl9sYWJlbF9ndWFyZC50c2AgbGV0cyB0aGUgd29ya2VyIGFwcGx5LiBgbmVlZHMtaHVtYW5gIGlzIG5ldmVyIHBhcnRcbiAqIG9mIHRoaXMgcm91dGU6ICMxNzczIHNlbnQgYW4gaXNzdWUgdGhlcmUgYmVjYXVzZSB0aGUgd29ya2VyIG1heSBub3QgYXBwbHlcbiAqIGB3b3JrLW9uYCwgYnV0IGBpZGxlLXRhc2tgIHJlLXF1ZXVlcyBpdCB3aXRob3V0IGEgaHVtYW4gYXQgYWxsLlxuICpcbiAqICoqVGhlIHJlZG8gc3RhcnRzIG9uIGEgZnJlc2ggYnJhbmNoLCBuZXZlciBhIHJlc3VtZWQgb25lLioqIFRoZSByZS1xdWV1ZWRcbiAqIGlzc3VlJ3MgbmV4dCBydW4gY3V0cyBpdHMgYnJhbmNoIGZyb20gdGhlIGJhc2UgYnJhbmNoJ3MgdGhlbi1jdXJyZW50IHRpcDtcbiAqIGl0cyBzZXR1cCBwaGFzZSBza2lwcyBhbnkgYnJhbmNoIG5hbWVkIGluIGEgdHJ1c3RlZCByZXN0YXJ0IG1hcmtlciBvbiB0aGVcbiAqIGlzc3VlLCBzbyBpdCBuZXZlciByZXN1bWVzIHRoZSBhYmFuZG9uZWQgaGVhZCAoc2VlXG4gKiBgbGliL2NvbmZsaWN0X3JlZG9fYnJhbmNoLnRzYCkuXG4gKlxuICogVGhlIHJlc3RhcnQgbWFya2VyIGlzIHJlY29yZGVkICoqb24gdGhlIGlzc3VlKiosIG5vdCBvbiB0aGUgUFI6IHRoZSBQUiBiZWluZ1xuICogY291bnRlZCBpcyBjbG9zZWQgbW9tZW50cyBsYXRlciBhbmQgYSBuZXcgb25lIHRha2VzIGl0cyBwbGFjZSwgc28gYSBQUi1rZXllZFxuICogbWFya2VyIHdvdWxkIHBhc3MgYSBzaW5nbGUtY3ljbGUgdGVzdCBhbmQgbG9vcCBpbiBwcm9kdWN0aW9uLiBJdCBpcyBwb3N0ZWRcbiAqICpiZWZvcmUqIHRoZSBjbG9zZSBmb3IgdGhlIHNhbWUgcmVhc29uIHRoZSBhdHRlbXB0IG1hcmtlciBpcyBwb3N0ZWQgYmVmb3JlXG4gKiB0aGUgbWVyZ2Ug4oCUIGl0IGlzIHRoZSBjbGFpbSB0d28gaG9zdHMgcmFjZSBmb3IsIGFuZCB0aGUgbG9zZXIgbXVzdCBsb3NlXG4gKiBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLlxuICpcbiAqIEV2ZXJ5IHN0ZXAgdGhhdCBmYWlscyByZXR1cm5zIHRoZSBzdGVwJ3MgbmFtZSwgYW5kIHRoZSBjYWxsZXIgcmVjb3JkcyBpdDogYVxuICogcGFydGlhbCBhYmFuZG9uIOKAlCB3b3JzdCBvZiBhbGwgXCJQUiBjbG9zZWQsIGlzc3VlIG5vdCByZS1xdWV1ZWRcIiDigJQgbXVzdCBiZVxuICogdmlzaWJsZSByYXRoZXIgdGhhbiB3aGVyZSB0aGlzIHF1aWV0bHkgc3RvcHMuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBMb2dnZXIsIFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHR5cGUgeyBHaXRSdW5uZXIgfSBmcm9tIFwiLi9naXRfYmFzZV9yZWYudHNcIjtcbmltcG9ydCB7XG4gIHR5cGUgQ29uZmxpY3RJc3N1ZUNvbnRleHQsXG4gIGdhdGhlckNvbmZsaWN0SXNzdWVDb250ZXh0LFxuICB0eXBlIE9yaWdpbmF0aW5nSXNzdWUsXG4gIHR5cGUgUHJVbnJlc29sdmVkUmVhc29uLFxufSBmcm9tIFwiLi9jb25mbGljdF9pc3N1ZV9jb250ZXh0LnRzXCI7XG5pbXBvcnQge1xuICBDT05GTElDVF9BVFRFTVBUX01BUktFUixcbiAgQ09ORkxJQ1RfRkFJTEVEX01BUktFUixcbiAgQ09ORkxJQ1RfUkVTT0xVVElPTl9CVURHRVQsXG4gIHR5cGUgQ29uZmxpY3RSZXNvbHV0aW9uQXR0ZW1wdCxcbiAgTUVSR0VfQ09ORkxJQ1RfTEFCRUwsXG4gIHJlYWRSZXNvbHV0aW9uQXR0ZW1wdHMsXG4gIHNwZW50Q29uZmxpY3RBdHRlbXB0cyxcbn0gZnJvbSBcIi4vbWVyZ2VfY29uZmxpY3RfbWFya2Vycy50c1wiO1xuaW1wb3J0IHsgaXNGbGVldEF1dGhvciB9IGZyb20gXCIuL2ZsZWV0X2F1dGhvcnMudHNcIjtcbmltcG9ydCB7XG4gIHR5cGUgUGFyc2VkU3RhZ2VUaW1pbmdzLFxuICBwYXJzZVN0YWdlVGltaW5nc0xpbmUsXG4gIHJlYWRQckRpZmZTdW1tYXJ5LFxuICByZWFkUHJEaXZlcmdlbmNlLFxufSBmcm9tIFwiLi9jb25mbGljdF9mYWxsYmFja19jb250ZXh0LnRzXCI7XG5pbXBvcnQge1xuICBjcmVhdGVGYWxsYmFja0ZsYWdGaWxlcixcbiAgTUVSR0VfRkFMTEJBQ0tfVEFSR0VUX1JFUE8sXG4gIHR5cGUgTWVyZ2VGYWxsYmFja0ZpbGluZyxcbiAgdHlwZSBNZXJnZUZhbGxiYWNrT3V0Y29tZSxcbiAgdHlwZSBNZXJnZUZhbGxiYWNrUnVuLFxufSBmcm9tIFwiLi9tZXJnZV9mYWxsYmFja19pc3N1ZS50c1wiO1xuaW1wb3J0IHsgQ09OU1VMVEVEX0lTU1VFU19IRUFESU5HIH0gZnJvbSBcIi4vY29uZmxpY3RfaW50ZW50X2F1ZGl0LnRzXCI7XG5pbXBvcnQgeyBESVNDT1ZFUllfTEFCRUxTIH0gZnJvbSBcIi4vY29uZmlnX2RlZmF1bHRzLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RBU0tfTEFCRUwgfSBmcm9tIFwiLi9pZGxlX3Rhc2tfaXNzdWUudHNcIjtcbmltcG9ydCB7IHByVGl0bGVNYXRjaGVzSXNzdWUgfSBmcm9tIFwiLi9wcl90aXRsZV9pc3N1ZV9yZWYudHNcIjtcbmltcG9ydCB7IHNhbml0aXNlSXNzdWVUZXh0IH0gZnJvbSBcIi4vY29uZmxpY3RfaW50ZW50X2NvbnRleHQudHNcIjtcbmltcG9ydCB7IGFkZExhYmVsVG9Jc3N1ZSB9IGZyb20gXCIuL2xhYmVsX29wZXJhdGlvbnMudHNcIjtcbmltcG9ydCB7IGZldGNoSXNzdWVDb21tZW50UGFnZXMgfSBmcm9tIFwiLi9pc3N1ZV9jb21tZW50X3BhZ2VzLnRzXCI7XG5pbXBvcnQgeyBwYXJ0aXRpb25Db25mbGljdENvbW1lbnRzIH0gZnJvbSBcIi4vY29uZmxpY3RfbWFya2VyX3RydXN0LnRzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTWFya2VyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBNYXJrZXIgcmVjb3JkZWQgb24gdGhlICoqb3JpZ2luYXRpbmcgaXNzdWUqKiB3aGVuIGl0IGlzIHJlc3RhcnRlZC5cbiAqXG4gKiBDYW5vbmljYWwgYHZpYmUtKmAgZ3JhbW1hciDigJQgYSBiYXJlIGB2aWJlLWAgcHJlZml4IGFuZCBga2V5PVwidmFsdWVcImBcbiAqIGF0dHJpYnV0ZXMgKElzc3VlICM4NDIpLiBUaGUgb2xkZXIgYHZpYmUtY29kZXI6bWVyZ2UtY29uZmxpY3QtKmAgbWFya2Vyc1xuICogYmVzaWRlIGl0IGFyZSBmcm96ZW4gb25seSBiZWNhdXNlIHRoZXkgYXJlIGFscmVhZHkgaW4gbGl2ZSBjb21tZW50IHRocmVhZHM7XG4gKiBhIG5ldyBtYXJrZXIgaGFzIG5vIHN1Y2ggZGF0YSB0byBzdGF5IGNvbXBhdGlibGUgd2l0aC5cbiAqXG4gKiBUaGVyZSBpcyBubyBjYXAgb24gaG93IG1hbnkgb2YgdGhlc2UgYW4gaXNzdWUgbWF5IGNhcnJ5IChJc3N1ZSAjMzAzMyk6IGl0c1xuICogcHJlc2VuY2UgaXMgd2hhdCBtYWtlcyB0d28gaG9zdHMgc2Nhbm5pbmcgdGhlIHNhbWUgZXhoYXVzdGVkIFBSIHByb2R1Y2Ugb25lXG4gKiBhYmFuZG9uLCBhbmQgaXQgcmVjb3JkcyB0aGUgYWJhbmRvbmVkIGJyYW5jaCBzbyB0aGUgcmVkbydzIHNldHVwIHBoYXNlIGNhblxuICogc2tpcCByZXN1bWluZyBpdCAoc2VlIGBsaWIvY29uZmxpY3RfcmVkb19icmFuY2gudHNgKS5cbiAqL1xuZXhwb3J0IGNvbnN0IENPTkZMSUNUX1JFU1RBUlRfTUFSS0VSID0gXCI8IS0tIHZpYmUtbWVyZ2UtY29uZmxpY3QtcmVzdGFydFwiO1xuXG4vKipcbiAqIFRoZSBtYXJrZXIgY29tbWVudCBsaW5lIGZvciBvbmUgYWJhbmRvbmVkIFBSLlxuICpcbiAqIGBicmFuY2hOYW1lYCBpcyBhcHBlbmRlZCBhcyBhIGBicmFuY2g9XCLigKZcImAgYXR0cmlidXRlIG9ubHkgd2hlbiBpdCBtYXRjaGVzXG4gKiB0aGUgc2FmZSBicmFuY2gtbmFtZSBzaGFwZSAobm8gYC4uYCwgbm8gc2hlbGwtIG9yIG1hcmt1cC1ob3N0aWxlXG4gKiBjaGFyYWN0ZXJzKSDigJQgYW4gdW5zYWZlIG9yIG9taXR0ZWQgbmFtZSBzaW1wbHkgbGVhdmVzIHRoZSBhdHRyaWJ1dGUgb2ZmXG4gKiByYXRoZXIgdGhhbiBlbWl0dGluZyBhIHZhbHVlIG5vdGhpbmcgZG93bnN0cmVhbSBjYW4gdHJ1c3QuXG4gKi9cbmNvbnN0IFNBRkVfQlJBTkNIX05BTUUgPSAvXltBLVphLXowLTkuX1xcLy1dezEsMjU1fSQvO1xuXG5leHBvcnQgZnVuY3Rpb24gY29uZmxpY3RSZXN0YXJ0TWFya2VyKFxuICByZXBvOiBzdHJpbmcsXG4gIHByTnVtYmVyOiBudW1iZXIsXG4gIGJyYW5jaE5hbWU/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCBicmFuY2hBdHRyID0gYnJhbmNoTmFtZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICBTQUZFX0JSQU5DSF9OQU1FLnRlc3QoYnJhbmNoTmFtZSkgJiYgIWJyYW5jaE5hbWUuaW5jbHVkZXMoXCIuLlwiKVxuICAgID8gYCBicmFuY2g9XCIke2JyYW5jaE5hbWV9XCJgXG4gICAgOiBcIlwiO1xuICByZXR1cm4gYCR7Q09ORkxJQ1RfUkVTVEFSVF9NQVJLRVJ9IHByPVwiJHtyZXBvfSMke3ByTnVtYmVyfVwiJHticmFuY2hBdHRyfSAtLT5gO1xufVxuXG4vKiogV2hldGhlciBhIHJhdyBjb21tZW50IGNhcnJpZXMgYSByZXN0YXJ0IGNsYWltIGF0IGFsbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYXJyaWVzUmVzdGFydE1hcmtlcihyYXc6IHVua25vd24pOiBib29sZWFuIHtcbiAgaWYgKHR5cGVvZiByYXcgIT09IFwib2JqZWN0XCIgfHwgcmF3ID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGJvZHkgPSAocmF3IGFzIHsgYm9keT86IHVua25vd24gfSkuYm9keTtcbiAgcmV0dXJuIHR5cGVvZiBib2R5ID09PSBcInN0cmluZ1wiICYmIGJvZHkuaW5jbHVkZXMoQ09ORkxJQ1RfUkVTVEFSVF9NQVJLRVIpO1xufVxuXG4vKipcbiAqIFRoZSBQUnMgYSB0aHJlYWQncyByZXN0YXJ0IG1hcmtlcnMgbmFtZSwgaW4gdGhlIG9yZGVyIHRoZXkgYXBwZWFyLlxuICpcbiAqIEEgbWFya2VyIG5hbWluZyAqdGhpcyogUFIgbWVhbnMgYW4gZWFybGllciBhYmFuZG9uIG9mIGl0IGNsYWltZWQgdGhlXG4gKiByZXN0YXJ0IGFuZCB0aGVuIGRpZCBub3QgZmluaXNoIOKAlCBhIGRpZmZlcmVudCBmYWN0IGZyb20gXCJ0aGUgd29yayB3YXNcbiAqIHJlc3RhcnRlZCBhbmQgaXRzIHJlcGxhY2VtZW50IGZhaWxlZCB0b29cIiwgYW5kIHRoZSBodW1hbi1mYWNpbmcgdGV4dCBoYXMgdG9cbiAqIHRlbGwgdGhlbSBhcGFydC4gQW4gdW5wYXJzZWFibGUgbWFya2VyIHN0aWxsIGNvdW50cyBhcyBhIHJlc3RhcnQ6IGl0IGlzIGFcbiAqIGNsYWltLCBhbmQgdGhlIGJvdW5kIG11c3QgZmFpbCB0b3dhcmRzIG5vdCBhYmFuZG9uaW5nIHR3aWNlLlxuICpcbiAqICoqQXV0aG9yLWJsaW5kIGJ5IGNvbnN0cnVjdGlvbioqIChJc3N1ZSAjMTI0Nyk6IHRoaXMgbWFya2VyICpzdXBwcmVzc2VzKiB0aGVcbiAqIGRlc3RydWN0aXZlIHN0ZXAsIHNvIGRpc2NhcmRpbmcgb25lIHRoYXQgY2Fubm90IGJlIGF0dHJpYnV0ZWQgd291bGQgcmVsYXggYVxuICogc2FmZXR5IGNoZWNrIHJhdGhlciB0aGFuIHRpZ2h0ZW4gaXQuIHtAbGluayBhYmFuZG9uQW5kUmVzdGFydH0gdGhlcmVmb3JlXG4gKiBhdHRyaWJ1dGVzIHRoZSB0aHJlYWQgZmlyc3QgYW5kIHJlZnVzZXMgb3V0cmlnaHQgd2hlbiBhIGNsYWltIGNhbm5vdCBiZVxuICogYXR0cmlidXRlZCwgaW5zdGVhZCBvZiBxdWlldGx5IHByb2NlZWRpbmcuIFBhc3MgdGhlIHRydXN0ZWQgY29tbWVudHMgb25seS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3RhcnRNYXJrZXJQck51bWJlcnMoXG4gIGNvbW1lbnRzOiByZWFkb25seSB1bmtub3duW10sXG4pOiBBcnJheTxudW1iZXIgfCBudWxsPiB7XG4gIGNvbnN0IGZvdW5kOiBBcnJheTxudW1iZXIgfCBudWxsPiA9IFtdO1xuICBmb3IgKGNvbnN0IHJhdyBvZiBjb21tZW50cykge1xuICAgIGlmICghY2Fycmllc1Jlc3RhcnRNYXJrZXIocmF3KSkgY29udGludWU7XG4gICAgY29uc3QgYm9keSA9IChyYXcgYXMgeyBib2R5OiBzdHJpbmcgfSkuYm9keTtcbiAgICBjb25zdCBpbmRleCA9IGJvZHkuaW5kZXhPZihDT05GTElDVF9SRVNUQVJUX01BUktFUik7XG4gICAgY29uc3QgbWF0Y2ggPSAvcHI9XCJbXlwiI10qIyhcXGQrKVwiLy5leGVjKGJvZHkuc2xpY2UoaW5kZXgpKTtcbiAgICBjb25zdCBudW1iZXIgPSBtYXRjaCA/IE51bWJlcihtYXRjaFsxXSkgOiBOYU47XG4gICAgZm91bmQucHVzaChOdW1iZXIuaXNTYWZlSW50ZWdlcihudW1iZXIpICYmIG51bWJlciA+IDAgPyBudW1iZXIgOiBudWxsKTtcbiAgfVxuICByZXR1cm4gZm91bmQ7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQXR0ZW1wdCBoaXN0b3J5LCByZWFkIGJhY2sgb2ZmIHRoZSBQUlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBDaGFyYWN0ZXJzIG9mIG9uZSByZWNvcmRlZCBmYWlsdXJlIGtlcHQgZm9yIHRoZSBhYmFuZG9uIGNvbW1lbnQuICovXG5jb25zdCBNQVhfQVRURU1QVF9ERVRBSUxfQ0hBUlMgPSA1MDA7XG5cbi8qKiBDb25mbGljdGVkIHBhdGhzIGxpc3RlZCBpbiB0aGUgYWJhbmRvbiBjb21tZW50LiAqL1xuY29uc3QgTUFYX0NPTkZMSUNURURfUEFUSFMgPSAyMDtcblxuLyoqIGAtIFxcYHBhdGhcXGBgIGFzIHtAbGluayBDT05GTElDVF9GQUlMRURfTUFSS0VSfSBjb21tZW50cyBsaXN0IHRoZW0uICovXG5jb25zdCBDT05GTElDVEVEX1BBVEhfTElORSA9IC9eLVxccytgKFteYF0rKWBcXHMqJC87XG5cbi8qKiBPbmUgY29uY2x1ZGVkLCBmYWlsZWQgYXR0ZW1wdCBhcyBpdHMgY29tbWVudCByZWNvcmRlZCBpdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRmFpbGVkQXR0ZW1wdFN1bW1hcnkge1xuICAvKiogQXR0ZW1wdCBudW1iZXIgdGhlIG1hcmtlciBjYXJyaWVkLCBvciBgbnVsbGAgd2hlbiBpdCBjYXJyaWVkIG5vbmUuICovXG4gIGF0dGVtcHQ6IG51bWJlciB8IG51bGw7XG4gIC8qKiBUaGUgcmVjb3JkZWQgcmVhc29uLCBib3VuZGVkIGZvciBjb21tZW50IHVzZS4gKi9cbiAgZGV0YWlsOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgc3RhZ2UgdGltaW5ncyBhbmQgaG9zdCB0aGUgc2FtZSBjb21tZW50IGNhcnJpZWQgKElzc3VlICMyMzA4KSwgd2hlbiBpdFxuICAgKiBjYXJyaWVkIHRoZW0uIFJlYWQgaGVyZSByYXRoZXIgdGhhbiBpbiBhIHNlY29uZCBwYXNzIG92ZXIgdGhlIHRocmVhZDogdHdvXG4gICAqIHBhc3NlcyBwYWlyZWQgYnkgaW5kZXggYXR0cmlidXRlIG9uZSBydW4ncyBtaW51dGVzIHRvIGFub3RoZXIgdGhlIG1vbWVudFxuICAgKiBlaXRoZXIgZmlsdGVyIGNoYW5nZXMsIGFuZCBub3RoaW5nIGZhaWxzIHdoZW4gdGhleSBkby5cbiAgICovXG4gIHRpbWluZ3M/OiBQYXJzZWRTdGFnZVRpbWluZ3M7XG59XG5cbi8qKiBXaGF0IHRoZSBhdHRlbXB0cyBvbiBhIFBSIHJlY29yZGVkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBGYWlsZWRBdHRlbXB0SGlzdG9yeSB7XG4gIGF0dGVtcHRzOiBGYWlsZWRBdHRlbXB0U3VtbWFyeVtdO1xuICAvKiogQ29uZmxpY3RlZCBwYXRocyBuYW1lZCBhY3Jvc3MgdGhvc2UgYXR0ZW1wdHMsIG5ld2VzdCBmaXJzdCwgZGVkdXBlZC4gKi9cbiAgY29uZmxpY3RlZFBhdGhzOiBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIElzc3VlcyB0aGUgYXR0ZW1wdHMgY29uc3VsdGVkLCBmcm9tIHRoZSBjb25zdWx0ZWQtaXNzdWVzIHNlY3Rpb24gIzExMTRcbiAgICogd3JpdGVzIG9udG8gZWFjaCBhdHRlbXB0IGNvbW1lbnQuIFJlYWQgYmFjayByYXRoZXIgdGhhbiByZS1kZXJpdmVkOiB0aGVcbiAgICogYmFzZSBzaWRlIG5lZWRzIGEgY2xvbmUgdG8gd2FsaywgYW5kIGJ5IG5vdyB0aGVyZSBpcyBub25lLlxuICAgKi9cbiAgY29uc3VsdGVkSXNzdWVzOiBudW1iZXJbXTtcbiAgLyoqXG4gICAqIFRoZSBzaGFyZWQtYnVkZ2V0IGF0dGVtcHQgaGlzdG9yeSAoSXNzdWUgIzI5OTYsICMzMDAwKSwgcmVhZCBiYWNrIHdpdGhcbiAgICoge0BsaW5rIHJlYWRSZXNvbHV0aW9uQXR0ZW1wdHN9IG92ZXIgdGhlIHNhbWUgdHJ1c3RlZCBjb21tZW50cy4gVGhpcyBpc1xuICAgKiB3aGF0IHtAbGluayByZW5kZXJBdHRlbXB0VGFibGV9IHJlbmRlcnMsIGFuZCB3aGF0IHRoZSBzcGVudC1idWRnZXQgZ3VhcmRcbiAgICogaW4ge0BsaW5rIGFiYW5kb25BbmRSZXN0YXJ0fSB0YWxsaWVzIHdpdGgge0BsaW5rIHNwZW50Q29uZmxpY3RBdHRlbXB0c30uXG4gICAqL1xuICByZXNvbHV0aW9uQXR0ZW1wdHM6IENvbmZsaWN0UmVzb2x1dGlvbkF0dGVtcHRbXTtcbn1cblxuLyoqIElzc3VlcyBuYW1lZCBpbiBvbmUgYXR0ZW1wdCBjb21tZW50J3MgY29uc3VsdGVkLWlzc3VlcyBzZWN0aW9uLiAqL1xuZnVuY3Rpb24gY29uc3VsdGVkSXNzdWVzRnJvbShib2R5OiBzdHJpbmcpOiBudW1iZXJbXSB7XG4gIGNvbnN0IHN0YXJ0ID0gYm9keS5pbmRleE9mKENPTlNVTFRFRF9JU1NVRVNfSEVBRElORyk7XG4gIGlmIChzdGFydCA8IDApIHJldHVybiBbXTtcbiAgY29uc3QgbnVtYmVyczogbnVtYmVyW10gPSBbXTtcbiAgZm9yIChcbiAgICBjb25zdCBtYXRjaCBvZiBib2R5LnNsaWNlKHN0YXJ0KS5tYXRjaEFsbCgvIyhcXGR7MSw5fSlcXGIvZylcbiAgKSB7XG4gICAgY29uc3QgbnVtYmVyID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgICBpZiAoTnVtYmVyLmlzU2FmZUludGVnZXIobnVtYmVyKSAmJiBudW1iZXIgPiAwKSBudW1iZXJzLnB1c2gobnVtYmVyKTtcbiAgfVxuICByZXR1cm4gbnVtYmVycztcbn1cblxuLyoqIFRoZSBhdHRlbXB0IG51bWJlciBhIGZhaWx1cmUgbWFya2VyIG5hbWVzLCBvciBgbnVsbGAuICovXG5mdW5jdGlvbiBhdHRlbXB0TnVtYmVyRnJvbShib2R5OiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSAvbWVyZ2UtY29uZmxpY3QtZmFpbGVkXFxzK249XCIoXFxkKylcIi8uZXhlYyhib2R5KTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG51bWJlciA9IE51bWJlcihtYXRjaFsxXSk7XG4gIHJldHVybiBOdW1iZXIuaXNTYWZlSW50ZWdlcihudW1iZXIpICYmIG51bWJlciA+IDAgPyBudW1iZXIgOiBudWxsO1xufVxuXG4vKipcbiAqIFJlYWQgdGhlIGNvbmNsdWRlZCBmYWlsdXJlcyBvdXQgb2YgYSBQUidzIGNvbW1lbnQgdGhyZWFkLlxuICpcbiAqIFRoZSByZWFzb25zIGFyZSB0aGUgZmFpbHVyZSBjb21tZW50cycgb3duIHdvcmRzIHJhdGhlciB0aGFuIGEgcmUtZGVyaXZhdGlvbjpcbiAqIHRoZSBhYmFuZG9uIGNvbW1lbnQgbXVzdCBzYXkgd2hhdCB0aGUgZmxlZXQgYWN0dWFsbHkgcmVjb3JkZWQsIGFuZCBvbmx5IHRoZVxuICogY29tbWVudHMga25vdyB0aGF0IG9uY2UgdGhlIHJ1biB0aGF0IHdyb3RlIHRoZW0gaXMgZ29uZS5cbiAqXG4gKiBAcGFyYW0gY29tbWVudHMgLSBUaGUgUFIncyB0aHJlYWQsIG9sZGVzdCBmaXJzdC5cbiAqIEBwYXJhbSB0cnVzdGVkQXV0aG9ycyAtIEZsZWV0IGxvZ2lucyAoSXNzdWUgIzEyNDcpIOKAlCBhbHNvIHdoYXRcbiAqICAge0BsaW5rIHJlYWRSZXNvbHV0aW9uQXR0ZW1wdHN9IGF0dHJpYnV0ZXMge0BsaW5rIENvbmZsaWN0UmVzb2x1dGlvbkF0dGVtcHR9XG4gKiAgIG1hcmtlcnMgYWdhaW5zdCBmb3Ige0BsaW5rIEZhaWxlZEF0dGVtcHRIaXN0b3J5LnJlc29sdXRpb25BdHRlbXB0c30uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpc2VGYWlsZWRBdHRlbXB0cyhcbiAgY29tbWVudHM6IHJlYWRvbmx5IHVua25vd25bXSxcbiAgdHJ1c3RlZEF1dGhvcnM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogRmFpbGVkQXR0ZW1wdEhpc3Rvcnkge1xuICBjb25zdCBhdHRlbXB0czogRmFpbGVkQXR0ZW1wdFN1bW1hcnlbXSA9IFtdO1xuICBjb25zdCBjb25mbGljdGVkUGF0aHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGNvbnN1bHRlZElzc3VlczogbnVtYmVyW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IHJhdyBvZiBjb21tZW50cykge1xuICAgIGlmICh0eXBlb2YgcmF3ICE9PSBcIm9iamVjdFwiIHx8IHJhdyA9PT0gbnVsbCkgY29udGludWU7XG4gICAgY29uc3QgYm9keSA9IChyYXcgYXMgeyBib2R5PzogdW5rbm93biB9KS5ib2R5O1xuICAgIGlmICh0eXBlb2YgYm9keSAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG5cbiAgICAvLyBUaGUgY29uc3VsdGVkLWlzc3VlcyByZWNvcmQgcmlkZXMgdGhlICphdHRlbXB0KiBjb21tZW50IChJc3N1ZSAjMTExNCksXG4gICAgLy8gbm90IHRoZSBmYWlsdXJlIGNvbmNsdXNpb24sIHNvIGl0IGlzIGNvbGxlY3RlZCBmcm9tIHRoZSB3aG9sZSB0aHJlYWQuXG4gICAgaWYgKGJvZHkuaW5jbHVkZXMoQ09ORkxJQ1RfQVRURU1QVF9NQVJLRVIpKSB7XG4gICAgICBmb3IgKGNvbnN0IGlzc3VlTnVtYmVyIG9mIGNvbnN1bHRlZElzc3Vlc0Zyb20oYm9keSkpIHtcbiAgICAgICAgaWYgKCFjb25zdWx0ZWRJc3N1ZXMuaW5jbHVkZXMoaXNzdWVOdW1iZXIpKSB7XG4gICAgICAgICAgY29uc3VsdGVkSXNzdWVzLnB1c2goaXNzdWVOdW1iZXIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFib2R5LmluY2x1ZGVzKENPTkZMSUNUX0ZBSUxFRF9NQVJLRVIpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGxpbmVzID0gYm9keS5zcGxpdChcIlxcblwiKTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAgIGNvbnN0IG1hdGNoID0gQ09ORkxJQ1RFRF9QQVRIX0xJTkUuZXhlYyhsaW5lLnRyaW0oKSk7XG4gICAgICBjb25zdCBwYXRoID0gbWF0Y2g/LlsxXT8udHJpbSgpO1xuICAgICAgaWYgKFxuICAgICAgICBwYXRoICE9PSB1bmRlZmluZWQgJiYgcGF0aC5sZW5ndGggPiAwICYmXG4gICAgICAgICFjb25mbGljdGVkUGF0aHMuaW5jbHVkZXMocGF0aClcbiAgICAgICkge1xuICAgICAgICBjb25mbGljdGVkUGF0aHMucHVzaChwYXRoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBkZXRhaWwgPSBsaW5lc1xuICAgICAgLmZpbHRlcigobGluZSkgPT4gIWxpbmUudHJpbSgpLnN0YXJ0c1dpdGgoXCI8IS0tXCIpKVxuICAgICAgLmpvaW4oXCJcXG5cIilcbiAgICAgIC50cmltKClcbiAgICAgIC5zbGljZSgwLCBNQVhfQVRURU1QVF9ERVRBSUxfQ0hBUlMpO1xuICAgIGNvbnN0IHRpbWluZ3MgPSBwYXJzZVN0YWdlVGltaW5nc0xpbmUoYm9keSk7XG4gICAgYXR0ZW1wdHMucHVzaCh7XG4gICAgICBhdHRlbXB0OiBhdHRlbXB0TnVtYmVyRnJvbShib2R5KSxcbiAgICAgIGRldGFpbCxcbiAgICAgIC4uLih0aW1pbmdzICE9PSB1bmRlZmluZWQgPyB7IHRpbWluZ3MgfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgYXR0ZW1wdHMsXG4gICAgY29uZmxpY3RlZFBhdGhzOiBjb25mbGljdGVkUGF0aHMuc2xpY2UoMCwgTUFYX0NPTkZMSUNURURfUEFUSFMpLFxuICAgIGNvbnN1bHRlZElzc3VlcyxcbiAgICByZXNvbHV0aW9uQXR0ZW1wdHM6IHJlYWRSZXNvbHV0aW9uQXR0ZW1wdHMoXG4gICAgICBjb21tZW50cyxcbiAgICAgIChsb2dpbikgPT4gaXNGbGVldEF1dGhvcihsb2dpbiwgWy4uLnRydXN0ZWRBdXRob3JzXSksXG4gICAgKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBCb3RoIHJ1bnMgYXMgdGhlIGBtZXJnZS1mYWxsYmFja2AgZmxhZyBpc3N1ZSByZWNvcmRzIHRoZW0gKElzc3VlICMyMzEwKS5cbiAqXG4gKiBFdmVyeSBmaWVsZCBjb21lcyBvZmYgb25lIHtAbGluayBGYWlsZWRBdHRlbXB0U3VtbWFyeX0g4oCUIHRoZSBhZ2VudCdzIG93blxuICogd29yZHMsIGFuZCB0aGUgc3RhZ2UgdGltaW5ncyBhbmQgaG9zdCB0aGUgc2FtZSBjb21tZW50IGNhcnJpZWQg4oCUIHNvIGEgcnVuJ3NcbiAqIG1pbnV0ZXMgY2FuIG5ldmVyIGJlIGF0dHJpYnV0ZWQgdG8gYSBkaWZmZXJlbnQgcnVuLiBUaGUgcnVuIHRoYXQgbWVhc3VyZWRcbiAqIHRoZW0gaXMgbG9uZyBnb25lIGJ5IHRoZSB0aW1lIGEgZmFsbGJhY2sgcnVucywgc28gdGhlIHRocmVhZCBpcyB0aGUgb25seVxuICogc3Vydml2aW5nIHNvdXJjZSBmb3IgZWl0aGVyLlxuICpcbiAqIEBwYXJhbSBoaXN0b3J5IC0gV2hhdCB7QGxpbmsgc3VtbWFyaXNlRmFpbGVkQXR0ZW1wdHN9IHJlYWQgb2ZmIHRoZSBQUidzXG4gKiAgIHRocmVhZCwgd2hpY2ggdGhlIGNhbGxlcnMgaGF2ZSBhbHJlYWR5IHJlZHVjZWQgdG8gdGhlIGZsZWV0J3Mgb3duIGNvbW1lbnRzXG4gKiBAcmV0dXJucyBPbmUgcnVuIHBlciBjb25jbHVkZWQgZmFpbHVyZSwgaW4gdGhlIG9yZGVyIHRoZSB0aHJlYWQgcmVjb3JkcyB0aGVtXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZUZhbGxiYWNrUnVuc0Zyb21IaXN0b3J5KFxuICBoaXN0b3J5OiBGYWlsZWRBdHRlbXB0SGlzdG9yeSxcbik6IE1lcmdlRmFsbGJhY2tSdW5bXSB7XG4gIHJldHVybiBoaXN0b3J5LmF0dGVtcHRzLm1hcCgoYXR0ZW1wdCwgaW5kZXgpID0+ICh7XG4gICAgcnVuOiBhdHRlbXB0LmF0dGVtcHQgPz8gaW5kZXggKyAxLFxuICAgIC4uLihhdHRlbXB0LmRldGFpbC5sZW5ndGggPiAwID8geyBhbmFseXNpczogYXR0ZW1wdC5kZXRhaWwgfSA6IHt9KSxcbiAgICAuLi4oYXR0ZW1wdC50aW1pbmdzICE9PSB1bmRlZmluZWQgJiYgYXR0ZW1wdC50aW1pbmdzLnRpbWluZ3MubGVuZ3RoID4gMFxuICAgICAgPyB7IHRpbWluZ3M6IGF0dGVtcHQudGltaW5ncy50aW1pbmdzIH1cbiAgICAgIDoge30pLFxuICAgIC4uLihhdHRlbXB0LnRpbWluZ3M/Lmhvc3QgIT09IHVuZGVmaW5lZFxuICAgICAgPyB7IGhvc3Q6IGF0dGVtcHQudGltaW5ncy5ob3N0IH1cbiAgICAgIDoge30pLFxuICB9KSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGhlIHJlLXF1ZXVlIGxhYmVsXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBUaGUgcGlja3VwIGxhYmVscywgaGlnaGVzdCBwcmlvcml0eSBmaXJzdCAoSXNzdWUgIzIyNzcpLlxuICpcbiAqIFRoZSB0aHJlZSBoYXJkd2lyZWQgZGlzY292ZXJ5IGxhYmVscyBpbiB0aGVpciBjYW5vbmljYWwgb3JkZXIsIHRoZW5cbiAqIGBpZGxlLXRhc2tgIOKAlCB0aGUgbG93ZXN0IHBpY2t1cCBzaWduYWwsIGFuZCB0aGUgb25seSBvbmUgb2YgdGhlIGZvdXIgdGhlXG4gKiB3b3JrZXIgbWF5IGFwcGx5IGl0c2VsZiAoYHdvcmtlcl9sYWJlbF9ndWFyZC50c2ApLlxuICovXG5jb25zdCBQSUNLVVBfTEFCRUxTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgLi4uRElTQ09WRVJZX0xBQkVMUyxcbiAgSURMRV9UQVNLX0xBQkVMLFxuXTtcblxuLyoqIFdoaWNoIHBpY2t1cCBsYWJlbCBhIHJlLXF1ZXVlZCBpc3N1ZSBlbmRzIHVwIGNhcnJ5aW5nIChJc3N1ZSAjMjI3NykuICovXG5leHBvcnQgdHlwZSBSZXF1ZXVlTGFiZWwgPVxuICAvKiogSXQgYWxyZWFkeSBjYXJyaWVkIHRoaXMgb25lLCBhbmQgdGhlIGFiYW5kb24gbGVmdCBpdCBhbG9uZS4gKi9cbiAgfCB7IGtlcHQ6IHN0cmluZyB9XG4gIC8qKiBJdCBjYXJyaWVkIG5vbmUsIHNvIHRoZSB3b3JrZXIgYXBwbGllZCBgaWRsZS10YXNrYC4gKi9cbiAgfCB7IGFwcGxpZWQ6IHR5cGVvZiBJRExFX1RBU0tfTEFCRUwgfTtcblxuLyoqXG4gKiBEZWNpZGUgdGhlIHJlLXF1ZXVlIGxhYmVsIGZyb20gdGhlIGlzc3VlJ3Mgb3duIGxhYmVscy5cbiAqXG4gKiBLZWVwaW5nIHdoYXQgaXMgdGhlcmUgaXMgdGhlIHBvaW50OiBhbiBpc3N1ZSBhIGh1bWFuIHJhaXNlZCBhc1xuICogYHRvcC1wcmlvcml0eWAgbXVzdCBjb21lIGJhY2sgYXMgYHRvcC1wcmlvcml0eWAsIG5vdCBiZSByZWxhYmVsbGVkIGRvd24gdG9cbiAqIHdoYXRldmVyIHRoZSB3b3JrZXIgaGFwcGVucyB0byBiZSBwZXJtaXR0ZWQgdG8gYXBwbHkuIE9ubHkgYW4gaXNzdWUgd2l0aCBub1xuICogcGlja3VwIGxhYmVsIGF0IGFsbCBpcyBsYWJlbGxlZCwgYW5kIHRoZW4gd2l0aCBgaWRsZS10YXNrYCwgc28gbm8gcm91dGVcbiAqIHRocm91Z2ggdGhpcyBydW5nIG5lZWRzIGEgaHVtYW4gdG8gcmUtcXVldWUgdGhlIHdvcmsuXG4gKlxuICogVGhlIGtlcHQgbmFtZSBpcyB0aGUgY2Fub25pY2FsIHBpY2t1cCBsYWJlbCByYXRoZXIgdGhhbiB0aGUgcmVwb3NpdG9yeSdzXG4gKiBvd24gc3BlbGxpbmcgb2YgaXQsIHNvIGEgbGFiZWwgd2hvc2UgdGV4dCBpcyBhdHRhY2tlci1jb250cm9sbGVkIGNhbm5vdFxuICogcmVhY2ggdGhlIHB1YmxpYyBjb21tZW50cyB0aGlzIGRlY2lzaW9uIGZlZWRzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhblJlcXVldWVMYWJlbChsYWJlbHM6IHJlYWRvbmx5IHN0cmluZ1tdKTogUmVxdWV1ZUxhYmVsIHtcbiAgY29uc3QgY2FycmllZCA9IG5ldyBTZXQobGFiZWxzLm1hcCgobGFiZWwpID0+IGxhYmVsLnRvTG93ZXJDYXNlKCkpKTtcbiAgZm9yIChjb25zdCBwaWNrdXAgb2YgUElDS1VQX0xBQkVMUykge1xuICAgIGlmIChjYXJyaWVkLmhhcyhwaWNrdXAudG9Mb3dlckNhc2UoKSkpIHJldHVybiB7IGtlcHQ6IHBpY2t1cCB9O1xuICB9XG4gIHJldHVybiB7IGFwcGxpZWQ6IElETEVfVEFTS19MQUJFTCB9O1xufVxuXG4vKiogVGhlIGxhYmVsIGEgcmUtcXVldWVkIGlzc3VlIGNhcnJpZXMsIGZvciBjb21tZW50IGFuZCBsb2cgdXNlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcXVldWVMYWJlbE5hbWUobGFiZWw6IFJlcXVldWVMYWJlbCk6IHN0cmluZyB7XG4gIHJldHVybiBcImtlcHRcIiBpbiBsYWJlbCA/IGxhYmVsLmtlcHQgOiBsYWJlbC5hcHBsaWVkO1xufVxuXG4vKipcbiAqIFdoYXQgdGhlIHRocmVhZCBhY3R1YWxseSByZWNvcmRzIGFib3V0IGNvbmNsdWRlZCBhdHRlbXB0cyAoSXNzdWUgIzIyODApLlxuICpcbiAqIFRoZSBjb21tZW50cyB0aGlzIHJ1bmcgcG9zdHMgYXJlIHBlcm1hbmVudCBhbmQgcHVibGljLCBzbyB0aGUgY291bnQgdGhleVxuICogcXVvdGUgaXMgcmVhZCBvZmYgdGhlIHRocmVhZCByYXRoZXIgdGhhbiBhc3N1bWVkLiBUaGUgc3RhbGUtdmVyZGljdCBsYWRkZXJcbiAqIHJlYWNoZXMgdGhpcyBydW5nIHdpdGggKipubyoqIGF0dGVtcHQgb3BlbmVkIGF0IGFsbCwgYW5kIGV2ZW4gdGhlXG4gKiBidWRnZXQtc3BlbnQgY2FsbGVyIGNhbiBhcnJpdmUgb25lIGNvbmNsdXNpb24gc2hvcnQgd2hlbiBhIGZhaWx1cmUgY29tbWVudFxuICogY291bGQgbm90IGJlIHBvc3RlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlc2NyaWJlQ29uY2x1ZGVkQXR0ZW1wdHMoXG4gIGhpc3Rvcnk6IEZhaWxlZEF0dGVtcHRIaXN0b3J5LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgY291bnQgPSBoaXN0b3J5LmF0dGVtcHRzLmxlbmd0aDtcbiAgaWYgKGNvdW50ID09PSAwKSB7XG4gICAgcmV0dXJuIFwiTm8gY29uY2x1ZGVkIG1lcmdlLWNvbmZsaWN0IHJlc29sdXRpb24gYXR0ZW1wdCBpcyByZWNvcmRlZCBvbiBcIiArXG4gICAgICBcInRoaXMgUFJcIjtcbiAgfVxuICByZXR1cm4gYCR7Y291bnR9IG1lcmdlLWNvbmZsaWN0IHJlc29sdXRpb24gYXR0ZW1wdCR7XG4gICAgY291bnQgPT09IDEgPyBcIlwiIDogXCJzXCJcbiAgfSBvbiB0aGlzIFBSIGNvbmNsdWRlZCBhbmQgZmFpbGVkYDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUaGUgYXR0ZW1wdCB0YWJsZSAoSXNzdWUgIzMwMDApXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIE9uZSBQUidzIHJlY29yZGVkIGF0dGVtcHRzLCBhcyBvbmUgbGluayBpbiBhIHJlc3RhcnQgY2hhaW4uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlc3RhcnRDaGFpbkxpbmsge1xuICAvKiogVGhlIFBSIG51bWJlciB0aGlzIGxpbmsncyBhdHRlbXB0cyB3ZXJlIHJlY29yZGVkIGFnYWluc3QuICovXG4gIHByTnVtYmVyOiBudW1iZXI7XG4gIC8qKiBGcm9tIHtAbGluayByZWFkUmVzb2x1dGlvbkF0dGVtcHRzfSwgb2xkZXN0IGZpcnN0LiAqL1xuICBhdHRlbXB0czogcmVhZG9ubHkgQ29uZmxpY3RSZXNvbHV0aW9uQXR0ZW1wdFtdO1xufVxuXG4vKiogT25lIGF0dGVtcHQncyB0aW1lLCBhcyBgWVlZWS1NTS1ERCBISDpNTSBVVENgLCBvciBgdW5rbm93bmAgd2hlbiB1bnNldC4gKi9cbmZ1bmN0aW9uIGF0dGVtcHRUaW1lQ2VsbChhdE1zOiBudW1iZXIgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBpZiAoYXRNcyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gXCJ1bmtub3duXCI7XG4gIHJldHVybiBgJHtuZXcgRGF0ZShhdE1zKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDE2KS5yZXBsYWNlKFwiVFwiLCBcIiBcIil9IFVUQ2A7XG59XG5cbi8qKiBPbmUgYXR0ZW1wdCdzIG91dGNvbWUsIGFzIGEgdGFibGUgY2VsbC4gKi9cbmZ1bmN0aW9uIGF0dGVtcHRPdXRjb21lQ2VsbChcbiAgb3V0Y29tZTogQ29uZmxpY3RSZXNvbHV0aW9uQXR0ZW1wdFtcIm91dGNvbWVcIl0sXG4pOiBzdHJpbmcge1xuICByZXR1cm4gb3V0Y29tZSA9PT0gXCJvcGVuXCIgPyBcIm9wZW4gKG5ldmVyIGNvbmNsdWRlZClcIiA6IG91dGNvbWU7XG59XG5cbi8qKlxuICogQSBtYXJrZG93biB0YWJsZSBvZiBldmVyeSByZXNvbHV0aW9uIGF0dGVtcHQgYWNyb3NzIGEgcmVzdGFydCBjaGFpblxuICogKElzc3VlICMzMDAwKSDigJQgb25lIHJvdyBwZXIgYXR0ZW1wdCwgY291bnRlZCBmcm9tIG9uZSB3aXRoaW4gZWFjaCBQUi5cbiAqXG4gKiBgcmVwb2AgaXMgY29uZmlnLCBub3QgdXNlci1jb250cm9sbGVkIHRleHQsIGFuZCBldmVyeSBvdGhlciBjZWxsIGNvbWVzIG9mZlxuICogYSBjbG9zZWQgdW5pb24gKHtAbGluayBDb25mbGljdFJlc29sdXRpb25QYXNzfSwgdGhlIG91dGNvbWUgd29yZCkgb3IgYVxuICogZm9ybWF0dGVkIGVwb2NoIG1zIOKAlCBub3RoaW5nIGhlcmUgbmVlZHMge0BsaW5rIHNhbml0aXNlSXNzdWVUZXh0fS5cbiAqXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gYG93bmVyL3JlcG9gIGZvcm0sIHNoYXJlZCBieSBldmVyeSBsaW5rLlxuICogQHBhcmFtIGNoYWluIC0gRXZlcnkgUFIncyBhdHRlbXB0cywgb2xkZXN0IFBSIGZpcnN0LiBBIFBSIHdpdGggbm8gcmVjb3JkZWRcbiAqICAgYXR0ZW1wdHMgc3RpbGwgZ2V0cyBvbmUgcm93LCBzYXlpbmcgc28uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJBdHRlbXB0VGFibGUoXG4gIHJlcG86IHN0cmluZyxcbiAgY2hhaW46IHJlYWRvbmx5IFJlc3RhcnRDaGFpbkxpbmtbXSxcbik6IHN0cmluZ1tdIHtcbiAgY29uc3Qgcm93czogc3RyaW5nW10gPSBbXG4gICAgXCJ8IFBSIHwgQXR0ZW1wdCB8IFBhc3MgfCBUaW1lIChVVEMpIHwgT3V0Y29tZSB8XCIsXG4gICAgXCJ8IC0tLSB8IC0tLSB8IC0tLSB8IC0tLSB8IC0tLSB8XCIsXG4gIF07XG4gIGZvciAoY29uc3QgbGluayBvZiBjaGFpbikge1xuICAgIGNvbnN0IHByQ2VsbCA9IGAke3JlcG99IyR7bGluay5wck51bWJlcn1gO1xuICAgIGlmIChsaW5rLmF0dGVtcHRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcm93cy5wdXNoKGB8ICR7cHJDZWxsfSB8IOKAlCB8IOKAlCB8IOKAlCB8IG5vIGF0dGVtcHQgcmVjb3JkZWQgfGApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGxpbmsuYXR0ZW1wdHMuZm9yRWFjaCgoYXR0ZW1wdCwgaW5kZXgpID0+IHtcbiAgICAgIHJvd3MucHVzaChcbiAgICAgICAgYHwgJHtwckNlbGx9IHwgJHtpbmRleCArIDF9IHwgJHthdHRlbXB0LnBhc3N9IHwgYCArXG4gICAgICAgICAgYCR7YXR0ZW1wdFRpbWVDZWxsKGF0dGVtcHQuYXRNcyl9IHwgYCArXG4gICAgICAgICAgYCR7YXR0ZW1wdE91dGNvbWVDZWxsKGF0dGVtcHQub3V0Y29tZSl9IHxgLFxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gcm93cztcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBPdXRjb21lIHRheG9ub215XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIFdoeSB0aGUgYWJhbmRvbiB3YXMgZGVjbGluZWQgYmVmb3JlIGFueXRoaW5nIHdhcyBjaGFuZ2VkLiAqL1xuZXhwb3J0IHR5cGUgQWJhbmRvbkRlY2xpbmVSZWFzb24gPVxuICAvKipcbiAgICogTm8gb3JpZ2luYXRpbmcgaXNzdWUuXG4gICAqXG4gICAqICoqTm8gbG9uZ2VyIHByb2R1Y2VkIGJ5IHtAbGluayBhYmFuZG9uQW5kUmVzdGFydH0qKiAoSXNzdWUgIzIzMTApOiBhIFBSXG4gICAqIHdob3NlIG9yaWdpbmF0aW5nIGlzc3VlIGNhbm5vdCBiZSBmb3VuZCBpcyBub3cgY2xvc2VkLCBhbmQgdGhlXG4gICAqIGBtZXJnZS1mYWxsYmFja2AgZmxhZyBpc3N1ZSDigJQgY2FycnlpbmcgdGhlIFBSJ3MgZGlmZiBzdW1tYXJ5IGFuZFxuICAgKiBgaWRsZS10YXNrYCDigJQgYmVjb21lcyB0aGUgcmUtZG8gaXRlbSBpbiBpdHMgcGxhY2UuIFRoZSBtZW1iZXIgaXMga2VwdFxuICAgKiBiZWNhdXNlIGl0IGlzIHN0aWxsIHRoZSBzaGFwZSBhIGNhbGxlciBtYXkgYmUgaGFuZGVkIGJ5IGFuIGluamVjdGVkIHJ1bmcsXG4gICAqIGFuZCB7QGxpbmsgZGVzY3JpYmVFeGhhdXN0ZWRSb3V0ZX0gbXVzdCBrZWVwIGFuIGFuc3dlciBmb3IgaXQuXG4gICAqL1xuICB8IHsga2luZDogXCJuby1vcmlnaW5hdGluZy1pc3N1ZVwiOyBkZXRhaWw6IFByVW5yZXNvbHZlZFJlYXNvbiB9XG4gIC8qKlxuICAgKiBBIHJlc3RhcnQgY2xhaW0gbmFtZXMgKnRoaXMqIFBSLiBgYWJhbmRvbkFuZFJlc3RhcnRgIHByb2R1Y2VzIHRoaXMgbWVtYmVyXG4gICAqIG9ubHkgd2hlbiBgc2FtZVByYCBpcyB0cnVlOiBhbiBlYXJsaWVyIGFiYW5kb24gb2YgdGhpcyB2ZXJ5IFBSIGNsYWltZWQgdGhlXG4gICAqIHJlc3RhcnQgYW5kIGRpZCBub3QgZmluaXNoLCBhbmQgY2xvc2luZyBpdCBhIHNlY29uZCB0aW1lIGlzIG5vdCBhIHJldHJ5XG4gICAqIChJc3N1ZSAjMzAzMykuIFRoZXJlIGlzIG5vIGNhcCBvbiByZXN0YXJ0cyBwZXIgaXNzdWUsIGFuZCBubyBuZWVkcy1odW1hblxuICAgKiBoYW5kLW9mZiBpcyBldmVyIGFwcGxpZWQg4oCUIGByZXN0YXJ0Q291bnRgIGlzIGNhcnJpZWQgZm9yIGxvZ2dpbmcgYW5kXG4gICAqIGNvbW1lbnQgdGV4dCBvbmx5LiBPdGhlciBtb2R1bGVzIG1heSBzdGlsbCBjb25zdHJ1Y3QgdGhpcyBtZW1iZXIgd2l0aFxuICAgKiBgc2FtZVByOiBmYWxzZWAgd2hlbiBpbmplY3RpbmcgYW4gb3V0Y29tZSBmb3IgdGhlaXIgb3duIHRlc3RzLlxuICAgKi9cbiAgfCB7XG4gICAga2luZDogXCJhbHJlYWR5LXJlc3RhcnRlZFwiO1xuICAgIGlzc3VlTnVtYmVyOiBudW1iZXI7XG4gICAgc2FtZVByOiBib29sZWFuO1xuICAgIC8qKiBGbGVldC1hdXRob3JlZCByZXN0YXJ0IGNsYWltcyBhbHJlYWR5IG9uIHRoZSBpc3N1ZS4gKi9cbiAgICByZXN0YXJ0Q291bnQ6IG51bWJlcjtcbiAgfVxuICAvKipcbiAgICogQSByZXN0YXJ0IGNsYWltIGlzIG9uIHRoZSBpc3N1ZSBidXQgaXRzIGF1dGhvciBjYW5ub3QgYmUgZXN0YWJsaXNoZWQsIHNvXG4gICAqIHRoZSBvbmUtYWJhbmRvbi1wZXItaXNzdWUgYm91bmQgY2Fubm90IGJlIGV2YWx1YXRlZCAoSXNzdWUgIzEyNDcpLlxuICAgKlxuICAgKiBEaXN0aW5jdCBmcm9tIGBhbHJlYWR5LXJlc3RhcnRlZGA6IHRoZXJlIHRoZSBmbGVldCdzIG93biBjbGFpbSB3YXMgcmVhZFxuICAgKiBhbmQgaG9ub3VyZWQuIEhlcmUgdGhlIGNsYWltIGNhcnJpZXMgbm8gcmVhZGFibGUgYXV0aG9yLCBvciBubyBmbGVldFxuICAgKiBpZGVudGl0eSBpcyBjb25maWd1cmVkIHRvIGNvbXBhcmUgaXQgYWdhaW5zdCDigJQgYW5kIGEgZGVzdHJ1Y3RpdmUgc3RlcFxuICAgKiBtdXN0IG5vdCBwcm9jZWVkIG9uIGEgYm91bmQgaXQgY2Fubm90IGNoZWNrLlxuICAgKi9cbiAgfCB7XG4gICAga2luZDogXCJyZXN0YXJ0LWNsYWltLXVudmVyaWZpYWJsZVwiO1xuICAgIGlzc3VlTnVtYmVyOiBudW1iZXI7XG4gICAgY2xhaW1Db3VudDogbnVtYmVyO1xuICB9XG4gIC8qKiBUaGUgaXNzdWUgYWxyZWFkeSBoYXMgYW5vdGhlciBQUiBvZiBpdHMgb3duLiAqL1xuICB8IHsga2luZDogXCJvdGhlci1vcGVuLXByXCI7IGlzc3VlTnVtYmVyOiBudW1iZXI7IHByVXJsOiBzdHJpbmcgfVxuICAvKipcbiAgICogVGhlIHNoYXJlZCB7QGxpbmsgQ09ORkxJQ1RfUkVTT0xVVElPTl9CVURHRVR9IGhhcyBub3QgYWN0dWFsbHkgYmVlblxuICAgKiBzcGVudCAoSXNzdWUgIzMwMDApOiBhYmFuZG9uLWFuZC1yZWRvIHJ1bnMgb25seSBvbmNlIGV2ZXJ5IGF0dGVtcHQgdGhlXG4gICAqIGJ1ZGdldCBhbGxvd3MgaGFzIGJlZW4gc3BlbnQgYW5kIGZhaWxlZCDigJQgdGhlIHN0YWxlLXZlcmRpY3QgbGFkZGVyXG4gICAqIHJlYWNoZWQgdGhpcyBydW5nIHdpdGggZmV3ZXIgZmFpbHVyZXMgdGhhbiB0aGUgYnVkZ2V0IGFsbG93cy4gTm90XG4gICAqIHByb2R1Y2VkIGZvciBhIGBzdGFsbGVkYCB7QGxpbmsgQWJhbmRvblJlYXNvbn06IGEgc3RhbGwgcmVwYWlyJ3Mgc2Vjb25kXG4gICAqIHRyaXAgaXMgbm90IGEgY29uZmxpY3QtcmVzb2x1dGlvbiBvdXRjb21lLCBhbmQgaGFzIGl0cyBvd24gdHdvLXRyaXBcbiAgICogYm91bmQuXG4gICAqL1xuICB8IHsga2luZDogXCJhdHRlbXB0cy1ub3Qtc3BlbnRcIjsgZmFpbGVkQXR0ZW1wdHM6IG51bWJlcjsgYnVkZ2V0OiBudW1iZXIgfTtcblxuLyoqIFRoZSBzdGVwcyBhbiBhYmFuZG9uIHJ1bnMsIGluIG9yZGVyLiBOYW1lZCBpbiB0aGUgZmFpbHVyZSBvdXRjb21lLiAqL1xuZXhwb3J0IHR5cGUgQWJhbmRvblN0ZXAgPVxuICB8IFwib3JpZ2luYXRpbmctaXNzdWVcIlxuICB8IFwiaXNzdWUtc3RhdGVcIlxuICB8IFwicmVzdGFydC1tYXJrZXJcIlxuICB8IFwiZXhpc3RpbmctcHJcIlxuICB8IFwicHItdGhyZWFkXCJcbiAgfCBcImlzc3VlLWNvbW1lbnRcIlxuICB8IFwicHItY29tbWVudFwiXG4gIHwgXCJwci1jbG9zZVwiXG4gIHwgXCJpc3N1ZS1yZW9wZW5cIlxuICB8IFwiaXNzdWUtbGFiZWxcIlxuICAvKipcbiAgICogRmlsaW5nIHRoZSBgbWVyZ2UtZmFsbGJhY2tgIGZsYWcgZm9yIGEgUFIgd2l0aCBubyBvcmlnaW5hdGluZyBpc3N1ZVxuICAgKiAoSXNzdWUgIzIzMTApLiBPbmx5IHRoYXQgcm91dGUgY2FuIGZhaWwgaGVyZSwgYW5kIGl0IGZhaWxzICpiZWZvcmUqIHRoZVxuICAgKiBjbG9zZTogdGhlIGZsYWcgaXMgdGhlIHJlLWRvIGl0ZW0sIHNvIGNsb3NpbmcgdGhlIFBSIHdpdGhvdXQgb25lIHdvdWxkXG4gICAqIGxvc2UgdGhlIHdvcmsgb3V0cmlnaHQg4oCUIHRoZSBzYW1lIGhhcm0gdGhlIG9sZCBkZWNsaW5lIGF2b2lkZWQuXG4gICAqL1xuICB8IFwiZmFsbGJhY2stZmxhZ1wiXG4gIC8qKiBMaXN0aW5nIHRoZSBtZXJnZWQgc3ViLVBScyBhIGBtaWxlc3RvbmUvKipgIHJlYnVpbGQgcmVwbGF5cyAoSXNzdWUgIzMwMzUpLiAqL1xuICB8IFwibWlsZXN0b25lLXN1Yi1wcnNcIlxuICAvKiogVGhlIGdpdCB3b3JrIHJlYnVpbGRpbmcgdGhlIG1pbGVzdG9uZSBicmFuY2ggZnJvbSBpdHMgYmFzZSAoSXNzdWUgIzMwMzUpLiAqL1xuICB8IFwibWlsZXN0b25lLXJlYnVpbGRcIlxuICAvKiogVGhlIG1lcmdlIGdhdGUgcmVmdXNpbmcgdGhlIHJlYnVpbHQgdHJlZSBiZWZvcmUgaXQgaXMgZGVsaXZlcmVkIChQUiAjNDM0NCByZXZpZXcpLiAqL1xuICB8IFwibWlsZXN0b25lLWdhdGVcIlxuICAvKiogRGVsaXZlcmluZyB0aGUgcmVidWlsZCB0byB0aGUgbWlsZXN0b25lIGJyYW5jaCAoSXNzdWUgIzMwMzUpLiAqL1xuICB8IFwibWlsZXN0b25lLXB1c2hcIlxuICAvKiogUmUtcXVldWluZyBhIHNraXBwZWQgc3ViLVBSJ3Mgc3ViLWlzc3VlIGFmdGVyIGEgbWlsZXN0b25lIHJlYnVpbGQgKElzc3VlICMzMDM1KS4gKi9cbiAgfCBcInN1Yi1pc3N1ZS1yZXF1ZXVlXCI7XG5cbi8qKiBXaGF0IHtAbGluayBhYmFuZG9uQW5kUmVzdGFydH0gZGlkLiAqL1xuZXhwb3J0IHR5cGUgQWJhbmRvblJlc3RhcnRPdXRjb21lID1cbiAgLyoqXG4gICAqIFRoZSBQUiB3YXMgY2xvc2VkIGFuZCB0aGUgd29yayByZS1xdWV1ZWQuIHtAbGluayBsYWJlbH0gc2F5cyBob3c6IHRoZVxuICAgKiBwaWNrdXAgbGFiZWwgdGhlIG9yaWdpbmF0aW5nIGlzc3VlIGFscmVhZHkgY2FycmllZCB3YXMga2VwdCwgb3JcbiAgICogYGlkbGUtdGFza2Agd2FzIGFwcGxpZWQgYmVjYXVzZSBpdCBjYXJyaWVkIG5vbmUgKElzc3VlICMyMjc3KS5cbiAgICpcbiAgICogV2hlbiB7QGxpbmsgZmxhZ0lzc3VlTnVtYmVyfSBpcyBzZXQsIHRoZSBQUiBuYW1lZCBubyBvcmlnaW5hdGluZyBpc3N1ZSBhbmRcbiAgICogdGhpcyBydW5nIGZpbGVkIHRoZSBgbWVyZ2UtZmFsbGJhY2tgIGZsYWcgYXMgdGhlIHJlLWRvIGl0ZW0gaW4gaXRzIHBsYWNlXG4gICAqIChJc3N1ZSAjMjMxMCk7IHtAbGluayBpc3N1ZU51bWJlcn0gaXMgdGhlbiB0aGF0IGZsYWcgaXNzdWUsIHdoaWNoIGlzIHRoZVxuICAgKiBpc3N1ZSB0aGUgd29yayBjb21lcyBiYWNrIHRocm91Z2guIFRoZSBjYWxsZXIgbXVzdCBub3QgZmlsZSBhIHNlY29uZCBmbGFnLlxuICAgKi9cbiAgfCB7XG4gICAgb3V0Y29tZTogXCJhYmFuZG9uZWRcIjtcbiAgICBpc3N1ZU51bWJlcjogbnVtYmVyO1xuICAgIGxhYmVsOiBSZXF1ZXVlTGFiZWw7XG4gICAgZmxhZ0lzc3VlTnVtYmVyPzogbnVtYmVyO1xuICB9XG4gIC8qKiBBIHByZWNvbmRpdGlvbiByZWZ1c2VkIHRoZSBhYmFuZG9uOyBub3RoaW5nIHdhcyBjaGFuZ2VkLiAqL1xuICB8IHsgb3V0Y29tZTogXCJkZWNsaW5lZFwiOyByZWFzb246IEFiYW5kb25EZWNsaW5lUmVhc29uIH1cbiAgLyoqXG4gICAqIEEgc3RhbGxlZCBQUiBuYW1pbmcgbm8gb3JpZ2luYXRpbmcgaXNzdWUgd2FzIGNsb3NlZCwgYW5kIOKAlCBieSBkZXNpZ24g4oCUXG4gICAqIG5vIGlzc3VlIHdhcyBmaWxlZCBvciByZS1xdWV1ZWQgKElzc3VlICMyODAyKS4gT25seSBhIGBzdGFsbGVkYFxuICAgKiB7QGxpbmsgQWJhbmRvblJlYXNvbn0gcHJvZHVjZXMgaXQuXG4gICAqL1xuICB8IHsgb3V0Y29tZTogXCJjbG9zZWQtd2l0aG91dC1pc3N1ZVwiOyByZWFzb246IFByVW5yZXNvbHZlZFJlYXNvbiB9XG4gIC8qKiBBIHN0ZXAgZmFpbGVkOyB0aGUgY2FsbGVyIG11c3QgZXNjYWxhdGUgbmFtaW5nIHtAbGluayBzdGVwfS4gKi9cbiAgfCB7XG4gICAgb3V0Y29tZTogXCJmYWlsZWRcIjtcbiAgICBzdGVwOiBBYmFuZG9uU3RlcDtcbiAgICBtZXNzYWdlOiBzdHJpbmc7XG4gICAgaXNzdWVOdW1iZXI/OiBudW1iZXI7XG4gIH07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gV2hpY2ggcm91dGUgZW5kZWQgYXQgYSBodW1hblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogV2hpY2ggZXhpdCBhbiBhYmFuZG9uIHRoYXQgZGlkIG5vdCBoYXBwZW4gdG9vayAoSXNzdWUgIzExMTUpLlxuICpcbiAqIEEgc3BlbnQgYnVkZ2V0IG5vIGxvbmdlciBtZWFucyBvbmUgdGhpbmcuIEFiYW5kb24tYW5kLXJlc3RhcnQgc2l0cyBiZXR3ZWVuXG4gKiBpdCBhbmQgYG5lZWRzLWh1bWFuYCwgc28gdGhlIHJlY29yZCBtdXN0IHNheSB3aGljaCBvZiB0aGUgcnVuZydzIGV4aXRzXG4gKiBwcm9kdWNlZCB0aGUgb3V0Y29tZSDigJQgYSByZWFkZXIgd2hvIGNhbm5vdCB0ZWxsIFwidGhlIGZsZWV0IGNvdWxkIG5vdCBmaW5kXG4gKiB0aGUgaXNzdWVcIiBmcm9tIFwidGhlIGZsZWV0IGFscmVhZHkgcmVzdGFydGVkIHRoaXMgb25jZVwiIGNhbm5vdCBhY3Qgb25cbiAqIGVpdGhlci4gVGhlIHN0YWxlLXZlcmRpY3QgbGFkZGVyIHJlY29yZHMgaXQgb24gdGhlIFBSIGFuZCBhc2tzIG5vYm9keVxuICogKElzc3VlICMyMjgwKS5cbiAqXG4gKiBUaGVyZSBpcyBubyBgcmVzdGFydC1leGhhdXN0ZWRgIG1lbWJlciwgYW5kIG5vIGNhcCBvbiByZXN0YXJ0cyBwZXIgaXNzdWVcbiAqIChJc3N1ZSAjMzAzMyk6IGFiYW5kb24tYW5kLXJlc3RhcnQgbmV2ZXIgaGFuZHMgYW4gaXNzdWUgdG8gYSBodW1hbiwgc29cbiAqIGV2ZXJ5IHJvdXRlIGhlcmUgZW5kcyB3aXRoIHRoZSBQUiBsZWZ0IG9wZW4gZm9yIHRoZSBuZXh0IHBhc3MgdG8gZGVjaWRlXG4gKiBhZ2FpbiwgbmV2ZXIgd2l0aCBgbmVlZHMtaHVtYW5gLlxuICovXG5leHBvcnQgdHlwZSBFeGhhdXN0ZWRFc2NhbGF0aW9uUm91dGUgPVxuICAvKiogQSBwcmVjb25kaXRpb24gcmVmdXNlZCB0aGUgYWJhbmRvbjsgbm90aGluZyB3YXMgY2xvc2VkLiAqL1xuICB8IHsga2luZDogXCJhYmFuZG9uLWRlY2xpbmVkXCI7IGRldGFpbDogc3RyaW5nIH1cbiAgLyoqIFRoZSBhYmFuZG9uIHN0YXJ0ZWQgYW5kIGEgc3RlcCBmYWlsZWQ7IHRoZSBzdGF0ZSBtYXkgYmUgcGFydGlhbC4gKi9cbiAgfCB7IGtpbmQ6IFwiYWJhbmRvbi1mYWlsZWRcIjsgc3RlcDogQWJhbmRvblN0ZXA7IGRldGFpbDogc3RyaW5nIH07XG5cbi8qKlxuICogV2hpY2ggZXNjYWxhdGlvbiByb3V0ZSBhbiBhYmFuZG9uIHRoYXQgZGlkIG5vdCBoYXBwZW4gcHJvZHVjZWQuXG4gKlxuICogRXhoYXVzdGl2ZSBvdmVyIGJvdGggbm9uLWFiYW5kb25pbmcgb3V0Y29tZXMsIHNvIGEgZGVjbGluZSByZWFzb24gYWRkZWRcbiAqIHdpdGhvdXQgYSByb3V0ZSBoZXJlIGZhaWxzIHRoZSB0eXBlIGNoZWNrIHJhdGhlciB0aGFuIHJlYWNoaW5nIGEgaHVtYW4gYXMgYW5cbiAqIHVuZXhwbGFpbmVkIGBuZWVkcy1odW1hbmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleGhhdXN0ZWRFc2NhbGF0aW9uUm91dGUoXG4gIG91dGNvbWU6IEV4Y2x1ZGU8QWJhbmRvblJlc3RhcnRPdXRjb21lLCB7IG91dGNvbWU6IFwiYWJhbmRvbmVkXCIgfT4sXG4pOiBFeGhhdXN0ZWRFc2NhbGF0aW9uUm91dGUge1xuICBpZiAob3V0Y29tZS5vdXRjb21lID09PSBcImNsb3NlZC13aXRob3V0LWlzc3VlXCIpIHtcbiAgICAvLyBPbmx5IHRoZSBzdGFsbCByb3V0ZSBwcm9kdWNlcyB0aGlzIChJc3N1ZSAjMjgwMik7IHJlY29yZGVkLCBub3Qgcm91dGVkLlxuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcImFiYW5kb24tZGVjbGluZWRcIixcbiAgICAgIGRldGFpbDogXCJUaGlzIFBSIG5hbWVzIG5vIG9yaWdpbmF0aW5nIGlzc3VlIFwiICtcbiAgICAgICAgYCgke291dGNvbWUucmVhc29ufSksIHNvIGl0IHdhcyBjbG9zZWQgd2l0aCBub3RoaW5nIHJlLXF1ZXVlZC5gLFxuICAgIH07XG4gIH1cbiAgaWYgKG91dGNvbWUub3V0Y29tZSA9PT0gXCJmYWlsZWRcIikge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcImFiYW5kb24tZmFpbGVkXCIsXG4gICAgICBzdGVwOiBvdXRjb21lLnN0ZXAsXG4gICAgICBkZXRhaWw6IHNhbml0aXNlSXNzdWVUZXh0KG91dGNvbWUubWVzc2FnZSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHJlYXNvbiA9IG91dGNvbWUucmVhc29uO1xuICBzd2l0Y2ggKHJlYXNvbi5raW5kKSB7XG4gICAgY2FzZSBcIm5vLW9yaWdpbmF0aW5nLWlzc3VlXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBraW5kOiBcImFiYW5kb24tZGVjbGluZWRcIixcbiAgICAgICAgZGV0YWlsOiBcIlRoaXMgUFIgbmFtZXMgbm8gb3JpZ2luYXRpbmcgaXNzdWUgXCIgK1xuICAgICAgICAgIGAoJHtyZWFzb24uZGV0YWlsfSk6IG5laXRoZXIgaXRzIGJyYW5jaCBuYW1lLCBub3IgYSBjbG9zaW5nIGAgK1xuICAgICAgICAgIFwia2V5d29yZCBpbiBpdHMgYm9keSwgbm9yIEdpdEh1YidzIG93biBsaW5rYWdlIHBvaW50cyBhdCBvbmUuIFwiICtcbiAgICAgICAgICBcIkNsb3NpbmcgYSBQUiB0aGUgZmxlZXQgY2Fubm90IHJlLXJhaXNlIHdvdWxkIGxvc2UgdGhlIHdvcmsgXCIgK1xuICAgICAgICAgIFwib3V0cmlnaHQsIHNvIGl0IHdhcyBsZWZ0IG9wZW4uXCIsXG4gICAgICB9O1xuICAgIGNhc2UgXCJhbHJlYWR5LXJlc3RhcnRlZFwiOlxuICAgICAgLy8gSXNzdWUgIzMwMzM6IHRoZXJlIGlzIG5vIHJlc3RhcnQgY2FwLCBzbyB0aGlzIG1lbWJlciBpcyBvbmx5IGV2ZXJcbiAgICAgIC8vIHByb2R1Y2VkIGZvciBhIGNsYWltIG5hbWluZyB0aGlzIHZlcnkgUFIg4oCUIHRoZSBgIXNhbWVQcmAgdGV4dCBiZWxvd1xuICAgICAgLy8gaXMga2VwdCBvbmx5IGZvciBvdXRjb21lcyBhbiBpbmplY3RlZCBydW5nIGNvbnN0cnVjdHMgaXRzZWxmLlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAga2luZDogXCJhYmFuZG9uLWRlY2xpbmVkXCIsXG4gICAgICAgIGRldGFpbDogcmVhc29uLnNhbWVQclxuICAgICAgICAgID8gYEFuIGVhcmxpZXIgYWJhbmRvbiBvZiB0aGlzIFBSIGNsYWltZWQgaXNzdWUgYCArXG4gICAgICAgICAgICBgIyR7cmVhc29uLmlzc3VlTnVtYmVyfSBhbmQgZGlkIG5vdCBmaW5pc2guIFRoZSByZXN0YXJ0IGNsYWltIGlzIGAgK1xuICAgICAgICAgICAgXCJvbiB0aGUgaXNzdWUsIHNvIHRoaXMgUFIgaXMgbm90IGNsb3NlZCBhIHNlY29uZCB0aW1lIOKAlCBpdCBpcyBcIiArXG4gICAgICAgICAgICBcImxlZnQgb3BlbiBvbiBgbWVyZ2UtY29uZmxpY3RgLlwiXG4gICAgICAgICAgOiBgSXNzdWUgIyR7cmVhc29uLmlzc3VlTnVtYmVyfSBhbHJlYWR5IHJlY29yZHMgYCArXG4gICAgICAgICAgICBgJHtyZWFzb24ucmVzdGFydENvdW50fSByZXN0YXJ0IGNsYWltKHMpIGFuZCB0aGlzIGFiYW5kb24gd2FzIGAgK1xuICAgICAgICAgICAgXCJkZWNsaW5lZCwgc28gdGhpcyBQUiBpcyBsZWZ0IG9wZW4gb24gYG1lcmdlLWNvbmZsaWN0YCBhbmQgdGhlIFwiICtcbiAgICAgICAgICAgIFwibmV4dCBwYXNzIGRlY2lkZXMgaXQgYWdhaW4uXCIsXG4gICAgICB9O1xuICAgIGNhc2UgXCJyZXN0YXJ0LWNsYWltLXVudmVyaWZpYWJsZVwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAga2luZDogXCJhYmFuZG9uLWRlY2xpbmVkXCIsXG4gICAgICAgIGRldGFpbDogYElzc3VlICMke3JlYXNvbi5pc3N1ZU51bWJlcn0gY2FycmllcyAke3JlYXNvbi5jbGFpbUNvdW50fSBgICtcbiAgICAgICAgICBcIm1lcmdlLWNvbmZsaWN0IHJlc3RhcnQgY2xhaW0ocykgd2hvc2UgYXV0aG9yIGNvdWxkIG5vdCBiZSBcIiArXG4gICAgICAgICAgXCJlc3RhYmxpc2hlZCDigJQgdGhlIGNvbW1lbnQgbmFtZXMgbm8gYXV0aG9yLCBvciB0aGlzIGhvc3QgaGFzIG5vIFwiICtcbiAgICAgICAgICBcImZsZWV0IGlkZW50aXR5IGNvbmZpZ3VyZWQgKGBzZXJ2aWNlX2FjY291bnRzYCAvIFwiICtcbiAgICAgICAgICBcImBmbGVldF9wcl9hdXRob3JzYCkgdG8gY29tcGFyZSBpdCBhZ2FpbnN0LiBUaGF0IGNsYWltIGlzIHRoZSBvbmx5IFwiICtcbiAgICAgICAgICBcImJvdW5kIG9uIGhvdyBvZnRlbiB0aGUgZmxlZXQgY2xvc2VzIGFuZCByZS1yYWlzZXMgdGhpcyB3b3JrLCBzbyBcIiArXG4gICAgICAgICAgXCJ0aGUgUFIgd2FzIGxlZnQgb3BlbiByYXRoZXIgdGhhbiBhYmFuZG9uZWQgb24gYSBib3VuZCB0aGF0IGNvdWxkIFwiICtcbiAgICAgICAgICBcIm5vdCBiZSBjaGVja2VkLlwiLFxuICAgICAgfTtcbiAgICBjYXNlIFwib3RoZXItb3Blbi1wclwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAga2luZDogXCJhYmFuZG9uLWRlY2xpbmVkXCIsXG4gICAgICAgIGRldGFpbDogYElzc3VlICMke3JlYXNvbi5pc3N1ZU51bWJlcn0gYWxyZWFkeSBoYXMgYW5vdGhlciBvcGVuIFBSIGAgK1xuICAgICAgICAgIGAoJHtzYW5pdGlzZUlzc3VlVGV4dChyZWFzb24ucHJVcmwpfSksIHNvIHJlLXF1ZXVpbmcgaXQgd291bGQgaGF2ZSBgICtcbiAgICAgICAgICBcInJhY2VkIHRoYXQgb25lLlwiLFxuICAgICAgfTtcbiAgICBjYXNlIFwiYXR0ZW1wdHMtbm90LXNwZW50XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBraW5kOiBcImFiYW5kb24tZGVjbGluZWRcIixcbiAgICAgICAgZGV0YWlsOiBgVGhpcyBQUiBoYXMgJHtyZWFzb24uZmFpbGVkQXR0ZW1wdHN9IGZhaWxlZCBtZXJnZS1jb25mbGljdCBgICtcbiAgICAgICAgICBgcmVzb2x1dGlvbiBhdHRlbXB0KHMpIHJlY29yZGVkIG9mIHRoZSAke3JlYXNvbi5idWRnZXR9IHRoZSBzaGFyZWQgYCArXG4gICAgICAgICAgXCJidWRnZXQgYWxsb3dzLCBzbyBpdCB3YXMgbm90IGFiYW5kb25lZDogYWJhbmRvbi1hbmQtcmVkbyBydW5zIFwiICtcbiAgICAgICAgICBcIm9ubHkgYWZ0ZXIgZXZlcnkgYXR0ZW1wdCBoYXMgYmVlbiBzcGVudCBhbmQgZmFpbGVkLiBJdCBzdGF5cyBcIiArXG4gICAgICAgICAgXCJvcGVuIG9uIGBtZXJnZS1jb25mbGljdGAgZm9yIHRoZSBuZXh0IGF0dGVtcHQuXCIsXG4gICAgICB9O1xuICB9XG4gIGNvbnN0IHVuaGFuZGxlZDogbmV2ZXIgPSByZWFzb247XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgVW5oYW5kbGVkIGFiYW5kb24gZGVjbGluZSByZWFzb246ICR7SlNPTi5zdHJpbmdpZnkodW5oYW5kbGVkKX1gLFxuICApO1xufVxuXG4vKipcbiAqIFRoZSByb3V0ZSwgYXMgdGhlIHBhcmFncmFwaHMgdGhlIGNvbW1lbnQgcmVjb3JkaW5nIGl0IGNhcnJpZXMg4oCUIHRoZVxuICogZGVjbGluZSdzIG93biBleHBsYW5hdGlvbiwgb3IgdGhlIGxhZGRlcidzIG93biBydW5nLWZhaWxlZCBjb21tZW50XG4gKiAoSXNzdWUgIzIyODApLiBOZWl0aGVyIHJvdXRlIGV2ZXIgaGFuZHMgdGhlIGlzc3VlIHRvIGEgaHVtYW5cbiAqIChJc3N1ZSAjMzAzMykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZUV4aGF1c3RlZFJvdXRlKFxuICByb3V0ZTogRXhoYXVzdGVkRXNjYWxhdGlvblJvdXRlLFxuKTogc3RyaW5nW10ge1xuICBzd2l0Y2ggKHJvdXRlLmtpbmQpIHtcbiAgICBjYXNlIFwiYWJhbmRvbi1kZWNsaW5lZFwiOlxuICAgICAgcmV0dXJuIFtcbiAgICAgICAgXCIqKlRoZSBhdXRvbWF0aWMgcmVzdGFydCB3YXMgZGVjbGluZWQsIHNvIG5vdGhpbmcgd2FzIGNsb3NlZC4qKiBcIiArXG4gICAgICAgIHJvdXRlLmRldGFpbCxcbiAgICAgIF07XG4gICAgY2FzZSBcImFiYW5kb24tZmFpbGVkXCI6XG4gICAgICByZXR1cm4gW1xuICAgICAgICBcIioqVGhlIGF1dG9tYXRpYyByZXN0YXJ0IGZhaWxlZCBwYXJ0LXdheSB0aHJvdWdoLCBhdCB0aGUgXCIgK1xuICAgICAgICBgXFxgJHtyb3V0ZS5zdGVwfVxcYCBzdGVwLioqICR7cm91dGUuZGV0YWlsfWAsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiQ2hlY2sgd2hhdCB0aGF0IHN0ZXAgbGVhdmVzIGJlaGluZCBiZWZvcmUgZG9pbmcgYW55dGhpbmcgZWxzZTogdGhpcyBcIiArXG4gICAgICAgIFwiUFIgbWF5IGFscmVhZHkgY2FycnkgdGhlIGFiYW5kb24gY29tbWVudCwgYW5kIGl0cyBpc3N1ZSBtYXkgYWxyZWFkeSBcIiArXG4gICAgICAgIFwiYmUgcmUtcXVldWVkLlwiLFxuICAgICAgXTtcbiAgfVxuICBjb25zdCB1bmhhbmRsZWQ6IG5ldmVyID0gcm91dGU7XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgVW5oYW5kbGVkIGV4aGF1c3RlZCBlc2NhbGF0aW9uIHJvdXRlOiAke0pTT04uc3RyaW5naWZ5KHVuaGFuZGxlZCl9YCxcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgYGVzY2FsYXRlVG9IdW1hbmAgZGVkdXAga2V5IGZvciBhIHJvdXRlLlxuICpcbiAqIEEgZmFpbGVkIGFiYW5kb24gZ2V0cyBpdHMgb3duIGtleTogdGhlIHNoYXJlZCBgbWVyZ2UtY29uZmxpY3QtPHByPmAga2V5IGlzXG4gKiBhbHNvIHRoZSBwcm9jZXNzb3IncywgYW5kIGEgbGFuZGVkIGVzY2FsYXRpb24gc3VwcHJlc3NlcyBmdXJ0aGVyIGNvbW1lbnRzXG4gKiBmb3IgYSBkYXkg4oCUIHdoaWNoIHdvdWxkIHN3YWxsb3cgdGhlIG9uZSBjb21tZW50IG5hbWluZyB0aGUgc3RlcCB0aGF0IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXhoYXVzdGVkRXNjYWxhdGlvbkRlZHVwS2V5KFxuICBwck51bWJlcjogbnVtYmVyLFxuICByb3V0ZTogRXhoYXVzdGVkRXNjYWxhdGlvblJvdXRlLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJvdXRlLmtpbmQgPT09IFwiYWJhbmRvbi1mYWlsZWRcIlxuICAgID8gYG1lcmdlLWNvbmZsaWN0LWFiYW5kb24tZmFpbGVkLSR7cHJOdW1iZXJ9YFxuICAgIDogYG1lcmdlLWNvbmZsaWN0LSR7cHJOdW1iZXJ9YDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBSZXF1ZXN0IGFuZCBzZWFtc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogV2hhdCBhIHN0YWxsLXJlcGFpciBmaXJzdCB0cmlwIHRyaWVkIGJlZm9yZSB0aGUgc2Vjb25kIHRyaXAgYWJhbmRvbmVkXG4gKiAoSXNzdWVzICMyODAyLCAjMjgwMykuIFRoZSBjb21tZW50cyBzdGF0ZSBpdCBhcyBmYWN0LCBzbyBlYWNoIHJvdXRlIG5hbWVzXG4gKiBpdHMgb3duOiB0aGUgYmxvY2tpbmctUFIgcm91dGUgc3luY2VkIHRoZSBicmFuY2ggYW5kIHJlcmFuIGl0cyBvd25pbmcgbGFuZTtcbiAqIHRoZSBjb25mbGljdC1xdWV1ZSByb3V0ZSBvbmx5IGNsZWFyZWQgdGhlIGxhZGRlcidzIHdhaXQgc28gaXQgcmFuIGFnYWluO1xuICogdGhlIENJLWZpeCBsYW5lIHNwZW50IGl0cyB3aG9sZSBhdHRlbXB0IGJ1ZGdldCBvbiBvbmUgZmFpbHVyZSAoSXNzdWUgIzQzMDQpXG4gKiBhbmQgYWJhbmRvbnMgaGVyZSByYXRoZXIgdGhhbiBoYW5kaW5nIHRoZSBQUiB0byBhIGh1bWFuOyB0aGUgUFItZmVlZGJhY2tcbiAqIGxhbmUgcmV0cmllZCBhbiB1bmFuc3dlcmVkIHJlcXVlc3QtY2hhbmdlcyByZXZpZXcgaW4gYSBsYXRlciBjeWNsZVxuICogKElzc3VlICM0MzA0KS5cbiAqL1xuZXhwb3J0IHR5cGUgU3RhbGxSZXBhaXJUcmllZCA9XG4gIHwgXCJzeW5jLWFuZC1sYW5lLXJlcnVuXCJcbiAgfCBcImxhZGRlci1yZXJ1blwiXG4gIHwgXCJjaS1maXgtY2FwXCJcbiAgfCBcInJldmlldy1yZXRyeVwiXG4gIC8qKlxuICAgKiBBIFBSIHdob3NlIGJhc2Ugd2FzIG1vdmVkIGFmdGVyIGl0IHdhcyBvcGVuZWQ6IHRoZSB3b3JrZXIgdHJpZWQgdG8gbW92ZVxuICAgKiBpdCBiYWNrIG9udG8gdGhlIGJhc2UgaXQgd2FzIG9wZW5lZCBhZ2FpbnN0IGFuZCBjb3VsZCBub3QgKElzc3VlICM0MzA0KS5cbiAgICovXG4gIHwgXCJyZXRhcmdldC1iYWNrXCJcbiAgLyoqXG4gICAqIEEgUFIgaGVsZCBvbiBhIG1pbGVzdG9uZSBicmFuY2ggd2hvc2Ugcm91dGUgdG8gdGhlIGRlZmF1bHQgYnJhbmNoIGhhc1xuICAgKiBjbG9zZWQ6IGl0IGNhbiBuZXZlciBsYW5kIHRoZXJlLCBhbmQgdGhlIGZsZWV0IG5ldmVyIG1vdmVzIGl0IG9mZiBhXG4gICAqIG1pbGVzdG9uZSBicmFuY2ggKElzc3VlICM0MzA0KS5cbiAgICovXG4gIHwgXCJyb3V0ZS1jbG9zZWQtaG9sZFwiO1xuXG4vKipcbiAqIFdoeSBhIFBSIGlzIGJlaW5nIGFiYW5kb25lZCAoSXNzdWUgIzI4MDIpLiBPbWl0dGVkIG1lYW5zIGEgbWVyZ2UgY29uZmxpY3QsXG4gKiB0aGUgcmVhc29uIHRoaXMgcnVuZyB3YXMgd3JpdHRlbiBmb3I7IGBzdGFsbGVkYCBpcyBhIHN0YWxsIHJlcGFpcidzIHNlY29uZFxuICogdHJpcCwgYW5kIGNoYW5nZXMgb25seSB3aGF0IHRoZSBjb21tZW50cyBzYXkg4oCUIGFuZCB0aGF0IGEgUFIgbmFtaW5nIG5vXG4gKiBvcmlnaW5hdGluZyBpc3N1ZSBpcyBjbG9zZWQgd2l0aG91dCBmaWxpbmcgYSBmbGFnIGlzc3VlLlxuICovXG5leHBvcnQgdHlwZSBBYmFuZG9uUmVhc29uID1cbiAgfCB7IGtpbmQ6IFwibWVyZ2UtY29uZmxpY3RcIiB9XG4gIHwge1xuICAgIGtpbmQ6IFwic3RhbGxlZFwiO1xuICAgIC8qKlxuICAgICAqIFdoYXQgdGhlIHN0YWxsIHdhdGNoZG9nIHNhdywgYXMgb25lIGNsYXVzZSBjb21wbGV0aW5nIFwiVGhpcyBQUiDigKZcIlxuICAgICAqIChlLmcuIFwiaGFzIHN0YWxsZWQ6IOKAplwiKS4gUXVvdGVkIGluIHRoZSBjb21tZW50cy5cbiAgICAgKi9cbiAgICBkZXRhaWw6IHN0cmluZztcbiAgICAvKiogV2hhdCB0aGUgZmlyc3QgdHJpcCB0cmllZCDigJQgc3RhdGVkIGFzIGZhY3QgaW4gdGhlIGNvbW1lbnRzLiAqL1xuICAgIHRyaWVkOiBTdGFsbFJlcGFpclRyaWVkO1xuICB9O1xuXG4vKipcbiAqIFdoYXQgd2FzIHRyaWVkIGJlZm9yZSB0aGUgYWJhbmRvbiwgYXMgYSB3aG9sZSBjbGF1c2Ugd2l0aCBpdHMgb3duIHN1YmplY3RcbiAqIChJc3N1ZSAjNDMwNCk6IG5vdCBldmVyeSByb3V0ZSBoZXJlIGlzIHRoZSBzdGFsbC1yZXBhaXIgcGFzcydzLlxuICovXG5mdW5jdGlvbiBkZXNjcmliZVN0YWxsUmVwYWlyKHRyaWVkOiBTdGFsbFJlcGFpclRyaWVkLCBiYXNlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHRyaWVkKSB7XG4gICAgY2FzZSBcImxhZGRlci1yZXJ1blwiOlxuICAgICAgcmV0dXJuIFwiVGhlIHN0YWxsLXJlcGFpciBwYXNzIGFscmVhZHkgcmVyYW4gdGhlIG1lcmdlLWNvbmZsaWN0IGxhZGRlciBvbmNlXCI7XG4gICAgY2FzZSBcInN5bmMtYW5kLWxhbmUtcmVydW5cIjpcbiAgICAgIHJldHVybiBgVGhlIHN0YWxsLXJlcGFpciBwYXNzIGFscmVhZHkgc3luY2VkIGl0IHdpdGggXFxgJHtiYXNlfVxcYCBhbmQgYCArXG4gICAgICAgIFwicmVyYW4gaXRzIG93bmluZyBsYW5lIG9uY2VcIjtcbiAgICBjYXNlIFwiY2ktZml4LWNhcFwiOlxuICAgICAgcmV0dXJuIFwiVGhlIENJLWZpeCBsYW5lIGFscmVhZHkgc3BlbnQgZXZlcnkgYXV0b21hdGljIGZpeCBhdHRlbXB0IG9uIFwiICtcbiAgICAgICAgXCJ0aGlzIHNhbWUgZmFpbHVyZVwiO1xuICAgIGNhc2UgXCJyZXZpZXctcmV0cnlcIjpcbiAgICAgIHJldHVybiBcIlRoZSBQUi1mZWVkYmFjayBsYW5lIGFscmVhZHkgcmV0cmllZCB0aGUgcmV2aWV3IGluIGEgbGF0ZXIgXCIgK1xuICAgICAgICBcImN5Y2xlXCI7XG4gICAgY2FzZSBcInJldGFyZ2V0LWJhY2tcIjpcbiAgICAgIHJldHVybiBcIlRoZSB3b3JrZXIgYWxyZWFkeSB0cmllZCB0byBtb3ZlIGl0IGJhY2sgb250byB0aGUgYmFzZSBpdCB3YXMgXCIgK1xuICAgICAgICBcIm9wZW5lZCBhZ2FpbnN0LCBhbmQgY291bGQgbm90XCI7XG4gICAgY2FzZSBcInJvdXRlLWNsb3NlZC1ob2xkXCI6XG4gICAgICByZXR1cm4gYFRoZSB3b3JrZXIgYWxyZWFkeSBkaXNhcm1lZCBpdHMgYXV0by1tZXJnZSBvbiBcXGAke2Jhc2V9XFxgLCBgICtcbiAgICAgICAgXCJhbmQgaXQgbmV2ZXIgbW92ZXMgYSBQUiBvZmYgYSBtaWxlc3RvbmUgYnJhbmNoXCI7XG4gIH1cbn1cblxuLyoqIFRoZSBleGhhdXN0ZWQgUFIgdG8gYWJhbmRvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQWJhbmRvblJlc3RhcnRSZXF1ZXN0IHtcbiAgLyoqIFJlcG9zaXRvcnkgaW4gYG93bmVyL3JlcG9gIGZvcm0uICovXG4gIHJlcG86IHN0cmluZztcbiAgLyoqIFRoZSBjb25mbGljdGluZyBQUidzIG51bWJlci4gKi9cbiAgcHJOdW1iZXI6IG51bWJlcjtcbiAgLyoqIFRoZSBQUidzIGhlYWQgYnJhbmNoIOKAlCBuYW1lZCBpbiBib3RoIGNvbW1lbnRzIHNvIHRoZSB3b3JrIHN0YXlzIGZpbmRhYmxlLiAqL1xuICBicmFuY2hOYW1lOiBzdHJpbmc7XG4gIC8qKiBUaGUgYmFzZSBicmFuY2ggdGhlIFBSIGNvbmZsaWN0cyB3aXRoLiAqL1xuICBiYXNlQnJhbmNoOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgUFIncyBjb21tZW50IHRocmVhZCwgb2xkZXN0IGZpcnN0LCB3aGVuIHRoZSBjYWxsZXIgYWxyZWFkeSBoYXMgaXQg4oCUXG4gICAqIHRoZSBzY2FuIGRvZXMuIE9taXQgaXQgYW5kIHRoZSBydW5nIGZldGNoZXMgdGhlIHRocmVhZCBpdHNlbGY7IGl0IGlzXG4gICAqIG5ldmVyIGFzc3VtZWQgZW1wdHksIGJlY2F1c2UgXCJubyBmYWlsdXJlIGNvbW1lbnQgc3Vydml2ZXNcIiBpcyBhIGNsYWltXG4gICAqIHRoaXMgY29tbWVudCBtYWtlcyBpbiBwdWJsaWMgYW5kIGFuIHVucmVhZCB0aHJlYWQgaXMgbm90IGV2aWRlbmNlIGZvciBpdC5cbiAgICpcbiAgICogQXR0cmlidXRlZCBhZ2FpbnN0IHtAbGluayBBYmFuZG9uUmVzdGFydERlcHMudHJ1c3RlZEF1dGhvcnN9IGVpdGhlciB3YXlcbiAgICogKElzc3VlICMxMjQ3KSwgc28gYSBjYWxsZXIgcGFzc2luZyBhbiB1bmZpbHRlcmVkIHRocmVhZCBjYW5ub3QgcHVibGlzaCBhblxuICAgKiBvdXRzaWRlcidzIHRleHQgYXMgdGhlIGZsZWV0J3Mgb3duIHJlY29yZC5cbiAgICovXG4gIHByQ29tbWVudHM/OiByZWFkb25seSB1bmtub3duW107XG4gIC8qKiBXaHkgdGhlIFBSIGlzIGFiYW5kb25lZCAoSXNzdWUgIzI4MDIpLiBEZWZhdWx0cyB0byBhIG1lcmdlIGNvbmZsaWN0LiAqL1xuICByZWFzb24/OiBBYmFuZG9uUmVhc29uO1xufVxuXG4vKiogSW5qZWN0ZWQgc2VhbXMgc28gdGhlIHdob2xlIHBhdGggaXMgdGVzdGFibGUgd2l0aG91dCBHaXRIdWIuICovXG5leHBvcnQgaW50ZXJmYWNlIEFiYW5kb25SZXN0YXJ0RGVwcyB7XG4gIC8qKiBSdW5zIGBnaGAsIHJldHVybmluZyBzdGRvdXQ7IHRocm93cyBvbiBmYWlsdXJlLiAqL1xuICBnaDogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIC8qKlxuICAgKiBGbGVldCBsb2dpbnMgd2hvc2UgbWFya2VyIGNvbW1lbnRzIGNvdW50IChJc3N1ZSAjMTI0NykuXG4gICAqXG4gICAqICoqUmVxdWlyZWQqKiwgc28gbm8gY2FsbCBzaXRlIGNhbiByZWFkIGEgcmVzdGFydCBjbGFpbSBvciBhbiBhdHRlbXB0XG4gICAqIHJlY29yZCBvZmYgYSBjb21tZW50IGFueWJvZHkgY291bGQgaGF2ZSB3cml0dGVuIOKAlCB0aGUgc2FtZSBzaGFwZVxuICAgKiBgbWVyZ2VfY29uZmxpY3RfZGVmZXJyYWxzLnRzYCB1c2VzIGZvciBpdHMgb3duIG1hcmtlciBkZWR1cC4gU3VwcGx5IHRoZVxuICAgKiBwdXNoLWNhcGFibGUgbWFpbnRlbmFuY2Ugc2V0IChgcmVzb2x2ZUZsZWV0TWFpbnRlbmFuY2VBdXRob3JTZXRgKS5cbiAgICpcbiAgICogQW4gZW1wdHkgbGlzdCBpcyBub3QgYSBzaG9ydGN1dDogaXQgbWVhbnMgbm8gaWRlbnRpdHkgd2FzIHJlc29sdmVkLCBzbyBhXG4gICAqIHJlc3RhcnQgY2xhaW0gb24gdGhlIGlzc3VlIGNhbm5vdCBiZSBhdHRyaWJ1dGVkIGFuZCB0aGUgYWJhbmRvbiBkZWNsaW5lc1xuICAgKiByYXRoZXIgdGhhbiBjbG9zaW5nIGEgUFIgb24gYSBib3VuZCBpdCBjYW5ub3QgY2hlY2suXG4gICAqL1xuICB0cnVzdGVkQXV0aG9yczogcmVhZG9ubHkgc3RyaW5nW107XG4gIGxvZ2dlcj86IExvZ2dlcjtcbiAgLyoqIE9yaWdpbmF0aW5nLWlzc3VlIHJlc29sdXRpb24g4oCUIGRlZmF1bHRzIHRvICMxMTEzJ3MgZ2F0aGVyZXIuICovXG4gIHJlc29sdmVDb250ZXh0PzogKFxuICAgIHJlcXVlc3Q6IEFiYW5kb25SZXN0YXJ0UmVxdWVzdCxcbiAgKSA9PiBQcm9taXNlPENvbmZsaWN0SXNzdWVDb250ZXh0PjtcbiAgLyoqXG4gICAqIE90aGVyLVBSIGxvb2t1cCDigJQgZGVmYXVsdHMgdG8ge0BsaW5rIGZpbmRPdGhlclByc0Zvcklzc3VlfS4gVGhyb3dzIG9uIGFcbiAgICogbG9va3VwIGZhaWx1cmU7IHRoZSBjYWxsZXIgdHVybnMgdGhhdCBpbnRvIGFuIGBleGlzdGluZy1wcmAgc3RlcCBmYWlsdXJlXG4gICAqIHJhdGhlciB0aGFuIHJlYWRpbmcgaXQgYXMgXCJ0aGlzIGlzc3VlIGhhcyBubyBvdGhlciBQUlwiLlxuICAgKi9cbiAgZmluZE90aGVyUHJzPzogKFxuICAgIHJlcG86IHN0cmluZyxcbiAgICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICAgIGV4Y2x1ZGVQck51bWJlcjogbnVtYmVyLFxuICApID0+IFByb21pc2U8SXNzdWVQclJlZltdPjtcbiAgLyoqIExhYmVsIGFwcGxpY2F0aW9uIOKAlCBkZWZhdWx0cyB0byB7QGxpbmsgYWRkTGFiZWxUb0lzc3VlfS4gKi9cbiAgYWRkTGFiZWw/OiAoXG4gICAgcmVwbzogc3RyaW5nLFxuICAgIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gICAgbGFiZWw6IHN0cmluZyxcbiAgKSA9PiBQcm9taXNlPFJlc3VsdDx2b2lkPj47XG4gIC8qKlxuICAgKiBGbGFnLWlzc3VlIGZpbGVyIGZvciB0aGUgbm8tb3JpZ2luYXRpbmctaXNzdWUgcm91dGUgKElzc3VlICMyMzEwKSDigJRcbiAgICogZGVmYXVsdHMgdG8ge0BsaW5rIGZpbGVNZXJnZUZhbGxiYWNrSXNzdWV9IG92ZXIge0BsaW5rIGdofS5cbiAgICovXG4gIGZpbGVGYWxsYmFja0ZsYWc/OiAoXG4gICAgZmlsaW5nOiBNZXJnZUZhbGxiYWNrRmlsaW5nLFxuICApID0+IFByb21pc2U8UmVzdWx0PE1lcmdlRmFsbGJhY2tPdXRjb21lPj47XG59XG5cbi8qKlxuICogVGhlIGdpdCBydW5uZXIgdGhlIHNjYW4gZG9lcyBub3QgaGF2ZS5cbiAqXG4gKiBUaGUgYWJhbmRvbiBkZWNpc2lvbiBuZWVkcyBvbmx5IHRoZSBQUiBzaWRlIG9mICMxMTEzJ3MgY29udGV4dCwgd2hpY2ggaXNcbiAqIHJlc29sdmVkIGZyb20gdGhlIGJyYW5jaCBuYW1lLCB0aGUgUFIgYm9keSBhbmQgR2l0SHViJ3MgbGlua2FnZSDigJQgbm8gY2xvbmUuXG4gKiBPZmZlcmluZyBubyBjb25mbGljdGVkIHBhdGggbWVhbnMgdGhlIGJhc2Utc2lkZSB3YWxrIG5ldmVyIHJ1bnM7IGlmIGl0IGV2ZXJcbiAqIGRpZCwgdGhpcyBmYWlscyBsb3VkIHJhdGhlciB0aGFuIHJlcG9ydGluZyBhbiBlbXB0eSBiYXNlIHNpZGUgYXMgYSBmYWN0LlxuICovXG5jb25zdCBOT19DTE9ORV9HSVQ6IEdpdFJ1bm5lciA9ICgpID0+XG4gIFByb21pc2UucmVzb2x2ZSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICBcIm5vIGNsb25lIGlzIGF2YWlsYWJsZSBoZXJlIOKAlCB0aGUgYmFzZS1zaWRlIHdhbGsgbXVzdCBub3QgcnVuIGZyb20gXCIgK1xuICAgICAgICBcInRoZSBtZXJnZS1jb25mbGljdCBzY2FuXCIsXG4gICAgKSxcbiAgfSk7XG5cbmZ1bmN0aW9uIGVycm9yTWVzc2FnZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbi8qKiBBbiBvcGVuIFBSIHRoYXQgYmVsb25ncyB0byBhbiBpc3N1ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSXNzdWVQclJlZiB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB1cmw6IHN0cmluZztcbn1cblxuLyoqIE9wZW4gUFJzIGxpc3RlZCBwZXIgbG9va3VwIOKAlCB0aGUgc2FtZSBib3VuZCBgZmluZEV4aXN0aW5nUHJGb3JJc3N1ZWAgdXNlcy4gKi9cbmNvbnN0IE9QRU5fUFJfTE9PS1VQX0xJTUlUID0gNTA7XG5cbi8qKlxuICogV2hldGhlciBhIFBSIGJvZHkgY2FycmllcyB0aGUgbGVnYWN5IGB2aWJlLXdvcmtlci1pc3N1ZS08bj5gIG1hcmtlciBmb3JcbiAqIHRoaXMgaXNzdWUg4oCUIGFuZCBub3QgZm9yICMxNiB3aGVuIHRoZSBpc3N1ZSBpcyAjMS5cbiAqXG4gKiBTY2FubmVkIGFzIGEgc3RyaW5nIHJhdGhlciB0aGFuIGJ1aWx0IGludG8gYSBgUmVnRXhwYDogYW4gaW50ZXJwb2xhdGVkXG4gKiBwYXR0ZXJuIGlzIGEgUmVEb1Mgc3VyZmFjZSB0aGUgU0FTVCBnYXRlIHJlamVjdHMgb3V0cmlnaHQsIGFuZCB0aGlzIG5lZWRzIG5vXG4gKiBwYXR0ZXJuIGF0IGFsbC5cbiAqL1xuZnVuY3Rpb24gYm9keU5hbWVzSXNzdWUoYm9keTogc3RyaW5nLCBpc3N1ZU51bWJlcjogbnVtYmVyKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1hcmtlciA9IGB2aWJlLXdvcmtlci1pc3N1ZS0ke2lzc3VlTnVtYmVyfWA7XG4gIGZvciAoXG4gICAgbGV0IGF0ID0gYm9keS5pbmRleE9mKG1hcmtlcik7XG4gICAgYXQgPj0gMDtcbiAgICBhdCA9IGJvZHkuaW5kZXhPZihtYXJrZXIsIGF0ICsgMSlcbiAgKSB7XG4gICAgY29uc3QgbmV4dCA9IGJvZHkuY2hhckF0KGF0ICsgbWFya2VyLmxlbmd0aCk7XG4gICAgaWYgKG5leHQgPT09IFwiXCIgfHwgbmV4dCA8IFwiMFwiIHx8IG5leHQgPiBcIjlcIikgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIEV2ZXJ5ICoqb3BlbioqIFBSIGZvciBhbiBpc3N1ZSBleGNlcHQgb25lLCBuZXdlc3QgZmlyc3QuXG4gKlxuICogRGVsaWJlcmF0ZWx5IG5vdCB7QGxpbmsgZmluZEV4aXN0aW5nUHJGb3JJc3N1ZX0sIHdob3NlIHNoYXBlIGlzIHdyb25nIGZvciBhXG4gKiBwcmVjb25kaXRpb24gb24gYSBkZXN0cnVjdGl2ZSBzdGVwIGluIHRocmVlIHdheXM6IGl0IHN3YWxsb3dzIGV2ZXJ5IGBnaGBcbiAqIGZhaWx1cmUgaW50byB0aGUgc2FtZSBcIm5vIFBSIGZvdW5kXCIgaXQgcmV0dXJucyBmb3IgYSBnZW51aW5lIGFic2VuY2UsIGl0XG4gKiByZXR1cm5zIG9ubHkgdGhlIGZpcnN0IG1hdGNoLCBhbmQgaXQgYWxzbyBtYXRjaGVzIG1lcmdlZCBhbmRcbiAqIHJlY2VudGx5LWNsb3NlZCBQUnMuIEhlcmUgYW4gQVBJIGZhaWx1cmUgbXVzdCAqKnRocm93Kiog4oCUIHJlYWRpbmcgYW4gb3V0YWdlXG4gKiBhcyBcIm5vIG90aGVyIFBSXCIgd291bGQgbGV0IHRoZSBjbG9zZSBwcm9jZWVkIOKAlCBhbmQgKmV2ZXJ5KiBtYXRjaCBtdXN0IGJlXG4gKiBzZWVuLCBzaW5jZSB0aGUgb25lIFBSIHRoYXQgbWF0dGVycyBtYXkgbm90IGJlIHRoZSBuZXdlc3QuXG4gKlxuICogVGhlIG1hdGNoZXIgaXMgdGhlIGZsZWV0J3Mgb3duIHtAbGluayBwclRpdGxlTWF0Y2hlc0lzc3VlfSBwbHVzIHRoZSBsZWdhY3lcbiAqIGJvZHkgbWFya2VyLCBzbyB0aGlzIGFuZCB0aGUgZmxlZXQncyBQUiBkZWR1cCBhZ3JlZSBvbiB3aGF0IFwidGhlIGlzc3VlJ3MgUFJcIlxuICogbWVhbnMuIEEgZm9yay1oZWFkZWQgUFIgcHJvdmVzIG5vdGhpbmcgKElzc3VlICMxMTI0KTogaXRzIHRpdGxlIGlzIHRleHRcbiAqIGFueWJvZHkgbWF5IHdyaXRlLCBzbyBpdCBpcyBpZ25vcmVkIHJhdGhlciB0aGFuIGFsbG93ZWQgdG8gYmxvY2sgYSByZXN0YXJ0LlxuICpcbiAqIEB0aHJvd3Mgd2hlbiB0aGUgbGlzdGluZyBjYW5ub3QgYmUgcmVhZCBvciBwYXJzZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmaW5kT3RoZXJQcnNGb3JJc3N1ZShcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBleGNsdWRlUHJOdW1iZXI6IG51bWJlcixcbiAgZ2g6IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuKTogUHJvbWlzZTxJc3N1ZVByUmVmW10+IHtcbiAgY29uc3QgcmF3ID0gYXdhaXQgZ2goW1xuICAgIFwicHJcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJvcGVuXCIsXG4gICAgXCItLWpzb25cIixcbiAgICBcIm51bWJlcix0aXRsZSxib2R5LHVybCxpc0Nyb3NzUmVwb3NpdG9yeVwiLFxuICAgIFwiLS1saW1pdFwiLFxuICAgIFN0cmluZyhPUEVOX1BSX0xPT0tVUF9MSU1JVCksXG4gIF0pO1xuICBjb25zdCB0cmltbWVkID0gcmF3LnRyaW0oKTtcbiAgaWYgKHRyaW1tZWQubGVuZ3RoID09PSAwKSB7XG4gICAgLy8gYGdoIHByIGxpc3QgLS1qc29uYCBwcmludHMgYFtdYCB3aGVuIHRoZXJlIGlzIG5vdGhpbmc7IGVtcHR5IG91dHB1dFxuICAgIC8vIG1lYW5zIHRoZSBjYWxsIGFuc3dlcmVkIHdpdGggbm90aGluZyBhdCBhbGwsIHdoaWNoIGlzIG5vdCBhbiBhYnNlbmNlLlxuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBFbXB0eSBQUiBsaXN0aW5nIGZvciAke3JlcG99IGlzc3VlICMke2lzc3VlTnVtYmVyfSDigJQgYW4gdW5hbnN3ZXJlZCBgICtcbiAgICAgICAgXCJsb29rdXAgbXVzdCBub3QgYmUgcmVhZCBhcyAnbm8gb3RoZXIgUFInXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKHRyaW1tZWQpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBFeHBlY3RlZCBhIFBSIGFycmF5IGZvciAke3JlcG99IGlzc3VlICMke2lzc3VlTnVtYmVyfSwgZ290IGAgK1xuICAgICAgICBgJHtwYXJzZWQgPT09IG51bGwgPyBcIm51bGxcIiA6IHR5cGVvZiBwYXJzZWR9YCxcbiAgICApO1xuICB9XG5cbiAgY29uc3Qgb3RoZXJzOiBJc3N1ZVByUmVmW10gPSBbXTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBwYXJzZWQpIHtcbiAgICBpZiAodHlwZW9mIGVudHJ5ICE9PSBcIm9iamVjdFwiIHx8IGVudHJ5ID09PSBudWxsKSBjb250aW51ZTtcbiAgICBjb25zdCBwciA9IGVudHJ5IGFzIHtcbiAgICAgIG51bWJlcj86IHVua25vd247XG4gICAgICB0aXRsZT86IHVua25vd247XG4gICAgICBib2R5PzogdW5rbm93bjtcbiAgICAgIHVybD86IHVua25vd247XG4gICAgICBpc0Nyb3NzUmVwb3NpdG9yeT86IHVua25vd247XG4gICAgfTtcbiAgICBjb25zdCBudW1iZXIgPSB0eXBlb2YgcHIubnVtYmVyID09PSBcIm51bWJlclwiID8gcHIubnVtYmVyIDogTmFOO1xuICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIobnVtYmVyKSB8fCBudW1iZXIgPT09IGV4Y2x1ZGVQck51bWJlcikgY29udGludWU7XG4gICAgaWYgKHByLmlzQ3Jvc3NSZXBvc2l0b3J5ID09PSB0cnVlKSBjb250aW51ZTtcbiAgICBjb25zdCB0aXRsZSA9IHR5cGVvZiBwci50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IHByLnRpdGxlIDogXCJcIjtcbiAgICBjb25zdCBib2R5ID0gdHlwZW9mIHByLmJvZHkgPT09IFwic3RyaW5nXCIgPyBwci5ib2R5IDogXCJcIjtcbiAgICBpZiAoXG4gICAgICAhcHJUaXRsZU1hdGNoZXNJc3N1ZSh0aXRsZSwgaXNzdWVOdW1iZXIpICYmXG4gICAgICAhYm9keU5hbWVzSXNzdWUoYm9keSwgaXNzdWVOdW1iZXIpXG4gICAgKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgb3RoZXJzLnB1c2goe1xuICAgICAgbnVtYmVyLFxuICAgICAgdXJsOiB0eXBlb2YgcHIudXJsID09PSBcInN0cmluZ1wiICYmIHByLnVybC5sZW5ndGggPiAwXG4gICAgICAgID8gcHIudXJsXG4gICAgICAgIDogYGh0dHBzOi8vZ2l0aHViLmNvbS8ke3JlcG99L3B1bGwvJHtudW1iZXJ9YCxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gb3RoZXJzO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENvbW1lbnQgYm9kaWVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIFRoZSBjb25mbGljdGVkIHBhdGhzLCByZW5kZXJlZCBmb3IgYSBjb21tZW50IOKAlCBvciB0aGUgc3RhdGVkIGFic2VuY2UuICovXG5mdW5jdGlvbiBjb25mbGljdGVkUGF0aExpbmVzKGhpc3Rvcnk6IEZhaWxlZEF0dGVtcHRIaXN0b3J5KTogc3RyaW5nW10ge1xuICByZXR1cm4gaGlzdG9yeS5jb25mbGljdGVkUGF0aHMubGVuZ3RoID4gMFxuICAgID8gaGlzdG9yeS5jb25mbGljdGVkUGF0aHMubWFwKChwYXRoKSA9PiBgLSBcXGAke3Nhbml0aXNlSXNzdWVUZXh0KHBhdGgpfVxcYGApXG4gICAgOiBbXCItIChubyBjb25mbGljdGVkIHBhdGggd2FzIHJlY29yZGVkKVwiXTtcbn1cblxuLyoqXG4gKiBUaGUgaXNzdWVzIGNvbnN1bHRlZCwgYXMgY29tbWVudCBsaW5lcyAoSXNzdWVzICMxMTEzLyMxMTE0KS5cbiAqXG4gKiBUd28gc291cmNlcywgYmVjYXVzZSBuZWl0aGVyIGFsb25lIGlzIHRoZSBhbnN3ZXI6IHRoZSBjb250ZXh0IHRoaXMgcnVuZ1xuICogZ2F0aGVyZWQgbmFtZXMgdGhlIFBSIHNpZGUgKGFuZCB0aGUgYmFzZSBzaWRlLCB3aGVuIHRoZSBjYWxsZXIgaGFkIGEgY2xvbmUpLFxuICogd2hpbGUgdGhlIGF0dGVtcHRzJyBvd24gY29tbWVudHMgbmFtZSBldmVyeSBpc3N1ZSB0aGUgcmVzb2x2ZXIgd2FzIGFjdHVhbGx5XG4gKiBzaG93biDigJQgYSByZWNvcmQgbm8gbGF0ZXIgcnVuIGNhbiByZS1kZXJpdmUgb25jZSB0aGUgY2xvbmUgaXMgZ29uZS5cbiAqL1xuZnVuY3Rpb24gY29uc3VsdGVkSXNzdWVMaW5lcyhcbiAgY29udGV4dDogQ29uZmxpY3RJc3N1ZUNvbnRleHQsXG4gIGhpc3Rvcnk6IEZhaWxlZEF0dGVtcHRIaXN0b3J5LFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBrbm93bjogT3JpZ2luYXRpbmdJc3N1ZVtdID0gW107XG4gIGlmIChjb250ZXh0LnByU2lkZS5yZXNvbHZlZCkga25vd24ucHVzaChjb250ZXh0LnByU2lkZS5pc3N1ZSk7XG4gIGZvciAoY29uc3QgcGF0aCBvZiBjb250ZXh0LmJhc2VTaWRlKSB7XG4gICAgZm9yIChjb25zdCBpc3N1ZSBvZiBwYXRoLmlzc3Vlcykge1xuICAgICAgaWYgKCFrbm93bi5zb21lKChzZWVuKSA9PiBzZWVuLm51bWJlciA9PT0gaXNzdWUubnVtYmVyKSkge1xuICAgICAgICBrbm93bi5wdXNoKGlzc3VlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCBsaW5lcyA9IGtub3duLm1hcCgoaXNzdWUpID0+XG4gICAgYC0gIyR7aXNzdWUubnVtYmVyfSDigJQgJHtzYW5pdGlzZUlzc3VlVGV4dChpc3N1ZS50aXRsZSl9YFxuICApO1xuICBmb3IgKGNvbnN0IGlzc3VlTnVtYmVyIG9mIGhpc3RvcnkuY29uc3VsdGVkSXNzdWVzKSB7XG4gICAgaWYgKGtub3duLnNvbWUoKHNlZW4pID0+IHNlZW4ubnVtYmVyID09PSBpc3N1ZU51bWJlcikpIGNvbnRpbnVlO1xuICAgIGxpbmVzLnB1c2goYC0gIyR7aXNzdWVOdW1iZXJ9IOKAlCByZWNvcmRlZCBvbiBhbiBhdHRlbXB0IGNvbW1lbnRgKTtcbiAgfVxuICByZXR1cm4gbGluZXMubGVuZ3RoID4gMFxuICAgID8gbGluZXNcbiAgICA6IFtcIi0gKG5vbmUg4oCUIG5vIG9yaWdpbmF0aW5nIGlzc3VlIHdhcyByZXNvbHZhYmxlIGZvciBlaXRoZXIgc2lkZSlcIl07XG59XG5cbi8qKlxuICogVGhlIGNvbW1lbnQgcG9zdGVkIG9uIHRoZSBQUiBiZWZvcmUgaXQgaXMgY2xvc2VkLlxuICpcbiAqIEl0IGhhcyB0byBzdGFuZCBvbiBpdHMgb3duIG1vbnRocyBsYXRlcjogd2hhdCB3YXMgdHJpZWQsIHdoYXQgaXQgdHJpcHBlZCBvbixcbiAqIHdoYXQgd2FzIGNvbnN1bHRlZCwgd2hhdCBoYXBwZW5zIG5leHQsIGFuZCB0aGUgYnJhbmNoIG5hbWUsIHNvIHRoZSBhYmFuZG9uZWRcbiAqIHdvcmsgc3RheXMgZmluZGFibGUgYWZ0ZXIgdGhlIFBSIGxlYXZlcyB0aGUgb3BlbiBxdWV1ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQWJhbmRvblByQ29tbWVudChhcmdzOiB7XG4gIHJlcXVlc3Q6IEFiYW5kb25SZXN0YXJ0UmVxdWVzdDtcbiAgaGlzdG9yeTogRmFpbGVkQXR0ZW1wdEhpc3Rvcnk7XG4gIGNvbnRleHQ6IENvbmZsaWN0SXNzdWVDb250ZXh0O1xuICBpc3N1ZU51bWJlcjogbnVtYmVyO1xuICAvKipcbiAgICogVGhlIHBpY2t1cCBsYWJlbCB0aGUgaXNzdWUgY2FycmllcyBvbmNlIGl0IGlzIHJlLXF1ZXVlZCAoSXNzdWUgIzIyNzcpLlxuICAgKiBOYW1lZCBoZXJlIGJlY2F1c2UgdGhpcyBjb21tZW50IGlzIHBlcm1hbmVudDogYSByZWFkZXIgbW9udGhzIGxhdGVyIG11c3RcbiAgICogYmUgYWJsZSB0byBzZWUgd2hpY2ggbGFiZWwgdGhlIGZsZWV0IHdpbGwgcGljayB0aGUgd29yayB1cCBieS5cbiAgICovXG4gIGxhYmVsOiBSZXF1ZXVlTGFiZWw7XG59KTogc3RyaW5nIHtcbiAgY29uc3QgeyByZXF1ZXN0LCBoaXN0b3J5LCBjb250ZXh0LCBpc3N1ZU51bWJlciB9ID0gYXJncztcbiAgY29uc3QgbGFiZWxOYW1lID0gcmVxdWV1ZUxhYmVsTmFtZShhcmdzLmxhYmVsKTtcbiAgLy8gRXZlcnkgcXVvdGVkIHN0cmluZyBiZWxvdyBjYW1lIG9mZiBHaXRIdWIg4oCUIGEgZmFpbHVyZSBjb21tZW50IHRoZSBhZ2VudFxuICAvLyB3cm90ZSwgYSBwYXRoLCBhbiBpc3N1ZSB0aXRsZSDigJQgYW5kIHRoaXMgY29tbWVudCBpcyBhIHB1YmxpYyBvdXRib3VuZFxuICAvLyBzaW5rLCBzbyBlYWNoIGdvZXMgdGhyb3VnaCB0aGUgc2FtZSBzYW5pdGlzZXIgdGhlIGludGVudCBhdWRpdCB1c2VzOlxuICAvLyBzZWNyZXRzIHJlZGFjdGVkLCBkZWxpbWl0ZXJzIGRlZnVzZWQsIEhUTUwgY29tbWVudHMgbmV1dHJhbGlzZWQgc28gYVxuICAvLyBxdW90ZWQgYm9keSBjYW5ub3QgZm9yZ2UgYSBtYXJrZXIgKElzc3VlICMxMTE0KS5cbiAgY29uc3QgYXR0ZW1wdHMgPSBoaXN0b3J5LmF0dGVtcHRzLmxlbmd0aCA+IDBcbiAgICA/IGhpc3RvcnkuYXR0ZW1wdHMuZmxhdE1hcCgoYXR0ZW1wdCwgaW5kZXgpID0+IFtcbiAgICAgIFwiXCIsXG4gICAgICBgKipBdHRlbXB0ICR7YXR0ZW1wdC5hdHRlbXB0ID8/IGluZGV4ICsgMX0qKmAsXG4gICAgICBcIlwiLFxuICAgICAgLi4uc2FuaXRpc2VJc3N1ZVRleHQoYXR0ZW1wdC5kZXRhaWwpLnNwbGl0KFwiXFxuXCIpLm1hcCgobGluZSkgPT5cbiAgICAgICAgYD4gJHtsaW5lfWBcbiAgICAgICksXG4gICAgXSlcbiAgICA6IFtcIlwiLCBcIl8obm8gZmFpbHVyZSBjb21tZW50IHN1cnZpdmVzIGluIHRoaXMgdGhyZWFkKV9cIl07XG5cbiAgY29uc3QgcGF0aHMgPSBjb25mbGljdGVkUGF0aExpbmVzKGhpc3RvcnkpO1xuXG4gIGNvbnN0IGNvbnN1bHRlZCA9IGNvbnN1bHRlZElzc3VlTGluZXMoY29udGV4dCwgaGlzdG9yeSk7XG5cbiAgY29uc3QgYnJhbmNoID0gc2FuaXRpc2VJc3N1ZVRleHQocmVxdWVzdC5icmFuY2hOYW1lKTtcbiAgY29uc3QgYmFzZSA9IHNhbml0aXNlSXNzdWVUZXh0KHJlcXVlc3QuYmFzZUJyYW5jaCk7XG4gIC8vIE5vIHJlc3RhcnQgbWFya2VyIGhlcmU6IHRoZSBtYXJrZXIgaXMgdGhlIGlzc3VlJ3MgKElzc3VlICMxMTE1KS4gVGhpcyBQUlxuICAvLyBpcyBjbG9zZWQgbW9tZW50cyBsYXRlciBhbmQgYSByZXBsYWNlbWVudCB0YWtlcyBpdHMgcGxhY2UsIHNvIGEgY2xhaW1cbiAgLy8gcmVjb3JkZWQgb24gaXQgd291bGQgYmUgcmVhZCBiYWNrIGFnYWluc3QgdGhlIHdyb25nIFBSLlxuICByZXR1cm4gW1xuICAgIFwi4pm777iPICoqQWJhbmRvbmluZyB0aGlzIFBSIGFuZCByZXN0YXJ0aW5nIHRoZSB3b3JrKipcIixcbiAgICBcIlwiLFxuICAgIC8vIENvdW50ZWQgZnJvbSB0aGUgdGhyZWFkLCBuZXZlciBhc3N1bWVkOiB0aGUgc3RhbGUtdmVyZGljdCBsYWRkZXIgcmVhY2hlc1xuICAgIC8vIHRoaXMgcnVuZyBoYXZpbmcgb3BlbmVkICoqbm8qKiBhdHRlbXB0IGF0IGFsbCAoSXNzdWUgIzIyODApLCBhbmQgYVxuICAgIC8vIGZhaWx1cmUgY29uY2x1c2lvbiB0aGF0IGNvdWxkIG5vdCBiZSBwb3N0ZWQgbGVhdmVzIG9uZSBhdHRlbXB0IHNob3J0XG4gICAgLy8gZWl0aGVyIHdheS4gXCJUd28gYXR0ZW1wdHMgZmFpbGVkXCIgb24gYSBQUiB0aGF0IHJlY29yZGVkIG5vbmUgaXMgYVxuICAgIC8vIGZhYnJpY2F0ZWQgZmFjdCBvbiBhIHBlcm1hbmVudCBjb21tZW50LlxuICAgIGAke2Rlc2NyaWJlQ29uY2x1ZGVkQXR0ZW1wdHMoaGlzdG9yeSl9LCBhbmQgR2l0SHViIHN0aWxsIHdpbGwgbm90IG1lcmdlIGAgK1xuICAgIGBcXGAke2JyYW5jaH1cXGAgaW50byBcXGAke2Jhc2V9XFxgLiBSZWRvaW5nIHRoZSB3b3JrIG9mZiB0aGUgY3VycmVudCBiYXNlIGAgK1xuICAgIFwiaXMgY2hlYXBlciB0aGFuIHJlY29uY2lsaW5nIGl0LCBhbmQgbmVlZHMgbm8gaHVtYW4uXCIsXG4gICAgXCJcIixcbiAgICBcIioqV2hhdCB0aGUgYXR0ZW1wdHMgcmVjb3JkZWQqKlwiLFxuICAgIC4uLmF0dGVtcHRzLFxuICAgIFwiXCIsXG4gICAgXCIqKkNvbmZsaWN0ZWQgcGF0aHMqKlwiLFxuICAgIFwiXCIsXG4gICAgLi4ucGF0aHMsXG4gICAgXCJcIixcbiAgICBcIioqSXNzdWVzIGNvbnN1bHRlZCoqXCIsXG4gICAgXCJcIixcbiAgICAuLi5jb25zdWx0ZWQsXG4gICAgXCJcIixcbiAgICBcIl9CYXNlLXNpZGUgaXNzdWVzIGFyZSByZXNvbHZhYmxlIG9ubHkgd2l0aCBhIGNsb25lIHRvIHdhbGsgXCIgK1xuICAgIFwiKElzc3VlICMxMTEzKTsgd2hlcmUgdGhlIGNhbGxlciBoYWQgbm9uZSwgdGhlIGxpc3QgYWJvdmUgaXMgdGhlIFBSIHNpZGUgXCIgK1xuICAgIFwicGx1cyB3aGF0ZXZlciB0aGUgYXR0ZW1wdCBjb21tZW50cyByZWNvcmRlZC5fXCIsXG4gICAgXCJcIixcbiAgICBcIioqV2hhdCBoYXBwZW5zIG5vdyoqXCIsXG4gICAgXCJcIixcbiAgICBgVGhpcyBQUiBpcyBiZWluZyAqKmNsb3NlZCoqIOKAlCBub3QgbWVyZ2VkIOKAlCBhbmQgaXNzdWUgYCArXG4gICAgYCMke2lzc3VlTnVtYmVyfSBpcyBiZWluZyByZS1xdWV1ZWQgKCR7XG4gICAgICBcImtlcHRcIiBpbiBhcmdzLmxhYmVsXG4gICAgICAgID8gYFxcYCR7bGFiZWxOYW1lfVxcYCwgdGhlIHBpY2t1cCBsYWJlbCBpdCBhbHJlYWR5IGNhcnJpZXNgXG4gICAgICAgIDogYFxcYCR7bGFiZWxOYW1lfVxcYCwgYXBwbGllZCBieSB0aGUgd29ya2VyYFxuICAgIH0pIHNvIHRoZSBmbGVldCByYWlzZXMgYSBmcmVzaCBQUiBvZmYgXFxgJHtiYXNlfVxcYC5gLFxuICAgIFwiXCIsXG4gICAgYFRoZSBicmFuY2ggXFxgJHticmFuY2h9XFxgIGlzICoqbm90KiogZGVsZXRlZCBhbmQgaGFzICoqbm90KiogYCArXG4gICAgXCJiZWVuIGZvcmNlLXB1c2hlZDogZXZlcnkgY29tbWl0IG9uIGl0IHN0YXlzIGV4YWN0bHkgYXMgaXRzIGF1dGhvciBcIiArXG4gICAgXCJwdXNoZWQgaXQsIHNvIHRoZSBhYmFuZG9uZWQgd29yayByZW1haW5zIHJlYWRhYmxlIGFuZCBsaW5rZWQgZnJvbSBoZXJlLlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIGNvbW1lbnQgcG9zdGVkIG9uIHRoZSBvcmlnaW5hdGluZyBpc3N1ZSDigJQgYW5kIHRoZSByZXN0YXJ0IG1hcmtlci5cbiAqXG4gKiBQcmVzZW50IHRlbnNlIG9uIHB1cnBvc2U6IGl0IGlzIHBvc3RlZCBiZWZvcmUgdGhlIGNsb3NlLCBhcyB0aGUgY2xhaW0gdGhhdFxuICogc3RvcHMgYSBzZWNvbmQgaG9zdCBhYmFuZG9uaW5nIHRoZSBzYW1lIFBSLCBzbyBpdCBtdXN0IG5vdCBhc3NlcnQgYVxuICogY29tcGxldGVkIHN0YXRlIGl0IGhhcyBub3QgcmVhY2hlZCB5ZXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFJlc3RhcnRJc3N1ZUNvbW1lbnQoYXJnczoge1xuICByZXF1ZXN0OiBBYmFuZG9uUmVzdGFydFJlcXVlc3Q7XG4gIGhpc3Rvcnk6IEZhaWxlZEF0dGVtcHRIaXN0b3J5O1xuICAvKiogVGhlIHBpY2t1cCBsYWJlbCB0aGlzIGlzc3VlIGNhcnJpZXMgb25jZSBpdCBpcyByZS1xdWV1ZWQgKCMyMjc3KS4gKi9cbiAgbGFiZWw6IFJlcXVldWVMYWJlbDtcbiAgLyoqXG4gICAqIFdoaWNoIHJlc3RhcnQgdGhpcyBpcyBmb3IgdGhlIGlzc3VlLCBjb3VudGluZyBmcm9tIG9uZSAoSXNzdWUgIzIzMTIpLlxuICAgKiBUaGVyZSBpcyBubyBjYXAgKElzc3VlICMzMDMzKTogdGhlIGNsb3NpbmcgcGFyYWdyYXBoIHNheXMgc28sIHdoYXRldmVyXG4gICAqIG51bWJlciB0aGlzIGlzLlxuICAgKi9cbiAgcmVzdGFydE51bWJlcj86IG51bWJlcjtcbn0pOiBzdHJpbmcge1xuICBjb25zdCB7IHJlcXVlc3QsIGhpc3RvcnkgfSA9IGFyZ3M7XG4gIGNvbnN0IHJlc3RhcnROdW1iZXIgPSBhcmdzLnJlc3RhcnROdW1iZXIgPz8gMTtcbiAgY29uc3QgbGFiZWxOYW1lID0gcmVxdWV1ZUxhYmVsTmFtZShhcmdzLmxhYmVsKTtcbiAgY29uc3QgcGF0aHMgPSBjb25mbGljdGVkUGF0aExpbmVzKGhpc3RvcnkpO1xuICAvLyBXaGljaCBsYWJlbCwgYW5kIHdoeSBpdCBpcyB0aGF0IG9uZTogYW4gaXNzdWUgdGhhdCBhbHJlYWR5IGNhcnJpZWQgYVxuICAvLyBwaWNrdXAgbGFiZWwga2VlcHMgaXQsIHNvIGEgYHRvcC1wcmlvcml0eWAgaXNzdWUgaXMgbm90IHNpbGVudGx5IGRlbW90ZWRcbiAgLy8gYnkgaXRzIG93biByZXN0YXJ0IChJc3N1ZSAjMjI3NykuXG4gIGNvbnN0IGxhYmVsQ2xhdXNlID0gXCJrZXB0XCIgaW4gYXJncy5sYWJlbFxuICAgID8gYGl0IGtlZXBzIHRoZSBcXGAke2xhYmVsTmFtZX1cXGAgbGFiZWwgaXQgYWxyZWFkeSBjYXJyaWVzYFxuICAgIDogYFxcYCR7bGFiZWxOYW1lfVxcYCBpcyBiZWluZyBhcHBsaWVkIHRvIGl0LCBzaW5jZSBpdCBjYXJyaWVkIG5vIHBpY2t1cCBgICtcbiAgICAgIFwibGFiZWxcIjtcbiAgY29uc3Qgd2hhdEhhcHBlbnNOb3cgPVxuICAgIGBUaGF0IFBSIGlzIGJlaW5nIGNsb3NlZCBhbmQgdGhpcyBpc3N1ZSByZS1xdWV1ZWQg4oCUICR7bGFiZWxDbGF1c2V9IOKAlCBzbyBgICtcbiAgICBcInRoZSB3b3JrIGlzIHJlZG9uZSBvZmYgdGhlIGN1cnJlbnQgYmFzZSByYXRoZXIgdGhhbiByZWNvbmNpbGVkIGFnYWluc3QgXCIgK1xuICAgIFwiaXQuIFRoZSBhYmFuZG9uZWQgYnJhbmNoIGlzIGtlcHQsIG5vdCBkZWxldGVkLCBhbmQgd2FzIG5ldmVyIFwiICtcbiAgICBgZm9yY2UtcHVzaGVkIOKAlCByZWFkIGl0IGF0ICR7cmVxdWVzdC5yZXBvfSMke3JlcXVlc3QucHJOdW1iZXJ9IGlmIHRoZSBgICtcbiAgICBcImVhcmxpZXIgd29yayBpcyB1c2VmdWwuXCI7XG5cbiAgY29uc3QgYmFzZSA9IHNhbml0aXNlSXNzdWVUZXh0KHJlcXVlc3QuYmFzZUJyYW5jaCk7XG4gIHJldHVybiBbXG4gICAgY29uZmxpY3RSZXN0YXJ0TWFya2VyKHJlcXVlc3QucmVwbywgcmVxdWVzdC5wck51bWJlciwgcmVxdWVzdC5icmFuY2hOYW1lKSxcbiAgICBcIuKZu++4jyAqKlJlLXF1ZXVlZDogdGhlIFBSIGZvciB0aGlzIGlzc3VlIGNvbmZsaWN0ZWQgaXJyZWNvbmNpbGFibHkqKlwiLFxuICAgIFwiXCIsXG4gICAgYCR7cmVxdWVzdC5yZXBvfSMke3JlcXVlc3QucHJOdW1iZXJ9IHB1dCB0aGlzIGlzc3VlJ3Mgd29yayBvbiBgICtcbiAgICBgXFxgJHtzYW5pdGlzZUlzc3VlVGV4dChyZXF1ZXN0LmJyYW5jaE5hbWUpfVxcYCwgYW5kIEdpdEh1YiB3aWxsIG5vdCBtZXJnZSBgICtcbiAgICBgdGhhdCBicmFuY2ggaW50byBcXGAke2Jhc2V9XFxgLiBgICtcbiAgICBgJHtkZXNjcmliZUNvbmNsdWRlZEF0dGVtcHRzKGhpc3RvcnkpfS5gLFxuICAgIFwiXCIsXG4gICAgXCJDb25mbGljdGVkIHBhdGhzOlwiLFxuICAgIFwiXCIsXG4gICAgLi4ucGF0aHMsXG4gICAgXCJcIixcbiAgICBcIioqUmVzb2x1dGlvbiBhdHRlbXB0cyBvbiB0aGlzIFBSKipcIixcbiAgICBcIlwiLFxuICAgIC4uLnJlbmRlckF0dGVtcHRUYWJsZShyZXF1ZXN0LnJlcG8sIFtcbiAgICAgIHsgcHJOdW1iZXI6IHJlcXVlc3QucHJOdW1iZXIsIGF0dGVtcHRzOiBoaXN0b3J5LnJlc29sdXRpb25BdHRlbXB0cyB9LFxuICAgIF0pLFxuICAgIFwiXCIsXG4gICAgd2hhdEhhcHBlbnNOb3csXG4gICAgXCJcIixcbiAgICBgVGhpcyBpcyByZXN0YXJ0ICoqJHtyZXN0YXJ0TnVtYmVyfSoqIGZvciB0aGlzIGlzc3VlLiBUaGVyZSBpcyBubyBjYXA6IGAgK1xuICAgIFwiaWYgdGhlIGZyZXNoIFBSIGNvbmZsaWN0cyB0b28sIHRoZSB3b3JrIGlzIHJlZG9uZSBhZ2FpbiBvbiBhIGZyZXNoIFwiICtcbiAgICBgYnJhbmNoIGN1dCBmcm9tIHRoZSB0aGVuLWN1cnJlbnQgdGlwIG9mIFxcYCR7YmFzZX1cXGAg4oCUIG5ldmVyIGZyb20gYW4gYCArXG4gICAgXCJhYmFuZG9uZWQgaGVhZC5cIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIE1hcmtlciBvbiB0aGUgb25lIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXQgYSBuby1pc3N1ZSBQUidzIGZhbGxiYWNrIHdhcyBmaWxlZFxuICogaW4gVmliZUNvZGVyIChJc3N1ZSAjNDQ1NiksIHNvIGEgbGF0ZXIgY3ljbGUgZG9lcyBub3QgZmlsZSBpdCBhZ2Fpbi5cbiAqL1xuZXhwb3J0IGNvbnN0IE5PX0lTU1VFX0ZBTExCQUNLX1JFQ09SREVEX01BUktFUiA9XG4gIFwiPCEtLSB2aWJlLW1lcmdlLWZhbGxiYWNrLXJlY29yZGVkIC0tPlwiO1xuXG4vKiogQ2F1c2UgcmVjb3JkZWQgZm9yIGEgUFIgd2hvc2UgY29uZmxpY3QgbGFkZGVyIHJhbiBvdXQgKElzc3VlICM0NDU2KS4gKi9cbmV4cG9ydCBjb25zdCBQUl9MQURERVJfRVhIQVVTVEVEX0NBVVNFID0gXCJ0aGUgUFIgY29uZmxpY3QgbGFkZGVyIHdhcyBleGhhdXN0ZWRcIjtcblxuLyoqXG4gKiBUaGUgY29tbWVudCBvbiBhIGNvbmZsaWN0aW5nIFBSIHdpdGggbm8gb3JpZ2luYXRpbmcgaXNzdWUgKElzc3VlcyAjMjMxMCxcbiAqICM0NDU2KTogaXQgc3RheXMgb3BlbiwgYW5kIGl0cyBmYWxsYmFjayBpcyBhIFZpYmVDb2RlciBmYWlsdXJlLlxuICpcbiAqIENsb3NpbmcgaXQgYW5kIGZpbGluZyBhIHJlLWRvIGlzc3VlIGluIGl0cyBwbGFjZSBjcmVhdGVkIG5ldyB3b3JrIGluc3RlYWRcbiAqIG9mIGZpbmlzaGluZyB0aGlzIHdvcmssIHNvIHRoZSBQUiBpcyBsZWZ0IG9wZW4gZm9yIHRoZSBsYWRkZXIgdG8ga2VlcFxuICogd29ya2luZywgYW5kIHRoZSBmYWxsYmFjayBpcyBmaWxlZCBpbiBWaWJlQ29kZXIgZm9yIHRoZSB3b3JrZXIgdG8gYmUgZml4ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZE5vSXNzdWVLZXB0T3BlblByQ29tbWVudChhcmdzOiB7XG4gIHJlcXVlc3Q6IEFiYW5kb25SZXN0YXJ0UmVxdWVzdDtcbiAgaGlzdG9yeTogRmFpbGVkQXR0ZW1wdEhpc3Rvcnk7XG4gIHJlYXNvbjogUHJVbnJlc29sdmVkUmVhc29uO1xuICAvKiogVGhlIFZpYmVDb2RlciByZWNvcmQsIG9yIDAgd2hlbiBpdHMgbnVtYmVyIGNvdWxkIG5vdCBiZSByZWFkLiAqL1xuICByZWNvcmRJc3N1ZU51bWJlcjogbnVtYmVyO1xufSk6IHN0cmluZyB7XG4gIGNvbnN0IHsgcmVxdWVzdCwgaGlzdG9yeSwgcmVjb3JkSXNzdWVOdW1iZXIgfSA9IGFyZ3M7XG4gIGNvbnN0IGJyYW5jaCA9IHNhbml0aXNlSXNzdWVUZXh0KHJlcXVlc3QuYnJhbmNoTmFtZSk7XG4gIGNvbnN0IGJhc2UgPSBzYW5pdGlzZUlzc3VlVGV4dChyZXF1ZXN0LmJhc2VCcmFuY2gpO1xuICBjb25zdCByZWNvcmQgPSByZWNvcmRJc3N1ZU51bWJlciA+IDBcbiAgICA/IGAke01FUkdFX0ZBTExCQUNLX1RBUkdFVF9SRVBPfSMke3JlY29yZElzc3VlTnVtYmVyfWBcbiAgICA6IGBhIFxcYG1lcmdlLWZhbGxiYWNrXFxgIGlzc3VlIGluICR7TUVSR0VfRkFMTEJBQ0tfVEFSR0VUX1JFUE99IHdob3NlIGAgK1xuICAgICAgXCJudW1iZXIgY291bGQgbm90IGJlIHJlYWRcIjtcbiAgcmV0dXJuIFtcbiAgICBOT19JU1NVRV9GQUxMQkFDS19SRUNPUkRFRF9NQVJLRVIsXG4gICAgXCLwn5qpICoqVGhpcyBQUiBzdGF5cyBvcGVuIOKAlCB0aGUgZmFsbGJhY2sgaXMgcmVjb3JkZWQgYXMgYSB3b3JrZXIgZmFpbHVyZSoqXCIsXG4gICAgXCJcIixcbiAgICBgJHtkZXNjcmliZUNvbmNsdWRlZEF0dGVtcHRzKGhpc3RvcnkpfSwgYW5kIEdpdEh1YiBzdGlsbCB3aWxsIG5vdCBtZXJnZSBgICtcbiAgICBgXFxgJHticmFuY2h9XFxgIGludG8gXFxgJHtiYXNlfVxcYC5gLFxuICAgIFwiXCIsXG4gICAgYFRoaXMgUFIgbmFtZXMgKipubyBvcmlnaW5hdGluZyBpc3N1ZSoqICgke2FyZ3MucmVhc29ufSkuIEl0IGlzIG5vdCBgICtcbiAgICBcImNsb3NlZCBhbmQgbm8gbmV3IGlzc3VlIGlzIGZpbGVkIHRvIHJlZG8gaXQ6IHRoZSBjb25mbGljdCBsYWRkZXIga2VlcHMgXCIgK1xuICAgIGB3b3JraW5nIHRoaXMgUFIuIFRoZSB3b3JrZXIncyBmYWlsdXJlIHRvIHNldHRsZSBpdCBpcyByZWNvcmRlZCBpbiAke3JlY29yZH0uYCxcbiAgICBcIlwiLFxuICAgIFwiKipDb25mbGljdGVkIHBhdGhzKipcIixcbiAgICBcIlwiLFxuICAgIC4uLmNvbmZsaWN0ZWRQYXRoTGluZXMoaGlzdG9yeSksXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLyoqIFdoZXJlIGEgcmUtcXVldWVkIGlzc3VlJ3MgcGlja3VwIGxhYmVsIGNhbWUgZnJvbSwgZm9yIGEgY29tbWVudC4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlUmVxdWV1ZUxhYmVsKGxhYmVsOiBSZXF1ZXVlTGFiZWwpOiBzdHJpbmcge1xuICBjb25zdCBuYW1lID0gcmVxdWV1ZUxhYmVsTmFtZShsYWJlbCk7XG4gIHJldHVybiBcImtlcHRcIiBpbiBsYWJlbFxuICAgID8gYFxcYCR7bmFtZX1cXGAsIHRoZSBwaWNrdXAgbGFiZWwgaXQgYWxyZWFkeSBjYXJyaWVzYFxuICAgIDogYFxcYCR7bmFtZX1cXGAsIGFwcGxpZWQgYnkgdGhlIHdvcmtlcmA7XG59XG5cbi8qKlxuICogVGhlIFBSIGNvbW1lbnQgZm9yIGEgc3RhbGxlZCBQUiBhYmFuZG9uZWQgd2l0aCBhbiBvcmlnaW5hdGluZyBpc3N1ZVxuICogKElzc3VlICMyODAyKS4gU3RhbmRzIGFsb25lIG1vbnRocyBsYXRlcjogd2hhdCBzdGFsbGVkLCB0aGF0IG9uZSByZXBhaXIgd2FzXG4gKiB0cmllZCwgd2hhdCBoYXBwZW5zIG5vdywgYW5kIHdoZXJlIHRoZSBicmFuY2ggaXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0YWxsZWRBYmFuZG9uUHJDb21tZW50KGFyZ3M6IHtcbiAgcmVxdWVzdDogQWJhbmRvblJlc3RhcnRSZXF1ZXN0O1xuICBkZXRhaWw6IHN0cmluZztcbiAgdHJpZWQ6IFN0YWxsUmVwYWlyVHJpZWQ7XG4gIGlzc3VlTnVtYmVyOiBudW1iZXI7XG4gIGxhYmVsOiBSZXF1ZXVlTGFiZWw7XG59KTogc3RyaW5nIHtcbiAgY29uc3QgYnJhbmNoID0gc2FuaXRpc2VJc3N1ZVRleHQoYXJncy5yZXF1ZXN0LmJyYW5jaE5hbWUpO1xuICBjb25zdCBiYXNlID0gc2FuaXRpc2VJc3N1ZVRleHQoYXJncy5yZXF1ZXN0LmJhc2VCcmFuY2gpO1xuICByZXR1cm4gW1xuICAgIFwi4pm777iPICoqQWJhbmRvbmluZyB0aGlzIHN0YWxsZWQgUFIgYW5kIHJlc3RhcnRpbmcgdGhlIHdvcmsqKlwiLFxuICAgIFwiXCIsXG4gICAgYFRoaXMgUFIgJHtzYW5pdGlzZUlzc3VlVGV4dChhcmdzLmRldGFpbCl9LiBgICtcbiAgICBgJHtkZXNjcmliZVN0YWxsUmVwYWlyKGFyZ3MudHJpZWQsIGJhc2UpfSwgYW5kIGl0IGlzIHN0aWxsIGAgK1xuICAgIFwic3RhbGxlZCwgc28gdGhlIHdvcmsgaXMgcmVkb25lIHJhdGhlciB0aGFuIG51cnNlZCBmdXJ0aGVyLlwiLFxuICAgIFwiXCIsXG4gICAgYFRoaXMgUFIgaXMgYmVpbmcgKipjbG9zZWQqKiDigJQgbm90IG1lcmdlZCDigJQgYW5kIGlzc3VlIGAgK1xuICAgIGAjJHthcmdzLmlzc3VlTnVtYmVyfSBpcyBiZWluZyByZS1xdWV1ZWQgYCArXG4gICAgYCgke2Rlc2NyaWJlUmVxdWV1ZUxhYmVsKGFyZ3MubGFiZWwpfSkgc28gdGhlIGZsZWV0IHJhaXNlcyBhIGZyZXNoIFBSIGAgK1xuICAgIC8vIEEgY2xvc2VkIHJvdXRlJ3MgYnJhbmNoIGlzIHRoZSBvbmUgcGxhY2UgdGhlIHJlZG8gbXVzdCBub3QgZ28gYmFjayB0b1xuICAgIC8vIChJc3N1ZSAjNDMwNCk6IHRoZSBuZXh0IHJ1biBwaWNrcyBpdHMgYmFzZSBhZnJlc2guXG4gICAgKGFyZ3MudHJpZWQgPT09IFwicm91dGUtY2xvc2VkLWhvbGRcIlxuICAgICAgPyBcImFnYWluc3Qgd2hhdGV2ZXIgYmFzZSBpdHMgbWlsZXN0b25lIG5vdyByb3V0ZXMgdG8uXCJcbiAgICAgIDogYG9mZiBcXGAke2Jhc2V9XFxgLmApLFxuICAgIFwiXCIsXG4gICAgYFRoZSBicmFuY2ggXFxgJHticmFuY2h9XFxgIGlzICoqbm90KiogZGVsZXRlZCBhbmQgaGFzICoqbm90KiogYmVlbiBgICtcbiAgICBcImZvcmNlLXB1c2hlZCwgc28gdGhlIGFiYW5kb25lZCB3b3JrIHJlbWFpbnMgcmVhZGFibGUgYW5kIGxpbmtlZCBmcm9tIGhlcmUuXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBUaGUgb3JpZ2luYXRpbmctaXNzdWUgY29tbWVudCBmb3IgYSBzdGFsbGVkIFBSIChJc3N1ZSAjMjgwMikuIENhcnJpZXMgdGhlXG4gKiBzYW1lIHJlc3RhcnQgbWFya2VyIGFzIHRoZSBtZXJnZS1jb25mbGljdCByb3V0ZSwgYW5kIHRoZSBzYW1lIHVuY2FwcGVkXG4gKiByZXN0YXJ0IGNvdW50IChJc3N1ZSAjMzAzMykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0YWxsZWRSZXN0YXJ0SXNzdWVDb21tZW50KGFyZ3M6IHtcbiAgcmVxdWVzdDogQWJhbmRvblJlc3RhcnRSZXF1ZXN0O1xuICBkZXRhaWw6IHN0cmluZztcbiAgdHJpZWQ6IFN0YWxsUmVwYWlyVHJpZWQ7XG4gIGxhYmVsOiBSZXF1ZXVlTGFiZWw7XG4gIHJlc3RhcnROdW1iZXI6IG51bWJlcjtcbn0pOiBzdHJpbmcge1xuICBjb25zdCB7IHJlcXVlc3QgfSA9IGFyZ3M7XG4gIHJldHVybiBbXG4gICAgY29uZmxpY3RSZXN0YXJ0TWFya2VyKHJlcXVlc3QucmVwbywgcmVxdWVzdC5wck51bWJlciwgcmVxdWVzdC5icmFuY2hOYW1lKSxcbiAgICBcIuKZu++4jyAqKlJlLXF1ZXVlZDogdGhlIFBSIGZvciB0aGlzIGlzc3VlIHN0YWxsZWQqKlwiLFxuICAgIFwiXCIsXG4gICAgYCR7cmVxdWVzdC5yZXBvfSMke3JlcXVlc3QucHJOdW1iZXJ9ICR7c2FuaXRpc2VJc3N1ZVRleHQoYXJncy5kZXRhaWwpfS4gYCArXG4gICAgYCR7XG4gICAgICBkZXNjcmliZVN0YWxsUmVwYWlyKGFyZ3MudHJpZWQsIHNhbml0aXNlSXNzdWVUZXh0KHJlcXVlc3QuYmFzZUJyYW5jaCkpXG4gICAgfSwgYW5kIGl0IGlzIHN0aWxsIHN0YWxsZWQuYCxcbiAgICBcIlwiLFxuICAgIGBUaGF0IFBSIGlzIGJlaW5nIGNsb3NlZCBhbmQgdGhpcyBpc3N1ZSByZS1xdWV1ZWQgYCArXG4gICAgYCgke2Rlc2NyaWJlUmVxdWV1ZUxhYmVsKGFyZ3MubGFiZWwpfSkgc28gdGhlIHdvcmsgaXMgcmVkb25lLiBUaGUgYCArXG4gICAgYGFiYW5kb25lZCBicmFuY2ggXFxgJHtzYW5pdGlzZUlzc3VlVGV4dChyZXF1ZXN0LmJyYW5jaE5hbWUpfVxcYCBpcyBrZXB0LCBgICtcbiAgICBcIm5vdCBkZWxldGVkLlwiLFxuICAgIFwiXCIsXG4gICAgYFRoaXMgaXMgcmVzdGFydCAqKiR7YXJncy5yZXN0YXJ0TnVtYmVyfSoqIGZvciB0aGlzIGlzc3VlLmAsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUaGUgcnVuZ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBUaGUgaXNzdWUgc3RhdGUgYW5kIGxhYmVscyBvbmUgYGdoIGlzc3VlIHZpZXdgIGFuc3dlcnMgZm9yLiAqL1xuZXhwb3J0IGludGVyZmFjZSBJc3N1ZVNuYXBzaG90IHtcbiAgc3RhdGU6IHN0cmluZztcbiAgbGFiZWxzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoSXNzdWVTbmFwc2hvdChcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBnaDogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4pOiBQcm9taXNlPElzc3VlU25hcHNob3Q+IHtcbiAgY29uc3QgcmF3ID0gYXdhaXQgZ2goW1xuICAgIFwiaXNzdWVcIixcbiAgICBcInZpZXdcIixcbiAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgIFwiLS1yZXBvXCIsXG4gICAgcmVwbyxcbiAgICBcIi0tanNvblwiLFxuICAgIFwic3RhdGUsbGFiZWxzXCIsXG4gIF0pO1xuICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdy50cmltKCkgfHwgXCJ7fVwiKSBhcyB7XG4gICAgc3RhdGU/OiB1bmtub3duO1xuICAgIGxhYmVscz86IHVua25vd247XG4gIH07XG4gIC8vIEFuIHVucmVhZGFibGUgaXNzdWUgbXVzdCBub3QgYmVjb21lIGB7IHN0YXRlOiBcIlwiLCBsYWJlbHM6IFtdIH1gOiB0aGF0XG4gIC8vIHJlYWRzIGFzIFwib3BlbiBhbmQgdW5sYWJlbGxlZFwiLCB3aGljaCBzaWxlbnRseSBza2lwcyB0aGUgcmVvcGVuIGFuZCBjYW5cbiAgLy8gbGV0IHRoZSBjbG9zZSBwcm9jZWVkIG9uIGFuIGlzc3VlIG5vYm9keSBjb3VsZCBzZWUuXG4gIGlmICh0eXBlb2YgcGFyc2VkLnN0YXRlICE9PSBcInN0cmluZ1wiIHx8ICFBcnJheS5pc0FycmF5KHBhcnNlZC5sYWJlbHMpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFVudXNhYmxlIGlzc3VlIHZpZXcgZm9yICR7cmVwb30jJHtpc3N1ZU51bWJlcn06IG5vIHN0YXRlL2xhYmVscyBpbiBgICtcbiAgICAgICAgXCJ0aGUgcmVzcG9uc2VcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGxhYmVsczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBsYWJlbCBvZiBwYXJzZWQubGFiZWxzKSB7XG4gICAgY29uc3QgbmFtZSA9IChsYWJlbCBhcyB7IG5hbWU/OiB1bmtub3duIH0gfCBudWxsKT8ubmFtZTtcbiAgICBpZiAodHlwZW9mIG5hbWUgPT09IFwic3RyaW5nXCIpIGxhYmVscy5wdXNoKG5hbWUpO1xuICB9XG4gIHJldHVybiB7IHN0YXRlOiBwYXJzZWQuc3RhdGUsIGxhYmVscyB9O1xufVxuXG4vKiogVGhlIHN0ZXAgcmVwb3J0ZXIge0BsaW5rIGFiYW5kb25BbmRSZXN0YXJ0fSBhbmQgaXRzIGJyYW5jaGVzIHNoYXJlLiAqL1xudHlwZSBGYWlsZWRSZXBvcnRlciA9IChcbiAgc3RlcDogQWJhbmRvblN0ZXAsXG4gIGVycm9yOiB1bmtub3duLFxuICBpc3N1ZU51bWJlcj86IG51bWJlcixcbikgPT4gQWJhbmRvblJlc3RhcnRPdXRjb21lO1xuXG4vKipcbiAqIExlYXZlIGEgY29uZmxpY3RpbmcgUFIgdGhhdCBuYW1lcyBubyBvcmlnaW5hdGluZyBpc3N1ZSBvcGVuLCBhbmQgcmVjb3JkIGl0c1xuICogZmFsbGJhY2sgaW4gVmliZUNvZGVyIChJc3N1ZXMgIzIzMTAsICM0NDU2KS5cbiAqXG4gKiBDbG9zaW5nIGl0IGFuZCBmaWxpbmcgYSByZS1kbyBpc3N1ZSBpbiB0aGUgc291cmNlIHJlcG9zaXRvcnkgbWFkZSBuZXcgd29ya1xuICogaW5zdGVhZCBvZiBmaW5pc2hpbmcgdGhpcyB3b3JrLCBzbyBuZWl0aGVyIGhhcHBlbnM6IHRoZSBQUiBzdGF5cyBvcGVuIGZvclxuICogdGhlIGxhZGRlciB0byBrZWVwIHdvcmtpbmcsIGFuZCB0aGUgcmVzdWx0IGlzIHRoZSBgbm8tb3JpZ2luYXRpbmctaXNzdWVgXG4gKiBkZWNsaW5lLiBBIHN0YWxsZWQgUFIgKElzc3VlICMyODAyKSBzdGF5cyBvcGVuIHRoZSBzYW1lIHdheS4gVGhlIHJlY29yZCBpc1xuICogZmlsZWQgb25jZSBwZXIgUFIg4oCUIHRoZSBtYXJrZXIgY29tbWVudCBzYXlzIGl0IHdhcyDigJQgYW5kIGEgcmVjb3JkIHRoYXRcbiAqIGNhbm5vdCBiZSBmaWxlZCBuZXZlciBjaGFuZ2VzIHRoZSBkZWNsaW5lOiBpdCBpcyBsb2dnZWQsIGFuZCB0aGUgbmV4dCBjeWNsZVxuICogdHJpZXMgYWdhaW4uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGFiYW5kb25XaXRob3V0T3JpZ2luYXRpbmdJc3N1ZShcbiAgcmVxdWVzdDogQWJhbmRvblJlc3RhcnRSZXF1ZXN0LFxuICBkZXBzOiBBYmFuZG9uUmVzdGFydERlcHMsXG4gIHJlYXNvbjogUHJVbnJlc29sdmVkUmVhc29uLFxuICBmYWlsZWQ6IEZhaWxlZFJlcG9ydGVyLFxuKTogUHJvbWlzZTxBYmFuZG9uUmVzdGFydE91dGNvbWU+IHtcbiAgY29uc3QgeyByZXBvLCBwck51bWJlciB9ID0gcmVxdWVzdDtcbiAgY29uc3QgZ2ggPSBkZXBzLmdoO1xuICBjb25zdCBsb2dnZXIgPSBkZXBzLmxvZ2dlcjtcbiAgY29uc3QgZGVjbGluZWQ6IEFiYW5kb25SZXN0YXJ0T3V0Y29tZSA9IHtcbiAgICBvdXRjb21lOiBcImRlY2xpbmVkXCIsXG4gICAgcmVhc29uOiB7IGtpbmQ6IFwibm8tb3JpZ2luYXRpbmctaXNzdWVcIiwgZGV0YWlsOiByZWFzb24gfSxcbiAgfTtcblxuICBpZiAocmVxdWVzdC5yZWFzb24/LmtpbmQgPT09IFwic3RhbGxlZFwiKSB7XG4gICAgbG9nZ2VyPy53YXJuPy4oXG4gICAgICBgU3RhbGxlZCBQUiAjJHtwck51bWJlcn0gbmFtZXMgbm8gb3JpZ2luYXRpbmcgaXNzdWUgKCR7cmVhc29ufSkg4oCUIGxlZnQgYCArXG4gICAgICAgIFwib3BlbjsgYSBQUiBpcyBuZXZlciBjbG9zZWQgYW5kIHJlZG9uZSB0aHJvdWdoIGEgbmV3IGlzc3VlIFwiICtcbiAgICAgICAgXCIoSXNzdWUgIzQ0NTYpXCIsXG4gICAgICB7IHJlcG8sIHByTnVtYmVyIH0sXG4gICAgKTtcbiAgICByZXR1cm4gZGVjbGluZWQ7XG4gIH1cblxuICBsZXQgY29tbWVudHM6IHJlYWRvbmx5IHVua25vd25bXTtcbiAgdHJ5IHtcbiAgICAvLyBBdHRyaWJ1dGVkIGxpa2UgZXZlcnkgb3RoZXIgcmVhZCBvZiB0aGlzIHRocmVhZCAoSXNzdWUgIzEyNDcpOiB0aGVcbiAgICAvLyByZWNvcmQgcXVvdGVzIGl0LCBzbyBhbiBvdXRzaWRlcidzIHRleHQgbXVzdCBuZXZlciBiZSBmaWxlZCBhcyB0aGVcbiAgICAvLyBmbGVldCdzIG93biBhY2NvdW50IG9mIHdoYXQgdGhlIHJ1bnMgZm91bmQuXG4gICAgY29tbWVudHMgPSBwYXJ0aXRpb25Db25mbGljdENvbW1lbnRzKFxuICAgICAgcmVxdWVzdC5wckNvbW1lbnRzID8/IGF3YWl0IGZldGNoSXNzdWVDb21tZW50UGFnZXMocmVwbywgcHJOdW1iZXIsIGdoKSxcbiAgICAgIGRlcHMudHJ1c3RlZEF1dGhvcnMsXG4gICAgKS50cnVzdGVkO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBmYWlsZWQoXCJwci10aHJlYWRcIiwgZXJyb3IpO1xuICB9XG4gIGNvbnN0IGFscmVhZHlSZWNvcmRlZCA9IGNvbW1lbnRzLnNvbWUoKGNvbW1lbnQpID0+XG4gICAgdHlwZW9mIChjb21tZW50IGFzIHsgYm9keT86IHVua25vd24gfSkuYm9keSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIChjb21tZW50IGFzIHsgYm9keTogc3RyaW5nIH0pLmJvZHkuaW5jbHVkZXMoXG4gICAgICBOT19JU1NVRV9GQUxMQkFDS19SRUNPUkRFRF9NQVJLRVIsXG4gICAgKVxuICApO1xuICBpZiAoYWxyZWFkeVJlY29yZGVkKSByZXR1cm4gZGVjbGluZWQ7XG4gIGNvbnN0IGhpc3RvcnkgPSBzdW1tYXJpc2VGYWlsZWRBdHRlbXB0cyhjb21tZW50cywgZGVwcy50cnVzdGVkQXV0aG9ycyk7XG5cbiAgLy8gQmVzdC1lZmZvcnQgY29udGV4dDogYSByZWFkIHRoYXQgZmFpbGVkIHJlbmRlcnMgYXMgYG5vdCByZWNvcmRlZGAgaW4gdGhlXG4gIC8vIHJlY29yZCByYXRoZXIgdGhhbiBhcyBhIGd1ZXNzLCBhbmQgbmV2ZXIgc3RvcHMgdGhlIGZhbGxiYWNrLlxuICBjb25zdCBkaXZlcmdlbmNlID0gYXdhaXQgcmVhZFByRGl2ZXJnZW5jZSh7XG4gICAgcmVwbyxcbiAgICBwck51bWJlcixcbiAgICBiYXNlQnJhbmNoOiByZXF1ZXN0LmJhc2VCcmFuY2gsXG4gICAgaGVhZEJyYW5jaDogcmVxdWVzdC5icmFuY2hOYW1lLFxuICAgIHF1ZXVlTGFiZWw6IE1FUkdFX0NPTkZMSUNUX0xBQkVMLFxuICAgIGdoLFxuICAgIC4uLihsb2dnZXIgIT09IHVuZGVmaW5lZCA/IHsgbG9nZ2VyIH0gOiB7fSksXG4gIH0pO1xuICBjb25zdCBkaWZmID0gYXdhaXQgcmVhZFByRGlmZlN1bW1hcnkoe1xuICAgIHJlcG8sXG4gICAgcHJOdW1iZXIsXG4gICAgZ2gsXG4gICAgLi4uKGxvZ2dlciAhPT0gdW5kZWZpbmVkID8geyBsb2dnZXIgfSA6IHt9KSxcbiAgfSk7XG5cbiAgY29uc3QgZmlsZXIgPSBkZXBzLmZpbGVGYWxsYmFja0ZsYWcgPz8gY3JlYXRlRmFsbGJhY2tGbGFnRmlsZXIoe1xuICAgIGdoLFxuICAgIC4uLihsb2dnZXIgIT09IHVuZGVmaW5lZCA/IHsgbG9nZ2VyIH0gOiB7fSksXG4gICAgZmxlZXRBdXRob3JzOiBkZXBzLnRydXN0ZWRBdXRob3JzLFxuICB9KTtcbiAgY29uc3QgZmlsZWQgPSBhd2FpdCBmaWxlcih7XG4gICAgdGFyZ2V0OiB7XG4gICAgICBraW5kOiBcInByXCIsXG4gICAgICByZXBvLFxuICAgICAgcHJOdW1iZXIsXG4gICAgICBoZWFkQnJhbmNoOiByZXF1ZXN0LmJyYW5jaE5hbWUsXG4gICAgICBiYXNlQnJhbmNoOiByZXF1ZXN0LmJhc2VCcmFuY2gsXG4gICAgfSxcbiAgICBjYXVzZTogUFJfTEFEREVSX0VYSEFVU1RFRF9DQVVTRSxcbiAgICBjb25mbGljdGVkRmlsZXM6IGhpc3RvcnkuY29uZmxpY3RlZFBhdGhzLFxuICAgIHJ1bnM6IG1lcmdlRmFsbGJhY2tSdW5zRnJvbUhpc3RvcnkoaGlzdG9yeSksXG4gICAgLi4uZGl2ZXJnZW5jZSxcbiAgICAuLi4oZGlmZiAhPT0gdW5kZWZpbmVkXG4gICAgICA/IHsgZGlmZlN1bW1hcnk6IGRpZmYuZmlsZXMsIGRpZmZTdW1tYXJ5T21pdHRlZDogZGlmZi5vbWl0dGVkIH1cbiAgICAgIDoge30pLFxuICAgIGZhbGxiYWNrQWN0aW9uOiBgTGVmdCAke3JlcG99IyR7cHJOdW1iZXJ9IG9wZW46IGl0IG5hbWVzIG5vIG9yaWdpbmF0aW5nIGAgK1xuICAgICAgYGlzc3VlICgke3JlYXNvbn0pLCBzbyB0aGUgbGFkZGVyIGtlZXBzIHdvcmtpbmcgdGhlIHNhbWUgUFIuYCxcbiAgfSk7XG4gIGlmICghZmlsZWQub2spIHtcbiAgICBsb2dnZXI/Lndhcm4/LihcbiAgICAgIGBQUiAjJHtwck51bWJlcn0gbmFtZXMgbm8gb3JpZ2luYXRpbmcgaXNzdWUgKCR7cmVhc29ufSkg4oCUIGxlZnQgb3BlbjsgYCArXG4gICAgICAgIFwiaXRzIGZhbGxiYWNrIGNvdWxkIG5vdCBiZSByZWNvcmRlZCBpbiBWaWJlQ29kZXIgdGhpcyBjeWNsZVwiLFxuICAgICAgeyByZXBvLCBwck51bWJlciwgZXJyb3I6IGZpbGVkLmVycm9yLm1lc3NhZ2UgfSxcbiAgICApO1xuICAgIHJldHVybiBkZWNsaW5lZDtcbiAgfVxuXG4gIHRyeSB7XG4gICAgYXdhaXQgZ2goW1xuICAgICAgXCJwclwiLFxuICAgICAgXCJjb21tZW50XCIsXG4gICAgICBTdHJpbmcocHJOdW1iZXIpLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tYm9keVwiLFxuICAgICAgYnVpbGROb0lzc3VlS2VwdE9wZW5QckNvbW1lbnQoe1xuICAgICAgICByZXF1ZXN0LFxuICAgICAgICBoaXN0b3J5LFxuICAgICAgICByZWFzb24sXG4gICAgICAgIHJlY29yZElzc3VlTnVtYmVyOiBmaWxlZC52YWx1ZS5pc3N1ZU51bWJlcixcbiAgICAgIH0pLFxuICAgIF0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGxvZ2dlcj8ud2Fybj8uKFxuICAgICAgYFBSICMke3ByTnVtYmVyfTogaXRzIGZhbGxiYWNrIGlzIHJlY29yZGVkIGluIFZpYmVDb2RlciBidXQgdGhlIFBSIGAgK1xuICAgICAgICBcImNvbW1lbnQgc2F5aW5nIHNvIGNvdWxkIG5vdCBiZSBwb3N0ZWRcIixcbiAgICAgIHtcbiAgICAgICAgcmVwbyxcbiAgICAgICAgcHJOdW1iZXIsXG4gICAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgbG9nZ2VyPy53YXJuPy4oXG4gICAgYFBSICMke3ByTnVtYmVyfSBuYW1lcyBubyBvcmlnaW5hdGluZyBpc3N1ZSAoJHtyZWFzb259KSDigJQgbGVmdCBvcGVuIGFuZCBgICtcbiAgICAgIGByZWNvcmRlZCBhcyAke01FUkdFX0ZBTExCQUNLX1RBUkdFVF9SRVBPfSMke2ZpbGVkLnZhbHVlLmlzc3VlTnVtYmVyfSDigJQgYCArXG4gICAgICBkZXNjcmliZUNvbmNsdWRlZEF0dGVtcHRzKGhpc3RvcnkpLFxuICAgIHsgcmVwbywgcHJOdW1iZXIsIHJlY29yZElzc3VlTnVtYmVyOiBmaWxlZC52YWx1ZS5pc3N1ZU51bWJlciB9LFxuICApO1xuICByZXR1cm4gZGVjbGluZWQ7XG59XG5cbi8qKlxuICogQ2xvc2UgdGhlIGNvbmZsaWN0aW5nIFBSIGFuZCByZS1xdWV1ZSBpdHMgb3JpZ2luYXRpbmcgaXNzdWUuXG4gKlxuICogTmV2ZXIgdGhyb3dzOiBldmVyeSBmYWlsdXJlIGlzIHJldHVybmVkIGFzIGB7IG91dGNvbWU6IFwiZmFpbGVkXCIsIHN0ZXAgfWAgc29cbiAqIHRoZSBjYWxsZXIgY2FuIGVzY2FsYXRlIG5hbWluZyB0aGUgc3RlcCB0aGF0IHN0b3BwZWQgaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhYmFuZG9uQW5kUmVzdGFydChcbiAgcmVxdWVzdDogQWJhbmRvblJlc3RhcnRSZXF1ZXN0LFxuICBkZXBzOiBBYmFuZG9uUmVzdGFydERlcHMsXG4pOiBQcm9taXNlPEFiYW5kb25SZXN0YXJ0T3V0Y29tZT4ge1xuICBjb25zdCB7IHJlcG8sIHByTnVtYmVyIH0gPSByZXF1ZXN0O1xuICBjb25zdCBnaCA9IGRlcHMuZ2g7XG4gIGNvbnN0IGxvZ2dlciA9IGRlcHMubG9nZ2VyO1xuXG4gIGNvbnN0IGZhaWxlZCA9IChcbiAgICBzdGVwOiBBYmFuZG9uU3RlcCxcbiAgICBlcnJvcjogdW5rbm93bixcbiAgICBpc3N1ZU51bWJlcj86IG51bWJlcixcbiAgKTogQWJhbmRvblJlc3RhcnRPdXRjb21lID0+IHtcbiAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yKTtcbiAgICBsb2dnZXI/LmVycm9yPy4oXCJBYmFuZG9uLWFuZC1yZXN0YXJ0IGZhaWxlZFwiLCB7XG4gICAgICByZXBvLFxuICAgICAgcHJOdW1iZXIsXG4gICAgICBzdGVwLFxuICAgICAgLi4uKGlzc3VlTnVtYmVyICE9PSB1bmRlZmluZWQgPyB7IGlzc3VlTnVtYmVyIH0gOiB7fSksXG4gICAgICBlcnJvcjogbWVzc2FnZSxcbiAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgb3V0Y29tZTogXCJmYWlsZWRcIixcbiAgICAgIHN0ZXAsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGlzc3VlTnVtYmVyICE9PSB1bmRlZmluZWQgPyB7IGlzc3VlTnVtYmVyIH0gOiB7fSksXG4gICAgfTtcbiAgfTtcblxuICAvLyAtLS0gUHJlY29uZGl0aW9uIDA6IHRoZSBzaGFyZWQgYnVkZ2V0IGhhcyBhY3R1YWxseSBiZWVuIHNwZW50XG4gIC8vIChJc3N1ZSAjMzAwMCkuIFJlYWQgb25jZSwgYXQgdGhlIHZlcnkgdG9wLCBiZWZvcmUgYW55dGhpbmcgZWxzZSDigJRcbiAgLy8gaW5jbHVkaW5nIHRoZSBvcmlnaW5hdGluZy1pc3N1ZSBsb29rdXAg4oCUIHJ1bnMuIEEgcmVhZCBmYWlsdXJlIGhlcmUgbWVhbnNcbiAgLy8gbm90aGluZyBoYXMgY2hhbmdlZCB5ZXQsIHNvIGl0IGZhaWxzIGFzIGBwci10aHJlYWRgIHJhdGhlciB0aGFuIHJlYWNoaW5nXG4gIC8vIGEgbGF0ZXIgc3RlcCB1bmRlciBhIGhhbGYtcmVhZCB0aHJlYWQuXG4gIGxldCB0cnVzdGVkVGhyZWFkOiByZWFkb25seSB1bmtub3duW107XG4gIHRyeSB7XG4gICAgdHJ1c3RlZFRocmVhZCA9IHBhcnRpdGlvbkNvbmZsaWN0Q29tbWVudHMoXG4gICAgICByZXF1ZXN0LnByQ29tbWVudHMgPz8gYXdhaXQgZmV0Y2hJc3N1ZUNvbW1lbnRQYWdlcyhyZXBvLCBwck51bWJlciwgZ2gpLFxuICAgICAgZGVwcy50cnVzdGVkQXV0aG9ycyxcbiAgICApLnRydXN0ZWQ7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIGZhaWxlZChcInByLXRocmVhZFwiLCBlcnJvcik7XG4gIH1cblxuICBjb25zdCBhdHRlbXB0cyA9IHJlYWRSZXNvbHV0aW9uQXR0ZW1wdHMoXG4gICAgdHJ1c3RlZFRocmVhZCxcbiAgICAobG9naW4pID0+IGlzRmxlZXRBdXRob3IobG9naW4sIFsuLi5kZXBzLnRydXN0ZWRBdXRob3JzXSksXG4gICk7XG4gIGNvbnN0IGZhaWxlZEF0dGVtcHRzID0gc3BlbnRDb25mbGljdEF0dGVtcHRzKGF0dGVtcHRzKTtcbiAgLy8gQSBgc3RhbGxlZGAgcmVhc29uIGlzIGV4ZW1wdCAoSXNzdWUgIzI4MDIpOiB0aGUgc3RhbGwtcmVwYWlyIHBhc3Mnc1xuICAvLyBzZWNvbmQgdHJpcCBpcyBub3QgYSBjb25mbGljdC1yZXNvbHV0aW9uIG91dGNvbWUgYXQgYWxsLCBhbmQgaGFzIGl0cyBvd25cbiAgLy8gdHdvLXRyaXAgYm91bmQg4oCUIHRoaXMgZ3VhcmQgb25seSBldmVyIGFwcGxpZXMgdG8gdGhlIG1lcmdlLWNvbmZsaWN0IHJvdXRlLlxuICAvL1xuICAvLyBXaXRoIG5vIGZsZWV0IGlkZW50aXR5IHJlc29sdmVkIChgZGVwcy50cnVzdGVkQXV0aG9yc2AgZW1wdHkpLFxuICAvLyBgcGFydGl0aW9uQ29uZmxpY3RDb21tZW50c2AgY2FuIG5ldmVyIGNhbGwgYW55dGhpbmcgXCJ0cnVzdGVkXCIg4oCUIHNvIGFcbiAgLy8gY29tcHV0ZWQgYGZhaWxlZEF0dGVtcHRzYCBvZiAwIHdvdWxkIGJlIGEgZmFsc2UgXCJub3Qgc3BlbnQgeWV0XCIgcmF0aGVyXG4gIC8vIHRoYW4gYSBnZW51aW5lIHJlYWQgb2YgdGhlIHRocmVhZC4gRGVjbGluZSBubyBlYXJsaWVyIHRoYW4gdGhlXG4gIC8vIHJlc3RhcnQtbWFya2VyIGNoZWNrIGZ1cnRoZXIgZG93biwgd2hpY2ggYWxyZWFkeSBkZWNsaW5lcyBhblxuICAvLyB1bmF0dHJpYnV0YWJsZSBjbGFpbSBleHBsaWNpdGx5IChJc3N1ZSAjMTI0NykgaW5zdGVhZCBvZiBzaWxlbnRseVxuICAvLyByZWFkaW5nIGl0IGFzIGEgaGVhbHRoeSB6ZXJvLlxuICBpZiAoXG4gICAgZGVwcy50cnVzdGVkQXV0aG9ycy5sZW5ndGggPiAwICYmXG4gICAgcmVxdWVzdC5yZWFzb24/LmtpbmQgIT09IFwic3RhbGxlZFwiICYmXG4gICAgZmFpbGVkQXR0ZW1wdHMgPCBDT05GTElDVF9SRVNPTFVUSU9OX0JVREdFVFxuICApIHtcbiAgICBsb2dnZXI/LmluZm8/LihcbiAgICAgIGBQUiAjJHtwck51bWJlcn0gaGFzICR7ZmFpbGVkQXR0ZW1wdHN9IGZhaWxlZCBtZXJnZS1jb25mbGljdCBgICtcbiAgICAgICAgYHJlc29sdXRpb24gYXR0ZW1wdChzKSByZWNvcmRlZCBvZiB0aGUgJHtDT05GTElDVF9SRVNPTFVUSU9OX0JVREdFVH0gYCArXG4gICAgICAgIFwidGhlIHNoYXJlZCBidWRnZXQgYWxsb3dzIOKAlCBub3QgYWJhbmRvbmVkIHlldFwiLFxuICAgICAgeyByZXBvLCBwck51bWJlciwgZmFpbGVkQXR0ZW1wdHMsIGJ1ZGdldDogQ09ORkxJQ1RfUkVTT0xVVElPTl9CVURHRVQgfSxcbiAgICApO1xuICAgIHJldHVybiB7XG4gICAgICBvdXRjb21lOiBcImRlY2xpbmVkXCIsXG4gICAgICByZWFzb246IHtcbiAgICAgICAga2luZDogXCJhdHRlbXB0cy1ub3Qtc3BlbnRcIixcbiAgICAgICAgZmFpbGVkQXR0ZW1wdHMsXG4gICAgICAgIGJ1ZGdldDogQ09ORkxJQ1RfUkVTT0xVVElPTl9CVURHRVQsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyAtLS0gUHJlY29uZGl0aW9uIDE6IHRoZSBvcmlnaW5hdGluZyBpc3N1ZS4gTm8gaXNzdWUsIG5vICpyZS1xdWV1ZSog4oCUIHRoZVxuICAvLyBQUiBpcyBzdGlsbCBjbG9zZWQsIGFnYWluc3QgYSBmbGFnIGlzc3VlIGZpbGVkIGFzIHRoZSByZS1kbyBpdGVtIGluIGl0c1xuICAvLyBwbGFjZSAoSXNzdWUgIzIzMTApLlxuXG4gIGxldCBjb250ZXh0OiBDb25mbGljdElzc3VlQ29udGV4dDtcbiAgdHJ5IHtcbiAgICBjb250ZXh0ID0gZGVwcy5yZXNvbHZlQ29udGV4dFxuICAgICAgPyBhd2FpdCBkZXBzLnJlc29sdmVDb250ZXh0KHJlcXVlc3QpXG4gICAgICA6IGF3YWl0IGdhdGhlckNvbmZsaWN0SXNzdWVDb250ZXh0KHtcbiAgICAgICAgcmVwbyxcbiAgICAgICAgcHJOdW1iZXIsXG4gICAgICAgIHByQnJhbmNoOiByZXF1ZXN0LmJyYW5jaE5hbWUsXG4gICAgICAgIGJhc2VCcmFuY2g6IHJlcXVlc3QuYmFzZUJyYW5jaCxcbiAgICAgICAgY29uZmxpY3RlZFBhdGhzOiBbXSxcbiAgICAgIH0sIHsgZ2gsIGdpdDogTk9fQ0xPTkVfR0lUIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBmYWlsZWQoXCJvcmlnaW5hdGluZy1pc3N1ZVwiLCBlcnJvcik7XG4gIH1cbiAgaWYgKCFjb250ZXh0LnByU2lkZS5yZXNvbHZlZCkge1xuICAgIC8vIElzc3VlICMyMzEwOiBubyBsb25nZXIgYSBkZWNsaW5lLiBUaGUgUFIgaXMgY2xvc2VkIGFuZCB0aGVcbiAgICAvLyBgbWVyZ2UtZmFsbGJhY2tgIGZsYWcgaXNzdWUg4oCUIGBpZGxlLXRhc2tgLCB3aXRoIHRoaXMgUFIncyBkaWZmIHN1bW1hcnkg4oCUXG4gICAgLy8gYmVjb21lcyB0aGUgcmUtZG8gaXRlbSwgYmVjYXVzZSBhIFBSIHBhcmtlZCBmb3IgYSBodW1hbiB3aG8gbmV2ZXIgY29tZXNcbiAgICAvLyBsb3NlcyB0aGUgd29yayBqdXN0IGFzIHN1cmVseSBhcyBjbG9zaW5nIG9uZSB3aXRoIG5vIHJlY29yZC5cbiAgICByZXR1cm4gYXdhaXQgYWJhbmRvbldpdGhvdXRPcmlnaW5hdGluZ0lzc3VlKFxuICAgICAgeyAuLi5yZXF1ZXN0LCBwckNvbW1lbnRzOiB0cnVzdGVkVGhyZWFkIH0sXG4gICAgICBkZXBzLFxuICAgICAgY29udGV4dC5wclNpZGUucmVhc29uLFxuICAgICAgZmFpbGVkLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaXNzdWVOdW1iZXIgPSBjb250ZXh0LnByU2lkZS5pc3N1ZS5udW1iZXI7XG5cbiAgLy8gLS0tIFByZWNvbmRpdGlvbiAyOiBhIGNsYWltIG5hbWluZyB0aGlzIFBSIGRlY2xpbmVzLiAtLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCBpc3N1ZUNvbW1lbnRzOiB1bmtub3duW107XG4gIHRyeSB7XG4gICAgaXNzdWVDb21tZW50cyA9IGF3YWl0IGZldGNoSXNzdWVDb21tZW50UGFnZXMocmVwbywgaXNzdWVOdW1iZXIsIGdoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gZmFpbGVkKFwicmVzdGFydC1tYXJrZXJcIiwgZXJyb3IsIGlzc3VlTnVtYmVyKTtcbiAgfVxuICAvLyBJc3N1ZSAjMTI0NzogdGhlIGNsYWltIGlzIG9ubHkgYSBib3VuZCBpZiB0aGUgZmxlZXQgd3JvdGUgaXQuIEFuXG4gIC8vIG91dHNpZGVyJ3MgbWFya2VyIGlzIGRpc2NhcmRlZCDigJQgb3RoZXJ3aXNlIG9uZSBwbGFudGVkIGNvbW1lbnQgc3RhbGxzXG4gIC8vIGV2ZXJ5IGNvbmZsaWN0ZWQgUFIgZm9yIHRoaXMgaXNzdWUgZm9yIGV2ZXIg4oCUIGJ1dCBhIGNsYWltIHRoYXQgY2Fubm90IGJlXG4gIC8vIGF0dHJpYnV0ZWQgYXQgYWxsIHJlZnVzZXMgdGhlIGFiYW5kb24sIGJlY2F1c2UgZGlzY2FyZGluZyAqdGhhdCogd291bGRcbiAgLy8gcmVsYXggdGhlIGJvdW5kIG9uIGEgc3RlcCB0aGF0IGNsb3NlcyBhIFBSLlxuICBjb25zdCBjbGFpbUNvbW1lbnRzID0gaXNzdWVDb21tZW50cy5maWx0ZXIoY2Fycmllc1Jlc3RhcnRNYXJrZXIpO1xuICBjb25zdCBhdHRyaWJ1dGlvbiA9IHBhcnRpdGlvbkNvbmZsaWN0Q29tbWVudHMoXG4gICAgY2xhaW1Db21tZW50cyxcbiAgICBkZXBzLnRydXN0ZWRBdXRob3JzLFxuICApO1xuICBpZiAoYXR0cmlidXRpb24udW5hdHRyaWJ1dGFibGUgPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG91dGNvbWU6IFwiZGVjbGluZWRcIixcbiAgICAgIHJlYXNvbjoge1xuICAgICAgICBraW5kOiBcInJlc3RhcnQtY2xhaW0tdW52ZXJpZmlhYmxlXCIsXG4gICAgICAgIGlzc3VlTnVtYmVyLFxuICAgICAgICBjbGFpbUNvdW50OiBhdHRyaWJ1dGlvbi51bmF0dHJpYnV0YWJsZSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuICBjb25zdCBvdXRzaWRlckNsYWltcyA9IGNsYWltQ29tbWVudHMubGVuZ3RoIC0gYXR0cmlidXRpb24udHJ1c3RlZC5sZW5ndGg7XG4gIGlmIChvdXRzaWRlckNsYWltcyA+IDApIHtcbiAgICBsb2dnZXI/Lndhcm4/LihcbiAgICAgIGBJZ25vcmVkICR7b3V0c2lkZXJDbGFpbXN9IG1lcmdlLWNvbmZsaWN0IHJlc3RhcnQgY2xhaW0ocykgb24gaXNzdWUgYCArXG4gICAgICAgIGAjJHtpc3N1ZU51bWJlcn0gYXV0aG9yZWQgb3V0c2lkZSB0aGUgZmxlZXQg4oCUIGEgbWFya2VyIGFueW9uZSBjYW4gYCArXG4gICAgICAgIFwicG9zdCBtdXN0IG5vdCBzdGFsbCB0aGUgcmVzdGFydFwiLFxuICAgICAgeyByZXBvLCBwck51bWJlciwgaXNzdWVOdW1iZXIsIG91dHNpZGVyQ2xhaW1zIH0sXG4gICAgKTtcbiAgfVxuICBjb25zdCBjbGFpbWVkID0gcmVzdGFydE1hcmtlclByTnVtYmVycyhhdHRyaWJ1dGlvbi50cnVzdGVkKTtcbiAgLy8gQSBjbGFpbSBuYW1pbmcgdGhpcyBQUiBtZWFucyBhbiBlYXJsaWVyIGFiYW5kb24gb2YgKml0KiBkaWQgbm90IGZpbmlzaCDigJRcbiAgLy8gYSBkaWZmZXJlbnQgc3RvcnkgdG8gdGVsbCB0aGFuIFwidGhlIHJlcGxhY2VtZW50IGZhaWxlZCB0b29cIiwgYW5kIGNsb3NpbmdcbiAgLy8gdGhlIHNhbWUgUFIgdHdpY2UgaXMgbm90IGEgcmV0cnksIHNvIGl0IGRlY2xpbmVzIHdoYXRldmVyIHRoZSBjb3VudCBzYXlzLlxuICAvLyBUaGVyZSBpcyBubyBjYXAgb24gaG93IG1hbnkgdGltZXMgdGhpcyBpc3N1ZSBtYXkgYmUgcmVzdGFydGVkICgjMzAzMyk6IGFcbiAgLy8gY2xhaW0gbmFtaW5nIGEgKmRpZmZlcmVudCogUFIgbmV2ZXIgZGVjbGluZXMuXG4gIGNvbnN0IHNhbWVQciA9IGNsYWltZWQuaW5jbHVkZXMocHJOdW1iZXIpO1xuICBpZiAoc2FtZVByKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG91dGNvbWU6IFwiZGVjbGluZWRcIixcbiAgICAgIHJlYXNvbjoge1xuICAgICAgICBraW5kOiBcImFscmVhZHktcmVzdGFydGVkXCIsXG4gICAgICAgIGlzc3VlTnVtYmVyLFxuICAgICAgICBzYW1lUHIsXG4gICAgICAgIHJlc3RhcnRDb3VudDogY2xhaW1lZC5sZW5ndGgsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyAtLS0gUHJlY29uZGl0aW9uIDM6IHRoZSBpc3N1ZSBoYXMgbm8gb3RoZXIgb3BlbiBQUiBvZiBpdHMgb3duLiAtLS0tLS0tLS1cbiAgbGV0IG90aGVyczogSXNzdWVQclJlZltdO1xuICB0cnkge1xuICAgIGNvbnN0IGZpbmRPdGhlclBycyA9IGRlcHMuZmluZE90aGVyUHJzID8/XG4gICAgICAoKHByUmVwbzogc3RyaW5nLCBudW1iZXI6IG51bWJlciwgZXhjbHVkZTogbnVtYmVyKSA9PlxuICAgICAgICBmaW5kT3RoZXJQcnNGb3JJc3N1ZShwclJlcG8sIG51bWJlciwgZXhjbHVkZSwgZ2gpKTtcbiAgICBvdGhlcnMgPSBhd2FpdCBmaW5kT3RoZXJQcnMocmVwbywgaXNzdWVOdW1iZXIsIHByTnVtYmVyKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBBIGxvb2t1cCB0aGF0IGZhaWxlZCBpcyBub3QgYW4gYWJzZW5jZTogcmVhZGluZyBhbiBvdXRhZ2UgYXMgXCJubyBvdGhlclxuICAgIC8vIFBSXCIgd291bGQgbGV0IHRoZSBjbG9zZSBwcm9jZWVkIG9uIGFuIGlzc3VlIHNvbWVib2R5IGVsc2UgaXMgb24uXG4gICAgcmV0dXJuIGZhaWxlZChcImV4aXN0aW5nLXByXCIsIGVycm9yLCBpc3N1ZU51bWJlcik7XG4gIH1cbiAgY29uc3Qgb3RoZXIgPSBvdGhlcnNbMF07XG4gIGlmIChvdGhlciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG91dGNvbWU6IFwiZGVjbGluZWRcIixcbiAgICAgIHJlYXNvbjogeyBraW5kOiBcIm90aGVyLW9wZW4tcHJcIiwgaXNzdWVOdW1iZXIsIHByVXJsOiBvdGhlci51cmwgfSxcbiAgICB9O1xuICB9XG5cbiAgLy8gLS0tIFRoZSBpc3N1ZSdzIG93biBzdGF0ZTogaXMgaXQgY2xvc2VkLCBhbmQgd2hhdCBkb2VzIGl0IGNhcnJ5PyAtLS0tLS0tXG4gIGxldCBzbmFwc2hvdDogSXNzdWVTbmFwc2hvdDtcbiAgdHJ5IHtcbiAgICBzbmFwc2hvdCA9IGF3YWl0IGZldGNoSXNzdWVTbmFwc2hvdChyZXBvLCBpc3N1ZU51bWJlciwgZ2gpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBmYWlsZWQoXCJpc3N1ZS1zdGF0ZVwiLCBlcnJvciwgaXNzdWVOdW1iZXIpO1xuICB9XG4gIC8vIElzc3VlICMyMjc3OiBrZWVwIHdoYXRldmVyIHBpY2t1cCBsYWJlbCB0aGUgaXNzdWUgYWxyZWFkeSBjYXJyaWVzLCBlbHNlXG4gIC8vIGFwcGx5IGBpZGxlLXRhc2tgLiBObyByb3V0ZSBoZXJlIGhhbmRzIHRoZSBpc3N1ZSB0byBhIGh1bWFuIOKAlCBhbiBpc3N1ZVxuICAvLyB3YWl0aW5nIG9uIGEgbGFiZWwgYSBwZXJzb24gbXVzdCBhcHBseSBpcyBub3QgcmUtcXVldWVkIGF0IGFsbC5cbiAgY29uc3QgcmVxdWV1ZUxhYmVsID0gcGxhblJlcXVldWVMYWJlbChzbmFwc2hvdC5sYWJlbHMpO1xuXG4gIC8vIFJlYWQgb25jZSwgYXQgdGhlIHRvcCBvZiB0aGlzIGNhbGwgKElzc3VlICMzMDAwKSDigJQgbm90IHJlLWZldGNoZWQgaGVyZS5cbiAgY29uc3QgaGlzdG9yeSA9IHN1bW1hcmlzZUZhaWxlZEF0dGVtcHRzKHRydXN0ZWRUaHJlYWQsIGRlcHMudHJ1c3RlZEF1dGhvcnMpO1xuXG4gIC8vIC0tLSBTdGVwIDE6IGNsYWltIHRoZSByZXN0YXJ0IG9uIHRoZSBpc3N1ZSwgbWFya2VyIGZpcnN0LiAtLS0tLS0tLS0tLS0tLVxuICB0cnkge1xuICAgIGF3YWl0IGdoKFtcbiAgICAgIFwiaXNzdWVcIixcbiAgICAgIFwiY29tbWVudFwiLFxuICAgICAgU3RyaW5nKGlzc3VlTnVtYmVyKSxcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWJvZHlcIixcbiAgICAgIHJlcXVlc3QucmVhc29uPy5raW5kID09PSBcInN0YWxsZWRcIlxuICAgICAgICA/IGJ1aWxkU3RhbGxlZFJlc3RhcnRJc3N1ZUNvbW1lbnQoe1xuICAgICAgICAgIHJlcXVlc3QsXG4gICAgICAgICAgZGV0YWlsOiByZXF1ZXN0LnJlYXNvbi5kZXRhaWwsXG4gICAgICAgICAgdHJpZWQ6IHJlcXVlc3QucmVhc29uLnRyaWVkLFxuICAgICAgICAgIGxhYmVsOiByZXF1ZXVlTGFiZWwsXG4gICAgICAgICAgcmVzdGFydE51bWJlcjogY2xhaW1lZC5sZW5ndGggKyAxLFxuICAgICAgICB9KVxuICAgICAgICA6IGJ1aWxkUmVzdGFydElzc3VlQ29tbWVudCh7XG4gICAgICAgICAgcmVxdWVzdCxcbiAgICAgICAgICBoaXN0b3J5LFxuICAgICAgICAgIGxhYmVsOiByZXF1ZXVlTGFiZWwsXG4gICAgICAgICAgLy8gUmVhZCBvZmYgdGhlIHRocmVhZCwgbmV2ZXIgYXNzdW1lZDogdGhlIGNvbW1lbnQgaXMgcGVybWFuZW50LCBhbmRcbiAgICAgICAgICAvLyBcInRoaXMgaXMgeW91ciBsYXN0IHJlc3RhcnRcIiBtdXN0IGJlIHRydWUgd2hlbiBpdCBzYXlzIHNvLlxuICAgICAgICAgIHJlc3RhcnROdW1iZXI6IGNsYWltZWQubGVuZ3RoICsgMSxcbiAgICAgICAgfSksXG4gICAgXSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIGZhaWxlZChcImlzc3VlLWNvbW1lbnRcIiwgZXJyb3IsIGlzc3VlTnVtYmVyKTtcbiAgfVxuXG4gIC8vIC0tLSBTdGVwIDI6IHNheSBvbiB0aGUgUFIgd2h5IGl0IGlzIGJlaW5nIGNsb3NlZC4gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICB0cnkge1xuICAgIGF3YWl0IGdoKFtcbiAgICAgIFwicHJcIixcbiAgICAgIFwiY29tbWVudFwiLFxuICAgICAgU3RyaW5nKHByTnVtYmVyKSxcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWJvZHlcIixcbiAgICAgIHJlcXVlc3QucmVhc29uPy5raW5kID09PSBcInN0YWxsZWRcIlxuICAgICAgICA/IGJ1aWxkU3RhbGxlZEFiYW5kb25QckNvbW1lbnQoe1xuICAgICAgICAgIHJlcXVlc3QsXG4gICAgICAgICAgZGV0YWlsOiByZXF1ZXN0LnJlYXNvbi5kZXRhaWwsXG4gICAgICAgICAgdHJpZWQ6IHJlcXVlc3QucmVhc29uLnRyaWVkLFxuICAgICAgICAgIGlzc3VlTnVtYmVyLFxuICAgICAgICAgIGxhYmVsOiByZXF1ZXVlTGFiZWwsXG4gICAgICAgIH0pXG4gICAgICAgIDogYnVpbGRBYmFuZG9uUHJDb21tZW50KHtcbiAgICAgICAgICByZXF1ZXN0LFxuICAgICAgICAgIGhpc3RvcnksXG4gICAgICAgICAgY29udGV4dCxcbiAgICAgICAgICBpc3N1ZU51bWJlcixcbiAgICAgICAgICBsYWJlbDogcmVxdWV1ZUxhYmVsLFxuICAgICAgICB9KSxcbiAgICBdKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gZmFpbGVkKFwicHItY29tbWVudFwiLCBlcnJvciwgaXNzdWVOdW1iZXIpO1xuICB9XG5cbiAgLy8gLS0tIFN0ZXAgMzogY2xvc2UgaXQuIENsb3NlZCwgbm90IG1lcmdlZDsgdGhlIGJyYW5jaCBzdGF5cy4gLS0tLS0tLS0tLS0tXG4gIHRyeSB7XG4gICAgLy8gTm8gYC0tZGVsZXRlLWJyYW5jaGA6IGJyYW5jaCBjbGVhbnVwIG93bnMgdGhhdCBsaWZlY3ljbGUsIGFuZCB0aGVcbiAgICAvLyBhYmFuZG9uZWQgY29tbWl0cyBtdXN0IHN0YXkgcmVhZGFibGUgKCMxMDc2KS5cbiAgICBhd2FpdCBnaChbXCJwclwiLCBcImNsb3NlXCIsIFN0cmluZyhwck51bWJlciksIFwiLS1yZXBvXCIsIHJlcG9dKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gZmFpbGVkKFwicHItY2xvc2VcIiwgZXJyb3IsIGlzc3VlTnVtYmVyKTtcbiAgfVxuXG4gIC8vIC0tLSBTdGVwIDQ6IHJlLXF1ZXVlIHRoZSBpc3N1ZSDigJQgcmVvcGVuIGl0IGlmIGl0IGlzIGNsb3NlZC4gLS0tLS0tLS0tLS0tXG4gIGlmIChzbmFwc2hvdC5zdGF0ZS50b1VwcGVyQ2FzZSgpID09PSBcIkNMT1NFRFwiKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGdoKFtcImlzc3VlXCIsIFwicmVvcGVuXCIsIFN0cmluZyhpc3N1ZU51bWJlciksIFwiLS1yZXBvXCIsIHJlcG9dKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmV0dXJuIGZhaWxlZChcImlzc3VlLXJlb3BlblwiLCBlcnJvciwgaXNzdWVOdW1iZXIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIC0tLSBTdGVwIDU6IOKApmFuZCBsYWJlbCBpdCwgYnV0IG9ubHkgd2hlcmUgdGhlcmUgaXMgbm90aGluZyB0byBrZWVwLiBBXG4gIC8vIHBpY2t1cCBsYWJlbCB0aGUgaXNzdWUgYWxyZWFkeSBjYXJyaWVzIGlzIGxlZnQgZXhhY3RseSBhcyBpdCBpcywgc28gdGhlXG4gIC8vIHJlc3RhcnQgY2Fubm90IGRlbW90ZSB0aGUgd29yayBhIGh1bWFuIHByaW9yaXRpc2VkIChJc3N1ZSAjMjI3NykuXG4gIGlmIChcImFwcGxpZWRcIiBpbiByZXF1ZXVlTGFiZWwpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgbGFiZWxsZWQgPSBkZXBzLmFkZExhYmVsXG4gICAgICAgID8gYXdhaXQgZGVwcy5hZGRMYWJlbChyZXBvLCBpc3N1ZU51bWJlciwgcmVxdWV1ZUxhYmVsLmFwcGxpZWQpXG4gICAgICAgIDogYXdhaXQgYWRkTGFiZWxUb0lzc3VlKHJlcG8sIGlzc3VlTnVtYmVyLCByZXF1ZXVlTGFiZWwuYXBwbGllZCwge1xuICAgICAgICAgIGdoQ29tbWFuZEZuOiBnaCxcbiAgICAgICAgfSk7XG4gICAgICBpZiAoIWxhYmVsbGVkLm9rKSB7XG4gICAgICAgIHJldHVybiBmYWlsZWQoXCJpc3N1ZS1sYWJlbFwiLCBsYWJlbGxlZC5lcnJvciwgaXNzdWVOdW1iZXIpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZXR1cm4gZmFpbGVkKFwiaXNzdWUtbGFiZWxcIiwgZXJyb3IsIGlzc3VlTnVtYmVyKTtcbiAgICB9XG4gIH1cblxuICBsb2dnZXI/Lndhcm4/LihcbiAgICBgUFIgIyR7cHJOdW1iZXJ9IHdhcyBhYmFuZG9uZWQgYW5kIGlzc3VlICMke2lzc3VlTnVtYmVyfSByZS1xdWV1ZWQgYCArXG4gICAgICBgKFxcYCR7cmVxdWV1ZUxhYmVsTmFtZShyZXF1ZXVlTGFiZWwpfVxcYCkg4oCUIGAgK1xuICAgICAgYCR7ZGVzY3JpYmVDb25jbHVkZWRBdHRlbXB0cyhoaXN0b3J5KX1gLFxuICAgIHtcbiAgICAgIHJlcG8sXG4gICAgICBwck51bWJlcixcbiAgICAgIGlzc3VlTnVtYmVyLFxuICAgICAgbGFiZWw6IHJlcXVldWVMYWJlbE5hbWUocmVxdWV1ZUxhYmVsKSxcbiAgICAgIGxhYmVsQXBwbGllZDogXCJhcHBsaWVkXCIgaW4gcmVxdWV1ZUxhYmVsLFxuICAgIH0sXG4gICk7XG4gIHJldHVybiB7IG91dGNvbWU6IFwiYWJhbmRvbmVkXCIsIGlzc3VlTnVtYmVyLCBsYWJlbDogcmVxdWV1ZUxhYmVsIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUZDLEdBSUQsU0FFRSwwQkFBMEIsUUFHckIsOEJBQThCO0FBQ3JDLFNBQ0UsdUJBQXVCLEVBQ3ZCLHNCQUFzQixFQUN0QiwwQkFBMEIs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
// denoCacheMetadata=2507859693839217097,1682249297104956096