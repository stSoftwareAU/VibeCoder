/**
 * Tests for the TokenEconomizer plugin launch decision (Issue #4956, part of
 * #4953).
 *
 * Each guard has a positive control (the same input with only the probed
 * value legal is accepted) and a refusal that asserts the cause in the logged
 * warning. Temporary directories come from `Deno.makeTempDir` and are removed
 * afterwards. Nothing is timed against the wall clock.
 *
 * Uses Australian English throughout (behaviour, recognised, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  effectiveMicroskills,
  overlayTokenEconomizerEnv,
  readTokenEconomizerStop,
  recordTokenEconomizerStop,
  resolveTokenEconomizerLaunch,
  type ResolveTokenEconomizerLaunchOptions,
  TOKEN_ECONOMIZER_ENV_KEYS,
  TOKEN_ECONOMIZER_PLUGIN_DIR,
  TOKEN_ECONOMIZER_RUN_KINDS,
  type TokenEconomizerLaunch,
  type TokenEconomizerRunKind,
  tokenEconomizerSpawnOptions,
  tokenEconomizerStatePath,
} from "../lib/token_economizer_plugin.ts";
import type {
  TokenEconomizerConfig,
  TokenEconomizerMicroskills,
} from "../types.ts";

/** A fixed clock for stop records, so `recordedAt` is predictable. */
const FIXED_NOW = new Date("2026-11-12T00:00:00.000Z");
const fixedNow = (): Date => FIXED_NOW;

/** A fixture: a temporary root with a work directory and a valid plugin directory. */
interface Fixture {
  root: string;
  work: string;
  plugin: string;
}

/** A logger that records every info and warn message. */
interface Captured {
  info: string[];
  warn: string[];
  logger: {
    info(m: string): void;
    warn(m: string): void;
  };
}

/** Run `body` against a fresh fixture, removing the temporary root afterwards. */
async function withFixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "token-economizer-plugin-" });
  try {
    const work = `${root}/work`;
    const plugin = `${root}/plugin`;
    await Deno.mkdir(work);
    await Deno.mkdir(`${plugin}/.claude-plugin`, { recursive: true });
    await Deno.writeTextFile(`${plugin}/.claude-plugin/plugin.json`, "{}\n");
    await body({ root, work, plugin });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** A logger that captures its messages. */
function captureLogger(): Captured {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    logger: {
      info: (m: string) => info.push(m),
      warn: (m: string) => warn.push(m),
    },
  };
}

/** A `token_economizer` block, enabled unless told otherwise. */
function config(
  overrides: Partial<TokenEconomizerConfig> = {},
): TokenEconomizerConfig {
  return {
    enabled: true,
    learningsRepo: "owner/learnings",
    microskills: "envfacts+distiller",
    loopguard: "nudge",
    ...overrides,
  };
}

/** Resolve options for a fixture, with a valid run kind, run id and plugin. */
function optionsFor(
  f: Fixture,
  captured: Captured,
  overrides: Partial<ResolveTokenEconomizerLaunchOptions> = {},
): ResolveTokenEconomizerLaunchOptions {
  return {
    config: config(),
    workDir: f.work,
    repo: "owner/VibeCoder",
    runKind: "implementation",
    runId: "run-1",
    pluginDir: f.plugin,
    logger: captured.logger,
    ...overrides,
  };
}

/** Assert exactly one warning was logged and it names `cause`. */
function assertSingleWarn(captured: Captured, cause: string): void {
  assertEquals(
    captured.warn.length,
    1,
    `warnings: ${captured.warn.join(" | ")}`,
  );
  assertStringIncludes(captured.warn[0] ?? "", cause);
}

/** The state directory a run is expected to get, canonicalised. */
async function expectedHome(work: string, runId: string): Promise<string> {
  return `${await Deno.realPath(work)}/.token-economizer/runs/${runId}`;
}

Deno.test("disabled block resolves to null with no log, enabled resolves to a launch", async () => {
  await withFixture(async (f) => {
    const off = captureLogger();
    const offLaunch = await resolveTokenEconomizerLaunch(
      optionsFor(f, off, { config: config({ enabled: false }) }),
    );
    assertEquals(offLaunch, null);
    assertEquals(off.warn, []);
    assertEquals(off.info, []);

    const on = captureLogger();
    const onLaunch = await resolveTokenEconomizerLaunch(optionsFor(f, on));
    assert(onLaunch !== null, "enabled block with no stop must launch");
    assertEquals(onLaunch.pluginDir, f.plugin);
  });
});

