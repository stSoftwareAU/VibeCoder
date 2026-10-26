/**
 * Apple container egress containment in run.sh (Issue #4051).
 *
 * `run.sh` brings containment up after the image exists and before the worker
 * starts, splices the arguments it hands back into the worker's run command
 * straight after `run` (ahead of the image reference), and takes containment
 * down on every exit path. These tests drive the real launcher under the shared
 * harness, with `apple-egress` answered by the stub, and assert on what the
 * launcher did:
 *
 *   - not applicable (exit 10): the worker is launched exactly as before;
 *   - up (exit 0): the arguments land after `run` and before the image, the
 *     command gets the worker's own --workdir and the host config, and `down`
 *     runs on the way out - a normal finish, a failed worker or a signal alike;
 *   - anything else: `down` is asked once, best-effort, the worker is NOT
 *     launched, the launch exits non-zero and the host is parked on the
 *     container_egress phase.
 *
 * Not covered here: the no-tee branch of the worker launch. run.sh appends the
 * system PATH, so `tee` is always found and that branch cannot be reached from
 * a test. Its run command carries the same argument expansion as the tee branch.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { containerTargetPaths } from "../lib/container_launch.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import {
  BASH_LAUNCHER,
  denoInvocationOrder,
  type Harness,
  type LaunchOutcome,
  launchPhaseMarker,
  recorded,
  REPO_ROOT,
  runCoreLog,
  runLauncher as runHarnessLauncher,
  setupHarness,
  spawnLauncher as spawnHarnessLauncher,
  waitForRecord,
} from "./fixtures/launcher_harness.ts";

const MANIFEST = parseContainerManifest(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
);
const TARGETS = containerTargetPaths(MANIFEST);
const IMAGE = await resolveContainerImageReference(REPO_ROOT);

/** The containment arguments the stub hands back, one token per line. */
const APPLE_EGRESS_TOKENS =
  "--network\nvibe-egress-4051\n--label\nvibe-egress=4051";

/** Those tokens as they must appear in the worker's run command. */
const SPLICED = [
  "--network",
  "vibe-egress-4051",
  "--label",
  "vibe-egress=4051",
];

/** Run `run.sh` under the shared launcher harness. */
function runLauncher(harness: Harness): Promise<LaunchOutcome> {
  return runHarnessLauncher(harness, BASH_LAUNCHER);
}

/**
 * Give the launcher a private TMPDIR, so the temporary files it creates are
 * visible to this test alone and not to whatever else shares /tmp.
 */
async function privateTmp(harness: Harness): Promise<string> {
  const dir = `${harness.tmpDir}/tmp`;
  await Deno.mkdir(dir, { recursive: true });
  harness.env.TMPDIR = dir;
  return dir;
}

/** How many times the launcher invoked `apple-egress`, `up` and `down` alike. */
async function appleEgressInvocations(harness: Harness): Promise<number> {
  return (await denoInvocationOrder(harness)).filter((command) =>
    command === "apple-egress"
  ).length;
}

/** Containment's own temporary files still present in a directory. */
async function containmentLeftovers(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith("vibe-apple-egress-")) names.push(entry.name);
  }
  return names.sort();
}

