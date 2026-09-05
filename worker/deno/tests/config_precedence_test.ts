/**
 * The precedence rule holds, and no module is allowed to disagree
 * (Issues #874, #1032).
 *
 * Issue #289 settled the rule — the `.config.json` key wins over the
 * environment variable, the default applies when neither states a usable
 * value — but not where it lives, so each call site implemented it again and
 * the three that resolve both sources drifted apart. #1032 reordered the two
 * that contradicted it, so the exception list below is empty and the
 * conformance test is now absolute: any module resolving both sources without
 * `resolveSetting` fails here.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  clearDeprecatedEnvWarnings,
  deprecationWarning,
  isNonNegative,
  parseNumber,
  resolveSetting,
  warnDeprecatedEnvSetting,
} from "../lib/config_precedence.ts";
import { VIBE_ENV_REGISTRY } from "../lib/vibe_env_registry.ts";
import { envFrom } from "./support/env_lookup.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

const DENO_DIR = `${REPO_ROOT}worker/deno`;

/** A number setting, as every numeric tunable in the registry declares one. */
function floor(
  configured: number | null | undefined,
  env: Record<string, string>,
) {
  return resolveSetting<number>({
    configKey: "host_disk_low_floor_gb",
    envVar: "VIBE_HOST_DISK_LOW_FLOOR_GB",
    env: envFrom(env),
    configured,
    fallback: 20,
    parse: parseNumber,
    accept: isNonNegative,
  });
}

Deno.test("resolveSetting - the config key wins over the environment", () => {
  const resolved = floor(50, { VIBE_HOST_DISK_LOW_FLOOR_GB: "99" });
  assertEquals(resolved.value, 50);
  assertEquals(resolved.source, "config");
  assertEquals(resolved.deprecatedEnvVar, undefined);
});

Deno.test("resolveSetting - the environment applies when the file states nothing", () => {
  const resolved = floor(undefined, { VIBE_HOST_DISK_LOW_FLOOR_GB: "99" });
  assertEquals(resolved.value, 99);
  assertEquals(resolved.source, "env");
  assertEquals(resolved.deprecatedEnvVar, "VIBE_HOST_DISK_LOW_FLOOR_GB");
});

Deno.test("resolveSetting - the default applies when neither states a value", () => {
  const resolved = floor(undefined, {});
  assertEquals(resolved.value, 20);
  assertEquals(resolved.source, "default");
});

// A .config.json key is no more trustworthy than a variable: a negative floor
// read from the file would silently disable the check it configures.
Deno.test("resolveSetting - an unusable value is refused wherever it was written", () => {
  for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const fromFile = floor(bad, {});
    assertEquals(fromFile.value, 20, `configured ${bad}`);
    assertEquals(fromFile.source, "default", `configured ${bad}`);
  }

  for (const bad of ["twenty", "-1", "", "   ", "NaN"]) {
    const fromEnv = floor(undefined, { VIBE_HOST_DISK_LOW_FLOOR_GB: bad });
    assertEquals(fromEnv.value, 20, `env ${JSON.stringify(bad)}`);
    assertEquals(fromEnv.source, "default", `env ${JSON.stringify(bad)}`);
  }
});

// An unusable override must not fail the run — a typo in one variable cannot
// be allowed to stop a host claiming work — but the operator has to be able
// to see it did not take effect, which is what the source is for.
Deno.test("resolveSetting - an unusable environment value falls through to the default, not to a throw", () => {
  const resolved = floor(undefined, { VIBE_HOST_DISK_LOW_FLOOR_GB: "twenty" });
  assertEquals(resolved.value, 20);
  assertEquals(resolved.source, "default");
  assertEquals(resolved.deprecatedEnvVar, undefined);
});

Deno.test("resolveSetting - zero is a value, not an absence", () => {
  assertEquals(floor(0, {}).source, "config");
  assertEquals(floor(undefined, { VIBE_HOST_DISK_LOW_FLOOR_GB: "0" }).value, 0);
  assertEquals(
    floor(undefined, { VIBE_HOST_DISK_LOW_FLOOR_GB: "0" }).source,
    "env",
  );
});

Deno.test("deprecationWarning - names the variable and the key that replaces it", () => {
  const fromEnv = floor(undefined, { VIBE_HOST_DISK_LOW_FLOOR_GB: "99" });
  const warning = deprecationWarning(fromEnv, "host_disk_low_floor_gb");

  assert(warning !== null);
  assert(warning.includes("VIBE_HOST_DISK_LOW_FLOOR_GB"));
  assert(
    warning.includes("host_disk_low_floor_gb"),
    "a deprecation notice without the replacement leaves the operator to " +
      "search for it",
  );
  assert(warning.includes("2.0.0"));
});

Deno.test("deprecationWarning - says nothing when the environment was not used", () => {
  assertEquals(
    deprecationWarning(floor(50, {}), "host_disk_low_floor_gb"),
    null,
  );
  assertEquals(
    deprecationWarning(floor(undefined, {}), "host_disk_low_floor_gb"),
    null,
  );
});

// --- The warning an operator gets before 2.0.0 flips nothing further ---

