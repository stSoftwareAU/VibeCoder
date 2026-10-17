/**
 * Quality gate check: run Checkov's CloudFormation scan over the repository
 * (Issue #3653).
 *
 * `checkov` is a required CI job (`.github/workflows/checkov.yml`) that
 * blocks the PR, but nothing ran it locally, so an agent's first sight of a
 * misconfigured template was a red PR. This runs the same pinned Checkov,
 * with the same arguments and the same judgement, before the push.
 *
 *   - **One judgement.** {@link judgeCheckovRun} decides PASSED or FAILED for
 *     both this gate and the CI entry `worker/deno/checkov_report.ts`, so a
 *     local pass and a CI pass mean the same thing.
 *   - **Skips must justify themselves.** Checkov reports an inline
 *     `# checkov:skip=<ID>` comment with no reason, and a `Metadata` skip
 *     block, exactly as it reports a justified skip. Only an inline
 *     `# checkov:skip=<ID>:<reason>` comment on the resource is accepted.
 *   - **No config file.** Checkov loads `.checkov.yaml` / `.checkov.yml`
 *     from the scanned directory by default, and either can skip checks
 *     without a reason. {@link judgeCheckovScanRoot} fails a root that has one.
 *   - **Unparseable templates fail.** Checkov exits 0 when a template cannot
 *     be parsed, so the report is read, not just the exit code.
 *   - **Same image, same arguments.** {@link checkovScanArgs} is the single
 *     source of truth the CI job must match. Where a container runtime holds
 *     the CI-pinned image, the scan runs inside it, read-only.
 *   - **Skip loudly, never silently.** No Checkov, no container holding the
 *     CI image, or an over-deadline scan returns SKIPPED with the reason
 *     spelled out. The CI job stays authoritative.
 *
 * The stage is only registered in a checkout that carries the CI workflow
 * (see {@link checkovStageApplies}), so a monitored repository with no
 * Checkov job is never scanned by this gate.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { CHECKOV_IMAGE, CHECKOV_IMAGE_TAG } from "./pinned_actions.ts";
import { probe, spawnWithDeadline } from "./semgrep_check.ts";

/** The CI workflow whose presence makes this checkout's own gate scan. */
export const CHECKOV_WORKFLOW_PATH = ".github/workflows/checkov.yml";

/** The one framework scanned — CloudFormation. */
export const CHECKOV_FRAMEWORK = "cloudformation";

/**
 * Wall-clock ceiling for one local scan. The gate runs unattended, so a
 * Checkov that never returns must not wedge the worker; exceeding the
 * deadline is reported as a loud SKIPPED, not a silent pass.
 */
export const CHECKOV_DEADLINE_MS = 300_000;

/** Text that opens a skip directive inside a comment. */
const SKIP_MARKER = "checkov:skip=";

/** Status of the Checkov check. */
export type CheckovStatus = "PASSED" | "SKIPPED" | "FAILED";

/** Raw subprocess result from one Checkov invocation. */
export interface CheckovRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the run was aborted at {@link CHECKOV_DEADLINE_MS}. */
  timedOut?: boolean;
}

/** A resolved way to invoke Checkov. */
export interface CheckovInvocation {
  /** How Checkov will be invoked, for the check output. */
  description: string;
  /** True when the invocation is the tag+digest image CI runs. */
  pinnedToCi: boolean;
  run(): Promise<CheckovRunResult>;
}

/** Resolves an invocation, or null when Checkov cannot be run locally. */
export type DetectCheckovInvocation = (
  scriptDir: string,
) => Promise<CheckovInvocation | null>;

/** One failed check, or one skip the evaluator refused to accept. */
export interface CheckovFinding {
  checkId: string;
  checkName: string;
  /** Path as Checkov reported it. */
  file: string;
  resource: string;
  /** 1-based first line of the resource, or null when Checkov gave none. */
  startLine: number | null;
  /** Why a skip was refused. Set on rejected skips only. */
  why?: string;
}

