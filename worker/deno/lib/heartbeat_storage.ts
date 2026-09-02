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
 */

import type { RunOutcome } from "./run_outcome.ts";
import {
  getFailureCategoryDisplay,
  getFailureDiagnosisOneliner,
} from "./failure_diagnosis.ts";
import type { Result } from "../types.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { spawnGh } from "./gh_spawn.ts";
import { sweepHeartbeatComments } from "./heartbeat_sweep.ts";

/**
 * Generate the heartbeat file path for a given repo and issue.
 */
export function heartbeatFilePath(
  workDir: string,
  repo: string,
  issueNumber: number,
): string {
  const safeRepo = repo.replace("/", "_");
  return `${workDir}/.heartbeat_${safeRepo}_${issueNumber}`;
}

/**
 * Generate the marker state file path for a given repo and issue (Issue #1454).
 *
 * Stores the GitHub comment id and last refresh epoch so subsequent calls
 * can edit the existing comment rather than spamming new ones.
 */
export function markerStateFilePath(
  workDir: string,
  repo: string,
  issueNumber: number,
): string {
  const safeRepo = repo.replace("/", "_");
  return `${workDir}/.heartbeat-marker_${safeRepo}_${issueNumber}`;
}

/** Prefix used inside the marker HTML comment. */
export const HEARTBEAT_MARKER_PREFIX = "VIBE_CODER_HEARTBEAT";

/** Default minimum seconds between marker refreshes (5 minutes). */
export const DEFAULT_MARKER_REFRESH_SECONDS = 300;

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
 */
export const CLEARED_MARKER_GRACE_SECONDS = 3600;

/** Maximum milestone entries kept in the progress log (Issue #3753). */
export const MAX_MILESTONES = 10;

/** Maximum rendered length of a single milestone line (Issue #3753). */
export const MILESTONE_TEXT_MAX_LENGTH = 120;

/** One entry in the heartbeat progress log (Issue #3753). */
export interface HeartbeatMilestone {
  /** Unix epoch seconds when the milestone was recorded. */
  epoch: number;
  /** Short, single-line, worker-authored description. */
  text: string;
}

/** Options controlling the GitHub marker published alongside the heartbeat. */
export interface HeartbeatMarkerOptions {
  /** Stable identifier for the current machine (see lib/machine_id.ts). */
  machineId: string;
  /** Function used to invoke `gh`. Defaults to the module-local runGh. */
  ghFn?: (args: string[]) => Promise<string>;
  /**
   * Minimum seconds between marker refreshes. Defaults to
   * DEFAULT_MARKER_REFRESH_SECONDS (300).
   */
  minRefreshSeconds?: number;
  /**
   * Fleet logins whose marker comments may be adopted (Issue #3751).
   *
   * Mirrors {@link scanHeartbeatMarkers}: when provided and non-empty, only a
   * marker comment authored by a fleet account is adopted, so a forged
   * `VIBE_CODER_HEARTBEAT` comment can never capture this worker's heartbeat
   * (Issue #3164 semantics). Omitted or empty disables the filter.
   */
  allowedAuthors?: string[];
  /**
   * Worker id shown in the visible heartbeat body (Issue #3752).
   *
   * Recorded on the first publish and reused on later refreshes, so a beat
   * that carries no worker id still renders the original one.
   */
  workerId?: string;
  /** Host name shown in the visible body. Defaults to the machine id's host. */
  host?: string;
}

/** Fields rendered into a visible heartbeat comment body (Issue #3752). */
export interface HeartbeatBodyFields {
  /** Stable identifier for the machine holding the claim. */
  machineId: string;
  /** Marker epoch — the last beat, or 0 once the claim is released. */
  epoch: number;
  /** Host name. Defaults to the hostname segment of `machineId`. */
  host?: string;
  /** Worker id. The worker clause is omitted when absent. */
  workerId?: string;
  /** When the claim started. The start clause is omitted when absent. */
  startedEpoch?: number;
  /** Render the released (cleared) shape instead of the live one. */
  released?: boolean;
  /** Rolling progress log appended below the status line (Issue #3753). */
  milestones?: HeartbeatMilestone[];
  /**
   * What the run achieved (Issue #4325, part of #4291): PR link, failure
   * diagnosis, or a deliberate no-PR. Only meaningful with `released`.
   * Absent → today's release text, byte for byte.
   */
  outcome?: RunOutcome;
  /**
   * Attempt tally rendered below the outcome on a collapsed release
   * (Issue #4327). Omitted, or a total of 1, renders nothing extra.
   */
  attempts?: ReleaseAttemptTally;
}

/** In-memory state persisted to markerStateFilePath. */
export interface MarkerState {
  commentId: number;
  lastRefresh: number;
  /**
   * Body text to prepend to the heartbeat marker on refresh (Issue #1628).
   *
   * When the claim and heartbeat are co-published as a single comment, this
   * holds the claim portion (`<!-- CLAIM_LOCK:WORKER_ID --> Claimed by ...`)
   * so PATCH refreshes preserve the CLAIM_LOCK marker that race detection
   * relies on.
   */
  claimPrefix?: string;
  /**
   * The claim owning this comment has been released (Issue #3751).
   *
   * `clearHeartbeat` keeps the state file with this flag set instead of
   * deleting it, so a re-claim on the same host revives the same comment
   * without a GitHub lookup. A released state always PATCHes on the next
   * publish, regardless of the refresh window.
   */
  released?: boolean;
  /**
   * Attempt tally of the release comment this state points at (Issue
   * #4327), so a same-host revive keeps the history and the next release
   * can extend it without a fetch.
   */
  attempts?: ReleaseAttemptTally;
  /**
   * Rolling progress log rendered inside the marker comment (Issue #3753).
   *
   * Capped at {@link MAX_MILESTONES}; the oldest entry is evicted first so a
   * long-running claim cannot grow the comment without bound.
   */
  milestones?: HeartbeatMilestone[];
  /**
   * Unix epoch seconds when this claim started (Issue #3752).
   *
   * Persisted on the first publish so later refreshes keep showing the
   * original start time rather than the current beat. Absent on state files
   * written before Issue #3752, in which case the start clause is omitted.
   */
  startedEpoch?: number;
  /** Worker id shown in the visible body (Issue #3752). */
  workerId?: string;
}

/**
 * Normalise milestone text to one short line (Issue #3753).
 *
 * Newlines are collapsed so worker-authored text can never wrap into — or
 * past — the machine-readable marker line, and the result is truncated to
 * {@link MILESTONE_TEXT_MAX_LENGTH}.
 */
function normaliseMilestoneText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MILESTONE_TEXT_MAX_LENGTH) return flat;
  return `${flat.substring(0, MILESTONE_TEXT_MAX_LENGTH - 1)}…`;
}

