/**
 * Regression test suite — git operations parity validation (Issue #1235).
 *
 * Validates that the Deno git operations produce identical results to the
 * original shell implementations, focusing on branch naming, protection
 * detection, and edge cases with special characters and empty inputs.
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createBranchName,
  createMilestoneBranchName,
  isProtectedBranch,
} from "../lib/git_branch.ts";
import { setupRepo } from "../commands/git_operations.ts";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnRunner,
} from "../lib/gh_spawn.ts";
import {
  cloneRecoveryStatePath,
  parseCloneCorruptRepeat,
} from "../lib/corrupt_clone_recovery.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import { classifyCodingFailure } from "../lib/coding_failure_ladder.ts";

// ============================================================================
// createBranchName — edge cases and parity with shell implementation
// ============================================================================

Deno.test("regression git - createBranchName with empty title", () => {
  const result = createBranchName(42, "");
  assertEquals(result, "issue-42-");
});

Deno.test("regression git - createBranchName with whitespace-only title", () => {
  const result = createBranchName(42, "   ");
  // Whitespace chars become hyphens, consecutive hyphens collapse to one
  assert(result.startsWith("issue-42-"), "Should start with issue prefix");
});

Deno.test("regression git - createBranchName with special characters", () => {
  const result = createBranchName(42, "Fix: login bug (authentication) @#$%");
  // All special chars should be replaced with hyphens, consecutive hyphens collapsed
  assert(!result.includes(" "), "Branch name should not contain spaces");
  assert(!result.includes("("), "Branch name should not contain parentheses");
  assert(!result.includes("@"), "Branch name should not contain @");
  assert(!result.includes("#"), "Branch name should not contain #");
  assert(
    result.startsWith("issue-42-"),
    "Branch name should start with issue prefix",
  );
});

Deno.test("regression git - createBranchName with Unicode characters", () => {
  const result = createBranchName(42, "Fix für überprüfung");
  // Unicode chars are not [a-z0-9], so they become hyphens
  assert(!result.includes("ü"), "Branch name should not contain Unicode");
  assertEquals(result, "issue-42-fix-f-r-berpr-fung");
});

Deno.test("regression git - createBranchName truncates long titles to 50 chars", () => {
  const longTitle = "a".repeat(100);
  const result = createBranchName(1, longTitle);
  // "issue-1-" prefix (8 chars) + up to 50 chars from title
  const titlePart = result.substring("issue-1-".length);
  assert(
    titlePart.length <= 50,
    `Title part should be at most 50 chars, got ${titlePart.length}`,
  );
});

Deno.test("regression git - createBranchName with issue number 0", () => {
  const result = createBranchName(0, "test");
  assertEquals(result, "issue-0-test");
});

Deno.test("regression git - createBranchName with large issue number", () => {
  const result = createBranchName(999999, "test");
  assertEquals(result, "issue-999999-test");
});

Deno.test("regression git - createBranchName collapses consecutive hyphens", () => {
  const result = createBranchName(42, "fix -- multiple --- hyphens");
  assert(
    !result.includes("--"),
    "Branch name should not contain consecutive hyphens",
  );
});

Deno.test("regression git - createBranchName lowercases all characters", () => {
  const result = createBranchName(42, "FIX LOGIN Bug");
  assertEquals(result, "issue-42-fix-login-bug");
});

Deno.test("regression git - createBranchName with numbers in title", () => {
  const result = createBranchName(42, "Fix issue 123 in module 456");
  assertEquals(result, "issue-42-fix-issue-123-in-module-456");
});

// ============================================================================
// createMilestoneBranchName — edge cases
// ============================================================================

Deno.test("regression git - createMilestoneBranchName with empty title", () => {
  const result = createMilestoneBranchName("");
  assertEquals(result, "milestone/");
});

Deno.test("regression git - createMilestoneBranchName strips leading/trailing hyphens", () => {
  const result = createMilestoneBranchName("  OIDC Auth  ");
  assert(!result.endsWith("-"), "Should strip trailing hyphens");
  assertEquals(result, "milestone/oidc-auth");
});

Deno.test("regression git - createMilestoneBranchName truncates to 50 chars", () => {
  const longTitle = "a".repeat(100);
  const result = createMilestoneBranchName(longTitle);
  const titlePart = result.substring("milestone/".length);
  assert(
    titlePart.length <= 50,
    `Title part should be at most 50 chars, got ${titlePart.length}`,
  );
});

Deno.test("regression git - createMilestoneBranchName with special characters", () => {
  const result = createMilestoneBranchName("OIDC Authentication (Phase 2)");
  assertEquals(result, "milestone/oidc-authentication-phase-2");
});

Deno.test("regression git - createMilestoneBranchName with version numbers", () => {
  const result = createMilestoneBranchName("v2.0 Release");
  assertEquals(result, "milestone/v2-0-release");
});

// ============================================================================
// isProtectedBranch — comprehensive detection
// ============================================================================

Deno.test("regression git - isProtectedBranch detects all standard protected branches", () => {
  const protectedNames = [
    "main",
    "master",
    "develop",
    "release",
    "production",
    "staging",
  ];

  for (const name of protectedNames) {
    assert(isProtectedBranch(name), `"${name}" should be protected`);
  }
});

Deno.test("regression git - isProtectedBranch is case-insensitive", () => {
  assert(isProtectedBranch("MAIN"), "MAIN should be protected");
  assert(isProtectedBranch("Main"), "Main should be protected");
  assert(isProtectedBranch("DEVELOP"), "DEVELOP should be protected");
  assert(isProtectedBranch("Master"), "Master should be protected");
});

Deno.test("regression git - isProtectedBranch detects milestone branches", () => {
  assert(
    isProtectedBranch("milestone/oidc-auth"),
    "milestone/ branches should be protected",
  );
  assert(isProtectedBranch("milestone/v2"), "milestone/v2 should be protected");
  assert(
    isProtectedBranch("MILESTONE/test"),
    "MILESTONE/ should be protected (case-insensitive)",
  );
});

Deno.test("regression git - isProtectedBranch allows feature branches", () => {
  assert(
    !isProtectedBranch("issue-42-fix-bug"),
    "Feature branches should not be protected",
  );
  assert(
    !isProtectedBranch("feature/new-login"),
    "feature/ branches should not be protected",
  );
  assert(
    !isProtectedBranch("hotfix/urgent-fix"),
    "hotfix/ branches should not be protected",
  );
  assert(
    !isProtectedBranch("main-feature"),
    "'main-feature' should not be protected",
  );
});

Deno.test("regression git - isProtectedBranch handles empty string", () => {
  assert(!isProtectedBranch(""), "Empty string should not be protected");
});

Deno.test("regression git - isProtectedBranch does not match partial names", () => {
  assert(
    !isProtectedBranch("maintainer"),
    "'maintainer' should not match 'main'",
  );
  assert(
    !isProtectedBranch("developer"),
    "'developer' should not match 'develop'",
  );
  assert(
    !isProtectedBranch("masterclass"),
    "'masterclass' should not match 'master'",
  );
});

// ============================================================================
// setupRepo — move a corrupt clone aside and re-clone it (Issue #2957)
// ============================================================================

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

async function listCorruptAsides(tmp: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(tmp)) {
    if (entry.name.includes(".corrupt-")) found.push(entry.name);
  }
  return found;
}

/** A gh runner that re-clones `upstream` to whatever target args[3] names. */
function recloningRunner(upstream: string): GhSpawnRunner {
  return async (args) => {
    const target = args[3] as string;
    const code = await runGit(["clone", `file://${upstream}`, target], "/");
    return {
      code,
      success: code === 0,
      stdout: "",
      stderr: code === 0 ? "" : "simulated re-clone failure",
    };
  };
}

