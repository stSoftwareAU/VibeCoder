/**
 * fleet-experiment-report command (Issue #3645).
 *
 * Reads every host's lifecycle ledger from the work volume (or the ledgers
 * named by `--ledger`), builds the randomised fleet experiment report, and
 * prints it as text, JSON or CSV:
 *
 *   deno run mod.ts fleet-experiment-report
 *   deno run mod.ts fleet-experiment-report --window 7 --format csv
 *   deno run mod.ts fleet-experiment-report --ledger a.jsonl,b.jsonl
 *   deno run mod.ts fleet-experiment-report --covariates covariates.json
 *   deno run mod.ts fleet-experiment-report --synthetic 42
 *
 * The command is read-only. It never posts to GitHub, writes nothing and
 * changes no allocation. `--synthetic <seed>` ignores the ledgers and
 * generates a reproducible history against a fixed clock, so its output is
 * byte-identical across runs. It demonstrates the report; it is not evidence.
 *
 * Missing data fails loud: a ledger that cannot be read, a named ledger that
 * does not exist, or a work volume with no ledgers is an error, never an
 * empty report.
 *
 * Uses Australian English spelling throughout.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  CONTROL_ARM_ID,
  DEFAULT_EXPERIMENT_ARMS,
  type ExperimentArm,
} from "../lib/fleet_experiment_arms.ts";
import {
  buildExperimentReport,
  experimentRecordsCsv,
  type ExperimentReport,
  formatExperimentReport,
} from "../lib/fleet_experiment_report.ts";
import {
  generateSyntheticHistory,
  type SyntheticArmSpec,
} from "../lib/fleet_experiment_synthetic.ts";
import {
  isPlainObject,
  type LifecycleEvent,
  LifecycleLedgerReadError,
  readLifecycleLedger,
} from "../lib/lifecycle_ledger.ts";

/** Default observation window, in days. */
const DEFAULT_WINDOW_DAYS = 30;

/** Default follow-up horizon, in days. */
const DEFAULT_HORIZON_DAYS = 14;

/** Largest window or horizon the report accepts, in days. */
const MAX_DAYS = 365;

/** The output formats the command prints. */
const FORMATS = ["text", "json", "csv"] as const;

/** Matches the ledger files the command discovers on the work volume. */
const LEDGER_FILE_PATTERN = /^lifecycle_ledger_.+\.jsonl$/;

/** The synthetic history's fixed clock, so its output never varies. */
const SYNTHETIC_NOW = "2026-01-31T00:00:00Z";

/** The synthetic history's arm id for the candidate arm. */
const SYNTHETIC_CANDIDATE_ARM_ID = "synthetic-candidate";

/** Covariates keyed by `${repo}#${issueNumber}`, then by name. */
type Covariates = Record<string, Record<string, string>>;

/** The outcome of validating one argument. */
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** The data the command returns alongside its rendered message. */
export interface FleetExperimentReportData {
  report: ExperimentReport;
}

/** Build a refusal that names the argument at fault. */
function refuse(name: string, rule: string): Parsed<never> {
  return { ok: false, message: `Argument ${name} ${rule}.` };
}

/** Parse `--window` or `--horizon`: a number of days in (0, 365]. */
function parseDays(
  name: string,
  raw: unknown,
  fallback: number,
): Parsed<number> {
  if (raw === undefined) return { ok: true, value: fallback };
  // Text is read only in plain decimal form, so "0x5" is refused although
  // Number() would read it as 5. Anything else stays NaN and is refused below.
  let value = Number.NaN;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim())) {
    value = Number(raw.trim());
  }
  if (!Number.isFinite(value) || value <= 0 || value > MAX_DAYS) {
    return refuse(
      name,
      `must be a number of days above 0 and at most ${MAX_DAYS}`,
    );
  }
  return { ok: true, value };
}

/** Parse `--format`: one of text, json or csv. */
function parseFormat(raw: unknown): Parsed<(typeof FORMATS)[number]> {
  if (raw === undefined) return { ok: true, value: "text" };
  const match = FORMATS.find((format) => format === raw);
  if (match === undefined) {
    return refuse("format", "must be one of text, json or csv");
  }
  return { ok: true, value: match };
}

