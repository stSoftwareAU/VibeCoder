/**
 * CI-fix attempt and deferral markers on a pull request (Issue #1877,
 * parent #1861).
 *
 * The CI-fix lane's attempt cap and its "one comment per failure" dedup both
 * used to live in each host's own `$HOME/auto-issue-work/.ci_check_state`
 * volume. Nothing in that directory is visible to another host, so two
 * accounts working the same pull request each spent their own three attempts
 * and posted their own copy of the same diagnosis — nine comments in
 * 76 minutes on NEAT-AI-Backpropagation#150.
 *
 * The record therefore moves to the pull request itself, where every host
 * already looks: a machine-readable marker in the comment the lane posts.
 *
 *   <!-- vibe-ci-fix-attempt signature="…" check="…" head="…" attempt="2"
 *        outcome="pushed" -->
 *   <!-- vibe-ci-fix-deferred signature="…" check="…"
 *        depends-on="owner/repo#149" -->
 *
 * Both use the canonical `vibe-` grammar — a bare prefix and `key="value"`
 * attributes, no colon payload — which `tests/marker_grammar_test.ts` pins,
 * so neither needs an `ACCEPTED_DEVIATIONS` entry.
 *
 * Two properties this module exists to hold:
 *
 * - **A marker is evidence only when the fleet wrote it.** A comment body is
 *   text anyone who can comment on a public pull request may write, and only
 *   the comment *author* is authenticated. {@link collectFleetCiFixMarkers}
 *   therefore filters by author before it reads any body, the same control
 *   `alert_dedup_authors.ts` applies to body-marker dedup (Issue #1216).
 *   Without it a drive-by comment carrying three attempt markers would
 *   exhaust the cap, and one carrying a deferral marker would park the pull
 *   request until someone noticed.
 * - **Every attribute value is validated, never passed through.** The parsed
 *   values are folded into later comments and log lines, so a marker is
 *   accepted only when its signature is hex, its head a 40-character SHA, its
 *   attempt a positive integer, its outcome one of the two known words and
 *   its dependency a real `owner/repo#N`. A malformed or partial marker is
 *   ignored rather than half-read.
 *
 * The module is pure: it builds strings and reads strings, and does no I/O.
 * Fetching the comments and acting on the tally belong to the processor and
 * scanner wiring, which land in their own sub-issues.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { isFleetAuthor } from "./fleet_authors.ts";
import { REPO_SLUG_PATTERN } from "./repo_slug.ts";

/** Marker recording one completed CI-fix attempt against a failure. */
export const CI_FIX_ATTEMPT_MARKER_NAME = "vibe-ci-fix-attempt";

/** Marker recording that a failure was deferred to a blocking issue. */
export const CI_FIX_DEFERRAL_MARKER_NAME = "vibe-ci-fix-deferred";

/** Longest check name a marker carries; a longer one is truncated. */
export const MAX_CHECK_NAME_LENGTH = 120;

/** Longest diagnosis line lifted from a comment body. */
export const MAX_DIAGNOSIS_LENGTH = 200;

/** Highest attempt number a marker may state. */
const MAX_ATTEMPT = 999;

/** A signature is the hex digest `computeFailureSignature` produces. */
const SIGNATURE_PATTERN = /^[0-9a-f]{8,64}$/;

/** A head is a full 40-character commit SHA. */
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** What an attempt did. */
export type CiFixAttemptOutcome = "pushed" | "no-change";

/** The two words {@link CiFixAttemptOutcome} may take, for validation. */
const OUTCOMES: readonly string[] = ["pushed", "no-change"];

/** One recorded CI-fix attempt. */
export interface CiFixAttemptMarker {
  /** Failure signature from `computeFailureSignature`. */
  signature: string;
  /** Name of the failing check. */
  checkName: string;
  /** Head SHA the attempt was made against. */
  head: string;
  /** 1-based attempt number. */
  attempt: number;
  /** Whether the attempt pushed a fix or reported no change required. */
  outcome: CiFixAttemptOutcome;
}

/** One recorded deferral of a failure to a blocking issue. */
export interface CiFixDeferralMarker {
  /** Failure signature from `computeFailureSignature`. */
  signature: string;
  /** Name of the failing check. */
  checkName: string;
  /** The blocking issue, in `owner/repo#N` form. */
  dependsOn: string;
}

