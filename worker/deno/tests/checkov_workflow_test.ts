/**
 * Lock-step guard for the Checkov CI job (Issue #3971).
 *
 * `.github/workflows/checkov.yml` runs the Checkov scan that the local quality
 * gate also runs, and `quality.yml`'s `gate` job must wait for it. This file
 * keeps four things in lock-step, so a drift in any one of them fails the
 * suite:
 *
 *   - `.github/workflows/checkov.yml` (trigger, permissions and the scan step);
 *   - `.github/workflows/quality.yml` (the job that calls it, and `gate.needs`);
 *   - `CHECKOV_IMAGE` (the digest-pinned image, worker/deno/lib/pinned_actions.ts);
 *   - `CHECKOV_SCAN_ARGS` (the scan contract, worker/deno/lib/checkov_report.ts).
 *
 * It also guards the two ways the scan could be narrowed without a flag in the
 * workflow: a `.checkov.yaml` / `.checkov.yml` at the repository root (Checkov
 * loads it on its own), and a deliberately bad fixture template stored under an
 * extension Checkov would discover (the scan carries no `--skip-path`).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { CHECKOV_IMAGE } from "../lib/pinned_actions.ts";
import {
  CHECKOV_SCAN_ARGS,
  findCheckovConfigFiles,
} from "../lib/checkov_report.ts";

const REPO_ROOT = new URL("../../../", import.meta.url);
const CHECKOV_WORKFLOW = new URL(".github/workflows/checkov.yml", REPO_ROOT);
const QUALITY_WORKFLOW = new URL(".github/workflows/quality.yml", REPO_ROOT);

/** The `uses:` value quality.yml gives the Checkov workflow. */
const CHECKOV_USES = "./.github/workflows/checkov.yml";

/** The judge the scan step hands its report to. */
const JUDGE = "worker/deno/lib/checkov_report.ts";

/**
 * Flags that would let the scan pass while findings stay hidden. Matched as
 * whole words in the run text, so `--check` does not match `--checkov`.
 */
const WEAKENING_FLAGS = [
  "--soft-fail",
  "--soft-fail-on",
  "--hard-fail-on",
  "--skip-check",
  "--check",
  "--baseline",
  "--skip-path",
  "--skip-framework",
];

type YamlMap = Record<string, unknown>;

