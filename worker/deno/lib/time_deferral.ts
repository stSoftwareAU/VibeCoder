/**
 * Time-gated deferral for analysis-only runs whose data does not exist yet
 * (Issue #2873).
 *
 * The no-changes handler's `needs-human` ending fits a run that genuinely
 * needs a human decision. It does not fit a run whose agent correctly found
 * the work cannot proceed *yet* because the data it needs to analyse has not
 * been produced — escalating that to a human strips the discovery label and
 * parks a task nobody can act on until the data turns up on its own.
 *
 * A time deferral is a third ending, mirroring `blocked_deferral.ts`:
 *
 *   * the issue stays **open**, with its discovery label untouched;
 *   * `Deferred until YYYY-MM-DDTHH:MM:SSZ` is recorded in the body, inside
 *     the machine-owned record block (`worker_record_block.ts`), so
 *     discovery can skip the issue until that time;
 *   * the claim is released with the outcome
 *     `deferred until <ISO>`, which the release comment states.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { execMarkerOutsideCode } from "./issue_dependencies.ts";
import { expectedNoPrOutcome, type RunOutcome } from "./run_outcome.ts";
import { releaseClaim as defaultReleaseClaim } from "./claim_release.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  readWorkerRecordLines,
  upsertWorkerRecordLine,
} from "./worker_record_block.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { neutraliseAgentMarkers } from "./agent_marker_neutralisation.ts";
import type { IssueFetcher } from "./issue_dependencies.ts";
import type { GitHubClient, Logger } from "../types.ts";

/** Marker the run emits to request a time-gated deferral. */
export const TIME_DEFERRAL_MARKER = "vibe-defer-until";

/**
 * How many times an issue may be time-deferred before it is handed to a
 * human. Bounded so a condition that is never met cannot loop forever,
 * re-running an expensive agent and re-parking the issue indefinitely.
 */
export const MAX_TIME_DEFERRALS = 3;

/**
 * The longest a single deferral may push the issue out. Bounded so a
 * mistaken or malicious `until` far in the future cannot park an issue for
 * good under a label that reads as "still active".
 */
export const MAX_DEFERRAL_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/** Longest reason carried into the public comment. */
const MAX_REASON_LENGTH = 500;

/** A validated request to park the issue until a future time. */
export interface TimeDeferralRequest {
  /** Canonical `YYYY-MM-DDTHH:MM:SSZ`, in UTC. */
  until: string;
  /** `until` as epoch milliseconds — matches the canonical string exactly. */
  untilMs: number;
  /** The agent's reason the data is not there yet, trimmed and capped. */
  reason: string;
}

/** Why a detected marker was rejected. */
export type TimeDeferralDetection =
  | { kind: "valid"; request: TimeDeferralRequest }
  | { kind: "invalid"; why: string };

