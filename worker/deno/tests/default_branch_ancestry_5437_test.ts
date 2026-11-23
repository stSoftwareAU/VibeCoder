/**
 * Default-branch ancestry of a commit (Issue #5437).
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import { assertEquals } from "@std/assert";
import { commitAncestryOnDefault } from "../lib/default_branch_ancestry.ts";

const SHA = "302adaa5e";

/**
 * A fake `gh` that answers only the compare call for `sha` with `reply`, and
 * throws for any other call. A reversed or wrong compare is therefore not
 * answered, and the status tests fail rather than pass by accident.
 */
function fakeCompare(sha: string, reply: string | Error) {
  const expected = [
    "api",
    `repos/o/r/compare/main...${sha}`,
    "--jq",
    ".status",
  ];
  return (args: string[]): Promise<string> => {
    if (JSON.stringify(args) !== JSON.stringify(expected)) {
      return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
    }
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply);
  };
}

Deno.test("an identical compare means the commit is on the default branch (Issue #5437)", async () => {
  assertEquals(
    await commitAncestryOnDefault(
      "o/r",
      SHA,
      "main",
      fakeCompare(SHA, "identical\n"),
    ),
    "on-default",
  );
});

Deno.test("a behind compare means the commit is an ancestor of the default branch (Issue #5437)", async () => {
  assertEquals(
    await commitAncestryOnDefault(
      "o/r",
      SHA,
      "main",
      fakeCompare(SHA, "behind\n"),
    ),
    "on-default",
  );
});

Deno.test("an ahead compare means the commit contains the whole default branch (Issue #5437)", async () => {
  assertEquals(
    await commitAncestryOnDefault(
      "o/r",
      SHA,
      "main",
      fakeCompare(SHA, "ahead\n"),
    ),
    "contains-default",
  );
});

Deno.test("a diverged compare means the commit lacks some default-branch commits (Issue #5437)", async () => {
  assertEquals(
    await commitAncestryOnDefault(
      "o/r",
      SHA,
      "main",
      fakeCompare(SHA, "diverged\n"),
    ),
    "diverged",
  );
});

Deno.test("an unrecognised compare status cannot be decided (Issue #5437)", async () => {
  assertEquals(
    await commitAncestryOnDefault(
      "o/r",
      SHA,
      "main",
      fakeCompare(SHA, "something-new\n"),
    ),
    "unknown",
  );
});

Deno.test("a failed compare call cannot be decided and never throws (Issue #5437)", async () => {
  assertEquals(
    await commitAncestryOnDefault(
      "o/r",
      SHA,
      "main",
      fakeCompare(SHA, new Error("gh: HTTP 500")),
    ),
    "unknown",
  );
});

Deno.test("an invalid sha cannot be decided (Issue #5437)", async () => {
  // The fake would answer `behind` for each sha, so `unknown` shows that gh
  // was never asked.
  for (const sha of ["", "main", "302adaa5e; rm -rf /", "a".repeat(41)]) {
    assertEquals(
      await commitAncestryOnDefault(
        "o/r",
        sha,
        "main",
        fakeCompare(sha, "behind"),
      ),
      "unknown",
    );
  }
});
