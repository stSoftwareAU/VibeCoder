/**
 * Off-state spawn pins for the token economizer (Issue #4955, part of #4953).
 *
 * The acceptance: a disabled host's agent argv and env are unchanged, for both
 * providers. The `token_economizer` block parses (`lib/token_economizer_config.ts`)
 * and `loadConfig` accepts it, but nothing reads it yet; #4956 wires it into
 * runs. This file pins the spawn the worker builds today, so that wiring cannot
 * change a disabled host's spawn unnoticed.
 *
 * What is proved, and what is not:
 *
 * 1. Disabled hosts. The four spellings of a disabled host (no block, `{}`,
 *    `{enabled: false}`, and the full off spelling) load through the real
 *    `loadConfig` from a temp `.config.json`, each with
 *    `config.tokenEconomizer.enabled === false`. That is the positive control:
 *    these ARE disabled hosts. Each one's (argv, env) pair from the real
 *    `buildInvocation` and `buildChildEnv` of the claude and codex descriptors,
 *    over several representative requests, is deep-equal to the no-block
 *    baseline.
 *
 *    HONEST SCOPE: the builders take no config today, so this equality pins the
 *    OFF STATE by construction. Nothing on the spawn path reads the block, so
 *    the equality cannot tell an enabled host from a disabled one. #4956 MUST
 *    keep this test and add an `enabled: true` case whose argv or env differs.
 *    The baseline is built by the same builders, so an UNCONDITIONAL change to
 *    a builder moves both sides and this equality stays green. Only the trace
 *    scan in (2) catches a planted trace; a non-trace change to today's spawn
 *    is not caught until a literal snapshot of it is pinned.
 *
 * 2. No plugin trace. No argv element or env key/value carries a token
 *    economizer name (`/token[-_ ]?economizer/i`), a `--plugin-dir` argument,
 *    or an env key starting `TE_`. A positive control proves the detector flags
 *    each of the three trace kinds separately and together, so a clean scan
 *    cannot come from a detector that matches nothing.
 *
 * 3. No plugin file. The builders take no HOME, cwd or plugin-directory
 *    parameter, and none writes a file today. The test hands them a fresh temp
 *    root holding a temp HOME, a temp WORK_DIR and an MCP config file, and
 *    asserts that the tree under the root is unchanged afterwards. That catches
 *    a builder that starts writing under the directories it is handed. It does
 *    NOT prove that a plugin file is absent from wherever #4956 would write one:
 *    there is no seam for that until #4956, and none is faked here.
 *
 * Every test calls the real functions with real data. Temp directories come
 * from `Deno.makeTempDir`. No wall-clock thresholds, no network.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import {
  type AgentInvocationRequest,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  IMAGE_AGENT_PROVIDERS_ENV,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { envFrom } from "./support/env_lookup.ts";
import type { ConfigFile, WorkerConfig } from "../types.ts";

/** The two providers this pin covers, in the order the tests report them. */
const PROVIDER_IDS: readonly string[] = [CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID];

/**
 * The four spellings of a disabled host. `undefined` means the key is absent,
 * which is the no-block baseline itself.
 */
const DISABLED_HOSTS: readonly {
  readonly label: string;
  readonly block: unknown;
}[] = [
  { label: "no block", block: undefined },
  { label: "empty block", block: {} },
  { label: "enabled false", block: { enabled: false } },
  {
    label: "enabled false with the full off spelling",
    block: {
      enabled: false,
      learnings_repo: "owner/repo",
      microskills: "off",
      loopguard: "off",
    },
  },
];

/** The PreToolUse hook settings a run carries, as `settingsJson` takes them. */
const SETTINGS_JSON = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "rtk hook claude" }],
      },
    ],
  },
});

/** The kinds of plugin trace the detector recognises. */
type TraceKind = "plugin-dir" | "te-env-key" | "token-economizer-name";

/** `/token[-_ ]?economizer/i`, matched against any argv element or env text. */
const TOKEN_ECONOMIZER_NAME = /token[-_ ]?economizer/i;

/**
 * Report which kinds of plugin trace an invocation carries.
 *
 * @param argv - The argument list a builder produced.
 * @param env - The child environment a builder produced.
 * @returns The trace kinds found, sorted; empty when there are none.
 */