function asMap(value: unknown): YamlMap {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as YamlMap
    : {};
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Joins shell continuations the way bash does (`--soft-\` + `fail` is
 * `--soft-fail`). Deliberately not shared with ci_install_pin_scanner.ts: its
 * private joinContinuations trims each line and inserts a space at the join,
 * giving `--soft- fail`, which would hide the mid-word split tested here.
 */
function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n/g, "");
}

function triggerNames(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(asMap(on));
}

/** The `run:` text of every step, in document order across all jobs. */
function runSteps(workflow: YamlMap): string[] {
  const runs: string[] = [];
  for (const job of Object.values(asMap(workflow["jobs"]))) {
    const steps = asMap(job)["steps"];
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const run = asMap(step)["run"];
      if (typeof run === "string") runs.push(run);
    }
  }
  return runs;
}

/**
 * One human-readable line per way the two workflows have drifted from the
 * image pin, the scan args and the judge contract. An empty list means they
 * are in lock-step.
 */
function lockStepProblems(
  checkovYaml: string,
  qualityYaml: string,
): string[] {
  const problems: string[] = [];
  const checkov = asMap(parseYaml(checkovYaml));
  const quality = asMap(parseYaml(qualityYaml));

  // 1. The only trigger is workflow_call. A YAML 1.1 reader reads `on` as the
  // boolean true, which the object keeps as the key "true", so accept either.
  const on = "on" in checkov ? checkov["on"] : checkov["true"];
  const triggers = triggerNames(on);
  if (triggers.length !== 1 || triggers[0] !== "workflow_call") {
    problems.push(
      `checkov.yml: "on" must be workflow_call only (found: ${
        triggers.join(", ") || "none"
      })`,
    );
  }

  // 2. No concurrency group, at the top level or on any job.
  if ("concurrency" in checkov) {
    problems.push(
      "checkov.yml: a top-level concurrency group is not allowed (it would cancel sibling called workflows)",
    );
  }
  for (const [name, job] of Object.entries(asMap(checkov["jobs"]))) {
    if ("concurrency" in asMap(job)) {
      problems.push(`checkov.yml: job ${name} sets a concurrency group`);
    }
  }

  // 3. Exactly one step runs docker, with the pinned image and the scan args
  // straight after it. The joined run text is what the shell sees, with runs
  // of blanks collapsed so adjacent tokens compare as single spaces.
  const runs = runSteps(checkov).map((run) =>
    joinContinuations(run).replace(/[ \t]+/g, " ")
  );
  const scans = runs.filter((run) => run.includes("docker run"));
  const scan = scans.length === 1 ? scans[0] : undefined;
  if (scan === undefined) {
    problems.push(
      `checkov.yml: expected exactly one step running docker run, found ${scans.length}`,
    );
  } else {
    if (!scan.includes("--entrypoint checkov")) {
      problems.push("checkov.yml: docker run must set --entrypoint checkov");
    }
    if (!scan.split(/\s+/).includes(CHECKOV_IMAGE)) {
      problems.push(
        `checkov.yml: docker run does not use the pinned image ${CHECKOV_IMAGE} as a whole token`,
      );
    }
    const scanArgs = CHECKOV_SCAN_ARGS.join(" ");
    if (!scan.includes(`${CHECKOV_IMAGE} ${scanArgs}`)) {
      problems.push(
        `checkov.yml: docker run must pass the scan args (${scanArgs}) straight after the pinned image`,
      );
    }

    // 5. The exit code is captured, and the judge gets the report and "$status".
    const lines = scan.split("\n");
    const dockerIndex = lines.findIndex((line) => line.includes("docker run"));
    const dockerLine = lines[dockerIndex] ?? "";
    if (!dockerLine.includes("|| status=$?")) {
      problems.push(
        'checkov.yml: docker run must capture its exit code with "|| status=$?"',
      );
    }
    const reportPath = />\s*"([^"]+)"/.exec(dockerLine)?.[1];
    if (reportPath === undefined) {
      problems.push(
        "checkov.yml: docker run must redirect the JSON report to a quoted path",
      );
    } else {
      const judgeLine = lines.slice(dockerIndex + 1).find((line) =>
        line.includes(JUDGE)
      );
      if (judgeLine === undefined) {
        problems.push(
          `checkov.yml: no step hands the report to ${JUDGE} after the scan`,
        );
      } else if (
        !judgeLine.trim().endsWith(`${JUDGE} "${reportPath}" "$status"`)
      ) {
        problems.push(
          `checkov.yml: ${JUDGE} must be called with the report path and the captured exit code "$status"`,
        );
      }
    }
  }

  // 4. No weakening flag anywhere in a run step, whether or not it is split
  // across continuation lines. `--skip-path` is among them with no exception:
  // Checkov matches it by substring, so it would hide more than it names.
  const allRuns = runs.join("\n");
  for (const flag of WEAKENING_FLAGS) {
    const wholeWord = new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?:=|\\s|$)`);
    if (wholeWord.test(allRuns)) {
      problems.push(`checkov.yml: ${flag} weakens the scan and is not allowed`);
    }
  }

  // 6. quality.yml calls the Checkov workflow, and gate waits on that job.
  const qualityJobs = asMap(quality["jobs"]);
  const callers = Object.entries(qualityJobs)
    .filter(([, job]) => asMap(job)["uses"] === CHECKOV_USES)
    .map(([key]) => key);
  if (callers.length === 0) {
    problems.push(`quality.yml: no job calls ${CHECKOV_USES}`);
  } else {
    const needs = asMap(qualityJobs["gate"])["needs"];
    const needed = typeof needs === "string"
      ? [needs]
      : Array.isArray(needs)
      ? needs.map(String)
      : [];
    if (!callers.some((key) => needed.includes(key))) {
      problems.push(
        `quality.yml: gate.needs does not include the checkov job (${
          callers.join(", ")
        })`,
      );
    }
  }

  // 7. No SARIF upload in any job: the verdict is the judge's exit code.
  for (const [name, job] of Object.entries(asMap(checkov["jobs"]))) {
    const steps = asMap(job)["steps"];
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const uses = asMap(step)["uses"];
      if (typeof uses === "string" && uses.includes("upload-sarif")) {
        problems.push(
          `checkov.yml: job ${name} has an upload-sarif step (${uses}), which is not allowed`,
        );
      }
    }
  }

  // 8. No path filter under any trigger, so every call runs the scan and
  // `gate` never waits on a skipped job.
  for (const [trigger, config] of Object.entries(asMap(on))) {
    for (const key of ["paths", "paths-ignore"]) {
      if (key in asMap(config)) {
        problems.push(
          `checkov.yml: "on" must not filter by path (${trigger} sets ${key})`,
        );
      }
    }
  }

  return problems;
}

