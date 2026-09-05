/**
 * Dependency-audit failure notifier (Issue #2691 — SCR-AUTO-UPDATE).
 *
 * The weekly `deno audit` job in `.github/workflows/dependency-audit.yml`
 * already *detects* a known advisory that has landed against a Deno
 * dependency already pinned in `deno.lock`. It does not *react*: a failing
 * scheduled run notifies no one, so a human must happen to notice the red
 * cron and bump the dependency by hand.
 *
 * Renovate cannot fill this gap because its `deno` manager is
 * deliberately disabled (`renovate.json`, Issue #2536) so it never
 * overlaps the native `minimumDependencyAge` quarantine window, and the
 * native Deno controls are a quarantine window plus detection-only audit
 * — neither raises a remediation item. This module is the security-update
 * *channel* the readiness catalogue asks for: when the scheduled audit
 * fails, file a single tracking issue so a vulnerable, already-committed
 * Deno dependency surfaces an actionable item instead of a silent red
 * cron.
 *
 * The notifier is invoked from CI (the `notify-audit-failure` command),
 * not by the worker, so it carries no worker-label-policy concerns — the
 * tracking label is applied by the GitHub Actions token, not the worker
 * account.
 *
 * Design notes:
 *   - Idempotent. One open tracking issue per ecosystem at a time: a
 *     second failing run finds the existing issue (matched by exact title
 *     **and** by fleet authorship — a title alone is attacker-writable) and
 *     skips rather than filing a duplicate every week.
 *   - The tracking issue is the guarantee; the label is best-effort. The
 *     issue is created first (no label, so creation cannot fail on a
 *     missing label), then the label is ensured and applied — any
 *     labelling failure leaves the issue in place.
 *   - The `gh` runner is injectable so the behaviour is unit-tested with
 *     no network and no `gh` binary.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand } from "./github.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { findFleetAuthoredIssuesTitled } from "./idle_task_wrapper_dedup.ts";
import {
  type AuditFailureMode,
  classifyAuditFailure,
} from "./audit_fail_closed.ts";
import {
  getLabelColour,
  getLabelDescription,
} from "../setup/label_definitions.ts";

export type { AuditFailureMode };

/** Label every filed tracking issue carries (best-effort). */
export const AUDIT_FAILURE_LABEL = "dependency-audit-failure";

/**
 * Colour + description used when ensuring the tracking label exists.
 * Issue #368 — read from the canonical label table so the label is the
 * same colour in every repo the notifier files into.
 */
const LABEL_COLOUR = getLabelColour(AUDIT_FAILURE_LABEL);
const LABEL_DESCRIPTION = getLabelDescription(AUDIT_FAILURE_LABEL);

// ---------------------------------------------------------------------------
// Issue content
// ---------------------------------------------------------------------------

export interface AuditFailureIssue {
  title: string;
  body: string;
}

/**
 * Build the title and body of the tracking issue for `ecosystem`.
 *
 * The title is stable per ecosystem *and* failure mode, so the idempotency
 * check can match it exactly and the two modes track separately. `runUrl`,
 * when supplied, links the reader straight to the failing workflow run.
 *
 * `mode` (Issue #3955) says which failure this is: `advisory` — the audit
 * ran and found a known-vulnerable committed dependency — or
 * `registry-unreachable` — the advisory service did not answer, so nothing
 * was audited at all.
 */
export function buildAuditFailureIssue(
  ecosystem: string,
  runUrl?: string,
  mode: AuditFailureMode = "advisory",
): AuditFailureIssue {
  const eco = ecosystem.trim() === "" ? "deno" : ecosystem.trim();
  const runLine = runUrl && runUrl.trim() !== ""
    ? `**Failing run:** ${runUrl.trim()}\n\n`
    : "";

  if (mode === "registry-unreachable") {
    return buildUnreachableIssue(eco, runLine);
  }

  const title = `🔴 Scheduled dependency audit failed for the ${eco} ecosystem`;

  const body = `The scheduled \`${eco}\` dependency audit has failed, which ` +
    `means a package already pinned in the lockfile now has a known ` +
    `security advisory.\n\n` +
    runLine +
    `## Why this issue exists\n\n` +
    `Renovate's \`deno\` manager is intentionally disabled so it does not ` +
    `overlap the native \`minimumDependencyAge\` quarantine window, and the ` +
    `native Deno controls only *quarantine* and *detect* — neither raises a ` +
    `remediation item. This tracking issue is the security-update channel: ` +
    `it converts a failing scheduled audit into an actionable bump rather ` +
    `than a silent red cron (Issue #2691, SCR-AUTO-UPDATE).\n\n` +
    `## What to do\n\n` +
    `1. Reproduce locally: \`cd worker/deno && deno task audit\`.\n` +
    `2. Identify the advisory and the fixed version.\n` +
    `3. Bump the dependency through Deno's own tooling ` +
    `(\`deno update --minimum-dependency-age=24h\`), following the ` +
    `emergency-override runbook in ` +
    `\`docs/security-advisory-triage.md#emergency-dependency-override\` for ` +
    `an actively-exploited advisory.\n` +
    `4. Close this issue once the fix lands.\n\n` +
    `_Filed automatically by the scheduled dependency-audit workflow._\n`;

  return { title, body };
}

