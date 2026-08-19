/**
 * `green-gate-report` — the Phase 0 evidence report (Issue #4189).
 *
 * Reads this host's local run logs (`~/logs`) plus the per-launch run-mode
 * records, checks the named regression issues on GitHub, and writes
 * `docs/evidence/green-gate-<date>.md`: per-host counts and a verdict that
 * is GREEN only when host-mode launches are zero, every launch is verified
 * as container mode, the observed window is at least the minimum, and no
 * regression issue is open. Re-running rewrites the file for the requested
 * window (idempotent). All the analysis lives in `lib/green_gate_report.ts`;
 * this file is the sources and the arguments.
 *
 * Arguments:
 *   --window-days N        how far back to look (default 30)
 *   --min-window-days N    shortest window that may be GREEN (default 14)
 *   --log-dir PATH         where the logs are (default $HOME/logs)
 *   --out PATH             report path (default docs/evidence/green-gate-<date>.md)
 *   --repo OWNER/NAME      repo the regression issues live in (default stSoftwareAU/VibeCoder)
 *   --regression-issues a,b,c   override the issue list
 *   --no-github            skip the issue lookup (reported as unverified → not GREEN)
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { runGhCommand } from "../lib/github.ts";
import {
  analyseGreenGate,
  DEFAULT_REGRESSION_ISSUES,
  formatGreenGateReport,
  gatherGreenGateEvidence,
  type GreenGateReport,
  type GreenGateSources,
} from "../lib/green_gate_report.ts";
import { resolveRunHostId } from "../lib/run_mode_record.ts";

/** Default report location, per the issue. */
export const GREEN_GATE_REPORT_DIR = "docs/evidence";

const WORKER_LOG_RE = /^worker-\d+(?:-\d+)*\.log(?:\.gz)?$/;
const RUN_CORE_LOG_RE = /^run_core\.log(?:\.\d+)?$/;

/** Read a file, gunzipping when the name ends in `.gz`. */
async function readMaybeGzip(path: string): Promise<string> {
  if (!path.endsWith(".gz")) return await Deno.readTextFile(path);
  const file = await Deno.open(path, { read: true });
  const stream = file.readable.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/** The production sources over a log directory. */
export function createGreenGateSources(options: {
  logDir: string;
  repo: string;
  useGithub: boolean;
  now?: () => Date;
}): GreenGateSources {
  const listNames = async (): Promise<string[]> => {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(options.logDir)) {
        if (entry.isFile) names.push(entry.name);
      }
    } catch {
      // No log dir → no evidence.
    }
    return names.sort();
  };
  return {
    now: options.now ?? (() => new Date()),
    hostId: () => resolveRunHostId(),
    readRunCoreLogs: async () => {
      const out: string[] = [];
      for (const name of await listNames()) {
        if (!RUN_CORE_LOG_RE.test(name)) continue;
        try {
          out.push(await Deno.readTextFile(`${options.logDir}/${name}`));
        } catch {
          // Unreadable rotated file — skip.
        }
      }
      return out;
    },
    listWorkerLogs: async () =>
      (await listNames())
        .filter((name) => WORKER_LOG_RE.test(name))
        .map((name) => ({
          name,
          read: () => readMaybeGzip(`${options.logDir}/${name}`),
        })),
    readSelfHealEvents: async () => {
      try {
        return await Deno.readTextFile(`${options.logDir}/self-heal.jsonl`);
      } catch {
        return "";
      }
    },
    openIssues: async (numbers) => {
      if (!options.useGithub) {
        throw new Error("GitHub lookup skipped (--no-github)");
      }
      if (numbers.length === 0) return [];
      // One search call: the open subset of the named issues.
      const raw = await runGhCommand([
        "issue",
        "list",
        "--repo",
        options.repo,
        "--state",
        "open",
        "--limit",
        "500",
        "--json",
        "number,title",
      ]);
      const wanted = new Set(numbers);
      const parsed = JSON.parse(raw) as Array<
        { number: number; title: string }
      >;
      return parsed.filter((i) => wanted.has(i.number));
    },
  };
}

function numberArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const v = args[name];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return fallback;
}

function issuesArg(
  args: Record<string, unknown>,
): readonly number[] {
  const v = args["regression-issues"];
  if (typeof v === "string" && v.trim().length > 0) {
    return v.split(",").map((s) => Number(s.trim())).filter((n) =>
      Number.isInteger(n) && n > 0
    );
  }
  if (typeof v === "number") return [v];
  return DEFAULT_REGRESSION_ISSUES;
}

/** Report file name for a date. */
export function greenGateReportPath(now: Date): string {
  return `${GREEN_GATE_REPORT_DIR}/green-gate-${
    now.toISOString().slice(0, 10)
  }.md`;
}

export const greenGateReportCommand: Command = {
  name: "green-gate-report",
  description:
    "Write the Phase 0 green-gate evidence report from this host's run logs to docs/evidence (Issue #4189)",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<GreenGateReport>> {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    const logDirArg = args["log-dir"];
    const logDir = typeof logDirArg === "string" && logDirArg.length > 0
      ? logDirArg
      : `${home}/logs`;
    const repoArg = args["repo"];
    const repo = typeof repoArg === "string" && repoArg.includes("/")
      ? repoArg
      : "stSoftwareAU/VibeCoder";
    const options = {
      windowDays: numberArg(args, "window-days", 30),
      minWindowDays: numberArg(args, "min-window-days", 14),
      regressionIssues: issuesArg(args),
    };
    const sources = createGreenGateSources({
      logDir,
      repo,
      useGithub: args["no-github"] !== true,
    });
    const evidence = await gatherGreenGateEvidence(sources, options);
    const report = analyseGreenGate(evidence, options);
    const md = formatGreenGateReport(report);

    const outArg = args["out"];
    const outPath = typeof outArg === "string" && outArg.length > 0
      ? outArg
      : greenGateReportPath(sources.now());
    try {
      const dir = outPath.includes("/")
        ? outPath.slice(0, outPath.lastIndexOf("/"))
        : ".";
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(outPath, md);
    } catch (err) {
      return {
        success: false,
        message: `Failed to write report: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    return {
      success: true,
      message:
        `Wrote ${outPath} — verdict ${report.verdict} (${report.host.launches.container} container / ${report.host.launches.hostMode} host-mode / ${report.host.launches.unknown} unverified launches over ${report.observedWindowDays} days)` +
        (report.reasons.length > 0 ? `: ${report.reasons.join("; ")}` : ""),
      data: report,
    };
  },
};
