/**
 * Tests for the AWS Emulator CloudFormation CI workflow (Issue #5110).
 *
 * Parses the real `.github/workflows/aws-emulator.yml` and `quality.yml`, and exercises the
 * pure checker against mutated copies of its YAML text. Each negative
 * mutation breaks exactly one invariant and must produce exactly the named
 * finding; each mutation's anchor must occur exactly once, so a stale anchor
 * fails loud rather than silently testing the unmutated file.
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  checkAwsEmulatorWorkflow,
  checkQualityCallsAwsEmulator,
} from "../lib/aws_emulator_workflow_check.ts";

const WORKFLOW_PATH =
  new URL("../../../.github/workflows/aws-emulator.yml", import.meta.url)
    .pathname;
const SCRIPT_PATH =
  new URL("../../../infra/cloudformation/test-aws-emulator.sh", import.meta.url)
    .pathname;

const REAL = Deno.readTextFileSync(WORKFLOW_PATH);

/**
 * Replace each `from` with `to` in the real YAML text. Every `from` must occur
 * exactly once, so a mutation whose anchor has drifted fails rather than
 * passing against the unmutated file.
 */
function mutate(...pairs: [string, string][]): string {
  let text = REAL;
  for (const [from, to] of pairs) {
    const occurrences = text.split(from).length - 1;
    assertEquals(
      occurrences,
      1,
      `anchor must occur exactly once, found ${occurrences}: ${
        JSON.stringify(from)
      }`,
    );
    text = text.replace(from, to);
  }
  return text;
}

function problemsOf(text: string): string[] {
  return checkAwsEmulatorWorkflow(parseYaml(text));
}

/** Assert the findings are exactly one per needle, each naming that needle. */
function expectFindings(text: string, needles: string[]) {
  const problems = problemsOf(text);
  assertEquals(
    problems.length,
    needles.length,
    `expected ${needles.length} finding(s), got: ${JSON.stringify(problems)}`,
  );
  needles.forEach((needle, i) => {
    assert(
      problems[i]?.includes(needle),
      `finding ${i} "${problems[i]}" lacks "${needle}"`,
    );
  });
}

const TEST_STEP_ANCHOR =
  "\n          ./infra/cloudformation/test-aws-emulator.sh\n";
const TEST_STEP_NAME =
  "      - name: Test CloudFormation templates against AWS Emulator\n";
const TOOLCHAIN_ANCHOR = "bash container/toolchains/aws-emulator.sh";
const CLI_TOOLCHAIN_ANCHOR = "bash container/toolchains/aws-cli.sh";
const RUNNER_INSTALL_ANCHOR =
  "sudo install -m 0755 container/aws-emulator-run.sh /usr/local/bin/aws-emulator-run";

Deno.test("real aws-emulator.yml passes every check", () => {
  assertEquals(problemsOf(REAL), []);
});

Deno.test("test-aws-emulator.sh exists and is executable", () => {
  const mode = Deno.statSync(SCRIPT_PATH).mode ?? 0;
  assert((mode & 0o111) !== 0, "test-aws-emulator.sh must be executable");
});

// (a) the test script runs in command position and fails the job.

Deno.test("(a) accepts the script invoked through bash", () => {
  expectFindings(
    mutate([
      TEST_STEP_ANCHOR,
      "\n          bash infra/cloudformation/test-aws-emulator.sh\n",
    ]),
    [],
  );
});

Deno.test("(a) refuses a script call followed by || true", () => {
  expectFindings(
    mutate([
      TEST_STEP_ANCHOR,
      "\n          ./infra/cloudformation/test-aws-emulator.sh || true\n",
    ]),
    ["[test-step] no step runs"],
  );
});

Deno.test("(a) refuses a script mentioned only in an echo", () => {
  expectFindings(
    mutate([
      TEST_STEP_ANCHOR,
      "\n          echo ./infra/cloudformation/test-aws-emulator.sh\n",
    ]),
    ["[test-step] no step runs"],
  );
});

Deno.test("(a) refuses the call wrapped in an if false; then ... fi block", () => {
  expectFindings(
    mutate([
      TEST_STEP_ANCHOR,
      "\n          if false; then\n            ./infra/cloudformation/test-aws-emulator.sh\n          fi\n",
    ]),
    ["[test-step] no step runs"],
  );
});

Deno.test("(a) refuses an exit 0 before the call", () => {
  expectFindings(
    mutate([
      TEST_STEP_ANCHOR,
      "\n          exit 0\n          ./infra/cloudformation/test-aws-emulator.sh\n",
    ]),
    ["[test-step] the infra/cloudformation/test-aws-emulator.sh step must run only"],
  );
});

for (
  const [label, tail] of [
    ["; true after the call", "; true"],
    ["a backgrounded call", " &"],
    ["a pipe to tee", " | tee log.txt"],
    ["&& echo done after the call", " && echo done"],
  ] as const
) {
  Deno.test(`(a) refuses ${label}`, () => {
    expectFindings(
      mutate([
        TEST_STEP_ANCHOR,
        "\n          ./infra/cloudformation/test-aws-emulator.sh" + tail + "\n",
      ]),
      ["[test-step] no step runs"],
    );
  });
}

