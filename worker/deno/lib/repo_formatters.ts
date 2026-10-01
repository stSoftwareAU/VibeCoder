/**
 * Repository-owned formatters, run and committed as one tidy-up (Issue #2967,
 * part of #2932).
 *
 * Runs `cargo fmt --all` once per outermost tracked `Cargo.toml` directory and
 * `deno fmt` once per outermost tracked `deno.json`/`deno.jsonc` directory,
 * then — if any tracked file differs afterwards — commits the result as one
 * `style: apply repository formatters` commit. This module is not yet wired
 * into the quality gate; it is a standalone building block.
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

/** Commit message stamped on the formatters' combined output. */
export const FORMATTER_COMMIT_MESSAGE = "style: apply repository formatters";

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

/**
 * Pick the outermost directories tracked config files live in.
 *
 * A nested `a/b/Cargo.toml` under an already-kept `a/Cargo.toml` is dropped —
 * `cargo fmt --all` at `a` already reaches it via the workspace — but
 * `webx/deno.json` is never treated as nested under a kept `web`.
 *
 * @param paths - Repo-relative paths, `/`-separated (as `git ls-files` prints).
 * @param configNames - Basenames that mark a formatter's root (e.g. `Cargo.toml`).
 */
export function outermostConfigDirs(
  paths: string[],
  configNames: readonly string[],
): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const base = slash === -1 ? path : path.slice(slash + 1);
    if (!configNames.includes(base)) continue;
    const dir = slash === -1 ? "." : path.slice(0, slash);
    dirs.add(dir === "" ? "." : dir);
  }
  const sorted = [...dirs].sort();
  const kept: string[] = [];
  for (const dir of sorted) {
    const hasKeptAncestor = kept.some((k) =>
      k === "." || dir.startsWith(`${k}/`)
    );
    if (!hasKeptAncestor) kept.push(dir);
  }
  return kept;
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
 * Run every applicable repository formatter and commit the combined result.
 *
 * `git add -u` also stages any uncommitted tracked edits already in the tree
 * — acceptable per the issue, since they would otherwise have become a WIP
 * commit anyway. Never throws: any unexpected failure is logged and reported
 * via `gitError` instead.
 */
export async function runRepoFormatters(
  repoPath: string,
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

    const cargoDirs = outermostConfigDirs(paths, ["Cargo.toml"]);
    const denoDirs = outermostConfigDirs(paths, ["deno.json", "deno.jsonc"]);
    if (cargoDirs.length === 0 && denoDirs.length === 0) {
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

    const steps: Array<{ tool: FormatterTool; dir: string; cmd: string[] }> = [
      ...cargoDirs.map((dir) => ({
        tool: "cargo fmt" as FormatterTool,
        dir,
        cmd: ["cargo", "fmt", "--all"],
      })),
      ...denoDirs.map((dir) => ({
        tool: "deno fmt" as FormatterTool,
        dir,
        cmd: ["deno", "fmt"],
      })),
    ];

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

    const add = await deps.runGitCommand(["add", "-u"], { cwd: repoPath });
    if (!add.ok || add.value.code !== 0) {
      const gitError = gitStepError("add -u", add)!;
      deps.logger.warn(`repo formatters: ${gitError}`);
      return { runs, failures, committed: false, gitError };
    }

    const message = appendRunIdTrailer(FORMATTER_COMMIT_MESSAGE, deps.runId());
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
