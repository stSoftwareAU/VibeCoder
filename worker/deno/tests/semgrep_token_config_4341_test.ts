/**
 * Regression tests for Issue #4341: `semgrep ci --config p/default` exits
 * fatally when SEMGREP_APP_TOKEN is set, so no Semgrep scan may pass it.
 *   a. The `semgrep` workflow template is token-free and still scans.
 *   b. Every workflow in `.github/workflows` is token-free; semgrep.yml scans.
 *   c. quality.yml passes no secrets to Semgrep; semgrep.yml has no environment.
 *
 * Token-free is decided by the production scanner `scanSemgrepTokenDrift`;
 * its own detection cases live in `semgrep_token_drift_scanner_test.ts`.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { scanSemgrepTokenDrift } from "../lib/semgrep_token_drift_scanner.ts";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

const TOKEN = "SEMGREP_APP_TOKEN";
const SCAN_RUN = "semgrep ci --config p/default";

type Mapping = Record<string, unknown>;

function isRecord(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Build the scanner's input for one workflow file. */
function workflowFile(path: string, rawText: string): WorkflowFile {
  return { path, rawText, parsed: parseYaml(rawText), kind: "workflow" };
}

function parseMapping(text: string): Mapping {
  const parsed = parseYaml(text);
  assert(isRecord(parsed), "document is not a YAML mapping");
  return parsed;
}

function jobNamed(workflow: Mapping, name: string): Mapping {
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const job = jobs[name];
  assert(isRecord(job), `no jobs.${name} mapping`);
  return job;
}

/** The `run` strings of a job's steps, in order (undefined for `uses:`). */
function runsOf(job: Mapping): unknown[] {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  return steps.map((step) => isRecord(step) ? step.run : undefined);
}

function workflowsDir(): URL {
  return new URL("../../../.github/workflows/", import.meta.url);
}

Deno.test("semgrep spec template runs the scan with no token (Issue #4341)", () => {
  const spec = WORKFLOW_SPECS.find((s) => s.id === "semgrep");
  assert(spec !== undefined, "semgrep spec missing");
  const template = spec.template;
  assertEquals(
    scanSemgrepTokenDrift([
      workflowFile(".github/workflows/semgrep.yml", template),
    ]),
    [],
  );
  const job = jobNamed(parseMapping(template), "semgrep");
  assert(runsOf(job).includes(SCAN_RUN), "template no longer runs the scan");
  const code = template.split("\n").filter((line) =>
    !line.trimStart().startsWith("#")
  );
  assertFalse(
    code.some((line) => line.includes(TOKEN)),
    "template passes SEMGREP_APP_TOKEN outside comments",
  );
});

Deno.test("no workflow in .github/workflows passes a token to semgrep ci --config", async () => {
  const dir = workflowsDir();
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".yml")) names.push(entry.name);
  }
  assert(names.includes("semgrep.yml"), "semgrep.yml not found");
  for (const name of names) {
    const text = await Deno.readTextFile(new URL(name, dir));
    assertEquals(
      scanSemgrepTokenDrift([workflowFile(`.github/workflows/${name}`, text)]),
      [],
      `${name} passes SEMGREP_APP_TOKEN to semgrep ci --config`,
    );
  }
});

Deno.test("semgrep.yml scans with no environment; quality.yml passes no secrets", async () => {
  const read = async (name: string) =>
    parseMapping(await Deno.readTextFile(new URL(name, workflowsDir())));
  const semgrep = jobNamed(await read("semgrep.yml"), "semgrep");
  assert(
    runsOf(semgrep).includes(SCAN_RUN),
    "semgrep.yml no longer runs the scan",
  );
  assertFalse(
    "environment" in semgrep,
    "semgrep.yml still targets an environment",
  );
  const quality = jobNamed(await read("quality.yml"), "semgrep");
  assertEquals(quality.uses, "./.github/workflows/semgrep.yml");
  assertFalse(
    "secrets" in quality,
    "quality.yml semgrep job still passes secrets",
  );
});
