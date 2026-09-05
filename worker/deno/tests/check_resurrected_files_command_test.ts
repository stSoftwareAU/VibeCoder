/**
 * Tests for the `check-resurrected-files` command (Issue #1048).
 *
 * The command is what the CI gate runs, so its exit verdict is the whole
 * contract: green only when the branch is genuinely clean, and never green
 * because an argument was missing or git could not be read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkResurrectedFilesCommand } from "../commands/check_resurrected_files.ts";
import type { ResurrectionReport } from "../lib/resurrected_file_check.ts";
import type { WorkerConfig } from "../types.ts";

const config = {} as WorkerConfig;

/** Run git in `cwd`, failing loud so a mis-built fixture is never a pass. */
async function gitOk(cwd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `fixture: git ${args.join(" ")} exited ${out.code}: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

/** A repository whose `milestone/x` branch resurrects `doomed.ts`. */
async function repoWithResurrection(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "resurrection_cmd_" });
  await gitOk(dir, ["init", "--initial-branch=main"]);
  await gitOk(dir, ["config", "user.email", "test@example.com"]);
  await gitOk(dir, ["config", "user.name", "Test User"]);
  await gitOk(dir, ["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${dir}/README.md`, "# fixture\n");
  await Deno.writeTextFile(`${dir}/doomed.ts`, "export const x=1;\n");
  await gitOk(dir, ["add", "."]);
  await gitOk(dir, ["commit", "-m", "Initial commit"]);
  await gitOk(dir, ["branch", "milestone/x"]);
  await gitOk(dir, ["rm", "doomed.ts"]);
  await gitOk(dir, ["commit", "-m", "Delete doomed.ts (Issue #805)"]);
  // The branch puts it back under its own commit.
  await gitOk(dir, ["checkout", "milestone/x"]);
  await Deno.writeTextFile(`${dir}/doomed.ts`, "export const x=2;\n");
  await gitOk(dir, ["add", "doomed.ts"]);
  await gitOk(dir, ["commit", "-m", "Modify doomed.ts"]);
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

Deno.test("check-resurrected-files - fails and names the file and deleting commit", async () => {
  const dir = await repoWithResurrection();
  try {
    const deletingSha = (await gitOk(dir, ["rev-parse", "main"])).trim();
    const result = await checkResurrectedFilesCommand.execute({
      "repo-dir": dir,
      "branch": "milestone/x",
      "default-branch": "main",
    }, config);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "doomed.ts");
    assertStringIncludes(result.message, deletingSha.slice(0, 8));
    assertStringIncludes(result.message, "Issue #805");
    const report = result.data as ResurrectionReport | undefined;
    assertEquals(report?.resurrected.length, 1);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("check-resurrected-files - passes on a clean branch", async () => {
  const dir = await repoWithResurrection();
  try {
    const result = await checkResurrectedFilesCommand.execute({
      "repo-dir": dir,
      "branch": "main",
      "default-branch": "main",
    }, config);
    assertEquals(result.success, true);
    const report = result.data as ResurrectionReport | undefined;
    assertEquals(report?.resurrected, []);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("check-resurrected-files - refuses without --default-branch", async () => {
  const result = await checkResurrectedFilesCommand.execute({
    "repo-dir": ".",
    "branch": "HEAD",
  }, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--default-branch");
});

Deno.test("check-resurrected-files - a git failure is a failure, never a clean branch", async () => {
  const dir = await Deno.makeTempDir({ prefix: "resurrection_cmd_nogit_" });
  try {
    // Not a git repository at all: every command fails.
    const result = await checkResurrectedFilesCommand.execute({
      "repo-dir": dir,
      "branch": "HEAD",
      "default-branch": "main",
    }, config);
    assertEquals(result.success, false);
    assert(
      result.data === undefined,
      "an unreadable repository must not produce a report",
    );
  } finally {
    await cleanup(dir);
  }
});
