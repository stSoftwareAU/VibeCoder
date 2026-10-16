/**
 * Tests for checkov_workflow_check.ts — the lock-step between the Checkov CI
 * job and the local quality stage (Issue #3653).
 *
 * The real `.github/workflows/checkov.yml` and `quality.yml` must hold every
 * invariant. Each negative test then mutates exactly one thing in that real
 * text, and asserts the one problem that mutation causes.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CHECKOV_WORKFLOW_PATH,
  checkovScanArgs,
} from "../lib/checkov_check.ts";
import {
  QUALITY_WORKFLOW_PATH,
  validateCheckovWorkflows,
} from "../lib/checkov_workflow_check.ts";
import { CHECKOV_IMAGE, CHECKOV_IMAGE_DIGEST } from "../lib/pinned_actions.ts";
import { WORKFLOW_FILE_CHECKS } from "../lib/workflow_file_checks.ts";
import { readWorkflowFiles } from "../lib/workflow_scan_common.ts";

/** Repository root — three levels up from `worker/deno/tests/`. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** The two real workflow files, read as the CI and the gate read them. */
interface RealFiles {
  checkov: string;
  quality: string;
}

async function realFiles(): Promise<RealFiles> {
  return {
    checkov: await Deno.readTextFile(`${REPO_ROOT}/${CHECKOV_WORKFLOW_PATH}`),
    quality: await Deno.readTextFile(`${REPO_ROOT}/${QUALITY_WORKFLOW_PATH}`),
  };
}

/** Replaces the one occurrence of `from`; fails the test when it is not unique. */
function replaceOnce(text: string, from: string, to: string): string {
  const parts = text.split(from);
  assertEquals(
    parts.length - 1,
    1,
    `expected exactly one occurrence of ${JSON.stringify(from)}`,
  );
  return parts.join(to);
}

/** The problem for a scan step that is missing or not the pinned scan. */
const NO_PINNED_SCAN =
  `${CHECKOV_WORKFLOW_PATH}: no step's run invokes the pinned Checkov scan ` +
  `(docker run --entrypoint checkov ${CHECKOV_IMAGE} ` +
  `${checkovScanArgs().join(" ")})`;

/** The problem for a missing judge invocation. */
const NOT_JUDGED =
  `${CHECKOV_WORKFLOW_PATH}: no step runs checkov_report.ts with --report and ` +
  "--checkov-exit, so the report is never judged";

/** The `--skip-download` line that ends the scan arguments in checkov.yml. */
const SCAN_ARGS_END = "--skip-download \\\n";

Deno.test("the real checkov.yml and quality.yml satisfy every Checkov lock-step invariant", async () => {
  const { checkov, quality } = await realFiles();
  assertEquals(validateCheckovWorkflows(checkov, quality), []);
});

Deno.test("the real checkov.yml and quality.yml raise no finding from WORKFLOW_FILE_CHECKS", async () => {
  const wanted = [CHECKOV_WORKFLOW_PATH, QUALITY_WORKFLOW_PATH];
  const files = (await readWorkflowFiles(REPO_ROOT)).filter((file) =>
    wanted.includes(file.path)
  );
  assertEquals(files.map((file) => file.path).sort(), [...wanted].sort());

  const ctx = { defaultBranch: "main" };
  const findings = WORKFLOW_FILE_CHECKS.flatMap((check) =>
    check.run(files, ctx).map((finding) =>
      `${check.id}: ${finding.file}:${finding.line} ${finding.detail}`
    )
  );
  assertEquals(findings, []);
});

// ---------------------------------------------------------------------------
// a. checkov.yml is triggered by workflow_call and nothing else
// ---------------------------------------------------------------------------

Deno.test("invariant a: a pull_request trigger on checkov.yml is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    "  workflow_call:\n",
    "  pull_request:\n  workflow_call:\n",
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: \`on\` must be exactly \`workflow_call\` ` +
    "(found: pull_request, workflow_call)",
  ]);
});

// ---------------------------------------------------------------------------
// b. exactly one step runs the pinned scan
// ---------------------------------------------------------------------------

Deno.test("invariant b: a different image digest is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    CHECKOV_IMAGE_DIGEST,
    `sha256:${"0".repeat(64)}`,
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [NO_PINNED_SCAN]);
});

Deno.test("invariant b: dropping --framework cloudformation is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(checkov, "--framework cloudformation ", "");
  assertEquals(validateCheckovWorkflows(mutated, quality), [NO_PINNED_SCAN]);
});

Deno.test("invariant b: dropping --entrypoint checkov is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(checkov, " --entrypoint checkov \\\n", " \\\n");
  assertEquals(validateCheckovWorkflows(mutated, quality), [NO_PINNED_SCAN]);
});

// ---------------------------------------------------------------------------
// c. the scan step passes no weakening Checkov flag
// ---------------------------------------------------------------------------

Deno.test("invariant c: adding --soft-fail to the scan is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    SCAN_ARGS_END,
    `--skip-download --soft-fail \\\n`,
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: the Checkov scan step passes weakening Checkov flag(s): --soft-fail`,
  ]);
});

Deno.test("invariant c: adding --skip-check CKV_AWS_24 to the scan is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    SCAN_ARGS_END,
    "--skip-download --skip-check CKV_AWS_24 \\\n",
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: the Checkov scan step passes weakening Checkov flag(s): --skip-check`,
  ]);
});