/**
 * A pull-request comment as `GitHubClient.getIssueComments` returns it.
 *
 * Every field beyond `id` is optional and nullable: the REST payload is
 * outside this module's control, and a row missing its author or body is
 * simply not evidence.
 */
export interface CiFixMarkerComment {
  /** Numeric comment id. */
  id: number;
  /** Comment author's login. */
  author?: string | null;
  /** Comment body. */
  body?: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt?: string | null;
}

/** Where a marker was found, and what the comment said around it. */
export interface CiFixMarkerContext {
  /** Id of the comment carrying the marker. */
  commentId: number;
  /** The comment's creation timestamp, or `""` when absent. */
  createdAt: string;
  /**
   * First non-empty, non-marker line of the comment body — the agent's own
   * one-line diagnosis, which the cap summary renders as its "diagnosed"
   * cell. Control characters are flattened and the line is capped, but it is
   * still prose: a caller rendering it into a Markdown table escapes it for
   * that sink.
   */
  diagnosed: string;
}

/** An attempt marker with the comment it was read from. */
export type CiFixAttemptRecord = CiFixAttemptMarker & CiFixMarkerContext;

/** A deferral marker with the comment it was read from. */
export type CiFixDeferralRecord = CiFixDeferralMarker & CiFixMarkerContext;

/** Every fleet-authored CI-fix marker on a pull request, by signature. */
export interface FleetCiFixMarkers {
  /** Attempt records, keyed by failure signature, in comment order. */
  attempts: Map<string, CiFixAttemptRecord[]>;
  /** Deferral records, keyed by failure signature, in comment order. */
  deferrals: Map<string, CiFixDeferralRecord[]>;
}

/**
 * Matches every `name="…"` attribute inside a marker's inner text.
 *
 * Hardcoded rather than compiled per attribute name — the name is data,
 * compared against the captured group — so no pattern is ever built from a
 * variable (the shape `cross_repo_pr_handoff.ts` established).
 */
const ATTRIBUTE_RE = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/g;

/** The attempt marker, wherever it appears in a body. */
const ATTEMPT_MARKER_RE = new RegExp(
  `<!--\\s*${CI_FIX_ATTEMPT_MARKER_NAME}\\b([^]*?)-->`,
  "gi",
);

/** The deferral marker, wherever it appears in a body. */
const DEFERRAL_MARKER_RE = new RegExp(
  `<!--\\s*${CI_FIX_DEFERRAL_MARKER_NAME}\\b([^]*?)-->`,
  "gi",
);

/** Read one attribute out of a marker's inner text. */
function attribute(inner: string, name: string): string | undefined {
  for (const match of inner.matchAll(ATTRIBUTE_RE)) {
    if (match[1]?.toLowerCase() !== name) continue;
    return match[2];
  }
  return undefined;
}

/** Collapse control characters (newlines included) to spaces. */
function flattenControlCharacters(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, " ");
}

/**
 * Render a check name safe to place inside an HTML comment attribute.
 *
 * A check name is chosen by whoever wrote the workflow, so on a fork's pull
 * request it is attacker-controlled text. A quote would end the attribute and
 * `-->` would end the comment, spilling the rest into the visible body — so
 * quotes and angle brackets are removed outright rather than escaped (an
 * attribute value has no escaping to lean on), control characters collapse to
 * spaces, and the result is capped.
 *
 * Deliberately not `sanitiseDeclarationField` from `cross_repo_pr_handoff.ts`:
 * that neutralises breakout sequences for a PR *body* and importing it would
 * pull `gh` spawning and the escalation graph into a module whose whole point
 * is that it is pure.
 *
 * @param checkName - The raw check name.
 * @returns The sanitised name, possibly empty.
 */