Deno.test("run.sh - apple-egress exit 10 (not Apple container) launches the worker exactly as before (Issue #4051)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "10",
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "run");
    assert(args, `the worker was never launched: ${outcome.stderr}`);
    assertEquals(args[0], "run");
    assertEquals(
      args[1],
      "--rm",
      `nothing may be spliced in after run: ${args.join(" ")}`,
    );
    assert(
      !args.includes("vibe-egress-4051"),
      "containment arguments must not reach a launch that is not contained by them",
    );
    assertEquals(args.at(-1), IMAGE, "the image reference stays last");

    assert(
      await recorded(harness, "apple-egress-up"),
      "apple-egress up was never run",
    );
    assertEquals(
      await appleEgressInvocations(harness),
      1,
      "only up is asked; nothing was brought up, so nothing is taken down",
    );
    assertEquals(
      await recorded(harness, "apple-egress-down"),
      null,
      "nothing was brought up, so nothing is taken down",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - apple-egress exit 0 splices its arguments after run, ahead of the image (Issue #4051)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "0",
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "run");
    assert(args, `the worker was never launched: ${outcome.stderr}`);
    assertEquals(
      args.slice(0, 1 + SPLICED.length),
      ["run", ...SPLICED],
      `the containment arguments must sit straight after run: ${
        args.join(" ")
      }`,
    );
    assertEquals(args[1 + SPLICED.length], "--rm");
    assertEquals(args.at(-1), IMAGE, "the image reference stays last");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - apple-egress up is handed the worker's own workdir, the host config, a temporary argument file and a report directory under the log directory (Issue #4051)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "0",
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
  }, { denoStub: true });
  const tmp = await privateTmp(harness);
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const up = await recorded(harness, "apple-egress-up");
    assert(up, "apple-egress up was never run");
    assertEquals(
      up[up.indexOf("--action") + 1],
      "up",
      "the subcommand is selected by --action",
    );
    assertEquals(
      up[up.indexOf("--workdir") + 1],
      TARGETS.base,
      "the in-container checkout is the worker's own --workdir",
    );
    assertEquals(
      up[up.indexOf("--config") + 1],
      harness.env.CONFIG_PATH,
      "the host configuration is the one the worker resolves",
    );
    const outFile = up[up.indexOf("--out") + 1] ?? "";
    assert(
      outFile.startsWith(`${tmp}/`),
      `the argument file must be a temporary of this run: ${outFile}`,
    );
    const reportDir = up[up.indexOf("--report-dir") + 1] ?? "";
    assertEquals(
      reportDir,
      `${harness.logDir}/apple-egress`,
      "the report directory is kept under the log directory, so its per-control results persist",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - apple-egress down runs on a normal exit, keeps the proxy log and the report directory, and removes the argument file (Issue #4051)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "0",
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
  }, { denoStub: true });
  const tmp = await privateTmp(harness);
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const run = await recorded(harness, "run");
    assert(run, `the worker was never launched: ${outcome.stderr}`);
    assertEquals(
      await appleEgressInvocations(harness),
      2,
      "one up and one down, and no second down on the way out",
    );
    const down = await recorded(harness, "apple-egress-down");
    assert(down, "containment was brought up and never taken down");
    assertEquals(
      down[down.indexOf("--action") + 1],
      "down",
      "the subcommand is selected by --action",
    );
    assertEquals(
      down[down.indexOf("--name") + 1],
      run[run.indexOf("--name") + 1],
      "down names the worker container it is taking containment down for",
    );
    assertEquals(
      down[down.indexOf("--proxy-log") + 1],
      `${harness.logDir}/apple-egress-proxy.log`,
      "the proxy log is kept beside the run's other logs",
    );
    assertEquals(
      await containmentLeftovers(tmp),
      [],
      "the argument file is removed on exit",
    );
    const up = await recorded(harness, "apple-egress-up");
    const reportDir = up?.[up.indexOf("--report-dir") + 1] ?? "";
    assertEquals(
      reportDir,
      `${harness.logDir}/apple-egress`,
      "the report directory is under the log directory",
    );
    const reportStat = await Deno.stat(reportDir);
    assert(
      reportStat.isDirectory,
      `the report directory must still exist after exit: ${reportDir}`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - apple-egress down runs when the worker exits non-zero (Issue #4051)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "0",
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
    STUB_RUN_EXIT: "125",
    STUB_RUN_STDERR: "Error: no such image",
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 125, outcome.stderr);
    assert(
      await recorded(harness, "apple-egress-down"),
      "a worker that failed left containment up",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - apple-egress down runs when the launch is signalled (Issue #4051)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "0",
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
    STUB_RUN_SLEEP: "60",
    STUB_RUN_SIGNAL_EXIT: "143",
  }, { denoStub: true });
  try {
    const child = spawnHarnessLauncher(harness, BASH_LAUNCHER);
    assert(
      await waitForRecord(harness, "run"),
      "the container never started",
    );

    child.kill("SIGTERM");
    const output = await child.output();
    assertEquals(
      output.code,
      143,
      new TextDecoder().decode(output.stderr),
    );
    assert(
      await recorded(harness, "apple-egress-down"),
      "a signalled launch left containment up",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - apple-egress that cannot bring containment up stops the launch closed (Issue #4051)", async () => {
  for (const status of ["1", "124"]) {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_APPLE_EGRESS_UP_EXIT: status,
      STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
    }, { denoStub: true });
    try {
      const outcome = await runLauncher(harness);
      assertEquals(
        outcome.code,
        1,
        `status ${status}: ${outcome.stderr}`,
      );
      assertEquals(
        await recorded(harness, "run"),
        null,
        `status ${status}: the worker must not launch without its containment`,
      );
      assertEquals(
        await appleEgressInvocations(harness),
        2,
        `status ${status}: one up, then one best-effort down`,
      );
      assert(
        await recorded(harness, "apple-egress-down"),
        `status ${status}: a failed up is taken down before the refusal`,
      );
      assertStringIncludes(
        outcome.stderr,
        "could not be brought up",
        `status ${status}`,
      );
      assertEquals(
        await launchPhaseMarker(harness),
        "container_egress",
        `status ${status}: the failure is attributed to containment`,
      );
      assertStringIncludes(
        await runCoreLog(harness),
        `apple-egress: containment could not be brought up (status ${status})`,
      );
    } finally {
      await harness.cleanup();
    }
  }
});
