/**
 * The Container Build pull-request path filter (Issue #1584).
 *
 * `.github/workflows/container-build.yml` decides on a pull request whether to
 * build the image — and so whether to run the "Drive the Playwright MCP server
 * from the generated config" probe — from the `git diff --name-only` pathspec
 * list in `.github/scripts/detect-image-changes.sh` (Issue #1929). Issue #1386 narrowed the MCP server's `--allow-net` in
 * `worker/deno/setup/screenshot.ts`, matched no pathspec, passed the `changes`
 * job in four seconds, and landed a `main` where every `browser_navigate`
 * failed with `NotCapable`.
 *
 * These tests run the real `git diff --name-only` with the pathspecs taken from
 * the committed workflow, against a throwaway repository — the same command CI
 * runs, so a pathspec that stops matching fails here rather than on `main`.
 */

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
// Issue #1929 moved the filter out of the workflow into a committed script,
// so the pathspecs the pull-request build turns on live here now.
const CHANGE_FILTER = `${REPO_ROOT}/.github/scripts/detect-image-changes.sh`;

/** The paths whose change must trigger the image build and the MCP probe. */
const PROBE_PATHS = [
  "worker/deno/setup/screenshot.ts",
  "worker/deno/tests/setup_screenshot_test.ts",
];

/**
 * The pathspecs the filter hands `git diff --name-only` on a pull request.
 *
 * They are read from the `IMAGE_PATHS` array in the committed
 * `.github/scripts/detect-image-changes.sh` — the single source of truth the
 * `changes` job runs (Issue #1929). Every step fails loudly rather than
 * returning an empty list, which would make the assertions below vacuously
 * true.
 */
function pullRequestPathspecs(scriptSource: string): string[] {
  const start = scriptSource.indexOf("readonly IMAGE_PATHS=(");
  assert(start >= 0, "the filter script no longer declares IMAGE_PATHS");
  const end = scriptSource.indexOf(")", start);
  assert(end > start, "the IMAGE_PATHS array is unterminated");
  const specs = [...scriptSource.slice(start, end).matchAll(/'([^']+)'/g)]
    .map((match) => match[1] ?? "");
  assert(specs.length > 0, "no pathspecs found in the filter script");
  return specs;
}

/** Run `git` in `cwd`, failing loudly with git's own stderr. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(
    output.success,
    `git ${args.join(" ")} failed: ${new TextDecoder().decode(output.stderr)}`,
  );
  return new TextDecoder().decode(output.stdout);
}

/** A throwaway repo with a base commit, then `changed` touched in a second. */
async function repoWithChange(changed: string[]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-probe-paths-" });
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  for (const path of [...new Set([...changed, "README.md"])]) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(`${dir}/${path.slice(0, slash)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${dir}/${path}`, "base\n");
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base");
  for (const path of changed) {
    await Deno.writeTextFile(`${dir}/${path}`, "changed\n");
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "change");
  return dir;
}

/** The files the workflow's own pathspecs select between the two commits. */
async function changedUnderPathspecs(
  cwd: string,
  pathspecs: string[],
): Promise<string[]> {
  const stdout = await git(
    cwd,
    "diff",
    "--name-only",
    "HEAD~1",
    "HEAD",
    "--",
    ...pathspecs,
  );
  return stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line !== ""
  );
}

Deno.test("container-build PR filter builds on an MCP-config change (Issue #1584)", async () => {
  const pathspecs = pullRequestPathspecs(
    await Deno.readTextFile(CHANGE_FILTER),
  );
  for (const probePath of PROBE_PATHS) {
    // A pathspec naming a file that no longer exists matches nothing in the
    // real repository, so the probe would silently stop running.
    assert(
      (await Deno.stat(`${REPO_ROOT}/${probePath}`)).isFile,
      `${probePath} is watched by the PR filter but is gone from the tree`,
    );
    const dir = await repoWithChange([probePath]);
    try {
      assertEquals(
        await changedUnderPathspecs(dir, pathspecs),
        [probePath],
        `${probePath} must trigger the image build and the Playwright probe`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("container-build PR filter still skips an unrelated change (Issue #1584)", async () => {
  const pathspecs = pullRequestPathspecs(
    await Deno.readTextFile(CHANGE_FILTER),
  );
  const dir = await repoWithChange(["docs/CONFIGURATION.md"]);
  try {
    assertEquals(
      await changedUnderPathspecs(dir, pathspecs),
      [],
      "a docs-only pull request must not pay the 11-minute image build",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
