/**
 * Quality gate check: run the CI gitleaks secret scan over the branch's
 * commit range locally (Issue #5121).
 *
 * Three fleet PRs (#5014, #5091, #5119) failed the blocking `gitleaks / gitleaks`
 * CI check, and nothing had scanned them locally, so each was met as a red PR
 * after the push. This stage runs the same scan the licence-less CI fallback in
 * `.github/workflows/gitleaks.yml` runs: the same pinned CLI version, the same
 * repository config and the same flags, over the same commit set CI scans
 * (`base..HEAD`). A local pass therefore predicts a CI pass.
 *
 * Pipeline:
 *   1. Not a git repository → SKIPPED (there is no commit range to scan).
 *   2. Resolve the diff base exactly as `semgrep_check.ts` does
 *      ({@link resolveDiffBase}). An unresolvable base is never PASSED: it is
 *      SKIPPED on a host (`--strict` promotes that) but FAILED inside the fleet
 *      container image, worded as an infrastructure fault, because the worker
 *      runs the gate non-strict and a skipped stage would let the PR through
 *      with its commit range never scanned. The range is `<base>..HEAD`. Uncommitted changes are not scanned, because
 *      CI scans commits only, and the PASSED output says so.
 *   3. Probe `gitleaks version`. Absent → SKIPPED on a host, but FAILED inside
 *      the fleet container image, which bakes gitleaks in (the image is broken,
 *      not the change). A version other than the CI pin still runs, with the
 *      drift named in the output.
 *   4. Scan, bounded by {@link GITLEAKS_DEADLINE_MS}. A deadline hit is FAILED:
 *      a scan that did not finish cannot be read as clean.
 *   5. Judge. PASSED only when the exit code is 0, stderr says `no leaks found`
 *      and stderr has no `ERR` or `FTL` line. gitleaks exits 0 even when the
 *      revision range is bad, so exit 0 alone is not a pass. A non-zero exit
 *      with a `leaks found: N` line is FAILED, with the redacted findings. Any
 *      other outcome is FAILED as a scanner error, quoting the redacted stderr.
 *
 * The babysitter repair publishes a clone's uncommitted edits and never runs
 * `quality.sh`, so {@link runGitleaksTreeCheck} gives that path the same scan
 * (Issue #5121, PR #5129 review): the branch's commit range plus the repair's
 * uncommitted files, with a finding `blocked` and a scanner or history fault
 * `infrastructure`.
 *
 * Australian English spelling used throughout (behaviour, licence, etc.).
 */

import {
  defaultEnsureHistory,
  type EnsureHistory,
  type GitRunner,
  makeGitRunner,
  probe,
  resolveDiffBase,
  type SemgrepRunResult,
  spawnWithDeadline,
} from "./semgrep_check.ts";
import { runningInContainerImage } from "./container_stamp.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { redactedLineTail } from "./redacted_text.ts";

/** The gitleaks version `.github/workflows/gitleaks.yml` downloads. */
export const GITLEAKS_VERSION = "8.30.1";

/** The repository config both the licensed action and the CLI fallback read. */
export const GITLEAKS_CONFIG_PATH = ".github/gitleaks.toml";

/**
 * Wall-clock ceiling for one local scan. A scan that never returns must not
 * wedge the gate, and exceeding the deadline is FAILED rather than a pass.
 */
export const GITLEAKS_DEADLINE_MS = 300_000;

/** Lines of redacted stderr quoted after a scanner error. */
const STDERR_TAIL_LINES = 20;

/** Lines of redacted findings quoted after a FAILED scan, to bound the output. */
const FINDINGS_MAX_LINES = 200;

/** An `ERR` or `FTL` log level, as gitleaks prints it between spaces. */
const ERROR_LEVEL_LINE = /\s(ERR|FTL)\s/;

/** The line gitleaks prints when it found secrets, e.g. `WRN leaks found: 1`. */
const LEAKS_FOUND_LINE = /\bleaks found: \d+/;