export function sanitiseCheckName(checkName: string): string {
  return flattenControlCharacters(checkName)
    .replace(/["'<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHECK_NAME_LENGTH)
    .trim();
}

/** True when `ref` is a dependency reference in `owner/repo#N` form. */
export function isDependencyRef(ref: string): boolean {
  const hash = ref.indexOf("#");
  if (hash < 0) return false;
  return REPO_SLUG_PATTERN.test(ref.slice(0, hash)) &&
    /^[1-9][0-9]*$/.test(ref.slice(hash + 1));
}

/** Reject a field the worker itself computed — a bad one is a bug, not data. */
function requireField(valid: boolean, field: string, value: string): void {
  if (valid) return;
  const inert = flattenControlCharacters(value).slice(0, 80);
  throw new Error(`ci-fix marker: ${field} is not valid ("${inert}")`);
}

/**
 * Build the marker recording one CI-fix attempt.
 *
 * Fails loud on every field except the check name: the signature, head,
 * attempt number and outcome are the worker's own values, so a malformed one
 * is a defect to surface rather than a marker to write. The check name is
 * untrusted workflow text and is sanitised instead — but an empty result is
 * still refused, because a marker naming no check identifies nothing.
 *
 * @param marker - The attempt to record.
 * @returns The marker, as a single-line HTML comment.
 * @throws When any field fails validation.
 */
export function buildCiFixAttemptMarker(marker: CiFixAttemptMarker): string {
  requireField(
    SIGNATURE_PATTERN.test(marker.signature),
    "signature",
    marker.signature,
  );
  requireField(HEAD_SHA_PATTERN.test(marker.head), "head", marker.head);
  requireField(
    Number.isInteger(marker.attempt) && marker.attempt >= 1 &&
      marker.attempt <= MAX_ATTEMPT,
    "attempt",
    String(marker.attempt),
  );
  requireField(OUTCOMES.includes(marker.outcome), "outcome", marker.outcome);
  const check = sanitiseCheckName(marker.checkName);
  requireField(check.length > 0, "check", marker.checkName);

  return `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME} signature="${marker.signature}" ` +
    `check="${check}" head="${marker.head}" attempt="${marker.attempt}" ` +
    `outcome="${marker.outcome}" -->`;
}

/**
 * Build the marker recording that a failure was deferred to a blocking issue.
 *
 * @param marker - The deferral to record.
 * @returns The marker, as a single-line HTML comment.
 * @throws When any field fails validation.
 */
export function buildCiFixDeferralMarker(marker: CiFixDeferralMarker): string {
  requireField(
    SIGNATURE_PATTERN.test(marker.signature),
    "signature",
    marker.signature,
  );
  requireField(
    isDependencyRef(marker.dependsOn),
    "depends-on",
    marker.dependsOn,
  );
  const check = sanitiseCheckName(marker.checkName);
  requireField(check.length > 0, "check", marker.checkName);

  return `<!-- ${CI_FIX_DEFERRAL_MARKER_NAME} signature="${marker.signature}" ` +
    `check="${check}" depends-on="${marker.dependsOn}" -->`;
}

/**
 * Read every well-formed attempt marker out of a comment body.
 *
 * A marker missing an attribute, or carrying one that fails validation, is
 * skipped: half a record is worse than none, because the half that survived
 * would still be counted as an attempt.
 *
 * @param body - The comment body.
 * @returns One record per valid marker, in the order they appear.
 */
export function parseCiFixAttemptMarkers(body: string): CiFixAttemptMarker[] {
  const markers: CiFixAttemptMarker[] = [];
  for (const match of body.matchAll(ATTEMPT_MARKER_RE)) {
    const inner = match[1] ?? "";
    const signature = attribute(inner, "signature") ?? "";
    const checkName = sanitiseCheckName(attribute(inner, "check") ?? "");
    const head = attribute(inner, "head") ?? "";
    const rawAttempt = attribute(inner, "attempt") ?? "";
    const outcome = attribute(inner, "outcome") ?? "";

    if (!SIGNATURE_PATTERN.test(signature)) continue;
    if (checkName.length === 0) continue;
    if (!HEAD_SHA_PATTERN.test(head)) continue;
    if (!/^[1-9][0-9]*$/.test(rawAttempt)) continue;
    const attempt = Number(rawAttempt);
    if (attempt > MAX_ATTEMPT) continue;
    if (!OUTCOMES.includes(outcome)) continue;

    markers.push({
      signature,
      checkName,
      head,
      attempt,
      outcome: outcome as CiFixAttemptOutcome,
    });
  }
  return markers;
}

/**
 * Read every well-formed deferral marker out of a comment body.
 *
 * @param body - The comment body.
 * @returns One record per valid marker, in the order they appear.
 */
export function parseCiFixDeferralMarkers(body: string): CiFixDeferralMarker[] {
  const markers: CiFixDeferralMarker[] = [];
  for (const match of body.matchAll(DEFERRAL_MARKER_RE)) {
    const inner = match[1] ?? "";
    const signature = attribute(inner, "signature") ?? "";
    const checkName = sanitiseCheckName(attribute(inner, "check") ?? "");
    const dependsOn = attribute(inner, "depends-on") ?? "";

    if (!SIGNATURE_PATTERN.test(signature)) continue;
    if (checkName.length === 0) continue;
    if (!isDependencyRef(dependsOn)) continue;

    markers.push({ signature, checkName, dependsOn });
  }
  return markers;
}

/**
 * The comment's first line that is neither empty nor a marker.
 *
 * The CI-fix comment leads with the agent's own diagnosis and carries its
 * markers underneath, so this is the sentence the cap summary quotes back.
 *
 * @param body - The comment body.
 * @returns The line, flattened and capped, or `""` when there is none.
 */
export function firstDiagnosisLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = flattenControlCharacters(raw).trim();
    if (line.length === 0) continue;
    if (line.startsWith("<!--")) continue;
    return line.slice(0, MAX_DIAGNOSIS_LENGTH).trim();
  }
  return "";
}

