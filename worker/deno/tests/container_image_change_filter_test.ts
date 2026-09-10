/**
 * Tests for `.github/scripts/detect-image-changes.sh` (Issue #1929).
 *
 * The script is the change filter behind the `changes` job in
 * `.github/workflows/container-build.yml`, which decides whether the
 * 11-minute image build runs for a pull request. It used to be an inline
 * `run:` block whose `git diff --name-only "${base}" "${head}" … || true`
 * swallowed every diff failure: `changed` came back empty, that reads as
 * "nothing image-affecting changed", and the REQUIRED `container` check
 * reported green having built and verified nothing.
 *
 * These tests run the real script against real throwaway git repositories
 * and assert on its exit code, its `$GITHUB_OUTPUT` writes and its output —
 * no source-text inspection. The first one is the regression: a commit the
 * diff cannot reach must exit non-zero, never decide `image=false`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../../../.github/scripts/detect-image-changes.sh",
  import.meta.url,
).pathname;

/** A well-formed SHA that no repository below has ever seen. */
const ABSENT_SHA = "9a1c0b4e2d7f5a3b8c6d4e2f1a0b9c8d7e6f5a4b";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** Everything the script appended to `$GITHUB_OUTPUT`. */
  githubOutput: string;
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

/** A throwaway repository with one empty base commit, returning its SHA. */
async function repoWithBase(dir: string): Promise<string> {
  await git(dir, "init", "-q", "-b", "main", ".");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  return (await git(dir, "rev-parse", "HEAD")).trim();
}

/** Commit `content` at `path` inside `dir`, returning the new HEAD SHA. */
async function commitFile(
  dir: string,
  path: string,
  content: string,
): Promise<string> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    await Deno.mkdir(`${dir}/${path.slice(0, slash)}`, { recursive: true });
  }
  await Deno.writeTextFile(`${dir}/${path}`, content);
  await git(dir, "add", path);
  await git(dir, "commit", "-q", "-m", `add ${path}`);
  return (await git(dir, "rev-parse", "HEAD")).trim();
}

/** Run the filter inside `dir` with a real `$GITHUB_OUTPUT` file. */
async function filter(dir: string, ...args: string[]): Promise<Run> {
  const outputFile = `${dir}/github_output`;
  await Deno.writeTextFile(outputFile, "");
  const out = await new Deno.Command("bash", {
    args: [SCRIPT_PATH, ...args],
    cwd: dir,
    env: { GITHUB_OUTPUT: outputFile },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    githubOutput: await Deno.readTextFile(outputFile),
  };
}

/** Run `body` against a fresh temporary directory, then remove it. */
async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "image_change_filter_" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("image filter - a commit outside the object store fails loud (Issue #1929)", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);
    await commitFile(dir, "container/Containerfile", "FROM scratch\n");

    const run = await filter(dir, base, ABSENT_SHA);

    assertEquals(run.code, 2, "an unreachable commit must not decide the build");
    assertStringIncludes(run.stderr, ABSENT_SHA);
    assertStringIncludes(run.stderr, "not in the local object store");
    // The silent skip the issue reported: a failed diff read as "no changes".
    assertEquals(run.githubOutput.includes("image=false"), false);
    assertEquals(run.stdout.includes("image=false"), false);
  });
});

Deno.test("image filter - an unreachable base commit fails loud", async () => {
  await withTempDir(async (dir) => {
    await repoWithBase(dir);
    const head = await commitFile(dir, "container/entrypoint.sh", "#!/bin/sh\n");

    const run = await filter(dir, ABSENT_SHA, head);

    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "not in the local object store");
    assertEquals(run.githubOutput.includes("image=false"), false);
  });
});

Deno.test("image filter - an empty commit argument fails loud", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);

    const run = await filter(dir, base, "");

    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "empty head commit argument");
    assertEquals(run.githubOutput, "");
  });
});

Deno.test("image filter - a missing argument fails loud", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);

    const run = await filter(dir, base);

    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "expected exactly two commit arguments");
    assertEquals(run.githubOutput, "");
  });
});

Deno.test("image filter - outside a git repository it fails loud", async () => {
  await withTempDir(async (dir) => {
    // No `git init` — the checkout the job relies on is simply not there.
    const run = await filter(dir, ABSENT_SHA, ABSENT_SHA);

    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "not inside a git repository");
    assertEquals(run.githubOutput, "");
  });
});

Deno.test("image filter - an image-definition change builds", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);
    const head = await commitFile(
      dir,
      "container/Containerfile",
      "FROM scratch\n",
    );

    const run = await filter(dir, base, head);

    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.githubOutput, "image=true");
    assertStringIncludes(run.stdout, "container/Containerfile");
  });
});

Deno.test("image filter - the screenshot generator builds (Issue #1584)", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);
    const head = await commitFile(
      dir,
      "worker/deno/setup/screenshot.ts",
      "export const mcp = {};\n",
    );

    const run = await filter(dir, base, head);

    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.githubOutput, "image=true");
  });
});

Deno.test("image filter - an unrelated change skips the build", async () => {
  await withTempDir(async (dir) => {
    const base = await repoWithBase(dir);
    const head = await commitFile(dir, "docs/README.md", "# docs\n");

    const run = await filter(dir, base, head);

    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.githubOutput, "image=false");
    assertStringIncludes(run.stdout, "no image-affecting changes");
  });
});
