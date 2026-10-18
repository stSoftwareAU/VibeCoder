/**
 * Regression test for Issue #3768: every push to a pull request that carries
 * an archived PR summary must run the `PR summary freshness and gates` step
 * in `validate-scripts.yml`, and that step must be able to fail the job.
 *
 * A review-fix push made outside the worker (a laptop or cloud session, a
 * human) reaches none of the worker's summary checks, so the archived summary
 * kept describing the previous head. The step runs `deno task pr-summary-ci`
 * over the PR's base and head branch, so the summary is checked on every push.
 *
 * This file checks the workflow's shape: the step exists, its refs come
 * through `env` rather than being interpolated into `run`, a failure fails
 * the job, and the checkout keeps the full history the check needs. The
 * unmutated workflow must pass. Each negative breaks exactly one invariant
 * and must fail for that invariant alone.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml/parse";

/** Repository root — three levels up from `worker/deno/tests/`. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

const WORKFLOW_PATH = ".github/workflows/validate-scripts.yml";
const QUALITY_PATH = ".github/workflows/quality.yml";
const CHECK_COMMAND = "deno task pr-summary-ci";
const BASE_REF_EXPR = "${{ github.base_ref }}";
const HEAD_REF_EXPR = "${{ github.head_ref }}";

type Obj = Record<string, unknown>;

function isRecord(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readYaml(relPath: string): Promise<unknown> {
  return parse(await Deno.readTextFile(`${REPO_ROOT}/${relPath}`));
}

/** The `validate` job of a parsed workflow, or undefined when absent. */
function validateJob(workflow: unknown): Obj | undefined {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) return undefined;
  const job = workflow["jobs"]["validate"];
  return isRecord(job) ? job : undefined;
}

/** The steps of the `validate` job, or none when the shape is missing. */
function validateSteps(workflow: unknown): Obj[] {
  const steps = validateJob(workflow)?.["steps"];
  return Array.isArray(steps) ? steps.filter(isRecord) : [];
}

/** The step that runs `deno task pr-summary-ci`, found by its command. */
function prSummaryStep(workflow: unknown): Obj | undefined {
  return validateSteps(workflow).find((step) =>
    typeof step["run"] === "string" && step["run"].includes(CHECK_COMMAND)
  );
}

/** The `actions/checkout` step of the `validate` job. */
function checkoutStep(workflow: unknown): Obj | undefined {
  return validateSteps(workflow).find((step) =>
    typeof step["uses"] === "string" &&
    step["uses"].startsWith("actions/checkout@")
  );
}

/**
 * Problems with the PR-summary freshness step in the `validate` job. An empty
 * list means every invariant holds; each problem names the invariant it breaks.
 */
function prSummaryCiStepProblems(workflow: unknown): string[] {
  const step = prSummaryStep(workflow);
  if (!step) {
    return [
      `validate job has no step running \`${CHECK_COMMAND}\` (Issue #3768)`,
    ];
  }

  const problems: string[] = [];
  const run = String(step["run"]);

  if (!run.includes('--base "$BASE_REF"')) {
    problems.push('run must pass --base "$BASE_REF" (Issue #3768)');
  }
  if (!run.includes('--head-branch "$HEAD_REF"')) {
    problems.push('run must pass --head-branch "$HEAD_REF" (Issue #3768)');
  }

  const envBlock = step["env"];
  const env: Obj = isRecord(envBlock) ? envBlock : {};
  if (env["BASE_REF"] !== BASE_REF_EXPR) {
    problems.push(
      `env.BASE_REF must be exactly \`${BASE_REF_EXPR}\` (Issue #3768)`,
    );
  }
  if (env["HEAD_REF"] !== HEAD_REF_EXPR) {
    problems.push(
      `env.HEAD_REF must be exactly \`${HEAD_REF_EXPR}\` (Issue #3768)`,
    );
  }

  if (run.includes("${{")) {
    problems.push(
      "run interpolates a ${{ }} expression (run-injection, Issue #3768): " +
        "pass refs through env",
    );
  }

  if (!run.trimStart().startsWith("set -euo pipefail")) {
    problems.push("run must start with `set -euo pipefail` (Issue #3768)");
  }
  if (run.includes("|| true")) {
    problems.push(
      "run must not contain `|| true`: a failure must fail the job (Issue #3768)",
    );
  }
  if (
    step["continue-on-error"] === true || step["continue-on-error"] === "true"
  ) {
    problems.push(
      "step must not set `continue-on-error: true`: a failure must fail the " +
        "job (Issue #3768)",
    );
  }

  const checkout = checkoutStep(workflow);
  if (!checkout) {
    problems.push("validate job has no actions/checkout step (Issue #3768)");
  } else {
    const withBlock = checkout["with"];
    const checkoutWith: Obj = isRecord(withBlock) ? withBlock : {};
    if (checkoutWith["fetch-depth"] !== 0) {
      problems.push(
        "the validate job's actions/checkout must set with.fetch-depth: 0 " +
          "(full history, Issue #3768)",
      );
    }
  }

  return problems;
}

/** A mutated copy must break exactly one invariant, named by `fragment`. */
function assertOnlyProblem(problems: string[], fragment: string): void {
  assertEquals(
    problems.length,
    1,
    `expected exactly one problem, got: ${JSON.stringify(problems)}`,
  );
  assertStringIncludes(problems[0] ?? "", fragment);
}

