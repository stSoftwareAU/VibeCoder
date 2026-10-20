/**
 * Checkov scan contract and verdict judge, shared by the CI workflow and the
 * local quality-gate stage (Issue #3970).
 *
 * Both run the same scan: `CHECKOV_SCAN_ARGS`, executed from the scanned
 * repository root inside the pinned Checkov image. The exit code and stdout
 * then go to `judgeCheckovRun`, which decides PASSED or FAILED itself. The
 * judge does not trust Checkov's exit code, because Checkov 3.3.29:
 *
 *   - exits 0 when a template fails to parse (the parse error is only listed
 *     in `results.parsing_errors`);
 *   - accepts a skip with no reason, reporting it as "No comment provided";
 *   - accepts a skip set in a resource's `Metadata` block, with no comment
 *     beside the resource that a reviewer could see;
 *   - prints a summary-only object, not a report, when it finds no templates.
 *
 * So the judge applies the repo's rules to the JSON. Every failed check,
 * every parse error and every skip without a reason is a problem, and a
 * skip is only accepted when the template carries an inline
 * `# checkov:skip=<ID>:<reason>` comment within the check's line range.
 *
 * Usage, from the scanned repository root:
 *
 *   deno run --allow-read worker/deno/lib/checkov_report.ts <report.json> <checkov-exit-code>
 *
 * Exit status: 0 PASSED, 1 FAILED (or the report cannot be read), 2 bad usage.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { installConsoleRedaction } from "./console_redaction.ts";

/** The Checkov scan both the CI workflow and the local gate run. */
export const CHECKOV_SCAN_ARGS: readonly string[] = [
  "-d",
  ".",
  "--framework",
  "cloudformation",
  "-o",
  "json",
  "--skip-download",
] as const;

/**
 * Returns the template text for a repo-relative path, or null when it cannot
 * be read.
 */
export type CheckovTemplateReader = (path: string) => Promise<string | null>;

/** The judge's decision and the human-readable text behind it. */
export interface CheckovVerdict {
  status: "PASSED" | "FAILED";
  /**
   * One line per problem (each naming the check ID, file and line range
   * where relevant), then a final status line. A PASSED verdict carries a
   * short summary instead.
   */
  report: string;
}

/** Checkov's placeholder suppress comment for a skip written with no reason. */
const NO_REASON_PLACEHOLDER = "No comment provided";

/** Exit codes the judge accepts: 0 clean, 1 failed checks. */
const ACCEPTED_EXIT_CODES: readonly number[] = [0, 1];

/** Count fields Checkov prints in a summary-only object (no templates found). */
const SUMMARY_ONLY_COUNTS = [
  "passed",
  "failed",
  "skipped",
  "parsing_errors",
  "resource_count",
] as const;

/** Keys of `results` that must be lists. */
const RESULT_LISTS = [
  "failed_checks",
  "skipped_checks",
  "parsing_errors",
] as const;

/** Keys of `summary` that must be numbers. */
const SUMMARY_COUNTS = [
  "passed",
  "failed",
  "skipped",
  "parsing_errors",
] as const;

/** Usage line printed on bad arguments. */
const USAGE =
  "usage: deno run --allow-read worker/deno/lib/checkov_report.ts <report.json> <checkov-exit-code>";

/**
 * An inline skip comment. Linear: tested one line at a time, with no
 * overlapping quantifiers. Group 1 is the check ID, group 2 the reason.
 */
const INLINE_SKIP = /#\s*checkov:skip=([A-Z0-9_]+):(\S[^\n]*)/g;

