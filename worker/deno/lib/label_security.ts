/**
 * Operational label security verification (Issue #1344).
 *
 * Verifies that operational labels (those affecting worker behaviour) were
 * added by trusted users. Extends the existing wasLabelAddedByAllowedAuthor()
 * pattern to cover all operational labels, not just work-on.
 *
 * Operational labels include: planning, question, needs-revision,
 * best-model, and needs-human. If any of these were added by an
 * untrusted user, they are ignored for processing decisions and a
 * [SECURITY] audit event is emitted.
 *
 * Issue #2031: `skip-clarification` retired from OPERATIONAL_LABEL_NAMES.
 * It remains in `DEPRECATED_LABELS` so existing repos get it deleted on
 * the next setup run.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { runGhCommand } from "./github.ts";

/**
 * Labels that affect worker behaviour and require trusted authorship.
 *
 * These labels change how the worker processes an issue:
 * - planning: triggers the planning phase
 * - question: triggers question answering phase
 * - needs-revision: triggers revision phase
 * - best-model: changes model selection (deprecated but still guarded)
 * - needs-human: worker-to-human escalation signal (Issue #1470, #2031).
 *   Applied by the worker itself to hand back an issue (clarification
 *   handoffs now also route here, replacing the retired
 *   `needs-clarification` label). If the worker user is passed via
 *   `workerUser`, the label is trusted when applied by that user. If applied
 *   by any other untrusted user, the timeline check strips it so it cannot be
 *   used to starve the worker.
 * - quorum: triggers the Quorum plan-off ahead of planning (Issue #4112).
 *   Three top-tier agent invocations per run, and the winning plan steers
 *   every downstream sub-issue, so the label is human-applied only — the
 *   worker's own attempt to add it is refused by `worker_label_guard.ts` and
 *   an untrusted actor's add is stripped here.
 * - refine-issue, failed, failed-once: block pickup in every discovery tier
 *   (see `filterAndSort` in `issue_filter.ts`) but were absent from this list
 *   until Issue #3648, so unlike the five above they were never trust-verified
 *   — an untrusted triage actor could park an issue indefinitely, the exact
 *   starvation the timeline check exists to prevent.
 */
export const OPERATIONAL_LABEL_NAMES: readonly string[] = [
  "planning",
  "question",
  "needs-revision",
  "best-model",
  "needs-human",
  "refine-issue",
  "failed",
  "failed-once",
  "quorum",
] as const;

/**
 * Worker-owned failure bookkeeping labels (Issue #3648).
 *
 * Applied by the worker's own failure path (`claim_issue.ts`) to drive the
 * consecutive-failure circuit breaker, so they must stay trusted when a fleet
 * worker set them — otherwise adding them to
 * {@link OPERATIONAL_LABEL_NAMES} would strip the worker's own failure marks
 * and a persistently failing issue would be re-picked forever.
 *
 * `refine-issue` is deliberately absent: it is a human/triage control, so an
 * untrusted actor's `refine-issue` is stripped like any other.
 */
const WORKER_FAILURE_LABELS: ReadonlySet<string> = new Set([
  "failed",
  "failed-once",
]);

/**
 * Blocking-only operational labels added by Issue #3648.
 *
 * These labels only ever *prevent* pickup — unlike `planning` / `question` /
 * `needs-revision`, none of them routes an issue into a privileged phase. That
 * inverts the safe default when authorship cannot be established: stripping a
 * permissive label fails closed, but stripping a blocking label fails **open**
 * — it hands a known-failing or under-refinement issue straight back to the
 * scan loop for another fully billed run.
 *
 * So for these three, an unverifiable adder (missing `labeled` event, null
 * actor, or an unreadable timeline) leaves the label in place. They are
 * stripped only on positive evidence: a named adder who is not trusted. That
 * is still the whole of the starvation threat the check exists to close — an
 * untrusted triage actor parking an issue is, by definition, a named actor.
 */
const BLOCKING_ONLY_LABELS: ReadonlySet<string> = new Set([
  "failed",
  "failed-once",
  "refine-issue",
]);

/** Whether an unverifiable adder should leave `label` in place. */
function keepWhenUnverifiable(label: string): boolean {
  return BLOCKING_ONLY_LABELS.has(label.toLowerCase());
}

/**
 * Lower-cased view of {@link OPERATIONAL_LABEL_NAMES} for case-insensitive
 * membership checks (Issue #3088).
 *
 * GitHub treats label names case-insensitively, and the dispatch gate
 * (`requiresLabelAdderTrust` in `operational_dispatch_labels.ts`) already
 * lower-cases before comparing. The trust verification here must match the
 * same way, otherwise a non-lower-case canonical label (e.g. `Planning`) would
 * route into a privileged phase while skipping this author check.
 */
