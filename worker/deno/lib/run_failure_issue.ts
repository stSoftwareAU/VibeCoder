/**
 * Auto-file a deduped GitHub issue for code-fixable run failures (Issue
 * #4329, part of #4291).
 *
 * #4291: a no-PR run whose cause is fixable by code (OOM, disk exhaustion,
 * worker crash, missing tools) raises an issue automatically. This follows
 * the repo's classify-then-file pattern (`ci_failure_classifier.ts` /
 * `ci_failure_issue.ts`) adapted to run outcomes:
 *
 * - **Target repo is always `stSoftwareAU/VibeCoder`** — a failed run is a
 *   worker fault, whichever monitored repo the run was on; the source repo
 *   and issue are named in the body.
 * - **Dedup per failure class** on a machine-readable body marker
 *   `<!-- VIBE_RUN_FAILURE:<class> -->` (never the title): one open issue
 *   per class; later occurrences add at most ONE follow-up comment per
 *   window (the #2943 one-follow-up rule) and update it in place thereafter.
 * - **Only `code_fixable` files.** `not_code_fixable` and `unknown` never
 *   write — a wrong guess costs a spam issue.
 * - **Best-effort, never throws.** A release that throws leaves the issue
 *   assigned and unpickupable (Issue #2670 / incident #2648); every GitHub
 *   call is wrapped and failures go to `recordFaultEvent`.
 * - **Rate-limited per class per host** with a persisted minimum write
 *   interval, so a fleet-wide fault yields one issue and one follow-up
 *   rather than a burst. Cross-host convergence relies on the marker search.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupRow,
  selectFleetAuthoredComments,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import {
  CI_FAILURE_EXCERPT_BYTES,
  CI_FAILURE_SIGNAL_LINES,
  extractFailureSignals,
} from "./ci_failure_issue.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { atomicWrite } from "./file_utils.ts";
import { getFailureCategoryDisplay } from "./failure_diagnosis.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import type { RunOutcome } from "./run_outcome.ts";
import {
  classifyRunFailure,
  type RunFailureClassification,
} from "./run_outcome_classifier.ts";
import { withStateLock } from "./state_mutex.ts";
import {
  recordSelfDiagnosticFiling,
  type SelfDiagnosticFiling,
} from "./self_diagnostic_attestation.ts";

/** Marker prefix; the body carries `<!-- VIBE_RUN_FAILURE:<class> -->`. */
export const RUN_FAILURE_MARKER_PREFIX = "VIBE_RUN_FAILURE";
/** Self-diagnostic family id for issues this module files (Issue #1277). */
export const RUN_FAILURE_FAMILY_ID = "run-failure";
/** Follow-up comment marker: `<!-- VIBE_RUN_FAILURE_FOLLOWUP:<class>:<epoch> -->`. */
export const RUN_FAILURE_FOLLOWUP_PREFIX = "VIBE_RUN_FAILURE_FOLLOWUP";
/** Where worker-fault issues land, whichever repo the run was on. */
export const RUN_FAILURE_TARGET_REPO = "stSoftwareAU/VibeCoder";
/** Per-class, per-host minimum interval between GitHub writes. */
export const RUN_FAILURE_MIN_WRITE_INTERVAL_SECONDS = 60 * 60;
/** One follow-up comment per class per window; later occurrences update it. */
export const RUN_FAILURE_FOLLOWUP_WINDOW_SECONDS = 24 * 60 * 60;
/** State file beside the other worker state files. */
export const RUN_FAILURE_STATE_FILE = ".run_failure_filing_state.json";
/** Classes filed as `bug`; the rest as `enhancement`. */
const CRASH_CLASSES: ReadonlySet<string> = new Set(["worker-crash", "oom"]);

export function formatRunFailureMarker(failureClass: string): string {
  return `<!-- ${RUN_FAILURE_MARKER_PREFIX}:${failureClass} -->`;
}

/** The failure class an issue body is filed under, or null. */
export function parseRunFailureMarker(body: string): string | null {
  const m = new RegExp(
    `<!--\\s*${RUN_FAILURE_MARKER_PREFIX}:([a-z0-9-]+)\\s*-->`,
  )
    .exec(body ?? "");
  return m ? m[1]! : null;
}

/** Whether a body is an auto-filed run-failure issue (for this class). */
export function isRunFailureIssue(
  body: string,
  failureClass?: string,
): boolean {
  const found = parseRunFailureMarker(body);
  if (found === null) return false;
  return failureClass === undefined || found === failureClass;
}

export function formatRunFailureFollowUpMarker(
  failureClass: string,
  epoch: number,
): string {
  return `<!-- ${RUN_FAILURE_FOLLOWUP_PREFIX}:${failureClass}:${epoch} -->`;
}

