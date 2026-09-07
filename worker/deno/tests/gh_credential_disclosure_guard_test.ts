/**
 * Tests for gh_credential_disclosure_guard.ts — the credential *reads* the
 * agent-side `gh` guard refuses (Issue #1371).
 *
 * The guard mediates argv, so its whole containment depends on the agent not
 * holding the raw GitHub credential itself. `gh auth token` and
 * `gh auth status --show-token` print exactly that, and both classified as
 * benign reads: the guarded channel handed out the one value that makes every
 * later call unguarded. These tests drive the classifier with real argument
 * vectors and assert on what it returns.
 *
 * WHAT-tests: each asserts on the verdict, never on how it was reached.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { classifyGhCredentialDisclosure } from "../lib/gh_credential_disclosure_guard.ts";

Deno.test("gh-credential-disclosure #1371 - classifies `gh auth token` as a disclosure", () => {
  const found = classifyGhCredentialDisclosure(["auth", "token"]);
  assertEquals(found?.root, "auth");
  assertEquals(found?.verb, "token");
});

Deno.test("gh-credential-disclosure #1371 - a hostname or user flag does not excuse `gh auth token`", () => {
  assertEquals(
    classifyGhCredentialDisclosure([
      "auth",
      "token",
      "--hostname",
      "github.com",
    ])?.verb,
    "token",
  );
  assertEquals(
    classifyGhCredentialDisclosure(["auth", "token", "-u", "someone"])?.verb,
    "token",
  );
});

Deno.test("gh-credential-disclosure #1371 - classifies `gh auth status --show-token`", () => {
  const found = classifyGhCredentialDisclosure([
    "auth",
    "status",
    "--show-token",
  ]);
  assertEquals(found?.root, "auth");
  assertEquals(found?.verb, "status");
});

Deno.test("gh-credential-disclosure #1371 - classifies the shorthand and attached spellings of --show-token", () => {
  for (
    const args of [
      ["auth", "status", "-t"],
      ["auth", "status", "-at"],
      ["auth", "status", "--show-token=true"],
    ]
  ) {
    assertEquals(
      classifyGhCredentialDisclosure(args)?.verb,
      "status",
      `expected a disclosure for: gh ${args.join(" ")}`,
    );
  }
});

Deno.test("gh-credential-disclosure #1371 - plain `gh auth status` stays a read", () => {
  assertEquals(classifyGhCredentialDisclosure(["auth", "status"]), undefined);
  assertEquals(
    classifyGhCredentialDisclosure([
      "auth",
      "status",
      "--hostname",
      "github.com",
    ]),
    undefined,
  );
  assertEquals(
    classifyGhCredentialDisclosure(["auth", "status", "--active"]),
    undefined,
  );
});

Deno.test("gh-credential-disclosure #1371 - unrelated commands are not disclosures", () => {
  assertEquals(classifyGhCredentialDisclosure(["issue", "list"]), undefined);
  assertEquals(
    classifyGhCredentialDisclosure(["pr", "view", "5", "--json", "title"]),
    undefined,
  );
  assertEquals(classifyGhCredentialDisclosure(["auth", "login"]), undefined);
  assertEquals(classifyGhCredentialDisclosure([]), undefined);
});
