/**
 * Tests for the mutation check inside the post-agent drift check (Issue #3750).
 *
 * The diff-scoped mutation gate (Issue #3393) runs over this run's own lines
 * through the `runMutationCheck` seam. Survivors feed the one recovery turn;
 * survivors that outlive it, and a check that could not run, are reported.
 *
 * Real temporary git repos throughout, as in
 * `pr_feedback_drift_check_3143_test.ts`. The mutation seam is a stub that
 * records each call and returns scripted results.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildDriftRecoveryPrompt,
  type DriftCheckDeps,
  formatDriftResidual,
  runPrFeedbackDriftCheck,
} from "../lib/pr_feedback_drift_check.ts";
import type { Mutant, MutationCheckResult } from "../lib/mutation_gate.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";

// ---------------------------------------------------------------------------
// Test-repo scaffolding — a real git checkout per test.
// ---------------------------------------------------------------------------

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(dir: string, args: string[]): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function writeFile(dir: string, path: string, content: string) {
  const full = `${dir}/${path}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, content);
}

async function commitAll(dir: string, message: string) {
  assertEquals((await git(dir, ["add", "."])).code, 0);
  assertEquals((await git(dir, ["commit", "-m", message])).code, 0);
}

async function initRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "drift_check_3750_" });
  assertEquals((await git(dir, ["init", "-b", "main"])).code, 0);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

/** Fake `runGit` that shells out to real git in `dir`. */
function makeRunGit(dir: string): DriftCheckDeps["runGit"] {
  return async (args: string[]) => await git(dir, args);
}

/** Fake `runGh` that always answers the `baseRefName` read with `main`. */
function makeRunGh(): DriftCheckDeps["runGh"] {
  return async () => "main\n";
}

type AgentResponse =
  | { ok: true; output: string }
  | { ok: false; error: Error };
type AgentCall = { prompt: string; readOnly: boolean };

function makeRunAgent(
  responses: readonly AgentResponse[],
  calls: AgentCall[],
): DriftCheckDeps["runAgent"] {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const resp = responses[i++];
    if (!resp) {
      throw new Error(`runAgent called more times (${i}) than expected`);
    }
    return resp;
  };
}

/**
 * Stub for the mutation seam: records each `beforeSha` it is given and
 * returns the scripted results in order. Running past the script is an
 * error the test sees as a wrong call count, since the check reports it.
 */
function makeMutationSeam(
  results: readonly MutationCheckResult[],
  calls: string[],
): DriftCheckDeps["runMutationCheck"] {
  let i = 0;
  return async (beforeSha) => {
    calls.push(beforeSha);
    const result = results[i++];
    if (!result) {
      throw new Error(
        `runMutationCheck called more times (${i}) than expected`,
      );
    }
    return result;
  };
}

function noopLogger(): DriftCheckDeps["logger"] {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

const DRIFT_OPEN = "<!-- vibe-drift-verdict -->";
const DRIFT_CLOSE = "<!-- /vibe-drift-verdict -->";

function verdictBlock(
  findings: { file: string; sentence: string; reason: string }[],
): string {
  return [
    DRIFT_OPEN,
    "```json",
    JSON.stringify({ findings }, null, 2),
    "```",
    DRIFT_CLOSE,
  ].join("\n");
}

/** The deps literal every case uses, with only the seams under test varied. */
function depsFor(
  dir: string,
  runAgent: DriftCheckDeps["runAgent"],
  runMutationCheck: DriftCheckDeps["runMutationCheck"],
): DriftCheckDeps {
  return {
    runGit: makeRunGit(dir),
    runGh: makeRunGh(),
    runAgent,
    runMutationCheck,
    logger: noopLogger(),
  };
}

// ---------------------------------------------------------------------------
// Fixture: a PR summary and a code file. The push changes the code, so the
// model pass runs; the model answers with no findings, so only the mutation
// seam decides the outcome.
// ---------------------------------------------------------------------------

const RULE_TS_V1 =
  `export function checkRule(entry: { subject?: string }): boolean {
  if (!entry.subject) return true; // subjectless entries are ignored
  return entry.subject.length > 0;
}
`;

const RULE_TS_V2 =
  `export function checkRule(entry: { subject?: string }): boolean {
  if (!entry.subject) return false; // subjectless entries are now rejected
  return entry.subject.length > 0;
}
`;

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";

const SUMMARY_V1 = `## Summary

Closes #7.

Rules now check the subject field.

**Docs sweep** — grep: \`subject\`; section: none — no manual documents this flag; siblings: none — no existing set gained a member
`;

/** Exempts \`lib/rule.ts:3\` from the mutation check, as a PR summary would. */
const EXEMPT_LINE =
  "- `lib/rule.ts:3` — exempt (untestable): the suite cannot stage it";

/** Base repo with the summary committed at the before-run head. */
async function setupBaseline(): Promise<{ dir: string; beforeSha: string }> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals(
    (await git(dir, ["checkout", "-b", "issue-7-fix"])).code,
    0,
  );
  await writeFile(dir, SUMMARY_PATH, SUMMARY_V1);
  await commitAll(dir, "docs: add PR summary");
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, beforeSha: rev.stdout.trim() };
}

