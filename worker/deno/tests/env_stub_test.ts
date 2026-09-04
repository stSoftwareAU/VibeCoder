/**
 * Tests for tests/support/env.ts — the shared environment stubbing helpers
 * (Issue #378).
 *
 * These exist because ten tests read the ambient worker environment and were
 * red on every in-container run. The contract asserted here is what makes
 * those tests host-independent: what the caller names is what the code path
 * sees, everything else is hidden, and the previous environment always comes
 * back — including after a throw.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { RUNTIME_ENV_KEEP, withCleanEnv, withEnv } from "./support/env.ts";

const PROBE = "VIBE_TEST_ENV_PROBE_378";
const ABSENT = "VIBE_TEST_ENV_ABSENT_378";

Deno.test("withEnv - sets, deletes and restores the named variables", async () => {
  Deno.env.set(PROBE, "ambient");
  Deno.env.delete(ABSENT);
  try {
    await withEnv({ [PROBE]: undefined, [ABSENT]: "stubbed" }, () => {
      assertEquals(Deno.env.get(PROBE), undefined);
      assertEquals(Deno.env.get(ABSENT), "stubbed");
    });
    // The variable that existed is back; the one that did not is gone again.
    assertEquals(Deno.env.get(PROBE), "ambient");
    assertEquals(Deno.env.get(ABSENT), undefined);
  } finally {
    Deno.env.delete(PROBE);
    Deno.env.delete(ABSENT);
  }
});

Deno.test("withEnv - returns the body's value", async () => {
  assertEquals(await withEnv({ [PROBE]: "x" }, () => 42), 42);
  assertEquals(
    await withEnv({ [PROBE]: "x" }, () => Promise.resolve("async")),
    "async",
  );
});

Deno.test("withEnv - restores the environment when the body throws", async () => {
  Deno.env.set(PROBE, "ambient");
  try {
    await assertRejects(
      () =>
        withEnv({ [PROBE]: "stubbed" }, () => {
          throw new Error("boom");
        }),
      Error,
      "boom",
    );
    assertEquals(Deno.env.get(PROBE), "ambient");
  } finally {
    Deno.env.delete(PROBE);
  }
});

Deno.test("withCleanEnv - hides an ambient variable the caller did not name", async () => {
  // This is the whole point of Issue #378: the worker container sets its own
  // variables, and a code path under test must not see them unless the test
  // asked for them.
  Deno.env.set(PROBE, "from-the-worker-container");
  try {
    await withCleanEnv({ [ABSENT]: "declared" }, () => {
      assertEquals(Deno.env.get(PROBE), undefined);
      assertEquals(Deno.env.get(ABSENT), "declared");
    });
    assertEquals(Deno.env.get(PROBE), "from-the-worker-container");
  } finally {
    Deno.env.delete(PROBE);
  }
});

Deno.test("withCleanEnv - keeps the runtime variables the test process needs", async () => {
  const home = Deno.env.get("HOME");
  await withCleanEnv({}, () => {
    assertEquals(Deno.env.get("HOME"), home);
    assert(RUNTIME_ENV_KEEP.includes("PATH"));
    // PATH must survive or every subprocess-spawning test breaks.
    assert((Deno.env.get("PATH") ?? "").length > 0);
  });
});

Deno.test("withCleanEnv - a named variable may still be explicitly unset", async () => {
  Deno.env.set(PROBE, "ambient");
  try {
    await withCleanEnv({ [PROBE]: undefined }, () => {
      assertEquals(Deno.env.get(PROBE), undefined);
    });
    assertEquals(Deno.env.get(PROBE), "ambient");
  } finally {
    Deno.env.delete(PROBE);
  }
});

Deno.test("withCleanEnv - restores every variable it cleared, even after a throw", async () => {
  Deno.env.set(PROBE, "ambient");
  const before = Deno.env.toObject();
  try {
    await assertRejects(
      () =>
        withCleanEnv({}, () => {
          throw new Error("boom");
        }),
      Error,
      "boom",
    );
    assertEquals(Deno.env.toObject(), before);
  } finally {
    Deno.env.delete(PROBE);
  }
});