/** The PR-summary step and checkout step of a copy, for mutation. */
function summaryAndCheckout(workflow: unknown): { step: Obj; checkout: Obj } {
  const step = prSummaryStep(workflow);
  const checkout = checkoutStep(workflow);
  assert(step, `${WORKFLOW_PATH} must have a \`${CHECK_COMMAND}\` step`);
  assert(checkout, `${WORKFLOW_PATH} must have an actions/checkout step`);
  return { step, checkout };
}

Deno.test(
  "validate-scripts.yml runs the PR-summary freshness step on every PR push (Issue #3768)",
  async () => {
    const workflow = await readYaml(WORKFLOW_PATH);
    assertEquals(prSummaryCiStepProblems(workflow), []);
  },
);

Deno.test(
  "an unmutated deep copy of the workflow passes the invariant checker (Issue #3768)",
  async () => {
    const workflow = await readYaml(WORKFLOW_PATH);
    assertEquals(prSummaryCiStepProblems(structuredClone(workflow)), []);
  },
);

Deno.test(
  "the PR-summary step must exist in the validate job (Issue #3768)",
  async () => {
    const copy = structuredClone(await readYaml(WORKFLOW_PATH));
    const job = validateJob(copy);
    assert(job, `${WORKFLOW_PATH} must have a validate job`);
    const steps = job["steps"];
    assert(Array.isArray(steps), "validate job must have steps");
    const step = prSummaryStep(copy);
    job["steps"] = steps.filter((s) => s !== step);
    assertOnlyProblem(prSummaryCiStepProblems(copy), "no step running");
  },
);

Deno.test(
  "the PR-summary step must pass --head-branch (Issue #3768)",
  async () => {
    const copy = structuredClone(await readYaml(WORKFLOW_PATH));
    const { step } = summaryAndCheckout(copy);
    step["run"] = String(step["run"]).replace(
      ' --head-branch "$HEAD_REF"',
      "",
    );
    assertOnlyProblem(prSummaryCiStepProblems(copy), "--head-branch");
  },
);

Deno.test(
  "the PR-summary step's env.HEAD_REF must be github.head_ref (Issue #3768)",
  async () => {
    const copy = structuredClone(await readYaml(WORKFLOW_PATH));
    const { step } = summaryAndCheckout(copy);
    const env = step["env"];
    assert(isRecord(env), "PR-summary step must have an env block");
    env["HEAD_REF"] = "${{ github.event.pull_request.head.ref }}";
    assertOnlyProblem(prSummaryCiStepProblems(copy), "env.HEAD_REF");
  },
);

Deno.test(
  "the PR-summary step must not interpolate a ref into run (Issue #3768)",
  async () => {
    const copy = structuredClone(await readYaml(WORKFLOW_PATH));
    const { step } = summaryAndCheckout(copy);
    step["run"] = String(step["run"]).replace(
      "set -euo pipefail\n",
      'set -euo pipefail\necho "${{ github.head_ref }}"\n',
    );
    assertOnlyProblem(prSummaryCiStepProblems(copy), "interpolates");
  },
);

Deno.test(
  "the PR-summary step must not append || true (Issue #3768)",
  async () => {
    const copy = structuredClone(await readYaml(WORKFLOW_PATH));
    const { step } = summaryAndCheckout(copy);
    step["run"] = `${String(step["run"]).trimEnd()} || true\n`;
    assertOnlyProblem(prSummaryCiStepProblems(copy), "|| true");
  },
);

Deno.test(
  "the PR-summary step must not set continue-on-error: true (Issue #3768)",
  async () => {
    const copy = structuredClone(await readYaml(WORKFLOW_PATH));
    const { step } = summaryAndCheckout(copy);
    step["continue-on-error"] = true;
    assertOnlyProblem(prSummaryCiStepProblems(copy), "continue-on-error");
  },
);

Deno.test(
  "the validate job's checkout must keep fetch-depth: 0 (Issue #3768)",
  async () => {
    const copy = structuredClone(await readYaml(WORKFLOW_PATH));
    const { checkout } = summaryAndCheckout(copy);
    const withBlock = checkout["with"];
    assert(isRecord(withBlock), "checkout step must have a with block");
    delete withBlock["fetch-depth"];
    assertOnlyProblem(prSummaryCiStepProblems(copy), "fetch-depth");
  },
);

Deno.test(
  "quality.yml's gate job needs validate-scripts, so the PR-summary step gates the PR (Issue #3768)",
  async () => {
    const quality = await readYaml(QUALITY_PATH);
    assert(isRecord(quality), `${QUALITY_PATH} must parse as a map`);
    const jobs = quality["jobs"];
    assert(isRecord(jobs), `${QUALITY_PATH} must declare jobs`);

    const caller = jobs["validate-scripts"];
    assert(isRecord(caller), `${QUALITY_PATH} must call validate-scripts`);
    const uses = caller["uses"];
    assertEquals(
      typeof uses === "string" && uses.endsWith(WORKFLOW_PATH),
      true,
      `${QUALITY_PATH} validate-scripts job must call ${WORKFLOW_PATH}`,
    );

    const gate = jobs["gate"];
    assert(isRecord(gate), `${QUALITY_PATH} must declare a gate job`);
    const needs = gate["needs"];
    assert(Array.isArray(needs), "gate job must declare needs");
    assertEquals(
      needs.includes("validate-scripts"),
      true,
      `gate must need validate-scripts (Issue #3768); got: ${
        JSON.stringify(needs)
      }`,
    );
  },
);
