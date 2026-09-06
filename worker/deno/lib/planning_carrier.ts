/**
 * Carrier sub-issue safety net for zero-sub-issue planning closes (Issue #2995).
 *
 * Part of #2993. A planning run can end with **zero** sub-issues. When that
 * happens because the work was genuinely nothing-to-do (invalid / duplicate /
 * already implemented) closing the parent is correct. But when real work
 * remained — the issue was simply small enough that breaking it up added no
 * value — closing the parent with no sub-issue and no PR silently loses the
 * work (the bug in #2993).
 *
 * The prompt path (`prompts/planning_critique/`, Issue #2994) instructs Claude
 * to create exactly one carrier sub-issue in that case before closing the
 * parent inline. This module is the **worker-side safety net** for the same
 * rule: it guarantees a carrier even when the prompt path did not run (a retry
 * or crash-recovery close) or Claude bypassed it. It mirrors the prompt's
 * carrier label set and nothing-to-do signal so the two layers stay consistent.
 *
 * Gating (mirrors the prompt's two cases):
 *   - 1+ sub-issues already exist → no-op (a carrier would duplicate work).
 *   - The parent carries an explicit nothing-to-do signal → no-op.
 *   - Otherwise (zero sub-issues, real work) → create and link exactly one
 *     carrier, labelled for pickup with `Part of #<parent>`.
 *
 * Idempotent and best-effort: the carrier is linked via GitHub's native
 * `sub_issues` relationship so a re-run sees it as an existing sub-issue and
 * skips. Any failure is logged and swallowed — it must never abort planning
 * closure, consistent with the sibling helpers (`maybeCreatePlanningMilestone`,
 * `applyDegradedModelLabel`, `stripReservedLabelsFromIssues`).
 *
 * Australian English spelling used throughout.
 */

import { runGhCommand } from "./github.ts";
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import type { Logger } from "../types.ts";

/**
 * Descriptive label applied to a carrier sub-issue.
 *
 * Matches the prompt counterpart (`prompts/planning_critique/prompt.md`, Issue
 * #2994), which labels the carrier `enhancement`. A reserved workflow label
 * such as `work-on` cannot be used: the worker is not on the trusted-author
 * allowlist, so `label_security` (Issue #1344) strips any reserved label it
 * applies. The descriptive label is enough — the new-work scan claims the
 * carrier on the strength of it.
 */
export const CARRIER_SUB_ISSUE_LABEL = "enhancement";

/** Maximum carrier title length before truncation. */
export const MAX_CARRIER_TITLE_LENGTH = 200;

/**
 * Descriptive labels that, when present on the parent, mark a genuine
 * nothing-to-do close (mirrors the prompt's `invalid` / `duplicate` /
 * `wontfix` carve-out).
 */