/** The judged content of one Checkov report. */
export interface CheckovReport {
  /** Resources Checkov evaluated. */
  resourceCount: number;
  /** Number of checks that passed. */
  passed: number;
  /** Number of skips accepted: an inline `checkov:skip=<ID>:<reason>` comment. */
  skippedJustified: number;
  /** Checks that failed. */
  failed: CheckovFinding[];
  /** Skips refused for want of an inline, reasoned comment on the resource. */
  rejectedSkips: CheckovFinding[];
  /** Templates Checkov could not parse. */
  parsingErrors: string[];
}

/** Outcome of the judgement applied to one Checkov run. */
export interface CheckovJudgement {
  status: "PASSED" | "FAILED";
  output: string;
}

/** Result of the Checkov check. */
export interface CheckovCheckResult {
  status: CheckovStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
}

/** Options for {@link runCheckovCheck} (injection points for the tests). */
export interface CheckovCheckOptions {
  /** Inject an invocation detector. Returning null forces SKIPPED. */
  detectInvocation?: DetectCheckovInvocation;
}

/**
 * The remedy printed under every FAILED judgement that names a finding. It
 * states the only accepted skip form, so an agent meets the rule in the same
 * output as the finding.
 */
export const CHECKOV_REMEDY = [
  "Remedy: fix the resource so Checkov passes. A skip is accepted only as an",
  "inline `# checkov:skip=<ID>:<reason>` comment inside the resource it",
  "applies to. In this repository a skip is allowed only where the fix stops",
  "`infra/cloudformation/test-floci.sh` reaching CREATE_COMPLETE, and the",
  "reason must say so. A skip with no reason, or a `Metadata` skip block, is",
  "refused. A template Checkov cannot parse has no skip form: fix the template.",
].join("\n");

/** How many trailing stderr lines a tool-error output keeps. */
const STDERR_TAIL_LINES = 20;

/** Placeholder for a template reported unparseable without a path. */
const UNNAMED_TEMPLATE = "(unnamed template)";

/**
 * The argument list CI must match (Issue #3653): the whole repository,
 * CloudFormation only, a JSON report, and no Prisma download.
 */
export function checkovScanArgs(): string[] {
  return [
    "-d",
    ".",
    "--framework",
    CHECKOV_FRAMEWORK,
    "-o",
    "json",
    "--skip-download",
  ];
}

/**
 * Arguments for running the CI-pinned Checkov image under a container
 * runtime. The repository is mounted read-only — the scan never writes.
 * `--entrypoint checkov` is explicit because the image's own entrypoint
 * ignores argv under `GITHUB_ACTIONS=true`.
 */
export function buildCheckovContainerArgs(
  repoDir: string,
  imageRef: string = CHECKOV_IMAGE,
): string[] {
  return [
    "run",
    "--rm",
    "-v",
    `${repoDir}:/src:ro`,
    "-w",
    "/src",
    "--entrypoint",
    "checkov",
    imageRef,
    ...checkovScanArgs(),
  ];
}

// ---------------------------------------------------------------------------
// Inline skip evaluation
// ---------------------------------------------------------------------------

/** What the code block of one SKIPPED entry says about its skip. */
export interface InlineSkipScan {
  /** The reason of an accepted inline skip for the check, else null. */
  reason: string | null;
  /**
   * True when an inline `checkov:skip=<checkId>` comment exists, with or
   * without a reason. False for a Metadata skip, which has no such comment.
   */
  markerForId: boolean;
}

/** Whether a character is a space or a tab. */
function isBlank(char: string): boolean {
  return char === " " || char === "\t";
}

/**
 * Index of the `#` that opens a YAML comment on this line: the first `#` at
 * the start of the line or after blank space. -1 when there is none.
 */
function commentStart(text: string): number {
  let at = text.indexOf("#");
  while (at !== -1) {
    if (at === 0 || isBlank(text.charAt(at - 1))) return at;
    at = text.indexOf("#", at + 1);
  }
  return -1;
}