const DEFAULT_INPUT = { repo: "org/repo", prNumber: 7 };

const SURVIVOR: Mutant = {
  file: "lib/rule.ts",
  line: 2,
  description: "negated if condition",
};

function completed(
  survivors: Mutant[],
  killed: number,
  total: number,
): MutationCheckResult {
  return { kind: "completed", language: "deno", survivors, killed, total };
}

// ---------------------------------------------------------------------------
// Survivors drive exactly one recovery turn; a second check decides the status.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a survivor that outlives the recovery turn gets one recovery turn, a second check, and a residual heading", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        { ok: true, output: "left as it is" },
      ],
      calls,
    );
    const seamCalls: string[] = [];
    const runMutationCheck = makeMutationSeam(
      [completed([SURVIVOR], 0, 1), completed([SURVIVOR], 0, 1)],
      seamCalls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      depsFor(dir, runAgent, runMutationCheck),
    );

    assertEquals(calls.length, 2);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(calls[1]!.readOnly, false);
    assertStringIncludes(calls[1]!.prompt, "lib/rule.ts:2");
    assertStringIncludes(
      calls[1]!.prompt,
      "No test went red when each of these mutations was applied",
    );
    assertStringIncludes(calls[1]!.prompt, "Change no production code");

    assertEquals(seamCalls, [beforeSha, beforeSha]);

    assert(outcome.status === "reported");
    assertEquals(outcome.recoveryRan, true);
    assertEquals(outcome.residual.mutationSurvivors?.length, 1);
    assertStringIncludes(
      outcome.residual.mutationSurvivors![0]!,
      "lib/rule.ts:2",
    );

    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assert(
      message.startsWith(
        "I've pushed a fix for this feedback, but the worker's mutation " +
          "check found lines this push added that no test pins — see below.",
      ),
    );
    assertStringIncludes(message, "#### Mutation check (Issue #3750)");
    assertStringIncludes(message, "lib/rule.ts:2");
    assert(!message.includes("found text this push leaves"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a survivor the recovery turn kills reports recovered, with no .pr_response_message", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        { ok: true, output: "added a test" },
      ],
      calls,
    );
    const seamCalls: string[] = [];
    const runMutationCheck = makeMutationSeam(
      [completed([SURVIVOR], 0, 1), completed([], 1, 1)],
      seamCalls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      depsFor(dir, runAgent, runMutationCheck),
    );

    assertEquals(calls.length, 2);
    assertEquals(calls[1]!.readOnly, false);
    assertEquals(seamCalls, [beforeSha, beforeSha]);
    assertEquals(outcome.status, "recovered");
    await assertRejects(
      () => Deno.stat(prResponseMessagePath(dir)),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a survivor covered by a summary exemption is not a hit: no recovery turn, clean", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, SUMMARY_PATH, `${SUMMARY_V1}\n${EXEMPT_LINE}\n`);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );
    const seamCalls: string[] = [];
    const runMutationCheck = makeMutationSeam(
      [completed(
        [{
          file: "lib/rule.ts",
          line: 3,
          description: "deleted call statement",
        }],
        0,
        1,
      )],
      seamCalls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      depsFor(dir, runAgent, runMutationCheck),
    );

    assertEquals(calls.length, 1, "only the model pass ran");
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(seamCalls.length, 1);
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a budget-exhausted check with no survivors gets no recovery turn and reports the budget note", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );
    const seamCalls: string[] = [];
    const runMutationCheck = makeMutationSeam(
      [{
        kind: "budget_exhausted",
        language: "deno",
        survivors: [],
        killed: 1,
        tested: 1,
        total: 2,
        budgetSeconds: 300,
      }],
      seamCalls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      depsFor(dir, runAgent, runMutationCheck),
    );

    assertEquals(calls.length, 1, "only the model pass ran");
    assertEquals(seamCalls.length, 1);
    assert(outcome.status === "reported");
    assertEquals(outcome.recoveryRan, false);
    assertStringIncludes(
      outcome.residual.mutationNote ?? "",
      "mutation budget exhausted",
    );
    assertEquals(outcome.residual.mutationSurvivors, undefined);
    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(message, "mutation budget exhausted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - an error result gets no recovery turn and is reported as the mutation check failing to run", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );
    const seamCalls: string[] = [];
    const runMutationCheck = makeMutationSeam(
      [{ kind: "error", reason: "deno check failed" }],
      seamCalls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      depsFor(dir, runAgent, runMutationCheck),
    );

    assertEquals(calls.length, 1, "only the model pass ran");
    assertEquals(seamCalls.length, 1);
    assert(outcome.status === "reported");
    assertEquals(outcome.recoveryRan, false);
    assertStringIncludes(
      outcome.residual.mutationCheckUnavailable ?? "",
      "mutation check failed to run",
    );
    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(message, "could not check it fully");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a not_applicable mutation check leaves the push clean, with the seam called once", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );
    const seamCalls: string[] = [];
    const runMutationCheck = makeMutationSeam(
      [{ kind: "not_applicable", reason: "no Deno files changed" }],
      seamCalls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      depsFor(dir, runAgent, runMutationCheck),
    );

    assertEquals(seamCalls.length, 1);
    assertEquals(calls.length, 1, "only the model pass ran");
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a throwing mutation seam is reported as an error, never thrown", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );
    const runMutationCheck: DriftCheckDeps["runMutationCheck"] = async () => {
      throw new Error("boom");
    };

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      depsFor(dir, runAgent, runMutationCheck),
    );

    assertEquals(calls.length, 1, "only the model pass ran");
    assert(outcome.status === "reported");
    assertEquals(outcome.recoveryRan, false);
    assertStringIncludes(
      outcome.residual.mutationCheckUnavailable ?? "",
      "mutation runner failed: boom",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Rendering: the survivors heading, the no-"found text" intro, and the
// recovery prompt's two wordings.
// ---------------------------------------------------------------------------

Deno.test("formatDriftResidual - a survivors-only residual has no 'found text' intro and renders its own heading", () => {
  const text = formatDriftResidual({
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    mutationSurvivors: ["`lib/rule.ts:2` — negated if condition"],
  });
  assert(!text.includes("found text this push leaves"));
  assertStringIncludes(text, "#### Mutation check (Issue #3750)");
  assertStringIncludes(
    text,
    "No test went red when each of these mutations was applied to a line this push added",
  );
  assertStringIncludes(text, "- `lib/rule.ts:2` — negated if condition");
});

Deno.test("formatDriftResidual - a mutationNote-only residual prints the note under the mutation heading, no 'found text' intro", () => {
  const text = formatDriftResidual({
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    mutationNote: "mutation budget exhausted after 1 of 2 mutants (300 s)",
  });
  assert(!text.includes("found text this push leaves"));
  assertStringIncludes(text, "#### Mutation check (Issue #3750)");
  assertStringIncludes(text, "mutation budget exhausted after 1 of 2 mutants");
});

Deno.test("buildDriftRecoveryPrompt - survivors switch the closing step to the test-only wording and fence the survivors", () => {
  const prompt = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    mutationGateComment:
      "## Mutation check: changed lines are not pinned\n- `lib/rule.ts:2` — negated if condition",
  });
  assertStringIncludes(
    prompt,
    "Mutation survivors — lines this push added that no test pins:",
  );
  assertStringIncludes(prompt, "lib/rule.ts:2");
  assertStringIncludes(prompt, "Add a test that kills each listed mutation");
  assertStringIncludes(prompt, "Change no production code");
  assert(!prompt.includes("Change no code —"));
});

Deno.test("buildDriftRecoveryPrompt - with no survivors the documentation-only closing step is kept verbatim", () => {
  const prompt = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [{ file: "a.md", sentence: "Foo.", reason: "bar" }],
    mismatches: [],
    docsSweepProblems: [],
  });
  assertStringIncludes(
    prompt,
    "Change no code — this is a documentation fix only. Commit the change, referencing PR #7.",
  );
  assert(!prompt.includes("Change no production code"));
  assert(!prompt.includes("Add a test that kills each listed mutation"));
});
