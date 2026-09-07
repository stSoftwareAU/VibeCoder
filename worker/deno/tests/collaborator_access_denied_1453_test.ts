/**
 * Issue #1453: which collaborator-fetch failures mean "this login cannot
 * list this repo" — a property of the deployment the resolver may skip —
 * and which are outages a retry might fix.
 *
 * The distinction carries weight: a skipped repo leaves the trust fold, so
 * a rate-limit 403 mistaken for a permission 403 would narrow the
 * intersection on every busy hour and could widen the fleet-wide set.
 *
 * Australian English throughout (authorised, behaviour, normalise).
 */

import { assertEquals } from "@std/assert";
import {
  type CollaboratorFetchReason,
  isCollaboratorAccessDenied,
} from "../lib/collaborator_permissions.ts";

function failed(reason: CollaboratorFetchReason, detail: string) {
  return { ok: false as const, reason, detail };
}

Deno.test("isCollaboratorAccessDenied - 404 is a repo this login cannot see (Issue #1453)", () => {
  assertEquals(
    isCollaboratorAccessDenied(failed("http-404", "gh: Not Found (HTTP 404)")),
    true,
  );
});

Deno.test("isCollaboratorAccessDenied - 403 'Must have push access' is a read-only login (Issue #1453)", () => {
  assertEquals(
    isCollaboratorAccessDenied(failed(
      "http-403",
      "gh: Must have push access to view repository collaborators. (HTTP 403)",
    )),
    true,
  );
  assertEquals(
    isCollaboratorAccessDenied(failed(
      "http-403",
      "HTTP 403: Resource not accessible by personal access token",
    )),
    true,
    "a token that cannot reach the repo is the same condition",
  );
});

Deno.test("isCollaboratorAccessDenied - a 403 that names a rate limit is transient, not a denial (Issue #1453)", () => {
  for (
    const detail of [
      "HTTP 403: API rate limit exceeded for user ID 283951956.",
      "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)",
      "HTTP 403: abuse detection mechanism triggered, retry later",
    ]
  ) {
    assertEquals(
      isCollaboratorAccessDenied(failed("http-403", detail)),
      false,
      detail,
    );
  }
});

Deno.test("isCollaboratorAccessDenied - every other failure is not a denial (Issue #1453)", () => {
  for (
    const reason of [
      "gh-failed",
      "malformed-json",
      "empty-list",
      "invalid-repo-slug",
      "invalid-login",
    ] as const
  ) {
    assertEquals(
      isCollaboratorAccessDenied(failed(reason, "whatever gh said")),
      false,
      reason,
    );
  }
});
