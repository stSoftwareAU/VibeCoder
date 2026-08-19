/**
 * Fixed-workload benchmark for container-vs-native comparison (Issue #4299).
 *
 * The contained Vibe Coder was observed to be dramatically slower than the
 * native one, but nothing measured it: every tuning decision (VM sizing,
 * virtiofs, Deno cache, scan batching) needs a before/after number on the
 * same host. This module runs a representative, network-free workload and
 * reports wall times so both modes can be compared with one command:
 *
 *   - `deno-check-cold`: type-check the worker entry with an empty
 *     DENO_DIR (module resolution + full check from zero — the
 *     "container launch" cost before Issue #4302);
 *   - `deno-check-warm`: the same check again against the populated cache
 *     (the steady-state cost after #4302);
 *   - `git-clone-local`: build a small fixture repo and clone it —
 *     filesystem + git process-spawn throughput (virtiofs sensitivity);
 *   - `fs-write-read`: write and read back N small files in the work dir —
 *     raw filesystem latency of wherever the work dir lives;
 *   - `cpu-hash`: SHA-256 over a fixed buffer, N iterations — pure CPU, the
 *     vCPU-scheduling sensitivity.
 *
 * Every step is best-effort and reports its own failure; a missing tool
 * never fails the whole run. Results are one JSON line so FLEET-health can
 * trend them per host and per mode.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** One measured step. */
export interface BenchmarkStep {
  name: string;
  /** Wall milliseconds. */
  ms: number;
  ok: boolean;
  /** Failure detail when `ok` is false. */
  error?: string;
}

/** The whole run. */
export interface BenchmarkReport {
  /** ISO timestamp of the run. */
  timestamp: string;
  /** "container" | "native" | whatever the caller labels it. */
  mode: string;
  host: string;
  steps: BenchmarkStep[];
  /** Sum of step wall times. */
  totalMs: number;
}

/** Options for {@link runBenchmark}. */
export interface BenchmarkOptions {
  /** Directory the benchmark may write scratch files under. */
  workDir: string;
  /** Path to the worker entry to type-check (mod.ts). */
  entryPath: string;
  /** Mode label for the report. */
  mode: string;
  /** Host label for the report. */
  host: string;
  /** Number of small files for the fs step. Default 200. */
  fsFiles?: number;
  /** Iterations for the CPU hash step. Default 2000. */
  cpuIterations?: number;
  /** Command runner, injectable for tests. */
  run?: (cmd: string, args: string[], env?: Record<string, string>) => Promise<{
    code: number;
    stderr: string;
  }>;
  /** Clock. */
  now?: () => number;
  /** Which steps to run (default: all). */
  only?: string[];
}

async function defaultRun(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      env: env ? { ...Deno.env.toObject(), ...env } : undefined,
      stdout: "null",
      stderr: "piped",
    }).output();
    return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
  } catch (err) {
    return {
      code: -1,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run the fixed workload and return the report. */
export async function runBenchmark(
  options: BenchmarkOptions,
): Promise<BenchmarkReport> {
  const run = options.run ?? defaultRun;
  const now = options.now ?? Date.now;
  const fsFiles = options.fsFiles ?? 200;
  const cpuIterations = options.cpuIterations ?? 2000;
  const only = options.only ? new Set(options.only) : undefined;
  const scratch = `${options.workDir}/.benchmark-${Math.floor(now())}`;
  await Deno.mkdir(scratch, { recursive: true });

  const steps: BenchmarkStep[] = [];
  const measure = async (
    name: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    if (only && !only.has(name)) return;
    const start = now();
    try {
      await fn();
      steps.push({ name, ms: now() - start, ok: true });
    } catch (err) {
      steps.push({
        name,
        ms: now() - start,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const denoDir = `${scratch}/deno-cache`;
  const check = async (): Promise<void> => {
    const result = await run("deno", ["check", options.entryPath], {
      DENO_DIR: denoDir,
    });
    if (result.code !== 0) {
      throw new Error(
        `deno check exit ${result.code}: ${result.stderr.trim().slice(0, 200)}`,
      );
    }
  };
  await measure("deno-check-cold", check);
  await measure("deno-check-warm", check);

  await measure("git-clone-local", async () => {
    const src = `${scratch}/fixture`;
    await Deno.mkdir(src, { recursive: true });
    const git = async (args: string[], cwd: string) => {
      const r = await run("git", ["-C", cwd, ...args], {
        GIT_AUTHOR_NAME: "bench",
        GIT_AUTHOR_EMAIL: "bench@example.com",
        GIT_COMMITTER_NAME: "bench",
        GIT_COMMITTER_EMAIL: "bench@example.com",
      });
      if (r.code !== 0) throw new Error(`git ${args[0]} exit ${r.code}`);
    };
    await git(["init", "-q", "-b", "main"], src);
    for (let i = 0; i < 50; i++) {
      await Deno.writeTextFile(`${src}/f${i}.txt`, "x".repeat(2048));
    }
    await git(["add", "."], src);
    await git(["commit", "-q", "-m", "seed"], src);
    await git(["clone", "-q", src, `${scratch}/clone`], scratch);
  });

  await measure("fs-write-read", async () => {
    const dir = `${scratch}/fs`;
    await Deno.mkdir(dir, { recursive: true });
    for (let i = 0; i < fsFiles; i++) {
      await Deno.writeTextFile(`${dir}/${i}.txt`, `${i}`.repeat(64));
    }
    for (let i = 0; i < fsFiles; i++) {
      await Deno.readTextFile(`${dir}/${i}.txt`);
    }
  });

  await measure("cpu-hash", async () => {
    const buffer = new Uint8Array(64 * 1024);
    for (let i = 0; i < buffer.length; i++) buffer[i] = i & 0xff;
    for (let i = 0; i < cpuIterations; i++) {
      await crypto.subtle.digest("SHA-256", buffer);
    }
  });

  await Deno.remove(scratch, { recursive: true }).catch(() => undefined);

  return {
    timestamp: new Date(now()).toISOString(),
    mode: options.mode,
    host: options.host,
    steps,
    totalMs: steps.reduce((sum, s) => sum + s.ms, 0),
  };
}

/** Human-readable table for the terminal. */
export function formatBenchmarkTable(report: BenchmarkReport): string {
  const lines = [
    `benchmark ${report.mode}@${report.host} ${report.timestamp}`,
  ];
  for (const step of report.steps) {
    lines.push(
      `  ${step.name.padEnd(18)} ${
        String(Math.round(step.ms)).padStart(8)
      } ms` +
        (step.ok ? "" : `  FAILED: ${step.error ?? ""}`),
    );
  }
  lines.push(
    `  ${"total".padEnd(18)} ${
      String(Math.round(report.totalMs)).padStart(8)
    } ms`,
  );
  return lines.join("\n");
}
