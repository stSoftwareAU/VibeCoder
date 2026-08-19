/**
 * Phase 3.5 — Dependency bump (Issue #1613).
 *
 * Slots between Phase 3 (Execute Claude) and Phase 4 (Quality Gate). If
 * the repository provides a `bump-deps.sh` at its root, run it once,
 * commit any modifications it produces, and stash the outcome on
 * `state.bumpInfo` so the quality-gate audit and the completion phase
 * can act on it.
 *
 * Backwards compatible: when no `bump-deps.sh` exists the phase is a
 * no-op and the worker behaves exactly as before.
 *
 * The script's environment carries:
 *   - `GH_TOKEN_HAS_WORKFLOW_SCOPE` — sourced from the same env var
 *     `run_core.sh` already exports (Issue #1612). Defaults to `false`.
 *   - `VIBE_BUMP_QUARANTINE_HOURS` — quarantine window for external
 *     publishes. Defaults to `24`.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import {
  type BumpDepsDeps,
  DEFAULT_BUMP_QUARANTINE_HOURS,
  runBumpDeps,
} from "../bump_deps.ts";
import {
  auditBumpDiff,
  type BumpAgeDeps,
  defaultBumpAgeDeps,
  unreadableBumpAgeAudit,
} from "../bump_age_audit.ts";
import { assertNever } from "../assert_never.ts";
import type { Result } from "../../types.ts";
import { detectTool } from "../quality_helpers.ts";
import { prependExecutableDir } from "../path_bootstrap.ts";

/**
 * Build the subprocess environment for `bump-deps.sh`, guaranteeing the
 * resolved `deno` binary's directory is on PATH (Issue #3532).
 *
 * On unattended launchd/cron hosts Deno is installed at `~/.deno/bin/deno`,
 * which the inherited PATH may not include. Per-repo bump scripts that
 * resolve `deno` from PATH (correctly, fail-loud per Issue #3234) would
 * then abort with "ERROR: deno is required" and the bump would be silently
 * reverted. Prepending the directory of the same `deno` the worker uses
 * keeps those scripts working.
 *
 * Pure and exported so the wiring is covered by a regression test.
 *
 * @param baseEnv - The inherited parent environment (e.g. `Deno.env.toObject()`).
 * @param bumpEnv - Bump-specific variables to layer on top.
 * @param denoPath - Absolute path to the resolved `deno`, or `undefined`
 *   when it could not be located (PATH is then left as inherited).
 */
export function buildBumpScriptEnv(
  baseEnv: Record<string, string>,
  bumpEnv: Record<string, string>,
  denoPath: string | undefined,
): Record<string, string> {
  const merged = { ...baseEnv, ...bumpEnv };
  if (denoPath) {
    merged.PATH = prependExecutableDir(merged.PATH ?? "", denoPath);
  }
  return merged;
}

/**
 * Build the production `BumpDepsDeps` from the worker `deps` aggregate.
 * Exposed as a separate function so phase tests can inject a stub.
 *
 * `ageDeps` resolves dependency publish times for the quarantine
 * verification (Issue #3659); tests inject a fake so the wiring is
 * covered with no network access.
 */
