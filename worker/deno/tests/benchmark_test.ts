/**
 * Tests for the fixed-workload benchmark (Issue #4299).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { formatBenchmarkTable, runBenchmark } from "../lib/benchmark.ts";
import { benchmarkCommand } from "../commands/benchmark.ts";
import type { WorkerConfig } from "../types.ts";

Deno.test("perf workload report - runs every step with an injected runner and reports each (Issue #4299)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "bench_" });
  const commands: string[] = [];
  try {
    const report = await runBenchmark({
      workDir,
      entryPath: "/nonexistent/mod.ts",
      mode: "container",
      host: "test-host",
      fsFiles: 5,
      cpuIterations: 3,
      run: (cmd, args) => {
        commands.push(`${cmd} ${args[0]}`);
        // deno check "succeeds"; git is real work but stubbed as ok too.
        return Promise.resolve({ code: 0, stderr: "" });
      },
    });
    assertEquals(report.mode, "container");
    assertEquals(report.host, "test-host");
    assertEquals(
      report.steps.map((s) => s.name),
      [
        "deno-check-cold",
        "deno-check-warm",
        "git-clone-local",
        "fs-write-read",
        "cpu-hash",
      ],
    );
    assert(report.steps.every((s) => s.ok), JSON.stringify(report.steps));
    assert(commands.includes("deno check"));
    assertEquals(
      report.totalMs,
      report.steps.reduce((sum, s) => sum + s.ms, 0),
    );
    const table = formatBenchmarkTable(report);
    assertStringIncludes(table, "benchmark container@test-host");
    assertStringIncludes(table, "cpu-hash");
    // Scratch is cleaned up.
    let scratchLeft = 0;
    for await (const e of Deno.readDir(workDir)) {
      if (e.name.startsWith(".benchmark-")) scratchLeft++;
    }
    assertEquals(scratchLeft, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("perf workload report - a failing step is reported, not thrown, and --only restricts steps (Issue #4299)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "bench_" });
  try {
    const report = await runBenchmark({
      workDir,
      entryPath: "/x/mod.ts",
      mode: "container",
      host: "h",
      only: ["deno-check-cold", "cpu-hash"],
      cpuIterations: 2,
      run: () => Promise.resolve({ code: 1, stderr: "type error" }),
    });
    assertEquals(report.steps.map((s) => s.name), [
      "deno-check-cold",
      "cpu-hash",
    ]);
    assertEquals(report.steps[0]!.ok, false);
    assertStringIncludes(report.steps[0]!.error ?? "", "type error");
    assertEquals(report.steps[1]!.ok, true);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("perf workload command - runs the real fs and cpu steps and emits a JSON line (Issue #4299)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "bench_cmd_" });
  try {
    const result = await benchmarkCommand.execute(
      {
        "work-dir": workDir,
        mode: "container",
        only: "fs-write-read,cpu-hash",
        json: true,
      },
      { workDir: "" } as unknown as WorkerConfig,
    );
    assertEquals(result.success, true);
    const parsed = JSON.parse(result.message ?? "");
    assertEquals(parsed.mode, "container");
    assertEquals(parsed.steps.length, 2);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
