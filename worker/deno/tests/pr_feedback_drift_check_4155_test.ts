// The review-fix drift check scopes archived summaries to the PR's own
// issue (Issue #4155). A base merge must not make another issue's summary
// part of the check, and an edit to one is restored.
// Uses Australian English throughout.

import { assert, assertEquals } from "@std/assert";
import {
  type DriftCheckDeps,
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

async function initRepo(branch: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "drift_check_4155_" });
  assertEquals((await git(dir, ["init", "-b", "main"])).code, 0);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(dir, "src/app.ts", "export const value = 1;\n");
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", branch])).code, 0);
  return dir;
}

const notMutationChecked: DriftCheckDeps["runMutationCheck"] = async () => ({
  kind: "not_applicable",
  reason: "not under test",
});

function verdictEmpty(): string {
  return [
    "<!-- vibe-drift-verdict -->",
    "```json",
    JSON.stringify({ findings: [] }),
    "```",
    "<!-- /vibe-drift-verdict -->",
  ].join("\n");
}

const OWN = "docs/archive/pr-summaries/pr-summary-4155.md";
const FOREIGN = "docs/archive/pr-summaries/pr-summary-3302.md";
const OWN_SUMMARY = "## Summary\n\nCloses #4155.\n";
const FOREIGN_SUMMARY = "## Summary\n\nCloses #3302.\n";

Deno.test("runPrFeedbackDriftCheck scopes Docs sweep to the PR's own summary (Issue #4155)", async () => {
  const dir = await initRepo("wip/not-an-issue");
  try {
    await writeFile(dir, OWN, OWN_SUMMARY);
    await writeFile(dir, FOREIGN, FOREIGN_SUMMARY);
    await commitAll(dir, "summaries");
    const beforeSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(dir, "src/app.ts", "export const value = 2;\n");
    const calls: { prompt: string }[] = [];
    const outcome = await runPrFeedbackDriftCheck(
      {
        repo: "org/repo",
        prNumber: 12,
        repoPath: dir,
        beforeSha,
        issueNumber: 4155,
      },
      {
        runGit: (args) => git(dir, args),
        runGh: async () => "main\n",
        runMutationCheck: notMutationChecked,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        runAgent: async (req) => {
          calls.push(req);
          return { ok: true, output: verdictEmpty() };
        },
      },
    );
    assertEquals(outcome.status, "reported");
    if (outcome.status !== "reported") return;
    assert(
      outcome.residual.docsSweepProblems.some((p) => p.includes(OWN)),
    );
    assert(
      outcome.residual.docsSweepProblems.every((p) => !p.includes(FOREIGN)),
    );
    for (const call of calls) {
      assert(!call.prompt.includes(FOREIGN));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a base merge does not make another issue's summary part of the drift check (Issue #4155)", async () => {
  const dir = await initRepo("milestone/4155-roll");
  try {
    await writeFile(dir, OWN, OWN_SUMMARY);
    await commitAll(dir, "own summary");
    assertEquals((await git(dir, ["checkout", "main"])).code, 0);
    await writeFile(dir, FOREIGN, FOREIGN_SUMMARY);
    await commitAll(dir, "merged summary");
    assertEquals(
      (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
      0,
    );
    assertEquals(
      (await git(dir, ["checkout", "milestone/4155-roll"])).code,
      0,
    );
    const beforeSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    assertEquals(
      (await git(dir, ["merge", "--no-edit", "origin/main"])).code,
      0,
    );
    await writeFile(dir, "src/app.ts", "export const value = 2;\n");
    const outcome = await runPrFeedbackDriftCheck(
      { repo: "org/repo", prNumber: 12, repoPath: dir, beforeSha },
      {
        runGit: (args) => git(dir, args),
        runGh: async () => "main\n",
        runMutationCheck: notMutationChecked,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        runAgent: async () => ({ ok: true, output: verdictEmpty() }),
      },
    );
    assertEquals(outcome.status, "reported");
    if (outcome.status !== "reported") return;
    assert(
      outcome.residual.docsSweepProblems.some((p) => p.includes(OWN)),
    );
    assert(
      outcome.residual.docsSweepProblems.every((p) => !p.includes(FOREIGN)),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an edit to another issue's archived summary is restored (Issue #4155)", async () => {
  const dir = await initRepo("issue-4155-restore");
  try {
    await writeFile(dir, FOREIGN, "## Summary\n\nThe original record.\n");
    await commitAll(dir, "foreign summary");
    const beforeSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      dir,
      FOREIGN,
      "## Summary\n\nThe original record.\n\n**Docs sweep** — added by the wrong run\n",
    );
    const warnings: string[] = [];
    await runPrFeedbackDriftCheck(
      { repo: "org/repo", prNumber: 12, repoPath: dir, beforeSha },
      {
        runGit: (args) => git(dir, args),
        runGh: async () => "main\n",
        runMutationCheck: notMutationChecked,
        logger: {
          info: () => {},
          error: () => {},
          warn: (message) => warnings.push(message),
        },
        runAgent: async () => ({ ok: true, output: verdictEmpty() }),
      },
    );
    assertEquals(
      await Deno.readTextFile(`${dir}/${FOREIGN}`),
      "## Summary\n\nThe original record.\n",
    );
    assert(warnings.some((w) => w.includes(FOREIGN) && w.includes("restored")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
