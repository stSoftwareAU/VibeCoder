/**
 * token-economizer-report command (Issue #4958).
 *
 *   deno run mod.ts token-economizer-report --archive <dir> \
 *     --trial-host <name> --window-start <iso> [--window-end <iso>] \
 *     --recorded-since <iso> [--mode work-on] [--format markdown|json] \
 *     [--stop-rule <rule>]
 *
 * Reads every `*.json` run record under `--archive` (recursive, bounded,
 * symlinks skipped) and prints the weekly TokenEconomizer comparison section.
 * It is read-only: the only outside call is `gh pr view`, once per pull
 * request. It prints the comparison section and then the keep-or-purge
 * verdict (Issue #4959).
 *
 * Missing data fails loud: an unreadable archive, an archive with no records
 * or a missing option is a failure, never an empty report.
 *
 * Uses Australian English spelling throughout.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { spawnGh } from "../lib/gh_spawn.ts";
import {
  buildTokenEconomizerTrialReport,
  formatTokenEconomizerTrialSection,
  parseIsoInstant,
  type PrState,
  type PrStateLookup,
  type TokenEconomizerTrialReport,
} from "../lib/token_economizer_trial_report.ts";
import {
  decideTokenEconomizerVerdict,
  formatTokenEconomizerVerdict,
  isTokenEconomizerStopRule,
  TOKEN_ECONOMIZER_STOP_RULES,
  type TokenEconomizerVerdict,
} from "../lib/token_economizer_verdict.ts";
import type { TokenEconomizerStopRule } from "../lib/token_economizer_plugin.ts";

/** Most files the command reads from one archive. */
const MAX_FILES = 100_000;
/** Deepest directory level read. */
const MAX_DEPTH = 8;
/** Largest single record file read, in bytes. */
const MAX_FILE_BYTES = 1_000_000;

/** What the command returns alongside its message. */
export interface TokenEconomizerReportData {
  report: TokenEconomizerTrialReport;
  verdict: TokenEconomizerVerdict;
}

/** Injectable dependencies. */
export interface TokenEconomizerReportDeps {
  lookup?: PrStateLookup;
  now?: () => Date;
}

/** Read pull request state through `gh pr view`; undefined when unknown. */
export const ghPrStateLookup: PrStateLookup = async (repository, prNumber) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) return undefined;
  try {
    const result = await spawnGh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repository,
      "--json",
      "state",
    ]);
    if (!result.success) return undefined;
    const state = (JSON.parse(result.stdout) as { state?: unknown }).state;
    const map: Record<string, PrState> = {
      MERGED: "merged",
      CLOSED: "closed",
      OPEN: "open",
    };
    return typeof state === "string" ? map[state] : undefined;
  } catch {
    return undefined;
  }
};

/** Collect `*.json` paths, skipping symlinks. Throws on the bounds. */
async function collectFiles(
  dir: string,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > MAX_DEPTH) {
    throw new Error(`archive nests deeper than ${MAX_DEPTH} levels`);
  }
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isSymlink) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectFiles(path, depth + 1, out);
    } else if (entry.isFile && entry.name.endsWith(".json")) {
      out.push(path);
      if (out.length > MAX_FILES) {
        throw new Error(`archive holds more than ${MAX_FILES} record files`);
      }
    }
  }
}

/** Read the files. An unreadable or invalid file becomes a malformed record. */
async function readRecords(paths: readonly string[]): Promise<unknown[]> {
  const records: unknown[] = [];
  for (const path of [...paths].sort()) {
    try {
      const info = await Deno.stat(path);
      if (info.size > MAX_FILE_BYTES) {
        records.push(null);
        continue;
      }
      const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
      if (Array.isArray(parsed)) records.push(...parsed);
      else records.push(parsed);
    } catch {
      records.push(null);
    }
  }
  return records;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/** Build the command with injectable dependencies. */
export function createTokenEconomizerReportCommand(
  deps: TokenEconomizerReportDeps = {},
): Command {
  return {
    name: "token-economizer-report",
    description:
      "Report the TokenEconomizer trial comparison and keep-or-purge verdict from archived runs (Issues #4958, #4959)",

    async execute(
      args: Record<string, unknown>,
      _config: WorkerConfig,
    ): Promise<CommandResult<TokenEconomizerReportData>> {
      const fail = (message: string) => ({ success: false, message });
      const archive = text(args["archive"]);
      if (archive === undefined) return fail("Argument --archive is required.");
      const trialHost = text(args["trial-host"]);
      if (trialHost === undefined) {
        return fail("Argument --trial-host is required.");
      }
      const dates: Record<string, string> = {};
      for (
        const [name, required] of [
          ["window-start", true],
          ["window-end", false],
          ["recorded-since", true],
        ] as const
      ) {
        const value = text(args[name]);
        if (value === undefined) {
          if (required) return fail(`Argument --${name} is required.`);
          continue;
        }
        if (parseIsoInstant(value) === undefined) {
          return fail(`Argument --${name} must be an ISO 8601 date or time.`);
        }
        dates[name] = value;
      }
      const format = args["format"] ?? "markdown";
      if (format !== "markdown" && format !== "json") {
        return fail("Argument --format must be markdown or json.");
      }
      const modeArg = args["mode"];
      if (modeArg !== undefined && text(modeArg) === undefined) {
        return fail("Argument --mode must be a non-empty label.");
      }
      const stopArg = args["stop-rule"];
      let stopRule: TokenEconomizerStopRule | undefined;
      if (stopArg !== undefined) {
        if (!isTokenEconomizerStopRule(stopArg)) {
          return fail(
            `Argument --stop-rule must be one of ${
              TOKEN_ECONOMIZER_STOP_RULES.join(", ")
            }.`,
          );
        }
        stopRule = stopArg;
      }

      try {
        const paths: string[] = [];
        try {
          await collectFiles(archive, 0, paths);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return fail(`Archive ${archive} could not be read: ${detail}`);
        }
        if (paths.length === 0) {
          return fail(`Archive ${archive} holds no *.json run records.`);
        }
        const records = await readRecords(paths);
        const report = await buildTokenEconomizerTrialReport(
          records,
          {
            trialHost,
            windowStart: dates["window-start"] ?? "",
            windowEnd: dates["window-end"],
            recordedSince: dates["recorded-since"] ?? "",
            mode: text(modeArg),
            now: deps.now,
          },
          deps.lookup ?? ghPrStateLookup,
        );
        const verdict = decideTokenEconomizerVerdict(report, {
          now: (deps.now ?? (() => new Date()))(),
          stopRule,
        });
        return {
          success: true,
          message: format === "json"
            ? JSON.stringify({ ...report, verdict }, null, 2)
            : formatTokenEconomizerTrialSection(report) + "\n\n" +
              formatTokenEconomizerVerdict(verdict),
          data: { report, verdict },
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          message: `token-economizer-report failed: ${detail}`,
        };
      }
    },
  };
}

export const tokenEconomizerReportCommand: Command =
  createTokenEconomizerReportCommand();
