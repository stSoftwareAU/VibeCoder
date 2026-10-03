/**
 * Tests for the post-agent drift check (Issue #3143).
 *
 * Real temporary git repos throughout — the module's whole job is reading
 * `git diff`/`git status` output and the current working tree, so a fake git
 * seam would not exercise the thing that actually drifted in production
 * (VibeCoder#3134, #3095, #3132).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDriftQuestionPrompt,
  buildDriftRecoveryPrompt,
  type DriftCheckDeps,
  type DriftFinding,
  formatDriftResidual,
  parseDriftVerdict,
  runPrFeedbackDriftCheck,
} from "../lib/pr_feedback_drift_check.ts";
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
  const dir = await Deno.makeTempDir({ prefix: "drift_check_3143_" });
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
  responses: readonly (AgentResponse | ((call: AgentCall) => AgentResponse))[],
  calls: AgentCall[],
): DriftCheckDeps["runAgent"] {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const resp = responses[i++];
    if (!resp) {
      throw new Error(`runAgent called more times (${i}) than expected`);
    }
    return typeof resp === "function" ? resp(req) : resp;
  };
}

function noopLogger(): DriftCheckDeps["logger"] {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

const DRIFT_OPEN = "<!-- vibe-drift-verdict -->";
const DRIFT_CLOSE = "<!-- /vibe-drift-verdict -->";

function verdictBlock(findings: DriftFinding[]): string {
  return [
    DRIFT_OPEN,
    "```json",
    JSON.stringify({ findings }, null, 2),
    "```",
    DRIFT_CLOSE,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fixture: a PR summary, a countable test file and a code file, with a push
// that changes the code, grows the test file, and leaves the summary stale.
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

const RULE_TEST_V1 = `import { assertEquals } from "@std/assert";
import { checkRule } from "../lib/rule.ts";

Deno.test("checkRule - accepts a subject", () => {
  assertEquals(checkRule({ subject: "x" }), true);
});

Deno.test("checkRule - ignores a missing subject", () => {
  assertEquals(checkRule({}), true);
});
`;

const RULE_TEST_V2 = RULE_TEST_V1 + `
Deno.test("checkRule - rejects a missing subject", () => {
  assertEquals(checkRule({}), false);
});

Deno.test("checkRule - rejects an empty subject", () => {
  assertEquals(checkRule({ subject: "" }), false);
});
`;

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";
const SENTENCE = "Subjectless entries are ignored.";

const SUMMARY_V1 = `## Summary

Closes #7.

${SENTENCE}

**Docs sweep** — section: none — no manual documents this flag

## Test Plan

- Added \`tests/rule_test.ts\` (2 tests).
`;

/** Base repo: committed base on \`main\`, \`origin/main\` pinned there, then
 * the PR's own files (summary + 2-test file) committed on a feature branch.
 * Returns the repo path and the resulting \`beforeSha\` (the before-run head).
 */
async function setupBaseline(): Promise<{ dir: string; beforeSha: string }> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V1);
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