const OPERATIONAL_LABEL_NAMES_LOWER: ReadonlySet<string> = new Set(
  OPERATIONAL_LABEL_NAMES.map((label) => label.toLowerCase()),
);

/**
 * Return true if `label` is an operational label, comparing case-insensitively
 * (Issue #3088).
 */
export function isOperationalLabel(label: string): boolean {
  return OPERATIONAL_LABEL_NAMES_LOWER.has(label.toLowerCase());
}

/**
 * Timeline event for label authorship checks.
 */
interface TimelineLabelEvent {
  event: string;
  label?: { name: string };
  actor?: { login: string } | null;
}

/**
 * Result of operational label verification.
 */
export interface OperationalLabelResult {
  /** Operational labels that were added by trusted users. */
  trustedLabels: string[];
  /** Operational labels added by untrusted users, with the actor. */
  untrustedLabels: Array<{ label: string; addedBy: string }>;
}

/**
 * Verify which operational labels on an issue were added by trusted users.
 *
 * Fetches the full issue timeline (paginated to exhaustion, Issue #3165) and
 * checks all operational labels in a single pass, avoiding redundant API
 * calls. For each operational label present on the issue, checks whether the
 * genuinely most-recent user to add it is in the allowedAuthors list.
 *
 * Special case: `needs-human` applied by `workerUser` is always trusted —
 * it is the designated worker-to-human escalation signal (Issue #1951).
 *
 * Fleet-worker exclusion (Issue #3225): in a multi-account fleet, sibling
 * worker logins are required to appear in `allowedAuthors` (the PR-dedup
 * requirement — see `resolveFleetAuthors` / `fleet_pr_authors`). Left
 * unchecked, that lets a label a worker applied directly (bypassing the
 * `addLabelToIssue` allowlist) be honoured fleet-wide instead of stripped —
 * contradicting the documented backstop in `worker_label_guard.ts`. Any
 * login in `fleetWorkerLogins` (this host's own login plus siblings) is
 * therefore treated as untrusted for every operational label, retaining only
 * the deliberate `needs-human` self-escalation exception above.
 *
 * Emits [SECURITY] [UNTRUSTED_LABEL_CHANGE] audit events for any
 * operational labels added by untrusted users.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param issueLabels - Current labels on the issue
 * @param allowedAuthors - Authorised GitHub usernames
 * @param ghCommandFn - Optional gh command function for testing
 * @param workerUser - Optional worker GitHub username; trusts `needs-human` when applied by this user
 * @param fleetWorkerLogins - Fleet worker logins (own host + siblings) excluded from operational-label trust (Issue #3225)
 * @returns Verification result with trusted and untrusted labels
 */
