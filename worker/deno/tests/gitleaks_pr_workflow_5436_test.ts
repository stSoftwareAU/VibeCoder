/**
 * Validator and behavioural regression test for the PR job of
 * `.github/workflows/gitleaks.yml` (Issue #5436).
 *
 * The licensed gitleaks-action scanned only the first 30 commits a PR lists
 * (PR #5322 passed with 21 of its 51 commits unscanned) and bundled its own
 * gitleaks 8.24.3. The PR job now runs the one pinned CLI over the full
 * `base..head` range, then over the merged result.
 *
 *   - `prScanViolations` is a pure validator over the parsed workflow: the real
 *     file must yield none, and each single mutation must be refused by the
 *     rule that names it.
 *   - The behavioural tests run the workflow's own `run` scripts with real
 *     gitleaks against a temporary repository whose pull request carries 35
 *     commits (skipped where gitleaks is not installed).
 *
 * Australian English spelling used throughout (behaviour, licence, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { runGitleaksRangeCheck } from "../lib/gitleaks_check.ts";
import { usesGitleaksAction } from "../lib/gitleaks_drift_scanner.ts";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
} from "./support/no_host_git_config.ts";
import { probe } from "../lib/semgrep_check.ts";

const WORKFLOW_URL = new URL(
  "../../../.github/workflows/gitleaks.yml",
  import.meta.url,
);
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

const INSTALL_STEP = "Install gitleaks";
const RANGE_STEP = "Scan every commit in the pull request (base..head)";
const MERGE_STEP = "Scan the merged result (refs/pull/N/merge)";
const BASE_EXPR = "${{ github.event.pull_request.base.sha }}";
const HEAD_EXPR = "${{ github.event.pull_request.head.sha }}";

/** A token-shaped string built at runtime so this file holds no secret. */
const FAKE_TOKEN = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(
  "",
);

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const RANGE_LOG_OPTS =
  '--log-opts="--diff-merges=first-parent ${BASE_SHA}..${HEAD_SHA}"';
const MERGE_LOG_OPTS =
  '--log-opts="--first-parent --diff-merges=first-parent -1 ${merge_sha}"';

const MSG_ACTION =
  "a step uses gitleaks-action, which bundles a second gitleaks version and scans only 30 commits";
const MSG_CHECKOUT =
  "the gitleaks PR job must exist and its actions/checkout step must set fetch-depth: 0";
const MSG_INSTALL =
  `the "${INSTALL_STEP}" step must exist and verify the download with sha256sum -c`;
const MSG_RANGE =
  `the "${RANGE_STEP}" step must exist, be unconditional, take BASE_SHA/HEAD_SHA from the pull request and run gitleaks git over ${RANGE_LOG_OPTS}`;
const MSG_MERGE =
  `the "${MERGE_STEP}" step must exist, be unconditional, take HEAD_SHA from the pull request and run gitleaks git over ${MERGE_LOG_OPTS}`;

type Step = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function stepsOf(job: unknown): Step[] {
  const steps = asRecord(job).steps;
  return Array.isArray(steps) ? steps.map(asRecord) : [];
}

function envOf(step: Step | undefined): Record<string, unknown> {
  return asRecord(step?.env);
}

function prScanViolations(workflow: unknown): string[] {
  const violations: string[] = [];
  const jobs = asRecord(asRecord(workflow).jobs);

  for (const job of Object.values(jobs)) {
    if (
      stepsOf(job).some((step) =>
        typeof step.uses === "string" && usesGitleaksAction(step.uses)
      )
    ) {
      violations.push(MSG_ACTION);
      break;
    }
  }

  const steps = stepsOf(jobs.gitleaks);
  const named = (name: string) => steps.find((step) => step.name === name);

  const checkout = steps.find((step) =>
    typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")
  );
  if (asRecord(checkout?.with)["fetch-depth"] !== 0) {
    violations.push(MSG_CHECKOUT);
  }

  const install = named(INSTALL_STEP);
  if (
    typeof install?.run !== "string" || !install.run.includes("sha256sum -c")
  ) {
    violations.push(MSG_INSTALL);
  }

  const range = named(RANGE_STEP);
  if (
    range === undefined || "if" in range ||
    envOf(range).BASE_SHA !== BASE_EXPR ||
    envOf(range).HEAD_SHA !== HEAD_EXPR ||
    typeof range.run !== "string" || !range.run.includes("gitleaks git ") ||
    !range.run.includes(RANGE_LOG_OPTS)
  ) {
    violations.push(MSG_RANGE);
  }

  const merge = named(MERGE_STEP);
  if (
    merge === undefined || "if" in merge ||
    envOf(merge).HEAD_SHA !== HEAD_EXPR ||
    typeof merge.run !== "string" || !merge.run.includes("gitleaks git ") ||
    !merge.run.includes(MERGE_LOG_OPTS)
  ) {
    violations.push(MSG_MERGE);
  }

  return violations;
}

