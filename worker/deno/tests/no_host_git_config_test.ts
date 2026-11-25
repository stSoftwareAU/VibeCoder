/**
 * Behaviour of the shared no-host git config helper (Issue #5254, Issue #5309,
 * Issue #5385).
 *
 * Real git against a temporary bare remote. A hostile pre-push hook is wired
 * in through the three routes a host can use (an injected environment entry, a
 * global config file, and a system config file). Each hostile route must block
 * a push on its own, and the helper must stop it. The hostile settings are
 * passed as child env overlays, so this test never mutates the process
 * environment.
 *
 * The journal tests (Issue #5385) put a `WORK_DIR` in the caller env and check
 * that a fixture push writes no audit row there, while a control push with the
 * journal re-enabled does.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
} from "../lib/audit_journal.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { envFrom } from "./support/env_lookup.ts";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
  runFixtureGit,
  runShieldedGit,
} from "./support/no_host_git_config.ts";

const HOSTILE_MARKER = "HOSTILE_PRE_PUSH_HOOK_RAN";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  remote: string;
  work: string;
}

interface HostileHook {
  hooksDir: string;
  marker: string;
}

async function run(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<RunResult> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Bare remote plus a work repo with one commit; origin points at the remote. */
async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "no-host-git-config-" });
  try {
    const remote = `${root}/remote.git`;
    const work = `${root}/work`;
    const setup = await run(["init", "--bare", "-b", "main", remote], root, {
      ...NO_HOST_GIT_CONFIG,
    });
    assertEquals(setup.code, 0, setup.stderr);
    const init = await run(["init", "-b", "main", work], root, {
      ...NO_HOST_GIT_CONFIG,
    });
    assertEquals(init.code, 0, init.stderr);
    const addRemote = await run(
      ["remote", "add", "origin", remote],
      work,
      { ...NO_HOST_GIT_CONFIG },
    );
    assertEquals(addRemote.code, 0, addRemote.stderr);
    await Deno.writeTextFile(`${work}/README.md`, "seed\n");
    const add = await run(["add", "README.md"], work, {
      ...NO_HOST_GIT_CONFIG,
    });
    assertEquals(add.code, 0, add.stderr);
    const commit = await run(
      [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "commit",
        "-m",
        "seed",
      ],
      work,
      { ...NO_HOST_GIT_CONFIG },
    );
    assertEquals(commit.code, 0, commit.stderr);
    await fn({ root, remote, work });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** A pre-push hook that announces itself, leaves a marker, and refuses the push. */
async function writeHostileHook(
  root: string,
  name: string,
): Promise<HostileHook> {
  const hooksDir = `${root}/hooks-${name}`;
  const marker = `${root}/hook-ran-${name}`;
  await Deno.mkdir(hooksDir);
  const hook = `${hooksDir}/pre-push`;
  await Deno.writeTextFile(
    hook,
    `#!/bin/sh\necho ${HOSTILE_MARKER} >&2\ntouch '${marker}'\nexit 1\n`,
  );
  await Deno.chmod(hook, 0o755);
  return { hooksDir, marker };
}

/** The host's injected `core.hooksPath`, as the fleet container sets it. */
function injectedHooksPath(hooksDir: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooksDir,
  };
}

/** Push HEAD to a distinct remote branch, with optional leading git args. */
function pushHead(
  fx: Fixture,
  branch: string,
  env: Record<string, string>,
  leadingArgs: readonly string[] = [],
): Promise<RunResult> {
  return run(
    [...leadingArgs, "push", "origin", `HEAD:refs/heads/${branch}`],
    fx.work,
    env,
  );
}

