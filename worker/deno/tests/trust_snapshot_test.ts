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
  "recomputeDerivedTrust - fleetAuthors is identity only, never the trusted humans (Issue #1066)",
  () => {
    // `fleetAuthors` gates heartbeat-marker adoption and stale-assignment
    // recovery — "is this one of us?". Since the trusted set is derived from
    // repository collaborators it now names every write-access human, so
    // folding it in would make a colleague's assignment read as fleet
    // occupancy. That is the #1064 shape.
    const derived = recomputeDerivedTrust(
      { allowedAuthors: ["alice"], authorisedCommenters: ["bob"] },
      CTX,
    );
    assertEquals(derived.fleetAuthors, ["worker-bot", "sibling-bot"]);
    // The defer-to set is different by design: a trusted human's open PR
    // still blocks a duplicate, so it keeps them.
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
    // Issue #1066: identity only — `alice` is a trusted human, not the fleet.
    assertEquals(first.fleetAuthors, ["worker-bot", "sibling-bot"]);
    assertEquals(first.fleetPrAuthorInput.allowedAuthors, ["alice"]);

    const second = holder.apply({
      allowedAuthors: ["dave", "erin"],
      authorisedCommenters: ["frank"],
    });

    assertEquals(second.allowedAuthors, ["dave", "erin"]);
    assertEquals(second.authorisedCommenters, ["frank"]);
    assertEquals(second.fleetAuthors, ["worker-bot", "sibling-bot"]);
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
    assertEquals(first.fleetAuthors, ["worker-bot", "sibling-bot"]);
    assertEquals(holder.read().allowedAuthors, ["dave"]);
  },
);