function traceKinds(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): TraceKind[] {
  const kinds = new Set<TraceKind>();
  for (const element of argv) {
    if (TOKEN_ECONOMIZER_NAME.test(element)) kinds.add("token-economizer-name");
    if (element.includes("--plugin-dir")) kinds.add("plugin-dir");
  }
  for (const [key, value] of Object.entries(env)) {
    if (TOKEN_ECONOMIZER_NAME.test(key) || TOKEN_ECONOMIZER_NAME.test(value)) {
      kinds.add("token-economizer-name");
    }
    if (key.startsWith("TE_")) kinds.add("te-env-key");
  }
  return [...kinds].sort();
}

/** One temp fixture: a root holding a HOME, a WORK_DIR and an MCP config. */
interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly work: string;
  readonly mcpConfigPath: string;
  /** The parent environment every builder inherits from. No TE_ or plugin names. */
  readonly parentEnv: Record<string, string>;
}

/**
 * Run `fn` on a fresh temp fixture, removing the root afterwards.
 *
 * @param fn - The test body.
 */
async function withFixture(
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "te-off-spawn-" });
  try {
    const home = `${root}/home`;
    const work = `${root}/work`;
    await Deno.mkdir(home);
    await Deno.mkdir(work);
    const mcpConfigPath = `${root}/mcp.json`;
    await Deno.writeTextFile(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          playwright: {
            command: "deno",
            args: ["run", "-A", "npm:@playwright/mcp@0.0.1"],
            env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" },
          },
        },
      }),
    );
    await fn({
      root,
      home,
      work,
      mcpConfigPath,
      parentEnv: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        WORK_DIR: work,
        LANG: "C.UTF-8",
        GH_TOKEN: "fixture-gh-installation-token",
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/**
 * Load a host config through the real `loadConfig` from a temp `.config.json`.
 *
 * @param block - The `token_economizer` value, or `undefined` for no key.
 * @returns The loaded worker config.
 */
async function loadHost(block: unknown): Promise<WorkerConfig> {
  const dir = await Deno.makeTempDir({ prefix: "te-off-config-" });
  try {
    const raw: ConfigFile = {
      allowed_authors: ["testuser"],
      repos: ["org/repo1"],
      ...(block === undefined ? {} : { token_economizer: block }),
    };
    const configPath = `${dir}/.config.json`;
    await Deno.writeTextFile(configPath, JSON.stringify(raw));
    return await loadConfig(configPath, {
      env: envFrom({ [IMAGE_AGENT_PROVIDERS_ENV]: "claude,codex" }),
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** One representative request, named so a failure says which one it was. */
interface NamedRequest {
  readonly name: string;
  readonly request: AgentInvocationRequest;
}

/**
 * The requests a provider is exercised with: every shape it supports.
 *
 * Every request carries the fixture environment as its lookup, so phase routing
 * and turn limits read the fixture and never the process environment.
 *
 * @param providerId - The provider the requests are built for.
 * @param fixture - The temp fixture supplying the MCP config path and env.
 * @returns The named requests.
 */
function requestsFor(providerId: string, fixture: Fixture): NamedRequest[] {
  const env = envFrom(fixture.parentEnv);
  const prompt = "Summarise the open issue.";
  const requests: NamedRequest[] = [
    { name: "plain prompt", request: { prompt, env } },
    {
      name: "system prompt, model, effort and disallowed tools",
      request: {
        prompt,
        env,
        systemPrompt: "Static policy text.",
        model: "fixture-model",
        effort: "high",
        disallowedTools: ["WebFetch", "WebSearch"],
      },
    },
    {
      name: "MCP config path",
      request: { prompt, env, mcpConfigPath: fixture.mcpConfigPath },
    },
    {
      name: "settings JSON",
      request: { prompt, env, settingsJson: SETTINGS_JSON },
    },
    {
      name: "prompt via stdin",
      request: { prompt, env, promptViaStdin: true },
    },
  ];
  // Only the Claude CLI takes `isolateClaudeConfig` (agent_provider.ts).
  if (providerId === CLAUDE_PROVIDER_ID) {
    requests.push({
      name: "isolated Claude config",
      request: { prompt, env, isolateClaudeConfig: true },
    });
  }
  return requests;
}

/** One spawn: the request it answers, its argv and its child environment. */
interface SpawnRecord {
  readonly request: string;
  readonly argv: string[];
  readonly env: Record<string, string>;
}

/**
 * Build every spawn for one provider through its real descriptor.
 *
 * `buildInvocation` and `buildChildEnv` are called on the descriptor from
 * `resolveAgentProvider`, the same path a run takes.
 *
 * @param providerId - The provider to build spawns for.
 * @param fixture - The temp fixture.
 * @returns One spawn record per requested shape.
 */
function spawnsFor(providerId: string, fixture: Fixture): SpawnRecord[] {
  const provider = resolveAgentProvider(providerId);
  return requestsFor(providerId, fixture).map(({ name, request }) => ({
    request: name,
    argv: provider.buildInvocation(request),
    env: provider.buildChildEnv(fixture.parentEnv),
  }));
}

/**
 * Every path under `dir`, relative to it, sorted.
 *
 * @param dir - The directory to list.
 * @param prefix - The relative prefix for entries found under `dir`.
 * @returns Relative paths; a directory's entries end with its own name.
 */
async function treeOf(dir: string, prefix = ""): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const relative = `${prefix}${entry.name}`;
    paths.push(relative);
    if (entry.isDirectory) {
      paths.push(...await treeOf(`${dir}/${entry.name}`, `${relative}/`));
    }
  }
  return paths.sort();
}

// ---------------------------------------------------------------------------
// Positive control: the detector flags each trace kind on its own
// ---------------------------------------------------------------------------

Deno.test("token_economizer off - the trace detector flags each plugin trace separately and together", () => {
  assertEquals(
    traceKinds(
      ["--plugin-dir", "/opt/tokeneconomizer/plugin"],
      { TE_TOOLPRUNE: "off" },
    ),
    ["plugin-dir", "te-env-key", "token-economizer-name"],
    "the combined synthetic spawn carries all three trace kinds",
  );
  assertEquals(
    traceKinds(["--plugin-dir", "/opt/plugins/other"], {}),
    ["plugin-dir"],
    "a --plugin-dir argument alone is flagged as plugin-dir",
  );
  assertEquals(
    traceKinds(["--add-dir", "/opt/token_economizer"], {}),
    ["token-economizer-name"],
    "a token economizer name in argv alone is flagged by name",
  );
  assertEquals(
    traceKinds([], { PATH: "/opt/Token Economizer/bin" }),
    ["token-economizer-name"],
    "a token economizer name in an env value alone is flagged by name",
  );
  assertEquals(
    traceKinds([], { TOKEN_ECONOMIZER_ON: "1" }),
    ["token-economizer-name"],
    "a token economizer name in an env key alone is flagged by name",
  );
  assertEquals(
    traceKinds([], { TE_LOOPGUARD: "off" }),
    ["te-env-key"],
    "an env key starting TE_ alone is flagged as te-env-key",
  );
  assertEquals(
    traceKinds(["-p", "hello"], { PATH: "/usr/bin", HOME: "/home/x" }),
    [],
    "an ordinary spawn carries no trace",
  );
});

// ---------------------------------------------------------------------------
// 1. Disabled hosts load as disabled and spawn the no-block argv and env
// ---------------------------------------------------------------------------

for (const providerId of PROVIDER_IDS) {
  for (const host of DISABLED_HOSTS) {
    Deno.test(`token_economizer off - ${providerId} - ${host.label}: loads as disabled and spawns the no-block argv and env`, async () => {
      await withFixture(async (fixture) => {
        const baselineConfig = await loadHost(undefined);
        assertEquals(
          baselineConfig.tokenEconomizer.enabled,
          false,
          "the no-block baseline loads as disabled by default",
        );
        const baseline = spawnsFor(providerId, fixture);

        const config = await loadHost(host.block);
        assertEquals(
          config.tokenEconomizer.enabled,
          false,
          `"${host.label}" loads as a disabled host (positive control)`,
        );
        assertEquals(spawnsFor(providerId, fixture), baseline);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// 2. No plugin trace in any argv element or env key/value
// ---------------------------------------------------------------------------

for (const providerId of PROVIDER_IDS) {
  Deno.test(`token_economizer off - ${providerId}: no argv element or env entry carries a plugin trace`, async () => {
    await withFixture(async (fixture) => {
      for (const spawn of spawnsFor(providerId, fixture)) {
        assertEquals(
          { request: spawn.request, traces: traceKinds(spawn.argv, spawn.env) },
          { request: spawn.request, traces: [] },
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 3. No plugin file: the builders leave the temp HOME, WORK_DIR and root alone
// ---------------------------------------------------------------------------

for (const providerId of PROVIDER_IDS) {
  Deno.test(`token_economizer off - ${providerId}: the builders write nothing under the temp HOME, WORK_DIR or root`, async () => {
    await withFixture(async (fixture) => {
      const before = await treeOf(fixture.root);
      spawnsFor(providerId, fixture);
      assertEquals(await treeOf(fixture.root), before);
      assertEquals(await treeOf(fixture.home), []);
      assertEquals(await treeOf(fixture.work), []);
    });
  });
}