async function refExists(fx: Fixture, branch: string): Promise<boolean> {
  const r = await run(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    fx.remote,
    { ...NO_HOST_GIT_CONFIG },
  );
  return r.code === 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("control: an injected hooksPath runs the hook and refuses the push", async () => {
  await withFixture(async (fx) => {
    const hook = await writeHostileHook(fx.root, "control");
    const r = await pushHead(fx, "case-a", injectedHooksPath(hook.hooksDir));
    assert(r.code !== 0, `push should be refused, got exit ${r.code}`);
    assertStringIncludes(r.stderr, HOSTILE_MARKER);
    assertEquals(await fileExists(hook.marker), true);
    assertEquals(await refExists(fx, "case-a"), false);
  });
});

Deno.test("helper: NO_HOST_GIT_CONFIG overlaid on the injected hooksPath lets the push through", async () => {
  await withFixture(async (fx) => {
    const hook = await writeHostileHook(fx.root, "overlay");
    const r = await pushHead(fx, "case-b", {
      ...injectedHooksPath(hook.hooksDir),
      ...NO_HOST_GIT_CONFIG,
    });
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.stderr.includes(HOSTILE_MARKER), false);
    assertEquals(await refExists(fx, "case-b"), true);
    assertEquals(await fileExists(hook.marker), false);
  });
});

Deno.test("helper: NO_HOST_HOOKS_ARGS alone lets the push through without the env", async () => {
  await withFixture(async (fx) => {
    const hook = await writeHostileHook(fx.root, "args");
    const r = await pushHead(
      fx,
      "case-c",
      injectedHooksPath(hook.hooksDir),
      NO_HOST_HOOKS_ARGS,
    );
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.stderr.includes(HOSTILE_MARKER), false);
    assertEquals(await refExists(fx, "case-c"), true);
    assertEquals(await fileExists(hook.marker), false);
  });
});

Deno.test("global config: a hostile GIT_CONFIG_GLOBAL runs the hook; the helper shuts it out", async () => {
  await withFixture(async (fx) => {
    const hook = await writeHostileHook(fx.root, "global");
    const globalConfig = `${fx.root}/hostile-global.gitconfig`;
    await Deno.writeTextFile(
      globalConfig,
      `[core]\n\thooksPath = ${hook.hooksDir}\n`,
    );

    // Pin GIT_CONFIG_COUNT so an inherited host injection cannot be the hook
    // that refuses the push: only the global file injects here.
    const control = await pushHead(fx, "case-d-control", {
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_GLOBAL: globalConfig,
    });
    assert(
      control.code !== 0,
      `control should be refused, got exit ${control.code}`,
    );
    assertStringIncludes(control.stderr, HOSTILE_MARKER);
    assertEquals(await fileExists(hook.marker), true);
    assertEquals(await refExists(fx, "case-d-control"), false);

    await Deno.remove(hook.marker);
    const overlay = await pushHead(fx, "case-d-overlay", {
      GIT_CONFIG_GLOBAL: globalConfig,
      ...NO_HOST_GIT_CONFIG,
    });
    assertEquals(overlay.code, 0, overlay.stderr);
    assertEquals(overlay.stderr.includes(HOSTILE_MARKER), false);
    assertEquals(await refExists(fx, "case-d-overlay"), true);
    assertEquals(await fileExists(hook.marker), false);
  });
});

Deno.test("system config: a hostile GIT_CONFIG_SYSTEM runs the hook; the helper shuts it out", async () => {
  await withFixture(async (fx) => {
    const hook = await writeHostileHook(fx.root, "system");
    const systemConfig = `${fx.root}/hostile-system.gitconfig`;
    await Deno.writeTextFile(
      systemConfig,
      `[core]\n\thooksPath = ${hook.hooksDir}\n`,
    );

    // Pin the global scope too: a host's global config outranks the system file.
    // NOSYSTEM is pinned to "0" so a host's NOSYSTEM=1 cannot hide the control.
    const control = await pushHead(fx, "case-e-control", {
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_SYSTEM: systemConfig,
    });
    assert(
      control.code !== 0,
      `control should be refused, got exit ${control.code}`,
    );
    assertStringIncludes(control.stderr, HOSTILE_MARKER);
    assertEquals(await fileExists(hook.marker), true);
    assertEquals(await refExists(fx, "case-e-control"), false);

    await Deno.remove(hook.marker);
    const overlay = await pushHead(fx, "case-e-overlay", {
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: systemConfig,
      ...NO_HOST_GIT_CONFIG,
    });
    assertEquals(overlay.code, 0, overlay.stderr);
    assertEquals(overlay.stderr.includes(HOSTILE_MARKER), false);
    assertEquals(await refExists(fx, "case-e-overlay"), true);
    assertEquals(await fileExists(hook.marker), false);
  });
});

