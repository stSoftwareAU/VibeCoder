/**
 * Tests for the per-cycle trusted-author snapshot holder (Issue #253).
 *
 * A snapshot change must recompute the derived fleet-author sets, not
 * just swap the raw arrays — a stale `fleetPrAuthorInput` would
 * silently reintroduce the #4023/#4079 divergence.
 *
 * Uses Australian English throughout (behaviour, authorised).
 */

import { assertEquals } from "@std/assert";
import {
  createTrustSnapshotHolder,
  recomputeDerivedTrust,
} from "../lib/trust_snapshot.ts";

const CTX = {
  githubUser: "worker-bot",
  fleetPrAuthors: ["sibling-bot"],
};

Deno.test(
  "recomputeDerivedTrust - fleetAuthors unions host, allowed authors and siblings",
  () => {
    const derived = recomputeDerivedTrust(
      { allowedAuthors: ["alice"], authorisedCommenters: ["bob"] },
      CTX,
    );
    assertEquals(derived.fleetAuthors, ["worker-bot", "alice", "sibling-bot"]);
    assertEquals(derived.fleetPrAuthorInput.allowedAuthors, ["alice"]);
    assertEquals(derived.fleetPrAuthorInput.githubUser, "worker-bot");
    // Maintenance set is push-capable only: host + siblings, not humans.
    assertEquals(derived.maintenanceAuthors, ["worker-bot", "sibling-bot"]);
  },
);

Deno.test(
  "createTrustSnapshotHolder - apply recomputes fleet-author sets, not just raw arrays",
  () => {
    const holder = createTrustSnapshotHolder(CTX, {
      allowedAuthors: ["alice"],
      authorisedCommenters: ["carol"],
    });

    const first = holder.read();
    assertEquals(first.allowedAuthors, ["alice"]);
    assertEquals(first.authorisedCommenters, ["carol"]);
    assertEquals(first.fleetAuthors, ["worker-bot", "alice", "sibling-bot"]);
    assertEquals(first.fleetPrAuthorInput.allowedAuthors, ["alice"]);

    const second = holder.apply({
      allowedAuthors: ["dave", "erin"],
      authorisedCommenters: ["frank"],
    });

    assertEquals(second.allowedAuthors, ["dave", "erin"]);
    assertEquals(second.authorisedCommenters, ["frank"]);
    assertEquals(second.fleetAuthors, [
      "worker-bot",
      "dave",
      "erin",
      "sibling-bot",
    ]);
    assertEquals(second.fleetPrAuthorInput.allowedAuthors, ["dave", "erin"]);
    assertEquals(second.maintenanceAuthors, ["worker-bot", "sibling-bot"]);

    const reread = holder.read();
    assertEquals(reread.fleetAuthors, second.fleetAuthors);
    assertEquals(reread.fleetPrAuthorInput.allowedAuthors, ["dave", "erin"]);
    assertEquals(reread.authorisedCommenters, ["frank"]);
  },
);

Deno.test(
  "createTrustSnapshotHolder - apply replaces the previous snapshot rather than mutating it",
  () => {
    const holder = createTrustSnapshotHolder(CTX, {
      allowedAuthors: ["alice"],
      authorisedCommenters: ["carol"],
    });
    const first = holder.read();
    holder.apply({
      allowedAuthors: ["dave"],
      authorisedCommenters: ["frank"],
    });
    assertEquals(first.allowedAuthors, ["alice"]);
    assertEquals(first.fleetAuthors, ["worker-bot", "alice", "sibling-bot"]);
    assertEquals(holder.read().allowedAuthors, ["dave"]);
  },
);
