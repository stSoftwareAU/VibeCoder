/**
 * security-tree-sweep command (Issue #4193).
 *
 * One-shot, re-runnable whole-tree security sweep: the worker's own security
 * scan (harvested from its filed `security` issues), semgrep over the entire
 * checkout and CodeQL (open code-scanning alerts) — normalised, deduplicated
 * across sources, classified against a committed baseline and written to a
 * Markdown report under `docs/audits/`.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run --allow-env \
 *     mod.ts security-tree-sweep [--repo /path/to/checkout] \
 *       [--slug owner/repo] \
 *       [--baseline .github/security-tree-sweep-baseline.json] \
 *       [--report docs/audits/security-tree-sweep.md] \
 *       [--sources worker-scan,semgrep,codeql] \
 *       [--semgrep-config p/default] [--semgrep-json PATH] \
 *       [--codeql-sarif PATH] [--run-worker-scan] \
 *       [--file-issues] [--max-issues N] [--stamp]
 *
 * Report-only by default. `--file-issues` files one issue per NEW finding
 * cluster (stable `SWEEP-<hex>` id, `security` + `security-tree-sweep` +
 * `severity:*` + `confidence:*` labels), most important first, skipping ids
 * already open and capped by `--max-issues` (default 20) so the fleet is not
 * flooded. Exits non-zero when unbaselined findings exist or the baseline is
 * malformed. A missing scanner or an unreadable alert feed is an error, never
 * a clean sweep (Issue #3234).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  createDefaultSweepDeps,
  DEFAULT_MAX_ISSUES,
  runSecurityTreeSweep,
  SWEEP_SOURCES,
  type SweepDeps,
  type SweepRunResult,
  type SweepSource,
} from "../lib/security_tree_sweep.ts";

/** Default baseline path, relative to the swept checkout. */
export const DEFAULT_BASELINE = ".github/security-tree-sweep-baseline.json";
/** Default report path, relative to the swept checkout. */
export const DEFAULT_REPORT = "docs/audits/security-tree-sweep.md";

/** Read a string argument, falling back to a default. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** Read an optional string argument. */
function optionalStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** True for `--flag`, `--flag true`. */
function boolArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true || args[key] === "true";
}

/** Join a repo-relative path onto the repo root (absolute paths pass through). */
function resolve(repoDir: string, path: string): string {
  return path.startsWith("/") ? path : `${repoDir}/${path}`;
}

/** Parse `--sources a,b`; returns an error string for an unknown name. */
export function parseSources(
  raw: string | undefined,
): { sources: SweepSource[] } | { error: string } {
  if (raw === undefined) return { sources: [...SWEEP_SOURCES] };
  const wanted = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const sources: SweepSource[] = [];
  for (const name of wanted) {
    if (!(SWEEP_SOURCES as readonly string[]).includes(name)) {
      return {
        error: `unknown source "${name}" — expected one of ` +
          SWEEP_SOURCES.join(", "),
      };
    }
    sources.push(name as SweepSource);
  }
  if (sources.length === 0) return { error: "--sources names no source" };
  return { sources };
}

/** Resolve the `owner/repo` slug: `--slug`, else `gh repo view` in the checkout. */
async function resolveSlug(
  args: Record<string, unknown>,
  repoDir: string,
  deps: SweepDeps,
): Promise<string> {
  const explicit = optionalStringArg(args, "slug");
  if (explicit !== undefined) return explicit;
  const raw = await deps.runner(
    {
      bin: "gh",
      args: ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    },
    repoDir,
  );
  const slug = raw.stdout.trim();
  if (raw.code !== 0 || !/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(
      "could not determine the repository slug — pass --slug owner/repo " +
        `(gh repo view exit ${raw.code}: ${raw.stderr.trim()})`,
    );
  }
  return slug;
}

/** Build the command with injectable deps (tests) or the defaults. */
export function createSecurityTreeSweepCommand(
  deps: SweepDeps = createDefaultSweepDeps(),
): Command {
  return {
    name: "security-tree-sweep",
    description:
      "Whole-tree security sweep: worker scan + semgrep + CodeQL, deduplicated " +
      "and baselined; --file-issues files new findings (Issue #4193)",
    async execute(
      args: Record<string, unknown>,
    ): Promise<CommandResult<SweepRunResult>> {
      const repoDir = stringArg(args, "repo", Deno.cwd());
      const parsedSources = parseSources(optionalStringArg(args, "sources"));
      if ("error" in parsedSources) {
        return {
          success: false,
          message:
            `❌ Whole-tree security sweep could not run: ${parsedSources.error}`,
        };
      }
      const maxIssuesRaw = args["max-issues"];
      const maxIssues = typeof maxIssuesRaw === "number"
        ? maxIssuesRaw
        : typeof maxIssuesRaw === "string"
        ? Number.parseInt(maxIssuesRaw, 10)
        : DEFAULT_MAX_ISSUES;
      if (!Number.isFinite(maxIssues) || maxIssues < 0) {
        return {
          success: false,
          message: "❌ Whole-tree security sweep could not run: --max-issues " +
            "must be a non-negative integer",
        };
      }

      let result: SweepRunResult;
      try {
        const slug = await resolveSlug(args, repoDir, deps);
        const semgrepJsonPath = optionalStringArg(args, "semgrep-json");
        const codeqlSarifPath = optionalStringArg(args, "codeql-sarif");
        const semgrepConfig = optionalStringArg(args, "semgrep-config");
        result = await runSecurityTreeSweep({
          repoDir,
          slug,
          baselinePath: resolve(
            repoDir,
            stringArg(args, "baseline", DEFAULT_BASELINE),
          ),
          reportPath: resolve(
            repoDir,
            stringArg(args, "report", DEFAULT_REPORT),
          ),
          sources: parsedSources.sources,
          fileIssues: boolArg(args, "file-issues"),
          maxIssues,
          runWorkerScan: boolArg(args, "run-worker-scan"),
          ...(semgrepJsonPath !== undefined ? { semgrepJsonPath } : {}),
          ...(codeqlSarifPath !== undefined ? { codeqlSarifPath } : {}),
          ...(semgrepConfig !== undefined ? { semgrepConfig } : {}),
          // The committed report is deterministic; --stamp opts into a
          // timestamp for ad-hoc runs whose output is not committed.
          ...(boolArg(args, "stamp") ? { now: new Date() } : {}),
        }, deps);
      } catch (error) {
        // Fail loud — a sweep that could not run is not a sweep that passed.
        return {
          success: false,
          message: `❌ Whole-tree security sweep could not run: ` +
            `${(error as Error).message}`,
        };
      }

      const detail = [
        result.summary,
        `Report: ${result.reportPath}`,
        ...result.baselineErrors.map((e) => `Baseline error: ${e}`),
        ...result.newRows.map((r) =>
          `Unbaselined: ${r.id} ${r.severity} ${r.family} ${r.path}` +
          (r.lineStart !== null ? `:${r.lineStart}` : "")
        ),
        ...result.filed.map((f) => `Filed: #${f.number} ${f.id}`),
        ...result.staleEntries.map((k) => `Stale baseline entry: ${k}`),
      ].join("\n");

      return { success: result.ok, message: detail, data: result };
    },
  };
}

/** The registered command, wired to production deps. */
export const securityTreeSweepCommand: Command =
  createSecurityTreeSweepCommand();
