/**
 * Tests for `.github/scripts/next-release-tag.sh` (Issue #627).
 *
 * The script is the version-selection logic behind
 * `.github/workflows/release-tag.yml`: pointed at a git repository and a merge
 * commit, it decides whether to tag and which tag to mint. Every part of the
 * version comes from what changed since the newest release tag — a removed
 * line of `docs/audits/release-contract.txt` is a major, an added line or a
 * `container/` change a minor, anything else a patch — so nothing is
 * hand-edited to move the series (it replaced the `.release-floor` file of
 * Issue #808).
 *
 * Post-merge is the only place the real trigger exists, so every test builds a
 * throwaway repository with real commits and tags and runs the real script
 * against it, asserting on its stdout and exit code — no source-text
 * inspection.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH =
  new URL("../../../.github/scripts/next-release-tag.sh", import.meta.url)
    .pathname;

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

const CONTRACT = "docs/audits/release-contract.txt";

/** A small contract record: a header comment and three entries. */
const BASE_CONTRACT = [
  "# generated; do not edit",
  "callback-schema 2",
  "config allowed_authors",
  "config repos",
  "",
].join("\n");

interface PlanRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a git command in `cwd`, returning its trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

/** A throwaway repository, removed when `body` returns. */
async function withRepo(body: (repo: Repo) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "next_release_tag_" });
  try {
    await git(dir, "init", "-q", "-b", "main");
    await body(new Repo(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

class Repo {
  constructor(readonly dir: string) {}

  /** Write (or, with `null`, delete) files, then commit them all. */
  async commit(files: Record<string, string | null>): Promise<string> {
    for (const [path, text] of Object.entries(files)) {
      const abs = `${this.dir}/${path}`;
      if (text === null) {
        await Deno.remove(abs);
        continue;
      }
      await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(abs, text);
    }
    await git(this.dir, "add", "-A");
    await git(this.dir, "commit", "-qm", "change", "--allow-empty");
    return await git(this.dir, "rev-parse", "HEAD");
  }

  async tag(name: string, rev = "HEAD"): Promise<void> {
    await git(this.dir, "tag", name, rev);
  }

  /** A first commit carrying the base contract, tagged as `version`. */
  async released(version: string): Promise<void> {
    await this.commit({ [CONTRACT]: BASE_CONTRACT, "README.md": "hello\n" });
    await this.tag(version);
  }

  async plan(rev = "HEAD"): Promise<PlanRun> {
    return await runScript([this.dir, rev]);
  }
}

async function runScript(args: string[]): Promise<PlanRun> {
  const out = await new Deno.Command("bash", {
    args: [SCRIPT_PATH, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** The `key=value` lines the script prints, parsed as a map. */
function outputs(run: PlanRun): Record<string, string> {
  assertEquals(run.code, 0, run.stderr);
  const parsed: Record<string, string> = {};
  for (const line of run.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const eq = line.indexOf("=");
    assert(eq > 0, `not a key=value line: ${line}`);
    parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

const minted = (tag: string, bump: string) => ({
  should_tag: "true",
  tag,
  bump,
});

// --- The series itself --------------------------------------------------

Deno.test("next-release-tag - a repository with no release tag mints 1.0.0", async () => {
  await withRepo(async (repo) => {
    await repo.commit({ [CONTRACT]: BASE_CONTRACT });
    assertEquals(outputs(await repo.plan()), minted("1.0.0", "initial"));
  });
});

Deno.test("next-release-tag - an ordinary change is a patch", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({ "worker/deno/lib/thing.ts": "export {};\n" });
    const run = await repo.plan();
    assertEquals(outputs(run), minted("1.4.8", "patch"));
    assertStringIncludes(run.stderr, "newest release tag: 1.4.7");
  });
});

Deno.test("next-release-tag - a merge with no file change at all is still a patch", async () => {
  // Every merge to main leaves a release behind (Issue #627).
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({});
    assertEquals(outputs(await repo.plan()), minted("1.4.8", "patch"));
  });
});

Deno.test("next-release-tag - segments compare numerically, not lexically", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.0.9");
    await repo.commit({ "a.txt": "a\n" });
    await repo.tag("1.0.10");
    await repo.commit({ "b.txt": "b\n" });
    await repo.tag("1.0.2", "HEAD~1");
    assertEquals(outputs(await repo.plan()), minted("1.0.11", "patch"));
  });
});

Deno.test("next-release-tag - a v-prefixed tag counts, and the mint stays bare", async () => {
  await withRepo(async (repo) => {
    await repo.released("v1.4.0");
    await repo.commit({ "a.txt": "a\n" });
    assertEquals(outputs(await repo.plan()), minted("1.4.1", "patch"));
  });
});

Deno.test("next-release-tag - pre-releases and moving names are not part of the series", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.0.0");
    for (const name of ["1.1.0-rc1", "2.0.0+build.7", "latest", "v9", "1.0"]) {
      await repo.tag(name);
    }
    await repo.commit({ "a.txt": "a\n" });
    assertEquals(outputs(await repo.plan()), minted("1.0.1", "patch"));
  });
});

