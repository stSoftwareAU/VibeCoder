/**
 * Tests for lib/optional_feature_env.ts — the `.config.json` optional-feature
 * keys (Issue #535) applied to the process environment by the Deno driver,
 * which used to be the bash conductor's `eval "$(load-config)"`.
 */

import { assertEquals } from "@std/assert";
import {
  applyOptionalFeatureEnv,
  resolveOptionalFeatureEnv,
} from "../lib/optional_feature_env.ts";

Deno.test("resolveOptionalFeatureEnv - maps the config keys to the variables their consumers read", () => {
  const out = resolveOptionalFeatureEnv({
    imgbb_api_key: "k",
    fleet_health_repo: "git@github.com:org/GRQ-health.git",
    fleet_health_dir: "/srv/GRQ-health",
    update_gh_user_status: false,
  }, { env: () => undefined, inContainer: false });
  assertEquals(out, {
    VIBE_IMGBB_API_KEY: "k",
    FLEET_HEALTH_REPO: "git@github.com:org/GRQ-health.git",
    FLEET_HEALTH_DIR: "/srv/GRQ-health",
    UPDATE_GH_USER_STATUS: "false",
  });
});

Deno.test("resolveOptionalFeatureEnv - the environment wins over the config, as `${VAR:-config}` did", () => {
  const out = resolveOptionalFeatureEnv({
    fleet_health_repo: "git@github.com:org/GRQ-health.git",
    imgbb_api_key: "from-config",
  }, {
    env: (name) => name === "VIBE_IMGBB_API_KEY" ? "from-env" : undefined,
    inContainer: false,
  });
  assertEquals(out.VIBE_IMGBB_API_KEY, undefined);
  assertEquals(out.FLEET_HEALTH_REPO, "git@github.com:org/GRQ-health.git");
});

Deno.test("resolveOptionalFeatureEnv - inside the container a host fleet_health_dir is not applied; the repository is", () => {
  const out = resolveOptionalFeatureEnv({
    fleet_health_repo: "git@github.com:org/GRQ-health.git",
    fleet_health_dir: "/Users/someone/src/GRQ-health",
  }, { env: () => undefined, inContainer: true });
  assertEquals(out.FLEET_HEALTH_DIR, undefined);
  assertEquals(out.FLEET_HEALTH_REPO, "git@github.com:org/GRQ-health.git");
});

Deno.test("resolveOptionalFeatureEnv - GitHub status defaults to true, the documented default; nothing else is assumed", () => {
  const out = resolveOptionalFeatureEnv({}, {
    env: () => undefined,
    inContainer: false,
  });
  assertEquals(out, { UPDATE_GH_USER_STATUS: "true" });
});

Deno.test("applyOptionalFeatureEnv - reads the file and sets what is missing; an unreadable file sets nothing", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/.config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({ fleet_health_repo: "git@github.com:org/h.git" }),
    );
    const set: Record<string, string> = {};
    const applied = await applyOptionalFeatureEnv(
      path,
      (name, value) => set[name] = value,
    );
    assertEquals(applied.FLEET_HEALTH_REPO, "git@github.com:org/h.git");
    assertEquals(set.FLEET_HEALTH_REPO, "git@github.com:org/h.git");

    const none: Record<string, string> = {};
    assertEquals(
      await applyOptionalFeatureEnv(
        `${tmp}/missing.json`,
        (n, v) => none[n] = v,
      ),
      {},
    );
    assertEquals(none, {});
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