/** Mutable tallies a PASSED verdict reports. */
interface Totals {
  passed: number;
  skipped: number;
  fullReports: number;
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSummaryOnly(value: Obj): boolean {
  return !("results" in value) &&
    SUMMARY_ONLY_COUNTS.every((key) => isCount(value[key]));
}

function isFullReport(value: Obj): boolean {
  return typeof value.check_type === "string" &&
    isObject(value.results) &&
    isObject(value.summary);
}

/** The items of a list field, or an empty list when the field is not one. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A 1-based inclusive `[start, end]` range, or null when malformed. */
function rangeOf(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const from = start as number;
  const to = end as number;
  if (from < 1 || to < from) return null;
  return [from, to];
}

/** The check ID, or a placeholder when the field is absent or malformed. */
function checkIdOf(entry: Obj): string {
  return typeof entry.check_id === "string" && entry.check_id !== ""
    ? entry.check_id
    : "<unnamed check>";
}

/**
 * `file_path` with a leading `/` and then a leading `./` stripped, or null
 * when it is not a string or is empty once stripped. A path that
 * `escapesScanDir` flags is still returned here, but `judgeSkip` refuses it
 * before the reader is called, so only templates inside the scanned directory
 * can justify a skip.
 */
function repoPathOf(entry: Obj): string | null {
  if (typeof entry.file_path !== "string") return null;
  const path = entry.file_path.replace(/^\//, "").replace(/^\.\//, "");
  return path === "" ? null : path;
}

/**
 * True when a `repoPathOf` path is absolute, holds a NUL, or has a `..` segment
 * (split on both `/` and `\`): a template it names may lie outside the scanned
 * directory.
 */
function escapesScanDir(path: string): boolean {
  return /^[/\\]/.test(path) || path.includes("\0") ||
    path.split(/[/\\]/).includes("..");
}

/** `file_path` and line range as shown in a problem line. */
function locationOf(entry: Obj): string {
  const file = typeof entry.file_path === "string"
    ? entry.file_path
    : "<unknown file>";
  const range = rangeOf(entry.file_line_range);
  return range ? `${file} lines ${range[0]}-${range[1]}` : file;
}

/**
 * The skip reason Checkov recorded: `check_result.suppress_comment`, else the
 * top-level `suppress_comment`. Null when neither is a string.
 */
function skipReasonOf(entry: Obj): string | null {
  const checkResult = isObject(entry.check_result)
    ? entry.check_result
    : undefined;
  const candidate = checkResult?.suppress_comment ?? entry.suppress_comment;
  return typeof candidate === "string" ? candidate : null;
}

function describeFailure(entry: unknown): string {
  if (!isObject(entry)) {
    return "malformed failed-check entry in results.failed_checks";
  }
  const name = typeof entry.check_name === "string" && entry.check_name !== ""
    ? ` (${entry.check_name})`
    : "";
  return `${checkIdOf(entry)} failed at ${locationOf(entry)}${name}`;
}

/** True when `lines[start..end]` (1-based, inclusive) holds the skip. */
function hasInlineSkip(
  text: string,
  checkId: string,
  range: [number, number],
): boolean {
  const lines = text.split("\n");
  const last = Math.min(range[1], lines.length);
  for (let lineNo = range[0]; lineNo <= last; lineNo++) {
    const line = lines[lineNo - 1] ?? "";
    for (const match of line.matchAll(INLINE_SKIP)) {
      if (match[1] === checkId) return true;
    }
  }
  return false;
}

async function readTemplate(
  templates: CheckovTemplateReader,
  path: string,
): Promise<string | null> {
  try {
    const text = await templates(path);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

async function judgeSkip(
  entry: unknown,
  templates: CheckovTemplateReader,
  problems: string[],
): Promise<void> {
  if (!isObject(entry)) {
    problems.push("malformed skipped-check entry in results.skipped_checks");
    return;
  }
  const id = checkIdOf(entry);
  const at = locationOf(entry);

  const reason = skipReasonOf(entry);
  if (
    reason === null || reason.trim() === "" || reason === NO_REASON_PLACEHOLDER
  ) {
    const placeholder = reason === NO_REASON_PLACEHOLDER
      ? ` (Checkov reports "${NO_REASON_PLACEHOLDER}")`
      : "";
    problems.push(`${id} skipped without a reason at ${at}${placeholder}`);
  }

  const path = repoPathOf(entry);
  if (path === null) {
    problems.push(`${id} skip at ${at} has no usable file_path`);
    return;
  }
  if (escapesScanDir(path)) {
    problems.push(
      `${id} skip at ${at} has a file path outside the scanned directory`,
    );
    return;
  }
  const range = rangeOf(entry.file_line_range);
  if (range === null) {
    problems.push(`${id} skip at ${at} has no valid file_line_range`);
    return;
  }
  const text = await readTemplate(templates, path);
  if (text === null) {
    problems.push(
      `${id} skip at ${at}: template ${path} could not be read to find its inline skip comment`,
    );
    return;
  }
  if (!hasInlineSkip(text, id, range)) {
    problems.push(
      `${id} skip at ${at} has no inline "# checkov:skip=${id}:<reason>" comment in ${path} (a skip set in Metadata is not accepted)`,
    );
  }
}

function judgeSummaryOnly(report: Obj, problems: string[]): void {
  const failed = report.failed as number;
  const parsingErrors = report.parsing_errors as number;
  if (failed > 0) {
    problems.push(
      `summary reports ${failed} failed check(s) with no report body to name them`,
    );
  }
  if (parsingErrors > 0) {
    problems.push(
      `summary reports ${parsingErrors} parsing error(s) with no report body to name the files`,
    );
  }
}

async function judgeFullReport(
  report: Obj,
  templates: CheckovTemplateReader,
  problems: string[],
  totals: Totals,
): Promise<void> {
  const results = report.results as Obj;
  const summary = report.summary as Obj;

  for (const key of RESULT_LISTS) {
    if (!Array.isArray(results[key])) {
      problems.push(`results.${key} is not a list`);
    }
  }
  for (const key of SUMMARY_COUNTS) {
    if (!isCount(summary[key])) {
      problems.push(`summary.${key} is not a number`);
    }
  }

  const failed = listOf(results.failed_checks);
  for (const entry of failed) problems.push(describeFailure(entry));
  if (failed.length === 0 && isCount(summary.failed) && summary.failed > 0) {
    problems.push(
      `summary reports ${summary.failed} failed check(s) but none are listed`,
    );
  }

  const parseErrors = listOf(results.parsing_errors);
  for (const file of parseErrors) {
    const name = typeof file === "string" ? file : "<unnamed file>";
    problems.push(
      `${name} could not be parsed by Checkov (a parse error is not a pass)`,
    );
  }
  if (
    parseErrors.length === 0 && isCount(summary.parsing_errors) &&
    summary.parsing_errors > 0
  ) {
    problems.push(
      `summary reports ${summary.parsing_errors} parsing error(s) but names no file`,
    );
  }

  for (const entry of listOf(results.skipped_checks)) {
    await judgeSkip(entry, templates, problems);
  }

  totals.fullReports++;
  if (isCount(summary.passed)) totals.passed += summary.passed;
  if (isCount(summary.skipped)) totals.skipped += summary.skipped;
}

type ParsedOutput =
  | { ok: true; reports: Obj[] }
  | { ok: false; problem: string };

/** Parse stdout as one report or a non-empty list of reports. */
function parseReports(stdout: string): ParsedOutput {
  const invalid = (reason: string): ParsedOutput => ({
    ok: false,
    problem: `output is not valid Checkov JSON (${reason})`,
  });
  if (stdout.trim() === "") return invalid("stdout is empty");

  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    return invalid(`parse error: ${messageOf(error)}`);
  }
  if (Array.isArray(value) && value.length === 0) {
    return invalid("empty list");
  }

  const items: unknown[] = Array.isArray(value) ? value : [value];
  const reports: Obj[] = [];
  for (const item of items) {
    if (!isObject(item) || !(isSummaryOnly(item) || isFullReport(item))) {
      return invalid("not a Checkov report");
    }
    reports.push(item);
  }
  return { ok: true, reports };
}

function verdictFor(problems: string[], totals: Totals): CheckovVerdict {
  if (problems.length > 0) {
    return {
      status: "FAILED",
      report: [...problems.map((p) => `- ${p}`), "Status: FAILED"].join("\n"),
    };
  }
  const summary = totals.fullReports === 0
    ? "No CloudFormation templates found; nothing to check."
    : `Checkov passed: ${totals.passed} passed, ${totals.skipped} skipped with a reason.`;
  return { status: "PASSED", report: `${summary}\nStatus: PASSED` };
}

/**
 * Decide PASSED or FAILED for one Checkov run. Collects every problem rather
 * than stopping at the first, and never throws on an odd shape: malformed
 * data becomes a problem.
 */
export async function judgeCheckovRun(input: {
  exitCode: number;
  stdout: string;
  templates: CheckovTemplateReader;
}): Promise<CheckovVerdict> {
  const problems: string[] = [];
  if (!ACCEPTED_EXIT_CODES.includes(input.exitCode)) {
    problems.push(
      `Checkov exited with code ${input.exitCode}; only 0 and 1 are accepted`,
    );
  }

  const parsed = parseReports(input.stdout);
  if (!parsed.ok) {
    problems.push(parsed.problem);
    return verdictFor(problems, { passed: 0, skipped: 0, fullReports: 0 });
  }

  const totals: Totals = { passed: 0, skipped: 0, fullReports: 0 };
  for (const report of parsed.reports) {
    if (isSummaryOnly(report)) {
      judgeSummaryOnly(report, problems);
    } else {
      await judgeFullReport(report, input.templates, problems, totals);
    }
  }
  return verdictFor(problems, totals);
}

/** Read a template relative to the current directory (the scanned repo root). */
async function readTemplateFromCwd(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/**
 * CLI entry point. Returns 0 for PASSED, 1 for FAILED or an unreadable
 * report, and 2 for bad usage.
 */
export async function main(args: string[]): Promise<number> {
  const [reportPath, exitText] = args;
  if (
    args.length !== 2 || reportPath === undefined || exitText === undefined ||
    !/^\d+$/.test(exitText)
  ) {
    console.error(USAGE);
    return 2;
  }

  let stdout: string;
  try {
    stdout = await Deno.readTextFile(reportPath);
  } catch (error) {
    console.error(
      `checkov_report: cannot read report ${reportPath}: ${messageOf(error)}`,
    );
    return 1;
  }

  const verdict = await judgeCheckovRun({
    exitCode: Number(exitText),
    stdout,
    templates: readTemplateFromCwd,
  });
  console.log(verdict.report);
  return verdict.status === "PASSED" ? 0 : 1;
}

if (import.meta.main) {
  // Issue #1280 (SEC-1217-12): the report is printed to stdout; redact any credential a template or finding quotes.
  installConsoleRedaction();
  Deno.exit(await main(Deno.args));
}
