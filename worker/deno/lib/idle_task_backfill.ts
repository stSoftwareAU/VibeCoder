/**
 * Back-fill the `idle-task` label on open idle-task wrapper issues
 * (Issue #2131, extended in Issue #2322 to cover all four templates,
 * extended in Issue #2398 to cover the fifth — supply-chain-readiness,
 * extended in Issue #2904 to cover the sixth — orphan-deps, extended in
 * Issue #2930 to cover the four Boy Scout templates — dead-code,
 * doc-coverage, format-drift, deprecated-api).
 *
 * Some wrappers filed in production before #2130 landed are missing the
 * `idle-task` label, so they sit invisible to the priority queue and to
 * the cross-repo dedup gate. This module sweeps the open wrappers in
 * every monitored repo and applies `idle-task` where missing — for any
 * of the ten registered idle-task templates (security-scan, test-audit,
 * best-practices, github-actions-audit, supply-chain-readiness,
 * orphan-deps, dead-code, doc-coverage, format-drift, deprecated-api).
 *
 * The sweep is idempotent — a labelled wrapper produces an
 * `already_labelled` event and is not re-touched. Per-repo failures are
 * captured in the returned `BackfillSummary` and never abort the rest
 * of the sweep.
 *
 * Every rescued orphan emits two log lines: the existing
 * `[backfill] action=labelled` line and a louder
 * `[idle-task] ALERT severity=warn action=backfill_rescued ...` line so
 * operators can grep production logs for create-path label drops.
 *
 * The sweep rescues **create-path drops only**: a wrapper whose
 * `idle-task` label was applied at filing time and later deliberately
 * removed (an operator re-triaging the wrapper to `work-on` or
 * `low-priority`, say) is not an orphan, and re-labelling it would
 * silently undo the operator's decision on every sweep — the same
 * re-add loop Issue #1878 fixed for `needs-human`. Before labelling, the
 * sweep therefore reads the issue's full label-event timeline: any
 * `unlabeled` event for `idle-task` means the create path did apply the
 * label, so the wrapper is skipped with a
 * `skipped_deliberately_unlabelled` event instead. An unreadable
 * timeline fails closed (error recorded, no label written) rather than
 * risk overriding a human.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand } from "./github.ts";
import { addLabelToIssue } from "./label_operations.ts";
import { fetchCompleteTimeline } from "./issue_query.ts";
import type { TimelineLabelEventJson } from "./validation.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { SECURITY_SCAN_ISSUE_TITLE } from "./idle_task_templates/security_scan_template.ts";
import { TEST_AUDIT_ISSUE_TITLE } from "./idle_task_templates/test_audit_template.ts";
import { BEST_PRACTICES_ISSUE_TITLE } from "./idle_task_templates/best_practices_template.ts";
import { GITHUB_ACTIONS_AUDIT_ISSUE_TITLE } from "./idle_task_templates/github_actions_audit_template.ts";
import { SUPPLY_CHAIN_READINESS_ISSUE_TITLE } from "./idle_task_templates/supply_chain_readiness_template.ts";
import { ORPHAN_DEPS_ISSUE_TITLE } from "./idle_task_templates/orphan_deps_template.ts";
import { DEAD_CODE_ISSUE_TITLE } from "./idle_task_templates/dead_code_template.ts";
import { DOC_COVERAGE_ISSUE_TITLE } from "./idle_task_templates/doc_coverage_template.ts";
import { FORMAT_DRIFT_ISSUE_TITLE } from "./idle_task_templates/format_drift_template.ts";
import { DEPRECATED_API_ISSUE_TITLE } from "./idle_task_templates/deprecated_api_template.ts";
import { BASH_SCRIPT_REFS_ISSUE_TITLE } from "./idle_task_templates/bash_script_refs_template.ts";
import { BASH_SYNTAX_AUDIT_ISSUE_TITLE } from "./idle_task_templates/bash_syntax_audit_template.ts";
import { DOCUMENTATION_AUDIT_ISSUE_TITLE } from "./idle_task_templates/documentation_audit_template.ts";
import { ALERT_FEED_ISSUE_TITLE } from "./idle_task_templates/alert_feed_template.ts";
import { WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE } from "./idle_task_templates/workflow_annotation_scan_template.ts";
import { PRIVATE_REPO_REFERENCE_ISSUE_TITLE } from "./idle_task_templates/private_repo_reference_template.ts";
import { DUPLICATED_KNOWLEDGE_ISSUE_TITLE } from "./idle_task_templates/duplicated_knowledge_template.ts";
import { RETRO_ISSUE_TITLE } from "./idle_task_templates/retro_template.ts";
import { assertNever } from "./assert_never.ts";

// ---------------------------------------------------------------------------
// Wrapper title allowlist (Issue #2322)
// ---------------------------------------------------------------------------

/**
 * Map from the exact wrapper title to the registered template name.
 * Hard-coded — registry-derived lookup is intentionally out of scope so
 * the sweep stays trivially auditable.
 */