/** Push HEAD through `runFixtureGit` with a caller env that tries to re-inject host config. */
async function pushThroughFixtureGit(
  fx: Fixture,
  branch: string,
  env: Record<string, string>,
): Promise<RunResult> {
  const r = await runFixtureGit(
    ["push", "origin", `HEAD:refs/heads/${branch}`],
    { cwd: fx.work, env },
  );
  assert(r.ok, r.ok ? "" : r.error.message);
  return r.value;
}

Deno.test("runFixtureGit: a caller env carrying the injected hooksPath cannot run the hook", async () => {
  await withFixture(async (fx) => {
    const hook = await writeHostileHook(fx.root, "fixture-env");
    const control = await pushHead(
      fx,
      "case-f-control",
      injectedHooksPath(hook.hooksDir),
    );
    assert(control.code !== 0, "control push should be refused");
    await Deno.remove(hook.marker);

    const r = await pushThroughFixtureGit(
      fx,
      "case-f",
      injectedHooksPath(hook.hooksDir),
    );
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.stderr.includes(HOSTILE_MARKER), false);
    assertEquals(await refExists(fx, "case-f"), true);
    assertEquals(await fileExists(hook.marker), false);
  });
});

Deno.test("runFixtureGit: a hostile GIT_CONFIG_GLOBAL in the caller env cannot run the hook", async () => {
  await withFixture(async (fx) => {
    const hook = await writeHostileHook(fx.root, "fixture-global");
    const globalConfig = `${fx.root}/hostile-global.gitconfig`;
    await Deno.writeTextFile(
      globalConfig,
      `[core]\n\thooksPath = ${hook.hooksDir}\n`,
    );
    const hostile = { GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: globalConfig };
    const control = await pushHead(fx, "case-g-control", hostile);
    assert(control.code !== 0, "control push should be refused");
    await Deno.remove(hook.marker);

    const r = await pushThroughFixtureGit(fx, "case-g", hostile);
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.stderr.includes(HOSTILE_MARKER), false);
    assertEquals(await refExists(fx, "case-g"), true);
    assertEquals(await fileExists(hook.marker), false);
  });
});

/** Plain git through `runGitCommand`: the control path that bypasses the shield. */
async function runPlainGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<RunResult> {
  const r = await runGitCommand(args, { cwd, env });
  assert(r.ok, r.ok ? "" : r.error.message);
  return r.value;
}

/** Read `init.defaultBranch` through `runFixtureGit` with the given caller env. */
async function readDefaultBranchThroughFixtureGit(
  fx: Fixture,
  env: Record<string, string>,
): Promise<RunResult> {
  const r = await runFixtureGit(["config", "--get", "init.defaultBranch"], {
    cwd: fx.work,
    env,
  });
  assert(r.ok, r.ok ? "" : r.error.message);
  return r.value;
}

/**
 * Env-layer case: a plain control under the caller env reads the hostile value,
 * and `runFixtureGit` under that same caller env reads nothing.
 */
async function assertEnvLayerShield(
  fx: Fixture,
  callerEnv: Record<string, string>,
  hostileValue: string,
): Promise<void> {
  // The control pins every env-controlled scope the caller leaves open, so the
  // injected entry is the only source of the value it reads.
  const control = await runPlainGit(
    ["config", "--get", "init.defaultBranch"],
    fx.work,
    { ...NO_HOST_GIT_CONFIG, ...callerEnv },
  );
  assertEquals(control.code, 0, control.stderr);
  assertEquals(control.stdout.trim(), hostileValue);

  const shielded = await readDefaultBranchThroughFixtureGit(fx, callerEnv);
  assertEquals(shielded.code, 1, shielded.stderr);
  assertEquals(shielded.stdout, "");
}

