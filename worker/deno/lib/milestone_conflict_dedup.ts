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
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

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
  log: (message: string) => void;
}

/**
 * Whether the tracking issue already carries this conflict's escalation.
 *
 * Fails **open**: a thread that cannot be read or parsed answers `false`, so
 * the escalation still goes out. Losing a "only a human can settle this"
 * report to a transient API fault would be worse than a duplicate comment,
 * which is what the caller did on every cycle before this existed. The
 * failure is never swallowed — it is named in the log.
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
    const parsed = JSON.parse(raw) as { comments?: { body?: unknown }[] };
    if (!Array.isArray(parsed?.comments)) {
      throw new Error("gh issue view returned no `comments` array");
    }
    return parsed.comments.some((comment) =>
      typeof comment?.body === "string" && comment.body.includes(marker)
    );
  } catch (err) {
    log(
      `WARNING: Could not tell whether the milestone sync conflict for ` +
        `${repo}#${issueNumber} was already escalated, so it is reported ` +
        `again: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