export function createBumpDepsRuntimeDeps(
  deps: WorkerDeps,
  ageDeps: BumpAgeDeps = defaultBumpAgeDeps(),
): BumpDepsDeps {
  return {
    fileExists: async (path: string): Promise<boolean> => {
      try {
        const stat = await Deno.stat(path);
        return stat.isFile;
      } catch {
        return false;
      }
    },

    runScript: async (cwd, scriptPath, env) => {
      try {
        // Resolve the same `deno` the worker uses and ensure its directory
        // is on PATH so per-repo bump scripts resolving `deno` from PATH
        // find it on unattended hosts (Issue #3532).
        const denoResult = await detectTool("deno");
        const denoPath = denoResult.ok ? denoResult.value : undefined;
        const proc = new Deno.Command("bash", {
          args: [scriptPath],
          cwd,
          stdout: "piped",
          stderr: "piped",
          stdin: "null",
          // Inherit the parent env then layer on the bump-specific values
          // (so the script still has PATH/HOME/etc.) and guarantee the
          // resolved deno's directory is on PATH.
          env: buildBumpScriptEnv(Deno.env.toObject(), env, denoPath),
        });
        const result = await proc.output();
        const stdout = new TextDecoder().decode(result.stdout);
        const stderr = new TextDecoder().decode(result.stderr);
        return { exitCode: result.code, output: stdout + stderr };
      } catch (err) {
        return {
          exitCode: 1,
          output: `Failed to spawn bump-deps.sh: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },

    getModifiedFiles: async (cwd: string): Promise<string[]> => {
      const status = await deps.git.runGitCommand(
        ["status", "--porcelain"],
        { cwd },
      );
      if (!status.ok) return [];
      const files = new Set<string>();
      for (const line of status.value.stdout.split("\n")) {
        if (line.length === 0) continue;
        // Porcelain format: "XY <path>" — XY is two-character status code.
        // For renames "XY orig -> new" we want the new path.
        const trimmed = line.slice(3);
        const arrow = trimmed.indexOf(" -> ");
        const path = arrow >= 0 ? trimmed.slice(arrow + 4) : trimmed;
        if (path.length > 0) files.add(path);
      }
      return [...files];
    },

    revertWorkingTree: async (cwd: string, files: string[]): Promise<void> => {
      if (files.length === 0) return;
      // Revert tracked modifications. Errors are non-fatal — `git clean`
      // below mops up any new untracked files the script left behind.
      await deps.git.runGitCommand(
        ["checkout", "--", ...files],
        { cwd },
      );
      // Remove untracked files the script may have created. Limit to
      // the listed paths so we never delete unrelated working-tree
      // content. `--` separates options from pathspecs.
      await deps.git.runGitCommand(
        ["clean", "-f", "--", ...files],
        { cwd },
      );
    },

    getHeadSha: async (cwd: string): Promise<Result<string>> => {
      const result = await deps.git.runGitCommand(
        ["rev-parse", "HEAD"],
        { cwd },
      );
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      const sha = result.value.stdout.trim();
      if (sha.length === 0) {
        return {
          ok: false,
          error: new Error("git rev-parse HEAD returned empty"),
        };
      }
      return { ok: true, value: sha };
    },

    commitFiles: async (
      cwd: string,
      files: string[],
      message: string,
    ): Promise<Result<string>> => {
      // Stage only the bump's own files. Avoid `git add -A` so we never
      // sweep in unrelated working-tree changes.
      const add = await deps.git.runGitCommand(
        ["add", "--", ...files],
        { cwd },
      );
      if (!add.ok) {
        return { ok: false, error: add.error };
      }
      const commit = await deps.git.runGitCommand(
        ["commit", "-m", message],
        { cwd },
      );
      if (!commit.ok) {
        return { ok: false, error: commit.error };
      }
      const head = await deps.git.runGitCommand(
        ["rev-parse", "HEAD"],
        { cwd },
      );
      if (!head.ok) {
        return { ok: false, error: head.error };
      }
      return { ok: true, value: head.value.stdout.trim() };
    },

    auditBumpedVersions: async (cwd, files, quarantineHours) => {
      // Diff the bump's own files against HEAD so only the versions this
      // bump introduced are checked (Issue #3659).
      const diff = await deps.git.runGitCommand(
        ["diff", "HEAD", "--", ...files],
        { cwd },
      );
      if (!diff.ok) {
        // Fail loud, fail closed (Issue #3951): a bump we cannot inspect
        // is refused, not reported as compliant.
        deps.logger.warn(
          "bump-deps: could not read the bump diff — bump refused",
          { error: diff.error.message },
        );
        return unreadableBumpAgeAudit(diff.error.message);
      }
      const result = await auditBumpDiff(
        diff.value.stdout,
        quarantineHours,
        ageDeps,
      );
      for (const verdict of result.indeterminate) {
        deps.logger.warn("bump-deps: release age unverified", {
          reason: verdict.reason,
        });
      }
      for (const line of result.unverifiable) {
        deps.logger.warn("bump-deps: dependency change refused", {
          file: line.file,
          reason: line.reason,
        });
      }
      return result;
    },
  };
}

/**
 * Resolve `GH_TOKEN_HAS_WORKFLOW_SCOPE` from the environment exported by
 * `run_core.sh`. Treats anything other than `"true"` (case-insensitive)
 * as `false` — including the unset case — so a missing scope never
 * accidentally lets a script attempt workflow edits.
 */
function readWorkflowScopeFromEnv(): boolean {
  const raw = Deno.env.get("GH_TOKEN_HAS_WORKFLOW_SCOPE");
  return typeof raw === "string" && raw.toLowerCase() === "true";
}

/**
 * Resolve the quarantine window (hours) from the environment. Falls
 * back to the documented default when the env var is unset, empty, or
 * not a positive integer.
 *
 * Issue #3649 / #3659 (SEC-a6cf30184e72): the guard rejected only
 * `parsed < 0`, so `VIBE_BUMP_QUARANTINE_HOURS=0` silently switched the
 * external supply-chain embargo off and propagated that to `bump-deps.sh`.
 * `parseInt` also swallowed trailing garbage, so `"0.5"` and `"0abc"` were
 * two more routes to the same zero. Only a bare positive integer is now
 * accepted; everything else is rejected loudly.
 */
function readQuarantineHoursFromEnv(): number {
  const raw = Deno.env.get("VIBE_BUMP_QUARANTINE_HOURS");
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_BUMP_QUARANTINE_HOURS;
  }
  const parsed = /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(
      `[bump-deps] Ignoring VIBE_BUMP_QUARANTINE_HOURS="${raw}" — the ` +
        `window must be a positive whole number of hours. Falling back to ` +
        `${DEFAULT_BUMP_QUARANTINE_HOURS}h so the external dependency ` +
        `embargo is not silently disabled.`,
    );
    return DEFAULT_BUMP_QUARANTINE_HOURS;
  }
  return parsed;
}

/**
 * Run the per-repo bump-deps script (if present) and record the outcome
 * on `state.bumpInfo` for downstream phases. Always returns
 * `{ status: "continue" }` — bump failures are surfaced via PR comment
 * by the completion phase rather than aborting the worker run.
 */
export async function workOnIssueBumpDeps(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  bumpDeps: BumpDepsDeps = createBumpDepsRuntimeDeps(deps),
): Promise<PhaseResult> {
  const info = await runBumpDeps(
    {
      repoPath: state.repoPath,
      hasWorkflowScope: readWorkflowScopeFromEnv(),
      quarantineHours: readQuarantineHoursFromEnv(),
      issueNumber: ctx.issueNumber,
    },
    bumpDeps,
  );

  state.bumpInfo = info;

  switch (info.status) {
    case "absent":
      // Backwards compatible — no script means no-op.
      break;
    case "noop":
      deps.logger.info("bump-deps: script ran with no changes");
      break;
    case "applied":
      deps.logger.info("bump-deps: bump committed", {
        files: info.files.length,
        sha: info.sha,
      });
      break;
    case "rejected_by_script":
      deps.logger.warn("bump-deps: script rejected the bump", {
        reason: info.rejectionReason,
        files: info.files.length,
      });
      break;
    case "rejected_by_quarantine":
      deps.logger.warn(
        "bump-deps: bump reverted — a dependency was published inside the " +
          "quarantine window",
        { reason: info.rejectionReason, files: info.files.length },
      );
      break;
    case "rejected_by_audit":
      // Set later by the quality-gate audit, never by this phase.
      break;
    default:
      assertNever(info.status);
  }

  return { status: "continue" };
}
