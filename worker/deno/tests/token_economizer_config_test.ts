/**
 * Tests for the `token_economizer` block (Issue #4955, part of #4953).
 *
 * The parser is the trust boundary between operator-written JSON and the
 * worker's `tokenEconomizer` setting, so each branch is exercised directly
 * here, and `loadConfig` is exercised on the same inputs through a temp
 * directory. The block is accepted and validated, but not read yet: #4956 will
 * wire it into runs; today a run is the same whatever it is set to.
 *
 * Every refusal is paired with the same input with only the probed value made
 * legal, so a test cannot pass by refusing everything.
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  defaultTokenEconomizer,
  parseTokenEconomizer,
  TOKEN_ECONOMIZER_KEYS,
  TOKEN_ECONOMIZER_LOOPGUARD,
  TOKEN_ECONOMIZER_MICROSKILLS,
} from "../lib/token_economizer_config.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";
import { loadConfig } from "../lib/config.ts";
import type { ConfigFile, TokenEconomizerConfig } from "../types.ts";

const KEY = "token_economizer";
/** A legal private repository, used as the probe that makes a refusal legal. */
const GOOD_REPO = "stSoftwareAU/learnings-store";

/** The error of a parse expected to fail. */
function errorOf(raw: unknown): string {
  const result = parseTokenEconomizer(raw);
  assert(!result.ok, `Expected ${JSON.stringify(raw)} to be refused`);
  return result.error;
}

/** The value of a parse expected to succeed. */
function valueOf(raw: unknown): TokenEconomizerConfig {
  const result = parseTokenEconomizer(raw);
  assert(result.ok, `Expected ${JSON.stringify(raw)} to parse`);
  return result.value;
}

/** Write a config file to a temp directory and run `fn` on its path. */
async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

/** A minimal host config carrying `block` as its `token_economizer`. */
function hostWith(block: unknown): ConfigFile {
  return {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    token_economizer: block,
  } as ConfigFile;
}

// ---------------------------------------------------------------------------
// Defaults and the allowed values
// ---------------------------------------------------------------------------

Deno.test("token_economizer - an absent block is the default: off, no repo, envfacts+distiller, nudge", () => {
  assertEquals(valueOf(undefined), {
    enabled: false,
    learningsRepo: undefined,
    microskills: "envfacts+distiller",
    loopguard: "nudge",
  });
});

Deno.test("token_economizer - an empty block is the default too", () => {
  assertEquals(valueOf({}), valueOf(undefined));
});

Deno.test("token_economizer - the defaults come from OPERATIONAL_DEFAULTS and are never shared", () => {
  assertEquals(
    defaultTokenEconomizer(),
    {
      enabled: OPERATIONAL_DEFAULTS.tokenEconomizer.enabled,
      learningsRepo: OPERATIONAL_DEFAULTS.tokenEconomizer.learningsRepo,
      microskills: OPERATIONAL_DEFAULTS.tokenEconomizer.microskills,
      loopguard: OPERATIONAL_DEFAULTS.tokenEconomizer.loopguard,
    },
  );

  const first = defaultTokenEconomizer();
  first.enabled = true;
  assertEquals(
    defaultTokenEconomizer().enabled,
    false,
    "Each call must return a fresh object",
  );
});

Deno.test("token_economizer - the block accepts exactly the four keys", () => {
  assertEquals(
    [...TOKEN_ECONOMIZER_KEYS].sort(),
    ["enabled", "learnings_repo", "loopguard", "microskills"],
  );
});

Deno.test("token_economizer - the two mechanisms accept exactly their documented values", () => {
  assertEquals(
    [...TOKEN_ECONOMIZER_MICROSKILLS],
    ["off", "envfacts", "distiller", "envfacts+distiller"],
  );
  assertEquals([...TOKEN_ECONOMIZER_LOOPGUARD], ["off", "nudge"]);
});

Deno.test("token_economizer - is a recognised top-level key", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has(KEY), true);
  assertEquals(
    detectUnknownConfigKeys({
      [KEY]: {
        enabled: true,
        learnings_repo: GOOD_REPO,
        microskills: "off",
        loopguard: "off",
      },
    }),
    [],
    "A well-formed token_economizer block must raise no warning",
  );
});

// ---------------------------------------------------------------------------
// A valid full block
// ---------------------------------------------------------------------------

