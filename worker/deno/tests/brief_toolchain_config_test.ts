/**
 * Tests for the `brief_toolchain` block parser (Issue #2603, part of #2581).
 *
 * The parser is the trust boundary between operator-written JSON and the
 * worker's `briefToolchain` switch. It is off by default and strict: an
 * unknown key or a non-boolean `enabled` fails the config load, naming
 * `brief_toolchain`, rather than reading as off.
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
  BRIEF_TOOLCHAIN_KEYS,
  defaultBriefToolchain,
  parseBriefToolchain,
} from "../lib/brief_toolchain_config.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { loadConfig } from "../lib/config.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";
import type { ConfigFile } from "../types.ts";

/** The error of a parse expected to fail. */
function errorOf(raw: unknown): string {
  const result = parseBriefToolchain(raw);
  assert(!result.ok, `Expected ${JSON.stringify(raw)} to be refused`);
  return result.error;
}

/** The value of a parse expected to succeed. */
function valueOf(raw: unknown): { enabled: boolean } {
  const result = parseBriefToolchain(raw);
  assert(result.ok, `Expected ${JSON.stringify(raw)} to parse`);
  return result.value;
}

/** Write `config` to a temporary file and run `fn` against its path. */
async function withTempConfig(
  config: ConfigFile,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "brief_toolchain_config_" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(path, JSON.stringify(config));
  try {
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const BASE: ConfigFile = { allowed_authors: ["testuser"], repos: ["org/r"] };

Deno.test("parseBriefToolchain - an absent block is off", () => {
  assertEquals(valueOf(undefined), { enabled: false });
});

Deno.test("parseBriefToolchain - an empty block is off", () => {
  assertEquals(valueOf({}), { enabled: false });
});

Deno.test("parseBriefToolchain - enabled true and false round-trip", () => {
  assertEquals(valueOf({ enabled: true }), { enabled: true });
  assertEquals(valueOf({ enabled: false }), { enabled: false });
});

Deno.test("parseBriefToolchain - a non-boolean enabled is refused, naming the key", () => {
  for (const bad of ["yes", 1, null, [], {}]) {
    assertStringIncludes(errorOf({ enabled: bad }), "brief_toolchain.enabled");
  }
  assertStringIncludes(errorOf({ enabled: "yes" }), "got string");
  assertStringIncludes(errorOf({ enabled: null }), "got null");
  assertStringIncludes(errorOf({ enabled: [] }), "got array");
});

Deno.test("parseBriefToolchain - a non-object or null block is refused", () => {
  for (const bad of [null, "on", 1, true, ["enabled"]]) {
    assertStringIncludes(errorOf(bad), "brief_toolchain");
  }
  assertStringIncludes(errorOf(null), "got null");
  assertStringIncludes(errorOf(["enabled"]), "got array");
});

Deno.test("parseBriefToolchain - an unknown key is refused, naming it", () => {
  const error = errorOf({ enabled: true, enabledd: false });
  assertStringIncludes(error, "brief_toolchain.enabledd");
  // A typo on its own is refused too, not read as the default.
  assertStringIncludes(errorOf({ enable: true }), "brief_toolchain.enable");
});

Deno.test("defaultBriefToolchain - off, and never shared", () => {
  const first = defaultBriefToolchain();
  assertEquals(first, { enabled: false });
  first.enabled = true;
  assertEquals(defaultBriefToolchain().enabled, false);
  assertEquals(buildDefaultWorkerConfig().briefToolchain, { enabled: false });
});

Deno.test("BRIEF_TOOLCHAIN_KEYS - the block accepts only enabled", () => {
  assertEquals([...BRIEF_TOOLCHAIN_KEYS], ["enabled"]);
});

Deno.test("brief_toolchain - is a recognised top-level key", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has("brief_toolchain"), true);
  assertEquals(
    detectUnknownConfigKeys({ brief_toolchain: { enabled: true } }),
    [],
  );
});

Deno.test("loadConfig - brief_toolchain absent is off", async () => {
  await withTempConfig(BASE, async (path) => {
    assertEquals((await loadConfig(path)).briefToolchain, { enabled: false });
  });
});

Deno.test("loadConfig - brief_toolchain enabled true is on", async () => {
  await withTempConfig(
    { ...BASE, brief_toolchain: { enabled: true } },
    async (path) => {
      assertEquals((await loadConfig(path)).briefToolchain, { enabled: true });
    },
  );
});

Deno.test("loadConfig - a non-boolean brief_toolchain.enabled fails the load", async () => {
  await withTempConfig(
    { ...BASE, brief_toolchain: { enabled: "yes" } },
    async (path) => {
      const error = await assertRejects(() => loadConfig(path), Error);
      assertStringIncludes(error.message, "brief_toolchain.enabled");
    },
  );
});

Deno.test("loadConfig - an unknown brief_toolchain key fails the load", async () => {
  await withTempConfig(
    { ...BASE, brief_toolchain: { enabled: true, trial: "yes" } },
    async (path) => {
      const error = await assertRejects(() => loadConfig(path), Error);
      assertStringIncludes(error.message, "brief_toolchain.trial");
    },
  );
});