/** Render an epoch as a `HH:MM` UTC clock time for the progress log. */
function formatMilestoneTime(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return "--:--";
  return new Date(epoch * 1000).toISOString().substring(11, 16);
}

/**
 * Render the rolling progress log appended to the marker comment
 * (Issue #3753). Returns "" when there is nothing to show.
 */
export function formatMilestoneLog(milestones: HeartbeatMilestone[]): string {
  const recent = milestones.slice(-MAX_MILESTONES);
  if (recent.length === 0) return "";
  const lines = recent.map((m) =>
    `- ${formatMilestoneTime(m.epoch)} ${normaliseMilestoneText(m.text)}`
  );
  return `\n\n**Progress**\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Attempt tally (Issue #4327, part of #4291)
// ---------------------------------------------------------------------------

/** One prior attempt on an issue, as rendered in the collapsed release. */
export interface ReleaseAttempt {
  /** Epoch seconds the attempt was released (0 when unknown). */
  epoch: number;
  /** Host that ran it. */
  host: string;
  /** Short outcome text, e.g. `no PR (\`timeout\`, phase \`execute\`)`. */
  text: string;
}

/** The attempt tally carried by a collapsed release comment. */
export interface ReleaseAttemptTally {
  /** Total attempts on the issue, including those evicted from the list. */
  total: number;
  /** The most recent attempts, oldest first (capped at MAX_ATTEMPTS). */
  attempts: ReleaseAttempt[];
}

/** Attempts listed in the collapsed release; older ones become "+N earlier". */
export const MAX_ATTEMPTS = MAX_MILESTONES;

const ATTEMPTS_HEADING = "**Attempts on this issue:**";

/** One attempt's outcome text for the tally line. */
export function describeAttemptOutcome(
  outcome: RunOutcome | undefined,
): string {
  if (!outcome) return "released";
  switch (outcome.kind) {
    case "pr":
      return `raised #${outcome.prNumber}`;
    case "no_pr":
      return `no PR (\`${
        getFailureCategoryDisplay(outcome.category)
      }\`, phase \`${normaliseMilestoneText(outcome.phase)}\`)`;
    case "no_pr_expected":
      return `no PR expected (phase \`${
        normaliseMilestoneText(outcome.phase)
      }\`)`;
    case "superseded":
      return `superseded by #${outcome.prNumber}`;
    case "claim_stale":
      return `claim went stale (\`${outcome.reason}\`)`;
  }
}

/**
 * Render the attempt block. Empty for a single attempt (today's text is
 * unchanged); otherwise a heading with the total and one line per listed
 * attempt, oldest first, with a "+N earlier" line when the list is capped.
 */
export function formatAttemptBlock(tally: ReleaseAttemptTally): string {
  if (tally.total <= 1) return "";
  const listed = tally.attempts.slice(-MAX_ATTEMPTS);
  const earlier = tally.total - listed.length;
  const lines = [
    `${ATTEMPTS_HEADING} ${tally.total}`,
    ...(earlier > 0 ? [`- +${earlier} earlier`] : []),
    ...listed.map((a) =>
      `- ${formatMilestoneTime(a.epoch)} \`${
        normaliseMilestoneText(a.host)
      }\` — ${normaliseMilestoneText(a.text)}`
    ),
  ];
  return `\n${lines.join("\n")}`;
}

/**
 * Parse the attempt block back out of a comment body — the only source of
 * the tally that survives a host change. Returns null when the body carries
 * no block. Round-trips with {@link formatAttemptBlock}: the rendered epoch
 * keeps only HH:MM, so a parsed attempt's epoch is that clock time on the
 * epoch day 0 (rendering it again yields the same HH:MM).
 */
export function parseAttemptBlock(body: string): ReleaseAttemptTally | null {
  const heading = new RegExp(
    `^\\s*${ATTEMPTS_HEADING.replace(/\*/g, "\\*")}\\s*(\\d+)\\s*$`,
    "m",
  );
  const m = heading.exec(body ?? "");
  if (!m) return null;
  const total = parseInt(m[1]!, 10);
  if (!Number.isFinite(total) || total < 1) return null;
  const rest = body.slice(m.index + m[0].length);
  const attempts: ReleaseAttempt[] = [];
  for (const line of rest.split("\n")) {
    if (line.trim().length === 0) {
      if (attempts.length > 0) break;
      continue;
    }
    if (/^\s*-\s+\+\d+ earlier\s*$/.test(line)) continue;
    const a = /^\s*-\s+(\d{2}):(\d{2}|--)\s+`([^`]*)`\s+—\s+(.*)$/.exec(line) ??
      /^\s*-\s+(--):(--)\s+`([^`]*)`\s+—\s+(.*)$/.exec(line);
    if (!a) break;
    const hh = a[1] === "--" ? NaN : parseInt(a[1]!, 10);
    const mm = a[2] === "--" ? NaN : parseInt(a[2]!, 10);
    attempts.push({
      epoch: Number.isFinite(hh) && Number.isFinite(mm)
        ? hh * 3600 + mm * 60
        : 0,
      host: a[3]!,
      text: a[4]!.trimEnd(),
    });
  }
  return { total, attempts };
}

/**
 * Reconstruct the single attempt a released body without a tally block
 * represents (the first release on a thread renders no block), from its
 * visible line: host, finish clock and outcome. Null when the body is not a
 * released shape.
 */
export function parseReleaseAttemptFromBody(
  body: string,
): ReleaseAttempt | null {
  const line =
    /(✅|⚠️)\s*\*\*Vibe Coder released this claim(?: with no PR)?\*\*\s*—\s*host `([^`]*)`, finished (\d{2}):(\d{2}) UTC\.(.*)$/m
      .exec(body ?? "");
  if (!line) return null;
  const host = line[2]!;
  const epoch = parseInt(line[3]!, 10) * 3600 + parseInt(line[4]!, 10) * 60;
  const rest = line[5] ?? "";
  let text = "released";
  const raised = /Raised #(\d+)/.exec(rest);
  const outcome = /\*\*Outcome:\*\* no PR raised — `([^`]+)`/.exec(body);
  const phase = /\*\*Diagnosis:\*\* died in phase `([^`]+)`/.exec(body);
  if (raised) text = `raised #${raised[1]}`;
  else if (outcome) {
    text = `no PR (\`${outcome[1]}\`${phase ? `, phase \`${phase[1]}\`` : ""})`;
  } else if (/no PR expected for this phase/.test(rest)) {
    text = "no PR expected";
  }
  return { epoch, host, text };
}

/** Append this release to a tally (or start one). */
export function appendAttempt(
  previous: ReleaseAttemptTally | null,
  attempt: ReleaseAttempt,
): ReleaseAttemptTally {
  const base = previous ?? { total: 0, attempts: [] };
  // One release can be cleared twice within the same minute (heartbeat
  // stop, then claim release — Issue #4330): that is the same attempt, so
  // the newer text replaces the entry instead of counting again.
  const last = base.attempts.at(-1);
  if (isSameAttempt(last, attempt)) {
    return {
      total: base.total,
      attempts: [...base.attempts.slice(0, -1), attempt].slice(-MAX_ATTEMPTS),
    };
  }
  return {
    total: base.total + 1,
    attempts: [...base.attempts, attempt].slice(-MAX_ATTEMPTS),
  };
}

/**
 * Derive the display host from a machine id (Issue #3752).
 *
 * Machine ids are `{hostname}-{uuid}` (see lib/machine_id.ts), so strip a
 * trailing UUID to recover the hostname. Anything that does not end in a UUID
 * is shown verbatim.
 */
function hostFromMachineId(machineId: string): string {
  const uuid =
    /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return machineId.replace(uuid, "");
}

/** Render an epoch as `HH:MM UTC`. */
function formatClock(epoch: number): string {
  return `${formatMilestoneTime(epoch)} UTC`;
}

/**
 * Render how long ago `epoch` was, as a short human phrase (Issue #3752).
 *
 * A clock that runs backwards is clamped to zero so the body never shows a
 * negative duration.
 */
function formatElapsed(epoch: number, now: number): string {
  const seconds = Math.max(0, now - epoch);
  if (seconds < 60) return "just now";
  return `${formatDuration(seconds)} ago`;
}

/**
 * Render a duration in seconds as the short phrase the elapsed clause uses
 * (`58 min`, `2 h`, `3 d`; under a minute → `under 1 min`). Shared with
 * {@link formatElapsed} so the two cannot drift (Issue #4326).
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return "under 1 min";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Longest rendered outcome block (Issue #4326): a brief line, not a log dump. */
export const OUTCOME_BLOCK_MAX_LENGTH = 600;
/** Longest raw-message excerpt inside the outcome block. */
export const OUTCOME_DETAIL_MAX_LENGTH = 200;

/**
 * Flatten and bound free text spliced into the release body (Issue #4326).
 * Whitespace collapses to single spaces, HTML-comment delimiters are
 * neutralised so a failure message can never open or close a comment and
 * push the marker off its line, and the result is truncated with an
 * ellipsis — the same discipline as {@link normaliseMilestoneText}.
 */
function boundOutcomeText(text: string, maxLength: number): string {
  const flat = text
    .replace(/<!--/g, "<!- -")
    .replace(/-->/g, "- ->")
    .replace(/\s+/g, " ")
    .trim();
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
 */
export function renderRunOutcomeClause(outcome: RunOutcome): string {
  return `${renderOutcomeKindClause(outcome)}${renderOutcomeNotes(outcome)}`;
}

/** Longest number of notes rendered — a brief line, not a log dump. */
const MAX_OUTCOME_NOTES = 3;

/** The `**Note:**` line for a run's outcome notes, or "" when it has none. */
function renderOutcomeNotes(outcome: RunOutcome): string {
  const notes = (outcome.notes ?? [])
    .map((note) => boundOutcomeText(note, OUTCOME_DETAIL_MAX_LENGTH))
    .filter((note) => note !== "")
    .slice(0, MAX_OUTCOME_NOTES);
  return notes.length === 0 ? "" : `\n**Note:** ${notes.join("; ")}`;
}

/** The kind-specific clause, without notes. */
function renderOutcomeKindClause(outcome: RunOutcome): string {
  switch (outcome.kind) {
    case "pr": {
      const url = boundOutcomeText(outcome.prUrl, OUTCOME_DETAIL_MAX_LENGTH);
      return ` Raised #${outcome.prNumber} — ${url}`;
    }
    case "no_pr_expected": {
      const summary = boundOutcomeText(
        outcome.summary,
        OUTCOME_DETAIL_MAX_LENGTH,
      );
      return ` ${summary} (no PR expected for this phase.)`;
    }
    case "superseded": {
      // Issue #218 — a sibling's PR resolved the issue mid-run. Say so
      // plainly, and name the branch the preserved WIP is on so the work
      // this run did do is findable rather than silently orphaned.
      const url = boundOutcomeText(outcome.prUrl, OUTCOME_DETAIL_MAX_LENGTH);
      const verb = outcome.prState === "MERGED" ? "merged" : "closed";
      const wip = outcome.wipNote
        ? ` ${boundOutcomeText(outcome.wipNote, OUTCOME_DETAIL_MAX_LENGTH)}.`
        : "";
      return ` Superseded by ${verb} #${outcome.prNumber} — ${url}` +
        ` (this run raised no PR).${wip}`;
    }
    case "claim_stale": {
      // Issue #344 — the claim was fine when it was taken and stale by the
      // time the PR would have gone up. Name the branch: it is the only place
      // the work now lives, and a reader must be able to find it.
      const detail = boundOutcomeText(
        outcome.detail,
        OUTCOME_DETAIL_MAX_LENGTH,
      );
      const branch = outcome.branch
        ? ` The work is on \`${boundOutcomeText(outcome.branch, 200)}\`.`
        : "";
      const pr = outcome.prUrl
        ? ` See ${boundOutcomeText(outcome.prUrl, OUTCOME_DETAIL_MAX_LENGTH)}.`
        : "";
      return ` No PR raised — the claim went stale: ${detail}.${branch}${pr}`;
    }
    case "no_pr": {
      const display = getFailureCategoryDisplay(outcome.category);
      // A timeout kill explains itself here (Issue #768): the one-liner
      // states the extension telemetry the run carried, so an operator reads
      // the grants and the last refusal off the release comment.
      const oneliner = getFailureDiagnosisOneliner(
        outcome.category,
        "not_assessed",
        outcome.extensions,
      );
      const phase = boundOutcomeText(outcome.phase, 60);
      const detail = boundOutcomeText(
        outcome.message,
        OUTCOME_DETAIL_MAX_LENGTH,
      );
      const block = `\n**Outcome:** no PR raised — \`${display}\`.\n` +
        `**Diagnosis:** died in phase \`${phase}\` after ${
          formatDuration(outcome.elapsedSeconds)
        }. ${oneliner}` +
        (detail ? `\n**Detail:** ${detail}` : "");
      return block.length <= OUTCOME_BLOCK_MAX_LENGTH
        ? block
        : `${block.substring(0, OUTCOME_BLOCK_MAX_LENGTH - 1)}…`;
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
 */
export function renderHeartbeatBody(
  fields: HeartbeatBodyFields,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): string {
  const host = fields.host ?? hostFromMachineId(fields.machineId);
  const log = formatMilestoneLog(fields.milestones ?? []);

  if (fields.released) {
    // The machine-readable marker line stays first and unchanged: every
    // parser keys off it, and `parseHeartbeatMarker` needs epoch 0 plus
    // the `cleared:` comment in the same body.
    const marker = `${formatHeartbeatMarker(fields.machineId, 0)} ` +
      `<!-- cleared: claim released by machine ${fields.machineId} -->`;
    const finished = `host \`${host}\`, finished ${formatClock(nowFn())}.`;
    const outcome = fields.outcome;
    // Repeated attempts collapse into this one comment (Issue #4327): the
    // tally follows the outcome and precedes the progress log.
    const tally = fields.attempts ? formatAttemptBlock(fields.attempts) : "";
    if (!outcome) {
      // No outcome (skip after claim, legacy callers): today's text, byte
      // for byte.
      return `${marker}\n\n✅ **Vibe Coder released this claim** — ` +
        `${finished}${tally}${log}`;
    }
    // The run outcome (Issue #4326, part of #4291): a PR link, a deliberate
    // no-PR, or a failure class + brief diagnosis.
    if (outcome.kind === "no_pr") {
      return `${marker}\n\n⚠️ **Vibe Coder released this claim with no PR** — ` +
        `${finished}${renderRunOutcomeClause(outcome)}${tally}${log}`;
    }
    return `${marker}\n\n✅ **Vibe Coder released this claim** — ` +
      `${finished}${renderRunOutcomeClause(outcome)}${tally}${log}`;
  }

  const who = fields.workerId
    ? `host \`${host}\`, worker \`${fields.workerId}\``
    : `host \`${host}\``;
  const elapsed = formatElapsed(fields.epoch, nowFn());
  const beat = fields.startedEpoch
    ? `Started ${formatClock(fields.startedEpoch)}, ` +
      `last beat ${formatClock(fields.epoch)} (${elapsed})`
    : `Last beat ${formatClock(fields.epoch)} (${elapsed})`;

  return `${formatHeartbeatMarker(fields.machineId, fields.epoch)}\n\n` +
    `🤖 **Vibe Coder working** on ${who} — ${beat}.${log}`;
}

/**
 * Format a heartbeat marker body.
 *
 * Wraps the identifier and epoch inside an HTML comment so it is invisible
 * on the rendered GitHub issue page but still searchable in the raw comment
 * body.
 */
export function formatHeartbeatMarker(
  machineId: string,
  epoch: number,
): string {
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
 */
export function parseHeartbeatMarker(
  body: string,
): { machineId: string; epoch: number; cleared: boolean } | null {
  const regex = new RegExp(
    `${HEARTBEAT_MARKER_PREFIX}:([^:\\s]+):(\\d+)`,
    "g",
  );
  let match: RegExpExecArray | null;
  let best: { machineId: string; epoch: number } | null = null;
  while ((match = regex.exec(body)) !== null) {
    const epoch = parseInt(match[2]!, 10);
    if (isNaN(epoch)) continue;
    if (best === null || epoch > best.epoch) {
      best = { machineId: match[1]!, epoch };
    }
  }
  if (best === null) return null;
  // The cleared signal requires both the zero-epoch marker AND the
  // explicit `cleared:` HTML comment in the same body. We use a regex
  // (not includes) so trailing-whitespace variants stay matched.
  const clearedSuffix = /<!--\s*cleared:[^>]*-->/i;
  const cleared = best.epoch === 0 && clearedSuffix.test(body);
  return { machineId: best.machineId, epoch: best.epoch, cleared };
}

/**
 * Run a gh command and return stdout. Returns empty string on failure.
 *
 * Exported for use by detection and recovery modules so they share a
 * single implementation.
 */
export async function runGh(args: string[]): Promise<string> {
  try {
    const result = await spawnGh(args, { stderr: "null" });
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
 */
export async function readMarkerState(
  workDir: string,
  repo: string,
  issueNumber: number,
): Promise<MarkerState | null> {
  try {
    const raw = await Deno.readTextFile(
      markerStateFilePath(workDir, repo, issueNumber),
    );
    const parsed = JSON.parse(raw) as {
      commentId?: number;
      lastRefresh?: number;
      claimPrefix?: string;
      released?: boolean;
      milestones?: unknown;
      startedEpoch?: number;
      workerId?: string;
      attempts?: unknown;
    };
    if (
      typeof parsed.commentId !== "number" ||
      typeof parsed.lastRefresh !== "number"
    ) {
      return null;
    }
    const state: MarkerState = {
      commentId: parsed.commentId,
      lastRefresh: parsed.lastRefresh,
    };
    if (
      typeof parsed.claimPrefix === "string" && parsed.claimPrefix.length > 0
    ) {
      state.claimPrefix = parsed.claimPrefix;
    }
    if (parsed.released === true) state.released = true;
    const attempts = parsed.attempts as
      | { total?: unknown; attempts?: unknown }
      | undefined;
    if (
      attempts && typeof attempts.total === "number" &&
      Array.isArray(attempts.attempts)
    ) {
      state.attempts = {
        total: attempts.total,
        attempts: (attempts.attempts as ReleaseAttempt[]).filter((a) =>
          a && typeof a.host === "string" && typeof a.text === "string"
        ).map((a) => ({
          epoch: typeof a.epoch === "number" ? a.epoch : 0,
          host: a.host,
          text: a.text,
        })),
      };
    }
    // Absent on state files written before Issue #3752 — the visible body
    // simply omits the clauses these feed.
    if (
      typeof parsed.startedEpoch === "number" &&
      Number.isFinite(parsed.startedEpoch) && parsed.startedEpoch > 0
    ) {
      state.startedEpoch = parsed.startedEpoch;
    }
    if (typeof parsed.workerId === "string" && parsed.workerId.length > 0) {
      state.workerId = parsed.workerId;
    }
    const milestones = coerceMilestones(parsed.milestones);
    if (milestones.length > 0) state.milestones = milestones;
    return state;
  } catch {
    return null;
  }
}

/** Coerce an untrusted JSON value into a milestone list (Issue #3753). */
function coerceMilestones(value: unknown): HeartbeatMilestone[] {
  if (!Array.isArray(value)) return [];
  const entries: HeartbeatMilestone[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const { epoch, text } = item as { epoch?: unknown; text?: unknown };
    if (typeof epoch !== "number" || !Number.isFinite(epoch)) continue;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    entries.push({ epoch, text: normaliseMilestoneText(text) });
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
 */
async function readMilestones(
  workDir: string,
  repo: string,
  issueNumber: number,
): Promise<HeartbeatMilestone[]> {
  try {
    const raw = await Deno.readTextFile(
      markerStateFilePath(workDir, repo, issueNumber),
    );
    return coerceMilestones(
      (JSON.parse(raw) as { milestones?: unknown })
        .milestones,
    );
  } catch {
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
 */
export async function seedMarkerState(
  workDir: string,
  repo: string,
  issueNumber: number,
  state: {
    commentId: number;
    lastRefresh: number;
    claimPrefix?: string;
    startedEpoch?: number;
    workerId?: string;
  },
): Promise<void> {
  // Seeding happens as a claim is taken (Issue #214), so any guard left by a
  // previous claim on this issue is lifted here too.
  clearClaimReleaseGuard(workDir, repo, issueNumber);
  await writeMarkerState(workDir, repo, issueNumber, state);
}

/**
 * Persist marker state for a repo/issue. Errors are non-fatal — marker
 * publication degrades to "post a new comment next time" rather than
 * breaking the heartbeat.
 */
async function writeMarkerState(
  workDir: string,
  repo: string,
  issueNumber: number,
  state: MarkerState,
): Promise<void> {
  try {
    await Deno.mkdir(workDir, { recursive: true });
  } catch {
    // Directory already exists — non-fatal
  }
  // Milestones outlive every other field of the state (Issue #3753): a
  // caller that does not carry them forward (seeding, adoption, release)
  // must not silently drop the progress log.
  const milestones = state.milestones ??
    await readMilestones(workDir, repo, issueNumber);
  try {
    await Deno.writeTextFile(
      markerStateFilePath(workDir, repo, issueNumber),
      JSON.stringify({
        ...state,
        ...(milestones.length > 0 ? { milestones } : {}),
      }),
    );
  } catch {
    // Non-fatal — next heartbeat will simply re-publish the marker.
  }
}

/**
 * Post a new heartbeat marker comment and return its id, or null on failure.
 *
 * `gh issue comment` does not expose the created comment id, so we use the
 * REST endpoint instead and parse the returned JSON.
 */
async function postMarkerComment(
  repo: string,
  issueNumber: number,
  body: string,
  ghFn: (args: string[]) => Promise<string>,
): Promise<number | null> {
  const json = await ghFn([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "-X",
    "POST",
    "-f",
    `body=${body}`,
    "--jq",
    ".id",
  ]);
  if (!json) return null;
  const id = parseInt(json.trim(), 10);
  return isNaN(id) ? null : id;
}

/**
 * Edit an existing heartbeat marker comment in place. Returns true on
 * success, false when the edit fails (e.g. comment was deleted).
 */
async function patchMarkerComment(
  repo: string,
  commentId: number,
  body: string,
  ghFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  const json = await ghFn([
    "api",
    `repos/${repo}/issues/comments/${commentId}`,
    "-X",
    "PATCH",
    "-f",
    `body=${body}`,
    "--jq",
    ".id",
  ]);
  if (!json) return false;
  const id = parseInt(json.trim(), 10);
  return !isNaN(id);
}

/**
 * Mark a heartbeat marker comment as stale by replacing its body. Falls
 * back to a no-op on failure — the next worker scan will treat a missing
 * comment the same as an invalidated one.
 */
async function invalidateMarkerComment(
  repo: string,
  commentId: number,
  machineId: string,
  ghFn: (args: string[]) => Promise<string>,
  milestones: HeartbeatMilestone[] = [],
  host?: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
  outcome?: RunOutcome,
  attempts?: ReleaseAttemptTally,
): Promise<boolean> {
  // The progress log is kept on release (Issue #3753) so the finished
  // timeline stays readable; the cleared signal is unaffected. The run
  // outcome (Issue #4325) and the attempt tally (Issue #4327) reach the
  // render here.
  const body = renderReleasedBody({
    machineId,
    epoch: 0,
    released: true,
    milestones,
    ...(host ? { host } : {}),
    ...(outcome ? { outcome } : {}),
    ...(attempts ? { attempts } : {}),
  }, nowFn);
  return await patchMarkerComment(repo, commentId, body, ghFn);
}

/**
 * List every fleet-authored heartbeat marker comment on an issue/PR, oldest
 * first (Issue #4327). Shares the author filter and parse rules of
 * {@link findExistingMarkerComment}. Any failure yields null so callers
 * degrade to single-comment behaviour.
 */
export async function listFleetMarkerComments(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
  allowedAuthors?: string[],
): Promise<ExistingMarkerComment[] | null> {
  let json: string;
  try {
    json = await ghFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      "[.[] | {id: .id, body: .body, author: .user.login}]",
    ]);
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `listFleetMarkerComments failed for ${repo}#${issueNumber}: ${err}`,
    );
    return null;
  }
  if (!json) return null;
  let comments: Array<{ id?: number; body?: string; author?: string | null }>;
  try {
    comments = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(comments)) return null;
  const filterByAuthor = allowedAuthors !== undefined &&
    allowedAuthors.length > 0;
  const found: ExistingMarkerComment[] = [];
  for (const comment of comments) {
    if (!comment || typeof comment.body !== "string") continue;
    if (typeof comment.id !== "number" || !Number.isFinite(comment.id)) {
      continue;
    }
    if (filterByAuthor && !isFleetAuthor(comment.author, allowedAuthors!)) {
      continue;
    }
    const marker = parseHeartbeatMarker(comment.body);
    if (marker === null) continue;
    found.push({
      commentId: comment.id,
      machineId: marker.machineId,
      epoch: marker.epoch,
      cleared: marker.cleared,
      body: comment.body,
    });
  }
  return found.sort((a, b) => a.commentId - b.commentId);
}

/**
 * The visible line left on a superseded release comment (Issue #4327): the
 * heartbeat layer's own text, so `isHeartbeatOnlyBody` still holds and the
 * existing sweep removes it once past the cleared-marker grace window. It
 * carries the cleared marker so no scanner sees a live claim on it.
 */
export function renderSupersededReleaseBody(machineId: string): string {
  return `${formatHeartbeatMarker(machineId, 0)} ` +
    `<!-- cleared: claim released by machine ${machineId} -->\n\n` +
    `✅ **Vibe Coder released this claim** — collapsed into the release summary above.`;
}

/**
 * Render seam for the released body (Issue #4325): tests replace it to
 * assert the outcome that arrived at the render call, independent of the
 * rendered text. Production is {@link renderHeartbeatBody}.
 */
export let renderReleasedBody: (
  fields: HeartbeatBodyFields,
  nowFn: () => number,
) => string = renderHeartbeatBody;

/** Swap the release-body renderer (tests only). Returns a restore function. */
export function _setRenderReleasedBody(
  fn: typeof renderReleasedBody,
): () => void {
  const previous = renderReleasedBody;
  renderReleasedBody = fn;
  return () => {
    renderReleasedBody = previous;
  };
}

/** A heartbeat marker comment already published on an issue/PR. */
export interface ExistingMarkerComment {
  /** GitHub comment id, for PATCHing in place. */
  commentId: number;
  /** Machine that last wrote the marker. */
  machineId: string;
  /** Marker epoch (0 when the claim was released). */
  epoch: number;
  /** True when the marker carries the `cleared:` release signal. */
  cleared: boolean;
  /** Full comment body, so a CLAIM_LOCK prefix can be preserved. */
  body: string;
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
 */
export async function findExistingMarkerComment(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
  allowedAuthors?: string[],
): Promise<ExistingMarkerComment | null> {
  const json = await ghFn([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "--jq",
    "[.[] | {id: .id, body: .body, author: .user.login}]",
  ]);
  if (!json) return null;
  let comments: Array<{ id?: number; body?: string; author?: string | null }>;
  try {
    comments = JSON.parse(json);
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `findExistingMarkerComment parse failed for ${repo}#${issueNumber}: ${err}`,
    );
    return null;
  }
  if (!Array.isArray(comments)) return null;
  const filterByAuthor = Array.isArray(allowedAuthors) &&
    allowedAuthors.length > 0;
  let newest: ExistingMarkerComment | null = null;
  for (const comment of comments) {
    if (!comment || typeof comment.body !== "string") continue;
    if (typeof comment.id !== "number" || !Number.isFinite(comment.id)) {
      continue;
    }
    if (filterByAuthor && !isFleetAuthor(comment.author, allowedAuthors!)) {
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
      body: comment.body,
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
 */
function extractClaimPrefix(body: string): string {
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
 */
async function adoptExistingMarker(
  repo: string,
  issueNumber: number,
  options: HeartbeatMarkerOptions,
  ghFn: (args: string[]) => Promise<string>,
  heartbeatBody: string,
): Promise<{ commentId: number; claimPrefix: string } | null> {
  let found: ExistingMarkerComment | null = null;
  try {
    found = await findExistingMarkerComment(
      repo,
      issueNumber,
      ghFn,
      options.allowedAuthors,
    );
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `marker adoption lookup failed for ${repo}#${issueNumber}: ${err}`,
    );
    return null;
  }
  if (found === null) return null;

  const ownedByOtherLiveMachine = found.machineId !== options.machineId &&
    !found.cleared && found.epoch > 0;
  if (ownedByOtherLiveMachine) {
    console.warn(
      `[heartbeat] not adopting marker comment ${found.commentId} on ` +
        `${repo}#${issueNumber}: held by machine ${found.machineId} ` +
        `(epoch ${found.epoch}) — publishing a separate marker`,
    );
    return null;
  }

  // Only this machine's own still-live claim keeps its CLAIM_LOCK prefix; a
  // cleared comment is being re-used for a *new* claim, so the previous
  // claim's lock marker must not be resurrected.
  const claimPrefix = (!found.cleared && found.machineId === options.machineId)
    ? extractClaimPrefix(found.body)
    : "";
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
      ...(options.allowedAuthors
        ? { allowedAuthors: options.allowedAuthors }
        : {}),
      machineId: options.machineId,
    });
    if (sweep.deleted.length > 0 || sweep.orphanedLiveMarkers > 0) {
      console.log(
        `[heartbeat] swept ${sweep.deleted.length} stale marker comment(s) ` +
          `on ${repo}#${issueNumber} ` +
          `(${sweep.orphanedLiveMarkers} orphaned live marker(s))`,
      );
    }
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `heartbeat sweep failed for ${repo}#${issueNumber}: ${err}`,
    );
  }
  return { commentId: found.commentId, claimPrefix };
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
 */
export async function publishOrRefreshMarker(
  workDir: string,
  repo: string,
  issueNumber: number,
  options: HeartbeatMarkerOptions,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Result<void>> {
  const ghFn = options.ghFn ?? runGh;
  const minRefresh = options.minRefreshSeconds ??
    DEFAULT_MARKER_REFRESH_SECONDS;
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
    ...(options.host ? { host: options.host } : {}),
    ...(workerId ? { workerId } : {}),
    ...(startedEpoch ? { startedEpoch } : {}),
  }, () => now);
  const identity = {
    ...(startedEpoch ? { startedEpoch } : {}),
    ...(workerId ? { workerId } : {}),
  };

  if (existing === null) {
    // No local state — adopt the marker comment already on the issue/PR
    // rather than posting a duplicate (Issue #3751).
    const adopted = await adoptExistingMarker(
      repo,
      issueNumber,
      options,
      ghFn,
      heartbeatBody,
    );
    if (adopted !== null) {
      await writeMarkerState(workDir, repo, issueNumber, {
        commentId: adopted.commentId,
        lastRefresh: now,
        ...(adopted.claimPrefix ? { claimPrefix: adopted.claimPrefix } : {}),
        ...identity,
      });
      return { ok: true, value: undefined };
    }
    const commentId = await postMarkerComment(
      repo,
      issueNumber,
      heartbeatBody,
      ghFn,
    );
    if (commentId === null) {
      return {
        ok: false,
        error: new Error(
          `Failed to publish heartbeat marker comment for ${repo}#${issueNumber}`,
        ),
      };
    }
    await writeMarkerState(workDir, repo, issueNumber, {
      commentId,
      lastRefresh: now,
      ...identity,
    });
    return { ok: true, value: undefined };
  }

  // A released marker (kept by clearHeartbeat, Issue #3751) is revived on
  // the next claim regardless of the refresh window — its body currently
  // reads epoch 0, so waiting would leave the claim invisible.
  if (!existing.released && now - existing.lastRefresh < minRefresh) {
    // Within the refresh window — leave the existing marker alone.
    return { ok: true, value: undefined };
  }

  // Preserve the claim prefix (CLAIM_LOCK marker) when refreshing so race
  // detection keeps working on the combined claim+heartbeat comment
  // (Issue #1628). A released comment starts a *new* claim, so the previous
  // claim's lock marker is dropped.
  const claimPrefix = existing.released ? undefined : existing.claimPrefix;
  const refreshedBody = claimPrefix
    ? `${claimPrefix}\n${heartbeatBody}`
    : heartbeatBody;

  const edited = await patchMarkerComment(
    repo,
    existing.commentId,
    refreshedBody,
    ghFn,
  );
  if (edited) {
    await writeMarkerState(workDir, repo, issueNumber, {
      commentId: existing.commentId,
      lastRefresh: now,
      ...(claimPrefix ? { claimPrefix } : {}),
      ...identity,
    });
    return { ok: true, value: undefined };
  }
  // PATCH failed — post a fresh comment so the claim stays visible.
  // The fresh comment cannot recreate the CLAIM_LOCK marker (the claimer
  // owns that), so just publish the heartbeat marker on its own.
  const commentId = await postMarkerComment(
    repo,
    issueNumber,
    heartbeatBody,
    ghFn,
  );
  if (commentId === null) {
    return {
      ok: false,
      error: new Error(
        `Failed to refresh heartbeat marker for ${repo}#${issueNumber} (PATCH and POST both failed)`,
      ),
    };
  }
  await writeMarkerState(workDir, repo, issueNumber, {
    commentId,
    lastRefresh: now,
    ...identity,
  });
  return { ok: true, value: undefined };
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
 */
export async function recordMilestone(
  workDir: string,
  repo: string,
  issueNumber: number,
  text: string,
  markerOptions?: HeartbeatMarkerOptions,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Result<void>> {
  try {
    const entryText = normaliseMilestoneText(text);
    if (entryText.length === 0) return { ok: true, value: undefined };

    const now = nowFn();
    const milestones = [
      ...await readMilestones(workDir, repo, issueNumber),
      { epoch: now, text: entryText },
    ].slice(-MAX_MILESTONES);

    // Merge into whatever the state file already holds — the comment id and
    // refresh epoch belong to the heartbeat path, not to this one.
    const existing = await readMarkerState(workDir, repo, issueNumber);
    if (existing !== null) {
      await writeMarkerState(workDir, repo, issueNumber, {
        ...existing,
        milestones,
      });
    } else {
      await writeMilestonesOnly(workDir, repo, issueNumber, milestones);
    }

    if (markerOptions && markerOptions.machineId.length > 0) {
      await publishOrRefreshMarker(
        workDir,
        repo,
        issueNumber,
        { ...markerOptions, minRefreshSeconds: 0 },
        () => now,
      );
    }
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `recordMilestone failed for ${repo}#${issueNumber}: ${err}`,
    );
  }
  return { ok: true, value: undefined };
}

/**
 * Persist milestones when no marker comment exists yet (Issue #3753).
 *
 * Writing only the `milestones` key keeps the file invalid for
 * {@link readMarkerState}, so the next publish still takes the adopt-or-post
 * path — it just renders the stashed log on the comment it creates.
 */
async function writeMilestonesOnly(
  workDir: string,
  repo: string,
  issueNumber: number,
  milestones: HeartbeatMilestone[],
): Promise<void> {
  try {
    await Deno.mkdir(workDir, { recursive: true });
  } catch {
    // Directory already exists — non-fatal
  }
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(workDir, repo, issueNumber)),
    ) as Record<string, unknown>;
  } catch {
    // No readable state yet — start from an empty object.
  }
  try {
    await Deno.writeTextFile(
      markerStateFilePath(workDir, repo, issueNumber),
      JSON.stringify({ ...existing, milestones }),
    );
  } catch {
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
 */
export async function recordHeartbeat(
  workDir: string,
  repo: string,
  issueNumber: number,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
  markerOptions?: HeartbeatMarkerOptions,
): Promise<Result<void>> {
  if (isClaimReleased(workDir, repo, issueNumber)) {
    const message =
      `Refused to record a heartbeat for ${repo}#${issueNumber}: ` +
      `the claim was already released (Issue #214)`;
    console.warn(`[heartbeat] heartbeat_after_release ${message}`);
    recordFaultEvent("catch_block_warning", message);
    return { ok: false, error: new Error(message) };
  }
  const path = heartbeatFilePath(workDir, repo, issueNumber);
  try {
    await Deno.writeTextFile(path, String(nowFn()));
  } catch (err) {
    return {
      ok: false,
      error: new Error(`Failed to record heartbeat: ${err}`),
    };
  }

  if (markerOptions && markerOptions.machineId.length > 0) {
    try {
      const markerResult = await publishOrRefreshMarker(
        workDir,
        repo,
        issueNumber,
        markerOptions,
        nowFn,
      );
      if (!markerResult.ok) {
        recordFaultEvent(
          "catch_block_warning",
          `marker publish/refresh failed for ${repo}#${issueNumber}: ${markerResult.error.message}`,
        );
        return markerResult;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordFaultEvent(
        "catch_block_warning",
        `marker publish/refresh threw for ${repo}#${issueNumber}: ${msg}`,
      );
      return {
        ok: false,
        error: new Error(`Marker publish/refresh threw: ${msg}`),
      };
    }
  }
  return { ok: true, value: undefined };
}

/**
 * Clear (remove) the heartbeat file after successful completion.
 *
 * When `markerOptions` is provided, also invalidates the published GitHub
 * marker comment (Issue #1454) so a stale marker cannot later block
 * recovery of the issue if it is reassigned to a different worker.
 */
/**
 * Run outcomes handed to the next {@link clearHeartbeat} for an issue
 * (Issue #4330). `stopHeartbeat(handle, outcome)` cannot change every
 * `clearFn` wiring's signature, so it parks the outcome here, keyed by
 * repo#issue, and the clear that follows consumes it. Taken exactly once.
 */
const pendingReleaseOutcomes = new Map<string, RunOutcome>();

function pendingKey(repo: string, issueNumber: number): string {
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
 */
const releasedClaims = new Set<string>();

function releaseKey(
  workDir: string,
  repo: string,
  issueNumber: number,
): string {
  return `${workDir} ${repo}#${issueNumber}`;
}

/** Record that this claim has been released — no further beats allowed. */
export function markClaimReleased(
  workDir: string,
  repo: string,
  issueNumber: number,
): void {
  releasedClaims.add(releaseKey(workDir, repo, issueNumber));
}

/**
 * Lift the guard because a new claim on this issue has begun (Issue #214).
 *
 * Called by `startHeartbeat` and by the claim path's marker seeding, so a
 * legitimate re-claim beats normally while a released claim stays silent.
 */
export function clearClaimReleaseGuard(
  workDir: string,
  repo: string,
  issueNumber: number,
): void {
  releasedClaims.delete(releaseKey(workDir, repo, issueNumber));
}

/** Whether this claim has been released and must not beat again. */
export function isClaimReleased(
  workDir: string,
  repo: string,
  issueNumber: number,
): boolean {
  return releasedClaims.has(releaseKey(workDir, repo, issueNumber));
}

/** Park an outcome for the next clear of this issue (Issue #4330). */
export function setPendingReleaseOutcome(
  repo: string,
  issueNumber: number,
  outcome: RunOutcome,
): void {
  pendingReleaseOutcomes.set(pendingKey(repo, issueNumber), outcome);
}

/** Take (and forget) the parked outcome for this issue, if any. */
export function takePendingReleaseOutcome(
  repo: string,
  issueNumber: number,
): RunOutcome | undefined {
  const key = pendingKey(repo, issueNumber);
  const outcome = pendingReleaseOutcomes.get(key);
  pendingReleaseOutcomes.delete(key);
  return outcome;
}

/** Same attempt seen twice (host and clock minute): the second clear of one release. */
function isSameAttempt(
  a: ReleaseAttempt | undefined,
  b: ReleaseAttempt,
): boolean {
  return a !== undefined && a.host === b.host &&
    formatMilestoneTime(a.epoch) === formatMilestoneTime(b.epoch);
}

export async function clearHeartbeat(
  workDir: string,
  repo: string,
  issueNumber: number,
  markerOptions?: HeartbeatMarkerOptions,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
  outcome?: RunOutcome,
): Promise<Result<void>> {
  // The claim is released from here on (Issue #214): any later beat for it
  // is a leak and is refused by `recordHeartbeat`.
  markClaimReleased(workDir, repo, issueNumber);
  const path = heartbeatFilePath(workDir, repo, issueNumber);
  try {
    await Deno.remove(path);
  } catch {
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
      return { ok: true, value: undefined };
    }
    const host = markerOptions.host ??
      hostFromMachineId(markerOptions.machineId);
    const thisAttempt: ReleaseAttempt = {
      epoch: now,
      host,
      text: describeAttemptOutcome(outcome),
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
    let canonical: ExistingMarkerComment | null = null;
    let listed: ExistingMarkerComment[] | null = null;
    try {
      listed = await listFleetMarkerComments(
        repo,
        issueNumber,
        ghFn,
        markerOptions.allowedAuthors,
      );
    } catch {
      listed = null;
    }
    if (listed !== null) {
      canonical = listed.find((c) =>
        c.cleared && c.commentId !== existing?.commentId
      ) ?? null;
      if (canonical === null && existing === null) {
        // Nothing released yet on the thread and no local state: adopt the
        // newest fleet marker (the claim comment this host cannot see
        // locally) so the release text lands somewhere.
        canonical = listed.length > 0 ? listed[listed.length - 1]! : null;
      }
    }

    // The tally: this host's state (same-host revive) or the canonical body
    // (the only source that survives a host change), plus this attempt.
    const canonicalTally = canonical ? parseAttemptBlock(canonical.body) : null;
    const ownBody = existing && listed
      ? listed.find((c) => c.commentId === existing.commentId)?.body
      : undefined;
    const canonicalSingle = canonical && canonicalTally === null
      ? (() => {
        const first = parseReleaseAttemptFromBody(canonical.body);
        return {
          total: 1,
          attempts: [
            first ?? {
              epoch: 0,
              host: hostFromMachineId(canonical.machineId),
              text: "released",
            },
          ],
        } satisfies ReleaseAttemptTally;
      })()
      : null;
    const previous = canonicalTally ?? canonicalSingle ??
      (ownBody ? parseAttemptBlock(ownBody) : null) ??
      existing?.attempts ?? null;
    // The second clear of one release (heartbeat stop, then the claim
    // release) says the same thing: skip the write.
    const last = existing?.attempts?.attempts.at(-1);
    if (
      existing?.released && isSameAttempt(last, thisAttempt) &&
      last!.text === thisAttempt.text
    ) {
      return { ok: true, value: undefined };
    }
    const tally = appendAttempt(previous, thisAttempt);

    const target = canonical?.commentId ?? existing?.commentId ?? null;
    if (target !== null) {
      try {
        await invalidateMarkerComment(
          repo,
          target,
          markerOptions.machineId,
          ghFn,
          existing?.milestones ?? [],
          markerOptions.host,
          nowFn,
          outcome,
          tally,
        );
      } catch (err) {
        recordFaultEvent(
          "catch_block_warning",
          `marker invalidate failed for ${repo}#${issueNumber}: ${err}`,
        );
      }
      // This host's own comment, superseded by the canonical: a pointer
      // with the cleared marker (never deleted here — the sweep owns that).
      if (
        existing !== null && canonical !== null &&
        canonical.commentId !== existing.commentId
      ) {
        try {
          await patchMarkerComment(
            repo,
            existing.commentId,
            renderSupersededReleaseBody(markerOptions.machineId),
            ghFn,
          );
        } catch (err) {
          recordFaultEvent(
            "catch_block_warning",
            `superseded marker patch failed for ${repo}#${issueNumber}: ${err}`,
          );
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
        attempts: tally,
      });
    }
  }
  return { ok: true, value: undefined };
}

/** Options controlling {@link releaseClaim}. */
export interface ReleaseClaimOptions {
  /** GitHub username of the worker to unassign. */
  githubUser: string;
  /**
   * Function used to invoke `gh` for the unassign call. Defaults to the
   * module-local {@link runGh}.
   */
  ghFn?: (args: string[]) => Promise<string>;
  /**
   * Marker options forwarded to {@link clearHeartbeat} so the published
   * GitHub heartbeat marker is invalidated alongside the local file.
   */
  markerOptions?: HeartbeatMarkerOptions;
  /**
   * What the run achieved (Issue #4325, part of #4291), rendered into the
   * release comment. Omitted on paths where the run never ran (skip after
   * claim) — the release text is then exactly today's.
   */
  outcome?: RunOutcome;
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
 */
export async function releaseClaim(
  workDir: string,
  repo: string,
  issueNumber: number,
  options: ReleaseClaimOptions,
): Promise<Result<{ unassigned: boolean; heartbeatCleared: boolean }>> {
  let unassigned = false;
  let heartbeatCleared = false;

  // Step 1: stop the heartbeat, post the outcome on the marker comment, and
  // arm the write-after-release guard (best-effort, independent of step 2).
  try {
    const result = await clearHeartbeat(
      workDir,
      repo,
      issueNumber,
      options.markerOptions,
      undefined,
      options.outcome,
    );
    heartbeatCleared = result.ok;
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `releaseClaim clearHeartbeat failed for ${repo}#${issueNumber}: ${err}`,
    );
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
        options.githubUser,
      ]);
      unassigned = true;
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `releaseClaim unassign failed for ${repo}#${issueNumber}: ${err}`,
      );
    }
  }

  return { ok: true, value: { unassigned, heartbeatCleared } };
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
 */
export async function scanHeartbeatMarkers(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
  allowedAuthors?: string[],
): Promise<Array<{ machineId: string; epoch: number; cleared: boolean }>> {
  const json = await ghFn([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "--jq",
    "[.[] | {body: .body, author: .user.login}]",
  ]);
  if (!json) return [];
  let comments: Array<{ body: string; author?: string | null }>;
  try {
    comments = JSON.parse(json);
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `scanHeartbeatMarkers parse failed for ${repo}#${issueNumber}: ${err}`,
    );
    return [];
  }
  const filterByAuthor = Array.isArray(allowedAuthors) &&
    allowedAuthors.length > 0;
  const markers: Array<{ machineId: string; epoch: number; cleared: boolean }> =
    [];
  for (const comment of comments) {
    if (!comment || typeof comment.body !== "string") continue;
    // Issue #3164: ignore a marker whose author is not a fleet account when
    // the caller supplied a fleet allow-list (fail toward recovery).
    if (filterByAuthor && !isFleetAuthor(comment.author, allowedAuthors!)) {
      continue;
    }
    const marker = parseHeartbeatMarker(comment.body);
    if (marker !== null) markers.push(marker);
  }
  return markers;
}
