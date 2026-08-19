/**
 * Dependency-bump pre-quality phase (Issue #1613).
 *
 * If a repo provides a `bump-deps.sh` script at its root, the worker
 * runs it after content changes are made and before `quality.sh`.
 * The script's contract:
 *
 *   - Exit 0 → bump applied (or no-op when already current).
 *   - Exit non-zero → bump attempted and failed; the worker reverts any
 *     working-tree modifications and continues without the bump.
 *
 * On a successful, non-empty bump the worker commits the modified files
 * as a separate commit so the audit gate (in `quality_gate_remediation_phase`)
 * can revert it cheaply if quality only passes without it.
 *
 * Two environment variables are propagated into the script:
 *
 *   - `GH_TOKEN_HAS_WORKFLOW_SCOPE` — `"true"` or `"false"` so scripts
 *     touching `.github/workflows/` know whether to attempt those edits
 *     (Issue #1612).
 *   - `VIBE_BUMP_QUARANTINE_HOURS` — how recently external deps may
 *     have been published before they are eligible for bumping
 *     (default `24` hours).
 *
 * That window is not left on the honour system (Issue #3659): before the
 * bump is committed the worker verifies the ages of the versions the
 * script actually produced and rejects the bump when one was published
 * inside the window. A repo-supplied script no longer decides whether the
 * worker's own supply-chain policy applies.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { BumpAgeAuditResult } from "./bump_age_audit.ts";

// =============================================================================
// Types
// =============================================================================

/** Outcome of a single `bump-deps.sh` invocation. */
export interface BumpInfo {
  /**
   * What happened:
   * - `absent`             — repo has no `bump-deps.sh`; nothing was run.
   * - `noop`               — script ran cleanly and modified no files.
   * - `applied`            — script ran cleanly and the modifications
   *                           were committed.
   * - `rejected_by_script` — script exited non-zero; modifications were
   *                           reverted before the phase returned.
   * - `rejected_by_quarantine` — the bump introduced a dependency version
   *                           published inside `VIBE_BUMP_QUARANTINE_HOURS`;
   *                           modifications were reverted (Issue #3659).
   * - `rejected_by_audit`  — script applied a bump but the post-bump
   *                           quality gate only passed without it. Set
   *                           by the audit gate, not by this library.
   */
  status:
    | "absent"
    | "noop"
    | "applied"
    | "rejected_by_script"
    | "rejected_by_quarantine"
    | "rejected_by_audit";
  /** Files modified by the script (porcelain paths, deduplicated). */
  files: string[];
  /** Combined stdout+stderr captured from the script invocation. */
  output: string;
  /** Commit SHA of the bump commit. Only set when `status === "applied"`. */
  sha?: string;
  /**
   * HEAD SHA before the bump commit was created. Captured so the audit
   * gate can `git reset --hard` back to it without inspecting the log.
   * Only set when `status === "applied"`.
   */
  beforeBumpSha?: string;
  /** Human-readable rejection reason, suitable for a PR comment. */
  rejectionReason?: string;
}

/** Parameters for `runBumpDeps`. */
export interface BumpDepsParams {
  /** Absolute path to the repo working tree. */
  repoPath: string;
  /** Script filename relative to `repoPath`. Defaults to `bump-deps.sh`. */
  scriptName?: string;
  /**
   * Whether the active gh token carries the `workflow` OAuth scope.
   * Propagated as `GH_TOKEN_HAS_WORKFLOW_SCOPE`.
   */
  hasWorkflowScope?: boolean;
  /**
   * Quarantine window in hours for newly-published external deps.
   * Propagated as `VIBE_BUMP_QUARANTINE_HOURS`. Defaults to `24`.
   */
  quarantineHours?: number;
  /** Issue number, included in the bump commit message when supplied. */
  issueNumber?: number;
}

/** Injectable side-effects for `runBumpDeps`. */
export interface BumpDepsDeps {
  /** True when `path` exists and is a regular file. */
  fileExists: (path: string) => Promise<boolean>;
  /** Run the script, capturing combined stdout+stderr. */
  runScript: (
    cwd: string,
    scriptPath: string,
    env: Record<string, string>,
  ) => Promise<{ exitCode: number; output: string }>;
  /**
   * Return the list of files reported by `git status --porcelain` in
   * `cwd`. Should include both tracked-modified and untracked entries.
   */
  getModifiedFiles: (cwd: string) => Promise<string[]>;
  /**
   * Restore the working tree so none of `files` show as modified or
   * untracked. Used when the script rejects its own bump or when commit
   * fails.
   */
  revertWorkingTree: (cwd: string, files: string[]) => Promise<void>;
  /** Current HEAD SHA in `cwd`. */
  getHeadSha: (cwd: string) => Promise<Result<string>>;
  /**
   * Stage `files` and create a commit with `message`. Returns the new
   * HEAD SHA on success.
   */
  commitFiles: (
    cwd: string,
    files: string[],
    message: string,
  ) => Promise<Result<string>>;
  /**
   * Verify the release ages of the dependency versions the bump wrote
   * into `files`, against `quarantineHours` (Issue #3659). Must not
   * throw — a publish time a registry would not serve is reported as
   * indeterminate and does not block.
   *
   * A dependency change the audit cannot recognise at all — an
   * open-ended range, a tag, a foreign ecosystem's manifest, or a diff
   * it could not read — does block (Issue #3951): the embargo never got
   * to look at it, so it must not pass by silence.
   */
  auditBumpedVersions: (
    cwd: string,
    files: string[],
    quarantineHours: number,
  ) => Promise<BumpAgeAuditResult>;
}

