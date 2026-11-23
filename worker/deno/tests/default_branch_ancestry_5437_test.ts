/**
 * Default-branch ancestry of a commit (Issue #5437).
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import { assertEquals } from "@std/assert";
import { commitAncestryOnDefault } from "../lib/default_branch_ancestry.ts";

const SHA = "302adaa5e";

/** A fake `gh` that answers the compare call with `reply`, recording calls. */
function fakeCompare(reply: string | Error) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply);
  };
  return { calls, gh };
}

Deno.test("an identical compare means the commit is on the default branch (Issue #5437)", async () => {
  const fake = fakeCompare("identical\n");
  assertEquals(
    await commitAncestryOnDefault("o/r", SHA, "main", fake.gh),
    "on-default",
  );
});

Deno.test("a behind compare means the commit is an ancestor of the default branch (Issue #5437)", async () => {
  const fake = fakeCompare("behind\n");
  assertEquals(
    await commitAncestryOnDefault("o/r", SHA, "main", fake.gh),
    "on-default",
  );
});

Deno.test("an ahead compare means the commit is not on the default branch (Issue #5437)", async () => {
  const fake = fakeCompare("ahead\n");
  assertEquals(
    await commitAncestryOnDefault("o/r", SHA, "main", fake.gh),
    "off-default",
  );
});

Deno.test("a diverged compare means the commit is not on the default branch (Issue #5437)", async () => {
  const fake = fakeCompare("diverged\n");
  assertEquals(
    await commitAncestryOnDefault("o/r", SHA, "main", fake.gh),
    "off-default",
  );
});

Deno.test("an unrecognised compare status cannot be decided (Issue #5437)", async () => {
  const fake = fakeCompare("something-new\n");
  assertEquals(
    await commitAncestryOnDefault("o/r", SHA, "main", fake.gh),
    "unknown",
  );
});

Deno.test("a failed compare call cannot be decided and never throws (Issue #5437)", async () => {
  const fake = fakeCompare(new Error("gh: HTTP 500"));
  assertEquals(
    await commitAncestryOnDefault("o/r", SHA, "main", fake.gh),
    "unknown",
  );
});

Deno.test("an invalid sha cannot be decided and gh is not called (Issue #5437)", async () => {
  for (const sha of ["", "main", "302adaa5e; rm -rf /", "a".repeat(41)]) {
    const fake = fakeCompare("behind");
    assertEquals(
      await commitAncestryOnDefault("o/r", sha, "main", fake.gh),
      "unknown",
    );
    assertEquals(fake.calls.length, 0);
  }
});

Deno.test("the compare call names the default branch and the commit (Issue #5437)", async () => {
  const fake = fakeCompare("behind");
  await commitAncestryOnDefault("o/r", SHA, "main", fake.gh);
  assertEquals(fake.calls, [[
    "api",
    `repos/o/r/compare/main...${SHA}`,
    "--jq",
    ".status",
  ]]);
});
