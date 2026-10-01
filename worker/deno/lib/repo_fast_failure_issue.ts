/**
 * Fleet-wide tally of fast failures for a repository (Issue #2956).
 *
 * `repo_fast_failure_tracker.ts` counts fast failures *per host*, so a
 * repository that fails fast once on three different hosts never reaches
 * any single host's own threshold and never backs off — the count the fleet
 * actually experienced was invisible, split across sidecars that never
 * compare notes.
 *
 * This module gives the fleet one shared place to compare notes: a single
 * **tally issue** per repository, filed in the repository itself (Issue
 * #2592 — never the worker repository), carrying a machine-readable marker
 * `<!-- VIBE_REPO_FAST_FAILURE_TALLY:<owner/repo> -->`. Every host that
 * records a fast failure for that repository posts one marker comment to
 * it: `<!-- vibe-fast-failure host="…" at="…" issue="…" -->`. The tally is
 * simply how many of those comments, from fleet-authored hosts, fall inside
 * the policy window.
 *
 * The module has exactly two states, never more:
 *
 * - **Tallying** — the issue exists and is collecting marker comments, but
 *   the count has not yet reached the threshold.
 * - **Backed off** — the count reached the threshold, so
 *   `formatRepoFastFailureMarker` (the same back-off marker
 *   `repo_fast_failure_tracker.ts` already reads via
 *   `lookupFleetDiagnosticBackOffs`, Issue #2955) is added to the body.
 *   Every host then honours the back-off fleet-wide, and closing the issue
 *   releases it.
 *
 * A tally-only body (no back-off marker yet) therefore does **not** put the
 * repository in the fleet-wide back-off set — only the second state does.
 *
 * Dedup, author verification and the never-throw contract mirror the
 * sibling self-diagnostic filers:
 *
 * - **Dedup on a machine-readable body marker**, never the title.
 * - A marker — in a body or a comment — is text anyone can write, so a
 *   match only counts when a fleet account authored it
 *   ({@link selectFleetAuthoredMatches}, {@link selectFleetAuthoredComments}).
 * - A refused `bug` label is retried once without it.
 * - **Best-effort, never throws.** This runs on the claim-release path, and
 *   a throw there leaves an issue assigned and unpickupable (incident
 *   #2648). Every decision is returned and logged instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  parseIssueViewCommentRows,
  selectFleetAuthoredComments,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import {
  type FaultEvent,
  recordFaultEvent,
} from "./fault_tolerance_counters.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import {
  recordSelfDiagnosticFiling,
  type SelfDiagnosticFiling,
} from "./self_diagnostic_attestation.ts";

/** Marker prefix; the back-off body carries `<!-- VIBE_REPO_FAST_FAILURE:<repo> -->`. */
export const REPO_FAST_FAILURE_MARKER_PREFIX = "VIBE_REPO_FAST_FAILURE";

/** Marker prefix for the fleet-wide tally issue's body. */
export const REPO_FAST_FAILURE_TALLY_MARKER_PREFIX =
  "VIBE_REPO_FAST_FAILURE_TALLY";

/** Self-diagnostic family id for issues this module files (Issue #1277). */
export const REPO_FAST_FAILURE_FAMILY_ID = "repo-fast-failure";

/** The back-off marker a diagnostic issue for `repo` carries once backed off. */
export function formatRepoFastFailureMarker(repo: string): string {
  return `<!-- ${REPO_FAST_FAILURE_MARKER_PREFIX}:${repo} -->`;
}

/** Whether a body carries the back-off marker for `repo`. */
export function isRepoFastFailureIssue(body: string, repo: string): boolean {
  return (body ?? "").includes(formatRepoFastFailureMarker(repo));
}

/** The tally marker a repository's fleet-wide tally issue carries. */
export function formatRepoFastFailureTallyMarker(repo: string): string {
  return `<!-- ${REPO_FAST_FAILURE_TALLY_MARKER_PREFIX}:${repo} -->`;
}

/** Whether a body is the fleet-wide tally issue for `repo`. */
export function isRepoFastFailureTallyIssue(
  body: string,
  repo: string,
): boolean {
  return (body ?? "").includes(formatRepoFastFailureTallyMarker(repo));
}

/** Stable title; a human can find it, but dedup never uses it. */
export function formatRepoFastFailureTitle(repo: string): string {
  return `fix(worker): ${repo} keeps failing at setup — runs die in the first minute`;
}

