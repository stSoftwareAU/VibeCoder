/**
 * Diagnostic issue for a repository backed off by fast failures (Issue #1950).
 *
 * `repo_fast_failure_tracker.ts` decides *that* a repository keeps failing
 * at setup; this module says so where a human will see it. Without it the
 * pattern was only ever visible in a hand-written weekly report — 47
 * sub-minute failures in one week, clustered in two repositories, and not
 * one issue filed.
 *
 * It follows the same filing policy as `run_failure_issue.ts`:
 *
 * - **The worker repository is the default target** — a repository failing
 *   in its first minute is a worker-side environment fault, and the
 *   affected repository is named in the body. `repo_config`'s
 *   `fast_failure_diagnostics_here` files it in the affected repository
 *   instead, for operators who want the report beside the code.
 * - **Dedup on a machine-readable body marker**, never the title:
 *   `<!-- VIBE_REPO_FAST_FAILURE:<owner/repo> -->`. A marker in a body is
 *   text anyone can write, so a match only counts when a fleet account
 *   authored it.
 * - **Best-effort, never throws.** This runs on the claim-release path, and
 *   a throw there leaves an issue assigned and unpickupable (incident
 *   #2648). Every decision is returned and logged instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { RepoConfig } from "../types.ts";
import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import type { RepoFastFailureState } from "./repo_fast_failure_tracker.ts";
import { getRepoConfig } from "./repo_config.ts";
import { RUN_FAILURE_TARGET_REPO } from "./run_failure_issue.ts";
import {
  recordSelfDiagnosticFiling,
  type SelfDiagnosticFiling,
} from "./self_diagnostic_attestation.ts";

/** Marker prefix; the body carries `<!-- VIBE_REPO_FAST_FAILURE:<repo> -->`. */
export const REPO_FAST_FAILURE_MARKER_PREFIX = "VIBE_REPO_FAST_FAILURE";

/** Self-diagnostic family id for issues this module files (Issue #1277). */
export const REPO_FAST_FAILURE_FAMILY_ID = "repo-fast-failure";

/** The marker a diagnostic issue for `repo` carries. */
export function formatRepoFastFailureMarker(repo: string): string {
  return `<!-- ${REPO_FAST_FAILURE_MARKER_PREFIX}:${repo} -->`;
}