/** Parse `--synthetic`: a non-negative integer seed, if given. */
function parseSynthetic(raw: unknown): Parsed<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  // Text is read only as plain digits, so "1e3" and "0x10" are refused although
  // Number() would read them as integers. Anything else stays NaN.
  let seed = Number.NaN;
  if (typeof raw === "number") {
    seed = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw)) {
    seed = Number(raw);
  }
  if (!Number.isSafeInteger(seed) || seed < 0) {
    return refuse("synthetic", "must be a non-negative integer seed");
  }
  return { ok: true, value: seed };
}

/** Parse `--ledger`: a comma-separated list of non-empty paths, if given. */
function parseLedgerList(raw: unknown): Parsed<string[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return refuse("ledger", "must be a comma-separated list of paths");
  }
  const paths = raw.split(",").map((path) => path.trim());
  if (paths.some((path) => path === "")) {
    return refuse(
      "ledger",
      "must be a comma-separated list of non-empty paths",
    );
  }
  return { ok: true, value: paths };
}

/**
 * Read and validate `--covariates`: a JSON object of plain objects of string
 * values. The file's content is never echoed into the refusal.
 */
async function readCovariates(
  raw: unknown,
): Promise<Parsed<Covariates | undefined>> {
  if (raw === undefined) return { ok: true, value: undefined };
  const shapeRule =
    "must name a JSON file holding an object of objects of string values";
  if (typeof raw !== "string" || raw.trim() === "") {
    return refuse("covariates", shapeRule);
  }

  let text: string;
  try {
    text = await Deno.readTextFile(raw);
  } catch {
    return refuse("covariates", `could not be read from ${raw}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("covariates", "is not valid JSON");
  }

  const isStringRow = (row: unknown): boolean =>
    isPlainObject(row) &&
    Object.values(row).every((value) => typeof value === "string");
  if (!isPlainObject(parsed) || !Object.values(parsed).every(isStringRow)) {
    return refuse("covariates", shapeRule);
  }
  return { ok: true, value: parsed as Covariates };
}

/**
 * Resolve the ledgers to read. Named paths must exist, since a missing file
 * would otherwise read as an empty report. With no `--ledger`, every ledger on
 * the work volume is read, sorted, and an empty volume is an error.
 */
async function resolveLedgerPaths(
  named: readonly string[] | undefined,
  workDir: string,
): Promise<Parsed<string[]>> {
  if (named !== undefined) {
    for (const path of named) {
      try {
        await Deno.stat(path);
      } catch (error) {
        const message = error instanceof Deno.errors.NotFound
          ? `Lifecycle ledger ${path} does not exist.`
          : `Lifecycle ledger ${path} could not be inspected.`;
        return { ok: false, message };
      }
    }
    return { ok: true, value: [...named] };
  }

  if (workDir === "") {
    return {
      ok: false,
      message: "No work directory is configured; pass --ledger.",
    };
  }

  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(workDir)) {
      if (LEDGER_FILE_PATTERN.test(entry.name)) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: false,
        message: `no lifecycle ledgers found in ${workDir}`,
      };
    }
    return {
      ok: false,
      message:
        `Could not list the work directory ${workDir} for lifecycle ledgers.`,
    };
  }

  if (names.length === 0) {
    return {
      ok: false,
      message: `no lifecycle ledgers found in ${workDir}`,
    };
  }
  return { ok: true, value: names.sort().map((name) => `${workDir}/${name}`) };
}

/**
 * Read every resolved ledger. A fault in any one of them fails the whole
 * report, naming that ledger, so a damaged file is never read as a short one.
 *
 * The reader dedupes within one file only. Follow-on and PR outcome keys carry
 * no host, so two hosts can write the same event; the first event per
 * `eventKey` is kept across every file, so its cost is counted once.
 */
async function readAllLedgers(
  paths: readonly string[],
): Promise<Parsed<LifecycleEvent[]>> {
  const events: LifecycleEvent[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    try {
      for (const event of await readLifecycleLedger(path)) {
        if (seen.has(event.eventKey)) continue;
        seen.add(event.eventKey);
        events.push(event);
      }
    } catch (error) {
      if (error instanceof LifecycleLedgerReadError) {
        return { ok: false, message: error.message };
      }
      return { ok: false, message: `Could not read lifecycle ledger ${path}.` };
    }
  }
  return { ok: true, value: events };
}

/**
 * The two arms the synthetic history compares: the control default and a
 * candidate with higher per-invocation prices, both with the same merge
 * probability, so the demonstration shows cost rather than outcome.
 */
function syntheticArms(
  control: ExperimentArm,
): SyntheticArmSpec[] {
  const candidate: ExperimentArm = {
    ...control,
    id: SYNTHETIC_CANDIDATE_ARM_ID,
    label: "Synthetic candidate (higher per-invocation prices)",
    control: false,
  };
  return [
    {
      arm: control,
      mergeProbability: 0.6,
      managerCostUsd: 0.4,
      executorCostUsd: 0.2,
    },
    {
      arm: candidate,
      mergeProbability: 0.6,
      managerCostUsd: 1.2,
      executorCostUsd: 0.6,
    },
  ];
}

/** Render a report in the requested format. */
function renderReport(
  report: ExperimentReport,
  format: (typeof FORMATS)[number],
): string {
  switch (format) {
    case "json":
      return JSON.stringify(report, null, 2);
    case "csv":
      return experimentRecordsCsv(report.records);
    case "text":
      return formatExperimentReport(report);
  }
}

export const fleetExperimentReportCommand: Command = {
  name: "fleet-experiment-report",
  description:
    "Report randomised fleet experiment arms: merged issues per estimated dollar (Issue #3645)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<FleetExperimentReportData>> {
    const policy = config.subscriptionAllocation;
    const windowArg = parseDays(
      "window",
      args["window"],
      policy?.windowDays ?? DEFAULT_WINDOW_DAYS,
    );
    if (!windowArg.ok) return { success: false, message: windowArg.message };
    const horizonArg = parseDays(
      "horizon",
      args["horizon"],
      policy?.horizonDays ?? DEFAULT_HORIZON_DAYS,
    );
    if (!horizonArg.ok) return { success: false, message: horizonArg.message };
    const formatArg = parseFormat(args["format"]);
    if (!formatArg.ok) return { success: false, message: formatArg.message };
    const syntheticArg = parseSynthetic(args["synthetic"]);
    if (!syntheticArg.ok) {
      return { success: false, message: syntheticArg.message };
    }
    const ledgerArg = parseLedgerList(args["ledger"]);
    if (!ledgerArg.ok) return { success: false, message: ledgerArg.message };
    const covariatesArg = await readCovariates(args["covariates"]);
    if (!covariatesArg.ok) {
      return { success: false, message: covariatesArg.message };
    }

    const windowDays = windowArg.value;
    const horizonDays = horizonArg.value;
    const format = formatArg.value;
    const seed = syntheticArg.value;
    const fileCovariates = covariatesArg.value;

    try {
      if (seed !== undefined) {
        const control = DEFAULT_EXPERIMENT_ARMS.find((arm) =>
          arm.id === CONTROL_ARM_ID
        );
        if (control === undefined) {
          return {
            success: false,
            message:
              `Control arm ${CONTROL_ARM_ID} is not in the default experiment arms.`,
          };
        }
        const arms = syntheticArms(control);
        const now = new Date(SYNTHETIC_NOW);
        const history = await generateSyntheticHistory({
          seed,
          experimentSeed: `issue-3645-synthetic-${seed}`,
          issues: 400,
          now,
          days: 30,
          arms,
          repos: ["org/a", "org/b"],
          hosts: ["host-1", "host-2"],
          pendingShare: 0.1,
        });
        const covariates = fileCovariates === undefined
          ? history.covariates
          : { ...history.covariates, ...fileCovariates };
        const report = buildExperimentReport(history.events, {
          now,
          windowDays,
          horizonDays,
          arms: arms.map((spec) => spec.arm),
          covariates,
        });
        return {
          success: true,
          message: renderReport(report, format),
          data: { report },
        };
      }

      const paths = await resolveLedgerPaths(
        ledgerArg.value ?? policy?.ledgerPaths,
        config.workDir,
      );
      if (!paths.ok) return { success: false, message: paths.message };
      const events = await readAllLedgers(paths.value);
      if (!events.ok) return { success: false, message: events.message };

      const report = buildExperimentReport(events.value, {
        now: new Date(),
        windowDays,
        horizonDays,
        covariates: fileCovariates,
        arms: policy?.arms,
      });
      return {
        success: true,
        message: renderReport(report, format),
        data: { report },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `fleet-experiment-report failed: ${detail}`,
      };
    }
  },
};
