/**
 * Tests for the Issue #3341 wiring of the stale Branch-outcomes line
 * citation check (`branch_outcome_citations.ts`) into the post-agent drift
 * check (`pr_feedback_drift_check.ts`, Issue #3143).
 *
 * Real temporary git repos throughout, mirroring
 * `pr_feedback_drift_check_3244_test.ts` — the module's whole job is reading
 * `git diff`/`git show`/`git ls-tree` output and the current working tree,
 * so a fake git seam would not exercise the thing that actually drifted in
 * production. Tests that need a specific git call to fail wrap the real
 * `runGit` and intercept just that one call.
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
  type DriftFinding,
  formatDriftResidual,
  runPrFeedbackDriftCheck,
} from "../lib/pr_feedback_drift_check.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";

// ---------------------------------------------------------------------------
// Test-repo scaffolding (copied from pr_feedback_drift_check_3244_test.ts;
// these helpers are file-local there).
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
  const dir = await Deno.makeTempDir({ prefix: "drift_check_3341_" });
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
// Fixtures: lib/rule.ts, a cited line at 2, a fix push that inserts lines
// above it so line 2 moves without the summary's citation being renumbered.
// ---------------------------------------------------------------------------

const RULE_TS_V1 =
  `export function checkRule(entry: { subject?: string }): boolean {
  if (!entry.subject) return true;
  return entry.subject.length > 0;
}
`;

// Inserts two lines above the cited line (originally line 2), moving it to
// line 4, and leaves the rest of the file (and its behaviour) unchanged.
const RULE_TS_V2 =
  `export function checkRule(entry: { subject?: string }): boolean {
  // A comment added by the fix push.
  // Another comment line.
  if (!entry.subject) return true;
  return entry.subject.length > 0;
}
`;

const RULE_TEST_TS = `import { assertEquals } from "@std/assert";
import { checkRule } from "../lib/rule.ts";

Deno.test("checkRule - accepts a subject", () => {
  assertEquals(checkRule({ subject: "x" }), true);
});
`;

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";

const OLD_CITATION = "lib/rule.ts:2";
const NEW_CITATION = "lib/rule.ts:4";

function summaryCiting(citation: string): string {
  return `## Summary

Closes #7.

**Branch outcomes:**

- A missing subject is accepted — \`${citation}\` — tested by \`tests/rule_test.ts::checkRule - accepts a subject\`.

**Docs sweep** — section: none — no manual documents this flag; siblings: none — no existing set gained a member

## Test Plan

- Added \`tests/rule_test.ts\` (1 test).
`;
}

const SUMMARY_STALE = summaryCiting(OLD_CITATION);
const SUMMARY_RENUMBERED = summaryCiting(NEW_CITATION);

/** A file this push changes but the summary never cites. */
const UNCITED_FILE_V1 = "Some notes.\n";
const UNCITED_FILE_V2 = "Some notes, updated.\n";

const DEFAULT_INPUT = { repo: "org/repo", prNumber: 7 };

/** Base repo: code + test + PR summary, all committed on a feature branch. */
async function setupBaseline(
  summary: string,
): Promise<{ dir: string; beforeSha: string }> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_TS);
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

/** Base repo with no PR summary committed at all. */
async function setupBaselineNoSummary(): Promise<
  { dir: string; beforeSha: string }
> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_TS);
  await writeFile(dir, "docs/notes.md", UNCITED_FILE_V1);
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, beforeSha: rev.stdout.trim() };
}

// ---------------------------------------------------------------------------
// 1. A fix push moves the cited line; the summary keeps the old citation.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a push that moves a cited line without renumbering the summary is reported with the stale citation", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_STALE);
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    await assertRejects(() => Deno.lstat(prResponseMessagePath(dir)));

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
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(calls[1]!.readOnly, false);
    assertStringIncludes(calls[1]!.prompt, OLD_CITATION);
    assertStringIncludes(calls[1]!.prompt, NEW_CITATION);

    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assert(
        outcome.residual.staleCitations?.some((c) =>
          c.includes(OLD_CITATION) && c.includes(NEW_CITATION)
        ),
      );
    }

    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(message, OLD_CITATION);
    assertStringIncludes(message, NEW_CITATION);
    assertStringIncludes(
      message,
      "found text it leaves out of step with the code",
    );
    assert(!message.includes("could not check it fully"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Same diff, but the summary in the working tree was already renumbered
// as part of this push — clean, no recovery call.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a push that moves a cited line AND renumbers the summary is clean", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_STALE);
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_RENUMBERED);

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
// 3. Same as 1, but the recovery turn fixes the citation — recovered.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a recovery turn that renumbers the stale citation reports recovered", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_STALE);
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

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
        await writeFile(dir, SUMMARY_PATH, SUMMARY_RENUMBERED);
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

    assertEquals(calls.length, 2);
    assertEquals(outcome.status, "recovered");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The push changes a file the summary does not cite — clean.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a push that changes an uncited file is clean", async () => {
  const { dir } = await setupBaseline(SUMMARY_STALE);
  try {
    await writeFile(dir, "docs/notes.md", UNCITED_FILE_V1);
    await commitAll(dir, "docs: add notes");
    const rev = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(dir, "docs/notes.md", UNCITED_FILE_V2);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha: rev.stdout.trim() },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 5. The summary did not exist at beforeSha (new in this push) — clean,
// nothing to compare against even though the push moves lines.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a summary new in this push is clean even though lines moved", async () => {
  const { dir, beforeSha } = await setupBaselineNoSummary();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_RENUMBERED);

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

    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 6. The `git ls-tree` call for the summary fails — reported with
