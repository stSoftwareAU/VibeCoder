/**
 * Regression tests for Issue #1443 — ignored paths survived the reset that
 * exists to erase them.
 *
 * `setupRepo` (and every other reused-tree reset) ran `git reset --hard`
 * followed by `git clean -fd`. `-fd` leaves **ignored** paths standing, which
 * is where a repository keeps the content a later run executes:
 * `node_modules/.bin` shims, a `.venv` interpreter, compiled output under
 * `target/` or `dist/`. So content planted by one run was still there for the
 * next, legitimate run of that repository.
 *
 * These tests plant that content in real git repositories, call the real
 * functions, and assert on the resulting tree. They fail against the unfixed
 * code (where `node_modules/` survives `setupRepo`) and pass after the fix.
 * They also pin the two halves of the trade-off the fix makes: pure download
 * caches stay warm, and an ignored file outside the executable-bearing set is
 * the documented residual (`docs/THREAT-MODEL.md`, R12).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  cleanWorkingTree,
  EXECUTABLE_IGNORED_DIRS,
  ignoredExecutableCleanArgs,
  workingTreeCleanSteps,
} from "../lib/ignored_path_clean.ts";
import { setupRepo } from "../commands/git_operations.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function runGit(args: string[], cwd: string): Promise<number> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: GIT_ENV,
  });
  return (await cmd.output()).code;
}

async function write(path: string, body: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, body);
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The `.gitignore` the fixtures commit, covering both halves of the trade. */
const GITIGNORE = [
  "node_modules/",
  "target/",
  ".venv/",
  // Not executable-bearing: a pure download cache and a log. These must
  // survive, because discarding them on every run is the cost the fix exists
  // to avoid.
  ".cache/",
  "*.log",
  "",
].join("\n");

