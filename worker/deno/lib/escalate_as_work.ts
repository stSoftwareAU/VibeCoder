/**
 * Escalating a stuck PR as WORK rather than parking it (Issue #569).
 *
 * Every escalation route for a PR that cannot land ended the same way: a
 * comment plus the `needs-human` label. The operator's own words for that:
 * *"`PR comment + needs-human label` is mostly a failure in our automated Vibe
 * Coder workflow."* Parking a PR behind a label is the automation stopping —
 * and a PR that is behind, conflicting, red or unmergeable is **work**, which
 * is the thing the fleet exists to do.
 *
 * Worse, `needs-human` is a **cross-subsystem veto**. The merge-conflict scan
 * skips any PR carrying it (`pr_merge_conflict_scan.ts`), so one subsystem's
 * judgement about red CI permanently removed a PR from a different lane's
 * queue. VibeCoder #549 lived that: the stall watchdog escalated it for a
 * two-hour-old semgrep failure — a mechanical finding the CI-fix lane exists
 * to repair, and which that lane could not repair only because it was itself
 * broken (Issue #580) — and the `needs-human` that followed then locked the
 * PR out of the conflict lane that would have merged `main` in. The automation
 * did not fail to fix it; it removed the PR from its own reach and waited for
 * a person.
 *
 * So this module files an ISSUE the fleet can claim instead. The PR comment
 * stays — it is the breadcrumb on the artefact — but the label applied is a
 * non-vetoing marker, and the escalation carries what was tried so whoever
 * (or whatever) picks it up does not start from nothing.
 *
 * `needs-human` keeps its meaning for the cases that genuinely need a person:
 * a policy call, a credential, "is this what you meant". Reaching for it
 * should be rare, and it should mean the fleet has correctly decided a human
 * is the next actor — never that the fleet ran out of road.
 *
 * **The dedup match is author-verified.** The escalation deduplicates on
 * the exact issue title and, on a match, posts the escalation body as a
 * **comment on the matched issue**. A title is chosen by whoever opens the
 * issue, so an unverified match does two things at once: it suppresses the
 * escalation, and it redirects the escalation's contents onto an issue
 * somebody else picked. The match therefore counts only when a fleet
 * account wrote it (`alert_dedup_authors.ts`) *and* the issue carries the
 * work label — applying a label needs triage permission, so the two
 * together are belt and braces rather than one check.
 *
 * **The fail direction is towards filing.** An unresolvable fleet files a
 * fresh escalation: a duplicate is noise a human closes, a redirected or
 * silenced one is a stuck PR nobody hears about.
 *
 * **The work label is applied only if the worker is allowed to (Issue
 * #1381).** This escalation is reached from wall-clock stall thresholds on a
 * PR, so who causes it to run is not a trusted decision — an ordinary
 * contributor whose PR goes red, conflicts or sits in review long enough is
 * enough. Queue-priority labels are the operator's to apply, and the fleet
 * asks `worker_label_guard.ts` before applying any label to a filed issue,
 * exactly as `conflict_abandon_restart.ts` asks before re-queuing. When the
 * answer is no the escalation is still filed — unqueued and saying so —
 * because the fail direction is towards filing.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Logger, Result } from "../types.ts";
import {
  ALERT_DEDUP_TITLE_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import { spawnGh } from "./gh_spawn.ts";
import { isWorkerAppliableLabel } from "./worker_label_guard.ts";

/** Label marking a PR whose blockage has been filed as work (Issue #569). */
export const ESCALATED_AS_WORK_LABEL = "escalated";

/** Label that puts the filed issue into the fleet's own queue. */
export const DEFAULT_WORK_LABEL = "work-on";

/** Marker tying an escalation issue to the PR it was raised for. */
export function workEscalationMarker(repo: string, prNumber: number): string {
  return `<!-- vibe-work-escalation:${repo}#${prNumber} -->`;
}

/** One stuck PR, and why it is stuck. */
export interface WorkEscalation {
  /** Repository in `owner/repo` form — the issue is filed here, beside the PR. */
  repo: string;
  prNumber: number;
  /** Short noun phrase for the title, e.g. `CI has been red for 2h`. */
  summary: string;
  /** What is wrong, in the fleet's own words. */
  reason: string;
  /** What was already tried, so the next actor does not repeat it. */
  attempted?: string;
  /** What would unblock it. */
  nextStep: string;
  /** Label applied to the filed issue. Defaults to {@link DEFAULT_WORK_LABEL}. */
  workLabel?: string;
}

/** What {@link escalateAsWork} did. */
export interface WorkEscalationOutcome {
  /** Issue number filed or updated, or 0 when neither happened. */
  issueNumber: number;
  /** True when this call filed a new issue rather than updating one. */
  filed: boolean;
}

/**
 * Injected seams so the whole path is testable without GitHub.
 *
 * Extends {@link AlertDedupAuthorOptions}: `fleetAuthors` (tests) or the
 * configured fleet identity (production) decides whose title match may
 * receive the escalation body.
 */
export interface EscalateAsWorkDeps extends AlertDedupAuthorOptions {
  /** Runs `gh`, returning stdout; throws on failure. */
  gh?: (args: string[]) => Promise<string>;
  logger?: Logger;
}

