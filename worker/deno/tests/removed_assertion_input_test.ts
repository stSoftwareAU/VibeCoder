/**
 * Unit tests for `readRemovedAssertionInput` (Issues #3131, #4234).
 *
 * Each test builds its own temporary git repository with `git init`, so no
 * checkout history is needed. Uses Australian English throughout (behaviour,
 * colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitRunner } from "../lib/git_base_ref.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { MAX_DIFF_CHARS } from "../lib/removed_assertion_gate.ts";
import { readRemovedAssertionInput } from "../lib/removed_assertion_input.ts";

const TEST_FILE = "tests/foo_test.ts";
const RENAMED_FILE = "tests/bar_test.ts";
const REMOVED_LINE = "  assertEquals(result.code, 0);";

const BASE_TEST = [
  'Deno.test("foo", () => {',
  "  const result = run();",
  REMOVED_LINE,
  "  assertEquals(result.other, 1);",
  "});",
  "",
].join("\n");

const WITHOUT_LINE = BASE_TEST.replace(REMOVED_LINE + "\n", "");

/** Run git in `dir`; throws when git fails, so a broken fixture is loud. */
async function git(dir: string, args: string[]): Promise<void> {
  const r = await runGitCommand(args, { cwd: dir });
  if (!r.ok || r.value.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        r.ok ? r.value.stderr : r.error.message
      }`,
    );
  }
}

/** Stage and commit everything in `dir` with a fixed identity. */
async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

/**
 * A repository with `main` holding `BASE_TEST` and a `feature` branch checked
 * out, ready for the caller to change the branch.
 */
async function repoWithFeatureBranch(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "removed-assertion-input-" });
  await git(dir, ["init", "-q"]);
  await git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await Deno.mkdir(`${dir}/tests`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${TEST_FILE}`, BASE_TEST);
  await commitAll(dir, "base");
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  return dir;
}

/** The real runner, bound to `dir`. */
function runnerIn(dir: string): GitRunner {
  return (args) => runGitCommand(args, { cwd: dir });
}

/** Captures warnings, so each test can assert which one fired. */
function captureWarnings(): { warn(message: string): void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message: string) => lines.push(message), lines };
}