Deno.test("token_economizer - a valid full block parses to every field", () => {
  assertEquals(
    valueOf({
      enabled: true,
      learnings_repo: GOOD_REPO,
      microskills: "distiller",
      loopguard: "off",
    }),
    {
      enabled: true,
      learningsRepo: GOOD_REPO,
      microskills: "distiller",
      loopguard: "off",
    },
  );
});

Deno.test("token_economizer - enabled false with a legal repo parses; the repo is kept", () => {
  assertEquals(valueOf({ enabled: false, learnings_repo: GOOD_REPO }), {
    enabled: false,
    learningsRepo: GOOD_REPO,
    microskills: "envfacts+distiller",
    loopguard: "nudge",
  });
});

// ---------------------------------------------------------------------------
// Non-object blocks
// ---------------------------------------------------------------------------

Deno.test("token_economizer - an explicit null block is refused, not read as the default", () => {
  assertStringIncludes(errorOf(null), KEY);
  assertStringIncludes(errorOf(null), "got null");
  assertEquals(valueOf({}).enabled, false, "the legal empty block is accepted");
});

Deno.test("token_economizer - a non-object block is refused, naming the block", () => {
  for (const bad of ["on", 1, true, ["enabled"]]) {
    assertStringIncludes(errorOf(bad), KEY);
  }
  assertStringIncludes(errorOf(["enabled"]), "got array");
  assertStringIncludes(errorOf("on"), "got string");
  assertEquals(valueOf({ enabled: false }).enabled, false);
});

// ---------------------------------------------------------------------------
// enabled
// ---------------------------------------------------------------------------

Deno.test("token_economizer - a non-boolean enabled is refused, naming token_economizer.enabled", () => {
  for (const bad of ["yes", "true", 1, [], {}]) {
    assertStringIncludes(
      errorOf({ enabled: bad }),
      "token_economizer.enabled",
    );
  }
  assertStringIncludes(errorOf({ enabled: "yes" }), "got string");
  assertEquals(
    valueOf({ enabled: true, learnings_repo: GOOD_REPO }).enabled,
    true,
    "the same input with a boolean enabled is accepted",
  );
});

Deno.test("token_economizer - an explicit null enabled is refused, naming token_economizer.enabled", () => {
  assertStringIncludes(errorOf({ enabled: null }), "token_economizer.enabled");
  assertStringIncludes(errorOf({ enabled: null }), "got null");
  assertEquals(valueOf({ enabled: false }).enabled, false);
});

// ---------------------------------------------------------------------------
// learnings_repo
// ---------------------------------------------------------------------------

Deno.test("token_economizer - a learnings_repo that is not owner/name is refused, naming the key", () => {
  const bad = [
    "",
    " ",
    "owner",
    "/name",
    "owner/",
    "owner/name/extra",
    "a/b/c",
    "https://github.com/owner/name",
    "github.com/owner/name",
    "owner/name.git/",
    "ow ner/name",
    "owner/na me",
    "owner/..",
    "owner/.",
    "-owner/name",
    "owner-/name",
    "own_er/name",
    "owner/name\n",
  ];
  for (const repo of bad) {
    assertStringIncludes(
      errorOf({ enabled: false, learnings_repo: repo }),
      "token_economizer.learnings_repo",
    );
  }
  assertEquals(
    valueOf({ enabled: false, learnings_repo: GOOD_REPO }).learningsRepo,
    GOOD_REPO,
    "the same input with a legal repo is accepted",
  );
});

Deno.test("token_economizer - a non-string learnings_repo is refused, naming the key", () => {
  for (const bad of [5, true, [], {}, null]) {
    assertStringIncludes(
      errorOf({ learnings_repo: bad }),
      "token_economizer.learnings_repo",
    );
  }
  assertStringIncludes(errorOf({ learnings_repo: null }), "got null");
  assertEquals(
    valueOf({ learnings_repo: GOOD_REPO }).learningsRepo,
    GOOD_REPO,
  );
});

Deno.test("token_economizer - a learnings_repo is validated even when the block is disabled", () => {
  assertStringIncludes(
    errorOf({ enabled: false, learnings_repo: "not a repo" }),
    "token_economizer.learnings_repo",
  );
  assertEquals(
    valueOf({ enabled: false, learnings_repo: "owner/name" }).learningsRepo,
    "owner/name",
  );
});

