/**
 * sweep-heartbeat-comments command (Issue #3755).
 *
 * One-shot sweep that collapses the heartbeat marker comments on a thread
 * down to at most one. The adoption path (Issue #3751) self-heals a thread
 * as it is worked; this command clears the backlog already on GitHub without
 * waiting for each thread to be picked up again.
 *
 * Usage:
 *   deno run mod.ts sweep-heartbeat-comments --dry-run
 *   deno run mod.ts sweep-heartbeat-comments --repos org/repo --issue 3644
 *   deno run mod.ts sweep-heartbeat-comments --repos org/a,org/b
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { getGithubUser } from "../lib/claude_runner.ts";
import { resolveFleetAuthors } from "../lib/fleet_authors.ts";
import { HEARTBEAT_MARKER_PREFIX, runGh } from "../lib/heartbeat_storage.ts";
import { sweepHeartbeatComments } from "../lib/heartbeat_sweep.ts";
import { getMachineId } from "../lib/machine_id.ts";

/** Maximum threads inspected per repo in one run. */
const MAX_THREADS_PER_REPO = 100;

/** Per-thread outcome reported by the command. */
export interface SweepThreadReport {
  repo: string;
  issue: number;
  scanned: number;
  deleted: number[];
  failed: number[];
  retained: number[];
  orphanedLiveMarkers: number;
}

/** Aggregated command output. */
export interface SweepCommandData {
  dryRun: boolean;
  repos: string[];
  threads: SweepThreadReport[];
  totals: {
    threads: number;
    deleted: number;
    failed: number;
    orphanedLiveMarkers: number;
  };
  /** Threads dropped because the per-repo cap was reached (never silent). */
  truncated: Array<{ repo: string; dropped: number }>;
}

/** Options accepted by {@link sweepHeartbeatCommentsAcrossRepos}. */
export interface SweepCommandOptions {
  repos: string[];
  allowedAuthors: string[];
  machineId?: string;
  issueNumber?: number;
  dryRun?: boolean;
  ghFn?: (args: string[]) => Promise<string>;
}

/**
 * Find the threads in a repo that carry at least one heartbeat marker.
 *
 * Uses the issue-search endpoint — the marker text is unique enough that a
 * phrase search returns clean results. Returns an empty list on any failure
 * so a search problem degrades to "nothing to sweep".
 */
async function findMarkerThreads(
  repo: string,
  ghFn: (args: string[]) => Promise<string>,
): Promise<{ numbers: number[]; dropped: number }> {
  const out = await ghFn([
    "api",
    "-X",
    "GET",
    "search/issues",
    "-f",
    `q="${HEARTBEAT_MARKER_PREFIX}" repo:${repo}`,
    "-F",
    `per_page=${MAX_THREADS_PER_REPO}`,
    "--jq",
    "{total: .total_count, numbers: [.items[].number]}",
  ]);
  if (!out) return { numbers: [], dropped: 0 };
  try {
    const parsed = JSON.parse(out) as {
      total?: number;
      numbers?: number[];
    };
    const numbers = (parsed.numbers ?? []).filter((n) =>
      typeof n === "number" && Number.isFinite(n)
    );
    const total = typeof parsed.total === "number" ? parsed.total : 0;
    return { numbers, dropped: Math.max(0, total - numbers.length) };
  } catch {
    return { numbers: [], dropped: 0 };
  }
}

/**
 * Sweep every named repo (or a single named thread) and report what changed.
 */
