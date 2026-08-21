/**
 * Tests for lib/escape_hatch_trusted_authors.ts (Issue #185, SEC-8f21c4a0e7b3).
 *
 * The escape-hatch follow-up gate is only as good as the set of logins it
 * trusts. These tests pin what goes into that set (worker login, fleet
 * siblings, `allowed_authors`, `authorized_commenters`) and what stays out.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveTrustedFollowUpAuthors } from "../lib/escape_hatch_trusted_authors.ts";
import { isTrustedFollowUpAuthor } from "../lib/escape_hatch_verify.ts";

Deno.test("resolveTrustedFollowUpAuthors - unions the worker, fleet and allowlists", () => {
  const authors = resolveTrustedFollowUpAuthors({
    githubUser: "vibe-bot",
    allowedAuthors: ["owner"],
    fleetPrAuthors: ["vibe-bot-2"],
    authorisedCommenters: ["maintainer"],
  });
  assertEquals(authors.sort(), [
    "maintainer",
    "owner",
    "vibe-bot",
    "vibe-bot-2",
  ]);
});

Deno.test("resolveTrustedFollowUpAuthors - drops blanks and de-duplicates by login case", () => {
  const authors = resolveTrustedFollowUpAuthors({
    githubUser: "vibe-bot",
    allowedAuthors: ["Vibe-Bot", "  ", "owner"],
    fleetPrAuthors: ["owner"],
    authorisedCommenters: [""],
  });
  assertEquals(authors, ["vibe-bot", "owner"]);
});

Deno.test("resolveTrustedFollowUpAuthors - an unconfigured worker yields an empty set (Issue #185)", () => {
  // Empty means "cannot verify", which the gate must treat as a rejection —
  // never as a wildcard that trusts every author.
  assertEquals(resolveTrustedFollowUpAuthors({ githubUser: "" }), []);
  assertEquals(
    isTrustedFollowUpAuthor(
      "anyone",
      resolveTrustedFollowUpAuthors({
        githubUser: "",
      }),
    ),
    false,
  );
});

Deno.test("resolveTrustedFollowUpAuthors - an arbitrary reviewer is not trusted", () => {
  const authors = resolveTrustedFollowUpAuthors({
    githubUser: "vibe-bot",
    authorisedCommenters: ["maintainer"],
  });
  assert(isTrustedFollowUpAuthor("maintainer", authors));
  assertEquals(isTrustedFollowUpAuthor("drive-by-reviewer", authors), false);
});