Deno.test("next-release-tag - padded segments do not abort the arithmetic", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.08.09");
    await repo.commit({ "a.txt": "a\n" });
    assertEquals(outputs(await repo.plan()), minted("1.8.10", "patch"));
  });
});

// --- Idempotency (Issue #688) -----------------------------------------------

Deno.test("next-release-tag - a commit that already carries a release tag is not tagged again", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.0.0");
    await repo.commit({ "container/Containerfile": "FROM x\n" });
    await repo.tag("1.1.0");
    const run = await repo.plan();
    // The `tag` output names the release the commit already carries, so a
    // re-run after a failed manifest publish still has one to publish for.
    assertEquals(outputs(run), {
      should_tag: "false",
      tag: "1.1.0",
      bump: "none",
    });
    assertStringIncludes(run.stderr, "already tagged");
  });
});

Deno.test("next-release-tag - the newest release tag on the commit is the one reported", async () => {
  await withRepo(async (repo) => {
    await repo.released("v1.0.9");
    await repo.tag("1.0.10");
    assertEquals(outputs(await repo.plan()), {
      should_tag: "false",
      tag: "1.0.10",
      bump: "none",
    });
  });
});

Deno.test("next-release-tag - a commit carrying only a non-release tag is still tagged", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.0.0");
    await repo.commit({ "a.txt": "a\n" });
    await repo.tag("nightly");
    assertEquals(outputs(await repo.plan()), minted("1.0.1", "patch"));
  });
});

// --- Minor: the container definition, or a contract that only grew ----------

Deno.test("next-release-tag - a container definition change is a minor and resets the patch", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({ "container/tools.json": "{}\n" });
    const run = await repo.plan();
    assertEquals(outputs(run), minted("1.5.0", "minor"));
    assertStringIncludes(
      run.stderr,
      "container definition changed: container/tools.json",
    );
  });
});

Deno.test("next-release-tag - deleting a container file is a container change too", async () => {
  await withRepo(async (repo) => {
    await repo.commit({ "container/entrypoint.sh": "#!/bin/sh\n" });
    await repo.released("1.4.7");
    await repo.commit({ "container/entrypoint.sh": null });
    assertEquals(outputs(await repo.plan()), minted("1.5.0", "minor"));
  });
});

Deno.test("next-release-tag - a path that only starts with `container` is not the container", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({
      "docs/CONTAINER.md": "# docs\n",
      "containers.txt": "x\n",
    });
    assertEquals(outputs(await repo.plan()), minted("1.4.8", "patch"));
  });
});

Deno.test("next-release-tag - a new configuration key is a minor", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({ [CONTRACT]: `${BASE_CONTRACT}config zz_new_key\n` });
    const run = await repo.plan();
    assertEquals(outputs(run), minted("1.5.0", "minor"));
    assertStringIncludes(
      run.stderr,
      "contract entries added: config zz_new_key",
    );
  });
});

Deno.test("next-release-tag - a change to the record's comments alone is a patch", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({
      [CONTRACT]: `# a reworded header\n\n${
        BASE_CONTRACT.replace(/^#.*\n/, "")
      }`,
    });
    assertEquals(outputs(await repo.plan()), minted("1.4.8", "patch"));
  });
});

// --- Major: the contract lost a line ----------------------------------------

Deno.test("next-release-tag - a removed configuration key is a major", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({
      [CONTRACT]: BASE_CONTRACT.replace("config repos\n", ""),
    });
    const run = await repo.plan();
    assertEquals(outputs(run), minted("2.0.0", "major"));
    assertStringIncludes(run.stderr, "contract entries removed: config repos");
  });
});

Deno.test("next-release-tag - a renamed configuration key is a major", async () => {
  // A rename is a removal plus an addition: a .config.json that still spells
  // the old key no longer configures anything.
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({
      [CONTRACT]: BASE_CONTRACT.replace("config repos", "config repositories"),
    });
    assertEquals(outputs(await repo.plan()), minted("2.0.0", "major"));
  });
});

Deno.test("next-release-tag - a moved callback schema version is a major", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({
      [CONTRACT]: BASE_CONTRACT.replace(
        "callback-schema 2",
        "callback-schema 3",
      ),
    });
    const run = await repo.plan();
    assertEquals(outputs(run), minted("2.0.0", "major"));
    assertStringIncludes(run.stderr, "callback-schema 2");
  });
});