export async function verifyOperationalLabels(
  repo: string,
  issueNumber: number,
  issueLabels: string[],
  allowedAuthors: string[],
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  workerUser?: string,
  fleetWorkerLogins: string[] = [],
): Promise<OperationalLabelResult> {
  const result: OperationalLabelResult = {
    trustedLabels: [],
    untrustedLabels: [],
  };

  // Find which operational labels are present on this issue
  const operationalPresent = issueLabels.filter((label) =>
    isOperationalLabel(label)
  );

  if (operationalPresent.length === 0) {
    return result;
  }

  // Fetch the full timeline via pagination (Issue #3165), then check every
  // operational label in a single pass (cache-friendly).
  //
  // The timeline API returns events oldest-first, capped at 100 per page (the
  // API maximum). Issue #3089 raised the page size from 30 to 100 but still
  // read only a single page, so on a busy issue (>100 timeline events) the
  // genuinely most-recent operational-label add can fall beyond page 1 and be
  // missed. An untrusted actor with triage permission could inflate the
  // timeline past 100 events, then re-add a previously-trusted-then-removed
  // operational label; reading only page 1 would honour the stale trusted add.
  // Paginate to exhaustion so the last `labeled` event per label is always the
  // true most-recent one.
  const PER_PAGE = 100;
  // Hard cap (10,000 events) — fail closed beyond it rather than risk reading a
  // stale trusted add on a timeline we could not fully enumerate.
  const MAX_TIMELINE_PAGES = 100;
  let timeline: TimelineLabelEvent[];
  try {
    timeline = [];
    for (let page = 1; page <= MAX_TIMELINE_PAGES; page++) {
      const timelineJson = await ghCommandFn([
        "api",
        `repos/${repo}/issues/${issueNumber}/timeline?per_page=${PER_PAGE}&page=${page}`,
      ]);
      const pageEvents = JSON.parse(timelineJson) as TimelineLabelEvent[];
      if (!Array.isArray(pageEvents)) {
        throw new Error("timeline page was not an array");
      }
      timeline.push(...pageEvents);
      if (pageEvents.length < PER_PAGE) {
        // A short (or empty) page is the last page — stop paginating.
        break;
      }
      if (page === MAX_TIMELINE_PAGES) {
        // A full page at the cap means more events may exist beyond what we can
        // read. Fail closed rather than honour a possibly-stale trusted add.
        throw new Error(
          `timeline exceeded ${MAX_TIMELINE_PAGES} pages — failing closed`,
        );
      }
    }
  } catch {
    // API failure — fail closed: without the timeline we cannot determine
    // authorship, so treat every operational label present as untrusted so
    // filterTrustedLabels() strips them. Returning an empty result here would
    // fail open (nothing stripped, every operational label honoured).
    for (const label of operationalPresent) {
      // Issue #3648: for a blocking-only label, stripping is the fail-OPEN
      // direction — keep it instead. See {@link BLOCKING_ONLY_LABELS}.
      if (keepWhenUnverifiable(label)) {
        result.trustedLabels.push(label);
        continue;
      }
      result.untrustedLabels.push({ label, addedBy: "unknown" });
      console.error(
        `[SECURITY] [UNTRUSTED_LABEL_CHANGE] Label '${label}' on ` +
          `${repo}#${issueNumber} could not be verified (timeline read failed) — ignoring`,
      );
    }
    return result;
  }

  // Check each operational label against the timeline
  for (const label of operationalPresent) {
    const labelEvents = timeline.filter(
      (e) => e.event === "labeled" && e.label?.name === label,
    );
    const lastEvent = labelEvents[labelEvents.length - 1];
    const adder = lastEvent?.actor?.login ?? null;

    if (adder !== null) {
      const adderLower = adder.toLowerCase();
      const labelLower = label.toLowerCase();
      const isSelf = workerUser !== undefined &&
        workerUser.toLowerCase() === adderLower;
      // Issue #3225: fleet worker logins (own host + siblings) are required in
      // allowedAuthors for PR-dedup, but must NOT be trusted to apply
      // operational labels — a label a worker applied directly (outside the
      // addLabelToIssue allowlist) has to be stripped by this backstop.
      const isFleetWorker = fleetWorkerLogins.some(
        (a) => a.toLowerCase() === adderLower,
      );
      // `needs-human` applied by this worker is always trusted — it is the
      // worker's designated escalation signal, not a human-to-worker control.
      // Issue #3088: case-insensitive so a non-lower-case canonical label
      // (e.g. `Needs-Human`) still matches the worker-trust special case.
      const isWorkerSelfEscalation = labelLower === "needs-human" && isSelf;
      // Issue #3648: `failed` / `failed-once` are worker bookkeeping that
      // drives the consecutive-failure circuit breaker (`claim_issue.ts`).
      // Any fleet worker — this host or a sibling — may legitimately have set
      // them, so they stay trusted; otherwise adding them to the operational
      // list would strip the worker's own failure marks and a persistently
      // failing issue would be re-picked forever.
      const isWorkerFailureMark = WORKER_FAILURE_LABELS.has(labelLower) &&
        (isSelf || isFleetWorker);
      const isTrusted = isWorkerSelfEscalation || isWorkerFailureMark ||
        (!isFleetWorker &&
          allowedAuthors.some((a) => a.toLowerCase() === adderLower));

      if (isTrusted) {
        result.trustedLabels.push(label);
      } else {
        result.untrustedLabels.push({ label, addedBy: adder });
        console.error(
          `[SECURITY] [UNTRUSTED_LABEL_CHANGE] Label '${label}' on ` +
            `${repo}#${issueNumber} was added by untrusted user '${adder}' — ignoring`,
        );
      }
    } else if (keepWhenUnverifiable(label)) {
      // Issue #3648: stripping a blocking-only label with no verifiable author
      // would fail OPEN — it hands the issue back for another billed run. Keep
      // it; only a named untrusted adder strips it.
      result.trustedLabels.push(label);
    } else {
      // No actor found (missing timeline event or null actor) — treat as untrusted
      result.untrustedLabels.push({ label, addedBy: "unknown" });
      console.error(
        `[SECURITY] [UNTRUSTED_LABEL_CHANGE] Label '${label}' on ` +
          `${repo}#${issueNumber} has no verifiable author — ignoring`,
      );
    }
  }

  return result;
}

/**
 * Filter an issue's labels to remove untrusted operational labels.
 *
 * Non-operational labels are always kept. Operational labels are only kept
 * if they appear in the trustedLabels list from verification.
 *
 * @param labels - Current labels on the issue
 * @param verificationResult - Result from verifyOperationalLabels()
 * @returns Labels with untrusted operational labels removed
 */
export function filterTrustedLabels(
  labels: string[],
  verificationResult: OperationalLabelResult,
): string[] {
  const untrustedSet = new Set(
    verificationResult.untrustedLabels.map((u) => u.label),
  );

  return labels.filter((label) => !untrustedSet.has(label));
}
