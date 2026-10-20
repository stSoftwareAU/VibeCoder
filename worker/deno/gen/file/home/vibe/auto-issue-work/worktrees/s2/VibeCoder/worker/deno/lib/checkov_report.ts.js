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
 */ import { installConsoleRedaction } from "./console_redaction.ts";
/** The Checkov scan both the CI workflow and the local gate run. */ export const CHECKOV_SCAN_ARGS = [
  "-d",
  ".",
  "--framework",
  "cloudformation",
  "-o",
  "json",
  "--skip-download"
];
/** Checkov's placeholder suppress comment for a skip written with no reason. */ const NO_REASON_PLACEHOLDER = "No comment provided";
/** Exit codes the judge accepts: 0 clean, 1 failed checks. */ const ACCEPTED_EXIT_CODES = [
  0,
  1
];
/** Count fields Checkov prints in a summary-only object (no templates found). */ const SUMMARY_ONLY_COUNTS = [
  "passed",
  "failed",
  "skipped",
  "parsing_errors",
  "resource_count"
];
/** Keys of `results` that must be lists. */ const RESULT_LISTS = [
  "failed_checks",
  "skipped_checks",
  "parsing_errors"
];
/** Keys of `summary` that must be numbers. */ const SUMMARY_COUNTS = [
  "passed",
  "failed",
  "skipped",
  "parsing_errors"
];
/** Usage line printed on bad arguments. */ const USAGE = "usage: deno run --allow-read worker/deno/lib/checkov_report.ts <report.json> <checkov-exit-code>";
/**
 * An inline skip comment. Linear: tested one line at a time, with no
 * overlapping quantifiers. Group 1 is the check ID, group 2 the reason.
 */ const INLINE_SKIP = /#\s*checkov:skip=([A-Z0-9_]+):(\S[^\n]*)/g;
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCount(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function isSummaryOnly(value) {
  return !("results" in value) && SUMMARY_ONLY_COUNTS.every((key)=>isCount(value[key]));
}
function isFullReport(value) {
  return typeof value.check_type === "string" && isObject(value.results) && isObject(value.summary);
}
/** The items of a list field, or an empty list when the field is not one. */ function listOf(value) {
  return Array.isArray(value) ? value : [];
}
/** A 1-based inclusive `[start, end]` range, or null when malformed. */ function rangeOf(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const from = start;
  const to = end;
  if (from < 1 || to < from) return null;
  return [
    from,
    to
  ];
}
/** The check ID, or a placeholder when the field is absent or malformed. */ function checkIdOf(entry) {
  return typeof entry.check_id === "string" && entry.check_id !== "" ? entry.check_id : "<unnamed check>";
}
/**
 * `file_path` with a leading `/` and then a leading `./` stripped, or null
 * when it is not a string or is empty once stripped. A path that
 * `escapesScanDir` flags is still returned here, but `judgeSkip` refuses it
 * before the reader is called, so only templates inside the scanned directory
 * can justify a skip.
 */ function repoPathOf(entry) {
  if (typeof entry.file_path !== "string") return null;
  const path = entry.file_path.replace(/^\//, "").replace(/^\.\//, "");
  return path === "" ? null : path;
}
/**
 * True when a `repoPathOf` path is absolute, holds a NUL, or has a `..` segment
 * (split on both `/` and `\`): a template it names may lie outside the scanned
 * directory.
 */ function escapesScanDir(path) {
  return /^[/\\]/.test(path) || path.includes("\0") || path.split(/[/\\]/).includes("..");
}
/** `file_path` and line range as shown in a problem line. */ function locationOf(entry) {
  const file = typeof entry.file_path === "string" ? entry.file_path : "<unknown file>";
  const range = rangeOf(entry.file_line_range);
  return range ? `${file} lines ${range[0]}-${range[1]}` : file;
}
/**
 * The skip reason Checkov recorded: `check_result.suppress_comment`, else the
 * top-level `suppress_comment`. Null when neither is a string.
 */ function skipReasonOf(entry) {
  const checkResult = isObject(entry.check_result) ? entry.check_result : undefined;
  const candidate = checkResult?.suppress_comment ?? entry.suppress_comment;
  return typeof candidate === "string" ? candidate : null;
}
function describeFailure(entry) {
  if (!isObject(entry)) {
    return "malformed failed-check entry in results.failed_checks";
  }
  const name = typeof entry.check_name === "string" && entry.check_name !== "" ? ` (${entry.check_name})` : "";
  return `${checkIdOf(entry)} failed at ${locationOf(entry)}${name}`;
}
/** True when `lines[start..end]` (1-based, inclusive) holds the skip. */ function hasInlineSkip(text, checkId, range) {
  const lines = text.split("\n");
  const last = Math.min(range[1], lines.length);
  for(let lineNo = range[0]; lineNo <= last; lineNo++){
    const line = lines[lineNo - 1] ?? "";
    for (const match of line.matchAll(INLINE_SKIP)){
      if (match[1] === checkId) return true;
    }
  }
  return false;
}
async function readTemplate(templates, path) {
  try {
    const text = await templates(path);
    return typeof text === "string" ? text : null;
  } catch  {
    return null;
  }
}
async function judgeSkip(entry, templates, problems) {
  if (!isObject(entry)) {
    problems.push("malformed skipped-check entry in results.skipped_checks");
    return;
  }
  const id = checkIdOf(entry);
  const at = locationOf(entry);
  const reason = skipReasonOf(entry);
  if (reason === null || reason.trim() === "" || reason === NO_REASON_PLACEHOLDER) {
    const placeholder = reason === NO_REASON_PLACEHOLDER ? ` (Checkov reports "${NO_REASON_PLACEHOLDER}")` : "";
    problems.push(`${id} skipped without a reason at ${at}${placeholder}`);
  }
  const path = repoPathOf(entry);
  if (path === null) {
    problems.push(`${id} skip at ${at} has no usable file_path`);
    return;
  }
  if (escapesScanDir(path)) {
    problems.push(`${id} skip at ${at} has a file path outside the scanned directory`);
    return;
  }
  const range = rangeOf(entry.file_line_range);
  if (range === null) {
    problems.push(`${id} skip at ${at} has no valid file_line_range`);
    return;
  }
  const text = await readTemplate(templates, path);
  if (text === null) {
    problems.push(`${id} skip at ${at}: template ${path} could not be read to find its inline skip comment`);
    return;
  }
  if (!hasInlineSkip(text, id, range)) {
    problems.push(`${id} skip at ${at} has no inline "# checkov:skip=${id}:<reason>" comment in ${path} (a skip set in Metadata is not accepted)`);
  }
}
function judgeSummaryOnly(report, problems) {
  const failed = report.failed;
  const parsingErrors = report.parsing_errors;
  if (failed > 0) {
    problems.push(`summary reports ${failed} failed check(s) with no report body to name them`);
  }
  if (parsingErrors > 0) {
    problems.push(`summary reports ${parsingErrors} parsing error(s) with no report body to name the files`);
  }
}
async function judgeFullReport(report, templates, problems, totals) {
  const results = report.results;
  const summary = report.summary;
  for (const key of RESULT_LISTS){
    if (!Array.isArray(results[key])) {
      problems.push(`results.${key} is not a list`);
    }
  }
  for (const key of SUMMARY_COUNTS){
    if (!isCount(summary[key])) {
      problems.push(`summary.${key} is not a number`);
    }
  }
  const failed = listOf(results.failed_checks);
  for (const entry of failed)problems.push(describeFailure(entry));
  if (failed.length === 0 && isCount(summary.failed) && summary.failed > 0) {
    problems.push(`summary reports ${summary.failed} failed check(s) but none are listed`);
  }
  const parseErrors = listOf(results.parsing_errors);
  for (const file of parseErrors){
    const name = typeof file === "string" ? file : "<unnamed file>";
    problems.push(`${name} could not be parsed by Checkov (a parse error is not a pass)`);
  }
  if (parseErrors.length === 0 && isCount(summary.parsing_errors) && summary.parsing_errors > 0 && false) {
    problems.push(`summary reports ${summary.parsing_errors} parsing error(s) but names no file`);
  }
  for (const entry of listOf(results.skipped_checks)){
    await judgeSkip(entry, templates, problems);
  }
  totals.fullReports++;
  if (isCount(summary.passed)) totals.passed += summary.passed;
  if (isCount(summary.skipped)) totals.skipped += summary.skipped;
}
/** Parse stdout as one report or a non-empty list of reports. */ function parseReports(stdout) {
  const invalid = (reason)=>({
      ok: false,
      problem: `output is not valid Checkov JSON (${reason})`
    });
  if (stdout.trim() === "") return invalid("stdout is empty");
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    return invalid(`parse error: ${messageOf(error)}`);
  }
  if (Array.isArray(value) && value.length === 0) {
    return invalid("empty list");
  }
  const items = Array.isArray(value) ? value : [
    value
  ];
  const reports = [];
  for (const item of items){
    if (!isObject(item) || !(isSummaryOnly(item) || isFullReport(item))) {
      return invalid("not a Checkov report");
    }
    reports.push(item);
  }
  return {
    ok: true,
    reports
  };
}
function verdictFor(problems, totals) {
  if (problems.length > 0) {
    return {
      status: "FAILED",
      report: [
        ...problems.map((p)=>`- ${p}`),
        "Status: FAILED"
      ].join("\n")
    };
  }
  const summary = totals.fullReports === 0 ? "No CloudFormation templates found; nothing to check." : `Checkov passed: ${totals.passed} passed, ${totals.skipped} skipped with a reason.`;
  return {
    status: "PASSED",
    report: `${summary}\nStatus: PASSED`
  };
}
/**
 * Decide PASSED or FAILED for one Checkov run. Collects every problem rather
 * than stopping at the first, and never throws on an odd shape: malformed
 * data becomes a problem.
 */ export async function judgeCheckovRun(input) {
  const problems = [];
  if (!ACCEPTED_EXIT_CODES.includes(input.exitCode)) {
    problems.push(`Checkov exited with code ${input.exitCode}; only 0 and 1 are accepted`);
  }
  const parsed = parseReports(input.stdout);
  if (!parsed.ok) {
    problems.push(parsed.problem);
    return verdictFor(problems, {
      passed: 0,
      skipped: 0,
      fullReports: 0
    });
  }
  const totals = {
    passed: 0,
    skipped: 0,
    fullReports: 0
  };
  for (const report of parsed.reports){
    if (isSummaryOnly(report)) {
      judgeSummaryOnly(report, problems);
    } else {
      await judgeFullReport(report, input.templates, problems, totals);
    }
  }
  return verdictFor(problems, totals);
}
/** Read a template relative to the current directory (the scanned repo root). */ async function readTemplateFromCwd(path) {
  try {
    return await Deno.readTextFile(path);
  } catch  {
    return null;
  }
}
/**
 * CLI entry point. Returns 0 for PASSED, 1 for FAILED or an unreadable
 * report, and 2 for bad usage.
 */ export async function main(args) {
  const [reportPath, exitText] = args;
  if (args.length !== 2 || reportPath === undefined || exitText === undefined || !/^\d+$/.test(exitText)) {
    console.error(USAGE);
    return 2;
  }
  let stdout;
  try {
    stdout = await Deno.readTextFile(reportPath);
  } catch (error) {
    console.error(`checkov_report: cannot read report ${reportPath}: ${messageOf(error)}`);
    return 1;
  }
  const verdict = await judgeCheckovRun({
    exitCode: Number(exitText),
    stdout,
    templates: readTemplateFromCwd
  });
  console.log(verdict.report);
  return verdict.status === "PASSED" ? 0 : 1;
}
if (import.meta.main) {
  // Issue #1280 (SEC-1217-12): the report is printed to stdout; redact any credential a template or finding quotes.
  installConsoleRedaction();
  Deno.exit(await main(Deno.args));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jaGVja292X3JlcG9ydC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENoZWNrb3Ygc2NhbiBjb250cmFjdCBhbmQgdmVyZGljdCBqdWRnZSwgc2hhcmVkIGJ5IHRoZSBDSSB3b3JrZmxvdyBhbmQgdGhlXG4gKiBsb2NhbCBxdWFsaXR5LWdhdGUgc3RhZ2UgKElzc3VlICMzOTcwKS5cbiAqXG4gKiBCb3RoIHJ1biB0aGUgc2FtZSBzY2FuOiBgQ0hFQ0tPVl9TQ0FOX0FSR1NgLCBleGVjdXRlZCBmcm9tIHRoZSBzY2FubmVkXG4gKiByZXBvc2l0b3J5IHJvb3QgaW5zaWRlIHRoZSBwaW5uZWQgQ2hlY2tvdiBpbWFnZS4gVGhlIGV4aXQgY29kZSBhbmQgc3Rkb3V0XG4gKiB0aGVuIGdvIHRvIGBqdWRnZUNoZWNrb3ZSdW5gLCB3aGljaCBkZWNpZGVzIFBBU1NFRCBvciBGQUlMRUQgaXRzZWxmLiBUaGVcbiAqIGp1ZGdlIGRvZXMgbm90IHRydXN0IENoZWNrb3YncyBleGl0IGNvZGUsIGJlY2F1c2UgQ2hlY2tvdiAzLjMuMjk6XG4gKlxuICogICAtIGV4aXRzIDAgd2hlbiBhIHRlbXBsYXRlIGZhaWxzIHRvIHBhcnNlICh0aGUgcGFyc2UgZXJyb3IgaXMgb25seSBsaXN0ZWRcbiAqICAgICBpbiBgcmVzdWx0cy5wYXJzaW5nX2Vycm9yc2ApO1xuICogICAtIGFjY2VwdHMgYSBza2lwIHdpdGggbm8gcmVhc29uLCByZXBvcnRpbmcgaXQgYXMgXCJObyBjb21tZW50IHByb3ZpZGVkXCI7XG4gKiAgIC0gYWNjZXB0cyBhIHNraXAgc2V0IGluIGEgcmVzb3VyY2UncyBgTWV0YWRhdGFgIGJsb2NrLCB3aXRoIG5vIGNvbW1lbnRcbiAqICAgICBiZXNpZGUgdGhlIHJlc291cmNlIHRoYXQgYSByZXZpZXdlciBjb3VsZCBzZWU7XG4gKiAgIC0gcHJpbnRzIGEgc3VtbWFyeS1vbmx5IG9iamVjdCwgbm90IGEgcmVwb3J0LCB3aGVuIGl0IGZpbmRzIG5vIHRlbXBsYXRlcy5cbiAqXG4gKiBTbyB0aGUganVkZ2UgYXBwbGllcyB0aGUgcmVwbydzIHJ1bGVzIHRvIHRoZSBKU09OLiBFdmVyeSBmYWlsZWQgY2hlY2ssXG4gKiBldmVyeSBwYXJzZSBlcnJvciBhbmQgZXZlcnkgc2tpcCB3aXRob3V0IGEgcmVhc29uIGlzIGEgcHJvYmxlbSwgYW5kIGFcbiAqIHNraXAgaXMgb25seSBhY2NlcHRlZCB3aGVuIHRoZSB0ZW1wbGF0ZSBjYXJyaWVzIGFuIGlubGluZVxuICogYCMgY2hlY2tvdjpza2lwPTxJRD46PHJlYXNvbj5gIGNvbW1lbnQgd2l0aGluIHRoZSBjaGVjaydzIGxpbmUgcmFuZ2UuXG4gKlxuICogVXNhZ2UsIGZyb20gdGhlIHNjYW5uZWQgcmVwb3NpdG9yeSByb290OlxuICpcbiAqICAgZGVubyBydW4gLS1hbGxvdy1yZWFkIHdvcmtlci9kZW5vL2xpYi9jaGVja292X3JlcG9ydC50cyA8cmVwb3J0Lmpzb24+IDxjaGVja292LWV4aXQtY29kZT5cbiAqXG4gKiBFeGl0IHN0YXR1czogMCBQQVNTRUQsIDEgRkFJTEVEIChvciB0aGUgcmVwb3J0IGNhbm5vdCBiZSByZWFkKSwgMiBiYWQgdXNhZ2UuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGluc3RhbGxDb25zb2xlUmVkYWN0aW9uIH0gZnJvbSBcIi4vY29uc29sZV9yZWRhY3Rpb24udHNcIjtcblxuLyoqIFRoZSBDaGVja292IHNjYW4gYm90aCB0aGUgQ0kgd29ya2Zsb3cgYW5kIHRoZSBsb2NhbCBnYXRlIHJ1bi4gKi9cbmV4cG9ydCBjb25zdCBDSEVDS09WX1NDQU5fQVJHUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwiLWRcIixcbiAgXCIuXCIsXG4gIFwiLS1mcmFtZXdvcmtcIixcbiAgXCJjbG91ZGZvcm1hdGlvblwiLFxuICBcIi1vXCIsXG4gIFwianNvblwiLFxuICBcIi0tc2tpcC1kb3dubG9hZFwiLFxuXSBhcyBjb25zdDtcblxuLyoqXG4gKiBSZXR1cm5zIHRoZSB0ZW1wbGF0ZSB0ZXh0IGZvciBhIHJlcG8tcmVsYXRpdmUgcGF0aCwgb3IgbnVsbCB3aGVuIGl0IGNhbm5vdFxuICogYmUgcmVhZC5cbiAqL1xuZXhwb3J0IHR5cGUgQ2hlY2tvdlRlbXBsYXRlUmVhZGVyID0gKHBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcblxuLyoqIFRoZSBqdWRnZSdzIGRlY2lzaW9uIGFuZCB0aGUgaHVtYW4tcmVhZGFibGUgdGV4dCBiZWhpbmQgaXQuICovXG5leHBvcnQgaW50ZXJmYWNlIENoZWNrb3ZWZXJkaWN0IHtcbiAgc3RhdHVzOiBcIlBBU1NFRFwiIHwgXCJGQUlMRURcIjtcbiAgLyoqXG4gICAqIE9uZSBsaW5lIHBlciBwcm9ibGVtIChlYWNoIG5hbWluZyB0aGUgY2hlY2sgSUQsIGZpbGUgYW5kIGxpbmUgcmFuZ2VcbiAgICogd2hlcmUgcmVsZXZhbnQpLCB0aGVuIGEgZmluYWwgc3RhdHVzIGxpbmUuIEEgUEFTU0VEIHZlcmRpY3QgY2FycmllcyBhXG4gICAqIHNob3J0IHN1bW1hcnkgaW5zdGVhZC5cbiAgICovXG4gIHJlcG9ydDogc3RyaW5nO1xufVxuXG4vKiogQ2hlY2tvdidzIHBsYWNlaG9sZGVyIHN1cHByZXNzIGNvbW1lbnQgZm9yIGEgc2tpcCB3cml0dGVuIHdpdGggbm8gcmVhc29uLiAqL1xuY29uc3QgTk9fUkVBU09OX1BMQUNFSE9MREVSID0gXCJObyBjb21tZW50IHByb3ZpZGVkXCI7XG5cbi8qKiBFeGl0IGNvZGVzIHRoZSBqdWRnZSBhY2NlcHRzOiAwIGNsZWFuLCAxIGZhaWxlZCBjaGVja3MuICovXG5jb25zdCBBQ0NFUFRFRF9FWElUX0NPREVTOiByZWFkb25seSBudW1iZXJbXSA9IFswLCAxXTtcblxuLyoqIENvdW50IGZpZWxkcyBDaGVja292IHByaW50cyBpbiBhIHN1bW1hcnktb25seSBvYmplY3QgKG5vIHRlbXBsYXRlcyBmb3VuZCkuICovXG5jb25zdCBTVU1NQVJZX09OTFlfQ09VTlRTID0gW1xuICBcInBhc3NlZFwiLFxuICBcImZhaWxlZFwiLFxuICBcInNraXBwZWRcIixcbiAgXCJwYXJzaW5nX2Vycm9yc1wiLFxuICBcInJlc291cmNlX2NvdW50XCIsXG5dIGFzIGNvbnN0O1xuXG4vKiogS2V5cyBvZiBgcmVzdWx0c2AgdGhhdCBtdXN0IGJlIGxpc3RzLiAqL1xuY29uc3QgUkVTVUxUX0xJU1RTID0gW1xuICBcImZhaWxlZF9jaGVja3NcIixcbiAgXCJza2lwcGVkX2NoZWNrc1wiLFxuICBcInBhcnNpbmdfZXJyb3JzXCIsXG5dIGFzIGNvbnN0O1xuXG4vKiogS2V5cyBvZiBgc3VtbWFyeWAgdGhhdCBtdXN0IGJlIG51bWJlcnMuICovXG5jb25zdCBTVU1NQVJZX0NPVU5UUyA9IFtcbiAgXCJwYXNzZWRcIixcbiAgXCJmYWlsZWRcIixcbiAgXCJza2lwcGVkXCIsXG4gIFwicGFyc2luZ19lcnJvcnNcIixcbl0gYXMgY29uc3Q7XG5cbi8qKiBVc2FnZSBsaW5lIHByaW50ZWQgb24gYmFkIGFyZ3VtZW50cy4gKi9cbmNvbnN0IFVTQUdFID1cbiAgXCJ1c2FnZTogZGVubyBydW4gLS1hbGxvdy1yZWFkIHdvcmtlci9kZW5vL2xpYi9jaGVja292X3JlcG9ydC50cyA8cmVwb3J0Lmpzb24+IDxjaGVja292LWV4aXQtY29kZT5cIjtcblxuLyoqXG4gKiBBbiBpbmxpbmUgc2tpcCBjb21tZW50LiBMaW5lYXI6IHRlc3RlZCBvbmUgbGluZSBhdCBhIHRpbWUsIHdpdGggbm9cbiAqIG92ZXJsYXBwaW5nIHF1YW50aWZpZXJzLiBHcm91cCAxIGlzIHRoZSBjaGVjayBJRCwgZ3JvdXAgMiB0aGUgcmVhc29uLlxuICovXG5jb25zdCBJTkxJTkVfU0tJUCA9IC8jXFxzKmNoZWNrb3Y6c2tpcD0oW0EtWjAtOV9dKyk6KFxcU1teXFxuXSopL2c7XG5cbi8qKiBNdXRhYmxlIHRhbGxpZXMgYSBQQVNTRUQgdmVyZGljdCByZXBvcnRzLiAqL1xuaW50ZXJmYWNlIFRvdGFscyB7XG4gIHBhc3NlZDogbnVtYmVyO1xuICBza2lwcGVkOiBudW1iZXI7XG4gIGZ1bGxSZXBvcnRzOiBudW1iZXI7XG59XG5cbnR5cGUgT2JqID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbmZ1bmN0aW9uIGlzT2JqZWN0KHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgT2JqIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIGlzQ291bnQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBudW1iZXIge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIG1lc3NhZ2VPZihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbmZ1bmN0aW9uIGlzU3VtbWFyeU9ubHkodmFsdWU6IE9iaik6IGJvb2xlYW4ge1xuICByZXR1cm4gIShcInJlc3VsdHNcIiBpbiB2YWx1ZSkgJiZcbiAgICBTVU1NQVJZX09OTFlfQ09VTlRTLmV2ZXJ5KChrZXkpID0+IGlzQ291bnQodmFsdWVba2V5XSkpO1xufVxuXG5mdW5jdGlvbiBpc0Z1bGxSZXBvcnQodmFsdWU6IE9iaik6IGJvb2xlYW4ge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlLmNoZWNrX3R5cGUgPT09IFwic3RyaW5nXCIgJiZcbiAgICBpc09iamVjdCh2YWx1ZS5yZXN1bHRzKSAmJlxuICAgIGlzT2JqZWN0KHZhbHVlLnN1bW1hcnkpO1xufVxuXG4vKiogVGhlIGl0ZW1zIG9mIGEgbGlzdCBmaWVsZCwgb3IgYW4gZW1wdHkgbGlzdCB3aGVuIHRoZSBmaWVsZCBpcyBub3Qgb25lLiAqL1xuZnVuY3Rpb24gbGlzdE9mKHZhbHVlOiB1bmtub3duKTogdW5rbm93bltdIHtcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkodmFsdWUpID8gdmFsdWUgOiBbXTtcbn1cblxuLyoqIEEgMS1iYXNlZCBpbmNsdXNpdmUgYFtzdGFydCwgZW5kXWAgcmFuZ2UsIG9yIG51bGwgd2hlbiBtYWxmb3JtZWQuICovXG5mdW5jdGlvbiByYW5nZU9mKHZhbHVlOiB1bmtub3duKTogW251bWJlciwgbnVtYmVyXSB8IG51bGwge1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpIHx8IHZhbHVlLmxlbmd0aCAhPT0gMikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IFtzdGFydCwgZW5kXSA9IHZhbHVlO1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIoc3RhcnQpIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKGVuZCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmcm9tID0gc3RhcnQgYXMgbnVtYmVyO1xuICBjb25zdCB0byA9IGVuZCBhcyBudW1iZXI7XG4gIGlmIChmcm9tIDwgMSB8fCB0byA8IGZyb20pIHJldHVybiBudWxsO1xuICByZXR1cm4gW2Zyb20sIHRvXTtcbn1cblxuLyoqIFRoZSBjaGVjayBJRCwgb3IgYSBwbGFjZWhvbGRlciB3aGVuIHRoZSBmaWVsZCBpcyBhYnNlbnQgb3IgbWFsZm9ybWVkLiAqL1xuZnVuY3Rpb24gY2hlY2tJZE9mKGVudHJ5OiBPYmopOiBzdHJpbmcge1xuICByZXR1cm4gdHlwZW9mIGVudHJ5LmNoZWNrX2lkID09PSBcInN0cmluZ1wiICYmIGVudHJ5LmNoZWNrX2lkICE9PSBcIlwiXG4gICAgPyBlbnRyeS5jaGVja19pZFxuICAgIDogXCI8dW5uYW1lZCBjaGVjaz5cIjtcbn1cblxuLyoqXG4gKiBgZmlsZV9wYXRoYCB3aXRoIGEgbGVhZGluZyBgL2AgYW5kIHRoZW4gYSBsZWFkaW5nIGAuL2Agc3RyaXBwZWQsIG9yIG51bGxcbiAqIHdoZW4gaXQgaXMgbm90IGEgc3RyaW5nIG9yIGlzIGVtcHR5IG9uY2Ugc3RyaXBwZWQuIEEgcGF0aCB0aGF0XG4gKiBgZXNjYXBlc1NjYW5EaXJgIGZsYWdzIGlzIHN0aWxsIHJldHVybmVkIGhlcmUsIGJ1dCBganVkZ2VTa2lwYCByZWZ1c2VzIGl0XG4gKiBiZWZvcmUgdGhlIHJlYWRlciBpcyBjYWxsZWQsIHNvIG9ubHkgdGVtcGxhdGVzIGluc2lkZSB0aGUgc2Nhbm5lZCBkaXJlY3RvcnlcbiAqIGNhbiBqdXN0aWZ5IGEgc2tpcC5cbiAqL1xuZnVuY3Rpb24gcmVwb1BhdGhPZihlbnRyeTogT2JqKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgZW50cnkuZmlsZV9wYXRoICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcGF0aCA9IGVudHJ5LmZpbGVfcGF0aC5yZXBsYWNlKC9eXFwvLywgXCJcIikucmVwbGFjZSgvXlxcLlxcLy8sIFwiXCIpO1xuICByZXR1cm4gcGF0aCA9PT0gXCJcIiA/IG51bGwgOiBwYXRoO1xufVxuXG4vKipcbiAqIFRydWUgd2hlbiBhIGByZXBvUGF0aE9mYCBwYXRoIGlzIGFic29sdXRlLCBob2xkcyBhIE5VTCwgb3IgaGFzIGEgYC4uYCBzZWdtZW50XG4gKiAoc3BsaXQgb24gYm90aCBgL2AgYW5kIGBcXGApOiBhIHRlbXBsYXRlIGl0IG5hbWVzIG1heSBsaWUgb3V0c2lkZSB0aGUgc2Nhbm5lZFxuICogZGlyZWN0b3J5LlxuICovXG5mdW5jdGlvbiBlc2NhcGVzU2NhbkRpcihwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIC9eWy9cXFxcXS8udGVzdChwYXRoKSB8fCBwYXRoLmluY2x1ZGVzKFwiXFwwXCIpIHx8XG4gICAgcGF0aC5zcGxpdCgvWy9cXFxcXS8pLmluY2x1ZGVzKFwiLi5cIik7XG59XG5cbi8qKiBgZmlsZV9wYXRoYCBhbmQgbGluZSByYW5nZSBhcyBzaG93biBpbiBhIHByb2JsZW0gbGluZS4gKi9cbmZ1bmN0aW9uIGxvY2F0aW9uT2YoZW50cnk6IE9iaik6IHN0cmluZyB7XG4gIGNvbnN0IGZpbGUgPSB0eXBlb2YgZW50cnkuZmlsZV9wYXRoID09PSBcInN0cmluZ1wiXG4gICAgPyBlbnRyeS5maWxlX3BhdGhcbiAgICA6IFwiPHVua25vd24gZmlsZT5cIjtcbiAgY29uc3QgcmFuZ2UgPSByYW5nZU9mKGVudHJ5LmZpbGVfbGluZV9yYW5nZSk7XG4gIHJldHVybiByYW5nZSA/IGAke2ZpbGV9IGxpbmVzICR7cmFuZ2VbMF19LSR7cmFuZ2VbMV19YCA6IGZpbGU7XG59XG5cbi8qKlxuICogVGhlIHNraXAgcmVhc29uIENoZWNrb3YgcmVjb3JkZWQ6IGBjaGVja19yZXN1bHQuc3VwcHJlc3NfY29tbWVudGAsIGVsc2UgdGhlXG4gKiB0b3AtbGV2ZWwgYHN1cHByZXNzX2NvbW1lbnRgLiBOdWxsIHdoZW4gbmVpdGhlciBpcyBhIHN0cmluZy5cbiAqL1xuZnVuY3Rpb24gc2tpcFJlYXNvbk9mKGVudHJ5OiBPYmopOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgY2hlY2tSZXN1bHQgPSBpc09iamVjdChlbnRyeS5jaGVja19yZXN1bHQpXG4gICAgPyBlbnRyeS5jaGVja19yZXN1bHRcbiAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3QgY2FuZGlkYXRlID0gY2hlY2tSZXN1bHQ/LnN1cHByZXNzX2NvbW1lbnQgPz8gZW50cnkuc3VwcHJlc3NfY29tbWVudDtcbiAgcmV0dXJuIHR5cGVvZiBjYW5kaWRhdGUgPT09IFwic3RyaW5nXCIgPyBjYW5kaWRhdGUgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBkZXNjcmliZUZhaWx1cmUoZW50cnk6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAoIWlzT2JqZWN0KGVudHJ5KSkge1xuICAgIHJldHVybiBcIm1hbGZvcm1lZCBmYWlsZWQtY2hlY2sgZW50cnkgaW4gcmVzdWx0cy5mYWlsZWRfY2hlY2tzXCI7XG4gIH1cbiAgY29uc3QgbmFtZSA9IHR5cGVvZiBlbnRyeS5jaGVja19uYW1lID09PSBcInN0cmluZ1wiICYmIGVudHJ5LmNoZWNrX25hbWUgIT09IFwiXCJcbiAgICA/IGAgKCR7ZW50cnkuY2hlY2tfbmFtZX0pYFxuICAgIDogXCJcIjtcbiAgcmV0dXJuIGAke2NoZWNrSWRPZihlbnRyeSl9IGZhaWxlZCBhdCAke2xvY2F0aW9uT2YoZW50cnkpfSR7bmFtZX1gO1xufVxuXG4vKiogVHJ1ZSB3aGVuIGBsaW5lc1tzdGFydC4uZW5kXWAgKDEtYmFzZWQsIGluY2x1c2l2ZSkgaG9sZHMgdGhlIHNraXAuICovXG5mdW5jdGlvbiBoYXNJbmxpbmVTa2lwKFxuICB0ZXh0OiBzdHJpbmcsXG4gIGNoZWNrSWQ6IHN0cmluZyxcbiAgcmFuZ2U6IFtudW1iZXIsIG51bWJlcl0sXG4pOiBib29sZWFuIHtcbiAgY29uc3QgbGluZXMgPSB0ZXh0LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBsYXN0ID0gTWF0aC5taW4ocmFuZ2VbMV0sIGxpbmVzLmxlbmd0aCk7XG4gIGZvciAobGV0IGxpbmVObyA9IHJhbmdlWzBdOyBsaW5lTm8gPD0gbGFzdDsgbGluZU5vKyspIHtcbiAgICBjb25zdCBsaW5lID0gbGluZXNbbGluZU5vIC0gMV0gPz8gXCJcIjtcbiAgICBmb3IgKGNvbnN0IG1hdGNoIG9mIGxpbmUubWF0Y2hBbGwoSU5MSU5FX1NLSVApKSB7XG4gICAgICBpZiAobWF0Y2hbMV0gPT09IGNoZWNrSWQpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRUZW1wbGF0ZShcbiAgdGVtcGxhdGVzOiBDaGVja292VGVtcGxhdGVSZWFkZXIsXG4gIHBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCB0ZW1wbGF0ZXMocGF0aCk7XG4gICAgcmV0dXJuIHR5cGVvZiB0ZXh0ID09PSBcInN0cmluZ1wiID8gdGV4dCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGp1ZGdlU2tpcChcbiAgZW50cnk6IHVua25vd24sXG4gIHRlbXBsYXRlczogQ2hlY2tvdlRlbXBsYXRlUmVhZGVyLFxuICBwcm9ibGVtczogc3RyaW5nW10sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFpc09iamVjdChlbnRyeSkpIHtcbiAgICBwcm9ibGVtcy5wdXNoKFwibWFsZm9ybWVkIHNraXBwZWQtY2hlY2sgZW50cnkgaW4gcmVzdWx0cy5za2lwcGVkX2NoZWNrc1wiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgaWQgPSBjaGVja0lkT2YoZW50cnkpO1xuICBjb25zdCBhdCA9IGxvY2F0aW9uT2YoZW50cnkpO1xuXG4gIGNvbnN0IHJlYXNvbiA9IHNraXBSZWFzb25PZihlbnRyeSk7XG4gIGlmIChcbiAgICByZWFzb24gPT09IG51bGwgfHwgcmVhc29uLnRyaW0oKSA9PT0gXCJcIiB8fCByZWFzb24gPT09IE5PX1JFQVNPTl9QTEFDRUhPTERFUlxuICApIHtcbiAgICBjb25zdCBwbGFjZWhvbGRlciA9IHJlYXNvbiA9PT0gTk9fUkVBU09OX1BMQUNFSE9MREVSXG4gICAgICA/IGAgKENoZWNrb3YgcmVwb3J0cyBcIiR7Tk9fUkVBU09OX1BMQUNFSE9MREVSfVwiKWBcbiAgICAgIDogXCJcIjtcbiAgICBwcm9ibGVtcy5wdXNoKGAke2lkfSBza2lwcGVkIHdpdGhvdXQgYSByZWFzb24gYXQgJHthdH0ke3BsYWNlaG9sZGVyfWApO1xuICB9XG5cbiAgY29uc3QgcGF0aCA9IHJlcG9QYXRoT2YoZW50cnkpO1xuICBpZiAocGF0aCA9PT0gbnVsbCkge1xuICAgIHByb2JsZW1zLnB1c2goYCR7aWR9IHNraXAgYXQgJHthdH0gaGFzIG5vIHVzYWJsZSBmaWxlX3BhdGhgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGVzY2FwZXNTY2FuRGlyKHBhdGgpKSB7XG4gICAgcHJvYmxlbXMucHVzaChcbiAgICAgIGAke2lkfSBza2lwIGF0ICR7YXR9IGhhcyBhIGZpbGUgcGF0aCBvdXRzaWRlIHRoZSBzY2FubmVkIGRpcmVjdG9yeWAsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcmFuZ2UgPSByYW5nZU9mKGVudHJ5LmZpbGVfbGluZV9yYW5nZSk7XG4gIGlmIChyYW5nZSA9PT0gbnVsbCkge1xuICAgIHByb2JsZW1zLnB1c2goYCR7aWR9IHNraXAgYXQgJHthdH0gaGFzIG5vIHZhbGlkIGZpbGVfbGluZV9yYW5nZWApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVhZFRlbXBsYXRlKHRlbXBsYXRlcywgcGF0aCk7XG4gIGlmICh0ZXh0ID09PSBudWxsKSB7XG4gICAgcHJvYmxlbXMucHVzaChcbiAgICAgIGAke2lkfSBza2lwIGF0ICR7YXR9OiB0ZW1wbGF0ZSAke3BhdGh9IGNvdWxkIG5vdCBiZSByZWFkIHRvIGZpbmQgaXRzIGlubGluZSBza2lwIGNvbW1lbnRgLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghaGFzSW5saW5lU2tpcCh0ZXh0LCBpZCwgcmFuZ2UpKSB7XG4gICAgcHJvYmxlbXMucHVzaChcbiAgICAgIGAke2lkfSBza2lwIGF0ICR7YXR9IGhhcyBubyBpbmxpbmUgXCIjIGNoZWNrb3Y6c2tpcD0ke2lkfTo8cmVhc29uPlwiIGNvbW1lbnQgaW4gJHtwYXRofSAoYSBza2lwIHNldCBpbiBNZXRhZGF0YSBpcyBub3QgYWNjZXB0ZWQpYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGp1ZGdlU3VtbWFyeU9ubHkocmVwb3J0OiBPYmosIHByb2JsZW1zOiBzdHJpbmdbXSk6IHZvaWQge1xuICBjb25zdCBmYWlsZWQgPSByZXBvcnQuZmFpbGVkIGFzIG51bWJlcjtcbiAgY29uc3QgcGFyc2luZ0Vycm9ycyA9IHJlcG9ydC5wYXJzaW5nX2Vycm9ycyBhcyBudW1iZXI7XG4gIGlmIChmYWlsZWQgPiAwKSB7XG4gICAgcHJvYmxlbXMucHVzaChcbiAgICAgIGBzdW1tYXJ5IHJlcG9ydHMgJHtmYWlsZWR9IGZhaWxlZCBjaGVjayhzKSB3aXRoIG5vIHJlcG9ydCBib2R5IHRvIG5hbWUgdGhlbWAsXG4gICAgKTtcbiAgfVxuICBpZiAocGFyc2luZ0Vycm9ycyA+IDApIHtcbiAgICBwcm9ibGVtcy5wdXNoKFxuICAgICAgYHN1bW1hcnkgcmVwb3J0cyAke3BhcnNpbmdFcnJvcnN9IHBhcnNpbmcgZXJyb3Iocykgd2l0aCBubyByZXBvcnQgYm9keSB0byBuYW1lIHRoZSBmaWxlc2AsXG4gICAgKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBqdWRnZUZ1bGxSZXBvcnQoXG4gIHJlcG9ydDogT2JqLFxuICB0ZW1wbGF0ZXM6IENoZWNrb3ZUZW1wbGF0ZVJlYWRlcixcbiAgcHJvYmxlbXM6IHN0cmluZ1tdLFxuICB0b3RhbHM6IFRvdGFscyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByZXN1bHRzID0gcmVwb3J0LnJlc3VsdHMgYXMgT2JqO1xuICBjb25zdCBzdW1tYXJ5ID0gcmVwb3J0LnN1bW1hcnkgYXMgT2JqO1xuXG4gIGZvciAoY29uc3Qga2V5IG9mIFJFU1VMVF9MSVNUUykge1xuICAgIGlmICghQXJyYXkuaXNBcnJheShyZXN1bHRzW2tleV0pKSB7XG4gICAgICBwcm9ibGVtcy5wdXNoKGByZXN1bHRzLiR7a2V5fSBpcyBub3QgYSBsaXN0YCk7XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3Qga2V5IG9mIFNVTU1BUllfQ09VTlRTKSB7XG4gICAgaWYgKCFpc0NvdW50KHN1bW1hcnlba2V5XSkpIHtcbiAgICAgIHByb2JsZW1zLnB1c2goYHN1bW1hcnkuJHtrZXl9IGlzIG5vdCBhIG51bWJlcmApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGZhaWxlZCA9IGxpc3RPZihyZXN1bHRzLmZhaWxlZF9jaGVja3MpO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGZhaWxlZCkgcHJvYmxlbXMucHVzaChkZXNjcmliZUZhaWx1cmUoZW50cnkpKTtcbiAgaWYgKGZhaWxlZC5sZW5ndGggPT09IDAgJiYgaXNDb3VudChzdW1tYXJ5LmZhaWxlZCkgJiYgc3VtbWFyeS5mYWlsZWQgPiAwKSB7XG4gICAgcHJvYmxlbXMucHVzaChcbiAgICAgIGBzdW1tYXJ5IHJlcG9ydHMgJHtzdW1tYXJ5LmZhaWxlZH0gZmFpbGVkIGNoZWNrKHMpIGJ1dCBub25lIGFyZSBsaXN0ZWRgLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBwYXJzZUVycm9ycyA9IGxpc3RPZihyZXN1bHRzLnBhcnNpbmdfZXJyb3JzKTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIHBhcnNlRXJyb3JzKSB7XG4gICAgY29uc3QgbmFtZSA9IHR5cGVvZiBmaWxlID09PSBcInN0cmluZ1wiID8gZmlsZSA6IFwiPHVubmFtZWQgZmlsZT5cIjtcbiAgICBwcm9ibGVtcy5wdXNoKFxuICAgICAgYCR7bmFtZX0gY291bGQgbm90IGJlIHBhcnNlZCBieSBDaGVja292IChhIHBhcnNlIGVycm9yIGlzIG5vdCBhIHBhc3MpYCxcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBwYXJzZUVycm9ycy5sZW5ndGggPT09IDAgJiYgaXNDb3VudChzdW1tYXJ5LnBhcnNpbmdfZXJyb3JzKSAmJlxuICAgIHN1bW1hcnkucGFyc2luZ19lcnJvcnMgPiAwICYmIGZhbHNlXG4gICkge1xuICAgIHByb2JsZW1zLnB1c2goXG4gICAgICBgc3VtbWFyeSByZXBvcnRzICR7c3VtbWFyeS5wYXJzaW5nX2Vycm9yc30gcGFyc2luZyBlcnJvcihzKSBidXQgbmFtZXMgbm8gZmlsZWAsXG4gICAgKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgZW50cnkgb2YgbGlzdE9mKHJlc3VsdHMuc2tpcHBlZF9jaGVja3MpKSB7XG4gICAgYXdhaXQganVkZ2VTa2lwKGVudHJ5LCB0ZW1wbGF0ZXMsIHByb2JsZW1zKTtcbiAgfVxuXG4gIHRvdGFscy5mdWxsUmVwb3J0cysrO1xuICBpZiAoaXNDb3VudChzdW1tYXJ5LnBhc3NlZCkpIHRvdGFscy5wYXNzZWQgKz0gc3VtbWFyeS5wYXNzZWQ7XG4gIGlmIChpc0NvdW50KHN1bW1hcnkuc2tpcHBlZCkpIHRvdGFscy5za2lwcGVkICs9IHN1bW1hcnkuc2tpcHBlZDtcbn1cblxudHlwZSBQYXJzZWRPdXRwdXQgPVxuICB8IHsgb2s6IHRydWU7IHJlcG9ydHM6IE9ialtdIH1cbiAgfCB7IG9rOiBmYWxzZTsgcHJvYmxlbTogc3RyaW5nIH07XG5cbi8qKiBQYXJzZSBzdGRvdXQgYXMgb25lIHJlcG9ydCBvciBhIG5vbi1lbXB0eSBsaXN0IG9mIHJlcG9ydHMuICovXG5mdW5jdGlvbiBwYXJzZVJlcG9ydHMoc3Rkb3V0OiBzdHJpbmcpOiBQYXJzZWRPdXRwdXQge1xuICBjb25zdCBpbnZhbGlkID0gKHJlYXNvbjogc3RyaW5nKTogUGFyc2VkT3V0cHV0ID0+ICh7XG4gICAgb2s6IGZhbHNlLFxuICAgIHByb2JsZW06IGBvdXRwdXQgaXMgbm90IHZhbGlkIENoZWNrb3YgSlNPTiAoJHtyZWFzb259KWAsXG4gIH0pO1xuICBpZiAoc3Rkb3V0LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIGludmFsaWQoXCJzdGRvdXQgaXMgZW1wdHlcIik7XG5cbiAgbGV0IHZhbHVlOiB1bmtub3duO1xuICB0cnkge1xuICAgIHZhbHVlID0gSlNPTi5wYXJzZShzdGRvdXQpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBpbnZhbGlkKGBwYXJzZSBlcnJvcjogJHttZXNzYWdlT2YoZXJyb3IpfWApO1xuICB9XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSAmJiB2YWx1ZS5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gaW52YWxpZChcImVtcHR5IGxpc3RcIik7XG4gIH1cblxuICBjb25zdCBpdGVtczogdW5rbm93bltdID0gQXJyYXkuaXNBcnJheSh2YWx1ZSkgPyB2YWx1ZSA6IFt2YWx1ZV07XG4gIGNvbnN0IHJlcG9ydHM6IE9ialtdID0gW107XG4gIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgIGlmICghaXNPYmplY3QoaXRlbSkgfHwgIShpc1N1bW1hcnlPbmx5KGl0ZW0pIHx8IGlzRnVsbFJlcG9ydChpdGVtKSkpIHtcbiAgICAgIHJldHVybiBpbnZhbGlkKFwibm90IGEgQ2hlY2tvdiByZXBvcnRcIik7XG4gICAgfVxuICAgIHJlcG9ydHMucHVzaChpdGVtKTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgcmVwb3J0cyB9O1xufVxuXG5mdW5jdGlvbiB2ZXJkaWN0Rm9yKHByb2JsZW1zOiBzdHJpbmdbXSwgdG90YWxzOiBUb3RhbHMpOiBDaGVja292VmVyZGljdCB7XG4gIGlmIChwcm9ibGVtcy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1czogXCJGQUlMRURcIixcbiAgICAgIHJlcG9ydDogWy4uLnByb2JsZW1zLm1hcCgocCkgPT4gYC0gJHtwfWApLCBcIlN0YXR1czogRkFJTEVEXCJdLmpvaW4oXCJcXG5cIiksXG4gICAgfTtcbiAgfVxuICBjb25zdCBzdW1tYXJ5ID0gdG90YWxzLmZ1bGxSZXBvcnRzID09PSAwXG4gICAgPyBcIk5vIENsb3VkRm9ybWF0aW9uIHRlbXBsYXRlcyBmb3VuZDsgbm90aGluZyB0byBjaGVjay5cIlxuICAgIDogYENoZWNrb3YgcGFzc2VkOiAke3RvdGFscy5wYXNzZWR9IHBhc3NlZCwgJHt0b3RhbHMuc2tpcHBlZH0gc2tpcHBlZCB3aXRoIGEgcmVhc29uLmA7XG4gIHJldHVybiB7IHN0YXR1czogXCJQQVNTRURcIiwgcmVwb3J0OiBgJHtzdW1tYXJ5fVxcblN0YXR1czogUEFTU0VEYCB9O1xufVxuXG4vKipcbiAqIERlY2lkZSBQQVNTRUQgb3IgRkFJTEVEIGZvciBvbmUgQ2hlY2tvdiBydW4uIENvbGxlY3RzIGV2ZXJ5IHByb2JsZW0gcmF0aGVyXG4gKiB0aGFuIHN0b3BwaW5nIGF0IHRoZSBmaXJzdCwgYW5kIG5ldmVyIHRocm93cyBvbiBhbiBvZGQgc2hhcGU6IG1hbGZvcm1lZFxuICogZGF0YSBiZWNvbWVzIGEgcHJvYmxlbS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGp1ZGdlQ2hlY2tvdlJ1bihpbnB1dDoge1xuICBleGl0Q29kZTogbnVtYmVyO1xuICBzdGRvdXQ6IHN0cmluZztcbiAgdGVtcGxhdGVzOiBDaGVja292VGVtcGxhdGVSZWFkZXI7XG59KTogUHJvbWlzZTxDaGVja292VmVyZGljdD4ge1xuICBjb25zdCBwcm9ibGVtczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKCFBQ0NFUFRFRF9FWElUX0NPREVTLmluY2x1ZGVzKGlucHV0LmV4aXRDb2RlKSkge1xuICAgIHByb2JsZW1zLnB1c2goXG4gICAgICBgQ2hlY2tvdiBleGl0ZWQgd2l0aCBjb2RlICR7aW5wdXQuZXhpdENvZGV9OyBvbmx5IDAgYW5kIDEgYXJlIGFjY2VwdGVkYCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VSZXBvcnRzKGlucHV0LnN0ZG91dCk7XG4gIGlmICghcGFyc2VkLm9rKSB7XG4gICAgcHJvYmxlbXMucHVzaChwYXJzZWQucHJvYmxlbSk7XG4gICAgcmV0dXJuIHZlcmRpY3RGb3IocHJvYmxlbXMsIHsgcGFzc2VkOiAwLCBza2lwcGVkOiAwLCBmdWxsUmVwb3J0czogMCB9KTtcbiAgfVxuXG4gIGNvbnN0IHRvdGFsczogVG90YWxzID0geyBwYXNzZWQ6IDAsIHNraXBwZWQ6IDAsIGZ1bGxSZXBvcnRzOiAwIH07XG4gIGZvciAoY29uc3QgcmVwb3J0IG9mIHBhcnNlZC5yZXBvcnRzKSB7XG4gICAgaWYgKGlzU3VtbWFyeU9ubHkocmVwb3J0KSkge1xuICAgICAganVkZ2VTdW1tYXJ5T25seShyZXBvcnQsIHByb2JsZW1zKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYXdhaXQganVkZ2VGdWxsUmVwb3J0KHJlcG9ydCwgaW5wdXQudGVtcGxhdGVzLCBwcm9ibGVtcywgdG90YWxzKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHZlcmRpY3RGb3IocHJvYmxlbXMsIHRvdGFscyk7XG59XG5cbi8qKiBSZWFkIGEgdGVtcGxhdGUgcmVsYXRpdmUgdG8gdGhlIGN1cnJlbnQgZGlyZWN0b3J5ICh0aGUgc2Nhbm5lZCByZXBvIHJvb3QpLiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZFRlbXBsYXRlRnJvbUN3ZChwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUocGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogQ0xJIGVudHJ5IHBvaW50LiBSZXR1cm5zIDAgZm9yIFBBU1NFRCwgMSBmb3IgRkFJTEVEIG9yIGFuIHVucmVhZGFibGVcbiAqIHJlcG9ydCwgYW5kIDIgZm9yIGJhZCB1c2FnZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJnczogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbcmVwb3J0UGF0aCwgZXhpdFRleHRdID0gYXJncztcbiAgaWYgKFxuICAgIGFyZ3MubGVuZ3RoICE9PSAyIHx8IHJlcG9ydFBhdGggPT09IHVuZGVmaW5lZCB8fCBleGl0VGV4dCA9PT0gdW5kZWZpbmVkIHx8XG4gICAgIS9eXFxkKyQvLnRlc3QoZXhpdFRleHQpXG4gICkge1xuICAgIGNvbnNvbGUuZXJyb3IoVVNBR0UpO1xuICAgIHJldHVybiAyO1xuICB9XG5cbiAgbGV0IHN0ZG91dDogc3RyaW5nO1xuICB0cnkge1xuICAgIHN0ZG91dCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHJlcG9ydFBhdGgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICBgY2hlY2tvdl9yZXBvcnQ6IGNhbm5vdCByZWFkIHJlcG9ydCAke3JlcG9ydFBhdGh9OiAke21lc3NhZ2VPZihlcnJvcil9YCxcbiAgICApO1xuICAgIHJldHVybiAxO1xuICB9XG5cbiAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IE51bWJlcihleGl0VGV4dCksXG4gICAgc3Rkb3V0LFxuICAgIHRlbXBsYXRlczogcmVhZFRlbXBsYXRlRnJvbUN3ZCxcbiAgfSk7XG4gIGNvbnNvbGUubG9nKHZlcmRpY3QucmVwb3J0KTtcbiAgcmV0dXJuIHZlcmRpY3Quc3RhdHVzID09PSBcIlBBU1NFRFwiID8gMCA6IDE7XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIElzc3VlICMxMjgwIChTRUMtMTIxNy0xMik6IHRoZSByZXBvcnQgaXMgcHJpbnRlZCB0byBzdGRvdXQ7IHJlZGFjdCBhbnkgY3JlZGVudGlhbCBhIHRlbXBsYXRlIG9yIGZpbmRpbmcgcXVvdGVzLlxuICBpbnN0YWxsQ29uc29sZVJlZGFjdGlvbigpO1xuICBEZW5vLmV4aXQoYXdhaXQgbWFpbihEZW5vLmFyZ3MpKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTRCQyxHQUVELFNBQVMsdUJBQXVCLFFBQVEseUJBQXlCO0FBRWpFLGtFQUFrRSxHQUNsRSxPQUFPLE1BQU0sb0JBQXVDO0VBQ2xEO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0QsQ0FBVTtBQW1CWCw4RUFBOEUsR0FDOUUsTUFBTSx3QkFBd0I7QUFFOUIsNERBQTRELEdBQzVELE1BQU0sc0JBQXlDO0VBQUM7RUFBRztDQUFFO0FBRXJELCtFQUErRSxHQUMvRSxNQUFNLHNCQUFzQjtFQUMxQjtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRCwwQ0FBMEMsR0FDMUMsTUFBTSxlQUFlO0VBQ25CO0VBQ0E7RUFDQTtDQUNEO0FBRUQsNENBQTRDLEdBQzVDLE1BQU0saUJBQWlCO0VBQ3JCO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFF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
// denoCacheMetadata=3776018605073153450,15256583340206445269