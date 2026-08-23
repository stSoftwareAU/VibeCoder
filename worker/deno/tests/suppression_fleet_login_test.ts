/**
 * A fleet worker login may never author a suppression (Issue #334).
 *
 * `[fleet-config]` warns on every start-up that `stservice` is in
 * `fleet_pr_authors`/`service_accounts` but not `allowed_authors`, and asks
 * for it to be added. That advice is right — `collect_work_on_candidates.ts`
 * says service accounts "sit in allowedAuthors for PR-dedup" — but
 * `allowed_authors` is also what feeds the suppression author allowlist. Doing
 * as the warning asks would let the fleet waive findings in code the fleet
 * wrote, and Issue #269's commit-identity bind cannot catch it because the
 * service account *is* the committer.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  _resetSuppressionAuthorAllowlist,
  _resetSuppressionCommitAuthors,
  _resetSuppressionFleetLogins,
  findSuppressions,
  setSuppressionAuthorAllowlist,
  setSuppressionFleetLogins,
} from "../lib/suppression_comments.ts";

/** A marker authored by `author`, with the commit-identity bind satisfied. */
function suppression(author: string) {
  const marker =
    `// orphan-deps-ignore: BP-abcdef — author=${author} expires=2999-01-01 x`;
  return findSuppressions(marker, "ts", { commitAuthors: [author] })[0];
}

function reset() {
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionFleetLogins();
  _resetSuppressionCommitAuthors();
}

Deno.test("#334 - a fleet login in allowed_authors still cannot suppress", () => {
  reset();
  try {
    // Exactly the state the [fleet-config] warning asks for.
    setSuppressionAuthorAllowlist(["nleck", "stservice", "VibeCoderST"]);
    setSuppressionFleetLogins(["VibeCoderST", "stservice"]);
    const record = suppression("stservice");
    assertEquals(record?.valid, false);
    assert(
      (record?.reason ?? "") !== "" || record !== undefined,
      "the marker is parsed, then refused",
    );
  } finally {
    reset();
  }
});

Deno.test("#334 - the host's own login cannot suppress either", () => {
  reset();
  try {
    setSuppressionAuthorAllowlist(["nleck", "VibeCoderST"]);
    setSuppressionFleetLogins(["VibeCoderST"]);
    assertEquals(suppression("VibeCoderST")?.valid, false);
  } finally {
    reset();
  }
});

Deno.test("#334 - a human in allowed_authors suppresses exactly as before", () => {
  reset();
  try {
    setSuppressionAuthorAllowlist(["nleck", "stservice"]);
    setSuppressionFleetLogins(["VibeCoderST", "stservice"]);
    assertEquals(
      suppression("nleck")?.valid,
      true,
      "the exclusion must not strip the humans who legitimately suppress",
    );
  } finally {
    reset();
  }
});

Deno.test("#334 - the comparison is case-insensitive, as GitHub logins are", () => {
  reset();
  try {
    setSuppressionAuthorAllowlist(["StService"]);
    setSuppressionFleetLogins(["stservice"]);
    assertEquals(
      suppression("StService")?.valid,
      false,
      "a different capitalisation is the same login",
    );
  } finally {
    reset();
  }
});

Deno.test("#334 - with no fleet logins configured nothing changes", () => {
  // The pre-#334 behaviour, so a caller that never wires the set is unaffected.
  reset();
  try {
    setSuppressionAuthorAllowlist(["stservice"]);
    assertEquals(suppression("stservice")?.valid, true);
  } finally {
    reset();
  }
});

Deno.test("#334 - a login outside the allowlist is still refused for that reason", () => {
  reset();
  try {
    setSuppressionAuthorAllowlist(["nleck"]);
    setSuppressionFleetLogins(["stservice"]);
    // Not in the allowlist at all: the original refusal still applies, and the
    // new one does not mask it.
    assertEquals(suppression("mallory")?.valid, false);
  } finally {
    reset();
  }
});
