/**
 * Tests for the fleet-experiment-report command (Issue #3645).
 *
 * Each test drives the real command against a temporary work directory that
 * the test creates and removes, so nothing touches a fixed path. Ledger
 * fixtures are built with the real ledger builder and serialiser.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fleetExperimentReportCommand } from "../commands/fleet_experiment_report.ts";
import { CONTROL_ARM_ID } from "../lib/fleet_experiment_arms.ts";
import { experimentRecordsCsv } from "../lib/fleet_experiment_report.ts";
import {
  buildLifecycleEvent,
  type LifecycleEvent,
  serialiseLifecycleEvent,
} from "../lib/lifecycle_ledger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { CommandResult, WorkerConfig } from "../types.ts";

const DAY_MS = 86_400_000;

/** Fixed UUIDs in the lowercase form the ledger accepts as assignment ids. */
const ASSIGNMENT_IDS = [
  "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e01",
  "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e02",
] as const;

/** An ISO timestamp the given number of days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** One assignment event, recorded `days` before now, on `host`. */
function assignment(
  host: string,
  assignmentId: string,
  issueNumber: number,
  days: number,
): LifecycleEvent {
  const recordedAt = daysAgo(days);
  return buildLifecycleEvent({
    kind: "assignment",
    assignmentId,
    runId: `run-${host}-${issueNumber}`,
    host,
    repo: "org/a",
    issueNumber,
    recordedAt,
    assignedAt: recordedAt,
    cohort: CONTROL_ARM_ID,
    reused: false,
    treatment: {
      roles: [{ role: "manager", provider: "claude", model: "sonnet" }],
    },
  });
}

/** Run `body` against a fresh temporary work directory, removed afterwards. */
async function withWorkDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "fleet_experiment_report_" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Write events as one JSON line each, as the ledger writer does. */
async function writeLedger(
  path: string,
  events: readonly LifecycleEvent[],
): Promise<void> {
  const text = events.map((event) => serialiseLifecycleEvent(event)).join(
    "\n",
  ) + "\n";
  await Deno.writeTextFile(path, text);
}

/** A config whose only meaningful field for this command is the work dir. */
function configFor(dir: string): WorkerConfig {
  return buildDefaultWorkerConfig({ workDir: dir });
}

/** A work directory holding one ledger per host, each with one assignment. */
async function seedTwoHosts(dir: string): Promise<void> {
  await writeLedger(`${dir}/lifecycle_ledger_host-1.jsonl`, [
    assignment("host-1", ASSIGNMENT_IDS[0], 101, 2),
  ]);
  await writeLedger(`${dir}/lifecycle_ledger_host-2.jsonl`, [
    assignment("host-2", ASSIGNMENT_IDS[1], 102, 3),
  ]);
}

/** Run the command with `args` against `config`. */
function run(
  args: Record<string, unknown>,
  config: WorkerConfig,
): Promise<CommandResult> {
  return fleetExperimentReportCommand.execute(args, config);
}

Deno.test("fleet-experiment-report - synthetic run is byte-identical across calls", async () => {
  const config = buildDefaultWorkerConfig();
  const first = await run({ synthetic: 42 }, config);
  const second = await run({ synthetic: 42 }, config);
  assertEquals(first.success, true);
  assertEquals(second.success, true);
  assertEquals(first.message, second.message);
});

Deno.test("fleet-experiment-report - synthetic json output parses", async () => {
  const result = await run(
    { synthetic: 42, format: "json" },
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, true);
  const parsed = JSON.parse(result.message) as { windowDays: number };
  assertEquals(parsed.windowDays, 30);
});

Deno.test("fleet-experiment-report - csv output starts with the records header", async () => {
  const result = await run(
    { synthetic: 42, format: "csv" },
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, true);
  const header = experimentRecordsCsv([]).split("\n")[0];
  assert(header !== undefined && header.length > 0);
  assertEquals(result.message.split("\n")[0], header);
});

Deno.test("fleet-experiment-report - reads every host ledger from the work directory", async () => {
  await withWorkDir(async (dir) => {
    await seedTwoHosts(dir);
    const result = await run(
      { format: "json" },
      configFor(dir),
    );
    assertEquals(result.success, true);
    const parsed = JSON.parse(result.message) as {
      records: unknown[];
    };
    assertEquals(parsed.records.length, 2);
    assertStringIncludes(result.message, "host-1");
    assertStringIncludes(result.message, "host-2");
  });
});

Deno.test("fleet-experiment-report - explicit ledger path reads only that ledger", async () => {
  await withWorkDir(async (dir) => {
    await seedTwoHosts(dir);
    const result = await run(
      { ledger: `${dir}/lifecycle_ledger_host-1.jsonl`, format: "json" },
      configFor(dir),
    );
    assertEquals(result.success, true);
    const parsed = JSON.parse(result.message) as { records: unknown[] };
    assertEquals(parsed.records.length, 1);
    assertStringIncludes(result.message, "host-1");
    assert(!result.message.includes("host-2"));
  });
});

