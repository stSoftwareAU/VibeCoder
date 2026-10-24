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
 * Markdown outside the worker's own archive is never handed to `deno fmt`:
 * it re-wraps whole documents and trips markdownlint MD018, so a Markdown
 * miss there is left to the check to report. After those formatters,
 * {@link formatBeforeGate} formats the Markdown and JSON the branch changed
 * under `docs/archive/pr-summaries/` and `docs/archive/handover/` only.
 * `docs/archive/` is excluded from the markdownlint globs, so that wrap does
 * not trip MD018.
 *
 * Callers: the quality-gate phase, before every `./quality.sh` attempt; the
 * completion phase's `gateBeforePush()`, before every pre-push gate run; and
 * the PR-feedback and CI-fix processors, as `commitAndPushPending`'s Step 1a
 * hook between its commit and its Step 1b gate (scoped, like that gate, to
 * the commits on no remote). A formatter that is missing or fails never fails
 * the run on its own: it is logged, and the gate that follows still runs and
 * reports the problem.
 */

import {
  type QualityGateDeps,
  runCommandAsWorker,
} from "./quality_gate_phase.ts";
import {
  type GitCommandOptions,
  type GitCommandOutput,
  runGitCommand,
} from "./git_timeout.ts";
import { defaultLogger } from "./logger.ts";
import type { Logger, Result } from "../types.ts";
import { redactedHeadTail, redactedTail } from "./redacted_text.ts";
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
  /**
   * Redacted head and tail of the formatter's output; present only when
   * exitCode !== 0. The head is kept because `cargo fmt` prints the error
   * and then a long usage text (Issue #4113).
   */
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

/**
 * Real dependencies: git, the logger, and a command runner that stays the
 * worker account (Issue #4113).
 *
 * The quality gate's runner drops to the untrusted `agent` account so a
 * repository script cannot read the worker's credential files (Issue #571).
 * These formatters are the repository's pinned toolchains, run on files the
 * agent already wrote, and that account cannot write the worktree — a
 * formatting miss was never fixed. The environment is still the allowlist,
 * with no credential variable in it. The agent's own commands are unchanged.
 */
