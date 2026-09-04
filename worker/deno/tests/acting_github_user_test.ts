/**
 * Tests for lib/acting_github_user.ts (Issue #965).
 *
 * The seam these commands resolve their identity through. Every injected
 * value here is absent from the real process environment, so a code path
 * that quietly fell back to `Deno.env.get` would read `undefined` (or a
 * host's own login) and fail rather than pass on the ambient value.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { resolveActingGithubUser } from "../lib/acting_github_user.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

Deno.test("resolveActingGithubUser - the --github-user argument wins", () => {
  assertEquals(
    resolveActingGithubUser(
      { "github-user": "arg-bot" },
      envFrom({ GITHUB_USER: "env-bot" }),
    ),
    "arg-bot",
  );
});

Deno.test("resolveActingGithubUser - falls back to the injected GITHUB_USER", () => {
  // `seam-only-bot` exists in no real environment: a fall back to
  // `Deno.env.get` cannot produce it.
  assertEquals(
    resolveActingGithubUser({}, envFrom({ GITHUB_USER: "seam-only-bot" })),
    "seam-only-bot",
  );
});

Deno.test("resolveActingGithubUser - an empty environment yields the empty login", () => {
  // The callers treat "" as a missing required argument and reject, so this
  // is the case that must not be rescued by an ambient variable.
  assertEquals(resolveActingGithubUser({}, emptyEnv), "");
});

Deno.test("resolveActingGithubUser - a non-string argument is stringified", () => {
  assertEquals(resolveActingGithubUser({ "github-user": 42 }, emptyEnv), "42");
});
