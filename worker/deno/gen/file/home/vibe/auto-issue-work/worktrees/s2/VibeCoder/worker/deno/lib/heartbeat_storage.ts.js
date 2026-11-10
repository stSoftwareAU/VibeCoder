/**
 * Heartbeat & marker storage — file paths, marker formatting, and the
 * record/clear/scan operations that maintain both the local heartbeat
 * file and the cross-machine GitHub marker comment (Issues #471, #1454).
 *
 * Single responsibility: persisting and publishing heartbeat state.
 * Detection and recovery logic live in stuck_detection.ts and
 * stuck_recovery.ts respectively.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { escapeRegExp } from "./regexp_escape.ts";
import { neutraliseCommentDelimiters } from "./agent_marker_neutralisation.ts";
import { PR_PENDING_MARKER } from "./deferred_pr_store.ts";
import { getFailureCategoryDisplay, getFailureDiagnosisOneliner } from "./failure_diagnosis.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { spawnGh } from "./gh_spawn.ts";
import { sweepHeartbeatComments } from "./heartbeat_sweep.ts";
import { describePreservedBranch } from "./preserved_wip_branch.ts";
import { HEARTBEAT_FILE_PREFIX, HEARTBEAT_MARKER_FILE_PREFIX } from "./worker_state_paths.ts";
/**
 * Generate the heartbeat file path for a given repo and issue.
 */ export function heartbeatFilePath(workDir, repo, issueNumber) {
  const safeRepo = repo.replace("/", "_");
  return `${workDir}/${HEARTBEAT_FILE_PREFIX}${safeRepo}_${issueNumber}`;
}
/**
 * Generate the marker state file path for a given repo and issue (Issue #1454).
 *
 * Stores the GitHub comment id and last refresh epoch so subsequent calls
 * can edit the existing comment rather than spamming new ones.
 */ export function markerStateFilePath(workDir, repo, issueNumber) {
  const safeRepo = repo.replace("/", "_");
  return `${workDir}/${HEARTBEAT_MARKER_FILE_PREFIX}${safeRepo}_${issueNumber}`;
}
/** Prefix used inside the marker HTML comment. */ export const HEARTBEAT_MARKER_PREFIX = "VIBE_CODER_HEARTBEAT";
/** Default minimum seconds between marker refreshes (5 minutes). */ export const DEFAULT_MARKER_REFRESH_SECONDS = 300;
/**
 * Grace window (seconds) during which a cleared heartbeat marker continues
 * to suppress recovery, even when it was written by a different machine
 * (Issue #1916).
 *
 * Background: Issue #1886 added an unconditional skip on any cleared
 * marker so a worker that finished cleanly was not immediately re-recovered
 * by a peer reading the same issue. That short-circuit over-reached — if
 * the issue was later re-assigned and the new worker crashed before
 * recording a heartbeat, the old cleared marker still suppressed recovery
 * forever (live evidence: VibeCoder#1891, private-repo-14#2612,
 * private-repo-18#253 stuck ~24h).
 *
 * The grace window keeps the original protection for the legitimate case
 * (the previous worker JUST finished and the recovery scan races the
 * unassign mutation) while allowing recovery for stale clears.
 *
 * One hour was chosen as the smallest value that comfortably exceeds the
 * default `assignedNoHeartbeatTimeout` (1800s) — so a freshly cleared
 * marker is always treated as recent, but a 24h-old clear is not.
 *
 * It lives here (rather than in stuck_recovery.ts, its original home) so the
 * comment sweep in heartbeat_sweep.ts shares the one definition: the sweep
 * must not delete a cleared marker that recovery would still honour
 * (Issue #3755).
 */ export const CLEARED_MARKER_GRACE_SECONDS = 3600;
/** Maximum milestone entries kept in the progress log (Issue #3753). */ export const MAX_MILESTONES = 10;
/** Maximum rendered length of a single milestone line (Issue #3753). */ export const MILESTONE_TEXT_MAX_LENGTH = 120;
/**
 * Normalise milestone text to one short line (Issue #3753).
 *
 * Newlines are collapsed so worker-authored text can never wrap into — or
 * past — the machine-readable marker line, and the result is truncated to
 * {@link MILESTONE_TEXT_MAX_LENGTH}.
 */ function normaliseMilestoneText(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MILESTONE_TEXT_MAX_LENGTH) return flat;
  return `${flat.substring(0, MILESTONE_TEXT_MAX_LENGTH - 1)}…`;
}
/** Render an epoch as a `HH:MM` UTC clock time for the progress log. */ function formatMilestoneTime(epoch) {
  if (!Number.isFinite(epoch) || epoch <= 0) return "--:--";
  return new Date(epoch * 1000).toISOString().substring(11, 16);
}
/**
 * Render the rolling progress log appended to the marker comment
 * (Issue #3753). Returns "" when there is nothing to show.
 */ export function formatMilestoneLog(milestones) {
  const recent = milestones.slice(-MAX_MILESTONES);
  if (recent.length === 0) return "";
  const lines = recent.map((m)=>`- ${formatMilestoneTime(m.epoch)} ${normaliseMilestoneText(m.text)}`);
  return `\n\n**Progress**\n${lines.join("\n")}`;
}
/** Attempts listed in the collapsed release; older ones become "+N earlier". */ export const MAX_ATTEMPTS = MAX_MILESTONES;
const ATTEMPTS_HEADING = "**Attempts on this issue:**";
/** One attempt's outcome text for the tally line. */ export function describeAttemptOutcome(outcome) {
  if (!outcome) return "released";
  switch(outcome.kind){
    case "pr":
      // Issue #2044: a PR a later step then blocked is still a delivered PR —
      // the tally says both, so it is not read as a run that delivered
      // nothing.
      return outcome.blocked ? `raised #${outcome.prNumber}, blocked (\`${getFailureCategoryDisplay(outcome.blocked.category)}\`)` : `raised #${outcome.prNumber}`;
    case "no_pr":
      return `no PR (\`${getFailureCategoryDisplay(outcome.category)}\`, phase \`${normaliseMilestoneText(outcome.phase)}\`)`;
    case "no_pr_expected":
      return `no PR expected (phase \`${normaliseMilestoneText(outcome.phase)}\`)`;
    case "superseded":
      return `superseded by #${outcome.prNumber}`;
    case "claim_stale":
      return `claim went stale (\`${outcome.reason}\`)`;
    case "summary_incomplete":
      return `raised #${outcome.prNumber}, summary incomplete`;
    case "pr_deferred":
      return `PR pending on \`${normaliseMilestoneText(outcome.branch)}\``;
  }
}
/**
 * The one line the superseded release pointer repeats (Issue #2388).
 *
 * {@link describeAttemptOutcome} is the tally's shorthand, and for the two
 * outcomes that carry a reason it throws that reason away: a deferral renders
 * as `no PR expected (phase setup)` and says nothing at all about *why*. That
 * is what left a milestone deferring on fifteen issues with no visible cause
 * — the reason was on the first release comment, a week and a dozen comments
 * up the thread. The shorthand keeps its place and the reason rides with it.
 *
 * Bounded through {@link boundOutcomeText}, like every other free-text splice
 * in this file: one line, and with `<!--` / `-->` neutralised, because the
 * pointer body opens with the machine-readable marker comment and
 * `isHeartbeatOnlyBody` matches it line by line.
 */ export function releaseReasonLine(outcome) {
  const terse = describeAttemptOutcome(outcome);
  const detail = outcome?.kind === "no_pr_expected" ? outcome.summary : outcome?.kind === "no_pr" ? outcome.message : undefined;
  const bounded = detail ? boundOutcomeText(detail, OUTCOME_DETAIL_MAX_LENGTH) : "";
  return bounded ? `${terse} — ${bounded}` : terse;
}
/**
 * Render the attempt block. Empty for a single attempt (today's text is
 * unchanged); otherwise a heading with the total and one line per listed
 * attempt, oldest first, with a "+N earlier" line when the list is capped.
 */ export function formatAttemptBlock(tally) {
  if (tally.total <= 1) return "";
  const listed = tally.attempts.slice(-MAX_ATTEMPTS);
  const earlier = tally.total - listed.length;
  const lines = [
    `${ATTEMPTS_HEADING} ${tally.total}`,
    ...earlier > 0 ? [
      `- +${earlier} earlier`
    ] : [],
    ...listed.map((a)=>`- ${formatMilestoneTime(a.epoch)} \`${normaliseMilestoneText(a.host)}\` — ${normaliseMilestoneText(a.text)}`)
  ];
  return `\n${lines.join("\n")}`;
}
/**
 * Parse the attempt block back out of a comment body — the only source of
 * the tally that survives a host change. Returns null when the body carries
 * no block. Round-trips with {@link formatAttemptBlock}: the rendered epoch
 * keeps only HH:MM, so a parsed attempt's epoch is that clock time on the
 * epoch day 0 (rendering it again yields the same HH:MM).
 */ export function parseAttemptBlock(body) {
  const heading = new RegExp(`^\\s*${escapeRegExp(ATTEMPTS_HEADING)}\\s*(\\d+)\\s*$`, "m");
  const m = heading.exec(body ?? "");
  if (!m) return null;
  const total = parseInt(m[1], 10);
  if (!Number.isFinite(total) || total < 1) return null;
  const rest = body.slice(m.index + m[0].length);
  const attempts = [];
  for (const line of rest.split("\n")){
    if (line.trim().length === 0) {
      if (attempts.length > 0) break;
      continue;
    }
    if (/^\s*-\s+\+\d+ earlier\s*$/.test(line)) continue;
    const a = /^\s*-\s+(\d{2}):(\d{2}|--)\s+`([^`]*)`\s+—\s+(.*)$/.exec(line) ?? /^\s*-\s+(--):(--)\s+`([^`]*)`\s+—\s+(.*)$/.exec(line);
    if (!a) break;
    const hh = a[1] === "--" ? NaN : parseInt(a[1], 10);
    const mm = a[2] === "--" ? NaN : parseInt(a[2], 10);
    attempts.push({
      epoch: Number.isFinite(hh) && Number.isFinite(mm) ? hh * 3600 + mm * 60 : 0,
      host: a[3],
      text: a[4].trimEnd()
    });
  }
  return {
    total,
    attempts
  };
}
/**
 * Reconstruct the single attempt a released body without a tally block
 * represents (the first release on a thread renders no block), from its
 * visible line: host, finish clock and outcome. Null when the body is not a
 * released shape.
 */ export function parseReleaseAttemptFromBody(body) {
  const line = /(✅|⚠️)\s*\*\*Vibe Coder released this claim(?: with no PR)?\*\*\s*—\s*host `([^`]*)`, finished (\d{2}):(\d{2}) UTC\.(.*)$/m.exec(body ?? "");
  if (!line) return null;
  const host = line[2];
  const epoch = parseInt(line[3], 10) * 3600 + parseInt(line[4], 10) * 60;
  const rest = line[5] ?? "";
  let text = "released";
  const raised = /Raised #(\d+)/.exec(rest);
  const outcome = /\*\*Outcome:\*\* no PR raised — `([^`]+)`/.exec(body);
  const phase = /\*\*Diagnosis:\*\* died in phase `([^`]+)`/.exec(body);
  // Issue #2044: a PR a later step blocked renders both halves, so the
  // reconstruction reads both — otherwise the tally would show the delivered
  // PR and silently drop the outstanding finding.
  const blocked = /\*\*Outcome:\*\* PR raised, then blocked in phase `[^`]+` — `([^`]+)`/.exec(body);
  if (raised) {
    text = blocked ? `raised #${raised[1]}, blocked (\`${blocked[1]}\`)` : `raised #${raised[1]}`;
  } else if (outcome) {
    text = `no PR (\`${outcome[1]}\`${phase ? `, phase \`${phase[1]}\`` : ""})`;
  } else if (/no PR expected for this phase/.test(rest)) {
    text = "no PR expected";
  }
  return {
    epoch,
    host,
    text
  };
}
/** Append this release to a tally (or start one). */ export function appendAttempt(previous, attempt) {
  const base = previous ?? {
    total: 0,
    attempts: []
  };
  // One release can be cleared twice within the same minute (heartbeat
  // stop, then claim release — Issue #4330): that is the same attempt, so
  // the newer text replaces the entry instead of counting again.
  const last = base.attempts.at(-1);
  if (isSameAttempt(last, attempt)) {
    return {
      total: base.total,
      attempts: [
        ...base.attempts.slice(0, -1),
        attempt
      ].slice(-MAX_ATTEMPTS)
    };
  }
  return {
    total: base.total + 1,
    attempts: [
      ...base.attempts,
      attempt
    ].slice(-MAX_ATTEMPTS)
  };
}
/**
 * Derive the display host from a machine id (Issue #3752).
 *
 * Machine ids are `{hostname}-{uuid}` (see lib/machine_id.ts), so strip a
 * trailing UUID to recover the hostname. Anything that does not end in a UUID
 * is shown verbatim.
 *
 * Exported for the stream lock (Issue #2334), which names the host holding a
 * milestone stream from the heartbeat marker it found beating.
 */ export function hostFromMachineId(machineId) {
  const uuid = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return machineId.replace(uuid, "");
}
/** Render an epoch as `HH:MM UTC`. */ function formatClock(epoch) {
  return `${formatMilestoneTime(epoch)} UTC`;
}
/**
 * Render how long ago `epoch` was, as a short human phrase (Issue #3752).
 *
 * A clock that runs backwards is clamped to zero so the body never shows a
 * negative duration.
 */ function formatElapsed(epoch, now) {
  const seconds = Math.max(0, now - epoch);
  if (seconds < 60) return "just now";
  return `${formatDuration(seconds)} ago`;
}
/**
 * Render a duration in seconds as the short phrase the elapsed clause uses
 * (`58 min`, `2 h`, `3 d`; under a minute → `under 1 min`). Shared with
 * {@link formatElapsed} so the two cannot drift (Issue #4326).
 */ export function formatDuration(seconds) {
  const s = Math.max(0, seconds);
  if (s < 60) return "under 1 min";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}
/**
 * Longest rendered outcome block (Issue #4326): a brief line, not a log dump.
 *
 * Raised from 600 for the preserved-branch line (Issue #770): the branch name
 * and its handover link must fit whole beside the diagnosis, because half a
 * ref or half a URL is worse than none.
 */ export const OUTCOME_BLOCK_MAX_LENGTH = 900;
/** Longest raw-message excerpt inside the outcome block. */ export const OUTCOME_DETAIL_MAX_LENGTH = 200;
/**
 * Longest preserved-branch line (Issue #770). Wider than a detail excerpt
 * because it carries a branch name and a handover link, and truncating it
 * would point a reader at half a ref.
 */ export const OUTCOME_WIP_MAX_LENGTH = 400;
/**
 * The `**Work in progress:**` line for a preserved branch (Issue #770).
 *
 * A line that does not fit drops the handover clause and keeps the branch:
 * half a URL is a broken link, and the branch is the part a reader cannot do
 * without. Only a branch name long enough to blow the bound on its own is
 * ever truncated.
 */ function renderPreservedWipClause(preserved) {
  const full = describePreservedBranch(preserved);
  const text = full.length <= OUTCOME_WIP_MAX_LENGTH ? full : describePreservedBranch({
    branch: preserved.branch
  });
  return `\n**Work in progress:** ${boundOutcomeText(text, OUTCOME_WIP_MAX_LENGTH)}`;
}
/**
 * Flatten and bound free text spliced into the release body (Issue #4326).
 * Whitespace collapses to single spaces, HTML-comment delimiters are
 * neutralised so a failure message can never open or close a comment and
 * push the marker off its line, and the result is truncated with an
 * ellipsis — the same discipline as {@link normaliseMilestoneText}.
 */ function boundOutcomeText(text, maxLength) {
  const flat = neutraliseCommentDelimiters(text).replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.substring(0, Math.max(0, maxLength - 1))}…`;
}
/**
 * Render the run outcome clause of a released body (Issue #4326, part of
 * #4291). Returns the text that follows `finished HH:MM UTC.` for a PR or
 * a deliberate no-PR, or the multi-line block for a failure. Kept bounded
 * by {@link OUTCOME_BLOCK_MAX_LENGTH}.
 *
 * The failure class and one-line diagnosis come from failure_diagnosis.ts
 * (`getFailureCategoryDisplay`, `getFailureDiagnosisOneliner`) so the
 * release comment inherits #4298's corrected diagnosis rather than
 * duplicating it.
 *
 * Outcome notes (Issue #210) follow the clause on their own line, whatever
 * the outcome kind: a run can raise a PR and still have named a follow-up
 * reference that does not exist, and a human must see that.
 */ export function renderRunOutcomeClause(outcome) {
  return `${renderOutcomeKindClause(outcome)}${renderOutcomeNotes(outcome)}`;
}
/** Longest number of notes rendered — a brief line, not a log dump. */ const MAX_OUTCOME_NOTES = 3;
/** The `**Note:**` line for a run's outcome notes, or "" when it has none. */ function renderOutcomeNotes(outcome) {
  const notes = (outcome.notes ?? []).map((note)=>boundOutcomeText(note, OUTCOME_DETAIL_MAX_LENGTH)).filter((note)=>note !== "").slice(0, MAX_OUTCOME_NOTES);
  return notes.length === 0 ? "" : `\n**Note:** ${notes.join("; ")}`;
}
/** The kind-specific clause, without notes. */ function renderOutcomeKindClause(outcome) {
  switch(outcome.kind){
    case "pr":
      {
        const url = boundOutcomeText(outcome.prUrl, OUTCOME_DETAIL_MAX_LENGTH);
        if (!outcome.blocked) return ` Raised #${outcome.prNumber} — ${url}`;
        // Issue #2044 — the work reached the PR and a later step then failed
        // the run. Name both halves: the PR, so nobody redoes delivered work,
        // and the block, so the outstanding finding is fixable on that PR.
        const display = getFailureCategoryDisplay(outcome.blocked.category);
        const phase = boundOutcomeText(outcome.blocked.phase, 60);
        const detail = boundOutcomeText(outcome.blocked.reason, OUTCOME_DETAIL_MAX_LENGTH);
        const block = ` Raised #${outcome.prNumber} — ${url}.\n` + `**Outcome:** PR raised, then blocked in phase \`${phase}\` — ` + `\`${display}\`. Fix the finding on that PR; the work is not lost.` + (detail ? `\n**Detail:** ${detail}` : "");
        return block.length <= OUTCOME_BLOCK_MAX_LENGTH ? block : `${block.substring(0, OUTCOME_BLOCK_MAX_LENGTH - 1)}…`;
      }
    case "no_pr_expected":
      {
        const summary = boundOutcomeText(outcome.summary, OUTCOME_DETAIL_MAX_LENGTH);
        return ` ${summary} (no PR expected for this phase.)`;
      }
    case "superseded":
      {
        // Issue #218 — a sibling's PR resolved the issue mid-run. Say so
        // plainly, and name the branch the preserved WIP is on so the work
        // this run did do is findable rather than silently orphaned.
        const url = boundOutcomeText(outcome.prUrl, OUTCOME_DETAIL_MAX_LENGTH);
        const verb = outcome.prState === "MERGED" ? "merged" : "closed";
        const wip = outcome.wipNote ? ` ${boundOutcomeText(outcome.wipNote, OUTCOME_DETAIL_MAX_LENGTH)}.` : "";
        return ` Superseded by ${verb} #${outcome.prNumber} — ${url}` + ` (this run raised no PR).${wip}`;
      }
    case "summary_incomplete":
      {
        // Issue #1140 — the work reached a PR and the summary did not close a
        // document rule out. Name both: the PR, so the reader can see the work
        // landed, and the rule, so the shortfall is fixable rather than
        // mysterious.
        const url = boundOutcomeText(outcome.prUrl, OUTCOME_DETAIL_MAX_LENGTH);
        const problem = boundOutcomeText(outcome.problem, OUTCOME_DETAIL_MAX_LENGTH);
        return ` Raised #${outcome.prNumber} — ${url}. The PR summary is` + ` incomplete: ${problem}`;
      }
    case "pr_deferred":
      {
        // Issue #1951 — the work is finished and pushed; GitHub's
        // content-creation throttle refused the PR for longer than the run had
        // left. Name the branch and say the PR is pending, so a reader knows
        // nothing was lost and no one needs to redo it.
        const reason = boundOutcomeText(outcome.reason, OUTCOME_DETAIL_MAX_LENGTH);
        const branch = boundOutcomeText(outcome.branch, 200);
        const base = boundOutcomeText(outcome.base, 200);
        return ` ${PR_PENDING_MARKER} PR pending — the work is on` + ` \`${branch}\` and the pull request (\`${branch}\` → \`${base}\`)` + ` is queued for the next cycle. GitHub's secondary` + ` (content-creation) rate limit refused it: ${reason}`;
      }
    case "claim_stale":
      {
        // Issue #344 — the claim was fine when it was taken and stale by the
        // time the PR would have gone up. Name the branch: it is the only place
        // the work now lives, and a reader must be able to find it.
        const detail = boundOutcomeText(outcome.detail, OUTCOME_DETAIL_MAX_LENGTH);
        const branch = outcome.branch ? ` The work is on \`${boundOutcomeText(outcome.branch, 200)}\`.` : "";
        const pr = outcome.prUrl ? ` See ${boundOutcomeText(outcome.prUrl, OUTCOME_DETAIL_MAX_LENGTH)}.` : "";
        return ` No PR raised — the claim went stale: ${detail}.${branch}${pr}`;
      }
    case "no_pr":
      {
        const display = getFailureCategoryDisplay(outcome.category);
        // A timeout kill explains itself here (Issue #768): the one-liner
        // states the extension telemetry the run carried, so an operator reads
        // the grants and the last refusal off the release comment.
        const oneliner = getFailureDiagnosisOneliner(outcome.category, "not_assessed", outcome.extensions);
        const phase = boundOutcomeText(outcome.phase, 60);
        const detail = boundOutcomeText(outcome.message, OUTCOME_DETAIL_MAX_LENGTH);
        // Where the work is (Issue #770), on its own line and BEFORE the raw
        // detail: a reader must be able to find the preserved branch even when
        // the message tail is trimmed to keep the block bounded.
        const wip = outcome.preservedWip ? renderPreservedWipClause(outcome.preservedWip) : "";
        const block = `\n**Outcome:** no PR raised — \`${display}\`.\n` + `**Diagnosis:** died in phase \`${phase}\` after ${formatDuration(outcome.elapsedSeconds)}. ${oneliner}` + wip + (detail ? `\n**Detail:** ${detail}` : "");
        return block.length <= OUTCOME_BLOCK_MAX_LENGTH ? block : `${block.substring(0, OUTCOME_BLOCK_MAX_LENGTH - 1)}…`;
      }
  }
}
/**
 * Build the full heartbeat comment body (Issues #3752, #3753).
 *
 * A heartbeat marker used to be a bare HTML comment, so GitHub rendered it as
 * a completely blank comment box. The machine-readable marker still comes
 * first and unchanged — every parser keys off that — followed by visible
 * status text and the rolling progress log.
 *
 * Timestamps come from `nowFn` rather than `Date.now()` so the body is
 * deterministic under test.
 */ export function renderHeartbeatBody(fields, nowFn = ()=>Math.floor(Date.now() / 1000)) {
  const host = fields.host ?? hostFromMachineId(fields.machineId);
  const log = formatMilestoneLog(fields.milestones ?? []);
  if (fields.released) {
    // The machine-readable marker line stays first and unchanged: every
    // parser keys off it, and `parseHeartbeatMarker` needs epoch 0 plus
    // the `cleared:` comment in the same body.
    const marker = `${formatHeartbeatMarker(fields.machineId, 0)} ` + `<!-- cleared: claim released by machine ${fields.machineId} -->`;
    const finished = `host \`${host}\`, finished ${formatClock(nowFn())}.`;
    const outcome = fields.outcome;
    // Repeated attempts collapse into this one comment (Issue #4327): the
    // tally follows the outcome and precedes the progress log.
    const tally = fields.attempts ? formatAttemptBlock(fields.attempts) : "";
    if (!outcome) {
      // No outcome (skip after claim, legacy callers): today's text, byte
      // for byte.
      return `${marker}\n\n✅ **Vibe Coder released this claim** — ` + `${finished}${tally}${log}`;
    }
    // The run outcome (Issue #4326, part of #4291): a PR link, a deliberate
    // no-PR, or a failure class + brief diagnosis.
    if (outcome.kind === "no_pr") {
      return `${marker}\n\n⚠️ **Vibe Coder released this claim with no PR** — ` + `${finished}${renderRunOutcomeClause(outcome)}${tally}${log}`;
    }
    return `${marker}\n\n✅ **Vibe Coder released this claim** — ` + `${finished}${renderRunOutcomeClause(outcome)}${tally}${log}`;
  }
  const who = fields.workerId ? `host \`${host}\`, worker \`${fields.workerId}\`` : `host \`${host}\``;
  const elapsed = formatElapsed(fields.epoch, nowFn());
  const beat = fields.startedEpoch ? `Started ${formatClock(fields.startedEpoch)}, ` + `last beat ${formatClock(fields.epoch)} (${elapsed})` : `Last beat ${formatClock(fields.epoch)} (${elapsed})`;
  return `${formatHeartbeatMarker(fields.machineId, fields.epoch)}\n\n` + `🤖 **Vibe Coder working** on ${who} — ${beat}.${log}`;
}
/**
 * Format a heartbeat marker body.
 *
 * Wraps the identifier and epoch inside an HTML comment so it is invisible
 * on the rendered GitHub issue page but still searchable in the raw comment
 * body.
 */ export function formatHeartbeatMarker(machineId, epoch) {
  return `<!-- ${HEARTBEAT_MARKER_PREFIX}:${machineId}:${epoch} -->`;
}
/**
 * Parse a single heartbeat marker from a comment body.
 *
 * Returns the most recent marker in the body (comments may contain multiple
 * markers if an older refresh was appended rather than edited).
 *
 * The `cleared` flag is true only when both signals are present in the same
 * comment body (Issue #1886): the chosen marker has `epoch === 0` *and* the
 * body also contains a `<!-- cleared: ... -->` HTML comment. This is the
 * exact shape written by `clearHeartbeat` when a worker releases a claim
 * after finishing successfully — the recovery scan must treat it as the
 * success path, not as "no live marker".
 */ export function parseHeartbeatMarker(body) {
  const regex = new RegExp(`${HEARTBEAT_MARKER_PREFIX}:([^:\\s]+):(\\d+)`, "g");
  let match;
  let best = null;
  while((match = regex.exec(body)) !== null){
    const epoch = parseInt(match[2], 10);
    if (isNaN(epoch)) continue;
    if (best === null || epoch > best.epoch) {
      best = {
        machineId: match[1],
        epoch
      };
    }
  }
  if (best === null) return null;
  // The cleared signal requires both the zero-epoch marker AND the
  // explicit `cleared:` HTML comment in the same body. We use a regex
  // (not includes) so trailing-whitespace variants stay matched.
  const clearedSuffix = /<!--\s*cleared:[^>]*-->/i;
  const cleared = best.epoch === 0 && clearedSuffix.test(body);
  return {
    machineId: best.machineId,
    epoch: best.epoch,
    cleared
  };
}
/**
 * Run a gh command and return stdout. Returns empty string on failure.
 *
 * Exported for use by detection and recovery modules so they share a
 * single implementation.
 */ export async function runGh(args) {
  try {
    const result = await spawnGh(args, {
      stderr: "null"
    });
    if (!result.success) return "";
    return result.stdout.trim();
  } catch (err) {
    recordFaultEvent("catch_block_warning", `gh command failed: ${err}`);
    return "";
  }
}
/**
 * Read the persisted marker state for a repo/issue. Returns null when no
 * state has been written yet or the file cannot be parsed.
 */ export async function readMarkerState(workDir, repo, issueNumber) {
  try {
    const raw = await Deno.readTextFile(markerStateFilePath(workDir, repo, issueNumber));
    const parsed = JSON.parse(raw);
    if (typeof parsed.commentId !== "number" || typeof parsed.lastRefresh !== "number") {
      return null;
    }
    const state = {
      commentId: parsed.commentId,
      lastRefresh: parsed.lastRefresh
    };
    if (typeof parsed.claimPrefix === "string" && parsed.claimPrefix.length > 0) {
      state.claimPrefix = parsed.claimPrefix;
    }
    if (parsed.released === true) state.released = true;
    const attempts = parsed.attempts;
    if (attempts && typeof attempts.total === "number" && Array.isArray(attempts.attempts)) {
      state.attempts = {
        total: attempts.total,
        attempts: attempts.attempts.filter((a)=>a && typeof a.host === "string" && typeof a.text === "string").map((a)=>({
            epoch: typeof a.epoch === "number" ? a.epoch : 0,
            host: a.host,
            text: a.text
          }))
      };
    }
    // Absent on state files written before Issue #3752 — the visible body
    // simply omits the clauses these feed.
    if (typeof parsed.startedEpoch === "number" && Number.isFinite(parsed.startedEpoch) && parsed.startedEpoch > 0) {
      state.startedEpoch = parsed.startedEpoch;
    }
    if (typeof parsed.workerId === "string" && parsed.workerId.length > 0) {
      state.workerId = parsed.workerId;
    }
    const milestones = coerceMilestones(parsed.milestones);
    if (milestones.length > 0) state.milestones = milestones;
    return state;
  } catch  {
    return null;
  }
}
/** Coerce an untrusted JSON value into a milestone list (Issue #3753). */ function coerceMilestones(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const item of value){
    if (item === null || typeof item !== "object") continue;
    const { epoch, text } = item;
    if (typeof epoch !== "number" || !Number.isFinite(epoch)) continue;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    entries.push({
      epoch,
      text: normaliseMilestoneText(text)
    });
  }
  return entries.slice(-MAX_MILESTONES);
}
/**
 * Read the milestone log without requiring a published comment
 * (Issue #3753).
 *
 * `readMarkerState` deliberately rejects a state file with no comment id;
 * milestones may legitimately be recorded before the first publish, so this
 * lenient reader is used for the progress log alone.
 */ async function readMilestones(workDir, repo, issueNumber) {
  try {
    const raw = await Deno.readTextFile(markerStateFilePath(workDir, repo, issueNumber));
    return coerceMilestones(JSON.parse(raw).milestones);
  } catch  {
    return [];
  }
}
/**
 * Seed the marker state file from outside heartbeat publication (Issue #1628).
 *
 * Used by the claim flow to record a comment id that already contains both
 * a CLAIM_LOCK marker and an initial heartbeat marker, so the heartbeat
 * updater PATCHes that same comment instead of posting a new one.
 *
 * Errors are non-fatal — failure to persist the seed simply means the next
 * heartbeat will fall back to posting a fresh marker comment.
 */ export async function seedMarkerState(workDir, repo, issueNumber, state) {
  // Seeding happens as a claim is taken (Issue #214), so any guard left by a
  // previous claim on this issue is lifted here too.
  clearClaimReleaseGuard(workDir, repo, issueNumber);
  await writeMarkerState(workDir, repo, issueNumber, state);
}
/**
 * Persist marker state for a repo/issue. Errors are non-fatal — marker
 * publication degrades to "post a new comment next time" rather than
 * breaking the heartbeat.
 */ async function writeMarkerState(workDir, repo, issueNumber, state) {
  try {
    await Deno.mkdir(workDir, {
      recursive: true
    });
  } catch  {
  // Directory already exists — non-fatal
  }
  // Milestones outlive every other field of the state (Issue #3753): a
  // caller that does not carry them forward (seeding, adoption, release)
  // must not silently drop the progress log.
  const milestones = state.milestones ?? await readMilestones(workDir, repo, issueNumber);
  try {
    await Deno.writeTextFile(markerStateFilePath(workDir, repo, issueNumber), JSON.stringify({
      ...state,
      ...milestones.length > 0 ? {
        milestones
      } : {}
    }));
  } catch  {
  // Non-fatal — next heartbeat will simply re-publish the marker.
  }
}
/**
 * Post a new heartbeat marker comment and return its id, or null on failure.
 *
 * `gh issue comment` does not expose the created comment id, so we use the
 * REST endpoint instead and parse the returned JSON.
 */ async function postMarkerComment(repo, issueNumber, body, ghFn) {
  const json = await ghFn([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "-X",
    "POST",
    "-f",
    `body=${body}`,
    "--jq",
    ".id"
  ]);
  if (!json) return null;
  const id = parseInt(json.trim(), 10);
  return isNaN(id) ? null : id;
}
/**
 * Edit an existing heartbeat marker comment in place. Returns true on
 * success, false when the edit fails (e.g. comment was deleted).
 */ async function patchMarkerComment(repo, commentId, body, ghFn) {
  const json = await ghFn([
    "api",
    `repos/${repo}/issues/comments/${commentId}`,
    "-X",
    "PATCH",
    "-f",
    `body=${body}`,
    "--jq",
    ".id"
  ]);
  if (!json) return false;
  const id = parseInt(json.trim(), 10);
  return !isNaN(id);
}
/**
 * Mark a heartbeat marker comment as stale by replacing its body. Falls
 * back to a no-op on failure — the next worker scan will treat a missing
 * comment the same as an invalidated one.
 */ async function invalidateMarkerComment(repo, commentId, machineId, ghFn, milestones = [], host, nowFn = ()=>Math.floor(Date.now() / 1000), outcome, attempts) {
  // The progress log is kept on release (Issue #3753) so the finished
  // timeline stays readable; the cleared signal is unaffected. The run
  // outcome (Issue #4325) and the attempt tally (Issue #4327) reach the
  // render here.
  const body = renderReleasedBody({
    machineId,
    epoch: 0,
    released: true,
    milestones,
    ...host ? {
      host
    } : {},
    ...outcome ? {
      outcome
    } : {},
    ...attempts ? {
      attempts
    } : {}
  }, nowFn);
  return await patchMarkerComment(repo, commentId, body, ghFn);
}
/**
 * List every fleet-authored heartbeat marker comment on an issue/PR, oldest
 * first (Issue #4327). Shares the author filter and parse rules of
 * {@link findExistingMarkerComment}. Any failure yields null so callers
 * degrade to single-comment behaviour.
 */ export async function listFleetMarkerComments(repo, issueNumber, ghFn, allowedAuthors) {
  let json;
  try {
    json = await ghFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      "[.[] | {id: .id, body: .body, author: .user.login}]"
    ]);
  } catch (err) {
    recordFaultEvent("catch_block_warning", `listFleetMarkerComments failed for ${repo}#${issueNumber}: ${err}`);
    return null;
  }
  if (!json) return null;
  let comments;
  try {
    comments = JSON.parse(json);
  } catch  {
    return null;
  }
  if (!Array.isArray(comments)) return null;
  const filterByAuthor = allowedAuthors !== undefined && allowedAuthors.length > 0;
  const found = [];
  for (const comment of comments){
    if (!comment || typeof comment.body !== "string") continue;
    if (typeof comment.id !== "number" || !Number.isFinite(comment.id)) {
      continue;
    }
    if (filterByAuthor && !isFleetAuthor(comment.author, allowedAuthors)) {
      continue;
    }
    const marker = parseHeartbeatMarker(comment.body);
    if (marker === null) continue;
    found.push({
      commentId: comment.id,
      machineId: marker.machineId,
      epoch: marker.epoch,
      cleared: marker.cleared,
      body: comment.body
    });
  }
  return found.sort((a, b)=>a.commentId - b.commentId);
}
/**
 * The visible line left on a superseded release comment (Issue #4327): the
 * heartbeat layer's own text, so `isHeartbeatOnlyBody` still holds and the
 * existing sweep removes it once past the cleared-marker grace window. It
 * carries the cleared marker so no scanner sees a live claim on it.
 *
 * It repeats **this** release's reason (Issue #2388). Pointing "above" was
 * accurate and useless: the canonical summary can be a week and a dozen
 * comments up the thread, so the newest comment — the one a reader lands on —
 * said nothing about why the claim had just been dropped.
 *
 * @param machineId - The host whose comment is being superseded
 * @param reason - This release's one-line outcome, when there is one
 */ export function renderSupersededReleaseBody(machineId, reason) {
  const trimmed = reason?.trim();
  const why = trimmed ? ` — ${trimmed}` : "";
  return `${formatHeartbeatMarker(machineId, 0)} ` + `<!-- cleared: claim released by machine ${machineId} -->\n\n` + `✅ **Vibe Coder released this claim**${why} — full history collapsed ` + `into the release summary above.`;
}
/**
 * Render seam for the released body (Issue #4325): tests replace it to
 * assert the outcome that arrived at the render call, independent of the
 * rendered text. Production is {@link renderHeartbeatBody}.
 */ export let renderReleasedBody = renderHeartbeatBody;
