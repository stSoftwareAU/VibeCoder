/**
 * Quality gate check: run Semgrep's CI ruleset over the branch's changed
 * files (Issue #559).
 *
 * `semgrep ci --config p/default` is a **blocking** PR check
 * (`.github/workflows/semgrep.yml`), but nothing ran it locally — so an
 * agent's first sight of a SAST finding was a red PR, after the branch, the
 * push and a review cycle. Two PRs sat blocked on the same
 * `detect-non-literal-regexp` rule because two agents wrote the same shape
 * and neither could know until CI told them.
 *
 * The check is deliberately narrow so it never becomes the critical path:
 *
 *   - **Changed files only.** The branch's diff against the merge-base with
 *     the remote's default branch, plus uncommitted and untracked files. A
 *     docs-only change scans nothing and returns PASSED immediately.
 *   - **Same ruleset, pinned the same way.** `p/default`, and where a
 *     container runtime already holds the CI image the scan runs inside
 *     `SEMGREP_IMAGE` — the tag+digest reference `semgrep.yml` uses — so a
 *     local pass predicts a CI pass. A PATH binary on a different version is
 *     used too, with the drift named in the output.
 *   - **Skip loudly, never silently.** No semgrep, no git repository, an
 *     unreachable rule registry or an over-deadline scan all return SKIPPED
 *     with the reason spelled out; `./quality.sh --strict` promotes every
 *     SKIPPED to FAILED. A tool error that is *not* one of those is FAILED —
 *     absence of findings is never read as success.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { SEMGREP_IMAGE, SEMGREP_IMAGE_TAG } from "./pinned_actions.ts";
import { runGitCommand } from "./git_timeout.ts";

/** Status of the semgrep check. */
export type SemgrepStatus = "PASSED" | "SKIPPED" | "FAILED";

/** The ruleset CI runs — kept identical to `.github/workflows/semgrep.yml`. */
export const SEMGREP_CONFIG = "p/default";

/**
 * Wall-clock ceiling for one local scan. The gate runs unattended, so a
 * semgrep that never returns must not wedge the worker; exceeding the
 * deadline is reported as a loud SKIPPED, not a silent pass.
 */
export const SEMGREP_DEADLINE_MS = 300_000;

/**
 * Extensions worth handing to semgrep. Anything else (Markdown, images,
 * lock files) carries no `p/default` rule, and filtering them out is what
 * makes a docs-only change cost nothing.
 */
export const SEMGREP_SCANNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "bash",
  "c",
  "cjs",
  "cpp",
  "cs",
  "dart",
  "go",
  "h",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "lua",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scala",
  "sh",
  "sql",
  "swift",
  "tf",
  "ts",
  "tsx",
  "yaml",
  "yml",
]);

/**
 * The standard remedy for `detect-non-literal-regexp` — the rule that blocked
 * two PRs at once (Issue #559). Named here so an agent meets the fix in the
 * same output as the finding.
 */
export const NON_LITERAL_REGEXP_REMEDY = [
  "Remedy for `detect-non-literal-regexp`: build the regular expression from",
  "a literal, or escape the interpolated value before it reaches the RegExp",
  "constructor (a `escapeRegExp`-style helper over the interpolated text).",
  "A dynamic regex built from agent-authored constants is still flagged — the",
  "pattern has to change rather than be argued with; a suppression needs an",
  "explicit, justified comment.",
].join("\n");

/** Rule identifier suffix that triggers the remedy note above. */
const NON_LITERAL_REGEXP_RULE = "detect-non-literal-regexp";

/** A single semgrep finding, flattened from the JSON report. */
export interface SemgrepFinding {
  /** Path as semgrep reported it. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Rule identifier, e.g. `javascript.lang.security.audit.detect-non-literal-regexp`. */
  ruleId: string;
  /** Severity as reported (`ERROR`, `WARNING`, `INFO`). */
  severity: string;
  /** Rule message. */
  message: string;
}

/** Structured result of running the semgrep check. */
export interface SemgrepCheckResult {
  status: SemgrepStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
  /** Parsed findings (empty unless status is FAILED with findings). */
  findings: SemgrepFinding[];
  /** Number of changed files handed to semgrep. */
  filesScanned: number;
  /** Reason for SKIPPED, when applicable. */
  skipReason?: string;
}

/** Raw subprocess result from one semgrep invocation. */
export interface SemgrepRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the run was aborted at {@link SEMGREP_DEADLINE_MS}. */
  timedOut?: boolean;
}

/** Runs semgrep over the given repo-relative paths. */
export type SemgrepRunner = (files: string[]) => Promise<SemgrepRunResult>;

/** A resolved way to invoke semgrep. */
export interface SemgrepInvocation {
  /** How semgrep will be invoked, for the check output. */
  description: string;
  /** True when the invocation is the tag+digest image CI runs. */
  pinnedToCi: boolean;
  run: SemgrepRunner;
}

