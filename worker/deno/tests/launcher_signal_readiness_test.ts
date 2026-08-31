/**
 * The launcher tests' readiness gate must mean "ready to be signalled"
 * (Issue #668).
 *
 * The SIGTERM cases wait for a stub's invocation record and then signal the
 * launcher. That only holds if the stub can already handle TERM when it writes
 * the record: a trap installed afterwards leaves a window where TERM takes its
 * default disposition, the stub dies without writing its marker, and the test
 * fails reading a file that was never created — which is exactly how
 * `validate (container)` failed on a docs-only PR.
 *
 * The window is normally microseconds wide, so these cases hold each stub
 * inside it on purpose (`STUB_READY_DELAY`) and signal it there. `run.sh` is
 * covered the same way at both ends of its own launch: a signal that arrives
 * before any container exists must still fail loud, and one that arrives after
 * the container is recorded must reach it.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  BASH_LAUNCHER,
  type Harness,
  recorded,
  setupHarness,
  spawnLauncher,
  stubPath,
  waitForRecord,
} from "./fixtures/launcher_harness.ts";

/** Long enough to swamp the 100 ms record poll, short enough to stay a unit test. */
const READY_DELAY_SECONDS = "2";

/** How long a stub pretends to be a running container. */
const CONTAINER_LIFETIME_SECONDS = "60";

/** True when the stub wrote the named marker file. */
async function marker(
  harness: Harness,
  name: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${harness.recordDir}/${name}`);
  } catch {
    return null;
  }
}

Deno.test("runtime stub - a TERM in the window after the run record still writes the marker (Issue #668)", async () => {
  const harness = await setupHarness();
  try {
    const stub = new Deno.Command(stubPath(harness, "container"), {
      args: ["run", "--name", "vibe-coder-test", "image:latest"],
      clearEnv: true,
      env: {
        ...harness.env,
        STUB_RUN_SLEEP: CONTAINER_LIFETIME_SECONDS,
        STUB_READY_DELAY: READY_DELAY_SECONDS,
        STUB_RUN_SIGNAL_EXIT: "143",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    assert(
      await waitForRecord(harness, "run"),
      "the stub never recorded the run",
    );
    // Inside the stall the record gates: the stub has recorded the run and
    // has not reached its sleep yet, which is where a CI runner descheduled it.
    stub.kill("SIGTERM");
    const output = await stub.output();

    assertEquals(
      await marker(harness, "terminated"),
      "terminated",
      "the record must not be published before the stub can handle TERM",
    );
    assertEquals(output.code, 143, new TextDecoder().decode(output.stderr));
  } finally {
    await harness.cleanup();
  }
});

Deno.test("deno stub - a TERM in the window after the run-entrypoint record still writes the marker (Issue #668)", async () => {
  const harness = await setupHarness({}, { denoStub: true });
  try {
    const stub = new Deno.Command(stubPath(harness, "deno"), {
      args: ["run", "mod.ts", "run-entrypoint"],
      clearEnv: true,
      env: {
        ...harness.env,
        STUB_ENTRYPOINT_SLEEP: CONTAINER_LIFETIME_SECONDS,
        STUB_READY_DELAY: READY_DELAY_SECONDS,
        STUB_ENTRYPOINT_SIGNAL_EXIT: "143",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    assert(
      await waitForRecord(harness, "run-entrypoint"),
      "the stub never recorded the entrypoint run",
    );
    stub.kill("SIGTERM");
    const output = await stub.output();

    assertEquals(
      await marker(harness, "entrypoint-terminated"),
      "terminated",
      "the entrypoint record must not be published before TERM is handled",
    );
    assertEquals(output.code, 143, new TextDecoder().decode(output.stderr));
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a SIGTERM held while the launch is in flight reaches the container (Issue #668)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_RUN_SLEEP: CONTAINER_LIFETIME_SECONDS,
    STUB_READY_DELAY: READY_DELAY_SECONDS,
    STUB_RUN_SIGNAL_EXIT: "143",
  });
  try {
    const child = spawnLauncher(harness, BASH_LAUNCHER);
    assert(
      await waitForRecord(harness, "run"),
      "the container never started",
    );

    child.kill("SIGTERM");
    const output = await child.output();

    assertEquals(
      await marker(harness, "terminated"),
      "terminated",
      "the container must receive the termination signal",
    );
    assertEquals(output.code, 143, new TextDecoder().decode(output.stderr));
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a SIGTERM before any container exists still fails loud (Issue #668)", async () => {
  const harness = await setupHarness({
    // No image locally, so the launch stalls in the build - before any
    // container, and so before the launcher has a child to forward to.
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_READY_DELAY: READY_DELAY_SECONDS,
    STUB_READY_DELAY_SUB: "build",
  });
  try {
    const child = spawnLauncher(harness, BASH_LAUNCHER);
    assert(
      await waitForRecord(harness, "build"),
      "the image was never built",
    );

    child.kill("SIGTERM");
    const output = await child.output();

    // Holding a signal for a launch that has not happened would hang the
    // launcher, and swallowing it would report a clean exit it never had.
    assert(
      output.code !== 0,
      "a terminated launcher must report failure, never a clean exit",
    );
    assertEquals(
      await marker(harness, "terminated"),
      null,
      "there was no container to forward the signal to",
    );
    assertEquals(
      await recorded(harness, "run"),
      null,
      "a terminated build must not fall through to a launch",
    );
  } finally {
    await harness.cleanup();
  }
});
