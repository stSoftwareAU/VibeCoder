/**
 * `./run.sh upgrade` — the launcher entry point (Issue #691, part of #674).
 *
 * The upgrade itself is the Deno `upgrade` command; `run.sh` only routes to
 * it, so that is what these tests assert. The real launcher is run under the
 * shared harness, with Deno replaced by the recording stub, and the
 * invocation it constructed is read back: the sub-command, the checkout it
 * was pointed at, the status it propagated — and that no container was
 * launched, because an upgrade rewrites `.config.json` and nothing else.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { UPGRADE_COMMAND_NAME } from "../commands/upgrade.ts";
import {
  invocationOrder,
  type LauncherInvocation,
  recorded,
  REPO_ROOT,
  runLauncher,
  setupHarness,
} from "./fixtures/launcher_harness.ts";

/** `run.sh upgrade`, run through bash. */
const UPGRADE_LAUNCHER: LauncherInvocation = {
  name: "run.sh upgrade",
  command: "bash",
  args: [`${REPO_ROOT}/run.sh`, UPGRADE_COMMAND_NAME],
};

Deno.test("run.sh upgrade - delegates to the Deno upgrade command for this checkout", async () => {
  const harness = await setupHarness();
  try {
    const outcome = await runLauncher(harness, UPGRADE_LAUNCHER);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, UPGRADE_COMMAND_NAME);
    assert(args, "the launcher never invoked the upgrade command");
    assertEquals(args.includes(UPGRADE_COMMAND_NAME), true);
    assertEquals(args.includes(`${REPO_ROOT}/worker/deno/mod.ts`), true);
    assertEquals(
      args[args.indexOf("--base-dir") + 1],
      REPO_ROOT,
      "the upgrade must be pointed at this checkout",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh upgrade - starts no container and launches no worker", async () => {
  const harness = await setupHarness();
  try {
    const outcome = await runLauncher(harness, UPGRADE_LAUNCHER);
    assertEquals(outcome.code, 0, outcome.stderr);

    assertEquals(await invocationOrder(harness), []);
    assertEquals(await recorded(harness, "worker-checkout-update"), null);
    assertEquals(await recorded(harness, "container-launch-plan"), null);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh upgrade - a refused upgrade is the launcher's exit status", async () => {
  const harness = await setupHarness({ STUB_UPGRADE_EXIT: "1" });
  try {
    const outcome = await runLauncher(harness, UPGRADE_LAUNCHER);
    assertEquals(outcome.code, 1);
    assert(await recorded(harness, UPGRADE_COMMAND_NAME));
  } finally {
    await harness.cleanup();
  }
});