Deno.test("an enabled launch carries exactly the env the worker sets, for both loop-guard values", async () => {
  await withFixture(async (f) => {
    for (const loopguard of ["off", "nudge"] as const) {
      const captured = captureLogger();
      const launch = await resolveTokenEconomizerLaunch(
        optionsFor(f, captured, {
          config: config({ microskills: "distiller", loopguard }),
        }),
      );
      assert(launch !== null);
      assertEquals(captured.warn, []);
      assertEquals(launch.env, {
        TOKENECONOMIZER_HOME: await expectedHome(f.work, "run-1"),
        TE_TOOLPRUNE: "off",
        TE_REPOMAP: "off",
        TE_HISTORY_IMPORT: "false",
        TE_MICROSKILLS: "envfacts",
        TE_LOOPGUARD: loopguard,
        TE_MICROSKILLS_MAX_FACTS: "4",
        TE_MICROSKILLS_MAX_TOKENS: "150",
      });
    }
  });
});

Deno.test("microskills is clamped to envfacts for every configured value", async () => {
  const expected: Record<TokenEconomizerMicroskills, "off" | "envfacts"> = {
    "off": "off",
    "envfacts": "envfacts",
    "distiller": "envfacts",
    "envfacts+distiller": "envfacts",
  };
  await withFixture(async (f) => {
    for (
      const configured of Object.keys(expected) as TokenEconomizerMicroskills[]
    ) {
      assertEquals(effectiveMicroskills(configured), expected[configured]);
      const launch = await resolveTokenEconomizerLaunch(
        optionsFor(f, captureLogger(), {
          config: config({ microskills: configured }),
        }),
      );
      assert(launch !== null);
      assertEquals(launch.env.TE_MICROSKILLS, expected[configured]);
    }
  });
});

Deno.test("only the three plugin run kinds launch; reviewer calls are refused", async () => {
  assertEquals(
    [...TOKEN_ECONOMIZER_RUN_KINDS],
    ["implementation", "pr-feedback", "ci-fix"],
  );
  assertEquals(TOKEN_ECONOMIZER_PLUGIN_DIR, "/opt/tokeneconomizer/plugin");
  await withFixture(async (f) => {
    for (const runKind of TOKEN_ECONOMIZER_RUN_KINDS) {
      const launch = await resolveTokenEconomizerLaunch(
        optionsFor(f, captureLogger(), { runKind }),
      );
      assert(launch !== null, `${runKind} must launch`);
    }

    const captured = captureLogger();
    const refused = await resolveTokenEconomizerLaunch(
      optionsFor(f, captured, {
        runKind: "reviewer" as TokenEconomizerRunKind,
      }),
    );
    assertEquals(refused, null);
    assertSingleWarn(captured, 'run kind "reviewer" is not one of');
  });
});

Deno.test("a plugin directory without its manifest is refused", async () => {
  await withFixture(async (f) => {
    const captured = captureLogger();
    const launch = await resolveTokenEconomizerLaunch(
      optionsFor(f, captured, { pluginDir: `${f.root}/absent` }),
    );
    assertEquals(launch, null);
    assertSingleWarn(captured, "plugin manifest missing at");
    assertStringIncludes(
      captured.warn[0] ?? "",
      `${f.root}/absent/.claude-plugin/plugin.json`,
    );

    const ok = await resolveTokenEconomizerLaunch(
      optionsFor(f, captureLogger()),
    );
    assert(ok !== null, "the fixture plugin with its manifest must launch");
  });
});

Deno.test("run ids outside the allow-list, and . and .., are refused", async () => {
  await withFixture(async (f) => {
    const refused = ["..", ".", "a/b", "", "x".repeat(81), "has space"];
    for (const runId of refused) {
      const captured = captureLogger();
      const launch = await resolveTokenEconomizerLaunch(
        optionsFor(f, captured, { runId }),
      );
      assertEquals(
        launch,
        null,
        `run id ${JSON.stringify(runId)} must be refused`,
      );
      assertSingleWarn(captured, "run id fails the allow-list");
    }

    for (const runId of ["a".repeat(80), "run.one_2-ok", "..."]) {
      const launch = await resolveTokenEconomizerLaunch(
        optionsFor(f, captureLogger(), { runId }),
      );
      assert(
        launch !== null,
        `run id ${JSON.stringify(runId)} must be accepted`,
      );
    }
  });
});