const NOTHING_TO_DO_LABELS: readonly string[] = [
  "invalid",
  "duplicate",
  "wontfix",
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MaybeCreateCarrierOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Parent planning issue number. */
  parentIssueNumber: number;
  /** Parent planning issue title — used to phrase the carrier title. */
  parentIssueTitle: string;
  /**
   * Sub-issue numbers resolved for this run (text-extracted ∪ native). When
   * non-empty the helper is a no-op.
   */
  subIssueNumbers: number[];
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Fleet identity for the nothing-to-do comment author check (Issue #1244).
   * Omitted means "read the configured fleet identity" from `CONFIG_PATH` /
   * `GITHUB_USER`.
   */
  authorOptions?: AlertDedupAuthorOptions;
  /** Logger for non-fatal warnings. */
  logger: Logger;
}

export interface CarrierOutcome {
  /** True when a carrier sub-issue was created. */
  created: boolean;
  /** URL of the created carrier, when `created` is true. */
  carrierUrl?: string;
  /** Number of the created carrier, when `created` is true. */
  carrierNumber?: number;
  /** True when the carrier was natively linked to the parent. */
  linked?: boolean;
  /** Reason the helper was a no-op, when `created` is false. */
  skippedReason?: "has-sub-issues" | "nothing-to-do";
}

// ---------------------------------------------------------------------------
// Nothing-to-do signal
// ---------------------------------------------------------------------------

/**
 * Pure predicate: does the parent carry an explicit nothing-to-do signal?
 *
 * The signal — agreed with the prompt counterpart (Issue #2994) — is either:
 *   - a descriptive `invalid` / `duplicate` / `wontfix` label, or
 *   - a line of the form `Nothing to do — <reason>` in the issue body or any
 *     comment.
 *
 * Either is sufficient (a superset of the prompt's "both" requirement) so a
 * genuine nothing-to-do close is recognised even when Claude phrased only one
 * half of the signal — erring towards *not* creating a spurious carrier when
 * the intent was clearly nothing-to-do.
 *
 * @param labels - Parent issue label names.
 * @param texts - Issue body plus comment bodies to scan for the marker line.
 */
export function hasNothingToDoSignal(
  labels: string[],
  texts: string[],
): boolean {
  const lowered = labels.map((l) => l.trim().toLowerCase());
  if (NOTHING_TO_DO_LABELS.some((l) => lowered.includes(l))) return true;

  // "Nothing to do" followed by an em dash / en dash / hyphen / colon
  // separator — anchored case-insensitively, multiline.
  const marker = /nothing\s+to\s+do\s*[—–\-:]/i;
  return texts.some((t) => typeof t === "string" && marker.test(t));
}

/**
 * Project the comment array of `gh issue view --json comments` onto
 * `{ author, body }` rows (Issue #1244).
 *
 * `gh issue view` renders the author as a `{ login }` object; the worker's own
 * `GitHubComment` renders it as a bare login. Both are accepted so the shape a
 * caller's runner returns cannot silently drop every author and, with it, every
 * comment.
 */
function commentRows(
  value: unknown,
): Array<{ author: string | null; body: string }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ author: string | null; body: string }> = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.body !== "string") continue;
    const author = record.author;
    const login = typeof author === "string"
      ? author
      : author !== null && typeof author === "object" &&
          typeof (author as Record<string, unknown>).login === "string"
      ? (author as Record<string, unknown>).login as string
      : null;
    rows.push({ author: login, body: record.body });
  }
  return rows;
}

/**
 * What an unattributable nothing-to-do comment costs, in this site's own words.
 */
const NOTHING_TO_DO_UNVERIFIED_OUTCOME =
  "no comment counts as a nothing-to-do signal and the carrier sub-issue is " +
  "created. A carrier a human closes in a moment is recoverable; work " +
  "dropped because a stranger wrote “Nothing to do” is not";

/**
 * Fetch the parent issue's labels, body, and comments and decide whether it
 * carries a nothing-to-do signal. Best-effort: on any error the result is
 * `false` (no signal) so the default — create a carrier — applies, consistent
 * with "never close a zero-sub-issue parent with no carrier when real work
 * remains".
 *
 * **Comments are author-verified (Issue #1244).** A comment thread is writable
 * by any account, and this signal *disables* the safety net, so only comments
 * a fleet account wrote are scanned for the marker; the rest — and every
 * comment when the fleet identity cannot be resolved — are discarded and the
 * carrier is created. The parent **body** is still scanned unfiltered: it is
 * the artefact the planning run is planning, and its author is the person
 * asking for the work, not a third party commenting on it. The
 * `invalid` / `duplicate` / `wontfix` labels need triage permission, so they
 * are already authenticated evidence.
 *
 * @param repo - Target repository in `owner/repo` form
 * @param parentIssueNumber - Parent planning issue number
 * @param gh - Injectable gh runner
 * @param authorOptions - Fleet identity for the comment author check
 * @param log - Sink for the discard / unresolved-set warnings
 */
