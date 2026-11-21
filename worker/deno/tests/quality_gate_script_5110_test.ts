/**
 * Issue #5110: the required `gate` check turns red when the AWS Emulator job is
 * skipped, cancelled, failed or reports no result. These tests run the real
 * `.github/scripts/gate.sh` against a `needs` context built from the job ids
 * the real `quality.yml` gate depends on.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

const GATE_PATH = new URL("../../../.github/scripts/gate.sh", import.meta.url)
  .pathname;
const QUALITY_PATH =
  new URL("../../../.github/workflows/quality.yml", import.meta.url).pathname;

const AWS_JOB = "aws-emulator";

function hasJq(): boolean {
  try {
    return new Deno.Command("jq", {
      args: ["--version"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

const HAS_JQ = hasJq();

const workflow = parseYaml(Deno.readTextFileSync(QUALITY_PATH)) as {
  jobs: { gate: { needs: string[] | string } };
};
const needs: string[] = [workflow.jobs.gate.needs].flat();

interface GateRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGate(needsJson?: string): Promise<GateRun> {
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  };
  if (needsJson !== undefined) env.NEEDS_JSON = needsJson;
  const out = await new Deno.Command("bash", {
    args: [GATE_PATH],
    stdin: "null",
    clearEnv: true,
    env,
  }).output();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

/** The shape GitHub's `toJSON(needs)` emits, with optional per-job overrides. */
function needsJson(overrides: Record<string, unknown> = {}): string {
  const context: Record<string, unknown> = {};
  for (const id of needs) context[id] = { result: "success", outputs: {} };
  return JSON.stringify({ ...context, ...overrides });
}

Deno.test("fixture: quality.yml gate needs the aws-emulator job", () => {
  assert(
    needs.includes(AWS_JOB),
    `gate.needs must include ${AWS_JOB}; got ${JSON.stringify(needs)}`,
  );
});

Deno.test({
  name: "gate.sh passes when every needed job reports success",
  // gate.sh needs jq; GitHub runners and the worker image carry it.
  ignore: !HAS_JQ,
  fn: async () => {
    const run = await runGate(needsJson());
    assertEquals(run.code, 0, run.stderr);
    assertStringIncludes(
      run.stdout,
      `QUALITY GATE PASSED: all ${needs.length} job(s) reported success.`,
    );
    assert(!run.stderr.includes("CLOSED"), run.stderr);
  },
});

for (const result of ["skipped", "cancelled", "failure"]) {
  Deno.test({
    name: `gate.sh closes when aws-emulator is ${result}`,
    // gate.sh needs jq; GitHub runners and the worker image carry it.
    ignore: !HAS_JQ,
    fn: async () => {
      const run = await runGate(
        needsJson({ [AWS_JOB]: { result, outputs: {} } }),
      );
      assertEquals(run.code, 1, `result=${result}: ${run.stderr}`);
      assertStringIncludes(
        run.stderr,
        `${AWS_JOB}=${result}`,
        `result=${result}`,
      );
      assertStringIncludes(
        run.stderr,
        "QUALITY GATE CLOSED: 1 job(s) did not report success.",
        `result=${result}`,
      );
    },
  });
}

Deno.test({
  name: "gate.sh closes when aws-emulator carries no result",
  // gate.sh needs jq; GitHub runners and the worker image carry it.
  ignore: !HAS_JQ,
  fn: async () => {
    const run = await runGate(needsJson({ [AWS_JOB]: {} }));
    assertEquals(run.code, 1, run.stderr);
    assertStringIncludes(run.stderr, `${AWS_JOB}=NO_RESULT`);
  },
});

Deno.test({
  name: "gate.sh closes when NEEDS_JSON is empty",
  // gate.sh needs jq; GitHub runners and the worker image carry it.
  ignore: !HAS_JQ,
  fn: async () => {
    const run = await runGate("");
    assertEquals(run.code, 1, run.stderr);
    assertStringIncludes(run.stderr, "NEEDS_JSON is empty");
  },
});

Deno.test({
  name: "gate.sh closes when NEEDS_JSON is unset",
  // gate.sh needs jq; GitHub runners and the worker image carry it.
  ignore: !HAS_JQ,
  fn: async () => {
    const run = await runGate(undefined);
    assertEquals(run.code, 1, run.stderr);
    assertStringIncludes(run.stderr, "NEEDS_JSON is empty");
  },
});

Deno.test({
  name: "gate.sh closes when NEEDS_JSON names no jobs",
  // gate.sh needs jq; GitHub runners and the worker image carry it.
  ignore: !HAS_JQ,
  fn: async () => {
    const run = await runGate("{}");
    assertEquals(run.code, 1, run.stderr);
    assertStringIncludes(run.stderr, "named no jobs");
  },
});

Deno.test({
  name: "gate.sh closes when NEEDS_JSON is not valid JSON",
  // gate.sh needs jq; GitHub runners and the worker image carry it.
  ignore: !HAS_JQ,
  fn: async () => {
    const run = await runGate("not json");
    assertEquals(run.code, 1, run.stderr);
    assertStringIncludes(run.stderr, "not valid JSON");
  },
});
