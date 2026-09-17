/**
 * Identity of an unresolvable milestone-sync conflict, for escalation dedup
 * (Issue #1786).
 *
 * `syncMilestoneBranches` escalates a `main` → `milestone/**` merge that no
 * automatic rule can resolve by commenting the prepared analysis on the
 * milestone's tracking issue, and remembers what it reported so the same
 * conflict is not reported every cycle. It remembered the **default branch's
 * tip** (Issue #1559). On a busy repository that tip moves every few minutes,
 * so every cycle looked like a new conflict: `stSoftwareAU/VibeCoder#1653`
 * collected four copies of one analysis in 36 minutes while
 * `stSoftwareAU/VibeCoder#1741` stayed conflicting.
 *
 * A conflict is identified here by what actually differs between the two
 * sides — the milestone branch's tip and the set of conflicted paths — so the
 * default branch moving on its own is not a new conflict, while a conflict
 * over a different file set, or against a milestone branch that has itself
 * moved, still is.
 *
 * The same key is written into the comment as a hidden marker, so a second
 * worker host, which keeps its own streak file, can see that the escalation
 * has already gone out rather than posting it again.
 *
 * **A marker is only evidence when a fleet account wrote it (Issue #2231).**
 * The marker text is fixed and the milestone branch it names is public on
 * every milestone PR, so anyone who can comment on a public repository can
 * plant one. Every marker match is therefore filtered through
 * `alert_dedup_authors.ts` before it decides anything — the same control
 * `milestone_branch_self_heal.ts` already applies to its own marker searches.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  type AlertDedupAuthorOptions,
  parseIssueViewCommentRows,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

/** What makes one unresolvable conflict distinct from another. */
export interface ConflictIdentity {
  /** The milestone branch the default branch was being merged into. */
  milestoneBranch: string;
  /** The milestone branch's tip at the time of the merge, when it is known. */
  milestoneSha?: string;
  /** Every conflicted path, in any order and with any duplicates. */
  files: readonly string[];
}

/** Length of the branch tip carried in the key — enough to be unambiguous. */
const SHA_PREFIX_LENGTH = 12;

/**
 * Strip the characters that would end the HTML comment the key is written
 * into, or the attribute it sits in. Repository paths never contain them;
 * stripping is defence in depth rather than an expected case.
 */
function sanitise(text: string): string {
  return text.replace(/["<>]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * A stable key for one unresolvable conflict.
 *
 * Deterministic across hosts and runs: the same branch, the same tip and the
 * same set of conflicted paths always produce the same key, whatever order
 * the paths arrive in and however often one repeats.
 */
export function conflictEscalationKey(identity: ConflictIdentity): string {
  const branch = sanitise(identity.milestoneBranch);
  const sha = sanitise(identity.milestoneSha ?? "").slice(
    0,
    SHA_PREFIX_LENGTH,
  );
  const files = [...new Set(identity.files.map(sanitise).filter(Boolean))]
    .sort();
  return `${branch}@${sha || "unknown"}:${files.join(",")}`;
}

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

/** Hidden marker identifying an escalation for a given conflict key. */
export function conflictEscalationMarker(key: string): string {
  return `<!-- vibe-milestone-sync-conflict key="${sanitise(key)}" -->`;
}

/**
 * The leading part every marker for `milestoneBranch` shares, whatever the
 * SHA and files (Issue #2214): a thread that contains it carried a sync
 * escalation for this branch at some point.
 */
export function conflictEscalationMarkerPrefix(
  milestoneBranch: string,
): string {
  return `<!-- vibe-milestone-sync-conflict key="${sanitise(milestoneBranch)}@`;
}

// ---------------------------------------------------------------------------
// Cross-host check
// ---------------------------------------------------------------------------

/** Inputs for {@link hasConflictEscalationComment}. */
export interface ConflictEscalationCommentQuery {
  repo: string;
  issueNumber: number;
  /** The marker produced by {@link conflictEscalationMarker}. */
  marker: string;
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * Fleet identity for the marker's author check (Issue #2231). Omitted
   * (production) means "read the configured fleet identity"; a test states
   * the fleet instead of writing a config file.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  log: (message: string) => void;
}

/** What an unattributable marker costs here, in this site's own words. */
const UNVERIFIED_ESCALATION_OUTCOME =
  "no comment counts as an escalation already posted and the analysis is " +
  "reported again. A duplicate report is noise a reader skips; a suppressed " +
  "one leaves a conflict only a human can settle unreported";

/**
 * Whether the tracking issue already carries this conflict's escalation.
 *
 * Only a **fleet-authored** marker counts (Issue #2231): the marker is fixed
 * text anybody who can comment may write, and a match suppresses the report,
 * so an unattributed one would let an outsider silence an escalation.
 *
 * Fails **open**: a thread that cannot be read or parsed, or a marker whose
 * author cannot be attributed, answers `false`, so the escalation still goes
 * out. Losing a "only a human can settle this" report to a transient API
 * fault would be worse than a duplicate comment, which is what the caller did
 * on every cycle before this existed. The failure is never swallowed — it is
 * named in the log.
 */
export async function hasConflictEscalationComment(
  query: ConflictEscalationCommentQuery,
): Promise<boolean> {
  const { repo, issueNumber, marker, ghCommandFn, log } = query;
  try {
    const raw = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "comments",
    ]);
    const parsed = JSON.parse(raw) as { comments?: unknown };
    if (!Array.isArray(parsed?.comments)) {
      throw new Error("gh issue view returned no `comments` array");
    }
    const matches = parseIssueViewCommentRows(parsed.comments).filter(
      (comment) => comment.body.includes(marker),
    );
    const fleetMatches = await selectFleetAuthoredComments(
      matches,
      `milestone-sync-conflict ${repo}#${issueNumber}`,
      query.dedupAuthors ?? {},
      log,
      UNVERIFIED_ESCALATION_OUTCOME,
    );
    return fleetMatches.length > 0;
  } catch (err) {
    log(
      `WARNING: Could not tell whether the milestone sync conflict for ` +
        `${repo}#${issueNumber} was already escalated, so it is reported ` +
        `again: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