Deno.test("with no run id given, VIBE_RUN_ID names the state directory", async () => {
  await withFixture(async (f) => {
    const previous = Deno.env.get("VIBE_RUN_ID");
    try {
      Deno.env.set("VIBE_RUN_ID", "env-run-7");
      const launch = await resolveTokenEconomizerLaunch(
        optionsFor(f, captureLogger(), { runId: undefined }),
      );
      assert(launch !== null);
      assertEquals(
        launch.env.TOKENECONOMIZER_HOME,
        await expectedHome(f.work, "env-run-7"),
      );
    } finally {
      if (previous === undefined) Deno.env.delete("VIBE_RUN_ID");
      else Deno.env.set("VIBE_RUN_ID", previous);
    }
  });
});

Deno.test("a .token-economizer symlinked outside the work directory is refused", async () => {
  await withFixture(async (f) => {
    const outside = `${f.root}/outside`;
    await Deno.mkdir(outside);
    await Deno.symlink(outside, `${f.work}/.token-economizer`);

    const captured = captureLogger();
    const launch = await resolveTokenEconomizerLaunch(optionsFor(f, captured));
    assertEquals(launch, null);
    assertSingleWarn(captured, "lies outside the work directory");

    const otherWork = `${f.root}/work-two`;
    await Deno.mkdir(otherWork);
    const ok = await resolveTokenEconomizerLaunch(
      optionsFor(f, captureLogger(), { workDir: otherWork }),
    );
    assert(ok !== null, "a work directory without the symlink must launch");
    assertEquals(
      ok.env.TOKENECONOMIZER_HOME,
      await expectedHome(otherWork, "run-1"),
    );
  });
});

Deno.test("a repo checkout that contains the state directory is refused", async () => {
  await withFixture(async (f) => {
    // The checkout of `owner/.token-economizer` is `${work}/.token-economizer`,
    // which holds the state directory.
    const captured = captureLogger();
    const launch = await resolveTokenEconomizerLaunch(
      optionsFor(f, captured, { repo: "owner/.token-economizer" }),
    );
    assertEquals(launch, null);
    assertSingleWarn(captured, "lies inside the repo checkout");

    // The checkout of `owner/..` is the root above the work directory, which
    // also contains the state directory.
    const parent = captureLogger();
    const parentLaunch = await resolveTokenEconomizerLaunch(
      optionsFor(f, parent, { repo: "owner/.." }),
    );
    assertEquals(parentLaunch, null);
    assertSingleWarn(parent, "lies inside the repo checkout");

    const ok = await resolveTokenEconomizerLaunch(
      optionsFor(f, captureLogger(), { repo: "owner/VibeCoder" }),
    );
    assert(ok !== null, "an ordinary repo checkout must launch");
  });
});

