/**
 * Tests for lib/optional_feature_env.ts — the `.config.json` optional-feature
 * keys (Issue #535) applied to the process environment by the Deno driver,
 * which used to be the bash conductor's `eval "$(load-config)"`.
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

import { assertEquals } from "@std/assert";
import {
  applyOptionalFeatureEnv,
  resolveOptionalFeatureEnv,
} from "../lib/optional_feature_env.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

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

Deno.test("resolveOptionalFeatureEnv - the environment wins over the config, as `${VAR:-config}` did", () => {
  const out = resolveOptionalFeatureEnv({
    imgbb_api_key: "from-config",
  }, {
    env: (name) => name === "VIBE_IMGBB_API_KEY" ? "from-env" : undefined,
  });
  assertEquals(out.VIBE_IMGBB_API_KEY, undefined);
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
    // Issue #378: this reads the ambient environment (the environment wins
    // over the config), and the worker container already exports
    // UPDATE_GH_USER_STATUS. Declaring an empty environment is what makes the
    // assertion mean something on a container as well as a bare developer
    // host — and it is stated, not installed in the process (Issue #969).
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

Deno.test("applyOptionalFeatureEnv - the ambient environment it is handed wins over the config file", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/.config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({ imgbb_api_key: "from-config" }),
    );
    // The hostile values the deleted process-environment stub used to install
    // are now simply named. A read that fell through to `Deno.env.get` would
    // not see them, so the config value would be applied and this fails.
    const set: Record<string, string> = {};
    const applied = await applyOptionalFeatureEnv(
      path,
      (name, value) => set[name] = value,
      envFrom({
        VIBE_IMGBB_API_KEY: "ambient-key",
        UPDATE_GH_USER_STATUS: "false",
      }),
    );
    assertEquals(applied, {});
    assertEquals(set, {});
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
