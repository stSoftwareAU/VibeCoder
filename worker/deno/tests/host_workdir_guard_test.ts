/**
 * Regression guard: host-side entry points must not create
 * `~/auto-issue-work` (Issue #135, parent #118).
 *
 * #118's requirement is behavioural: no host-side VibeCoder process may
 * create `~/auto-issue-work` or `~/auto-issue-work-approval-state` on the
 * host. Issues #131/#132/#133 removed the `$HOME`-derived cache fallback that
 * did exactly that. These tests keep the class fixed two ways:
 *
 * 1. Behaviourally — each host-side entry point runs as a real subprocess
 *    with HOME pointed at a throwaway temp directory and WORK_DIR unset
 *    (`clearEnv`), and the test asserts the work directories were NOT
 *    created. No state lands outside the temp HOME and nothing depends on
 *    the developer's real home directory.
 * 2. Statically — the whole `worker/deno` source tree (tests excluded) is
 *    scanned for work-dir path constructions outside the commented allowlist
 *    in `lib/home_workdir_check.ts`. Reverting Issue #131 (restoring the
 *    HOME fallback in `worker_cache_dir.ts`) turns this test red, because
 *    the restored line builds a work-dir path from HOME/USERPROFILE in a
 *    file the allowlist does not name.
 *
 * DELIBERATE GAP: the GitHub-mutating setup steps (`label-sync`,
 * `workflow-sync`, `best-practices-sync`, `branch-protection-sync`,
 * `backfill-idle-task-labels`) are NOT invoked here — they write to real
 * repositories, and this suite must run offline. Their shared cache path is
 * covered at the unit level by Issues #132 (default_branch_cache) and #133
 * (baseline_quality_cache), whose tests assert the caches are a no-op
 * without WORK_DIR.
 *
 * Everything runs offline: no GitHub API call is made, and the spawned Deno
 * processes reuse the parent's warm module cache via an explicit DENO_DIR
 * (with clearEnv the child would otherwise derive its cache from the temp
 * HOME and try the network).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { scanDirectoriesForHomeWorkDir } from "../lib/home_workdir_check.ts";

/** worker/deno/, resolved from this test file. */
const DENO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
/** The repository root. */
const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** Deno's module cache, so the children's runs stay offline. */
async function resolveDenoDir(): Promise<string> {
  const configured = Deno.env.get("DENO_DIR");
  if (configured) return configured;
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const info = JSON.parse(new TextDecoder().decode(output.stdout));
  return info.denoDir as string;
}

const DENO_DIR = await resolveDenoDir();

interface EntryPointRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a Deno entry point as a real subprocess with a hermetic environment:
 * HOME pointed at the given temp directory, WORK_DIR (and everything else)
 * absent via `clearEnv`. PATH is inherited so git and other tools resolve;
 * DENO_DIR is the parent's warm cache so the run needs no network.
 */
async function runEntryPoint(
  scriptArgs: string[],
  options: { home: string; cwd: string },
): Promise<EntryPointRun> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", ...scriptArgs],
    cwd: options.cwd,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: options.home,
      DENO_DIR,
      NO_COLOR: "true",
      CI: "true",
    },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** Assert the entry point left no work-dir residue under the temp HOME. */
async function assertNoStrayWorkDir(
  home: string,
  label: string,
): Promise<void> {
  for (
    const dir of [
      `${home}/auto-issue-work`,
      `${home}/auto-issue-work-approval-state`,
    ]
  ) {
    let exists = false;
    try {
      await Deno.stat(dir);
      exists = true;
    } catch {
      // Absent — exactly what the guard requires.
    }
    assertEquals(exists, false, `${label} created ${dir}`);
  }
}