// =============================================================================
// Helpers
// =============================================================================

/** Default name of the per-repo bump script. */
export const DEFAULT_BUMP_SCRIPT_NAME = "bump-deps.sh";

/** Default quarantine window in hours. */
export const DEFAULT_BUMP_QUARANTINE_HOURS = 24;

/** Build the bump commit message, optionally referencing an issue. */
export function buildBumpCommitMessage(issueNumber?: number): string {
  const suffix = issueNumber ? ` (Issue #${issueNumber})` : "";
  return `chore: bump dependencies via bump-deps.sh${suffix}`;
}

/** Comment heading per rejection status. */
const BUMP_REJECTION_HEADINGS = {
  rejected_by_script: "Dependency bump rejected by `bump-deps.sh`",
  rejected_by_quarantine:
    "Dependency bump rejected by the release-age quarantine",
  rejected_by_audit: "Dependency bump rejected by quality audit",
} as const;

/** Statuses that warrant a rejection comment. */
function isRejection(
  status: BumpInfo["status"],
): status is keyof typeof BUMP_REJECTION_HEADINGS {
  return status in BUMP_REJECTION_HEADINGS;
}

/**
 * Build the PR/issue comment summarising a bump rejection. Returns an
 * empty string for statuses that do not warrant a comment (`absent`,
 * `noop`, `applied`).
 */
export function buildBumpRejectionComment(info: BumpInfo): string {
  if (!isRejection(info.status)) {
    return "";
  }
  const heading = BUMP_REJECTION_HEADINGS[info.status];
  const reason = info.rejectionReason
    ? `\n\n**Reason:** ${info.rejectionReason}`
    : "";
  const filesBlock = info.files.length > 0
    ? `\n\n**Files the bump would have touched:**\n${
      info.files.map((f) => `- \`${f}\``).join("\n")
    }`
    : "";
  const tail = info.output.length > 0
    ? `\n\n<details><summary>bump-deps.sh output (last 4000 chars)</summary>\n\n\`\`\`\n${
      info.output.slice(-4000)
    }\n\`\`\`\n\n</details>`
    : "";
  return `### ${heading}${reason}${filesBlock}${tail}`;
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Run the per-repo bump-deps script and classify the outcome.
 *
 * Always returns a populated `BumpInfo` — never throws. Failures from
 * git or the script itself are folded into the `status`/`output` fields
 * so the calling phase can decide how to proceed.
 */
export async function runBumpDeps(
  params: BumpDepsParams,
  deps: BumpDepsDeps,
): Promise<BumpInfo> {
  const scriptName = params.scriptName ?? DEFAULT_BUMP_SCRIPT_NAME;
  const scriptPath = `${params.repoPath}/${scriptName}`;
  const quarantineHours = params.quarantineHours ??
    DEFAULT_BUMP_QUARANTINE_HOURS;

  if (!(await deps.fileExists(scriptPath))) {
    return { status: "absent", files: [], output: "" };
  }

  const env: Record<string, string> = {
    GH_TOKEN_HAS_WORKFLOW_SCOPE: params.hasWorkflowScope ? "true" : "false",
    VIBE_BUMP_QUARANTINE_HOURS: String(quarantineHours),
  };

  // Capture HEAD before running so we can record `beforeBumpSha` on
  // success — used by the audit gate to revert cheaply.
  const beforeShaResult = await deps.getHeadSha(params.repoPath);
  const beforeSha = beforeShaResult.ok ? beforeShaResult.value : undefined;

  const { exitCode, output } = await deps.runScript(
    params.repoPath,
    scriptPath,
    env,
  );

  if (exitCode !== 0) {
    const files = await deps.getModifiedFiles(params.repoPath);
    if (files.length > 0) {
      await deps.revertWorkingTree(params.repoPath, files);
    }
    return {
      status: "rejected_by_script",
      files,
      output,
      rejectionReason:
        `\`${scriptName}\` exited with status ${exitCode} — bump reverted.`,
    };
  }

  const files = await deps.getModifiedFiles(params.repoPath);
  if (files.length === 0) {
    return { status: "noop", files: [], output };
  }

  // Verify the window the script was *told* to honour was actually
  // honoured (Issue #3659). Reject before committing, never after.
  const ages = await deps.auditBumpedVersions(
    params.repoPath,
    files,
    quarantineHours,
  );
  if (!ages.ok) {
    await deps.revertWorkingTree(params.repoPath, files);
    return {
      status: "rejected_by_quarantine",
      files,
      output,
      rejectionReason: ages.reason,
    };
  }

  const message = buildBumpCommitMessage(params.issueNumber);
  const commit = await deps.commitFiles(params.repoPath, files, message);
  if (!commit.ok) {
    await deps.revertWorkingTree(params.repoPath, files);
    return {
      status: "rejected_by_script",
      files,
      output: `${output}\n\nCould not commit bump: ${commit.error.message}`,
      rejectionReason:
        `Could not commit bump produced by \`${scriptName}\`: ${commit.error.message}`,
    };
  }

  return {
    status: "applied",
    files,
    output,
    sha: commit.value,
    beforeBumpSha: beforeSha,
  };
}
