/**
 * Fail-loud enable/authorise issue filer for an unavailable alert feed
 * (Issue #3396, part of #3386 / #3394).
 *
 * When a monitored repo's alert feed reports `feed-unavailable` — a Dependabot
 * 404 (no access / disabled) or a code-scanning 403 ("Code Security must be
 * enabled for this repository") — the alert-feed idle task must **not** silently
 * skip it (fail-loud, Issue #3234). Instead it files a single, actionable
 * one-off issue asking a human to enable/authorise that feed, then leaves it
 * open until the human acts.
 *
 * This module owns exactly that decision and its dedup/allowlist gating; it
 * consumes the `feed-unavailable` outcome produced by the sibling fetchers
 * (`dependabot_alerts.ts` #3392, `code_scanning_alerts.ts` #3393) and is
 * consumed by the alert-feed template (#3394).
 *
 * Three guarantees (the #3396 acceptance):
 *
 *   1. **Fail-loud** — a `feed-unavailable` outcome for an allowlisted repo
 *      files exactly one enable-feed issue (never a silent skip, never a silent
 *      zero-findings pass).
 *   2. **Dedup** — one open enable-feed issue per repo+feed. The stable
 *      `<!-- finding-id: ENABLE-FEED-<feed> -->` body marker keys the existing
 *      `fileFindingOnce` dedup, so a second run with the issue still open files
 *      nothing.
 *   3. **Allowlist** — a repo absent from the Vibe Coder's own `.config.json`
 *      `repos` list is another instance's scope (e.g. the TitlePage repos): a
 *      404/403 there is expected and must generate no noise, so nothing is
 *      filed.
 *
 * The `reason` carried on the outcome is the worker's own `gh` stderr, surfaced
 * verbatim into the issue body as evidence — it is worker output, not untrusted
 * repo content.
 *
 * The `gh` runner is dependency-injected so tests never hit the network,
 * matching the DI convention across `idle_task_templates/`, `alert_fingerprint.ts`,
 * and the sibling fetchers.
 *
 * Australian English throughout (behaviour, authorise, organisation).
 */

import {
  fileFindingOnce,
  type FindingIdDedupOptions,
} from "../idle_task_snapshot.ts";

/** The two alert feeds the idle task reads (Issues #3392 / #3393). */
export type AlertFeedName = "dependabot" | "code-scanning";

/**
 * The minimal shape of a `feed-unavailable` outcome, shared by both fetchers'
 * discriminated results. Only the two fields the enable-feed issue needs are
 * carried — the caller passes the `status`/`reason` from its
 * `{ kind: "feed-unavailable"; status; reason }` result.
 */
export interface FeedUnavailable {
  /** HTTP status that made the feed unavailable. */
  status: 403 | 404;
  /** The `gh` failure message, surfaced verbatim as evidence. */
  reason: string;
}

/** The descriptive label carried by every enable-feed issue. */
export const ENABLE_FEED_LABEL = "enable-feed";

/**
 * The stable finding id for an enable-feed issue, keyed only on the feed.
 *
 * The dedup look-up (`fileFindingOnce`) is already `--repo`-scoped, so the id
 * needs to encode only the feed to guarantee **one open enable-feed issue per
 * repo+feed**. Both ids satisfy the `finding-id` grammar (`[A-Za-z0-9-]+`), so
 * they round-trip through the existing marker machinery unchanged.
 */
export function enableFeedFindingId(feed: AlertFeedName): string {
  return `ENABLE-FEED-${feed}`;
}

/** Human-readable feed name for issue titles and prose. */
function feedDisplayName(feed: AlertFeedName): string {
  return feed === "dependabot"
    ? "Dependabot alerts"
    : "Code Security (code-scanning) alerts";
}

/**
 * Normalise a repo slug for allowlist comparison. GitHub `owner/repo` slugs are
 * case-insensitive, so both sides are trimmed and lower-cased.
 */
function normaliseSlug(repo: string): string {
  return (repo ?? "").trim().toLowerCase();
}

/**
 * Is `repo` in the Vibe Coder's own monitored allowlist (`.config.json`
 * `repos`)? Case-insensitive, whitespace-tolerant. A repo outside the allowlist
 * belongs to another instance's scope and must never have an enable-feed issue
 * filed against it (avoids the TitlePage 404 noise).
 *
 * Pure helper (extracted for unit testing).
 */