// PR #5276 review: `!` inverts the script's failure to exit 0 and is exempt
// from errexit, so a negated call must not count as running the script.
for (
  const [label, prefix] of [
    ["a negated call", "! "],
    ["a negated call after time", "time ! "],
    ["a call under until, which retries a failure", "until "],
    ["a call as a while condition", "while "],
    ["a call as an if condition", "if "],
  ] as const
) {
  Deno.test(`(a) refuses ${label}`, () => {
    expectFindings(
      mutate([
        TEST_STEP_ANCHOR,
        "\n          set -euo pipefail\n          " + prefix +
        "./infra/cloudformation/test-aws-emulator.sh\n",
      ]),
      ["[test-step] no step runs"],
    );
  });
}

Deno.test("(a) accepts the normal call after set -euo pipefail (control for the negated cases)", () => {
  expectFindings(
    mutate([
      TEST_STEP_ANCHOR,
      "\n          set -euo pipefail\n          ./infra/cloudformation/test-aws-emulator.sh\n",
    ]),
    [],
  );
});

Deno.test("(b) refuses a negated pinned install, which would swallow a checksum failure", () => {
  expectFindings(
    mutate([TOOLCHAIN_ANCHOR, "! " + TOOLCHAIN_ANCHOR]),
    ["[pinned-install] no step runs"],
  );
});

Deno.test("(a) refuses the call only in a comment line", () => {
  expectFindings(
    mutate([
      TEST_STEP_ANCHOR,
      "\n          # ./infra/cloudformation/test-aws-emulator.sh\n",
    ]),
    ["[test-step] no step runs"],
  );
});

Deno.test("(a) accepts an explicit continue-on-error: false on the test step", () => {
  expectFindings(
    mutate([
      TEST_STEP_NAME,
      TEST_STEP_NAME + "        continue-on-error: false\n",
    ]),
    [],
  );
});

Deno.test("(d) accepts a workflow parsed with the YAML 1.1 true key in place of on", () => {
  const parsed = parseYaml(REAL) as Record<string, unknown>;
  assert(parsed.on !== undefined, "real workflow must have an on key");
  const { on, ...rest } = parsed;
  assertEquals(checkAwsEmulatorWorkflow({ ...rest, "true": on }), []);
});

Deno.test("(a) refuses continue-on-error on the test step", () => {
  expectFindings(
    mutate([
      TEST_STEP_NAME,
      TEST_STEP_NAME + "        continue-on-error: true\n",
    ]),
    ["[test-step] continue-on-error"],
  );
});

Deno.test("(a) refuses continue-on-error on the job", () => {
  expectFindings(
    mutate([
      "    timeout-minutes: 25\n",
      "    timeout-minutes: 25\n    continue-on-error: true\n",
    ]),
    ["[test-step] continue-on-error"],
  );
});

Deno.test("(a) refuses an if: on the test step", () => {
  expectFindings(
    mutate([TEST_STEP_NAME, TEST_STEP_NAME + "        if: false\n"]),
    ["[test-step] an if:"],
  );
});

Deno.test("(a) refuses an if: on the job", () => {
  expectFindings(
    mutate([
      "    timeout-minutes: 25\n",
      "    timeout-minutes: 25\n    if: false\n",
    ]),
    ["[test-step] an if: on job cloudformation"],
  );
});

// (b) the pinned install and the runner install precede the test step.

Deno.test("(b) refuses the test step placed before the install steps", () => {
  const install = REAL.indexOf(
    "      - name: Install the pinned AWS Emulator\n",
  );
  const check = REAL.indexOf("      - name: Install the pinned AWS CLI\n");
  const test = REAL.indexOf(TEST_STEP_NAME);
  assert(
    install > 0 && check > install && test > check,
    "anchors out of order",
  );
  const reordered = REAL.slice(0, install) + REAL.slice(test) +
    REAL.slice(install, test);
  expectFindings(reordered, [
    "[pinned-install] ",
    "[pinned-cli] ",
    "[runner-install] ",
  ]);
});

Deno.test("(b) refuses a missing pinned install", () => {
  expectFindings(mutate([TOOLCHAIN_ANCHOR, "true"]), [
    "[pinned-install] no step runs",
  ]);
});

Deno.test("(b) refuses the pinned install with || true, which would swallow a checksum failure", () => {
  expectFindings(
    mutate([TOOLCHAIN_ANCHOR, TOOLCHAIN_ANCHOR + " || true"]),
    // The runner install shares that step, so the whole step stops counting.
    ["[pinned-install] no step runs", "[runner-install] no step installs"],
  );
});