Deno.test("fleet-experiment-report - corrupt ledger line fails naming the path", async () => {
  await withWorkDir(async (dir) => {
    await seedTwoHosts(dir);
    const corrupt = `${dir}/lifecycle_ledger_host-2.jsonl`;
    await Deno.writeTextFile(corrupt, "this line is not json\n");
    const result = await run({}, configFor(dir));
    assertEquals(result.success, false);
    assertStringIncludes(result.message, corrupt);
  });
});

Deno.test("fleet-experiment-report - named ledger that does not exist fails", async () => {
  await withWorkDir(async (dir) => {
    const missing = `${dir}/lifecycle_ledger_absent.jsonl`;
    const result = await run({ ledger: missing }, configFor(dir));
    assertEquals(result.success, false);
    assertStringIncludes(result.message, missing);
  });
});

Deno.test("fleet-experiment-report - no ledgers on the work volume fails", async () => {
  await withWorkDir(async (dir) => {
    const result = await run({}, configFor(dir));
    assertEquals(result.success, false);
    assertEquals(
      result.message,
      `no lifecycle ledgers found in ${dir}`,
    );
  });
});

Deno.test("fleet-experiment-report - a missing work directory fails as no ledgers", async () => {
  await withWorkDir(async (dir) => {
    const absent = `${dir}/not-created`;
    const result = await run({}, configFor(absent));
    assertEquals(result.success, false);
    assertEquals(
      result.message,
      `no lifecycle ledgers found in ${absent}`,
    );
  });
});

Deno.test("fleet-experiment-report - window must be a number of days in (0, 365]", async () => {
  await withWorkDir(async (dir) => {
    await seedTwoHosts(dir);
    const config = configFor(dir);
    for (const window of [0, -1, 366, "abc", "", NaN, Infinity]) {
      const result = await run({ window }, config);
      assertEquals(result.success, false, `window ${String(window)}`);
      assertStringIncludes(result.message, "window");
    }
    const legal = await run({ window: "7" }, config);
    assertEquals(legal.success, true);
  });
});

Deno.test("fleet-experiment-report - horizon must be a number of days in (0, 365]", async () => {
  await withWorkDir(async (dir) => {
    await seedTwoHosts(dir);
    const config = configFor(dir);
    const result = await run({ horizon: 0 }, config);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "horizon");
    const legal = await run({ horizon: 365 }, config);
    assertEquals(legal.success, true);
  });
});

Deno.test("fleet-experiment-report - format must be text, json or csv", async () => {
  await withWorkDir(async (dir) => {
    await seedTwoHosts(dir);
    const config = configFor(dir);
    const result = await run({ format: "xml" }, config);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "format");
    const legal = await run({ format: "csv" }, config);
    assertEquals(legal.success, true);
  });
});

Deno.test("fleet-experiment-report - synthetic must be a non-negative integer", async () => {
  const config = buildDefaultWorkerConfig();
  for (const synthetic of [-1, 1.5, "abc", "-3"]) {
    const result = await run({ synthetic }, config);
    assertEquals(result.success, false, `synthetic ${String(synthetic)}`);
    assertStringIncludes(result.message, "synthetic");
  }
  const legal = await run({ synthetic: "0" }, config);
  assertEquals(legal.success, true);
});

Deno.test("fleet-experiment-report - covariates must be an object of objects of strings", async () => {
  await withWorkDir(async (dir) => {
    await seedTwoHosts(dir);
    const config = configFor(dir);
    const secret = "SENTINEL-7731";
    const bad = `${dir}/bad_covariates.json`;
    await Deno.writeTextFile(
      bad,
      JSON.stringify({ "org/a#101": { size: secret }, "org/a#102": 3 }),
    );
    const refused = await run({ covariates: bad }, config);
    assertEquals(refused.success, false);
    assertStringIncludes(refused.message, "covariates");
    assert(!refused.message.includes(secret));

    const good = `${dir}/good_covariates.json`;
    await Deno.writeTextFile(
      good,
      JSON.stringify({ "org/a#101": { size: "small" } }),
    );
    const legal = await run({ covariates: good }, config);
    assertEquals(legal.success, true);
  });
});

Deno.test("fleet-experiment-report - covariates that are not JSON are refused", async () => {
  await withWorkDir(async (dir) => {
    await seedTwoHosts(dir);
    const path = `${dir}/not_json.json`;
    await Deno.writeTextFile(path, "{ not json");
    const result = await run({ covariates: path }, configFor(dir));
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "covariates");
  });
});