/** Whether every code-block entry is a `[lineNumber, lineText]` pair. */
function isWellFormedCodeBlock(codeBlock: unknown[]): boolean {
  return codeBlock.every((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === "number" &&
    typeof entry[1] === "string"
  );
}

/**
 * Scan a SKIPPED entry's code block for the inline skip that names
 * `checkId` (Issue #3653).
 *
 * A marker counts only inside a YAML comment: after the comment's `#`. The
 * id runs to the first `:`, and the reason is the trimmed text after it. A
 * marker for another id, or one with an empty reason, is not an acceptance.
 * A code block that is not a well-formed list of `[number, string]` pairs
 * fails closed: nothing is accepted from it.
 *
 * No regular expressions — the text is untrusted, and `indexOf`/`slice` are
 * linear on any input.
 */
export function inlineSkipScan(
  codeBlock: unknown,
  checkId: string,
): InlineSkipScan {
  const none: InlineSkipScan = { reason: null, markerForId: false };
  if (!Array.isArray(codeBlock) || !isWellFormedCodeBlock(codeBlock)) {
    return none;
  }

  let markerForId = false;
  for (const entry of codeBlock as [number, string][]) {
    const text = entry[1];
    const hash = commentStart(text);
    if (hash === -1) continue;

    let at = text.indexOf(SKIP_MARKER, hash);
    while (at !== -1) {
      const start = at + SKIP_MARKER.length;
      const colon = text.indexOf(":", start);
      const id = (colon === -1 ? text.slice(start) : text.slice(start, colon))
        .trim();
      if (id === checkId) {
        markerForId = true;
        if (colon !== -1) {
          const reason = text.slice(colon + 1).trim();
          if (reason !== "") return { reason, markerForId };
        }
      }
      at = text.indexOf(SKIP_MARKER, start);
    }
  }
  return { reason: null, markerForId };
}

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

/** Keys of Checkov's summary-only object, emitted when no template exists. */
const SUMMARY_ONLY_KEYS = [
  "passed",
  "failed",
  "skipped",
  "parsing_errors",
  "resource_count",
] as const;

/** Whether a value is a plain, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list of objects under `key`; throws on anything else. */
function recordList(value: unknown, key: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `unrecognised Checkov report shape: \`${key}\` is not a list`,
    );
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error(
        `unrecognised Checkov report shape: \`${key}\` holds a non-object entry`,
      );
    }
    return entry;
  });
}

/** The first line number of a `file_line_range`, or null. */
function startLineOf(range: unknown): number | null {
  return Array.isArray(range) && typeof range[0] === "number" ? range[0] : null;
}

/** Flatten one check entry into a finding. */
function findingFrom(entry: Record<string, unknown>): CheckovFinding {
  return {
    checkId: typeof entry.check_id === "string" ? entry.check_id : "unknown",
    checkName: typeof entry.check_name === "string" ? entry.check_name : "",
    file: typeof entry.file_path === "string"
      ? entry.file_path
      : "(unknown file)",
    resource: typeof entry.resource === "string"
      ? entry.resource
      : "(unknown resource)",
    startLine: startLineOf(entry.file_line_range),
  };
}

/** The judged content of one report object, before aggregation. */
type ReportPart = CheckovReport;

/** Judge a full report object: one with a `results` block. */
function readFullReport(
  results: Record<string, unknown>,
  summary: unknown,
): ReportPart {
  if (
    !isRecord(summary) ||
    typeof summary.resource_count !== "number" ||
    typeof summary.parsing_errors !== "number"
  ) {
    throw new Error(
      "unrecognised Checkov report shape: `summary` lacks resource_count or parsing_errors",
    );
  }

  const failed = recordList(results.failed_checks, "failed_checks")
    .map(findingFrom);

  const rejectedSkips: CheckovFinding[] = [];
  let skippedJustified = 0;
  for (const entry of recordList(results.skipped_checks, "skipped_checks")) {
    const checkId = typeof entry.check_id === "string"
      ? entry.check_id
      : "unknown";
    const scan = inlineSkipScan(entry.code_block, checkId);
    if (scan.reason !== null) {
      skippedJustified++;
      continue;
    }
    rejectedSkips.push({
      ...findingFrom(entry),
      why: scan.markerForId
        ? "no reason given"
        : `not an inline \`# checkov:skip=${checkId}:<reason>\` comment on the resource`,
    });
  }

  if (!Array.isArray(results.parsing_errors)) {
    throw new Error(
      "unrecognised Checkov report shape: `parsing_errors` is not a list",
    );
  }
  const parsingErrors = results.parsing_errors.map((path) =>
    typeof path === "string" ? path : UNNAMED_TEMPLATE
  );
  // Never lose an unparseable template: the summary can count one the list
  // does not name.
  while (parsingErrors.length < summary.parsing_errors) {
    parsingErrors.push(UNNAMED_TEMPLATE);
  }

  if (!Array.isArray(results.passed_checks)) {
    throw new Error(
      "unrecognised Checkov report shape: `passed_checks` is not a list",
    );
  }

  return {
    resourceCount: summary.resource_count,
    passed: results.passed_checks.length,
    skippedJustified,
    failed,
    rejectedSkips,
    parsingErrors,
  };
}