/** The line gitleaks prints when a scan ran clean. */
const NO_LEAKS_TEXT = "no leaks found";

/** Status of the gitleaks check. */
export type GitleaksStatus = "PASSED" | "SKIPPED" | "FAILED";

/** Structured result of running the gitleaks check. */
export interface GitleaksCheckResult {
  status: GitleaksStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
}

/**
 * Arguments for the gitleaks scan of a commit range. The first four flags after
 * `git` mirror the CI fallback in `gitleaks.yml`. `--verbose` and `--no-color`
 * are local additions, so the finding's file, line and rule are printed (the
 * secret stays redacted). They do not change the verdict.
 */
export function gitleaksScanArgs(
  range: string,
  configPath: string | null,
): string[] {
  return [
    "git",
    ...(configPath ? ["--config", configPath] : []),
    "--redact",
    "--no-banner",
    "--exit-code",
    "1",
    "--verbose",
    "--no-color",
    `--log-opts=${range}`,
    ".",
  ];
}

/** Injection points for {@link runGitleaksCheck} (used by the tests). */
export interface GitleaksCheckOptions {
  /** Inject a git runner. Defaults to {@link makeGitRunner}. */
  git?: GitRunner;
  /**
   * Deepen shallow history before the diff base is resolved. The default is
   * semgrep_check's {@link defaultEnsureHistory}, shared so both stages deepen
   * the same way.
   */
  ensureHistory?: EnsureHistory;
  /** Inject a version probe. Returns null when gitleaks cannot run. */
  probeVersion?: () => Promise<string | null>;
  /** Inject the scan. Defaults to the deadline-bound spawn of `gitleaks`. */
  run?: (args: string[]) => Promise<SemgrepRunResult>;
  /**
   * Environment lookup used to decide whether this run is inside the fleet
   * container image; defaults to the process environment.
   */
  env?: EnvLookup;
}

/** Default version probe: `gitleaks version`, printing e.g. `8.30.1`. */
function defaultProbeVersion(): Promise<string | null> {
  return probe("gitleaks", ["version"]);
}

/** Build the SKIPPED result, with the reason spelled out. */
function skipped(reason: string): GitleaksCheckResult {
  return { status: "SKIPPED", output: `gitleaks: SKIPPED (${reason})` };
}

/**
 * The absolute path of the repository config, or null when the file is absent.
 * Any other read error is rethrown rather than read as "no config".
 */