Deno.test("(b) refuses a missing pinned aws-cli install (Issue #5110: CI must not use the runner's CLI)", () => {
  expectFindings(mutate([CLI_TOOLCHAIN_ANCHOR, "true"]), [
    "[pinned-cli] no step runs",
  ]);
});

Deno.test("(b) refuses a missing runner install", () => {
  expectFindings(
    mutate([RUNNER_INSTALL_ANCHOR, "true"]),
    ["[runner-install] no step installs"],
  );
});

// (c) no services, no docker socket, no Floci.

Deno.test("(c) refuses a services block", () => {
  expectFindings(
    mutate([
      "    steps:\n      - name: Checkout code",
      "    services:\n      registry:\n        image: alpine:3\n" +
      "    steps:\n      - name: Checkout code",
    ]),
    ["[no-services]"],
  );
});

Deno.test("(c) refuses a step that mentions the docker socket", () => {
  expectFindings(
    mutate([
      "          aws --version\n",
      "          aws --version\n          ls /var/run/docker.sock\n",
    ]),
    ["[no-docker-socket]"],
  );
});

Deno.test("(c) refuses a step that references Floci", () => {
  expectFindings(
    mutate([
      "          aws --version\n",
      "          aws --version\n          echo floci\n",
    ]),
    ["[no-floci]"],
  );
});

// (d) called from quality.yml: workflow_call, no pull_request, no concurrency.

Deno.test("(d) refuses a missing workflow_call trigger", () => {
  expectFindings(
    mutate(["  workflow_call:\n", ""]),
    ["[triggers] on.workflow_call must be present"],
  );
});

Deno.test("(d) refuses a re-added pull_request trigger with a paths filter", () => {
  expectFindings(
    mutate([
      "  workflow_call:\n",
      "  workflow_call:\n  pull_request:\n    paths:\n      - 'infra/cloudformation/**'\n",
    ]),
    [
      "[triggers] on.pull_request must be absent: a standalone pull_request run is not part of quality.yml's gate",
    ],
  );
});

Deno.test("(d) refuses a top-level concurrency block", () => {
  expectFindings(
    mutate([
      "\njobs:\n",
      "\nconcurrency:\n  group: x\n  cancel-in-progress: true\n\njobs:\n",
    ]),
    ["[no-concurrency]"],
  );
});

// quality.yml calls this workflow and its gate job needs the call.

const QUALITY = Deno.readTextFileSync(
  new URL("../../../.github/workflows/quality.yml", import.meta.url).pathname,
);

function qualityMutated(from: string, to: string): unknown {
  const occurrences = QUALITY.split(from).length - 1;
  assertEquals(
    occurrences,
    1,
    `anchor must occur exactly once, found ${occurrences}: ${
      JSON.stringify(from)
    }`,
  );
  return parseYaml(QUALITY.replace(from, to));
}

Deno.test("real quality.yml calls aws-emulator.yml and gate needs it", () => {
  assertEquals(checkQualityCallsAwsEmulator(parseYaml(QUALITY)), []);
});

Deno.test("(gate-needs) refuses a gate that does not need aws-emulator", () => {
  const findings = checkQualityCallsAwsEmulator(
    qualityMutated("      - aws-emulator\n", ""),
  );
  assertEquals(findings.length, 1);
  assert(findings[0]?.startsWith("[gate-needs]"), findings[0]);
});

Deno.test("(gate-call) refuses a quality.yml without the aws-emulator caller job", () => {
  const start = QUALITY.indexOf("  aws-emulator:\n");
  const end = QUALITY.indexOf("  gate:\n");
  assert(start > 0 && end > start, "anchors out of order");
  const findings = checkQualityCallsAwsEmulator(
    parseYaml(QUALITY.slice(0, start) + QUALITY.slice(end)),
  );
  assertEquals(findings.length, 1);
  assert(findings[0]?.startsWith("[gate-call]"), findings[0]);
});

Deno.test("checkQualityCallsAwsEmulator reports non-object input without throwing", () => {
  assertEquals(checkQualityCallsAwsEmulator(null), [
    "quality workflow is not an object",
  ]);
  assertEquals(checkQualityCallsAwsEmulator("nope").length, 1);
});

// (e) least-privilege token.

Deno.test("(e) refuses permissions.contents: write", () => {
  expectFindings(
    mutate([
      "permissions:\n  contents: read",
      "permissions:\n  contents: write",
    ]),
    ["[permissions] top-level permissions.contents must be read"],
  );
});

// (f) checkout must not persist credentials.

Deno.test("(f) refuses checkout without persist-credentials: false", () => {
  expectFindings(
    mutate(["        with:\n          persist-credentials: false\n", ""]),
    ["[checkout-credentials] actions/checkout step must set with.persist-credentials: false"],
  );
});

Deno.test("checkAwsEmulatorWorkflow reports non-object input without throwing", () => {
  assertEquals(checkAwsEmulatorWorkflow(null), ["workflow is not an object"]);
  assertEquals(checkAwsEmulatorWorkflow("nope").length, 1);
});
