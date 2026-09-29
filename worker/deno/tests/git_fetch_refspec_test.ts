/**
 * Tests for the fetch-refspec repair of legacy single-branch clones
 * (Issue #211).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { resetSafeDirectoryRepairs } from "../lib/git_timeout.ts";
import {
  ALL_BRANCHES_FETCH_REFSPEC,
  ensureAllBranchesFetchRefspec,
} from "../lib/git_fetch_refspec.ts";

async function runGit(args: string[], cwd: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
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
  return new TextDecoder().decode(out.stdout);
}

/** Upstream with `main` plus a `feat` branch, cloned single-branch. */
async function makeSingleBranchClone(
  prefix: string,
): Promise<{ tmp: string; downstream: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const seed = `${tmp}/seed`;
  const downstream = `${tmp}/downstream`;

  await runGit(["init", "--bare", "-b", "main", upstream], tmp);
  await runGit(["clone", upstream, seed], tmp);
  await runGit(["config", "user.email", "t@t"], seed);
  await runGit(["config", "user.name", "t"], seed);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "seed"], seed);
  await runGit(["push", "origin", "main"], seed);
  await runGit(["checkout", "-b", "feat"], seed);
  await Deno.writeTextFile(`${seed}/a.txt`, "a\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "a"], seed);
  await runGit(["push", "origin", "feat"], seed);

  await runGit(
    ["clone", "--single-branch", "--branch", "main", upstream, downstream],
    tmp,
  );
  return { tmp, downstream };
}

Deno.test("ensureAllBranchesFetchRefspec - repairs a single-branch clone so feature branches gain tracking refs (Issue #211)", async () => {
  const { tmp, downstream } = await makeSingleBranchClone("refspec_repair_");
  try {
    // Before the repair, fetching the feature branch leaves no tracking ref.
    await runGit(["fetch", "origin", "feat"], downstream);
    const beforeRefs = await runGit(
      ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
      downstream,
    );
    assert(
      !beforeRefs.includes("refs/remotes/origin/feat"),
      `single-branch clone should not track feat, got:\n${beforeRefs}`,
    );

    const result = await ensureAllBranchesFetchRefspec({ cwd: downstream });
    assert(result.ok, !result.ok ? result.error.message : "");
    if (result.ok) assertEquals(result.value.repaired, true);

    // After the repair the tracking ref appears on the next fetch.
    await runGit(["fetch", "origin"], downstream);
    const afterRefs = await runGit(
      ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
      downstream,
    );
    assert(
      afterRefs.includes("refs/remotes/origin/feat"),
      `repaired clone should track feat, got:\n${afterRefs}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("ensureAllBranchesFetchRefspec - leaves a full clone untouched and is idempotent (Issue #211)", async () => {
  const { tmp, downstream } = await makeSingleBranchClone(
    "refspec_idempotent_",
  );
  try {
    const first = await ensureAllBranchesFetchRefspec({ cwd: downstream });
    assert(first.ok);
    if (first.ok) assertEquals(first.value.repaired, true);

    // A second call must not add the refspec again.
    const second = await ensureAllBranchesFetchRefspec({ cwd: downstream });
    assert(second.ok);
    if (second.ok) assertEquals(second.value.repaired, false);

    const configured = await runGit(
      ["config", "--get-all", "remote.origin.fetch"],
      downstream,
    );
    const occurrences = configured.split("\n").filter((line) =>
      line.trim() === ALL_BRANCHES_FETCH_REFSPEC
    );
    assertEquals(occurrences.length, 1);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("ensureAllBranchesFetchRefspec - reports a git failure rather than claiming a repair (Issue #211)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "refspec_not_a_repo_" });
  try {
    const result = await ensureAllBranchesFetchRefspec({ cwd: tmp });
    assert(!result.ok, "a non-repository must fail loudly, not report ok");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// Issue #2825: setup died every cycle with "Failed to add the all-branches
// fetch refspec: fatal: not in a git directory". Outside a usable repository
// `git config --get-all` exits 1 exactly like "no such key", so the read
// passed and the `--add` reported a reason that named neither cause.
Deno.test("ensureAllBranchesFetchRefspec - names git's own reason when the directory is not a repository (Issue #2825)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "refspec_plain_dir_" });
  try {
    const result = await ensureAllBranchesFetchRefspec({ cwd: tmp });
    assert(!result.ok, "a non-repository must fail loudly");
    assertStringIncludes(result.error.message, "not a git repository");
    assert(
      !result.error.message.includes("Failed to add"),
      `the misleading --add failure must not be the reported reason: ${result.error.message}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/** Env that makes git see the clone as owned by someone else (Issue #2825). */
function dubiousOwnershipEnv(globalConfig: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
  };
}

Deno.test("ensureAllBranchesFetchRefspec - restores safe.directory when git refuses the clone as dubious ownership (Issue #2825)", async () => {
  resetSafeDirectoryRepairs();
  const { tmp, downstream } = await makeSingleBranchClone("refspec_dubious_");
  try {
    // The staged global config has lost its `safe.directory` line.
    const globalConfig = `${tmp}/gitconfig`;
    await Deno.writeTextFile(globalConfig, "");
    const env = dubiousOwnershipEnv(globalConfig);

    const result = await ensureAllBranchesFetchRefspec({
      cwd: downstream,
      env,
    });
    assert(result.ok, `setup must self-heal: ${!result.ok && result.error}`);
    assertEquals(result.value.repaired, true);
    assertStringIncludes(
      await Deno.readTextFile(globalConfig),
      "directory = *",
    );
  } finally {
    resetSafeDirectoryRepairs();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("ensureAllBranchesFetchRefspec - reports dubious ownership when safe.directory cannot be restored (Issue #2825)", async () => {
  resetSafeDirectoryRepairs();
  const { tmp, downstream } = await makeSingleBranchClone("refspec_dubious_");
  try {
    // The global config lives in a directory that no longer exists, so the
    // repair cannot write and git's own refusal must be the reported reason.
    const env = dubiousOwnershipEnv(`${tmp}/gone/gitconfig`);

    const result = await ensureAllBranchesFetchRefspec({
      cwd: downstream,
      env,
    });
    assert(!result.ok, "a clone git still refuses must fail loudly");
    assertStringIncludes(result.error.message, "dubious ownership");
  } finally {
    resetSafeDirectoryRepairs();
    await Deno.remove(tmp, { recursive: true });
  }
});