Deno.test("a .. after a missing component is normalised before anything is created", async () => {
  await withFixture(async (f) => {
    const ugly = `${f.root}/absent/../work`;
    const launch = await resolveTokenEconomizerLaunch(
      optionsFor(f, captureLogger(), { workDir: ugly }),
    );
    assert(launch !== null, "the normalised work directory must launch");
    assertEquals(
      launch.env.TOKENECONOMIZER_HOME,
      await expectedHome(f.work, "run-1"),
    );
    await assertRejects(
      () => Deno.stat(`${f.root}/absent`),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("a state directory that cannot be created is refused, not thrown", async () => {
  await withFixture(async (f) => {
    // A dangling symlink as the work directory: no state directory can be
    // made beneath it.
    const dangling = `${f.root}/dangling`;
    await Deno.symlink(`${f.root}/nowhere/deeper`, dangling);

    const captured = captureLogger();
    const launch = await resolveTokenEconomizerLaunch(
      optionsFor(f, captured, { workDir: dangling }),
    );
    assertEquals(launch, null);
    assertSingleWarn(captured, "per-run state directory cannot be created");
  });
});

Deno.test("an unexpected error falls back to plugin off rather than throwing", async () => {
  await withFixture(async (f) => {
    const captured = captureLogger();
    const launch = await resolveTokenEconomizerLaunch(
      optionsFor(f, captured, { repo: undefined as unknown as string }),
    );
    assertEquals(launch, null);
    assertSingleWarn(captured, "launch failed");
  });
});

Deno.test("a missing stop record reads as null", async () => {
  await withFixture(async (f) => {
    assertEquals(await readTokenEconomizerStop(f.work), null);
  });
});

Deno.test("a recorded stop switches the plugin off, naming the rule and the redacted reason", async () => {
  await withFixture(async (f) => {
    const before = await resolveTokenEconomizerLaunch(
      optionsFor(f, captureLogger()),
    );
    assert(before !== null, "positive control: no stop, plugin on");

    const token = `ghp_${"a".repeat(36)}`;
    await recordTokenEconomizerStop(f.work, {
      rule: "secret-in-learnings",
      reason: `line 3 held ${token} in learnings`,
    }, fixedNow);

    const captured = captureLogger();
    const launch = await resolveTokenEconomizerLaunch(optionsFor(f, captured));
    assertEquals(launch, null);
    assertSingleWarn(captured, "rule secret-in-learnings");
    const warning = captured.warn[0] ?? "";
    assertStringIncludes(warning, "line 3 held ***REDACTED*** in learnings");
    assert(!warning.includes(token), "the token must not reach the log");
  });
});

Deno.test("the stop record is durable: a fresh call is still off, and the file holds the stop", async () => {
  await withFixture(async (f) => {
    await recordTokenEconomizerStop(f.work, {
      rule: "cross-repo-fact",
      reason: "fact names another repository",
    }, fixedNow);

    const second = captureLogger();
    assertEquals(
      await resolveTokenEconomizerLaunch(optionsFor(f, second)),
      null,
    );
    assertSingleWarn(second, "rule cross-repo-fact");

    const onDisk = JSON.parse(
      await Deno.readTextFile(tokenEconomizerStatePath(f.work)),
    );
    assertEquals(onDisk, {
      rule: "cross-repo-fact",
      reason: "fact names another repository",
      recordedAt: FIXED_NOW.toISOString(),
    });
  });
});

Deno.test("the first stop wins: a later record returns the existing stop unchanged", async () => {
  await withFixture(async (f) => {
    const first = await recordTokenEconomizerStop(f.work, {
      rule: "secret-in-learnings",
      reason: "first finding",
    }, fixedNow);
    const later = await recordTokenEconomizerStop(f.work, {
      rule: "plugin-run-failure",
      reason: "second finding",
    }, () => new Date("2030-01-01T00:00:00.000Z"));

    assertEquals(later, first);
    assertEquals(later.rule, "secret-in-learnings");
    const onDisk = JSON.parse(
      await Deno.readTextFile(tokenEconomizerStatePath(f.work)),
    );
    assertEquals(onDisk.rule, "secret-in-learnings");
    assertEquals(onDisk.reason, "first finding");
  });
});

Deno.test("a token in the reason is redacted before it reaches the file", async () => {
  await withFixture(async (f) => {
    const token = `ghp_${"b".repeat(36)}`;
    await recordTokenEconomizerStop(f.work, {
      rule: "secret-in-learnings",
      reason: `pasted ${token} into a learning`,
    }, fixedNow);

    const text = await Deno.readTextFile(tokenEconomizerStatePath(f.work));
    assert(!text.includes(token), "the raw token must not be on disk");
    assertStringIncludes(text, "***REDACTED***");
  });
});

Deno.test("a stop reason is single-line and at most 300 characters", async () => {
  await withFixture(async (f) => {
    const stop = await recordTokenEconomizerStop(f.work, {
      rule: "plugin-run-failure",
      reason: `line one\nline two\r\nline three ${"x".repeat(400)}`,
    }, fixedNow);
    assertEquals(stop.reason.length, 300);
    assertStringIncludes(stop.reason, "line one line two line three");
    assert(!stop.reason.includes("\n") && !stop.reason.includes("\r"));
  });
});

Deno.test("a corrupt or malformed stop record fails closed as unreadable", async () => {
  await withFixture(async (f) => {
    await Deno.mkdir(`${f.work}/.token-economizer`, { recursive: true });
    const cases = [
      "",
      "{not json",
      "[]",
      `{"rule":"bogus","reason":"x","recordedAt":"t"}`,
      `{"rule":"unreadable-stop-record","reason":"x","recordedAt":"t"}`,
      `{"rule":"cross-repo-fact","reason":1,"recordedAt":"t"}`,
    ];
    for (const body of cases) {
      await Deno.writeTextFile(tokenEconomizerStatePath(f.work), body);
      const stop = await readTokenEconomizerStop(f.work);
      assert(stop !== null, `${JSON.stringify(body)} must not read as no stop`);
      assertEquals(stop.rule, "unreadable-stop-record");
      assert(stop.reason.length > 0);

      const captured = captureLogger();
      assertEquals(
        await resolveTokenEconomizerLaunch(optionsFor(f, captured)),
        null,
      );
      assertSingleWarn(captured, "rule unreadable-stop-record");
    }
  });
});

Deno.test("recording a rule outside the findable set is rejected and writes nothing", async () => {
  await withFixture(async (f) => {
    await assertRejects(
      () =>
        recordTokenEconomizerStop(f.work, {
          rule: "bogus" as "cross-repo-fact",
          reason: "x",
        }),
      Error,
      "bogus",
    );
    await assertRejects(
      () =>
        recordTokenEconomizerStop(f.work, {
          rule: "unreadable-stop-record" as "cross-repo-fact",
          reason: "x",
        }),
      Error,
      "unreadable-stop-record",
    );
    await assertRejects(
      () => Deno.stat(tokenEconomizerStatePath(f.work)),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("the overlay copies only the allow-listed keys", () => {
  assertEquals(
    [...TOKEN_ECONOMIZER_ENV_KEYS].sort(),
    [
      "TE_HISTORY_IMPORT",
      "TE_LOOPGUARD",
      "TE_MICROSKILLS",
      "TE_MICROSKILLS_MAX_FACTS",
      "TE_MICROSKILLS_MAX_TOKENS",
      "TE_REPOMAP",
      "TE_TOOLPRUNE",
      "TOKENECONOMIZER_HOME",
    ],
  );

  const baseEnv: Record<string, string> = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "keep-me",
  };
  const launch: TokenEconomizerLaunch = {
    pluginDir: TOKEN_ECONOMIZER_PLUGIN_DIR,
    env: {
      TOKENECONOMIZER_HOME: "/state/run-1",
      TE_TOOLPRUNE: "off",
      TE_REPOMAP: "off",
      TE_HISTORY_IMPORT: "false",
      TE_MICROSKILLS: "envfacts",
      TE_LOOPGUARD: "nudge",
      TE_MICROSKILLS_MAX_FACTS: "4",
      TE_MICROSKILLS_MAX_TOKENS: "150",
      PATH: "/evil/bin",
      ANTHROPIC_API_KEY: "stolen",
      HOME: "/evil-home",
    },
  };
  overlayTokenEconomizerEnv(baseEnv, launch);

  assertEquals(baseEnv, {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "keep-me",
    TOKENECONOMIZER_HOME: "/state/run-1",
    TE_TOOLPRUNE: "off",
    TE_REPOMAP: "off",
    TE_HISTORY_IMPORT: "false",
    TE_MICROSKILLS: "envfacts",
    TE_LOOPGUARD: "nudge",
    TE_MICROSKILLS_MAX_FACTS: "4",
    TE_MICROSKILLS_MAX_TOKENS: "150",
  });
});

Deno.test("spawn options are empty when off and carry the launch when on", async () => {
  await withFixture(async (f) => {
    assertEquals(
      await tokenEconomizerSpawnOptions(
        optionsFor(f, captureLogger(), { config: config({ enabled: false }) }),
      ),
      {},
    );

    const on = await tokenEconomizerSpawnOptions(
      optionsFor(f, captureLogger()),
    );
    assert(on.tokenEconomizer !== undefined);
    assertEquals(on.tokenEconomizer.pluginDir, f.plugin);
    assertEquals(
      Object.keys(on.tokenEconomizer.env).sort(),
      [...TOKEN_ECONOMIZER_ENV_KEYS].sort(),
    );
  });
});