export async function sweepHeartbeatCommentsAcrossRepos(
  options: SweepCommandOptions,
): Promise<SweepCommandData> {
  const ghFn = options.ghFn ?? runGh;
  const dryRun = options.dryRun === true;
  const threads: SweepThreadReport[] = [];
  const truncated: Array<{ repo: string; dropped: number }> = [];

  for (const repo of options.repos) {
    let numbers: number[];
    if (options.issueNumber !== undefined) {
      numbers = [options.issueNumber];
    } else {
      const found = await findMarkerThreads(repo, ghFn);
      numbers = found.numbers;
      if (found.dropped > 0) truncated.push({ repo, dropped: found.dropped });
    }
    for (const issue of numbers) {
      const result = await sweepHeartbeatComments(repo, issue, ghFn, {
        allowedAuthors: options.allowedAuthors,
        ...(options.machineId ? { machineId: options.machineId } : {}),
        dryRun,
      });
      if (result.scanned === 0) continue;
      threads.push({
        repo,
        issue,
        scanned: result.scanned,
        deleted: result.deleted,
        failed: result.failed,
        retained: result.retained,
        orphanedLiveMarkers: result.orphanedLiveMarkers,
      });
    }
  }

  return {
    dryRun,
    repos: options.repos,
    threads,
    totals: {
      threads: threads.length,
      deleted: threads.reduce((n, t) => n + t.deleted.length, 0),
      failed: threads.reduce((n, t) => n + t.failed.length, 0),
      orphanedLiveMarkers: threads.reduce(
        (n, t) => n + t.orphanedLiveMarkers,
        0,
      ),
    },
    truncated,
  };
}

/** Parse the `--repos` argument, falling back to the configured repos. */
function parseReposArg(
  args: Record<string, unknown>,
  config: WorkerConfig,
): string[] {
  const raw = args["repos"];
  if (Array.isArray(raw)) {
    return raw.map(String).map((r) => r.trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.length > 0) {
    return raw.split(",").map((r) => r.trim()).filter(Boolean);
  }
  return config.repos ?? [];
}

/** The sweep-heartbeat-comments command implementation. */
export const sweepHeartbeatCommentsCommand: Command = {
  name: "sweep-heartbeat-comments",
  description:
    "Collapse orphaned/blanked heartbeat marker comments down to one per thread (Issue #3755)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<SweepCommandData>> {
    const repos = parseReposArg(args, config);
    if (repos.length === 0) {
      return {
        success: false,
        message:
          "No repos to sweep. Pass --repos org/repo1,org/repo2 or configure repos in .config.json.",
      };
    }

    const issueArg = args["issue"];
    let issueNumber: number | undefined;
    if (issueArg !== undefined) {
      const parsed = typeof issueArg === "number"
        ? issueArg
        : parseInt(String(issueArg), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          success: false,
          message: `sweep-heartbeat-comments: invalid --issue "${issueArg}"`,
        };
      }
      issueNumber = parsed;
    }

    const userResult = await getGithubUser();
    if (!userResult.ok) {
      return {
        success: false,
        message:
          `Failed to detect the worker GitHub user: ${userResult.error.message}`,
      };
    }
    const allowedAuthors = resolveFleetAuthors(
      userResult.value,
      config.allowedAuthors ?? [],
      config.fleetPrAuthors ?? [],
    );

    let machineId: string | undefined;
    try {
      machineId = await getMachineId(config.workDir);
    } catch {
      // Without a machine id the sweep is simply more conservative: this
      // host's own duplicate markers age out rather than being swept early.
      machineId = undefined;
    }

    const data = await sweepHeartbeatCommentsAcrossRepos({
      repos,
      allowedAuthors,
      ...(machineId ? { machineId } : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      dryRun: args["dry-run"] === true || args["dry-run"] === "true",
    });

    for (const drop of data.truncated) {
      console.warn(
        `[sweep] ${drop.repo}: ${drop.dropped} further thread(s) carry heartbeat ` +
          `markers but were not inspected (cap ${MAX_THREADS_PER_REPO}) — re-run to continue`,
      );
    }

    const verb = data.dryRun ? "would delete" : "deleted";
    return {
      success: true,
      message:
        `Swept ${data.totals.threads} thread(s) across ${repos.length} ` +
        `repo(s): ${verb} ${data.totals.deleted} marker comment(s), ` +
        `${data.totals.failed} failure(s), ` +
        `${data.totals.orphanedLiveMarkers} orphaned live marker(s).`,
      data,
    };
  },
};