export function isRepoAllowlisted(
  repo: string,
  allowlist: readonly string[],
): boolean {
  const target = normaliseSlug(repo);
  if (target === "") return false;
  return allowlist.some((r) => normaliseSlug(r) === target);
}

/** The title of the enable-feed issue for `repo`+`feed`. */
export function buildEnableFeedTitle(
  repo: string,
  feed: AlertFeedName,
): string {
  return `Enable ${feedDisplayName(feed)} for ${repo}`;
}

/**
 * Feed-specific remediation steps rendered into the issue body.
 *
 * Kept per-feed because "enable Dependabot" and "enable Code Security" are two
 * different GitHub settings with different failure statuses.
 */
function remediationSteps(feed: AlertFeedName): string {
  if (feed === "dependabot") {
    return [
      "1. Open the repository's **Settings → Advanced Security** " +
      "(formerly *Code security and analysis*).",
      "2. Enable **Dependabot alerts** (and, if desired, Dependabot security " +
      "updates).",
      "3. If alerts are already enabled, confirm the Vibe Coder's token has " +
      "read access to Dependabot alerts for this repository " +
      "(`security_events` / repo `read` scope).",
    ].join("\n");
  }
  return [
    "1. Open the repository's **Settings → Advanced Security** " +
    "(formerly *Code security and analysis*).",
    "2. Enable **Code scanning** (GitHub Advanced Security / Code Security). " +
    "The 403 response means Code Security is not yet enabled for this " +
    "repository.",
    "3. If code scanning is already enabled, confirm the Vibe Coder's token " +
    "has read access to code-scanning alerts (`security_events` scope).",
  ].join("\n");
}

/**
 * Build the enable-feed issue body, embedding the stable `finding-id` marker so
 * a subsequent run dedups against the still-open issue.
 *
 * The observed `status`/`reason` are surfaced verbatim as evidence (worker
 * `gh` output). An optional attribution `footer` is appended when supplied
 * (the idle-task convention) — the caller passes it through unchanged.
 */
export function buildEnableFeedBody(
  repo: string,
  feed: AlertFeedName,
  unavailable: FeedUnavailable,
  footer = "",
): string {
  const findingId = enableFeedFindingId(feed);
  const parts = [
    `The Vibe Coder could not read **${feedDisplayName(feed)}** for ` +
    `\`${repo}\` because the feed is unavailable (HTTP ${unavailable.status}).`,
    "",
    'This is **not** the same as "zero alerts": the feed could not be read ' +
    "at all, so any high/critical alerts it holds are going unmonitored. Per " +
    "the fail-loud policy (Issue #3234) this is surfaced as an actionable " +
    "issue rather than skipped silently.",
    "",
    "## Remediation",
    "",
    remediationSteps(feed),
    "",
    "Once the feed is available this issue can be closed; the alert-feed idle " +
    "task will then start filing one issue per new high/critical alert.",
    "",
    "## Observed response",
    "",
    "```",
    `HTTP ${unavailable.status}: ${unavailable.reason}`,
    "```",
    "",
    `<!-- finding-id: ${findingId} -->`,
  ];
  const body = parts.join("\n");
  return footer ? `${body}\n\n${footer}` : body;
}

/**
 * The outcome of {@link maybeFileEnableFeedIssue}. Every branch is explicit so
 * the caller (and its summary) can distinguish a filed issue, a deduped skip,
 * an out-of-allowlist skip, and a hard filing failure.
 */
export type EnableFeedIssueOutcome =
  | {
    /** Repo is outside the config allowlist — nothing filed (expected). */
    action: "not-allowlisted";
    repo: string;
    feed: AlertFeedName;
  }
  | {
    /** A new enable-feed issue was filed. */
    action: "filed";
    repo: string;
    feed: AlertFeedName;
    findingId: string;
    number: number;
  }
  | {
    /** An open enable-feed issue already existed — deduped, nothing filed. */
    action: "already-open";
    repo: string;
    feed: AlertFeedName;
    findingId: string;
    number: number;
  }
  | {
    /** `gh issue create` failed — surfaced loud, never masked as success. */
    action: "file-failed";
    repo: string;
    feed: AlertFeedName;
    findingId: string;
  };