/** Whether a body is a fast-failure diagnostic for `repo`. */
export function isRepoFastFailureIssue(body: string, repo: string): boolean {
  return (body ?? "").includes(formatRepoFastFailureMarker(repo));
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
 */
function safeForBody(text: string): string {
  return (text ?? "")
    .replace(/<!--/g, "<!- -")
    .replace(/-->/g, "- ->")
    .replace(/```/g, "'''");
}

/** Where a repository's diagnostic issue is filed. */
export function resolveRepoFastFailureTarget(
  repo: string,
  repoConfigs: Record<string, RepoConfig> | undefined,
): string {
  return getRepoConfig(repoConfigs, repo, "fastFailureDiagnosticsHere") ===
      "true"
    ? repo
    : RUN_FAILURE_TARGET_REPO;
}

/** Issue body: marker first, then the diagnosis a human needs. */
export function formatRepoFastFailureBody(
  state: RepoFastFailureState,
  policy: {
    threshold: number;
    windowSeconds: number;
    fastFailureSeconds: number;
  },
  machineId: string,
): string {
  const windowHours = Math.round(policy.windowSeconds / 3600);
  const until = state.backedOffUntil !== undefined
    ? new Date(state.backedOffUntil * 1000).toISOString()
    : "unknown";
  return [
    formatRepoFastFailureMarker(state.repo),
    "",
    `Auto-filed by the Vibe Coder (Issue #1950): **${state.repo}** recorded ` +
    `${state.count} fast failures in the last ${windowHours} h, so it is ` +
    `backed off until the window lapses or this issue is closed.`,
    "",
    `A *fast* failure ended before the agent produced output, or inside ` +
    `${policy.fastFailureSeconds}s — a claim or setup fault (missing ` +
    `toolchain, broken quality-gate bootstrap, credential or branch problem), ` +
    `not a property of the issues being claimed.`,
    "",
    `**Repository:** ${state.repo}`,
    `**Fast failures in window:** ${state.count} (threshold ${policy.threshold} in ${windowHours} h)`,
    `**Backed off until:** ${until}`,
    `**Failing phase:** \`${safeForBody(state.lastPhase ?? "unknown")}\``,
    `**Host:** \`${machineId}\``,
    "",
    "## Last error",
    "",
    "The last line of the failure that names a cause — git's own summary " +
    "lines are stepped over, so a refused push shows the refusal rather " +
    "than `failed to push some refs` (Issue #2034).",
    "",
    "```",
    safeForBody(state.lastDetail ?? "(no error captured)"),
    "```",
    "",
    "Closing this issue releases the back-off on the next scan; otherwise it " +
    "lapses on its own once the failures decay out of the window.",
  ].join("\n");
}

/** What the filing did. */
export type RepoFastFailureFilingDecision =
  | { action: "filed"; issueNumber: number; targetRepo: string }
  | { action: "exists"; issueNumber: number; targetRepo: string }
  | { action: "suppressed"; reason: "gh_failed" | "not_backed_off" };

export interface FileRepoFastFailureIssueOptions
  extends AlertDedupAuthorOptions {
  /** The backed-off repository's current state. */
  state: RepoFastFailureState;
  policy: {
    threshold: number;
    windowSeconds: number;
    fastFailureSeconds: number;
  };
  /** Machine / host id of the worker that recorded the failures. */
  machineId: string;
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Per-repo config, for `fast_failure_diagnostics_here`. */
  repoConfigs?: Record<string, RepoConfig>;
  /** Target repo override (tests). */
  targetRepo?: string;
  log?: (message: string) => void;
  /** Records the filing attestation (Issue #1277). Injected by tests. */
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
}

/**
 * File (or find) the one diagnostic issue for a backed-off repository.
 *
 * Never throws: the caller is the claim-release path. A GitHub failure is
 * returned as `suppressed:gh_failed` and counted as a fault event, so a
 * diagnostic that could not be filed is visible rather than silent.
 */
export async function fileRepoFastFailureIssue(
  opts: FileRepoFastFailureIssueOptions,
): Promise<RepoFastFailureFilingDecision> {
  const log = opts.log ?? (() => {});
  const repo = opts.state.repo;
  const decide = (
    decision: RepoFastFailureFilingDecision,
  ): RepoFastFailureFilingDecision => {
    log(
      `repo-fast-failure filing: ${decision.action}${
        decision.action === "suppressed"
          ? `:${decision.reason}`
          : `:#${decision.issueNumber}`
      } repo=${repo}`,
    );
    return decision;
  };

  if (!opts.state.backedOff) {
    return decide({ action: "suppressed", reason: "not_backed_off" });
  }

  const targetRepo = opts.targetRepo ??
    resolveRepoFastFailureTarget(repo, opts.repoConfigs);

  try {
    // 1. An open diagnostic a fleet account authored already covers this
    // repository — on this host or any sibling.
    try {
      const raw = await opts.ghFn([
        "issue",
        "list",
        "--repo",
        targetRepo,
        "--state",
        "open",
        "--search",
        `"${REPO_FAST_FAILURE_MARKER_PREFIX}:${repo}" in:body`,
        "--json",
        ALERT_DEDUP_JSON_FIELDS,
        "--limit",
        "20",
      ]);
      const list = JSON.parse(raw || "[]") as AlertDedupRow[];
      const verified = await selectFleetAuthoredMatches(
        list.filter((row) => isRepoFastFailureIssue(row.body ?? "", repo)),
        `repo-fast-failure ${repo}`,
        opts,
        log,
      );
      const match = verified.sort((a, b) => a.number - b.number)[0];
      if (match) {
        return decide({
          action: "exists",
          issueNumber: match.number,
          targetRepo,
        });
      }
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `repo fast-failure issue search failed (${repo}): ${err}`,
      );
      return decide({ action: "suppressed", reason: "gh_failed" });
    }

    // 2. None → file exactly one.
    // Built before the try: a refused label is a programming error and must
    // fail loud, not be reported as a `gh_failed` suppression.
    const labelArgs = guardedLabelArgs(
      ["bug"],
      "worker/deno/lib/repo_fast_failure_issue.ts",
    );
    const title = formatRepoFastFailureTitle(repo);
    const body = formatRepoFastFailureBody(
      opts.state,
      opts.policy,
      opts.machineId,
    );
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
      return decide({ action: "filed", issueNumber, targetRepo });
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `repo fast-failure issue create failed (${repo}): ${err}`,
      );
      return decide({ action: "suppressed", reason: "gh_failed" });
    }
  } catch (err) {
    // Belt and braces: the release path must never see an exception here.
    recordFaultEvent(
      "catch_block_warning",
      `repo fast-failure filing threw (${repo}): ${err}`,
    );
    return decide({ action: "suppressed", reason: "gh_failed" });
  }
}
