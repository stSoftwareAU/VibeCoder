/**
 * CLI entry point for the bulk security/supply-chain triage sweep
 * (Issue #2403).
 *
 * Walks the supplied list of monitored repos, finds open issues carrying
 * any of the configured findings labels (`security`,
 * `supply-chain-readiness`, `supply-chain:quarantine-missing`,
 * `supply-chain:quarantine-misconfigured` by default), applies severity
 * and minimum-age filters, and — unless `--dry-run` is passed — applies
 * the pickup label (`work-on` by default) in bulk.
 *
 * The command is meant to be run by a **human operator** with their own
 * `gh` credentials. The worker is not authorised to apply `work-on` —
 * `label_security.ts` strips a worker-applied pickup label on the next
 * scan. Running this command from a trusted-author session keeps the
 * label policy intact while clearing the triage backlog in one pass.
 *
 * Example:
 *
 *   deno run --allow-env --allow-run --allow-read mod.ts \
 *     bulk-triage-security \
 *     --monitored-repos owner/a,owner/b \
 *     --severities severity:high,severity:medium \
 *     --min-age-days 1 \
 *     --max 20 \
 *     --dry-run
 *
 * Structured progress lines (parseable by operator log scrapers):
 *
 *   [bulk-triage] repo=<r> issue=<n> action=labelled label=work-on matched=security severity=severity:high
 *   [bulk-triage] repo=<r> issue=<n> action=would_label label=work-on matched=security severity=severity:high
 *   [bulk-triage] repo=<r> issue=<n> action=skipped reason=already_labelled label=work-on
 *   [bulk-triage] repo=<r> issue=<n> action=skipped reason=severity allowed=severity:high
 *   [bulk-triage] repo=<r> issue=<n> action=skipped reason=age age_days=0 min_age_days=1
 *   [bulk-triage] repo=<r> issue=<n> action=skipped reason=cap max=20
 *   [bulk-triage] repo=<r> action=error reason=<msg>
 *   [bulk-triage] action=summary mode=applied labelled=N would_label=N already=N skipped_severity=N skipped_age=N skipped_cap=N errors=N
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type BulkTriageSummary,
  DEFAULT_APPLY_LABEL,
  DEFAULT_FINDINGS_LABELS,
  formatBulkTriageEvent,
  formatBulkTriageSummary,
  runBulkTriage,
  SEVERITY_LABELS,
} from "../lib/bulk_triage.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: (args: string[]) => Promise<string>;
  addLabelFn?: Parameters<typeof runBulkTriage>[0]["addLabelFn"];
  now?: () => Date;
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntArg(
  value: unknown,
  fallback: number,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: fallback };
  }
  // parseArgs() in mod.ts may have already JSON-parsed the value into a number.
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value: Math.floor(value) };
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return { ok: true, value: n };
  }
  return {
    ok: false,
    error: `Invalid integer for --${label}: ${String(value)}`,
  };
}

function isBooleanFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/**
 * Validate severity selectors. Each entry must be one of
 * `severity:high|medium|low`.
 */
function validateSeverities(
  raw: string[],
): { ok: true; value: string[] } | { ok: false; error: string } {
  const allowed = new Set(SEVERITY_LABELS);
  const invalid = raw.filter((s) => !allowed.has(s));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid severity selector(s): ${invalid.join(", ")}. ` +
        `Allowed: ${SEVERITY_LABELS.join(", ")}`,
    };
  }
  return { ok: true, value: raw };
}

export const bulkTriageSecurityCommand: Command = {
  name: "bulk-triage-security",
  description: "Apply a pickup label in bulk to open security / supply-chain " +
    "finding issues across monitored repos (Issue #2403). " +
    "Supports severity + minimum-age filters and --dry-run.",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<BulkTriageSummary>> {
    const repos = splitCsv(args["monitored-repos"]);
    const deps: TestDeps = (args["__testDeps"] as TestDeps | undefined) ?? {};
    const log = deps.log ?? ((line: string) => console.log(line));

    if (repos.length === 0) {
      return {
        success: false,
        message: "Missing required argument: --monitored-repos",
      };
    }

    const applyLabel = typeof args["apply-label"] === "string" &&
        args["apply-label"].length > 0
      ? (args["apply-label"] as string)
      : DEFAULT_APPLY_LABEL;

    const findingsLabelsArg = splitCsv(args["findings-labels"]);
    const findingsLabels = findingsLabelsArg.length > 0
      ? findingsLabelsArg
      : DEFAULT_FINDINGS_LABELS;

    const severitiesArg = splitCsv(args["severities"]);
    const severitiesResult = validateSeverities(severitiesArg);
    if (!severitiesResult.ok) {
      return { success: false, message: severitiesResult.error };
    }

    const minAgeResult = parseIntArg(
      args["min-age-days"],
      0,
      "min-age-days",
    );
    if (!minAgeResult.ok) {
      return { success: false, message: minAgeResult.error };
    }
    if (minAgeResult.value < 0) {
      return {
        success: false,
        message:
          `Invalid --min-age-days: must be >= 0 (got ${minAgeResult.value})`,
      };
    }

    const maxResult = parseIntArg(args["max"], 50, "max");
    if (!maxResult.ok) {
      return { success: false, message: maxResult.error };
    }
    if (maxResult.value <= 0) {
      return {
        success: false,
        message: `Invalid --max: must be > 0 (got ${maxResult.value})`,
      };
    }

    const dryRun = isBooleanFlag(args["dry-run"]);

    const summary = await runBulkTriage({
      repos,
      applyLabel,
      findingsLabels,
      severities: severitiesResult.value,
      minAgeDays: minAgeResult.value,
      max: maxResult.value,
      dryRun,
      ghCommandFn: deps.ghCommandFn,
      addLabelFn: deps.addLabelFn,
      now: deps.now,
      log: (event) => log(formatBulkTriageEvent(event)),
    });

    log(formatBulkTriageSummary(summary));

    const mode = dryRun ? "dry-run" : "applied";
    return {
      success: true,
      message: `Bulk triage ${mode}: ${summary.labelled} labelled, ` +
        `${summary.wouldLabel} would-label, ` +
        `${summary.alreadyLabelled} already, ` +
        `${
          summary.skippedSeverity + summary.skippedAge + summary.skippedCap
        } skipped, ` +
        `${summary.errors} errors`,
      data: summary,
    };
  },
};
