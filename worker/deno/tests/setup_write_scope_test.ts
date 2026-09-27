/**
 * Setup's GitHub writes run inside a write-repo allowlist seeded from the
 * configured repos (Issue #2684).
 *
 * Every setup write used to log `[SECURITY] [WRITE_REPO_UNSEEDED]`: setup is
 * its own process, and nothing in it seeded the allowlist (Issue #1425), so
 * each write went through unscoped and the security log filled with lines
 * that meant nothing. Setup knows its targets — `.config.json` `repos` — so it
 * seeds them before any repo-side step writes, in a context of its own that
 * leaves the process default (and its fail-open accounting) untouched.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _resetUnseededWrites,
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  countUnseededWrites,
  enforceGhWriteAllowlist,
  isWriteRepoAllowlistActive,
  listAllowedWriteRepos,
  resetWriteRepoAllowlist,
  WriteRepoBlockedError,
} from "../lib/write_repo_allowlist.ts";
import {
  RUN_ALL_REPO_STEPS,
  runRepoSteps,
  SETUP_WRITE_SUBCOMMANDS,
  withSetupWriteScope,
} from "../setup/setup_cli.ts";

/** A config file listing `repos`, removed by the caller. */
async function configWith(repos: string[]): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(path, JSON.stringify({ repos }));
  return path;
}

/** Capture the security log lines; returns them and a restore. */
function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  _setWriteRepoAllowlistSinks({
    record: () => Promise.resolve({ ok: true, value: undefined as never }),
    log: (m) => logs.push(m),
  });
  return {
    logs,
    restore: () => {
      resetWriteRepoAllowlist();
      _resetUnseededWrites();
      _resetWriteRepoAllowlistSinks();
    },
  };
}

/** A `gh issue comment` against `repo`, as the chokepoint sees it. */
const comment = (repo: string) =>
  enforceGhWriteAllowlist(["issue", "comment", "1", "-R", repo, "--body", "x"]);

Deno.test("withSetupWriteScope - a setup write to a configured repo is scoped, never unseeded", async () => {
  const path = await configWith(["stSoftwareAU/GRQ", "stSoftwareAU/NEAT-AI"]);
  const { logs, restore } = captureLogs();
  try {
    await withSetupWriteScope(path, async () => {
      assert(isWriteRepoAllowlistActive());
      assert(listAllowedWriteRepos().includes("stsoftwareau/grq"));
      assert(listAllowedWriteRepos().includes("stsoftwareau/neat-ai"));
      await comment("stSoftwareAU/GRQ");
      await comment("stSoftwareAU/NEAT-AI");
    });
    assertEquals(
      logs.filter((l) => l.includes("WRITE_REPO_UNSEEDED")),
      [],
      "a seeded setup write must not be recorded as unseeded",
    );
    assertEquals(countUnseededWrites(), 0);
  } finally {
    restore();
    await Deno.remove(path);
  }
});

Deno.test("withSetupWriteScope - a write to a repo setup does not manage is refused", async () => {
  const path = await configWith(["stSoftwareAU/GRQ"]);
  const { restore } = captureLogs();
  try {
    await withSetupWriteScope(path, async () => {
      await assertRejects(
        () => comment("someone/else"),
        WriteRepoBlockedError,
      );
    });
  } finally {
    restore();
    await Deno.remove(path);
  }
});

Deno.test("withSetupWriteScope - VibeCoder, where setup files its own precheck issue, is in scope", async () => {
  const path = await configWith(["stSoftwareAU/GRQ"]);
  const { restore } = captureLogs();
  try {
    await withSetupWriteScope(path, () => {
      assert(listAllowedWriteRepos().includes("stsoftwareau/vibecoder"));
      return Promise.resolve();
    });
  } finally {
    restore();
    await Deno.remove(path);
  }
});

Deno.test("withSetupWriteScope - the process default context is left inactive afterwards", async () => {
  // The seed lives in a context of its own, so the fail-open accounting for
  // every other caller in the process is exactly what it was.
  const path = await configWith(["stSoftwareAU/GRQ"]);
  const { logs, restore } = captureLogs();
  try {
    await withSetupWriteScope(path, () => Promise.resolve());
    assertEquals(isWriteRepoAllowlistActive(), false);
    await comment("other/repo");
    assertEquals(
      logs.filter((l) => l.includes("WRITE_REPO_UNSEEDED")).length,
      1,
      "outside setup's scope an unseeded write is still marked",
    );
  } finally {
    restore();
    await Deno.remove(path);
  }
});

Deno.test("withSetupWriteScope - no configured repos means nothing to seed", async () => {
  const path = await configWith([]);
  const { restore } = captureLogs();
  try {
    const seen = await withSetupWriteScope(
      path,
      () => Promise.resolve(isWriteRepoAllowlistActive()),
    );
    assertEquals(seen, false);
  } finally {
    restore();
    await Deno.remove(path);
  }
});

Deno.test("runRepoSteps - every repo-side step of a full setup runs seeded", async () => {
  const path = await configWith(["stSoftwareAU/GRQ"]);
  const { restore } = captureLogs();
  try {
    const seen: boolean[] = [];
    await runRepoSteps(path, [
      {
        name: "a",
        run: () => Promise.resolve(seen.push(isWriteRepoAllowlistActive()) > 0),
      },
      {
        name: "b",
        run: () => Promise.resolve(seen.push(isWriteRepoAllowlistActive()) > 0),
      },
    ]);
    assertEquals(seen, [true, true]);
  } finally {
    restore();
    await Deno.remove(path);
  }
});

Deno.test("SETUP_WRITE_SUBCOMMANDS - every repo-side step run on its own is seeded too", () => {
  // setup.sh and setup.ps1 run each step as its own subcommand, so a step
  // missing from this set would write unscoped again.
  for (const step of RUN_ALL_REPO_STEPS) {
    assert(SETUP_WRITE_SUBCOMMANDS.has(step.name), step.name);
  }
  for (const name of ["label-colour-reconcile", "best-practices-relabel"]) {
    assert(SETUP_WRITE_SUBCOMMANDS.has(name), name);
  }
});
