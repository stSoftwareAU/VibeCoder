/**
 * Behaviour of the shared no-host git config helper (Issue #5254, Issue #5309).
 *
 * Real git against a temporary bare remote. A hostile pre-push hook is wired
 * in through the three routes a host can use (an injected environment entry, a
 * global config file, and a system config file). Each hostile route must block
 * a push on its own, and the helper must stop it. The hostile settings are
 * passed as child env overlays, so this test never mutates the process
 * environment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
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

    const control = await pushHead(fx, "case-e-control", {
      GIT_CONFIG_COUNT: "0",
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
      GIT_CONFIG_SYSTEM: systemConfig,
      ...NO_HOST_GIT_CONFIG,
    });
    assertEquals(overlay.code, 0, overlay.stderr);
    assertEquals(overlay.stderr.includes(HOSTILE_MARKER), false);
    assertEquals(await refExists(fx, "case-e-overlay"), true);
    assertEquals(await fileExists(hook.marker), false);
  });
});