const workflowText = await Deno.readTextFile(WORKFLOW_URL);
const workflow = parseYaml(workflowText) as Record<string, unknown>;

/** Clone the real workflow, hand its PR job steps to `mutate`, and validate. */
function mutated(mutate: (steps: Step[]) => void): string[] {
  const clone = structuredClone(workflow);
  const job = asRecord(asRecord(clone.jobs).gitleaks);
  mutate(job.steps as Step[]);
  return prScanViolations(clone);
}

function findStep(steps: Step[], name: string): Step {
  const step = steps.find((candidate) => candidate.name === name);
  assert(step !== undefined, `step "${name}" missing from gitleaks.yml`);
  return step;
}

Deno.test("gitleaks.yml PR job - the real workflow has no violations", () => {
  assertEquals(prScanViolations(workflow), []);
});

Deno.test("gitleaks.yml PR job - a gitleaks-action step is refused", () => {
  const pinned =
    "gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e";
  assertEquals(
    mutated((steps) => steps.push({ uses: pinned })),
    [MSG_ACTION],
  );
});

Deno.test("gitleaks.yml PR job - a shallow checkout is refused", () => {
  assertEquals(
    mutated((steps) => {
      const checkout = steps.find((step) =>
        String(step.uses).startsWith("actions/checkout@")
      )!;
      asRecord(checkout.with)["fetch-depth"] = 1;
    }),
    [MSG_CHECKOUT],
  );
});

Deno.test("gitleaks.yml PR job - an unverified install is refused", () => {
  assertEquals(
    mutated((steps) => {
      const install = findStep(steps, INSTALL_STEP);
      install.run = String(install.run).replaceAll("sha256sum -c", "cat");
    }),
    [MSG_INSTALL],
  );
});

Deno.test("gitleaks.yml PR job - a conditional range scan is refused", () => {
  assertEquals(
    mutated((steps) => {
      findStep(steps, RANGE_STEP).if = "env.X != ''";
    }),
    [MSG_RANGE],
  );
});

Deno.test("gitleaks.yml PR job - a range scan from the wrong base is refused", () => {
  assertEquals(
    mutated((steps) => {
      envOf(findStep(steps, RANGE_STEP)).BASE_SHA =
        "${{ github.event.before }}";
    }),
    [MSG_RANGE],
  );
});

Deno.test("gitleaks.yml PR job - a missing merged-result scan is refused", () => {
  assertEquals(
    mutated((steps) => {
      steps.splice(steps.indexOf(findStep(steps, MERGE_STEP)), 1);
    }),
    [MSG_MERGE],
  );
});

Deno.test("gitleaks.yml PR job - a conditional merged-result scan is refused", () => {
  assertEquals(
    mutated((steps) => {
      findStep(steps, MERGE_STEP).if = "env.X != ''";
    }),
    [MSG_MERGE],
  );
});

Deno.test("gitleaks.yml PR job - a range scan that no longer scans the range is refused", () => {
  assertEquals(
    mutated((steps) => {
      const range = findStep(steps, RANGE_STEP);
      range.run = String(range.run).replaceAll(
        RANGE_LOG_OPTS,
        '--log-opts="${HEAD_SHA}"',
      );
    }),
    [MSG_RANGE],
  );
});

Deno.test("gitleaks.yml PR job - a merged-result scan without first-parent diffs is refused", () => {
  assertEquals(
    mutated((steps) => {
      const merge = findStep(steps, MERGE_STEP);
      merge.run = String(merge.run).replaceAll(
        "--first-parent --diff-merges=first-parent ",
        "",
      );
    }),
    [MSG_MERGE],
  );
});

// ---------------------------------------------------------------------------
// Behaviour with real gitleaks
// ---------------------------------------------------------------------------

const gitleaksAvailable = (await probe("gitleaks", ["version"])) !== null;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  ...NO_HOST_GIT_CONFIG,
};

