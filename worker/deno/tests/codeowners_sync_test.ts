/**
 * Tests for the setup-time default CODEOWNERS writer (Issue #2627, part of
 * #2611).
 *
 * The writer creates `.github/CODEOWNERS` in a repo's `WORK_DIR` checkout
 * only when neither the checkout nor the default branch has a CODEOWNERS file
 * at any of the three locations GitHub reads. Each test runs against a temp
 * directory and a stubbed default-branch lookup — no network, no git.
 *
 * Failure directions covered:
 *   - the written file drifts from the three-rule default → byte comparison
 *     fails;
 *   - the writer overwrites an existing file → bytes or mtime change;
 *   - the writer writes after a failed default-branch check → file appears;
 *   - a second run rewrites → result is not `skipped`.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  CODEOWNERS_CHECK_PATHS,
  CODEOWNERS_WRITE_PATH,
  codeownersOwnerError,
  DEFAULT_CODEOWNERS_OWNERS,
  renderDefaultCodeowners,
  syncCodeowners,
} from "../setup/codeowners_sync.ts";
import type { CodeownersLocation } from "../lib/repo_settings_harden.ts";

const EXPECTED_DEFAULT_FILE = "/.github/workflows/ @nleck @Green-Beret\n" +
  "/.github/actions/ @nleck @Green-Beret\n" +
  "/.github/CODEOWNERS @nleck @Green-Beret\n";

function absent(): (repo: string) => Promise<CodeownersLocation> {
  return () => Promise.resolve({ state: "absent" });
}

async function withCheckout(
  fn: (workDir: string, repoPath: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "codeowners_sync_" });
  try {
    const repoPath = `${workDir}/repo`;
    await Deno.mkdir(repoPath);
    await fn(workDir, repoPath);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

Deno.test("DEFAULT_CODEOWNERS_OWNERS is @nleck and @Green-Beret", () => {
  assertEquals([...DEFAULT_CODEOWNERS_OWNERS], ["@nleck", "@Green-Beret"]);
});

Deno.test("syncCodeowners - default config writes the exact three-rule file", async () => {
  await withCheckout(async (workDir, repoPath) => {
    const result = await syncCodeowners({
      repo: "org/repo",
      workDir,
      owners: DEFAULT_CODEOWNERS_OWNERS,
      findOnDefaultBranch: absent(),
    });
    assertEquals(result, { status: "written", path: ".github/CODEOWNERS" });
    assertEquals(
      await Deno.readTextFile(`${repoPath}/.github/CODEOWNERS`),
      EXPECTED_DEFAULT_FILE,
    );
    assertEquals(
      renderDefaultCodeowners(DEFAULT_CODEOWNERS_OWNERS),
      EXPECTED_DEFAULT_FILE,
    );
  });
});

Deno.test("syncCodeowners - configured owners own all three rules", async () => {
  await withCheckout(async (workDir, repoPath) => {
    await syncCodeowners({
      repo: "org/repo",
      workDir,
      owners: ["@alice", "@org/team"],
      findOnDefaultBranch: absent(),
    });
    assertEquals(
      await Deno.readTextFile(`${repoPath}/.github/CODEOWNERS`),
      "/.github/workflows/ @alice @org/team\n" +
        "/.github/actions/ @alice @org/team\n" +
        "/.github/CODEOWNERS @alice @org/team\n",
    );
  });
});

Deno.test("CODEOWNERS_CHECK_PATHS covers the three locations GitHub reads", () => {
  assertEquals(
    [...CODEOWNERS_CHECK_PATHS].sort(),
    [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"],
  );
  assertEquals(CODEOWNERS_WRITE_PATH, ".github/CODEOWNERS");
});

for (
  const location of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
) {
  Deno.test(`syncCodeowners - existing ${location} in the checkout is untouched`, async () => {
    await withCheckout(async (workDir, repoPath) => {
      const target = `${repoPath}/${location}`;
      const dir = target.slice(0, target.lastIndexOf("/"));
      await Deno.mkdir(dir, { recursive: true });
      const original = "* @someone-else\n";
      await Deno.writeTextFile(target, original);
      const past = new Date("2020-01-01T00:00:00Z");
      await Deno.utime(target, past, past);
      const before = await Deno.stat(target);

      let lookedUp = false;
      const result = await syncCodeowners({
        repo: "org/repo",
        workDir,
        owners: DEFAULT_CODEOWNERS_OWNERS,
        findOnDefaultBranch: () => {
          lookedUp = true;
          return Promise.resolve({ state: "absent" });
        },
      });

      assertEquals(result, {
        status: "skipped",
        reason: `present at ${location}`,
      });
      assertEquals(await Deno.readTextFile(target), original);
      assertEquals(
        (await Deno.stat(target)).mtime?.getTime(),
        before.mtime?.getTime(),
      );
      assertEquals(lookedUp, false, "a local file settles it without the API");
      if (location !== ".github/CODEOWNERS") {
        assertEquals(await exists(`${repoPath}/.github/CODEOWNERS`), false);
      }
    });
  });

  Deno.test(`syncCodeowners - ${location} on the default branch blocks the write`, async () => {
    await withCheckout(async (workDir, repoPath) => {
      const result = await syncCodeowners({
        repo: "org/repo",
        workDir,
        owners: DEFAULT_CODEOWNERS_OWNERS,
        findOnDefaultBranch: () =>
          Promise.resolve({ state: "present", path: location }),
      });
      assertEquals(result, {
        status: "skipped",
        reason: `present at ${location}`,
      });
      assertEquals(await exists(`${repoPath}/.github/CODEOWNERS`), false);
      assertEquals(await exists(`${repoPath}/CODEOWNERS`), false);
      assertEquals(await exists(`${repoPath}/docs/CODEOWNERS`), false);
    });
  });
}

Deno.test("syncCodeowners - a dangling CODEOWNERS symlink counts as present", async () => {
  await withCheckout(async (workDir, repoPath) => {
    await Deno.symlink(`${repoPath}/nowhere`, `${repoPath}/CODEOWNERS`);
    const result = await syncCodeowners({
      repo: "org/repo",
      workDir,
      owners: DEFAULT_CODEOWNERS_OWNERS,
      findOnDefaultBranch: absent(),
    });
    assertEquals(result, {
      status: "skipped",
      reason: "present at CODEOWNERS",
    });
    assertEquals(await exists(`${repoPath}/.github/CODEOWNERS`), false);
  });
});

Deno.test("syncCodeowners - a failed default-branch check writes nothing", async () => {
  await withCheckout(async (workDir, repoPath) => {
    const result = await syncCodeowners({
      repo: "org/repo",
      workDir,
      owners: DEFAULT_CODEOWNERS_OWNERS,
      findOnDefaultBranch: () =>
        Promise.resolve({
          state: "error",
          message: "could not read .github/CODEOWNERS: HTTP 502",
        }),
    });
    assertEquals(result, {
      status: "skipped",
      reason:
        "default-branch check failed: could not read .github/CODEOWNERS: HTTP 502",
    });
    assertEquals(await exists(`${repoPath}/.github`), false);
  });
});

Deno.test("syncCodeowners - a thrown default-branch check writes nothing", async () => {
  await withCheckout(async (workDir, repoPath) => {
    const result = await syncCodeowners({
      repo: "org/repo",
      workDir,
      owners: DEFAULT_CODEOWNERS_OWNERS,
      findOnDefaultBranch: () => Promise.reject(new Error("gh not found")),
    });
    assertEquals(result, {
      status: "skipped",
      reason: "default-branch check failed: gh not found",
    });
    assertEquals(await exists(`${repoPath}/.github`), false);
  });
});

Deno.test("syncCodeowners - running twice gives written, then skipped", async () => {
  await withCheckout(async (workDir, repoPath) => {
    const opts = {
      repo: "org/repo",
      workDir,
      owners: DEFAULT_CODEOWNERS_OWNERS,
      findOnDefaultBranch: absent(),
    };
    const first = await syncCodeowners(opts);
    assertEquals(first.status, "written");
    const second = await syncCodeowners(opts);
    assertEquals(second, {
      status: "skipped",
      reason: "present at .github/CODEOWNERS",
    });
    assertEquals(
      await Deno.readTextFile(`${repoPath}/.github/CODEOWNERS`),
      EXPECTED_DEFAULT_FILE,
    );
  });
});

Deno.test("syncCodeowners - no checkout is skipped without asking the API", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "codeowners_sync_none_" });
  try {
    let lookedUp = false;
    const result = await syncCodeowners({
      repo: "org/missing",
      workDir,
      owners: DEFAULT_CODEOWNERS_OWNERS,
      findOnDefaultBranch: () => {
        lookedUp = true;
        return Promise.resolve({ state: "absent" });
      },
    });
    assertEquals(result, { status: "skipped", reason: "no local checkout" });
    assertEquals(lookedUp, false);
    assertEquals(await exists(`${workDir}/missing`), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("syncCodeowners - a file where the checkout should be is no checkout", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "codeowners_sync_file_" });
  try {
    await Deno.writeTextFile(`${workDir}/repo`, "not a directory");
    const result = await syncCodeowners({
      repo: "org/repo",
      workDir,
      owners: DEFAULT_CODEOWNERS_OWNERS,
      findOnDefaultBranch: absent(),
    });
    assertEquals(result, { status: "skipped", reason: "no local checkout" });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("syncCodeowners - an invalid repo slug is an error, never a path", async () => {
  await withCheckout(async (workDir) => {
    const result = await syncCodeowners({
      repo: "org/..",
      workDir,
      owners: DEFAULT_CODEOWNERS_OWNERS,
      findOnDefaultBranch: absent(),
    });
    assertEquals(result.status, "error");
    assertEquals(await exists(`${workDir}/.github`), false);
  });
});

Deno.test("syncCodeowners - a bot owner is refused before anything is written", async () => {
  await withCheckout(async (workDir, repoPath) => {
    const result = await syncCodeowners({
      repo: "org/repo",
      workDir,
      owners: ["@nleck", "@stservice"],
      findOnDefaultBranch: absent(),
    });
    assertEquals(result.status, "error");
    assert(result.status === "error" && result.message.includes("@stservice"));
    assertEquals(await exists(`${repoPath}/.github`), false);
  });
});

Deno.test("syncCodeowners - an empty owner list is refused", async () => {
  await withCheckout(async (workDir, repoPath) => {
    const result = await syncCodeowners({
      repo: "org/repo",
      workDir,
      owners: [],
      findOnDefaultBranch: absent(),
    });
    assertEquals(result.status, "error");
    assertEquals(await exists(`${repoPath}/.github`), false);
  });
});

Deno.test("codeownersOwnerError - accepts users and org teams", () => {
  for (const ok of ["@nleck", "@Green-Beret", "@org/team", "@org/team.x_y-z"]) {
    assertEquals(codeownersOwnerError(ok), null, ok);
  }
});

Deno.test("codeownersOwnerError - rejects bots and malformed entries, naming them", () => {
  for (
    const bad of [
      "@foo[bot]",
      "@stservice",
      "@StService",
      "@VibeCoderST",
      "@stSoftwareAU/developers",
      "@stsoftwareau/Developers",
      "nleck",
      "@",
      "@a b",
      "@org/team/extra",
      "someone@example.com",
    ]
  ) {
    const error = codeownersOwnerError(bad);
    assert(error !== null, `${bad} must be rejected`);
    assert(error.includes(bad), `error must name ${bad}: ${error}`);
  }
});
