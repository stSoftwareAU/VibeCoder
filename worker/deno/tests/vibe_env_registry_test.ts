/**
 * The `VIBE_*` registry is total over the source, and the bypass count only
 * falls (Issue #874).
 *
 * `.config.json` rejects an unknown key loudly (`config_unknown_keys.ts`); a
 * misspelled `VIBE_` variable is silently ignored and the setting simply never
 * applies. That asymmetry is why the environment surface has to be declared
 * rather than discovered: a list nobody checks drifts, and a drifted list is
 * worse than none — a stale `HOME_WORKDIR_ALLOWLIST` entry is what caught #805
 * and then #808.
 *
 * So this suite fails in both directions. A `VIBE_*` name in the tree that the
 * registry does not classify fails here, naming it. A name the registry
 * classifies that has left the tree fails here too, so the record cannot rot
 * into fiction. And `operator_config` — the group Issue #874 exists to drain —
 * is capped, so the debt can be paid down but not run back up.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  OPERATOR_CONFIG_BYPASS_CAP,
  unkeyedOperatorSettings,
  VIBE_ENV_REGISTRY,
  vibeEnvNamesByRole,
  type VibeEnvRole,
} from "../lib/vibe_env_registry.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

/**
 * `worker/deno`, resolved from this file rather than from the process working
 * directory — the scan must find the same tree whatever the cwd is, and cwd
 * is exactly what Issue #944 is removing from the suite.
 */
const DENO_DIR = `${REPO_ROOT}worker/deno`;

/** The `VIBE_*` shape, matched against source text rather than a call site. */
const VIBE_NAME_RE = /VIBE_[A-Z0-9_]+/g;

/** Directories the registry claims to cover, relative to `worker/deno`. */
const SCANNED_DIRS = ["lib", "commands", "setup"] as const;

/** Single files the registry claims to cover. */
const SCANNED_FILES = ["mod.ts"] as const;

/**
 * The registry module itself, which is the declaration rather than a use.
 *
 * It is the one file under `lib/` whose `VIBE_*` matches are its own exported
 * identifiers (`VIBE_ENV_REGISTRY`) and the names it declares. Scanning it
 * would make the registry trivially total over itself, which proves nothing.
 */
const REGISTRY_MODULE = `${DENO_DIR}/lib/vibe_env_registry.ts`;

/**
 * Every `VIBE_*` name the worker source mentions.
 *
 * Deliberately a text scan and not a call-site scan: the reads are spelled
 * seven different ways across the tree (`Deno.env.get`, an injected `env`,
 * `getEnv`, `envGet`, a named constant resolved elsewhere, a table of
 * name-to-key pairs, a template written into a child's environment), and a
 * scanner that understood only some of them would under-count exactly the way
 * #874's own figure did. Matching the shape catches all of them and pulls in
 * comment markers too — which is why {@link VibeEnvRole} has a `marker` role.
 */
async function namesInSource(): Promise<Set<string>> {
  const found = new Set<string>();
  const add = async (path: string): Promise<void> => {
    for (
      const match of (await Deno.readTextFile(path)).matchAll(VIBE_NAME_RE)
    ) {
      found.add(match[0]);
    }
  };

  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith(".ts") && path !== REGISTRY_MODULE) {
        await add(path);
      }
    }
  };

  for (const dir of SCANNED_DIRS) await walk(`${DENO_DIR}/${dir}`);
  for (const file of SCANNED_FILES) await add(`${DENO_DIR}/${file}`);
  return found;
}

Deno.test("VIBE_ENV_REGISTRY - classifies every VIBE_ name in the source", async () => {
  const inSource = await namesInSource();
  const undeclared = [...inSource]
    .filter((name) => !Object.hasOwn(VIBE_ENV_REGISTRY, name))
    .sort();

  assertEquals(
    undeclared,
    [],
    "these VIBE_ names are not in lib/vibe_env_registry.ts. Declare each one " +
      "with its role. A new `operator_config` entry is a new setting that " +
      "bypasses .config.json and will also fail the cap below — put it in " +
      "the config file instead:\n" + undeclared.join("\n"),
  );
});

Deno.test("VIBE_ENV_REGISTRY - holds no name the source has dropped", async () => {
  const inSource = await namesInSource();
  const stale = Object.keys(VIBE_ENV_REGISTRY)
    .filter((name) => !inSource.has(name))
    .sort();

  assertEquals(
    stale,
    [],
    "these registry entries name nothing in the source. Remove them, so the " +
      "registry stays an exact record rather than a list that drifts:\n" +
      stale.join("\n"),
  );
});

