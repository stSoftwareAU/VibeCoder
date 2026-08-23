/**
 * Tests for gh_local_state_guard.ts — the local `gh` state classification the
 * agent-side guard refuses (Issue #187).
 *
 * `classifyGhMutation` only knows mutations made **on GitHub**, so a command
 * that rewrites the pinned `GH_CONFIG_DIR` instead — the credential store, the
 * config file, the alias table, the installed extensions — classified as a
 * read and reached the real binary. These tests drive the classifier with real
 * argument vectors and assert on what it returns.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { classifyGhLocalStateChange } from "../lib/gh_local_state_guard.ts";
import { ghSubVerb } from "../lib/audit_mutation_classifier.ts";

Deno.test("gh-local-state #187 - classifies a credential login as a local-state change", () => {
  const change = classifyGhLocalStateChange(["auth", "login", "--with-token"]);
  assertEquals(change?.root, "auth");
  assertEquals(change?.verb, "login");
  assertEquals(change?.target, "the credential store");
});

Deno.test("gh-local-state #187 - classifies setup-git, which redirects git credentials", () => {
  const change = classifyGhLocalStateChange(["auth", "setup-git"]);
  assertEquals(change?.root, "auth");
  assertEquals(change?.verb, "setup-git");
});

Deno.test("gh-local-state #187 - classifies config, alias and extension writes", () => {
  assertEquals(
    classifyGhLocalStateChange(["config", "set", "pager", "cat"])?.target,
    "the gh configuration",
  );
  assertEquals(
    classifyGhLocalStateChange(["alias", "set", "co", "pr checkout"])?.target,
    "the alias table",
  );
  assertEquals(
    classifyGhLocalStateChange(["extension", "install", "o/gh-x"])?.target,
    "the installed extensions",
  );
});

Deno.test("gh-local-state #187 - resolves gh's own root aliases for extension", () => {
  for (const root of ["ext", "extensions", "EXT"]) {
    assertEquals(
      classifyGhLocalStateChange([root, "install", "o/gh-x"])?.root,
      "extension",
      `expected ${root} to resolve to extension`,
    );
  }
});

Deno.test("gh-local-state #187 - matches the verb case-insensitively", () => {
  assertEquals(classifyGhLocalStateChange(["auth", "LOGIN"])?.verb, "LOGIN");
});

Deno.test("gh-local-state #187 - a value-carrying global flag does not hide the verb", () => {
  const change = classifyGhLocalStateChange(["--repo", "o/r", "auth", "login"]);
  assertEquals(change?.root, "auth");
  assertEquals(change?.verb, "login");
});

Deno.test("gh-local-state #187 - reads on the same roots are not local-state changes", () => {
  for (
    const args of [
      ["auth", "status"],
      ["auth", "token"],
      ["config", "get", "git_protocol"],
      ["config", "list"],
      ["alias", "list"],
      ["extension", "list"],
    ]
  ) {
    assertEquals(
      classifyGhLocalStateChange(args),
      undefined,
      `expected a read: ${args}`,
    );
  }
});

Deno.test("gh-local-state #187 - other roots and bare vectors classify as nothing", () => {
  for (
    const args of [
      ["issue", "comment", "7", "--body", "x"],
      ["repo", "create", "o/r"],
      ["auth"],
      ["--version"],
      [],
    ]
  ) {
    assertEquals(
      classifyGhLocalStateChange(args),
      undefined,
      `expected no local-state change: ${args}`,
    );
  }
});

Deno.test("gh-local-state #187 - ghSubVerb reads the verb the classifier would", () => {
  assertEquals(ghSubVerb(["auth", "login"]), "login");
  assertEquals(ghSubVerb(["-R", "o/r", "issue", "comment"]), "comment");
  assertEquals(ghSubVerb(["auth"]), undefined);
  assertEquals(ghSubVerb([]), undefined);
});