export function createRepoFormatterDeps(): RepoFormatterDeps {
  return {
    runCommand: runCommandAsWorker,
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
 * Stage and commit exactly these tracked paths.
 *
 * Returns the git error, or `undefined` when the commit landed. The body
 * keeps the run-id trailer in a paragraph of its own: the subject reads as a
 * `Key: value` line, so the trailer would otherwise join it.
 */
async function commitTrackedPaths(
  repoPath: string,
  deps: RepoFormatterDeps,
  paths: readonly string[],
): Promise<string | undefined> {
  const pathspecs = [...new Set(paths)].map((path) => `:(literal)${path}`);
  const add = await deps.runGitCommand(["add", "-u", "--", ...pathspecs], {
    cwd: repoPath,
  });
  const addError = gitStepError("add -u", add);
  if (addError !== undefined) return addError;
  const message = appendRunIdTrailer(
    `${FORMATTER_COMMIT_MESSAGE}\n\n${FORMATTER_COMMIT_BODY}`,
    deps.runId(),
  );
  const commit = await deps.runGitCommand(["commit", "-m", message], {
    cwd: repoPath,
  });
  return gitStepError("commit", commit);
}

/** Directories whose Markdown and JSON the worker itself writes (Issue #4129). */
const WORKER_OWNED_ARCHIVE_DIRS = [
  "docs/archive/pr-summaries/",
  "docs/archive/handover/",
] as const;

/** Extensions `deno fmt` will rewrite under those directories. */
const ARCHIVE_FORMAT_EXTENSIONS = [".md", ".markdown", ".json", ".jsonc"];

/**
 * A branch path the archive step may rewrite.
 *
 * Refuses a path git could hand us that leaves the two directories: a
 * leading slash, a NUL, or a `..` segment.
 */
function isWorkerOwnedArchiveFile(path: string): boolean {
  if (
    path.length === 0 || path.includes("\0") || path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    return false;
  }
  const lower = path.toLowerCase();
  if (!ARCHIVE_FORMAT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return false;
  }
  return WORKER_OWNED_ARCHIVE_DIRS.some((dir) => path.startsWith(dir));
}

function isDenoConfig(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === "deno.json" || base === "deno.jsonc";
}

/**
 * Stable key order, two-space indent, and one trailing newline.
 *
 * `deno fmt` pretty-prints JSON and leaves key order alone, so a writer that
 * emitted keys in encounter order would fail a later check the moment the
 * object was built differently. Invalid JSON is returned unchanged for the
 * formatter to judge.
 */
function canonicalArchiveJson(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return `${JSON.stringify(sortJsonKeys(parsed), null, 2)}\n`;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Format the worker's own archive Markdown and JSON, then commit.
 *
 * Runs after the repository formatters. Only the two worker-owned
 * directories are touched, and only when the repository tracks a Deno
 * config — that is the formatter the pre-push gate will check them with.
 * A missing formatter, a write failure, or a formatter that exits non-zero
 * is logged. This function never throws, so the gate still runs.
 */
export async function formatWorkerOwnedArchive(
  repoPath: string,
  baseRef: string | undefined,
  deps: RepoFormatterDeps,
): Promise<void> {
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
      return;
    }
    const archiveFiles = changed.value.filter(isWorkerOwnedArchiveFile);
    if (archiveFiles.length === 0) return;

    const tracked = await deps.runGitCommand(["ls-files", "-z"], {
      cwd: repoPath,
    });
    if (!tracked.ok || tracked.value.code !== 0) {
      deps.logger.warn(
        `repo formatters: ${gitStepError("ls-files", tracked)}`,
      );
      return;
    }
    const trackedPaths = tracked.value.stdout.split("\0").filter((p) =>
      p.length > 0
    );
    if (!trackedPaths.some(isDenoConfig)) {
      deps.logger.info(
        "repo formatters: no Deno formatter in this repository; " +
          "worker-owned archive Markdown and JSON left for the gate",
      );
      return;
    }

    for (const path of archiveFiles) {
      if (
        !path.toLowerCase().endsWith(".json") &&
        !path.toLowerCase().endsWith(".jsonc")
      ) {
        continue;
      }
      const absolute = `${repoPath}/${path}`;
      try {
        const current = await Deno.readTextFile(absolute);
        const canonical = canonicalArchiveJson(current);
        if (canonical !== undefined && canonical !== current) {
          await Deno.writeTextFile(absolute, canonical);
        }
      } catch (error: unknown) {
        deps.logger.warn(
          `repo formatters: could not rewrite ${path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const { exitCode, output } = await deps.runCommand(
      [
        "deno",
        "fmt",
        "--permit-no-files",
        ...archiveFiles.map((path) =>
          path.startsWith("-") ? `./${path}` : path
        ),
      ],
      { stdin: "null", cwd: repoPath },
    );
    const diff = await deps.runGitCommand(
      [
        "diff",
        "--name-only",
        "-z",
        "--",
        ...archiveFiles.map((path) => `:(literal)${path}`),
      ],
      { cwd: repoPath },
    );
    const diffError = gitStepError("diff --name-only", diff);
    const changedCount = diff.ok && diff.value.code === 0
      ? diff.value.stdout.split("\0").filter((name) =>
        archiveFiles.includes(name)
      ).length
      : undefined;
    const countText = changedCount === undefined
      ? "could not count changed files"
      : `${changedCount} files changed`;
    if (exitCode === 0) {
      deps.logger.info(
        `Formatter deno fmt on worker-owned archive: exit ${exitCode}, ${countText}`,
      );
    } else {
      deps.logger.warn(
        `Formatter deno fmt on worker-owned archive: exit ${exitCode}, ${countText} — ${
          redactedHeadTail(output, 500, 500)
        }`,
      );
    }
    if (diffError !== undefined) {
      deps.logger.warn(`repo formatters: ${diffError}`);
    }
    if (changedCount === 0) return;

    const gitError = await commitTrackedPaths(repoPath, deps, archiveFiles);
    if (gitError !== undefined) {
      deps.logger.warn(`repo formatters: ${gitError}`);
      return;
    }
    deps.logger.info(
      "repo formatters: committed worker-owned archive formatting",
    );
  } catch (error: unknown) {
    deps.logger.warn(
      `repo formatters: worker-owned archive skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
        ...(exitCode !== 0
          ? { excerpt: redactedHeadTail(output, 500, 500) }
          : {}),
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

    const gitError = await commitTrackedPaths(
      repoPath,
      deps,
      steps.flatMap((step) => step.paths),
    );
    if (gitError !== undefined) {
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
 * non-merge commit ahead of `baseRef`, or — with no `baseRef` (the PR base
 * could not be resolved, or a PR round whose `commitAndPushPending` Step 1b
 * gate checks only these) — every commit on no remote-tracking ref, so the
 * formatters and
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
 * runs and reports whatever is left unfixed. After the repository formatters,
 * the worker's own archive Markdown and JSON are formatted the same way
 * (Issue #4129).
 */
export async function formatBeforeGate(
  deps: {
    git: { formatBranchChanges: typeof formatBranchChanges };
    logger: Logger;
    /** Defaults to the production formatter runner, logging on `deps.logger`. */
    formatterDeps?: RepoFormatterDeps;
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
  const formatterDeps = deps.formatterDeps ?? {
    ...createRepoFormatterDeps(),
    logger: deps.logger,
  };
  await formatWorkerOwnedArchive(repoPath, baseRef, formatterDeps);
}
