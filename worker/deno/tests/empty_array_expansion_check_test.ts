/**
 * Tests for `.github/scripts/check-empty-array-expansions.sh` (Issue #1891).
 *
 * The script is the bash-3.2 empty-array-expansion gate behind the
 * `validate` job in `.github/workflows/validate-scripts.yml`. It used to be
 * an inline `run:` block whose `git diff … || true` swallowed
 * `fatal: bad object` under the job's shallow checkout: `changed_scripts`
 * came back empty, the loop never ran, and the step printed
 * "Empty array expansion check complete" having inspected nothing.
 *
 * These tests run the real script against real throwaway git repositories
 * and assert on its exit code and output — no source-text inspection. The
 * first one is the regression: an unavailable base commit must exit
 * non-zero, never report a vacuous pass.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../../../.github/scripts/check-empty-array-expansions.sh",
  import.meta.url,
).pathname;

/** A well-formed SHA that no repository below has ever seen. */
const ABSENT_SHA = "4f089bcc8a0d3fb68552f7b7f3ef88aee566190c";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `git` in `dir`, failing loud on a non-zero exit. */
async function git(dir: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    env: {
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

/**
 * A throwaway repository with one empty base commit, returning its SHA.
 */
async function repoWithBase(dir: string): Promise<string> {
  await git(dir, "init", "-q", "-b", "main", ".");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  return (await git(dir, "rev-parse", "HEAD")).trim();
}

/**
 * Commit `content` at `path` inside `dir` — the PR head as CI sees it: the
 * changed scripts are committed, not sitting untracked in the work tree.
 */
async function commitFile(
  dir: string,
  path: string,
  content: string,
): Promise<void> {
  const full = `${dir}/${path}`;
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    await Deno.mkdir(`${dir}/${path.slice(0, slash)}`, { recursive: true });
  }
  await Deno.writeTextFile(full, content);
  await git(dir, "add", path);
  await git(dir, "commit", "-q", "-m", `add ${path}`);
}

/** Run the script inside `dir` with the given arguments. */
async function check(dir: string, ...args: string[]): Promise<Run> {
  const out = await new Deno.Command("bash", {
    args: [SCRIPT_PATH, ...args],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Run `body` against a fresh temporary directory, then remove it. */
async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "empty_array_check_" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const UNSAFE_SCRIPT = `#!/bin/bash
set -euo pipefail
args=()
echo "\${args[@]}"
`;

const SAFE_SCRIPT = `#!/bin/bash
set -euo pipefail
args=()
echo "\${args[@]+"\${args[@]}"}"
`;

Deno.test("empty-array check - an absent base commit fails loud (Issue #1891)", async () => {
  await withTempDir(async (dir) => {
    await repoWithBase(dir);
    await commitFile(dir, "unsafe.sh", UNSAFE_SCRIPT);

    const run = await check(dir, ABSENT_SHA);

    assertEquals(run.code, 2, "an unavailable base commit must not pass");
    assertStringIncludes(run.stderr, ABSENT_SHA);
    assertStringIncludes(run.stderr, "not in the local object store");
    // The vacuous pass the issue reported: "complete" with nothing inspected.
    assertEquals(run.stdout.includes("check complete"), false);
  });
});

Deno.test("empty-array check - an empty base argument fails loud", async () => {
  await withTempDir(async (dir) => {
    await repoWithBase(dir);

    const run = await check(dir, "");

    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "base commit");
  });
});

Deno.test("empty-array check - warns on an unsafe expansion in a changed script", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);
    await commitFile(dir, "unsafe.sh", UNSAFE_SCRIPT);

    const run = await check(dir, base);

    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.stdout, "unsafe.sh:4");
    assertStringIncludes(run.stdout, "Array 'args' is declared empty");
    assertStringIncludes(run.stdout, "Inspected 1 shell script(s)");
  });
});

Deno.test("empty-array check - the safe expansion pattern raises no warning", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);
    await commitFile(dir, "safe.sh", SAFE_SCRIPT);

    const run = await check(dir, base);

    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertEquals(run.stdout.includes("WARNING"), false);
    assertStringIncludes(run.stdout, "Inspected 1 shell script(s)");
  });
});

Deno.test("empty-array check - a PR that changed no shell script says so", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);
    await commitFile(dir, "notes.md", "# nothing to scan\n");

    const run = await check(dir, base);

    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.stdout, "Inspected 0 shell script(s)");
  });
});

Deno.test("empty-array check - no base argument scans every script in the tree", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/nested`);
    await Deno.writeTextFile(`${dir}/nested/unsafe.sh`, UNSAFE_SCRIPT);
    await Deno.writeTextFile(`${dir}/safe.sh`, SAFE_SCRIPT);

    const run = await check(dir);

    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.stdout, "nested/unsafe.sh:4");
    assertStringIncludes(run.stdout, "Inspected 2 shell script(s)");
  });
});
