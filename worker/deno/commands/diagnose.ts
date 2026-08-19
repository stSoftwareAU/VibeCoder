/**
 * `worker diagnose` command (Issue #1905).
 *
 * One-shot live-state summary of the Vibe Coder worker. Read-only and
 * safe to run alongside an active worker — every probe falls back to
 * `n/a` rather than failing the report.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-run --allow-net \
 *     worker/deno/mod.ts diagnose
 *
 * Optional flags:
 *   --pid-file   Override the path to the run_core PID file.
 *   --log-dir    Override the directory containing worker-*.log files.
 *   --github-user Override the worker's GitHub username (defaults to GITHUB_USER).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type DiagnoseData,
  type DiagnoseDeps,
  formatDiagnostics,
  gatherDiagnostics,
  type OutstandingWork,
} from "../lib/diagnose.ts";
import { isRunning } from "../lib/pid_guard.ts";
import { runGhCommandRaw } from "../lib/github.ts";
import { isRateLimitActive } from "../lib/rate_limit_signal.ts";

async function realPsSupervisors(): Promise<string> {
  const cmd = new Deno.Command("ps", {
    args: ["-axo", "pid=,etime=,ppid=,command="],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout, success } = await cmd.output();
  if (!success) return "";
  return new TextDecoder().decode(stdout);
}

async function realReadPidFile(path: string): Promise<string | undefined> {
  try {
    const txt = await Deno.readTextFile(path);
    return txt.length > 0 ? txt : undefined;
  } catch {
    return undefined;
  }
}

async function realListLogs(
  dir: string,
): Promise<Array<{ path: string; mtime: Date }>> {
  const out: Array<{ path: string; mtime: Date }> = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      if (!/^worker-\d+\.log$/.test(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      try {
        const stat = await Deno.stat(path);
        out.push({ path, mtime: stat.mtime ?? new Date(0) });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory missing — return empty list
  }
  return out;
}

async function realTailLog(path: string, lines: number): Promise<string[]> {
  try {
    const txt = await Deno.readTextFile(path);
    const all = txt.split("\n").filter((l) => l.length > 0);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

async function realRateLimitJson(): Promise<string> {
  return await runGhCommandRaw(["api", "rate_limit"]);
}

async function realRateLimitSignal(
  workDir: string,
): Promise<{ active: boolean; remainingSeconds: number } | undefined> {
  const result = await isRateLimitActive(workDir);
  if (!result.ok) return undefined;
  return result.value;
}

async function realOutstandingWork(
  user: string,
): Promise<OutstandingWork | undefined> {
  if (!user) return undefined;
  try {
    const prsRaw = await runGhCommandRaw([
      "search",
      "prs",
      `--author=${user}`,
      "--state=open",
      "--limit=1",
      "--json=totalCount",
    ]);
    const issuesRaw = await runGhCommandRaw([
      "search",
      "issues",
      `--assignee=${user}`,
      "--state=open",
      "--limit=1",
      "--json=totalCount",
    ]);
    // `gh search` with --json=totalCount returns an array — pull the field
    // off the first element, or 0 if missing.
    const parseCount = (raw: string): number => {
      try {
        const parsed = JSON.parse(raw) as Array<{ totalCount?: number }> | {
          total_count?: number;
        };
        if (Array.isArray(parsed)) {
          return parsed[0]?.totalCount ?? 0;
        }
        return parsed.total_count ?? 0;
      } catch {
        return 0;
      }
    };
    return {
      openPRs: parseCount(prsRaw),
      openIssues: parseCount(issuesRaw),
    };
  } catch {
    return undefined;
  }
}

async function realRecentMergedTimestamps(
  user: string,
  since: Date,
): Promise<string[]> {
  if (!user) return [];
  try {
    const sinceDate = since.toISOString().slice(0, 10);
    const raw = await runGhCommandRaw([
      "search",
      "prs",
      `--author=${user}`,
      "--merged",
      `--merged-at=>=${sinceDate}`,
      "--limit=100",
      "--json=closedAt",
    ]);
    const parsed = JSON.parse(raw) as Array<{ closedAt?: string }>;
    return parsed.map((p) => p.closedAt ?? "").filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

async function realHostname(): Promise<string> {
  try {
    const cmd = new Deno.Command("hostname", {
      stdout: "piped",
      stderr: "null",
    });
    const { stdout, success } = await cmd.output();
    if (!success) return "unknown-host";
    return new TextDecoder().decode(stdout).trim() || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

export const diagnoseCommand: Command = {
  name: "diagnose",
  description:
    "One-shot live-state summary of the worker: supervisors, active PID, rate limit, recent merges",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<DiagnoseData>> {
    const repoRoot = Deno.cwd();
    const defaultPidFile = `${repoRoot}/.run.pid`;
    const defaultLogDir = `${Deno.env.get("HOME") ?? ""}/logs`;
    const workDir = config.workDir || repoRoot;

    const pidFile = (args["pid-file"] as string | undefined) ?? defaultPidFile;
    const logDir = (args["log-dir"] as string | undefined) ?? defaultLogDir;
    const githubUser = (args["github-user"] as string | undefined) ??
      Deno.env.get("GITHUB_USER") ?? "";

    const deps: DiagnoseDeps = {
      pidFile,
      logDir,
      githubUser,
      now: () => new Date(),
      hostname: realHostname,
      psSupervisors: realPsSupervisors,
      isRunning,
      readPidFile: realReadPidFile,
      listLogs: realListLogs,
      tailLog: realTailLog,
      rateLimitJson: realRateLimitJson,
      rateLimitSignal: () => realRateLimitSignal(workDir),
      outstandingWork: realOutstandingWork,
      recentMergedTimestamps: realRecentMergedTimestamps,
    };

    const data = await gatherDiagnostics(deps);
    const formatted = formatDiagnostics(data);

    return {
      success: true,
      message: formatted,
      data,
    };
  },
};