async function gitleaksConfigPath(scriptDir: string): Promise<string | null> {
  const path = `${scriptDir}/${GITLEAKS_CONFIG_PATH}`;
  try {
    await Deno.stat(path);
    return path;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** How one finished scan read: clean, a finding, or a scanner fault. */
type RunVerdict = "clean" | "leaks" | "error";

/** A judged scan: the stage result plus the verdict the tree check maps on. */
type JudgedRun = GitleaksCheckResult & { verdict: RunVerdict };

/**
 * Judge one finished scan (step 5 of the pipeline). `subject` names what was
 * scanned; `passedNote` is appended to the PASSED line. Exit 0 is not enough on
 * its own: a bad revision range exits 0 with an `ERR` line and `no leaks found`.
 */
function judgeRun(
  run: SemgrepRunResult,
  subject: string,
  description: string,
  passedNote = "",
): JudgedRun {
  const stderrLines = run.stderr.split("\n");
  const hasErrorLevel = stderrLines.some((line) => ERROR_LEVEL_LINE.test(line));

  if (
    run.exitCode === 0 &&
    run.stderr.includes(NO_LEAKS_TEXT) &&
    !hasErrorLevel
  ) {
    return {
      status: "PASSED",
      verdict: "clean",
      output: `gitleaks: PASSED (${subject}, ${description}${passedNote})`,
    };
  }

  const leaksLine = stderrLines.find((line) => LEAKS_FOUND_LINE.test(line));
  if (run.exitCode !== 0 && leaksLine !== undefined) {
    // Findings are on stdout. Redact the whole of it before it is cut.
    const findings = redactedLineTail(run.stdout, FINDINGS_MAX_LINES).trim();
    return {
      status: "FAILED",
      verdict: "leaks",
      output: [
        `gitleaks: FAILED (leaks found in ${subject}, ${description})`,
        "",
        findings === "" ? "(no finding detail on stdout)" : findings,
        "",
        redactedLineTail(leaksLine, 1),
        "",
        "The same scan blocks the PR in `.github/workflows/gitleaks.yml`. " +
        "Remove the secret from the branch history; for a deliberate fake " +
        "fixture, add a narrowly scoped allowlist to `.github/gitleaks.toml`.",
      ].join("\n"),
    };
  }

  // Anything else is a scanner error. The ERR or FTL line names the cause.
  const stderrTail = redactedLineTail(run.stderr, STDERR_TAIL_LINES).trim();
  return {
    status: "FAILED",
    verdict: "error",
    output: [
      `gitleaks: FAILED (scanner error, exit ${run.exitCode}, ${description})`,
      "",
      stderrTail === "" ? "(no stderr)" : stderrTail,
    ].join("\n"),
  };
}

/**
 * Run the gitleaks quality check over the branch's commit range.
 *
 * Pipeline (see the module comment): not a repository → SKIPPED; unresolvable
 * diff base or gitleaks absent → SKIPPED on a host, FAILED in the fleet image;
 * deadline → FAILED; otherwise judged by {@link judgeRun}.
 */
export async function runGitleaksCheck(
  scriptDir: string,
  options: GitleaksCheckOptions = {},
): Promise<GitleaksCheckResult> {
  const git = options.git ?? makeGitRunner(scriptDir);
  const ensureHistory = options.ensureHistory ?? defaultEnsureHistory;

  const insideWorkTree = await git(["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.exitCode !== 0) {
    return skipped("not a git repository — no commit range to scan");
  }

  const resolved = await resolveDiffBase(git, scriptDir, ensureHistory);
  if ("skipReason" in resolved) {
    if (runningInContainerImage(options.env ?? processEnvLookup)) {
      return {
        status: "FAILED",
        output: "gitleaks: FAILED (the git history needed to resolve the " +
          "diff base is not available in the worker environment: " +
          `${resolved.skipReason} — an infrastructure fault, not a finding; ` +
          "the commit range was never scanned)",
      };
    }
    return skipped(resolved.skipReason);
  }
  const range = `${resolved.base}..HEAD`;
  const shortRange = `${resolved.base.slice(0, 12)}..HEAD`;

  const version = await (options.probeVersion ?? defaultProbeVersion)();
  if (version === null) {
    if (runningInContainerImage(options.env ?? processEnvLookup)) {
      return {
        status: "FAILED",
        output: "gitleaks: FAILED (gitleaks is not installed or not in PATH " +
          "inside the fleet container image, which bakes it in — the image " +
          "is broken, not the change; rebuild it per docs/CONTAINER-IMAGE.md)",
      };
    }
    return skipped(
      `gitleaks is not installed — install gitleaks ${GITLEAKS_VERSION} ` +
        "(the CI pin in `.github/workflows/gitleaks.yml`) so the scan runs " +
        "before the push",
    );
  }

  const reported = version === "" ? "(unknown version)" : version;
  const drift = version === GITLEAKS_VERSION
    ? ""
    : ` — differs from the CI pin ${GITLEAKS_VERSION}, so a local pass is` +
      " not a guarantee";
  const description = `gitleaks ${reported}${drift}`;

  const configPath = await gitleaksConfigPath(scriptDir);
  const scan = options.run ??
    ((args: string[]) =>
      spawnWithDeadline("gitleaks", args, scriptDir, GITLEAKS_DEADLINE_MS));
  const run = await scan(gitleaksScanArgs(range, configPath));

  if (run.timedOut) {
    return {
      status: "FAILED",
      output: `gitleaks: FAILED (scan of ${shortRange} exceeded the ` +
        `${GITLEAKS_DEADLINE_MS / 1000}s local deadline, ${description}) — a ` +
        "scan that did not finish is not clean",
    };
  }

  const { status, output } = judgeRun(
    run,
    `commit range ${shortRange}`,
    description,
    "; uncommitted changes are not scanned, as in CI",
  );
  return { status, output };
}

// ---------------------------------------------------------------------------
// Babysitter repair: the uncommitted tree (PR #5129 review)
// ---------------------------------------------------------------------------

/**
 * What the scan of a babysitter repair's tree found. The shape matches the
 * tree gate's own outcomes: a finding is `blocked` (a verdict on the tree, so
 * the repair attempt counts), a missing scanner, unresolvable history or a
 * scanner fault is `infrastructure` (no attempt is spent), and only a clean
 * scan of both the commit range and every uncommitted file is `passed`.
 */
export type GitleaksTreeOutcome =
  | { kind: "passed"; summary: string }
  | { kind: "blocked"; message: string }
  | { kind: "infrastructure"; message: string };

/** Injection points for {@link runGitleaksTreeCheck} (used by the tests). */
export interface GitleaksTreeCheckOptions {
  /** Inject a git runner rooted at the clone. Defaults to {@link makeGitRunner}. */
  git?: GitRunner;
  /** Inject a version probe. Returns null when gitleaks cannot run. */
  probeVersion?: () => Promise<string | null>;
  /** Inject the scan. Defaults to the deadline-bound spawn of `gitleaks`. */
  run?: (args: string[]) => Promise<SemgrepRunResult>;
}

/**
 * Arguments for the scan of one uncommitted file. The `--` keeps a path that
 * starts with `-` from being read as a flag; the scan flags are
 * {@link gitleaksScanArgs}'s, except that the findings are written to stdout
 * as a JSON report (with the secret redacted), so each finding's line span can
 * be compared with the lines the repair added.
 */
export function gitleaksFileScanArgs(
  path: string,
  configPath: string | null,
): string[] {
  return [
    "dir",
    ...(configPath ? ["--config", configPath] : []),
    "--redact",
    "--no-banner",
    "--exit-code",
    "1",
    "--no-color",
    "--report-format",
    "json",
    "--report-path",
    "-",
    "--",
    path,
  ];
}

/** An inclusive span of line numbers in a file. */
interface LineSpan {
  start: number;
  end: number;
}

/** A hunk header of `git diff -U0`: `@@ -a[,b] +c[,d] @@`. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The lines of `path` the uncommitted change added relative to `HEAD`, as CI
 * sees them: gitleaks scans only the added lines of each commit's patch, so a
 * pre-existing match on an untouched line never blocks a PR. Returns null when
 * the file is not in `HEAD` (new or untracked), meaning every line is added.
 * The diff is read with `--no-optional-locks`, so nothing is written to `.git`.
 */
async function addedLineSpans(
  git: GitRunner,
  path: string,
): Promise<LineSpan[] | null | { error: string }> {
  const inHead = await git(["cat-file", "-e", `HEAD:${path}`]);
  if (inHead.exitCode !== 0) return null;
  const diff = await git([
    "--no-optional-locks",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "-U0",
    "HEAD",
    "--",
    path,
  ]);
  if (diff.exitCode !== 0) {
    return { error: `git diff HEAD -- ${JSON.stringify(path)} failed` };
  }
  const spans: LineSpan[] = [];
  for (const line of diff.stdout.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) spans.push({ start, end: start + count - 1 });
  }
  return spans;
}

/** One finding of a JSON report, reduced to its safe metadata. */
interface ReportFinding {
  rule: string;
  file: string;
  start: number;
  end: number;
}

/** Parse a gitleaks JSON report, or null when it is not one. */
function parseReport(stdout: string): ReportFinding[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const findings: ReportFinding[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return null;
    const { RuleID, File, StartLine, EndLine } = entry as Record<
      string,
      unknown
    >;
    if (typeof StartLine !== "number") return null;
    findings.push({
      rule: String(RuleID ?? "(unknown rule)"),
      file: String(File ?? "(unknown file)"),
      start: StartLine,
      end: typeof EndLine === "number" && EndLine >= StartLine
        ? EndLine
        : StartLine,
    });
  }
  return findings;
}

/** A changed path the tree scan can hand to gitleaks safely, or null. */
function unsafeTreePath(path: string): string | null {
  if (path === "" || path.startsWith("/")) {
    return `${JSON.stringify(path)} is not a repository-relative path`;
  }
  if (path.split("/").includes("..")) {
    return `${JSON.stringify(path)} leaves the clone`;
  }
  return null;
}

/**
 * Whether `path` names a regular file or directory to scan. A path the repair
 * deleted is gone, and a symlink's content is its target's, which is not part
 * of what the repair added; neither is scanned.
 */
async function pathToScan(dir: string, path: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(`${dir}/${path}`);
    return !info.isSymlink;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Run the gitleaks scan over a babysitter repair's clone before its READY is
 * honoured. The repair's edits are uncommitted and the clone's `.git` is
 * read-only, so two scans run, neither writing to `.git`:
 *
 *   1. the branch's commit range `<merge-base with origin/<baseBranch>>..HEAD`,
 *      the range CI scans (the clone is a full clone, so no deepening is
 *      needed or possible);
 *   2. each changed file as it is now on disk (`paths`), because the host
 *      commits and pushes those edits and CI then scans them.
 *
 * The repository config is read from the working tree, as CI reads it from the
 * PR head. `paths` may name files the repair deleted; those are skipped.
 *
 * Each changed file is scanned whole, one process per file, and a finding
 * blocks only when its line span touches a line the repair added relative to
 * `HEAD` (every line, for a file not in `HEAD`), because CI scans only the
 * added lines of each patch. SIMPLE-ON-PURPOSE: one process per file — upgrade
 * when a repair touches more than a few hundred files in one run.
 */
export async function runGitleaksTreeCheck(
  dir: string,
  baseBranch: string | undefined,
  paths: readonly string[],
  options: GitleaksTreeCheckOptions = {},
): Promise<GitleaksTreeOutcome> {
  const git = options.git ?? makeGitRunner(dir);
  const infra = (message: string): GitleaksTreeOutcome => ({
    kind: "infrastructure",
    message: `gitleaks: ${message} — an infrastructure fault, not a finding`,
  });

  for (const path of paths) {
    const unsafe = unsafeTreePath(path);
    if (unsafe !== null) {
      return {
        kind: "blocked",
        message: `gitleaks: cannot scan a changed path: ${unsafe}`,
      };
    }
  }

  const baseRef = baseBranch === undefined
    ? "refs/remotes/origin/HEAD"
    : `refs/remotes/origin/${baseBranch}`;
  const mergeBase = await git(["merge-base", baseRef, "HEAD"]);
  const base = mergeBase.stdout.trim();
  if (mergeBase.exitCode !== 0 || base === "") {
    return infra(
      `the diff base is not available in the worker environment: ` +
        `merge-base of ${baseRef} and HEAD failed, so the commit range was ` +
        "never scanned",
    );
  }
  const shortRange = `${base.slice(0, 12)}..HEAD`;

  const version = await (options.probeVersion ?? defaultProbeVersion)();
  if (version === null) {
    return infra(
      "gitleaks is not installed or not in PATH, so nothing was scanned",
    );
  }
  const reported = version === "" ? "(unknown version)" : version;
  const description = `gitleaks ${reported}${
    version === GITLEAKS_VERSION ? "" : ` (CI pins ${GITLEAKS_VERSION})`
  }`;

  const configPath = await gitleaksConfigPath(dir);
  const deadlineAt = Date.now() + GITLEAKS_DEADLINE_MS;
  const scan = options.run ??
    ((args: string[]) =>
      spawnWithDeadline(
        "gitleaks",
        args,
        dir,
        Math.max(deadlineAt - Date.now(), 1),
      ));

  const scans: { subject: string; args: string[]; path?: string }[] = [{
    subject: `commit range ${shortRange}`,
    args: gitleaksScanArgs(`${base}..HEAD`, configPath),
  }];
  for (const path of paths) {
    if (await pathToScan(dir, path)) {
      scans.push({
        subject: `uncommitted file ${path}`,
        args: gitleaksFileScanArgs(path, configPath),
        path,
      });
    }
  }

  for (const { subject, args, path } of scans) {
    const run = await scan(args);
    if (run.timedOut) {
      return infra(
        `the scan of ${subject} exceeded the ` +
          `${GITLEAKS_DEADLINE_MS / 1000}s local deadline — a scan that did ` +
          "not finish is not clean",
      );
    }
    const judged = judgeRun(run, subject, description);
    if (judged.verdict === "error") {
      // The output already names the scanner error and quotes its cause.
      return { kind: "infrastructure", message: judged.output };
    }
    if (judged.verdict === "clean") continue;
    if (path === undefined) {
      return { kind: "blocked", message: judged.output };
    }
    const fileVerdict = await judgeFileFindings(
      git,
      path,
      run.stdout,
      subject,
      description,
    );
    if (fileVerdict !== null) return fileVerdict;
  }
  return {
    kind: "passed",
    summary: `gitleaks: PASSED (commit range ${shortRange} and ` +
      `${scans.length - 1} uncommitted file(s), ${description})`,
  };
}

/**
 * Keep only the findings of one file scan that touch a line the repair added,
 * as CI's patch scan would (Issue #5121, PR #5129 review): a whole-file scan
 * also matches content already on the base branch, such as the PEM markers in
 * `github_app_auth.ts`, which CI never re-reads unless the PR adds them.
 * Returns null when no finding touches an added line, a `blocked` outcome
 * naming each remaining finding's rule, file and line span (never the secret),
 * or `infrastructure` when the report or the diff cannot be read.
 */
async function judgeFileFindings(
  git: GitRunner,
  path: string,
  stdout: string,
  subject: string,
  description: string,
): Promise<GitleaksTreeOutcome | null> {
  const findings = parseReport(stdout);
  if (findings === null) {
    return {
      kind: "infrastructure",
      message: `gitleaks: FAILED (scanner error: the scan of ${subject} ` +
        `reported leaks but its JSON report could not be read, ${description})` +
        " — an infrastructure fault, not a finding",
    };
  }
  const added = await addedLineSpans(git, path);
  if (added !== null && "error" in added) {
    return {
      kind: "infrastructure",
      message: `gitleaks: ${added.error}, so the findings in ${subject} ` +
        "could not be matched to the repair's lines — an infrastructure " +
        "fault, not a finding",
    };
  }
  const touching = added === null
    ? findings
    : findings.filter((finding) =>
      added.some((span) =>
        finding.start <= span.end && span.start <= finding.end
      )
    );
  if (touching.length === 0) return null;
  const lines = touching.slice(0, FINDINGS_MAX_LINES).map((finding) =>
    `RuleID: ${finding.rule}  File: ${finding.file}  Line: ${finding.start}` +
    (finding.end === finding.start ? "" : `-${finding.end}`)
  );
  return {
    kind: "blocked",
    message: redactedLineTail(
      [
        `gitleaks: FAILED (leaks found in ${subject}, ${description})`,
        "",
        ...lines,
        "",
        "The same lines would block the PR in `.github/workflows/gitleaks.yml`. " +
        "Remove the secret; for a deliberate fake fixture, add a narrowly " +
        "scoped allowlist to `.github/gitleaks.toml`.",
      ].join("\n"),
      FINDINGS_MAX_LINES + 4,
    ),
  };
}