const REQUEST_RE = /<!--\s*vibe-defer-until(?![A-Za-z0-9_:-])([^]*?)-->/i;
const UNTIL_RE = /\buntil\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const REASON_RE = /\breason\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** Strict ISO-8601 date-time with an explicit offset — `Z` or `±HH:MM`. */
const STRICT_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Canonical form `upsertWorkerRecordLine` accepts, matching `until`. */
function canonicalUntil(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Detect a `vibe-defer-until` request in the run output.
 *
 * `undefined` when no marker is present at all — the caller falls through to
 * its existing handling. A marker with a malformed `until`, a time already
 * past (or too close, or too far out), or a missing `reason` is `invalid`
 * rather than silently ignored, so the caller can say why it did not defer.
 */
export function detectTimeDeferral(
  output: string,
  nowMs: number,
): TimeDeferralDetection | undefined {
  // A marker quoted in a fence or an inline span is the template, not a
  // request. A committed run reads this detector, so a summary that quotes
  // the marker must not park the run (Issue #3088 review). Attributes are
  // read from the original text so a reason's own backticks stay.
  const marker = execMarkerOutsideCode(output, REQUEST_RE);
  if (!marker) return undefined;
  const body = marker[1] ?? "";

  const untilAttr = UNTIL_RE.exec(body);
  const rawUntil = (untilAttr?.[1] ?? untilAttr?.[2] ?? "").trim();
  if (!rawUntil) return { kind: "invalid", why: "missing 'until'" };
  if (!STRICT_ISO_RE.test(rawUntil)) {
    return {
      kind: "invalid",
      why:
        `'until' is not a strict ISO-8601 date-time with an offset: ${rawUntil}`,
    };
  }
  const parsedMs = Date.parse(rawUntil);
  if (Number.isNaN(parsedMs)) {
    return { kind: "invalid", why: `'until' does not parse: ${rawUntil}` };
  }

  const reasonAttr = REASON_RE.exec(body);
  const reason = (reasonAttr?.[1] ?? reasonAttr?.[2] ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_REASON_LENGTH);
  if (!reason) return { kind: "invalid", why: "missing 'reason'" };

  if (parsedMs <= nowMs) {
    return { kind: "invalid", why: "'until' is not in the future" };
  }
  if (parsedMs - nowMs > MAX_DEFERRAL_HORIZON_MS) {
    return {
      kind: "invalid",
      why: `'until' is beyond the ${MAX_DEFERRAL_HORIZON_MS}ms horizon`,
    };
  }

  const until = canonicalUntil(parsedMs);
  return {
    kind: "valid",
    request: { until, untilMs: Date.parse(until), reason },
  };
}

/** The `Deferred until <ISO>` line the machine-owned block carries. */
export function buildTimeDeferralLine(until: string): string {
  return `Deferred until ${until}`;
}

const RECORD_LINE_RE =
  /^Deferred until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

/**
 * Read the `Deferred until` time out of the body's machine-owned block, in
 * milliseconds. Only a line inside that block counts — user-typed prose
 * elsewhere in the body, even text that looks identical, is never read as a
 * deferral (the same author-blind rule `worker_record_block.ts` documents).
 */
export function parseTimeDeferralUntil(body: string): number | undefined {
  for (const line of readWorkerRecordLines(body)) {
    const match = RECORD_LINE_RE.exec(line);
    if (match) return Date.parse(match[1]!);
  }
  return undefined;
}

/** True while `body` records a `Deferred until` time still in the future. */
export function isTimeDeferred(body: string, nowMs: number): boolean {
  const until = parseTimeDeferralUntil(body);
  return until !== undefined && nowMs < until;
}

/**
 * Discovery-side check: is `repo#issueNumber` still time-deferred right now?
 *
 * One helper shared by every collector (Issue #2873), rather than each
 * re-implementing the same read-and-check. Fails toward **not** deferred
 * when the body cannot be read — the same fail-safe direction
 * `isDependencyBlocked` takes on an unreadable body — but the failure is
 * reported through `onReadError`, not swallowed, so a persistently
 * unreadable body is visible rather than silently parking the issue in
 * discovery's blind spot.
 */
export async function isIssueTimeDeferred(
  fetcher: Pick<IssueFetcher, "getIssueBody">,
  repo: string,
  issueNumber: number,
  nowMs: number,
  onReadError?: (message: string) => void,
): Promise<boolean> {
  try {
    const body = await fetcher.getIssueBody(repo, issueNumber);
    return isTimeDeferred(body, nowMs);
  } catch (error) {
    onReadError?.(
      `Could not read ${repo}#${issueNumber} to check time deferral: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Marker hidden in the park comment, naming the time deferred to. A later
 * run reads it back to count how many times the issue has been parked.
 */
export const TIME_DEFERRAL_RECORD_MARKER = "vibe-time-deferral";

/** The hidden marker the park comment carries. */
function buildTimeDeferralRecordMarker(until: string): string {
  return `<!-- ${TIME_DEFERRAL_RECORD_MARKER} until="${until}" -->`;
}

const RECORD_MARKER_RE =
  /<!--\s*vibe-time-deferral(?![A-Za-z0-9_:-])([^]*?)-->/gi;

/**
 * The `until` values of earlier park comments, oldest first.
 *
 * `comments` is the same flattened comment text `hasPriorDeferral` takes —
 * already trust-boundary formatted upstream, so no further author filtering
 * happens here.
 */
export function priorTimeDeferrals(comments: string): string[] {
  if (!comments) return [];
  const found: string[] = [];
  for (const match of comments.matchAll(RECORD_MARKER_RE)) {
    const attr = UNTIL_RE.exec(match[1] ?? "");
    const until = attr?.[1] ?? attr?.[2];
    if (until) found.push(until);
  }
  return found;
}

/** Options accepted by {@link countPriorTimeDeferrals}. */
export interface CountPriorTimeDeferralsOptions {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  /**
   * Fleet-owned logins whose park comments count — this host plus every
   * sibling `fleet_pr_authors` / `service_accounts` login, i.e.
   * {@link resolveFleetMaintenanceAuthorSet}. A single login under-counts
   * on a multi-host fleet: a sibling host's own park comments would not be
   * seen, letting the issue be parked up to `MAX_TIME_DEFERRALS` times per
   * login instead of per issue (Issue #2933 review).
   */
  fleetAuthors: readonly string[];
  /** The prompt comment blob, read only when the thread cannot be fetched. */
  fallbackComments: string;
  logger: Logger;
}

/**
 * The `until` values of this issue's earlier park comments, oldest first,
 * read from the full comment thread.
 *
 * Not from the prompt comment blob: that is capped at 20 comments / 12,000
 * characters and admits worker comments last, so on a busy thread it holds
 * none of the park comments and the {@link MAX_TIME_DEFERRALS} bound never
 * fires (#2873 review). Only fleet-owned comments count (this host plus
 * sibling `fleet_pr_authors` / `service_accounts` logins), so a marker
 * pasted by anyone outside the fleet cannot move the budget, while a sibling
 * host's own parks still do (Issue #2933 review). A failed fetch falls back
 * to the blob, logged as degraded.
 */
export async function countPriorTimeDeferrals(
  options: CountPriorTimeDeferralsOptions,
): Promise<string[]> {
  const { ghClient, repo, issueNumber, fleetAuthors, logger } = options;
  try {
    const thread = await ghClient.getIssueComments(repo, issueNumber);
    return priorTimeDeferrals(
      thread
        .filter((c) => isFleetAuthor(c.author, [...fleetAuthors]))
        .map((c) => c.body)
        .join("\n\n"),
    );
  } catch (err) {
    logger.warn(
      "Could not fetch the issue thread to count prior time deferrals — " +
        "counting from the prompt comment blob, which may undercount",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return priorTimeDeferrals(options.fallbackComments);
  }
}

/** Injectable dependencies for {@link deferIssueUntil} (testing). */
export interface DeferIssueUntilDeps {
  /** Override the claim-release helper. Defaults to {@link releaseClaim}. */
  releaseClaim?: typeof defaultReleaseClaim;
}

/** Options accepted by {@link deferIssueUntil}. */
export interface DeferIssueUntilOptions {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  githubUser: string;
  request: TimeDeferralRequest;
  /** How many times this issue has already been time-deferred. */
  priorCount: number;
  logger: Logger;
  deps?: DeferIssueUntilDeps;
  /**
   * The branch a committed run already pushed (Issue #3088). When set, the
   * comment names it and the outcome phase is `declared_handoff`.
   */
  committedBranch?: string;
}

/** What {@link deferIssueUntil} did. */
export interface DeferIssueUntilResult {
  outcome: RunOutcome;
  /** `true` when the `Deferred until` line was written to the body. */
  recorded: boolean;
}

/** The public comment parking the issue until `request.until`. */
function buildDeferralComment(
  request: TimeDeferralRequest,
  priorCount: number,
  committedBranch?: string,
): string {
  const reason = redactSecrets(neutraliseAgentMarkers(request.reason).text);
  const deferralNumber = priorCount + 1;
  const lead = committedBranch
    ? `This run committed work on \`${committedBranch}\` and reported the ` +
      `data it needs is not there yet, `
    : `No code changes: this run reported the data it needs is not there yet, `;
  return `## Deferred until ${request.until}\n\n` +
    lead +
    `so the issue stays open and keeps its discovery label. The worker ` +
    `skips this issue until ${request.until} and then re-runs it ` +
    `automatically — no human action is needed yet.\n\n` +
    `**Reason given by the run:**\n\n` +
    `${reason.split("\n").map((l) => `> ${l}`).join("\n")}\n\n` +
    `Deferral ${deferralNumber} of ${MAX_TIME_DEFERRALS}. Past that limit, ` +
    `this issue is handed to a human instead of deferred again.\n\n` +
    `${buildTimeDeferralRecordMarker(request.until)}`;
}

/**
 * Park a `work-on` issue until `request.until` instead of escalating it.
 *
 * Every GitHub step is best-effort but never silently swallowed: a failure
 * is logged loudly with `logger.error`, and `recorded` says whether the body
 * actually carries the `Deferred until` line the discovery gate reads.
 */
export async function deferIssueUntil(
  options: DeferIssueUntilOptions,
): Promise<DeferIssueUntilResult> {
  const {
    ghClient,
    repo,
    issueNumber,
    githubUser,
    request,
    priorCount,
    logger,
    deps,
    committedBranch,
  } = options;
  const releaseClaim = deps?.releaseClaim ?? defaultReleaseClaim;

  try {
    await ghClient.postComment(
      repo,
      issueNumber,
      buildDeferralComment(request, priorCount, committedBranch),
    );
  } catch (err) {
    logger.error("Failed to post the time-deferral comment", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let recorded = false;
  try {
    const issue = await ghClient.getIssue(repo, issueNumber);
    const body = issue.body ?? "";
    await ghClient.editIssue(repo, issueNumber, {
      body: upsertWorkerRecordLine(
        body,
        buildTimeDeferralLine(request.until),
        { replaces: /^Deferred until / },
      ),
    });
    recorded = true;
  } catch (err) {
    logger.error(
      "Failed to record 'Deferred until' in the issue body — discovery " +
        "will not skip this issue until the time elapses",
      {
        repo,
        issueNumber,
        until: request.until,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  const outcome = expectedNoPrOutcome(
    committedBranch ? "declared_handoff" : "handle_no_changes",
    `deferred until ${request.until}`,
  );
  await releaseClaim(ghClient, repo, issueNumber, githubUser, logger, {
    outcome,
  });

  return { outcome, recorded };
}

/** The public comment when the deferral limit is reached and a human takes over. */
export function buildDeferralExhaustedComment(
  history: string[],
  request: TimeDeferralRequest,
): string {
  const reason = redactSecrets(neutraliseAgentMarkers(request.reason).text);
  const list = history.map((until) => `- ${until}`).join("\n");
  return `## Deferral limit reached\n\n` +
    `This issue has been deferred ${history.length} time` +
    `${history.length === 1 ? "" : "s"} waiting for data that still is not ` +
    `there:\n\n${list}\n\n` +
    `**Latest reason given by the run:**\n\n` +
    `${reason.split("\n").map((l) => `> ${l}`).join("\n")}\n\n` +
    `Rather than deferring again, this is now handed to a human — it may be ` +
    `worth checking whether the data source this issue depends on will ever ` +
    `produce data.`;
}
