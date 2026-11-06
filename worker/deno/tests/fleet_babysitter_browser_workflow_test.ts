import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

const WORKFLOW = new URL(
  "../../../.github/workflows/validate-scripts.yml",
  import.meta.url,
);
const GATE = new URL("../../../.github/scripts/gate.sh", import.meta.url);

type YamlMap = Record<string, unknown>;

function map(value: unknown): YamlMap {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as YamlMap
    : {};
}

function babysitterBrowserWorkflowProblems(source: string): string[] {
  const workflow = map(parseYaml(source));
  const jobs = map(workflow.jobs);
  const browser = map(jobs["babysitter-browser"]);
  const browserSteps = Array.isArray(browser.steps)
    ? browser.steps.map(map)
    : [];
  const problems: string[] = [];
  if (browser["runs-on"] !== "macos-15") {
    problems.push("babysitter-browser must run on the native macOS runner");
  }
  if (
    !browserSteps.some((step) =>
      typeof step.run === "string" &&
      step.run.includes("deno task test:browser < /dev/null") &&
      step.run.includes('test -x "$CHROMIUM_PATH"') &&
      step["continue-on-error"] !== true
    )
  ) {
    problems.push(
      "babysitter-browser must execute the required browser integration and fail on error",
    );
  }
  if (
    !browserSteps.some((step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("denoland/setup-deno@")
    )
  ) {
    problems.push("babysitter-browser must install the pinned Deno toolchain");
  }
  const aggregate = map(jobs["babysitter-browser-gate"]);
  const needs = Array.isArray(aggregate.needs)
    ? aggregate.needs.map(String)
    : [];
  const gateSteps = Array.isArray(aggregate.steps)
    ? aggregate.steps.map(map)
    : [];
  const gateStep = gateSteps.find((step) =>
    step.run === ".github/scripts/gate.sh"
  );
  const gateEnv = map(gateStep?.env);
  if (
    aggregate.if !== "always()" || !needs.includes("validate") ||
    !needs.includes("babysitter-browser") ||
    aggregate["continue-on-error"] === true || !gateStep ||
    gateStep["continue-on-error"] === true ||
    (gateStep.if !== undefined && gateStep.if !== "always()") ||
    gateEnv.NEEDS_JSON !== "${{ toJSON(needs) }}"
  ) {
    problems.push(
      "babysitter-browser-gate must fail closed on skipped or unsuccessful validation jobs",
    );
  }
  return problems;
}

Deno.test("validate-scripts requires the native macOS browser and containment task", async () => {
  const source = await Deno.readTextFile(WORKFLOW);
  assertEquals(babysitterBrowserWorkflowProblems(source), []);
});

Deno.test("browser workflow validator rejects a missing or skippable macOS check", async () => {
  const workflow = map(parseYaml(await Deno.readTextFile(WORKFLOW)));
  const jobs = map(workflow.jobs);
  const browser = map(jobs["babysitter-browser"]);
  const steps = (browser.steps as unknown[]).map((step) => ({ ...map(step) }));
  const runStep = steps.find((step) => typeof step.run === "string")!;

  const noBrowser = structuredClone(workflow);
  delete map(noBrowser.jobs)["babysitter-browser"];
  assert(
    babysitterBrowserWorkflowProblems(JSON.stringify(noBrowser)).some((
      problem,
    ) => problem.includes("native macOS runner")),
  );

  const skippedCheck = structuredClone(workflow);
  const skippedSteps = map(map(skippedCheck.jobs)["babysitter-browser"])
    .steps as unknown[];
  const skippedRun = skippedSteps.map(map).find((step) =>
    typeof step.run === "string"
  )!;
  skippedRun["continue-on-error"] = true;
  assert(
    babysitterBrowserWorkflowProblems(JSON.stringify(skippedCheck)).some((
      problem,
    ) => problem.includes("execute the required browser integration")),
  );

  const skippedAggregate = structuredClone(workflow);
  map(map(skippedAggregate.jobs)["babysitter-browser-gate"]).if = "false";
  assert(
    babysitterBrowserWorkflowProblems(JSON.stringify(skippedAggregate)).some((
      problem,
    ) => problem.includes("fail closed")),
  );

  const toleratedGate = structuredClone(workflow);
  map(map(toleratedGate.jobs)["babysitter-browser-gate"])[
    "continue-on-error"
  ] = true;
  assert(
    babysitterBrowserWorkflowProblems(JSON.stringify(toleratedGate)).some((
      problem,
    ) => problem.includes("fail closed")),
  );

  const skippedGateStep = structuredClone(workflow);
  const gateStep = map(map(skippedGateStep.jobs)["babysitter-browser-gate"])
    .steps as unknown[];
  const command = gateStep.map(map).find((step) =>
    step.run === ".github/scripts/gate.sh"
  )!;
  command.if = "false";
  assert(
    babysitterBrowserWorkflowProblems(JSON.stringify(skippedGateStep)).some((
      problem,
    ) => problem.includes("fail closed")),
  );

  const missingNeeds = structuredClone(workflow);
  const gateJob = map(map(missingNeeds.jobs)["babysitter-browser-gate"]);
  const gateCommand = (gateJob.steps as unknown[]).map(map).find((step) =>
    step.run === ".github/scripts/gate.sh"
  )!;
  delete map(gateCommand.env).NEEDS_JSON;
  assert(
    babysitterBrowserWorkflowProblems(JSON.stringify(missingNeeds)).some((
      problem,
    ) => problem.includes("fail closed")),
  );
  assert(typeof runStep.run === "string");
});

Deno.test("aggregate gate rejects skipped browser checks and accepts two passes", async () => {
  const gate = async (browser: string) => {
    const result = await new Deno.Command("bash", {
      args: [GATE.pathname],
      env: {
        NEEDS_JSON: JSON.stringify({
          validate: { result: "success" },
          "babysitter-browser": { result: browser },
        }),
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: result.success,
      output: new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    };
  };

  const skipped = await gate("skipped");
  assertEquals(skipped.success, false);
  assert(skipped.output.includes("babysitter-browser=skipped"));
  const failed = await gate("failure");
  assertEquals(failed.success, false);
  assert(failed.output.includes("babysitter-browser=failure"));
  const passed = await gate("success");
  assertEquals(passed.success, true, passed.output);
});
