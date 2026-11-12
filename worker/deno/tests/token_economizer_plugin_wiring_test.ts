/**
 * Wiring of the TokenEconomizer plugin into the Claude CLI spawn (Issue #4956,
 * part of #4953).
 *
 * What is proved here, with the real functions throughout:
 *
 * a. The argv. `--plugin-dir <dir>` is emitted by the Claude descriptor only
 *    when a directory is given, beside `--setting-sources ""` when the config
 *    is isolated. The DeepSeek, Codex and Gemini descriptors emit nothing for it.
 * b. The spawn. `runClaudeWithTimeout` runs a stub agent that dumps its argv
 *    and its environment. A launch built by the real
 *    `tokenEconomizerSpawnOptions` (against temp directories and a fake plugin
 *    directory) reaches the child as `--plugin-dir` and the eight variables. A
 *    stray `TE_` or `TOKENECONOMIZER_` variable in the parent never reaches an
 *    enabled child. A disabled host, and a non-Claude provider, get neither.
 * c. The real vendored plugin. Where `/opt/tokeneconomizer/plugin` is present
 *    (the container image), its `te-hook` runs as a subprocess against a clean
 *    git checkout, and writes only to the state directory outside it.
 *
 * Prerequisite for (c): the vendored TokenEconomizer plugin at
 * {@link TOKEN_ECONOMIZER_PLUGIN_DIR}, which ships only in the container image.
 * Where it is absent the real-plugin tests are ignored, so a host without it
 * runs (a) and (b). Set `REQUIRE_TOKENECONOMIZER_PLUGIN=1` on a run that must
 * exercise (c): the always-run guard test then fails the suite, naming the
 * missing plugin, rather than reporting a green suite that tested nothing.
 *
 * Temporary directories come from `Deno.makeTempDir` and are removed afterwards.
 * Nothing is timed against the wall clock. Australian English throughout
 * (behaviour, recognised, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
  IMAGE_AGENT_PROVIDERS_ENV,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { repoCheckoutPath } from "../lib/repo_checkout_path.ts";
import {
  resolveTokenEconomizerLaunch,
  TOKEN_ECONOMIZER_PLUGIN_DIR,
  TOKEN_ECONOMIZER_RUN_KINDS,
  type TokenEconomizerLaunch,
  type TokenEconomizerRunKind,
  tokenEconomizerSpawnOptions,
} from "../lib/token_economizer_plugin.ts";
import type { TokenEconomizerConfig } from "../types.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** The repository the checkout stands for. Its last segment names the checkout. */
const REPO = "owner/checkout-repo";

/** Commit identity for the test checkout, passed per command. */
const GIT_IDENTITY = [
  "-c",
  "user.name=vibe-test",
  "-c",
  "user.email=vibe-test@example.invalid",
];

/**
 * Whether the vendored plugin is installed here. It ships only in the
 * container image at {@link TOKEN_ECONOMIZER_PLUGIN_DIR}, so a host without it
 * cannot run the real-plugin tests and they are ignored there. The stub-based
 * tests need no plugin and run everywhere.
 */
const REAL_PLUGIN_PRESENT = ((): boolean => {
  try {
    return Deno.statSync(
      join(TOKEN_ECONOMIZER_PLUGIN_DIR, "scripts", "te-hook"),
    )
      .isFile;
  } catch {
    return false;
  }
})();

/** The env var that turns a missing vendored plugin into a failure, not a skip. */
const REQUIRE_PLUGIN_ENV = "REQUIRE_TOKENECONOMIZER_PLUGIN";

/**
 * The refusal a missing prerequisite makes when {@link REQUIRE_PLUGIN_ENV} is
 * `1`, or `null` when nothing is required or the plugin is present.
 */
function missingRequiredPlugin(
  required: string | undefined,
  present: boolean,
): string | null {
  if (required !== "1" || present) return null;
  return `${REQUIRE_PLUGIN_ENV}=1 but the vendored TokenEconomizer plugin is absent at ${TOKEN_ECONOMIZER_PLUGIN_DIR} (its te-hook is missing): install the container image that ships it, or unset ${REQUIRE_PLUGIN_ENV}`;
}

