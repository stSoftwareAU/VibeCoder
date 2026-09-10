/**
 * Tests for pinned_actions.ts — immutable pins for third-party CI
 * components referenced by the emitted workflow templates.
 *
 * Issue #3645: emitted templates must never reference an action by a
 * mutable tag or branch.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  PINNED_ACTIONS,
  pinnedAction,
  SEMGREP_IMAGE,
  SEMGREP_IMAGE_DIGEST,
  SEMGREP_IMAGE_TAG,
} from "../lib/pinned_actions.ts";

Deno.test("pinned_actions - every pin is a 40-char lowercase SHA", () => {
  const entries = Object.entries(PINNED_ACTIONS);
  assertEquals(entries.length > 0, true, "Expected at least one pin");
  for (const [name, pin] of entries) {
    assertEquals(
      /^[0-9a-f]{40}$/.test(pin.sha),
      true,
      `${name}: "${pin.sha}" is not a 40-character lowercase commit SHA`,
    );
    assertEquals(pin.version.trim().length > 0, true, `${name}: empty version`);
    assertEquals(
      /^[\w.-]+\/[\w.-]+$/.test(name),
      true,
      `${name}: not an owner/repo action coordinate`,
    );
  }
});

Deno.test("pinned_actions - pinnedAction renders ref plus version comment", () => {
  const pin = PINNED_ACTIONS["actions/checkout"]!;
  assertEquals(
    pinnedAction("actions/checkout"),
    `actions/checkout@${pin.sha} # ${pin.version}`,
  );
});

Deno.test("pinned_actions - pinnedAction fails loud on an unknown action", () => {
  // A missing pin must never silently degrade to a mutable ref.
  const err = assertThrows(
    () => pinnedAction("evil/unpinned-action"),
    Error,
    "evil/unpinned-action",
  );
  assertEquals(err.message.includes("PINNED_ACTIONS"), true);
});

Deno.test("pinned_actions - semgrep image is digest-pinned", () => {
  assertEquals(
    /^sha256:[0-9a-f]{64}$/.test(SEMGREP_IMAGE_DIGEST),
    true,
    `"${SEMGREP_IMAGE_DIGEST}" is not a sha256 image digest`,
  );
  // Tag + digest since Issue #4403: immutable AND trackable by an updater.
  assertEquals(
    SEMGREP_IMAGE,
    `semgrep/semgrep:${SEMGREP_IMAGE_TAG}@${SEMGREP_IMAGE_DIGEST}`,
  );
  assert(/^\d+\.\d+\.\d+$/.test(SEMGREP_IMAGE_TAG), "release tag shape");
});

Deno.test("pinned_actions - resolution is absent or one of the two modes", () => {
  // Issue #1823: the catalogue is the fallback floor. An absent `resolution`
  // means "release" — the action is resolved against upstream at sync time.
  for (const [name, pin] of Object.entries(PINNED_ACTIONS)) {
    assert(
      pin.resolution === undefined || pin.resolution === "release" ||
        pin.resolution === "catalogue",
      `${name}: unexpected resolution "${pin.resolution}"`,
    );
  }
});

Deno.test("pinned_actions - branch-HEAD pins are never resolved", () => {
  // These two track an upstream default branch, so there is no release series
  // to resolve them against — the recorded SHA is emitted verbatim.
  for (
    const name of [
      "dependency-check/Dependency-Check_Action",
      "ludeeus/action-shellcheck",
    ]
  ) {
    assertEquals(
      PINNED_ACTIONS[name]?.resolution,
      "catalogue",
      `${name}: a branch-HEAD pin must not be resolved against releases`,
    );
  }
});

Deno.test("pinned_actions - most entries resolve against upstream releases", () => {
  const resolved = Object.entries(PINNED_ACTIONS)
    .filter(([, pin]) => (pin.resolution ?? "release") === "release");
  assert(
    resolved.length > Object.keys(PINNED_ACTIONS).length / 2,
    "the catalogue must remain a fallback floor, not the emitted value",
  );
});
