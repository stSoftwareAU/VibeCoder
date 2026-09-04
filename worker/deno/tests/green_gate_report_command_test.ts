/**
 * Command-level tests for `green-gate-report` (Issue #4189): the production
 * sources over a real (temporary) log directory — gzip worker logs, rotated
 * run_core.log — and the idempotent write to the report path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createGreenGateSources,
  greenGateReportCommand,
  greenGateReportPath,
} from "../commands/green_gate_report.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function makeLogDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "green_gate_logs_" });
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - 2);
  const ts = day.toISOString().replace(/\.\d{3}Z$/, "Z");
  const d = ts.slice(0, 10);
  await Deno.writeTextFile(
    `${dir}/run_core.log`,
    [
      `${ts} VIBE_RUN_ID=vibe-live-1`,
      `${ts} run mode: container host=TESTHOST run_id=vibe-live-1`,
    ].join("\n") + "\n",
  );
  // A rotated sibling with an older, host-mode launch.
  const old = new Date();
  old.setUTCDate(old.getUTCDate() - 20);
  const ots = old.toISOString().replace(/\.\d{3}Z$/, "Z");
  await Deno.writeTextFile(
    `${dir}/run_core.log.1`,
    [
      `${ots} VIBE_RUN_ID=vibe-old-native`,
      `${ots} run mode: native host=TESTHOST run_id=vibe-old-native`,
    ].join("\n") + "\n",
  );
  const worker = [
    `run_core pid=20 start=${ts} (Worker timestamps are UTC)`,
    `[${d} 01:05:00Z] INFO: Processing issue org/repo#1: t [version=1.0.0 commit=unknown]`,
    `[${d} 01:30:00Z] INFO: Releasing claim org/repo#1 — outcome pr:#2`,
    `[${d} 02:00:00Z] [WORKER_SUMMARY] issues_processed=1 duration=3600s human=1h avg=3600s_per_issue`,
  ].join("\n") + "\n";
  await Deno.writeFile(
    `${dir}/worker-20260101-000000.log.gz`,
    await gzipText(worker),
  );
  await Deno.writeTextFile(`${dir}/worker-20260102-000000.log`, worker);
  await Deno.writeTextFile(`${dir}/unrelated.log`, "not a worker log\n");
  return dir;
}

Deno.test("green-gate-report command - name and description", () => {
  assertEquals(greenGateReportCommand.name, "green-gate-report");
  assert(greenGateReportCommand.description.length > 20);
});

Deno.test("green-gate-report sources - read gzip worker logs, rotated run_core.log, and skip unrelated files (Issue #4189)", async () => {
  const dir = await makeLogDir();
  try {
    const sources = createGreenGateSources({
      logDir: dir,
      repo: "o/r",
      useGithub: false,
    });
    const runCore = await sources.readRunCoreLogs();
    assertEquals(runCore.length, 2);
    const logs = await sources.listWorkerLogs();
    assertEquals(logs.map((l) => l.name), [
      "worker-20260101-000000.log.gz",
      "worker-20260102-000000.log",
    ]);
    const gz = await logs[0]!.read();
    assertStringIncludes(gz, "Processing issue org/repo#1");
    await sources.openIssues([1]).then(
      () => {
        throw new Error("expected rejection");
      },
      (err) => assertStringIncludes(String(err), "--no-github"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("green-gate-report command - writes the report, names the host-mode launch, and rewrites idempotently (Issue #4189)", async () => {
  const dir = await makeLogDir();
  const out = `${dir}/report/green-gate-test.md`;
  try {
    const run = () =>
      greenGateReportCommand.execute(
        {
          "log-dir": dir,
          out,
          "no-github": true,
          "window-days": 30,
          "min-window-days": 14,
        },
        buildDefaultWorkerConfig(),
      );
    const first = await run();
    assert(first.success, first.message);
    assertStringIncludes(first.message, "NOT GREEN");
    const md1 = await Deno.readTextFile(out);
    assertStringIncludes(md1, "**Verdict: NOT GREEN**");
    // The host-mode launch is named, the container one counted.
    assertStringIncludes(md1, "vibe-old-native");
    // The host column is the machine the command runs on (not the fixture's).
    assert(/\| \S+ \| Container-mode launches \| 1 \|/.test(md1), md1);
    // Both fixture logs carry the same claim at the same instant — a run
    // that appears twice (log and its gzip) is counted once.
    assert(/\| \S+ \| Issues processed \| 1 \|/.test(md1), md1);
    // The skipped GitHub lookup is a reason, not a pass.
    assertStringIncludes(md1, "could not verify the regression issues");

    // Second run rewrites (same window → same body apart from the timestamp).
    const second = await run();
    assert(second.success, second.message);
    const md2 = await Deno.readTextFile(out);
    // Only the clock moves between the two runs: generated-at and the
    // derived window start.
    const strip = (s: string) =>
      s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "T");
    assertEquals(strip(md2), strip(md1));
    assertEquals(
      (md2.match(/# Green-gate evidence report/g) ?? []).length,
      1,
      "rewritten, not appended",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("green-gate-report - default report path is docs/evidence/green-gate-<date>.md (Issue #4189)", () => {
  assertEquals(
    greenGateReportPath(new Date("2026-08-18T10:00:00Z")),
    "docs/evidence/green-gate-2026-08-18.md",
  );
});
