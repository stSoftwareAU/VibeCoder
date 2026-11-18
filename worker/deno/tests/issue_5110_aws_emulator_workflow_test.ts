/**
 * Tests for the AWS Emulator CloudFormation CI workflow (Issue #5110).
 *
 * Parses the real `.github/workflows/aws-emulator.yml`, and exercises the
 * pure checker against mutated copies of its YAML text. Each negative
 * mutation breaks exactly one invariant and must produce exactly the named
 * finding; each mutation's anchor must occur exactly once, so a stale anchor
 * fails loud rather than silently testing the unmutated file.
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { checkAwsEmulatorWorkflow } from "../lib/aws_emulator_workflow_check.ts";

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

// (b) the pinned install and the runner install precede the test step.

Deno.test("(b) refuses the test step placed before the install steps", () => {
  const install = REAL.indexOf(
    "      - name: Install the pinned AWS Emulator\n",
  );
  const check = REAL.indexOf("      - name: Check AWS CLI\n");
  const test = REAL.indexOf(TEST_STEP_NAME);
  assert(
    install > 0 && check > install && test > check,
    "anchors out of order",
  );
  const reordered = REAL.slice(0, install) + REAL.slice(test) +
    REAL.slice(install, test);
  expectFindings(reordered, [
    "[pinned-install] ",
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
    ["[pinned-install] no step runs"],
  );
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

// (d) pull_request watches the required paths and targets milestone/*.

Deno.test("(d) refuses a pull_request trigger without milestone/*", () => {
  expectFindings(
    mutate([
      "branches: [Develop, main, 'milestone/*']",
      "branches: [Develop, main]",
    ]),
    ["[triggers] on.pull_request.branches must include milestone/*"],
  );
});

Deno.test("(d) refuses a missing tools.json path", () => {
  expectFindings(
    mutate(["      - 'container/tools.json'\n", ""]),
    ["[triggers] on.pull_request.paths must include container/tools.json"],
  );
});

Deno.test("(d) refuses a missing runner-script path", () => {
  expectFindings(
    mutate(["      - 'container/aws-emulator-run.sh'\n", ""]),
    ["[triggers] on.pull_request.paths must include container/aws-emulator-run.sh"],
  );
});

Deno.test("(d) refuses a missing CloudFormation template path", () => {
  expectFindings(
    mutate(["      - 'infra/cloudformation/**'\n", ""]),
    ["[triggers] on.pull_request.paths must include infra/cloudformation/**"],
  );
});

Deno.test("(d) refuses a missing workflow self-path", () => {
  expectFindings(
    mutate(["      - '.github/workflows/aws-emulator.yml'\n", ""]),
    ["[triggers] on.pull_request.paths must include .github/workflows/aws-emulator.yml"],
  );
});

Deno.test("(d) refuses a missing toolchain-script path", () => {
  expectFindings(
    mutate(["      - 'container/toolchains/aws-emulator.sh'\n", ""]),
    ["[triggers] on.pull_request.paths must include container/toolchains/aws-emulator.sh"],
  );
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
  assertEquals(checkAwsEmulatorWorkflow(null).length, 1);
  assertEquals(checkAwsEmulatorWorkflow("nope").length, 1);
});