Deno.test("runFixtureGit: the env layer alone shuts out a caller's injected GIT_CONFIG_COUNT entry", async () => {
  await withFixture(async (fx) => {
    await assertEnvLayerShield(
      fx,
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "init.defaultBranch",
        GIT_CONFIG_VALUE_0: "hostile-5309-count",
      },
      "hostile-5309-count",
    );
  });
});

Deno.test("runFixtureGit: the env layer alone shuts out a caller's GIT_CONFIG_GLOBAL file", async () => {
  await withFixture(async (fx) => {
    const globalConfig = `${fx.root}/hostile-5309-global.gitconfig`;
    await Deno.writeTextFile(
      globalConfig,
      "[init]\n\tdefaultBranch = hostile-5309-global\n",
    );
    await assertEnvLayerShield(
      fx,
      { GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: globalConfig },
      "hostile-5309-global",
    );
  });
});

Deno.test("runFixtureGit: the env layer alone shuts out a caller's GIT_CONFIG_SYSTEM file", async () => {
  await withFixture(async (fx) => {
    const systemConfig = `${fx.root}/hostile-5309-system.gitconfig`;
    await Deno.writeTextFile(
      systemConfig,
      "[init]\n\tdefaultBranch = hostile-5309-system\n",
    );
    await assertEnvLayerShield(
      fx,
      {
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_CONFIG_SYSTEM: systemConfig,
      },
      "hostile-5309-system",
    );
  });
});

Deno.test("runFixtureGit: the args layer alone shuts out a repo-local core.hooksPath", async () => {
  await withFixture(async (fx) => {
    const hook = await writeHostileHook(fx.root, "args-local");
    // Repo-local config sits outside the env shield, so only `-c` can stop it.
    const set = await run(
      ["config", "core.hooksPath", hook.hooksDir],
      fx.work,
      {
        ...NO_HOST_GIT_CONFIG,
      },
    );
    assertEquals(set.code, 0, set.stderr);

    const control = await runPlainGit(
      ["push", "origin", "HEAD:refs/heads/case-x-control"],
      fx.work,
      { ...NO_HOST_GIT_CONFIG },
    );
    assert(
      control.code !== 0,
      `control should be refused, got exit ${control.code}`,
    );
    assertStringIncludes(control.stderr, HOSTILE_MARKER);
    assertEquals(await fileExists(hook.marker), true);
    assertEquals(await refExists(fx, "case-x-control"), false);

    await Deno.remove(hook.marker);
    const r = await pushThroughFixtureGit(fx, "case-x", {});
    assertEquals(r.code, 0, r.stderr);
    assertEquals(r.stderr.includes(HOSTILE_MARKER), false);
    assertEquals(await refExists(fx, "case-x"), true);
    assertEquals(await fileExists(hook.marker), false);
  });
});

// ---------------------------------------------------------------------------
// Audit journal (Issue #5385)
// ---------------------------------------------------------------------------

/**
 * Caller env as the fleet container exports it: a live WORK_DIR and run identity.
 * `VIBE_AUDIT_DISABLED: "0"` keeps the journal on from the caller's side, so a
 * host-level switch-off (which the process env would otherwise supply) cannot
 * mask a leak (Issue #5385).
 */
function callerEnvWithWorkDir(workDir: string): Record<string, string> {
  return {
    WORK_DIR: workDir,
    WORKER_UNIQUE_ID: "no-host-5385",
    VIBE_RUN_ID: "no-host-5385",
    VIBE_AUDIT_DISABLED: "0",
  };
}

/** A WORK_DIR inside the fixture root, so its `audit` journal is ours to inspect. */
async function makeWorkDir(fx: Fixture, name: string): Promise<string> {
  const dir = `${fx.root}/${name}`;
  await Deno.mkdir(dir);
  return dir;
}

/**
 * Assert no journal exists for `env`. `loadEntries` reports a missing file as
 * `Audit journal not found: <path>`, so that is the outcome checked here.
 */