/** Parse a follow-up marker: the class and the window-start epoch. */
export function parseRunFailureFollowUpMarker(
  body: string,
): { failureClass: string; epoch: number } | null {
  const m = new RegExp(
    `<!--\\s*${RUN_FAILURE_FOLLOWUP_PREFIX}:([a-z0-9-]+):(\\d+)\\s*-->`,
  ).exec(body ?? "");
  if (!m) return null;
  return { failureClass: m[1]!, epoch: parseInt(m[2]!, 10) };
}

/** What the release path knows about the failed run. */
export interface RunFailureReport {
  /** Monitored repo the run was on (`owner/repo`). */
  sourceRepo: string;
  sourceIssueNumber: number;
  /** The no-PR outcome (Issue #4325). */
  outcome: Extract<RunOutcome, { kind: "no_pr" }>;
  /** Machine / host id of the worker that ran it. */
  machineId: string;
  /** Permalink to the release comment, when known. */
  releaseCommentUrl?: string;
}

/** Filing decision, logged at every no-PR release. */
export type RunFailureFilingDecision =
  | { action: "filed"; issueNumber: number; failureClass: string }
  | {
    action: "commented";
    issueNumber: number;
    failureClass: string;
    updated: boolean;
  }
  | {
    action: "suppressed";
    reason:
      | "not_code_fixable"
      | "unknown"
      | "rate_limited"
      | "gh_failed"
      | "disabled";
    failureClass: string;
  };

export interface FileRunFailureIssueOptions {
  report: RunFailureReport;
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Work directory holding the rate-limit state file. */
  workDir: string;
  /** Injected clock (epoch seconds). */
  nowSeconds?: () => number;
  /** Target repo override (tests). Production: RUN_FAILURE_TARGET_REPO. */
  targetRepo?: string;
  /** Minimum interval override (tests). */
  minWriteIntervalSeconds?: number;
  /** Follow-up window override (tests). */
  followUpWindowSeconds?: number;
  log?: (message: string) => void;
  /**
   * Fleet logins whose escalation markers are trusted.
   *
   * A marker in an issue body is text anyone can write, so a dedup match is
   * only evidence the alert already exists when a fleet account authored it.
   * Omitted means "read the configured fleet identity"
   * (`service_accounts` / `fleet_pr_authors` / `GITHUB_USER`), which is what
   * every production caller does. An empty list is an *unresolved* fleet:
   * the match cannot be attributed, so it is not treated as an existing
   * alert and the escalation is raised.
   */
  fleetAuthors?: readonly string[];
  /**
   * Records the filing attestation tier 2b checks (Issue #1277).
   *
   * Injected so a test never appends to the host's real audit chain.
   * Production callers omit it and get {@link recordSelfDiagnosticFiling}.
   */
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
}

interface FilingState {
  classes: Record<string, { lastWriteEpoch: number; issueNumber?: number }>;
}

async function readState(path: string): Promise<FilingState> {
  try {
    const raw = await Deno.readTextFile(path);
    const parsed = JSON.parse(raw) as Partial<FilingState>;
    return { classes: parsed.classes ?? {} };
  } catch {
    return { classes: {} };
  }
}

async function writeState(path: string, state: FilingState): Promise<void> {
  try {
    const result = await atomicWrite({
      targetFile: path,
      content: JSON.stringify(state, null, 2) + "\n",
    });
    if (!result.ok) throw result.error;
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `run-failure filing state write failed: ${err}`,
    );
  }
}

