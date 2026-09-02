/**
 * Setup persists the coding-agent selection it was given (Issue #799).
 *
 * On a fresh host there is no `.config.json`, so the selection has to come
 * from the environment: `VIBE_AGENT_PROVIDER=codex ./setup.sh`. That worked
 * for the run — the `claude` prerequisite stopped being host-fatal and only
 * the Codex credential flow was prompted (#730) — but setup never *wrote* it.
 * The next command is `./run.sh`, in a shell with no override: it resolved the
 * default, and since #729 built the image from that same set, so a Codex-only
 * deployment got a Claude image.
 *
 * These cases pin the write, and then prove what the written file means by
 * resolving it back through the same reader `setup.sh` and the launcher use.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildOverridesOnly,
  mergeNonInteractive,
  type SetupConfig,
} from "../setup/config_setup.ts";
import { resolveSetupAgentProviderIds } from "../setup/agent_providers.ts";
import { withoutProviderEnv } from "./fixtures/provider_env.ts";

/** An environment reader over a plain record. */
function env(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

/** The `.config.json` setup would write for `existing` under `values`. */
function written(
  values: Record<string, string>,
  existing: SetupConfig = {},
): Record<string, unknown> {
  return buildOverridesOnly(mergeNonInteractive(existing, env(values)));
}

Deno.test("setup - VIBE_AGENT_PROVIDER is written into the configuration (Issue #799)", () => {
  const config = written({ VIBE_AGENT_PROVIDER: "codex" });
  assertEquals(config.agent_provider, "codex");
});

Deno.test("setup - VIBE_AGENT_PROVIDERS is written as the enabled set (Issue #799)", () => {
  const config = written({
    VIBE_AGENT_PROVIDERS: "codex, gemini",
    VIBE_AGENT_PROVIDER: "codex",
  });
  assertEquals(config.agent_providers, ["codex", "gemini"]);
  assertEquals(config.agent_provider, "codex");
});

Deno.test("setup - the written file makes a Codex host Codex-only (Issue #799)", async () => {
  // The point of the issue: not that a key is written, but that the file
  // setup leaves behind resolves to Codex when nothing is exported any more.
  await withoutProviderEnv(async () => {
    const dir = await Deno.makeTempDir({ prefix: "vibe-provider-persist-" });
    try {
      const configPath = `${dir}/.config.json`;
      await Deno.writeTextFile(
        configPath,
        JSON.stringify(written({ VIBE_AGENT_PROVIDER: "codex" }), null, 2),
      );

      // Read back through the resolver `setup.sh`, the prerequisite probe and
      // the launcher all use — with no override in the environment.
      assertEquals(await resolveSetupAgentProviderIds(configPath), ["codex"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("setup - a host that declares nothing writes nothing (Issue #799)", () => {
  const config = written({ VIBE_REPOS: "org/repo" });
  assertEquals("agent_provider" in config, false);
  assertEquals("agent_providers" in config, false);
});

Deno.test("setup - an existing selection survives a run that declares none (Issue #799)", () => {
  // `.config.json` is rewritten on every `./setup.sh`, so a selection made on
  // the first run must not be destroyed by the second.
  const config = written({ VIBE_REPOS: "org/repo" }, {
    agent_provider: "codex",
    agent_providers: ["codex"],
  });
  assertEquals(config.agent_provider, "codex");
  assertEquals(config.agent_providers, ["codex"]);
});

Deno.test("setup - a later declaration replaces the stored one (Issue #799)", () => {
  const config = written({ VIBE_AGENT_PROVIDER: "gemini" }, {
    agent_provider: "codex",
  });
  assertEquals(config.agent_provider, "gemini");
});

Deno.test("setup - an unregistered provider is refused, not written (Issue #799)", () => {
  // A `.config.json` naming a provider nothing can run breaks every later
  // command; the operator is standing right here, so it fails now.
  let threw = false;
  try {
    written({ VIBE_AGENT_PROVIDER: "not-a-provider" });
  } catch (error) {
    threw = true;
    assertStringIncludes(
      (error as Error).message,
      "Unsupported coding-agent provider",
    );
  }
  assert(threw, "an unregistered provider must not reach .config.json");

  let threwForSet = false;
  try {
    written({ VIBE_AGENT_PROVIDERS: "codex,not-a-provider" });
  } catch {
    threwForSet = true;
  }
  assert(threwForSet, "every id in the set is checked");
});