Deno.test("next-release-tag - the highest category wins, applied once", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({ "container/tools.json": "{}\n" });
    await repo.commit({
      [CONTRACT]: BASE_CONTRACT.replace("config repos\n", "config zz_new\n"),
    });
    await repo.commit({ "worker/x.ts": "export {};\n" });
    // Three merges' worth of change since 1.4.7, one release: 2.0.0, not 3.x.
    assertEquals(outputs(await repo.plan()), minted("2.0.0", "major"));
  });
});

Deno.test("next-release-tag - a key removed and restored before the release is no change", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({
      [CONTRACT]: BASE_CONTRACT.replace("config repos\n", ""),
    });
    await repo.commit({ [CONTRACT]: BASE_CONTRACT });
    assertEquals(outputs(await repo.plan()), minted("1.4.8", "patch"));
  });
});

Deno.test("next-release-tag - a last release with no contract record is a major (the 2.0.0 transition)", async () => {
  // The release that introduced the record: the release before it cannot show
  // its configuration surface is compatible, so the series moves to the next
  // major once and continues from the record after that.
  await withRepo(async (repo) => {
    await repo.commit({ "README.md": "hello\n" });
    await repo.tag("1.10.529");
    await repo.commit({ [CONTRACT]: BASE_CONTRACT });
    const run = await repo.plan();
    assertEquals(outputs(run), minted("2.0.0", "major"));
    assertStringIncludes(run.stderr, "has no docs/audits/release-contract.txt");

    await repo.tag("2.0.0");
    await repo.commit({ "a.txt": "a\n" });
    assertEquals(outputs(await repo.plan()), minted("2.0.1", "patch"));
  });
});

// --- Comparing from the merge base ---------------------------------------

Deno.test("next-release-tag - a commit older than the newest release classifies only its own history", async () => {
  // An out-of-order re-run: 1.5.0 was minted for a later container change, and
  // the run for the commit before it must not count that change.
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    const older = await repo.commit({ "a.txt": "a\n" });
    await repo.commit({ "container/tools.json": "{}\n" });
    await repo.tag("1.5.0");
    assertEquals(outputs(await repo.plan(older)), minted("1.5.1", "patch"));
  });
});

Deno.test("next-release-tag - a commit on a side branch is compared from where it left the release", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await git(repo.dir, "checkout", "-q", "-b", "side");
    const side = await repo.commit({ "a.txt": "a\n" });
    await git(repo.dir, "checkout", "-q", "main");
    await repo.commit({ "container/tools.json": "{}\n" });
    await repo.tag("1.5.0");
    assertEquals(outputs(await repo.plan(side)), minted("1.5.1", "patch"));
  });
});

// --- Failing loud --------------------------------------------------------

Deno.test("next-release-tag - a commit with no contract record fails loud", async () => {
  // Guessing a patch for a merge whose contract cannot be read is the mistake
  // the classification exists to prevent.
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    await repo.commit({ [CONTRACT]: null });
    const run = await repo.plan();
    assert(run.code !== 0, "a missing contract record must fail the step");
    assertEquals(run.stdout, "");
    assertStringIncludes(run.stderr, "deno task release-contract");
  });
});

Deno.test("next-release-tag - a commit that does not resolve fails loud", async () => {
  await withRepo(async (repo) => {
    await repo.released("1.4.7");
    const run = await repo.plan("0000000000000000000000000000000000000000");
    assert(run.code !== 0, "an unknown commit must fail the step");
    assertEquals(run.stdout, "");
    assertStringIncludes(run.stderr, "not a commit");
  });
});

Deno.test("next-release-tag - a directory that is not a repository fails loud", async () => {
  const dir = await Deno.makeTempDir({ prefix: "next_release_tag_bare_" });
  try {
    const run = await runScript([dir, "HEAD"]);
    assert(run.code !== 0, "a non-repository must fail the step");
    assertEquals(run.stdout, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("next-release-tag - a missing argument fails loud", async () => {
  for (const args of [[], [REPO_ROOT]]) {
    const run = await runScript(args);
    assert(run.code !== 0, `missing arguments must fail the step: ${args}`);
    assertEquals(run.stdout, "");
  }
});

// --- The repository's own record -----------------------------------------

Deno.test("next-release-tag - the repository's contract record is committed, not ignored", async () => {
  // `.gitignore` ignores much by default. The tagger reads the record from
  // git, so an ignored record would fail every merge's tag step.
  const out = await new Deno.Command("git", {
    args: ["check-ignore", "-q", CONTRACT],
    cwd: REPO_ROOT,
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(out.code, 1, `${CONTRACT} must be committed, not ignored`);
});

Deno.test("next-release-tag - nothing hand-edited decides the version any more", async () => {
  // The release floor (Issue #808) was a manual step; the version is now
  // derived entirely from the change, so the file must not come back.
  const floor = await Deno.stat(`${REPO_ROOT}.release-floor`).then(
    () => true,
    () => false,
  );
  assertEquals(floor, false, ".release-floor must not exist");
});