/** Bounded, signal-first excerpt of the failure message. */
export function formatRunFailureExcerpt(message: string): string {
  const signals = extractFailureSignals(message, CI_FAILURE_SIGNAL_LINES);
  const chosen = signals.length > 0 ? signals.join("\n") : message;
  const bounded = chosen.length > CI_FAILURE_EXCERPT_BYTES
    ? chosen.slice(-CI_FAILURE_EXCERPT_BYTES)
    : chosen;
  // Never let the excerpt carry a marker of ours or close the fence.
  return bounded.replace(/<!--/g, "<!- -").replace(/-->/g, "- ->").replace(
    /```/g,
    "'''",
  );
}

/** Title for a class; stable so a human can find it, dedup never uses it. */
export function formatRunFailureTitle(failureClass: string): string {
  return `fix(worker): ${failureClass} — runs releasing with no PR`;
}

/** Issue body: marker first, then the diagnosis a human needs. */
export function formatRunFailureBody(
  report: RunFailureReport,
  classification: RunFailureClassification,
): string {
  const o = report.outcome;
  const lines = [
    formatRunFailureMarker(classification.failureClass),
    "",
    `Auto-filed by the Vibe Coder (Issue #4329): a run released its claim with **no PR** for a reason classified as fixable by code.`,
    "",
    `**Failure class:** \`${classification.failureClass}\` (${classification.fixability})`,
    `**Rationale:** ${classification.rationale}`,
    `**Category:** \`${getFailureCategoryDisplay(o.category)}\``,
    `**Phase that died:** \`${o.phase}\` after ${o.elapsedSeconds}s`,
    `**Host:** \`${report.machineId}\``,
    `**Source:** ${report.sourceRepo}#${report.sourceIssueNumber}`,
    ...(report.releaseCommentUrl
      ? [`**Release comment:** ${report.releaseCommentUrl}`]
      : []),
    "",
    "## Failure message (bounded excerpt)",
    "",
    "```",
    formatRunFailureExcerpt(o.message),
    "```",
    "",
    "Later occurrences of this class add one follow-up comment per window on this issue rather than filing again.",
  ];
  return lines.join("\n");
}

function formatOccurrenceLine(report: RunFailureReport, epoch: number): string {
  const when = new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `- ${when} \`${report.machineId}\` — ${report.sourceRepo}#${report.sourceIssueNumber}, phase \`${report.outcome.phase}\` after ${report.outcome.elapsedSeconds}s`;
}

/**
 * File, comment or suppress. Never throws; every decision is returned (and
 * logged when `log` is supplied) so worker logs can be reconciled with the
 * tracker.
 */
export async function fileRunFailureIssue(
  opts: FileRunFailureIssueOptions,
): Promise<RunFailureFilingDecision> {
  const classification = classifyRunFailure(
    opts.report.outcome.category,
    opts.report.outcome.message,
  );
  const failureClass = classification.failureClass;
  const log = opts.log ?? (() => {});
  const decide = (d: RunFailureFilingDecision): RunFailureFilingDecision => {
    log(
      `run-failure filing: ${d.action}${
        d.action === "suppressed" ? `:${d.reason}` : `:#${d.issueNumber}`
      } class=${failureClass} source=${opts.report.sourceRepo}#${opts.report.sourceIssueNumber}`,
    );
    return d;
  };

  // Only code-fixable outcomes file (asserted by test, not just this branch).
  if (classification.fixability !== "code_fixable") {
    return decide({
      action: "suppressed",
      reason: classification.fixability === "unknown"
        ? "unknown"
        : "not_code_fixable",
      failureClass,
    });
  }

  const now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const targetRepo = opts.targetRepo ?? RUN_FAILURE_TARGET_REPO;
  const minInterval = opts.minWriteIntervalSeconds ??
    RUN_FAILURE_MIN_WRITE_INTERVAL_SECONDS;
  const window = opts.followUpWindowSeconds ??
    RUN_FAILURE_FOLLOWUP_WINDOW_SECONDS;
  const statePath = `${opts.workDir}/${RUN_FAILURE_STATE_FILE}`;

  try {
    return await withStateLock(`run-failure-filing:${statePath}`, async () => {
      const state = await readState(statePath);
      const entry = state.classes[failureClass];
      const t = now();
      if (entry && t - entry.lastWriteEpoch < minInterval) {
        return decide({
          action: "suppressed",
          reason: "rate_limited",
          failureClass,
        });
      }

      // 1. Existing open issue for the class — matched on the body marker
      // AND on the author. A body is text anyone with an issue-open button
      // can write, so an unverified marker match would let a stranger's
      // issue stand in for this alert and silence it.
      let existing: { number: number } | null = null;
      try {
        const raw = await opts.ghFn([
          "issue",
          "list",
          "--repo",
          targetRepo,
          "--state",
          "open",
          "--search",
          `"${RUN_FAILURE_MARKER_PREFIX}:${failureClass}" in:body`,
          "--json",
          ALERT_DEDUP_JSON_FIELDS,
          "--limit",
          "20",
        ]);
        const list = JSON.parse(raw || "[]") as AlertDedupRow[];
        const verified = await selectFleetAuthoredMatches(
          list.filter((i) => isRunFailureIssue(i.body ?? "", failureClass)),
          `run-failure ${failureClass}`,
          opts,
          log,
        );
        const match = verified.sort((a, b) => a.number - b.number)[0];
        existing = match ? { number: match.number } : null;
      } catch (err) {
        recordFaultEvent(
          "catch_block_warning",
          `run-failure issue search failed (class ${failureClass}): ${err}`,
        );
        return decide({
          action: "suppressed",
          reason: "gh_failed",
          failureClass,
        });
      }

      // 2. None → file one.
      if (!existing) {
        // Built before the try: a refused label is a programming error and
        // must fail loud, not be reported as a `gh_failed` suppression.
        const labelArgs = guardedLabelArgs(
          [CRASH_CLASSES.has(failureClass) ? "bug" : "enhancement"],
          "worker/deno/lib/run_failure_issue.ts",
        );
        const body = formatRunFailureBody(opts.report, classification);
        const title = formatRunFailureTitle(failureClass);
        try {
          const raw = await opts.ghFn([
            "issue",
            "create",
            "--repo",
            targetRepo,
            "--title",
            title,
            "--body",
            body,
            ...labelArgs,
          ]);
          const m = /\/issues\/(\d+)\s*$/.exec(raw.trim());
          const issueNumber = m ? parseInt(m[1]!, 10) : 0;
          state.classes[failureClass] = { lastWriteEpoch: t, issueNumber };
          await writeState(statePath, state);
          // Issue #1277: attest the filing out of band, so tier 2b can tell
          // this diagnostic from one an injected agent typed the marker into.
          // `opts.log` defaults to a silent sink in this module, so the
          // attestation logs through `recordSelfDiagnosticFiling`'s own
          // stderr default when the caller supplied none.
          const recordFiling = opts.recordFiling ??
            ((filing: SelfDiagnosticFiling) =>
              recordSelfDiagnosticFiling(filing, { log: opts.log }));
          await recordFiling({
            repo: targetRepo,
            issueNumber,
            familyId: RUN_FAILURE_FAMILY_ID,
            title,
            body,
            filedBy: "worker/deno/lib/run_failure_issue.ts",
          });
          return decide({ action: "filed", issueNumber, failureClass });
        } catch (err) {
          recordFaultEvent(
            "catch_block_warning",
            `run-failure issue create failed (class ${failureClass}): ${err}`,
          );
          return decide({
            action: "suppressed",
            reason: "gh_failed",
            failureClass,
          });
        }
      }

      // 3. Exists → at most one follow-up per window; update it in place.
      try {
        // Issue #1216: the follow-up marker carries an attacker-choosable
        // epoch and lives in a comment body anyone may write, so the author
        // is asked for and checked exactly as step 1 checks the issue's. An
        // unverified match let one planted comment absorb every later
        // occurrence of the class — or, when the edit was refused, suppress
        // the class outright.
        const rawComments = await opts.ghFn([
          "api",
          `repos/${targetRepo}/issues/${existing.number}/comments`,
          "--jq",
          "[.[] | {id: .id, body: .body, author: .user.login}]",
        ]);
        const comments = JSON.parse(rawComments || "[]") as {
          id: number;
          body?: string;
          author?: string | null;
        }[];
        const fleetComments = await selectFleetAuthoredComments(
          comments.filter((c) =>
            parseRunFailureFollowUpMarker(c.body ?? "") !== null
          ),
          `run-failure follow-up ${failureClass}`,
          opts,
          log,
          "none counts as an existing follow-up and a fresh comment is " +
            "posted. A duplicate follow-up is noise; a suppressed one hides " +
            "a recurring worker fault",
        );
        const inWindow = fleetComments
          .map((c) => ({ c, m: parseRunFailureFollowUpMarker(c.body ?? "") }))
          .filter((x) =>
            x.m !== null && x.m.failureClass === failureClass &&
            t - x.m.epoch < window
          )
          .sort((a, b) => b.m!.epoch - a.m!.epoch)[0];
        if (inWindow) {
          const body = (inWindow.c.body ?? "").trimEnd() + "\n" +
            formatOccurrenceLine(opts.report, t);
          await opts.ghFn([
            "api",
            "--method",
            "PATCH",
            `repos/${targetRepo}/issues/comments/${inWindow.c.id}`,
            "-f",
            `body=${body}`,
          ]);
          state.classes[failureClass] = {
            lastWriteEpoch: t,
            issueNumber: existing.number,
          };
          await writeState(statePath, state);
          return decide({
            action: "commented",
            issueNumber: existing.number,
            failureClass,
            updated: true,
          });
        }
        const body = [
          formatRunFailureFollowUpMarker(failureClass, t),
          "",
          `Recurred (class \`${failureClass}\`, ${classification.rationale})`,
          "",
          formatOccurrenceLine(opts.report, t),
        ].join("\n");
        await opts.ghFn([
          "issue",
          "comment",
          String(existing.number),
          "--repo",
          targetRepo,
          "--body",
          body,
        ]);
        state.classes[failureClass] = {
          lastWriteEpoch: t,
          issueNumber: existing.number,
        };
        await writeState(statePath, state);
        return decide({
          action: "commented",
          issueNumber: existing.number,
          failureClass,
          updated: false,
        });
      } catch (err) {
        recordFaultEvent(
          "catch_block_warning",
          `run-failure follow-up failed (class ${failureClass}): ${err}`,
        );
        return decide({
          action: "suppressed",
          reason: "gh_failed",
          failureClass,
        });
      }
    });
  } catch (err) {
    // Belt and braces: nothing above should throw, but the release path
    // must never see an exception from here.
    recordFaultEvent(
      "catch_block_warning",
      `run-failure filing threw (class ${failureClass}): ${err}`,
    );
    return decide({ action: "suppressed", reason: "gh_failed", failureClass });
  }
}
