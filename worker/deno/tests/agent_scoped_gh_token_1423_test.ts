/**
 * SEC-8d02435d8683 — the coding agent's `gh` gets a run-scoped credential
 * (Issue #1423).
 *
 * The write-repo allowlist defends in two layers: the argv classifier refuses
 * an off-allowlist write before `gh` is spawned, and — since Issue #1391 —
 * the credential itself cannot reach beyond the run's scope, so a write that
 * gets past the classifier is still refused by GitHub. The second layer
 * existed only for the worker's own `gh` calls. The agent's went through the
 * PATH shim with whatever ambient credential the container had staged, which
 * carries the installation's full reach — leaving the one component driven by
 * untrusted issue and comment text with the argv check as its only backstop.
 *
 * The half of this that is easy to get wrong is WHICH environment the token
 * is overlaid onto. `buildGhEnv` builds from `Deno.env.toObject()` — the
 * worker's whole environment, `GITHUB_APP_PRIVATE_KEY_PATH` among it — so
 * reusing it here would trade a scoping gap for the PEM that mints
 * installation tokens landing in a prompt-injected shell. The leak guard
 * below pins that: the returned environment may gain a token and nothing
 * else.
 *
 * Uses Australian English throughout (behaviour, authorisation, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { withRunScopedGhToken } from "../lib/gh_spawn.ts";

const SCOPED = "ghs_scoped_run_token";

/** A sanitised agent environment, of the shape `buildChildEnv` produces. */
function sanitisedEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/vibe",
    GH_TOKEN: "ambient-installation-wide-token",
    CLAUDE_CODE_OAUTH_TOKEN: "agent-provider-credential",
  };
}

Deno.test("SEC-8d02435d8683 - the agent's GH_TOKEN is replaced with the run-scoped one", async () => {
  const env = await withRunScopedGhToken(
    sanitisedEnv(),
    () => Promise.resolve(SCOPED),
  );
  assertEquals(env["GH_TOKEN"], SCOPED);
});

Deno.test("SEC-8d02435d8683 - GITHUB_TOKEN is replaced too, so no unscoped credential is left beside it", async () => {
  const base = { ...sanitisedEnv(), GITHUB_TOKEN: "ambient-alias-token" };
  const env = await withRunScopedGhToken(base, () => Promise.resolve(SCOPED));
  // `gh` accepts either name; leaving one ambient would park an unscoped
  // credential next to the scoped one.
  assertEquals(env["GH_TOKEN"], SCOPED);
  assertEquals(env["GITHUB_TOKEN"], SCOPED);
});

Deno.test("SEC-8d02435d8683 - GITHUB_TOKEN is not invented when the base carries none", async () => {
  const env = await withRunScopedGhToken(
    sanitisedEnv(),
    () => Promise.resolve(SCOPED),
  );
  assertEquals("GITHUB_TOKEN" in env, false);
});

Deno.test("SEC-8d02435d8683 - the overlay adds a token and NOTHING else (no worker secrets)", async () => {
  // The regression this pins: implementing the overlay via `buildGhEnv()`
  // would splat `Deno.env.toObject()` over the sanitised environment and hand
  // the agent every worker-only secret, the GitHub App PEM path included.
  const base = sanitisedEnv();
  const env = await withRunScopedGhToken(base, () => Promise.resolve(SCOPED));

  assertEquals(
    Object.keys(env).sort(),
    Object.keys(base).sort(),
    "the scoped overlay must not introduce environment variables",
  );
  // Named explicitly, because this is the one that matters most.
  assertEquals("GITHUB_APP_PRIVATE_KEY_PATH" in env, false);
  for (const [name, value] of Object.entries(base)) {
    if (name === "GH_TOKEN" || name === "GITHUB_TOKEN") continue;
    assertEquals(env[name], value, `${name} must be carried through unchanged`);
  }
});

Deno.test("SEC-8d02435d8683 - a host with no GitHub App degrades to ambient auth, it does not break", async () => {
  // `getGhTokenForSubprocess` returns undefined when the App is not
  // configured — a deliberate operator choice, and the same fallback
  // `buildGhEnv`'s callers already make. The agent must keep working.
  const base = sanitisedEnv();
  const env = await withRunScopedGhToken(
    base,
    () => Promise.resolve(undefined),
  );
  assertEquals(env, base);
  assertEquals(env["GH_TOKEN"], "ambient-installation-wide-token");
});

Deno.test("SEC-8d02435d8683 - the base environment is not mutated in place", async () => {
  const base = sanitisedEnv();
  const before = { ...base };
  await withRunScopedGhToken(base, () => Promise.resolve(SCOPED));
  assertEquals(base, before, "the caller's environment must be left alone");
});

Deno.test("SEC-8d02435d8683 - the token is minted once per call", async () => {
  let mints = 0;
  await withRunScopedGhToken(sanitisedEnv(), () => {
    mints += 1;
    return Promise.resolve(SCOPED);
  });
  assertEquals(mints, 1);
});

Deno.test("SEC-8d02435d8683 - the agent spawn path overlays the scoped token before the shim", async () => {
  // The wiring, asserted on the source: `runClaudeWithTimeout` must hand
  // `prepareGhGuardShim` an environment that has been through
  // `withRunScopedGhToken`, not the raw output of `buildChildEnv`. A future
  // edit that drops the overlay puts the agent back on the ambient
  // credential, which no unit test of the helper alone would notice.
  const source = await Deno.readTextFile(
    new URL("../lib/claude_runner.ts", import.meta.url),
  );
  assert(
    /withRunScopedGhToken\(\s*sanitisedEnv\s*\)/.test(source),
    "claude_runner must scope the sanitised agent environment",
  );
  assert(
    !/buildGhEnv/.test(source),
    "the agent env must never be built from the worker's own environment",
  );
});