/** Run git in `cwd` with a clean, non-interactive environment. */
async function runGit(cwd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [...NO_HOST_HOOKS_ARGS, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: GIT_ENV,
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/** Run git in `cwd`, feeding `input` to its stdin. */
async function runGitWithInput(
  cwd: string,
  args: string[],
  input: string,
): Promise<void> {
  const child = new Deno.Command("git", {
    args: [...NO_HOST_HOOKS_ARGS, ...args],
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: GIT_ENV,
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const out = await child.output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

interface StepContext {
  baseSha: string;
  headSha: string;
}

/**
 * Run a PR-job step's own `run` script as GitHub does (`bash -eo pipefail`),
 * with its `env` and the job-level `env` expressions substituted.
 */
async function runWorkflowStep(
  stepName: string,
  repoDir: string,
  ctx: StepContext,
): Promise<{ code: number; output: string }> {
  const job = asRecord(asRecord(workflow.jobs).gitleaks);
  const step = findStep(stepsOf(job), stepName);
  const run = String(step.run);
  if (run.includes("${{")) {
    throw new Error(`step "${stepName}" run script holds a \${{ expression`);
  }
  const substitute = (value: unknown): string =>
    String(value).replace(/\$\{\{[^}]*\}\}/g, (expression) => {
      switch (expression) {
        case BASE_EXPR:
          return ctx.baseSha;
        case HEAD_EXPR:
          return ctx.headSha;
        case "${{ github.workspace }}":
          return REPO_ROOT;
        default:
          throw new Error(`unsupported expression ${expression}`);
      }
    });
  const env: Record<string, string> = {};
  for (const source of [envOf(job as Step), envOf(step)]) {
    for (const [key, value] of Object.entries(source)) {
      env[key] = substitute(value);
    }
  }
  const out = await new Deno.Command("bash", {
    args: ["--noprofile", "--norc", "-eo", "pipefail", "-c", run],
    cwd: repoDir,
    clearEnv: true,
    env: {
      ...env,
      PATH: Deno.env.get("PATH") ?? "",
      HOME: repoDir,
      ...GIT_ENV,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    output: decoder.decode(out.stdout) + decoder.decode(out.stderr),
  };
}

const COMMITS = 35;

interface Fixture {
  baseSha: string;
  headSha: string;
}

/**
 * A pull request of 35 commits on `feature`, merged into `main` on a detached
 * HEAD, as actions/checkout leaves refs/pull/N/merge.
 */
async function buildFixture(
  dir: string,
  options: { leakInLast?: boolean; mergeLeak?: "retained" | "removed" },
): Promise<Fixture> {
  const commitFile = async (name: string, content: string, message: string) => {
    await Deno.writeTextFile(`${dir}/${name}`, content);
    await runGit(dir, ["add", name]);
    await runGit(dir, ["commit", "-q", "-m", message]);
  };
  await runGit(dir, ["init", "-q", "-b", "main"]);
  await commitFile("base.txt", "base\n", "base");
  await runGit(dir, ["checkout", "-q", "-b", "feature"]);
  const baseCommit = await runGit(dir, ["rev-parse", "HEAD"]);
  const encoder = new TextEncoder();
  const data = (text: string) =>
    `data ${encoder.encode(text).length}\n${text}\n`;
  let stream = "";
  for (let n = 1; n <= COMMITS; n++) {
    const [name, content] = n === COMMITS && options.leakInLast
      ? ["leak.ts", `const t = "${FAKE_TOKEN}";\n`]
      : [`file${n}.txt`, `file ${n}\n`];
    stream += `commit refs/heads/feature\n` +
      `committer Test <test@example.com> ${1700000000 + n} +0000\n` +
      data(`commit ${n}`) +
      (n === 1 ? `from ${baseCommit}\n` : "") +
      `M 100644 inline ${name}\n` +
      data(content) + "\n";
  }
  await runGitWithInput(dir, ["fast-import", "--quiet"], stream);
  await runGit(dir, ["reset", "--hard", "-q", "feature"]);
  if (options.mergeLeak) {
    await runGit(dir, ["checkout", "-q", "main"]);
    await commitFile("main-only.txt", "main\n", "main moves on");
    await runGit(dir, ["checkout", "-q", "feature"]);
    await runGit(dir, ["merge", "-q", "--no-commit", "--no-ff", "main"]);
    await Deno.writeTextFile(`${dir}/evil.ts`, `const t = "${FAKE_TOKEN}";\n`);
    await runGit(dir, ["add", "evil.ts"]);
    await runGit(dir, ["commit", "-q", "-m", "merge main"]);
    if (options.mergeLeak === "removed") {
      await runGit(dir, ["rm", "evil.ts"]);
      await runGit(dir, ["commit", "-q", "-m", "remove fixture"]);
    }
  }
  const headSha = await runGit(dir, ["rev-parse", "HEAD"]);
  const baseSha = await runGit(dir, ["rev-parse", "main"]);
  await runGit(dir, ["checkout", "-q", "--detach", "main"]);
  await runGit(dir, [
    "merge",
    "-q",
    "--no-ff",
    headSha,
    "-m",
    "Merge pull request",
  ]);
  return { baseSha, headSha };
}

async function withFixture(
  options: { leakInLast?: boolean; mergeLeak?: "retained" | "removed" },
  body: (dir: string, fixture: Fixture) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "gitleaks-5436-" });
  try {
    const fixture = await buildFixture(dir, options);
    await body(dir, fixture);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name:
    "gitleaks.yml PR job - a leak in commit 35, beyond the 30-commit page, fails the range scan",
  ignore: !gitleaksAvailable,
  fn: async () => {
    await withFixture({ leakInLast: true }, async (dir, ctx) => {
      const result = await runWorkflowStep(RANGE_STEP, dir, ctx);
      assert(result.code !== 0, result.output);
      assertStringIncludes(result.output, `${ctx.baseSha}..${ctx.headSha}`);
      assertStringIncludes(result.output, "Scanning 35 commit(s)");
      assertStringIncludes(result.output, "35 commits scanned");
      assertStringIncludes(result.output, "leaks found: 1");
      assert(
        !result.output.includes(FAKE_TOKEN),
        "the raw token must not be printed",
      );
    });
  },
});

Deno.test({
  name: "gitleaks.yml PR job - 35 clean commits pass both scans",
  ignore: !gitleaksAvailable,
  fn: async () => {
    await withFixture({}, async (dir, ctx) => {
      const range = await runWorkflowStep(RANGE_STEP, dir, ctx);
      assertEquals(range.code, 0, range.output);
      assertStringIncludes(range.output, "no leaks found");
      assertStringIncludes(range.output, "35 commits scanned");
      const merge = await runWorkflowStep(MERGE_STEP, dir, ctx);
      assertEquals(merge.code, 0, merge.output);
      assertStringIncludes(merge.output, "no leaks found");
      assertStringIncludes(merge.output, "1 commits scanned");
    });
  },
});

Deno.test({
  name:
    "gitleaks.yml PR job - a secret only in the merge resolution is caught by both scans",
  ignore: !gitleaksAvailable,
  fn: async () => {
    await withFixture({ mergeLeak: "retained" }, async (dir, ctx) => {
      const range = await runWorkflowStep(RANGE_STEP, dir, ctx);
      assertEquals(range.code, 1, range.output);
      assertStringIncludes(range.output, "leaks found: 1");
      const merge = await runWorkflowStep(MERGE_STEP, dir, ctx);
      assert(merge.code !== 0, merge.output);
      assertStringIncludes(merge.output, "leaks found: 1");
      assertStringIncludes(merge.output, "Scanning the merged result:");
    });
  },
});

Deno.test({
  name:
    "an intermediate merge finding removed before the head blocks CI and the local push",
  ignore: !gitleaksAvailable,
  fn: async () => {
    await withFixture({ mergeLeak: "removed" }, async (dir, ctx) => {
      const merge = await runWorkflowStep(MERGE_STEP, dir, ctx);
      assertEquals(merge.code, 0, merge.output);
      const range = await runWorkflowStep(RANGE_STEP, dir, ctx);
      assertEquals(range.code, 1, range.output);
      assertStringIncludes(range.output, "leaks found: 1");
      const local = await runGitleaksRangeCheck(dir, ctx.baseSha, ctx.headSha, {
        mergeBaseRef: "main",
      });
      assert(local.kind === "blocked", JSON.stringify(local));
      assertStringIncludes(local.message, "evil.ts");
    });
  },
});

Deno.test({
  name:
    "gitleaks.yml PR job - the merged-result scan refuses a HEAD that is not the merge of the PR head",
  ignore: !gitleaksAvailable,
  fn: async () => {
    await withFixture({}, async (dir, ctx) => {
      await runGit(dir, ["checkout", "-q", "--detach", ctx.headSha]);
      const result = await runWorkflowStep(MERGE_STEP, dir, ctx);
      assertEquals(result.code, 1, result.output);
      assertStringIncludes(result.output, "is not the merge of the PR head");
    });
  },
});

Deno.test({
  name:
    "gitleaks.yml PR job - the merged-result scan refuses a merge whose second parent is not the PR head",
  ignore: !gitleaksAvailable,
  fn: async () => {
    await withFixture({}, async (dir, ctx) => {
      await runGit(dir, ["checkout", "-q", "--detach", ctx.baseSha]);
      await runGit(dir, [
        "merge",
        "-q",
        "--no-ff",
        `${ctx.headSha}~1`,
        "-m",
        "stale merge",
      ]);
      const result = await runWorkflowStep(MERGE_STEP, dir, ctx);
      assertEquals(result.code, 1, result.output);
      assertStringIncludes(result.output, "is not the merge of the PR head");
    });
  },
});

Deno.test({
  name:
    "gitleaks.yml PR job - the range scan fails loud on an unresolvable base",
  ignore: !gitleaksAvailable,
  fn: async () => {
    await withFixture({}, async (dir, ctx) => {
      const result = await runWorkflowStep(RANGE_STEP, dir, {
        ...ctx,
        baseSha: "0123456789abcdef0123456789abcdef01234567",
      });
      assertEquals(result.code, 1, result.output);
      assertStringIncludes(result.output, "is not in the checkout");
    });
  },
});