async function assertNoJournal(env: Record<string, string>): Promise<void> {
  const path = auditFilePath({ env: envFrom(env) });
  assertEquals(await fileExists(path), false, `journal written at ${path}`);
  const journal = await loadEntries(path);
  assertEquals(journal.ok, false);
  if (!journal.ok) assertStringIncludes(journal.error.message, "not found");
}

/** Assert the journal for `env` holds exactly one successful `git-push` row. */
async function assertOnePushJournalled(
  env: Record<string, string>,
): Promise<void> {
  const journal = await loadEntries(auditFilePath({ env: envFrom(env) }));
  assertEquals(journal.ok, true);
  if (!journal.ok) throw journal.error;
  assertEquals(journal.value.length, 1);
  assertEquals(journal.value[0]?.verb, "git-push");
  assertEquals(journal.value[0]?.outcome, "success");
}

Deno.test("runFixtureGit: a push with WORK_DIR in the caller env writes no audit journal row (Issue #5385)", async () => {
  await withFixture(async (fx) => {
    const dir = await makeWorkDir(fx, "journal-a");
    const env = callerEnvWithWorkDir(dir);
    try {
      const r = await runFixtureGit(
        ["push", "origin", "HEAD:refs/heads/case-5385-a"],
        { cwd: fx.work, env },
      );
      assert(r.ok, r.ok ? "" : r.error.message);
      assertEquals(r.value.code, 0, r.value.stderr);
      assertEquals(await refExists(fx, "case-5385-a"), true);
      await assertNoJournal(env);
    } finally {
      _resetAuditCaches();
    }
  });
});

Deno.test("runShieldedGit: a push with WORK_DIR in the caller env writes no audit journal row (Issue #5385)", async () => {
  await withFixture(async (fx) => {
    const dir = await makeWorkDir(fx, "journal-b");
    const env = callerEnvWithWorkDir(dir);
    try {
      const r = await runShieldedGit(
        ["push", "origin", "HEAD:refs/heads/case-5385-b"],
        { cwd: fx.work, env },
      );
      assert(r.ok, r.ok ? "" : r.error.message);
      assertEquals(r.value.code, 0, r.value.stderr);
      assertEquals(await refExists(fx, "case-5385-b"), true);
      await assertNoJournal(env);
    } finally {
      _resetAuditCaches();
    }
  });
});

Deno.test("runGitCommand with the shield in env: a push with WORK_DIR in the caller env writes no audit journal row (Issue #5385)", async () => {
  await withFixture(async (fx) => {
    const dir = await makeWorkDir(fx, "journal-c");
    const env = callerEnvWithWorkDir(dir);
    try {
      const r = await runGitCommand(
        [
          ...NO_HOST_HOOKS_ARGS,
          "push",
          "origin",
          "HEAD:refs/heads/case-5385-c",
        ],
        { cwd: fx.work, env: { ...env, ...NO_HOST_GIT_CONFIG } },
      );
      assert(r.ok, r.ok ? "" : r.error.message);
      assertEquals(r.value.code, 0, r.value.stderr);
      assertEquals(await refExists(fx, "case-5385-c"), true);
      await assertNoJournal(env);
    } finally {
      _resetAuditCaches();
    }
  });
});

Deno.test("control: the audit env after the shield re-enables the journal for one push (Issue #5385)", async () => {
  await withFixture(async (fx) => {
    const dir = await makeWorkDir(fx, "journal-d");
    const env = callerEnvWithWorkDir(dir);
    const journalEnv = { ...env, VIBE_AUDIT_DISABLED: "0" };
    try {
      const r = await runGitCommand(
        [
          ...NO_HOST_HOOKS_ARGS,
          "push",
          "origin",
          "HEAD:refs/heads/case-5385-d",
        ],
        { cwd: fx.work, env: { ...NO_HOST_GIT_CONFIG, ...journalEnv } },
      );
      assert(r.ok, r.ok ? "" : r.error.message);
      assertEquals(r.value.code, 0, r.value.stderr);
      assertEquals(await refExists(fx, "case-5385-d"), true);
      await assertOnePushJournalled(env);
    } finally {
      _resetAuditCaches();
    }
  });
});
