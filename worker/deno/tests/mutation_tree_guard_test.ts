/**
 * Working-tree guard for the Deno mutation gate (Issue #4905).
 *
 * Runs `runMutationCheck` against a real git repository in a temporary
 * directory, with a fake process runner that misbehaves the way a test run can
 * (writes a stray file, rewrites a tracked fixture, deletes a tracked file).
 * The fixture repository is set up through `runGitCommandChecked` (Issue #1214).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runGitCommandChecked } from "../lib/git_timeout.ts";
import {
  defaultMutationRunnerSeams,
  type MutationRunnerSeams,
  runMutationCheck,
} from "../lib/mutation_runner.ts";
import {
  isUnsafePath,
  restoreTree,
  snapshotTree,
} from "../lib/mutation_tree_guard.ts";

const MODULE = "lib/m.ts";
const SOURCE =
  "export function f(a: boolean) {\n  if (a) {\n    return 1;\n  }\n  return 2;\n}\n";
const TEST_SRC =
  'import { f } from "../lib/m.ts";\nDeno.test("t", () => f(true));\n';
const DIFF =
  `diff --git a/${MODULE} b/${MODULE}\n--- a/${MODULE}\n+++ b/${MODULE}\n` +
  "@@ -0,0 +1,6 @@\n" +
  SOURCE.split("\n").slice(0, 6).map((l) => "+" + l).join("\n") + "\n";

/** A project whose module is mutated and whose test imports it. */
const PROJECT: Record<string, string> = {
  "deno.json": "{}\n",
  [MODULE]: SOURCE,
  "tests/m_test.ts": TEST_SRC,
};

/** Git with the identity and signing settings the fixtures need. */
function git(cwd: string, args: string[]): Promise<string> {
  return runGitCommandChecked([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ], { cwd }).then((r) => {
    if (!r.ok) throw r.error;
    return r.value;
  });
}