/**
 * Tracking issue for the "did not audit" mode: the advisory service did
 * not answer, so the run checked nothing. The remediation is to re-run,
 * not to bump a dependency — and explicitly *not* to restore the
 * `--ignore-registry-errors` opt-out that hid this for weeks.
 */
function buildUnreachableIssue(
  eco: string,
  runLine: string,
): AuditFailureIssue {
  const title =
    `🔴 Scheduled dependency audit could not run for the ${eco} ecosystem`;

  const body =
    `The scheduled \`${eco}\` dependency audit could not reach the advisory ` +
    `service, so **nothing was audited**. This is not a clean result — the ` +
    `committed lockfile has not been checked against current advisories ` +
    `since the last successful run.\n\n` +
    runLine +
    `## Why this issue exists\n\n` +
    `The audit is fail-closed (Issue #3955): \`deno audit\` runs without ` +
    `\`--ignore-registry-errors\`, which returns exit code 0 when the remote ` +
    `service responds with an error. With the opt-out in place an outage ` +
    `produced a green weekly job that had checked nothing, and this ` +
    `notification never fired. Nothing else re-audits an unchanged ` +
    `\`deno.lock\` — Renovate's \`deno\` manager is deliberately disabled ` +
    `(Issue #2536).\n\n` +
    `## What to do\n\n` +
    `1. Check the failing run's log for the transport error and confirm the ` +
    `advisory service is back (\`cd worker/deno && deno task audit\`).\n` +
    `2. Re-run the workflow (\`workflow_dispatch\` on ` +
    `\`dependency-audit.yml\`) and confirm it passes.\n` +
    `3. If it keeps failing, investigate runner egress rather than ` +
    `restoring \`--ignore-registry-errors\` — that flag converts an ` +
    `unaudited run back into a green one.\n` +
    `4. Close this issue once a scheduled or manual run has audited ` +
    `cleanly.\n\n` +
    `_Filed automatically by the scheduled dependency-audit workflow._\n`;

  return { title, body };
}

// ---------------------------------------------------------------------------
// Notify
// ---------------------------------------------------------------------------

export interface NotifyAuditFailureOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Ecosystem whose audit failed (e.g. `deno`). */
  ecosystem: string;
  /** Optional link to the failing workflow run. */
  runUrl?: string;
  /**
   * Path to the captured audit output (Issue #3955). When supplied, the
   * failure is classified from it so the tracking issue distinguishes
   * "did not audit" from "audited, vulnerable". An unreadable log falls
   * back to the advisory mode with a logged warning.
   */
  auditLogPath?: string;
  /** Injectable log reader — defaults to `Deno.readTextFile`. */
  readTextFileFn?: (path: string) => Promise<string>;
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Injectable warning sink — defaults to `console.error` (Issue #3649). */
  warnFn?: (message: string) => void;
  /**
   * Author-verification inputs for the idempotency lookup. Omitted — every
   * production caller — reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
}

export interface NotifyAuditFailureResult {
  /**
   * `filed` — a new tracking issue was created.
   * `skipped` — a matching open tracking issue already exists.
   * `error` — issue creation failed (the audit failure is still surfaced
   *   by the red CI run; only the convenience notification was lost).
   */
  action: "filed" | "skipped" | "error";
  /** Issue number of the filed or matched issue, when known. */
  issueNumber?: number;
  /** URL of the filed issue, when known. */
  url?: string;
  /** Whether the tracking label was successfully applied (filed path). */
  labelApplied?: boolean;
  /** Failure reason on the `error` path. */
  reason?: string;
}

/**
 * File (or skip, when one already exists) a tracking issue for a failed
 * scheduled dependency audit. Never throws — every failure mode is folded
 * into the returned result so the caller can log and exit cleanly.
 */