/**
 * Judge a summary-only report object. Checkov emits this when no template
 * exists, so it carries no check list to judge. A non-zero failure or skip
 * count with no list behind it is a shape this evaluator cannot read, and
 * is refused rather than passed.
 */
function readSummaryOnly(obj: Record<string, unknown>): ReportPart {
  const count = (key: (typeof SUMMARY_ONLY_KEYS)[number]): number => {
    const value = obj[key];
    return typeof value === "number" ? value : 0;
  };
  if (count("failed") !== 0 || count("skipped") !== 0) {
    throw new Error(
      `summary-only Checkov report claims ${count("failed")} failed and ` +
        `${count("skipped")} skipped check(s) with no check list`,
    );
  }
  const parsingErrors: string[] = [];
  while (parsingErrors.length < count("parsing_errors")) {
    parsingErrors.push(UNNAMED_TEMPLATE);
  }
  return {
    resourceCount: count("resource_count"),
    passed: count("passed"),
    skippedJustified: 0,
    failed: [],
    rejectedSkips: [],
    parsingErrors,
  };
}

/** Judge one report object, either the full shape or the summary-only one. */
function readReportObject(obj: Record<string, unknown>): ReportPart {
  if (isRecord(obj.results)) return readFullReport(obj.results, obj.summary);
  if (SUMMARY_ONLY_KEYS.every((key) => typeof obj[key] === "number")) {
    return readSummaryOnly(obj);
  }
  throw new Error(
    "unrecognised Checkov report shape: expected `results` or the summary keys",
  );
}

/**
 * Parse Checkov's `-o json` stdout into the judged report.
 *
 * Accepts one report object or an array of them (one per check type), and
 * sums the parts. Throws on empty stdout, non-JSON, or any shape it does not
 * recognise — the caller reports that as an unreadable report, never a pass.
 */