Deno.test("invariant c: the flag= form of a weakening flag is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    SCAN_ARGS_END,
    "--skip-download --check=CKV_AWS_24 \\\n",
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: the Checkov scan step passes weakening Checkov flag(s): --check`,
  ]);
});

Deno.test("invariant c: a quoted weakening flag is still a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    SCAN_ARGS_END,
    '--skip-download "--soft-fail" \\\n',
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: the Checkov scan step passes weakening Checkov flag(s): --soft-fail`,
  ]);
});

Deno.test("positive control: --checkov-exit in the scan step is not mistaken for --check", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    "          status=0\n",
    '          status=0\n          echo "judge: --checkov-exit $status"\n',
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), []);
});

// ---------------------------------------------------------------------------
// d. the judge is invoked, and the scan's exit is captured
// ---------------------------------------------------------------------------

Deno.test("invariant d: dropping --checkov-exit from the judge is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(checkov, ' --checkov-exit "$status"', "");
  assertEquals(validateCheckovWorkflows(mutated, quality), [NOT_JUDGED]);
});

Deno.test("invariant d: removing || status=$? from the scan is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(checkov, " || status=$?", "");
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: the Checkov scan step does not capture its exit with ` +
    "`|| status=$?`, so a failed scan ends the step before " +
    "checkov_report.ts judges it",
  ]);
});

// ---------------------------------------------------------------------------
// e. quality.yml calls checkov.yml, and gate needs that job
// ---------------------------------------------------------------------------

Deno.test("invariant e: dropping - checkov from gate.needs is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    quality,
    "      - semgrep\n      - checkov\n",
    "      - semgrep\n",
  );
  assertEquals(validateCheckovWorkflows(checkov, mutated), [
    `${QUALITY_WORKFLOW_PATH}: jobs.gate.needs does not include checkov`,
  ]);
});

Deno.test("invariant e: no job calling checkov.yml is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    quality,
    "uses: ./.github/workflows/checkov.yml",
    "uses: ./.github/workflows/semgrep.yml",
  );
  assertEquals(validateCheckovWorkflows(checkov, mutated), [
    `${QUALITY_WORKFLOW_PATH}: no job calls ./.github/workflows/checkov.yml`,
  ]);
});

// ---------------------------------------------------------------------------
// f. checkov.yml sets no concurrency key, top level or job level
// ---------------------------------------------------------------------------

/** Why checkov.yml must not set `concurrency`, as the problem states it. */
const CONCURRENCY_WHY =
  "as a called workflow it inherits the caller's github.workflow, " +
  "so its own group would cancel its siblings (quality.yml holds the one group)";

Deno.test("invariant f: a top-level concurrency block in checkov.yml is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    "\njobs:\n",
    "\nconcurrency:\n  group: checkov\n\njobs:\n",
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: top-level \`concurrency\` is not allowed; ` +
    CONCURRENCY_WHY,
  ]);
});

Deno.test("invariant f: a job-level concurrency block in checkov.yml is a problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    "    timeout-minutes: 15\n",
    "    timeout-minutes: 15\n    concurrency:\n      group: checkov\n",
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: job \`checkov\` sets \`concurrency\`, ` +
    `which is not allowed; ${CONCURRENCY_WHY}`,
  ]);
});

// ---------------------------------------------------------------------------
// Unparseable YAML is a problem, never a throw
// ---------------------------------------------------------------------------

Deno.test("unparseable checkov.yml is reported as a problem, not thrown", async () => {
  const { quality } = await realFiles();
  const problems = validateCheckovWorkflows("name: [\n  unclosed", quality);
  const [problem] = problems;
  assertEquals(problems.length, 1);
  assert(
    problem?.startsWith(`${CHECKOV_WORKFLOW_PATH}: not valid YAML (`) === true,
    problem,
  );
});

Deno.test("unparseable quality.yml is reported as a problem, not thrown", async () => {
  const { checkov } = await realFiles();
  const problems = validateCheckovWorkflows(checkov, "jobs: {\n");
  const [problem] = problems;
  assertEquals(problems.length, 1);
  assert(
    problem?.startsWith(`${QUALITY_WORKFLOW_PATH}: not valid YAML (`) === true,
    problem,
  );
});

// ---------------------------------------------------------------------------
// Hostile input: long runs of backslashes and whitespace
// ---------------------------------------------------------------------------

Deno.test("hostile input: a flood of backslashes ending a line is a continuation and raises no false problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    "          status=0\n",
    `          status=0 ${"\\".repeat(100_000)}\n`,
  );
  // Any trailing backslash continues the line, whatever the count. The next
  // line joins after a space, so the scan is still found and nothing is flagged.
  assertEquals(validateCheckovWorkflows(mutated, quality), []);
});

Deno.test("hostile input: a long run of backslashes followed by a non-matching character is one inert word and raises no false problem", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    "          status=0\n",
    `          status=0 ${"\\".repeat(100_001)}x\n`,
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), []);
});

Deno.test("hostile input: a flood of whitespace still exposes a hidden weakening flag", async () => {
  const { checkov, quality } = await realFiles();
  const mutated = replaceOnce(
    checkov,
    SCAN_ARGS_END,
    `--skip-download${" ".repeat(100_000)}--soft-fail \\\n`,
  );
  assertEquals(validateCheckovWorkflows(mutated, quality), [
    `${CHECKOV_WORKFLOW_PATH}: the Checkov scan step passes weakening Checkov flag(s): --soft-fail`,
  ]);
});