async function defaultGh(args: string[]): Promise<string> {
  const result = await spawnGh(args);
  if (!result.success) {
    throw new Error(
      `gh ${args[0]} ${args[1] ?? ""} failed (exit ${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return result.stdout;
}

/** Title of the escalation issue — also its deduplication key. */
export function workEscalationTitle(
  escalation: Pick<WorkEscalation, "prNumber" | "summary">,
): string {
  return `PR #${escalation.prNumber} cannot land: ${escalation.summary}`;
}

/**
 * Body of the escalation issue.
 *
 * `withheldLabel` names the queue label the fleet was not permitted to apply
 * (Issue #1381), so an unqueued escalation explains itself rather than
 * looking like a filing that simply forgot its label.
 */
export function buildWorkEscalationBody(
  escalation: WorkEscalation,
  withheldLabel?: string,
): string {
  const { repo, prNumber, reason, attempted, nextStep } = escalation;
  return [
    workEscalationMarker(repo, prNumber),
    "",
    `${repo}#${prNumber} is blocked and the fleet could not clear it ` +
    `automatically.`,
    "",
    "**Why it is stuck**",
    "",
    reason,
    ...(attempted
      ? ["", "**What has already been tried**", "", attempted]
      : []),
    "",
    "**What would unblock it**",
    "",
    nextStep,
    "",
    "---",
    "",
    "Filed as work rather than parked behind `needs-human` (Issue #569): a PR " +
    "that is behind, conflicting, red or unmergeable is a task, not a " +
    "decision. `needs-human` is reserved for what genuinely needs a person — " +
    "a policy call, a credential, or confirming intent.",
    ...(withheldLabel
      ? [
        "",
        `This issue is **not queued**: the fleet did not apply ` +
        `\`${withheldLabel}\` to it. Queue-priority labels are yours to ` +
        "apply, not the worker's to award itself " +
        "(`worker/deno/lib/worker_label_guard.ts`, Issue #1381) — the " +
        "escalation would otherwise be a route by which anything that can " +
        "stall a PR also decides what the fleet works on next. Add the " +
        "label when you want a slot to pick this up.",
      ]
      : []),
  ].join("\n");
}

/**
 * File (or update) the issue that carries a stuck PR into the work queue.
 *
 * Deduplicated on the exact title, so an ongoing blockage stays one issue and
 * is commented on rather than re-filed.
 *
 * @returns The issue number, and whether this call filed it.
 */
export async function escalateAsWork(
  escalation: WorkEscalation,
  deps: EscalateAsWorkDeps = {},
): Promise<Result<WorkEscalationOutcome>> {
  const gh = deps.gh ?? defaultGh;
  const { repo } = escalation;
  const title = workEscalationTitle(escalation);
  const workLabel = escalation.workLabel ?? DEFAULT_WORK_LABEL;
  // Issue #1381: ask the one allowlist, never assume. `work-on` is reserved,
  // so on the production path this is false and the escalation files
  // unqueued; a caller passing a label the worker owns still gets it.
  const mayApplyWorkLabel = isWorkerAppliableLabel(workLabel);
  const body = buildWorkEscalationBody(
    escalation,
    mayApplyWorkLabel ? undefined : workLabel,
  );
  const log = (message: string) => {
    if (deps.logger?.warn) deps.logger.warn(message, { repo });
    else console.warn(message);
  };

  try {
    // Dedup by exact title among OPEN issues: a closed one means the blockage
    // was cleared, and a recurrence deserves its own issue rather than
    // reopening an argument that finished.
    const listed = await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      // Belt: only issues carrying the work label, which needs triage
      // permission to apply. Dropped when the fleet is not permitted to
      // apply that label (Issue #1381) — filtering on a label this module
      // never applies would match nothing and re-file the same escalation
      // every pass. The author check below is then the whole of the
      // verification, which is why it is not optional.
      ...(mayApplyWorkLabel ? ["--label", workLabel] : []),
      "--search",
      `in:title "${title}"`,
      "--json",
      ALERT_DEDUP_TITLE_JSON_FIELDS,
    ]);
    let existing: number | undefined;
    try {
      const parsed = JSON.parse(listed || "[]") as (AlertDedupRow & {
        title?: string;
      })[];
      // Braces: and only issues a fleet account authored.
      const verified = await selectFleetAuthoredMatches(
        parsed.filter((issue) => issue.title === title),
        `work escalation ${repo}#${escalation.prNumber}`,
        deps,
        (message) => log(message),
        "a fresh escalation is filed — the escalation body must never be " +
          "posted onto an issue the fleet did not open",
      );
      existing = verified[0]?.number;
    } catch {
      // Unparseable listing — fall through to filing, since a duplicate is
      // recoverable and a lost escalation is not.
    }

    if (existing !== undefined) {
      await gh([
        "issue",
        "comment",
        String(existing),
        "--repo",
        repo,
        "--body",
        `Still blocked.\n\n${escalation.reason}`,
      ]);
      deps.logger?.info?.("Updated the work escalation for a stuck PR", {
        repo,
        prNumber: escalation.prNumber,
        issueNumber: existing,
      });
      return { ok: true, value: { issueNumber: existing, filed: false } };
    }

    const created = await gh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
      ...(mayApplyWorkLabel ? ["--label", workLabel] : []),
    ]);
    const issueNumber = Number(created.trim().split("/").pop());
    if (!mayApplyWorkLabel) {
      log(
        `Filed ${repo}#${escalation.prNumber}'s blockage as issue ` +
          `#${issueNumber} without \`${workLabel}\` — the worker is not ` +
          "permitted to apply that label (worker_label_guard.ts). Apply it " +
          "to queue the escalation.",
      );
    }
    deps.logger?.info?.("Filed a stuck PR as work rather than parking it", {
      repo,
      prNumber: escalation.prNumber,
      issueNumber,
      workLabel,
      queued: mayApplyWorkLabel,
    });
    return {
      ok: true,
      value: {
        issueNumber: Number.isInteger(issueNumber) ? issueNumber : 0,
        filed: true,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