export async function notifyAuditFailure(
  opts: NotifyAuditFailureOptions,
): Promise<NotifyAuditFailureResult> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const warn = opts.warnFn ?? ((message: string) => console.error(message));
  const mode = await resolveFailureMode(opts, warn);
  const issue = buildAuditFailureIssue(opts.ecosystem, opts.runUrl, mode);

  // 1. Idempotency — one open tracking issue per ecosystem at a time.
  const existing = await findExistingAuditFailureIssue(
    opts.repo,
    issue.title,
    gh,
    opts.dedupAuthors ?? {},
    warn,
  );
  if (existing !== null && "lookupFailed" in existing) {
    const reason = `existing-issue lookup failed: ${existing.reason}`;
    warn(`[audit-notify] ${opts.repo}: ${reason} — no issue was filed`);
    return { action: "error", reason };
  }
  if (existing !== null) {
    return {
      action: "skipped",
      issueNumber: existing.number,
      url: existing.url,
    };
  }

  // 2. Create the tracking issue (no label, so a missing label cannot
  //    fail creation).
  let createOutput: string;
  try {
    createOutput = await gh([
      "issue",
      "create",
      "--repo",
      opts.repo,
      "--title",
      issue.title,
      "--body",
      issue.body,
    ]);
  } catch (err) {
    return {
      action: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const issueNumber = parseIssueNumber(createOutput);
  const url = createOutput.trim().split(/\s+/).find((t) =>
    t.startsWith("http")
  );

  // 3. Best-effort label — the issue is the guarantee, the label a bonus.
  const labelApplied = issueNumber === null
    ? false
    : await applyTrackingLabel(opts.repo, issueNumber, gh);

  return {
    action: "filed",
    issueNumber: issueNumber ?? undefined,
    url,
    labelApplied,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify the failure from the captured audit output (Issue #3955).
 *
 * With no log supplied the mode stays `advisory`, the pre-#3955 behaviour.
 * A log that cannot be read is reported — the classification is lost, so
 * the loss must be visible rather than silently defaulted.
 */
async function resolveFailureMode(
  opts: NotifyAuditFailureOptions,
  warn: (message: string) => void,
): Promise<AuditFailureMode> {
  const path = opts.auditLogPath?.trim() ?? "";
  if (path === "") return "advisory";

  const read = opts.readTextFileFn ?? Deno.readTextFile;
  try {
    return classifyAuditFailure(await read(path));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(
      `[audit-notify] could not read the audit log ${path}: ${reason} — ` +
        `filing the advisory-mode tracking issue`,
    );
    return "advisory";
  }
}

interface ExistingIssue {
  number: number;
  url: string;
}

/** The lookup itself failed, so "does one already exist?" is unanswered. */
interface LookupFailure {
  lookupFailed: true;
  reason: string;
}

/**
 * Return the first open **fleet-authored** issue in `repo` whose title
 * exactly equals `title`, or null when there is none.
 *
 * The server-side `in:title` search narrows the candidate set; the exact
 * client-side match guards against the search being fuzzy; and the author
 * check is what makes a match evidence. An issue title is text any account
 * able to open an issue may write, and the titles here are constants derived
 * from the ecosystem name, so without the author check an outsider could open
 * one issue with the right title and every future audit failure would report
 * "already tracked" while nothing was tracked at all. An unresolvable fleet
 * author set counts no match, so the tracking issue is filed rather than
 * silently skipped — `idle_task_wrapper_dedup.ts` logs the reason.
 */
async function findExistingAuditFailureIssue(
  repo: string,
  title: string,
  gh: (args: string[]) => Promise<string>,
  dedupAuthors: AlertDedupAuthorOptions,
  warn: (message: string) => void,
): Promise<ExistingIssue | null | LookupFailure> {
  let matches: { number: number; url?: string }[];
  try {
    matches = await findFleetAuthoredIssuesTitled({
      repo,
      title,
      context: `audit-failure tracker ${repo}`,
      ghCommand: gh,
      searchExpression: `${title} in:title`,
      extraJsonFields: ["url"],
      limit: 50,
      log: warn,
      ...dedupAuthors,
    });
  } catch (err) {
    // A failed lookup must not produce a duplicate-or-nothing gamble, so
    // filing is still skipped — but Issue #3649 (SEC-c8172be04d3a): the old
    // `{ number: 0 }` sentinel was indistinguishable from "a matching issue
    // already exists", so the workflow reported success while no advisory
    // issue existed and the error was never logged. Report it explicitly.
    return {
      lookupFailed: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const match = matches[0];
  if (match === undefined) return null;
  return { number: match.number, url: match.url ?? "" };
}

/**
 * Ensure the tracking label exists, then apply it to the freshly-filed
 * issue. Both steps are best-effort: any failure returns `false` and
 * leaves the issue in place.
 */
async function applyTrackingLabel(
  repo: string,
  issueNumber: number,
  gh: (args: string[]) => Promise<string>,
): Promise<boolean> {
  // Ensure the label exists (ignore "already exists" / permission errors).
  try {
    await gh([
      "label",
      "create",
      AUDIT_FAILURE_LABEL,
      "--repo",
      repo,
      "--color",
      LABEL_COLOUR,
      "--description",
      LABEL_DESCRIPTION,
      "--force",
    ]);
  } catch {
    // Label may already exist, or the token may lack permission — the
    // add-label below still attempts to apply it.
  }

  try {
    await gh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      AUDIT_FAILURE_LABEL,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Extract the trailing issue number from a `gh issue create` URL. */
function parseIssueNumber(createOutput: string): number | null {
  const match = createOutput.match(/\/issues\/(\d+)/);
  if (match === null || match[1] === undefined) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isNaN(n) ? null : n;
}