const TITLE_TO_TEMPLATE: ReadonlyMap<string, string> = new Map([
  [SECURITY_SCAN_ISSUE_TITLE, "security-scan"],
  [TEST_AUDIT_ISSUE_TITLE, "test-audit"],
  [BEST_PRACTICES_ISSUE_TITLE, "best-practices"],
  [GITHUB_ACTIONS_AUDIT_ISSUE_TITLE, "github-actions-audit"],
  [SUPPLY_CHAIN_READINESS_ISSUE_TITLE, "supply-chain-readiness"],
  [ORPHAN_DEPS_ISSUE_TITLE, "orphan-deps"],
  [DEAD_CODE_ISSUE_TITLE, "dead-code"],
  [DOC_COVERAGE_ISSUE_TITLE, "doc-coverage"],
  [FORMAT_DRIFT_ISSUE_TITLE, "format-drift"],
  [DEPRECATED_API_ISSUE_TITLE, "deprecated-api"],
  [BASH_SCRIPT_REFS_ISSUE_TITLE, "bash-script-refs"],
  [BASH_SYNTAX_AUDIT_ISSUE_TITLE, "bash-syntax-audit"],
  [DOCUMENTATION_AUDIT_ISSUE_TITLE, "documentation-audit"],
  [ALERT_FEED_ISSUE_TITLE, "alert-feed"],
  [WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE, "workflow-annotation-scan"],
  [PRIVATE_REPO_REFERENCE_ISSUE_TITLE, "private-repo-reference-audit"],
  [DUPLICATED_KNOWLEDGE_ISSUE_TITLE, "duplicated-knowledge"],
  [RETRO_ISSUE_TITLE, "retro"],
]);

/** The eighteen wrapper titles the sweep is allowed to rescue. */
export const IDLE_TASK_WRAPPER_TITLES: readonly string[] = Array.from(
  TITLE_TO_TEMPLATE.keys(),
);

/**
 * The registered template names behind the canonical wrapper titles (Issue
 * #3320). Derived from the same hard-coded {@link TITLE_TO_TEMPLATE} map so it
 * is the single source of truth for "which template names name a canonical
 * idle-task wrapper" — used by the single-template raiser to validate a
 * caller-supplied `--template` before filing, so an unknown name fails loud
 * rather than filing nothing.
 */
export const IDLE_TASK_WRAPPER_TEMPLATE_NAMES: ReadonlySet<string> = new Set(
  TITLE_TO_TEMPLATE.values(),
);

const TITLE_SET: ReadonlySet<string> = new Set(IDLE_TASK_WRAPPER_TITLES);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structured event emitted while the sweep walks each repo. */
export type BackfillEvent =
  | { kind: "labelled"; repo: string; number: number }
  | {
    kind: "alert_rescued";
    repo: string;
    number: number;
    template: string;
  }
  | { kind: "already_labelled"; repo: string; number: number }
  | {
    kind: "skipped_deliberately_unlabelled";
    repo: string;
    number: number;
    removedBy: string;
  }
  | { kind: "error"; repo: string; message: string };

/** Aggregate outcome of a sweep. */
export interface BackfillSummary {
  labelled: Array<{ repo: string; number: number }>;
  alreadyLabelled: number;
  /**
   * Wrappers left alone because the timeline shows the `idle-task`
   * label was applied and later deliberately removed — an operator
   * re-triage, not a create-path drop.
   */
  deliberatelyUnlabelled: Array<{
    repo: string;
    number: number;
    removedBy: string;
  }>;
  errors: Array<{ repo: string; message: string }>;
}