// ---------------------------------------------------------------------------
// Core flow: finding + mismatch -> one recovery turn -> recovered / reported.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - finding and mismatch trigger exactly one read-only question then one recovery turn", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    // The agent's push: uncommitted changes to the code and the test file.
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        {
          ok: true,
          output: verdictBlock([{
            file: SUMMARY_PATH,
            sentence: SENTENCE,
            reason: "the fix now rejects a subjectless entry",
          }]),
        },
        { ok: true, output: "did nothing" },
      ],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 2);
    assertEquals(calls[0]!.readOnly, true);
    assertStringIncludes(calls[0]!.prompt, beforeSha);
    assertStringIncludes(calls[0]!.prompt, SUMMARY_PATH);

    assertEquals(calls[1]!.readOnly, false);
    assertStringIncludes(calls[1]!.prompt, SENTENCE);
    assertStringIncludes(calls[1]!.prompt, "tests/rule_test.ts");
    assertStringIncludes(calls[1]!.prompt, "2");

    assertEquals(outcome.status, "reported");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - recovery that fixes everything reports recovered, with no .pr_response_message written", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        {
          ok: true,
          output: verdictBlock([{
            file: SUMMARY_PATH,
            sentence: SENTENCE,
            reason: "the fix now rejects a subjectless entry",
          }]),
        },
        {
          ok: true,
          output: "fixed",
        },
      ],
      calls,
    );
    // The fake recovery turn rewrites the summary, as a real agent would.
    const fixedRunAgent: DriftCheckDeps["runAgent"] = async (req) => {
      const result = await runAgent(req);
      if (!req.readOnly) {
        await writeFile(
          dir,
          SUMMARY_PATH,
          `## Summary

Closes #7.

Subjectless entries are now rejected.

**Docs sweep** — section: none — no manual documents this flag

## Test Plan

- Added \`tests/rule_test.ts\` (4 tests).
`,
        );
      }
      return result;
    };

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent: fixedRunAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(outcome.status, "recovered");
    let responseExists = true;
    try {
      await Deno.stat(prResponseMessagePath(dir));
    } catch {
      responseExists = false;
    }
    assertEquals(responseExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - recovery that does nothing reports, writing .pr_response_message with the sentence and the mismatch", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        {
          ok: true,
          output: verdictBlock([{
            file: SUMMARY_PATH,
            sentence: SENTENCE,
            reason: "the fix now rejects a subjectless entry",
          }]),
        },
        { ok: true, output: "did nothing" },
      ],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(outcome.status, "reported");
    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(message, SENTENCE);
    assertStringIncludes(message, "Drift check (Issue #3143)");
    assertStringIncludes(message, "tests/rule_test.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - an existing .pr_response_message is appended to, keeping the original text first", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);
    await Deno.writeTextFile(
      prResponseMessagePath(dir),
      "Original agent reply text.",
    );

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        {
          ok: true,
          output: verdictBlock([{
            file: SUMMARY_PATH,
            sentence: SENTENCE,
            reason: "the fix now rejects a subjectless entry",
          }]),
        },
        { ok: true, output: "did nothing" },
      ],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(outcome.status, "reported");
    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assert(message.startsWith("Original agent reply text."));
    assertStringIncludes(message, "Drift check (Issue #3143)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a misquoted finding is reported even when the recovery runs and fixes the mismatch", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);

    const calls: AgentCall[] = [];
    const misquoted = "The gizmo frobnicates twice before returning.";
    const baseRunAgent = makeRunAgent(
      [
        {
          ok: true,
          output: verdictBlock([{
            file: SUMMARY_PATH,
            sentence: misquoted,
            reason: "a reason that quotes nothing in the file",
          }]),
        },
        { ok: true, output: "fixed the mismatch" },
      ],
      calls,
    );
    const runAgent: DriftCheckDeps["runAgent"] = async (req) => {
      const result = await baseRunAgent(req);
      if (!req.readOnly) {
        await writeFile(
          dir,
          SUMMARY_PATH,
          SUMMARY_V1.replace("(2 tests)", "(4 tests)"),
        );
      }
      return result;
    };

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertEquals(outcome.residual.findings.length, 1);
      assertEquals(outcome.residual.findings[0]!.sentence, misquoted);
      // The mismatch really was fixed by this recovery.
      assertEquals(outcome.residual.mismatches.length, 0);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Docs-only pushes and the Docs sweep gating.
// ---------------------------------------------------------------------------

async function setupDocsOnlyBaseline(
  summaryContent: string | undefined,
): Promise<{ dir: string; beforeSha: string }> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V1);
  await writeFile(dir, "docs/notes.md", "Some notes.\n");
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  if (summaryContent !== undefined) {
    await writeFile(dir, SUMMARY_PATH, summaryContent);
    await commitAll(dir, "docs: add PR summary");
  }
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, beforeSha: rev.stdout.trim() };
}

Deno.test("runPrFeedbackDriftCheck - a docs-only push makes no model call and reports clean", async () => {
  const { dir, beforeSha } = await setupDocsOnlyBaseline(undefined);
  try {
    await writeFile(dir, "docs/notes.md", "Some updated notes.\n");

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent([], calls);

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 0);
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a docs-only push with a Docs-sweep-less summary is still clean (gate does not apply with no code change)", async () => {
  const summaryNoDocsSweep = `## Summary

Closes #7.

No code changed here.

## Test Plan

No tests changed.
`;
  const { dir, beforeSha } = await setupDocsOnlyBaseline(summaryNoDocsSweep);
  try {
    await writeFile(dir, "docs/notes.md", "Some updated notes.\n");

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent([], calls);

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 0);
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a code push with a Docs-sweep-less summary carries the problem into the recovery prompt", async () => {
  const summaryNoDocsSweep = `## Summary

Closes #7.

Some unrelated prose.
`;
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  await writeFile(dir, SUMMARY_PATH, summaryNoDocsSweep);
  await commitAll(dir, "docs: add PR summary");
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  const beforeSha = rev.stdout.trim();

  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        { ok: true, output: "did nothing" },
      ],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 2);
    assertStringIncludes(calls[1]!.prompt, "Docs sweep");
    assertEquals(outcome.status, "reported");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Skipped cases.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - undefined beforeSha is skipped with no agent call", async () => {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await commitAll(dir, "base");
  try {
    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent([], calls);

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha: undefined },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 0);
    assertEquals(outcome.status, "skipped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - nothing changed since beforeSha is skipped with no agent call", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent([], calls);

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 0);
    assertEquals(outcome.status, "skipped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Unparseable model output.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - unparseable model output is reported as modelPassUnavailable, with no recovery turn", async () => {
  const cleanSummary = `## Summary

Closes #7.

Subjectless entries are now rejected.

**Docs sweep** — section: none — no manual documents this flag

## Test Plan

- Added \`tests/rule_test.ts\` (4 tests).
`;
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2); // already 4 tests
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  await writeFile(dir, SUMMARY_PATH, cleanSummary);
  await commitAll(dir, "docs: add PR summary");
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  const beforeSha = rev.stdout.trim();

  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: "I have no block at all." }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 1, "no recovery turn should have run");
    assertEquals(outcome.status, "reported");
    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(
      message,
      "drift check's model pass returned no verdict",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// parseDriftVerdict unit tests.
// ---------------------------------------------------------------------------

Deno.test("parseDriftVerdict - reads a valid block", () => {
  const output = verdictBlock([
    { file: "a.md", sentence: "Foo.", reason: "bar" },
  ]);
  const result = parseDriftVerdict(output);
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0]!.file, "a.md");
  }
});