Deno.test("the vendored plugin is present wherever REQUIRE_TOKENECONOMIZER_PLUGIN=1 requires it (Issue #4956)", () => {
  const problem = missingRequiredPlugin(
    Deno.env.get(REQUIRE_PLUGIN_ENV),
    REAL_PLUGIN_PRESENT,
  );
  assert(problem === null, problem ?? "");
});

Deno.test("the plugin guard refuses only a required run without the plugin (Issue #4956)", () => {
  // Positive control: a required run with the plugin present is accepted.
  assertEquals(missingRequiredPlugin("1", true), null);
  // Nothing required: the real-plugin tests may skip, with no failure.
  assertEquals(missingRequiredPlugin(undefined, false), null);
  assertEquals(missingRequiredPlugin("0", false), null);
  // Required and absent: refused, naming the variable and the directory.
  const refusal = missingRequiredPlugin("1", false) ?? "";
  assertStringIncludes(refusal, REQUIRE_PLUGIN_ENV);
  assertStringIncludes(refusal, TOKEN_ECONOMIZER_PLUGIN_DIR);
});

/** The eight variables a launch sets, with the loop-guard value under test. */
function expectedLaunchEnv(
  stateHome: string,
  loopguard: "off" | "nudge",
): Record<string, string> {
  return {
    TOKENECONOMIZER_HOME: stateHome,
    TE_TOOLPRUNE: "off",
    TE_REPOMAP: "off",
    TE_HISTORY_IMPORT: "false",
    TE_MICROSKILLS: "envfacts",
    TE_LOOPGUARD: loopguard,
    TE_MICROSKILLS_MAX_FACTS: "4",
    TE_MICROSKILLS_MAX_TOKENS: "150",
  };
}

/** Keys a launch sets, other than `TE_MICROSKILLS`, which a stray parent value can also carry. */
const LAUNCH_ONLY_KEYS = [
  "TOKENECONOMIZER_HOME",
  "TE_TOOLPRUNE",
  "TE_REPOMAP",
  "TE_HISTORY_IMPORT",
  "TE_LOOPGUARD",
  "TE_MICROSKILLS_MAX_FACTS",
  "TE_MICROSKILLS_MAX_TOKENS",
];

/** A host block that is switched on, with micro-skills and loop-guard set away from their defaults. */
function enabledBlock(loopguard: "off" | "nudge"): TokenEconomizerConfig {
  return {
    ...buildDefaultWorkerConfig().tokenEconomizer,
    enabled: true,
    microskills: "distiller",
    loopguard,
  };
}

/** The same block switched off. */
function disabledBlock(): TokenEconomizerConfig {
  return { ...buildDefaultWorkerConfig().tokenEconomizer, enabled: false };
}

/** Asserts `flag` is in `args` and `value` is the element straight after it. */
function assertAdjacent(args: string[], flag: string, value: string): void {
  const index = args.indexOf(flag);
  assert(index >= 0, `expected ${flag} in argv: ${JSON.stringify(args)}`);
  assertEquals(args[index + 1], value, `${flag} must be followed by its value`);
}