/** Parameters for {@link maybeFileEnableFeedIssue}. */
export interface MaybeFileEnableFeedIssueParams {
  /** The `owner/repo` slug whose feed is unavailable. */
  repo: string;
  /** Which feed was unavailable. */
  feed: AlertFeedName;
  /** The `feed-unavailable` signal (status + gh reason). */
  unavailable: FeedUnavailable;
  /** The Vibe Coder's monitored allowlist (`.config.json` `repos`). */
  allowlist: readonly string[];
  /** Injected `gh` runner (dedup look-up + issue create). */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Optional attribution footer appended to the issue body. */
  footer?: string;
  /** Optional log sink for the fail-loud per-run signal (defaults to console). */
  logFn?: (message: string) => void;
  /**
   * Author-verification inputs for the dedup look-up (Issue #1243). Omitted —
   * every production caller — reads the configured fleet identity.
   */
  dedupAuthors?: FindingIdDedupOptions;
}

/**
 * File one enable-feed issue for an unavailable feed, gated by allowlist and
 * deduped per repo+feed.
 *
 * Behaviour (the #3396 acceptance):
 *   - **Not allowlisted** → nothing filed, `action: "not-allowlisted"`.
 *   - **First run** → one issue filed, `action: "filed"`.
 *   - **Second run (issue still open)** → deduped, `action: "already-open"`.
 *   - **`gh` create failure** → `action: "file-failed"` (surfaced loud).
 *
 * Every run logs the `feed-unavailable` outcome per repo+feed via `logFn`, so a
 * `feed-unavailable` log line with no corresponding open issue is the
 * silent-skip detection point during manual log review (Issue #3234).
 *
 * Never throws — the dedup look-up and create failures are handled by
 * `fileFindingOnce` / this wrapper and surfaced as typed outcomes.
 */
export async function maybeFileEnableFeedIssue(
  params: MaybeFileEnableFeedIssueParams,
): Promise<EnableFeedIssueOutcome> {
  const {
    repo,
    feed,
    unavailable,
    allowlist,
    ghCommandFn,
    footer = "",
    logFn = (m: string) => console.warn(m),
    dedupAuthors,
  } = params;
  const findingId = enableFeedFindingId(feed);

  // Per-run fail-loud log: the feed-unavailable outcome is always recorded, so
  // a run summary showing feed-unavailable with no open issue is detectable.
  const logPrefix =
    `[alert-feed] feed-unavailable: repo=${repo} feed=${feed} ` +
    `status=${unavailable.status}`;

  if (!isRepoAllowlisted(repo, allowlist)) {
    // Out-of-allowlist repos belong to another Vibe Coder instance — a 404/403
    // there is expected and must not generate noise.
    logFn(`${logPrefix} -> skipped (not in allowlist)`);
    return { action: "not-allowlisted", repo, feed };
  }

  const result = await fileFindingOnce({
    repo,
    logLabel: ENABLE_FEED_LABEL,
    findingId,
    ghCommandFn,
    dedupAuthors,
    fileFn: () =>
      createEnableFeedIssue(repo, feed, unavailable, footer, ghCommandFn),
  });

  if (result === null) {
    logFn(`${logPrefix} -> FILE FAILED (gh create returned no issue)`);
    return { action: "file-failed", repo, feed, findingId };
  }
  if (result.skipped) {
    logFn(`${logPrefix} -> deduped (issue #${result.number} already open)`);
    return {
      action: "already-open",
      repo,
      feed,
      findingId,
      number: result.number,
    };
  }
  logFn(`${logPrefix} -> filed issue #${result.number}`);
  return { action: "filed", repo, feed, findingId, number: result.number };
}

/**
 * Create the enable-feed issue via `gh issue create`, returning its number or
 * `null` on failure. Mirrors the `fileMissingScriptFinding` filer shape so
 * `fileFindingOnce` can dedup it.
 */
async function createEnableFeedIssue(
  repo: string,
  feed: AlertFeedName,
  unavailable: FeedUnavailable,
  footer: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<{ number: number; findingId: string } | null> {
  const findingId = enableFeedFindingId(feed);
  const args = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    buildEnableFeedTitle(repo, feed),
    "--body",
    buildEnableFeedBody(repo, feed, unavailable, footer),
    "--label",
    ENABLE_FEED_LABEL,
  ];
  let raw: string;
  try {
    raw = await ghCommandFn(args);
  } catch {
    return null;
  }
  const m = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (!m || !m[1]) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;
  return { number, findingId };
}