async function makeUpstreamAndClone(
  tmp: string,
): Promise<{ upstream: string; clonePath: string }> {
  const upstream = `${tmp}/upstream`;
  const clonePath = `${tmp}/downstream`;
  await Deno.mkdir(upstream, { recursive: true });
  assertEquals(await runGit(["init", "-b", "main", "."], upstream), 0);
  await runGit(["config", "user.email", "t@t"], upstream);
  await runGit(["config", "user.name", "t"], upstream);
  await write(`${upstream}/file.txt`, "first\n");
  await runGit(["add", "."], upstream);
  await runGit(["commit", "-m", "first"], upstream);
  assertEquals(
    await runGit(["clone", `file://${upstream}`, clonePath], tmp),
    0,
  );
  return { upstream, clonePath };
}

Deno.test("setupRepo - a corrupt .git/config is moved aside and re-cloned (Issue #2957, AC1)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "setup_repo_corrupt_config_" });
  try {
    const { upstream, clonePath } = await makeUpstreamAndClone(tmp);
    await Deno.writeTextFile(
      `${clonePath}/.git/config`,
      "not a valid config line\n" +
        await Deno.readTextFile(`${clonePath}/.git/config`),
    );

    _setGhSpawnRunner(recloningRunner(upstream));
    try {
      const result = await setupRepo("owner/downstream", tmp);
      assertEquals(result.success, true, result.message);
    } finally {
      _resetGhSpawnRunner();
    }

    const asides = await listCorruptAsides(tmp);
    assertEquals(asides.length, 1, `expected exactly one aside, got ${asides}`);

    const rev = await runGit(["rev-parse", "--git-dir"], clonePath);
    assertEquals(rev, 0, "the re-cloned downstream must be a healthy clone");

    const state = JSON.parse(
      await Deno.readTextFile(cloneRecoveryStatePath(tmp)),
    );
    assert(
      "owner/downstream" in state,
      "the state file must record the recovered repo",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setupRepo - a bad object referenced by a loose ref is moved aside and re-cloned (Issue #2957, AC2)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "setup_repo_corrupt_ref_" });
  try {
    const { upstream, clonePath } = await makeUpstreamAndClone(tmp);

    // A fresh commit upstream so the up-to-date fast path cannot skip fetch.
    await write(`${upstream}/file2.txt`, "second\n");
    await runGit(["add", "."], upstream);
    await runGit(["commit", "-m", "second"], upstream);

    // Corrupt the loose ref so it points at an object that doesn't exist,
    // ensuring it isn't only resolvable via packed-refs.
    await runGit(["pack-refs", "--all"], clonePath);
    await write(
      `${clonePath}/.git/refs/heads/main`,
      "1234567890123456789012345678901234567890\n",
    );

    _setGhSpawnRunner(recloningRunner(upstream));
    try {
      const result = await setupRepo("owner/downstream", tmp);
      assertEquals(result.success, true, result.message);
      // A single corruption's own recovery succeeds — its message carries no
      // clone-corrupt-repeat payload (Issue #2958).
      assertEquals(parseCloneCorruptRepeat(result.message), null);
    } finally {
      _resetGhSpawnRunner();
    }

    const asides = await listCorruptAsides(tmp);
    assertEquals(asides.length, 1, `expected exactly one aside, got ${asides}`);

    const rev = await runGit(["rev-parse", "--git-dir"], clonePath);
    assertEquals(rev, 0, "the re-cloned downstream must be a healthy clone");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setupRepo - a recovery already used within 24h is not retried (Issue #2957, AC3)", async () => {
  const tmp = await Deno.makeTempDir({
    prefix: "setup_repo_recovery_capped_",
  });
  try {
    const { clonePath } = await makeUpstreamAndClone(tmp);

    await Deno.writeTextFile(
      cloneRecoveryStatePath(tmp),
      JSON.stringify({ "owner/downstream": new Date().toISOString() }),
    );

    await Deno.writeTextFile(
      `${clonePath}/.git/config`,
      "not a valid config line\n" +
        await Deno.readTextFile(`${clonePath}/.git/config`),
    );

    const result = await setupRepo("owner/downstream", tmp);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "bad config line");

    assert(exists(clonePath), "downstream must not be moved while capped");
    const asides = await listCorruptAsides(tmp);
    assertEquals(asides.length, 0, "no aside directory should be created");

    // The refusal carries a parseable clone-corrupt-repeat payload (Issue
    // #2958), and the setup-phase reason it feeds through classifies as a
    // transient `clone_corrupt` failure.
    const repeat = parseCloneCorruptRepeat(result.message);
    assert(
      repeat !== null,
      "cap refusal must carry a clone-corrupt-repeat payload",
    );
    assertStringIncludes(repeat.currentGitMessage, "bad config line");

    const reason = `Failed to set up repo owner/downstream: ${result.message}`;
    assertEquals(detectFailureCategory(reason), "clone_corrupt");
    assertEquals(classifyCodingFailure(reason).disposition, "transient");
    // The release path parses the payload out of this exact wrapped message
    // (`outcome.message`), so the wrapper must not break the parse (Issue
    // #2958).
    assertEquals(parseCloneCorruptRepeat(reason), repeat);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setupRepo - a cap refusal after a successful recovery carries both corruptions' git messages (Issue #2958)", async () => {
  const tmp = await Deno.makeTempDir({
    prefix: "setup_repo_recovery_repeat_",
  });
  try {
    const { upstream, clonePath } = await makeUpstreamAndClone(tmp);

    // First corruption: a bad git-config line, recovered successfully (the
    // same shape as the AC2 test), which writes the object-form state entry.
    await Deno.writeTextFile(
      `${clonePath}/.git/config`,
      "not a valid config line\n" +
        await Deno.readTextFile(`${clonePath}/.git/config`),
    );
    _setGhSpawnRunner(recloningRunner(upstream));
    try {
      const first = await setupRepo("owner/downstream", tmp);
      assertEquals(first.success, true, first.message);
    } finally {
      _resetGhSpawnRunner();
    }

    // A fresh commit upstream so the up-to-date fast path cannot skip fetch.
    await write(`${upstream}/file2.txt`, "second\n");
    await runGit(["add", "."], upstream);
    await runGit(["commit", "-m", "second"], upstream);

    // Second corruption, inside the 24 h window: this time a bad object
    // behind a loose ref.
    await runGit(["pack-refs", "--all"], clonePath);
    await write(
      `${clonePath}/.git/refs/heads/main`,
      "1234567890123456789012345678901234567890\n",
    );

    const second = await setupRepo("owner/downstream", tmp);
    assertEquals(second.success, false);

    const repeat = parseCloneCorruptRepeat(second.message);
    assert(repeat !== null, "repeat cap refusal must carry a payload");
    assertStringIncludes(
      repeat.previousGitMessage ?? "",
      "bad config line",
    );
    assertStringIncludes(repeat.currentGitMessage, "bad object");
    assert(repeat.aside !== undefined, "aside must name the first recovery");

    const reason = `Failed to set up repo owner/downstream: ${second.message}`;
    assertEquals(detectFailureCategory(reason), "clone_corrupt");
    assertEquals(classifyCodingFailure(reason).disposition, "transient");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setupRepo - a failed recovery re-clone names the repo path (Issue #2957, AC6)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "setup_repo_reclone_fails_" });
  try {
    const { clonePath } = await makeUpstreamAndClone(tmp);
    await Deno.writeTextFile(
      `${clonePath}/.git/config`,
      "not a valid config line\n" +
        await Deno.readTextFile(`${clonePath}/.git/config`),
    );

    _setGhSpawnRunner(() =>
      Promise.resolve({
        code: 1,
        success: false,
        stdout: "",
        stderr: "simulated gh failure",
      })
    );
    try {
      const result = await setupRepo("owner/downstream", tmp);
      assertEquals(result.success, false);
      assertStringIncludes(
        result.message,
        "Failed to clone owner/downstream: ",
      );
      assertStringIncludes(result.message, clonePath);
      // A single corruption (this re-clone failed, but nothing repeated yet)
      // carries no repeat payload, so the release path never escalates it
      // (Issue #2958).
      assertEquals(parseCloneCorruptRepeat(result.message), null);
    } finally {
      _resetGhSpawnRunner();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setupRepo - a healthy clone is never moved aside (Issue #2957)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "setup_repo_healthy_" });
  try {
    await makeUpstreamAndClone(tmp);

    const result = await setupRepo("owner/downstream", tmp);
    assertEquals(result.success, true, result.message);

    const asides = await listCorruptAsides(tmp);
    assertEquals(asides.length, 0, "a healthy clone must never be moved");
    assert(
      !exists(cloneRecoveryStatePath(tmp)),
      "no recovery state should be written for a healthy clone",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