/** Resolves an invocation, or null when semgrep cannot be run locally. */
export type DetectSemgrepInvocation = (
  scriptDir: string,
) => Promise<SemgrepInvocation | null>;

/** Result of one git invocation. */
export interface GitRunResult {
  exitCode: number;
  stdout: string;
}

/** Runs `git` with the given arguments inside the repository. */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

// ---------------------------------------------------------------------------
// Changed-file selection
// ---------------------------------------------------------------------------

/** The changed-file set for one working tree. */
export interface ChangedFileSet {
  /** Scannable, de-duplicated, sorted repo-relative paths. */
  files: string[];
  /** The git revision the diff was taken against, for the output. */
  base: string;
}

/** Whether a path carries an extension semgrep has rules for. */
export function isScannablePath(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const name = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SEMGREP_SCANNABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Reduce raw git output lines to the sorted, de-duplicated set of scannable
 * paths. Blank lines and unscannable extensions are dropped.
 */
export function selectScannableFiles(paths: readonly string[]): string[] {
  const selected = new Set<string>();
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    if (!isScannablePath(path)) continue;
    selected.add(path);
  }
  return [...selected].sort();
}

/**
 * Default git runner: `git -C <scriptDir> …` through the shared chokepoint
 * (Issue #1214), so the call is timeout-bounded rather than able to hang the
 * gate.
 */
export function makeGitRunner(scriptDir: string): GitRunner {
  return async (args: string[]) => {
    const result = await runGitCommand(["-C", scriptDir, ...args]);
    if (!result.ok) {
      return { exitCode: 1, stdout: "" };
    }
    return {
      exitCode: result.value.code,
      stdout: result.value.stdout,
    };
  };
}

/**
 * Resolve the revision to diff against: the merge-base with the remote's
 * default branch when it can be resolved, else `HEAD` (which still catches
 * everything uncommitted). Never a hardcoded branch name — the remote's own
 * HEAD is the source of truth.
 */
