/**
 * Tests for the Issue #3244 fixes to the post-agent drift check
 * (`pr_feedback_drift_check.ts`, Issue #3143): the model pass now runs on a
 * test-file-only push (not only a code-changing one), and a deterministic,
 * no-model-needed check looks for change-request-quoted sentences still
 * present in the PR summaries the change request names.
 *
 * Real temporary git repos throughout, mirroring
 * `pr_feedback_drift_check_3143_test.ts` — the module's whole job is reading
 * `git diff`/`git status` output and the current working tree, so a fake git
 * seam would not exercise the thing that actually drifted in production.
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
  runPrFeedbackDriftCheck,
} from "../lib/pr_feedback_drift_check.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";

// ---------------------------------------------------------------------------
// Test-repo scaffolding — a real git checkout per test (copied from
// pr_feedback_drift_check_3143_test.ts; these helpers are file-local there).
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
  const dir = await Deno.makeTempDir({ prefix: "drift_check_3244_" });
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
// Fixture: a PR summary carrying a sentence the change request quotes, a
// countable test file, and an untouched code file.
// ---------------------------------------------------------------------------

const RULE_TS =
  `export function checkRule(entry: { subject?: string }): boolean {
  if (!entry.subject) return true; // subjectless entries are ignored
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
Deno.test("checkRule - a third case", () => {
  assertEquals(checkRule({ subject: "y" }), true);
});
`;

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";
const MISSING_SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-99.md";

/** The quoted span the change request names — 4+ words, matched verbatim. */
const QUOTE = "not each, which drift-pins-on-base showed was already present";
const SENTENCE = `The lists pin ${QUOTE}.`;

/** The change request body, in the review-fleet-prs finding shape. */
const CHANGE_REQUEST =
  `**\`${SUMMARY_PATH}:12\`**: The summary still says the lists pin "${QUOTE}", but the head test pins it.

**Fix:** Rewrite the sentence.

Overall: one finding.`;

/** Same finding, naming a summary that is never written to the repo. */
const CHANGE_REQUEST_MISSING_SUMMARY =
  `**\`${MISSING_SUMMARY_PATH}:12\`**: The summary still says the lists pin "${QUOTE}", but the head test pins it.

**Fix:** Rewrite the sentence.

Overall: one finding.`;

const SUMMARY_WITH_SENTENCE = `## Summary

Closes #7.

${SENTENCE}

**Docs sweep** — section: none — no manual documents this flag

## Test Plan

- Added \`tests/rule_test.ts\` (2 tests).
`;

const SUMMARY_WITHOUT_SENTENCE = `## Summary

Closes #7.

The lists pin every entry correctly.

**Docs sweep** — section: none — no manual documents this flag

## Test Plan

- Added \`tests/rule_test.ts\` (3 tests).
`;

/** The sentence left standing, with a round-2 correction appended below it. */
const SUMMARY_WITH_SENTENCE_AND_ROUND2 = `## Summary

Closes #7.

${SENTENCE}

PR-feedback round 2: the drift-pins-on-base behaviour is now covered by a
third test case.

**Docs sweep** — section: none — no manual documents this flag

## Test Plan

- Added \`tests/rule_test.ts\` (3 tests).
`;

/** The sentence actually rewritten away, round-2 note kept. */
const SUMMARY_WITH_SENTENCE_REMOVED = `## Summary

Closes #7.

The lists pin each entry, which drift-pins-on-base now confirms.

PR-feedback round 2: the drift-pins-on-base behaviour is now covered by a
third test case.

**Docs sweep** — section: none — no manual documents this flag

## Test Plan

- Added \`tests/rule_test.ts\` (3 tests).
`;

/** Base repo: code + test file + PR summary, all committed on a feature branch. */
async function setupBaseline(
  summary: string,
): Promise<{ dir: string; beforeSha: string }> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V1);
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  await writeFile(dir, SUMMARY_PATH, summary);
  await commitAll(dir, "docs: add PR summary");
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, beforeSha: rev.stdout.trim() };
}

/** Base repo with no PR summary at all, for the missing-summary case. */
async function setupBaselineNoSummary(): Promise<
  { dir: string; beforeSha: string }
> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V1);
  await writeFile(dir, "docs/notes.md", "Some notes.\n");
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, beforeSha: rev.stdout.trim() };
}

