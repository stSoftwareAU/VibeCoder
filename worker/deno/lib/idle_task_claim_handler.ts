/**
 * Idle-task claim handler.
 *
 * Routes an issue that is identifiable as an idle-task scan *wrapper*
 * through the matching template's `runTask` instead of the standard
 * Claude-driven flow. An issue that is NOT a recognised wrapper falls
 * through (`handled: false`) so the caller runs it through the standard
 * issue→PR pipeline — `idle-task` is just the lowest of the four
 * work-trigger priorities (`top-priority` > `work-on` > `low-priority` >
 * `idle-task`), so a plain `idle-task` finding or work item is worked
 * like any other issue, only later.
 *
 * Issue #2077: filed wrappers are human-style — no hidden marker. The
 * handler dispatches by matching the issue title against each
 * registered template's `buildIssueTitle(repo)`. A human can paste the
 * security-scan prompt verbatim into a fresh issue titled
 * `Run a security scan` and apply the `idle-task` label; the worker
 * runs it exactly as if the worker had filed the wrapper itself.
 *
 * Issue #2083 regression guard: an issue is treated as an idle-task
 * wrapper when EITHER its labels include `idle-task` OR its title
 * matches a registered template. The label-only check used to be the
 * single signal — if the `idle-task` label was missing (race with the
 * label-sync layer, human-filed wrapper not yet labelled, or a tool
 * stripping operational labels) the wrapper fell through to the
 * standard issue worker, which obediently built a PR from a prompt
 * whose body began with "Must not modify the codebase". Title-based
 * fallback closes that loophole so a security-scan wrapper can never
 * raise a PR no matter how the labels arrived.
 *
 * Issue #2087 adds a body-fingerprint check as a third signal — when
 * a registered template implements `matchesIdleTaskBody(body)` and it
 * returns true, the issue routes through that template. This protects
 * against wrappers that have lost both their label AND their title
 * (e.g. a stale worker filed an older-format wrapper, then a human
 * renamed the issue, then the label-sync layer stripped `idle-task`).
 *
 * The handler never throws — every failure mode (no matching template,
 * runTask exception or failure) logs a structured warning and returns
 * `{ handled: true }` so the worker still closes the issue and the
 * queue does not block.
 *
 * Issue closure itself is the caller's responsibility.
 *
 * Australian English spelling used throughout (behaviour,
 * organisation, etc.).
 */

