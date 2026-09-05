/**
 * Tests for the sandbox-start contract constants (Issue #981, parent #933).
 *
 * The module's whole reason for existing is that the abort status must be the
 * framework's own: a start script exiting 75 would otherwise be recorded as a
 * deliberate quota pause, which resets the failure streak and escalates
 * nothing — the silent failure this contract exists to prevent. That property
 * is asserted here against the real constants rather than described in a
 * comment, so a future status added anywhere in the fleet cannot quietly
 * collide with it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  EXTENSION_PREFIX,
  EXTENSION_START_ABORT_EXIT_STATUS,
  EXTENSION_START_ENV,
} from "../lib/container_extension_start.ts";
import { EXTENSION_START_BUILD_ARG } from "../lib/container_extension_build.ts";
import { CONTAINER_START_EXIT_CODES } from "../lib/container_restart_backoff.ts";
import { CONTAINER_WEDGED_EXIT_STATUS } from "../lib/container_watchdog.ts";
import { QUOTA_PAUSE_EXIT_STATUS } from "../lib/quota_pause.ts";
import { BUILD_NOT_HEALABLE_EXIT } from "../commands/container_build_heal.ts";
import { ANOTHER_WORKER_RUNNING_EXIT } from "../commands/container_reap.ts";

Deno.test("the abort status collides with no status the fleet already reads (Issue #981)", () => {
  const taken = [
    0,
    1,
    QUOTA_PAUSE_EXIT_STATUS,
    BUILD_NOT_HEALABLE_EXIT,
    ANOTHER_WORKER_RUNNING_EXIT,
    CONTAINER_WEDGED_EXIT_STATUS,
    ...CONTAINER_START_EXIT_CODES,
  ];

  assert(
    !taken.includes(EXTENSION_START_ABORT_EXIT_STATUS),
    `the abort status ${EXTENSION_START_ABORT_EXIT_STATUS} is already read as ` +
      `something else (${taken.join(", ")})`,
  );
  // A status a shell can actually return: bash truncates an exit to 8 bits,
  // and 126–255 carry the runtime's and the signal conventions' own meanings.
  assert(
    EXTENSION_START_ABORT_EXIT_STATUS > 0 &&
      EXTENSION_START_ABORT_EXIT_STATUS < 125,
  );
});

Deno.test("the start path is one literal on both sides of the image (Issue #981)", () => {
  // The build records it and the entrypoint reads it back; a rename that moved
  // only one of them would leave the entrypoint watching for an environment
  // variable the launcher never sets.
  assertEquals(EXTENSION_START_BUILD_ARG, EXTENSION_START_ENV);
});

Deno.test("the extension prefix is the contract path, absolute and fixed (Issue #981)", () => {
  // The operator's Containerfile copies the extension here, so this value is
  // part of the published contract rather than an implementation detail.
  assertEquals(EXTENSION_PREFIX, "/opt/vibe-extension");
});