/** Swap the release-body renderer (tests only). Returns a restore function. */ export function _setRenderReleasedBody(fn) {
  const previous = renderReleasedBody;
  renderReleasedBody = fn;
  return ()=>{
    renderReleasedBody = previous;
  };
}
/**
 * Find the heartbeat marker comment already published on an issue/PR
 * (Issue #3751).
 *
 * Returns the newest fleet-authored comment carrying a
 * {@link HEARTBEAT_MARKER_PREFIX} marker, or null when there is none. Comment
 * ids increase monotonically, so "newest" is simply the highest id.
 *
 * The `allowedAuthors` filter mirrors {@link scanHeartbeatMarkers} (Issue
 * #3164): when supplied and non-empty, a comment from outside the fleet is
 * never returned, so a forged marker can never be adopted. Any failure —
 * API error, unparseable JSON — yields null so the caller falls back to
 * posting a fresh comment.
 */ export async function findExistingMarkerComment(repo, issueNumber, ghFn, allowedAuthors) {
  const json = await ghFn([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "--jq",
    "[.[] | {id: .id, body: .body, author: .user.login}]"
  ]);
  if (!json) return null;
  let comments;
  try {
    comments = JSON.parse(json);
  } catch (err) {
    recordFaultEvent("catch_block_warning", `findExistingMarkerComment parse failed for ${repo}#${issueNumber}: ${err}`);
    return null;
  }
  if (!Array.isArray(comments)) return null;
  const filterByAuthor = Array.isArray(allowedAuthors) && allowedAuthors.length > 0;
  let newest = null;
  for (const comment of comments){
    if (!comment || typeof comment.body !== "string") continue;
    if (typeof comment.id !== "number" || !Number.isFinite(comment.id)) {
      continue;
    }
    if (filterByAuthor && !isFleetAuthor(comment.author, allowedAuthors)) {
      continue;
    }
    const marker = parseHeartbeatMarker(comment.body);
    if (marker === null) continue;
    if (newest !== null && comment.id <= newest.commentId) continue;
    newest = {
      commentId: comment.id,
      machineId: marker.machineId,
      epoch: marker.epoch,
      cleared: marker.cleared,
      body: comment.body
    };
  }
  return newest;
}
/**
 * Extract the CLAIM_LOCK prefix from an adopted marker comment body.
 *
 * The claim flow co-publishes `<!-- CLAIM_LOCK:worker --> Claimed by ...`
 * with the heartbeat marker in one comment (Issue #1628). When this host
 * re-adopts its own live claim comment, the PATCH must keep that prefix or
 * claim-race detection loses its lock marker. Returns "" when the body has
 * no CLAIM_LOCK prefix.
 */ function extractClaimPrefix(body) {
  if (!body.includes("<!-- CLAIM_LOCK:")) return "";
  const markerIndex = body.indexOf(`<!-- ${HEARTBEAT_MARKER_PREFIX}:`);
  const prefix = markerIndex >= 0 ? body.substring(0, markerIndex) : body;
  return prefix.replace(/\s+$/, "");
}
/**
 * Adopt the heartbeat marker comment already on the issue/PR, if any
 * (Issue #3751).
 *
 * Returns the adopted comment id (and any CLAIM_LOCK prefix to keep on
 * later refreshes) after a successful PATCH, or null when there is nothing
 * to adopt, the marker belongs to another live machine (contention — the
 * caller posts its own marker, unchanged behaviour), or the PATCH failed.
 * Adoption is best-effort: every failure degrades to the POST path rather
 * than failing the heartbeat.
 */ async function adoptExistingMarker(repo, issueNumber, options, ghFn, heartbeatBody) {
  let found = null;
  try {
    found = await findExistingMarkerComment(repo, issueNumber, ghFn, options.allowedAuthors);
  } catch (err) {
    recordFaultEvent("catch_block_warning", `marker adoption lookup failed for ${repo}#${issueNumber}: ${err}`);
    return null;
  }
  if (found === null) return null;
  const ownedByOtherLiveMachine = found.machineId !== options.machineId && !found.cleared && found.epoch > 0;
  if (ownedByOtherLiveMachine) {
    console.warn(`[heartbeat] not adopting marker comment ${found.commentId} on ` + `${repo}#${issueNumber}: held by machine ${found.machineId} ` + `(epoch ${found.epoch}) — publishing a separate marker`);
    return null;
  }
  // Only this machine's own still-live claim keeps its CLAIM_LOCK prefix; a
  // cleared comment is being re-used for a *new* claim, so the previous
  // claim's lock marker must not be resurrected.
  const claimPrefix = !found.cleared && found.machineId === options.machineId ? extractClaimPrefix(found.body) : "";
  const body = claimPrefix ? `${claimPrefix}\n${heartbeatBody}` : heartbeatBody;
  const patched = await patchMarkerComment(repo, found.commentId, body, ghFn);
  if (!patched) return null;
  // Self-heal the thread while it is being worked (Issue #3755): every other
  // marker-only comment left behind by a previous run is swept away, keeping
  // only the comment we just adopted. Best-effort — a sweep failure must
  // never break the heartbeat.
  try {
    const sweep = await sweepHeartbeatComments(repo, issueNumber, ghFn, {
      keepCommentId: found.commentId,
      ...options.allowedAuthors ? {
        allowedAuthors: options.allowedAuthors
      } : {},
      machineId: options.machineId
    });
    if (sweep.deleted.length > 0 || sweep.orphanedLiveMarkers > 0) {
      console.log(`[heartbeat] swept ${sweep.deleted.length} stale marker comment(s) ` + `on ${repo}#${issueNumber} ` + `(${sweep.orphanedLiveMarkers} orphaned live marker(s))`);
    }
  } catch (err) {
    recordFaultEvent("catch_block_warning", `heartbeat sweep failed for ${repo}#${issueNumber}: ${err}`);
  }
  return {
    commentId: found.commentId,
    claimPrefix
  };
}
/**
 * Publish or refresh the GitHub heartbeat marker comment for an issue
 * (Issue #1454).
 *
 * First call publishes a new comment and persists the comment id. Subsequent
 * calls refresh no more often than `minRefreshSeconds` by editing the
 * existing comment in place via `gh api PATCH`, so comment history stays
 * tidy and other machines see the marker's epoch move forward.
 *
 * Returns `Result<void>` — `{ ok: false }` when the GitHub API call fails
 * (no comment id returned). Callers may treat this as fatal (initial
 * publish — Issue #1888) or non-fatal (periodic refresh, where the next
 * iteration retries).
 */ export async function publishOrRefreshMarker(workDir, repo, issueNumber, options, nowFn = ()=>Math.floor(Date.now() / 1000)) {
  const ghFn = options.ghFn ?? runGh;
  const minRefresh = options.minRefreshSeconds ?? DEFAULT_MARKER_REFRESH_SECONDS;
  const now = nowFn();
  // Milestones are read leniently (Issue #3753) so a milestone recorded
  // before the first publish is rendered on that first comment.
  const milestones = await readMilestones(workDir, repo, issueNumber);
  const existing = await readMarkerState(workDir, repo, issueNumber);
  // Issue #3752: the start time and worker id are pinned when the claim
  // begins and reused on every refresh, so the body keeps naming the original
  // claim rather than the current beat. A released marker is revived for a
  // *new* claim (Issue #3751), so its start time restarts with it. A state
  // file written before #3752 has no start time — that clause simply drops.
  const isNewClaim = existing === null || existing.released === true;
  const startedEpoch = isNewClaim ? now : existing.startedEpoch;
  const workerId = options.workerId ?? existing?.workerId;
  const heartbeatBody = renderHeartbeatBody({
    machineId: options.machineId,
    epoch: now,
    milestones,
    ...options.host ? {
      host: options.host
    } : {},
    ...workerId ? {
      workerId
    } : {},
    ...startedEpoch ? {
      startedEpoch
    } : {}
  }, ()=>now);
  const identity = {
    ...startedEpoch ? {
      startedEpoch
    } : {},
    ...workerId ? {
      workerId
    } : {}
  };
  if (existing === null) {
    // No local state — adopt the marker comment already on the issue/PR
    // rather than posting a duplicate (Issue #3751).
    const adopted = await adoptExistingMarker(repo, issueNumber, options, ghFn, heartbeatBody);
    if (adopted !== null) {
      await writeMarkerState(workDir, repo, issueNumber, {
        commentId: adopted.commentId,
        lastRefresh: now,
        ...adopted.claimPrefix ? {
          claimPrefix: adopted.claimPrefix
        } : {},
        ...identity
      });
      return {
        ok: true,
        value: undefined
      };
    }
    const commentId = await postMarkerComment(repo, issueNumber, heartbeatBody, ghFn);
    if (commentId === null) {
      return {
        ok: false,
        error: new Error(`Failed to publish heartbeat marker comment for ${repo}#${issueNumber}`)
      };
    }
    await writeMarkerState(workDir, repo, issueNumber, {
      commentId,
      lastRefresh: now,
      ...identity
    });
    return {
      ok: true,
      value: undefined
    };
  }
  // A released marker (kept by clearHeartbeat, Issue #3751) is revived on
  // the next claim regardless of the refresh window — its body currently
  // reads epoch 0, so waiting would leave the claim invisible.
  if (!existing.released && now - existing.lastRefresh < minRefresh) {
    // Within the refresh window — leave the existing marker alone.
    return {
      ok: true,
      value: undefined
    };
  }
  // Preserve the claim prefix (CLAIM_LOCK marker) when refreshing so race
  // detection keeps working on the combined claim+heartbeat comment
  // (Issue #1628). A released comment starts a *new* claim, so the previous
  // claim's lock marker is dropped.
  const claimPrefix = existing.released ? undefined : existing.claimPrefix;
  const refreshedBody = claimPrefix ? `${claimPrefix}\n${heartbeatBody}` : heartbeatBody;
  const edited = await patchMarkerComment(repo, existing.commentId, refreshedBody, ghFn);
  if (edited) {
    await writeMarkerState(workDir, repo, issueNumber, {
      commentId: existing.commentId,
      lastRefresh: now,
      ...claimPrefix ? {
        claimPrefix
      } : {},
      ...identity
    });
    return {
      ok: true,
      value: undefined
    };
  }
  // PATCH failed — post a fresh comment so the claim stays visible.
  // The fresh comment cannot recreate the CLAIM_LOCK marker (the claimer
  // owns that), so just publish the heartbeat marker on its own.
  const commentId = await postMarkerComment(repo, issueNumber, heartbeatBody, ghFn);
  if (commentId === null) {
    return {
      ok: false,
      error: new Error(`Failed to refresh heartbeat marker for ${repo}#${issueNumber} (PATCH and POST both failed)`)
    };
  }
  await writeMarkerState(workDir, repo, issueNumber, {
    commentId,
    lastRefresh: now,
    ...identity
  });
  return {
    ok: true,
    value: undefined
  };
}
/**
 * Append a milestone to the heartbeat progress log and publish it at once
 * (Issue #3753).
 *
 * The entry is persisted in the marker state file (so it survives periodic
 * beats, a state-file reload, and comment adoption within the run) and then
 * pushed to GitHub through {@link publishOrRefreshMarker} with
 * `minRefreshSeconds: 0`, bypassing the ordinary refresh gate so progress is
 * visible immediately rather than up to five minutes later. Periodic beats
 * keep honouring the gate.
 *
 * Every failure is non-fatal: the result is always `{ ok: true }` so a
 * milestone can never abort the work it is describing. A failed PATCH simply
 * leaves the entry persisted for the next successful refresh.
 */ export async function recordMilestone(workDir, repo, issueNumber, text, markerOptions, nowFn = ()=>Math.floor(Date.now() / 1000)) {
  try {
    const entryText = normaliseMilestoneText(text);
    if (entryText.length === 0) return {
      ok: true,
      value: undefined
    };
    const now = nowFn();
    const milestones = [
      ...await readMilestones(workDir, repo, issueNumber),
      {
        epoch: now,
        text: entryText
      }
    ].slice(-MAX_MILESTONES);
    // Merge into whatever the state file already holds — the comment id and
    // refresh epoch belong to the heartbeat path, not to this one.
    const existing = await readMarkerState(workDir, repo, issueNumber);
    if (existing !== null) {
      await writeMarkerState(workDir, repo, issueNumber, {
        ...existing,
        milestones
      });
    } else {
      await writeMilestonesOnly(workDir, repo, issueNumber, milestones);
    }
    if (markerOptions && markerOptions.machineId.length > 0) {
      await publishOrRefreshMarker(workDir, repo, issueNumber, {
        ...markerOptions,
        minRefreshSeconds: 0
      }, ()=>now);
    }
  } catch (err) {
    recordFaultEvent("catch_block_warning", `recordMilestone failed for ${repo}#${issueNumber}: ${err}`);
  }
  return {
    ok: true,
    value: undefined
  };
}
/**
 * Persist milestones when no marker comment exists yet (Issue #3753).
 *
 * Writing only the `milestones` key keeps the file invalid for
 * {@link readMarkerState}, so the next publish still takes the adopt-or-post
 * path — it just renders the stashed log on the comment it creates.
 */ async function writeMilestonesOnly(workDir, repo, issueNumber, milestones) {
  try {
    await Deno.mkdir(workDir, {
      recursive: true
    });
  } catch  {
  // Directory already exists — non-fatal
  }
  let existing = {};
  try {
    existing = JSON.parse(await Deno.readTextFile(markerStateFilePath(workDir, repo, issueNumber)));
  } catch  {
  // No readable state yet — start from an empty object.
  }
  try {
    await Deno.writeTextFile(markerStateFilePath(workDir, repo, issueNumber), JSON.stringify({
      ...existing,
      milestones
    }));
  } catch  {
  // Non-fatal — the milestone is simply not persisted.
  }
}
/**
 * Record (write/update) a heartbeat timestamp for an issue.
 *
 * When `markerOptions` is provided, also publishes (or refreshes) a
 * GitHub-visible marker comment so other machines running the same
 * `githubUser` can see this claim is alive (Issue #1454).
 *
 * Marker publish failures are propagated as `{ ok: false, error }` so the
 * caller can decide whether to treat them as fatal (Issue #1888 — initial
 * heartbeat must succeed before a claim is considered live) or non-fatal
 * (periodic refresh — counted via the consecutive-failure counter and
 * retried on the next interval).
 *
 * Issue #214: a beat after the claim was released is refused, loudly. A
 * heartbeat that outlives its release is what leaves an issue "unassigned
 * with a live heartbeat" — the state that made every host read VibeCoder#185
 * as free while a sibling was still working it. The guard is lifted by the
 * next claim on this work directory (see {@link clearClaimReleaseGuard}).
 */ export async function recordHeartbeat(workDir, repo, issueNumber, nowFn = ()=>Math.floor(Date.now() / 1000), markerOptions) {
  if (isClaimReleased(workDir, repo, issueNumber)) {
    const message = `Refused to record a heartbeat for ${repo}#${issueNumber}: ` + `the claim was already released (Issue #214)`;
    console.warn(`[heartbeat] heartbeat_after_release ${message}`);
    recordFaultEvent("catch_block_warning", message);
    return {
      ok: false,
      error: new Error(message)
    };
  }
  const path = heartbeatFilePath(workDir, repo, issueNumber);
  try {
    await Deno.writeTextFile(path, String(nowFn()));
  } catch (err) {
    return {
      ok: false,
      error: new Error(`Failed to record heartbeat: ${err}`)
    };
  }
  if (markerOptions && markerOptions.machineId.length > 0) {
    try {
      const markerResult = await publishOrRefreshMarker(workDir, repo, issueNumber, markerOptions, nowFn);
      if (!markerResult.ok) {
        recordFaultEvent("catch_block_warning", `marker publish/refresh failed for ${repo}#${issueNumber}: ${markerResult.error.message}`);
        return markerResult;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordFaultEvent("catch_block_warning", `marker publish/refresh threw for ${repo}#${issueNumber}: ${msg}`);
      return {
        ok: false,
        error: new Error(`Marker publish/refresh threw: ${msg}`)
      };
    }
  }
  return {
    ok: true,
    value: undefined
  };
}
/**
 * Clear (remove) the heartbeat file after successful completion.
 *
 * When `markerOptions` is provided, also invalidates the published GitHub
 * marker comment (Issue #1454) so a stale marker cannot later block
 * recovery of the issue if it is reassigned to a different worker.
 */ /**
 * Run outcomes handed to the next {@link clearHeartbeat} for an issue
 * (Issue #4330). `stopHeartbeat(handle, outcome)` cannot change every
 * `clearFn` wiring's signature, so it parks the outcome here, keyed by
 * repo#issue, and the clear that follows consumes it. Taken exactly once.
 */ const pendingReleaseOutcomes = new Map();
function pendingKey(repo, issueNumber) {
  return `${repo}#${issueNumber}`;
}
/**
 * Claims released in this process, keyed by work directory and issue
 * (Issue #214).
 *
 * The release path is ordered stop heartbeat → post outcome → unassign, so
 * an issue is never unassigned while its heartbeat is still beating. This
 * set closes the other direction: once a claim is released, nothing may
 * write a heartbeat for it again — not a straggling interval callback, not a
 * keep-alive from a processor that has already handed the issue back. The
 * key includes the work directory because that is what identifies the claim
 * a heartbeat belongs to; a different slot's directory is a different claim.
 */ const releasedClaims = new Set();
function releaseKey(workDir, repo, issueNumber) {
  return `${workDir} ${repo}#${issueNumber}`;
}
/** Record that this claim has been released — no further beats allowed. */ export function markClaimReleased(workDir, repo, issueNumber) {
  releasedClaims.add(releaseKey(workDir, repo, issueNumber));
}
/**
 * Lift the guard because a new claim on this issue has begun (Issue #214).
 *
 * Called by `startHeartbeat` and by the claim path's marker seeding, so a
 * legitimate re-claim beats normally while a released claim stays silent.
 */ export function clearClaimReleaseGuard(workDir, repo, issueNumber) {
  releasedClaims.delete(releaseKey(workDir, repo, issueNumber));
}
/** Whether this claim has been released and must not beat again. */ export function isClaimReleased(workDir, repo, issueNumber) {
  return releasedClaims.has(releaseKey(workDir, repo, issueNumber));
}
/** Park an outcome for the next clear of this issue (Issue #4330). */ export function setPendingReleaseOutcome(repo, issueNumber, outcome) {
  pendingReleaseOutcomes.set(pendingKey(repo, issueNumber), outcome);
}
/** Take (and forget) the parked outcome for this issue, if any. */ export function takePendingReleaseOutcome(repo, issueNumber) {
  const key = pendingKey(repo, issueNumber);
  const outcome = pendingReleaseOutcomes.get(key);
  pendingReleaseOutcomes.delete(key);
  return outcome;
}
/** Same attempt seen twice (host and clock minute): the second clear of one release. */ function isSameAttempt(a, b) {
  return a !== undefined && a.host === b.host && formatMilestoneTime(a.epoch) === formatMilestoneTime(b.epoch);
}
export async function clearHeartbeat(workDir, repo, issueNumber, markerOptions, nowFn = ()=>Math.floor(Date.now() / 1000), outcome) {
  // The claim is released from here on (Issue #214): any later beat for it
  // is a leak and is refused by `recordHeartbeat`.
  markClaimReleased(workDir, repo, issueNumber);
  const path = heartbeatFilePath(workDir, repo, issueNumber);
  try {
    await Deno.remove(path);
  } catch  {
  // File doesn't exist or removal failed — non-fatal
  }
  // An outcome parked by stopHeartbeat (Issue #4330) reaches this clear.
  outcome ??= takePendingReleaseOutcome(repo, issueNumber);
  if (markerOptions && markerOptions.machineId.length > 0) {
    const ghFn = markerOptions.ghFn ?? runGh;
    const existing = await readMarkerState(workDir, repo, issueNumber);
    const now = nowFn();
    // A clear with nothing new to say on an already-released claim (crash
    // cleanup, the stuck-issue detector, a second stop of one heartbeat)
    // must not overwrite the outcome that is already there (Issue #4330).
    if (existing?.released && !outcome) {
      return {
        ok: true,
        value: undefined
      };
    }
    const host = markerOptions.host ?? hostFromMachineId(markerOptions.machineId);
    const thisAttempt = {
      epoch: now,
      host,
      text: describeAttemptOutcome(outcome)
    };
    // Collapse (Issue #4327): every claim posts its own CLAIM_LOCK comment
    // and seeds the marker state to it, so — before this — each release
    // PATCHed a fresh comment and #4174 collected four. The release now
    // lands on ONE canonical comment: the oldest fleet-authored release
    // (cleared marker) already on the thread. This host's own comment, when
    // it is not the canonical, is reduced to a pointer that the existing
    // sweep removes. Local state absent (cold host) → the canonical is
    // adopted the same way. All best-effort: a listing failure degrades to
    // today's single-comment behaviour, never throws.
    let canonical = null;
    let listed = null;
    try {
      listed = await listFleetMarkerComments(repo, issueNumber, ghFn, markerOptions.allowedAuthors);
    } catch  {
      listed = null;
    }
    if (listed !== null) {
      canonical = listed.find((c)=>c.cleared && c.commentId !== existing?.commentId) ?? null;
      if (canonical === null && existing === null) {
        // Nothing released yet on the thread and no local state: adopt the
        // newest fleet marker (the claim comment this host cannot see
        // locally) so the release text lands somewhere.
        canonical = listed.length > 0 ? listed[listed.length - 1] : null;
      }
    }
    // The tally: this host's state (same-host revive) or the canonical body
    // (the only source that survives a host change), plus this attempt.
    const canonicalTally = canonical ? parseAttemptBlock(canonical.body) : null;
    const ownBody = existing && listed ? listed.find((c)=>c.commentId === existing.commentId)?.body : undefined;
    const canonicalSingle = canonical && canonicalTally === null ? (()=>{
      const first = parseReleaseAttemptFromBody(canonical.body);
      return {
        total: 1,
        attempts: [
          first ?? {
            epoch: 0,
            host: hostFromMachineId(canonical.machineId),
            text: "released"
          }
        ]
      };
    })() : null;
    const previous = canonicalTally ?? canonicalSingle ?? (ownBody ? parseAttemptBlock(ownBody) : null) ?? existing?.attempts ?? null;
    // The second clear of one release (heartbeat stop, then the claim
    // release) says the same thing: skip the write.
    const last = existing?.attempts?.attempts.at(-1);
    if (existing?.released && isSameAttempt(last, thisAttempt) && last.text === thisAttempt.text) {
      return {
        ok: true,
        value: undefined
      };
    }
    const tally = appendAttempt(previous, thisAttempt);
    const target = canonical?.commentId ?? existing?.commentId ?? null;
    if (target !== null) {
      try {
        await invalidateMarkerComment(repo, target, markerOptions.machineId, ghFn, existing?.milestones ?? [], markerOptions.host, nowFn, outcome, tally);
      } catch (err) {
        recordFaultEvent("catch_block_warning", `marker invalidate failed for ${repo}#${issueNumber}: ${err}`);
      }
      // This host's own comment, superseded by the canonical: a pointer
      // with the cleared marker (never deleted here — the sweep owns that).
      if (existing !== null && canonical !== null && canonical.commentId !== existing.commentId) {
        try {
          await patchMarkerComment(repo, existing.commentId, renderSupersededReleaseBody(markerOptions.machineId, releaseReasonLine(outcome)), ghFn);
        } catch (err) {
          recordFaultEvent("catch_block_warning", `superseded marker patch failed for ${repo}#${issueNumber}: ${err}`);
        }
      }
      // Keep the comment id with a `released` flag (Issue #3751) so a
      // re-claim on this host revives the same comment instead of posting
      // a new one — now the canonical, with its tally. The GitHub-side
      // finder covers cold hosts.
      await writeMarkerState(workDir, repo, issueNumber, {
        commentId: target,
        lastRefresh: existing?.lastRefresh ?? now,
        released: true,
        attempts: tally
      });
    }
  }
  return {
    ok: true,
    value: undefined
  };
}
/**
 * Release a claim on an issue: unassign the worker AND clear the heartbeat.
 *
 * Every path that releases a claim (success, failure, skip-after-claim,
 * shutdown/rate-limit pause) must remove the worker's assignment — clearing
 * the heartbeat marker alone leaves the issue permanently assigned and blocks
 * all future pickup (Issue #2670, incident stSoftwareAU/VibeCoder#2648).
 *
 * Both steps are best-effort and independent: a failure in one must not
 * prevent the other, and both failures are logged. A double-unassign is
 * harmless — `gh issue edit --remove-assignee` is a no-op when the worker is
 * not an assignee, and removing only `githubUser` never touches another
 * worker's assignment. Returns which actions succeeded for logging.
 *
 * Issue #214: the order is stop the heartbeat and post the outcome FIRST,
 * unassign LAST. The assignee is the claim lock every other host checks, so
 * dropping it while the heartbeat still beats leaves the issue readable as
 * free by a sibling host that would then start a second agent on the same
 * issue (live evidence: VibeCoder#185, unassigned 06:31Z, still beating at
 * 06:40Z). Clearing first also arms the write-after-release guard before the
 * lock is dropped, so no straggling beat can revive the marker.
 */ export async function releaseClaim(workDir, repo, issueNumber, options) {
  let unassigned = false;
  let heartbeatCleared = false;
  // Step 1: stop the heartbeat, post the outcome on the marker comment, and
  // arm the write-after-release guard (best-effort, independent of step 2).
  try {
    const result = await clearHeartbeat(workDir, repo, issueNumber, options.markerOptions, undefined, options.outcome);
    heartbeatCleared = result.ok;
  } catch (err) {
    recordFaultEvent("catch_block_warning", `releaseClaim clearHeartbeat failed for ${repo}#${issueNumber}: ${err}`);
  }
  // Step 2: drop the claim lock (best-effort, independent of step 1, so a
  // clear failure never leaves the issue assigned — Issue #2670).
  if (repo.length > 0 && issueNumber > 0 && options.githubUser.length > 0) {
    const ghFn = options.ghFn ?? runGh;
    try {
      await ghFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        options.githubUser
      ]);
      unassigned = true;
    } catch (err) {
      recordFaultEvent("catch_block_warning", `releaseClaim unassign failed for ${repo}#${issueNumber}: ${err}`);
    }
  }
  return {
    ok: true,
    value: {
      unassigned,
      heartbeatCleared
    }
  };
}
/**
 * Fetch the heartbeat markers currently published on an issue.
 *
 * Returns a list of `{ machineId, epoch }` markers extracted from the
 * issue's comments. Comments without a marker are ignored. Returns an
 * empty array on any failure (e.g. the API call fails or the response
 * cannot be parsed) so callers can treat "unknown" as "no live marker"
 * and fall back to the existing `updatedAt` behaviour.
 *
 * Issue #3164: when `allowedAuthors` is provided and non-empty, a marker is
 * honoured only when its comment author is in the fleet login set (the
 * `resolveFleetAuthors` union). A marker posted by any other GitHub user is
 * ignored — so a forged `VIBE_CODER_HEARTBEAT` comment from an attacker who
 * can merely comment on the issue can no longer defeat stale-assignment
 * recovery. This mirrors the author verification `verifyOperationalLabels`
 * already performs on operational labels. When `allowedAuthors` is omitted
 * or empty the author filter is disabled, preserving the prior behaviour.
 */ export async function scanHeartbeatMarkers(repo, issueNumber, ghFn, allowedAuthors) {
  const json = await ghFn([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "--jq",
    "[.[] | {body: .body, author: .user.login}]"
  ]);
  if (!json) return [];
  let comments;
  try {
    comments = JSON.parse(json);
  } catch (err) {
    recordFaultEvent("catch_block_warning", `scanHeartbeatMarkers parse failed for ${repo}#${issueNumber}: ${err}`);
    return [];
  }
  const filterByAuthor = Array.isArray(allowedAuthors) && allowedAuthors.length > 0;
  const markers = [];
  for (const comment of comments){
    if (!comment || typeof comment.body !== "string") continue;
    // Issue #3164: ignore a marker whose author is not a fleet account when
    // the caller supplied a fleet allow-list (fail toward recovery).
    if (filterByAuthor && !isFleetAuthor(comment.author, allowedAuthors)) {
      continue;
    }
    const marker = parseHeartbeatMarker(comment.body);
    if (marker !== null) markers.push(marker);
  }
  return markers;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9oZWFydGJlYXRfc3RvcmFnZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEhlYXJ0YmVhdCAmIG1hcmtlciBzdG9yYWdlIOKAlCBmaWxlIHBhdGhzLCBtYXJrZXIgZm9ybWF0dGluZywgYW5kIHRoZVxuICogcmVjb3JkL2NsZWFyL3NjYW4gb3BlcmF0aW9ucyB0aGF0IG1haW50YWluIGJvdGggdGhlIGxvY2FsIGhlYXJ0YmVhdFxuICogZmlsZSBhbmQgdGhlIGNyb3NzLW1hY2hpbmUgR2l0SHViIG1hcmtlciBjb21tZW50IChJc3N1ZXMgIzQ3MSwgIzE0NTQpLlxuICpcbiAqIFNpbmdsZSByZXNwb25zaWJpbGl0eTogcGVyc2lzdGluZyBhbmQgcHVibGlzaGluZyBoZWFydGJlYXQgc3RhdGUuXG4gKiBEZXRlY3Rpb24gYW5kIHJlY292ZXJ5IGxvZ2ljIGxpdmUgaW4gc3R1Y2tfZGV0ZWN0aW9uLnRzIGFuZFxuICogc3R1Y2tfcmVjb3ZlcnkudHMgcmVzcGVjdGl2ZWx5LlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGVzY2FwZVJlZ0V4cCB9IGZyb20gXCIuL3JlZ2V4cF9lc2NhcGUudHNcIjtcbmltcG9ydCB7IG5ldXRyYWxpc2VDb21tZW50RGVsaW1pdGVycyB9IGZyb20gXCIuL2FnZW50X21hcmtlcl9uZXV0cmFsaXNhdGlvbi50c1wiO1xuaW1wb3J0IHR5cGUgeyBSdW5PdXRjb21lIH0gZnJvbSBcIi4vcnVuX291dGNvbWUudHNcIjtcbmltcG9ydCB7IFBSX1BFTkRJTkdfTUFSS0VSIH0gZnJvbSBcIi4vZGVmZXJyZWRfcHJfc3RvcmUudHNcIjtcbmltcG9ydCB7XG4gIGdldEZhaWx1cmVDYXRlZ29yeURpc3BsYXksXG4gIGdldEZhaWx1cmVEaWFnbm9zaXNPbmVsaW5lcixcbn0gZnJvbSBcIi4vZmFpbHVyZV9kaWFnbm9zaXMudHNcIjtcbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyByZWNvcmRGYXVsdEV2ZW50IH0gZnJvbSBcIi4vZmF1bHRfdG9sZXJhbmNlX2NvdW50ZXJzLnRzXCI7XG5pbXBvcnQgeyBpc0ZsZWV0QXV0aG9yIH0gZnJvbSBcIi4vZmxlZXRfYXV0aG9ycy50c1wiO1xuaW1wb3J0IHsgc3Bhd25HaCB9IGZyb20gXCIuL2doX3NwYXduLnRzXCI7XG5pbXBvcnQgeyBzd2VlcEhlYXJ0YmVhdENvbW1lbnRzIH0gZnJvbSBcIi4vaGVhcnRiZWF0X3N3ZWVwLnRzXCI7XG5pbXBvcnQge1xuICBkZXNjcmliZVByZXNlcnZlZEJyYW5jaCxcbiAgdHlwZSBQcmVzZXJ2ZWRXaXAsXG59IGZyb20gXCIuL3ByZXNlcnZlZF93aXBfYnJhbmNoLnRzXCI7XG5pbXBvcnQge1xuICBIRUFSVEJFQVRfRklMRV9QUkVGSVgsXG4gIEhFQVJUQkVBVF9NQVJLRVJfRklMRV9QUkVGSVgsXG59IGZyb20gXCIuL3dvcmtlcl9zdGF0ZV9wYXRocy50c1wiO1xuXG4vKipcbiAqIEdlbmVyYXRlIHRoZSBoZWFydGJlYXQgZmlsZSBwYXRoIGZvciBhIGdpdmVuIHJlcG8gYW5kIGlzc3VlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0RmlsZVBhdGgoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgc2FmZVJlcG8gPSByZXBvLnJlcGxhY2UoXCIvXCIsIFwiX1wiKTtcbiAgcmV0dXJuIGAke3dvcmtEaXJ9LyR7SEVBUlRCRUFUX0ZJTEVfUFJFRklYfSR7c2FmZVJlcG99XyR7aXNzdWVOdW1iZXJ9YDtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSB0aGUgbWFya2VyIHN0YXRlIGZpbGUgcGF0aCBmb3IgYSBnaXZlbiByZXBvIGFuZCBpc3N1ZSAoSXNzdWUgIzE0NTQpLlxuICpcbiAqIFN0b3JlcyB0aGUgR2l0SHViIGNvbW1lbnQgaWQgYW5kIGxhc3QgcmVmcmVzaCBlcG9jaCBzbyBzdWJzZXF1ZW50IGNhbGxzXG4gKiBjYW4gZWRpdCB0aGUgZXhpc3RpbmcgY29tbWVudCByYXRoZXIgdGhhbiBzcGFtbWluZyBuZXcgb25lcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtlclN0YXRlRmlsZVBhdGgoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgc2FmZVJlcG8gPSByZXBvLnJlcGxhY2UoXCIvXCIsIFwiX1wiKTtcbiAgcmV0dXJuIGAke3dvcmtEaXJ9LyR7SEVBUlRCRUFUX01BUktFUl9GSUxFX1BSRUZJWH0ke3NhZmVSZXBvfV8ke2lzc3VlTnVtYmVyfWA7XG59XG5cbi8qKiBQcmVmaXggdXNlZCBpbnNpZGUgdGhlIG1hcmtlciBIVE1MIGNvbW1lbnQuICovXG5leHBvcnQgY29uc3QgSEVBUlRCRUFUX01BUktFUl9QUkVGSVggPSBcIlZJQkVfQ09ERVJfSEVBUlRCRUFUXCI7XG5cbi8qKiBEZWZhdWx0IG1pbmltdW0gc2Vjb25kcyBiZXR3ZWVuIG1hcmtlciByZWZyZXNoZXMgKDUgbWludXRlcykuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9NQVJLRVJfUkVGUkVTSF9TRUNPTkRTID0gMzAwO1xuXG4vKipcbiAqIEdyYWNlIHdpbmRvdyAoc2Vjb25kcykgZHVyaW5nIHdoaWNoIGEgY2xlYXJlZCBoZWFydGJlYXQgbWFya2VyIGNvbnRpbnVlc1xuICogdG8gc3VwcHJlc3MgcmVjb3ZlcnksIGV2ZW4gd2hlbiBpdCB3YXMgd3JpdHRlbiBieSBhIGRpZmZlcmVudCBtYWNoaW5lXG4gKiAoSXNzdWUgIzE5MTYpLlxuICpcbiAqIEJhY2tncm91bmQ6IElzc3VlICMxODg2IGFkZGVkIGFuIHVuY29uZGl0aW9uYWwgc2tpcCBvbiBhbnkgY2xlYXJlZFxuICogbWFya2VyIHNvIGEgd29ya2VyIHRoYXQgZmluaXNoZWQgY2xlYW5seSB3YXMgbm90IGltbWVkaWF0ZWx5IHJlLXJlY292ZXJlZFxuICogYnkgYSBwZWVyIHJlYWRpbmcgdGhlIHNhbWUgaXNzdWUuIFRoYXQgc2hvcnQtY2lyY3VpdCBvdmVyLXJlYWNoZWQg4oCUIGlmXG4gKiB0aGUgaXNzdWUgd2FzIGxhdGVyIHJlLWFzc2lnbmVkIGFuZCB0aGUgbmV3IHdvcmtlciBjcmFzaGVkIGJlZm9yZVxuICogcmVjb3JkaW5nIGEgaGVhcnRiZWF0LCB0aGUgb2xkIGNsZWFyZWQgbWFya2VyIHN0aWxsIHN1cHByZXNzZWQgcmVjb3ZlcnlcbiAqIGZvcmV2ZXIgKGxpdmUgZXZpZGVuY2U6IFZpYmVDb2RlciMxODkxLCBwcml2YXRlLXJlcG8tMTQjMjYxMixcbiAqIHByaXZhdGUtcmVwby0xOCMyNTMgc3R1Y2sgfjI0aCkuXG4gKlxuICogVGhlIGdyYWNlIHdpbmRvdyBrZWVwcyB0aGUgb3JpZ2luYWwgcHJvdGVjdGlvbiBmb3IgdGhlIGxlZ2l0aW1hdGUgY2FzZVxuICogKHRoZSBwcmV2aW91cyB3b3JrZXIgSlVTVCBmaW5pc2hlZCBhbmQgdGhlIHJlY292ZXJ5IHNjYW4gcmFjZXMgdGhlXG4gKiB1bmFzc2lnbiBtdXRhdGlvbikgd2hpbGUgYWxsb3dpbmcgcmVjb3ZlcnkgZm9yIHN0YWxlIGNsZWFycy5cbiAqXG4gKiBPbmUgaG91ciB3YXMgY2hvc2VuIGFzIHRoZSBzbWFsbGVzdCB2YWx1ZSB0aGF0IGNvbWZvcnRhYmx5IGV4Y2VlZHMgdGhlXG4gKiBkZWZhdWx0IGBhc3NpZ25lZE5vSGVhcnRiZWF0VGltZW91dGAgKDE4MDBzKSDigJQgc28gYSBmcmVzaGx5IGNsZWFyZWRcbiAqIG1hcmtlciBpcyBhbHdheXMgdHJlYXRlZCBhcyByZWNlbnQsIGJ1dCBhIDI0aC1vbGQgY2xlYXIgaXMgbm90LlxuICpcbiAqIEl0IGxpdmVzIGhlcmUgKHJhdGhlciB0aGFuIGluIHN0dWNrX3JlY292ZXJ5LnRzLCBpdHMgb3JpZ2luYWwgaG9tZSkgc28gdGhlXG4gKiBjb21tZW50IHN3ZWVwIGluIGhlYXJ0YmVhdF9zd2VlcC50cyBzaGFyZXMgdGhlIG9uZSBkZWZpbml0aW9uOiB0aGUgc3dlZXBcbiAqIG11c3Qgbm90IGRlbGV0ZSBhIGNsZWFyZWQgbWFya2VyIHRoYXQgcmVjb3Zlcnkgd291bGQgc3RpbGwgaG9ub3VyXG4gKiAoSXNzdWUgIzM3NTUpLlxuICovXG5leHBvcnQgY29uc3QgQ0xFQVJFRF9NQVJLRVJfR1JBQ0VfU0VDT05EUyA9IDM2MDA7XG5cbi8qKiBNYXhpbXVtIG1pbGVzdG9uZSBlbnRyaWVzIGtlcHQgaW4gdGhlIHByb2dyZXNzIGxvZyAoSXNzdWUgIzM3NTMpLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9NSUxFU1RPTkVTID0gMTA7XG5cbi8qKiBNYXhpbXVtIHJlbmRlcmVkIGxlbmd0aCBvZiBhIHNpbmdsZSBtaWxlc3RvbmUgbGluZSAoSXNzdWUgIzM3NTMpLiAqL1xuZXhwb3J0IGNvbnN0IE1JTEVTVE9ORV9URVhUX01BWF9MRU5HVEggPSAxMjA7XG5cbi8qKiBPbmUgZW50cnkgaW4gdGhlIGhlYXJ0YmVhdCBwcm9ncmVzcyBsb2cgKElzc3VlICMzNzUzKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSGVhcnRiZWF0TWlsZXN0b25lIHtcbiAgLyoqIFVuaXggZXBvY2ggc2Vjb25kcyB3aGVuIHRoZSBtaWxlc3RvbmUgd2FzIHJlY29yZGVkLiAqL1xuICBlcG9jaDogbnVtYmVyO1xuICAvKiogU2hvcnQsIHNpbmdsZS1saW5lLCB3b3JrZXItYXV0aG9yZWQgZGVzY3JpcHRpb24uICovXG4gIHRleHQ6IHN0cmluZztcbn1cblxuLyoqIE9wdGlvbnMgY29udHJvbGxpbmcgdGhlIEdpdEh1YiBtYXJrZXIgcHVibGlzaGVkIGFsb25nc2lkZSB0aGUgaGVhcnRiZWF0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBIZWFydGJlYXRNYXJrZXJPcHRpb25zIHtcbiAgLyoqIFN0YWJsZSBpZGVudGlmaWVyIGZvciB0aGUgY3VycmVudCBtYWNoaW5lIChzZWUgbGliL21hY2hpbmVfaWQudHMpLiAqL1xuICBtYWNoaW5lSWQ6IHN0cmluZztcbiAgLyoqIEZ1bmN0aW9uIHVzZWQgdG8gaW52b2tlIGBnaGAuIERlZmF1bHRzIHRvIHRoZSBtb2R1bGUtbG9jYWwgcnVuR2guICovXG4gIGdoRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbiAgLyoqXG4gICAqIE1pbmltdW0gc2Vjb25kcyBiZXR3ZWVuIG1hcmtlciByZWZyZXNoZXMuIERlZmF1bHRzIHRvXG4gICAqIERFRkFVTFRfTUFSS0VSX1JFRlJFU0hfU0VDT05EUyAoMzAwKS5cbiAgICovXG4gIG1pblJlZnJlc2hTZWNvbmRzPzogbnVtYmVyO1xuICAvKipcbiAgICogRmxlZXQgbG9naW5zIHdob3NlIG1hcmtlciBjb21tZW50cyBtYXkgYmUgYWRvcHRlZCAoSXNzdWUgIzM3NTEpLlxuICAgKlxuICAgKiBNaXJyb3JzIHtAbGluayBzY2FuSGVhcnRiZWF0TWFya2Vyc306IHdoZW4gcHJvdmlkZWQgYW5kIG5vbi1lbXB0eSwgb25seSBhXG4gICAqIG1hcmtlciBjb21tZW50IGF1dGhvcmVkIGJ5IGEgZmxlZXQgYWNjb3VudCBpcyBhZG9wdGVkLCBzbyBhIGZvcmdlZFxuICAgKiBgVklCRV9DT0RFUl9IRUFSVEJFQVRgIGNvbW1lbnQgY2FuIG5ldmVyIGNhcHR1cmUgdGhpcyB3b3JrZXIncyBoZWFydGJlYXRcbiAgICogKElzc3VlICMzMTY0IHNlbWFudGljcykuIE9taXR0ZWQgb3IgZW1wdHkgZGlzYWJsZXMgdGhlIGZpbHRlci5cbiAgICovXG4gIGFsbG93ZWRBdXRob3JzPzogc3RyaW5nW107XG4gIC8qKlxuICAgKiBXb3JrZXIgaWQgc2hvd24gaW4gdGhlIHZpc2libGUgaGVhcnRiZWF0IGJvZHkgKElzc3VlICMzNzUyKS5cbiAgICpcbiAgICogUmVjb3JkZWQgb24gdGhlIGZpcnN0IHB1Ymxpc2ggYW5kIHJldXNlZCBvbiBsYXRlciByZWZyZXNoZXMsIHNvIGEgYmVhdFxuICAgKiB0aGF0IGNhcnJpZXMgbm8gd29ya2VyIGlkIHN0aWxsIHJlbmRlcnMgdGhlIG9yaWdpbmFsIG9uZS5cbiAgICovXG4gIHdvcmtlcklkPzogc3RyaW5nO1xuICAvKiogSG9zdCBuYW1lIHNob3duIGluIHRoZSB2aXNpYmxlIGJvZHkuIERlZmF1bHRzIHRvIHRoZSBtYWNoaW5lIGlkJ3MgaG9zdC4gKi9cbiAgaG9zdD86IHN0cmluZztcbn1cblxuLyoqIEZpZWxkcyByZW5kZXJlZCBpbnRvIGEgdmlzaWJsZSBoZWFydGJlYXQgY29tbWVudCBib2R5IChJc3N1ZSAjMzc1MikuICovXG5leHBvcnQgaW50ZXJmYWNlIEhlYXJ0YmVhdEJvZHlGaWVsZHMge1xuICAvKiogU3RhYmxlIGlkZW50aWZpZXIgZm9yIHRoZSBtYWNoaW5lIGhvbGRpbmcgdGhlIGNsYWltLiAqL1xuICBtYWNoaW5lSWQ6IHN0cmluZztcbiAgLyoqIE1hcmtlciBlcG9jaCDigJQgdGhlIGxhc3QgYmVhdCwgb3IgMCBvbmNlIHRoZSBjbGFpbSBpcyByZWxlYXNlZC4gKi9cbiAgZXBvY2g6IG51bWJlcjtcbiAgLyoqIEhvc3QgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGhvc3RuYW1lIHNlZ21lbnQgb2YgYG1hY2hpbmVJZGAuICovXG4gIGhvc3Q/OiBzdHJpbmc7XG4gIC8qKiBXb3JrZXIgaWQuIFRoZSB3b3JrZXIgY2xhdXNlIGlzIG9taXR0ZWQgd2hlbiBhYnNlbnQuICovXG4gIHdvcmtlcklkPzogc3RyaW5nO1xuICAvKiogV2hlbiB0aGUgY2xhaW0gc3RhcnRlZC4gVGhlIHN0YXJ0IGNsYXVzZSBpcyBvbWl0dGVkIHdoZW4gYWJzZW50LiAqL1xuICBzdGFydGVkRXBvY2g/OiBudW1iZXI7XG4gIC8qKiBSZW5kZXIgdGhlIHJlbGVhc2VkIChjbGVhcmVkKSBzaGFwZSBpbnN0ZWFkIG9mIHRoZSBsaXZlIG9uZS4gKi9cbiAgcmVsZWFzZWQ/OiBib29sZWFuO1xuICAvKiogUm9sbGluZyBwcm9ncmVzcyBsb2cgYXBwZW5kZWQgYmVsb3cgdGhlIHN0YXR1cyBsaW5lIChJc3N1ZSAjMzc1MykuICovXG4gIG1pbGVzdG9uZXM/OiBIZWFydGJlYXRNaWxlc3RvbmVbXTtcbiAgLyoqXG4gICAqIFdoYXQgdGhlIHJ1biBhY2hpZXZlZCAoSXNzdWUgIzQzMjUsIHBhcnQgb2YgIzQyOTEpOiBQUiBsaW5rLCBmYWlsdXJlXG4gICAqIGRpYWdub3Npcywgb3IgYSBkZWxpYmVyYXRlIG5vLVBSLiBPbmx5IG1lYW5pbmdmdWwgd2l0aCBgcmVsZWFzZWRgLlxuICAgKiBBYnNlbnQg4oaSIHRvZGF5J3MgcmVsZWFzZSB0ZXh0LCBieXRlIGZvciBieXRlLlxuICAgKi9cbiAgb3V0Y29tZT86IFJ1bk91dGNvbWU7XG4gIC8qKlxuICAgKiBBdHRlbXB0IHRhbGx5IHJlbmRlcmVkIGJlbG93IHRoZSBvdXRjb21lIG9uIGEgY29sbGFwc2VkIHJlbGVhc2VcbiAgICogKElzc3VlICM0MzI3KS4gT21pdHRlZCwgb3IgYSB0b3RhbCBvZiAxLCByZW5kZXJzIG5vdGhpbmcgZXh0cmEuXG4gICAqL1xuICBhdHRlbXB0cz86IFJlbGVhc2VBdHRlbXB0VGFsbHk7XG59XG5cbi8qKiBJbi1tZW1vcnkgc3RhdGUgcGVyc2lzdGVkIHRvIG1hcmtlclN0YXRlRmlsZVBhdGguICovXG5leHBvcnQgaW50ZXJmYWNlIE1hcmtlclN0YXRlIHtcbiAgY29tbWVudElkOiBudW1iZXI7XG4gIGxhc3RSZWZyZXNoOiBudW1iZXI7XG4gIC8qKlxuICAgKiBCb2R5IHRleHQgdG8gcHJlcGVuZCB0byB0aGUgaGVhcnRiZWF0IG1hcmtlciBvbiByZWZyZXNoIChJc3N1ZSAjMTYyOCkuXG4gICAqXG4gICAqIFdoZW4gdGhlIGNsYWltIGFuZCBoZWFydGJlYXQgYXJlIGNvLXB1Ymxpc2hlZCBhcyBhIHNpbmdsZSBjb21tZW50LCB0aGlzXG4gICAqIGhvbGRzIHRoZSBjbGFpbSBwb3J0aW9uIChgPCEtLSBDTEFJTV9MT0NLOldPUktFUl9JRCAtLT4gQ2xhaW1lZCBieSAuLi5gKVxuICAgKiBzbyBQQVRDSCByZWZyZXNoZXMgcHJlc2VydmUgdGhlIENMQUlNX0xPQ0sgbWFya2VyIHRoYXQgcmFjZSBkZXRlY3Rpb25cbiAgICogcmVsaWVzIG9uLlxuICAgKi9cbiAgY2xhaW1QcmVmaXg/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgY2xhaW0gb3duaW5nIHRoaXMgY29tbWVudCBoYXMgYmVlbiByZWxlYXNlZCAoSXNzdWUgIzM3NTEpLlxuICAgKlxuICAgKiBgY2xlYXJIZWFydGJlYXRgIGtlZXBzIHRoZSBzdGF0ZSBmaWxlIHdpdGggdGhpcyBmbGFnIHNldCBpbnN0ZWFkIG9mXG4gICAqIGRlbGV0aW5nIGl0LCBzbyBhIHJlLWNsYWltIG9uIHRoZSBzYW1lIGhvc3QgcmV2aXZlcyB0aGUgc2FtZSBjb21tZW50XG4gICAqIHdpdGhvdXQgYSBHaXRIdWIgbG9va3VwLiBBIHJlbGVhc2VkIHN0YXRlIGFsd2F5cyBQQVRDSGVzIG9uIHRoZSBuZXh0XG4gICAqIHB1Ymxpc2gsIHJlZ2FyZGxlc3Mgb2YgdGhlIHJlZnJlc2ggd2luZG93LlxuICAgKi9cbiAgcmVsZWFzZWQ/OiBib29sZWFuO1xuICAvKipcbiAgICogQXR0ZW1wdCB0YWxseSBvZiB0aGUgcmVsZWFzZSBjb21tZW50IHRoaXMgc3RhdGUgcG9pbnRzIGF0IChJc3N1ZVxuICAgKiAjNDMyNyksIHNvIGEgc2FtZS1ob3N0IHJldml2ZSBrZWVwcyB0aGUgaGlzdG9yeSBhbmQgdGhlIG5leHQgcmVsZWFzZVxuICAgKiBjYW4gZXh0ZW5kIGl0IHdpdGhvdXQgYSBmZXRjaC5cbiAgICovXG4gIGF0dGVtcHRzPzogUmVsZWFzZUF0dGVtcHRUYWxseTtcbiAgLyoqXG4gICAqIFJvbGxpbmcgcHJvZ3Jlc3MgbG9nIHJlbmRlcmVkIGluc2lkZSB0aGUgbWFya2VyIGNvbW1lbnQgKElzc3VlICMzNzUzKS5cbiAgICpcbiAgICogQ2FwcGVkIGF0IHtAbGluayBNQVhfTUlMRVNUT05FU307IHRoZSBvbGRlc3QgZW50cnkgaXMgZXZpY3RlZCBmaXJzdCBzbyBhXG4gICAqIGxvbmctcnVubmluZyBjbGFpbSBjYW5ub3QgZ3JvdyB0aGUgY29tbWVudCB3aXRob3V0IGJvdW5kLlxuICAgKi9cbiAgbWlsZXN0b25lcz86IEhlYXJ0YmVhdE1pbGVzdG9uZVtdO1xuICAvKipcbiAgICogVW5peCBlcG9jaCBzZWNvbmRzIHdoZW4gdGhpcyBjbGFpbSBzdGFydGVkIChJc3N1ZSAjMzc1MikuXG4gICAqXG4gICAqIFBlcnNpc3RlZCBvbiB0aGUgZmlyc3QgcHVibGlzaCBzbyBsYXRlciByZWZyZXNoZXMga2VlcCBzaG93aW5nIHRoZVxuICAgKiBvcmlnaW5hbCBzdGFydCB0aW1lIHJhdGhlciB0aGFuIHRoZSBjdXJyZW50IGJlYXQuIEFic2VudCBvbiBzdGF0ZSBmaWxlc1xuICAgKiB3cml0dGVuIGJlZm9yZSBJc3N1ZSAjMzc1MiwgaW4gd2hpY2ggY2FzZSB0aGUgc3RhcnQgY2xhdXNlIGlzIG9taXR0ZWQuXG4gICAqL1xuICBzdGFydGVkRXBvY2g/OiBudW1iZXI7XG4gIC8qKiBXb3JrZXIgaWQgc2hvd24gaW4gdGhlIHZpc2libGUgYm9keSAoSXNzdWUgIzM3NTIpLiAqL1xuICB3b3JrZXJJZD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBOb3JtYWxpc2UgbWlsZXN0b25lIHRleHQgdG8gb25lIHNob3J0IGxpbmUgKElzc3VlICMzNzUzKS5cbiAqXG4gKiBOZXdsaW5lcyBhcmUgY29sbGFwc2VkIHNvIHdvcmtlci1hdXRob3JlZCB0ZXh0IGNhbiBuZXZlciB3cmFwIGludG8g4oCUIG9yXG4gKiBwYXN0IOKAlCB0aGUgbWFjaGluZS1yZWFkYWJsZSBtYXJrZXIgbGluZSwgYW5kIHRoZSByZXN1bHQgaXMgdHJ1bmNhdGVkIHRvXG4gKiB7QGxpbmsgTUlMRVNUT05FX1RFWFRfTUFYX0xFTkdUSH0uXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGlzZU1pbGVzdG9uZVRleHQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZmxhdCA9IHRleHQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xuICBpZiAoZmxhdC5sZW5ndGggPD0gTUlMRVNUT05FX1RFWFRfTUFYX0xFTkdUSCkgcmV0dXJuIGZsYXQ7XG4gIHJldHVybiBgJHtmbGF0LnN1YnN0cmluZygwLCBNSUxFU1RPTkVfVEVYVF9NQVhfTEVOR1RIIC0gMSl94oCmYDtcbn1cblxuLyoqIFJlbmRlciBhbiBlcG9jaCBhcyBhIGBISDpNTWAgVVRDIGNsb2NrIHRpbWUgZm9yIHRoZSBwcm9ncmVzcyBsb2cuICovXG5mdW5jdGlvbiBmb3JtYXRNaWxlc3RvbmVUaW1lKGVwb2NoOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShlcG9jaCkgfHwgZXBvY2ggPD0gMCkgcmV0dXJuIFwiLS06LS1cIjtcbiAgcmV0dXJuIG5ldyBEYXRlKGVwb2NoICogMTAwMCkudG9JU09TdHJpbmcoKS5zdWJzdHJpbmcoMTEsIDE2KTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgdGhlIHJvbGxpbmcgcHJvZ3Jlc3MgbG9nIGFwcGVuZGVkIHRvIHRoZSBtYXJrZXIgY29tbWVudFxuICogKElzc3VlICMzNzUzKS4gUmV0dXJucyBcIlwiIHdoZW4gdGhlcmUgaXMgbm90aGluZyB0byBzaG93LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0TWlsZXN0b25lTG9nKG1pbGVzdG9uZXM6IEhlYXJ0YmVhdE1pbGVzdG9uZVtdKTogc3RyaW5nIHtcbiAgY29uc3QgcmVjZW50ID0gbWlsZXN0b25lcy5zbGljZSgtTUFYX01JTEVTVE9ORVMpO1xuICBpZiAocmVjZW50Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IGxpbmVzID0gcmVjZW50Lm1hcCgobSkgPT5cbiAgICBgLSAke2Zvcm1hdE1pbGVzdG9uZVRpbWUobS5lcG9jaCl9ICR7bm9ybWFsaXNlTWlsZXN0b25lVGV4dChtLnRleHQpfWBcbiAgKTtcbiAgcmV0dXJuIGBcXG5cXG4qKlByb2dyZXNzKipcXG4ke2xpbmVzLmpvaW4oXCJcXG5cIil9YDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBBdHRlbXB0IHRhbGx5IChJc3N1ZSAjNDMyNywgcGFydCBvZiAjNDI5MSlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogT25lIHByaW9yIGF0dGVtcHQgb24gYW4gaXNzdWUsIGFzIHJlbmRlcmVkIGluIHRoZSBjb2xsYXBzZWQgcmVsZWFzZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVsZWFzZUF0dGVtcHQge1xuICAvKiogRXBvY2ggc2Vjb25kcyB0aGUgYXR0ZW1wdCB3YXMgcmVsZWFzZWQgKDAgd2hlbiB1bmtub3duKS4gKi9cbiAgZXBvY2g6IG51bWJlcjtcbiAgLyoqIEhvc3QgdGhhdCByYW4gaXQuICovXG4gIGhvc3Q6IHN0cmluZztcbiAgLyoqIFNob3J0IG91dGNvbWUgdGV4dCwgZS5nLiBgbm8gUFIgKFxcYHRpbWVvdXRcXGAsIHBoYXNlIFxcYGV4ZWN1dGVcXGApYC4gKi9cbiAgdGV4dDogc3RyaW5nO1xufVxuXG4vKiogVGhlIGF0dGVtcHQgdGFsbHkgY2FycmllZCBieSBhIGNvbGxhcHNlZCByZWxlYXNlIGNvbW1lbnQuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlbGVhc2VBdHRlbXB0VGFsbHkge1xuICAvKiogVG90YWwgYXR0ZW1wdHMgb24gdGhlIGlzc3VlLCBpbmNsdWRpbmcgdGhvc2UgZXZpY3RlZCBmcm9tIHRoZSBsaXN0LiAqL1xuICB0b3RhbDogbnVtYmVyO1xuICAvKiogVGhlIG1vc3QgcmVjZW50IGF0dGVtcHRzLCBvbGRlc3QgZmlyc3QgKGNhcHBlZCBhdCBNQVhfQVRURU1QVFMpLiAqL1xuICBhdHRlbXB0czogUmVsZWFzZUF0dGVtcHRbXTtcbn1cblxuLyoqIEF0dGVtcHRzIGxpc3RlZCBpbiB0aGUgY29sbGFwc2VkIHJlbGVhc2U7IG9sZGVyIG9uZXMgYmVjb21lIFwiK04gZWFybGllclwiLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9BVFRFTVBUUyA9IE1BWF9NSUxFU1RPTkVTO1xuXG5jb25zdCBBVFRFTVBUU19IRUFESU5HID0gXCIqKkF0dGVtcHRzIG9uIHRoaXMgaXNzdWU6KipcIjtcblxuLyoqIE9uZSBhdHRlbXB0J3Mgb3V0Y29tZSB0ZXh0IGZvciB0aGUgdGFsbHkgbGluZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZUF0dGVtcHRPdXRjb21lKFxuICBvdXRjb21lOiBSdW5PdXRjb21lIHwgdW5kZWZpbmVkLFxuKTogc3RyaW5nIHtcbiAgaWYgKCFvdXRjb21lKSByZXR1cm4gXCJyZWxlYXNlZFwiO1xuICBzd2l0Y2ggKG91dGNvbWUua2luZCkge1xuICAgIGNhc2UgXCJwclwiOlxuICAgICAgLy8gSXNzdWUgIzIwNDQ6IGEgUFIgYSBsYXRlciBzdGVwIHRoZW4gYmxvY2tlZCBpcyBzdGlsbCBhIGRlbGl2ZXJlZCBQUiDigJRcbiAgICAgIC8vIHRoZSB0YWxseSBzYXlzIGJvdGgsIHNvIGl0IGlzIG5vdCByZWFkIGFzIGEgcnVuIHRoYXQgZGVsaXZlcmVkXG4gICAgICAvLyBub3RoaW5nLlxuICAgICAgcmV0dXJuIG91dGNvbWUuYmxvY2tlZFxuICAgICAgICA/IGByYWlzZWQgIyR7b3V0Y29tZS5wck51bWJlcn0sIGJsb2NrZWQgKFxcYCR7XG4gICAgICAgICAgZ2V0RmFpbHVyZUNhdGVnb3J5RGlzcGxheShvdXRjb21lLmJsb2NrZWQuY2F0ZWdvcnkpXG4gICAgICAgIH1cXGApYFxuICAgICAgICA6IGByYWlzZWQgIyR7b3V0Y29tZS5wck51bWJlcn1gO1xuICAgIGNhc2UgXCJub19wclwiOlxuICAgICAgcmV0dXJuIGBubyBQUiAoXFxgJHtcbiAgICAgICAgZ2V0RmFpbHVyZUNhdGVnb3J5RGlzcGxheShvdXRjb21lLmNhdGVnb3J5KVxuICAgICAgfVxcYCwgcGhhc2UgXFxgJHtub3JtYWxpc2VNaWxlc3RvbmVUZXh0KG91dGNvbWUucGhhc2UpfVxcYClgO1xuICAgIGNhc2UgXCJub19wcl9leHBlY3RlZFwiOlxuICAgICAgcmV0dXJuIGBubyBQUiBleHBlY3RlZCAocGhhc2UgXFxgJHtcbiAgICAgICAgbm9ybWFsaXNlTWlsZXN0b25lVGV4dChvdXRjb21lLnBoYXNlKVxuICAgICAgfVxcYClgO1xuICAgIGNhc2UgXCJzdXBlcnNlZGVkXCI6XG4gICAgICByZXR1cm4gYHN1cGVyc2VkZWQgYnkgIyR7b3V0Y29tZS5wck51bWJlcn1gO1xuICAgIGNhc2UgXCJjbGFpbV9zdGFsZVwiOlxuICAgICAgcmV0dXJuIGBjbGFpbSB3ZW50IHN0YWxlIChcXGAke291dGNvbWUucmVhc29ufVxcYClgO1xuICAgIGNhc2UgXCJzdW1tYXJ5X2luY29tcGxldGVcIjpcbiAgICAgIHJldHVybiBgcmFpc2VkICMke291dGNvbWUucHJOdW1iZXJ9LCBzdW1tYXJ5IGluY29tcGxldGVgO1xuICAgIGNhc2UgXCJwcl9kZWZlcnJlZFwiOlxuICAgICAgcmV0dXJuIGBQUiBwZW5kaW5nIG9uIFxcYCR7bm9ybWFsaXNlTWlsZXN0b25lVGV4dChvdXRjb21lLmJyYW5jaCl9XFxgYDtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBvbmUgbGluZSB0aGUgc3VwZXJzZWRlZCByZWxlYXNlIHBvaW50ZXIgcmVwZWF0cyAoSXNzdWUgIzIzODgpLlxuICpcbiAqIHtAbGluayBkZXNjcmliZUF0dGVtcHRPdXRjb21lfSBpcyB0aGUgdGFsbHkncyBzaG9ydGhhbmQsIGFuZCBmb3IgdGhlIHR3b1xuICogb3V0Y29tZXMgdGhhdCBjYXJyeSBhIHJlYXNvbiBpdCB0aHJvd3MgdGhhdCByZWFzb24gYXdheTogYSBkZWZlcnJhbCByZW5kZXJzXG4gKiBhcyBgbm8gUFIgZXhwZWN0ZWQgKHBoYXNlIHNldHVwKWAgYW5kIHNheXMgbm90aGluZyBhdCBhbGwgYWJvdXQgKndoeSouIFRoYXRcbiAqIGlzIHdoYXQgbGVmdCBhIG1pbGVzdG9uZSBkZWZlcnJpbmcgb24gZmlmdGVlbiBpc3N1ZXMgd2l0aCBubyB2aXNpYmxlIGNhdXNlXG4gKiDigJQgdGhlIHJlYXNvbiB3YXMgb24gdGhlIGZpcnN0IHJlbGVhc2UgY29tbWVudCwgYSB3ZWVrIGFuZCBhIGRvemVuIGNvbW1lbnRzXG4gKiB1cCB0aGUgdGhyZWFkLiBUaGUgc2hvcnRoYW5kIGtlZXBzIGl0cyBwbGFjZSBhbmQgdGhlIHJlYXNvbiByaWRlcyB3aXRoIGl0LlxuICpcbiAqIEJvdW5kZWQgdGhyb3VnaCB7QGxpbmsgYm91bmRPdXRjb21lVGV4dH0sIGxpa2UgZXZlcnkgb3RoZXIgZnJlZS10ZXh0IHNwbGljZVxuICogaW4gdGhpcyBmaWxlOiBvbmUgbGluZSwgYW5kIHdpdGggYDwhLS1gIC8gYC0tPmAgbmV1dHJhbGlzZWQsIGJlY2F1c2UgdGhlXG4gKiBwb2ludGVyIGJvZHkgb3BlbnMgd2l0aCB0aGUgbWFjaGluZS1yZWFkYWJsZSBtYXJrZXIgY29tbWVudCBhbmRcbiAqIGBpc0hlYXJ0YmVhdE9ubHlCb2R5YCBtYXRjaGVzIGl0IGxpbmUgYnkgbGluZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbGVhc2VSZWFzb25MaW5lKG91dGNvbWU6IFJ1bk91dGNvbWUgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBjb25zdCB0ZXJzZSA9IGRlc2NyaWJlQXR0ZW1wdE91dGNvbWUob3V0Y29tZSk7XG4gIGNvbnN0IGRldGFpbCA9IG91dGNvbWU/LmtpbmQgPT09IFwibm9fcHJfZXhwZWN0ZWRcIlxuICAgID8gb3V0Y29tZS5zdW1tYXJ5XG4gICAgOiBvdXRjb21lPy5raW5kID09PSBcIm5vX3ByXCJcbiAgICA/IG91dGNvbWUubWVzc2FnZVxuICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCBib3VuZGVkID0gZGV0YWlsXG4gICAgPyBib3VuZE91dGNvbWVUZXh0KGRldGFpbCwgT1VUQ09NRV9ERVRBSUxfTUFYX0xFTkdUSClcbiAgICA6IFwiXCI7XG4gIHJldHVybiBib3VuZGVkID8gYCR7dGVyc2V9IOKAlCAke2JvdW5kZWR9YCA6IHRlcnNlO1xufVxuXG4vKipcbiAqIFJlbmRlciB0aGUgYXR0ZW1wdCBibG9jay4gRW1wdHkgZm9yIGEgc2luZ2xlIGF0dGVtcHQgKHRvZGF5J3MgdGV4dCBpc1xuICogdW5jaGFuZ2VkKTsgb3RoZXJ3aXNlIGEgaGVhZGluZyB3aXRoIHRoZSB0b3RhbCBhbmQgb25lIGxpbmUgcGVyIGxpc3RlZFxuICogYXR0ZW1wdCwgb2xkZXN0IGZpcnN0LCB3aXRoIGEgXCIrTiBlYXJsaWVyXCIgbGluZSB3aGVuIHRoZSBsaXN0IGlzIGNhcHBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEF0dGVtcHRCbG9jayh0YWxseTogUmVsZWFzZUF0dGVtcHRUYWxseSk6IHN0cmluZyB7XG4gIGlmICh0YWxseS50b3RhbCA8PSAxKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgbGlzdGVkID0gdGFsbHkuYXR0ZW1wdHMuc2xpY2UoLU1BWF9BVFRFTVBUUyk7XG4gIGNvbnN0IGVhcmxpZXIgPSB0YWxseS50b3RhbCAtIGxpc3RlZC5sZW5ndGg7XG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGAke0FUVEVNUFRTX0hFQURJTkd9ICR7dGFsbHkudG90YWx9YCxcbiAgICAuLi4oZWFybGllciA+IDAgPyBbYC0gKyR7ZWFybGllcn0gZWFybGllcmBdIDogW10pLFxuICAgIC4uLmxpc3RlZC5tYXAoKGEpID0+XG4gICAgICBgLSAke2Zvcm1hdE1pbGVzdG9uZVRpbWUoYS5lcG9jaCl9IFxcYCR7XG4gICAgICAgIG5vcm1hbGlzZU1pbGVzdG9uZVRleHQoYS5ob3N0KVxuICAgICAgfVxcYCDigJQgJHtub3JtYWxpc2VNaWxlc3RvbmVUZXh0KGEudGV4dCl9YFxuICAgICksXG4gIF07XG4gIHJldHVybiBgXFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfWA7XG59XG5cbi8qKlxuICogUGFyc2UgdGhlIGF0dGVtcHQgYmxvY2sgYmFjayBvdXQgb2YgYSBjb21tZW50IGJvZHkg4oCUIHRoZSBvbmx5IHNvdXJjZSBvZlxuICogdGhlIHRhbGx5IHRoYXQgc3Vydml2ZXMgYSBob3N0IGNoYW5nZS4gUmV0dXJucyBudWxsIHdoZW4gdGhlIGJvZHkgY2Fycmllc1xuICogbm8gYmxvY2suIFJvdW5kLXRyaXBzIHdpdGgge0BsaW5rIGZvcm1hdEF0dGVtcHRCbG9ja306IHRoZSByZW5kZXJlZCBlcG9jaFxuICoga2VlcHMgb25seSBISDpNTSwgc28gYSBwYXJzZWQgYXR0ZW1wdCdzIGVwb2NoIGlzIHRoYXQgY2xvY2sgdGltZSBvbiB0aGVcbiAqIGVwb2NoIGRheSAwIChyZW5kZXJpbmcgaXQgYWdhaW4geWllbGRzIHRoZSBzYW1lIEhIOk1NKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXR0ZW1wdEJsb2NrKGJvZHk6IHN0cmluZyk6IFJlbGVhc2VBdHRlbXB0VGFsbHkgfCBudWxsIHtcbiAgY29uc3QgaGVhZGluZyA9IG5ldyBSZWdFeHAoXG4gICAgYF5cXFxccyoke2VzY2FwZVJlZ0V4cChBVFRFTVBUU19IRUFESU5HKX1cXFxccyooXFxcXGQrKVxcXFxzKiRgLFxuICAgIFwibVwiLFxuICApO1xuICBjb25zdCBtID0gaGVhZGluZy5leGVjKGJvZHkgPz8gXCJcIik7XG4gIGlmICghbSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHRvdGFsID0gcGFyc2VJbnQobVsxXSEsIDEwKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodG90YWwpIHx8IHRvdGFsIDwgMSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHJlc3QgPSBib2R5LnNsaWNlKG0uaW5kZXggKyBtWzBdLmxlbmd0aCk7XG4gIGNvbnN0IGF0dGVtcHRzOiBSZWxlYXNlQXR0ZW1wdFtdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiByZXN0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgaWYgKGF0dGVtcHRzLmxlbmd0aCA+IDApIGJyZWFrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICgvXlxccyotXFxzK1xcK1xcZCsgZWFybGllclxccyokLy50ZXN0KGxpbmUpKSBjb250aW51ZTtcbiAgICBjb25zdCBhID0gL15cXHMqLVxccysoXFxkezJ9KTooXFxkezJ9fC0tKVxccytgKFteYF0qKWBcXHMr4oCUXFxzKyguKikkLy5leGVjKGxpbmUpID8/XG4gICAgICAvXlxccyotXFxzKygtLSk6KC0tKVxccytgKFteYF0qKWBcXHMr4oCUXFxzKyguKikkLy5leGVjKGxpbmUpO1xuICAgIGlmICghYSkgYnJlYWs7XG4gICAgY29uc3QgaGggPSBhWzFdID09PSBcIi0tXCIgPyBOYU4gOiBwYXJzZUludChhWzFdISwgMTApO1xuICAgIGNvbnN0IG1tID0gYVsyXSA9PT0gXCItLVwiID8gTmFOIDogcGFyc2VJbnQoYVsyXSEsIDEwKTtcbiAgICBhdHRlbXB0cy5wdXNoKHtcbiAgICAgIGVwb2NoOiBOdW1iZXIuaXNGaW5pdGUoaGgpICYmIE51bWJlci5pc0Zpbml0ZShtbSlcbiAgICAgICAgPyBoaCAqIDM2MDAgKyBtbSAqIDYwXG4gICAgICAgIDogMCxcbiAgICAgIGhvc3Q6IGFbM10hLFxuICAgICAgdGV4dDogYVs0XSEudHJpbUVuZCgpLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiB7IHRvdGFsLCBhdHRlbXB0cyB9O1xufVxuXG4vKipcbiAqIFJlY29uc3RydWN0IHRoZSBzaW5nbGUgYXR0ZW1wdCBhIHJlbGVhc2VkIGJvZHkgd2l0aG91dCBhIHRhbGx5IGJsb2NrXG4gKiByZXByZXNlbnRzICh0aGUgZmlyc3QgcmVsZWFzZSBvbiBhIHRocmVhZCByZW5kZXJzIG5vIGJsb2NrKSwgZnJvbSBpdHNcbiAqIHZpc2libGUgbGluZTogaG9zdCwgZmluaXNoIGNsb2NrIGFuZCBvdXRjb21lLiBOdWxsIHdoZW4gdGhlIGJvZHkgaXMgbm90IGFcbiAqIHJlbGVhc2VkIHNoYXBlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZWxlYXNlQXR0ZW1wdEZyb21Cb2R5KFxuICBib2R5OiBzdHJpbmcsXG4pOiBSZWxlYXNlQXR0ZW1wdCB8IG51bGwge1xuICBjb25zdCBsaW5lID1cbiAgICAvKOKchXzimqDvuI8pXFxzKlxcKlxcKlZpYmUgQ29kZXIgcmVsZWFzZWQgdGhpcyBjbGFpbSg/OiB3aXRoIG5vIFBSKT9cXCpcXCpcXHMq4oCUXFxzKmhvc3QgYChbXmBdKilgLCBmaW5pc2hlZCAoXFxkezJ9KTooXFxkezJ9KSBVVENcXC4oLiopJC9tXG4gICAgICAuZXhlYyhib2R5ID8/IFwiXCIpO1xuICBpZiAoIWxpbmUpIHJldHVybiBudWxsO1xuICBjb25zdCBob3N0ID0gbGluZVsyXSE7XG4gIGNvbnN0IGVwb2NoID0gcGFyc2VJbnQobGluZVszXSEsIDEwKSAqIDM2MDAgKyBwYXJzZUludChsaW5lWzRdISwgMTApICogNjA7XG4gIGNvbnN0IHJlc3QgPSBsaW5lWzVdID8/IFwiXCI7XG4gIGxldCB0ZXh0ID0gXCJyZWxlYXNlZFwiO1xuICBjb25zdCByYWlzZWQgPSAvUmFpc2VkICMoXFxkKykvLmV4ZWMocmVzdCk7XG4gIGNvbnN0IG91dGNvbWUgPSAvXFwqXFwqT3V0Y29tZTpcXCpcXCogbm8gUFIgcmFpc2VkIOKAlCBgKFteYF0rKWAvLmV4ZWMoYm9keSk7XG4gIGNvbnN0IHBoYXNlID0gL1xcKlxcKkRpYWdub3NpczpcXCpcXCogZGllZCBpbiBwaGFzZSBgKFteYF0rKWAvLmV4ZWMoYm9keSk7XG4gIC8vIElzc3VlICMyMDQ0OiBhIFBSIGEgbGF0ZXIgc3RlcCBibG9ja2VkIHJlbmRlcnMgYm90aCBoYWx2ZXMsIHNvIHRoZVxuICAvLyByZWNvbnN0cnVjdGlvbiByZWFkcyBib3RoIOKAlCBvdGhlcndpc2UgdGhlIHRhbGx5IHdvdWxkIHNob3cgdGhlIGRlbGl2ZXJlZFxuICAvLyBQUiBhbmQgc2lsZW50bHkgZHJvcCB0aGUgb3V0c3RhbmRpbmcgZmluZGluZy5cbiAgY29uc3QgYmxvY2tlZCA9XG4gICAgL1xcKlxcKk91dGNvbWU6XFwqXFwqIFBSIHJhaXNlZCwgdGhlbiBibG9ja2VkIGluIHBoYXNlIGBbXmBdK2Ag4oCUIGAoW15gXSspYC9cbiAgICAgIC5leGVjKGJvZHkpO1xuICBpZiAocmFpc2VkKSB7XG4gICAgdGV4dCA9IGJsb2NrZWRcbiAgICAgID8gYHJhaXNlZCAjJHtyYWlzZWRbMV19LCBibG9ja2VkIChcXGAke2Jsb2NrZWRbMV19XFxgKWBcbiAgICAgIDogYHJhaXNlZCAjJHtyYWlzZWRbMV19YDtcbiAgfSBlbHNlIGlmIChvdXRjb21lKSB7XG4gICAgdGV4dCA9IGBubyBQUiAoXFxgJHtvdXRjb21lWzFdfVxcYCR7cGhhc2UgPyBgLCBwaGFzZSBcXGAke3BoYXNlWzFdfVxcYGAgOiBcIlwifSlgO1xuICB9IGVsc2UgaWYgKC9ubyBQUiBleHBlY3RlZCBmb3IgdGhpcyBwaGFzZS8udGVzdChyZXN0KSkge1xuICAgIHRleHQgPSBcIm5vIFBSIGV4cGVjdGVkXCI7XG4gIH1cbiAgcmV0dXJuIHsgZXBvY2gsIGhvc3QsIHRleHQgfTtcbn1cblxuLyoqIEFwcGVuZCB0aGlzIHJlbGVhc2UgdG8gYSB0YWxseSAob3Igc3RhcnQgb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBlbmRBdHRlbXB0KFxuICBwcmV2aW91czogUmVsZWFzZUF0dGVtcHRUYWxseSB8IG51bGwsXG4gIGF0dGVtcHQ6IFJlbGVhc2VBdHRlbXB0LFxuKTogUmVsZWFzZUF0dGVtcHRUYWxseSB7XG4gIGNvbnN0IGJhc2UgPSBwcmV2aW91cyA/PyB7IHRvdGFsOiAwLCBhdHRlbXB0czogW10gfTtcbiAgLy8gT25lIHJlbGVhc2UgY2FuIGJlIGNsZWFyZWQgdHdpY2Ugd2l0aGluIHRoZSBzYW1lIG1pbnV0ZSAoaGVhcnRiZWF0XG4gIC8vIHN0b3AsIHRoZW4gY2xhaW0gcmVsZWFzZSDigJQgSXNzdWUgIzQzMzApOiB0aGF0IGlzIHRoZSBzYW1lIGF0dGVtcHQsIHNvXG4gIC8vIHRoZSBuZXdlciB0ZXh0IHJlcGxhY2VzIHRoZSBlbnRyeSBpbnN0ZWFkIG9mIGNvdW50aW5nIGFnYWluLlxuICBjb25zdCBsYXN0ID0gYmFzZS5hdHRlbXB0cy5hdCgtMSk7XG4gIGlmIChpc1NhbWVBdHRlbXB0KGxhc3QsIGF0dGVtcHQpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRvdGFsOiBiYXNlLnRvdGFsLFxuICAgICAgYXR0ZW1wdHM6IFsuLi5iYXNlLmF0dGVtcHRzLnNsaWNlKDAsIC0xKSwgYXR0ZW1wdF0uc2xpY2UoLU1BWF9BVFRFTVBUUyksXG4gICAgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHRvdGFsOiBiYXNlLnRvdGFsICsgMSxcbiAgICBhdHRlbXB0czogWy4uLmJhc2UuYXR0ZW1wdHMsIGF0dGVtcHRdLnNsaWNlKC1NQVhfQVRURU1QVFMpLFxuICB9O1xufVxuXG4vKipcbiAqIERlcml2ZSB0aGUgZGlzcGxheSBob3N0IGZyb20gYSBtYWNoaW5lIGlkIChJc3N1ZSAjMzc1MikuXG4gKlxuICogTWFjaGluZSBpZHMgYXJlIGB7aG9zdG5hbWV9LXt1dWlkfWAgKHNlZSBsaWIvbWFjaGluZV9pZC50cyksIHNvIHN0cmlwIGFcbiAqIHRyYWlsaW5nIFVVSUQgdG8gcmVjb3ZlciB0aGUgaG9zdG5hbWUuIEFueXRoaW5nIHRoYXQgZG9lcyBub3QgZW5kIGluIGEgVVVJRFxuICogaXMgc2hvd24gdmVyYmF0aW0uXG4gKlxuICogRXhwb3J0ZWQgZm9yIHRoZSBzdHJlYW0gbG9jayAoSXNzdWUgIzIzMzQpLCB3aGljaCBuYW1lcyB0aGUgaG9zdCBob2xkaW5nIGFcbiAqIG1pbGVzdG9uZSBzdHJlYW0gZnJvbSB0aGUgaGVhcnRiZWF0IG1hcmtlciBpdCBmb3VuZCBiZWF0aW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaG9zdEZyb21NYWNoaW5lSWQobWFjaGluZUlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB1dWlkID1cbiAgICAvLVswLTlhLWZdezh9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezEyfSQvaTtcbiAgcmV0dXJuIG1hY2hpbmVJZC5yZXBsYWNlKHV1aWQsIFwiXCIpO1xufVxuXG4vKiogUmVuZGVyIGFuIGVwb2NoIGFzIGBISDpNTSBVVENgLiAqL1xuZnVuY3Rpb24gZm9ybWF0Q2xvY2soZXBvY2g6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtmb3JtYXRNaWxlc3RvbmVUaW1lKGVwb2NoKX0gVVRDYDtcbn1cblxuLyoqXG4gKiBSZW5kZXIgaG93IGxvbmcgYWdvIGBlcG9jaGAgd2FzLCBhcyBhIHNob3J0IGh1bWFuIHBocmFzZSAoSXNzdWUgIzM3NTIpLlxuICpcbiAqIEEgY2xvY2sgdGhhdCBydW5zIGJhY2t3YXJkcyBpcyBjbGFtcGVkIHRvIHplcm8gc28gdGhlIGJvZHkgbmV2ZXIgc2hvd3MgYVxuICogbmVnYXRpdmUgZHVyYXRpb24uXG4gKi9cbmZ1bmN0aW9uIGZvcm1hdEVsYXBzZWQoZXBvY2g6IG51bWJlciwgbm93OiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBzZWNvbmRzID0gTWF0aC5tYXgoMCwgbm93IC0gZXBvY2gpO1xuICBpZiAoc2Vjb25kcyA8IDYwKSByZXR1cm4gXCJqdXN0IG5vd1wiO1xuICByZXR1cm4gYCR7Zm9ybWF0RHVyYXRpb24oc2Vjb25kcyl9IGFnb2A7XG59XG5cbi8qKlxuICogUmVuZGVyIGEgZHVyYXRpb24gaW4gc2Vjb25kcyBhcyB0aGUgc2hvcnQgcGhyYXNlIHRoZSBlbGFwc2VkIGNsYXVzZSB1c2VzXG4gKiAoYDU4IG1pbmAsIGAyIGhgLCBgMyBkYDsgdW5kZXIgYSBtaW51dGUg4oaSIGB1bmRlciAxIG1pbmApLiBTaGFyZWQgd2l0aFxuICoge0BsaW5rIGZvcm1hdEVsYXBzZWR9IHNvIHRoZSB0d28gY2Fubm90IGRyaWZ0IChJc3N1ZSAjNDMyNikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXREdXJhdGlvbihzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBzID0gTWF0aC5tYXgoMCwgc2Vjb25kcyk7XG4gIGlmIChzIDwgNjApIHJldHVybiBcInVuZGVyIDEgbWluXCI7XG4gIGlmIChzIDwgMzYwMCkgcmV0dXJuIGAke01hdGguZmxvb3IocyAvIDYwKX0gbWluYDtcbiAgaWYgKHMgPCA4NjQwMCkgcmV0dXJuIGAke01hdGguZmxvb3IocyAvIDM2MDApfSBoYDtcbiAgcmV0dXJuIGAke01hdGguZmxvb3IocyAvIDg2NDAwKX0gZGA7XG59XG5cbi8qKlxuICogTG9uZ2VzdCByZW5kZXJlZCBvdXRjb21lIGJsb2NrIChJc3N1ZSAjNDMyNik6IGEgYnJpZWYgbGluZSwgbm90IGEgbG9nIGR1bXAuXG4gKlxuICogUmFpc2VkIGZyb20gNjAwIGZvciB0aGUgcHJlc2VydmVkLWJyYW5jaCBsaW5lIChJc3N1ZSAjNzcwKTogdGhlIGJyYW5jaCBuYW1lXG4gKiBhbmQgaXRzIGhhbmRvdmVyIGxpbmsgbXVzdCBmaXQgd2hvbGUgYmVzaWRlIHRoZSBkaWFnbm9zaXMsIGJlY2F1c2UgaGFsZiBhXG4gKiByZWYgb3IgaGFsZiBhIFVSTCBpcyB3b3JzZSB0aGFuIG5vbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBPVVRDT01FX0JMT0NLX01BWF9MRU5HVEggPSA5MDA7XG4vKiogTG9uZ2VzdCByYXctbWVzc2FnZSBleGNlcnB0IGluc2lkZSB0aGUgb3V0Y29tZSBibG9jay4gKi9cbmV4cG9ydCBjb25zdCBPVVRDT01FX0RFVEFJTF9NQVhfTEVOR1RIID0gMjAwO1xuLyoqXG4gKiBMb25nZXN0IHByZXNlcnZlZC1icmFuY2ggbGluZSAoSXNzdWUgIzc3MCkuIFdpZGVyIHRoYW4gYSBkZXRhaWwgZXhjZXJwdFxuICogYmVjYXVzZSBpdCBjYXJyaWVzIGEgYnJhbmNoIG5hbWUgYW5kIGEgaGFuZG92ZXIgbGluaywgYW5kIHRydW5jYXRpbmcgaXRcbiAqIHdvdWxkIHBvaW50IGEgcmVhZGVyIGF0IGhhbGYgYSByZWYuXG4gKi9cbmV4cG9ydCBjb25zdCBPVVRDT01FX1dJUF9NQVhfTEVOR1RIID0gNDAwO1xuXG4vKipcbiAqIFRoZSBgKipXb3JrIGluIHByb2dyZXNzOioqYCBsaW5lIGZvciBhIHByZXNlcnZlZCBicmFuY2ggKElzc3VlICM3NzApLlxuICpcbiAqIEEgbGluZSB0aGF0IGRvZXMgbm90IGZpdCBkcm9wcyB0aGUgaGFuZG92ZXIgY2xhdXNlIGFuZCBrZWVwcyB0aGUgYnJhbmNoOlxuICogaGFsZiBhIFVSTCBpcyBhIGJyb2tlbiBsaW5rLCBhbmQgdGhlIGJyYW5jaCBpcyB0aGUgcGFydCBhIHJlYWRlciBjYW5ub3QgZG9cbiAqIHdpdGhvdXQuIE9ubHkgYSBicmFuY2ggbmFtZSBsb25nIGVub3VnaCB0byBibG93IHRoZSBib3VuZCBvbiBpdHMgb3duIGlzXG4gKiBldmVyIHRydW5jYXRlZC5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyUHJlc2VydmVkV2lwQ2xhdXNlKHByZXNlcnZlZDogUHJlc2VydmVkV2lwKTogc3RyaW5nIHtcbiAgY29uc3QgZnVsbCA9IGRlc2NyaWJlUHJlc2VydmVkQnJhbmNoKHByZXNlcnZlZCk7XG4gIGNvbnN0IHRleHQgPSBmdWxsLmxlbmd0aCA8PSBPVVRDT01FX1dJUF9NQVhfTEVOR1RIXG4gICAgPyBmdWxsXG4gICAgOiBkZXNjcmliZVByZXNlcnZlZEJyYW5jaCh7IGJyYW5jaDogcHJlc2VydmVkLmJyYW5jaCB9KTtcbiAgcmV0dXJuIGBcXG4qKldvcmsgaW4gcHJvZ3Jlc3M6KiogJHtcbiAgICBib3VuZE91dGNvbWVUZXh0KHRleHQsIE9VVENPTUVfV0lQX01BWF9MRU5HVEgpXG4gIH1gO1xufVxuXG4vKipcbiAqIEZsYXR0ZW4gYW5kIGJvdW5kIGZyZWUgdGV4dCBzcGxpY2VkIGludG8gdGhlIHJlbGVhc2UgYm9keSAoSXNzdWUgIzQzMjYpLlxuICogV2hpdGVzcGFjZSBjb2xsYXBzZXMgdG8gc2luZ2xlIHNwYWNlcywgSFRNTC1jb21tZW50IGRlbGltaXRlcnMgYXJlXG4gKiBuZXV0cmFsaXNlZCBzbyBhIGZhaWx1cmUgbWVzc2FnZSBjYW4gbmV2ZXIgb3BlbiBvciBjbG9zZSBhIGNvbW1lbnQgYW5kXG4gKiBwdXNoIHRoZSBtYXJrZXIgb2ZmIGl0cyBsaW5lLCBhbmQgdGhlIHJlc3VsdCBpcyB0cnVuY2F0ZWQgd2l0aCBhblxuICogZWxsaXBzaXMg4oCUIHRoZSBzYW1lIGRpc2NpcGxpbmUgYXMge0BsaW5rIG5vcm1hbGlzZU1pbGVzdG9uZVRleHR9LlxuICovXG5mdW5jdGlvbiBib3VuZE91dGNvbWVUZXh0KHRleHQ6IHN0cmluZywgbWF4TGVuZ3RoOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBmbGF0ID0gbmV1dHJhbGlzZUNvbW1lbnREZWxpbWl0ZXJzKHRleHQpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKTtcbiAgaWYgKGZsYXQubGVuZ3RoIDw9IG1heExlbmd0aCkgcmV0dXJuIGZsYXQ7XG4gIHJldHVybiBgJHtmbGF0LnN1YnN0cmluZygwLCBNYXRoLm1heCgwLCBtYXhMZW5ndGggLSAxKSl94oCmYDtcbn1cblxuLyoqXG4gKiBSZW5kZXIgdGhlIHJ1biBvdXRjb21lIGNsYXVzZSBvZiBhIHJlbGVhc2VkIGJvZHkgKElzc3VlICM0MzI2LCBwYXJ0IG9mXG4gKiAjNDI5MSkuIFJldHVybnMgdGhlIHRleHQgdGhhdCBmb2xsb3dzIGBmaW5pc2hlZCBISDpNTSBVVEMuYCBmb3IgYSBQUiBvclxuICogYSBkZWxpYmVyYXRlIG5vLVBSLCBvciB0aGUgbXVsdGktbGluZSBibG9jayBmb3IgYSBmYWlsdXJlLiBLZXB0IGJvdW5kZWRcbiAqIGJ5IHtAbGluayBPVVRDT01FX0JMT0NLX01BWF9MRU5HVEh9LlxuICpcbiAqIFRoZSBmYWlsdXJlIGNsYXNzIGFuZCBvbmUtbGluZSBkaWFnbm9zaXMgY29tZSBmcm9tIGZhaWx1cmVfZGlhZ25vc2lzLnRzXG4gKiAoYGdldEZhaWx1cmVDYXRlZ29yeURpc3BsYXlgLCBgZ2V0RmFpbHVyZURpYWdub3Npc09uZWxpbmVyYCkgc28gdGhlXG4gKiByZWxlYXNlIGNvbW1lbnQgaW5oZXJpdHMgIzQyOTgncyBjb3JyZWN0ZWQgZGlhZ25vc2lzIHJhdGhlciB0aGFuXG4gKiBkdXBsaWNhdGluZyBpdC5cbiAqXG4gKiBPdXRjb21lIG5vdGVzIChJc3N1ZSAjMjEwKSBmb2xsb3cgdGhlIGNsYXVzZSBvbiB0aGVpciBvd24gbGluZSwgd2hhdGV2ZXJcbiAqIHRoZSBvdXRjb21lIGtpbmQ6IGEgcnVuIGNhbiByYWlzZSBhIFBSIGFuZCBzdGlsbCBoYXZlIG5hbWVkIGEgZm9sbG93LXVwXG4gKiByZWZlcmVuY2UgdGhhdCBkb2VzIG5vdCBleGlzdCwgYW5kIGEgaHVtYW4gbXVzdCBzZWUgdGhhdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclJ1bk91dGNvbWVDbGF1c2Uob3V0Y29tZTogUnVuT3V0Y29tZSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtyZW5kZXJPdXRjb21lS2luZENsYXVzZShvdXRjb21lKX0ke3JlbmRlck91dGNvbWVOb3RlcyhvdXRjb21lKX1gO1xufVxuXG4vKiogTG9uZ2VzdCBudW1iZXIgb2Ygbm90ZXMgcmVuZGVyZWQg4oCUIGEgYnJpZWYgbGluZSwgbm90IGEgbG9nIGR1bXAuICovXG5jb25zdCBNQVhfT1VUQ09NRV9OT1RFUyA9IDM7XG5cbi8qKiBUaGUgYCoqTm90ZToqKmAgbGluZSBmb3IgYSBydW4ncyBvdXRjb21lIG5vdGVzLCBvciBcIlwiIHdoZW4gaXQgaGFzIG5vbmUuICovXG5mdW5jdGlvbiByZW5kZXJPdXRjb21lTm90ZXMob3V0Y29tZTogUnVuT3V0Y29tZSk6IHN0cmluZyB7XG4gIGNvbnN0IG5vdGVzID0gKG91dGNvbWUubm90ZXMgPz8gW10pXG4gICAgLm1hcCgobm90ZSkgPT4gYm91bmRPdXRjb21lVGV4dChub3RlLCBPVVRDT01FX0RFVEFJTF9NQVhfTEVOR1RIKSlcbiAgICAuZmlsdGVyKChub3RlKSA9PiBub3RlICE9PSBcIlwiKVxuICAgIC5zbGljZSgwLCBNQVhfT1VUQ09NRV9OT1RFUyk7XG4gIHJldHVybiBub3Rlcy5sZW5ndGggPT09IDAgPyBcIlwiIDogYFxcbioqTm90ZToqKiAke25vdGVzLmpvaW4oXCI7IFwiKX1gO1xufVxuXG4vKiogVGhlIGtpbmQtc3BlY2lmaWMgY2xhdXNlLCB3aXRob3V0IG5vdGVzLiAqL1xuZnVuY3Rpb24gcmVuZGVyT3V0Y29tZUtpbmRDbGF1c2Uob3V0Y29tZTogUnVuT3V0Y29tZSk6IHN0cmluZyB7XG4gIHN3aXRjaCAob3V0Y29tZS5raW5kKSB7XG4gICAgY2FzZSBcInByXCI6IHtcbiAgICAgIGNvbnN0IHVybCA9IGJvdW5kT3V0Y29tZVRleHQob3V0Y29tZS5wclVybCwgT1VUQ09NRV9ERVRBSUxfTUFYX0xFTkdUSCk7XG4gICAgICBpZiAoIW91dGNvbWUuYmxvY2tlZCkgcmV0dXJuIGAgUmFpc2VkICMke291dGNvbWUucHJOdW1iZXJ9IOKAlCAke3VybH1gO1xuICAgICAgLy8gSXNzdWUgIzIwNDQg4oCUIHRoZSB3b3JrIHJlYWNoZWQgdGhlIFBSIGFuZCBhIGxhdGVyIHN0ZXAgdGhlbiBmYWlsZWRcbiAgICAgIC8vIHRoZSBydW4uIE5hbWUgYm90aCBoYWx2ZXM6IHRoZSBQUiwgc28gbm9ib2R5IHJlZG9lcyBkZWxpdmVyZWQgd29yayxcbiAgICAgIC8vIGFuZCB0aGUgYmxvY2ssIHNvIHRoZSBvdXRzdGFuZGluZyBmaW5kaW5nIGlzIGZpeGFibGUgb24gdGhhdCBQUi5cbiAgICAgIGNvbnN0IGRpc3BsYXkgPSBnZXRGYWlsdXJlQ2F0ZWdvcnlEaXNwbGF5KG91dGNvbWUuYmxvY2tlZC5jYXRlZ29yeSk7XG4gICAgICBjb25zdCBwaGFzZSA9IGJvdW5kT3V0Y29tZVRleHQob3V0Y29tZS5ibG9ja2VkLnBoYXNlLCA2MCk7XG4gICAgICBjb25zdCBkZXRhaWwgPSBib3VuZE91dGNvbWVUZXh0KFxuICAgICAgICBvdXRjb21lLmJsb2NrZWQucmVhc29uLFxuICAgICAgICBPVVRDT01FX0RFVEFJTF9NQVhfTEVOR1RILFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGJsb2NrID0gYCBSYWlzZWQgIyR7b3V0Y29tZS5wck51bWJlcn0g4oCUICR7dXJsfS5cXG5gICtcbiAgICAgICAgYCoqT3V0Y29tZToqKiBQUiByYWlzZWQsIHRoZW4gYmxvY2tlZCBpbiBwaGFzZSBcXGAke3BoYXNlfVxcYCDigJQgYCArXG4gICAgICAgIGBcXGAke2Rpc3BsYXl9XFxgLiBGaXggdGhlIGZpbmRpbmcgb24gdGhhdCBQUjsgdGhlIHdvcmsgaXMgbm90IGxvc3QuYCArXG4gICAgICAgIChkZXRhaWwgPyBgXFxuKipEZXRhaWw6KiogJHtkZXRhaWx9YCA6IFwiXCIpO1xuICAgICAgcmV0dXJuIGJsb2NrLmxlbmd0aCA8PSBPVVRDT01FX0JMT0NLX01BWF9MRU5HVEhcbiAgICAgICAgPyBibG9ja1xuICAgICAgICA6IGAke2Jsb2NrLnN1YnN0cmluZygwLCBPVVRDT01FX0JMT0NLX01BWF9MRU5HVEggLSAxKX3igKZgO1xuICAgIH1cbiAgICBjYXNlIFwibm9fcHJfZXhwZWN0ZWRcIjoge1xuICAgICAgY29uc3Qgc3VtbWFyeSA9IGJvdW5kT3V0Y29tZVRleHQoXG4gICAgICAgIG91dGNvbWUuc3VtbWFyeSxcbiAgICAgICAgT1VUQ09NRV9ERVRBSUxfTUFYX0xFTkdUSCxcbiAgICAgICk7XG4gICAgICByZXR1cm4gYCAke3N1bW1hcnl9IChubyBQUiBleHBlY3RlZCBmb3IgdGhpcyBwaGFzZS4pYDtcbiAgICB9XG4gICAgY2FzZSBcInN1cGVyc2VkZWRcIjoge1xuICAgICAgLy8gSXNzdWUgIzIxOCDigJQgYSBzaWJsaW5nJ3MgUFIgcmVzb2x2ZWQgdGhlIGlzc3VlIG1pZC1ydW4uIFNheSBzb1xuICAgICAgLy8gcGxhaW5seSwgYW5kIG5hbWUgdGhlIGJyYW5jaCB0aGUgcHJlc2VydmVkIFdJUCBpcyBvbiBzbyB0aGUgd29ya1xuICAgICAgLy8gdGhpcyBydW4gZGlkIGRvIGlzIGZpbmRhYmxlIHJhdGhlciB0aGFuIHNpbGVudGx5IG9ycGhhbmVkLlxuICAgICAgY29uc3QgdXJsID0gYm91bmRPdXRjb21lVGV4dChvdXRjb21lLnByVXJsLCBPVVRDT01FX0RFVEFJTF9NQVhfTEVOR1RIKTtcbiAgICAgIGNvbnN0IHZlcmIgPSBvdXRjb21lLnByU3RhdGUgPT09IFwiTUVSR0VEXCIgPyBcIm1lcmdlZFwiIDogXCJjbG9zZWRcIjtcbiAgICAgIGNvbnN0IHdpcCA9IG91dGNvbWUud2lwTm90ZVxuICAgICAgICA/IGAgJHtib3VuZE91dGNvbWVUZXh0KG91dGNvbWUud2lwTm90ZSwgT1VUQ09NRV9ERVRBSUxfTUFYX0xFTkdUSCl9LmBcbiAgICAgICAgOiBcIlwiO1xuICAgICAgcmV0dXJuIGAgU3VwZXJzZWRlZCBieSAke3ZlcmJ9ICMke291dGNvbWUucHJOdW1iZXJ9IOKAlCAke3VybH1gICtcbiAgICAgICAgYCAodGhpcyBydW4gcmFpc2VkIG5vIFBSKS4ke3dpcH1gO1xuICAgIH1cbiAgICBjYXNlIFwic3VtbWFyeV9pbmNvbXBsZXRlXCI6IHtcbiAgICAgIC8vIElzc3VlICMxMTQwIOKAlCB0aGUgd29yayByZWFjaGVkIGEgUFIgYW5kIHRoZSBzdW1tYXJ5IGRpZCBub3QgY2xvc2UgYVxuICAgICAgLy8gZG9jdW1lbnQgcnVsZSBvdXQuIE5hbWUgYm90aDogdGhlIFBSLCBzbyB0aGUgcmVhZGVyIGNhbiBzZWUgdGhlIHdvcmtcbiAgICAgIC8vIGxhbmRlZCwgYW5kIHRoZSBydWxlLCBzbyB0aGUgc2hvcnRmYWxsIGlzIGZpeGFibGUgcmF0aGVyIHRoYW5cbiAgICAgIC8vIG15c3RlcmlvdXMuXG4gICAgICBjb25zdCB1cmwgPSBib3VuZE91dGNvbWVUZXh0KG91dGNvbWUucHJVcmwsIE9VVENPTUVfREVUQUlMX01BWF9MRU5HVEgpO1xuICAgICAgY29uc3QgcHJvYmxlbSA9IGJvdW5kT3V0Y29tZVRleHQoXG4gICAgICAgIG91dGNvbWUucHJvYmxlbSxcbiAgICAgICAgT1VUQ09NRV9ERVRBSUxfTUFYX0xFTkdUSCxcbiAgICAgICk7XG4gICAgICByZXR1cm4gYCBSYWlzZWQgIyR7b3V0Y29tZS5wck51bWJlcn0g4oCUICR7dXJsfS4gVGhlIFBSIHN1bW1hcnkgaXNgICtcbiAgICAgICAgYCBpbmNvbXBsZXRlOiAke3Byb2JsZW19YDtcbiAgICB9XG4gICAgY2FzZSBcInByX2RlZmVycmVkXCI6IHtcbiAgICAgIC8vIElzc3VlICMxOTUxIOKAlCB0aGUgd29yayBpcyBmaW5pc2hlZCBhbmQgcHVzaGVkOyBHaXRIdWInc1xuICAgICAgLy8gY29udGVudC1jcmVhdGlvbiB0aHJvdHRsZSByZWZ1c2VkIHRoZSBQUiBmb3IgbG9uZ2VyIHRoYW4gdGhlIHJ1biBoYWRcbiAgICAgIC8vIGxlZnQuIE5hbWUgdGhlIGJyYW5jaCBhbmQgc2F5IHRoZSBQUiBpcyBwZW5kaW5nLCBzbyBhIHJlYWRlciBrbm93c1xuICAgICAgLy8gbm90aGluZyB3YXMgbG9zdCBhbmQgbm8gb25lIG5lZWRzIHRvIHJlZG8gaXQuXG4gICAgICBjb25zdCByZWFzb24gPSBib3VuZE91dGNvbWVUZXh0KFxuICAgICAgICBvdXRjb21lLnJlYXNvbixcbiAgICAgICAgT1VUQ09NRV9ERVRBSUxfTUFYX0xFTkdUSCxcbiAgICAgICk7XG4gICAgICBjb25zdCBicmFuY2ggPSBib3VuZE91dGNvbWVUZXh0KG91dGNvbWUuYnJhbmNoLCAyMDApO1xuICAgICAgY29uc3QgYmFzZSA9IGJvdW5kT3V0Y29tZVRleHQob3V0Y29tZS5iYXNlLCAyMDApO1xuICAgICAgcmV0dXJuIGAgJHtQUl9QRU5ESU5HX01BUktFUn0gUFIgcGVuZGluZyDigJQgdGhlIHdvcmsgaXMgb25gICtcbiAgICAgICAgYCBcXGAke2JyYW5jaH1cXGAgYW5kIHRoZSBwdWxsIHJlcXVlc3QgKFxcYCR7YnJhbmNofVxcYCDihpIgXFxgJHtiYXNlfVxcYClgICtcbiAgICAgICAgYCBpcyBxdWV1ZWQgZm9yIHRoZSBuZXh0IGN5Y2xlLiBHaXRIdWIncyBzZWNvbmRhcnlgICtcbiAgICAgICAgYCAoY29udGVudC1jcmVhdGlvbikgcmF0ZSBsaW1pdCByZWZ1c2VkIGl0OiAke3JlYXNvbn1gO1xuICAgIH1cbiAgICBjYXNlIFwiY2xhaW1fc3RhbGVcIjoge1xuICAgICAgLy8gSXNzdWUgIzM0NCDigJQgdGhlIGNsYWltIHdhcyBmaW5lIHdoZW4gaXQgd2FzIHRha2VuIGFuZCBzdGFsZSBieSB0aGVcbiAgICAgIC8vIHRpbWUgdGhlIFBSIHdvdWxkIGhhdmUgZ29uZSB1cC4gTmFtZSB0aGUgYnJhbmNoOiBpdCBpcyB0aGUgb25seSBwbGFjZVxuICAgICAgLy8gdGhlIHdvcmsgbm93IGxpdmVzLCBhbmQgYSByZWFkZXIgbXVzdCBiZSBhYmxlIHRvIGZpbmQgaXQuXG4gICAgICBjb25zdCBkZXRhaWwgPSBib3VuZE91dGNvbWVUZXh0KFxuICAgICAgICBvdXRjb21lLmRldGFpbCxcbiAgICAgICAgT1VUQ09NRV9ERVRBSUxfTUFYX0xFTkdUSCxcbiAgICAgICk7XG4gICAgICBjb25zdCBicmFuY2ggPSBvdXRjb21lLmJyYW5jaFxuICAgICAgICA/IGAgVGhlIHdvcmsgaXMgb24gXFxgJHtib3VuZE91dGNvbWVUZXh0KG91dGNvbWUuYnJhbmNoLCAyMDApfVxcYC5gXG4gICAgICAgIDogXCJcIjtcbiAgICAgIGNvbnN0IHByID0gb3V0Y29tZS5wclVybFxuICAgICAgICA/IGAgU2VlICR7Ym91bmRPdXRjb21lVGV4dChvdXRjb21lLnByVXJsLCBPVVRDT01FX0RFVEFJTF9NQVhfTEVOR1RIKX0uYFxuICAgICAgICA6IFwiXCI7XG4gICAgICByZXR1cm4gYCBObyBQUiByYWlzZWQg4oCUIHRoZSBjbGFpbSB3ZW50IHN0YWxlOiAke2RldGFpbH0uJHticmFuY2h9JHtwcn1gO1xuICAgIH1cbiAgICBjYXNlIFwibm9fcHJcIjoge1xuICAgICAgY29uc3QgZGlzcGxheSA9IGdldEZhaWx1cmVDYXRlZ29yeURpc3BsYXkob3V0Y29tZS5jYXRlZ29yeSk7XG4gICAgICAvLyBBIHRpbWVvdXQga2lsbCBleHBsYWlucyBpdHNlbGYgaGVyZSAoSXNzdWUgIzc2OCk6IHRoZSBvbmUtbGluZXJcbiAgICAgIC8vIHN0YXRlcyB0aGUgZXh0ZW5zaW9uIHRlbGVtZXRyeSB0aGUgcnVuIGNhcnJpZWQsIHNvIGFuIG9wZXJhdG9yIHJlYWRzXG4gICAgICAvLyB0aGUgZ3JhbnRzIGFuZCB0aGUgbGFzdCByZWZ1c2FsIG9mZiB0aGUgcmVsZWFzZSBjb21tZW50LlxuICAgICAgY29uc3Qgb25lbGluZXIgPSBnZXRGYWlsdXJlRGlhZ25vc2lzT25lbGluZXIoXG4gICAgICAgIG91dGNvbWUuY2F0ZWdvcnksXG4gICAgICAgIFwibm90X2Fzc2Vzc2VkXCIsXG4gICAgICAgIG91dGNvbWUuZXh0ZW5zaW9ucyxcbiAgICAgICk7XG4gICAgICBjb25zdCBwaGFzZSA9IGJvdW5kT3V0Y29tZVRleHQob3V0Y29tZS5waGFzZSwgNjApO1xuICAgICAgY29uc3QgZGV0YWlsID0gYm91bmRPdXRjb21lVGV4dChcbiAgICAgICAgb3V0Y29tZS5tZXNzYWdlLFxuICAgICAgICBPVVRDT01FX0RFVEFJTF9NQVhfTEVOR1RILFxuICAgICAgKTtcbiAgICAgIC8vIFdoZXJlIHRoZSB3b3JrIGlzIChJc3N1ZSAjNzcwKSwgb24gaXRzIG93biBsaW5lIGFuZCBCRUZPUkUgdGhlIHJhd1xuICAgICAgLy8gZGV0YWlsOiBhIHJlYWRlciBtdXN0IGJlIGFibGUgdG8gZmluZCB0aGUgcHJlc2VydmVkIGJyYW5jaCBldmVuIHdoZW5cbiAgICAgIC8vIHRoZSBtZXNzYWdlIHRhaWwgaXMgdHJpbW1lZCB0byBrZWVwIHRoZSBibG9jayBib3VuZGVkLlxuICAgICAgY29uc3Qgd2lwID0gb3V0Y29tZS5wcmVzZXJ2ZWRXaXBcbiAgICAgICAgPyByZW5kZXJQcmVzZXJ2ZWRXaXBDbGF1c2Uob3V0Y29tZS5wcmVzZXJ2ZWRXaXApXG4gICAgICAgIDogXCJcIjtcbiAgICAgIGNvbnN0IGJsb2NrID0gYFxcbioqT3V0Y29tZToqKiBubyBQUiByYWlzZWQg4oCUIFxcYCR7ZGlzcGxheX1cXGAuXFxuYCArXG4gICAgICAgIGAqKkRpYWdub3NpczoqKiBkaWVkIGluIHBoYXNlIFxcYCR7cGhhc2V9XFxgIGFmdGVyICR7XG4gICAgICAgICAgZm9ybWF0RHVyYXRpb24ob3V0Y29tZS5lbGFwc2VkU2Vjb25kcylcbiAgICAgICAgfS4gJHtvbmVsaW5lcn1gICsgd2lwICtcbiAgICAgICAgKGRldGFpbCA/IGBcXG4qKkRldGFpbDoqKiAke2RldGFpbH1gIDogXCJcIik7XG4gICAgICByZXR1cm4gYmxvY2subGVuZ3RoIDw9IE9VVENPTUVfQkxPQ0tfTUFYX0xFTkdUSFxuICAgICAgICA/IGJsb2NrXG4gICAgICAgIDogYCR7YmxvY2suc3Vic3RyaW5nKDAsIE9VVENPTUVfQkxPQ0tfTUFYX0xFTkdUSCAtIDEpfeKApmA7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGZ1bGwgaGVhcnRiZWF0IGNvbW1lbnQgYm9keSAoSXNzdWVzICMzNzUyLCAjMzc1MykuXG4gKlxuICogQSBoZWFydGJlYXQgbWFya2VyIHVzZWQgdG8gYmUgYSBiYXJlIEhUTUwgY29tbWVudCwgc28gR2l0SHViIHJlbmRlcmVkIGl0IGFzXG4gKiBhIGNvbXBsZXRlbHkgYmxhbmsgY29tbWVudCBib3guIFRoZSBtYWNoaW5lLXJlYWRhYmxlIG1hcmtlciBzdGlsbCBjb21lc1xuICogZmlyc3QgYW5kIHVuY2hhbmdlZCDigJQgZXZlcnkgcGFyc2VyIGtleXMgb2ZmIHRoYXQg4oCUIGZvbGxvd2VkIGJ5IHZpc2libGVcbiAqIHN0YXR1cyB0ZXh0IGFuZCB0aGUgcm9sbGluZyBwcm9ncmVzcyBsb2cuXG4gKlxuICogVGltZXN0YW1wcyBjb21lIGZyb20gYG5vd0ZuYCByYXRoZXIgdGhhbiBgRGF0ZS5ub3coKWAgc28gdGhlIGJvZHkgaXNcbiAqIGRldGVybWluaXN0aWMgdW5kZXIgdGVzdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckhlYXJ0YmVhdEJvZHkoXG4gIGZpZWxkczogSGVhcnRiZWF0Qm9keUZpZWxkcyxcbiAgbm93Rm46ICgpID0+IG51bWJlciA9ICgpID0+IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgaG9zdCA9IGZpZWxkcy5ob3N0ID8/IGhvc3RGcm9tTWFjaGluZUlkKGZpZWxkcy5tYWNoaW5lSWQpO1xuICBjb25zdCBsb2cgPSBmb3JtYXRNaWxlc3RvbmVMb2coZmllbGRzLm1pbGVzdG9uZXMgPz8gW10pO1xuXG4gIGlmIChmaWVsZHMucmVsZWFzZWQpIHtcbiAgICAvLyBUaGUgbWFjaGluZS1yZWFkYWJsZSBtYXJrZXIgbGluZSBzdGF5cyBmaXJzdCBhbmQgdW5jaGFuZ2VkOiBldmVyeVxuICAgIC8vIHBhcnNlciBrZXlzIG9mZiBpdCwgYW5kIGBwYXJzZUhlYXJ0YmVhdE1hcmtlcmAgbmVlZHMgZXBvY2ggMCBwbHVzXG4gICAgLy8gdGhlIGBjbGVhcmVkOmAgY29tbWVudCBpbiB0aGUgc2FtZSBib2R5LlxuICAgIGNvbnN0IG1hcmtlciA9IGAke2Zvcm1hdEhlYXJ0YmVhdE1hcmtlcihmaWVsZHMubWFjaGluZUlkLCAwKX0gYCArXG4gICAgICBgPCEtLSBjbGVhcmVkOiBjbGFpbSByZWxlYXNlZCBieSBtYWNoaW5lICR7ZmllbGRzLm1hY2hpbmVJZH0gLS0+YDtcbiAgICBjb25zdCBmaW5pc2hlZCA9IGBob3N0IFxcYCR7aG9zdH1cXGAsIGZpbmlzaGVkICR7Zm9ybWF0Q2xvY2sobm93Rm4oKSl9LmA7XG4gICAgY29uc3Qgb3V0Y29tZSA9IGZpZWxkcy5vdXRjb21lO1xuICAgIC8vIFJlcGVhdGVkIGF0dGVtcHRzIGNvbGxhcHNlIGludG8gdGhpcyBvbmUgY29tbWVudCAoSXNzdWUgIzQzMjcpOiB0aGVcbiAgICAvLyB0YWxseSBmb2xsb3dzIHRoZSBvdXRjb21lIGFuZCBwcmVjZWRlcyB0aGUgcHJvZ3Jlc3MgbG9nLlxuICAgIGNvbnN0IHRhbGx5ID0gZmllbGRzLmF0dGVtcHRzID8gZm9ybWF0QXR0ZW1wdEJsb2NrKGZpZWxkcy5hdHRlbXB0cykgOiBcIlwiO1xuICAgIGlmICghb3V0Y29tZSkge1xuICAgICAgLy8gTm8gb3V0Y29tZSAoc2tpcCBhZnRlciBjbGFpbSwgbGVnYWN5IGNhbGxlcnMpOiB0b2RheSdzIHRleHQsIGJ5dGVcbiAgICAgIC8vIGZvciBieXRlLlxuICAgICAgcmV0dXJuIGAke21hcmtlcn1cXG5cXG7inIUgKipWaWJlIENvZGVyIHJlbGVhc2VkIHRoaXMgY2xhaW0qKiDigJQgYCArXG4gICAgICAgIGAke2ZpbmlzaGVkfSR7dGFsbHl9JHtsb2d9YDtcbiAgICB9XG4gICAgLy8gVGhlIHJ1biBvdXRjb21lIChJc3N1ZSAjNDMyNiwgcGFydCBvZiAjNDI5MSk6IGEgUFIgbGluaywgYSBkZWxpYmVyYXRlXG4gICAgLy8gbm8tUFIsIG9yIGEgZmFpbHVyZSBjbGFzcyArIGJyaWVmIGRpYWdub3Npcy5cbiAgICBpZiAob3V0Y29tZS5raW5kID09PSBcIm5vX3ByXCIpIHtcbiAgICAgIHJldHVybiBgJHttYXJrZXJ9XFxuXFxu4pqg77iPICoqVmliZSBDb2RlciByZWxlYXNlZCB0aGlzIGNsYWltIHdpdGggbm8gUFIqKiDigJQgYCArXG4gICAgICAgIGAke2ZpbmlzaGVkfSR7cmVuZGVyUnVuT3V0Y29tZUNsYXVzZShvdXRjb21lKX0ke3RhbGx5fSR7bG9nfWA7XG4gICAgfVxuICAgIHJldHVybiBgJHttYXJrZXJ9XFxuXFxu4pyFICoqVmliZSBDb2RlciByZWxlYXNlZCB0aGlzIGNsYWltKiog4oCUIGAgK1xuICAgICAgYCR7ZmluaXNoZWR9JHtyZW5kZXJSdW5PdXRjb21lQ2xhdXNlKG91dGNvbWUpfSR7dGFsbHl9JHtsb2d9YDtcbiAgfVxuXG4gIGNvbnN0IHdobyA9IGZpZWxkcy53b3JrZXJJZFxuICAgID8gYGhvc3QgXFxgJHtob3N0fVxcYCwgd29ya2VyIFxcYCR7ZmllbGRzLndvcmtlcklkfVxcYGBcbiAgICA6IGBob3N0IFxcYCR7aG9zdH1cXGBgO1xuICBjb25zdCBlbGFwc2VkID0gZm9ybWF0RWxhcHNlZChmaWVsZHMuZXBvY2gsIG5vd0ZuKCkpO1xuICBjb25zdCBiZWF0ID0gZmllbGRzLnN0YXJ0ZWRFcG9jaFxuICAgID8gYFN0YXJ0ZWQgJHtmb3JtYXRDbG9jayhmaWVsZHMuc3RhcnRlZEVwb2NoKX0sIGAgK1xuICAgICAgYGxhc3QgYmVhdCAke2Zvcm1hdENsb2NrKGZpZWxkcy5lcG9jaCl9ICgke2VsYXBzZWR9KWBcbiAgICA6IGBMYXN0IGJlYXQgJHtmb3JtYXRDbG9jayhmaWVsZHMuZXBvY2gpfSAoJHtlbGFwc2VkfSlgO1xuXG4gIHJldHVybiBgJHtmb3JtYXRIZWFydGJlYXRNYXJrZXIoZmllbGRzLm1hY2hpbmVJZCwgZmllbGRzLmVwb2NoKX1cXG5cXG5gICtcbiAgICBg8J+kliAqKlZpYmUgQ29kZXIgd29ya2luZyoqIG9uICR7d2hvfSDigJQgJHtiZWF0fS4ke2xvZ31gO1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIGhlYXJ0YmVhdCBtYXJrZXIgYm9keS5cbiAqXG4gKiBXcmFwcyB0aGUgaWRlbnRpZmllciBhbmQgZXBvY2ggaW5zaWRlIGFuIEhUTUwgY29tbWVudCBzbyBpdCBpcyBpbnZpc2libGVcbiAqIG9uIHRoZSByZW5kZXJlZCBHaXRIdWIgaXNzdWUgcGFnZSBidXQgc3RpbGwgc2VhcmNoYWJsZSBpbiB0aGUgcmF3IGNvbW1lbnRcbiAqIGJvZHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRIZWFydGJlYXRNYXJrZXIoXG4gIG1hY2hpbmVJZDogc3RyaW5nLFxuICBlcG9jaDogbnVtYmVyLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGA8IS0tICR7SEVBUlRCRUFUX01BUktFUl9QUkVGSVh9OiR7bWFjaGluZUlkfToke2Vwb2NofSAtLT5gO1xufVxuXG4vKipcbiAqIFBhcnNlIGEgc2luZ2xlIGhlYXJ0YmVhdCBtYXJrZXIgZnJvbSBhIGNvbW1lbnQgYm9keS5cbiAqXG4gKiBSZXR1cm5zIHRoZSBtb3N0IHJlY2VudCBtYXJrZXIgaW4gdGhlIGJvZHkgKGNvbW1lbnRzIG1heSBjb250YWluIG11bHRpcGxlXG4gKiBtYXJrZXJzIGlmIGFuIG9sZGVyIHJlZnJlc2ggd2FzIGFwcGVuZGVkIHJhdGhlciB0aGFuIGVkaXRlZCkuXG4gKlxuICogVGhlIGBjbGVhcmVkYCBmbGFnIGlzIHRydWUgb25seSB3aGVuIGJvdGggc2lnbmFscyBhcmUgcHJlc2VudCBpbiB0aGUgc2FtZVxuICogY29tbWVudCBib2R5IChJc3N1ZSAjMTg4Nik6IHRoZSBjaG9zZW4gbWFya2VyIGhhcyBgZXBvY2ggPT09IDBgICphbmQqIHRoZVxuICogYm9keSBhbHNvIGNvbnRhaW5zIGEgYDwhLS0gY2xlYXJlZDogLi4uIC0tPmAgSFRNTCBjb21tZW50LiBUaGlzIGlzIHRoZVxuICogZXhhY3Qgc2hhcGUgd3JpdHRlbiBieSBgY2xlYXJIZWFydGJlYXRgIHdoZW4gYSB3b3JrZXIgcmVsZWFzZXMgYSBjbGFpbVxuICogYWZ0ZXIgZmluaXNoaW5nIHN1Y2Nlc3NmdWxseSDigJQgdGhlIHJlY292ZXJ5IHNjYW4gbXVzdCB0cmVhdCBpdCBhcyB0aGVcbiAqIHN1Y2Nlc3MgcGF0aCwgbm90IGFzIFwibm8gbGl2ZSBtYXJrZXJcIi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlSGVhcnRiZWF0TWFya2VyKFxuICBib2R5OiBzdHJpbmcsXG4pOiB7IG1hY2hpbmVJZDogc3RyaW5nOyBlcG9jaDogbnVtYmVyOyBjbGVhcmVkOiBib29sZWFuIH0gfCBudWxsIHtcbiAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKFxuICAgIGAke0hFQVJUQkVBVF9NQVJLRVJfUFJFRklYfTooW146XFxcXHNdKyk6KFxcXFxkKylgLFxuICAgIFwiZ1wiLFxuICApO1xuICBsZXQgbWF0Y2g6IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG4gIGxldCBiZXN0OiB7IG1hY2hpbmVJZDogc3RyaW5nOyBlcG9jaDogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcbiAgd2hpbGUgKChtYXRjaCA9IHJlZ2V4LmV4ZWMoYm9keSkpICE9PSBudWxsKSB7XG4gICAgY29uc3QgZXBvY2ggPSBwYXJzZUludChtYXRjaFsyXSEsIDEwKTtcbiAgICBpZiAoaXNOYU4oZXBvY2gpKSBjb250aW51ZTtcbiAgICBpZiAoYmVzdCA9PT0gbnVsbCB8fCBlcG9jaCA+IGJlc3QuZXBvY2gpIHtcbiAgICAgIGJlc3QgPSB7IG1hY2hpbmVJZDogbWF0Y2hbMV0hLCBlcG9jaCB9O1xuICAgIH1cbiAgfVxuICBpZiAoYmVzdCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIC8vIFRoZSBjbGVhcmVkIHNpZ25hbCByZXF1aXJlcyBib3RoIHRoZSB6ZXJvLWVwb2NoIG1hcmtlciBBTkQgdGhlXG4gIC8vIGV4cGxpY2l0IGBjbGVhcmVkOmAgSFRNTCBjb21tZW50IGluIHRoZSBzYW1lIGJvZHkuIFdlIHVzZSBhIHJlZ2V4XG4gIC8vIChub3QgaW5jbHVkZXMpIHNvIHRyYWlsaW5nLXdoaXRlc3BhY2UgdmFyaWFudHMgc3RheSBtYXRjaGVkLlxuICBjb25zdCBjbGVhcmVkU3VmZml4ID0gLzwhLS1cXHMqY2xlYXJlZDpbXj5dKi0tPi9pO1xuICBjb25zdCBjbGVhcmVkID0gYmVzdC5lcG9jaCA9PT0gMCAmJiBjbGVhcmVkU3VmZml4LnRlc3QoYm9keSk7XG4gIHJldHVybiB7IG1hY2hpbmVJZDogYmVzdC5tYWNoaW5lSWQsIGVwb2NoOiBiZXN0LmVwb2NoLCBjbGVhcmVkIH07XG59XG5cbi8qKlxuICogUnVuIGEgZ2ggY29tbWFuZCBhbmQgcmV0dXJuIHN0ZG91dC4gUmV0dXJucyBlbXB0eSBzdHJpbmcgb24gZmFpbHVyZS5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgdXNlIGJ5IGRldGVjdGlvbiBhbmQgcmVjb3ZlcnkgbW9kdWxlcyBzbyB0aGV5IHNoYXJlIGFcbiAqIHNpbmdsZSBpbXBsZW1lbnRhdGlvbi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkdoKGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzcGF3bkdoKGFyZ3MsIHsgc3RkZXJyOiBcIm51bGxcIiB9KTtcbiAgICBpZiAoIXJlc3VsdC5zdWNjZXNzKSByZXR1cm4gXCJcIjtcbiAgICByZXR1cm4gcmVzdWx0LnN0ZG91dC50cmltKCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlY29yZEZhdWx0RXZlbnQoXCJjYXRjaF9ibG9ja193YXJuaW5nXCIsIGBnaCBjb21tYW5kIGZhaWxlZDogJHtlcnJ9YCk7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBwZXJzaXN0ZWQgbWFya2VyIHN0YXRlIGZvciBhIHJlcG8vaXNzdWUuIFJldHVybnMgbnVsbCB3aGVuIG5vXG4gKiBzdGF0ZSBoYXMgYmVlbiB3cml0dGVuIHlldCBvciB0aGUgZmlsZSBjYW5ub3QgYmUgcGFyc2VkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZE1hcmtlclN0YXRlKFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IFByb21pc2U8TWFya2VyU3RhdGUgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoXG4gICAgICBtYXJrZXJTdGF0ZUZpbGVQYXRoKHdvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyKSxcbiAgICApO1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyB7XG4gICAgICBjb21tZW50SWQ/OiBudW1iZXI7XG4gICAgICBsYXN0UmVmcmVzaD86IG51bWJlcjtcbiAgICAgIGNsYWltUHJlZml4Pzogc3RyaW5nO1xuICAgICAgcmVsZWFzZWQ/OiBib29sZWFuO1xuICAgICAgbWlsZXN0b25lcz86IHVua25vd247XG4gICAgICBzdGFydGVkRXBvY2g/OiBudW1iZXI7XG4gICAgICB3b3JrZXJJZD86IHN0cmluZztcbiAgICAgIGF0dGVtcHRzPzogdW5rbm93bjtcbiAgICB9O1xuICAgIGlmIChcbiAgICAgIHR5cGVvZiBwYXJzZWQuY29tbWVudElkICE9PSBcIm51bWJlclwiIHx8XG4gICAgICB0eXBlb2YgcGFyc2VkLmxhc3RSZWZyZXNoICE9PSBcIm51bWJlclwiXG4gICAgKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3Qgc3RhdGU6IE1hcmtlclN0YXRlID0ge1xuICAgICAgY29tbWVudElkOiBwYXJzZWQuY29tbWVudElkLFxuICAgICAgbGFzdFJlZnJlc2g6IHBhcnNlZC5sYXN0UmVmcmVzaCxcbiAgICB9O1xuICAgIGlmIChcbiAgICAgIHR5cGVvZiBwYXJzZWQuY2xhaW1QcmVmaXggPT09IFwic3RyaW5nXCIgJiYgcGFyc2VkLmNsYWltUHJlZml4Lmxlbmd0aCA+IDBcbiAgICApIHtcbiAgICAgIHN0YXRlLmNsYWltUHJlZml4ID0gcGFyc2VkLmNsYWltUHJlZml4O1xuICAgIH1cbiAgICBpZiAocGFyc2VkLnJlbGVhc2VkID09PSB0cnVlKSBzdGF0ZS5yZWxlYXNlZCA9IHRydWU7XG4gICAgY29uc3QgYXR0ZW1wdHMgPSBwYXJzZWQuYXR0ZW1wdHMgYXNcbiAgICAgIHwgeyB0b3RhbD86IHVua25vd247IGF0dGVtcHRzPzogdW5rbm93biB9XG4gICAgICB8IHVuZGVmaW5lZDtcbiAgICBpZiAoXG4gICAgICBhdHRlbXB0cyAmJiB0eXBlb2YgYXR0ZW1wdHMudG90YWwgPT09IFwibnVtYmVyXCIgJiZcbiAgICAgIEFycmF5LmlzQXJyYXkoYXR0ZW1wdHMuYXR0ZW1wdHMpXG4gICAgKSB7XG4gICAgICBzdGF0ZS5hdHRlbXB0cyA9IHtcbiAgICAgICAgdG90YWw6IGF0dGVtcHRzLnRvdGFsLFxuICAgICAgICBhdHRlbXB0czogKGF0dGVtcHRzLmF0dGVtcHRzIGFzIFJlbGVhc2VBdHRlbXB0W10pLmZpbHRlcigoYSkgPT5cbiAgICAgICAgICBhICYmIHR5cGVvZiBhLmhvc3QgPT09IFwic3RyaW5nXCIgJiYgdHlwZW9mIGEudGV4dCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICApLm1hcCgoYSkgPT4gKHtcbiAgICAgICAgICBlcG9jaDogdHlwZW9mIGEuZXBvY2ggPT09IFwibnVtYmVyXCIgPyBhLmVwb2NoIDogMCxcbiAgICAgICAgICBob3N0OiBhLmhvc3QsXG4gICAgICAgICAgdGV4dDogYS50ZXh0LFxuICAgICAgICB9KSksXG4gICAgICB9O1xuICAgIH1cbiAgICAvLyBBYnNlbnQgb24gc3RhdGUgZmlsZXMgd3JpdHRlbiBiZWZvcmUgSXNzdWUgIzM3NTIg4oCUIHRoZSB2aXNpYmxlIGJvZHlcbiAgICAvLyBzaW1wbHkgb21pdHMgdGhlIGNsYXVzZXMgdGhlc2UgZmVlZC5cbiAgICBpZiAoXG4gICAgICB0eXBlb2YgcGFyc2VkLnN0YXJ0ZWRFcG9jaCA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgTnVtYmVyLmlzRmluaXRlKHBhcnNlZC5zdGFydGVkRXBvY2gpICYmIHBhcnNlZC5zdGFydGVkRXBvY2ggPiAwXG4gICAgKSB7XG4gICAgICBzdGF0ZS5zdGFydGVkRXBvY2ggPSBwYXJzZWQuc3RhcnRlZEVwb2NoO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHBhcnNlZC53b3JrZXJJZCA9PT0gXCJzdHJpbmdcIiAmJiBwYXJzZWQud29ya2VySWQubGVuZ3RoID4gMCkge1xuICAgICAgc3RhdGUud29ya2VySWQgPSBwYXJzZWQud29ya2VySWQ7XG4gICAgfVxuICAgIGNvbnN0IG1pbGVzdG9uZXMgPSBjb2VyY2VNaWxlc3RvbmVzKHBhcnNlZC5taWxlc3RvbmVzKTtcbiAgICBpZiAobWlsZXN0b25lcy5sZW5ndGggPiAwKSBzdGF0ZS5taWxlc3RvbmVzID0gbWlsZXN0b25lcztcbiAgICByZXR1cm4gc3RhdGU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBDb2VyY2UgYW4gdW50cnVzdGVkIEpTT04gdmFsdWUgaW50byBhIG1pbGVzdG9uZSBsaXN0IChJc3N1ZSAjMzc1MykuICovXG5mdW5jdGlvbiBjb2VyY2VNaWxlc3RvbmVzKHZhbHVlOiB1bmtub3duKTogSGVhcnRiZWF0TWlsZXN0b25lW10ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gW107XG4gIGNvbnN0IGVudHJpZXM6IEhlYXJ0YmVhdE1pbGVzdG9uZVtdID0gW107XG4gIGZvciAoY29uc3QgaXRlbSBvZiB2YWx1ZSkge1xuICAgIGlmIChpdGVtID09PSBudWxsIHx8IHR5cGVvZiBpdGVtICE9PSBcIm9iamVjdFwiKSBjb250aW51ZTtcbiAgICBjb25zdCB7IGVwb2NoLCB0ZXh0IH0gPSBpdGVtIGFzIHsgZXBvY2g/OiB1bmtub3duOyB0ZXh0PzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgZXBvY2ggIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZShlcG9jaCkpIGNvbnRpbnVlO1xuICAgIGlmICh0eXBlb2YgdGV4dCAhPT0gXCJzdHJpbmdcIiB8fCB0ZXh0LnRyaW0oKS5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIGVudHJpZXMucHVzaCh7IGVwb2NoLCB0ZXh0OiBub3JtYWxpc2VNaWxlc3RvbmVUZXh0KHRleHQpIH0pO1xuICB9XG4gIHJldHVybiBlbnRyaWVzLnNsaWNlKC1NQVhfTUlMRVNUT05FUyk7XG59XG5cbi8qKlxuICogUmVhZCB0aGUgbWlsZXN0b25lIGxvZyB3aXRob3V0IHJlcXVpcmluZyBhIHB1Ymxpc2hlZCBjb21tZW50XG4gKiAoSXNzdWUgIzM3NTMpLlxuICpcbiAqIGByZWFkTWFya2VyU3RhdGVgIGRlbGliZXJhdGVseSByZWplY3RzIGEgc3RhdGUgZmlsZSB3aXRoIG5vIGNvbW1lbnQgaWQ7XG4gKiBtaWxlc3RvbmVzIG1heSBsZWdpdGltYXRlbHkgYmUgcmVjb3JkZWQgYmVmb3JlIHRoZSBmaXJzdCBwdWJsaXNoLCBzbyB0aGlzXG4gKiBsZW5pZW50IHJlYWRlciBpcyB1c2VkIGZvciB0aGUgcHJvZ3Jlc3MgbG9nIGFsb25lLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWFkTWlsZXN0b25lcyhcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4pOiBQcm9taXNlPEhlYXJ0YmVhdE1pbGVzdG9uZVtdPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoXG4gICAgICBtYXJrZXJTdGF0ZUZpbGVQYXRoKHdvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyKSxcbiAgICApO1xuICAgIHJldHVybiBjb2VyY2VNaWxlc3RvbmVzKFxuICAgICAgKEpTT04ucGFyc2UocmF3KSBhcyB7IG1pbGVzdG9uZXM/OiB1bmtub3duIH0pXG4gICAgICAgIC5taWxlc3RvbmVzLFxuICAgICk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKipcbiAqIFNlZWQgdGhlIG1hcmtlciBzdGF0ZSBmaWxlIGZyb20gb3V0c2lkZSBoZWFydGJlYXQgcHVibGljYXRpb24gKElzc3VlICMxNjI4KS5cbiAqXG4gKiBVc2VkIGJ5IHRoZSBjbGFpbSBmbG93IHRvIHJlY29yZCBhIGNvbW1lbnQgaWQgdGhhdCBhbHJlYWR5IGNvbnRhaW5zIGJvdGhcbiAqIGEgQ0xBSU1fTE9DSyBtYXJrZXIgYW5kIGFuIGluaXRpYWwgaGVhcnRiZWF0IG1hcmtlciwgc28gdGhlIGhlYXJ0YmVhdFxuICogdXBkYXRlciBQQVRDSGVzIHRoYXQgc2FtZSBjb21tZW50IGluc3RlYWQgb2YgcG9zdGluZyBhIG5ldyBvbmUuXG4gKlxuICogRXJyb3JzIGFyZSBub24tZmF0YWwg4oCUIGZhaWx1cmUgdG8gcGVyc2lzdCB0aGUgc2VlZCBzaW1wbHkgbWVhbnMgdGhlIG5leHRcbiAqIGhlYXJ0YmVhdCB3aWxsIGZhbGwgYmFjayB0byBwb3N0aW5nIGEgZnJlc2ggbWFya2VyIGNvbW1lbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZWVkTWFya2VyU3RhdGUoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBzdGF0ZToge1xuICAgIGNvbW1lbnRJZDogbnVtYmVyO1xuICAgIGxhc3RSZWZyZXNoOiBudW1iZXI7XG4gICAgY2xhaW1QcmVmaXg/OiBzdHJpbmc7XG4gICAgc3RhcnRlZEVwb2NoPzogbnVtYmVyO1xuICAgIHdvcmtlcklkPzogc3RyaW5nO1xuICB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFNlZWRpbmcgaGFwcGVucyBhcyBhIGNsYWltIGlzIHRha2VuIChJc3N1ZSAjMjE0KSwgc28gYW55IGd1YXJkIGxlZnQgYnkgYVxuICAvLyBwcmV2aW91cyBjbGFpbSBvbiB0aGlzIGlzc3VlIGlzIGxpZnRlZCBoZXJlIHRvby5cbiAgY2xlYXJDbGFpbVJlbGVhc2VHdWFyZCh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcik7XG4gIGF3YWl0IHdyaXRlTWFya2VyU3RhdGUod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIsIHN0YXRlKTtcbn1cblxuLyoqXG4gKiBQZXJzaXN0IG1hcmtlciBzdGF0ZSBmb3IgYSByZXBvL2lzc3VlLiBFcnJvcnMgYXJlIG5vbi1mYXRhbCDigJQgbWFya2VyXG4gKiBwdWJsaWNhdGlvbiBkZWdyYWRlcyB0byBcInBvc3QgYSBuZXcgY29tbWVudCBuZXh0IHRpbWVcIiByYXRoZXIgdGhhblxuICogYnJlYWtpbmcgdGhlIGhlYXJ0YmVhdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gd3JpdGVNYXJrZXJTdGF0ZShcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIHN0YXRlOiBNYXJrZXJTdGF0ZSxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ubWtkaXIod29ya0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIERpcmVjdG9yeSBhbHJlYWR5IGV4aXN0cyDigJQgbm9uLWZhdGFsXG4gIH1cbiAgLy8gTWlsZXN0b25lcyBvdXRsaXZlIGV2ZXJ5IG90aGVyIGZpZWxkIG9mIHRoZSBzdGF0ZSAoSXNzdWUgIzM3NTMpOiBhXG4gIC8vIGNhbGxlciB0aGF0IGRvZXMgbm90IGNhcnJ5IHRoZW0gZm9yd2FyZCAoc2VlZGluZywgYWRvcHRpb24sIHJlbGVhc2UpXG4gIC8vIG11c3Qgbm90IHNpbGVudGx5IGRyb3AgdGhlIHByb2dyZXNzIGxvZy5cbiAgY29uc3QgbWlsZXN0b25lcyA9IHN0YXRlLm1pbGVzdG9uZXMgPz9cbiAgICBhd2FpdCByZWFkTWlsZXN0b25lcyh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcik7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgbWFya2VyU3RhdGVGaWxlUGF0aCh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlciksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIC4uLnN0YXRlLFxuICAgICAgICAuLi4obWlsZXN0b25lcy5sZW5ndGggPiAwID8geyBtaWxlc3RvbmVzIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICApO1xuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tZmF0YWwg4oCUIG5leHQgaGVhcnRiZWF0IHdpbGwgc2ltcGx5IHJlLXB1Ymxpc2ggdGhlIG1hcmtlci5cbiAgfVxufVxuXG4vKipcbiAqIFBvc3QgYSBuZXcgaGVhcnRiZWF0IG1hcmtlciBjb21tZW50IGFuZCByZXR1cm4gaXRzIGlkLCBvciBudWxsIG9uIGZhaWx1cmUuXG4gKlxuICogYGdoIGlzc3VlIGNvbW1lbnRgIGRvZXMgbm90IGV4cG9zZSB0aGUgY3JlYXRlZCBjb21tZW50IGlkLCBzbyB3ZSB1c2UgdGhlXG4gKiBSRVNUIGVuZHBvaW50IGluc3RlYWQgYW5kIHBhcnNlIHRoZSByZXR1cm5lZCBKU09OLlxuICovXG5hc3luYyBmdW5jdGlvbiBwb3N0TWFya2VyQ29tbWVudChcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBib2R5OiBzdHJpbmcsXG4gIGdoRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIGNvbnN0IGpzb24gPSBhd2FpdCBnaEZuKFtcbiAgICBcImFwaVwiLFxuICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke2lzc3VlTnVtYmVyfS9jb21tZW50c2AsXG4gICAgXCItWFwiLFxuICAgIFwiUE9TVFwiLFxuICAgIFwiLWZcIixcbiAgICBgYm9keT0ke2JvZHl9YCxcbiAgICBcIi0tanFcIixcbiAgICBcIi5pZFwiLFxuICBdKTtcbiAgaWYgKCFqc29uKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgaWQgPSBwYXJzZUludChqc29uLnRyaW0oKSwgMTApO1xuICByZXR1cm4gaXNOYU4oaWQpID8gbnVsbCA6IGlkO1xufVxuXG4vKipcbiAqIEVkaXQgYW4gZXhpc3RpbmcgaGVhcnRiZWF0IG1hcmtlciBjb21tZW50IGluIHBsYWNlLiBSZXR1cm5zIHRydWUgb25cbiAqIHN1Y2Nlc3MsIGZhbHNlIHdoZW4gdGhlIGVkaXQgZmFpbHMgKGUuZy4gY29tbWVudCB3YXMgZGVsZXRlZCkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHBhdGNoTWFya2VyQ29tbWVudChcbiAgcmVwbzogc3RyaW5nLFxuICBjb21tZW50SWQ6IG51bWJlcixcbiAgYm9keTogc3RyaW5nLFxuICBnaEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBqc29uID0gYXdhaXQgZ2hGbihbXG4gICAgXCJhcGlcIixcbiAgICBgcmVwb3MvJHtyZXBvfS9pc3N1ZXMvY29tbWVudHMvJHtjb21tZW50SWR9YCxcbiAgICBcIi1YXCIsXG4gICAgXCJQQVRDSFwiLFxuICAgIFwiLWZcIixcbiAgICBgYm9keT0ke2JvZHl9YCxcbiAgICBcIi0tanFcIixcbiAgICBcIi5pZFwiLFxuICBdKTtcbiAgaWYgKCFqc29uKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGlkID0gcGFyc2VJbnQoanNvbi50cmltKCksIDEwKTtcbiAgcmV0dXJuICFpc05hTihpZCk7XG59XG5cbi8qKlxuICogTWFyayBhIGhlYXJ0YmVhdCBtYXJrZXIgY29tbWVudCBhcyBzdGFsZSBieSByZXBsYWNpbmcgaXRzIGJvZHkuIEZhbGxzXG4gKiBiYWNrIHRvIGEgbm8tb3Agb24gZmFpbHVyZSDigJQgdGhlIG5leHQgd29ya2VyIHNjYW4gd2lsbCB0cmVhdCBhIG1pc3NpbmdcbiAqIGNvbW1lbnQgdGhlIHNhbWUgYXMgYW4gaW52YWxpZGF0ZWQgb25lLlxuICovXG5hc3luYyBmdW5jdGlvbiBpbnZhbGlkYXRlTWFya2VyQ29tbWVudChcbiAgcmVwbzogc3RyaW5nLFxuICBjb21tZW50SWQ6IG51bWJlcixcbiAgbWFjaGluZUlkOiBzdHJpbmcsXG4gIGdoRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICBtaWxlc3RvbmVzOiBIZWFydGJlYXRNaWxlc3RvbmVbXSA9IFtdLFxuICBob3N0Pzogc3RyaW5nLFxuICBub3dGbjogKCkgPT4gbnVtYmVyID0gKCkgPT4gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCksXG4gIG91dGNvbWU/OiBSdW5PdXRjb21lLFxuICBhdHRlbXB0cz86IFJlbGVhc2VBdHRlbXB0VGFsbHksXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgLy8gVGhlIHByb2dyZXNzIGxvZyBpcyBrZXB0IG9uIHJlbGVhc2UgKElzc3VlICMzNzUzKSBzbyB0aGUgZmluaXNoZWRcbiAgLy8gdGltZWxpbmUgc3RheXMgcmVhZGFibGU7IHRoZSBjbGVhcmVkIHNpZ25hbCBpcyB1bmFmZmVjdGVkLiBUaGUgcnVuXG4gIC8vIG91dGNvbWUgKElzc3VlICM0MzI1KSBhbmQgdGhlIGF0dGVtcHQgdGFsbHkgKElzc3VlICM0MzI3KSByZWFjaCB0aGVcbiAgLy8gcmVuZGVyIGhlcmUuXG4gIGNvbnN0IGJvZHkgPSByZW5kZXJSZWxlYXNlZEJvZHkoe1xuICAgIG1hY2hpbmVJZCxcbiAgICBlcG9jaDogMCxcbiAgICByZWxlYXNlZDogdHJ1ZSxcbiAgICBtaWxlc3RvbmVzLFxuICAgIC4uLihob3N0ID8geyBob3N0IH0gOiB7fSksXG4gICAgLi4uKG91dGNvbWUgPyB7IG91dGNvbWUgfSA6IHt9KSxcbiAgICAuLi4oYXR0ZW1wdHMgPyB7IGF0dGVtcHRzIH0gOiB7fSksXG4gIH0sIG5vd0ZuKTtcbiAgcmV0dXJuIGF3YWl0IHBhdGNoTWFya2VyQ29tbWVudChyZXBvLCBjb21tZW50SWQsIGJvZHksIGdoRm4pO1xufVxuXG4vKipcbiAqIExpc3QgZXZlcnkgZmxlZXQtYXV0aG9yZWQgaGVhcnRiZWF0IG1hcmtlciBjb21tZW50IG9uIGFuIGlzc3VlL1BSLCBvbGRlc3RcbiAqIGZpcnN0IChJc3N1ZSAjNDMyNykuIFNoYXJlcyB0aGUgYXV0aG9yIGZpbHRlciBhbmQgcGFyc2UgcnVsZXMgb2ZcbiAqIHtAbGluayBmaW5kRXhpc3RpbmdNYXJrZXJDb21tZW50fS4gQW55IGZhaWx1cmUgeWllbGRzIG51bGwgc28gY2FsbGVyc1xuICogZGVncmFkZSB0byBzaW5nbGUtY29tbWVudCBiZWhhdmlvdXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsaXN0RmxlZXRNYXJrZXJDb21tZW50cyhcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBnaEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbiAgYWxsb3dlZEF1dGhvcnM/OiBzdHJpbmdbXSxcbik6IFByb21pc2U8RXhpc3RpbmdNYXJrZXJDb21tZW50W10gfCBudWxsPiB7XG4gIGxldCBqc29uOiBzdHJpbmc7XG4gIHRyeSB7XG4gICAganNvbiA9IGF3YWl0IGdoRm4oW1xuICAgICAgXCJhcGlcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke2lzc3VlTnVtYmVyfS9jb21tZW50c2AsXG4gICAgICBcIi0tanFcIixcbiAgICAgIFwiWy5bXSB8IHtpZDogLmlkLCBib2R5OiAuYm9keSwgYXV0aG9yOiAudXNlci5sb2dpbn1dXCIsXG4gICAgXSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgICBcImNhdGNoX2Jsb2NrX3dhcm5pbmdcIixcbiAgICAgIGBsaXN0RmxlZXRNYXJrZXJDb21tZW50cyBmYWlsZWQgZm9yICR7cmVwb30jJHtpc3N1ZU51bWJlcn06ICR7ZXJyfWAsXG4gICAgKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoIWpzb24pIHJldHVybiBudWxsO1xuICBsZXQgY29tbWVudHM6IEFycmF5PHsgaWQ/OiBudW1iZXI7IGJvZHk/OiBzdHJpbmc7IGF1dGhvcj86IHN0cmluZyB8IG51bGwgfT47XG4gIHRyeSB7XG4gICAgY29tbWVudHMgPSBKU09OLnBhcnNlKGpzb24pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoIUFycmF5LmlzQXJyYXkoY29tbWVudHMpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsdGVyQnlBdXRob3IgPSBhbGxvd2VkQXV0aG9ycyAhPT0gdW5kZWZpbmVkICYmXG4gICAgYWxsb3dlZEF1dGhvcnMubGVuZ3RoID4gMDtcbiAgY29uc3QgZm91bmQ6IEV4aXN0aW5nTWFya2VyQ29tbWVudFtdID0gW107XG4gIGZvciAoY29uc3QgY29tbWVudCBvZiBjb21tZW50cykge1xuICAgIGlmICghY29tbWVudCB8fCB0eXBlb2YgY29tbWVudC5ib2R5ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpZiAodHlwZW9mIGNvbW1lbnQuaWQgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZShjb21tZW50LmlkKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChmaWx0ZXJCeUF1dGhvciAmJiAhaXNGbGVldEF1dGhvcihjb21tZW50LmF1dGhvciwgYWxsb3dlZEF1dGhvcnMhKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IG1hcmtlciA9IHBhcnNlSGVhcnRiZWF0TWFya2VyKGNvbW1lbnQuYm9keSk7XG4gICAgaWYgKG1hcmtlciA9PT0gbnVsbCkgY29udGludWU7XG4gICAgZm91bmQucHVzaCh7XG4gICAgICBjb21tZW50SWQ6IGNvbW1lbnQuaWQsXG4gICAgICBtYWNoaW5lSWQ6IG1hcmtlci5tYWNoaW5lSWQsXG4gICAgICBlcG9jaDogbWFya2VyLmVwb2NoLFxuICAgICAgY2xlYXJlZDogbWFya2VyLmNsZWFyZWQsXG4gICAgICBib2R5OiBjb21tZW50LmJvZHksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGZvdW5kLnNvcnQoKGEsIGIpID0+IGEuY29tbWVudElkIC0gYi5jb21tZW50SWQpO1xufVxuXG4vKipcbiAqIFRoZSB2aXNpYmxlIGxpbmUgbGVmdCBvbiBhIHN1cGVyc2VkZWQgcmVsZWFzZSBjb21tZW50IChJc3N1ZSAjNDMyNyk6IHRoZVxuICogaGVhcnRiZWF0IGxheWVyJ3Mgb3duIHRleHQsIHNvIGBpc0hlYXJ0YmVhdE9ubHlCb2R5YCBzdGlsbCBob2xkcyBhbmQgdGhlXG4gKiBleGlzdGluZyBzd2VlcCByZW1vdmVzIGl0IG9uY2UgcGFzdCB0aGUgY2xlYXJlZC1tYXJrZXIgZ3JhY2Ugd2luZG93LiBJdFxuICogY2FycmllcyB0aGUgY2xlYXJlZCBtYXJrZXIgc28gbm8gc2Nhbm5lciBzZWVzIGEgbGl2ZSBjbGFpbSBvbiBpdC5cbiAqXG4gKiBJdCByZXBlYXRzICoqdGhpcyoqIHJlbGVhc2UncyByZWFzb24gKElzc3VlICMyMzg4KS4gUG9pbnRpbmcgXCJhYm92ZVwiIHdhc1xuICogYWNjdXJhdGUgYW5kIHVzZWxlc3M6IHRoZSBjYW5vbmljYWwgc3VtbWFyeSBjYW4gYmUgYSB3ZWVrIGFuZCBhIGRvemVuXG4gKiBjb21tZW50cyB1cCB0aGUgdGhyZWFkLCBzbyB0aGUgbmV3ZXN0IGNvbW1lbnQg4oCUIHRoZSBvbmUgYSByZWFkZXIgbGFuZHMgb24g4oCUXG4gKiBzYWlkIG5vdGhpbmcgYWJvdXQgd2h5IHRoZSBjbGFpbSBoYWQganVzdCBiZWVuIGRyb3BwZWQuXG4gKlxuICogQHBhcmFtIG1hY2hpbmVJZCAtIFRoZSBob3N0IHdob3NlIGNvbW1lbnQgaXMgYmVpbmcgc3VwZXJzZWRlZFxuICogQHBhcmFtIHJlYXNvbiAtIFRoaXMgcmVsZWFzZSdzIG9uZS1saW5lIG91dGNvbWUsIHdoZW4gdGhlcmUgaXMgb25lXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJTdXBlcnNlZGVkUmVsZWFzZUJvZHkoXG4gIG1hY2hpbmVJZDogc3RyaW5nLFxuICByZWFzb24/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gcmVhc29uPy50cmltKCk7XG4gIGNvbnN0IHdoeSA9IHRyaW1tZWQgPyBgIOKAlCAke3RyaW1tZWR9YCA6IFwiXCI7XG4gIHJldHVybiBgJHtmb3JtYXRIZWFydGJlYXRNYXJrZXIobWFjaGluZUlkLCAwKX0gYCArXG4gICAgYDwhLS0gY2xlYXJlZDogY2xhaW0gcmVsZWFzZWQgYnkgbWFjaGluZSAke21hY2hpbmVJZH0gLS0+XFxuXFxuYCArXG4gICAgYOKchSAqKlZpYmUgQ29kZXIgcmVsZWFzZWQgdGhpcyBjbGFpbSoqJHt3aHl9IOKAlCBmdWxsIGhpc3RvcnkgY29sbGFwc2VkIGAgK1xuICAgIGBpbnRvIHRoZSByZWxlYXNlIHN1bW1hcnkgYWJvdmUuYDtcbn1cblxuLyoqXG4gKiBSZW5kZXIgc2VhbSBmb3IgdGhlIHJlbGVhc2VkIGJvZHkgKElzc3VlICM0MzI1KTogdGVzdHMgcmVwbGFjZSBpdCB0b1xuICogYXNzZXJ0IHRoZSBvdXRjb21lIHRoYXQgYXJyaXZlZCBhdCB0aGUgcmVuZGVyIGNhbGwsIGluZGVwZW5kZW50IG9mIHRoZVxuICogcmVuZGVyZWQgdGV4dC4gUHJvZHVjdGlvbiBpcyB7QGxpbmsgcmVuZGVySGVhcnRiZWF0Qm9keX0uXG4gKi9cbmV4cG9ydCBsZXQgcmVuZGVyUmVsZWFzZWRCb2R5OiAoXG4gIGZpZWxkczogSGVhcnRiZWF0Qm9keUZpZWxkcyxcbiAgbm93Rm46ICgpID0+IG51bWJlcixcbikgPT4gc3RyaW5nID0gcmVuZGVySGVhcnRiZWF0Qm9keTtcblxuLyoqIFN3YXAgdGhlIHJlbGVhc2UtYm9keSByZW5kZXJlciAodGVzdHMgb25seSkuIFJldHVybnMgYSByZXN0b3JlIGZ1bmN0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9zZXRSZW5kZXJSZWxlYXNlZEJvZHkoXG4gIGZuOiB0eXBlb2YgcmVuZGVyUmVsZWFzZWRCb2R5LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHByZXZpb3VzID0gcmVuZGVyUmVsZWFzZWRCb2R5O1xuICByZW5kZXJSZWxlYXNlZEJvZHkgPSBmbjtcbiAgcmV0dXJuICgpID0+IHtcbiAgICByZW5kZXJSZWxlYXNlZEJvZHkgPSBwcmV2aW91cztcbiAgfTtcbn1cblxuLyoqIEEgaGVhcnRiZWF0IG1hcmtlciBjb21tZW50IGFscmVhZHkgcHVibGlzaGVkIG9uIGFuIGlzc3VlL1BSLiAqL1xuZXhwb3J0IGludGVyZmFjZSBFeGlzdGluZ01hcmtlckNvbW1lbnQge1xuICAvKiogR2l0SHViIGNvbW1lbnQgaWQsIGZvciBQQVRDSGluZyBpbiBwbGFjZS4gKi9cbiAgY29tbWVudElkOiBudW1iZXI7XG4gIC8qKiBNYWNoaW5lIHRoYXQgbGFzdCB3cm90ZSB0aGUgbWFya2VyLiAqL1xuICBtYWNoaW5lSWQ6IHN0cmluZztcbiAgLyoqIE1hcmtlciBlcG9jaCAoMCB3aGVuIHRoZSBjbGFpbSB3YXMgcmVsZWFzZWQpLiAqL1xuICBlcG9jaDogbnVtYmVyO1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBtYXJrZXIgY2FycmllcyB0aGUgYGNsZWFyZWQ6YCByZWxlYXNlIHNpZ25hbC4gKi9cbiAgY2xlYXJlZDogYm9vbGVhbjtcbiAgLyoqIEZ1bGwgY29tbWVudCBib2R5LCBzbyBhIENMQUlNX0xPQ0sgcHJlZml4IGNhbiBiZSBwcmVzZXJ2ZWQuICovXG4gIGJvZHk6IHN0cmluZztcbn1cblxuLyoqXG4gKiBGaW5kIHRoZSBoZWFydGJlYXQgbWFya2VyIGNvbW1lbnQgYWxyZWFkeSBwdWJsaXNoZWQgb24gYW4gaXNzdWUvUFJcbiAqIChJc3N1ZSAjMzc1MSkuXG4gKlxuICogUmV0dXJucyB0aGUgbmV3ZXN0IGZsZWV0LWF1dGhvcmVkIGNvbW1lbnQgY2FycnlpbmcgYVxuICoge0BsaW5rIEhFQVJUQkVBVF9NQVJLRVJfUFJFRklYfSBtYXJrZXIsIG9yIG51bGwgd2hlbiB0aGVyZSBpcyBub25lLiBDb21tZW50XG4gKiBpZHMgaW5jcmVhc2UgbW9ub3RvbmljYWxseSwgc28gXCJuZXdlc3RcIiBpcyBzaW1wbHkgdGhlIGhpZ2hlc3QgaWQuXG4gKlxuICogVGhlIGBhbGxvd2VkQXV0aG9yc2AgZmlsdGVyIG1pcnJvcnMge0BsaW5rIHNjYW5IZWFydGJlYXRNYXJrZXJzfSAoSXNzdWVcbiAqICMzMTY0KTogd2hlbiBzdXBwbGllZCBhbmQgbm9uLWVtcHR5LCBhIGNvbW1lbnQgZnJvbSBvdXRzaWRlIHRoZSBmbGVldCBpc1xuICogbmV2ZXIgcmV0dXJuZWQsIHNvIGEgZm9yZ2VkIG1hcmtlciBjYW4gbmV2ZXIgYmUgYWRvcHRlZC4gQW55IGZhaWx1cmUg4oCUXG4gKiBBUEkgZXJyb3IsIHVucGFyc2VhYmxlIEpTT04g4oCUIHlpZWxkcyBudWxsIHNvIHRoZSBjYWxsZXIgZmFsbHMgYmFjayB0b1xuICogcG9zdGluZyBhIGZyZXNoIGNvbW1lbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmaW5kRXhpc3RpbmdNYXJrZXJDb21tZW50KFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIGdoRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICBhbGxvd2VkQXV0aG9ycz86IHN0cmluZ1tdLFxuKTogUHJvbWlzZTxFeGlzdGluZ01hcmtlckNvbW1lbnQgfCBudWxsPiB7XG4gIGNvbnN0IGpzb24gPSBhd2FpdCBnaEZuKFtcbiAgICBcImFwaVwiLFxuICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke2lzc3VlTnVtYmVyfS9jb21tZW50c2AsXG4gICAgXCItLWpxXCIsXG4gICAgXCJbLltdIHwge2lkOiAuaWQsIGJvZHk6IC5ib2R5LCBhdXRob3I6IC51c2VyLmxvZ2lufV1cIixcbiAgXSk7XG4gIGlmICghanNvbikgcmV0dXJuIG51bGw7XG4gIGxldCBjb21tZW50czogQXJyYXk8eyBpZD86IG51bWJlcjsgYm9keT86IHN0cmluZzsgYXV0aG9yPzogc3RyaW5nIHwgbnVsbCB9PjtcbiAgdHJ5IHtcbiAgICBjb21tZW50cyA9IEpTT04ucGFyc2UoanNvbik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgICBcImNhdGNoX2Jsb2NrX3dhcm5pbmdcIixcbiAgICAgIGBmaW5kRXhpc3RpbmdNYXJrZXJDb21tZW50IHBhcnNlIGZhaWxlZCBmb3IgJHtyZXBvfSMke2lzc3VlTnVtYmVyfTogJHtlcnJ9YCxcbiAgICApO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmICghQXJyYXkuaXNBcnJheShjb21tZW50cykpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWx0ZXJCeUF1dGhvciA9IEFycmF5LmlzQXJyYXkoYWxsb3dlZEF1dGhvcnMpICYmXG4gICAgYWxsb3dlZEF1dGhvcnMubGVuZ3RoID4gMDtcbiAgbGV0IG5ld2VzdDogRXhpc3RpbmdNYXJrZXJDb21tZW50IHwgbnVsbCA9IG51bGw7XG4gIGZvciAoY29uc3QgY29tbWVudCBvZiBjb21tZW50cykge1xuICAgIGlmICghY29tbWVudCB8fCB0eXBlb2YgY29tbWVudC5ib2R5ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpZiAodHlwZW9mIGNvbW1lbnQuaWQgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZShjb21tZW50LmlkKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChmaWx0ZXJCeUF1dGhvciAmJiAhaXNGbGVldEF1dGhvcihjb21tZW50LmF1dGhvciwgYWxsb3dlZEF1dGhvcnMhKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IG1hcmtlciA9IHBhcnNlSGVhcnRiZWF0TWFya2VyKGNvbW1lbnQuYm9keSk7XG4gICAgaWYgKG1hcmtlciA9PT0gbnVsbCkgY29udGludWU7XG4gICAgaWYgKG5ld2VzdCAhPT0gbnVsbCAmJiBjb21tZW50LmlkIDw9IG5ld2VzdC5jb21tZW50SWQpIGNvbnRpbnVlO1xuICAgIG5ld2VzdCA9IHtcbiAgICAgIGNvbW1lbnRJZDogY29tbWVudC5pZCxcbiAgICAgIG1hY2hpbmVJZDogbWFya2VyLm1hY2hpbmVJZCxcbiAgICAgIGVwb2NoOiBtYXJrZXIuZXBvY2gsXG4gICAgICBjbGVhcmVkOiBtYXJrZXIuY2xlYXJlZCxcbiAgICAgIGJvZHk6IGNvbW1lbnQuYm9keSxcbiAgICB9O1xuICB9XG4gIHJldHVybiBuZXdlc3Q7XG59XG5cbi8qKlxuICogRXh0cmFjdCB0aGUgQ0xBSU1fTE9DSyBwcmVmaXggZnJvbSBhbiBhZG9wdGVkIG1hcmtlciBjb21tZW50IGJvZHkuXG4gKlxuICogVGhlIGNsYWltIGZsb3cgY28tcHVibGlzaGVzIGA8IS0tIENMQUlNX0xPQ0s6d29ya2VyIC0tPiBDbGFpbWVkIGJ5IC4uLmBcbiAqIHdpdGggdGhlIGhlYXJ0YmVhdCBtYXJrZXIgaW4gb25lIGNvbW1lbnQgKElzc3VlICMxNjI4KS4gV2hlbiB0aGlzIGhvc3RcbiAqIHJlLWFkb3B0cyBpdHMgb3duIGxpdmUgY2xhaW0gY29tbWVudCwgdGhlIFBBVENIIG11c3Qga2VlcCB0aGF0IHByZWZpeCBvclxuICogY2xhaW0tcmFjZSBkZXRlY3Rpb24gbG9zZXMgaXRzIGxvY2sgbWFya2VyLiBSZXR1cm5zIFwiXCIgd2hlbiB0aGUgYm9keSBoYXNcbiAqIG5vIENMQUlNX0xPQ0sgcHJlZml4LlxuICovXG5mdW5jdGlvbiBleHRyYWN0Q2xhaW1QcmVmaXgoYm9keTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFib2R5LmluY2x1ZGVzKFwiPCEtLSBDTEFJTV9MT0NLOlwiKSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IG1hcmtlckluZGV4ID0gYm9keS5pbmRleE9mKGA8IS0tICR7SEVBUlRCRUFUX01BUktFUl9QUkVGSVh9OmApO1xuICBjb25zdCBwcmVmaXggPSBtYXJrZXJJbmRleCA+PSAwID8gYm9keS5zdWJzdHJpbmcoMCwgbWFya2VySW5kZXgpIDogYm9keTtcbiAgcmV0dXJuIHByZWZpeC5yZXBsYWNlKC9cXHMrJC8sIFwiXCIpO1xufVxuXG4vKipcbiAqIEFkb3B0IHRoZSBoZWFydGJlYXQgbWFya2VyIGNvbW1lbnQgYWxyZWFkeSBvbiB0aGUgaXNzdWUvUFIsIGlmIGFueVxuICogKElzc3VlICMzNzUxKS5cbiAqXG4gKiBSZXR1cm5zIHRoZSBhZG9wdGVkIGNvbW1lbnQgaWQgKGFuZCBhbnkgQ0xBSU1fTE9DSyBwcmVmaXggdG8ga2VlcCBvblxuICogbGF0ZXIgcmVmcmVzaGVzKSBhZnRlciBhIHN1Y2Nlc3NmdWwgUEFUQ0gsIG9yIG51bGwgd2hlbiB0aGVyZSBpcyBub3RoaW5nXG4gKiB0byBhZG9wdCwgdGhlIG1hcmtlciBiZWxvbmdzIHRvIGFub3RoZXIgbGl2ZSBtYWNoaW5lIChjb250ZW50aW9uIOKAlCB0aGVcbiAqIGNhbGxlciBwb3N0cyBpdHMgb3duIG1hcmtlciwgdW5jaGFuZ2VkIGJlaGF2aW91ciksIG9yIHRoZSBQQVRDSCBmYWlsZWQuXG4gKiBBZG9wdGlvbiBpcyBiZXN0LWVmZm9ydDogZXZlcnkgZmFpbHVyZSBkZWdyYWRlcyB0byB0aGUgUE9TVCBwYXRoIHJhdGhlclxuICogdGhhbiBmYWlsaW5nIHRoZSBoZWFydGJlYXQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGFkb3B0RXhpc3RpbmdNYXJrZXIoXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgb3B0aW9uczogSGVhcnRiZWF0TWFya2VyT3B0aW9ucyxcbiAgZ2hGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4gIGhlYXJ0YmVhdEJvZHk6IHN0cmluZyxcbik6IFByb21pc2U8eyBjb21tZW50SWQ6IG51bWJlcjsgY2xhaW1QcmVmaXg6IHN0cmluZyB9IHwgbnVsbD4ge1xuICBsZXQgZm91bmQ6IEV4aXN0aW5nTWFya2VyQ29tbWVudCB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGZvdW5kID0gYXdhaXQgZmluZEV4aXN0aW5nTWFya2VyQ29tbWVudChcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZU51bWJlcixcbiAgICAgIGdoRm4sXG4gICAgICBvcHRpb25zLmFsbG93ZWRBdXRob3JzLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgICBcImNhdGNoX2Jsb2NrX3dhcm5pbmdcIixcbiAgICAgIGBtYXJrZXIgYWRvcHRpb24gbG9va3VwIGZhaWxlZCBmb3IgJHtyZXBvfSMke2lzc3VlTnVtYmVyfTogJHtlcnJ9YCxcbiAgICApO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmIChmb3VuZCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3Qgb3duZWRCeU90aGVyTGl2ZU1hY2hpbmUgPSBmb3VuZC5tYWNoaW5lSWQgIT09IG9wdGlvbnMubWFjaGluZUlkICYmXG4gICAgIWZvdW5kLmNsZWFyZWQgJiYgZm91bmQuZXBvY2ggPiAwO1xuICBpZiAob3duZWRCeU90aGVyTGl2ZU1hY2hpbmUpIHtcbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW2hlYXJ0YmVhdF0gbm90IGFkb3B0aW5nIG1hcmtlciBjb21tZW50ICR7Zm91bmQuY29tbWVudElkfSBvbiBgICtcbiAgICAgICAgYCR7cmVwb30jJHtpc3N1ZU51bWJlcn06IGhlbGQgYnkgbWFjaGluZSAke2ZvdW5kLm1hY2hpbmVJZH0gYCArXG4gICAgICAgIGAoZXBvY2ggJHtmb3VuZC5lcG9jaH0pIOKAlCBwdWJsaXNoaW5nIGEgc2VwYXJhdGUgbWFya2VyYCxcbiAgICApO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gT25seSB0aGlzIG1hY2hpbmUncyBvd24gc3RpbGwtbGl2ZSBjbGFpbSBrZWVwcyBpdHMgQ0xBSU1fTE9DSyBwcmVmaXg7IGFcbiAgLy8gY2xlYXJlZCBjb21tZW50IGlzIGJlaW5nIHJlLXVzZWQgZm9yIGEgKm5ldyogY2xhaW0sIHNvIHRoZSBwcmV2aW91c1xuICAvLyBjbGFpbSdzIGxvY2sgbWFya2VyIG11c3Qgbm90IGJlIHJlc3VycmVjdGVkLlxuICBjb25zdCBjbGFpbVByZWZpeCA9ICghZm91bmQuY2xlYXJlZCAmJiBmb3VuZC5tYWNoaW5lSWQgPT09IG9wdGlvbnMubWFjaGluZUlkKVxuICAgID8gZXh0cmFjdENsYWltUHJlZml4KGZvdW5kLmJvZHkpXG4gICAgOiBcIlwiO1xuICBjb25zdCBib2R5ID0gY2xhaW1QcmVmaXggPyBgJHtjbGFpbVByZWZpeH1cXG4ke2hlYXJ0YmVhdEJvZHl9YCA6IGhlYXJ0YmVhdEJvZHk7XG4gIGNvbnN0IHBhdGNoZWQgPSBhd2FpdCBwYXRjaE1hcmtlckNvbW1lbnQocmVwbywgZm91bmQuY29tbWVudElkLCBib2R5LCBnaEZuKTtcbiAgaWYgKCFwYXRjaGVkKSByZXR1cm4gbnVsbDtcblxuICAvLyBTZWxmLWhlYWwgdGhlIHRocmVhZCB3aGlsZSBpdCBpcyBiZWluZyB3b3JrZWQgKElzc3VlICMzNzU1KTogZXZlcnkgb3RoZXJcbiAgLy8gbWFya2VyLW9ubHkgY29tbWVudCBsZWZ0IGJlaGluZCBieSBhIHByZXZpb3VzIHJ1biBpcyBzd2VwdCBhd2F5LCBrZWVwaW5nXG4gIC8vIG9ubHkgdGhlIGNvbW1lbnQgd2UganVzdCBhZG9wdGVkLiBCZXN0LWVmZm9ydCDigJQgYSBzd2VlcCBmYWlsdXJlIG11c3RcbiAgLy8gbmV2ZXIgYnJlYWsgdGhlIGhlYXJ0YmVhdC5cbiAgdHJ5IHtcbiAgICBjb25zdCBzd2VlcCA9IGF3YWl0IHN3ZWVwSGVhcnRiZWF0Q29tbWVudHMocmVwbywgaXNzdWVOdW1iZXIsIGdoRm4sIHtcbiAgICAgIGtlZXBDb21tZW50SWQ6IGZvdW5kLmNvbW1lbnRJZCxcbiAgICAgIC4uLihvcHRpb25zLmFsbG93ZWRBdXRob3JzXG4gICAgICAgID8geyBhbGxvd2VkQXV0aG9yczogb3B0aW9ucy5hbGxvd2VkQXV0aG9ycyB9XG4gICAgICAgIDoge30pLFxuICAgICAgbWFjaGluZUlkOiBvcHRpb25zLm1hY2hpbmVJZCxcbiAgICB9KTtcbiAgICBpZiAoc3dlZXAuZGVsZXRlZC5sZW5ndGggPiAwIHx8IHN3ZWVwLm9ycGhhbmVkTGl2ZU1hcmtlcnMgPiAwKSB7XG4gICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgYFtoZWFydGJlYXRdIHN3ZXB0ICR7c3dlZXAuZGVsZXRlZC5sZW5ndGh9IHN0YWxlIG1hcmtlciBjb21tZW50KHMpIGAgK1xuICAgICAgICAgIGBvbiAke3JlcG99IyR7aXNzdWVOdW1iZXJ9IGAgK1xuICAgICAgICAgIGAoJHtzd2VlcC5vcnBoYW5lZExpdmVNYXJrZXJzfSBvcnBoYW5lZCBsaXZlIG1hcmtlcihzKSlgLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgICBcImNhdGNoX2Jsb2NrX3dhcm5pbmdcIixcbiAgICAgIGBoZWFydGJlYXQgc3dlZXAgZmFpbGVkIGZvciAke3JlcG99IyR7aXNzdWVOdW1iZXJ9OiAke2Vycn1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHsgY29tbWVudElkOiBmb3VuZC5jb21tZW50SWQsIGNsYWltUHJlZml4IH07XG59XG5cbi8qKlxuICogUHVibGlzaCBvciByZWZyZXNoIHRoZSBHaXRIdWIgaGVhcnRiZWF0IG1hcmtlciBjb21tZW50IGZvciBhbiBpc3N1ZVxuICogKElzc3VlICMxNDU0KS5cbiAqXG4gKiBGaXJzdCBjYWxsIHB1Ymxpc2hlcyBhIG5ldyBjb21tZW50IGFuZCBwZXJzaXN0cyB0aGUgY29tbWVudCBpZC4gU3Vic2VxdWVudFxuICogY2FsbHMgcmVmcmVzaCBubyBtb3JlIG9mdGVuIHRoYW4gYG1pblJlZnJlc2hTZWNvbmRzYCBieSBlZGl0aW5nIHRoZVxuICogZXhpc3RpbmcgY29tbWVudCBpbiBwbGFjZSB2aWEgYGdoIGFwaSBQQVRDSGAsIHNvIGNvbW1lbnQgaGlzdG9yeSBzdGF5c1xuICogdGlkeSBhbmQgb3RoZXIgbWFjaGluZXMgc2VlIHRoZSBtYXJrZXIncyBlcG9jaCBtb3ZlIGZvcndhcmQuXG4gKlxuICogUmV0dXJucyBgUmVzdWx0PHZvaWQ+YCDigJQgYHsgb2s6IGZhbHNlIH1gIHdoZW4gdGhlIEdpdEh1YiBBUEkgY2FsbCBmYWlsc1xuICogKG5vIGNvbW1lbnQgaWQgcmV0dXJuZWQpLiBDYWxsZXJzIG1heSB0cmVhdCB0aGlzIGFzIGZhdGFsIChpbml0aWFsXG4gKiBwdWJsaXNoIOKAlCBJc3N1ZSAjMTg4OCkgb3Igbm9uLWZhdGFsIChwZXJpb2RpYyByZWZyZXNoLCB3aGVyZSB0aGUgbmV4dFxuICogaXRlcmF0aW9uIHJldHJpZXMpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHVibGlzaE9yUmVmcmVzaE1hcmtlcihcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIG9wdGlvbnM6IEhlYXJ0YmVhdE1hcmtlck9wdGlvbnMsXG4gIG5vd0ZuOiAoKSA9PiBudW1iZXIgPSAoKSA9PiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IGdoRm4gPSBvcHRpb25zLmdoRm4gPz8gcnVuR2g7XG4gIGNvbnN0IG1pblJlZnJlc2ggPSBvcHRpb25zLm1pblJlZnJlc2hTZWNvbmRzID8/XG4gICAgREVGQVVMVF9NQVJLRVJfUkVGUkVTSF9TRUNPTkRTO1xuICBjb25zdCBub3cgPSBub3dGbigpO1xuICAvLyBNaWxlc3RvbmVzIGFyZSByZWFkIGxlbmllbnRseSAoSXNzdWUgIzM3NTMpIHNvIGEgbWlsZXN0b25lIHJlY29yZGVkXG4gIC8vIGJlZm9yZSB0aGUgZmlyc3QgcHVibGlzaCBpcyByZW5kZXJlZCBvbiB0aGF0IGZpcnN0IGNvbW1lbnQuXG4gIGNvbnN0IG1pbGVzdG9uZXMgPSBhd2FpdCByZWFkTWlsZXN0b25lcyh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcik7XG5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkTWFya2VyU3RhdGUod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIpO1xuICAvLyBJc3N1ZSAjMzc1MjogdGhlIHN0YXJ0IHRpbWUgYW5kIHdvcmtlciBpZCBhcmUgcGlubmVkIHdoZW4gdGhlIGNsYWltXG4gIC8vIGJlZ2lucyBhbmQgcmV1c2VkIG9uIGV2ZXJ5IHJlZnJlc2gsIHNvIHRoZSBib2R5IGtlZXBzIG5hbWluZyB0aGUgb3JpZ2luYWxcbiAgLy8gY2xhaW0gcmF0aGVyIHRoYW4gdGhlIGN1cnJlbnQgYmVhdC4gQSByZWxlYXNlZCBtYXJrZXIgaXMgcmV2aXZlZCBmb3IgYVxuICAvLyAqbmV3KiBjbGFpbSAoSXNzdWUgIzM3NTEpLCBzbyBpdHMgc3RhcnQgdGltZSByZXN0YXJ0cyB3aXRoIGl0LiBBIHN0YXRlXG4gIC8vIGZpbGUgd3JpdHRlbiBiZWZvcmUgIzM3NTIgaGFzIG5vIHN0YXJ0IHRpbWUg4oCUIHRoYXQgY2xhdXNlIHNpbXBseSBkcm9wcy5cbiAgY29uc3QgaXNOZXdDbGFpbSA9IGV4aXN0aW5nID09PSBudWxsIHx8IGV4aXN0aW5nLnJlbGVhc2VkID09PSB0cnVlO1xuICBjb25zdCBzdGFydGVkRXBvY2ggPSBpc05ld0NsYWltID8gbm93IDogZXhpc3Rpbmcuc3RhcnRlZEVwb2NoO1xuICBjb25zdCB3b3JrZXJJZCA9IG9wdGlvbnMud29ya2VySWQgPz8gZXhpc3Rpbmc/LndvcmtlcklkO1xuICBjb25zdCBoZWFydGJlYXRCb2R5ID0gcmVuZGVySGVhcnRiZWF0Qm9keSh7XG4gICAgbWFjaGluZUlkOiBvcHRpb25zLm1hY2hpbmVJZCxcbiAgICBlcG9jaDogbm93LFxuICAgIG1pbGVzdG9uZXMsXG4gICAgLi4uKG9wdGlvbnMuaG9zdCA/IHsgaG9zdDogb3B0aW9ucy5ob3N0IH0gOiB7fSksXG4gICAgLi4uKHdvcmtlcklkID8geyB3b3JrZXJJZCB9IDoge30pLFxuICAgIC4uLihzdGFydGVkRXBvY2ggPyB7IHN0YXJ0ZWRFcG9jaCB9IDoge30pLFxuICB9LCAoKSA9PiBub3cpO1xuICBjb25zdCBpZGVudGl0eSA9IHtcbiAgICAuLi4oc3RhcnRlZEVwb2NoID8geyBzdGFydGVkRXBvY2ggfSA6IHt9KSxcbiAgICAuLi4od29ya2VySWQgPyB7IHdvcmtlcklkIH0gOiB7fSksXG4gIH07XG5cbiAgaWYgKGV4aXN0aW5nID09PSBudWxsKSB7XG4gICAgLy8gTm8gbG9jYWwgc3RhdGUg4oCUIGFkb3B0IHRoZSBtYXJrZXIgY29tbWVudCBhbHJlYWR5IG9uIHRoZSBpc3N1ZS9QUlxuICAgIC8vIHJhdGhlciB0aGFuIHBvc3RpbmcgYSBkdXBsaWNhdGUgKElzc3VlICMzNzUxKS5cbiAgICBjb25zdCBhZG9wdGVkID0gYXdhaXQgYWRvcHRFeGlzdGluZ01hcmtlcihcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZU51bWJlcixcbiAgICAgIG9wdGlvbnMsXG4gICAgICBnaEZuLFxuICAgICAgaGVhcnRiZWF0Qm9keSxcbiAgICApO1xuICAgIGlmIChhZG9wdGVkICE9PSBudWxsKSB7XG4gICAgICBhd2FpdCB3cml0ZU1hcmtlclN0YXRlKHdvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyLCB7XG4gICAgICAgIGNvbW1lbnRJZDogYWRvcHRlZC5jb21tZW50SWQsXG4gICAgICAgIGxhc3RSZWZyZXNoOiBub3csXG4gICAgICAgIC4uLihhZG9wdGVkLmNsYWltUHJlZml4ID8geyBjbGFpbVByZWZpeDogYWRvcHRlZC5jbGFpbVByZWZpeCB9IDoge30pLFxuICAgICAgICAuLi5pZGVudGl0eSxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgICB9XG4gICAgY29uc3QgY29tbWVudElkID0gYXdhaXQgcG9zdE1hcmtlckNvbW1lbnQoXG4gICAgICByZXBvLFxuICAgICAgaXNzdWVOdW1iZXIsXG4gICAgICBoZWFydGJlYXRCb2R5LFxuICAgICAgZ2hGbixcbiAgICApO1xuICAgIGlmIChjb21tZW50SWQgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgRmFpbGVkIHRvIHB1Ymxpc2ggaGVhcnRiZWF0IG1hcmtlciBjb21tZW50IGZvciAke3JlcG99IyR7aXNzdWVOdW1iZXJ9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGF3YWl0IHdyaXRlTWFya2VyU3RhdGUod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIsIHtcbiAgICAgIGNvbW1lbnRJZCxcbiAgICAgIGxhc3RSZWZyZXNoOiBub3csXG4gICAgICAuLi5pZGVudGl0eSxcbiAgICB9KTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgLy8gQSByZWxlYXNlZCBtYXJrZXIgKGtlcHQgYnkgY2xlYXJIZWFydGJlYXQsIElzc3VlICMzNzUxKSBpcyByZXZpdmVkIG9uXG4gIC8vIHRoZSBuZXh0IGNsYWltIHJlZ2FyZGxlc3Mgb2YgdGhlIHJlZnJlc2ggd2luZG93IOKAlCBpdHMgYm9keSBjdXJyZW50bHlcbiAgLy8gcmVhZHMgZXBvY2ggMCwgc28gd2FpdGluZyB3b3VsZCBsZWF2ZSB0aGUgY2xhaW0gaW52aXNpYmxlLlxuICBpZiAoIWV4aXN0aW5nLnJlbGVhc2VkICYmIG5vdyAtIGV4aXN0aW5nLmxhc3RSZWZyZXNoIDwgbWluUmVmcmVzaCkge1xuICAgIC8vIFdpdGhpbiB0aGUgcmVmcmVzaCB3aW5kb3cg4oCUIGxlYXZlIHRoZSBleGlzdGluZyBtYXJrZXIgYWxvbmUuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuXG4gIC8vIFByZXNlcnZlIHRoZSBjbGFpbSBwcmVmaXggKENMQUlNX0xPQ0sgbWFya2VyKSB3aGVuIHJlZnJlc2hpbmcgc28gcmFjZVxuICAvLyBkZXRlY3Rpb24ga2VlcHMgd29ya2luZyBvbiB0aGUgY29tYmluZWQgY2xhaW0raGVhcnRiZWF0IGNvbW1lbnRcbiAgLy8gKElzc3VlICMxNjI4KS4gQSByZWxlYXNlZCBjb21tZW50IHN0YXJ0cyBhICpuZXcqIGNsYWltLCBzbyB0aGUgcHJldmlvdXNcbiAgLy8gY2xhaW0ncyBsb2NrIG1hcmtlciBpcyBkcm9wcGVkLlxuICBjb25zdCBjbGFpbVByZWZpeCA9IGV4aXN0aW5nLnJlbGVhc2VkID8gdW5kZWZpbmVkIDogZXhpc3RpbmcuY2xhaW1QcmVmaXg7XG4gIGNvbnN0IHJlZnJlc2hlZEJvZHkgPSBjbGFpbVByZWZpeFxuICAgID8gYCR7Y2xhaW1QcmVmaXh9XFxuJHtoZWFydGJlYXRCb2R5fWBcbiAgICA6IGhlYXJ0YmVhdEJvZHk7XG5cbiAgY29uc3QgZWRpdGVkID0gYXdhaXQgcGF0Y2hNYXJrZXJDb21tZW50KFxuICAgIHJlcG8sXG4gICAgZXhpc3RpbmcuY29tbWVudElkLFxuICAgIHJlZnJlc2hlZEJvZHksXG4gICAgZ2hGbixcbiAgKTtcbiAgaWYgKGVkaXRlZCkge1xuICAgIGF3YWl0IHdyaXRlTWFya2VyU3RhdGUod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIsIHtcbiAgICAgIGNvbW1lbnRJZDogZXhpc3RpbmcuY29tbWVudElkLFxuICAgICAgbGFzdFJlZnJlc2g6IG5vdyxcbiAgICAgIC4uLihjbGFpbVByZWZpeCA/IHsgY2xhaW1QcmVmaXggfSA6IHt9KSxcbiAgICAgIC4uLmlkZW50aXR5LFxuICAgIH0pO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH1cbiAgLy8gUEFUQ0ggZmFpbGVkIOKAlCBwb3N0IGEgZnJlc2ggY29tbWVudCBzbyB0aGUgY2xhaW0gc3RheXMgdmlzaWJsZS5cbiAgLy8gVGhlIGZyZXNoIGNvbW1lbnQgY2Fubm90IHJlY3JlYXRlIHRoZSBDTEFJTV9MT0NLIG1hcmtlciAodGhlIGNsYWltZXJcbiAgLy8gb3ducyB0aGF0KSwgc28ganVzdCBwdWJsaXNoIHRoZSBoZWFydGJlYXQgbWFya2VyIG9uIGl0cyBvd24uXG4gIGNvbnN0IGNvbW1lbnRJZCA9IGF3YWl0IHBvc3RNYXJrZXJDb21tZW50KFxuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICAgaGVhcnRiZWF0Qm9keSxcbiAgICBnaEZuLFxuICApO1xuICBpZiAoY29tbWVudElkID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gcmVmcmVzaCBoZWFydGJlYXQgbWFya2VyIGZvciAke3JlcG99IyR7aXNzdWVOdW1iZXJ9IChQQVRDSCBhbmQgUE9TVCBib3RoIGZhaWxlZClgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGF3YWl0IHdyaXRlTWFya2VyU3RhdGUod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIsIHtcbiAgICBjb21tZW50SWQsXG4gICAgbGFzdFJlZnJlc2g6IG5vdyxcbiAgICAuLi5pZGVudGl0eSxcbiAgfSk7XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG59XG5cbi8qKlxuICogQXBwZW5kIGEgbWlsZXN0b25lIHRvIHRoZSBoZWFydGJlYXQgcHJvZ3Jlc3MgbG9nIGFuZCBwdWJsaXNoIGl0IGF0IG9uY2VcbiAqIChJc3N1ZSAjMzc1MykuXG4gKlxuICogVGhlIGVudHJ5IGlzIHBlcnNpc3RlZCBpbiB0aGUgbWFya2VyIHN0YXRlIGZpbGUgKHNvIGl0IHN1cnZpdmVzIHBlcmlvZGljXG4gKiBiZWF0cywgYSBzdGF0ZS1maWxlIHJlbG9hZCwgYW5kIGNvbW1lbnQgYWRvcHRpb24gd2l0aGluIHRoZSBydW4pIGFuZCB0aGVuXG4gKiBwdXNoZWQgdG8gR2l0SHViIHRocm91Z2gge0BsaW5rIHB1Ymxpc2hPclJlZnJlc2hNYXJrZXJ9IHdpdGhcbiAqIGBtaW5SZWZyZXNoU2Vjb25kczogMGAsIGJ5cGFzc2luZyB0aGUgb3JkaW5hcnkgcmVmcmVzaCBnYXRlIHNvIHByb2dyZXNzIGlzXG4gKiB2aXNpYmxlIGltbWVkaWF0ZWx5IHJhdGhlciB0aGFuIHVwIHRvIGZpdmUgbWludXRlcyBsYXRlci4gUGVyaW9kaWMgYmVhdHNcbiAqIGtlZXAgaG9ub3VyaW5nIHRoZSBnYXRlLlxuICpcbiAqIEV2ZXJ5IGZhaWx1cmUgaXMgbm9uLWZhdGFsOiB0aGUgcmVzdWx0IGlzIGFsd2F5cyBgeyBvazogdHJ1ZSB9YCBzbyBhXG4gKiBtaWxlc3RvbmUgY2FuIG5ldmVyIGFib3J0IHRoZSB3b3JrIGl0IGlzIGRlc2NyaWJpbmcuIEEgZmFpbGVkIFBBVENIIHNpbXBseVxuICogbGVhdmVzIHRoZSBlbnRyeSBwZXJzaXN0ZWQgZm9yIHRoZSBuZXh0IHN1Y2Nlc3NmdWwgcmVmcmVzaC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlY29yZE1pbGVzdG9uZShcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIHRleHQ6IHN0cmluZyxcbiAgbWFya2VyT3B0aW9ucz86IEhlYXJ0YmVhdE1hcmtlck9wdGlvbnMsXG4gIG5vd0ZuOiAoKSA9PiBudW1iZXIgPSAoKSA9PiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZW50cnlUZXh0ID0gbm9ybWFsaXNlTWlsZXN0b25lVGV4dCh0ZXh0KTtcbiAgICBpZiAoZW50cnlUZXh0Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcblxuICAgIGNvbnN0IG5vdyA9IG5vd0ZuKCk7XG4gICAgY29uc3QgbWlsZXN0b25lcyA9IFtcbiAgICAgIC4uLmF3YWl0IHJlYWRNaWxlc3RvbmVzKHdvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyKSxcbiAgICAgIHsgZXBvY2g6IG5vdywgdGV4dDogZW50cnlUZXh0IH0sXG4gICAgXS5zbGljZSgtTUFYX01JTEVTVE9ORVMpO1xuXG4gICAgLy8gTWVyZ2UgaW50byB3aGF0ZXZlciB0aGUgc3RhdGUgZmlsZSBhbHJlYWR5IGhvbGRzIOKAlCB0aGUgY29tbWVudCBpZCBhbmRcbiAgICAvLyByZWZyZXNoIGVwb2NoIGJlbG9uZyB0byB0aGUgaGVhcnRiZWF0IHBhdGgsIG5vdCB0byB0aGlzIG9uZS5cbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHJlYWRNYXJrZXJTdGF0ZSh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcik7XG4gICAgaWYgKGV4aXN0aW5nICE9PSBudWxsKSB7XG4gICAgICBhd2FpdCB3cml0ZU1hcmtlclN0YXRlKHdvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyLCB7XG4gICAgICAgIC4uLmV4aXN0aW5nLFxuICAgICAgICBtaWxlc3RvbmVzLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGF3YWl0IHdyaXRlTWlsZXN0b25lc09ubHkod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIsIG1pbGVzdG9uZXMpO1xuICAgIH1cblxuICAgIGlmIChtYXJrZXJPcHRpb25zICYmIG1hcmtlck9wdGlvbnMubWFjaGluZUlkLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IHB1Ymxpc2hPclJlZnJlc2hNYXJrZXIoXG4gICAgICAgIHdvcmtEaXIsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIGlzc3VlTnVtYmVyLFxuICAgICAgICB7IC4uLm1hcmtlck9wdGlvbnMsIG1pblJlZnJlc2hTZWNvbmRzOiAwIH0sXG4gICAgICAgICgpID0+IG5vdyxcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgXCJjYXRjaF9ibG9ja193YXJuaW5nXCIsXG4gICAgICBgcmVjb3JkTWlsZXN0b25lIGZhaWxlZCBmb3IgJHtyZXBvfSMke2lzc3VlTnVtYmVyfTogJHtlcnJ9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG59XG5cbi8qKlxuICogUGVyc2lzdCBtaWxlc3RvbmVzIHdoZW4gbm8gbWFya2VyIGNvbW1lbnQgZXhpc3RzIHlldCAoSXNzdWUgIzM3NTMpLlxuICpcbiAqIFdyaXRpbmcgb25seSB0aGUgYG1pbGVzdG9uZXNgIGtleSBrZWVwcyB0aGUgZmlsZSBpbnZhbGlkIGZvclxuICoge0BsaW5rIHJlYWRNYXJrZXJTdGF0ZX0sIHNvIHRoZSBuZXh0IHB1Ymxpc2ggc3RpbGwgdGFrZXMgdGhlIGFkb3B0LW9yLXBvc3RcbiAqIHBhdGgg4oCUIGl0IGp1c3QgcmVuZGVycyB0aGUgc3Rhc2hlZCBsb2cgb24gdGhlIGNvbW1lbnQgaXQgY3JlYXRlcy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gd3JpdGVNaWxlc3RvbmVzT25seShcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIG1pbGVzdG9uZXM6IEhlYXJ0YmVhdE1pbGVzdG9uZVtdLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2Rpcih3b3JrRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gRGlyZWN0b3J5IGFscmVhZHkgZXhpc3RzIOKAlCBub24tZmF0YWxcbiAgfVxuICBsZXQgZXhpc3Rpbmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHRyeSB7XG4gICAgZXhpc3RpbmcgPSBKU09OLnBhcnNlKFxuICAgICAgYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUobWFya2VyU3RhdGVGaWxlUGF0aCh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcikpLFxuICAgICkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vIHJlYWRhYmxlIHN0YXRlIHlldCDigJQgc3RhcnQgZnJvbSBhbiBlbXB0eSBvYmplY3QuXG4gIH1cbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBtYXJrZXJTdGF0ZUZpbGVQYXRoKHdvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgLi4uZXhpc3RpbmcsIG1pbGVzdG9uZXMgfSksXG4gICAgKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIOKAlCB0aGUgbWlsZXN0b25lIGlzIHNpbXBseSBub3QgcGVyc2lzdGVkLlxuICB9XG59XG5cbi8qKlxuICogUmVjb3JkICh3cml0ZS91cGRhdGUpIGEgaGVhcnRiZWF0IHRpbWVzdGFtcCBmb3IgYW4gaXNzdWUuXG4gKlxuICogV2hlbiBgbWFya2VyT3B0aW9uc2AgaXMgcHJvdmlkZWQsIGFsc28gcHVibGlzaGVzIChvciByZWZyZXNoZXMpIGFcbiAqIEdpdEh1Yi12aXNpYmxlIG1hcmtlciBjb21tZW50IHNvIG90aGVyIG1hY2hpbmVzIHJ1bm5pbmcgdGhlIHNhbWVcbiAqIGBnaXRodWJVc2VyYCBjYW4gc2VlIHRoaXMgY2xhaW0gaXMgYWxpdmUgKElzc3VlICMxNDU0KS5cbiAqXG4gKiBNYXJrZXIgcHVibGlzaCBmYWlsdXJlcyBhcmUgcHJvcGFnYXRlZCBhcyBgeyBvazogZmFsc2UsIGVycm9yIH1gIHNvIHRoZVxuICogY2FsbGVyIGNhbiBkZWNpZGUgd2hldGhlciB0byB0cmVhdCB0aGVtIGFzIGZhdGFsIChJc3N1ZSAjMTg4OCDigJQgaW5pdGlhbFxuICogaGVhcnRiZWF0IG11c3Qgc3VjY2VlZCBiZWZvcmUgYSBjbGFpbSBpcyBjb25zaWRlcmVkIGxpdmUpIG9yIG5vbi1mYXRhbFxuICogKHBlcmlvZGljIHJlZnJlc2gg4oCUIGNvdW50ZWQgdmlhIHRoZSBjb25zZWN1dGl2ZS1mYWlsdXJlIGNvdW50ZXIgYW5kXG4gKiByZXRyaWVkIG9uIHRoZSBuZXh0IGludGVydmFsKS5cbiAqXG4gKiBJc3N1ZSAjMjE0OiBhIGJlYXQgYWZ0ZXIgdGhlIGNsYWltIHdhcyByZWxlYXNlZCBpcyByZWZ1c2VkLCBsb3VkbHkuIEFcbiAqIGhlYXJ0YmVhdCB0aGF0IG91dGxpdmVzIGl0cyByZWxlYXNlIGlzIHdoYXQgbGVhdmVzIGFuIGlzc3VlIFwidW5hc3NpZ25lZFxuICogd2l0aCBhIGxpdmUgaGVhcnRiZWF0XCIg4oCUIHRoZSBzdGF0ZSB0aGF0IG1hZGUgZXZlcnkgaG9zdCByZWFkIFZpYmVDb2RlciMxODVcbiAqIGFzIGZyZWUgd2hpbGUgYSBzaWJsaW5nIHdhcyBzdGlsbCB3b3JraW5nIGl0LiBUaGUgZ3VhcmQgaXMgbGlmdGVkIGJ5IHRoZVxuICogbmV4dCBjbGFpbSBvbiB0aGlzIHdvcmsgZGlyZWN0b3J5IChzZWUge0BsaW5rIGNsZWFyQ2xhaW1SZWxlYXNlR3VhcmR9KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlY29yZEhlYXJ0YmVhdChcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIG5vd0ZuOiAoKSA9PiBudW1iZXIgPSAoKSA9PiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSxcbiAgbWFya2VyT3B0aW9ucz86IEhlYXJ0YmVhdE1hcmtlck9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBpZiAoaXNDbGFpbVJlbGVhc2VkKHdvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyKSkge1xuICAgIGNvbnN0IG1lc3NhZ2UgPVxuICAgICAgYFJlZnVzZWQgdG8gcmVjb3JkIGEgaGVhcnRiZWF0IGZvciAke3JlcG99IyR7aXNzdWVOdW1iZXJ9OiBgICtcbiAgICAgIGB0aGUgY2xhaW0gd2FzIGFscmVhZHkgcmVsZWFzZWQgKElzc3VlICMyMTQpYDtcbiAgICBjb25zb2xlLndhcm4oYFtoZWFydGJlYXRdIGhlYXJ0YmVhdF9hZnRlcl9yZWxlYXNlICR7bWVzc2FnZX1gKTtcbiAgICByZWNvcmRGYXVsdEV2ZW50KFwiY2F0Y2hfYmxvY2tfd2FybmluZ1wiLCBtZXNzYWdlKTtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBuZXcgRXJyb3IobWVzc2FnZSkgfTtcbiAgfVxuICBjb25zdCBwYXRoID0gaGVhcnRiZWF0RmlsZVBhdGgod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIpO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShwYXRoLCBTdHJpbmcobm93Rm4oKSkpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihgRmFpbGVkIHRvIHJlY29yZCBoZWFydGJlYXQ6ICR7ZXJyfWApLFxuICAgIH07XG4gIH1cblxuICBpZiAobWFya2VyT3B0aW9ucyAmJiBtYXJrZXJPcHRpb25zLm1hY2hpbmVJZC5sZW5ndGggPiAwKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG1hcmtlclJlc3VsdCA9IGF3YWl0IHB1Ymxpc2hPclJlZnJlc2hNYXJrZXIoXG4gICAgICAgIHdvcmtEaXIsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIGlzc3VlTnVtYmVyLFxuICAgICAgICBtYXJrZXJPcHRpb25zLFxuICAgICAgICBub3dGbixcbiAgICAgICk7XG4gICAgICBpZiAoIW1hcmtlclJlc3VsdC5vaykge1xuICAgICAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgICAgIFwiY2F0Y2hfYmxvY2tfd2FybmluZ1wiLFxuICAgICAgICAgIGBtYXJrZXIgcHVibGlzaC9yZWZyZXNoIGZhaWxlZCBmb3IgJHtyZXBvfSMke2lzc3VlTnVtYmVyfTogJHttYXJrZXJSZXN1bHQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gbWFya2VyUmVzdWx0O1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgcmVjb3JkRmF1bHRFdmVudChcbiAgICAgICAgXCJjYXRjaF9ibG9ja193YXJuaW5nXCIsXG4gICAgICAgIGBtYXJrZXIgcHVibGlzaC9yZWZyZXNoIHRocmV3IGZvciAke3JlcG99IyR7aXNzdWVOdW1iZXJ9OiAke21zZ31gLFxuICAgICAgKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihgTWFya2VyIHB1Ymxpc2gvcmVmcmVzaCB0aHJldzogJHttc2d9YCksXG4gICAgICB9O1xuICAgIH1cbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xufVxuXG4vKipcbiAqIENsZWFyIChyZW1vdmUpIHRoZSBoZWFydGJlYXQgZmlsZSBhZnRlciBzdWNjZXNzZnVsIGNvbXBsZXRpb24uXG4gKlxuICogV2hlbiBgbWFya2VyT3B0aW9uc2AgaXMgcHJvdmlkZWQsIGFsc28gaW52YWxpZGF0ZXMgdGhlIHB1Ymxpc2hlZCBHaXRIdWJcbiAqIG1hcmtlciBjb21tZW50IChJc3N1ZSAjMTQ1NCkgc28gYSBzdGFsZSBtYXJrZXIgY2Fubm90IGxhdGVyIGJsb2NrXG4gKiByZWNvdmVyeSBvZiB0aGUgaXNzdWUgaWYgaXQgaXMgcmVhc3NpZ25lZCB0byBhIGRpZmZlcmVudCB3b3JrZXIuXG4gKi9cbi8qKlxuICogUnVuIG91dGNvbWVzIGhhbmRlZCB0byB0aGUgbmV4dCB7QGxpbmsgY2xlYXJIZWFydGJlYXR9IGZvciBhbiBpc3N1ZVxuICogKElzc3VlICM0MzMwKS4gYHN0b3BIZWFydGJlYXQoaGFuZGxlLCBvdXRjb21lKWAgY2Fubm90IGNoYW5nZSBldmVyeVxuICogYGNsZWFyRm5gIHdpcmluZydzIHNpZ25hdHVyZSwgc28gaXQgcGFya3MgdGhlIG91dGNvbWUgaGVyZSwga2V5ZWQgYnlcbiAqIHJlcG8jaXNzdWUsIGFuZCB0aGUgY2xlYXIgdGhhdCBmb2xsb3dzIGNvbnN1bWVzIGl0LiBUYWtlbiBleGFjdGx5IG9uY2UuXG4gKi9cbmNvbnN0IHBlbmRpbmdSZWxlYXNlT3V0Y29tZXMgPSBuZXcgTWFwPHN0cmluZywgUnVuT3V0Y29tZT4oKTtcblxuZnVuY3Rpb24gcGVuZGluZ0tleShyZXBvOiBzdHJpbmcsIGlzc3VlTnVtYmVyOiBudW1iZXIpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7cmVwb30jJHtpc3N1ZU51bWJlcn1gO1xufVxuXG4vKipcbiAqIENsYWltcyByZWxlYXNlZCBpbiB0aGlzIHByb2Nlc3MsIGtleWVkIGJ5IHdvcmsgZGlyZWN0b3J5IGFuZCBpc3N1ZVxuICogKElzc3VlICMyMTQpLlxuICpcbiAqIFRoZSByZWxlYXNlIHBhdGggaXMgb3JkZXJlZCBzdG9wIGhlYXJ0YmVhdCDihpIgcG9zdCBvdXRjb21lIOKGkiB1bmFzc2lnbiwgc29cbiAqIGFuIGlzc3VlIGlzIG5ldmVyIHVuYXNzaWduZWQgd2hpbGUgaXRzIGhlYXJ0YmVhdCBpcyBzdGlsbCBiZWF0aW5nLiBUaGlzXG4gKiBzZXQgY2xvc2VzIHRoZSBvdGhlciBkaXJlY3Rpb246IG9uY2UgYSBjbGFpbSBpcyByZWxlYXNlZCwgbm90aGluZyBtYXlcbiAqIHdyaXRlIGEgaGVhcnRiZWF0IGZvciBpdCBhZ2FpbiDigJQgbm90IGEgc3RyYWdnbGluZyBpbnRlcnZhbCBjYWxsYmFjaywgbm90IGFcbiAqIGtlZXAtYWxpdmUgZnJvbSBhIHByb2Nlc3NvciB0aGF0IGhhcyBhbHJlYWR5IGhhbmRlZCB0aGUgaXNzdWUgYmFjay4gVGhlXG4gKiBrZXkgaW5jbHVkZXMgdGhlIHdvcmsgZGlyZWN0b3J5IGJlY2F1c2UgdGhhdCBpcyB3aGF0IGlkZW50aWZpZXMgdGhlIGNsYWltXG4gKiBhIGhlYXJ0YmVhdCBiZWxvbmdzIHRvOyBhIGRpZmZlcmVudCBzbG90J3MgZGlyZWN0b3J5IGlzIGEgZGlmZmVyZW50IGNsYWltLlxuICovXG5jb25zdCByZWxlYXNlZENsYWltcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG5mdW5jdGlvbiByZWxlYXNlS2V5KFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IHN0cmluZyB7XG4gIHJldHVybiBgJHt3b3JrRGlyfVx1MDAwMCR7cmVwb30jJHtpc3N1ZU51bWJlcn1gO1xufVxuXG4vKiogUmVjb3JkIHRoYXQgdGhpcyBjbGFpbSBoYXMgYmVlbiByZWxlYXNlZCDigJQgbm8gZnVydGhlciBiZWF0cyBhbGxvd2VkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtDbGFpbVJlbGVhc2VkKFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IHZvaWQge1xuICByZWxlYXNlZENsYWltcy5hZGQocmVsZWFzZUtleSh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcikpO1xufVxuXG4vKipcbiAqIExpZnQgdGhlIGd1YXJkIGJlY2F1c2UgYSBuZXcgY2xhaW0gb24gdGhpcyBpc3N1ZSBoYXMgYmVndW4gKElzc3VlICMyMTQpLlxuICpcbiAqIENhbGxlZCBieSBgc3RhcnRIZWFydGJlYXRgIGFuZCBieSB0aGUgY2xhaW0gcGF0aCdzIG1hcmtlciBzZWVkaW5nLCBzbyBhXG4gKiBsZWdpdGltYXRlIHJlLWNsYWltIGJlYXRzIG5vcm1hbGx5IHdoaWxlIGEgcmVsZWFzZWQgY2xhaW0gc3RheXMgc2lsZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJDbGFpbVJlbGVhc2VHdWFyZChcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4pOiB2b2lkIHtcbiAgcmVsZWFzZWRDbGFpbXMuZGVsZXRlKHJlbGVhc2VLZXkod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIpKTtcbn1cblxuLyoqIFdoZXRoZXIgdGhpcyBjbGFpbSBoYXMgYmVlbiByZWxlYXNlZCBhbmQgbXVzdCBub3QgYmVhdCBhZ2Fpbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0NsYWltUmVsZWFzZWQoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiByZWxlYXNlZENsYWltcy5oYXMocmVsZWFzZUtleSh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcikpO1xufVxuXG4vKiogUGFyayBhbiBvdXRjb21lIGZvciB0aGUgbmV4dCBjbGVhciBvZiB0aGlzIGlzc3VlIChJc3N1ZSAjNDMzMCkuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0UGVuZGluZ1JlbGVhc2VPdXRjb21lKFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIG91dGNvbWU6IFJ1bk91dGNvbWUsXG4pOiB2b2lkIHtcbiAgcGVuZGluZ1JlbGVhc2VPdXRjb21lcy5zZXQocGVuZGluZ0tleShyZXBvLCBpc3N1ZU51bWJlciksIG91dGNvbWUpO1xufVxuXG4vKiogVGFrZSAoYW5kIGZvcmdldCkgdGhlIHBhcmtlZCBvdXRjb21lIGZvciB0aGlzIGlzc3VlLCBpZiBhbnkuICovXG5leHBvcnQgZnVuY3Rpb24gdGFrZVBlbmRpbmdSZWxlYXNlT3V0Y29tZShcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogUnVuT3V0Y29tZSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGtleSA9IHBlbmRpbmdLZXkocmVwbywgaXNzdWVOdW1iZXIpO1xuICBjb25zdCBvdXRjb21lID0gcGVuZGluZ1JlbGVhc2VPdXRjb21lcy5nZXQoa2V5KTtcbiAgcGVuZGluZ1JlbGVhc2VPdXRjb21lcy5kZWxldGUoa2V5KTtcbiAgcmV0dXJuIG91dGNvbWU7XG59XG5cbi8qKiBTYW1lIGF0dGVtcHQgc2VlbiB0d2ljZSAoaG9zdCBhbmQgY2xvY2sgbWludXRlKTogdGhlIHNlY29uZCBjbGVhciBvZiBvbmUgcmVsZWFzZS4gKi9cbmZ1bmN0aW9uIGlzU2FtZUF0dGVtcHQoXG4gIGE6IFJlbGVhc2VBdHRlbXB0IHwgdW5kZWZpbmVkLFxuICBiOiBSZWxlYXNlQXR0ZW1wdCxcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gYSAhPT0gdW5kZWZpbmVkICYmIGEuaG9zdCA9PT0gYi5ob3N0ICYmXG4gICAgZm9ybWF0TWlsZXN0b25lVGltZShhLmVwb2NoKSA9PT0gZm9ybWF0TWlsZXN0b25lVGltZShiLmVwb2NoKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFySGVhcnRiZWF0KFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgbWFya2VyT3B0aW9ucz86IEhlYXJ0YmVhdE1hcmtlck9wdGlvbnMsXG4gIG5vd0ZuOiAoKSA9PiBudW1iZXIgPSAoKSA9PiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSxcbiAgb3V0Y29tZT86IFJ1bk91dGNvbWUsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICAvLyBUaGUgY2xhaW0gaXMgcmVsZWFzZWQgZnJvbSBoZXJlIG9uIChJc3N1ZSAjMjE0KTogYW55IGxhdGVyIGJlYXQgZm9yIGl0XG4gIC8vIGlzIGEgbGVhayBhbmQgaXMgcmVmdXNlZCBieSBgcmVjb3JkSGVhcnRiZWF0YC5cbiAgbWFya0NsYWltUmVsZWFzZWQod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIpO1xuICBjb25zdCBwYXRoID0gaGVhcnRiZWF0RmlsZVBhdGgod29ya0RpciwgcmVwbywgaXNzdWVOdW1iZXIpO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHBhdGgpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBGaWxlIGRvZXNuJ3QgZXhpc3Qgb3IgcmVtb3ZhbCBmYWlsZWQg4oCUIG5vbi1mYXRhbFxuICB9XG4gIC8vIEFuIG91dGNvbWUgcGFya2VkIGJ5IHN0b3BIZWFydGJlYXQgKElzc3VlICM0MzMwKSByZWFjaGVzIHRoaXMgY2xlYXIuXG4gIG91dGNvbWUgPz89IHRha2VQZW5kaW5nUmVsZWFzZU91dGNvbWUocmVwbywgaXNzdWVOdW1iZXIpO1xuXG4gIGlmIChtYXJrZXJPcHRpb25zICYmIG1hcmtlck9wdGlvbnMubWFjaGluZUlkLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBnaEZuID0gbWFya2VyT3B0aW9ucy5naEZuID8/IHJ1bkdoO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgcmVhZE1hcmtlclN0YXRlKHdvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyKTtcbiAgICBjb25zdCBub3cgPSBub3dGbigpO1xuICAgIC8vIEEgY2xlYXIgd2l0aCBub3RoaW5nIG5ldyB0byBzYXkgb24gYW4gYWxyZWFkeS1yZWxlYXNlZCBjbGFpbSAoY3Jhc2hcbiAgICAvLyBjbGVhbnVwLCB0aGUgc3R1Y2staXNzdWUgZGV0ZWN0b3IsIGEgc2Vjb25kIHN0b3Agb2Ygb25lIGhlYXJ0YmVhdClcbiAgICAvLyBtdXN0IG5vdCBvdmVyd3JpdGUgdGhlIG91dGNvbWUgdGhhdCBpcyBhbHJlYWR5IHRoZXJlIChJc3N1ZSAjNDMzMCkuXG4gICAgaWYgKGV4aXN0aW5nPy5yZWxlYXNlZCAmJiAhb3V0Y29tZSkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgICB9XG4gICAgY29uc3QgaG9zdCA9IG1hcmtlck9wdGlvbnMuaG9zdCA/P1xuICAgICAgaG9zdEZyb21NYWNoaW5lSWQobWFya2VyT3B0aW9ucy5tYWNoaW5lSWQpO1xuICAgIGNvbnN0IHRoaXNBdHRlbXB0OiBSZWxlYXNlQXR0ZW1wdCA9IHtcbiAgICAgIGVwb2NoOiBub3csXG4gICAgICBob3N0LFxuICAgICAgdGV4dDogZGVzY3JpYmVBdHRlbXB0T3V0Y29tZShvdXRjb21lKSxcbiAgICB9O1xuXG4gICAgLy8gQ29sbGFwc2UgKElzc3VlICM0MzI3KTogZXZlcnkgY2xhaW0gcG9zdHMgaXRzIG93biBDTEFJTV9MT0NLIGNvbW1lbnRcbiAgICAvLyBhbmQgc2VlZHMgdGhlIG1hcmtlciBzdGF0ZSB0byBpdCwgc28g4oCUIGJlZm9yZSB0aGlzIOKAlCBlYWNoIHJlbGVhc2VcbiAgICAvLyBQQVRDSGVkIGEgZnJlc2ggY29tbWVudCBhbmQgIzQxNzQgY29sbGVjdGVkIGZvdXIuIFRoZSByZWxlYXNlIG5vd1xuICAgIC8vIGxhbmRzIG9uIE9ORSBjYW5vbmljYWwgY29tbWVudDogdGhlIG9sZGVzdCBmbGVldC1hdXRob3JlZCByZWxlYXNlXG4gICAgLy8gKGNsZWFyZWQgbWFya2VyKSBhbHJlYWR5IG9uIHRoZSB0aHJlYWQuIFRoaXMgaG9zdCdzIG93biBjb21tZW50LCB3aGVuXG4gICAgLy8gaXQgaXMgbm90IHRoZSBjYW5vbmljYWwsIGlzIHJlZHVjZWQgdG8gYSBwb2ludGVyIHRoYXQgdGhlIGV4aXN0aW5nXG4gICAgLy8gc3dlZXAgcmVtb3Zlcy4gTG9jYWwgc3RhdGUgYWJzZW50IChjb2xkIGhvc3QpIOKGkiB0aGUgY2Fub25pY2FsIGlzXG4gICAgLy8gYWRvcHRlZCB0aGUgc2FtZSB3YXkuIEFsbCBiZXN0LWVmZm9ydDogYSBsaXN0aW5nIGZhaWx1cmUgZGVncmFkZXMgdG9cbiAgICAvLyB0b2RheSdzIHNpbmdsZS1jb21tZW50IGJlaGF2aW91ciwgbmV2ZXIgdGhyb3dzLlxuICAgIGxldCBjYW5vbmljYWw6IEV4aXN0aW5nTWFya2VyQ29tbWVudCB8IG51bGwgPSBudWxsO1xuICAgIGxldCBsaXN0ZWQ6IEV4aXN0aW5nTWFya2VyQ29tbWVudFtdIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGxpc3RlZCA9IGF3YWl0IGxpc3RGbGVldE1hcmtlckNvbW1lbnRzKFxuICAgICAgICByZXBvLFxuICAgICAgICBpc3N1ZU51bWJlcixcbiAgICAgICAgZ2hGbixcbiAgICAgICAgbWFya2VyT3B0aW9ucy5hbGxvd2VkQXV0aG9ycyxcbiAgICAgICk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBsaXN0ZWQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAobGlzdGVkICE9PSBudWxsKSB7XG4gICAgICBjYW5vbmljYWwgPSBsaXN0ZWQuZmluZCgoYykgPT5cbiAgICAgICAgYy5jbGVhcmVkICYmIGMuY29tbWVudElkICE9PSBleGlzdGluZz8uY29tbWVudElkXG4gICAgICApID8/IG51bGw7XG4gICAgICBpZiAoY2Fub25pY2FsID09PSBudWxsICYmIGV4aXN0aW5nID09PSBudWxsKSB7XG4gICAgICAgIC8vIE5vdGhpbmcgcmVsZWFzZWQgeWV0IG9uIHRoZSB0aHJlYWQgYW5kIG5vIGxvY2FsIHN0YXRlOiBhZG9wdCB0aGVcbiAgICAgICAgLy8gbmV3ZXN0IGZsZWV0IG1hcmtlciAodGhlIGNsYWltIGNvbW1lbnQgdGhpcyBob3N0IGNhbm5vdCBzZWVcbiAgICAgICAgLy8gbG9jYWxseSkgc28gdGhlIHJlbGVhc2UgdGV4dCBsYW5kcyBzb21ld2hlcmUuXG4gICAgICAgIGNhbm9uaWNhbCA9IGxpc3RlZC5sZW5ndGggPiAwID8gbGlzdGVkW2xpc3RlZC5sZW5ndGggLSAxXSEgOiBudWxsO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRoZSB0YWxseTogdGhpcyBob3N0J3Mgc3RhdGUgKHNhbWUtaG9zdCByZXZpdmUpIG9yIHRoZSBjYW5vbmljYWwgYm9keVxuICAgIC8vICh0aGUgb25seSBzb3VyY2UgdGhhdCBzdXJ2aXZlcyBhIGhvc3QgY2hhbmdlKSwgcGx1cyB0aGlzIGF0dGVtcHQuXG4gICAgY29uc3QgY2Fub25pY2FsVGFsbHkgPSBjYW5vbmljYWwgPyBwYXJzZUF0dGVtcHRCbG9jayhjYW5vbmljYWwuYm9keSkgOiBudWxsO1xuICAgIGNvbnN0IG93bkJvZHkgPSBleGlzdGluZyAmJiBsaXN0ZWRcbiAgICAgID8gbGlzdGVkLmZpbmQoKGMpID0+IGMuY29tbWVudElkID09PSBleGlzdGluZy5jb21tZW50SWQpPy5ib2R5XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjYW5vbmljYWxTaW5nbGUgPSBjYW5vbmljYWwgJiYgY2Fub25pY2FsVGFsbHkgPT09IG51bGxcbiAgICAgID8gKCgpID0+IHtcbiAgICAgICAgY29uc3QgZmlyc3QgPSBwYXJzZVJlbGVhc2VBdHRlbXB0RnJvbUJvZHkoY2Fub25pY2FsLmJvZHkpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHRvdGFsOiAxLFxuICAgICAgICAgIGF0dGVtcHRzOiBbXG4gICAgICAgICAgICBmaXJzdCA/PyB7XG4gICAgICAgICAgICAgIGVwb2NoOiAwLFxuICAgICAgICAgICAgICBob3N0OiBob3N0RnJvbU1hY2hpbmVJZChjYW5vbmljYWwubWFjaGluZUlkKSxcbiAgICAgICAgICAgICAgdGV4dDogXCJyZWxlYXNlZFwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9IHNhdGlzZmllcyBSZWxlYXNlQXR0ZW1wdFRhbGx5O1xuICAgICAgfSkoKVxuICAgICAgOiBudWxsO1xuICAgIGNvbnN0IHByZXZpb3VzID0gY2Fub25pY2FsVGFsbHkgPz8gY2Fub25pY2FsU2luZ2xlID8/XG4gICAgICAob3duQm9keSA/IHBhcnNlQXR0ZW1wdEJsb2NrKG93bkJvZHkpIDogbnVsbCkgPz9cbiAgICAgIGV4aXN0aW5nPy5hdHRlbXB0cyA/PyBudWxsO1xuICAgIC8vIFRoZSBzZWNvbmQgY2xlYXIgb2Ygb25lIHJlbGVhc2UgKGhlYXJ0YmVhdCBzdG9wLCB0aGVuIHRoZSBjbGFpbVxuICAgIC8vIHJlbGVhc2UpIHNheXMgdGhlIHNhbWUgdGhpbmc6IHNraXAgdGhlIHdyaXRlLlxuICAgIGNvbnN0IGxhc3QgPSBleGlzdGluZz8uYXR0ZW1wdHM/LmF0dGVtcHRzLmF0KC0xKTtcbiAgICBpZiAoXG4gICAgICBleGlzdGluZz8ucmVsZWFzZWQgJiYgaXNTYW1lQXR0ZW1wdChsYXN0LCB0aGlzQXR0ZW1wdCkgJiZcbiAgICAgIGxhc3QhLnRleHQgPT09IHRoaXNBdHRlbXB0LnRleHRcbiAgICApIHtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gICAgfVxuICAgIGNvbnN0IHRhbGx5ID0gYXBwZW5kQXR0ZW1wdChwcmV2aW91cywgdGhpc0F0dGVtcHQpO1xuXG4gICAgY29uc3QgdGFyZ2V0ID0gY2Fub25pY2FsPy5jb21tZW50SWQgPz8gZXhpc3Rpbmc/LmNvbW1lbnRJZCA/PyBudWxsO1xuICAgIGlmICh0YXJnZXQgIT09IG51bGwpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGludmFsaWRhdGVNYXJrZXJDb21tZW50KFxuICAgICAgICAgIHJlcG8sXG4gICAgICAgICAgdGFyZ2V0LFxuICAgICAgICAgIG1hcmtlck9wdGlvbnMubWFjaGluZUlkLFxuICAgICAgICAgIGdoRm4sXG4gICAgICAgICAgZXhpc3Rpbmc/Lm1pbGVzdG9uZXMgPz8gW10sXG4gICAgICAgICAgbWFya2VyT3B0aW9ucy5ob3N0LFxuICAgICAgICAgIG5vd0ZuLFxuICAgICAgICAgIG91dGNvbWUsXG4gICAgICAgICAgdGFsbHksXG4gICAgICAgICk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVjb3JkRmF1bHRFdmVudChcbiAgICAgICAgICBcImNhdGNoX2Jsb2NrX3dhcm5pbmdcIixcbiAgICAgICAgICBgbWFya2VyIGludmFsaWRhdGUgZmFpbGVkIGZvciAke3JlcG99IyR7aXNzdWVOdW1iZXJ9OiAke2Vycn1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gVGhpcyBob3N0J3Mgb3duIGNvbW1lbnQsIHN1cGVyc2VkZWQgYnkgdGhlIGNhbm9uaWNhbDogYSBwb2ludGVyXG4gICAgICAvLyB3aXRoIHRoZSBjbGVhcmVkIG1hcmtlciAobmV2ZXIgZGVsZXRlZCBoZXJlIOKAlCB0aGUgc3dlZXAgb3ducyB0aGF0KS5cbiAgICAgIGlmIChcbiAgICAgICAgZXhpc3RpbmcgIT09IG51bGwgJiYgY2Fub25pY2FsICE9PSBudWxsICYmXG4gICAgICAgIGNhbm9uaWNhbC5jb21tZW50SWQgIT09IGV4aXN0aW5nLmNvbW1lbnRJZFxuICAgICAgKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgcGF0Y2hNYXJrZXJDb21tZW50KFxuICAgICAgICAgICAgcmVwbyxcbiAgICAgICAgICAgIGV4aXN0aW5nLmNvbW1lbnRJZCxcbiAgICAgICAgICAgIHJlbmRlclN1cGVyc2VkZWRSZWxlYXNlQm9keShcbiAgICAgICAgICAgICAgbWFya2VyT3B0aW9ucy5tYWNoaW5lSWQsXG4gICAgICAgICAgICAgIHJlbGVhc2VSZWFzb25MaW5lKG91dGNvbWUpLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIGdoRm4sXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmVjb3JkRmF1bHRFdmVudChcbiAgICAgICAgICAgIFwiY2F0Y2hfYmxvY2tfd2FybmluZ1wiLFxuICAgICAgICAgICAgYHN1cGVyc2VkZWQgbWFya2VyIHBhdGNoIGZhaWxlZCBmb3IgJHtyZXBvfSMke2lzc3VlTnVtYmVyfTogJHtlcnJ9YCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBLZWVwIHRoZSBjb21tZW50IGlkIHdpdGggYSBgcmVsZWFzZWRgIGZsYWcgKElzc3VlICMzNzUxKSBzbyBhXG4gICAgICAvLyByZS1jbGFpbSBvbiB0aGlzIGhvc3QgcmV2aXZlcyB0aGUgc2FtZSBjb21tZW50IGluc3RlYWQgb2YgcG9zdGluZ1xuICAgICAgLy8gYSBuZXcgb25lIOKAlCBub3cgdGhlIGNhbm9uaWNhbCwgd2l0aCBpdHMgdGFsbHkuIFRoZSBHaXRIdWItc2lkZVxuICAgICAgLy8gZmluZGVyIGNvdmVycyBjb2xkIGhvc3RzLlxuICAgICAgYXdhaXQgd3JpdGVNYXJrZXJTdGF0ZSh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlciwge1xuICAgICAgICBjb21tZW50SWQ6IHRhcmdldCxcbiAgICAgICAgbGFzdFJlZnJlc2g6IGV4aXN0aW5nPy5sYXN0UmVmcmVzaCA/PyBub3csXG4gICAgICAgIHJlbGVhc2VkOiB0cnVlLFxuICAgICAgICBhdHRlbXB0czogdGFsbHksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbn1cblxuLyoqIE9wdGlvbnMgY29udHJvbGxpbmcge0BsaW5rIHJlbGVhc2VDbGFpbX0uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlbGVhc2VDbGFpbU9wdGlvbnMge1xuICAvKiogR2l0SHViIHVzZXJuYW1lIG9mIHRoZSB3b3JrZXIgdG8gdW5hc3NpZ24uICovXG4gIGdpdGh1YlVzZXI6IHN0cmluZztcbiAgLyoqXG4gICAqIEZ1bmN0aW9uIHVzZWQgdG8gaW52b2tlIGBnaGAgZm9yIHRoZSB1bmFzc2lnbiBjYWxsLiBEZWZhdWx0cyB0byB0aGVcbiAgICogbW9kdWxlLWxvY2FsIHtAbGluayBydW5HaH0uXG4gICAqL1xuICBnaEZuPzogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIC8qKlxuICAgKiBNYXJrZXIgb3B0aW9ucyBmb3J3YXJkZWQgdG8ge0BsaW5rIGNsZWFySGVhcnRiZWF0fSBzbyB0aGUgcHVibGlzaGVkXG4gICAqIEdpdEh1YiBoZWFydGJlYXQgbWFya2VyIGlzIGludmFsaWRhdGVkIGFsb25nc2lkZSB0aGUgbG9jYWwgZmlsZS5cbiAgICovXG4gIG1hcmtlck9wdGlvbnM/OiBIZWFydGJlYXRNYXJrZXJPcHRpb25zO1xuICAvKipcbiAgICogV2hhdCB0aGUgcnVuIGFjaGlldmVkIChJc3N1ZSAjNDMyNSwgcGFydCBvZiAjNDI5MSksIHJlbmRlcmVkIGludG8gdGhlXG4gICAqIHJlbGVhc2UgY29tbWVudC4gT21pdHRlZCBvbiBwYXRocyB3aGVyZSB0aGUgcnVuIG5ldmVyIHJhbiAoc2tpcCBhZnRlclxuICAgKiBjbGFpbSkg4oCUIHRoZSByZWxlYXNlIHRleHQgaXMgdGhlbiBleGFjdGx5IHRvZGF5J3MuXG4gICAqL1xuICBvdXRjb21lPzogUnVuT3V0Y29tZTtcbn1cblxuLyoqXG4gKiBSZWxlYXNlIGEgY2xhaW0gb24gYW4gaXNzdWU6IHVuYXNzaWduIHRoZSB3b3JrZXIgQU5EIGNsZWFyIHRoZSBoZWFydGJlYXQuXG4gKlxuICogRXZlcnkgcGF0aCB0aGF0IHJlbGVhc2VzIGEgY2xhaW0gKHN1Y2Nlc3MsIGZhaWx1cmUsIHNraXAtYWZ0ZXItY2xhaW0sXG4gKiBzaHV0ZG93bi9yYXRlLWxpbWl0IHBhdXNlKSBtdXN0IHJlbW92ZSB0aGUgd29ya2VyJ3MgYXNzaWdubWVudCDigJQgY2xlYXJpbmdcbiAqIHRoZSBoZWFydGJlYXQgbWFya2VyIGFsb25lIGxlYXZlcyB0aGUgaXNzdWUgcGVybWFuZW50bHkgYXNzaWduZWQgYW5kIGJsb2Nrc1xuICogYWxsIGZ1dHVyZSBwaWNrdXAgKElzc3VlICMyNjcwLCBpbmNpZGVudCBzdFNvZnR3YXJlQVUvVmliZUNvZGVyIzI2NDgpLlxuICpcbiAqIEJvdGggc3RlcHMgYXJlIGJlc3QtZWZmb3J0IGFuZCBpbmRlcGVuZGVudDogYSBmYWlsdXJlIGluIG9uZSBtdXN0IG5vdFxuICogcHJldmVudCB0aGUgb3RoZXIsIGFuZCBib3RoIGZhaWx1cmVzIGFyZSBsb2dnZWQuIEEgZG91YmxlLXVuYXNzaWduIGlzXG4gKiBoYXJtbGVzcyDigJQgYGdoIGlzc3VlIGVkaXQgLS1yZW1vdmUtYXNzaWduZWVgIGlzIGEgbm8tb3Agd2hlbiB0aGUgd29ya2VyIGlzXG4gKiBub3QgYW4gYXNzaWduZWUsIGFuZCByZW1vdmluZyBvbmx5IGBnaXRodWJVc2VyYCBuZXZlciB0b3VjaGVzIGFub3RoZXJcbiAqIHdvcmtlcidzIGFzc2lnbm1lbnQuIFJldHVybnMgd2hpY2ggYWN0aW9ucyBzdWNjZWVkZWQgZm9yIGxvZ2dpbmcuXG4gKlxuICogSXNzdWUgIzIxNDogdGhlIG9yZGVyIGlzIHN0b3AgdGhlIGhlYXJ0YmVhdCBhbmQgcG9zdCB0aGUgb3V0Y29tZSBGSVJTVCxcbiAqIHVuYXNzaWduIExBU1QuIFRoZSBhc3NpZ25lZSBpcyB0aGUgY2xhaW0gbG9jayBldmVyeSBvdGhlciBob3N0IGNoZWNrcywgc29cbiAqIGRyb3BwaW5nIGl0IHdoaWxlIHRoZSBoZWFydGJlYXQgc3RpbGwgYmVhdHMgbGVhdmVzIHRoZSBpc3N1ZSByZWFkYWJsZSBhc1xuICogZnJlZSBieSBhIHNpYmxpbmcgaG9zdCB0aGF0IHdvdWxkIHRoZW4gc3RhcnQgYSBzZWNvbmQgYWdlbnQgb24gdGhlIHNhbWVcbiAqIGlzc3VlIChsaXZlIGV2aWRlbmNlOiBWaWJlQ29kZXIjMTg1LCB1bmFzc2lnbmVkIDA2OjMxWiwgc3RpbGwgYmVhdGluZyBhdFxuICogMDY6NDBaKS4gQ2xlYXJpbmcgZmlyc3QgYWxzbyBhcm1zIHRoZSB3cml0ZS1hZnRlci1yZWxlYXNlIGd1YXJkIGJlZm9yZSB0aGVcbiAqIGxvY2sgaXMgZHJvcHBlZCwgc28gbm8gc3RyYWdnbGluZyBiZWF0IGNhbiByZXZpdmUgdGhlIG1hcmtlci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbGVhc2VDbGFpbShcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIG9wdGlvbnM6IFJlbGVhc2VDbGFpbU9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDx7IHVuYXNzaWduZWQ6IGJvb2xlYW47IGhlYXJ0YmVhdENsZWFyZWQ6IGJvb2xlYW4gfT4+IHtcbiAgbGV0IHVuYXNzaWduZWQgPSBmYWxzZTtcbiAgbGV0IGhlYXJ0YmVhdENsZWFyZWQgPSBmYWxzZTtcblxuICAvLyBTdGVwIDE6IHN0b3AgdGhlIGhlYXJ0YmVhdCwgcG9zdCB0aGUgb3V0Y29tZSBvbiB0aGUgbWFya2VyIGNvbW1lbnQsIGFuZFxuICAvLyBhcm0gdGhlIHdyaXRlLWFmdGVyLXJlbGVhc2UgZ3VhcmQgKGJlc3QtZWZmb3J0LCBpbmRlcGVuZGVudCBvZiBzdGVwIDIpLlxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsZWFySGVhcnRiZWF0KFxuICAgICAgd29ya0RpcixcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZU51bWJlcixcbiAgICAgIG9wdGlvbnMubWFya2VyT3B0aW9ucyxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIG9wdGlvbnMub3V0Y29tZSxcbiAgICApO1xuICAgIGhlYXJ0YmVhdENsZWFyZWQgPSByZXN1bHQub2s7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgICBcImNhdGNoX2Jsb2NrX3dhcm5pbmdcIixcbiAgICAgIGByZWxlYXNlQ2xhaW0gY2xlYXJIZWFydGJlYXQgZmFpbGVkIGZvciAke3JlcG99IyR7aXNzdWVOdW1iZXJ9OiAke2Vycn1gLFxuICAgICk7XG4gIH1cblxuICAvLyBTdGVwIDI6IGRyb3AgdGhlIGNsYWltIGxvY2sgKGJlc3QtZWZmb3J0LCBpbmRlcGVuZGVudCBvZiBzdGVwIDEsIHNvIGFcbiAgLy8gY2xlYXIgZmFpbHVyZSBuZXZlciBsZWF2ZXMgdGhlIGlzc3VlIGFzc2lnbmVkIOKAlCBJc3N1ZSAjMjY3MCkuXG4gIGlmIChyZXBvLmxlbmd0aCA+IDAgJiYgaXNzdWVOdW1iZXIgPiAwICYmIG9wdGlvbnMuZ2l0aHViVXNlci5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgZ2hGbiA9IG9wdGlvbnMuZ2hGbiA/PyBydW5HaDtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZ2hGbihbXG4gICAgICAgIFwiaXNzdWVcIixcbiAgICAgICAgXCJlZGl0XCIsXG4gICAgICAgIFN0cmluZyhpc3N1ZU51bWJlciksXG4gICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIFwiLS1yZW1vdmUtYXNzaWduZWVcIixcbiAgICAgICAgb3B0aW9ucy5naXRodWJVc2VyLFxuICAgICAgXSk7XG4gICAgICB1bmFzc2lnbmVkID0gdHJ1ZTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgICAgIFwiY2F0Y2hfYmxvY2tfd2FybmluZ1wiLFxuICAgICAgICBgcmVsZWFzZUNsYWltIHVuYXNzaWduIGZhaWxlZCBmb3IgJHtyZXBvfSMke2lzc3VlTnVtYmVyfTogJHtlcnJ9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IHVuYXNzaWduZWQsIGhlYXJ0YmVhdENsZWFyZWQgfSB9O1xufVxuXG4vKipcbiAqIEZldGNoIHRoZSBoZWFydGJlYXQgbWFya2VycyBjdXJyZW50bHkgcHVibGlzaGVkIG9uIGFuIGlzc3VlLlxuICpcbiAqIFJldHVybnMgYSBsaXN0IG9mIGB7IG1hY2hpbmVJZCwgZXBvY2ggfWAgbWFya2VycyBleHRyYWN0ZWQgZnJvbSB0aGVcbiAqIGlzc3VlJ3MgY29tbWVudHMuIENvbW1lbnRzIHdpdGhvdXQgYSBtYXJrZXIgYXJlIGlnbm9yZWQuIFJldHVybnMgYW5cbiAqIGVtcHR5IGFycmF5IG9uIGFueSBmYWlsdXJlIChlLmcuIHRoZSBBUEkgY2FsbCBmYWlscyBvciB0aGUgcmVzcG9uc2VcbiAqIGNhbm5vdCBiZSBwYXJzZWQpIHNvIGNhbGxlcnMgY2FuIHRyZWF0IFwidW5rbm93blwiIGFzIFwibm8gbGl2ZSBtYXJrZXJcIlxuICogYW5kIGZhbGwgYmFjayB0byB0aGUgZXhpc3RpbmcgYHVwZGF0ZWRBdGAgYmVoYXZpb3VyLlxuICpcbiAqIElzc3VlICMzMTY0OiB3aGVuIGBhbGxvd2VkQXV0aG9yc2AgaXMgcHJvdmlkZWQgYW5kIG5vbi1lbXB0eSwgYSBtYXJrZXIgaXNcbiAqIGhvbm91cmVkIG9ubHkgd2hlbiBpdHMgY29tbWVudCBhdXRob3IgaXMgaW4gdGhlIGZsZWV0IGxvZ2luIHNldCAodGhlXG4gKiBgcmVzb2x2ZUZsZWV0QXV0aG9yc2AgdW5pb24pLiBBIG1hcmtlciBwb3N0ZWQgYnkgYW55IG90aGVyIEdpdEh1YiB1c2VyIGlzXG4gKiBpZ25vcmVkIOKAlCBzbyBhIGZvcmdlZCBgVklCRV9DT0RFUl9IRUFSVEJFQVRgIGNvbW1lbnQgZnJvbSBhbiBhdHRhY2tlciB3aG9cbiAqIGNhbiBtZXJlbHkgY29tbWVudCBvbiB0aGUgaXNzdWUgY2FuIG5vIGxvbmdlciBkZWZlYXQgc3RhbGUtYXNzaWdubWVudFxuICogcmVjb3ZlcnkuIFRoaXMgbWlycm9ycyB0aGUgYXV0aG9yIHZlcmlmaWNhdGlvbiBgdmVyaWZ5T3BlcmF0aW9uYWxMYWJlbHNgXG4gKiBhbHJlYWR5IHBlcmZvcm1zIG9uIG9wZXJhdGlvbmFsIGxhYmVscy4gV2hlbiBgYWxsb3dlZEF1dGhvcnNgIGlzIG9taXR0ZWRcbiAqIG9yIGVtcHR5IHRoZSBhdXRob3IgZmlsdGVyIGlzIGRpc2FibGVkLCBwcmVzZXJ2aW5nIHRoZSBwcmlvciBiZWhhdmlvdXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzY2FuSGVhcnRiZWF0TWFya2VycyhcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBnaEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbiAgYWxsb3dlZEF1dGhvcnM/OiBzdHJpbmdbXSxcbik6IFByb21pc2U8QXJyYXk8eyBtYWNoaW5lSWQ6IHN0cmluZzsgZXBvY2g6IG51bWJlcjsgY2xlYXJlZDogYm9vbGVhbiB9Pj4ge1xuICBjb25zdCBqc29uID0gYXdhaXQgZ2hGbihbXG4gICAgXCJhcGlcIixcbiAgICBgcmVwb3MvJHtyZXBvfS9pc3N1ZXMvJHtpc3N1ZU51bWJlcn0vY29tbWVudHNgLFxuICAgIFwiLS1qcVwiLFxuICAgIFwiWy5bXSB8IHtib2R5OiAuYm9keSwgYXV0aG9yOiAudXNlci5sb2dpbn1dXCIsXG4gIF0pO1xuICBpZiAoIWpzb24pIHJldHVybiBbXTtcbiAgbGV0IGNvbW1lbnRzOiBBcnJheTx7IGJvZHk6IHN0cmluZzsgYXV0aG9yPzogc3RyaW5nIHwgbnVsbCB9PjtcbiAgdHJ5IHtcbiAgICBjb21tZW50cyA9IEpTT04ucGFyc2UoanNvbik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgICBcImNhdGNoX2Jsb2NrX3dhcm5pbmdcIixcbiAgICAgIGBzY2FuSGVhcnRiZWF0TWFya2VycyBwYXJzZSBmYWlsZWQgZm9yICR7cmVwb30jJHtpc3N1ZU51bWJlcn06ICR7ZXJyfWAsXG4gICAgKTtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgY29uc3QgZmlsdGVyQnlBdXRob3IgPSBBcnJheS5pc0FycmF5KGFsbG93ZWRBdXRob3JzKSAmJlxuICAgIGFsbG93ZWRBdXRob3JzLmxlbmd0aCA+IDA7XG4gIGNvbnN0IG1hcmtlcnM6IEFycmF5PHsgbWFjaGluZUlkOiBzdHJpbmc7IGVwb2NoOiBudW1iZXI7IGNsZWFyZWQ6IGJvb2xlYW4gfT4gPVxuICAgIFtdO1xuICBmb3IgKGNvbnN0IGNvbW1lbnQgb2YgY29tbWVudHMpIHtcbiAgICBpZiAoIWNvbW1lbnQgfHwgdHlwZW9mIGNvbW1lbnQuYm9keSAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG4gICAgLy8gSXNzdWUgIzMxNjQ6IGlnbm9yZSBhIG1hcmtlciB3aG9zZSBhdXRob3IgaXMgbm90IGEgZmxlZXQgYWNjb3VudCB3aGVuXG4gICAgLy8gdGhlIGNhbGxlciBzdXBwbGllZCBhIGZsZWV0IGFsbG93LWxpc3QgKGZhaWwgdG93YXJkIHJlY292ZXJ5KS5cbiAgICBpZiAoZmlsdGVyQnlBdXRob3IgJiYgIWlzRmxlZXRBdXRob3IoY29tbWVudC5hdXRob3IsIGFsbG93ZWRBdXRob3JzISkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBtYXJrZXIgPSBwYXJzZUhlYXJ0YmVhdE1hcmtlcihjb21tZW50LmJvZHkpO1xuICAgIGlmIChtYXJrZXIgIT09IG51bGwpIG1hcmtlcnMucHVzaChtYXJrZXIpO1xuICB9XG4gIHJldHVybiBtYXJrZXJzO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7O0NBVUMsR0FFRCxTQUFTLFlBQVksUUFBUSxxQkFBcUI7QUFDbEQsU0FBUywyQkFBMkIsUUFBUSxtQ0FBbUM7QUFFL0UsU0FBUyxpQkFBaUIsUUFBUSx5QkFBeUI7QUFDM0QsU0FDRSx5QkFBeUIsRUFDekIsMkJBQTJCLFFBQ3RCLHlCQUF5QjtBQUVoQyxTQUFTLGdCQUFnQixRQUFRLGdDQUFnQztBQUNqRSxTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBUyxPQUFPLFFBQVEsZ0JBQWdCO0FBQ3hDLFNBQVMsc0JBQXNCLFFBQVEsdUJBQXVCO0FBQzlELFNBQ0UsdUJBQXVCLFFBRWxCLDRCQUE0QjtBQUNuQyxTQUNFLHFCQUFxQixFQUNyQiw0QkFBNEIsUUFDdkIsMEJBQTBCO0FBRWpDOztDQUVDLEdBQ0QsT0FBTyxTQUFTLGtCQUNkLE9BQWUsRUFDZixJQUFZLEVBQ1osV0FBbUI7RUFFbkIsTUFBTSxXQUFXLEtBQUssT0FBTyxDQUFDLEtBQUs7RUFDbkMsT0FBTyxHQUFHLFFBQVEsQ0FBQyxFQUFFLHdCQUF3QixTQUFTLENBQUMsRUFBRSxhQUFhO0FBQ3hFO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsb0JBQ2QsT0FBZSxFQUNmLElBQVksRUFDWixXQUFtQjtFQUVuQixNQUFNLFdBQVcsS0FBSyxPQUFPLENBQUMsS0FBSztFQUNuQyxPQUFPLEdBQUcsUUFBUSxDQUFDLEVBQUUsK0JBQStCLFNBQVMsQ0FBQyxFQUFFLGFBQWE7QUFDL0U7QUFFQSxnREFBZ0QsR0FDaEQsT0FBTyxNQUFNLDBCQUEw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
// denoCacheMetadata=17732815455395915035,15251781490130378758