Deno.test("parseDriftVerdict - {findings: []} is ok with no findings", () => {
  const result = parseDriftVerdict(verdictBlock([]));
  assert(result.ok);
  if (result.ok) assertEquals(result.value.length, 0);
});

Deno.test("parseDriftVerdict - missing markers is an error", () => {
  const result = parseDriftVerdict("no markers here at all");
  assertEquals(result.ok, false);
});

Deno.test("parseDriftVerdict - malformed entries are dropped", () => {
  const output = [
    DRIFT_OPEN,
    "```json",
    JSON.stringify(
      {
        findings: [
          { file: "a.md", sentence: "Good.", reason: "ok" },
          { file: "", sentence: "Bad - empty file.", reason: "ok" },
          { file: "b.md", sentence: "", reason: "ok" },
          { file: "c.md", sentence: "ok" }, // missing reason
          "not an object",
        ],
      },
      null,
      2,
    ),
    "```",
    DRIFT_CLOSE,
  ].join("\n");
  const result = parseDriftVerdict(output);
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0]!.file, "a.md");
  }
});

// ---------------------------------------------------------------------------
// buildDriftQuestionPrompt.
// ---------------------------------------------------------------------------

Deno.test("buildDriftQuestionPrompt - throws on a non-hex beforeSha", () => {
  let threw = false;
  try {
    buildDriftQuestionPrompt({
      repo: "org/repo",
      prNumber: 7,
      beforeSha: "not-a-sha",
      baseRef: undefined,
      files: ["a.md"],
    });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("buildDriftQuestionPrompt - fences the file list with the given boundary id", () => {
  const boundaryId = "aaaaaaaaaaaa";
  const prompt = buildDriftQuestionPrompt({
    repo: "org/repo",
    prNumber: 7,
    beforeSha: "abc1234",
    baseRef: undefined,
    files: ["docs/x.md"],
    boundaryId,
  });
  assertStringIncludes(prompt, boundaryId);
  assertStringIncludes(prompt, "docs/x.md");
});

// ---------------------------------------------------------------------------
// formatDriftResidual.
// ---------------------------------------------------------------------------

Deno.test("formatDriftResidual - carries no HTML comment", () => {
  const text = formatDriftResidual({
    findings: [{ file: "a.md", sentence: "Foo.", reason: "bar" }],
    mismatches: ["a mismatch"],
    docsSweepProblems: ["a problem"],
    modelPassUnavailable: "no block",
  });
  assert(!text.includes("<!--"));
  assertStringIncludes(text, "Drift check (Issue #3143)");
});

// ---------------------------------------------------------------------------
// Sanity-check note (not an executable test): the two breakages below were
// applied by hand and the named tests confirmed red, then reverted.
//
// 1. Removing the post-recovery `stillPresent` check (treating a found-before
//    finding as never resolved) turned
//    "recovery that fixes everything reports recovered..." red: the outcome
//    became "reported" instead of "recovered".
// 2. Skipping the recovery `runAgent` call entirely (leaving `calls.length`
//    at 1) turned
//    "finding and mismatch trigger exactly one read-only question then one
//    recovery turn" red: `assertEquals(calls.length, 2)` failed.
// ---------------------------------------------------------------------------

Deno.test("buildDriftRecoveryPrompt - names the sentence and mismatch in its fenced blocks", () => {
  const prompt = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [{ file: "a.md", sentence: SENTENCE, reason: "stale" }],
    mismatches: ["the Test Plan line quotes 2 tests, but the head has 4"],
    docsSweepProblems: [],
  });
  assertStringIncludes(prompt, SENTENCE);
  assertStringIncludes(prompt, "the head has 4");
});

Deno.test("buildDriftRecoveryPrompt - a mismatch-only prompt does not ask for a Docs sweep fix or a sentence rewrite", () => {
  const prompt = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [],
    mismatches: ["the Test Plan line quotes 2 tests, but the head has 4"],
    docsSweepProblems: [],
  });
  assertStringIncludes(prompt, "Recount the Test Plan");
  assert(!prompt.includes("Docs sweep` line"));
  assert(!prompt.includes("Rewrite each listed sentence"));
  // The always-present steps are still there.
  assertStringIncludes(prompt, "Change no code");
  assertStringIncludes(prompt, ".pr_response_message");
});