/** Runs `git` in `cwd` and returns its stdout, failing on a non-zero exit. */
async function git(cwd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-C", cwd, ...GIT_IDENTITY, ...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

/** One temp layout: a work directory, a checkout inside it, a home, and a fake plugin. */
interface Layout {
  readonly root: string;
  readonly workDir: string;
  readonly checkout: string;
  readonly home: string;
  readonly fakePluginDir: string;
}

/**
 * Builds the layout. The checkout is a real git repository with one commit,
 * placed where production places it: `repoCheckoutPath(workDir, REPO)`. The
 * fake plugin directory carries only the manifest the launch checks for.
 */
async function makeLayout(): Promise<Layout> {
  const root = await Deno.makeTempDir({ prefix: "te_wiring_" });
  const workDir = join(root, "work");
  const home = join(root, "home");
  const fakePluginDir = join(root, "plugin");
  await Deno.mkdir(workDir);
  await Deno.mkdir(home);
  await Deno.mkdir(join(fakePluginDir, ".claude-plugin"), { recursive: true });
  await Deno.writeTextFile(
    join(fakePluginDir, ".claude-plugin", "plugin.json"),
    '{"name": "tokeneconomizer"}\n',
  );
  const checkout = repoCheckoutPath(workDir, REPO);
  await Deno.mkdir(checkout);
  await git(checkout, ["init", "-q"]);
  await git(checkout, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return { root, workDir, checkout, home, fakePluginDir };
}

/** The stub's body: it dumps its argv and environment beside itself, then answers with a result line. */
const DUMP_STUB = [
  'DIR="${0%/*}"',
  'printf \'%s\\n\' "$@" > "$DIR/argv.txt"',
  '/usr/bin/env > "$DIR/env.txt"',
  'printf \'{"type":"result","result":"ok"}\\n\'',
  "exit 0",
].join("\n");

/** What the stub recorded about one spawn. */
interface SpawnDump {
  readonly argv: string[];
  readonly env: Map<string, string>;
}

/** Reads the stub's recorded argv and environment from its directory. */
async function readDump(dir: string): Promise<SpawnDump> {
  const argvText = await Deno.readTextFile(join(dir, "argv.txt"));
  const argv = argvText.split("\n");
  if (argv[argv.length - 1] === "") argv.pop();
  const env = new Map<string, string>();
  const envText = await Deno.readTextFile(join(dir, "env.txt"));
  for (const line of envText.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return { argv, env };
}

/** The parent environment a run starts from: the process PATH, a temp HOME, and a stray TE_ value. */
function parentEnvFor(layout: Layout): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: layout.home,
    // A stray value the worker's own environment might carry. An enabled launch
    // removes it; a disabled run keeps it, and nothing loads to read it (see the
    // inert-when-off test below).
    TE_MICROSKILLS: "distiller",
  };
}

/**
 * Runs one Claude-provider spawn against the dump stub and returns what the
 * stub recorded. `extra` carries the provider and the launch option under test,
 * and `parentEnv` adds parent variables to the default run environment.
 */
async function spawnWithStub(
  layout: Layout,
  extra: {
    agentProvider?: string;
    tokenEconomizer?: TokenEconomizerLaunch;
    env?: (key: string) => string | undefined;
    parentEnv?: Record<string, string>;
  },
): Promise<SpawnDump> {
  const { parentEnv, ...rest } = extra;
  return await withAgentStub(DUMP_STUB, async (stub) => {
    await runClaudeWithTimeout({
      clock: fakeClock(),
      prompt: "wiring test",
      timeoutSeconds: 30,
      killAfterSeconds: 2,
      agentBinaryPath: stub.path,
      cwd: layout.checkout,
      repo: REPO,
      parentEnv: { ...parentEnvFor(layout), ...parentEnv },
      ...rest,
    });
    return await readDump(stub.dir);
  });
}

/** Builds the launch the way production does, for one run kind, from the layout. */
async function enabledSpawnOptions(
  layout: Layout,
  runKind: TokenEconomizerRunKind,
  loopguard: "off" | "nudge" = "off",
): Promise<{ tokenEconomizer?: TokenEconomizerLaunch }> {
  return await tokenEconomizerSpawnOptions({
    config: enabledBlock(loopguard),
    workDir: layout.workDir,
    repo: REPO,
    runKind,
    runId: `wiring-${runKind}`,
    pluginDir: layout.fakePluginDir,
  });
}

// ---------------------------------------------------------------------------
// a. The argv, through the provider descriptors' buildInvocation.
// ---------------------------------------------------------------------------

Deno.test("claude argv carries --plugin-dir and its directory as adjacent elements", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const args = claude.buildInvocation({
    prompt: "P",
    pluginDir: "/opt/tokeneconomizer/plugin",
  });
  assertAdjacent(args, "--plugin-dir", "/opt/tokeneconomizer/plugin");
});

Deno.test("claude argv has no --plugin-dir when no directory is given, and is unchanged", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const without = claude.buildInvocation({ prompt: "P" });
  assert(!without.includes("--plugin-dir"), JSON.stringify(without));
  assertEquals(
    claude.buildInvocation({ prompt: "P", pluginDir: undefined }),
    without,
  );
});