/** Options accepted by {@link backfillIdleTaskLabels}. */
export interface BackfillIdleTaskLabelsOptions {
  /** Monitored repo slugs (`owner/name`). */
  repos: readonly string[];
  /**
   * Injectable gh CLI runner. Defaults to the production retry wrapper.
   * Tests inject a stub so the sweep never touches the network.
   */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Per-event sink. Defaults to a no-op. The CLI and the setup_cli
   * wrapper pass a callback that emits the structured `[backfill] ...`
   * log lines.
   */
  log?: (event: BackfillEvent) => void;
  /**
   * Injectable label-add function. Defaults to the production
   * REST-primary, CLI-fallback `addLabelToIssue`. Exposed so tests can
   * observe calls without stubbing gh twice.
   */
  addLabelFn?: (
    repo: string,
    issueNumber: number,
    label: string,
    deps: { ghCommandFn?: (args: string[]) => Promise<string> },
  ) => Promise<{ ok: true; value: void } | { ok: false; error: Error }>;
  /**
   * Injectable label-event timeline fetch for the deliberate-removal
   * guard. Defaults to the exhaustively paginated
   * `fetchCompleteTimeline` — the same source of truth the reserved-label
   * trust gate uses (Issue #3709: mutating callers must not act on a
   * page-1-only slice). Only consulted for wrappers missing the label,
   * so the steady-state sweep issues no extra API calls.
   */
  fetchTimelineFn?: (
    repo: string,
    issueNumber: number,
    ghCommandFn: (args: string[]) => Promise<string>,
  ) => Promise<TimelineLabelEventJson[] | null>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Sweep every repo in `opts.repos`, fetch open issues whose title matches
 * `Run a security scan`, and apply the `idle-task` label where missing.
 *
 * One transient gh failure on a single repo never aborts the rest of the
 * sweep — the per-repo error is captured in `summary.errors` and the
 * walk moves on to the next repo.
 */
export async function backfillIdleTaskLabels(
  opts: BackfillIdleTaskLabelsOptions,
): Promise<BackfillSummary> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const log = opts.log ?? (() => {});
  const addLabelFn = opts.addLabelFn ?? addLabelToIssue;
  const fetchTimelineFn = opts.fetchTimelineFn ??
    ((repo: string, issueNumber: number, ghFn: typeof gh) =>
      fetchCompleteTimeline(repo, issueNumber, ghFn));

  const summary: BackfillSummary = {
    labelled: [],
    alreadyLabelled: 0,
    deliberatelyUnlabelled: [],
    errors: [],
  };