// ---------------------------------------------------------------------------
// formatDriftResidual / appendResidualToResponseMessage wording (review fix).
// ---------------------------------------------------------------------------

Deno.test("formatDriftResidual - a modelPassUnavailable-only residual prints only the unavailable line, no 'found text' intro", () => {
  const text = formatDriftResidual({
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    modelPassUnavailable: "no block at all",
  });
  assert(!text.includes("found text this push leaves"));
  assertStringIncludes(text, "Drift check (Issue #3143)");
  assertStringIncludes(text, "no block at all");
});

Deno.test("formatDriftResidual - a residual with hits uses the 'still unresolved after its one recovery attempt' intro", () => {
  const text = formatDriftResidual({
    findings: [{ file: "a.md", sentence: "Foo.", reason: "bar" }],
    mismatches: [],
    docsSweepProblems: [],
  });
  assertStringIncludes(
    text,
    "still unresolved after its one recovery attempt",
  );
});

Deno.test("runPrFeedbackDriftCheck - a modelPassUnavailable-only residual gets the 'could not check it fully' lead, not the 'found text' lead", async () => {
  const cleanSummary = `## Summary

Closes #7.

Subjectless entries are now rejected.

**Docs sweep** — section: none — no manual documents this flag

## Test Plan

- Added \`tests/rule_test.ts\` (4 tests).
`;
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2); // already 4 tests
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  await writeFile(dir, SUMMARY_PATH, cleanSummary);
  await commitAll(dir, "docs: add PR summary");
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  const beforeSha = rev.stdout.trim();

  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: "I have no block at all." }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(outcome.status, "reported");
    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assert(
      message.startsWith(
        "I've pushed a fix for this feedback. The worker's drift check " +
          "could not check it fully — see below.",
      ),
    );
    assert(!message.includes("found text this push leaves"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Path confinement (review fix): a finding's `file` is model output, so it
// must only ever be read when it is exactly one of the files the question
// asked about.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a finding naming a path outside the checkout, or a repo file never offered to the model, is reported and never read", async () => {
  const { dir, beforeSha } = await setupBaseline();
  const outsideDir = await Deno.makeTempDir({
    prefix: "drift_check_3143_outside_",
  });
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);

    const outsideSentence = "This sentence lives outside the checkout.";
    const outsidePath = `${outsideDir}/outside.md`;
    await Deno.writeTextFile(outsidePath, `${outsideSentence}\n`);
    // A relative path from repoPath that escapes the checkout to the same file.
    const outsideRelative = `../${
      outsideDir.slice(outsideDir.lastIndexOf("/") + 1)
    }/outside.md`;

    // A real repo file that is part of this PR's diff, but a test file — so
    // it is never offered to the model as a file to check.
    const uncheckedFile = "tests/rule_test.ts";
    const uncheckedSentence = "checkRule - accepts a subject";

    const calls: AgentCall[] = [];
    const baseRunAgent = makeRunAgent(
      [
        {
          ok: true,
          output: verdictBlock([
            {
              file: outsideRelative,
              sentence: outsideSentence,
              reason: "claims drift in a file outside the checkout",
            },
            {
              file: uncheckedFile,
              sentence: uncheckedSentence,
              reason: "claims drift in a file never offered to the model",
            },
          ]),
        },
        { ok: true, output: "fixed" },
      ],
      calls,
    );
    // The recovery turn "fixes" both — if the guard did not confine reads,
    // this would resolve both findings.
    const runAgent: DriftCheckDeps["runAgent"] = async (req) => {
      const result = await baseRunAgent(req);
      if (!req.readOnly) {
        await Deno.writeTextFile(outsidePath, "Nothing to see here.\n");
        await writeFile(
          dir,
          uncheckedFile,
          RULE_TEST_V2.replace(uncheckedSentence, "renamed test"),
        );
      }
      return result;
    };

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertEquals(outcome.residual.findings.length, 2);
      const files = outcome.residual.findings.map((f) => f.file).sort();
      assertEquals(files, [outsideRelative, uncheckedFile].sort());
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outsideDir, { recursive: true });
  }
});
