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
 *      ({@link resolveDiffBase}). An unresolvable base → SKIPPED, never PASSED.
 *      The range is `<base>..HEAD`. Uncommitted changes are not scanned, because
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

/**
 * Judge one finished scan (step 5 of the pipeline). Exit 0 is not enough on
 * its own: a bad revision range exits 0 with an `ERR` line and `no leaks found`.
 */
function judgeRun(
  run: SemgrepRunResult,
  shortRange: string,
  description: string,
): GitleaksCheckResult {
  const stderrLines = run.stderr.split("\n");
  const hasErrorLevel = stderrLines.some((line) => ERROR_LEVEL_LINE.test(line));

  if (
    run.exitCode === 0 &&
    run.stderr.includes(NO_LEAKS_TEXT) &&
    !hasErrorLevel
  ) {
    return {
      status: "PASSED",
      output: `gitleaks: PASSED (commit range ${shortRange}, ${description}; ` +
        "uncommitted changes are not scanned, as in CI)",
    };
  }

  const leaksLine = stderrLines.find((line) => LEAKS_FOUND_LINE.test(line));
  if (run.exitCode !== 0 && leaksLine !== undefined) {
    // Findings are on stdout. Redact the whole of it before it is cut.
    const findings = redactedLineTail(run.stdout, FINDINGS_MAX_LINES).trim();
    return {
      status: "FAILED",
      output: [
        `gitleaks: FAILED (leaks found in commit range ${shortRange}, ${description})`,
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
 * diff base → SKIPPED; gitleaks absent → SKIPPED on a host, FAILED in the
 * fleet image; deadline → FAILED; otherwise judged by {@link judgeRun}.
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
  if ("skipReason" in resolved) return skipped(resolved.skipReason);
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

  return judgeRun(run, shortRange, description);
}