// citationCheckUnavailable, no recovery turn.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a failed ls-tree read of the before-run summary is reported unavailable with no recovery turn", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_STALE);
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const realRunGit = makeRunGit(dir);
    const runGit: DriftCheckDeps["runGit"] = async (args) => {
      if (args[0] === "ls-tree") {
        return { code: 128, stdout: "", stderr: "boom" };
      }
      return await realRunGit(args);
    };

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      { runGit, runGh: makeRunGh(), runAgent, logger: noopLogger() },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertStringIncludes(
        outcome.residual.citationCheckUnavailable ?? "",
        SUMMARY_PATH,
      );
      assertEquals(outcome.residual.staleCitations ?? [], []);
    }
    assert(
      !calls.some((c) => !c.readOnly),
      "no recovery (non-readOnly) call",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 7. The `git diff -U0` call for the cited file fails — reported,
// citationCheckUnavailable mentions the citation, no recovery turn.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a failed diff read of the cited file is reported unavailable with no recovery turn", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_STALE);
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const realRunGit = makeRunGit(dir);
    const runGit: DriftCheckDeps["runGit"] = async (args) => {
      if (args[0] === "diff" && args.includes("-U0")) {
        return { code: 128, stdout: "", stderr: "boom" };
      }
      return await realRunGit(args);
    };

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      { runGit, runGh: makeRunGh(), runAgent, logger: noopLogger() },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertStringIncludes(
        outcome.residual.citationCheckUnavailable ?? "",
        OLD_CITATION,
      );
    }
    assert(
      !calls.some((c) => !c.readOnly),
      "no recovery (non-readOnly) call",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 7b. The `git show <sha>:<summary>` call fails (ls-tree delegates to real
// git) — reported, citationCheckUnavailable mentions the summary could not
// be read at the before-run head, no recovery turn.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a failed show read of the before-run summary is reported unavailable with no recovery turn", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_STALE);
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);

    const realRunGit = makeRunGit(dir);
    const runGit: DriftCheckDeps["runGit"] = async (args) => {
      if (args[0] === "show") {
        return { code: 128, stdout: "", stderr: "boom" };
      }
      return await realRunGit(args);
    };

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      { runGit, runGh: makeRunGh(), runAgent, logger: noopLogger() },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertStringIncludes(
        outcome.residual.citationCheckUnavailable ?? "",
        "could not read the summary at the before-run head",
      );
      assertEquals(outcome.residual.staleCitations ?? [], []);
    }
    assert(
      !calls.some((c) => !c.readOnly),
      "no recovery (non-readOnly) call",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 7c. A cited file this push changed is binary — `git diff -U0` succeeds
// but `parseDiffHunks` reads it as binary (null), so the citation is
// reported unchecked rather than treated as "no hunks, nothing moved".
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a cited binary file is reported unavailable with no recovery turn", async () => {
  const dir = await initRepo();
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_TS);
    await Deno.writeFile(
      `${dir}/lib/blob.bin`,
      new Uint8Array([0, 1, 2, 0, 3, 4, 0]),
    );
    await commitAll(dir, "base");
    assertEquals(
      (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]))
        .code,
      0,
    );
    assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
    await writeFile(dir, SUMMARY_PATH, summaryCiting("lib/blob.bin:2"));
    await commitAll(dir, "docs: add PR summary");
    const rev = await git(dir, ["rev-parse", "HEAD"]);
    const beforeSha = rev.stdout.trim();

    await Deno.writeFile(
      `${dir}/lib/blob.bin`,
      new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]),
    );

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

    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertStringIncludes(
        outcome.residual.citationCheckUnavailable ?? "",
        "lib/blob.bin",
      );
    }
    assert(
      !calls.some((c) => !c.readOnly),
      "no recovery (non-readOnly) call",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 8. buildDriftRecoveryPrompt unit test.
// ---------------------------------------------------------------------------

Deno.test("buildDriftRecoveryPrompt - fences stale citations only when given, and the renumber step only then", () => {
  const withoutStaleCitations = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [],
    mismatches: ["a mismatch"],
    docsSweepProblems: [],
  });
  assert(
    !withoutStaleCitations.includes(
      "Branch outcomes citations left at the previous head's line numbers:",
    ),
  );
  assert(!withoutStaleCitations.includes("Renumber each listed"));

  const staleCitations = [
    `${SUMMARY_PATH}: Branch outcomes still cites \`${OLD_CITATION}\`, but this push moved that line to ${NEW_CITATION} — renumber it to the head`,
  ];
  const withStaleCitations = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    staleCitations,
  });
  assertStringIncludes(
    withStaleCitations,
    "Branch outcomes citations left at the previous head's line numbers:",
  );
  assertStringIncludes(withStaleCitations, OLD_CITATION);
  assertStringIncludes(withStaleCitations, "Renumber each listed");
});

// ---------------------------------------------------------------------------
// 9. formatDriftResidual unit tests.
// ---------------------------------------------------------------------------

Deno.test("formatDriftResidual - a staleCitations-only residual lists the citation under the 'found text' intro", () => {
  const staleCitations = [
    `${SUMMARY_PATH}: Branch outcomes still cites \`${OLD_CITATION}\`, but this push moved that line to ${NEW_CITATION} — renumber it to the head`,
  ];
  const text = formatDriftResidual({
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    staleCitations,
  });
  assertStringIncludes(text, "found text this push leaves");
  assertStringIncludes(text, OLD_CITATION);
});

Deno.test("formatDriftResidual - a citationCheckUnavailable-only residual prints only that line, no 'found text' intro", () => {
  const text = formatDriftResidual({
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    citationCheckUnavailable:
      `the line-citation check could not check: ${SUMMARY_PATH}: could not ` +
      "read the summary at the before-run head, so its Branch outcomes " +
      "citations were not checked",
  });
  assert(!text.includes("found text this push leaves"));
  assertStringIncludes(text, SUMMARY_PATH);
});