/** A git repository with the fixture `.gitignore` committed. */
async function buildRepo(prefix: string): Promise<
  { dir: string; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix });
  assertEquals(await runGit(["init", "-b", "main", "."], dir), 0);
  await runGit(["config", "user.email", "t@t"], dir);
  await runGit(["config", "user.name", "t"], dir);
  await write(`${dir}/.gitignore`, GITIGNORE);
  await runGit(["add", "."], dir);
  await runGit(["commit", "-m", "init"], dir);
  return { dir, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

Deno.test("ignoredExecutableCleanArgs - scopes an ignored clean to the executable-bearing directories", () => {
  const args = ignoredExecutableCleanArgs();

  // `-x` is what reaches ignored paths at all; the second `-f` is what stops
  // git skipping a dependency directory that holds a nested `.git`.
  assertEquals(args[0], "clean");
  assertEquals(args[1], "-ffdx");
  assertEquals(args[2], "--");

  // Every entry is a pathspec, never a bare `-x` over the whole tree, so
  // download caches outside the named set are not discarded.
  const pathspecs = args.slice(3);
  assertEquals(pathspecs.length, EXECUTABLE_IGNORED_DIRS.length);
  for (const dir of EXECUTABLE_IGNORED_DIRS) {
    assert(
      pathspecs.includes(`:(glob)**/${dir}/**`),
      `${dir} must be cleaned at any depth`,
    );
  }

  // The reset sequence keeps the untracked clean first, then the scoped one.
  const steps = workingTreeCleanSteps();
  assertEquals(steps[0], ["clean", "-fd"]);
  assertEquals(steps[1], args);
});

Deno.test("cleanWorkingTree - erases ignored executable paths at any depth and keeps caches warm", async () => {
  const { dir, cleanup } = await buildRepo("ignored_clean_");
  try {
    // What a previous run could have tampered with, at the root and nested in
    // a monorepo package.
    await write(`${dir}/node_modules/.bin/tool`, "#!/bin/sh\nexfiltrate\n");
    await write(`${dir}/packages/app/node_modules/dep/index.js`, "evil\n");
    await write(`${dir}/target/release/app`, "compiled\n");
    await write(`${dir}/.venv/bin/python`, "shim\n");
    // What must stay: a download cache and an ignored log.
    await write(`${dir}/.cache/registry.tar`, "downloaded\n");
    await write(`${dir}/build.log`, "last run\n");
    // And an ordinary untracked file, which the existing `-fd` clean removes.
    await write(`${dir}/scratch.txt`, "untracked\n");

    await cleanWorkingTree({ cwd: dir });

    assert(!exists(`${dir}/node_modules`), "root node_modules must be erased");
    assert(
      !exists(`${dir}/packages/app/node_modules`),
      "a nested node_modules must be erased too",
    );
    assert(!exists(`${dir}/target`), "target/ must be erased");
    assert(!exists(`${dir}/.venv`), ".venv/ must be erased");
    assert(!exists(`${dir}/scratch.txt`), "untracked files still go");

    assert(exists(`${dir}/.cache/registry.tar`), "download caches stay warm");
    assert(exists(`${dir}/build.log`), "ignored logs are not the target");
    assert(exists(`${dir}/.gitignore`), "tracked files are untouched");
  } finally {
    await cleanup();
  }
});

Deno.test("cleanWorkingTree - erases a dependency directory that holds a nested git repository", async () => {
  const { dir, cleanup } = await buildRepo("ignored_clean_nested_");
  try {
    // A git-installed dependency: `git clean -fdx` prints "Skipping
    // repository" and leaves it, which is exactly the content that must not
    // survive into the next run.
    const dep = `${dir}/node_modules/dep`;
    await Deno.mkdir(dep, { recursive: true });
    assertEquals(await runGit(["init", "-b", "main", "."], dep), 0);
    await write(`${dep}/index.js`, "evil\n");

    await cleanWorkingTree({ cwd: dir });

    assert(
      !exists(`${dir}/node_modules`),
      "a nested repository inside a dependency directory must be erased",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("cleanWorkingTree - an ignored file outside the executable set is the documented residual", async () => {
  const { dir, cleanup } = await buildRepo("ignored_clean_residual_");
  try {
    await write(`${dir}/.cache/tool.sh`, "#!/bin/sh\n");

    await cleanWorkingTree({ cwd: dir });

    // Recorded rather than assumed away: the fix is scoped, and R12 in
    // docs/THREAT-MODEL.md carries the reasoning and the cost of the
    // alternative.
    assert(
      exists(`${dir}/.cache/tool.sh`),
      "ignored paths outside the named set survive, by design",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("setupRepo - a reused clone does not carry ignored executable content into the next run", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "setup_repo_ignored_" });
  try {
    const upstream = `${tmp}/upstream`;
    const clonePath = `${tmp}/downstream`;
    await Deno.mkdir(upstream, { recursive: true });
    assertEquals(await runGit(["init", "-b", "main", "."], upstream), 0);
    await runGit(["config", "user.email", "t@t"], upstream);
    await runGit(["config", "user.name", "t"], upstream);
    await write(`${upstream}/.gitignore`, GITIGNORE);
    await write(`${upstream}/file.txt`, "first\n");
    await runGit(["add", "."], upstream);
    await runGit(["commit", "-m", "first"], upstream);
    assertEquals(
      await runGit(["clone", `file://${upstream}`, clonePath], tmp),
      0,
    );

    // What the previous run left behind in the reused clone.
    await write(`${clonePath}/node_modules/.bin/tool`, "#!/bin/sh\nevil\n");
    await write(`${clonePath}/packages/a/node_modules/dep/i.js`, "evil\n");
    await write(`${clonePath}/.cache/registry.tar`, "downloaded\n");

    const result = await setupRepo("owner/downstream", tmp);
    assertEquals(result.success, true, result.message);

    assert(
      !exists(`${clonePath}/node_modules`),
      "setupRepo must erase ignored executable content from a reused clone",
    );
    assert(
      !exists(`${clonePath}/packages/a/node_modules`),
      "including the nested copies a monorepo carries",
    );
    assert(
      exists(`${clonePath}/.cache/registry.tar`),
      "and must leave the download cache warm",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