async function writeRelative(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const abs = `${root}/${rel}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, text);
  }
}

/** A git repository with `files` committed; the caller removes it. */
async function makeRepo(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  await writeRelative(root, files);
  await git(root, ["init", "-q"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

/**
 * Run `body` with a fresh repository and a scratch directory. The scratch
 * directory is the run's TMPDIR, kept outside the repository.
 */
async function withRepo(
  files: Record<string, string>,
  body: (repo: string, scratch: string) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "mutation-tree-guard-" });
  const scratch = await Deno.makeTempDir({
    prefix: "mutation-tree-guard-tmp-",
  });
  try {
    await makeRepo(repo, files);
    await body(repo, scratch);
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
}

function seamsFor(
  scratch: string,
  runProcess: MutationRunnerSeams["runProcess"],
): MutationRunnerSeams {
  return { ...defaultMutationRunnerSeams({ TMPDIR: scratch }), runProcess };
}

const result = (code: number) => ({
  code,
  stdout: "",
  stderr: "",
  timedOut: false,
});

/** Passes only while the module is unmutated, as a real suite would. */
async function passesOnlyUnmutated(cwd: string): Promise<number> {
  const current = await Deno.readTextFile(`${cwd}/${MODULE}`);
  return current === SOURCE ? 0 : 1;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Capture `console.warn` for the duration of `fn`. */
async function captureWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

Deno.test("Issue #4905 - a stray file a test run writes is deleted and a pre-existing untracked file is kept", async () => {
  await withRepo(PROJECT, async (repo, scratch) => {
    await Deno.writeTextFile(`${repo}/keep.txt`, "keep\n");
    let runs = 0;
    const outcome = await runMutationCheck(
      { repoPath: repo, diff: DIFF, budgetSeconds: 600 },
      seamsFor(scratch, async (_cmd, _args, opts) => {
        runs++;
        await Deno.writeTextFile(`${opts.cwd}/undefined`, "stray\n");
        return result(await passesOnlyUnmutated(opts.cwd));
      }),
    );
    assertEquals(outcome.kind, "completed");
    assert(runs > 1, "the baseline and at least one mutant must have run");
    assertEquals(await exists(`${repo}/undefined`), false);
    assertEquals(await Deno.readTextFile(`${repo}/keep.txt`), "keep\n");
    assertEquals(await Deno.readTextFile(`${repo}/${MODULE}`), SOURCE);
  });
});

Deno.test("Issue #4905 - a tracked fixture a test run rewrites is checked out again, and an earlier uncommitted edit is kept", async () => {
  await withRepo({
    ...PROJECT,
    "fixtures/data.json": '{"v":1}\n',
    "notes.txt": "base\n",
  }, async (repo, scratch) => {
    await Deno.writeTextFile(`${repo}/notes.txt`, "base\nedited\n");
    let runs = 0;
    const outcome = await runMutationCheck(
      { repoPath: repo, diff: DIFF, budgetSeconds: 600 },
      seamsFor(scratch, async (_cmd, _args, opts) => {
        runs++;
        await Deno.writeTextFile(
          `${opts.cwd}/fixtures/data.json`,
          '{"v":"rewritten"}\n',
        );
        return result(await passesOnlyUnmutated(opts.cwd));
      }),
    );
    assertEquals(outcome.kind, "completed");
    assert(runs > 1, "the baseline and at least one mutant must have run");
    assertEquals(
      await Deno.readTextFile(`${repo}/fixtures/data.json`),
      '{"v":1}\n',
    );
    assertEquals(
      await Deno.readTextFile(`${repo}/notes.txt`),
      "base\nedited\n",
    );
  });
});

Deno.test("Issue #4905 - a mutant run that deletes a tracked file gets it back from git", async () => {
  await withRepo({
    ...PROJECT,
    "fixtures/gone.txt": "keep me\n",
  }, async (repo, scratch) => {
    let deletions = 0;
    const outcome = await runMutationCheck(
      { repoPath: repo, diff: DIFF, budgetSeconds: 600 },
      seamsFor(scratch, async (_cmd, _args, opts) => {
        const code = await passesOnlyUnmutated(opts.cwd);
        if (code !== 0) {
          try {
            await Deno.remove(`${opts.cwd}/fixtures/gone.txt`);
            deletions++;
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          }
        }
        return result(code);
      }),
    );
    assertEquals(outcome.kind, "completed");
    assert(deletions > 0, "a mutant run must have deleted the tracked file");
    assertEquals(
      await Deno.readTextFile(`${repo}/fixtures/gone.txt`),
      "keep me\n",
    );
  });
});

Deno.test("Issue #4905 - snapshotTree returns null and warns with the git cause outside a git repository", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mutation-tree-guard-plain-" });
  try {
    const { value, warnings } = await captureWarnings(() => snapshotTree(dir));
    assertEquals(value, null);
    assertEquals(warnings.length, 1);
    assertStringIncludes(
      warnings[0] ?? "",
      "[mutation] could not snapshot the working tree:",
    );
    assertStringIncludes(warnings[0] ?? "", "not a git repository");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Issue #4905 - restoreTree warns and does not throw when the listing now fails", async () => {
  const repo = await Deno.makeTempDir({ prefix: "mutation-tree-guard-" });
  try {
    await makeRepo(repo, { "a.txt": "a\n" });
    const before = await snapshotTree(repo);
    assert(before !== null, "the snapshot of a git repository must succeed");
    await Deno.remove(`${repo}/.git`, { recursive: true });
    const { warnings } = await captureWarnings(async () => {
      await restoreTree(repo, before);
    });
    assertEquals(warnings.length, 1);
    assertStringIncludes(
      warnings[0] ?? "",
      "[mutation] could not restore the working tree:",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("Issue #4905 - snapshotTree returns null and warns when the directory does not exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mutation-tree-guard-gone-" });
  await Deno.remove(dir, { recursive: true });
  const { value, warnings } = await captureWarnings(() => snapshotTree(dir));
  assertEquals(value, null);
  assertEquals(warnings.length, 1);
  assertStringIncludes(
    warnings[0] ?? "",
    "[mutation] could not snapshot the working tree:",
  );
});

Deno.test("Issue #4905 - snapshotTree returns null and warns when the modified-file listing fails", async () => {
  await withRepo({ "a.txt": "a\n" }, async (repo) => {
    // `git diff` reads this setting; `git ls-files` does not, so only the
    // second listing fails.
    await git(repo, ["config", "diff.renames", "bogus"]);
    const { value, warnings } = await captureWarnings(() => snapshotTree(repo));
    assertEquals(value, null);
    assertEquals(warnings.length, 1);
    assertStringIncludes(
      warnings[0] ?? "",
      "[mutation] could not snapshot the working tree:",
    );
    assertStringIncludes(warnings[0] ?? "", "diff.renames");
  });
});

Deno.test("Issue #4905 - snapshotTree lists untracked and modified paths exactly", async () => {
  await withRepo({ "a.txt": "a\n", "b.txt": "b\n" }, async (repo) => {
    await Deno.writeTextFile(`${repo}/a.txt`, "changed\n");
    await Deno.writeTextFile(`${repo}/new.txt`, "new\n");
    const snapshot = await snapshotTree(repo);
    assert(snapshot !== null);
    assertEquals([...snapshot.untracked], ["new.txt"]);
    assertEquals([...snapshot.modified], ["a.txt"]);
  });
});

Deno.test("Issue #4905 - isUnsafePath flags absolute, dot-segment and trailing-slash paths only", () => {
  assertEquals(isUnsafePath("/abs"), true);
  assertEquals(isUnsafePath("dir/"), true);
  assertEquals(isUnsafePath("./a"), true);
  assertEquals(isUnsafePath("a/./b"), true);
  assertEquals(isUnsafePath("../a"), true);
  assertEquals(isUnsafePath("a/../b"), true);
  assertEquals(isUnsafePath("a"), false);
  assertEquals(isUnsafePath("a/b.txt"), false);
  assertEquals(isUnsafePath("a/.hidden/b"), false);
});

Deno.test("Issue #4905 - restoreTree refuses a nested repository directory and leaves it", async () => {
  await withRepo({ "a.txt": "a\n" }, async (repo) => {
    const before = await snapshotTree(repo);
    assert(before !== null);
    await Deno.mkdir(`${repo}/nested`);
    await git(`${repo}/nested`, ["init", "-q"]);
    await Deno.writeTextFile(`${repo}/nested/f.txt`, "f\n");
    const { warnings } = await captureWarnings(() => restoreTree(repo, before));
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0] ?? "", "refusing unsafe path nested/");
    assertEquals(await exists(`${repo}/nested/f.txt`), true);
  });
});

Deno.test("Issue #4905 - restoreTree warns with the OS message when a stray file cannot be removed, and carries on", async () => {
  if (Deno.uid() === 0) return; // root ignores directory permissions
  await withRepo({ "a.txt": "a\n" }, async (repo) => {
    const before = await snapshotTree(repo);
    assert(before !== null);
    await Deno.mkdir(`${repo}/locked`);
    await Deno.writeTextFile(`${repo}/locked/f.txt`, "f\n");
    await Deno.writeTextFile(`${repo}/stray.txt`, "s\n");
    await Deno.chmod(`${repo}/locked`, 0o555);
    let message = "";
    try {
      try {
        await Deno.remove(`${repo}/locked/f.txt`);
      } catch (err) {
        message = (err as Error).message;
      }
      assert(message !== "", "the locked directory must refuse the removal");
      const { warnings } = await captureWarnings(() =>
        restoreTree(repo, before)
      );
      assertEquals(warnings.length, 1);
      assertStringIncludes(
        warnings[0] ?? "",
        `removing locked/f.txt: ${message}`,
      );
      assertEquals(await exists(`${repo}/stray.txt`), false);
    } finally {
      await Deno.chmod(`${repo}/locked`, 0o755);
    }
  });
});

Deno.test("Issue #4905 - restoreTree is silent when a stray file has already gone", async () => {
  await withRepo({ "a.txt": "a\n" }, async (repo) => {
    const before = await snapshotTree(repo);
    assert(before !== null);
    await Deno.writeTextFile(`${repo}/stray.txt`, "s\n");
    await Deno.remove(`${repo}/stray.txt`);
    const { warnings } = await captureWarnings(() => restoreTree(repo, before));
    assertEquals(warnings, []);
  });
});
