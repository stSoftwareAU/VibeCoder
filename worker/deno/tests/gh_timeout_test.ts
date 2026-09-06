/**
 * Tests for the `gh` default-timeout policy (Issue #1229).
 *
 * Exercises the real `getGhTimeoutForOperation`, including the environment
 * overrides documented in `docs/CONFIGURATION.md` and the rejection of a
 * non-positive override, which must not restore unbounded behaviour. The
 * environment is injected (Issue #880), never mutated.
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_GH_CLONE_TIMEOUT,
  DEFAULT_GH_COMMAND_TIMEOUT,
  DEFAULT_GH_PAGINATED_TIMEOUT,
  getGhTimeoutForOperation,
  isGhTimeoutExitCode,
} from "../lib/gh_timeout.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

Deno.test("getGhTimeoutForOperation - a standard call takes the command timeout", () => {
  assertEquals(
    getGhTimeoutForOperation(["issue", "view", "1"], emptyEnv),
    DEFAULT_GH_COMMAND_TIMEOUT,
  );
});

Deno.test("getGhTimeoutForOperation - a clone takes the long clone timeout", () => {
  assertEquals(
    getGhTimeoutForOperation(["repo", "clone", "me/repo", "path"], emptyEnv),
    DEFAULT_GH_CLONE_TIMEOUT,
  );
});

Deno.test("getGhTimeoutForOperation - a paginated read takes the pagination timeout", () => {
  assertEquals(
    getGhTimeoutForOperation(
      ["api", "--paginate", "/repos/me/repo/issues"],
      emptyEnv,
    ),
    DEFAULT_GH_PAGINATED_TIMEOUT,
  );
});

Deno.test("getGhTimeoutForOperation - honours the documented environment overrides", () => {
  const env = envFrom({
    GH_COMMAND_TIMEOUT: "17",
    GH_CLONE_TIMEOUT: "900",
    GH_PAGINATED_TIMEOUT: "45",
  });
  assertEquals(getGhTimeoutForOperation(["pr", "view", "1"], env), 17);
  assertEquals(
    getGhTimeoutForOperation(["repo", "clone", "me/repo"], env),
    900,
  );
  assertEquals(getGhTimeoutForOperation(["api", "--paginate", "/x"], env), 45);
});

Deno.test("getGhTimeoutForOperation - a non-positive override cannot disable the timeout", () => {
  for (const bogus of ["0", "-30", "", "forever"]) {
    assertEquals(
      getGhTimeoutForOperation(
        ["issue", "list"],
        envFrom({ GH_COMMAND_TIMEOUT: bogus }),
      ),
      DEFAULT_GH_COMMAND_TIMEOUT,
    );
  }
});

Deno.test("getGhTimeoutForOperation - an empty argument list still gets a budget", () => {
  assertEquals(
    getGhTimeoutForOperation([], emptyEnv),
    DEFAULT_GH_COMMAND_TIMEOUT,
  );
});

Deno.test("getGhTimeoutForOperation - the process environment is the default source", () => {
  // No lookup supplied: production callers pass nothing and must still get a
  // positive budget rather than an unbounded call.
  const timeout = getGhTimeoutForOperation(["issue", "view", "1"]);
  assertEquals(timeout > 0, true);
});

Deno.test("isGhTimeoutExitCode - recognises 124 and nothing else", () => {
  assertEquals(isGhTimeoutExitCode(124), true);
  assertEquals(isGhTimeoutExitCode(0), false);
  assertEquals(isGhTimeoutExitCode(1), false);
});
