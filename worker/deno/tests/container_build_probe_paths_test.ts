/**
 * The Container Build pull-request path filter (Issue #1584).
 *
 * `.github/workflows/container-build.yml` decides on a pull request whether to
 * build the image — and so whether to run the "Drive the Playwright MCP server
 * from the generated config" probe — from a `git diff --name-only` pathspec
 * list. Issue #1386 narrowed the MCP server's `--allow-net` in
 * `worker/deno/setup/screenshot.ts`, matched no pathspec, passed the `changes`
 * job in four seconds, and landed a `main` where every `browser_navigate`
 * failed with `NotCapable`.
 *
 * These tests run the real `git diff --name-only` with the pathspecs parsed out
 * of the committed workflow, against a throwaway repository — the same command
 * CI runs, so a pathspec that stops matching fails here rather than on `main`.
 */

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const CONTAINER_WORKFLOW = `${REPO_ROOT}/.github/workflows/container-build.yml`;

/** The paths whose change must trigger the image build and the MCP probe. */
const PROBE_PATHS = [
  "worker/deno/setup/screenshot.ts",
  "worker/deno/tests/setup_screenshot_test.ts",
];

/**
 * The pathspecs the workflow hands `git diff --name-only` on a pull request.
 *
 * Fails loudly when the command's shape changes, rather than silently
 * returning an empty list that would make every assertion below vacuous.
 */
function pullRequestPathspecs(workflow: string): string[] {
  const start = workflow.indexOf('changed="$(git diff --name-only');
  assert(start >= 0, "the changes job no longer runs `git diff --name-only`");
  const end = workflow.indexOf("|| true)", start);
  assert(end > start, "the `git diff` pathspec list is unterminated");
  const specs = [...workflow.slice(start, end).matchAll(/'([^']+)'/g)]
    .map((match) => match[1] ?? "");
  assert(specs.length > 0, "no pathspecs found in the changes job");
  return specs;
}

/** Files changed between two commits of a throwaway repo, per the workflow. */
async function changedUnderPathspecs(
  cwd: string,
  pathspecs: string[],
): Promise<string[]> {
  const run = async (...args: string[]) => {
    const output = await new Deno.Command("git", {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      output.success,
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
    return new TextDecoder().decode(output.stdout);
  };
  const stdout = await run(
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

/** A throwaway repo with a base commit, then `changed` touched in a second. */
async function repoWithChange(changed: string[]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-probe-paths-" });
  const seeded = [...new Set([...changed, "README.md"])];
  const git = async (...args: string[]) => {
    const output = await new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      output.success,
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  };
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  for (const path of seeded) {
    const parent = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    if (parent !== "") {
      await Deno.mkdir(`${dir}/${parent}`, { recursive: true });
    }
    await Deno.writeTextFile(`${dir}/${path}`, "base\n");
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  for (const path of changed) {
    await Deno.writeTextFile(`${dir}/${path}`, "changed\n");
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "change");
  return dir;
}

Deno.test("container-build PR filter builds on an MCP-config change (Issue #1584)", async () => {
  const pathspecs = pullRequestPathspecs(
    await Deno.readTextFile(CONTAINER_WORKFLOW),
  );
  for (const probePath of PROBE_PATHS) {
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
    await Deno.readTextFile(CONTAINER_WORKFLOW),
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

Deno.test("the paths the Container Build probe watches exist (Issue #1584)", async () => {
  for (const probePath of PROBE_PATHS) {
    const stat = await Deno.stat(`${REPO_ROOT}/${probePath}`);
    assert(stat.isFile, `${probePath} is listed in the PR filter but is gone`);
  }
});