async function readWorkflows(): Promise<{ checkov: string; quality: string }> {
  return {
    checkov: await Deno.readTextFile(CHECKOV_WORKFLOW),
    quality: await Deno.readTextFile(QUALITY_WORKFLOW),
  };
}

function assertProblem(problems: string[], words: string): void {
  assert(
    problems.some((p) => p.includes(words)),
    `expected a problem mentioning ${JSON.stringify(words)}, got: ${
      JSON.stringify(problems)
    }`,
  );
}

Deno.test("checkov_workflow - checkov.yml and quality.yml are in lock-step", async () => {
  const { checkov, quality } = await readWorkflows();
  assertEquals(lockStepProblems(checkov, quality), []);
});

Deno.test("checkov_workflow - a changed image digest is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace("sha256:3cc125b5", "sha256:3cc125b4");
  assert(fixture !== checkov, "fixture did not change the digest");
  assertProblem(
    lockStepProblems(fixture, quality),
    "does not use the pinned image",
  );
});

Deno.test("checkov_workflow - an added --soft-fail is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(
    "--skip-download",
    "--soft-fail --skip-download",
  );
  assert(fixture !== checkov, "fixture did not add the flag");
  assertProblem(lockStepProblems(fixture, quality), "--soft-fail");
});

Deno.test("checkov_workflow - a weakening flag on its own continuation line is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(
    "--skip-download",
    "--skip-download \\\n            --skip-check CKV_AWS_1",
  );
  assert(fixture !== checkov, "fixture did not add the continuation");
  assertProblem(lockStepProblems(fixture, quality), "--skip-check");
});

Deno.test("checkov_workflow - a weakening flag split mid-word across a continuation is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  // The run block's content indent is 10 spaces, which the YAML parser strips,
  // so the parsed run text reads `--soft-\` newline `fail`.
  const fixture = checkov.replace(
    "--skip-download",
    "--soft-\\\n          fail --skip-download",
  );
  assert(fixture !== checkov, "fixture did not split the flag");
  assertProblem(lockStepProblems(fixture, quality), "--soft-fail");
});

Deno.test("checkov_workflow - checkov removed from gate.needs is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = quality.replace(
    "      - semgrep\n      - checkov\n",
    "      - semgrep\n",
  );
  assert(fixture !== quality, "fixture did not remove checkov from needs");
  assertProblem(lockStepProblems(checkov, fixture), "gate.needs");
});

Deno.test("checkov_workflow - an added pull_request trigger is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(
    "  workflow_call:\n",
    "  workflow_call:\n  pull_request:\n",
  );
  assert(fixture !== checkov, "fixture did not add a trigger");
  assertProblem(lockStepProblems(fixture, quality), "workflow_call only");
});

Deno.test("checkov_workflow - a top-level concurrency block is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(
    "\njobs:\n",
    "\nconcurrency:\n  group: checkov\n\njobs:\n",
  );
  assert(fixture !== checkov, "fixture did not add a concurrency block");
  assertProblem(lockStepProblems(fixture, quality), "top-level concurrency");
});

Deno.test('checkov_workflow - the judge without "$status" is reported', async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(
    '"$RUNNER_TEMP/checkov.json" "$status"',
    '"$RUNNER_TEMP/checkov.json" 0',
  );
  assert(fixture !== checkov, "fixture did not change the judge call");
  assertProblem(lockStepProblems(fixture, quality), "captured exit code");
});

Deno.test("checkov_workflow - removing --entrypoint checkov is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(" --entrypoint checkov", "");
  assert(fixture !== checkov, "fixture did not remove the entrypoint");
  const problems = lockStepProblems(fixture, quality);
  assertProblem(problems, "must set --entrypoint checkov");
  assertEquals(problems.length, 1);
});

Deno.test("checkov_workflow - removing || status=$? is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(" || status=$?", "");
  assert(fixture !== checkov, "fixture did not remove the exit capture");
  const problems = lockStepProblems(fixture, quality);
  assertProblem(problems, "must capture its exit code");
  assertEquals(problems.length, 1);
});