/**
 * Neutralise text that is pasted into a Markdown body.
 *
 * The detail is the agent's own last error line, so it must not be able to
 * close a fence or forge one of our markers.
 *
 * Every angle bracket is replaced by its nearest inert glyph, so no markup
 * of any kind can be opened or closed by construction — the fixed-pattern
 * mangling this replaces was a bad-tag-filter (CodeQL, Issue #2057): a
 * filter that names the forms it knows can be bypassed by the forms it does
 * not. Glyphs rather than HTML entities because the text lands inside a
 * fenced code block, where entities render literally instead of decoding.
 */
function safeForBody(text: string): string {
  return (text ?? "")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/```/g, "'''");
}

/** Where a repository's diagnostic issue is filed: the repository itself (Issue #2592). */
export function resolveRepoFastFailureTarget(repo: string): string {
  return repo;
}

/** Characters outside this allowlist cannot appear in a marker attribute. */
function sanitiseMarkerValue(value: string): string {
  return (value ?? "").replace(/[^A-Za-z0-9_.:#/-]/g, "-");
}

/** One recorded fast-failure comment event. */
export interface FastFailureCommentEvent {
  /** Host that recorded the fast failure. */
  host: string;
  /** ISO timestamp the comment marker carries. */
  at: string;
  /** `<repo>#<issueNumber>` the failed run was claiming. */
  issue: string;
}

/**
 * The marker a fast-failure tally comment carries.
 *
 * `host` and `issue` are sanitised against an allowlist so neither can break
 * out of the attribute or the comment itself.
 */
export function formatFastFailureCommentMarker(
  e: FastFailureCommentEvent,
): string {
  return `<!-- vibe-fast-failure host="${sanitiseMarkerValue(e.host)}" ` +
    `at="${e.at}" issue="${sanitiseMarkerValue(e.issue)}" -->`;
}

/** The marker regex, anchored to the opener and closer of our own marker. */
const FAST_FAILURE_COMMENT_MARKER_RE =
  /<!-- vibe-fast-failure host="([^"]*)" at="([^"]*)" issue="([^"]*)" -->/;

/** Parse a fast-failure comment marker out of a comment body, if present. */
export function parseFastFailureCommentMarker(
  body: string,
): FastFailureCommentEvent | undefined {
  const match = FAST_FAILURE_COMMENT_MARKER_RE.exec(body ?? "");
  if (!match) return undefined;
  return { host: match[1]!, at: match[2]!, issue: match[3]! };
}

/** Tally issue body: marker first, then a short explanation of the design. */
export function formatRepoFastFailureTallyBody(
  repo: string,
  policy: {
    threshold: number;
    windowSeconds: number;
    fastFailureSeconds: number;
  },
): string {
  const windowHours = Math.round(policy.windowSeconds / 3600);
  return [
    formatRepoFastFailureTallyMarker(repo),
    "",
    `Auto-filed by the Vibe Coder (Issue #2956): **${repo}** is being ` +
    `tallied for fast failures across the fleet. Every host adds a marker ` +
    `comment here each time its own run fails fast against this ` +
    `repository (inside ${policy.fastFailureSeconds}s, or before any ` +
    `output at all).`,
    "",
    `When ${policy.threshold} fast failures fall inside a rolling ` +
    `${windowHours} h window the back-off marker is added to this issue, ` +
    `and every host then skips ${repo} until this issue is closed (Issue ` +
    `#2955).`,
    "",
    "Closing this issue releases the back-off; a fresh tally starts from " +
    "the next fast failure.",
  ].join("\n");
}

/** What the fleet-wide tally did with this failure. */
export type RepoFastFailureTallyDecision =
  | {
    action: "recorded";
    targetRepo: string;
    issueNumber: number;
    created: boolean;
    count: number;
    backedOff: boolean;
  }
  | { action: "suppressed"; reason: "gh_failed" };

export interface RecordRepoFastFailureTallyOptions
  extends AlertDedupAuthorOptions {
  /** Repository that failed fast. */
  repo: string;
  /** Issue whose run failed fast. */
  failedIssueNumber: number;
  /** One-line reason; sanitised before it is posted. */
  reason: string;
  /** Host that recorded the fast failure. */
  machineId: string;
  policy: {
    threshold: number;
    windowSeconds: number;
    fastFailureSeconds: number;
  };
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Injected clock (epoch seconds). */
  nowSeconds?: () => number;
  /** Target repo override (tests). */
  targetRepo?: string;
  /** Sink for info-level decisions. */
  log?: (message: string) => void;
  /** Sink for warnings; defaults to `log` (or a no-op). */
  warn?: (message: string) => void;
  /** Records the filing attestation (Issue #1277). Injected by tests. */
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
  /** Fault-event recorder; defaults to `recordFaultEvent`. Injected by tests. */
  recordFault?: (event: FaultEvent, context?: string) => void;
}

