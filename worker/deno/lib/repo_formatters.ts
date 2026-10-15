/**
 * Repository-owned formatters, run and committed as one tidy-up (Issue #2967,
 * part of #2932), wired into the issue run before its gates.
 *
 * A PR sent back by review, or failed by CI, for a formatting-only miss costs
 * a whole round of tokens. {@link formatBranchChanges} lists the files the
 * branch changed — the same non-merge commits ahead of the PR base that the
 * pre-push gate checks — and {@link runRepoFormatters} runs the repository's
 * own formatters over exactly what that gate's `deno fmt --check` and `cargo
 * fmt --check` would flag (`planFormatterFixes` in `pre_push_gate.ts`): `deno
 * fmt` on the changed code files under each outermost tracked `deno.json` /
 * `deno.jsonc` that its fmt scope covers, and `cargo fmt --all` in each
 * outermost tracked `Cargo.toml` directory whose `.rs` files changed. If any
 * tracked file differs afterwards, the formatted paths are committed as one
 * `style: apply repository formatters` commit.
 *
 * Markdown is never handed to `deno fmt`: it re-wraps whole documents and
 * trips markdownlint MD018. A Markdown miss is left to the check to report.
 *
 * Callers: the quality-gate phase, before every `./quality.sh` attempt, and
 * the completion phase's `gateBeforePush()`, before every pre-push gate run.
 * A formatter that is missing or fails never fails the run on its own: it is
 * logged, and the gate that follows still runs and reports the problem. The
 * PR feedback and CI-fix push paths do not run it yet.
 */

import {
  createDefaultDeps,
  type QualityGateDeps,
} from "./quality_gate_phase.ts";
import {
  type GitCommandOptions,
  type GitCommandOutput,
  runGitCommand,
} from "./git_timeout.ts";
import { defaultLogger } from "./logger.ts";
import type { Logger, Result } from "../types.ts";
import { redactedTail } from "./redacted_text.ts";
import { appendRunIdTrailer, getRunId } from "./run_id.ts";
import {
  listPushedFiles,
  loadDenoScopes,
  planFormatterFixes,
  type PrePushGit,
} from "./pre_push_gate.ts";

export { outermostConfigDirs } from "./pre_push_gate.ts";

/** Commit message stamped on the formatters' combined output. */
export const FORMATTER_COMMIT_MESSAGE = "style: apply repository formatters";

/** Body of that commit, saying why the worker made it. */
const FORMATTER_COMMIT_BODY =
  "Formatted the files this branch changed with the repository's own " +
  "formatters before the worker's gates, so a formatting-only miss is " +
  "fixed rather than failed.";

/** A formatter this module knows how to run. */
export type FormatterTool = "cargo fmt" | "deno fmt";

/** Outcome of a single formatter invocation in a single directory. */
export interface FormatterRun {
  tool: FormatterTool;
  /** Repo-relative directory; "." for the root. */
  dir: string;
  exitCode: number;
  /** True when tracked files differ after this formatter ran. */
  changed: boolean;
  /** Redacted output tail; present only when exitCode !== 0. */
  excerpt?: string;
}

/** Outcome of running every applicable formatter across the repository. */
export interface RepoFormattersResult {
  runs: FormatterRun[];
  /** Runs that exited non-zero (includes a missing binary). */
  failures: FormatterRun[];
  committed: boolean;
  /** Set when a git step failed; the function never throws. */
  gitError?: string;
}

/** Injectable dependencies for {@link runRepoFormatters}. */
export interface RepoFormatterDeps {
  runCommand: QualityGateDeps["runCommand"];
  runGitCommand: (
    args: string[],
    options?: GitCommandOptions,
  ) => Promise<Result<GitCommandOutput>>;
  logger: Logger;
  /** Run id stamped as the commit's trailer. */
  runId: () => string;
}

/** Real dependencies: the worker's own command runner, git and logger. */
export function createRepoFormatterDeps(): RepoFormatterDeps {
  return {
    runCommand: createDefaultDeps().runCommand,
    runGitCommand,
    logger: defaultLogger,
    runId: () => getRunId(),
  };
}

/** Join a repo-relative directory onto an absolute repo path. */
function resolveDir(repoPath: string, dir: string): string {
  return dir === "." ? repoPath : `${repoPath}/${dir}`;
}