const DEFAULT_INPUT = { repo: "org/repo", prNumber: 7 };

// ---------------------------------------------------------------------------
// (a) Acceptance test: a test-only push appends a round-2 correction below
// a change-request-quoted sentence instead of rewriting it.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a test-only push that leaves a change-request-quoted sentence standing under a round-2 note is reported with the stale quote", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_WITH_SENTENCE);
  try {
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_WITH_SENTENCE_AND_ROUND2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        { ok: true, output: "did nothing" },
      ],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      {
        ...DEFAULT_INPUT,
        repoPath: dir,
        beforeSha,
        changeRequest: CHANGE_REQUEST,
      },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 2);
    assertEquals(calls[0]!.readOnly, true);
    assertStringIncludes(calls[0]!.prompt, CHANGE_REQUEST);
    assertEquals(calls[1]!.readOnly, false);
    assertStringIncludes(calls[1]!.prompt, QUOTE);

    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assert(
        outcome.residual.staleQuotes?.some((q) =>
          q.includes(QUOTE) && q.includes(SUMMARY_PATH)
        ),
      );
    }

    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(message, QUOTE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// (b) Same, but the recovery turn actually rewrites the sentence away.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a recovery turn that rewrites the stale quoted sentence away reports recovered", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_WITH_SENTENCE);
  try {
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_WITH_SENTENCE_AND_ROUND2);

    const calls: AgentCall[] = [];
    const baseRunAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        { ok: true, output: "fixed" },
      ],
      calls,
    );
    const runAgent: DriftCheckDeps["runAgent"] = async (req) => {
      const result = await baseRunAgent(req);
      if (!req.readOnly) {
        await writeFile(dir, SUMMARY_PATH, SUMMARY_WITH_SENTENCE_REMOVED);
      }
      return result;
    };

    const outcome = await runPrFeedbackDriftCheck(
      {
        ...DEFAULT_INPUT,
        repoPath: dir,
        beforeSha,
        changeRequest: CHANGE_REQUEST,
      },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 2);
    assertEquals(outcome.status, "recovered");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// (c) A docs-only push (no code, no test file) still runs the recovery turn