/** Push `value` onto the list `key` names, creating it when absent. */
function append<T>(target: Map<string, T[]>, key: string, value: T): void {
  const existing = target.get(key);
  if (existing === undefined) target.set(key, [value]);
  else existing.push(value);
}

/**
 * Collect the CI-fix markers a fleet account wrote, grouped by signature.
 *
 * Comments by anyone outside `fleetLogins` are dropped before their bodies
 * are read at all — a marker is a claim about what the fleet did, and only
 * the author of a comment is authenticated. An empty `fleetLogins` is an
 * unresolved fleet identity, so nothing is attributable and nothing is
 * collected; the caller decides what an empty tally means for it and says so
 * in its own log, as `alert_dedup_authors.ts` requires of its callers.
 *
 * @param comments - The pull request's comments, in the order the API
 *   returned them (oldest first), so "the earliest marker" is the first.
 * @param fleetLogins - Logins whose markers are trusted.
 * @returns Attempt and deferral records grouped by failure signature.
 */
export function collectFleetCiFixMarkers(
  comments: readonly CiFixMarkerComment[],
  fleetLogins: readonly string[],
): FleetCiFixMarkers {
  const attempts = new Map<string, CiFixAttemptRecord[]>();
  const deferrals = new Map<string, CiFixDeferralRecord[]>();
  const fleet = [...fleetLogins];
  if (fleet.length === 0) return { attempts, deferrals };

  for (const comment of comments) {
    if (!isFleetAuthor(comment.author, fleet)) continue;
    const body = comment.body ?? "";
    if (body.length === 0) continue;

    const context: CiFixMarkerContext = {
      commentId: comment.id,
      createdAt: comment.createdAt ?? "",
      diagnosed: firstDiagnosisLine(body),
    };

    for (const marker of parseCiFixAttemptMarkers(body)) {
      append(attempts, marker.signature, { ...marker, ...context });
    }
    for (const marker of parseCiFixDeferralMarkers(body)) {
      append(deferrals, marker.signature, { ...marker, ...context });
    }
  }

  return { attempts, deferrals };
}

/**
 * How many attempts the fleet has already made against one signature.
 *
 * This is the fleet-wide tally the attempt cap binds on: every host reads it
 * off the same pull request, so three attempts are three across the fleet
 * rather than three per host.
 *
 * @param markers - Collected markers.
 * @param signature - Failure signature.
 * @returns The number of recorded attempts, zero when there are none.
 */
export function countAttempts(
  markers: FleetCiFixMarkers,
  signature: string,
): number {
  return markers.attempts.get(signature)?.length ?? 0;
}

/**
 * The first "no change required" comment posted for one signature.
 *
 * Its presence is what makes the CI-fix reply post once per failure per pull
 * request fleet-wide instead of once per host.
 *
 * @param markers - Collected markers.
 * @param signature - Failure signature.
 * @returns The earliest no-change record, or `undefined`.
 */
export function findNoChangeComment(
  markers: FleetCiFixMarkers,
  signature: string,
): CiFixAttemptRecord | undefined {
  return markers.attempts.get(signature)
    ?.find((record) => record.outcome === "no-change");
}

/**
 * The first deferral recorded for one signature.
 *
 * @param markers - Collected markers.
 * @param signature - Failure signature.
 * @returns The earliest deferral record, or `undefined`.
 */
export function findDeferral(
  markers: FleetCiFixMarkers,
  signature: string,
): CiFixDeferralRecord | undefined {
  return markers.deferrals.get(signature)?.[0];
}