/**
 * Describe why a git step failed, or `undefined` when it succeeded.
 *
 * `step` names the operation for the message (e.g. `"ls-files"`); stderr is
 * run through {@link redactedTail} so a credential a failing git call echoes
 * never reaches a log line.
 */
function gitStepError(
  step: string,
  result: Result<GitCommandOutput>,
): string | undefined {
  if (!result.ok) return result.error.message;
  if (result.value.code === 0) return undefined;
  return `git ${step} failed (exit ${result.value.code}): ${
    redactedTail(result.value.stderr, 500)
  }`;
}

/** Snapshot of the tracked tree, used to detect whether a formatter changed it. */
async function snapshot(
  repoPath: string,
  deps: RepoFormatterDeps,
): Promise<Result<string>> {
  const result = await deps.runGitCommand(
    ["diff", "--no-ext-diff", "--binary"],
    { cwd: repoPath },
  );
  if (!result.ok) return result;
  const error = gitStepError("diff", result);
  if (error !== undefined) return { ok: false, error: new Error(error) };
  return { ok: true, value: result.value.stdout };
}

/**
 * Run the repository's formatters over `changed` and commit the result.
 *
 * Only the files a changed-file check (`planChangedFileChecks`) would flag
 * are formatted — see `planFormatterFixes`: never Markdown, never an
 * untouched code file under `deno fmt`, and `cargo fmt --all` only for a
 * cargo root whose `.rs` files changed. Only those paths are staged (`git add
 * -u -- <paths>`), so an unrelated edit elsewhere in the tree stays out of the
 * commit; an uncommitted edit already in a formatted file does go in with it.
 * Never throws: any unexpected failure is logged and reported via `gitError`
 * instead, and a formatter that fails is logged and recorded in `failures` —
 * the caller's own check still runs and reports what was left unfixed.
 *
 * @param changed - Repo-relative paths the run changed (as `git log
 *   --name-only` prints them).
 */
export async function runRepoFormatters(
  repoPath: string,
  changed: readonly string[],
  deps: RepoFormatterDeps = createRepoFormatterDeps(),
): Promise<RepoFormattersResult> {
  try {
    const lsFiles = await deps.runGitCommand(["ls-files", "-z"], {
      cwd: repoPath,
    });
    if (!lsFiles.ok || lsFiles.value.code !== 0) {
      const gitError = gitStepError("ls-files", lsFiles)!;
      deps.logger.warn(`repo formatters: ${gitError}`);
      return { runs: [], failures: [], committed: false, gitError };
    }
    const paths = lsFiles.value.stdout.split("\0").filter((p) => p.length > 0);

    const steps = planFormatterFixes(
      changed,
      paths,
      await loadDenoScopes(repoPath, paths),
    );
    if (steps.length === 0) {
      return { runs: [], failures: [], committed: false };
    }

    const initialSnapshot = await snapshot(repoPath, deps);
    if (!initialSnapshot.ok) {
      const gitError = initialSnapshot.error.message;
      deps.logger.warn(`repo formatters: ${gitError}`);
      return { runs: [], failures: [], committed: false, gitError };
    }

    const runs: FormatterRun[] = [];
    const failures: FormatterRun[] = [];
    let before = initialSnapshot.value;

    for (const step of steps) {
      const { exitCode, output } = await deps.runCommand(step.cmd, {
        stdin: "null",
        cwd: resolveDir(repoPath, step.dir),
      });
      const after = await snapshot(repoPath, deps);
      const changed = after.ok ? after.value !== before : false;

      const run: FormatterRun = {
        tool: step.tool,
        dir: step.dir,
        exitCode,
        changed,
        ...(exitCode !== 0 ? { excerpt: redactedTail(output, 500) } : {}),
      };
      runs.push(run);

      if (exitCode === 0) {
        deps.logger.info(
          `Formatter ${step.tool} in ${step.dir}: exit ${exitCode}, ${
            changed ? "files changed" : "no changes"
          }`,
        );
      } else {
        failures.push(run);
        deps.logger.warn(
          `Formatter ${step.tool} in ${step.dir}: exit ${exitCode}, ${
            changed ? "files changed" : "no changes"
          } — ${run.excerpt}`,
        );
      }

      // A snapshot that failed mid-loop must not be silently read as "no
      // change" — the tree's real state afterwards is unknown, so staging and
      // committing on a stale `before` risks folding an unrelated or missing
      // change into the formatters' commit. Fail loud instead.
      if (!after.ok) {
        const gitError = after.error.message;
        deps.logger.warn(`repo formatters: ${gitError}`);
        return { runs, failures, committed: false, gitError };
      }
      before = after.value;
    }

    if (before === initialSnapshot.value) {
      return { runs, failures, committed: false };
    }

    const pathspecs = [...new Set(steps.flatMap((step) => step.paths))]
      .map((path) => `:(literal)${path}`);
    const add = await deps.runGitCommand(["add", "-u", "--", ...pathspecs], {
      cwd: repoPath,
    });
    if (!add.ok || add.value.code !== 0) {
      const gitError = gitStepError("add -u", add)!;
      deps.logger.warn(`repo formatters: ${gitError}`);
      return { runs, failures, committed: false, gitError };
    }

    // The body keeps the trailer in a paragraph of its own: the subject reads
    // as a `Key: value` line, so the trailer would otherwise join it.
    const message = appendRunIdTrailer(
      `${FORMATTER_COMMIT_MESSAGE}\n\n${FORMATTER_COMMIT_BODY}`,
      deps.runId(),
    );
    const commit = await deps.runGitCommand(["commit", "-m", message], {
      cwd: repoPath,
    });
    if (!commit.ok || commit.value.code !== 0) {
      const gitError = gitStepError("commit", commit)!;
      deps.logger.warn(`repo formatters: ${gitError}`);
      return { runs, failures, committed: false, gitError };
    }

    deps.logger.info("repo formatters: committed formatter output");
    return { runs, failures, committed: true };
  } catch (error: unknown) {
    const gitError = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`repo formatters: unexpected error: ${gitError}`);
    return { runs: [], failures: [], committed: false, gitError };
  }
}