// off the stale-quote hit alone — no model pass.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a docs-only push with a still-present quoted sentence makes no model call but still runs the recovery turn", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_WITH_SENTENCE);
  try {
    // Docs-only push: only the summary changes, appending (not rewriting)
    // a round-2 note below the quoted sentence.
    await writeFile(dir, SUMMARY_PATH, SUMMARY_WITH_SENTENCE_AND_ROUND2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: "did nothing" }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      {
        ...DEFAULT_INPUT,
        repoPath: dir,
        beforeSha,
        changeRequest: CHANGE_REQUEST,
      },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, false);
    assertStringIncludes(calls[0]!.prompt, QUOTE);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertEquals(outcome.residual.findings, []);
      assertEquals(outcome.residual.mismatches, []);
      assertEquals(outcome.residual.docsSweepProblems, []);
    }

    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(
      message,
      "found text it leaves out of step with the code",
    );
    assert(!message.includes("could not check it fully"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a docs-only push where the recovery turn removes the quoted sentence reports recovered", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_WITH_SENTENCE);
  try {
    await writeFile(dir, SUMMARY_PATH, SUMMARY_WITH_SENTENCE_AND_ROUND2);

    const calls: AgentCall[] = [];
    const baseRunAgent = makeRunAgent(
      [{ ok: true, output: "fixed" }],
      calls,
    );
    const runAgent: DriftCheckDeps["runAgent"] = async (req) => {
      const result = await baseRunAgent(req);
      if (!req.readOnly) {
        await writeFile(dir, SUMMARY_PATH, SUMMARY_WITH_SENTENCE_REMOVED);
      }
      return result;
    };

    const outcome = await runPrFeedbackDriftCheck(
      {
        ...DEFAULT_INPUT,
        repoPath: dir,
        beforeSha,
        changeRequest: CHANGE_REQUEST,
      },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 1);
    assertEquals(outcome.status, "recovered");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// (d) A test-only push with NO change request still gets a model pass —
// the base-code push would have made none.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a test-only push with no change request still makes a model call", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_WITHOUT_SENTENCE);
  try {
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
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

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// (e) The change request quotes a sentence already gone from the summary —
// clean, no recovery beyond the model pass.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a change request quoting a sentence already gone from the summary is clean", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_WITHOUT_SENTENCE);
  try {
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      {
        ...DEFAULT_INPUT,
        repoPath: dir,
        beforeSha,
        changeRequest: CHANGE_REQUEST,
      },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 1);
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// (f) A finding names a pr-summary that does not exist at the head.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a finding naming a pr-summary that does not exist at the head is reported with quoteCheckUnavailable and no recovery call", async () => {
  const { dir, beforeSha } = await setupBaselineNoSummary();
  try {
    // Docs-only push — no code, no test file, so no model call either.
    await writeFile(dir, "docs/notes.md", "Updated notes.\n");

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent([], calls);

    const outcome = await runPrFeedbackDriftCheck(
      {
        ...DEFAULT_INPUT,
        repoPath: dir,
        beforeSha,
        changeRequest: CHANGE_REQUEST_MISSING_SUMMARY,
      },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 0, "no model call and no recovery call");
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertStringIncludes(
        outcome.residual.quoteCheckUnavailable ?? "",
        MISSING_SUMMARY_PATH,
      );
      assertEquals(outcome.residual.staleQuotes ?? [], []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// (g) Unit tests: buildDriftQuestionPrompt, buildDriftRecoveryPrompt,
// formatDriftResidual.
// ---------------------------------------------------------------------------

Deno.test("buildDriftQuestionPrompt - fences the change request only when given, and always carries the internal-contradiction clause", () => {
  const withoutChangeRequest = buildDriftQuestionPrompt({
    repo: "org/repo",
    prNumber: 7,
    beforeSha: "abc1234",
    baseRef: undefined,
    files: ["docs/x.md"],
  });
  assert(
    !withoutChangeRequest.includes("The change request this push answers:"),
  );
  assertStringIncludes(withoutChangeRequest, "PR-feedback round N");
  assert(
    !withoutChangeRequest.includes(
      "Confirm each one has been rewritten or removed",
    ),
  );

  const withChangeRequest = buildDriftQuestionPrompt({
    repo: "org/repo",
    prNumber: 7,
    beforeSha: "abc1234",
    baseRef: undefined,
    files: ["docs/x.md"],
    changeRequest: CHANGE_REQUEST,
  });
  assertStringIncludes(
    withChangeRequest,
    "The change request this push answers:",
  );
  assertStringIncludes(withChangeRequest, CHANGE_REQUEST);
  assertStringIncludes(withChangeRequest, "PR-feedback round N");
  assertStringIncludes(
    withChangeRequest,
    "Confirm each one has been rewritten or removed",
  );
});

Deno.test("buildDriftRecoveryPrompt - fences stale quotes only when given, and the 'do not append' step only then", () => {
  const withoutStaleQuotes = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [],
    mismatches: ["a mismatch"],
    docsSweepProblems: [],
  });
  assert(
    !withoutStaleQuotes.includes(
      "Sentences the change request quoted that are still in the summary:",
    ),
  );
  assert(!withoutStaleQuotes.includes("do not append"));

  const staleQuotes = [`${SUMMARY_PATH}: "${QUOTE}"`];
  const withStaleQuotes = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    staleQuotes,
  });
  assertStringIncludes(
    withStaleQuotes,
    "Sentences the change request quoted that are still in the summary:",
  );
  assertStringIncludes(withStaleQuotes, QUOTE);
  assertStringIncludes(withStaleQuotes, "do not append");
});

Deno.test("formatDriftResidual - a staleQuotes-only residual lists the quote under the 'found text' intro", () => {
  const staleQuotes = [`${SUMMARY_PATH}: "${QUOTE}"`];
  const text = formatDriftResidual({
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    staleQuotes,
  });
  assertStringIncludes(text, "found text this push leaves");
  assertStringIncludes(text, QUOTE);
});

Deno.test("formatDriftResidual - a quoteCheckUnavailable-only residual prints only that line, no 'found text' intro", () => {
  const text = formatDriftResidual({
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    quoteCheckUnavailable:
      `the change request names ${MISSING_SUMMARY_PATH} but it could not ` +
      "be read at the head, so its quoted sentences were not checked",
  });
  assert(!text.includes("found text this push leaves"));
  assertStringIncludes(text, MISSING_SUMMARY_PATH);
});