Deno.test("token_economizer - the owner and name length limits are the GitHub ones", () => {
  const owner39 = "a".repeat(39);
  const owner40 = "a".repeat(40);
  const name100 = "b".repeat(100);
  const name101 = "b".repeat(101);
  assertEquals(
    valueOf({ learnings_repo: `${owner39}/${name100}` }).learningsRepo,
    `${owner39}/${name100}`,
    "the longest legal owner and name are accepted",
  );
  assertStringIncludes(
    errorOf({ learnings_repo: `${owner40}/x` }),
    "token_economizer.learnings_repo",
  );
  assertStringIncludes(
    errorOf({ learnings_repo: `o/${name101}` }),
    "token_economizer.learnings_repo",
  );
});

Deno.test("token_economizer - a hostile input is refused: a very long run of valid characters then an invalid one", () => {
  // The length cap refuses these before any character is read, so a hostile
  // value costs one pass and no backtracking.
  const run = 200_000;
  const cases = [
    `${"a".repeat(run)}!/name`,
    `owner/${"b".repeat(run)}!`,
    `${"a".repeat(run)}/${"b".repeat(run)}`,
    "a".repeat(run) + "!",
    `${"-".repeat(run)}/name`,
  ];
  for (const repo of cases) {
    assertStringIncludes(
      errorOf({ enabled: false, learnings_repo: repo }),
      "token_economizer.learnings_repo",
    );
  }
  assertEquals(
    valueOf({ enabled: false, learnings_repo: "owner/name" }).learningsRepo,
    "owner/name",
    "the same shape with the invalid character removed is accepted",
  );
});

// ---------------------------------------------------------------------------
// learnings_repo is required when enabled
// ---------------------------------------------------------------------------

Deno.test("token_economizer - enabled true without learnings_repo is refused, naming the key and the rule", () => {
  const error = errorOf({ enabled: true });
  assertStringIncludes(error, "token_economizer.learnings_repo");
  assertStringIncludes(error, "required when token_economizer.enabled is true");
  assertEquals(
    valueOf({ enabled: true, learnings_repo: GOOD_REPO }).enabled,
    true,
    "the same input with a repo is accepted",
  );
});

Deno.test("token_economizer - enabled true with an undefined learnings_repo is refused the same way", () => {
  // An explicit undefined is the same as absent here, so it is refused too.
  assertStringIncludes(
    errorOf({ enabled: true, learnings_repo: undefined }),
    "token_economizer.learnings_repo",
  );
});

// ---------------------------------------------------------------------------
// microskills and loopguard
// ---------------------------------------------------------------------------

Deno.test("token_economizer - a microskills value outside the allowed set is refused, naming the key and the values", () => {
  for (const bad of ["on", "stop", "Off", "envfacts+distiller ", "", 1, true, null, [], {}]) {
    const error = errorOf({ microskills: bad });
    assertStringIncludes(error, "token_economizer.microskills");
    for (const allowed of TOKEN_ECONOMIZER_MICROSKILLS) {
      assertStringIncludes(error, `"${allowed}"`);
    }
  }
  assertStringIncludes(errorOf({ microskills: "on" }), 'got "on"');
  assertEquals(
    valueOf({ microskills: "envfacts" }).microskills,
    "envfacts",
    "the same input with an allowed value is accepted",
  );
});

Deno.test("token_economizer - every allowed microskills value parses", () => {
  for (const allowed of TOKEN_ECONOMIZER_MICROSKILLS) {
    assertEquals(valueOf({ microskills: allowed }).microskills, allowed);
  }
});

Deno.test("token_economizer - a loopguard value outside the allowed set is refused, naming the key and the values", () => {
  for (const bad of ["on", "stop", "Nudge", "", 1, true, null, [], {}]) {
    const error = errorOf({ loopguard: bad });
    assertStringIncludes(error, "token_economizer.loopguard");
    for (const allowed of TOKEN_ECONOMIZER_LOOPGUARD) {
      assertStringIncludes(error, `"${allowed}"`);
    }
  }
  assertStringIncludes(errorOf({ loopguard: "stop" }), 'got "stop"');
  assertEquals(
    valueOf({ loopguard: "off" }).loopguard,
    "off",
    "the same input with an allowed value is accepted",
  );
});

// ---------------------------------------------------------------------------
// Explicit null inner values
// ---------------------------------------------------------------------------

