/**
 * Tests for the explicit store-initialisation marker (Issue #4215).
 *
 * #3717 inferred "a baseline once existed" from the store *directory's*
 * existence — sound while the store was created only by a successful write.
 * The named-volume migration (#4203) broke the inference: the store is now
 * the `vibe-approval-state` volume mountpoint, which always exists (and
 * carries ext4's `lost+found`), so a fresh host read as "initialised store,
 * state deleted" and every claimable issue fleet-wide blocked with
 * CONTENT_CHECK_ERROR — observed live on host-23, 2026-08-17.
 *
 * Initialisation is now an explicit record: a `.store_initialised` marker
 * written beside the state on every successful persist. These tests run
 * against the real filesystem, because the regression lives precisely in
 * the default (non-injected) probes.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  captureContentSnapshot,
  resetContentApprovalRunState,
  verifyContentUnchanged,
} from "../lib/content_approval_tracker.ts";

const TITLE = "Fix the bug";
const BODY = "Body text";

/** A store directory shaped like the fresh volume mountpoint. */
async function makeMountpointStore(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "approval_store_marker_" });
  // The mountpoint always exists and carries the ext4 artefact.
  await Deno.mkdir(`${dir}/lost+found`);
  return dir;
}

Deno.test("approval store - a bare volume mountpoint is not an initialised store (Issue #4215)", async () => {
  resetContentApprovalRunState();
  const stateDir = await makeMountpointStore();
  try {
    const result = await verifyContentUnchanged(
      stateDir,
      "org/repo",
      42,
      TITLE,
      BODY,
    );
    // A never-initialised store is the ordinary first encounter — never the
    // fail-closed "state deleted" fault that blocked every claim.
    assertEquals(result.status, "no_snapshot", JSON.stringify(result));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("approval store - a successful persist writes the initialisation marker (Issue #4215)", async () => {
  resetContentApprovalRunState();
  const stateDir = await makeMountpointStore();
  try {
    const captured = await captureContentSnapshot(
      stateDir,
      "org/repo",
      42,
      TITLE,
      BODY,
      "author",
    );
    assert(captured.ok, `capture failed: ${!captured.ok && captured.error}`);
    assertEquals(
      (await Deno.stat(`${stateDir}/.store_initialised`)).isFile,
      true,
      "the marker must be the durable record that a baseline once existed",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("approval store - state deleted while the marker survives still fails closed (Issue #4215)", async () => {
  resetContentApprovalRunState();
  const stateDir = await makeMountpointStore();
  try {
    const captured = await captureContentSnapshot(
      stateDir,
      "org/repo",
      42,
      TITLE,
      BODY,
      "author",
    );
    assert(captured.ok);

    // The #3717 accident class: the state file vanishes from a store that
    // demonstrably held a baseline. The tamper gate must stay armed.
    await Deno.remove(`${stateDir}/.content_approval_state.json`);
    resetContentApprovalRunState();
    const result = await verifyContentUnchanged(
      stateDir,
      "org/repo",
      42,
      TITLE,
      BODY,
    );
    assertEquals(result.status, "error", JSON.stringify(result));
    assert(
      (result.status === "error" ? result.message : "").includes("deleted"),
      "a deleted baseline must be named as such",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("approval store - a legacy store (state file, no marker) keeps working across the upgrade (Issue #4215)", async () => {
  resetContentApprovalRunState();
  const stateDir = await Deno.makeTempDir({ prefix: "approval_store_legacy_" });
  try {
    // Persist, then strip the marker to model a pre-#4215 store.
    const captured = await captureContentSnapshot(
      stateDir,
      "org/repo",
      42,
      TITLE,
      BODY,
      "author",
    );
    assert(captured.ok);
    await Deno.remove(`${stateDir}/.store_initialised`);

    resetContentApprovalRunState();
    const unchanged = await verifyContentUnchanged(
      stateDir,
      "org/repo",
      42,
      TITLE,
      BODY,
    );
    assertEquals(unchanged.status, "unchanged", JSON.stringify(unchanged));

    // And a deletion in the legacy store is still caught: the state file's
    // own prior existence is not observable, but the marker-less initialised
    // check falls back to the state file, so with BOTH gone the store reads
    // as never-initialised — the documented deliberate-reset semantics.
    await Deno.remove(`${stateDir}/.content_approval_state.json`);
    resetContentApprovalRunState();
    const afterDeletion = await verifyContentUnchanged(
      stateDir,
      "org/repo",
      42,
      TITLE,
      BODY,
    );
    assertEquals(afterDeletion.status, "no_snapshot");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
