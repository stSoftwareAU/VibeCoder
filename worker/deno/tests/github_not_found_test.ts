/**
 * Tests for the shared definitive-not-found test (Issue #210).
 *
 * `gh` reports a missing issue number through GraphQL as "Could not resolve
 * to an issue or pull request with the number of N" — the wording that made
 * the reserved-label strip retry and ERROR on NEAT-AI-Lamarck#3952. It must
 * read as definitively absent, while transient failures must not.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { isDefinitiveNotFound } from "../lib/github_not_found.ts";

Deno.test("isDefinitiveNotFound - the GraphQL missing-number wording is definitive", () => {
  assert(
    isDefinitiveNotFound(
      "gh command failed (exit 1): GraphQL: Could not resolve to an issue " +
        "or pull request with the number of 3952. (repository.issue)",
    ),
    "the wording that burned NEAT-AI-Lamarck#187 must read as not-found",
  );
});

Deno.test("isDefinitiveNotFound - REST 404 wordings stay definitive", () => {
  assert(isDefinitiveNotFound("gh: Not Found (HTTP 404)"));
  assert(isDefinitiveNotFound("HTTP 404"));
});

Deno.test("isDefinitiveNotFound - transient failures stay inconclusive", () => {
  assertEquals(isDefinitiveNotFound("HTTP 502 Bad Gateway"), false);
  assertEquals(isDefinitiveNotFound("API rate limit exceeded"), false);
  assertEquals(isDefinitiveNotFound("dial tcp: i/o timeout"), false);
  assertEquals(isDefinitiveNotFound("GraphQL: Something else failed"), false);
});