Deno.test("checkov_workflow - an upload-sarif step is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture =
    `${checkov.trimEnd()}\n      - uses: github/codeql-action/upload-sarif@0000000000000000000000000000000000000000\n`;
  assert(fixture !== checkov, "fixture did not add a step");
  const problems = lockStepProblems(fixture, quality);
  assertProblem(problems, "upload-sarif");
  assertEquals(problems.length, 1);
});

Deno.test("checkov_workflow - a path filter under workflow_call is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(
    "  workflow_call:\n",
    '  workflow_call:\n    paths:\n      - "**/*.yaml"\n',
  );
  assert(fixture !== checkov, "fixture did not add a path filter");
  const problems = lockStepProblems(fixture, quality);
  assertProblem(problems, "must not filter by path");
  assertEquals(problems.length, 1);
});

Deno.test("checkov_workflow - an added --skip-path is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(
    "--skip-download",
    "--skip-download --skip-path worker/deno/tests/fixtures/checkov",
  );
  assert(fixture !== checkov, "fixture did not add the skip path");
  assertProblem(
    lockStepProblems(fixture, quality),
    "--skip-path weakens the scan",
  );
});

Deno.test("checkov_workflow - a changed scan arg is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = checkov.replace(
    "--framework cloudformation",
    "--framework terraform",
  );
  assert(fixture !== checkov, "fixture did not change the scan args");
  const problems = lockStepProblems(fixture, quality);
  assertProblem(problems, "must pass the scan args");
  assertEquals(problems.length, 1);
});

Deno.test("checkov_workflow - a missing checkov caller in quality.yml is reported", async () => {
  const { checkov, quality } = await readWorkflows();
  const fixture = quality.replace(
    `uses: ${CHECKOV_USES}`,
    "uses: ./.github/workflows/checkov-moved.yml",
  );
  assert(fixture !== quality, "fixture did not move the caller");
  const problems = lockStepProblems(checkov, fixture);
  assertProblem(problems, `no job calls ${CHECKOV_USES}`);
  assertEquals(problems.length, 1);
});

/** Extensions Checkov's CloudFormation runner reads, besides `.json`. */
const CFN_TEMPLATE_EXTENSIONS = [".yaml", ".yml", ".template"];

/** Files under `dir` (recursively) that the CloudFormation runner would read as templates. */
async function discoverableTemplates(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      found.push(...await discoverableTemplates(path));
    } else if (
      CFN_TEMPLATE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
    ) {
      found.push(path);
    }
  }
  return found;
}

Deno.test("checkov_workflow - the repository root holds no Checkov config file", async () => {
  assertEquals(await findCheckovConfigFiles(REPO_ROOT.pathname), []);
});

Deno.test("checkov_workflow - a Checkov config file at the root is found", async () => {
  const dir = await Deno.makeTempDir({ prefix: "checkov-root-" });
  try {
    await Deno.writeTextFile(
      `${dir}/.checkov.yml`,
      "skip-check: [CKV_AWS_158]",
    );
    assertEquals(await findCheckovConfigFiles(dir), [".checkov.yml"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkov_workflow - the fixture templates are stored where Checkov does not discover them", async () => {
  const fixtures = new URL("worker/deno/tests/fixtures/checkov", REPO_ROOT)
    .pathname;
  const stored: string[] = [];
  for await (const entry of Deno.readDir(fixtures)) {
    if (entry.isDirectory) stored.push(entry.name);
  }
  assert(stored.length > 0, "expected fixture case directories");
  assertEquals(await discoverableTemplates(fixtures), []);
});

Deno.test("checkov_workflow - a fixture template under a discoverable extension is found", async () => {
  const dir = await Deno.makeTempDir({ prefix: "checkov-fixtures-" });
  try {
    await Deno.mkdir(`${dir}/case`);
    await Deno.writeTextFile(`${dir}/case/report.json`, "{}");
    await Deno.writeTextFile(`${dir}/case/template.yaml.fixture`, "");
    assertEquals(await discoverableTemplates(dir), []);
    await Deno.writeTextFile(`${dir}/case/template.yaml`, "");
    assertEquals(await discoverableTemplates(dir), [
      `${dir}/case/template.yaml`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