Deno.test('claude argv with isolateClaudeConfig keeps --setting-sources "" and adds --plugin-dir', () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const args = claude.buildInvocation({
    prompt: "P",
    isolateClaudeConfig: true,
    pluginDir: "/opt/tokeneconomizer/plugin",
  });
  assertAdjacent(args, "--setting-sources", "");
  assert(args.includes("--strict-mcp-config"), JSON.stringify(args));
  assertAdjacent(args, "--plugin-dir", "/opt/tokeneconomizer/plugin");
});

Deno.test("deepseek argv strips --plugin-dir, so the argv is the one it built before", () => {
  const deepseek = resolveAgentProvider(DEEPSEEK_PROVIDER_ID);
  const withDir = deepseek.buildInvocation({
    prompt: "P",
    pluginDir: "/opt/tokeneconomizer/plugin",
  });
  assert(!withDir.includes("--plugin-dir"), JSON.stringify(withDir));
  assert(
    !withDir.includes("/opt/tokeneconomizer/plugin"),
    JSON.stringify(withDir),
  );
  assertEquals(
    withDir,
    deepseek.buildInvocation({ prompt: "P" }),
  );
});

Deno.test("codex and gemini argv never carry --plugin-dir", () => {
  for (const id of [CODEX_PROVIDER_ID, GEMINI_PROVIDER_ID]) {
    const args = resolveAgentProvider(id).buildInvocation({
      prompt: "P",
      pluginDir: "/opt/tokeneconomizer/plugin",
    });
    assert(!args.includes("--plugin-dir"), `${id}: ${JSON.stringify(args)}`);
    assert(
      !args.includes("/opt/tokeneconomizer/plugin"),
      `${id}: ${JSON.stringify(args)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// b. The spawn, through runClaudeWithTimeout and a stub agent that dumps.
// ---------------------------------------------------------------------------

for (const runKind of TOKEN_ECONOMIZER_RUN_KINDS) {
  Deno.test({
    name:
      `an enabled ${runKind} run reaches the Claude child with --plugin-dir and the eight variables (Issue #4956)`,
    permissions: { run: true, read: true, write: true, env: true },
    ignore: Deno.build.os === "windows",
    async fn() {
      const layout = await makeLayout();
      try {
        const options = await enabledSpawnOptions(layout, runKind, "nudge");
        assert(options.tokenEconomizer, "the launch must resolve");
        const stateHome = await Deno.realPath(
          join(
            layout.workDir,
            ".token-economizer",
            "runs",
            `wiring-${runKind}`,
          ),
        );
        const dump = await spawnWithStub(layout, options);

        assertAdjacent(
          dump.argv,
          "--plugin-dir",
          options.tokenEconomizer.pluginDir,
        );
        const expected = expectedLaunchEnv(stateHome, "nudge");
        for (const [key, value] of Object.entries(expected)) {
          assertEquals(dump.env.get(key), value, `child env ${key}`);
        }
        // The state home lies under the work directory and outside the checkout.
        const realCheckout = await Deno.realPath(layout.checkout);
        assert(
          stateHome.startsWith(`${await Deno.realPath(layout.workDir)}/`),
          stateHome,
        );
        assert(!stateHome.startsWith(`${realCheckout}/`), stateHome);
        assert((await Deno.stat(stateHome)).isDirectory, stateHome);
      } finally {
        await Deno.remove(layout.root, { recursive: true }).catch(() => {});
      }
    },
  });
}

Deno.test({
  name:
    "a disabled host spawns the Claude child with neither --plugin-dir nor a launch variable (Issue #4956)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const layout = await makeLayout();
    try {
      const options = await tokenEconomizerSpawnOptions({
        config: disabledBlock(),
        workDir: layout.workDir,
        repo: REPO,
        runKind: "implementation",
        runId: "wiring-disabled",
        pluginDir: layout.fakePluginDir,
      });
      assertEquals(options, {});
      const dump = await spawnWithStub(layout, options);

      assert(!dump.argv.includes("--plugin-dir"), JSON.stringify(dump.argv));
      for (const key of LAUNCH_ONLY_KEYS) {
        assertEquals(dump.env.get(key), undefined, `child env ${key}`);
      }
      assert(
        !(await Deno.stat(join(layout.workDir, ".token-economizer")).then(
          () => true,
          () => false,
        )),
        "a disabled host must not create the state directory",
      );
    } finally {
      await Deno.remove(layout.root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "a stray TE_MICROSKILLS in the worker's environment reaches a disabled child unchanged, inert because nothing loads the plugin (Issue #4956)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // This pins what the runner passes through when the plugin is off. The
    // runner's env sanitiser (`lib/agent_env.ts`, `buildAgentChildEnv`) copies
    // every key that is not denylisted, so the stray value reaches the child.
    // The overlay that removes `TE_` keys runs only for an enabled launch, and
    // with the plugin off no plugin is loaded, so nothing reads the value: it
    // is inert. This test pins that, so a change to the pass-through is noticed.
    const layout = await makeLayout();
    try {
      const dump = await spawnWithStub(layout, {});
      assertEquals(dump.env.get("TE_MICROSKILLS"), "distiller");
    } finally {
      await Deno.remove(layout.root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "an enabled Claude run drops stray TE_ and TOKENECONOMIZER_ parent variables, and the child gets only the launch's eight (Issue #4956)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const layout = await makeLayout();
    try {
      const options = await enabledSpawnOptions(
        layout,
        "implementation",
        "nudge",
      );
      assert(options.tokenEconomizer, "the launch must resolve");
      const stateHome = await Deno.realPath(
        join(
          layout.workDir,
          ".token-economizer",
          "runs",
          "wiring-implementation",
        ),
      );
      // Strays a worker environment might carry. None of them is a launch key:
      // TE_LOOPGUARD_NUDGES is not TE_LOOPGUARD, so it is not overwritten, only
      // removed.
      const dump = await spawnWithStub(layout, {
        ...options,
        parentEnv: {
          TE_LOOPGUARD_NUDGES: "off",
          TE_DISABLE: "1",
          TOKENECONOMIZER_X: "stray",
        },
      });

      assertAdjacent(
        dump.argv,
        "--plugin-dir",
        options.tokenEconomizer.pluginDir,
      );
      for (
        const key of ["TE_LOOPGUARD_NUDGES", "TE_DISABLE", "TOKENECONOMIZER_X"]
      ) {
        assertEquals(dump.env.get(key), undefined, `stray child env ${key}`);
      }
      const expected = expectedLaunchEnv(stateHome, "nudge");
      for (const [key, value] of Object.entries(expected)) {
        assertEquals(dump.env.get(key), value, `child env ${key}`);
      }
    } finally {
      await Deno.remove(layout.root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "a non-Claude provider with the launch set gets neither --plugin-dir nor the launch variables (Issue #4956)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const layout = await makeLayout();
    try {
      const options = await enabledSpawnOptions(layout, "implementation");
      assert(options.tokenEconomizer, "the launch must resolve");
      // Codex is the fallback a Claude run can switch to; its argv and env
      // builder are its own, so the launch must not reach it. The stub's
      // result line may not parse as Codex output, so only the dump is read.
      // The image stamp must name codex, or the runner refuses the provider
      // before spawn. The per-call lookup names it and reads everything else
      // from the process, so no process-wide state is touched.
      const codexImage = (key: string): string | undefined =>
        key === IMAGE_AGENT_PROVIDERS_ENV
          ? `${CLAUDE_PROVIDER_ID},${CODEX_PROVIDER_ID}`
          : Deno.env.get(key);
      await spawnWithStub(layout, {
        agentProvider: CODEX_PROVIDER_ID,
        tokenEconomizer: options.tokenEconomizer,
        env: codexImage,
      }).then((dump) => {
        assert(!dump.argv.includes("--plugin-dir"), JSON.stringify(dump.argv));
        for (const key of LAUNCH_ONLY_KEYS) {
          assertEquals(dump.env.get(key), undefined, `child env ${key}`);
        }
        // The overlay did not run, so the stray value is still the stray value.
        assertEquals(dump.env.get("TE_MICROSKILLS"), "distiller");
      });
    } finally {
      await Deno.remove(layout.root, { recursive: true }).catch(() => {});
    }
  },
});

// ---------------------------------------------------------------------------
// c. The real vendored plugin, run as a subprocess (container image only).
// ---------------------------------------------------------------------------

/** Runs `te-hook` with one event on stdin, from `cwd`, with `env` and no inherited environment. */
async function runHook(
  hook: string,
  cwd: string,
  env: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command(hook, {
    args: ["--host", "claude", "--event", String(payload.hook_event_name)],
    cwd,
    env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
  await writer.close();
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** `git status --porcelain` for the checkout: empty when it is clean. */
async function gitStatus(checkout: string): Promise<string> {
  return (await git(checkout, ["status", "--porcelain"])).trim();
}

/** The number of regular files under `dir`, recursively. */
async function countFiles(dir: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) count += await countFiles(path);
    else if (entry.isFile) count += 1;
  }
  return count;
}

/** The three hook events the test replays, in the order a session sends them. */
function sessionEvents(checkout: string): Record<string, unknown>[] {
  return [
    {
      hook_event_name: "SessionStart",
      session_id: "s1",
      cwd: checkout,
      source: "startup",
    },
    { hook_event_name: "Stop", session_id: "s1", cwd: checkout },
    { hook_event_name: "SessionEnd", session_id: "s1", cwd: checkout },
  ];
}

Deno.test({
  name:
    "the real vendored te-hook leaves a clean checkout clean and writes only to the state directory (Issue #4956)",
  permissions: { run: true, read: true, write: true, env: true },
  // The plugin ships only in the container image; see REAL_PLUGIN_PRESENT.
  ignore: Deno.build.os === "windows" || !REAL_PLUGIN_PRESENT,
  async fn() {
    const layout = await makeLayout();
    try {
      const launch = await resolveTokenEconomizerLaunch({
        config: enabledBlock("off"),
        workDir: layout.workDir,
        repo: REPO,
        runKind: "implementation",
        runId: "wiring-real-clean",
      });
      assert(launch !== null, "the real plugin's launch must resolve");
      const hook = join(launch.pluginDir, "scripts", "te-hook");
      const env = {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: layout.home,
        ...launch.env,
      };

      assertEquals(await gitStatus(layout.checkout), "");
      for (const payload of sessionEvents(layout.checkout)) {
        const out = await runHook(hook, layout.checkout, env, payload);
        assertEquals(out.code, 0, `${payload.hook_event_name}: ${out.stderr}`);
        const parsed: unknown = JSON.parse(out.stdout);
        assert(
          typeof parsed === "object" && parsed !== null,
          `${payload.hook_event_name} must print one JSON object: ${out.stdout}`,
        );
      }
      assertEquals(await gitStatus(layout.checkout), "");
      // Positive control: the plugin ran and wrote outside the checkout.
      const stateHome = launch.env.TOKENECONOMIZER_HOME;
      assert(stateHome !== undefined, "the launch names a state directory");
      assert(
        (await countFiles(stateHome)) > 0,
        "the state directory must hold the plugin's files",
      );
    } finally {
      await Deno.remove(layout.root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "the real vendored te-hook fails open to {} when no Python is on PATH (Issue #4956)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows" || !REAL_PLUGIN_PRESENT,
  async fn() {
    const layout = await makeLayout();
    try {
      const launch = await resolveTokenEconomizerLaunch({
        config: enabledBlock("off"),
        workDir: layout.workDir,
        repo: REPO,
        runKind: "implementation",
        runId: "wiring-real-nopy",
      });
      assert(launch !== null, "the real plugin's launch must resolve");
      const emptyPath = join(layout.root, "no-python");
      await Deno.mkdir(emptyPath);
      const hook = join(launch.pluginDir, "scripts", "te-hook");
      const env = { PATH: emptyPath, HOME: layout.home, ...launch.env };

      const start = sessionEvents(layout.checkout)[0];
      assert(start !== undefined, "a SessionStart event");
      const out = await runHook(hook, layout.checkout, env, start);
      assertEquals(out.code, 0, out.stderr);
      assertEquals(out.stdout.trim(), "{}");
      assertStringIncludes(out.stdout, "{}");
      assertEquals(await gitStatus(layout.checkout), "");
    } finally {
      await Deno.remove(layout.root, { recursive: true }).catch(() => {});
    }
  },
});
