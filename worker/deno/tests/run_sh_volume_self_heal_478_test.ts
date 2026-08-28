/**
 * The launcher recreates a volume it can no longer trim (Issue #478).
 *
 * # The incident
 *
 * Issue #384 made `fstrim` run at every launch and called it "the supported
 * compaction path ... no operator incantation". On the Apple `container`
 * runtime the ioctl is refused outright — as root, on a device that
 * advertises discard — so it has never returned a byte. The `vibe-work`
 * image ratcheted to 26 GB against 12.1 GB of live data, host GRQ-23 sat
 * below its disk floor for three days claiming none of 43 available issues,
 * and the remedy printed in its own alarm (`volume delete vibe-work`) was
 * addressed to a human. An unattended host has no human, so it stays stuck.
 *
 * # What these tests pin
 *
 * The launcher takes the remedy itself, and only when it is warranted:
 *
 *   - a refused trim **on a host short of disk** recreates the volume, using
 *     the same delete/create/re-init path #229 already established for an
 *     unrepairable filesystem;
 *   - a refused trim **on a host with room** changes nothing — recreating
 *     costs a full re-clone of every repository, which is a bad trade for a
 *     runtime that merely never supports discard;
 *   - a recreate that did not clear the floor does not run again next launch.
 *     Re-cloning every repository on every launch for ever is a worse failure
 *     than the one being healed, so the host escalates instead.
 *
 * The floor is driven through `VIBE_HOST_DISK_LOW_FLOOR_GB` /
 * `..._PERCENT` rather than by faking `df`: the real measurement runs, and
 * the test only moves the line it is compared against.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { WORK_VOLUME_NAME } from "../lib/container_launch.ts";
import {
  BASH_LAUNCHER,
  type Harness,
  recorded,
  runCoreLog,
  runLauncher,
  setupHarness,
} from "./fixtures/launcher_harness.ts";

/** The work volume's mount point inside the container. */
const WORK_TARGET = "/home/vibe/auto-issue-work";

/** A host that is, by construction, below its disk floor. */
const BELOW_FLOOR = {
  VIBE_HOST_DISK_LOW_FLOOR_GB: "999999",
  VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "100",
};

/** A host that is, by construction, above its disk floor. */
const ABOVE_FLOOR = {
  VIBE_HOST_DISK_LOW_FLOOR_GB: "0",
  VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "0",
};

async function deletedVolumes(harness: Harness): Promise<string[]> {
  const args = await recorded(harness, "volume-delete");
  return args === null ? [] : args.slice(2);
}

Deno.test("run.sh - a refused trim on a host short of disk recreates the work volume (Issue #478)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: `VOLUME_TRIM_REFUSED ${WORK_TARGET}`,
    ...BELOW_FLOOR,
  });
  try {
    const outcome = await runLauncher(harness, BASH_LAUNCHER);

    assert(
      (await deletedVolumes(harness)).includes(WORK_VOLUME_NAME),
      `the launcher must take the remedy its own alarm prints, rather than ` +
        `addressing it to an operator who may not exist: ${outcome.stderr}`,
    );
    const created = await recorded(harness, "volume-create");
    assert(
      created?.includes(WORK_VOLUME_NAME),
      "a deleted volume must be recreated before the worker runs",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - the recreate is recorded where an operator will find it (Issue #478)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: `VOLUME_TRIM_REFUSED ${WORK_TARGET}`,
    ...BELOW_FLOOR,
  });
  try {
    await runLauncher(harness, BASH_LAUNCHER);
    const log = await runCoreLog(harness);
    assert(
      log.includes(WORK_VOLUME_NAME) && /recreat/i.test(log),
      `a self-heal that re-clones every repository must say so in ` +
        `run_core.log; got: ${log}`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a refused trim on a host with room changes nothing (Issue #478)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: `VOLUME_TRIM_REFUSED ${WORK_TARGET}`,
    ...ABOVE_FLOOR,
  });
  try {
    const outcome = await runLauncher(harness, BASH_LAUNCHER);
    assertEquals(
      (await deletedVolumes(harness)).includes(WORK_VOLUME_NAME),
      false,
      `recreating costs a full re-clone of every repository; a runtime that ` +
        `simply cannot discard must not pay that on a host with room: ` +
        outcome.stderr,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a trim that succeeded never recreates the volume (Issue #478)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    ...BELOW_FLOOR,
  });
  try {
    await runLauncher(harness, BASH_LAUNCHER);
    assertEquals(
      (await deletedVolumes(harness)).includes(WORK_VOLUME_NAME),
      false,
      "a working trim is the healthy path and must never destroy the volume",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a recreate that did not clear the floor does not repeat next launch (Issue #478)", async () => {
  // Same host, same refusal, still below the floor: the first launch heals,
  // the second must not. Re-cloning every repository on every launch for ever
  // is a worse failure than the one being healed.
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: `VOLUME_TRIM_REFUSED ${WORK_TARGET}`,
    ...BELOW_FLOOR,
  });
  try {
    await runLauncher(harness, BASH_LAUNCHER);
    assert(
      (await deletedVolumes(harness)).includes(WORK_VOLUME_NAME),
      "the first launch must heal",
    );

    await Deno.remove(`${harness.recordDir}/volume-delete.args`).catch(
      () => {},
    );

    await runLauncher(harness, BASH_LAUNCHER);
    assertEquals(
      (await deletedVolumes(harness)).includes(WORK_VOLUME_NAME),
      false,
      "a second recreate would re-clone every repository again for nothing",
    );
    const log = await runCoreLog(harness);
    assert(
      /cannot self-heal|already recreated|escalat/i.test(log),
      `a host that recreated and is still below the floor must escalate ` +
        `rather than fall silent; got: ${log}`,
    );
  } finally {
    await harness.cleanup();
  }
});