/** A reason line, safe to paste into a tally comment body. */
function sanitiseReason(reason: string): string {
  const collapsed = (reason ?? "").replace(/\s+/g, " ").trim();
  return safeForBody(collapsed).slice(0, 300);
}

/**
 * Find (or create) the one fleet-wide tally issue for a repository, post a
 * marker comment recording this host's fast failure, count how many fall
 * inside the policy window, and add the back-off marker once the threshold
 * is reached.
 *
 * Never throws: the caller is the claim-release path. A GitHub failure at
 * any step is returned as `suppressed:gh_failed` and counted as a fault
 * event, so a tally that could not be recorded is visible rather than
 * silent.
 */
export async function recordRepoFastFailureTally(
  opts: RecordRepoFastFailureTallyOptions,
): Promise<RepoFastFailureTallyDecision> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? log;
  const recordFault = opts.recordFault ?? recordFaultEvent;
  const repo = opts.repo;
  const now = (opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const decide = (
    decision: RepoFastFailureTallyDecision,
  ): RepoFastFailureTallyDecision => {
    log(
      `repo-fast-failure tally: ${decision.action}${
        decision.action === "suppressed"
          ? `:${decision.reason}`
          : `:#${decision.issueNumber} count=${decision.count} backedOff=${decision.backedOff}`
      } repo=${repo}`,
    );
    return decision;
  };

  const targetRepo = opts.targetRepo ?? resolveRepoFastFailureTarget(repo);

  try {
    // 1. Find the existing fleet-authored tally issue, if any.
    let issueNumber: number | undefined;
    let created = false;
    try {
      const raw = await opts.ghFn([
        "issue",
        "list",
        "--repo",
        targetRepo,
        "--state",
        "open",
        "--search",
        `"${REPO_FAST_FAILURE_TALLY_MARKER_PREFIX}:${repo}" in:body`,
        "--json",
        ALERT_DEDUP_JSON_FIELDS,
        "--limit",
        "20",
      ]);
      const list = JSON.parse(raw || "[]") as AlertDedupRow[];
      const verified = await selectFleetAuthoredMatches(
        list.filter((row) => isRepoFastFailureTallyIssue(row.body ?? "", repo)),
        `repo-fast-failure tally ${repo}`,
        opts,
        log,
      );
      const match = verified.sort((a, b) => a.number - b.number)[0];
      if (match) issueNumber = match.number;
    } catch (err) {
      recordFault(
        "catch_block_warning",
        `repo fast-failure tally search failed (${repo}): ${err}`,
      );
      return decide({ action: "suppressed", reason: "gh_failed" });
    }

    // 2. None → create exactly one.
    if (issueNumber === undefined) {
      // Built before the try: a refused label is a programming error and
      // must fail loud, not be reported as a `gh_failed` suppression.
      const labelArgs = guardedLabelArgs(
        ["bug"],
        "worker/deno/lib/repo_fast_failure_issue.ts",
      );
      const title = formatRepoFastFailureTitle(repo);
      const body = formatRepoFastFailureTallyBody(repo, opts.policy);
      const createArgs = [
        "issue",
        "create",
        "--repo",
        targetRepo,
        "--title",
        title,
        "--body",
        body,
      ];
      try {
        let raw: string;
        try {
          raw = await opts.ghFn([...createArgs, ...labelArgs]);
        } catch (labelled) {
          // The monitored repository may not have a `bug` label: retry
          // exactly once without it rather than lose the tally (Issue #2592).
          log(
            `repo-fast-failure tally: create with label failed (${repo}), ` +
              `retrying without --label: ${labelled}`,
          );
          raw = await opts.ghFn(createArgs);
        }
        const m = /\/issues\/(\d+)\s*$/.exec(raw.trim());
        if (!m) {
          recordFault(
            "catch_block_warning",
            `repo fast-failure tally create returned no issue number (${repo}): ${raw}`,
          );
          return decide({ action: "suppressed", reason: "gh_failed" });
        }
        issueNumber = parseInt(m[1]!, 10);
        created = true;
        const recordFiling = opts.recordFiling ??
          ((filing: SelfDiagnosticFiling) =>
            recordSelfDiagnosticFiling(filing, { log: opts.log }));
        await recordFiling({
          repo: targetRepo,
          issueNumber,
          familyId: REPO_FAST_FAILURE_FAMILY_ID,
          title,
          body,
          filedBy: "worker/deno/lib/repo_fast_failure_issue.ts",
        });
      } catch (err) {
        recordFault(
          "catch_block_warning",
          `repo fast-failure tally create failed (${repo}): ${err}`,
        );
        return decide({ action: "suppressed", reason: "gh_failed" });
      }
    }

    // 3. Post this host's marker comment.
    const at = new Date(now * 1000).toISOString();
    const marker = formatFastFailureCommentMarker({
      host: opts.machineId,
      at,
      issue: `${repo}#${opts.failedIssueNumber}`,
    });
    const commentBody = `${marker}\n${sanitiseReason(opts.reason)}`;
    try {
      await opts.ghFn([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        targetRepo,
        "--body",
        commentBody,
      ]);
    } catch (err) {
      warn(
        `repo fast-failure tally comment failed (${repo}, #${issueNumber}): ${err}`,
      );
      recordFault(
        "catch_block_warning",
        `repo fast-failure tally comment failed (${repo}): ${err}`,
      );
      return decide({ action: "suppressed", reason: "gh_failed" });
    }

    // 4. Count fleet-authored marker comments inside the window.
    let body: string;
    let count: number;
    try {
      const raw = await opts.ghFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        targetRepo,
        "--json",
        "body,comments",
      ]);
      const parsed = JSON.parse(raw) as {
        body?: string;
        comments?: unknown;
      };
      body = parsed.body ?? "";
      const rows = parseIssueViewCommentRows(parsed.comments);
      const verifiedRows = await selectFleetAuthoredComments(
        rows,
        `repo-fast-failure tally ${repo}`,
        opts,
        log,
      );
      count = verifiedRows.filter((row) => {
        const event = parseFastFailureCommentMarker(row.body);
        if (!event) return false;
        const at = Date.parse(event.at);
        if (!Number.isFinite(at)) return false;
        const atSeconds = at / 1000;
        return atSeconds >= now - opts.policy.windowSeconds &&
          atSeconds <= now + opts.policy.windowSeconds;
      }).length;
    } catch (err) {
      warn(
        `repo fast-failure tally count failed (${repo}, #${issueNumber}): ${err}`,
      );
      recordFault(
        "catch_block_warning",
        `repo fast-failure tally count failed (${repo}): ${err}`,
      );
      return decide({ action: "suppressed", reason: "gh_failed" });
    }

    // 5. Back off once the threshold is reached.
    const alreadyBackedOff = isRepoFastFailureIssue(body, repo);
    if (count >= opts.policy.threshold && !alreadyBackedOff) {
      const windowHours = Math.round(opts.policy.windowSeconds / 3600);
      const newBody = formatRepoFastFailureMarker(repo) + "\n\n" +
        `**Backed off** at ${
          new Date(now * 1000).toISOString()
        }: ${count} fast failures across the fleet in the last ` +
        `${windowHours} h (threshold ${opts.policy.threshold}). Every host ` +
        `now skips ${repo} until this issue is closed.` + "\n\n" + body;
      try {
        await opts.ghFn([
          "issue",
          "edit",
          String(issueNumber),
          "--repo",
          targetRepo,
          "--body",
          newBody,
        ]);
      } catch (err) {
        warn(
          `repo fast-failure tally back-off edit failed (${repo}, #${issueNumber}): ${err}`,
        );
        recordFault(
          "catch_block_warning",
          `repo fast-failure tally back-off edit failed (${repo}): ${err}`,
        );
        return decide({
          action: "recorded",
          targetRepo,
          issueNumber,
          created,
          count,
          backedOff: false,
        });
      }
      return decide({
        action: "recorded",
        targetRepo,
        issueNumber,
        created,
        count,
        backedOff: true,
      });
    }

    return decide({
      action: "recorded",
      targetRepo,
      issueNumber,
      created,
      count,
      backedOff: alreadyBackedOff,
    });
  } catch (err) {
    // Belt and braces: the release path must never see an exception here.
    recordFault(
      "catch_block_warning",
      `repo fast-failure tally threw (${repo}): ${err}`,
    );
    return decide({ action: "suppressed", reason: "gh_failed" });
  }
}
