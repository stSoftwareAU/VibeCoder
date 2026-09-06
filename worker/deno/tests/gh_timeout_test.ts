/**
 * Tests for the `gh` default-timeout policy (Issue #1229).
 *
 * Exercises the real `getGhTimeoutForOperation`, including the environment
 * overrides documented in `docs/CONFIGURATION.md` and the rejection of a
 * non-positive override, which must not restore unbounded behaviour.
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

/** Run `body` with one environment variable set, restoring it afterwards. */
function withEnv(name: string, value: string, body: () => void): void {
  const previous = Deno.env.get(name);
  Deno.env.set(name, value);
  try {
    body();
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
}

Deno.test("getGhTimeoutForOperation - a standard call takes the command timeout", () => {
  assertEquals(
    getGhTimeoutForOperation(["issue", "view", "1"]),
    DEFAULT_GH_COMMAND_TIMEOUT,
  );
});

Deno.test("getGhTimeoutForOperation - a clone takes the long clone timeout", () => {
  assertEquals(
    getGhTimeoutForOperation(["repo", "clone", "me/repo", "path"]),
    DEFAULT_GH_CLONE_TIMEOUT,
  );
});

Deno.test("getGhTimeoutForOperation - a paginated read takes the pagination timeout", () => {
  assertEquals(
    getGhTimeoutForOperation(["api", "--paginate", "/repos/me/repo/issues"]),
    DEFAULT_GH_PAGINATED_TIMEOUT,
  );
});

Deno.test("getGhTimeoutForOperation - honours the documented environment overrides", () => {
  withEnv("GH_COMMAND_TIMEOUT", "17", () => {
    assertEquals(getGhTimeoutForOperation(["pr", "view", "1"]), 17);
  });
  withEnv("GH_CLONE_TIMEOUT", "900", () => {
    assertEquals(getGhTimeoutForOperation(["repo", "clone", "me/repo"]), 900);
  });
  withEnv("GH_PAGINATED_TIMEOUT", "45", () => {
    assertEquals(getGhTimeoutForOperation(["api", "--paginate", "/x"]), 45);
  });
});

Deno.test("getGhTimeoutForOperation - a non-positive override cannot disable the timeout", () => {
  for (const bogus of ["0", "-30", "", "forever"]) {
    withEnv("GH_COMMAND_TIMEOUT", bogus, () => {
      assertEquals(
        getGhTimeoutForOperation(["issue", "list"]),
        DEFAULT_GH_COMMAND_TIMEOUT,
      );
    });
  }
});

Deno.test("getGhTimeoutForOperation - an empty argument list still gets a budget", () => {
  assertEquals(getGhTimeoutForOperation([]), DEFAULT_GH_COMMAND_TIMEOUT);
});

Deno.test("isGhTimeoutExitCode - recognises 124 and nothing else", () => {
  assertEquals(isGhTimeoutExitCode(124), true);
  assertEquals(isGhTimeoutExitCode(0), false);
  assertEquals(isGhTimeoutExitCode(1), false);
});