export async function fetchNothingToDoSignal(
  repo: string,
  parentIssueNumber: number,
  gh: (args: string[]) => Promise<string>,
  authorOptions: AlertDedupAuthorOptions = {},
  log: (message: string) => void = (message) => console.error(message),
): Promise<boolean> {
  let raw: string;
  try {
    raw = await gh([
      "issue",
      "view",
      String(parentIssueNumber),
      "--repo",
      repo,
      "--json",
      "labels,body,comments",
    ]);
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const r = parsed as Record<string, unknown>;

  const labels: string[] = Array.isArray(r.labels)
    ? r.labels
      .map((l) =>
        l && typeof l === "object" &&
          typeof (l as Record<string, unknown>).name === "string"
          ? ((l as Record<string, unknown>).name as string)
          : ""
      )
      .filter((n) => n !== "")
    : [];

  const texts: string[] = [];
  if (typeof r.body === "string") texts.push(r.body);

  // Only the marker-carrying comments are put to the author check, so the
  // discard log names genuine signals from outside the fleet rather than
  // every comment on the thread.
  const markerComments = commentRows(r.comments).filter((row) =>
    hasNothingToDoSignal([], [row.body])
  );
  const fleetComments = await selectFleetAuthoredComments(
    markerComments,
    `planning nothing-to-do signal ${repo}#${parentIssueNumber}`,
    authorOptions,
    log,
    NOTHING_TO_DO_UNVERIFIED_OUTCOME,
  );
  texts.push(...fleetComments.map((row) => row.body));

  return hasNothingToDoSignal(labels, texts);
}

// ---------------------------------------------------------------------------
// Carrier title / body
// ---------------------------------------------------------------------------

/** Build the carrier sub-issue title, truncated to a safe length. */
export function buildCarrierTitle(
  parentIssueNumber: number,
  parentIssueTitle: string,
): string {
  const trimmed = parentIssueTitle.trim();
  const raw = trimmed
    ? `Implement remaining work from #${parentIssueNumber}: ${trimmed}`
    : `Implement remaining work from #${parentIssueNumber}`;
  if (raw.length <= MAX_CARRIER_TITLE_LENGTH) return raw;
  return raw.slice(0, MAX_CARRIER_TITLE_LENGTH - 1).trimEnd() + "…";
}

/** Build the carrier sub-issue body, including the `Part of #<parent>` link. */
export function buildCarrierBody(parentIssueNumber: number): string {
  return [
    `Carrier sub-issue created by the planning safety net (Issue #2995).`,
    ``,
    `The planning run on #${parentIssueNumber} concluded the work was small ` +
    `enough to need no further breakdown, but real work remains and no ` +
    `implementing PR was raised. Implement the remaining work described in ` +
    `the parent issue here.`,
    ``,
    `### Acceptance criteria`,
    `- The work described in #${parentIssueNumber} is implemented and verified.`,
    ``,
    `Part of #${parentIssueNumber}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// maybeCreateCarrierSubIssue
// ---------------------------------------------------------------------------

/**
 * Ensure exactly one carrier sub-issue exists when a planning run ends with
 * zero sub-issues and the close is not an explicit nothing-to-do close.
 *
 * See the module docstring for the gating rules. Best-effort throughout: any
 * failure is logged and swallowed so planning closure is never blocked.
 */
export async function maybeCreateCarrierSubIssue(
  opts: MaybeCreateCarrierOptions,
): Promise<CarrierOutcome> {
  const { repo, parentIssueNumber, parentIssueTitle, subIssueNumbers, logger } =
    opts;
  const gh = opts.ghCommandFn ?? runGhCommand;

  // Gate 1: the run already produced 1+ sub-issues — a carrier would duplicate
  // work. A previously-created carrier is a native sub-issue, so this gate also
  // gives idempotency across re-runs.
  if ([...new Set(subIssueNumbers)].length > 0) {
    return { created: false, skippedReason: "has-sub-issues" };
  }

  // Gate 2: genuine nothing-to-do close — no carrier. Only a fleet-authored
  // comment (or a triage-permission label) is evidence of that (Issue #1244).
  const signalled = await fetchNothingToDoSignal(
    repo,
    parentIssueNumber,
    gh,
    opts.authorOptions ?? {},
    (message) => logger.warn(message),
  );
  if (signalled) {
    return { created: false, skippedReason: "nothing-to-do" };
  }

  // Create the carrier.
  let carrierUrl: string;
  let carrierNumber: number;
  try {
    const createOut = await gh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      buildCarrierTitle(parentIssueNumber, parentIssueTitle),
      "--body",
      buildCarrierBody(parentIssueNumber),
      "--label",
      CARRIER_SUB_ISSUE_LABEL,
    ]);
    const parsed = parseCarrierUrl(createOut, repo);
    if (parsed === null) {
      logger.warn("Carrier created but URL could not be parsed (non-fatal)", {
        repo,
        parentIssueNumber,
        output: createOut.slice(0, 200),
      });
      return { created: false };
    }
    carrierUrl = parsed.url;
    carrierNumber = parsed.number;
  } catch (err) {
    logger.warn("Failed to create carrier sub-issue (non-fatal)", {
      repo,
      parentIssueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return { created: false };
  }

  // Link the carrier to the parent via the native sub_issues relationship.
  // Best-effort: a link failure still leaves a labelled `Part of #N` carrier
  // that the new-work scan picks up, so the work is not lost — we just lose
  // the native idempotency guard for that case.
  const linked = await linkCarrierToParent(
    repo,
    parentIssueNumber,
    carrierNumber,
    gh,
    logger,
  );

  logger.info("Planning safety net created carrier sub-issue (Issue #2995)", {
    repo,
    parentIssueNumber,
    carrierNumber,
    linked,
  });

  return { created: true, carrierUrl, carrierNumber, linked };
}

/**
 * Link `carrierNumber` as a native sub-issue of `parentIssueNumber`.
 *
 * Uses the REST `POST /repos/{repo}/issues/{parent}/sub_issues` endpoint, which
 * takes the child's internal **id** (not its number). Returns true on success;
 * any failure is logged and swallowed (returns false).
 */
async function linkCarrierToParent(
  repo: string,
  parentIssueNumber: number,
  carrierNumber: number,
  gh: (args: string[]) => Promise<string>,
  logger: Logger,
): Promise<boolean> {
  try {
    const idRaw = await gh([
      "api",
      `repos/${repo}/issues/${carrierNumber}`,
      "--jq",
      ".id",
    ]);
    const subId = parseInt(idRaw.trim(), 10);
    if (!Number.isInteger(subId) || subId <= 0) {
      throw new Error(`malformed carrier id: ${idRaw.trim().slice(0, 80)}`);
    }
    await gh([
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${parentIssueNumber}/sub_issues`,
      "-F",
      `sub_issue_id=${subId}`,
    ]);
    return true;
  } catch (err) {
    logger.warn("Failed to link carrier sub-issue to parent (non-fatal)", {
      repo,
      parentIssueNumber,
      carrierNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Parse the issue URL and number from `gh issue create` output.
 *
 * `gh issue create` prints the created issue's URL (typically as the last
 * non-empty line). Returns null when no matching URL for `repo` is found.
 */
export function parseCarrierUrl(
  output: string,
  repo: string,
): { url: string; number: number } | null {
  // Static regex (no dynamic RegExp — avoids the ReDoS surface flagged by
  // semgrep detect-non-literal-regexp): match any GitHub issue URL, then
  // filter by the literal repo prefix with a plain string comparison.
  const expectedPrefix = `https://github.com/${repo}/issues/`;
  const pattern = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)/g;
  let match: RegExpExecArray | null;
  let last: { url: string; number: number } | null = null;
  while ((match = pattern.exec(output)) !== null) {
    if (!match[0].startsWith(expectedPrefix)) continue;
    last = { url: match[0], number: parseInt(match[1]!, 10) };
  }
  return last;
}