export function parseCheckovReport(stdout: string): CheckovReport {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("checkov produced no JSON report on stdout");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`checkov stdout is not JSON: ${detail}`);
  }

  const objects: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (objects.length === 0) {
    throw new Error("unrecognised Checkov report shape: empty array");
  }

  const total: CheckovReport = {
    resourceCount: 0,
    passed: 0,
    skippedJustified: 0,
    failed: [],
    rejectedSkips: [],
    parsingErrors: [],
  };
  for (const obj of objects) {
    if (!isRecord(obj)) {
      throw new Error("unrecognised Checkov report shape: expected an object");
    }
    const part = readReportObject(obj);
    total.resourceCount += part.resourceCount;
    total.passed += part.passed;
    total.skippedJustified += part.skippedJustified;
    total.failed.push(...part.failed);
    total.rejectedSkips.push(...part.rejectedSkips);
    total.parsingErrors.push(...part.parsingErrors);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------

/** The last few lines of stderr, or an empty list when there is none. */
function stderrTail(stderr: string): string[] {
  const trimmed = stderr.trim();
  if (!trimmed) return [];
  return trimmed.split("\n").slice(-STDERR_TAIL_LINES);
}

/** `<file>:<line>`, or just `<file>` when no line was reported. */
function locationOf(finding: CheckovFinding): string {
  return finding.startLine === null
    ? finding.file
    : `${finding.file}:${finding.startLine}`;
}

/**
 * The one judgement of a Checkov run, shared by the local gate and the CI
 * entry (Issue #3653).
 *
 * - An exit code other than 0 or 1 is a tool error: FAILED, with the stderr
 *   tail.
 * - A report that cannot be read is FAILED as unreadable, with the reason.
 * - Any failed check, refused skip or unparseable template is FAILED, listed
 *   with the remedy. Checkov exits 0 for an unparseable template, so the
 *   report is checked whatever the exit code.
 * - Exit 1 with nothing failing in the report is FAILED too: a non-zero exit
 *   is never read as a pass.
 * - Otherwise PASSED.
 */
export function judgeCheckovRun(run: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): CheckovJudgement {
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    return {
      status: "FAILED",
      output: [
        `checkov: FAILED (exit ${run.exitCode}, tool error)`,
        ...stderrTail(run.stderr),
      ].join("\n"),
    };
  }

  let report: CheckovReport;
  try {
    report = parseCheckovReport(run.stdout);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: "FAILED",
      output: [
        `checkov: FAILED (exit ${run.exitCode}, unreadable report)`,
        "",
        detail,
        ...stderrTail(run.stderr),
      ].join("\n"),
    };
  }

  const problems = report.failed.length + report.rejectedSkips.length +
    report.parsingErrors.length;
  if (problems > 0) {
    const lines = [
      `checkov: FAILED (${report.failed.length} failed check(s), ` +
      `${report.rejectedSkips.length} rejected skip(s), ` +
      `${report.parsingErrors.length} unparseable template(s))`,
      "",
      ...report.failed.map((f) =>
        `  ${locationOf(f)} ${f.checkId} ${f.resource} — ${f.checkName}`
      ),
      ...report.rejectedSkips.map((f) =>
        `  ${locationOf(f)} ${f.checkId} ${f.resource} — ${f.why ?? ""}`
      ),
      ...report.parsingErrors.map((path) =>
        `  ${path} — Checkov could not parse this template`
      ),
      "",
      CHECKOV_REMEDY,
    ];
    return { status: "FAILED", output: lines.join("\n") };
  }

  if (run.exitCode === 1) {
    return {
      status: "FAILED",
      output: [
        `checkov: FAILED (exit 1 with no failing check in the report)`,
        "",
        "Checkov exited non-zero but its report lists no failing check, so",
        "the run is not read as a pass.",
        ...stderrTail(run.stderr),
      ].join("\n"),
    };
  }

  return {
    status: "PASSED",
    output: `checkov: PASSED (${report.resourceCount} resource(s), ` +
      `${report.passed} check(s) passed, ` +
      `${report.skippedJustified} skipped with a reason)`,
  };
}

/**
 * The config files Checkov loads by default from the directory it scans.
 * Either one can skip checks, paths or frameworks with no inline reason, and
 * the report would show nothing of it.
 */
export const CHECKOV_CONFIG_FILES: readonly string[] = [
  ".checkov.yaml",
  ".checkov.yml",
];

/**
 * Judge the scan root before any report (Issue #3653): FAILED when a
 * default-loaded Checkov config file is present there, else null. Both the
 * local gate and the CI entry apply it. Only a genuine absence clears a
 * name; any other stat error propagates, so a fault is never read as "no
 * config".
 */
