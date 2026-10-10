/**
 * Tests for the review-fix drift check's manual/prompt prose pass (Issue
 * #3347): a push that only edits a manual line still gets the model question,
 * with the shared doc-prose instruction.
 *
 * Real temporary git repos, as in the #3143 tests.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDriftQuestionPrompt,
  type DriftCheckDeps,
  type DriftFinding,
  runPrFeedbackDriftCheck,
} from "../lib/pr_feedback_drift_check.ts";

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
  const dir = await Deno.makeTempDir({ prefix: "drift_check_3347_" });
  assertEquals((await git(dir, ["init", "-b", "main"])).code, 0);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function makeRunGit(dir: string): DriftCheckDeps["runGit"] {
  return async (args: string[]) => await git(dir, args);
}

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

function noopLogger(): DriftCheckDeps["logger"] {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function verdictBlock(findings: DriftFinding[]): string {
  return [
    "<!-- vibe-drift-verdict -->",
    "```json",
    JSON.stringify({ findings }, null, 2),
    "```",
    "<!-- /vibe-drift-verdict -->",
  ].join("\n");
}

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";
const MANUAL_PATH = "docs/manual.md";
const DOC_PHRASE = "check only the lines this push's change adds or edits";
const ADDED = "The rule only ever rejects a subjectless entry.";
const DEFAULT_INPUT = { repo: "org/repo", prNumber: 7 };

const SUMMARY = `## Summary

Closes #7.

Docs only.

**Docs sweep** — section: none — nothing documented
`;

async function setupBaseline(): Promise<{ dir: string; beforeSha: string }> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", "export const rule = 1;\n");
  await writeFile(dir, MANUAL_PATH, "# Manual\n\nThe rule exists.\n");
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  await writeFile(dir, SUMMARY_PATH, SUMMARY);
  await commitAll(dir, "docs: add PR summary");
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, beforeSha: rev.stdout.trim() };
}

async function addManualSentence(dir: string) {
  await writeFile(
    dir,
    MANUAL_PATH,
    `# Manual\n\nThe rule exists.\n\n${ADDED}\n`,
  );
}

Deno.test("runPrFeedbackDriftCheck - a push that edits only a manual makes one read-only model call and reports clean on an empty verdict", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await addManualSentence(dir);
    const calls: AgentCall[] = [];
    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent: makeRunAgent([{ ok: true, output: verdictBlock([]) }], calls),
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, true);
    assertStringIncludes(calls[0]!.prompt, MANUAL_PATH);
    assertStringIncludes(calls[0]!.prompt, DOC_PHRASE);
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a manual sentence the verdict reports drives one recovery turn and is reported when left standing", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await addManualSentence(dir);
    const calls: AgentCall[] = [];
    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent: makeRunAgent(
          [
            {
              ok: true,
              output: verdictBlock([{
                file: MANUAL_PATH,
                sentence: ADDED,
                reason: "lib/rule.ts:1 never rejects anything",
              }]),
            },
            { ok: true, output: "did nothing" },
          ],
          calls,
        ),
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 2);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(calls[1]!.readOnly, false);
    assertStringIncludes(calls[1]!.prompt, ADDED);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertEquals(outcome.residual.findings.length, 1);
      assertEquals(outcome.residual.findings[0]!.file, MANUAL_PATH);
      assertEquals(outcome.residual.findings[0]!.sentence, ADDED);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a push that edits only the PR summary still makes no model call", async () => {
  const { dir, beforeSha } = await setupBaseline();
  try {
    await writeFile(dir, SUMMARY_PATH, SUMMARY + "\nAn extra line.\n");
    const calls: AgentCall[] = [];
    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent: makeRunAgent([], calls),
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 0);
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildDriftQuestionPrompt - the doc-prose instruction appears only when a manual is listed", () => {
  const base = {
    repo: "org/repo",
    prNumber: 7,
    beforeSha: "a".repeat(40),
    baseRef: "main",
  };
  const summaryOnly = buildDriftQuestionPrompt({
    ...base,
    files: [SUMMARY_PATH],
  });
  assert(!summaryOnly.includes(DOC_PHRASE));

  const withManual = buildDriftQuestionPrompt({
    ...base,
    files: [SUMMARY_PATH, MANUAL_PATH],
  });
  assertStringIncludes(withManual, DOC_PHRASE);
  assertStringIncludes(withManual, "A sentence that was already false");
});

Deno.test("runPrFeedbackDriftCheck - a pushed manual is still questioned when the PR carries more docs than the file cap", async () => {
  const { dir } = await setupBaseline();
  try {
    // 45 other (non-manual) docs, edited by this push too; they sort before
    // docs/manual.md, so without manual-first ordering the cap drops it.
    for (let i = 0; i < 45; i++) {
      await writeFile(dir, `docs/a${i}.txt`, `Doc ${i}.\n`);
    }
    await commitAll(dir, "docs: many other docs");
    const rev = await git(dir, ["rev-parse", "HEAD"]);
    for (let i = 0; i < 45; i++) {
      await writeFile(dir, `docs/a${i}.txt`, `Doc ${i} edited.\n`);
    }
    await addManualSentence(dir);

    const calls: AgentCall[] = [];
    const warnings: string[] = [];
    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha: rev.stdout.trim() },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent: makeRunAgent([{ ok: true, output: verdictBlock([]) }], calls),
        logger: {
          info: () => {},
          warn: (message: string) => warnings.push(message),
          error: () => {},
        },
      },
    );

    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0]!.prompt, MANUAL_PATH);
    assertEquals(outcome.status, "clean");
    assert(warnings.some((w) => w.includes("over the 40-file cap")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
