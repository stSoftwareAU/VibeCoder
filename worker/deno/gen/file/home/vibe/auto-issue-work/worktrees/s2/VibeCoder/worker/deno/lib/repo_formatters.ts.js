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
 */ import { runCommandAsWorker } from "./quality_gate_phase.ts";
import { runGitCommand } from "./git_timeout.ts";
import { defaultLogger } from "./logger.ts";
import { isClosingFence, parseFenceLine } from "./markdown_code_spans.ts";
import { redactedHeadTail, redactedTail } from "./redacted_text.ts";
import { appendRunIdTrailer, getRunId } from "./run_id.ts";
import { listPushedFiles, loadDenoScopes, planFormatterFixes } from "./pre_push_gate.ts";
export { outermostConfigDirs } from "./pre_push_gate.ts";
/** Commit message stamped on the formatters' combined output. */ export const FORMATTER_COMMIT_MESSAGE = "style: apply repository formatters";
/** Body of that commit, saying why the worker made it. */ const FORMATTER_COMMIT_BODY = "Formatted the files this branch changed with the repository's own " + "formatters before the worker's gates, so a formatting-only miss is " + "fixed rather than failed.";
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
 */ export function createRepoFormatterDeps() {
  return {
    runCommand: runCommandAsWorker,
    runGitCommand,
    logger: defaultLogger,
    runId: ()=>getRunId()
  };
}
/** Join a repo-relative directory onto an absolute repo path. */ function resolveDir(repoPath, dir) {
  return dir === "." ? repoPath : `${repoPath}/${dir}`;
}
/**
 * Describe why a git step failed, or `undefined` when it succeeded.
 *
 * `step` names the operation for the message (e.g. `"ls-files"`); stderr is
 * run through {@link redactedTail} so a credential a failing git call echoes
 * never reaches a log line.
 */ function gitStepError(step, result) {
  if (!result.ok) return result.error.message;
  if (result.value.code === 0) return undefined;
  return `git ${step} failed (exit ${result.value.code}): ${redactedTail(result.value.stderr, 500)}`;
}
/** Snapshot of the tracked tree, used to detect whether a formatter changed it. */ async function snapshot(repoPath, deps) {
  const result = await deps.runGitCommand([
    "diff",
    "--no-ext-diff",
    "--binary"
  ], {
    cwd: repoPath
  });
  if (!result.ok) return result;
  const error = gitStepError("diff", result);
  if (error !== undefined) return {
    ok: false,
    error: new Error(error)
  };
  return {
    ok: true,
    value: result.value.stdout
  };
}
/**
 * Stage and commit exactly these tracked paths.
 *
 * Returns the git error, or `undefined` when the commit landed. The body
 * keeps the run-id trailer in a paragraph of its own: the subject reads as a
 * `Key: value` line, so the trailer would otherwise join it.
 */ async function commitTrackedPaths(repoPath, deps, paths) {
  const pathspecs = [
    ...new Set(paths)
  ].map((path)=>`:(literal)${path}`);
  const add = await deps.runGitCommand([
    "add",
    "-u",
    "--",
    ...pathspecs
  ], {
    cwd: repoPath
  });
  const addError = gitStepError("add -u", add);
  if (addError !== undefined) return addError;
  const message = appendRunIdTrailer(`${FORMATTER_COMMIT_MESSAGE}\n\n${FORMATTER_COMMIT_BODY}`, deps.runId());
  const commit = await deps.runGitCommand([
    "commit",
    "-m",
    message
  ], {
    cwd: repoPath
  });
  return gitStepError("commit", commit);
}
/** Directories whose Markdown and JSON the worker itself writes (Issue #4129). */ const WORKER_OWNED_ARCHIVE_DIRS = [
  "docs/archive/pr-summaries/",
  "docs/archive/handover/"
];
/** Extensions `deno fmt` will rewrite under those directories. */ const ARCHIVE_FORMAT_EXTENSIONS = [
  ".md",
  ".markdown",
  ".json",
  ".jsonc"
];
/** Largest archive file the worker will read and rewrite (1 MiB). */ export const MAX_ARCHIVE_REWRITE_BYTES = 1024 * 1024;
/**
 * A branch path the archive step may rewrite.
 *
 * Refuses a path git could hand us that leaves the two directories: a
 * leading slash, a NUL, or a `..` segment.
 */ function isWorkerOwnedArchiveFile(path) {
  if (path.length === 0 || path.includes("\0") || path.startsWith("/") || path.split("/").includes("..")) {
    return false;
  }
  const lower = path.toLowerCase();
  if (!ARCHIVE_FORMAT_EXTENSIONS.some((ext)=>lower.endsWith(ext))) {
    return false;
  }
  return WORKER_OWNED_ARCHIVE_DIRS.some((dir)=>path.startsWith(dir));
}
function isDenoConfig(path) {
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
 */ function canonicalArchiveJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch  {
    return undefined;
  }
  return `${JSON.stringify(sortJsonKeys(parsed), null, 2)}\n`;
}
function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === "object") {
    const record = value;
    const sorted = {};
    for (const key of Object.keys(record).sort()){
      sorted[key] = sortJsonKeys(record[key]);
    }
    return sorted;
  }
  return value;
}
/**
 * A line that is only a linkage keyword and an issue reference, such as
 * `Part of #4802` or `Closes owner/repo#12`.
 *
 * The line is trimmed before the test, so the pattern carries no leading or
 * trailing whitespace quantifiers and stray spaces cannot hide a linkage line.
 * Whitespace is allowed between the number and the full stop, matching the
 * reviewer's `PART_OF_SAME` and `PART_OF_OTHER`
 * (`.claude/skills/review-fleet-prs/scripts/test_change_policy.ts`); a test
 * runs both over the same table so they cannot drift.
 */ const LINKAGE_LINE = /^(?:Closes|Fixes|Resolves|Part of) (?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+[ \t]*\.?$/i;
/**
 * Give each linkage-only line its own paragraph before `deno fmt` runs.
 *
 * `deno fmt` joins adjacent lines into one paragraph, so `Part of #A` over
 * `Part of #B` would become `Part of #A Part of #B`, which breaks the
 * reviewer's anchored-line rule (Issue #4802). A blank line goes above and
 * below each linkage line that touches a non-blank line, so consecutive
 * linkage lines end up with exactly one blank between them. Lines inside a
 * fenced code block are left alone, and every other line is unchanged. A
 * fence closes only on the opener's character with a run at least as long, as
 * in CommonMark, so a ``` line inside a ~~~ block does not end it.
 */ export function isolateLinkageLines(text) {
  const input = text.split("\n");
  const output = [];
  let opener = null;
  for (const [i, line] of input.entries()){
    const fence = parseFenceLine(line);
    if (opener === null && fence !== null) {
      opener = fence;
      output.push(line);
      continue;
    }
    if (opener !== null) {
      if (isClosingFence(line, opener)) opener = null;
      output.push(line);
      continue;
    }
    if (!LINKAGE_LINE.test(line.trim())) {
      output.push(line);
      continue;
    }
    if ((output.at(-1) ?? "").trim() !== "") output.push("");
    output.push(line);
    if ((input[i + 1] ?? "").trim() !== "") output.push("");
  }
  return output.join("\n");
}
/**
 * Format the worker's own archive Markdown and JSON, then commit.
 *
 * Runs after the repository formatters. Only the two worker-owned
 * directories are touched, and only when the repository tracks a Deno
 * config — that is the formatter the pre-push gate will check them with.
 * Before `deno fmt` runs, each Markdown file has its linkage-only lines
 * isolated (see {@link isolateLinkageLines}) and each JSON file is rewritten
 * with sorted keys; a file is written back only when it changed. Files over
 * MAX_ARCHIVE_REWRITE_BYTES are skipped with a warning and left for the gate
 * to report. A missing formatter, a write failure, or a formatter that exits
 * non-zero is logged.
 * This function never throws, so the gate still runs.
 */ export async function formatWorkerOwnedArchive(repoPath, baseRef, deps) {
  try {
    const git = async (args, cwd)=>{
      const result = await deps.runGitCommand(args, {
        cwd
      });
      if (!result.ok) {
        return {
          code: 1,
          stdout: "",
          stderr: result.error.message
        };
      }
      return result.value;
    };
    const changed = await listPushedFiles([
      {
        localRef: "HEAD",
        localSha: "HEAD",
        remoteRef: "HEAD",
        remoteSha: "0".repeat(40)
      }
    ], repoPath, git, baseRef);
    if (!changed.ok) {
      deps.logger.warn(`repo formatters: ${changed.error}`);
      return;
    }
    const archiveFiles = changed.value.filter(isWorkerOwnedArchiveFile);
    if (archiveFiles.length === 0) return;
    const tracked = await deps.runGitCommand([
      "ls-files",
      "-z"
    ], {
      cwd: repoPath
    });
    if (!tracked.ok || tracked.value.code !== 0) {
      deps.logger.warn(`repo formatters: ${gitStepError("ls-files", tracked)}`);
      return;
    }
    const trackedPaths = tracked.value.stdout.split("\0").filter((p)=>p.length > 0);
    if (!trackedPaths.some(isDenoConfig)) {
      deps.logger.info("repo formatters: no Deno formatter in this repository; " + "worker-owned archive Markdown and JSON left for the gate");
      return;
    }
    const skipped = new Set();
    for (const path of archiveFiles){
      const lower = path.toLowerCase();
      const isMarkdown = lower.endsWith(".md") || lower.endsWith(".markdown");
      const isJson = lower.endsWith(".json") || lower.endsWith(".jsonc");
      if (!isMarkdown && !isJson) continue;
      const absolute = `${repoPath}/${path}`;
      try {
        // `listPushedFiles` has already dropped symlinks and paths that
        // resolve outside the checkout; the cap keeps a huge file out of memory.
        const info = await Deno.lstat(absolute);
        if (info.size > MAX_ARCHIVE_REWRITE_BYTES) {
          skipped.add(path);
          deps.logger.warn(`repo formatters: skipped ${path}: larger than ${MAX_ARCHIVE_REWRITE_BYTES} bytes`);
          continue;
        }
        const current = await Deno.readTextFile(absolute);
        const rewritten = isMarkdown ? isolateLinkageLines(current) : canonicalArchiveJson(current);
        if (rewritten !== undefined && rewritten !== current) {
          await Deno.writeTextFile(absolute, rewritten);
        }
      } catch (error) {
        deps.logger.warn(`repo formatters: could not rewrite ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const formatPaths = archiveFiles.filter((path)=>!skipped.has(path));
    // `deno fmt` with no paths formats the whole repository: never run it empty.
    if (formatPaths.length === 0) return;
    const { exitCode, output } = await deps.runCommand([
      "deno",
      "fmt",
      "--permit-no-files",
      ...formatPaths.map((path)=>path.startsWith("-") ? `./${path}` : path)
    ], {
      stdin: "null",
      cwd: repoPath
    });
    const diff = await deps.runGitCommand([
      "diff",
      "--name-only",
      "-z",
      "--",
      ...formatPaths.map((path)=>`:(literal)${path}`)
    ], {
      cwd: repoPath
    });
    const diffError = gitStepError("diff --name-only", diff);
    const changedCount = diff.ok && diff.value.code === 0 ? diff.value.stdout.split("\0").filter((name)=>formatPaths.includes(name)).length : undefined;
    const countText = changedCount === undefined ? "could not count changed files" : `${changedCount} files changed`;
    if (exitCode === 0) {
      deps.logger.info(`Formatter deno fmt on worker-owned archive: exit ${exitCode}, ${countText}`);
    } else {
      deps.logger.warn(`Formatter deno fmt on worker-owned archive: exit ${exitCode}, ${countText} — ${redactedHeadTail(output, 500, 500)}`);
    }
    if (diffError !== undefined) {
      deps.logger.warn(`repo formatters: ${diffError}`);
    }
    if (changedCount === 0) return;
    const gitError = await commitTrackedPaths(repoPath, deps, formatPaths);
    if (gitError !== undefined) {
      deps.logger.warn(`repo formatters: ${gitError}`);
      return;
    }
    deps.logger.info("repo formatters: committed worker-owned archive formatting");
  } catch (error) {
    deps.logger.warn(`repo formatters: worker-owned archive skipped: ${error instanceof Error ? error.message : String(error)}`);
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
 */ export async function runRepoFormatters(repoPath, changed, deps = createRepoFormatterDeps()) {
  try {
    const lsFiles = await deps.runGitCommand([
      "ls-files",
      "-z"
    ], {
      cwd: repoPath
    });
    if (!lsFiles.ok || lsFiles.value.code !== 0) {
      const gitError = gitStepError("ls-files", lsFiles);
      deps.logger.warn(`repo formatters: ${gitError}`);
      return {
        runs: [],
        failures: [],
        committed: false,
        gitError
      };
    }
    const paths = lsFiles.value.stdout.split("\0").filter((p)=>p.length > 0);
    const steps = planFormatterFixes(changed, paths, await loadDenoScopes(repoPath, paths));
    if (steps.length === 0) {
      return {
        runs: [],
        failures: [],
        committed: false
      };
    }
    const initialSnapshot = await snapshot(repoPath, deps);
    if (!initialSnapshot.ok) {
      const gitError = initialSnapshot.error.message;
      deps.logger.warn(`repo formatters: ${gitError}`);
      return {
        runs: [],
        failures: [],
        committed: false,
        gitError
      };
    }
    const runs = [];
    const failures = [];
    let before = initialSnapshot.value;
    for (const step of steps){
      const { exitCode, output } = await deps.runCommand(step.cmd, {
        stdin: "null",
        cwd: resolveDir(repoPath, step.dir)
      });
      const after = await snapshot(repoPath, deps);
      const changed = after.ok ? after.value !== before : false;
      const run = {
        tool: step.tool,
        dir: step.dir,
        exitCode,
        changed,
        ...exitCode !== 0 ? {
          excerpt: redactedHeadTail(output, 500, 500)
        } : {}
      };
      runs.push(run);
      if (exitCode === 0) {
        deps.logger.info(`Formatter ${step.tool} in ${step.dir}: exit ${exitCode}, ${changed ? "files changed" : "no changes"}`);
      } else {
        failures.push(run);
        deps.logger.warn(`Formatter ${step.tool} in ${step.dir}: exit ${exitCode}, ${changed ? "files changed" : "no changes"} — ${run.excerpt}`);
      }
      // A snapshot that failed mid-loop must not be silently read as "no
      // change" — the tree's real state afterwards is unknown, so staging and
      // committing on a stale `before` risks folding an unrelated or missing
      // change into the formatters' commit. Fail loud instead.
      if (!after.ok) {
        const gitError = after.error.message;
        deps.logger.warn(`repo formatters: ${gitError}`);
        return {
          runs,
          failures,
          committed: false,
          gitError
        };
      }
      before = after.value;
    }
    if (before === initialSnapshot.value) {
      return {
        runs,
        failures,
        committed: false
      };
    }
    const gitError = await commitTrackedPaths(repoPath, deps, steps.flatMap((step)=>step.paths));
    if (gitError !== undefined) {
      deps.logger.warn(`repo formatters: ${gitError}`);
      return {
        runs,
        failures,
        committed: false,
        gitError
      };
    }
    deps.logger.info("repo formatters: committed formatter output");
    return {
      runs,
      failures,
      committed: true
    };
  } catch (error) {
    const gitError = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`repo formatters: unexpected error: ${gitError}`);
    return {
      runs: [],
      failures: [],
      committed: false,
      gitError
    };
  }
}
/**
 * Run the formatters over every file the branch changed, then commit.
 *
 * The file list is the pre-push gate's own (`listPushedFiles`): every
 * commit ahead of `baseRef` (for a merge commit, only the paths the merge
 * itself changed, such as a conflict resolution), or — with no `baseRef` (the PR base
 * could not be resolved, or a PR round whose `commitAndPushPending` Step 1b
 * gate checks only these) — every commit on no remote-tracking ref, so the
 * formatters and
 * the gate that follows always agree on scope. Files a merge merely
 * brings in from the base are never reformatted. Never throws.
 */ export async function formatBranchChanges(repoPath, baseRef, deps = createRepoFormatterDeps()) {
  try {
    const git = async (args, cwd)=>{
      const result = await deps.runGitCommand(args, {
        cwd
      });
      if (!result.ok) {
        return {
          code: 1,
          stdout: "",
          stderr: result.error.message
        };
      }
      return result.value;
    };
    const changed = await listPushedFiles([
      {
        localRef: "HEAD",
        localSha: "HEAD",
        remoteRef: "HEAD",
        remoteSha: "0".repeat(40)
      }
    ], repoPath, git, baseRef);
    if (!changed.ok) {
      deps.logger.warn(`repo formatters: ${changed.error}`);
      return {
        runs: [],
        failures: [],
        committed: false,
        gitError: changed.error
      };
    }
    if (changed.value.length === 0) {
      return {
        runs: [],
        failures: [],
        committed: false
      };
    }
    return await runRepoFormatters(repoPath, changed.value, deps);
  } catch (error) {
    const gitError = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`repo formatters: unexpected error: ${gitError}`);
    return {
      runs: [],
      failures: [],
      committed: false,
      gitError
    };
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
 */ export async function formatBeforeGate(deps, repoPath, baseRef) {
  try {
    const result = await deps.git.formatBranchChanges(repoPath, baseRef);
    if (result.committed) {
      deps.logger.info(`Formatted the branch's changed files before the gate ` + `(${FORMATTER_COMMIT_MESSAGE})`);
    }
  } catch (error) {
    deps.logger.warn(`repo formatters: skipped before the gate: ${error instanceof Error ? error.message : String(error)}`);
  }
  const formatterDeps = deps.formatterDeps ?? {
    ...createRepoFormatterDeps(),
    logger: deps.logger
  };
  await formatWorkerOwnedArchive(repoPath, baseRef, formatterDeps);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZXBvX2Zvcm1hdHRlcnMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZXBvc2l0b3J5LW93bmVkIGZvcm1hdHRlcnMsIHJ1biBhbmQgY29tbWl0dGVkIGFzIG9uZSB0aWR5LXVwIChJc3N1ZSAjMjk2NyxcbiAqIHBhcnQgb2YgIzI5MzIpLCB3aXJlZCBpbnRvIHRoZSBpc3N1ZSBydW4gYmVmb3JlIGl0cyBnYXRlcy5cbiAqXG4gKiBBIFBSIHNlbnQgYmFjayBieSByZXZpZXcsIG9yIGZhaWxlZCBieSBDSSwgZm9yIGEgZm9ybWF0dGluZy1vbmx5IG1pc3MgY29zdHNcbiAqIGEgd2hvbGUgcm91bmQgb2YgdG9rZW5zLiB7QGxpbmsgZm9ybWF0QnJhbmNoQ2hhbmdlc30gbGlzdHMgdGhlIGZpbGVzIHRoZVxuICogYnJhbmNoIGNoYW5nZWQg4oCUIHRoZSBzYW1lIG5vbi1tZXJnZSBjb21taXRzIGFoZWFkIG9mIHRoZSBQUiBiYXNlIHRoYXQgdGhlXG4gKiBwcmUtcHVzaCBnYXRlIGNoZWNrcyDigJQgYW5kIHtAbGluayBydW5SZXBvRm9ybWF0dGVyc30gcnVucyB0aGUgcmVwb3NpdG9yeSdzXG4gKiBvd24gZm9ybWF0dGVycyBvdmVyIGV4YWN0bHkgd2hhdCB0aGF0IGdhdGUncyBgZGVubyBmbXQgLS1jaGVja2AgYW5kIGBjYXJnb1xuICogZm10IC0tY2hlY2tgIHdvdWxkIGZsYWcgKGBwbGFuRm9ybWF0dGVyRml4ZXNgIGluIGBwcmVfcHVzaF9nYXRlLnRzYCk6IGBkZW5vXG4gKiBmbXRgIG9uIHRoZSBjaGFuZ2VkIGNvZGUgZmlsZXMgdW5kZXIgZWFjaCBvdXRlcm1vc3QgdHJhY2tlZCBgZGVuby5qc29uYCAvXG4gKiBgZGVuby5qc29uY2AgdGhhdCBpdHMgZm10IHNjb3BlIGNvdmVycywgYW5kIGBjYXJnbyBmbXQgLS1hbGxgIGluIGVhY2hcbiAqIG91dGVybW9zdCB0cmFja2VkIGBDYXJnby50b21sYCBkaXJlY3Rvcnkgd2hvc2UgYC5yc2AgZmlsZXMgY2hhbmdlZC4gSWYgYW55XG4gKiB0cmFja2VkIGZpbGUgZGlmZmVycyBhZnRlcndhcmRzLCB0aGUgZm9ybWF0dGVkIHBhdGhzIGFyZSBjb21taXR0ZWQgYXMgb25lXG4gKiBgc3R5bGU6IGFwcGx5IHJlcG9zaXRvcnkgZm9ybWF0dGVyc2AgY29tbWl0LlxuICpcbiAqIE1hcmtkb3duIG91dHNpZGUgdGhlIHdvcmtlcidzIG93biBhcmNoaXZlIGlzIG5ldmVyIGhhbmRlZCB0byBgZGVubyBmbXRgOlxuICogaXQgcmUtd3JhcHMgd2hvbGUgZG9jdW1lbnRzIGFuZCB0cmlwcyBtYXJrZG93bmxpbnQgTUQwMTgsIHNvIGEgTWFya2Rvd25cbiAqIG1pc3MgdGhlcmUgaXMgbGVmdCB0byB0aGUgY2hlY2sgdG8gcmVwb3J0LiBBZnRlciB0aG9zZSBmb3JtYXR0ZXJzLFxuICoge0BsaW5rIGZvcm1hdEJlZm9yZUdhdGV9IGZvcm1hdHMgdGhlIE1hcmtkb3duIGFuZCBKU09OIHRoZSBicmFuY2ggY2hhbmdlZFxuICogdW5kZXIgYGRvY3MvYXJjaGl2ZS9wci1zdW1tYXJpZXMvYCBhbmQgYGRvY3MvYXJjaGl2ZS9oYW5kb3Zlci9gIG9ubHkuXG4gKiBgZG9jcy9hcmNoaXZlL2AgaXMgZXhjbHVkZWQgZnJvbSB0aGUgbWFya2Rvd25saW50IGdsb2JzLCBzbyB0aGF0IHdyYXAgZG9lc1xuICogbm90IHRyaXAgTUQwMTguXG4gKlxuICogQ2FsbGVyczogdGhlIHF1YWxpdHktZ2F0ZSBwaGFzZSwgYmVmb3JlIGV2ZXJ5IGAuL3F1YWxpdHkuc2hgIGF0dGVtcHQ7IHRoZVxuICogY29tcGxldGlvbiBwaGFzZSdzIGBnYXRlQmVmb3JlUHVzaCgpYCwgYmVmb3JlIGV2ZXJ5IHByZS1wdXNoIGdhdGUgcnVuOyBhbmRcbiAqIHRoZSBQUi1mZWVkYmFjayBhbmQgQ0ktZml4IHByb2Nlc3NvcnMsIGFzIGBjb21taXRBbmRQdXNoUGVuZGluZ2AncyBTdGVwIDFhXG4gKiBob29rIGJldHdlZW4gaXRzIGNvbW1pdCBhbmQgaXRzIFN0ZXAgMWIgZ2F0ZSAoc2NvcGVkLCBsaWtlIHRoYXQgZ2F0ZSwgdG9cbiAqIHRoZSBjb21taXRzIG9uIG5vIHJlbW90ZSkuIEEgZm9ybWF0dGVyIHRoYXQgaXMgbWlzc2luZyBvciBmYWlscyBuZXZlciBmYWlsc1xuICogdGhlIHJ1biBvbiBpdHMgb3duOiBpdCBpcyBsb2dnZWQsIGFuZCB0aGUgZ2F0ZSB0aGF0IGZvbGxvd3Mgc3RpbGwgcnVucyBhbmRcbiAqIHJlcG9ydHMgdGhlIHByb2JsZW0uXG4gKi9cblxuaW1wb3J0IHtcbiAgdHlwZSBRdWFsaXR5R2F0ZURlcHMsXG4gIHJ1bkNvbW1hbmRBc1dvcmtlcixcbn0gZnJvbSBcIi4vcXVhbGl0eV9nYXRlX3BoYXNlLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEdpdENvbW1hbmRPcHRpb25zLFxuICB0eXBlIEdpdENvbW1hbmRPdXRwdXQsXG4gIHJ1bkdpdENvbW1hbmQsXG59IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9nZ2VyIH0gZnJvbSBcIi4vbG9nZ2VyLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEZlbmNlTGluZSxcbiAgaXNDbG9zaW5nRmVuY2UsXG4gIHBhcnNlRmVuY2VMaW5lLFxufSBmcm9tIFwiLi9tYXJrZG93bl9jb2RlX3NwYW5zLnRzXCI7XG5pbXBvcnQgdHlwZSB7IExvZ2dlciwgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyByZWRhY3RlZEhlYWRUYWlsLCByZWRhY3RlZFRhaWwgfSBmcm9tIFwiLi9yZWRhY3RlZF90ZXh0LnRzXCI7XG5pbXBvcnQgeyBhcHBlbmRSdW5JZFRyYWlsZXIsIGdldFJ1bklkIH0gZnJvbSBcIi4vcnVuX2lkLnRzXCI7XG5pbXBvcnQge1xuICBsaXN0UHVzaGVkRmlsZXMsXG4gIGxvYWREZW5vU2NvcGVzLFxuICBwbGFuRm9ybWF0dGVyRml4ZXMsXG4gIHR5cGUgUHJlUHVzaEdpdCxcbn0gZnJvbSBcIi4vcHJlX3B1c2hfZ2F0ZS50c1wiO1xuXG5leHBvcnQgeyBvdXRlcm1vc3RDb25maWdEaXJzIH0gZnJvbSBcIi4vcHJlX3B1c2hfZ2F0ZS50c1wiO1xuXG4vKiogQ29tbWl0IG1lc3NhZ2Ugc3RhbXBlZCBvbiB0aGUgZm9ybWF0dGVycycgY29tYmluZWQgb3V0cHV0LiAqL1xuZXhwb3J0IGNvbnN0IEZPUk1BVFRFUl9DT01NSVRfTUVTU0FHRSA9IFwic3R5bGU6IGFwcGx5IHJlcG9zaXRvcnkgZm9ybWF0dGVyc1wiO1xuXG4vKiogQm9keSBvZiB0aGF0IGNvbW1pdCwgc2F5aW5nIHdoeSB0aGUgd29ya2VyIG1hZGUgaXQuICovXG5jb25zdCBGT1JNQVRURVJfQ09NTUlUX0JPRFkgPVxuICBcIkZvcm1hdHRlZCB0aGUgZmlsZXMgdGhpcyBicmFuY2ggY2hhbmdlZCB3aXRoIHRoZSByZXBvc2l0b3J5J3Mgb3duIFwiICtcbiAgXCJmb3JtYXR0ZXJzIGJlZm9yZSB0aGUgd29ya2VyJ3MgZ2F0ZXMsIHNvIGEgZm9ybWF0dGluZy1vbmx5IG1pc3MgaXMgXCIgK1xuICBcImZpeGVkIHJhdGhlciB0aGFuIGZhaWxlZC5cIjtcblxuLyoqIEEgZm9ybWF0dGVyIHRoaXMgbW9kdWxlIGtub3dzIGhvdyB0byBydW4uICovXG5leHBvcnQgdHlwZSBGb3JtYXR0ZXJUb29sID0gXCJjYXJnbyBmbXRcIiB8IFwiZGVubyBmbXRcIjtcblxuLyoqIE91dGNvbWUgb2YgYSBzaW5nbGUgZm9ybWF0dGVyIGludm9jYXRpb24gaW4gYSBzaW5nbGUgZGlyZWN0b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBGb3JtYXR0ZXJSdW4ge1xuICB0b29sOiBGb3JtYXR0ZXJUb29sO1xuICAvKiogUmVwby1yZWxhdGl2ZSBkaXJlY3Rvcnk7IFwiLlwiIGZvciB0aGUgcm9vdC4gKi9cbiAgZGlyOiBzdHJpbmc7XG4gIGV4aXRDb2RlOiBudW1iZXI7XG4gIC8qKiBUcnVlIHdoZW4gdHJhY2tlZCBmaWxlcyBkaWZmZXIgYWZ0ZXIgdGhpcyBmb3JtYXR0ZXIgcmFuLiAqL1xuICBjaGFuZ2VkOiBib29sZWFuO1xuICAvKipcbiAgICogUmVkYWN0ZWQgaGVhZCBhbmQgdGFpbCBvZiB0aGUgZm9ybWF0dGVyJ3Mgb3V0cHV0OyBwcmVzZW50IG9ubHkgd2hlblxuICAgKiBleGl0Q29kZSAhPT0gMC4gVGhlIGhlYWQgaXMga2VwdCBiZWNhdXNlIGBjYXJnbyBmbXRgIHByaW50cyB0aGUgZXJyb3JcbiAgICogYW5kIHRoZW4gYSBsb25nIHVzYWdlIHRleHQgKElzc3VlICM0MTEzKS5cbiAgICovXG4gIGV4Y2VycHQ/OiBzdHJpbmc7XG59XG5cbi8qKiBPdXRjb21lIG9mIHJ1bm5pbmcgZXZlcnkgYXBwbGljYWJsZSBmb3JtYXR0ZXIgYWNyb3NzIHRoZSByZXBvc2l0b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZXBvRm9ybWF0dGVyc1Jlc3VsdCB7XG4gIHJ1bnM6IEZvcm1hdHRlclJ1bltdO1xuICAvKiogUnVucyB0aGF0IGV4aXRlZCBub24temVybyAoaW5jbHVkZXMgYSBtaXNzaW5nIGJpbmFyeSkuICovXG4gIGZhaWx1cmVzOiBGb3JtYXR0ZXJSdW5bXTtcbiAgY29tbWl0dGVkOiBib29sZWFuO1xuICAvKiogU2V0IHdoZW4gYSBnaXQgc3RlcCBmYWlsZWQ7IHRoZSBmdW5jdGlvbiBuZXZlciB0aHJvd3MuICovXG4gIGdpdEVycm9yPzogc3RyaW5nO1xufVxuXG4vKiogSW5qZWN0YWJsZSBkZXBlbmRlbmNpZXMgZm9yIHtAbGluayBydW5SZXBvRm9ybWF0dGVyc30uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlcG9Gb3JtYXR0ZXJEZXBzIHtcbiAgcnVuQ29tbWFuZDogUXVhbGl0eUdhdGVEZXBzW1wicnVuQ29tbWFuZFwiXTtcbiAgcnVuR2l0Q29tbWFuZDogKFxuICAgIGFyZ3M6IHN0cmluZ1tdLFxuICAgIG9wdGlvbnM/OiBHaXRDb21tYW5kT3B0aW9ucyxcbiAgKSA9PiBQcm9taXNlPFJlc3VsdDxHaXRDb21tYW5kT3V0cHV0Pj47XG4gIGxvZ2dlcjogTG9nZ2VyO1xuICAvKiogUnVuIGlkIHN0YW1wZWQgYXMgdGhlIGNvbW1pdCdzIHRyYWlsZXIuICovXG4gIHJ1bklkOiAoKSA9PiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVhbCBkZXBlbmRlbmNpZXM6IGdpdCwgdGhlIGxvZ2dlciwgYW5kIGEgY29tbWFuZCBydW5uZXIgdGhhdCBzdGF5cyB0aGVcbiAqIHdvcmtlciBhY2NvdW50IChJc3N1ZSAjNDExMykuXG4gKlxuICogVGhlIHF1YWxpdHkgZ2F0ZSdzIHJ1bm5lciBkcm9wcyB0byB0aGUgdW50cnVzdGVkIGBhZ2VudGAgYWNjb3VudCBzbyBhXG4gKiByZXBvc2l0b3J5IHNjcmlwdCBjYW5ub3QgcmVhZCB0aGUgd29ya2VyJ3MgY3JlZGVudGlhbCBmaWxlcyAoSXNzdWUgIzU3MSkuXG4gKiBUaGVzZSBmb3JtYXR0ZXJzIGFyZSB0aGUgcmVwb3NpdG9yeSdzIHBpbm5lZCB0b29sY2hhaW5zLCBydW4gb24gZmlsZXMgdGhlXG4gKiBhZ2VudCBhbHJlYWR5IHdyb3RlLCBhbmQgdGhhdCBhY2NvdW50IGNhbm5vdCB3cml0ZSB0aGUgd29ya3RyZWUg4oCUIGFcbiAqIGZvcm1hdHRpbmcgbWlzcyB3YXMgbmV2ZXIgZml4ZWQuIFRoZSBlbnZpcm9ubWVudCBpcyBzdGlsbCB0aGUgYWxsb3dsaXN0LFxuICogd2l0aCBubyBjcmVkZW50aWFsIHZhcmlhYmxlIGluIGl0LiBUaGUgYWdlbnQncyBvd24gY29tbWFuZHMgYXJlIHVuY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVJlcG9Gb3JtYXR0ZXJEZXBzKCk6IFJlcG9Gb3JtYXR0ZXJEZXBzIHtcbiAgcmV0dXJuIHtcbiAgICBydW5Db21tYW5kOiBydW5Db21tYW5kQXNXb3JrZXIsXG4gICAgcnVuR2l0Q29tbWFuZCxcbiAgICBsb2dnZXI6IGRlZmF1bHRMb2dnZXIsXG4gICAgcnVuSWQ6ICgpID0+IGdldFJ1bklkKCksXG4gIH07XG59XG5cbi8qKiBKb2luIGEgcmVwby1yZWxhdGl2ZSBkaXJlY3Rvcnkgb250byBhbiBhYnNvbHV0ZSByZXBvIHBhdGguICovXG5mdW5jdGlvbiByZXNvbHZlRGlyKHJlcG9QYXRoOiBzdHJpbmcsIGRpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGRpciA9PT0gXCIuXCIgPyByZXBvUGF0aCA6IGAke3JlcG9QYXRofS8ke2Rpcn1gO1xufVxuXG4vKipcbiAqIERlc2NyaWJlIHdoeSBhIGdpdCBzdGVwIGZhaWxlZCwgb3IgYHVuZGVmaW5lZGAgd2hlbiBpdCBzdWNjZWVkZWQuXG4gKlxuICogYHN0ZXBgIG5hbWVzIHRoZSBvcGVyYXRpb24gZm9yIHRoZSBtZXNzYWdlIChlLmcuIGBcImxzLWZpbGVzXCJgKTsgc3RkZXJyIGlzXG4gKiBydW4gdGhyb3VnaCB7QGxpbmsgcmVkYWN0ZWRUYWlsfSBzbyBhIGNyZWRlbnRpYWwgYSBmYWlsaW5nIGdpdCBjYWxsIGVjaG9lc1xuICogbmV2ZXIgcmVhY2hlcyBhIGxvZyBsaW5lLlxuICovXG5mdW5jdGlvbiBnaXRTdGVwRXJyb3IoXG4gIHN0ZXA6IHN0cmluZyxcbiAgcmVzdWx0OiBSZXN1bHQ8R2l0Q29tbWFuZE91dHB1dD4sXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHJlc3VsdC5lcnJvci5tZXNzYWdlO1xuICBpZiAocmVzdWx0LnZhbHVlLmNvZGUgPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiBgZ2l0ICR7c3RlcH0gZmFpbGVkIChleGl0ICR7cmVzdWx0LnZhbHVlLmNvZGV9KTogJHtcbiAgICByZWRhY3RlZFRhaWwocmVzdWx0LnZhbHVlLnN0ZGVyciwgNTAwKVxuICB9YDtcbn1cblxuLyoqIFNuYXBzaG90IG9mIHRoZSB0cmFja2VkIHRyZWUsIHVzZWQgdG8gZGV0ZWN0IHdoZXRoZXIgYSBmb3JtYXR0ZXIgY2hhbmdlZCBpdC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNuYXBzaG90KFxuICByZXBvUGF0aDogc3RyaW5nLFxuICBkZXBzOiBSZXBvRm9ybWF0dGVyRGVwcyxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGVwcy5ydW5HaXRDb21tYW5kKFxuICAgIFtcImRpZmZcIiwgXCItLW5vLWV4dC1kaWZmXCIsIFwiLS1iaW5hcnlcIl0sXG4gICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICk7XG4gIGlmICghcmVzdWx0Lm9rKSByZXR1cm4gcmVzdWx0O1xuICBjb25zdCBlcnJvciA9IGdpdFN0ZXBFcnJvcihcImRpZmZcIiwgcmVzdWx0KTtcbiAgaWYgKGVycm9yICE9PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG5ldyBFcnJvcihlcnJvcikgfTtcbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiByZXN1bHQudmFsdWUuc3Rkb3V0IH07XG59XG5cbi8qKlxuICogU3RhZ2UgYW5kIGNvbW1pdCBleGFjdGx5IHRoZXNlIHRyYWNrZWQgcGF0aHMuXG4gKlxuICogUmV0dXJucyB0aGUgZ2l0IGVycm9yLCBvciBgdW5kZWZpbmVkYCB3aGVuIHRoZSBjb21taXQgbGFuZGVkLiBUaGUgYm9keVxuICoga2VlcHMgdGhlIHJ1bi1pZCB0cmFpbGVyIGluIGEgcGFyYWdyYXBoIG9mIGl0cyBvd246IHRoZSBzdWJqZWN0IHJlYWRzIGFzIGFcbiAqIGBLZXk6IHZhbHVlYCBsaW5lLCBzbyB0aGUgdHJhaWxlciB3b3VsZCBvdGhlcndpc2Ugam9pbiBpdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY29tbWl0VHJhY2tlZFBhdGhzKFxuICByZXBvUGF0aDogc3RyaW5nLFxuICBkZXBzOiBSZXBvRm9ybWF0dGVyRGVwcyxcbiAgcGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcbiAgY29uc3QgcGF0aHNwZWNzID0gWy4uLm5ldyBTZXQocGF0aHMpXS5tYXAoKHBhdGgpID0+IGA6KGxpdGVyYWwpJHtwYXRofWApO1xuICBjb25zdCBhZGQgPSBhd2FpdCBkZXBzLnJ1bkdpdENvbW1hbmQoW1wiYWRkXCIsIFwiLXVcIiwgXCItLVwiLCAuLi5wYXRoc3BlY3NdLCB7XG4gICAgY3dkOiByZXBvUGF0aCxcbiAgfSk7XG4gIGNvbnN0IGFkZEVycm9yID0gZ2l0U3RlcEVycm9yKFwiYWRkIC11XCIsIGFkZCk7XG4gIGlmIChhZGRFcnJvciAhPT0gdW5kZWZpbmVkKSByZXR1cm4gYWRkRXJyb3I7XG4gIGNvbnN0IG1lc3NhZ2UgPSBhcHBlbmRSdW5JZFRyYWlsZXIoXG4gICAgYCR7Rk9STUFUVEVSX0NPTU1JVF9NRVNTQUdFfVxcblxcbiR7Rk9STUFUVEVSX0NPTU1JVF9CT0RZfWAsXG4gICAgZGVwcy5ydW5JZCgpLFxuICApO1xuICBjb25zdCBjb21taXQgPSBhd2FpdCBkZXBzLnJ1bkdpdENvbW1hbmQoW1wiY29tbWl0XCIsIFwiLW1cIiwgbWVzc2FnZV0sIHtcbiAgICBjd2Q6IHJlcG9QYXRoLFxuICB9KTtcbiAgcmV0dXJuIGdpdFN0ZXBFcnJvcihcImNvbW1pdFwiLCBjb21taXQpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgd2hvc2UgTWFya2Rvd24gYW5kIEpTT04gdGhlIHdvcmtlciBpdHNlbGYgd3JpdGVzIChJc3N1ZSAjNDEyOSkuICovXG5jb25zdCBXT1JLRVJfT1dORURfQVJDSElWRV9ESVJTID0gW1xuICBcImRvY3MvYXJjaGl2ZS9wci1zdW1tYXJpZXMvXCIsXG4gIFwiZG9jcy9hcmNoaXZlL2hhbmRvdmVyL1wiLFxuXSBhcyBjb25zdDtcblxuLyoqIEV4dGVuc2lvbnMgYGRlbm8gZm10YCB3aWxsIHJld3JpdGUgdW5kZXIgdGhvc2UgZGlyZWN0b3JpZXMuICovXG5jb25zdCBBUkNISVZFX0ZPUk1BVF9FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLmpzb25cIiwgXCIuanNvbmNcIl07XG5cbi8qKiBMYXJnZXN0IGFyY2hpdmUgZmlsZSB0aGUgd29ya2VyIHdpbGwgcmVhZCBhbmQgcmV3cml0ZSAoMSBNaUIpLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9BUkNISVZFX1JFV1JJVEVfQllURVMgPSAxMDI0ICogMTAyNDtcblxuLyoqXG4gKiBBIGJyYW5jaCBwYXRoIHRoZSBhcmNoaXZlIHN0ZXAgbWF5IHJld3JpdGUuXG4gKlxuICogUmVmdXNlcyBhIHBhdGggZ2l0IGNvdWxkIGhhbmQgdXMgdGhhdCBsZWF2ZXMgdGhlIHR3byBkaXJlY3RvcmllczogYVxuICogbGVhZGluZyBzbGFzaCwgYSBOVUwsIG9yIGEgYC4uYCBzZWdtZW50LlxuICovXG5mdW5jdGlvbiBpc1dvcmtlck93bmVkQXJjaGl2ZUZpbGUocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChcbiAgICBwYXRoLmxlbmd0aCA9PT0gMCB8fCBwYXRoLmluY2x1ZGVzKFwiXFwwXCIpIHx8IHBhdGguc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICBwYXRoLnNwbGl0KFwiL1wiKS5pbmNsdWRlcyhcIi4uXCIpXG4gICkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCBsb3dlciA9IHBhdGgudG9Mb3dlckNhc2UoKTtcbiAgaWYgKCFBUkNISVZFX0ZPUk1BVF9FWFRFTlNJT05TLnNvbWUoKGV4dCkgPT4gbG93ZXIuZW5kc1dpdGgoZXh0KSkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIFdPUktFUl9PV05FRF9BUkNISVZFX0RJUlMuc29tZSgoZGlyKSA9PiBwYXRoLnN0YXJ0c1dpdGgoZGlyKSk7XG59XG5cbmZ1bmN0aW9uIGlzRGVub0NvbmZpZyhwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYmFzZSA9IHBhdGguc2xpY2UocGF0aC5sYXN0SW5kZXhPZihcIi9cIikgKyAxKTtcbiAgcmV0dXJuIGJhc2UgPT09IFwiZGVuby5qc29uXCIgfHwgYmFzZSA9PT0gXCJkZW5vLmpzb25jXCI7XG59XG5cbi8qKlxuICogU3RhYmxlIGtleSBvcmRlciwgdHdvLXNwYWNlIGluZGVudCwgYW5kIG9uZSB0cmFpbGluZyBuZXdsaW5lLlxuICpcbiAqIGBkZW5vIGZtdGAgcHJldHR5LXByaW50cyBKU09OIGFuZCBsZWF2ZXMga2V5IG9yZGVyIGFsb25lLCBzbyBhIHdyaXRlciB0aGF0XG4gKiBlbWl0dGVkIGtleXMgaW4gZW5jb3VudGVyIG9yZGVyIHdvdWxkIGZhaWwgYSBsYXRlciBjaGVjayB0aGUgbW9tZW50IHRoZVxuICogb2JqZWN0IHdhcyBidWlsdCBkaWZmZXJlbnRseS4gSW52YWxpZCBKU09OIGlzIHJldHVybmVkIHVuY2hhbmdlZCBmb3IgdGhlXG4gKiBmb3JtYXR0ZXIgdG8ganVkZ2UuXG4gKi9cbmZ1bmN0aW9uIGNhbm9uaWNhbEFyY2hpdmVKc29uKHRleHQ6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoc29ydEpzb25LZXlzKHBhcnNlZCksIG51bGwsIDIpfVxcbmA7XG59XG5cbmZ1bmN0aW9uIHNvcnRKc29uS2V5cyh2YWx1ZTogdW5rbm93bik6IHVua25vd24ge1xuICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB2YWx1ZS5tYXAoc29ydEpzb25LZXlzKTtcbiAgaWYgKHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikge1xuICAgIGNvbnN0IHJlY29yZCA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IHNvcnRlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhyZWNvcmQpLnNvcnQoKSkge1xuICAgICAgc29ydGVkW2tleV0gPSBzb3J0SnNvbktleXMocmVjb3JkW2tleV0pO1xuICAgIH1cbiAgICByZXR1cm4gc29ydGVkO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuLyoqXG4gKiBBIGxpbmUgdGhhdCBpcyBvbmx5IGEgbGlua2FnZSBrZXl3b3JkIGFuZCBhbiBpc3N1ZSByZWZlcmVuY2UsIHN1Y2ggYXNcbiAqIGBQYXJ0IG9mICM0ODAyYCBvciBgQ2xvc2VzIG93bmVyL3JlcG8jMTJgLlxuICpcbiAqIFRoZSBsaW5lIGlzIHRyaW1tZWQgYmVmb3JlIHRoZSB0ZXN0LCBzbyB0aGUgcGF0dGVybiBjYXJyaWVzIG5vIGxlYWRpbmcgb3JcbiAqIHRyYWlsaW5nIHdoaXRlc3BhY2UgcXVhbnRpZmllcnMgYW5kIHN0cmF5IHNwYWNlcyBjYW5ub3QgaGlkZSBhIGxpbmthZ2UgbGluZS5cbiAqIFdoaXRlc3BhY2UgaXMgYWxsb3dlZCBiZXR3ZWVuIHRoZSBudW1iZXIgYW5kIHRoZSBmdWxsIHN0b3AsIG1hdGNoaW5nIHRoZVxuICogcmV2aWV3ZXIncyBgUEFSVF9PRl9TQU1FYCBhbmQgYFBBUlRfT0ZfT1RIRVJgXG4gKiAoYC5jbGF1ZGUvc2tpbGxzL3Jldmlldy1mbGVldC1wcnMvc2NyaXB0cy90ZXN0X2NoYW5nZV9wb2xpY3kudHNgKTsgYSB0ZXN0XG4gKiBydW5zIGJvdGggb3ZlciB0aGUgc2FtZSB0YWJsZSBzbyB0aGV5IGNhbm5vdCBkcmlmdC5cbiAqL1xuY29uc3QgTElOS0FHRV9MSU5FID1cbiAgL14oPzpDbG9zZXN8Rml4ZXN8UmVzb2x2ZXN8UGFydCBvZikgKD86W0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rKT8jXFxkK1sgXFx0XSpcXC4/JC9pO1xuXG4vKipcbiAqIEdpdmUgZWFjaCBsaW5rYWdlLW9ubHkgbGluZSBpdHMgb3duIHBhcmFncmFwaCBiZWZvcmUgYGRlbm8gZm10YCBydW5zLlxuICpcbiAqIGBkZW5vIGZtdGAgam9pbnMgYWRqYWNlbnQgbGluZXMgaW50byBvbmUgcGFyYWdyYXBoLCBzbyBgUGFydCBvZiAjQWAgb3ZlclxuICogYFBhcnQgb2YgI0JgIHdvdWxkIGJlY29tZSBgUGFydCBvZiAjQSBQYXJ0IG9mICNCYCwgd2hpY2ggYnJlYWtzIHRoZVxuICogcmV2aWV3ZXIncyBhbmNob3JlZC1saW5lIHJ1bGUgKElzc3VlICM0ODAyKS4gQSBibGFuayBsaW5lIGdvZXMgYWJvdmUgYW5kXG4gKiBiZWxvdyBlYWNoIGxpbmthZ2UgbGluZSB0aGF0IHRvdWNoZXMgYSBub24tYmxhbmsgbGluZSwgc28gY29uc2VjdXRpdmVcbiAqIGxpbmthZ2UgbGluZXMgZW5kIHVwIHdpdGggZXhhY3RseSBvbmUgYmxhbmsgYmV0d2VlbiB0aGVtLiBMaW5lcyBpbnNpZGUgYVxuICogZmVuY2VkIGNvZGUgYmxvY2sgYXJlIGxlZnQgYWxvbmUsIGFuZCBldmVyeSBvdGhlciBsaW5lIGlzIHVuY2hhbmdlZC4gQVxuICogZmVuY2UgY2xvc2VzIG9ubHkgb24gdGhlIG9wZW5lcidzIGNoYXJhY3RlciB3aXRoIGEgcnVuIGF0IGxlYXN0IGFzIGxvbmcsIGFzXG4gKiBpbiBDb21tb25NYXJrLCBzbyBhIGBgYCBsaW5lIGluc2lkZSBhIH5+fiBibG9jayBkb2VzIG5vdCBlbmQgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc29sYXRlTGlua2FnZUxpbmVzKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGlucHV0ID0gdGV4dC5zcGxpdChcIlxcblwiKTtcbiAgY29uc3Qgb3V0cHV0OiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgb3BlbmVyOiBGZW5jZUxpbmUgfCBudWxsID0gbnVsbDtcbiAgZm9yIChjb25zdCBbaSwgbGluZV0gb2YgaW5wdXQuZW50cmllcygpKSB7XG4gICAgY29uc3QgZmVuY2UgPSBwYXJzZUZlbmNlTGluZShsaW5lKTtcbiAgICBpZiAob3BlbmVyID09PSBudWxsICYmIGZlbmNlICE9PSBudWxsKSB7XG4gICAgICBvcGVuZXIgPSBmZW5jZTtcbiAgICAgIG91dHB1dC5wdXNoKGxpbmUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChvcGVuZXIgIT09IG51bGwpIHtcbiAgICAgIGlmIChpc0Nsb3NpbmdGZW5jZShsaW5lLCBvcGVuZXIpKSBvcGVuZXIgPSBudWxsO1xuICAgICAgb3V0cHV0LnB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFMSU5LQUdFX0xJTkUudGVzdChsaW5lLnRyaW0oKSkpIHtcbiAgICAgIG91dHB1dC5wdXNoKGxpbmUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICgob3V0cHV0LmF0KC0xKSA/PyBcIlwiKS50cmltKCkgIT09IFwiXCIpIG91dHB1dC5wdXNoKFwiXCIpO1xuICAgIG91dHB1dC5wdXNoKGxpbmUpO1xuICAgIGlmICgoaW5wdXRbaSArIDFdID8/IFwiXCIpLnRyaW0oKSAhPT0gXCJcIikgb3V0cHV0LnB1c2goXCJcIik7XG4gIH1cbiAgcmV0dXJuIG91dHB1dC5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIEZvcm1hdCB0aGUgd29ya2VyJ3Mgb3duIGFyY2hpdmUgTWFya2Rvd24gYW5kIEpTT04sIHRoZW4gY29tbWl0LlxuICpcbiAqIFJ1bnMgYWZ0ZXIgdGhlIHJlcG9zaXRvcnkgZm9ybWF0dGVycy4gT25seSB0aGUgdHdvIHdvcmtlci1vd25lZFxuICogZGlyZWN0b3JpZXMgYXJlIHRvdWNoZWQsIGFuZCBvbmx5IHdoZW4gdGhlIHJlcG9zaXRvcnkgdHJhY2tzIGEgRGVub1xuICogY29uZmlnIOKAlCB0aGF0IGlzIHRoZSBmb3JtYXR0ZXIgdGhlIHByZS1wdXNoIGdhdGUgd2lsbCBjaGVjayB0aGVtIHdpdGguXG4gKiBCZWZvcmUgYGRlbm8gZm10YCBydW5zLCBlYWNoIE1hcmtkb3duIGZpbGUgaGFzIGl0cyBsaW5rYWdlLW9ubHkgbGluZXNcbiAqIGlzb2xhdGVkIChzZWUge0BsaW5rIGlzb2xhdGVMaW5rYWdlTGluZXN9KSBhbmQgZWFjaCBKU09OIGZpbGUgaXMgcmV3cml0dGVuXG4gKiB3aXRoIHNvcnRlZCBrZXlzOyBhIGZpbGUgaXMgd3JpdHRlbiBiYWNrIG9ubHkgd2hlbiBpdCBjaGFuZ2VkLiBGaWxlcyBvdmVyXG4gKiBNQVhfQVJDSElWRV9SRVdSSVRFX0JZVEVTIGFyZSBza2lwcGVkIHdpdGggYSB3YXJuaW5nIGFuZCBsZWZ0IGZvciB0aGUgZ2F0ZVxuICogdG8gcmVwb3J0LiBBIG1pc3NpbmcgZm9ybWF0dGVyLCBhIHdyaXRlIGZhaWx1cmUsIG9yIGEgZm9ybWF0dGVyIHRoYXQgZXhpdHNcbiAqIG5vbi16ZXJvIGlzIGxvZ2dlZC5cbiAqIFRoaXMgZnVuY3Rpb24gbmV2ZXIgdGhyb3dzLCBzbyB0aGUgZ2F0ZSBzdGlsbCBydW5zLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZm9ybWF0V29ya2VyT3duZWRBcmNoaXZlKFxuICByZXBvUGF0aDogc3RyaW5nLFxuICBiYXNlUmVmOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGRlcHM6IFJlcG9Gb3JtYXR0ZXJEZXBzLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZ2l0OiBQcmVQdXNoR2l0ID0gYXN5bmMgKGFyZ3MsIGN3ZCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGVwcy5ydW5HaXRDb21tYW5kKGFyZ3MsIHsgY3dkIH0pO1xuICAgICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgICAgcmV0dXJuIHsgY29kZTogMSwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IHJlc3VsdC5lcnJvci5tZXNzYWdlIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzdWx0LnZhbHVlO1xuICAgIH07XG4gICAgY29uc3QgY2hhbmdlZCA9IGF3YWl0IGxpc3RQdXNoZWRGaWxlcyhcbiAgICAgIFt7XG4gICAgICAgIGxvY2FsUmVmOiBcIkhFQURcIixcbiAgICAgICAgbG9jYWxTaGE6IFwiSEVBRFwiLFxuICAgICAgICByZW1vdGVSZWY6IFwiSEVBRFwiLFxuICAgICAgICByZW1vdGVTaGE6IFwiMFwiLnJlcGVhdCg0MCksXG4gICAgICB9XSxcbiAgICAgIHJlcG9QYXRoLFxuICAgICAgZ2l0LFxuICAgICAgYmFzZVJlZixcbiAgICApO1xuICAgIGlmICghY2hhbmdlZC5vaykge1xuICAgICAgZGVwcy5sb2dnZXIud2FybihgcmVwbyBmb3JtYXR0ZXJzOiAke2NoYW5nZWQuZXJyb3J9YCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGFyY2hpdmVGaWxlcyA9IGNoYW5nZWQudmFsdWUuZmlsdGVyKGlzV29ya2VyT3duZWRBcmNoaXZlRmlsZSk7XG4gICAgaWYgKGFyY2hpdmVGaWxlcy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIGNvbnN0IHRyYWNrZWQgPSBhd2FpdCBkZXBzLnJ1bkdpdENvbW1hbmQoW1wibHMtZmlsZXNcIiwgXCItelwiXSwge1xuICAgICAgY3dkOiByZXBvUGF0aCxcbiAgICB9KTtcbiAgICBpZiAoIXRyYWNrZWQub2sgfHwgdHJhY2tlZC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgICBkZXBzLmxvZ2dlci53YXJuKFxuICAgICAgICBgcmVwbyBmb3JtYXR0ZXJzOiAke2dpdFN0ZXBFcnJvcihcImxzLWZpbGVzXCIsIHRyYWNrZWQpfWAsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCB0cmFja2VkUGF0aHMgPSB0cmFja2VkLnZhbHVlLnN0ZG91dC5zcGxpdChcIlxcMFwiKS5maWx0ZXIoKHApID0+XG4gICAgICBwLmxlbmd0aCA+IDBcbiAgICApO1xuICAgIGlmICghdHJhY2tlZFBhdGhzLnNvbWUoaXNEZW5vQ29uZmlnKSkge1xuICAgICAgZGVwcy5sb2dnZXIuaW5mbyhcbiAgICAgICAgXCJyZXBvIGZvcm1hdHRlcnM6IG5vIERlbm8gZm9ybWF0dGVyIGluIHRoaXMgcmVwb3NpdG9yeTsgXCIgK1xuICAgICAgICAgIFwid29ya2VyLW93bmVkIGFyY2hpdmUgTWFya2Rvd24gYW5kIEpTT04gbGVmdCBmb3IgdGhlIGdhdGVcIixcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc2tpcHBlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgcGF0aCBvZiBhcmNoaXZlRmlsZXMpIHtcbiAgICAgIGNvbnN0IGxvd2VyID0gcGF0aC50b0xvd2VyQ2FzZSgpO1xuICAgICAgY29uc3QgaXNNYXJrZG93biA9IGxvd2VyLmVuZHNXaXRoKFwiLm1kXCIpIHx8IGxvd2VyLmVuZHNXaXRoKFwiLm1hcmtkb3duXCIpO1xuICAgICAgY29uc3QgaXNKc29uID0gbG93ZXIuZW5kc1dpdGgoXCIuanNvblwiKSB8fCBsb3dlci5lbmRzV2l0aChcIi5qc29uY1wiKTtcbiAgICAgIGlmICghaXNNYXJrZG93biAmJiAhaXNKc29uKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGFic29sdXRlID0gYCR7cmVwb1BhdGh9LyR7cGF0aH1gO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gYGxpc3RQdXNoZWRGaWxlc2AgaGFzIGFscmVhZHkgZHJvcHBlZCBzeW1saW5rcyBhbmQgcGF0aHMgdGhhdFxuICAgICAgICAvLyByZXNvbHZlIG91dHNpZGUgdGhlIGNoZWNrb3V0OyB0aGUgY2FwIGtlZXBzIGEgaHVnZSBmaWxlIG91dCBvZiBtZW1vcnkuXG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBEZW5vLmxzdGF0KGFic29sdXRlKTtcbiAgICAgICAgaWYgKGluZm8uc2l6ZSA+IE1BWF9BUkNISVZFX1JFV1JJVEVfQllURVMpIHtcbiAgICAgICAgICBza2lwcGVkLmFkZChwYXRoKTtcbiAgICAgICAgICBkZXBzLmxvZ2dlci53YXJuKFxuICAgICAgICAgICAgYHJlcG8gZm9ybWF0dGVyczogc2tpcHBlZCAke3BhdGh9OiBsYXJnZXIgdGhhbiAke01BWF9BUkNISVZFX1JFV1JJVEVfQllURVN9IGJ5dGVzYCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShhYnNvbHV0ZSk7XG4gICAgICAgIGNvbnN0IHJld3JpdHRlbiA9IGlzTWFya2Rvd25cbiAgICAgICAgICA/IGlzb2xhdGVMaW5rYWdlTGluZXMoY3VycmVudClcbiAgICAgICAgICA6IGNhbm9uaWNhbEFyY2hpdmVKc29uKGN1cnJlbnQpO1xuICAgICAgICBpZiAocmV3cml0dGVuICE9PSB1bmRlZmluZWQgJiYgcmV3cml0dGVuICE9PSBjdXJyZW50KSB7XG4gICAgICAgICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGFic29sdXRlLCByZXdyaXR0ZW4pO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgICAgICBkZXBzLmxvZ2dlci53YXJuKFxuICAgICAgICAgIGByZXBvIGZvcm1hdHRlcnM6IGNvdWxkIG5vdCByZXdyaXRlICR7cGF0aH06ICR7XG4gICAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgICB9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBmb3JtYXRQYXRocyA9IGFyY2hpdmVGaWxlcy5maWx0ZXIoKHBhdGgpID0+ICFza2lwcGVkLmhhcyhwYXRoKSk7XG4gICAgLy8gYGRlbm8gZm10YCB3aXRoIG5vIHBhdGhzIGZvcm1hdHMgdGhlIHdob2xlIHJlcG9zaXRvcnk6IG5ldmVyIHJ1biBpdCBlbXB0eS5cbiAgICBpZiAoZm9ybWF0UGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBjb25zdCB7IGV4aXRDb2RlLCBvdXRwdXQgfSA9IGF3YWl0IGRlcHMucnVuQ29tbWFuZChcbiAgICAgIFtcbiAgICAgICAgXCJkZW5vXCIsXG4gICAgICAgIFwiZm10XCIsXG4gICAgICAgIFwiLS1wZXJtaXQtbm8tZmlsZXNcIixcbiAgICAgICAgLi4uZm9ybWF0UGF0aHMubWFwKChwYXRoKSA9PiBwYXRoLnN0YXJ0c1dpdGgoXCItXCIpID8gYC4vJHtwYXRofWAgOiBwYXRoKSxcbiAgICAgIF0sXG4gICAgICB7IHN0ZGluOiBcIm51bGxcIiwgY3dkOiByZXBvUGF0aCB9LFxuICAgICk7XG4gICAgY29uc3QgZGlmZiA9IGF3YWl0IGRlcHMucnVuR2l0Q29tbWFuZChcbiAgICAgIFtcbiAgICAgICAgXCJkaWZmXCIsXG4gICAgICAgIFwiLS1uYW1lLW9ubHlcIixcbiAgICAgICAgXCItelwiLFxuICAgICAgICBcIi0tXCIsXG4gICAgICAgIC4uLmZvcm1hdFBhdGhzLm1hcCgocGF0aCkgPT4gYDoobGl0ZXJhbCkke3BhdGh9YCksXG4gICAgICBdLFxuICAgICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICAgKTtcbiAgICBjb25zdCBkaWZmRXJyb3IgPSBnaXRTdGVwRXJyb3IoXCJkaWZmIC0tbmFtZS1vbmx5XCIsIGRpZmYpO1xuICAgIGNvbnN0IGNoYW5nZWRDb3VudCA9IGRpZmYub2sgJiYgZGlmZi52YWx1ZS5jb2RlID09PSAwXG4gICAgICA/IGRpZmYudmFsdWUuc3Rkb3V0LnNwbGl0KFwiXFwwXCIpLmZpbHRlcigobmFtZSkgPT5cbiAgICAgICAgZm9ybWF0UGF0aHMuaW5jbHVkZXMobmFtZSlcbiAgICAgICkubGVuZ3RoXG4gICAgICA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjb3VudFRleHQgPSBjaGFuZ2VkQ291bnQgPT09IHVuZGVmaW5lZFxuICAgICAgPyBcImNvdWxkIG5vdCBjb3VudCBjaGFuZ2VkIGZpbGVzXCJcbiAgICAgIDogYCR7Y2hhbmdlZENvdW50fSBmaWxlcyBjaGFuZ2VkYDtcbiAgICBpZiAoZXhpdENvZGUgPT09IDApIHtcbiAgICAgIGRlcHMubG9nZ2VyLmluZm8oXG4gICAgICAgIGBGb3JtYXR0ZXIgZGVubyBmbXQgb24gd29ya2VyLW93bmVkIGFyY2hpdmU6IGV4aXQgJHtleGl0Q29kZX0sICR7Y291bnRUZXh0fWAsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBkZXBzLmxvZ2dlci53YXJuKFxuICAgICAgICBgRm9ybWF0dGVyIGRlbm8gZm10IG9uIHdvcmtlci1vd25lZCBhcmNoaXZlOiBleGl0ICR7ZXhpdENvZGV9LCAke2NvdW50VGV4dH0g4oCUICR7XG4gICAgICAgICAgcmVkYWN0ZWRIZWFkVGFpbChvdXRwdXQsIDUwMCwgNTAwKVxuICAgICAgICB9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChkaWZmRXJyb3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgZGVwcy5sb2dnZXIud2FybihgcmVwbyBmb3JtYXR0ZXJzOiAke2RpZmZFcnJvcn1gKTtcbiAgICB9XG4gICAgaWYgKGNoYW5nZWRDb3VudCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgY29uc3QgZ2l0RXJyb3IgPSBhd2FpdCBjb21taXRUcmFja2VkUGF0aHMocmVwb1BhdGgsIGRlcHMsIGZvcm1hdFBhdGhzKTtcbiAgICBpZiAoZ2l0RXJyb3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgZGVwcy5sb2dnZXIud2FybihgcmVwbyBmb3JtYXR0ZXJzOiAke2dpdEVycm9yfWApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkZXBzLmxvZ2dlci5pbmZvKFxuICAgICAgXCJyZXBvIGZvcm1hdHRlcnM6IGNvbW1pdHRlZCB3b3JrZXItb3duZWQgYXJjaGl2ZSBmb3JtYXR0aW5nXCIsXG4gICAgKTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBkZXBzLmxvZ2dlci53YXJuKFxuICAgICAgYHJlcG8gZm9ybWF0dGVyczogd29ya2VyLW93bmVkIGFyY2hpdmUgc2tpcHBlZDogJHtcbiAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gICAgICB9YCxcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogUnVuIHRoZSByZXBvc2l0b3J5J3MgZm9ybWF0dGVycyBvdmVyIGBjaGFuZ2VkYCBhbmQgY29tbWl0IHRoZSByZXN1bHQuXG4gKlxuICogT25seSB0aGUgZmlsZXMgYSBjaGFuZ2VkLWZpbGUgY2hlY2sgKGBwbGFuQ2hhbmdlZEZpbGVDaGVja3NgKSB3b3VsZCBmbGFnXG4gKiBhcmUgZm9ybWF0dGVkIOKAlCBzZWUgYHBsYW5Gb3JtYXR0ZXJGaXhlc2A6IG5ldmVyIE1hcmtkb3duLCBuZXZlciBhblxuICogdW50b3VjaGVkIGNvZGUgZmlsZSB1bmRlciBgZGVubyBmbXRgLCBhbmQgYGNhcmdvIGZtdCAtLWFsbGAgb25seSBmb3IgYVxuICogY2FyZ28gcm9vdCB3aG9zZSBgLnJzYCBmaWxlcyBjaGFuZ2VkLiBPbmx5IHRob3NlIHBhdGhzIGFyZSBzdGFnZWQgKGBnaXQgYWRkXG4gKiAtdSAtLSA8cGF0aHM+YCksIHNvIGFuIHVucmVsYXRlZCBlZGl0IGVsc2V3aGVyZSBpbiB0aGUgdHJlZSBzdGF5cyBvdXQgb2YgdGhlXG4gKiBjb21taXQ7IGFuIHVuY29tbWl0dGVkIGVkaXQgYWxyZWFkeSBpbiBhIGZvcm1hdHRlZCBmaWxlIGRvZXMgZ28gaW4gd2l0aCBpdC5cbiAqIE5ldmVyIHRocm93czogYW55IHVuZXhwZWN0ZWQgZmFpbHVyZSBpcyBsb2dnZWQgYW5kIHJlcG9ydGVkIHZpYSBgZ2l0RXJyb3JgXG4gKiBpbnN0ZWFkLCBhbmQgYSBmb3JtYXR0ZXIgdGhhdCBmYWlscyBpcyBsb2dnZWQgYW5kIHJlY29yZGVkIGluIGBmYWlsdXJlc2Ag4oCUXG4gKiB0aGUgY2FsbGVyJ3Mgb3duIGNoZWNrIHN0aWxsIHJ1bnMgYW5kIHJlcG9ydHMgd2hhdCB3YXMgbGVmdCB1bmZpeGVkLlxuICpcbiAqIEBwYXJhbSBjaGFuZ2VkIC0gUmVwby1yZWxhdGl2ZSBwYXRocyB0aGUgcnVuIGNoYW5nZWQgKGFzIGBnaXQgbG9nXG4gKiAgIC0tbmFtZS1vbmx5YCBwcmludHMgdGhlbSkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5SZXBvRm9ybWF0dGVycyhcbiAgcmVwb1BhdGg6IHN0cmluZyxcbiAgY2hhbmdlZDogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGRlcHM6IFJlcG9Gb3JtYXR0ZXJEZXBzID0gY3JlYXRlUmVwb0Zvcm1hdHRlckRlcHMoKSxcbik6IFByb21pc2U8UmVwb0Zvcm1hdHRlcnNSZXN1bHQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBsc0ZpbGVzID0gYXdhaXQgZGVwcy5ydW5HaXRDb21tYW5kKFtcImxzLWZpbGVzXCIsIFwiLXpcIl0sIHtcbiAgICAgIGN3ZDogcmVwb1BhdGgsXG4gICAgfSk7XG4gICAgaWYgKCFsc0ZpbGVzLm9rIHx8IGxzRmlsZXMudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgY29uc3QgZ2l0RXJyb3IgPSBnaXRTdGVwRXJyb3IoXCJscy1maWxlc1wiLCBsc0ZpbGVzKSE7XG4gICAgICBkZXBzLmxvZ2dlci53YXJuKGByZXBvIGZvcm1hdHRlcnM6ICR7Z2l0RXJyb3J9YCk7XG4gICAgICByZXR1cm4geyBydW5zOiBbXSwgZmFpbHVyZXM6IFtdLCBjb21taXR0ZWQ6IGZhbHNlLCBnaXRFcnJvciB9O1xuICAgIH1cbiAgICBjb25zdCBwYXRocyA9IGxzRmlsZXMudmFsdWUuc3Rkb3V0LnNwbGl0KFwiXFwwXCIpLmZpbHRlcigocCkgPT4gcC5sZW5ndGggPiAwKTtcblxuICAgIGNvbnN0IHN0ZXBzID0gcGxhbkZvcm1hdHRlckZpeGVzKFxuICAgICAgY2hhbmdlZCxcbiAgICAgIHBhdGhzLFxuICAgICAgYXdhaXQgbG9hZERlbm9TY29wZXMocmVwb1BhdGgsIHBhdGhzKSxcbiAgICApO1xuICAgIGlmIChzdGVwcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiB7IHJ1bnM6IFtdLCBmYWlsdXJlczogW10sIGNvbW1pdHRlZDogZmFsc2UgfTtcbiAgICB9XG5cbiAgICBjb25zdCBpbml0aWFsU25hcHNob3QgPSBhd2FpdCBzbmFwc2hvdChyZXBvUGF0aCwgZGVwcyk7XG4gICAgaWYgKCFpbml0aWFsU25hcHNob3Qub2spIHtcbiAgICAgIGNvbnN0IGdpdEVycm9yID0gaW5pdGlhbFNuYXBzaG90LmVycm9yLm1lc3NhZ2U7XG4gICAgICBkZXBzLmxvZ2dlci53YXJuKGByZXBvIGZvcm1hdHRlcnM6ICR7Z2l0RXJyb3J9YCk7XG4gICAgICByZXR1cm4geyBydW5zOiBbXSwgZmFpbHVyZXM6IFtdLCBjb21taXR0ZWQ6IGZhbHNlLCBnaXRFcnJvciB9O1xuICAgIH1cblxuICAgIGNvbnN0IHJ1bnM6IEZvcm1hdHRlclJ1bltdID0gW107XG4gICAgY29uc3QgZmFpbHVyZXM6IEZvcm1hdHRlclJ1bltdID0gW107XG4gICAgbGV0IGJlZm9yZSA9IGluaXRpYWxTbmFwc2hvdC52YWx1ZTtcblxuICAgIGZvciAoY29uc3Qgc3RlcCBvZiBzdGVwcykge1xuICAgICAgY29uc3QgeyBleGl0Q29kZSwgb3V0cHV0IH0gPSBhd2FpdCBkZXBzLnJ1bkNvbW1hbmQoc3RlcC5jbWQsIHtcbiAgICAgICAgc3RkaW46IFwibnVsbFwiLFxuICAgICAgICBjd2Q6IHJlc29sdmVEaXIocmVwb1BhdGgsIHN0ZXAuZGlyKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgYWZ0ZXIgPSBhd2FpdCBzbmFwc2hvdChyZXBvUGF0aCwgZGVwcyk7XG4gICAgICBjb25zdCBjaGFuZ2VkID0gYWZ0ZXIub2sgPyBhZnRlci52YWx1ZSAhPT0gYmVmb3JlIDogZmFsc2U7XG5cbiAgICAgIGNvbnN0IHJ1bjogRm9ybWF0dGVyUnVuID0ge1xuICAgICAgICB0b29sOiBzdGVwLnRvb2wsXG4gICAgICAgIGRpcjogc3RlcC5kaXIsXG4gICAgICAgIGV4aXRDb2RlLFxuICAgICAgICBjaGFuZ2VkLFxuICAgICAgICAuLi4oZXhpdENvZGUgIT09IDBcbiAgICAgICAgICA/IHsgZXhjZXJwdDogcmVkYWN0ZWRIZWFkVGFpbChvdXRwdXQsIDUwMCwgNTAwKSB9XG4gICAgICAgICAgOiB7fSksXG4gICAgICB9O1xuICAgICAgcnVucy5wdXNoKHJ1bik7XG5cbiAgICAgIGlmIChleGl0Q29kZSA9PT0gMCkge1xuICAgICAgICBkZXBzLmxvZ2dlci5pbmZvKFxuICAgICAgICAgIGBGb3JtYXR0ZXIgJHtzdGVwLnRvb2x9IGluICR7c3RlcC5kaXJ9OiBleGl0ICR7ZXhpdENvZGV9LCAke1xuICAgICAgICAgICAgY2hhbmdlZCA/IFwiZmlsZXMgY2hhbmdlZFwiIDogXCJubyBjaGFuZ2VzXCJcbiAgICAgICAgICB9YCxcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZhaWx1cmVzLnB1c2gocnVuKTtcbiAgICAgICAgZGVwcy5sb2dnZXIud2FybihcbiAgICAgICAgICBgRm9ybWF0dGVyICR7c3RlcC50b29sfSBpbiAke3N0ZXAuZGlyfTogZXhpdCAke2V4aXRDb2RlfSwgJHtcbiAgICAgICAgICAgIGNoYW5nZWQgPyBcImZpbGVzIGNoYW5nZWRcIiA6IFwibm8gY2hhbmdlc1wiXG4gICAgICAgICAgfSDigJQgJHtydW4uZXhjZXJwdH1gLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICAvLyBBIHNuYXBzaG90IHRoYXQgZmFpbGVkIG1pZC1sb29wIG11c3Qgbm90IGJlIHNpbGVudGx5IHJlYWQgYXMgXCJub1xuICAgICAgLy8gY2hhbmdlXCIg4oCUIHRoZSB0cmVlJ3MgcmVhbCBzdGF0ZSBhZnRlcndhcmRzIGlzIHVua25vd24sIHNvIHN0YWdpbmcgYW5kXG4gICAgICAvLyBjb21taXR0aW5nIG9uIGEgc3RhbGUgYGJlZm9yZWAgcmlza3MgZm9sZGluZyBhbiB1bnJlbGF0ZWQgb3IgbWlzc2luZ1xuICAgICAgLy8gY2hhbmdlIGludG8gdGhlIGZvcm1hdHRlcnMnIGNvbW1pdC4gRmFpbCBsb3VkIGluc3RlYWQuXG4gICAgICBpZiAoIWFmdGVyLm9rKSB7XG4gICAgICAgIGNvbnN0IGdpdEVycm9yID0gYWZ0ZXIuZXJyb3IubWVzc2FnZTtcbiAgICAgICAgZGVwcy5sb2dnZXIud2FybihgcmVwbyBmb3JtYXR0ZXJzOiAke2dpdEVycm9yfWApO1xuICAgICAgICByZXR1cm4geyBydW5zLCBmYWlsdXJlcywgY29tbWl0dGVkOiBmYWxzZSwgZ2l0RXJyb3IgfTtcbiAgICAgIH1cbiAgICAgIGJlZm9yZSA9IGFmdGVyLnZhbHVlO1xuICAgIH1cblxuICAgIGlmIChiZWZvcmUgPT09IGluaXRpYWxTbmFwc2hvdC52YWx1ZSkge1xuICAgICAgcmV0dXJuIHsgcnVucywgZmFpbHVyZXMsIGNvbW1pdHRlZDogZmFsc2UgfTtcbiAgICB9XG5cbiAgICBjb25zdCBnaXRFcnJvciA9IGF3YWl0IGNvbW1pdFRyYWNrZWRQYXRocyhcbiAgICAgIHJlcG9QYXRoLFxuICAgICAgZGVwcyxcbiAgICAgIHN0ZXBzLmZsYXRNYXAoKHN0ZXApID0+IHN0ZXAucGF0aHMpLFxuICAgICk7XG4gICAgaWYgKGdpdEVycm9yICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlcHMubG9nZ2VyLndhcm4oYHJlcG8gZm9ybWF0dGVyczogJHtnaXRFcnJvcn1gKTtcbiAgICAgIHJldHVybiB7IHJ1bnMsIGZhaWx1cmVzLCBjb21taXR0ZWQ6IGZhbHNlLCBnaXRFcnJvciB9O1xuICAgIH1cblxuICAgIGRlcHMubG9nZ2VyLmluZm8oXCJyZXBvIGZvcm1hdHRlcnM6IGNvbW1pdHRlZCBmb3JtYXR0ZXIgb3V0cHV0XCIpO1xuICAgIHJldHVybiB7IHJ1bnMsIGZhaWx1cmVzLCBjb21taXR0ZWQ6IHRydWUgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBjb25zdCBnaXRFcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICBkZXBzLmxvZ2dlci53YXJuKGByZXBvIGZvcm1hdHRlcnM6IHVuZXhwZWN0ZWQgZXJyb3I6ICR7Z2l0RXJyb3J9YCk7XG4gICAgcmV0dXJuIHsgcnVuczogW10sIGZhaWx1cmVzOiBbXSwgY29tbWl0dGVkOiBmYWxzZSwgZ2l0RXJyb3IgfTtcbiAgfVxufVxuXG4vKipcbiAqIFJ1biB0aGUgZm9ybWF0dGVycyBvdmVyIGV2ZXJ5IGZpbGUgdGhlIGJyYW5jaCBjaGFuZ2VkLCB0aGVuIGNvbW1pdC5cbiAqXG4gKiBUaGUgZmlsZSBsaXN0IGlzIHRoZSBwcmUtcHVzaCBnYXRlJ3Mgb3duIChgbGlzdFB1c2hlZEZpbGVzYCk6IGV2ZXJ5XG4gKiBjb21taXQgYWhlYWQgb2YgYGJhc2VSZWZgIChmb3IgYSBtZXJnZSBjb21taXQsIG9ubHkgdGhlIHBhdGhzIHRoZSBtZXJnZVxuICogaXRzZWxmIGNoYW5nZWQsIHN1Y2ggYXMgYSBjb25mbGljdCByZXNvbHV0aW9uKSwgb3Ig4oCUIHdpdGggbm8gYGJhc2VSZWZgICh0aGUgUFIgYmFzZVxuICogY291bGQgbm90IGJlIHJlc29sdmVkLCBvciBhIFBSIHJvdW5kIHdob3NlIGBjb21taXRBbmRQdXNoUGVuZGluZ2AgU3RlcCAxYlxuICogZ2F0ZSBjaGVja3Mgb25seSB0aGVzZSkg4oCUIGV2ZXJ5IGNvbW1pdCBvbiBubyByZW1vdGUtdHJhY2tpbmcgcmVmLCBzbyB0aGVcbiAqIGZvcm1hdHRlcnMgYW5kXG4gKiB0aGUgZ2F0ZSB0aGF0IGZvbGxvd3MgYWx3YXlzIGFncmVlIG9uIHNjb3BlLiBGaWxlcyBhIG1lcmdlIG1lcmVseVxuICogYnJpbmdzIGluIGZyb20gdGhlIGJhc2UgYXJlIG5ldmVyIHJlZm9ybWF0dGVkLiBOZXZlciB0aHJvd3MuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmb3JtYXRCcmFuY2hDaGFuZ2VzKFxuICByZXBvUGF0aDogc3RyaW5nLFxuICBiYXNlUmVmOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGRlcHM6IFJlcG9Gb3JtYXR0ZXJEZXBzID0gY3JlYXRlUmVwb0Zvcm1hdHRlckRlcHMoKSxcbik6IFByb21pc2U8UmVwb0Zvcm1hdHRlcnNSZXN1bHQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBnaXQ6IFByZVB1c2hHaXQgPSBhc3luYyAoYXJncywgY3dkKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkZXBzLnJ1bkdpdENvbW1hbmQoYXJncywgeyBjd2QgfSk7XG4gICAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgICByZXR1cm4geyBjb2RlOiAxLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogcmVzdWx0LmVycm9yLm1lc3NhZ2UgfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXN1bHQudmFsdWU7XG4gICAgfTtcbiAgICBjb25zdCBjaGFuZ2VkID0gYXdhaXQgbGlzdFB1c2hlZEZpbGVzKFxuICAgICAgW3tcbiAgICAgICAgbG9jYWxSZWY6IFwiSEVBRFwiLFxuICAgICAgICBsb2NhbFNoYTogXCJIRUFEXCIsXG4gICAgICAgIHJlbW90ZVJlZjogXCJIRUFEXCIsXG4gICAgICAgIHJlbW90ZVNoYTogXCIwXCIucmVwZWF0KDQwKSxcbiAgICAgIH1dLFxuICAgICAgcmVwb1BhdGgsXG4gICAgICBnaXQsXG4gICAgICBiYXNlUmVmLFxuICAgICk7XG4gICAgaWYgKCFjaGFuZ2VkLm9rKSB7XG4gICAgICBkZXBzLmxvZ2dlci53YXJuKGByZXBvIGZvcm1hdHRlcnM6ICR7Y2hhbmdlZC5lcnJvcn1gKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJ1bnM6IFtdLFxuICAgICAgICBmYWlsdXJlczogW10sXG4gICAgICAgIGNvbW1pdHRlZDogZmFsc2UsXG4gICAgICAgIGdpdEVycm9yOiBjaGFuZ2VkLmVycm9yLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGNoYW5nZWQudmFsdWUubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4geyBydW5zOiBbXSwgZmFpbHVyZXM6IFtdLCBjb21taXR0ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCBydW5SZXBvRm9ybWF0dGVycyhyZXBvUGF0aCwgY2hhbmdlZC52YWx1ZSwgZGVwcyk7XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgY29uc3QgZ2l0RXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgZGVwcy5sb2dnZXIud2FybihgcmVwbyBmb3JtYXR0ZXJzOiB1bmV4cGVjdGVkIGVycm9yOiAke2dpdEVycm9yfWApO1xuICAgIHJldHVybiB7IHJ1bnM6IFtdLCBmYWlsdXJlczogW10sIGNvbW1pdHRlZDogZmFsc2UsIGdpdEVycm9yIH07XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgaXNzdWUgcnVuJ3MgY2FsbCBzaXRlOiBmb3JtYXQgdGhlIGJyYW5jaCdzIGNoYW5nZXMgYmVmb3JlIGEgZ2F0ZSBydW5zLlxuICpcbiAqIE5ldmVyIHRocm93cyBhbmQgcmV0dXJucyBub3RoaW5nIHRoZSBjYWxsZXIgbXVzdCBhY3Qgb24g4oCUIGEgZm9ybWF0dGVyIHRoYXRcbiAqIGlzIG1pc3NpbmcsIGZhaWxzIG9yIHRocm93cyBpcyBsb2dnZWQgaGVyZSwgYW5kIHRoZSBnYXRlIHRoYXQgZm9sbG93cyBzdGlsbFxuICogcnVucyBhbmQgcmVwb3J0cyB3aGF0ZXZlciBpcyBsZWZ0IHVuZml4ZWQuIEFmdGVyIHRoZSByZXBvc2l0b3J5IGZvcm1hdHRlcnMsXG4gKiB0aGUgd29ya2VyJ3Mgb3duIGFyY2hpdmUgTWFya2Rvd24gYW5kIEpTT04gYXJlIGZvcm1hdHRlZCB0aGUgc2FtZSB3YXlcbiAqIChJc3N1ZSAjNDEyOSkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmb3JtYXRCZWZvcmVHYXRlKFxuICBkZXBzOiB7XG4gICAgZ2l0OiB7IGZvcm1hdEJyYW5jaENoYW5nZXM6IHR5cGVvZiBmb3JtYXRCcmFuY2hDaGFuZ2VzIH07XG4gICAgbG9nZ2VyOiBMb2dnZXI7XG4gICAgLyoqIERlZmF1bHRzIHRvIHRoZSBwcm9kdWN0aW9uIGZvcm1hdHRlciBydW5uZXIsIGxvZ2dpbmcgb24gYGRlcHMubG9nZ2VyYC4gKi9cbiAgICBmb3JtYXR0ZXJEZXBzPzogUmVwb0Zvcm1hdHRlckRlcHM7XG4gIH0sXG4gIHJlcG9QYXRoOiBzdHJpbmcsXG4gIGJhc2VSZWY6IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlcHMuZ2l0LmZvcm1hdEJyYW5jaENoYW5nZXMocmVwb1BhdGgsIGJhc2VSZWYpO1xuICAgIGlmIChyZXN1bHQuY29tbWl0dGVkKSB7XG4gICAgICBkZXBzLmxvZ2dlci5pbmZvKFxuICAgICAgICBgRm9ybWF0dGVkIHRoZSBicmFuY2gncyBjaGFuZ2VkIGZpbGVzIGJlZm9yZSB0aGUgZ2F0ZSBgICtcbiAgICAgICAgICBgKCR7Rk9STUFUVEVSX0NPTU1JVF9NRVNTQUdFfSlgLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgZGVwcy5sb2dnZXIud2FybihcbiAgICAgIGByZXBvIGZvcm1hdHRlcnM6IHNraXBwZWQgYmVmb3JlIHRoZSBnYXRlOiAke1xuICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgIH1gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgZm9ybWF0dGVyRGVwcyA9IGRlcHMuZm9ybWF0dGVyRGVwcyA/PyB7XG4gICAgLi4uY3JlYXRlUmVwb0Zvcm1hdHRlckRlcHMoKSxcbiAgICBsb2dnZXI6IGRlcHMubG9nZ2VyLFxuICB9O1xuICBhd2FpdCBmb3JtYXRXb3JrZXJPd25lZEFyY2hpdmUocmVwb1BhdGgsIGJhc2VSZWYsIGZvcm1hdHRlckRlcHMpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBK0JDLEdBRUQsU0FFRSxrQkFBa0IsUUFDYiwwQkFBMEI7QUFDakMsU0FHRSxhQUFhLFFBQ1IsbUJBQW1CO0FBQzFCLFNBQVMsYUFBYSxRQUFRLGNBQWM7QUFDNUMsU0FFRSxjQUFjLEVBQ2QsY0FBYyxRQUNULDJCQUEyQjtB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
// denoCacheMetadata=8244923413795392648,4298420932122685463