async function resolveDiffBase(git: GitRunner): Promise<string> {
  const remoteHead = await git([
    "rev-parse",
    "--abbrev-ref",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead.exitCode !== 0) return "HEAD";
  const remoteRef = remoteHead.stdout.trim();
  if (!remoteRef) return "HEAD";

  const mergeBase = await git(["merge-base", remoteRef, "HEAD"]);
  const sha = mergeBase.stdout.trim();
  if (mergeBase.exitCode !== 0 || !sha) return "HEAD";
  return sha;
}

/**
 * Collect the branch's changed files: everything added, copied, modified or
 * renamed since the diff base (committed **and** uncommitted), plus untracked
 * files git would let you add. Deletions are excluded — there is nothing left
 * to scan.
 *
 * Returns null when `scriptDir` is not a git work tree, which the caller
 * reports as a loud SKIPPED.
 */
export async function collectChangedFiles(
  git: GitRunner,
): Promise<ChangedFileSet | null> {
  const insideWorkTree = await git(["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.exitCode !== 0) return null;

  const base = await resolveDiffBase(git);

  const diff = await git([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    base,
  ]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"]);

  const raw = [
    ...diff.stdout.split("\n"),
    ...untracked.stdout.split("\n"),
  ];
  return { files: selectScannableFiles(raw), base };
}

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

interface RawSemgrepResult {
  check_id?: unknown;
  path?: unknown;
  start?: { line?: unknown };
  extra?: { message?: unknown; severity?: unknown };
}

/**
 * Parse semgrep's `--json` report into findings. Entries missing a path or a
 * line are dropped rather than guessed; a report that does not parse at all
 * throws, so the caller can surface the tool error instead of reading an
 * unparseable report as "no findings".
 */
export function parseSemgrepJson(stdout: string): SemgrepFinding[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("semgrep produced no JSON report on stdout");
  }
  const parsed = JSON.parse(trimmed) as { results?: unknown };
  const results = Array.isArray(parsed.results) ? parsed.results : [];

  const findings: SemgrepFinding[] = [];
  for (const entry of results as RawSemgrepResult[]) {
    const file = typeof entry.path === "string" ? entry.path : "";
    const line = typeof entry.start?.line === "number" ? entry.start.line : 0;
    if (!file || line <= 0) continue;
    findings.push({
      file,
      line,
      ruleId: typeof entry.check_id === "string" ? entry.check_id : "unknown",
      severity: typeof entry.extra?.severity === "string"
        ? entry.extra.severity
        : "UNKNOWN",
      message: typeof entry.extra?.message === "string"
        ? entry.extra.message.trim()
        : "",
    });
  }
  return findings;
}

/**
 * Whether a failed run failed because the rule registry could not be reached.
 *
 * `p/default` is fetched from semgrep.dev, so an offline host cannot scan at
 * all. That is "the tool is unavailable", not "the code is clean" — it is
 * reported as a loud SKIPPED, and strict mode still fails on it.
 */
export function isRegistryUnavailable(output: string): boolean {
  return /failed to (?:download|fetch|load) config|connection (?:error|refused|aborted|reset)|network is unreachable|temporary failure in name resolution|max retries exceeded|could not resolve host/i
    .test(output);
}

// ---------------------------------------------------------------------------
// Invocation detection
// ---------------------------------------------------------------------------

/** Semgrep CLI arguments shared by every invocation. */
export function semgrepScanArgs(files: readonly string[]): string[] {
  return [
    "scan",
    "--config",
    SEMGREP_CONFIG,
    "--json",
    "--quiet",
    // No telemetry from an unattended agent container.
    "--metrics=off",
    // Exit non-zero on findings, matching `semgrep ci`.
    "--error",
    // A changed file can be named `--something`; `--` keeps every path a
    // path rather than an option (CWE-88).
    "--",
    ...files,
  ];
}

/**
 * Arguments for running the CI-pinned semgrep image under a container
 * runtime. The repository is mounted read-only — the scan never writes.
 */
export function buildContainerArgs(
  scriptDir: string,
  files: readonly string[],
  imageRef: string = SEMGREP_IMAGE,
): string[] {
  return [
    "run",
    "--rm",
    "-v",
    `${scriptDir}:/src:ro`,
    "-w",
    "/src",
    imageRef,
    "semgrep",
    ...semgrepScanArgs(files),
  ];
}

/** The result of a run cut short at the deadline. */
const TIMED_OUT: SemgrepRunResult = {
  exitCode: -1,
  stdout: "",
  stderr: "",
  timedOut: true,
};

/** Spawn a command with the scan deadline applied. */
async function spawnWithDeadline(
  binary: string,
  args: string[],
  cwd: string,
): Promise<SemgrepRunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEMGREP_DEADLINE_MS);
  try {
    const command = new Deno.Command(binary, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const result = await command.output();
    // An aborted child is killed rather than throwing, so the signal — not the
    // exit code — is what identifies a deadline hit.
    if (controller.signal.aborted) return TIMED_OUT;
    return {
      exitCode: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } catch (err) {
    if (controller.signal.aborted) return TIMED_OUT;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `<binary> <probeArgs>` and return its stdout, or null if it cannot run. */
async function probe(
  binary: string,
  probeArgs: string[],
): Promise<string | null> {
  try {
    const command = new Deno.Command(binary, {
      args: probeArgs,
      stdout: "piped",
      stderr: "null",
    });
    const result = await command.output();
    if (!result.success) return null;
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

/**
 * Detect how semgrep can be run locally.
 *
 * Order:
 *   1. A `semgrep` binary on PATH — fastest, and the common developer setup.
 *      Version drift from the CI pin is reported, not fatal.
 *   2. A container runtime that **already holds** the CI-pinned image. The
 *      image is never pulled here: a multi-hundred-megabyte download in the
 *      middle of `./quality.sh` is exactly the critical-path cost this check
 *      must not add.
 *
 * Returns null when neither is available, which the caller reports as a loud
 * SKIPPED naming both ways to fix it.
 */
export const detectSemgrepInvocation: DetectSemgrepInvocation = async (
  scriptDir: string,
): Promise<SemgrepInvocation | null> => {
  const version = await probe("semgrep", ["--version"]);
  if (version !== null) {
    const pinnedToCi = version === SEMGREP_IMAGE_TAG;
    const drift = pinnedToCi
      ? ""
      : ` — differs from the CI pin ${SEMGREP_IMAGE_TAG}, so a local pass is` +
        " not a guarantee";
    return {
      description: `semgrep ${version || "(unknown version)"} on PATH${drift}`,
      pinnedToCi,
      run: (files) =>
        spawnWithDeadline("semgrep", semgrepScanArgs(files), scriptDir),
    };
  }

  for (const runtime of ["docker", "podman"]) {
    if (await probe(runtime, ["--version"]) === null) continue;
    // Present locally? `image inspect` succeeds only for an image already
    // in the local store, so nothing is downloaded by this check.
    if (await probe(runtime, ["image", "inspect", SEMGREP_IMAGE]) === null) {
      continue;
    }
    return {
      description: `${runtime} run ${SEMGREP_IMAGE} (the image CI runs)`,
      pinnedToCi: true,
      run: (files) =>
        spawnWithDeadline(
          runtime,
          buildContainerArgs(scriptDir, files),
          scriptDir,
        ),
    };
  }

  return null;
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** Options for {@link runSemgrepCheck} (injection points for the tests). */
export interface SemgrepCheckOptions {
  /** Inject an invocation detector. Returning null forces SKIPPED. */
  detectInvocation?: DetectSemgrepInvocation;
  /** Inject a git runner. */
  git?: GitRunner;
}

/** Build the SKIPPED result, with the reason spelled out. */
function skipped(reason: string): SemgrepCheckResult {
  return {
    status: "SKIPPED",
    output: `semgrep: SKIPPED (${reason})`,
    findings: [],
    filesScanned: 0,
    skipReason: reason,
  };
}

/** Format the FAILED output for a set of findings. */
function formatFindings(
  findings: readonly SemgrepFinding[],
  filesScanned: number,
  description: string,
): string {
  const lines = [
    `semgrep: FAILED (${findings.length} finding(s) across ${filesScanned} changed file(s))`,
    "",
    `Ruleset ${SEMGREP_CONFIG} via ${description}. The same rules block the PR`,
    "in `.github/workflows/semgrep.yml` — fix them before pushing.",
    "",
    ...findings.map((f) =>
      `  ${f.file}:${f.line} ${f.ruleId} [${f.severity}] ${f.message}`
    ),
  ];

  if (findings.some((f) => f.ruleId.endsWith(NON_LITERAL_REGEXP_RULE))) {
    lines.push("", NON_LITERAL_REGEXP_REMEDY);
  }

  return lines.join("\n");
}

/**
 * Run the semgrep quality check over the branch's changed files.
 *
 * Pipeline:
 *   1. Collect changed files. Not a git repository → SKIPPED; nothing
 *      scannable → PASSED.
 *   2. Detect an invocation. None → SKIPPED.
 *   3. Scan, bounded by {@link SEMGREP_DEADLINE_MS}. Over deadline, or an
 *      unreachable rule registry → SKIPPED.
 *   4. Findings → FAILED (with the `detect-non-literal-regexp` remedy when
 *      that rule fired). A non-zero exit with no parseable report → FAILED,
 *      never a silent pass.
 */
export async function runSemgrepCheck(
  scriptDir: string,
  options: SemgrepCheckOptions = {},
): Promise<SemgrepCheckResult> {
  const git = options.git ?? makeGitRunner(scriptDir);
  const changed = await collectChangedFiles(git);
  if (changed === null) {
    return skipped("not a git repository — no changed-file set to scan");
  }
  if (changed.files.length === 0) {
    return {
      status: "PASSED",
      output: `semgrep: PASSED (no scannable changed files since ${
        changed.base.slice(0, 12)
      })`,
      findings: [],
      filesScanned: 0,
    };
  }

  const detect = options.detectInvocation ?? detectSemgrepInvocation;
  const invocation = await detect(scriptDir);
  if (invocation === null) {
    return skipped(
      "semgrep is not installed and no container runtime holds " +
        `${SEMGREP_IMAGE} — install semgrep (\`pipx install semgrep\`) or ` +
        `pull the CI image so ${SEMGREP_CONFIG} runs before the push`,
    );
  }

  const run = await invocation.run(changed.files);
  const combined = `${run.stdout}\n${run.stderr}`;

  if (run.timedOut) {
    return skipped(
      `scan exceeded the ${SEMGREP_DEADLINE_MS / 1000}s local deadline over ` +
        `${changed.files.length} changed file(s) — CI still runs the full scan`,
    );
  }

  if (run.exitCode !== 0 && isRegistryUnavailable(combined)) {
    return skipped(
      `the ${SEMGREP_CONFIG} ruleset could not be fetched from the semgrep ` +
        "registry (offline?) — the scan did not run",
    );
  }

  let findings: SemgrepFinding[];
  try {
    findings = parseSemgrepJson(run.stdout);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: "FAILED",
      output: [
        `semgrep: FAILED (exit ${run.exitCode}, unreadable report)`,
        "",
        detail,
        combined.trim(),
      ].join("\n"),
      findings: [],
      filesScanned: changed.files.length,
    };
  }

  if (findings.length > 0) {
    return {
      status: "FAILED",
      output: formatFindings(
        findings,
        changed.files.length,
        invocation.description,
      ),
      findings,
      filesScanned: changed.files.length,
    };
  }

  if (run.exitCode !== 0) {
    // Non-zero with a parseable, empty report: semgrep itself errored. An
    // empty findings list is not a pass here.
    return {
      status: "FAILED",
      output: [
        `semgrep: FAILED (exit ${run.exitCode} with no findings reported)`,
        "",
        combined.trim(),
      ].join("\n"),
      findings: [],
      filesScanned: changed.files.length,
    };
  }

  return {
    status: "PASSED",
    output: `semgrep: PASSED (${changed.files.length} changed file(s), ` +
      `${SEMGREP_CONFIG} via ${invocation.description})`,
    findings: [],
    filesScanned: changed.files.length,
  };
}