Deno.test("token_economizer - an explicit null inner value is refused, naming that key", () => {
  assertStringIncludes(errorOf({ enabled: null }), "token_economizer.enabled");
  assertStringIncludes(
    errorOf({ learnings_repo: null }),
    "token_economizer.learnings_repo",
  );
  assertStringIncludes(
    errorOf({ microskills: null }),
    "token_economizer.microskills",
  );
  assertStringIncludes(errorOf({ loopguard: null }), "token_economizer.loopguard");
});

Deno.test("token_economizer - only an absent or undefined inner key takes its default", () => {
  assertEquals(valueOf({ microskills: undefined }).microskills, "envfacts+distiller");
  assertEquals(valueOf({ loopguard: undefined }).loopguard, "nudge");
  assertEquals(valueOf({ enabled: undefined }).enabled, false);
});

// ---------------------------------------------------------------------------
// Unknown inner keys warn, they do not fail the parse
// ---------------------------------------------------------------------------

Deno.test("token_economizer - an unknown nested key does not fail the parse", () => {
  assertEquals(
    valueOf({ enabled: false, enabledd: true }).enabled,
    false,
  );
});

Deno.test("token_economizer - an unknown nested key is reported with a suggestion", () => {
  const warnings = detectUnknownConfigKeys({
    token_economizer: { enabeld: true },
  });
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.field, "token_economizer.enabeld");
  assertEquals(warnings[0]!.suggestion, "token_economizer.enabled");
});

Deno.test("token_economizer - an unknown nested key that is nowhere near a real one is still reported", () => {
  const warnings = detectUnknownConfigKeys({
    token_economizer: { zzzzzzzzzzzz: 1 },
  });
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.field, "token_economizer.zzzzzzzzzzzz");
});

// ---------------------------------------------------------------------------
// loadConfig: the same blocks through the real loader
// ---------------------------------------------------------------------------

Deno.test("loadConfig - an absent token_economizer block loads as the default", async () => {
  await withTempConfig({
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  }, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.tokenEconomizer, {
      enabled: false,
      learningsRepo: undefined,
      microskills: "envfacts+distiller",
      loopguard: "nudge",
    });
  });
});

Deno.test("loadConfig - a valid full token_economizer block loads to every field", async () => {
  await withTempConfig(
    hostWith({
      enabled: true,
      learnings_repo: GOOD_REPO,
      microskills: "off",
      loopguard: "nudge",
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.tokenEconomizer, {
        enabled: true,
        learningsRepo: GOOD_REPO,
        microskills: "off",
        loopguard: "nudge",
      });
    },
  );
});

Deno.test("loadConfig - enabled true without learnings_repo throws, naming the key", async () => {
  await withTempConfig(hostWith({ enabled: true }), async (configPath) => {
    const error = await assertRejects(() => loadConfig(configPath), Error);
    assertStringIncludes(error.message, "token_economizer.learnings_repo");
    assertStringIncludes(error.message, configPath);
  });
});

Deno.test("loadConfig - enabled true with a legal repo loads", async () => {
  await withTempConfig(
    hostWith({ enabled: true, learnings_repo: GOOD_REPO }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.tokenEconomizer.enabled, true);
      assertEquals(config.tokenEconomizer.learningsRepo, GOOD_REPO);
    },
  );
});

Deno.test("loadConfig - a bad microskills value throws, naming the key and the allowed values", async () => {
  await withTempConfig(
    hostWith({ microskills: "on" }),
    async (configPath) => {
      const error = await assertRejects(() => loadConfig(configPath), Error);
      assertStringIncludes(error.message, "token_economizer.microskills");
      assertStringIncludes(error.message, '"envfacts+distiller"');
    },
  );
  await withTempConfig(
    hostWith({ microskills: "envfacts" }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.tokenEconomizer.microskills, "envfacts");
    },
  );
});

Deno.test("loadConfig - a bad loopguard value throws, naming the key", async () => {
  await withTempConfig(
    hostWith({ loopguard: "stop" }),
    async (configPath) => {
      const error = await assertRejects(() => loadConfig(configPath), Error);
      assertStringIncludes(error.message, "token_economizer.loopguard");
    },
  );
});

Deno.test("loadConfig - a hostile learnings_repo throws, naming the key", async () => {
  await withTempConfig(
    hostWith({
      enabled: false,
      learnings_repo: `${"a".repeat(200_000)}!/name`,
    }),
    async (configPath) => {
      const error = await assertRejects(() => loadConfig(configPath), Error);
      assertStringIncludes(error.message, "token_economizer.learnings_repo");
    },
  );
});