Deno.test("VIBE_ENV_REGISTRY - the .config.json bypass count only falls", () => {
  const bypassing = unkeyedOperatorSettings();

  assert(
    bypassing.length <= OPERATOR_CONFIG_BYPASS_CAP,
    `${bypassing.length} operator settings have no .config.json key, above ` +
      `the cap of ${OPERATOR_CONFIG_BYPASS_CAP}. This may shrink, never grow ` +
      "(Issue #874): a new operator setting belongs in .config.json, where " +
      `it is validated, diffable and visible in one place:\n${
        bypassing.join("\n")
      }`,
  );

  assertEquals(
    bypassing.length,
    OPERATOR_CONFIG_BYPASS_CAP,
    "the bypass count moved without the cap moving with it. Lower " +
      "OPERATOR_CONFIG_BYPASS_CAP to the new count in the same PR, so the " +
      "cap records progress instead of leaving slack for a regression.",
  );
});

// The count above is measured against the real config surface rather than
// taken from the classification, because the first cut of this registry got
// it wrong in exactly that way: five operator_config entries already had a
// key and were counted as debt anyway.
Deno.test("VIBE_ENV_REGISTRY - a keyed setting is not counted as debt", () => {
  const keyed = vibeEnvNamesByRole("operator_config")
    .filter((name) => {
      const key = VIBE_ENV_REGISTRY[name]?.configKey;
      return key !== undefined && KNOWN_CONFIG_KEYS.has(key);
    });

  assert(
    keyed.length > 0,
    "no operator_config entry is keyed, so the cross-check against " +
      "KNOWN_CONFIG_KEYS is proving nothing — it would pass just as well if " +
      "the two lists never met",
  );

  const debt = new Set(unkeyedOperatorSettings());
  for (const name of keyed) {
    assertEquals(
      debt.has(name),
      false,
      `${name} has a .config.json key and is still counted as a bypass`,
    );
  }
});

Deno.test("VIBE_ENV_REGISTRY - every configurable name states its config key", () => {
  const missing: string[] = [];
  const shaped: string[] = [];

  for (const [name, entry] of Object.entries(VIBE_ENV_REGISTRY)) {
    const needsKey = entry.role === "operator_config" ||
      entry.role === "setup_input";
    if (needsKey && entry.configKey === undefined) missing.push(name);
    if (
      entry.configKey !== undefined &&
      !/^[a-z][a-z0-9_]*$/.test(entry.configKey)
    ) {
      shaped.push(`${name} -> ${entry.configKey}`);
    }
  }

  assertEquals(
    missing,
    [],
    "an operator_config or setup_input entry with no configKey names no " +
      "destination, so nobody can tell what migrating it would mean:\n" +
      missing.join("\n"),
  );
  assertEquals(
    shaped,
    [],
    ".config.json keys are snake_case (config_unknown_keys.ts):\n" +
      shaped.join("\n"),
  );
});

Deno.test("VIBE_ENV_REGISTRY - a role that configures nothing names no config key", () => {
  const stray = Object.entries(VIBE_ENV_REGISTRY)
    .filter(([, entry]) =>
      entry.configKey !== undefined &&
      entry.role !== "operator_config" && entry.role !== "setup_input"
    )
    .map(([name, entry]) => `${name} (${entry.role}) -> ${entry.configKey}`);

  assertEquals(
    stray,
    [],
    "a run id, a disk measurement and an API key are not configuration. A " +
      "configKey here means the role is wrong, or the key should not exist:\n" +
      stray.join("\n"),
  );
});

Deno.test("VIBE_ENV_REGISTRY - every entry explains itself", () => {
  const silent = Object.entries(VIBE_ENV_REGISTRY)
    .filter(([, entry]) => entry.note.trim().length < 15)
    .map(([name]) => name);

  assertEquals(
    silent,
    [],
    "the note is what lets a reviewer check the role without reading the " +
      "call site; these say too little:\n" + silent.join("\n"),
  );
});

Deno.test("VIBE_ENV_REGISTRY - the roles partition the registry", () => {
  const roles: VibeEnvRole[] = [
    "operator_config",
    "setup_input",
    "launch_plumbing",
    "switch",
    "marker",
  ];

  const counted = roles.reduce(
    (total, role) => total + vibeEnvNamesByRole(role).length,
    0,
  );

  assertEquals(
    counted,
    Object.keys(VIBE_ENV_REGISTRY).length,
    "a role was added to VibeEnvRole without being added here, so entries " +
      "in it would be counted by nothing.",
  );
});

// Credentials are the one group where landing in .config.json would be a
// security regression rather than an improvement: the file is committed.
Deno.test("VIBE_ENV_REGISTRY - no provisioned credential is marked configurable", () => {
  const credentials = Object.entries(VIBE_ENV_REGISTRY)
    .filter(([name]) =>
      /_API_KEY$|_TOKEN$/.test(name) && name !== "VIBE_IMGBB_API_KEY"
    );

  assert(credentials.length > 0, "the fixture names no credentials");
  for (const [name, entry] of credentials) {
    assertEquals(
      entry.role,
      "switch",
      `${name} is a credential; .config.json is committed, so it must stay ` +
        "in the environment",
    );
  }
});
