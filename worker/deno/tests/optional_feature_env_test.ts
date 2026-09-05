/**
 * Tests for lib/optional_feature_env.ts — the `.config.json` optional-feature
 * keys (Issue #535) applied to the process environment by the Deno driver,
 * which used to be the bash conductor's `eval "$(load-config)"`.
 *
 * Precedence is `config → env → default` since Issue #1032: the two
 * assertions that pinned the old "environment wins" order are inverted below,
 * each marked with the issue, and a warning test covers the deprecation
 * notice an operator gets while the variable still works.
 *
 * Migrated off the now-deleted `tests/support/env.ts` (Issues #944, #969).
 * `resolveOptionalFeatureEnv` always took its environment as a parameter;
 * `applyOptionalFeatureEnv` reached `Deno.env.get` itself, so the only way to
 * state the ambient environment was to write one into the process — the
 * mutation that kept this suite in the gate's slow serial pass. It now takes
 * the same lookup, so the suite declares both a hostile ambient environment
 * and an empty one without touching the process at all.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  applyOptionalFeatureEnv,
  resolveOptionalFeatureEnv,
} from "../lib/optional_feature_env.ts";
import { clearDeprecatedEnvWarnings } from "../lib/config_precedence.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

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

Deno.test("resolveOptionalFeatureEnv - maps the config keys to the variables their consumers read", () => {
  const out = resolveOptionalFeatureEnv({
    imgbb_api_key: "k",
    update_gh_user_status: false,
  }, { env: () => undefined });
  assertEquals(out, {
    VIBE_IMGBB_API_KEY: "k",
    UPDATE_GH_USER_STATUS: "false",
  });
});

// Issue #1032 reversed this: the suite used to assert the environment won,
// reproducing the bash-era `${VAR:-config}` expansion. The file wins now, as
// it always has for every other knob (Issue #289), so a host that states
// `imgbb_api_key` *and* exports `VIBE_IMGBB_API_KEY` uploads with the file's
// key — and the applied entry is what makes that value the one in force.
Deno.test("resolveOptionalFeatureEnv - the config file wins over the environment (Issue #1032)", () => {
  clearDeprecatedEnvWarnings();
  const lines = capturingWarnings(() => {
    const out = resolveOptionalFeatureEnv({
      imgbb_api_key: "from-config",
    }, {
      env: (name) => name === "VIBE_IMGBB_API_KEY" ? "from-env" : undefined,
    });
    assertEquals(out.VIBE_IMGBB_API_KEY, "from-config");
  });
  assertEquals(lines, [], "nothing is deprecated when the file supplied it");
});

Deno.test("resolveOptionalFeatureEnv - the environment applies when the file states nothing, and is deprecated once", () => {
  clearDeprecatedEnvWarnings();
  const lines = capturingWarnings(() => {
    for (let i = 0; i < 3; i++) {
      const out = resolveOptionalFeatureEnv({}, {
        env: (name) => name === "VIBE_IMGBB_API_KEY" ? "from-env" : undefined,
      });
      // Nothing to apply: the process already carries the operator's value.
      assertEquals(out.VIBE_IMGBB_API_KEY, undefined);
    }
  });

  assertEquals(lines.length, 1, "a warning on every read is noise");
  assert(lines[0]!.includes("VIBE_IMGBB_API_KEY"));
  assert(
    lines[0]!.includes("imgbb_api_key"),
    "the warning names the config key that replaces the variable",
  );
});

// The same flip for the second key this module carries. UPDATE_GH_USER_STATUS
// is not a deprecated VIBE_ override — this module is what *sets* it — so the
// precedence moves with the rule but no deprecation line is emitted.
Deno.test("resolveOptionalFeatureEnv - the config file wins for the GitHub status switch too", () => {
  clearDeprecatedEnvWarnings();
  const lines = capturingWarnings(() => {
    const out = resolveOptionalFeatureEnv({ update_gh_user_status: false }, {
      env: (name) => name === "UPDATE_GH_USER_STATUS" ? "true" : undefined,
    });
    assertEquals(out.UPDATE_GH_USER_STATUS, "false");
  });
  assertEquals(lines, []);
});

Deno.test("resolveOptionalFeatureEnv - GitHub status defaults to true, the documented default; nothing else is assumed", () => {
  const out = resolveOptionalFeatureEnv({}, { env: () => undefined });
  assertEquals(out, { UPDATE_GH_USER_STATUS: "true" });
});

Deno.test("applyOptionalFeatureEnv - reads the file and sets what is missing; an unreadable file sets nothing", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/.config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({ imgbb_api_key: "from-config" }),
    );
    // Issue #378: this reads the ambient environment, and the worker container
    // already exports UPDATE_GH_USER_STATUS. Declaring an empty environment is
    // what makes the assertion mean something on a container as well as a bare
    // developer host — and it is stated, not installed in the process
    // (Issue #969).
    const set: Record<string, string> = {};
    const applied = await applyOptionalFeatureEnv(
      path,
      (name, value) => set[name] = value,
      emptyEnv,
    );
    assertEquals(applied.VIBE_IMGBB_API_KEY, "from-config");
    assertEquals(set.VIBE_IMGBB_API_KEY, "from-config");

    const none: Record<string, string> = {};
    assertEquals(
      await applyOptionalFeatureEnv(
        `${tmp}/missing.json`,
        (n, v) => none[n] = v,
        emptyEnv,
      ),
      {},
    );
    assertEquals(none, {});
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// Issue #1032: this suite used to assert the ambient environment won here.
// The config file wins now, so the ambient values are overwritten with what
// the operator wrote in the file — the whole point of the behaviour change.
Deno.test("applyOptionalFeatureEnv - the config file wins over the ambient environment it is handed", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/.config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({ imgbb_api_key: "from-config" }),
    );
    // The hostile values the deleted process-environment stub used to install
    // are now simply named.
    const set: Record<string, string> = {};
    const applied = await applyOptionalFeatureEnv(
      path,
      (name, value) => set[name] = value,
      envFrom({
        VIBE_IMGBB_API_KEY: "ambient-key",
        UPDATE_GH_USER_STATUS: "false",
      }),
    );
    assertEquals(applied, { VIBE_IMGBB_API_KEY: "from-config" });
    assertEquals(set, { VIBE_IMGBB_API_KEY: "from-config" });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