Deno.test("readRemovedAssertionInput - a plain edit yields the test file and its patch", async () => {
  const dir = await repoWithFeatureBranch();
  try {
    await Deno.writeTextFile(`${dir}/${TEST_FILE}`, WITHOUT_LINE);
    await commitAll(dir, "feature");
    const logger = captureWarnings();
    const input = await readRemovedAssertionInput({
      runGit: runnerIn(dir),
      base: "main",
      changedFiles: [TEST_FILE],
      changedFilesKnown: true,
      logger,
    });
    assertEquals(input.testFiles, [TEST_FILE]);
    assert(input.testDiff !== null);
    assertStringIncludes(input.testDiff, `-${REMOVED_LINE}`);
    assertEquals(logger.lines, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRemovedAssertionInput - a renamed test file contributes both sides to the pathspec and the patch", async () => {
  const dir = await repoWithFeatureBranch();
  try {
    await git(dir, ["mv", TEST_FILE, RENAMED_FILE]);
    await Deno.writeTextFile(`${dir}/${RENAMED_FILE}`, WITHOUT_LINE);
    await commitAll(dir, "rename and edit");
    const input = await readRemovedAssertionInput({
      runGit: runnerIn(dir),
      base: "main",
      changedFiles: [RENAMED_FILE],
      changedFilesKnown: true,
    });
    assertEquals(input.testFiles.sort(), [RENAMED_FILE, TEST_FILE].sort());
    assert(input.testDiff !== null);
    assertStringIncludes(input.testDiff, `-${REMOVED_LINE}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRemovedAssertionInput - an unresolvable base is a failed git call, so null and the sides warning", async () => {
  const dir = await repoWithFeatureBranch();
  try {
    const logger = captureWarnings();
    const input = await readRemovedAssertionInput({
      runGit: runnerIn(dir),
      base: "no-such-ref",
      changedFiles: [TEST_FILE],
      changedFilesKnown: true,
      logger,
    });
    assertEquals(input, { testDiff: null, testFiles: [] });
    assertEquals(logger.lines, [
      "Could not list both sides of renamed test files for the removed-assertion gate — only the Test Plan heading rule applies",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRemovedAssertionInput - a failed or unrunnable diff call is null, with the diff warning", async () => {
  const dir = await repoWithFeatureBranch();
  try {
    await Deno.writeTextFile(`${dir}/${TEST_FILE}`, WITHOUT_LINE);
    await commitAll(dir, "feature");
    const real = runnerIn(dir);
    const warningText =
      "Could not read the test-file diff for the removed-assertion gate — only the Test Plan heading rule applies";

    const exits: GitRunner = (args) =>
      args.includes("--unified=4000000")
        ? Promise.resolve({
          ok: true as const,
          value: { code: 128, stdout: "", stderr: "fatal" },
        })
        : real(args);
    const exited = captureWarnings();
    assertEquals(
      await readRemovedAssertionInput({
        runGit: exits,
        base: "main",
        changedFiles: [TEST_FILE],
        changedFilesKnown: true,
        logger: exited,
      }),
      { testDiff: null, testFiles: [TEST_FILE] },
    );
    assertEquals(exited.lines, [warningText]);

    const spawnFails: GitRunner = (args) =>
      args.includes("--unified=4000000")
        ? Promise.resolve({ ok: false as const, error: new Error("spawn") })
        : real(args);
    const unrunnable = captureWarnings();
    const result = await readRemovedAssertionInput({
      runGit: spawnFails,
      base: "main",
      changedFiles: [TEST_FILE],
      changedFilesKnown: true,
      logger: unrunnable,
    });
    assertEquals(result.testDiff, null);
    assertEquals(unrunnable.lines, [warningText]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRemovedAssertionInput - a patch at the read cap is null, with the cap warning", async () => {
  const dir = await repoWithFeatureBranch();
  try {
    await Deno.writeTextFile(`${dir}/${TEST_FILE}`, WITHOUT_LINE);
    await commitAll(dir, "feature");
    const real = runnerIn(dir);
    const atCap: GitRunner = (args) =>
      args.includes("--unified=4000000")
        ? Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: "x".repeat(MAX_DIFF_CHARS),
            stderr: "",
          },
        })
        : real(args);
    const logger = captureWarnings();
    const input = await readRemovedAssertionInput({
      runGit: atCap,
      base: "main",
      changedFiles: [TEST_FILE],
      changedFilesKnown: true,
      logger,
    });
    assertEquals(input.testDiff, null);
    assertEquals(logger.lines.length, 1);
    assertStringIncludes(logger.lines[0]!, "reached the read cap");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRemovedAssertionInput - no test file changed means no diff call", async () => {
  const dir = await repoWithFeatureBranch();
  try {
    await Deno.mkdir(`${dir}/lib`, { recursive: true });
    await Deno.writeTextFile(`${dir}/lib/foo.ts`, "export const x = 1;\n");
    await commitAll(dir, "feature");
    const real = runnerIn(dir);
    const calls: string[][] = [];
    const recording: GitRunner = (args, options) => {
      calls.push(args);
      return real(args, options);
    };
    const input = await readRemovedAssertionInput({
      runGit: recording,
      base: "main",
      changedFiles: ["lib/foo.ts"],
      changedFilesKnown: true,
    });
    assertEquals(input, { testDiff: null, testFiles: [] });
    assertEquals(calls.length, 1, "only the rename-status call runs");
    assertEquals(calls[0]![0], "diff");
    assert(calls[0]!.includes("--name-status"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRemovedAssertionInput - an unknown changed-files list reads the whole patch, applying the gate", async () => {
  const dir = await repoWithFeatureBranch();
  try {
    await Deno.writeTextFile(`${dir}/${TEST_FILE}`, WITHOUT_LINE);
    await commitAll(dir, "feature");
    const input = await readRemovedAssertionInput({
      runGit: runnerIn(dir),
      base: "main",
      changedFiles: [],
      changedFilesKnown: false,
    });
    assertEquals(input.testFiles, []);
    assert(input.testDiff !== null);
    assertStringIncludes(input.testDiff, `-${REMOVED_LINE}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
