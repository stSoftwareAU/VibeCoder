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
import { APPLE_EGRESS_REPORT_FILE } from "../lib/apple_egress.ts";
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

/** The launcher these tests drive: the repository's own run.sh. */
const RUN_SH = `${REPO_ROOT}/run.sh`;

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

/** The paths a recorded Deno invocation granted `--allow-write` to. */
function writeGrants(args: readonly string[]): string[] {
  return args
    .filter((arg) => arg.startsWith("--allow-write="))
    .flatMap((arg) => arg.slice("--allow-write=".length).split(","));
}

/**
 * Whether `path` is inside a granted entry, i.e. the entry is a directory that
 * is the path's parent or one of its ancestors. A file grant covers only that
 * exact file, never its temporary sibling `<file>.tmp.<uuid>`, so a sibling is
 * covered only by a directory grant.
 */
function isWritable(grants: readonly string[], path: string): boolean {
  return grants.some((grant) =>
    path.startsWith(`${grant.replace(/\/+$/, "")}/`)
  );
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

Deno.test("run.sh - apple-egress up is handed the worker's own workdir, a temporary argument file and a report directory under the log directory, and resolves the host config itself (Issues #4051, #750)", async () => {
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
    assert(
      !up.includes("--config"),
      "the launcher no longer resolves the host config; apple-egress resolves it itself",
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

Deno.test("run.sh - the harness drives the repository's own run.sh (Issue #4051)", async () => {
  assertEquals(BASH_LAUNCHER.args, [RUN_SH]);
  assert((await Deno.stat(RUN_SH)).isFile, `${RUN_SH} is not a file`);
});

Deno.test("run.sh - apple-egress is granted write access to the temporary sibling of every file it writes (Issue #4051)", async () => {
  // atomicWrite creates `<file>.tmp.<uuid>` beside its target and renames it
  // into place. A grant for the target alone denies that create; the denial is
  // only a warning, so the proxy log would silently go unsaved.
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "0",
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const up = await recorded(harness, "apple-egress-up");
    const down = await recorded(harness, "apple-egress-down");
    assert(up, "apple-egress up was never run");
    assert(down, "apple-egress down was never run");

    // up writes the report through the same atomic write, into the report
    // directory, so the directory grant must cover its temporary sibling.
    const upGrants = writeGrants(up);
    const reportFile = `${
      up[up.indexOf("--report-dir") + 1] ?? ""
    }/${APPLE_EGRESS_REPORT_FILE}`;
    assert(
      isWritable(upGrants, `${reportFile}.tmp.${crypto.randomUUID()}`),
      `up may not write the report's temporary sibling; granted: ${
        upGrants.join(", ")
      }`,
    );
    // up writes the argument file with a plain write, so the file is granted.
    const outFile = up[up.indexOf("--out") + 1] ?? "";
    assert(
      upGrants.includes(outFile) || isWritable(upGrants, outFile),
      `up may not write its argument file ${outFile}; granted: ${
        upGrants.join(", ")
      }`,
    );

    // down saves the proxy log through the same atomic write.
    const proxyLog = down[down.indexOf("--proxy-log") + 1] ?? "";
    const downGrants = writeGrants(down);
    assert(
      isWritable(downGrants, `${proxyLog}.tmp.${crypto.randomUUID()}`),
      `down may not write the proxy log's temporary sibling of ${proxyLog}; granted: ${
        downGrants.join(", ")
      }`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - apple-egress that hands back an argument key other than arg stops the launch closed (Issue #4051)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "0",
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
    STUB_APPLE_EGRESS_KEY: "env",
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 1, outcome.stderr);
    assertStringIncludes(
      outcome.stderr,
      "unrecognised apple-egress argument key: env - refusing to launch",
    );
    assertEquals(
      await recorded(harness, "run"),
      null,
      "a token the launcher cannot place must not reach a worker launch",
    );
    assert(
      await recorded(harness, "apple-egress-down"),
      "containment was brought up and must be taken down on the refusal",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - apple-egress up that refuses a host config naming two files (exit 2, not 10) stops the launch closed and forwards its reason (Issue #750)", async () => {
  // The real resolver message is pinned in apple_egress_command_test.ts, where
  // `up` runs for real. Here the stub's `up` says the same thing on stderr and
  // exits 2, which is what the launcher must act on: refuse, and not launch.
  const reason =
    "[egress] apple-egress: CONFIG_FILE and CONFIG_PATH are both set and name different files";
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_APPLE_EGRESS_UP_EXIT: "2",
    STUB_APPLE_EGRESS_STDERR: reason,
    STUB_APPLE_EGRESS_ARGS: APPLE_EGRESS_TOKENS,
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 1, outcome.stderr);
    assertStringIncludes(outcome.stderr, reason);
    assertStringIncludes(outcome.stderr, "could not be brought up (status 2)");
    assertEquals(
      await recorded(harness, "run"),
      null,
      "the worker must not launch when the host config is in conflict",
    );
  } finally {
    await harness.cleanup();
  }
});
