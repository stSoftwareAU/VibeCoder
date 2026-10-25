/**
 * Regression tests for Issue #4341: `semgrep ci --config p/default` exits
 * fatally when SEMGREP_APP_TOKEN is set, so no Semgrep scan may pass it.
 *   a. The detector reports token + `--config` at step, job or top level.
 *   b. The `semgrep` workflow template is token-free and still scans.
 *   c. Every workflow in `.github/workflows` is token-free; semgrep.yml scans.
 *   d. quality.yml passes no secrets to Semgrep; semgrep.yml has no environment.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";

const TOKEN = "SEMGREP_APP_TOKEN";
const SCAN_RUN = "semgrep ci --config p/default";

type Mapping = Record<string, unknown>;

function isRecord(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const hasToken = (env: unknown): boolean => isRecord(env) && TOKEN in env;

/**
 * Return `"<job>#<stepIndex>"` for every step whose `run` invokes
 * `semgrep ci` with `--config` while SEMGREP_APP_TOKEN is in scope: the
 * step's `env`, its job's `env`, or the workflow's top-level `env`.
 */
function semgrepTokenWithConfigSteps(yamlText: string): string[] {
  const workflow = parseMapping(yamlText);
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const hits: string[] = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step: unknown, index: number) => {
      if (!isRecord(step) || typeof step.run !== "string") return;
      const configScan = step.run.includes("semgrep ci") &&
        step.run.includes("--config");
      const inScope = hasToken(step.env) || hasToken(job.env) ||
        hasToken(workflow.env);
      if (configScan && inScope) hits.push(`${jobName}#${index}`);
    });
  }
  return hits;
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

const STEP_ENV = `jobs:
  semgrep:
    steps:
      - run: semgrep ci --config p/default
        env:
          SEMGREP_APP_TOKEN: \${{ secrets.SEMGREP_APP_TOKEN }}
`;

const JOB_ENV = `jobs:
  semgrep:
    env:
      SEMGREP_APP_TOKEN: \${{ secrets.SEMGREP_APP_TOKEN }}
    steps:
      - run: semgrep ci --config p/default
`;

const TOP_ENV = `env:
  SEMGREP_APP_TOKEN: \${{ secrets.SEMGREP_APP_TOKEN }}
jobs:
  semgrep:
    steps:
      - run: semgrep ci --config p/default
`;

const NO_CONFIG_WITH_TOKEN = `jobs:
  semgrep:
    steps:
      - run: semgrep ci
        env:
          SEMGREP_APP_TOKEN: \${{ secrets.SEMGREP_APP_TOKEN }}
`;

const TOKEN_FREE = `jobs:
  semgrep:
    steps:
      - run: semgrep ci --config p/default
`;

Deno.test("detector reports a token with --config at step, job and top level (Issue #4341)", () => {
  assertEquals(semgrepTokenWithConfigSteps(STEP_ENV), ["semgrep#0"]);
  assertEquals(semgrepTokenWithConfigSteps(JOB_ENV), ["semgrep#0"]);
  assertEquals(semgrepTokenWithConfigSteps(TOP_ENV), ["semgrep#0"]);
});

Deno.test("detector ignores token-free runs and the --config-less alternative mode", () => {
  assertEquals(semgrepTokenWithConfigSteps(NO_CONFIG_WITH_TOKEN), []);
  assertEquals(semgrepTokenWithConfigSteps(TOKEN_FREE), []);
});

Deno.test("semgrep spec template runs the scan with no token (Issue #4341)", () => {
  const spec = WORKFLOW_SPECS.find((s) => s.id === "semgrep");
  assert(spec !== undefined, "semgrep spec missing");
  const template = spec.template;
  assertEquals(semgrepTokenWithConfigSteps(template), []);
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
      semgrepTokenWithConfigSteps(text),
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