  for (const repo of opts.repos) {
    // If a repo's gh queries are failing (e.g. HTTP 502, auth blip), it
    // is overwhelmingly likely all six title queries will fail the same
    // way. Short-circuit after the first failure so we record one error
    // per repo — matching the pre-#2322 per-repo error semantics —
    // rather than five duplicates.
    let repoFailed = false;

    for (const queriedTitle of IDLE_TASK_WRAPPER_TITLES) {
      if (repoFailed) break;

      let raw: string;
      try {
        raw = await gh([
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--search",
          `"${queriedTitle}" in:title`,
          "--json",
          "number,title,labels",
          "--limit",
          "50",
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push({ repo, message });
        log({ kind: "error", repo, message });
        repoFailed = true;
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const message = err instanceof Error
          ? `malformed gh JSON: ${err.message}`
          : `malformed gh JSON: ${String(err)}`;
        summary.errors.push({ repo, message });
        log({ kind: "error", repo, message });
        repoFailed = true;
        continue;
      }
      if (!Array.isArray(parsed)) continue;

      for (const item of parsed) {
        if (item === null || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const title = obj.title;
        const number = obj.number;
        const labels = obj.labels;
        if (typeof title !== "string") continue;
        const titleTrim = title.trim();
        // Defensive exact-match guard. `Run a security scan in /tmp` and
        // other partial matches from gh's `in:title` token query are
        // ignored; we also discard rows whose title matches a
        // different wrapper than the one this query targeted, so each
        // wrapper is processed exactly once per sweep.
        if (!TITLE_SET.has(titleTrim)) continue;
        if (titleTrim !== queriedTitle) continue;
        if (typeof number !== "number" || !Number.isFinite(number)) continue;

        const hasLabel = Array.isArray(labels) &&
          labels.some((l) =>
            l !== null && typeof l === "object" &&
            typeof (l as { name?: unknown }).name === "string" &&
            (l as { name: string }).name === IDLE_TASK_LABEL
          );

        if (hasLabel) {
          summary.alreadyLabelled++;
          log({ kind: "already_labelled", repo, number });
          continue;
        }

        // Deliberate-removal guard: an `unlabeled idle-task` event in the
        // timeline proves the create path applied the label, so this is an
        // operator re-triage, not the orphan this sweep exists to rescue.
        // Re-labelling would undo the operator's decision on every sweep
        // (the Issue #1878 re-add loop). An unreadable timeline fails
        // closed — no label written, error recorded, retried next sweep.
        let timeline: TimelineLabelEventJson[] | null;
        try {
          timeline = await fetchTimelineFn(repo, number, gh);
        } catch (err) {
          const message = err instanceof Error
            ? `timeline fetch failed for issue #${number}: ${err.message}`
            : `timeline fetch failed for issue #${number}: ${String(err)}`;
          summary.errors.push({ repo, message });
          log({ kind: "error", repo, message });
          continue;
        }
        if (timeline === null) {
          const message =
            `timeline unreadable for issue #${number} — rescue skipped, failing closed`;
          summary.errors.push({ repo, message });
          log({ kind: "error", repo, message });
          continue;
        }
        const removals = timeline.filter(
          (e) => e.event === "unlabeled" && e.label?.name === IDLE_TASK_LABEL,
        );
        if (removals.length > 0) {
          const removedBy = removals[removals.length - 1]?.actor?.login ??
            "unknown";
          summary.deliberatelyUnlabelled.push({ repo, number, removedBy });
          log({
            kind: "skipped_deliberately_unlabelled",
            repo,
            number,
            removedBy,
          });
          continue;
        }

        const res = await addLabelFn(repo, number, IDLE_TASK_LABEL, {
          ghCommandFn: gh,
        });
        if (res.ok) {
          summary.labelled.push({ repo, number });
          log({ kind: "labelled", repo, number });
          // Loud `[idle-task] ALERT ...` line so production logs surface
          // every create-path label drop (Issue #2322). The template
          // name is inferred from the matched title; `unknown` is
          // unreachable given the `TITLE_SET` guard above but kept as
          // belt-and-braces against future refactors.
          const template = TITLE_TO_TEMPLATE.get(titleTrim) ?? "unknown";
          log({ kind: "alert_rescued", repo, number, template });
        } else {
          const message = res.error.message;
          summary.errors.push({ repo, message });
          log({ kind: "error", repo, message });
        }
      }
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Structured log helpers (shared by the CLI command and setup_cli)
// ---------------------------------------------------------------------------

/** Render a single sweep event as the canonical `[backfill] ...` log line. */
export function formatBackfillEvent(event: BackfillEvent): string {
  switch (event.kind) {
    case "labelled":
      return `[backfill] repo=${event.repo} issue=${event.number} action=labelled`;
    case "alert_rescued": {
      const url = `https://github.com/${event.repo}/issues/${event.number}`;
      return `[idle-task] ALERT severity=warn action=backfill_rescued template=${event.template} repo=${event.repo} issue=${event.number} url=${url} — orphan wrapper missing idle-task label was rescued by the backfill sweep`;
    }
    case "already_labelled":
      return `[backfill] repo=${event.repo} issue=${event.number} action=already_labelled`;
    case "skipped_deliberately_unlabelled":
      return `[backfill] repo=${event.repo} issue=${event.number} action=skipped_deliberately_unlabelled removed_by=${event.removedBy} — idle-task label was deliberately removed after filing; leaving the re-triage in place`;
    case "error":
      return `[backfill] repo=${event.repo} action=error reason=${event.message}`;
    default:
      return assertNever(event);
  }
}

/** Render the summary line emitted at the end of the sweep. */
export function formatBackfillSummary(summary: BackfillSummary): string {
  return `[backfill] action=summary labelled=${summary.labelled.length} already=${summary.alreadyLabelled} deliberately_unlabelled=${summary.deliberatelyUnlabelled.length} errors=${summary.errors.length}`;
}
