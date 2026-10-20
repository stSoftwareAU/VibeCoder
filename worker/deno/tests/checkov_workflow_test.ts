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
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { CHECKOV_IMAGE } from "../lib/pinned_actions.ts";
import { CHECKOV_SCAN_ARGS } from "../lib/checkov_report.ts";

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
 * Joins shell line continuations: a `\` at the end of a line, with any spaces
 * before it, becomes one space, and the next line's indentation goes with it.
 * ci_install_pin_scanner.ts has its own version of this, but it is private.
 */
function joinContinuations(text: string): string {
  return text.replace(/[ \t]*\\[ \t]*\r?\n[ \t]*/g, " ");
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
  const triggers = triggerNames(
    "on" in checkov ? checkov["on"] : checkov["true"],
  );
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
  // straight after it. The joined run text is what the shell sees.
  const runs = runSteps(checkov).map(joinContinuations);
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
  // across continuation lines.
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

Deno.test("checkov_workflow - scan step text carries the pinned image and entrypoint", async () => {
  const { checkov } = await readWorkflows();
  assertStringIncludes(checkov, CHECKOV_IMAGE);
  assertStringIncludes(checkov, "--entrypoint checkov");
  assertStringIncludes(
    checkov,
    `${JUDGE} "$RUNNER_TEMP/checkov.json" "$status"`,
  );
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
