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
  const result = await commitAncestryOnDefault(
    "o/r",
    SHA,
    "main",
    fakeCompare(SHA, "identical\n"),
  );
  assertEquals(result, { status: "on-default" });
});

Deno.test("a behind compare means the commit is an ancestor of the default branch (Issue #5437)", async () => {
  const result = await commitAncestryOnDefault(
    "o/r",
    SHA,
    "main",
    fakeCompare(SHA, "behind\n"),
  );
  assertEquals(result, { status: "on-default" });
});

Deno.test("an ahead compare means the commit contains the whole default branch (Issue #5437)", async () => {
  const result = await commitAncestryOnDefault(
    "o/r",
    SHA,
    "main",
    fakeCompare(SHA, "ahead\n"),
  );
  assertEquals(result, { status: "contains-default" });
});

Deno.test("a diverged compare means the commit lacks some default-branch commits (Issue #5437)", async () => {
  const result = await commitAncestryOnDefault(
    "o/r",
    SHA,
    "main",
    fakeCompare(SHA, "diverged\n"),
  );
  assertEquals(result, { status: "diverged" });
});

Deno.test("an unrecognised compare status cannot be decided and names the status (Issue #5437)", async () => {
  const result = await commitAncestryOnDefault(
    "o/r",
    SHA,
    "main",
    fakeCompare(SHA, "something-new\n"),
  );
  assertEquals(result, {
    status: "unknown",
    cause: `unrecognised compare status "something-new"`,
  });
});

Deno.test("a failed compare call cannot be decided, never throws, and carries the gh error (Issue #5437)", async () => {
  const result = await commitAncestryOnDefault(
    "o/r",
    SHA,
    "main",
    fakeCompare(SHA, new Error("HTTP 502: Bad Gateway")),
  );
  assertEquals(result, {
    status: "unknown",
    cause: "HTTP 502: Bad Gateway",
  });
});

Deno.test("an invalid sha cannot be decided and names the rejected input (Issue #5437)", async () => {
  // The fake would answer `behind` for each sha, so `unknown` shows that gh
  // was never asked.
  for (const sha of ["", "main", "302adaa5e; rm -rf /", "a".repeat(41)]) {
    const result = await commitAncestryOnDefault(
      "o/r",
      sha,
      "main",
      fakeCompare(sha, "behind"),
    );
    assertEquals(result, {
      status: "unknown",
      cause: `not a commit sha: ${JSON.stringify(sha)}`,
    });
  }
});
