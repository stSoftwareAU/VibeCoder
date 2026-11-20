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
  checkContainerBuildRunsAwsEmulator,
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
  return mutateText(REAL, ...pairs);
}

/** `mutate` against any base text (the exactly-once anchor check applies). */
function mutateText(base: string, ...pairs: [string, string][]): string {
  let text = base;
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

// PR #5276 review: a shell that only parses or never runs the body would pass
// the step without deploying anything.
for (
  const [label, shell] of [
    ["bash -n {0}", "bash -n {0}"],
    ["bash -o noexec {0}", "bash -o noexec {0}"],
    ["sh -n {0}", "sh -n {0}"],
    ["true {0}", "true {0}"],
    ["python {0}", "python {0}"],
    ["bash -c true {0}", "bash -c true {0}"],
    ["sh -c true {0}", "sh -c true {0}"],
    ["bash -s {0}", "bash -s {0}"],
    ["bash --version {0}", "bash --version {0}"],
  ] as const
) {
  Deno.test(`(a) refuses shell: ${label} on the test step`, () => {
    expectFindings(
      mutate([TEST_STEP_NAME, TEST_STEP_NAME + `        shell: ${shell}\n`]),
      ["[test-step] the infra/cloudformation/test-aws-emulator.sh step's shell"],
    );
  });
}

Deno.test("(a) refuses a job-level defaults.run.shell of bash -n {0}", () => {
  expectFindings(
    mutate([
      "    timeout-minutes: 25\n",
      "    timeout-minutes: 25\n    defaults:\n      run:\n        shell: bash -n {0}\n",
    ]),
    ["[test-step] the infra/cloudformation/test-aws-emulator.sh step's shell"],
  );
});

Deno.test("(a) refuses a workflow-level defaults.run.shell of bash -n {0}", () => {
  expectFindings(
    mutate([
      "\njobs:\n",
      "\ndefaults:\n  run:\n    shell: bash -n {0}\n\njobs:\n",
    ]),
    ["[test-step] the infra/cloudformation/test-aws-emulator.sh step's shell"],
  );
});

Deno.test("(a) accepts shell: bash and the GitHub default bash form", () => {
  for (
    const shell of [
      "bash",
      "bash --noprofile --norc -eo pipefail {0}",
      "bash -eo pipefail {0}",
    ]
  ) {
    expectFindings(
      mutate([TEST_STEP_NAME, TEST_STEP_NAME + `        shell: ${shell}\n`]),
      [],
    );
  }
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

// container-build.yml runs the reference command as agent in a fresh container.

const CONTAINER_BUILD = Deno.readTextFileSync(
  new URL("../../../.github/workflows/container-build.yml", import.meta.url)
    .pathname,
);
const AGENT_STEP_NAME =
  "      - name: Run the AWS Emulator reference command as agent in a fresh container\n";
const AGENT_STEP_IF = AGENT_STEP_NAME +
  "        if: env.IMAGE_CHANGED == 'true'\n";
const AGENT_USER = "--user agent --volume";
const AGENT_TAIL = 'test-aws-emulator.sh "${IMAGE}" < /dev/null';
const AGENT_DOCKER_LINE =
  '          docker run --rm --user agent --volume "${GITHUB_WORKSPACE}/infra/cloudformation:/workspace/cloudformation:ro" --entrypoint /workspace/cloudformation/test-aws-emulator.sh "${IMAGE}" < /dev/null\n';
const JOB_IMAGE_LINE = "      IMAGE: vibe-coder:ci\n";
const BUILD_STEP_IF = "      - name: Build image with Docker\n" +
  "        if: env.IMAGE_CHANGED == 'true'\n";
const BUILD_TAG =
  'docker build -f /tmp/Containerfile.stripped -t "${IMAGE}" container/\n';

const JOB_IMAGE_CHANGED_LINE =
  "      IMAGE_CHANGED: ${{ needs.changes.outputs.image }}\n";

/** A new step whose `run:` is `line`, placed just before `anchor`. */
function insertedStepBefore(anchor: string, line: string): string {
  return "      - name: Inserted step\n" +
    "        if: env.IMAGE_CHANGED == 'true'\n" +
    `        run: |\n          ${line}\n` + anchor;
}

/** A new step, just before the agent run, whose `run:` is `line`. */
function insertedStep(line: string): string {
  return "      - name: Inserted step\n" +
    "        if: env.IMAGE_CHANGED == 'true'\n" +
    `        run: |\n          ${line}\n` + AGENT_STEP_NAME;
}

Deno.test("real container-build.yml runs the reference command as agent", () => {
  assertEquals(
    checkContainerBuildRunsAwsEmulator(parseYaml(CONTAINER_BUILD)),
    [],
  );
});

for (
  const [label, pairs] of [
    ["--user vibe", [[AGENT_USER, "--user vibe --volume"]]],
    ["a trailing || true", [[AGENT_TAIL, AGENT_TAIL + " || true"]]],
    ["if: false", [[AGENT_STEP_IF, AGENT_STEP_NAME + "        if: false\n"]]],
    [
      "continue-on-error: true",
      [[AGENT_STEP_IF, AGENT_STEP_IF + "        continue-on-error: true\n"]],
    ],
    [
      "shell: bash -n {0}",
      [[AGENT_STEP_IF, AGENT_STEP_IF + "        shell: bash -n {0}\n"]],
    ],
    [
      "a different entrypoint script",
      [[
        "--entrypoint /workspace/cloudformation/test-aws-emulator.sh",
        "--entrypoint /workspace/cloudformation/other.sh",
      ]],
    ],
    [
      "a negated docker line",
      [[AGENT_DOCKER_LINE, "          ! " + AGENT_DOCKER_LINE.trimStart()]],
    ],
    [
      "an extra --entrypoint after the real one",
      [[
        'test-aws-emulator.sh "${IMAGE}"',
        'test-aws-emulator.sh --entrypoint /bin/true "${IMAGE}"',
      ]],
    ],
    ["an extra --user root after --user agent", [[
      AGENT_USER,
      "--user agent --user root --volume",
    ]]],
    ["a different image", [[
      AGENT_TAIL,
      "test-aws-emulator.sh ubuntu:latest < /dev/null",
    ]]],
    [
      "a mount without :ro",
      [[':/workspace/cloudformation:ro"', ':/workspace/cloudformation"']],
    ],
    [
      "a set +e line before the docker line",
      [[AGENT_DOCKER_LINE, "          set +e\n" + AGENT_DOCKER_LINE]],
    ],
    [
      "a commented-out docker line",
      [[AGENT_DOCKER_LINE, "          # " + AGENT_DOCKER_LINE.trimStart()]],
    ],
    [
      "a help-only wrapper",
      [[
        AGENT_DOCKER_LINE,
        "          timeout --help 30 " + AGENT_DOCKER_LINE.trimStart(),
      ]],
    ],
    [
      "an inline daemon override",
      [[
        AGENT_DOCKER_LINE,
        "          env DOCKER_HOST=unused " + AGENT_DOCKER_LINE.trimStart(),
      ]],
    ],
    [
      "an echo look-alike",
      [[AGENT_DOCKER_LINE, "          echo " + AGENT_DOCKER_LINE.trimStart()]],
    ],
    [
      "shell: bash -c true {0}",
      [[AGENT_STEP_IF, AGENT_STEP_IF + "        shell: bash -c true {0}\n"]],
    ],
    [
      "an extra argument after the image",
      [[AGENT_TAIL, 'test-aws-emulator.sh "${IMAGE}" --help < /dev/null']],
    ],
    // Verifier evasions on the image (Issue #5110): the step must run the
    // image the job's docker build just tagged.
    [
      "a step-level env IMAGE override",
      [[
        AGENT_STEP_IF,
        AGENT_STEP_IF + "        env:\n          IMAGE: busybox\n",
      ]],
    ],
    [
      "a step-level env that is an expression",
      [[AGENT_STEP_IF, AGENT_STEP_IF + "        env: ${{ fromJSON('{}') }}\n"]],
    ],
    ["no job-level env IMAGE", [[JOB_IMAGE_LINE, ""]]],
    [
      "a build step with its own env IMAGE",
      [[
        BUILD_STEP_IF,
        BUILD_STEP_IF + "        env:\n          IMAGE: other:tag\n",
      ]],
    ],
    ["a build step tagging another image", [[
      BUILD_TAG,
      '-t "other:tag" container/',
    ]]],
    [
      "a later step retagging ${IMAGE}",
      [[AGENT_STEP_NAME, insertedStep('docker tag busybox "${IMAGE}"')]],
    ],
    [
      "a later step retagging the job's literal tag",
      [[
        AGENT_STEP_NAME,
        insertedStep("docker pull busybox && docker tag busybox vibe-coder:ci"),
      ]],
    ],
    [
      "a later step writing GITHUB_ENV",
      [[
        AGENT_STEP_NAME,
        insertedStep('echo "IMAGE=busybox" >> "$GITHUB_ENV"'),
      ]],
    ],
    // Verifier evasions on the mount (Issue #5110): exactly one volume, and
    // the entrypoint is the script inside it.
    [
      "a second volume shadowing the entrypoint's directory",
      [[
        "--entrypoint /workspace/cloudformation/test-aws-emulator.sh",
        '--volume "${GITHUB_WORKSPACE}/evil:/workspace/cloudformation" --entrypoint /workspace/cloudformation/test-aws-emulator.sh',
      ]],
    ],
    [
      "the reference mount moved aside and a second volume at the entrypoint's directory",
      [[
        ':/workspace/cloudformation:ro"',
        ':/x:ro" --volume "${GITHUB_WORKSPACE}/evil:/workspace/cloudformation"',
      ]],
    ],
    [
      "an entrypoint outside the mounted directory",
      [[
        "--entrypoint /workspace/cloudformation/test-aws-emulator.sh",
        "--entrypoint /usr/local/bin/test-aws-emulator.sh",
      ]],
    ],
    [
      "an entrypoint reached through ..",
      [[
        "--entrypoint /workspace/cloudformation/test-aws-emulator.sh",
        "--entrypoint /workspace/cloudformation/../cloudformation/test-aws-emulator.sh",
      ]],
    ],
    [
      "a volume from another source directory",
      [["/infra/cloudformation:/workspace", "/infra/other:/workspace"]],
    ],
    ["a mount mode other than :ro", [[
      ':/workspace/cloudformation:ro"',
      ':/workspace/cloudformation:ro,z"',
    ]]],
    [
      "a --mount flag",
      [[
        "--entrypoint /workspace/cloudformation/test-aws-emulator.sh",
        "--mount type=bind,src=/tmp,dst=/workspace/cloudformation --entrypoint /workspace/cloudformation/test-aws-emulator.sh",
      ]],
    ],
    [
      "an --env BASH_ENV for the bash script",
      [[AGENT_USER, "--user agent --env BASH_ENV=/tmp/x --volume"]],
    ],
    // Spec reviewer's evasions (Issue #5110): no env on the run step, no
    // GITHUB_ENV/GITHUB_PATH anywhere in the job, a real IMAGE_CHANGED gate
    // and a system bash/sh.
    [
      "a step-level env BASH_ENV",
      [[
        AGENT_STEP_IF,
        AGENT_STEP_IF + "        env:\n          BASH_ENV: /tmp/x\n",
      ]],
    ],
    [
      "a step-level env DOCKER_HOST",
      [[
        AGENT_STEP_IF,
        AGENT_STEP_IF +
        "        env:\n          DOCKER_HOST: unix:///tmp/fake.sock\n",
      ]],
    ],
    [
      "an earlier step writing GITHUB_PATH",
      [[
        BUILD_STEP_IF.split("\n")[0] + "\n",
        insertedStepBefore(
          BUILD_STEP_IF.split("\n")[0] + "\n",
          'echo /tmp/f >> "$GITHUB_PATH"',
        ),
      ]],
    ],
    [
      "a step before the build writing GITHUB_ENV",
      [[
        BUILD_STEP_IF.split("\n")[0] + "\n",
        insertedStepBefore(
          BUILD_STEP_IF.split("\n")[0] + "\n",
          'echo IMAGE_CHANGED=false >> "$GITHUB_ENV"',
        ),
      ]],
    ],
    [
      "a job-level env BASH_ENV",
      [[JOB_IMAGE_LINE, JOB_IMAGE_LINE + "      BASH_ENV: /tmp/x\n"]],
    ],
    [
      "a workflow-level env DOCKER_HOST",
      [[
        "permissions:\n  contents: read\n",
        "permissions:\n  contents: read\nenv:\n  DOCKER_HOST: unix:///tmp/fake.sock\n",
      ]],
    ],
    [
      "a constant job IMAGE_CHANGED",
      [[JOB_IMAGE_CHANGED_LINE, "      IMAGE_CHANGED: 'false'\n"]],
    ],
    [
      "shell: /tmp/f/bash {0}",
      [[AGENT_STEP_IF, AGENT_STEP_IF + "        shell: /tmp/f/bash {0}\n"]],
    ],
  ] as [string, [string, string][]][]
) {
  Deno.test(`(container-agent-run) refuses ${label}`, () => {
    const text = mutateText(CONTAINER_BUILD, ...pairs);
    const problems = checkContainerBuildRunsAwsEmulator(parseYaml(text));
    assertEquals(
      problems.length,
      1,
      `expected one finding, got: ${JSON.stringify(problems)}`,
    );
    assert(problems[0]?.startsWith("[container-agent-run]"), problems[0]);
  });
}

const AGENT_ONE_LINE_ARGS = [
  "docker run --rm --user agent",
  '--volume "${GITHUB_WORKSPACE}/infra/cloudformation:/workspace/cloudformation:ro"',
  '--entrypoint /workspace/cloudformation/test-aws-emulator.sh "${IMAGE}" < /dev/null',
];

for (
  const [label, pairs] of [
    ["-u agent", [["--user agent --volume", "-u agent --volume"]]],
    ["--user=agent", [["--user agent --volume", "--user=agent --volume"]]],
    ["shell: /bin/bash -e {0}", [[
      AGENT_STEP_IF,
      AGENT_STEP_IF + "        shell: /bin/bash -e {0}\n",
    ]]],
    ["--volume= and --entrypoint= forms", [
      [
        AGENT_USER + ' "${GITHUB_WORKSPACE}',
        "--user agent --volume=" + '"${GITHUB_WORKSPACE}',
      ],
      [
        "--entrypoint /workspace/cloudformation/test-aws-emulator.sh",
        "--entrypoint=/workspace/cloudformation/test-aws-emulator.sh",
      ],
    ]],
    ["a mount at another absolute directory", [[
      ':/workspace/cloudformation:ro" --entrypoint /workspace/cloudformation/test-aws-emulator.sh',
      ':/opt/cfn:ro" --entrypoint /opt/cfn/test-aws-emulator.sh',
    ]]],
    ["backslash continuations", [[
      AGENT_DOCKER_LINE,
      "          " + AGENT_ONE_LINE_ARGS.join(" \\\n            ") + "\n",
    ]]],
  ] as [string, [string, string][]][]
) {
  Deno.test(`(container-agent-run) accepts ${label}`, () => {
    const text = mutateText(CONTAINER_BUILD, ...pairs);
    assertEquals(checkContainerBuildRunsAwsEmulator(parseYaml(text)), []);
  });
}

for (
  const [label, line] of [
    ["continue-on-error: true", "    continue-on-error: true\n"],
    ["if: false", "    if: false\n"],
  ] as const
) {
  Deno.test(`(container-agent-run) refuses job container with ${label}`, () => {
    const anchor = "  container:\n    needs: changes\n";
    const problems = checkContainerBuildRunsAwsEmulator(
      parseYaml(mutateText(CONTAINER_BUILD, [anchor, anchor + line])),
    );
    assertEquals(problems.length, 1, JSON.stringify(problems));
    assert(problems[0]?.startsWith("[container-agent-run] job container"));
  });
}

const CONTAINER_NEEDS = "  container:\n    needs: changes\n";
const CHANGES_JOB = "  changes:\n";
const CHANGES_OUTPUT_LINE = "      image: ${{ steps.filter.outputs.image }}\n";
const FILTER_BASE_LINE =
  "          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n";
const FILTER_HEAD_LINE =
  "          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n";
const FILTER_ID = "        id: filter\n";
const DETECT_CALL_LINE =
  '          .github/scripts/detect-image-changes.sh "$BASE_SHA" "$HEAD_SHA"\n';
const IMAGE_FALSE_LINE = '          echo "image=false" >> "$GITHUB_OUTPUT"\n';

// The `changes` job feeds IMAGE_CHANGED: if it cannot yield 'true' every image
// step, the agent run included, skips and the required check still passes.
for (
  const [label, pairs, expected] of [
    ["a comment inside the continued image output command", [[
      'echo "image=true" >>',
      'echo "image=true" \\\n            # comment\n            >>',
    ]], "must be exactly"],
    ["a comment inside the continued detect script command", [[
      'detect-image-changes.sh "$BASE_SHA"',
      'detect-image-changes.sh \\\n            # comment\n            "$BASE_SHA"',
    ]], "must be exactly"],
    ["job container without needs: changes", [[
      CONTAINER_NEEDS,
      "  container:\n",
    ]], "job container must need changes"],
    ["job container needing only another job", [[
      CONTAINER_NEEDS,
      "  container:\n    needs: [setup]\n",
    ]], "job container must need changes"],
    ["a constant changes outputs.image", [[
      CHANGES_OUTPUT_LINE,
      "      image: 'false'\n",
    ]], "must set outputs.image"],
    ["job changes with if: false", [[
      CHANGES_JOB,
      CHANGES_JOB + "    if: false\n",
    ]], "job changes must have no if:"],
    ["job changes with continue-on-error: true", [[
      CHANGES_JOB,
      CHANGES_JOB + "    continue-on-error: true\n",
    ]], "job changes must have no if:"],
    [
      "the filter step id renamed",
      [[FILTER_ID, "        id: detect\n"]],
      "must have a step with id: filter",
    ],
    ["the filter step with continue-on-error: true", [[
      FILTER_ID,
      FILTER_ID + "        continue-on-error: true\n",
    ]], "the changes filter step must have no if:"],
    ["the filter step with if: false", [[
      FILTER_ID,
      FILTER_ID + "        if: false\n",
    ]], "the changes filter step must have no if:"],
    ["the filter step writing image=false instead of the script", [[
      DETECT_CALL_LINE,
      IMAGE_FALSE_LINE,
    ]], "must be exactly"],
    ["the filter step writing image=false before the script", [[
      DETECT_CALL_LINE,
      IMAGE_FALSE_LINE + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["the filter step writing image=$x before the script", [[
      DETECT_CALL_LINE,
      '          echo "image=$x" >> "$GITHUB_OUTPUT"\n' + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["the script call behind true ||", [[
      DETECT_CALL_LINE,
      "          true || \\\n  " + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["an unconditional exit 0 before the script call", [[
      DETECT_CALL_LINE,
      "          exit 0\n" + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["a comment backslash before exit 0", [[
      DETECT_CALL_LINE,
      "          # note \\\n          exit 0\n" + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["a comment backslash before true ||", [[
      DETECT_CALL_LINE,
      "          # note \\\n          true ||\n" + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["an assignment prefix on the script call", [[
      DETECT_CALL_LINE,
      "          GITHUB_OUTPUT= " + DETECT_CALL_LINE.trimStart(),
    ]], "must be exactly"],
    ["the script called with HEAD_SHA twice", [[
      DETECT_CALL_LINE,
      '          .github/scripts/detect-image-changes.sh "$HEAD_SHA" "$HEAD_SHA"\n',
    ]], "must be exactly"],
    ["the filter step BASE_SHA taken from the head sha", [[
      FILTER_BASE_LINE,
      "          BASE_SHA: ${{ github.event.pull_request.head.sha }}\n",
    ]], "must set env BASE_SHA to exactly"],
    ["the filter step HEAD_SHA taken from the base sha", [[
      FILTER_HEAD_LINE,
      "          HEAD_SHA: ${{ github.event.pull_request.base.sha }}\n",
    ]], "must set env HEAD_SHA to exactly"],
    ["the filter step with shell: bash -n {0}", [[
      FILTER_ID,
      FILTER_ID + "        shell: bash -n {0}\n",
    ]], "the changes filter step's shell"],
    ["job changes with defaults.run.shell: bash -n {0}", [[
      CHANGES_JOB,
      CHANGES_JOB +
      "    defaults:\n      run:\n        shell: bash -n {0}\n",
    ]], "the changes filter step's shell"],
    ["the filter step writing image=true-x", [[
      DETECT_CALL_LINE,
      '          echo "image=true-x" >> "$GITHUB_OUTPUT"\n' + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["the filter step writing image=true$X", [[
      DETECT_CALL_LINE,
      '          echo "image=true$X" >> "$GITHUB_OUTPUT"\n' + DETECT_CALL_LINE,
    ]], "must be exactly"],
    // The here-document lines are not in the FILTER_CODE allowlist.
    ["the filter step writing an image<<X output through a here-document", [[
      DETECT_CALL_LINE,
      [
        "          cat >> \"$GITHUB_OUTPUT\" <<'OUT'",
        "          image<<X",
        "          false",
        "          X",
        "          OUT",
      ].join("\n") + "\n" + DETECT_CALL_LINE,
    ]], "must be exactly"],
    // An extra echo line is not in the FILTER_CODE allowlist.
    ["the filter step writing an image<< heredoc output", [[
      DETECT_CALL_LINE,
      '          echo "image<<" >> "$GITHUB_OUTPUT"\n' + DETECT_CALL_LINE,
    ]], "must be exactly"],
    // Runtime guards, backgrounding and output redirection (verifier review):
    // each exits 0 in bash with no image output, so the code is allowlisted.
    ["the script call behind a runtime [[ ]] ||", [[
      DETECT_CALL_LINE,
      '          [[ -n "$BASE_SHA" ]] || ' + DETECT_CALL_LINE.trimStart(),
    ]], "must be exactly"],
    ["the script call behind a runtime [[ ]] &&", [[
      DETECT_CALL_LINE,
      '          [[ -z "$HEAD_SHA" ]] && ' + DETECT_CALL_LINE.trimStart(),
    ]], "must be exactly"],
    ["the script call inside an if on the event name", [[
      DETECT_CALL_LINE,
      '          if [[ "${EVENT_NAME}" == "push" ]]; then\n  ' +
      DETECT_CALL_LINE + "          fi\n",
    ]], "must be exactly"],
    ["a guarded exit 0 before the script call", [[
      DETECT_CALL_LINE,
      '          [[ -n "$HEAD_SHA" ]] && exit 0\n' + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["the script call inside an empty for loop", [[
      DETECT_CALL_LINE,
      "          for x in; do\n  " + DETECT_CALL_LINE + "          done\n",
    ]], "must be exactly"],
    ["the script call inside a case that never matches", [[
      DETECT_CALL_LINE,
      '          case "$HEAD_SHA" in nomatch)\n  ' + DETECT_CALL_LINE +
      "          ;; esac\n",
    ]], "must be exactly"],
    ["the script call run in the background", [[
      DETECT_CALL_LINE,
      DETECT_CALL_LINE.trimEnd() + " &\n",
    ]], "must be exactly"],
    ["GITHUB_OUTPUT assigned on its own line", [[
      DETECT_CALL_LINE,
      "          GITHUB_OUTPUT=/dev/null\n" + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["GITHUB_OUTPUT exported", [[
      DETECT_CALL_LINE,
      "          export GITHUB_OUTPUT=/dev/null\n" + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["GITHUB_OUTPUT unset", [[
      DETECT_CALL_LINE,
      "          unset GITHUB_OUTPUT\n" + DETECT_CALL_LINE,
    ]], "must be exactly"],
    ["the filter step setting GITHUB_OUTPUT in its env", [[
      FILTER_HEAD_LINE,
      FILTER_HEAD_LINE + "          GITHUB_OUTPUT: /dev/null\n",
    ]], "the changes filter step's env must set only"],
    ["job changes setting BASH_ENV in its env", [[
      CHANGES_JOB,
      CHANGES_JOB + "    env:\n      BASH_ENV: /tmp/x\n",
    ]], "job changes must set no env:"],
    ["the workflow setting GITHUB_OUTPUT in its env", [[
      "jobs:\n",
      "env:\n  GITHUB_OUTPUT: /dev/null\njobs:\n",
    ]], "workflow must set no env:"],
    ["a GitHub expression inside a filter comment", [[
      DETECT_CALL_LINE,
      "          # ${{ github.event_name }}\n" + DETECT_CALL_LINE,
    ]], "raw code must contain no GitHub expression"],
    ["the workflow setting a git path variable", [[
      "jobs:\n",
      "env:\n  GIT_LITERAL_PATHSPECS: '1'\njobs:\n",
    ]], "workflow must set no env:"],
    ["job changes using a container", [[
      CHANGES_JOB,
      CHANGES_JOB + "    container: ubuntu:latest\n",
    ]], "job changes must set no container:"],
    // Another step in job changes could rewrite the script the filter runs.
    ["a step rewriting the detect script before the filter", [[
      "      - name: Detect image-affecting changes\n",
      "      - run: printf 'exit 0\\n' > .github/scripts/detect-image-changes.sh\n" +
      "      - name: Detect image-affecting changes\n",
    ]], "job changes may have no step but"],
    ["a step writing BASH_ENV to GITHUB_ENV before the filter", [[
      "      - name: Detect image-affecting changes\n",
      '      - run: echo BASH_ENV=/tmp/e >> "$GITHUB_ENV"\n' +
      "      - name: Detect image-affecting changes\n",
    ]], "job changes may have no step but"],
    ["a local action step before the filter", [[
      "      - name: Detect image-affecting changes\n",
      "      - uses: ./.github/actions/x\n" +
      "      - name: Detect image-affecting changes\n",
    ]], "job changes may have no step but"],
    ["job changes setting a harmless-looking env", [[
      CHANGES_JOB,
      CHANGES_JOB + "    env:\n      SHELLOPTS: xtrace\n",
    ]], "job changes must set no env:"],
    ["the workflow env given as an expression", [[
      "jobs:\n",
      "env: ${{ fromJSON(vars.E) }}\njobs:\n",
    ]], "workflow must set no env:"],
    ["an echo of --image=foo before the script call", [[
      DETECT_CALL_LINE,
      '          echo "--image=foo"\n' + DETECT_CALL_LINE,
    ]], "must be exactly"],
  ] as [string, [string, string][], string][]
) {
  Deno.test(`(container-agent-run) refuses ${label}`, () => {
    const problems = checkContainerBuildRunsAwsEmulator(
      parseYaml(mutateText(CONTAINER_BUILD, ...pairs)),
    );
    assertEquals(problems.length, 1, JSON.stringify(problems));
    assert(problems[0]?.startsWith("[container-agent-run]"), problems[0]);
    assert(problems[0]?.includes(expected), problems[0]);
  });
}

Deno.test("(container-agent-run) refuses job changes removed entirely with one finding", () => {
  const start = CONTAINER_BUILD.indexOf(CHANGES_JOB);
  const end = CONTAINER_BUILD.indexOf(CONTAINER_NEEDS);
  assert(start > 0 && end > start, "anchors out of order");
  const problems = checkContainerBuildRunsAwsEmulator(
    parseYaml(mutateText(CONTAINER_BUILD, [
      CONTAINER_BUILD.slice(start, end),
      "",
    ])),
  );
  assertEquals(problems.length, 1, JSON.stringify(problems));
  assert(problems[0]?.startsWith("[container-agent-run]"), problems[0]);
  assert(problems[0]?.includes("job changes must exist"), problems[0]);
});

for (
  const [label, line] of [
    ["an extra comment line", "          # a note\n"],
    ["an extra blank line", "\n"],
  ] as const
) {
  Deno.test(`(container-agent-run) accepts the filter step with ${label}`, () => {
    assertEquals(
      checkContainerBuildRunsAwsEmulator(parseYaml(
        mutateText(CONTAINER_BUILD, [
          DETECT_CALL_LINE,
          line + DETECT_CALL_LINE,
        ]),
      )),
      [],
    );
  });
}

Deno.test("(container-agent-run) accepts the script call split by a backslash continuation", () => {
  assertEquals(
    checkContainerBuildRunsAwsEmulator(parseYaml(
      mutateText(CONTAINER_BUILD, [
        DETECT_CALL_LINE,
        '          .github/scripts/detect-image-changes.sh \\\n            "$BASE_SHA" "$HEAD_SHA"\n',
      ]),
    )),
    [],
  );
});

Deno.test("(container-agent-run) accepts job container with needs in list form", () => {
  assertEquals(
    checkContainerBuildRunsAwsEmulator(parseYaml(
      mutateText(CONTAINER_BUILD, [
        CONTAINER_NEEDS,
        "  container:\n    needs: [changes]\n",
      ]),
    )),
    [],
  );
});

Deno.test("(container-agent-run) refuses the step removed entirely", () => {
  const start = CONTAINER_BUILD.indexOf(AGENT_STEP_NAME);
  const end = CONTAINER_BUILD.indexOf(AGENT_DOCKER_LINE) +
    AGENT_DOCKER_LINE.length;
  assert(start > 0 && end > start, "anchors out of order");
  const step = CONTAINER_BUILD.slice(start, end);
  const problems = checkContainerBuildRunsAwsEmulator(
    parseYaml(mutateText(CONTAINER_BUILD, [step, ""])),
  );
  assertEquals(problems.length, 1, JSON.stringify(problems));
  assert(
    problems[0]?.startsWith("[container-agent-run] no step in job container"),
    problems[0],
  );
});

Deno.test("checkContainerBuildRunsAwsEmulator reports malformed input without throwing", () => {
  assertEquals(checkContainerBuildRunsAwsEmulator(null).length, 1);
  assertEquals(checkContainerBuildRunsAwsEmulator({ jobs: 3 }).length, 1);
  assertEquals(
    checkContainerBuildRunsAwsEmulator({
      jobs: { container: { steps: [1, null] } },
    })
      .length,
    1,
  );
});
