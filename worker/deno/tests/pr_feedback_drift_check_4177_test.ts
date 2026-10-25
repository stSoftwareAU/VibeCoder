// Cap overflow in the review-fix drift check is one warning (Issue #4177).
// The logger level is warn; the
// message text does not also start with WARNING:.
// Uses Australian English throughout.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runPrFeedbackDriftCheck } from "../lib/pr_feedback_drift_check.ts";

async function git(dir: string, args: string[]) {
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

Deno.test("a 20-range overflow logs one warning, not one line per range (Issue #4177)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "drift_check_4177_" });
  try {
    assertEquals((await git(dir, ["init", "-b", "main"])).code, 0);
    await git(dir, ["config", "user.name", "test"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await Deno.writeTextFile(`${dir}/README.md`, "base\n");
    assertEquals((await git(dir, ["add", "."])).code, 0);
    assertEquals((await git(dir, ["commit", "-m", "base"])).code, 0);
    assertEquals(
      (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
      0,
    );
    const names = Array.from(
      { length: 40 },
      (_, i) => `docs/manual-${String(i).padStart(2, "0")}.md`,
    );
    for (const name of names) {
      const full = `${dir}/${name}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, "# Title\n\nA sentence.\n");
    }
    assertEquals((await git(dir, ["add", "."])).code, 0);
    assertEquals((await git(dir, ["commit", "-m", "manuals"])).code, 0);
    const beforeSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    for (const name of names) {
      await Deno.writeTextFile(
        `${dir}/${name}`,
        "# Title\n\nA changed sentence.\n",
      );
    }
    const warnings: string[] = [];
    await runPrFeedbackDriftCheck(
      { repo: "org/repo", prNumber: 12, repoPath: dir, beforeSha },
      {
        runGit: (args) => git(dir, args),
        runGh: async () => "main\n",
        runMutationCheck: async () => ({
          kind: "not_applicable",
          reason: "not under test",
        }),
        logger: {
          info: () => {},
          error: () => {},
          warn: (message) => warnings.push(message),
        },
        runAgent: async () => ({
          ok: true,
          output: [
            "<!-- vibe-drift-verdict -->",
            "```json",
            JSON.stringify({ findings: [] }),
            "```",
            "<!-- /vibe-drift-verdict -->",
          ].join("\n"),
        }),
      },
    );
    const capWarns = warnings.filter((w) =>
      w.includes("doc-prose range(s) over a cap")
    );
    assertEquals(capWarns.length, 1);
    assertEquals(warnings.length, 1);
    const warning = capWarns[0]!;
    assert(warning.startsWith("Drift check:"));
    assertFalseStarts(warning);
    assertStringIncludes(warning, "20 doc-prose range(s) over a cap");
    assertStringIncludes(warning, "(first 3)");
    assertStringIncludes(warning, "docs/manual-20.md");
    assertStringIncludes(warning, "and 17 more");
    assert(!warning.includes("docs/manual-39.md"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function assertFalseStarts(warning: string) {
  assert(
    !warning.startsWith("WARNING:"),
    "the warn message must not also start with WARNING:",
  );
}