import type { Logger } from "../types.ts";
import {
  type IdleTaskRunResult,
  type IdleTaskTemplate,
  listTemplates as defaultListTemplates,
} from "./idle_task_template.ts";
import {
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "./write_repo_allowlist.ts";
import { parseWrapperModelTier } from "./idle_task_model_tier.ts";
import { withIdleTaskRunContext } from "./idle_task_claude_budget.ts";

// Importing the bundled templates for their registration side-effect
// keeps the production set wired up regardless of which call site
// reaches this module first. Issue #2256 added `github-actions-audit`
// as the fourth template; Issue #2398 added `supply-chain-readiness`
// as the fifth; Issue #2904 added `orphan-deps` as the sixth; Issue
// #2930 added the four Boy Scout templates (dead-code, doc-coverage,
// format-drift, deprecated-api) so a claimed Boy Scout wrapper routes
// to its `runTask()`; Issue #3228 added `bash-script-refs`; Issue #3238
// added `bash-syntax-audit` as the twelfth template; Issue #3319 added
// `documentation-audit` as the thirteenth; Issue #3394 added `alert-feed`
// as the fourteenth; Issue #3488 added `workflow-annotation-scan` as the
// fifteenth; Issue #3549 added `private-repo-reference-audit` as the
// sixteenth (public-repos-only); Issue #3609 added `duplicated-knowledge`
// as the seventeenth.
import "./idle_task_templates/security_scan_template.ts";
import "./idle_task_templates/best_practices_template.ts";
import "./idle_task_templates/test_audit_template.ts";
import "./idle_task_templates/github_actions_audit_template.ts";
import "./idle_task_templates/supply_chain_readiness_template.ts";
import "./idle_task_templates/orphan_deps_template.ts";
import "./idle_task_templates/dead_code_template.ts";
import "./idle_task_templates/doc_coverage_template.ts";
import "./idle_task_templates/format_drift_template.ts";
import "./idle_task_templates/deprecated_api_template.ts";
import "./idle_task_templates/bash_script_refs_template.ts";
import "./idle_task_templates/bash_syntax_audit_template.ts";
import "./idle_task_templates/documentation_audit_template.ts";
import "./idle_task_templates/alert_feed_template.ts";
import "./idle_task_templates/workflow_annotation_scan_template.ts";
import "./idle_task_templates/private_repo_reference_template.ts";
import "./idle_task_templates/duplicated_knowledge_template.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input for {@link handleIdleTaskIssue}. */
export interface HandleIdleTaskIssueOptions {
  /** `owner/repo` of the claimed issue. */
  repo: string;
  /** Issue number of the claimed idle-task issue. */
  issueNumber: number;
  /** Title of the claimed issue — used for template dispatch (Issue #2077). */
  issueTitle: string;
  /** Labels attached to the claimed issue. */
  issueLabels: string[];
  /** Body of the claimed issue — retained for forward compatibility. */
  issueBody: string;
  /** Working directory passed through to the template runner. */
  workDir: string;
  /**
   * Epoch-ms deadline of the current cycle (Issue #186). When supplied, the
   * scan's Claude budget is bounded to the runway left instead of the flat
   * hour — a wrapper claimed minutes before the deadline must not hold its
   * slot for the next 55. Optional: the `work-on-issue` CLI path, which has
   * no cycle, omits it and the scan keeps the full idle-task budget.
   */
  cycleDeadlineEpochMs?: number;
}

/** Structured outcome from {@link handleIdleTaskIssue}. */
export interface HandleIdleTaskIssueResult {
  /**
   * `false` when the issue is not a recognised scan wrapper (its title
   * and body match no registered template) — the caller should fall
   * through to the standard issue→PR processor and work it as an
   * ordinary, lowest-priority issue. `true` when the handler took
   * ownership and ran a template (whether the runner succeeded or not).
   */
  handled: boolean;
  /**
   * Human-readable summary suitable for posting back as a closing
   * comment on the idle-task issue. Always populated when
   * `handled === true`.
   */
  summary?: string;
  /**
   * Whether `runTask` returned `ok: true`. Only meaningful when
   * `handled === true`.
   */
  ok?: boolean;
}

/** Injectable dependencies. Defaults wire up the production registry. */
export interface HandleIdleTaskIssueDeps {
  logger: Logger;
  /** List all registered templates. Defaults to the production registry. */
  listTemplatesFn?: () => IdleTaskTemplate[];
}

// ---------------------------------------------------------------------------
// Wrapper identification
// ---------------------------------------------------------------------------

/**
 * Find the registered template a claimed issue belongs to, or `undefined`
 * when the issue is not a recognised scan wrapper.
 *
 * Dispatch is by title first (Issue #2077 — the first template whose
 * `buildIssueTitle(repo)` matches), then by body fingerprint (Issue #2087 —
 * `matchesIdleTaskBody`) for wrappers that have lost both label and title.
 *
 * Exported (Issue #179) so a caller can tell a wrapper from ordinary work
 * *before* running it — the production route needs that to ensure the repo's
 * local clone exists before the template walks its tree. Pure: no side
 * effects, safe to call twice.
 */
export function findIdleTaskTemplate(
  opts: { repo: string; issueTitle: string; issueBody: string },
  listTemplatesFn: () => IdleTaskTemplate[] = defaultListTemplates,
): IdleTaskTemplate | undefined {
  const wantedTitle = opts.issueTitle.trim();
  for (const t of listTemplatesFn()) {
    if (t.buildIssueTitle(opts.repo).trim() === wantedTitle) return t;
  }
  for (const t of listTemplatesFn()) {
    if (t.matchesIdleTaskBody?.(opts.issueBody) === true) return t;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Route an issue through the idle-task template runner.
 *
 * Flow:
 *   1. Find the first registered template whose `buildIssueTitle(repo)`
 *      matches the claimed issue's title; failing that, the first whose
 *      `matchesIdleTaskBody(body)` returns true.
 *   2. No template match → pass through (`handled: false`) so the caller
 *      runs the standard issue→PR pipeline. The issue is ordinary
 *      lowest-priority work, not a scan wrapper.
 *   3. Template match → call `template.runTask` and surface its result.
 *      Exceptions are caught and converted into a
 *      `{ handled: true, ok: false }` outcome so the queue never blocks.
 */
export async function handleIdleTaskIssue(
  opts: HandleIdleTaskIssueOptions,
  deps: HandleIdleTaskIssueDeps,
): Promise<HandleIdleTaskIssueResult> {
  const { repo, issueNumber, issueTitle, issueBody, workDir } = opts;
  const { cycleDeadlineEpochMs } = opts;
  const listTemplates = deps.listTemplatesFn ?? defaultListTemplates;

  // Issue #2077: dispatch by title. The first template whose
  // `buildIssueTitle(repo)` matches the claimed issue's title wins.
  // Issue #2087: when no title match, fall back to body fingerprint —
  // a template may declare `matchesIdleTaskBody(body)` to claim
  // wrappers that have lost both their label and their title.
  const template = findIdleTaskTemplate(
    { repo, issueTitle, issueBody },
    listTemplates,
  );

  // Route to a scan template only when the issue is identifiable as a
  // registered wrapper — its title matches `buildIssueTitle(repo)` or
  // its body matches `matchesIdleTaskBody`. Everything else falls
  // through (`handled: false`) to the standard issue→PR pipeline,
  // because `idle-task` is just the lowest work-trigger priority, not a
  // scan-only marker: a plain `idle-task` finding or work item is
  // worked like any other issue.
  //
  // The label alone no longer forces wrapper handling. The wrapper-
  // identity signals (title + body fingerprint) still keep a genuine
  // scan wrapper out of the PR flow even if its `idle-task` label was
  // stripped (Issue #2083 / #2087) — all seventeen templates implement
  // `matchesIdleTaskBody`, so a real wrapper is always recognised by
  // its body even with a mangled title.
  if (template === undefined) {
    return { handled: false };
  }

  // Issue #3311 — egress containment. An idle-scan run writes its findings
  // to the scanned repo (cwd = target clone), so seed the per-run write-repo
  // allowlist with that repo before the template performs any GitHub write.
  seedWriteRepoAllowlist(repo);

  // Issue #4010 — the tier a cadence-biased wrapper was filed for travels in
  // the wrapper body (the filer and this claim are different runs). An
  // unstamped or unrecognised stamp yields undefined, and the run keeps its
  // template/phase default exactly as before.
  const modelTier = parseWrapperModelTier(issueBody, {
    logger: deps.logger,
    context: { repo, issueNumber, template: template.name },
  });

  let result: IdleTaskRunResult;
  try {
    // Issue #186 — the cycle deadline and the worker logger reach the scan's
    // Claude invocation as an ambient run context rather than as arguments
    // threaded through every template: a template cannot forget to pass what
    // it never sees, and the bound therefore holds for templates added later.
    result = await withIdleTaskRunContext(
      {
        ...(cycleDeadlineEpochMs !== undefined ? { cycleDeadlineEpochMs } : {}),
        logger: deps.logger,
      },
      () =>
        template.runTask({
          repo,
          workDir,
          idleTaskIssueNumber: issueNumber,
          ...(modelTier !== undefined ? { modelTier } : {}),
        }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn("idle-task runTask threw", {
      repo,
      issueNumber,
      template: template.name,
      error: message,
    });
    return {
      handled: true,
      ok: false,
      summary: `idle-task ${template.name} runTask threw: ${message}`,
    };
  } finally {
    // Issue #3311 — deactivate the allowlist so enforcement does not leak
    // past the idle-task run into the main loop's cross-repo maintenance.
    resetWriteRepoAllowlist();
  }

  if (!result.ok) {
    deps.logger.warn("idle-task runTask failed", {
      repo,
      issueNumber,
      template: template.name,
      summary: result.summary,
    });
  } else {
    deps.logger.info("idle-task runTask complete", {
      repo,
      issueNumber,
      template: template.name,
      summary: result.summary,
    });
  }

  return {
    handled: true,
    ok: result.ok,
    summary: result.summary,
  };
}