/** Run `fn` with `console.warn` captured, and return the lines it emitted. */
function capturingWarnings(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

Deno.test("warnDeprecatedEnvSetting - one line per setting per run, however often it is resolved", () => {
  clearDeprecatedEnvWarnings();
  const lines = capturingWarnings(() => {
    for (let i = 0; i < 5; i++) {
      warnDeprecatedEnvSetting(
        floor(undefined, { VIBE_HOST_DISK_LOW_FLOOR_GB: "99" }),
        "host_disk_low_floor_gb",
      );
    }
  });

  assertEquals(lines.length, 1, "a warning on every read is noise");
  assert(lines[0]!.includes("VIBE_HOST_DISK_LOW_FLOOR_GB"));
  assert(lines[0]!.includes("host_disk_low_floor_gb"));
});

Deno.test("warnDeprecatedEnvSetting - says nothing when the file or the default supplied the value", () => {
  clearDeprecatedEnvWarnings();
  const lines = capturingWarnings(() => {
    warnDeprecatedEnvSetting(
      floor(50, { VIBE_HOST_DISK_LOW_FLOOR_GB: "99" }),
      "host_disk_low_floor_gb",
    );
    warnDeprecatedEnvSetting(floor(undefined, {}), "host_disk_low_floor_gb");
  });

  assertEquals(lines, []);
});

Deno.test("warnDeprecatedEnvSetting - each setting is reported on its own", () => {
  clearDeprecatedEnvWarnings();
  const lines = capturingWarnings(() => {
    warnDeprecatedEnvSetting(
      floor(undefined, { VIBE_HOST_DISK_LOW_FLOOR_GB: "99" }),
      "host_disk_low_floor_gb",
    );
    warnDeprecatedEnvSetting(
      resolveSetting<string>({
        configKey: "imgbb_api_key",
        envVar: "VIBE_IMGBB_API_KEY",
        env: envFrom({ VIBE_IMGBB_API_KEY: "from-env" }),
        fallback: "",
        parse: (raw) => raw,
      }),
      "imgbb_api_key",
    );
  });

  assertEquals(lines.length, 2);
  assert(lines[1]!.includes("imgbb_api_key"));
});

// --- The divergence is capped ---

/**
 * The modules that resolve a config key against a `VIBE_*` variable **without**
 * {@link resolveSetting}, and why each is allowed to.
 *
 * **Empty, and meant to stay that way** (Issue #1032). It held
 * `optional_feature_env.ts` and `agent_provider.ts`, the two that resolved
 * `env ?? config` — the reverse of the rule Issue #289 states. Both were
 * moved onto {@link resolveSetting} in the 2.0.0 flip, so every module that
 * resolves both sources now obeys one order and any new divergence fails the
 * conformance test below immediately, with nothing to hide behind.
 */
const DECLARED_PRECEDENCE_EXCEPTIONS: string[] = [];

Deno.test("config precedence - no undeclared module decides the rule for itself", async () => {
  // Driven by the registry rather than by a source pattern: a module resolves
  // both sources when it names an operator setting's VIBE_ variable *and* the
  // .config.json key that setting declares. Guessing at the shape instead
  // matched `raw.trim()` in two modules that read one source only.
  const pairs = Object.entries(VIBE_ENV_REGISTRY)
    .filter(([, entry]) => entry.role === "operator_config")
    .map(([envVar, entry]) => ({ envVar, configKey: entry.configKey! }));

  assert(pairs.length > 0, "the registry declares no operator settings");

  const offenders: string[] = [];
  for await (const entry of Deno.readDir(`${DENO_DIR}/lib`)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const relative = `lib/${entry.name}`;
    if (relative === "lib/config_precedence.ts") continue;
    if (relative === "lib/vibe_env_registry.ts") continue;
    if (DECLARED_PRECEDENCE_EXCEPTIONS.includes(relative)) continue;

    const source = await Deno.readTextFile(`${DENO_DIR}/${relative}`);
    if (source.includes("resolveSetting")) continue;

    for (const { envVar, configKey } of pairs) {
      if (source.includes(envVar) && source.includes(`"${configKey}"`)) {
        offenders.push(`${relative} (${envVar} vs ${configKey})`);
      }
    }
  }

  assertEquals(
    offenders,
    [],
    "these modules resolve a .config.json value against a VIBE_ variable " +
      "without lib/config_precedence.ts, so they decide the precedence for " +
      "themselves — which is the defect Issue #874 is about. Use " +
      "resolveSetting, or add the module to DECLARED_PRECEDENCE_EXCEPTIONS " +
      `with the reason:\n${offenders.join("\n")}`,
  );
});

// The exception list is only worth having if its entries are real: a stale
// name would silently excuse a module that no longer exists while a genuine
// offender took its place.
Deno.test("config precedence - every declared exception still exists and still diverges", async () => {
  for (const relative of DECLARED_PRECEDENCE_EXCEPTIONS) {
    const source = await Deno.readTextFile(`${DENO_DIR}/${relative}`);
    assert(
      !source.includes("resolveSetting"),
      `${relative} now uses resolveSetting — remove it from ` +
        "DECLARED_PRECEDENCE_EXCEPTIONS so a future divergence is caught",
    );
  }
});