export async function judgeCheckovScanRoot(
  scanRoot: string,
): Promise<CheckovJudgement | null> {
  const found: string[] = [];
  for (const name of CHECKOV_CONFIG_FILES) {
    try {
      await Deno.lstat(`${scanRoot}/${name}`);
      found.push(name);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  if (found.length === 0) return null;
  return {
    status: "FAILED",
    output: [
      `checkov: FAILED (${found.length} Checkov config file(s) at the scan root)`,
      "",
      ...found.map((name) =>
        `  ${name} — Checkov loads this file by default, so it could skip ` +
        "checks with no inline reason"
      ),
      "",
      "Remedy: delete the file. A skip is accepted only as an inline",
      "`# checkov:skip=<ID>:<reason>` comment inside the resource it applies to.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Invocation detection
// ---------------------------------------------------------------------------

/**
 * Detect how Checkov can be run locally.
 *
 * Order:
 *   1. A `checkov` binary on PATH. Pinned to CI only when its version equals
 *      {@link CHECKOV_IMAGE_TAG}; drift is reported by the check, not fatal.
 *   2. A container runtime (docker, then podman) that **already holds** the
 *      CI-pinned image. The image is never pulled here.
 *
 * Returns null when neither is available.
 */
export const detectCheckovInvocation: DetectCheckovInvocation = async (
  scriptDir: string,
): Promise<CheckovInvocation | null> => {
  const version = await probe("checkov", ["--version"]);
  if (version !== null) {
    return {
      description: `checkov ${version || "(unknown version)"} on PATH`,
      pinnedToCi: version === CHECKOV_IMAGE_TAG,
      run: () =>
        spawnWithDeadline(
          "checkov",
          checkovScanArgs(),
          scriptDir,
          CHECKOV_DEADLINE_MS,
        ),
    };
  }

  for (const runtime of ["docker", "podman"]) {
    if (await probe(runtime, ["--version"]) === null) continue;
    // `image inspect` succeeds only for an image already in the local store,
    // so nothing is downloaded by this check.
    if (await probe(runtime, ["image", "inspect", CHECKOV_IMAGE]) === null) {
      continue;
    }
    return {
      description: `${runtime} run ${CHECKOV_IMAGE} (the image CI runs)`,
      pinnedToCi: true,
      run: () =>
        spawnWithDeadline(
          runtime,
          buildCheckovContainerArgs(scriptDir),
          scriptDir,
          CHECKOV_DEADLINE_MS,
        ),
    };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Stage applicability and the check
// ---------------------------------------------------------------------------

/**
 * Whether this checkout carries the Checkov CI workflow, so the gate should
 * mirror it. Only a genuine absence answers `false`; any other error
 * propagates, so a permissions fault is never read as "no workflow".
 */
export async function checkovStageApplies(scriptDir: string): Promise<boolean> {
  try {
    const info = await Deno.stat(`${scriptDir}/${CHECKOV_WORKFLOW_PATH}`);
    return info.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Run the Checkov check over the repository.
 *
 * A Checkov config file at the root → FAILED, whether or not Checkov is
 * installed. No invocation → SKIPPED naming the required CI job. A deadline hit →
 * SKIPPED. Otherwise the run is judged by {@link judgeCheckovRun}, with the
 * invocation named in the output, and a local PASSED from a version other
 * than the CI pin is flagged as not a guarantee.
 */
export async function runCheckovCheck(
  scriptDir: string,
  options: CheckovCheckOptions = {},
): Promise<CheckovCheckResult> {
  const configured = await judgeCheckovScanRoot(scriptDir);
  if (configured !== null) return configured;

  const detect = options.detectInvocation ?? detectCheckovInvocation;
  const invocation = await detect(scriptDir);
  if (invocation === null) {
    const reason = "checkov is not installed and no container runtime holds " +
      `${CHECKOV_IMAGE}; the required \`checkov\` CI job ` +
      `(${CHECKOV_WORKFLOW_PATH}) still scans every template — install with ` +
      `\`pipx install checkov==${CHECKOV_IMAGE_TAG}\` or pull the image so ` +
      "the scan runs before the push";
    return {
      status: "SKIPPED",
      output: `checkov: SKIPPED (not run — ${reason})`,
    };
  }

  const run = await invocation.run();
  if (run.timedOut) {
    const reason = `scan exceeded the ${CHECKOV_DEADLINE_MS / 1000}s local ` +
      `deadline via ${invocation.description} — the required checkov CI job ` +
      "still runs the full scan";
    return {
      status: "SKIPPED",
      output: `checkov: SKIPPED (${reason})`,
    };
  }

  const judged = judgeCheckovRun(run);
  const newline = judged.output.indexOf("\n");
  const headLine = newline === -1
    ? judged.output
    : judged.output.slice(0, newline);
  const rest = newline === -1 ? "" : judged.output.slice(newline);
  let output = `${headLine} via ${invocation.description}${rest}`;
  if (judged.status === "PASSED" && !invocation.pinnedToCi) {
    output += "\n\ncheckov: the local run differs from the CI pin " +
      `${CHECKOV_IMAGE_TAG}, so a local pass is not a guarantee of a CI pass`;
  }
  return { status: judged.status, output };
}