/**
 * Run the formatters over every file the branch changed, then commit.
 *
 * The file list is the pre-push gate's own (`listPushedFiles`): every
 * non-merge commit ahead of `baseRef`, or — when the PR base could not be
 * resolved — every commit on no remote-tracking ref, so the formatters and
 * the gate that follows always agree on scope. Files merged in from the base
 * are never reformatted. Never throws.
 */
export async function formatBranchChanges(
  repoPath: string,
  baseRef: string | undefined,
  deps: RepoFormatterDeps = createRepoFormatterDeps(),
): Promise<RepoFormattersResult> {
  try {
    const git: PrePushGit = async (args, cwd) => {
      const result = await deps.runGitCommand(args, { cwd });
      if (!result.ok) {
        return { code: 1, stdout: "", stderr: result.error.message };
      }
      return result.value;
    };
    const changed = await listPushedFiles(
      [{
        localRef: "HEAD",
        localSha: "HEAD",
        remoteRef: "HEAD",
        remoteSha: "0".repeat(40),
      }],
      repoPath,
      git,
      baseRef,
    );
    if (!changed.ok) {
      deps.logger.warn(`repo formatters: ${changed.error}`);
      return {
        runs: [],
        failures: [],
        committed: false,
        gitError: changed.error,
      };
    }
    if (changed.value.length === 0) {
      return { runs: [], failures: [], committed: false };
    }
    return await runRepoFormatters(repoPath, changed.value, deps);
  } catch (error: unknown) {
    const gitError = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`repo formatters: unexpected error: ${gitError}`);
    return { runs: [], failures: [], committed: false, gitError };
  }
}

/**
 * The issue run's call site: format the branch's changes before a gate runs.
 *
 * Never throws and returns nothing the caller must act on — a formatter that
 * is missing, fails or throws is logged here, and the gate that follows still
 * runs and reports whatever is left unfixed.
 */
export async function formatBeforeGate(
  deps: {
    git: { formatBranchChanges: typeof formatBranchChanges };
    logger: Logger;
  },
  repoPath: string,
  baseRef: string | undefined,
): Promise<void> {
  try {
    const result = await deps.git.formatBranchChanges(repoPath, baseRef);
    if (result.committed) {
      deps.logger.info(
        `Formatted the branch's changed files before the gate ` +
          `(${FORMATTER_COMMIT_MESSAGE})`,
      );
    }
  } catch (error: unknown) {
    deps.logger.warn(
      `repo formatters: skipped before the gate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