/** A throwaway HOME plus a separate cwd, torn down after the test body. */
async function withTempHome(
  body: (home: string, cwd: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "host_workdir_guard_" });
  const home = `${root}/home`;
  const cwd = `${root}/cwd`;
  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir(cwd, { recursive: true });
  try {
    await body(home, cwd);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// setup_cli.ts entry points (setup steps that run locally, no GitHub
// mutation — see the module comment for the deliberately uncovered ones)
// ---------------------------------------------------------------------------

Deno.test("host workdir guard - setup_cli --help creates no work dir", async () => {
  await withTempHome(async (home, cwd) => {
    const run = await runEntryPoint(
      [`${DENO_ROOT}/setup/setup_cli.ts`, "--help"],
      { home, cwd },
    );
    assertEquals(run.code, 0, `--help failed:\n${run.stdout}\n${run.stderr}`);
    await assertNoStrayWorkDir(home, "setup_cli --help");
  });
});

Deno.test("host workdir guard - setup_cli hooks creates no work dir", async () => {
  await withTempHome(async (home, cwd) => {
    // A plain --script-dir (no .git) exercises the subcommand end to end;
    // the hook installer reports "not a git repository" and succeeds.
    const run = await runEntryPoint(
      [
        `${DENO_ROOT}/setup/setup_cli.ts`,
        "hooks",
        "--script-dir",
        cwd,
        "--config-path",
        `${cwd}/.config.json`,
      ],
      { home, cwd },
    );
    assertEquals(run.code, 0, `hooks failed:\n${run.stdout}\n${run.stderr}`);
    await assertNoStrayWorkDir(home, "setup_cli hooks");
  });
});

// ---------------------------------------------------------------------------
// mod.ts entry points
// ---------------------------------------------------------------------------

Deno.test("host workdir guard - mod.ts run-mode creates no work dir", async () => {
  await withTempHome(async (home, cwd) => {
    // setup.sh invokes this on every setup run. No config file in cwd, so
    // the hardwired default mode is printed.
    const run = await runEntryPoint([`${DENO_ROOT}/mod.ts`, "run-mode"], {
      home,
      cwd,
    });
    assertEquals(
      run.code,
      0,
      `run-mode failed:\n${run.stdout}\n${run.stderr}`,
    );
    assertStringIncludes(run.stdout, "container");
    await assertNoStrayWorkDir(home, "mod.ts run-mode");
  });
});

Deno.test("host workdir guard - mod.ts disk-space without WORK_DIR creates no work dir", async () => {
  await withTempHome(async (home, cwd) => {
    // Before Issue #135 this entry point resolved its work dir to
    // `${HOME}/auto-issue-work` and ensureDir'd it — the exact regression
    // this guard exists to catch.
    const run = await runEntryPoint([`${DENO_ROOT}/mod.ts`, "disk-space"], {
      home,
      cwd,
    });
    assertEquals(
      run.code,
      0,
      `disk-space failed:\n${run.stdout}\n${run.stderr}`,
    );
    assertStringIncludes(run.stdout, "No directory specified");
    await assertNoStrayWorkDir(home, "mod.ts disk-space");
  });
});

Deno.test("host workdir guard - mod.ts disk-space still works with an explicit work dir", async () => {
  await withTempHome(async (home, cwd) => {
    // The in-container flow always passes an explicit work dir (or exports
    // WORK_DIR) — that path must keep working and may create the directory
    // it was TOLD to manage, just never a HOME-derived one.
    const explicit = `${cwd}/explicit-work`;
    const run = await runEntryPoint(
      [`${DENO_ROOT}/mod.ts`, "disk-space", "--work-dir", explicit],
      { home, cwd },
    );
    assertEquals(
      run.code,
      0,
      `disk-space --work-dir failed:\n${run.stdout}\n${run.stderr}`,
    );
    await assertNoStrayWorkDir(home, "mod.ts disk-space --work-dir");
  });
});

Deno.test("host workdir guard - mod.ts run-housekeeping without WORK_DIR refuses and creates no work dir", async () => {
  await withTempHome(async (home, cwd) => {
    // Before Issue #135 the housekeeping run fell back to a HOME-derived
    // work dir and its disk-space step created it. Now it refuses loudly
    // instead. A minimal valid config lets the command execute (it is not
    // config-optional); --default-branch avoids a git lookup in the
    // (non-repo) temp cwd. Nothing in this path calls gh or the network.
    await Deno.writeTextFile(
      `${cwd}/.config.json`,
      JSON.stringify({
        allowed_authors: ["test-user"],
        repos: ["example-org/example-repo"],
      }),
    );
    const run = await runEntryPoint(
      [
        `${DENO_ROOT}/mod.ts`,
        "run-housekeeping",
        "--operation",
        "run",
        "--default-branch",
        "main",
      ],
      { home, cwd },
    );
    assertEquals(run.code, 1, "run-housekeeping without WORK_DIR must fail");
    assertStringIncludes(
      run.stdout + run.stderr,
      "needs a work directory",
    );
    await assertNoStrayWorkDir(home, "mod.ts run-housekeeping");
  });
});

// ---------------------------------------------------------------------------
// Static guard over the real tree — this is the test that turns red when
// Issue #131's fix is reverted (the restored HOME fallback in
// worker_cache_dir.ts builds a work-dir path outside the allowlist).
// ---------------------------------------------------------------------------

Deno.test("host workdir guard - no source file builds a work-dir path outside the allowlist", async () => {
  const result = await scanDirectoriesForHomeWorkDir(REPO_ROOT, [
    "worker/deno",
  ]);
  assertEquals(
    result.violations,
    [],
    "work-dir path built from HOME/USERPROFILE outside the allowlist — " +
      "see lib/home_workdir_check.ts (Issue #135)",
  );
  assertEquals(result.staleAllowlist, [], "allowlist no longer matches");
  assertEquals(result.filesScanned > 100, true, "scan found the tree");
});
