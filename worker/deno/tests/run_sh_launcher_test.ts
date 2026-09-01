/**
 * Tests for run.sh as a launcher (Issues #4065, #4148).
 *
 * `run.sh` is the trusted containment boundary: whatever it hands the
 * container runtime is exactly what the worker can reach. These tests replace
 * the runtime executable with a recording stub on PATH and run the real
 * `run.sh`, then assert on the invocation it actually constructed - the
 * mounts, the absence of a runtime socket, of `--privileged`, of host
 * networking and of published ports - so a future edit that broadens the
 * container's privileges fails here in the `Validate Scripts` workflow.
 *
 * Containment is mandatory (Issue #4): the host-native run mode (#4148) and
 * the macOS seatbelt mode (#4300) are gone. The cases at the foot of this
 * file hold the line that matters: container is what runs, a configuration
 * naming a removed mode fails loud and launches nothing, and a missing
 * container runtime never quietly becomes a host run.
 *
 * The end-to-end containment behaviour (a container genuinely cannot read
 * prohibited host paths) is verified separately by the containment
 * integration tests.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  APPROVAL_STATE_VOLUME_NAME,
  containerTargetPaths,
  WORK_VOLUME_NAME,
} from "../lib/container_launch.ts";
import {
  candidatesForPlatform,
  normaliseHostPlatform,
} from "../lib/container_runtime.ts";
import { CONTAINER_START_EXIT_CODES } from "../lib/container_restart_backoff.ts";
import { CONTAINER_WEDGED_EXIT_STATUS } from "../lib/container_watchdog.ts";
import { stripContainerfile } from "../lib/containerfile_strip.ts";
import { activeAgentProvider } from "../lib/agent_provider.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import { formatReleaseNotice } from "../lib/release_notice.ts";
import {
  BASH_LAUNCHER,
  buildCount,
  builderHealed,
  denoInvocationOrder,
  type Harness,
  initCount,
  invocationOrder,
  type LaunchOutcome,
  mountValues,
  recorded,
  recordedLaunchLog,
  removedImages,
  removedVolumes,
  REPO_ROOT,
  runCoreLog,
  runLauncher as runHarnessLauncher,
  setupHarness,
  spawnLauncher as spawnHarnessLauncher,
  waitForRecord,
} from "./fixtures/launcher_harness.ts";

const RUN_SH = `${REPO_ROOT}/run.sh`;

const MANIFEST = parseContainerManifest(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
);
const TARGETS = containerTargetPaths(MANIFEST);
const PROVIDER_SUBDIR = activeAgentProvider().credentials.subdir;
const IMAGE = await resolveContainerImageReference(REPO_ROOT);

/** Run `run.sh` under the shared launcher harness. */
function runLauncher(harness: Harness): Promise<LaunchOutcome> {
  return runHarnessLauncher(harness, BASH_LAUNCHER);
}

/** Start `run.sh` under the shared launcher harness. */
function spawnLauncher(harness: Harness): Deno.ChildProcess {
  return spawnHarnessLauncher(harness, BASH_LAUNCHER);
}

Deno.test("run.sh - launches the container with exactly the permitted mounts", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "run");
    assert(args, `no container run was recorded: ${outcome.stderr}`);
    assertEquals(args[0], "run");

    assertEquals(mountValues(args), [
      // The checkout is read-only (Issue #514): the worker never modifies
      // the code it is running.
      `${REPO_ROOT}:${TARGETS.base}:ro`,
      // The work dir and its approval-state sibling ride named volumes
      // (Issue #4186): no host directory holds the worker's repositories.
      `${WORK_VOLUME_NAME}:${TARGETS.work}`,
      `${APPROVAL_STATE_VOLUME_NAME}:${TARGETS.approvalState}`,
      `${harness.tmpDir}/home/logs:${TARGETS.logs}`,
      `${harness.tmpDir}/home/.vibe-coder/run-config:${TARGETS.config}:ro`,
      // Issue #4067: only the worker's `gh` material and the active
      // provider's credential sub-directory are exposed.
      `${harness.tmpDir}/credentials/gh:${TARGETS.credentials}/gh:ro`,
      `${harness.tmpDir}/credentials/${PROVIDER_SUBDIR}:` +
      `${TARGETS.credentials}/${PROVIDER_SUBDIR}:ro`,
    ]);

    // The read/write host mounts are created by the launcher, so the runtime
    // never invents a root-owned empty directory for them.
    assertEquals(
      (await Deno.stat(`${harness.tmpDir}/home/logs`)).isDirectory,
      true,
    );

    // The image is present, so nothing was built.
    assertEquals(await recorded(harness, "build"), null);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - ensures the named volumes and runs the ownership init (Issue #4186)", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    // The stub reports every volume absent, so both are created.
    const inspect = await recorded(harness, "volume-inspect");
    assert(inspect, `no volume presence check was made: ${outcome.stderr}`);
    const create = await recorded(harness, "volume-create");
    assert(create, "an absent volume must be created");
    assertEquals(create[0], "volume");
    assertEquals(create[1], "create");
    assertEquals(create[2], APPROVAL_STATE_VOLUME_NAME);

    // The ownership init: root chowns the volume mount roots to the image's
    // worker account before the worker starts, and nothing else — no host
    // mount, no credentials, no config.
    const init = await recorded(harness, "run-init");
    assert(init, "the volume-ownership init must run before the worker");
    assertEquals(init.includes("--user"), true);
    assertEquals(init[init.indexOf("--user") + 1], "0:0");
    assertEquals(
      init[init.indexOf("--entrypoint") + 1],
      "/usr/local/bin/vibe-volume-init",
    );
    assertEquals(mountValues(init), [
      `${WORK_VOLUME_NAME}:${TARGETS.work}`,
      `${APPROVAL_STATE_VOLUME_NAME}:${TARGETS.approvalState}`,
    ]);

    // The worker itself still ran.
    assert(await recorded(harness, "run"));
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a volume that already exists is not recreated, but is still re-owned", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_VOLUME_INSPECT_EXIT: "0",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assert(await recorded(harness, "volume-inspect"));
    assertEquals(
      await recorded(harness, "volume-create"),
      null,
      "an existing volume must not be recreated",
    );
    // The init is idempotent and runs every launch, so a first launch that
    // died between create and chown heals here instead of wedging forever.
    assert(await recorded(harness, "run-init"));
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - passes the real host identity into the container (VIBE_HOST_ID)", async () => {
  // End-to-end through the REAL plan command under run.sh's restricted Deno
  // sandbox. Regression: the plan invocation lacked --allow-sys=hostname, so
  // Deno.hostname() threw, the silent catch dropped the host id, and fleet
  // heartbeats reported the ephemeral container name (observed live:
  // "Reporting health as Vibe Coder:vibe-coder-98446" while the FLEET-health
  // board showed host-23 dead all day).
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "run");
    assert(args, `no container run was recorded: ${outcome.stderr}`);
    const expected = `VIBE_HOST_ID=${Deno.hostname().split(".")[0]}`;
    assert(
      args.includes(expected),
      `container run must carry ${expected}; env args were: ${
        args.filter((a, i) => a === "--env" || args[i - 1] === "--env").join(
          " ",
        )
      }`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - passes the supervisor run cap into the container (Issue #421)", async () => {
  // The bound the worker's progress-extension policy applies. If a launcher
  // refactor drops this passthrough the worker silently applies no ceiling
  // and a progressing run walks into loop.sh's `timeout` SIGTERM — no
  // orderly WIP commit window, and a launcher failure against the host.
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    VIBE_RUN_MAX_SECONDS: "10800",
    VIBE_RUN_STARTED_EPOCH: "1700000000",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "run");
    assert(args, `no container run was recorded: ${outcome.stderr}`);
    for (
      const expected of [
        "VIBE_RUN_MAX_SECONDS=10800",
        "VIBE_RUN_STARTED_EPOCH=1700000000",
      ]
    ) {
      assert(
        args.includes(expected),
        `container run must carry ${expected}; got: ${args.join(" ")}`,
      );
    }
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - no supervisor cap in the environment leaves the worker uncapped (Issue #421)", async () => {
  // A launcher invoked outside loop.sh publishes nothing, and the worker
  // extends exactly as it did before the cap existed.
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);
    const args = await recorded(harness, "run");
    assert(args, `no container run was recorded: ${outcome.stderr}`);
    assert(
      !args.some((arg) => arg.startsWith("VIBE_RUN_")),
      `no run-cap env should be passed; got: ${args.join(" ")}`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - never mounts the host home, a runtime socket, or opens the container up", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "run");
    assert(args);

    for (const value of mountValues(args)) {
      const source = value.split(":")[0]!;
      assertEquals(
        source,
        source.replace(/\.sock$/, ""),
        "no container-runtime control socket may be mounted",
      );
      assertEquals(
        source === `${harness.tmpDir}/home`,
        false,
        "the host home directory must never be mounted wholesale",
      );
    }

    for (
      const flag of [
        "--privileged",
        "--publish",
        "-p",
        "--publish-all",
        "-P",
        "--cap-add",
        "--device",
        "--network=host",
        "--net=host",
        "--pid=host",
        "--userns=host",
      ]
    ) {
      assertEquals(
        args.includes(flag),
        false,
        `the container must not be started with ${flag}`,
      );
    }

    const networkIndex = args.indexOf("--network");
    if (networkIndex >= 0) {
      assertEquals(args[networkIndex + 1], "bridge");
    }
    assertEquals(args.includes("--rm"), true);
    assertEquals(args[args.length - 1], IMAGE);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - builds the image when the content-derived reference is absent", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "1" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const inspect = await recorded(harness, "image") ??
      await recorded(harness, "images");
    assert(inspect, "the launcher must check whether the image is present");
    assertEquals(inspect[inspect.length - 1], IMAGE);

    const build = await recorded(harness, "build");
    assert(build, "an absent image reference must trigger a build");
    assertEquals(build[0], "build");
    assertEquals(build.includes(IMAGE), true);
    // Issue #4393: the build reads a comment-stripped copy written beside
    // the plan file, never the committed Containerfile; the context is still
    // the container/ directory.
    const fileArg = build[build.indexOf("--file") + 1] ?? "";
    assert(
      /vibe-launch-plan\.[^/]+\.Containerfile$/.test(fileArg),
      `--file must name the stripped copy: ${fileArg}`,
    );
    assertEquals(build.at(-1), `${REPO_ROOT}/container`);
    const built = await Deno.readTextFile(
      `${harness.recordDir}/build.containerfile`,
    );
    const committed = await Deno.readTextFile(
      `${REPO_ROOT}/container/Containerfile`,
    );
    assertEquals(built, stripContainerfile(committed));
    assert(!built.includes("\n#"), "no comment lines survive the strip");
    // ...and the copy is gone once the launcher exits.
    assertEquals(await exists(fileArg), false);

    // The build is not the end of the launch - the worker still starts.
    assert(await recorded(harness, "run"));
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Pruning superseded image tags (Issue #4162)
// ---------------------------------------------------------------------------

/** A local image store holding the current reference and two superseded ones. */
const SUPERSEDED = ["vibe-coder:aaaaaaaaaaaa", "vibe-coder:bbbbbbbbbbbb"];
const IMAGE_STORE = [
  IMAGE,
  ...SUPERSEDED,
  // Not ours: neither may be touched.
  "node:22",
  "ghcr.io/other/vibe-coder:latest",
].join("\n");

Deno.test("run.sh - prunes every superseded vibe-coder tag (Issue #4162)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_IMAGE_LIST: IMAGE_STORE,
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    // Exactly the superseded tags of our own image - the current reference and
    // every foreign image are left alone.
    assertEquals(await removedImages(harness), SUPERSEDED);

    // Loud by design: each removed tag is named on the host log.
    for (const reference of SUPERSEDED) {
      assertStringIncludes(outcome.stderr, reference);
    }

    // Reclaiming disk is not the end of the launch - the worker still starts.
    assert(await recorded(harness, "run"));
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - prunes after a build, keeping the reference it just built", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_IMAGE_LIST: IMAGE_STORE,
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assert(await recorded(harness, "build"), "the absent image was rebuilt");
    const removed = await removedImages(harness);
    assertEquals(removed, SUPERSEDED);
    assertEquals(
      removed.includes(IMAGE),
      false,
      "the reference this checkout resolves to must never be pruned",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a superseded tag the runtime refuses to remove is a warning, not a failed launch", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_IMAGE_LIST: IMAGE_STORE,
    STUB_IMAGE_REMOVE_EXIT: "1",
  });
  try {
    const outcome = await runLauncher(harness);
    // Reclaiming disk must never block a launch, but it must be said out loud.
    assertEquals(outcome.code, 0, outcome.stderr);
    assertStringIncludes(outcome.stderr, "prune");
    assert(await recorded(harness, "run"), "the worker still launched");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a store holding only the current reference prunes nothing", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_IMAGE_LIST: IMAGE,
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);
    assertEquals(await removedImages(harness), []);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - exits with the container's exit status", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_RUN_EXIT: "17",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 17, outcome.stderr);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The outer watchdog (Issue #4173)
// ---------------------------------------------------------------------------

/** The container listing a runtime was asked for, whichever it spells. */
function listing(harness: Harness): Promise<string[] | null> {
  return recorded(harness, "list").then((args) =>
    args ?? recorded(harness, "ps")
  );
}

/** A pid that is certainly not running, for the orphan-container cases. */
async function deadPid(): Promise<number> {
  const child = new Deno.Command("true", { stdout: "null", stderr: "null" })
    .spawn();
  const pid = child.pid;
  await child.status;
  return pid;
}

Deno.test("run.sh - reaps a container that outlives the watchdog deadline", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    // The wedge: the container never exits and the runtime's own kill cannot
    // reap it ("running and can not be deleted", as observed on host-23).
    STUB_RUN_SLEEP: "900",
    STUB_KILL_EXIT: "1",
    VIBE_CONTAINER_WATCHDOG_SECONDS: "2",
    // Keep the test fast: the reaper's own grace period before it escalates
    // to SIGKILL is 30s in production.
    VIBE_CONTAINER_REAP_GRACE_SECONDS: "2",
  });
  try {
    const outcome = await runLauncher(harness);

    // A named non-zero reason, so the supervisor proceeds to the next cycle
    // instead of waiting for ever.
    assertEquals(
      outcome.code,
      CONTAINER_WEDGED_EXIT_STATUS,
      outcome.stderr,
    );
    assertStringIncludes(outcome.stderr, "watchdog");

    const args = await recorded(harness, "run");
    assert(args, "the container never started");
    const name = args[args.indexOf("--name") + 1]!;

    const killed = await recorded(harness, "kill");
    assert(killed, `the wedged container was never killed: ${outcome.stderr}`);
    assertEquals(killed, ["kill", name]);

    // The forced reap is fleet telemetry, not just a host log line.
    const events = await Deno.readTextFile(
      `${harness.tmpDir}/work/logs/self-heal.jsonl`,
    );
    assertStringIncludes(events, "container_wedged");
    assertStringIncludes(events, name);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a healthy run is never reaped", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    VIBE_CONTAINER_WATCHDOG_SECONDS: "600",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    // The pre-launch scan runs, finds nothing leaked, and kills nothing.
    assert(
      await listing(harness),
      `the pre-launch scan never listed the containers: ${outcome.stderr}`,
    );
    assertEquals(
      await recorded(harness, "kill"),
      null,
      "a container that exits on its own must never be killed",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - refuses to launch when another worker is already running on this host (Issue #26)", async () => {
  // A worker container whose launcher is alive: this very test process.
  const live = `vibe-coder-${Deno.pid}`;
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_LIST_JSON: JSON.stringify([{ Names: live }]),
  });
  try {
    const outcome = await runLauncher(harness);

    // Loud, early, and plain: exit non-zero naming the container and the
    // launcher pid, before anything is built or launched - never the
    // runtime's storage-attachment error a second worker would die on.
    assert(outcome.code !== 0, "a second worker must not launch");
    assertStringIncludes(outcome.stderr, "another worker is already running");
    assertStringIncludes(outcome.stderr, live);
    assertStringIncludes(outcome.stderr, `launcher pid ${Deno.pid}`);
    assertEquals(
      await recorded(harness, "kill"),
      null,
      "a live worker is never reaped",
    );
    assertEquals(await recorded(harness, "build"), null);
    assertEquals(await recorded(harness, "run"), null);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - reaps a leaked worker container before launching (Issue #4173)", async () => {
  const orphan = `vibe-coder-${await deadPid()}`;
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    // A worker container left behind by a launcher that is no longer running —
    // including one that outlived a host reboot.
    STUB_LIST_JSON: JSON.stringify([{ Names: orphan }]),
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const killed = await recorded(harness, "kill");
    assert(killed, `the leaked container was never killed: ${outcome.stderr}`);
    assertEquals(killed, ["kill", orphan]);

    // The launch itself still happens — reaping a previous cycle's leak must
    // not cost this cycle.
    assert(await recorded(harness, "run"), "the launch must still proceed");

    const events = await Deno.readTextFile(
      `${harness.tmpDir}/work/logs/self-heal.jsonl`,
    );
    assertStringIncludes(events, "container_wedged");
    assertStringIncludes(events, orphan);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - propagates SIGTERM to the container and reports its status", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_RUN_SLEEP: "60",
    STUB_RUN_SIGNAL_EXIT: "143",
  });
  try {
    const child = spawnLauncher(harness);
    assert(
      await waitForRecord(harness, "run"),
      "the container never started",
    );

    child.kill("SIGTERM");
    const output = await child.output();

    assertEquals(
      await Deno.readTextFile(`${harness.recordDir}/terminated`),
      "terminated",
      "the container must receive the termination signal",
    );
    assertEquals(
      output.code,
      143,
      new TextDecoder().decode(output.stderr),
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - exits non-zero with an actionable message when no runtime is available", async () => {
  const harness = await setupHarness({ STUB_PROBE_EXIT: "1" }, {
    denoStub: true,
  });
  try {
    const outcome = await runLauncher(harness);
    assert(outcome.code !== 0, "an unavailable runtime must fail the launch");
    assertStringIncludes(outcome.stderr, "No supported container runtime");
    assertStringIncludes(outcome.stderr, "no host fallback");
    assertEquals(await recorded(harness, "run"), null);
    // There is no host mode to fall back to (Issue #4), and an absent
    // runtime must never invent one.
    assertEquals(
      await recorded(harness, "run-entrypoint"),
      null,
      "a missing container runtime must not fall back to a host run",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - fails loud when the credential directory is absent", async () => {
  const harness = await setupHarness(
    { STUB_IMAGE_INSPECT_EXIT: "0" },
    { credentials: false },
  );
  try {
    const outcome = await runLauncher(harness);
    assert(outcome.code !== 0, "a missing credential directory must fail");
    assertStringIncludes(outcome.stderr, "credentials");
    assertEquals(await recorded(harness, "run"), null);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Host-side checkout update (Issue #512)
// ---------------------------------------------------------------------------

Deno.test("run.sh - updates the worker checkout before it builds the launch plan (Issue #512)", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "worker-checkout-update");
    assert(args, `the checkout was never updated: ${outcome.stderr}`);
    assertEquals(args[args.indexOf("--base-dir") + 1], REPO_ROOT);

    // Order matters: the plan - and the image reference it derives from the
    // checkout's own contents - must be built from the updated tree.
    const order = await denoInvocationOrder(harness);
    const update = order.indexOf("worker-checkout-update");
    const plan = order.indexOf("container-launch-plan");
    assert(update > -1 && plan > -1, `deno order: ${order.join(", ")}`);
    assert(
      update < plan,
      `the checkout update must precede the launch plan: ${order.join(", ")}`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a failed checkout update warns and launches on the existing checkout (Issue #512)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_CHECKOUT_UPDATE_EXIT: "1",
  });
  try {
    const outcome = await runLauncher(harness);
    // Not fatal by design: a host that cannot reach GitHub still works.
    assertEquals(
      outcome.code,
      0,
      `a failed update must not abort the launch: ${outcome.stderr}`,
    );
    assertStringIncludes(outcome.stderr, "could not update the worker");
    assert(
      await recorded(harness, "run"),
      "the container must still be launched",
    );
    // Loud, not quiet: the failure reaches the host log too (Issue #3234).
    assertStringIncludes(await runCoreLog(harness), "worker-checkout-update");
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// New-release notice (Issue #690)
// ---------------------------------------------------------------------------

Deno.test("run.sh - prints the new-release notice once, on stderr and in the run-core log (Issue #690)", async () => {
  const notice = formatReleaseNotice("1.0.4", "1.0.5");
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_RELEASE_NOTICE_STDOUT: notice,
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    // The check is asked about this checkout, beside the checkout update.
    const args = await recorded(harness, "release-notice");
    assert(args, `the release check never ran: ${outcome.stderr}`);
    assertEquals(args[args.indexOf("--base-dir") + 1], REPO_ROOT);

    // Once, on stderr, so an operator watching a launch sees it...
    assertStringIncludes(outcome.stderr, notice);
    assertEquals(outcome.stderr.split(notice).length - 1, 1);
    // ...and in the run-core log, so a non-interactive host's notice is not
    // lost. Same wording in both places.
    assertStringIncludes(await runCoreLog(harness), notice);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - says nothing when the release check has nothing to say (Issue #690)", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assert(
      await recorded(harness, "release-notice"),
      "the release check must still run",
    );
    // A dynamic host, a host on the newest release, a commit-SHA pin: the
    // command prints nothing, and so does the launcher.
    assertEquals(outcome.stderr.includes("A new release of Vibe Coder"), false);
    assertEquals(
      (await runCoreLog(harness)).includes("A new release of Vibe Coder"),
      false,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a failed release check warns and the launch proceeds (Issue #690)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_RELEASE_NOTICE_EXIT: "1",
    STUB_RELEASE_NOTICE_STDOUT: "gh release list failed: no network",
  });
  try {
    const outcome = await runLauncher(harness);
    // Never blocks the launch: the exit status is the container's.
    assertEquals(
      outcome.code,
      0,
      `a failed release check must not abort the launch: ${outcome.stderr}`,
    );
    assert(
      await recorded(harness, "run"),
      "the container must still be launched",
    );

    // Warned in the same shape as the checkout-update failure path, and never
    // mistaken for a notice.
    assertStringIncludes(outcome.stderr, "could not check for a newer release");
    assertEquals(outcome.stderr.includes("A new release of Vibe Coder"), false);
    assertStringIncludes(await runCoreLog(harness), "release-notice: failed");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - carries no release logic of its own (Issue #690)", async () => {
  const source = await Deno.readTextFile(RUN_SH);

  // The shell captures what the Deno command printed and prints it; it must
  // not compare versions, list releases or name a release tag itself.
  assertStringIncludes(source, "release-notice");
  for (const logic of ["gh release", "semver", "1.0."]) {
    assertEquals(
      source.includes(logic),
      false,
      `run.sh must leave release logic to the Deno command, found: ${logic}`,
    );
  }
});

Deno.test("run.sh - carries no host-execution path at all (Issue #4)", async () => {
  const source = await Deno.readTextFile(RUN_SH);

  // The launcher still asks the run-mode resolver — so a removed mode fails
  // loud in one place — but there is nothing for the answer to select: no
  // run-entrypoint, no sandbox-exec, no Seatbelt profile.
  assertStringIncludes(source, "run-mode");
  for (const gone of ["run-entrypoint", "sandbox-exec", "seatbelt-profile"]) {
    assertEquals(
      source.includes(gone),
      false,
      `run.sh must not contain the host-execution marker ${gone}`,
    );
  }
  for (
    const forbidden of [
      "--privileged",
      "docker.sock",
      "podman.sock",
      "--network host",
      "--network=host",
      "--publish",
    ]
  ) {
    assertEquals(
      source.includes(forbidden),
      false,
      `run.sh must not contain ${forbidden}`,
    );
  }
  // The launch plan - not the shell - decides the mounts and the flags.
  assertStringIncludes(source, "container-launch-plan");
});

// ---------------------------------------------------------------------------
// Run mode (Issues #4146, #4) - container, and only container
// ---------------------------------------------------------------------------

Deno.test("run.sh - launches the container when no run mode is configured", async () => {
  const harness = await setupHarness(
    { STUB_IMAGE_INSPECT_EXIT: "0" },
    { denoStub: true },
  );
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assert(
      await recorded(harness, "run"),
      "the default launch is the container",
    );
    assertEquals(
      await recorded(harness, "run-entrypoint"),
      null,
      "the worker driver never runs on the host",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - fails loud on an unrecognised run mode rather than choosing one", async () => {
  const harness = await setupHarness(
    { VIBE_RUN_MODE: "Native", STUB_IMAGE_INSPECT_EXIT: "0" },
    { denoStub: true },
  );
  try {
    const outcome = await runLauncher(harness);
    assert(outcome.code !== 0, "an unrecognised run mode must fail the launch");
    assertStringIncludes(outcome.stderr, "run mode");
    assertEquals(await recorded(harness, "run"), null);
    assertEquals(await recorded(harness, "run-entrypoint"), null);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a removed run mode fails loud with the removal explained, and launches nothing (Issue #4)", async () => {
  for (const removed of ["native", "seatbelt"]) {
    const harness = await setupHarness(
      { VIBE_RUN_MODE: removed, STUB_IMAGE_INSPECT_EXIT: "0" },
      { denoStub: true },
    );
    try {
      const outcome = await runLauncher(harness);
      assert(outcome.code !== 0, `${removed} must fail the launch`);
      assertStringIncludes(outcome.stderr, "removed");
      assertStringIncludes(outcome.stderr, "Issue #4");
      assertEquals(await recorded(harness, "run"), null);
      assertEquals(await recorded(harness, "build"), null);
      assertEquals(await recorded(harness, "run-entrypoint"), null);
    } finally {
      await harness.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Builder helper stop after the image exists (Issue #4331)
// ---------------------------------------------------------------------------

Deno.test("run.sh - stops the runtime's builder helper on Apple container, and asks nothing of Docker/Podman (Issue #4331)", async () => {
  const harness = await setupHarness({ STUB_RUN_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);
    const stop = await recorded(harness, "builder-stop");
    if (Deno.build.os === "darwin") {
      // Apple container: the buildkit VM outlives the build; the launcher
      // stops it once the image exists.
      assert(
        stop,
        `expected a builder stop on Apple container: ${outcome.stderr}`,
      );
      assertEquals(stop.slice(0, 2), ["builder", "stop"]);
    } else {
      // Docker/Podman have no builder container: the plan carries no
      // arguments and the launcher must not invent a call.
      assertEquals(stop, null);
    }
  } finally {
    await harness.cleanup();
  }
});

/** What Apple container prints when the buildkit VM is not there. */
const BUILDER_ABSENT_STDERR =
  'Error: failed to stop container (cause: "notFound: "container with ID ' +
  'buildkit not found"")';

Deno.test("run.sh - a builder that is not there is not a failure (Issue #492)", async () => {
  const harness = await setupHarness({
    STUB_RUN_EXIT: "0",
    STUB_BUILDER_STOP_EXIT: "1",
    STUB_BUILDER_STOP_STDERR: BUILDER_ABSENT_STDERR,
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);
    if (Deno.build.os !== "darwin") return; // no builder helper to stop
    assert(
      !outcome.stderr.includes("could not stop"),
      `a builder that was never running must not warn: ${outcome.stderr}`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a genuine builder stop failure warns and names the cause (Issue #492)", async () => {
  const harness = await setupHarness({
    STUB_RUN_EXIT: "0",
    STUB_BUILDER_STOP_EXIT: "1",
    STUB_BUILDER_STOP_STDERR: "Error: builder is wedged and will not stop",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, "a stop failure must not fail the launch");
    if (Deno.build.os !== "darwin") return; // no builder helper to stop
    assertStringIncludes(outcome.stderr, "could not stop");
    // The previous implementation discarded the runtime's stderr, leaving a
    // warning that named no cause at all.
    assertStringIncludes(outcome.stderr, "builder is wedged");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - the builder stop runs after the store prune, never before it (Issue #492)", async () => {
  const harness = await setupHarness({ STUB_RUN_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);
    if (Deno.build.os !== "darwin") return; // no builder helper to stop

    const order = await invocationOrder(harness);
    const stop = order.indexOf("builder-stop");
    // The store prune reclaims dangling layers and can delete the builder
    // outright; stopping something it is about to delete was pointless work
    // that also guaranteed the next launch found nothing to stop.
    const prune = order.lastIndexOf("image-prune");
    assert(stop > -1, `no builder stop recorded: ${order.join(", ")}`);
    assert(prune > -1, `no store prune recorded: ${order.join(", ")}`);
    assert(
      stop > prune,
      `builder stop ran before the store prune: ${order.join(", ")}`,
    );
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Builder self-heal after a storage failure (Issue #4441)
// ---------------------------------------------------------------------------

/** The ENOSPC export failure host-23 produced, mid-build. */
const ENOSPC_BUILD_FAILURE =
  'Error: resourceExhausted: "failed to solve: write ' +
  "/var/lib/container-builder-shim/exports/abc/out.tar: no space left on " +
  'device"';

Deno.test("run.sh - heals the builder and retries once when the build dies on storage (Issue #4441)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_BUILD_EXIT: "1",
    STUB_BUILD_STDERR: ENOSPC_BUILD_FAILURE,
    // The retry succeeds, exactly as the hand-run builder restart did.
    STUB_BUILD_RETRY_EXIT: "0",
  });
  try {
    const outcome = await runLauncher(harness);

    // The launch continued: the retry built the image and the worker ran.
    assertEquals(outcome.code, 0, outcome.stderr);
    assertEquals(await buildCount(harness), 2);
    assert(await builderHealed(harness), `no builder heal: ${outcome.stderr}`);
    assert(await recorded(harness, "run"), "the worker must still be launched");

    // The outcome is on the worker's own host log, not only stderr.
    const log = await runCoreLog(harness);
    assertStringIncludes(log, "container-build-heal");
    assertStringIncludes(log, "succeeded");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a build that failed for its own reasons is not healed or retried (Issue #4441)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_BUILD_EXIT: "1",
    STUB_BUILD_STDERR: "E: Unable to locate package nosuchpackage",
  });
  try {
    const outcome = await runLauncher(harness);

    assert(outcome.code !== 0, "an unhealable build failure must still fail");
    assertEquals(await buildCount(harness), 1);
    assertEquals(await builderHealed(harness), false);
    assertEquals(await recorded(harness, "run"), null);
    assertStringIncludes(outcome.stderr, "failed to build");
    assertStringIncludes(
      await runCoreLog(harness),
      "does not cover",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - escalates to a builder recreate when the retry fails too, and never loops (Issue #4441)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_BUILD_EXIT: "1",
    STUB_BUILD_RETRY_EXIT: "1",
    STUB_BUILD_STDERR: ENOSPC_BUILD_FAILURE,
  });
  try {
    const outcome = await runLauncher(harness);

    assert(outcome.code !== 0, "a build that never succeeded must fail");
    // Exactly one retry - the launcher must not loop on a broken builder.
    assertEquals(await buildCount(harness), 2);
    assertEquals(await recorded(harness, "run"), null);

    // Apple container escalates to `builder delete`; Docker/Podman have no
    // builder VM to recreate and repeat the cache prune.
    if (Deno.build.os === "darwin") {
      const deleted = await recorded(harness, "builder-delete");
      assert(deleted, `no builder recreate: ${outcome.stderr}`);
      assertEquals(deleted.slice(0, 2), ["builder", "delete"]);
    } else {
      assert(await recorded(harness, "builder-prune"));
    }
    assertStringIncludes(await runCoreLog(harness), "recreating the builder");
  } finally {
    await harness.cleanup();
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("run.sh - carries the container_tools spec into the build (Issue #72)", async () => {
  // STUB_IMAGE_INSPECT_EXIT=1 makes the image absent, so a build is recorded.
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "1" });
  try {
    const spec = [
      {
        id: "java",
        version: "21.0.5+11",
        url: { noarch: "https://example.com/openjdk21.tar.gz" },
        sha256: { noarch: "a".repeat(64) },
        stripComponents: 1,
        bin: ["bin"],
        env: { JAVA_HOME: "" },
      },
    ];
    await Deno.writeTextFile(
      `${harness.tmpDir}/config.json`,
      JSON.stringify({ repos: ["org/repo1"], container_tools: spec }),
    );

    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const build = await recorded(harness, "build");
    assert(build, "an absent image reference must trigger a build");
    const at = build.indexOf("--build-arg");
    assert(at !== -1, `build carried no --build-arg: ${build.join(" ")}`);
    // The JSON spec survives the plan → run.sh → runtime hand-off verbatim.
    assertEquals(build[at + 1], `VIBE_CONTAINER_TOOLS=${JSON.stringify(spec)}`);
    // Options precede the build-context path (the last argument).
    assert(
      at + 1 < build.length - 1,
      "the --build-arg must precede the context",
    );
    assertEquals(build.at(-1), `${REPO_ROOT}/container`);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - no container_tools means no extra build arg (Issue #72)", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "1" });
  try {
    // The default harness config selects no tools.
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);
    const build = await recorded(harness, "build");
    assert(build, "an absent image reference must trigger a build");
    assertEquals(
      build.some((a) => a.startsWith("VIBE_CONTAINER_TOOLS=")),
      false,
      "the default build must carry no tool spec",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a malformed container_tools spec fails the launch loudly (Issue #72)", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "1" });
  try {
    // Missing the required `version` — the #69 validator must reject it at
    // plan time so a bad spec never reaches the build.
    await Deno.writeTextFile(
      `${harness.tmpDir}/config.json`,
      JSON.stringify({
        repos: ["org/repo1"],
        container_tools: [{
          id: "java",
          url: { noarch: "https://x/y.tar.gz" },
        }],
      }),
    );
    const outcome = await runLauncher(harness);
    assert(outcome.code !== 0, "a malformed spec must fail the launch");
    assertStringIncludes(outcome.stderr, "container_tools");
    // Nothing was built from the bad spec.
    assertEquals(await recorded(harness, "build"), null);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - the work volume is trimmed before the hard disk floor can refuse the launch (Issue #384)", async () => {
  // A floor no host can clear stands in for GRQ-23 sitting below it for days.
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    VIBE_HOST_DISK_HARD_FLOOR_GB: "999999",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 1, outcome.stderr);
    assertStringIncludes(outcome.stderr, "hard floor");

    // The init is what runs fstrim on the volume, so it must already have
    // run: gating first left the image holding every block it was ever
    // allocated and the floor unreachable by construction.
    const init = await recorded(harness, "run-init");
    assert(init, `the volume init must run before the gate: ${outcome.stderr}`);
    assert(
      init.includes("/usr/local/bin/vibe-volume-init"),
      init.join(" "),
    );
    // The refusal still holds: no worker container was started.
    assertEquals(await recorded(harness, "run"), null);
  } finally {
    await harness.cleanup();
  }
});

// --- Self-healing a volume the runtime will not trim (Issue #478) -----------

/** The `VOLUME_TRIM_REFUSED` lines container/volume-init.sh writes. */
const TRIM_REFUSED_STDOUT = [
  `VOLUME_TRIM_REFUSED ${TARGETS.work}`,
  `VOLUME_TRIM_REFUSED ${TARGETS.approvalState}`,
].join("\\n");

Deno.test("run.sh - a refused trim below the claiming floor recreates the volumes and re-runs the init (Issue #478)", async () => {
  // GRQ-23: FITRIM refused on every launch, ~14 GB of dead space, three days
  // below the floor claiming nothing, and a remedy only a human could apply.
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: TRIM_REFUSED_STDOUT,
    // A claiming floor no host can clear: the launcher is below it.
    VIBE_HOST_DISK_LOW_FLOOR_GB: "999999",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    // Both untrimmable volumes were recreated — no operator incantation.
    assertEquals(await removedVolumes(harness), [
      WORK_VOLUME_NAME,
      APPROVAL_STATE_VOLUME_NAME,
    ]);
    assert(
      await recorded(harness, "volume-create"),
      "a recreated volume must be created again",
    );
    // A fresh volume is root-owned, so the init must have run a second time.
    assertEquals(await initCount(harness), 2);

    const log = await runCoreLog(harness);
    // The refusal is recorded as a refusal, not as a successful trim.
    assertStringIncludes(log, "the runtime refused to trim");
    assertStringIncludes(log, `recreating ${WORK_VOLUME_NAME}`);
    // The floor is unreachable here, so the launcher must not claim a fix.
    assertStringIncludes(log, "[WORK_VOLUME_UNRECOVERED]");
    assertStringIncludes(outcome.stderr, "[WORK_VOLUME_UNRECOVERED]");

    // The worker still launched: a host that cannot claim must still run and
    // report (Issue #477). Only the hard floor stops a launch.
    assert(await recorded(harness, "run"), "the worker must still start");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a refused trim on a host with room to spare destroys nothing (Issue #478)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: TRIM_REFUSED_STDOUT,
    // Floors of zero: whatever this host has free is above them.
    VIBE_HOST_DISK_LOW_FLOOR_GB: "0",
    VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "0",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assertEquals(
      await removedVolumes(harness),
      [],
      "a host above its floor must keep its clones",
    );
    assertEquals(await initCount(harness), 1);

    const log = await runCoreLog(harness);
    // Still recorded — the ratchet is real, the host just is not short yet.
    assertStringIncludes(log, "the runtime refused to trim");
    assertStringIncludes(log, "above the");
    assertEquals(log.includes("[WORK_VOLUME_UNRECOVERED]"), false, log);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a recreate that did not clear the floor is not retried on the next launch (Issue #478)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: TRIM_REFUSED_STDOUT,
    VIBE_HOST_DISK_LOW_FLOOR_GB: "999999",
  });
  try {
    // A recreate from a minute ago: this launch must escalate, not wipe the
    // clones again every hour for ever.
    await Deno.mkdir(`${harness.tmpDir}/home/.vibe-coder`, { recursive: true });
    await Deno.writeTextFile(
      `${harness.tmpDir}/home/.vibe-coder/work-volume-heal`,
      `${Math.floor(Date.now() / 1000) - 60}\n`,
    );

    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assertEquals(await removedVolumes(harness), []);
    assertEquals(await initCount(harness), 1);
    assertStringIncludes(outcome.stderr, "[WORK_VOLUME_UNRECOVERED]");
    assertStringIncludes(
      await runCoreLog(harness),
      "recreating again would destroy the clones",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - volumes too small to hold the missing space are escalated, not destroyed (Issue #478)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: `VOLUME_TRIM_REFUSED ${TARGETS.work}`,
    VIBE_HOST_DISK_LOW_FLOOR_GB: "999999",
  });
  try {
    // A container store whose work volume holds a few kilobytes: the host's
    // space went somewhere else, so recreating it would achieve nothing.
    const store =
      `${harness.tmpDir}/home/Library/Application Support/com.apple.container`;
    await Deno.mkdir(`${store}/volumes/${WORK_VOLUME_NAME}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${store}/volumes/${WORK_VOLUME_NAME}/volume.img`,
      "small",
    );

    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assertEquals(await removedVolumes(harness), []);
    assertStringIncludes(
      await runCoreLog(harness),
      "the host's missing space is somewhere else",
    );
  } finally {
    await harness.cleanup();
  }
});

// --- Recovery removes volumes with the verb the runtime accepts (#731) -----
//
// `volume delete` was written into both recovery paths for every runtime.
// Podman has no such sub-command: it answered "unrecognized command", the
// `2>&1 || true` threw that away, the volume survived, and the `volume create`
// on the very next line failed with "volume with name vibe-work already
// exists" — a misleading report of a removal that had never happened.

/** The removal verb the runtime this host would select actually accepts. */
const REMOVE_VERB = candidatesForPlatform(
  normaliseHostPlatform(Deno.build.os),
)[0]!.dialect
  .volumeRemoveArgs[1]!;

/** The spelling that runtime rejects — `rm` and `delete` are not synonyms. */
const REJECTED_VERB = REMOVE_VERB === "rm" ? "delete" : "rm";

/** An init that reports the work volume unrepairable, then comes back clean. */
const UNREPAIRABLE_ENV = {
  STUB_IMAGE_INSPECT_EXIT: "0",
  STUB_INIT_EXIT: "3",
  STUB_INIT_RETRY_EXIT: "0",
  STUB_INIT_STDOUT: `VOLUME_UNREPAIRABLE ${TARGETS.work}`,
};

Deno.test("run.sh - recreates an unrepairable volume with the verb its runtime accepts (Issues #731, #229)", async () => {
  const harness = await setupHarness({
    ...UNREPAIRABLE_ENV,
    // The runtime answers only its own spelling, exactly as Podman answers
    // `volume delete` with an unrecognised command and keeps the volume.
    STUB_VOLUME_REMOVE_VERB: REMOVE_VERB,
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assertEquals(await removedVolumes(harness), [WORK_VOLUME_NAME]);
    assertEquals(
      await recorded(harness, `volume-${REJECTED_VERB}`),
      null,
      `the launcher must not spell the removal 'volume ${REJECTED_VERB}'`,
    );
    // The volume was recreated and re-owned: a fresh volume is root-owned.
    assert(await recorded(harness, "volume-create"));
    assertEquals(await initCount(harness), 2);
    assert(await recorded(harness, "run"), "the worker must still start");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a removal the runtime refuses is surfaced, and no volume create follows it (Issue #731)", async () => {
  const harness = await setupHarness({
    ...UNREPAIRABLE_ENV,
    // The volumes are there and the runtime will not remove them.
    STUB_VOLUME_INSPECT_EXIT: "0",
    STUB_VOLUME_REMOVE_EXIT: "125",
    STUB_VOLUME_REMOVE_STDERR: `Error: volume ${WORK_VOLUME_NAME} is in use`,
  });
  try {
    const outcome = await runLauncher(harness);
    // The init still reports the volume unrepairable, so the launch fails at
    // volume preparation rather than starting a worker on a broken volume.
    assert(outcome.code !== 0, `expected a failed launch: ${outcome.stderr}`);

    // The runtime's own words, not a swallowed failure.
    assertStringIncludes(
      outcome.stderr,
      `could not remove volume ${WORK_VOLUME_NAME}`,
    );
    assertStringIncludes(
      outcome.stderr,
      `Error: volume ${WORK_VOLUME_NAME} is in use`,
    );
    assertStringIncludes(await runCoreLog(harness), "could not remove");

    assertEquals(await removedVolumes(harness), []);
    assertEquals(
      await recorded(harness, "volume-create"),
      null,
      "a removal that failed must not fall through to a create that cannot work",
    );
    assertEquals(await initCount(harness), 1);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - removing a volume that is not there is still not an error (Issue #731)", async () => {
  const harness = await setupHarness({
    ...UNREPAIRABLE_ENV,
    // "No such volume": a non-zero status over a volume that is already gone.
    STUB_VOLUME_INSPECT_EXIT: "1",
    STUB_VOLUME_REMOVE_EXIT: "1",
    STUB_VOLUME_REMOVE_STDERR: `Error: no such volume ${WORK_VOLUME_NAME}`,
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    assertEquals(
      outcome.stderr.includes("could not remove"),
      false,
      `nothing to remove is not a failure: ${outcome.stderr}`,
    );
    // The recreate went ahead: the volume was created and the init re-run.
    assert(await recorded(harness, "volume-create"));
    assertEquals(await initCount(harness), 2);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a heal whose removal the runtime refuses is reported, never dressed up as a fix (Issues #731, #478)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_STDOUT: TRIM_REFUSED_STDOUT,
    VIBE_HOST_DISK_LOW_FLOOR_GB: "999999",
    STUB_VOLUME_INSPECT_EXIT: "0",
    STUB_VOLUME_REMOVE_EXIT: "125",
    STUB_VOLUME_REMOVE_STDERR: `Error: volume ${WORK_VOLUME_NAME} is in use`,
  });
  try {
    const outcome = await runLauncher(harness);
    // A host that cannot claim must still run and report (Issue #477).
    assertEquals(outcome.code, 0, outcome.stderr);

    assertEquals(await removedVolumes(harness), []);
    assertEquals(
      await recorded(harness, "volume-create"),
      null,
      "nothing was removed, so nothing may be recreated",
    );
    assertEquals(await initCount(harness), 1);

    assertStringIncludes(outcome.stderr, "[WORK_VOLUME_UNRECOVERED]");
    assertStringIncludes(
      outcome.stderr,
      `Error: volume ${WORK_VOLUME_NAME} is in use`,
    );

    // The interval is not spent on a recreate that never happened: a launch
    // once the runtime is well again must be free to try.
    assertEquals(
      await exists(`${harness.tmpDir}/home/.vibe-coder/work-volume-heal`),
      false,
    );
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The outcome record run.sh makes on its own way out (Issue #709)
// ---------------------------------------------------------------------------
//
// Under cron / launchd / Task Scheduler there is no supervisor, so run.sh
// records its own launcher outcome — and that record is what escalates. Two
// things it hands the recorder decide whether the resulting GitHub issue is
// actionable: permission to read the hostname, and the failing build's own
// log. Issue #709 is the report that arrived without either: it was titled
// `unknown-host`, said `Host: unknown`, and named no cause for the build
// failure it was reporting.

Deno.test("run.sh - lets the outcome recorder read the hostname, so its escalation names the machine (Issue #709)", async () => {
  const harness = await setupHarness(
    { STUB_IMAGE_INSPECT_EXIT: "0" },
    { denoStub: true },
  );
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "container-restart-backoff");
    assert(args, "run.sh must record its own launcher outcome");
    assert(
      args.includes("--allow-sys=hostname"),
      "without --allow-sys=hostname Deno.hostname() throws and every host " +
        `files its escalation as "unknown-host": ${args.join(" ")}`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a failed image build hands its own log to the outcome recorder (Issue #709)", async () => {
  const buildFailure = "Error: unable to prepare context: no such file or " +
    "directory";
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_BUILD_EXIT: "1",
    STUB_BUILD_STDERR: buildFailure,
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assert(outcome.code !== 0, "a build that never succeeded must fail");

    const args = await recorded(harness, "container-restart-backoff");
    assert(args, "a failed build must still record its outcome");
    assert(
      args.includes("--launch-log"),
      `an image_build escalation with no evidence: ${args.join(" ")}`,
    );

    // The launcher deletes the build log on its way out; handing it over
    // before that deletion is the behaviour, not merely naming the path.
    const log = await recordedLaunchLog(harness);
    assert(log !== null, "the build log was deleted before it was reported");
    assertStringIncludes(log, buildFailure);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a build that succeeded is not quoted as failure evidence (Issue #709)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_BUILD_EXIT: "0",
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "container-restart-backoff");
    assert(args, "run.sh must record its own launcher outcome");
    assertEquals(
      args.includes("--launch-log"),
      false,
      `a successful build must not be reported as a failure's log: ${
        args.join(" ")
      }`,
    );
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The container start the runtime client refused (Issue #711)
// ---------------------------------------------------------------------------
//
// Issue #711 is the third report of the same shape: `Failure phase:
// container_start`, `Last launcher exit status: 125`, and not one word about
// why the runtime refused. The client's own explanation went to the console
// and nowhere else, so the escalation could not carry it. The launcher now
// keeps a copy of that stderr and hands it over as `--launch-log`, exactly as
// a failed build hands over its build log (Issue #709).

Deno.test("run.sh - a refused container start quotes the runtime client's own stderr (Issue #711)", async () => {
  const refusal =
    'Error: no such image "vibe-coder:deadbeef"; refusing to start';
  for (const status of CONTAINER_START_EXIT_CODES) {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_RUN_EXIT: `${status}`,
      STUB_RUN_STDERR: refusal,
    }, { denoStub: true });
    try {
      const outcome = await runLauncher(harness);
      assertEquals(outcome.code, status, outcome.stderr);

      // The container's output IS this run's console, so capturing it must
      // not take it away from the console.
      assertStringIncludes(outcome.stderr, refusal);

      const args = await recorded(harness, "container-restart-backoff");
      assert(args, "a refused start must still record its outcome");
      assert(
        args.includes("--launch-log"),
        `a container_start escalation with no evidence: ${args.join(" ")}`,
      );

      // The launcher removes the capture on its way out; handing it over
      // while it is still readable is the behaviour, not naming the path.
      const log = await recordedLaunchLog(harness);
      assert(
        log !== null,
        "the run capture was deleted before the outcome was recorded",
      );
      assertStringIncludes(log, refusal);
    } finally {
      await harness.cleanup();
    }
  }
});

Deno.test("run.sh - the client's stderr reaches the console while the container is still running (Issue #711)", async () => {
  // Capturing the output must not take it away from the console, and must not
  // hold it back until the container exits: the container's output IS this
  // run's console, so an operator watching a launch has to see it as it is
  // produced. The stub prints its line and then stalls, so a console line read
  // before the launcher returns can only have been streamed.
  const line = "[stub] pulling image layers";
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_RUN_STDERR: line,
    STUB_RUN_SLEEP: "30",
  }, { denoStub: true });
  const child = spawnLauncher(harness);
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let console_ = "";
  try {
    const deadline = Date.now() + 30_000;
    while (!console_.includes(line) && Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (read === null || read.done) break;
      console_ += decoder.decode(read.value, { stream: true });
    }
    assert(
      console_.includes(line),
      `the container's stderr was not on the console while it was still ` +
        `running: ${console_}`,
    );
  } finally {
    child.kill("SIGTERM");
    await reader.cancel();
    await child.stdout.cancel();
    await child.status;
    await harness.cleanup();
  }
});

Deno.test("run.sh - a container that started is never quoted as failure evidence (Issue #711)", async () => {
  // Exit status 1 is the worker reporting its own failure from inside a
  // container that started perfectly well, so its console output says nothing
  // about a launch that did not fail.
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_RUN_EXIT: "1",
    STUB_RUN_STDERR: "worker: the run failed for its own reasons",
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 1, outcome.stderr);

    const args = await recorded(harness, "container-restart-backoff");
    assert(args, "run.sh must record its own launcher outcome");
    assertEquals(
      args.includes("--launch-log"),
      false,
      `a container that started must not be quoted as a refused start: ${
        args.join(" ")
      }`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a failed launch records exactly one outcome (Issue #711)", async () => {
  // Bash runs an EXIT trap in asynchronous subshells too, so the launcher's
  // own background jobs — the watchdog, and the capture's drain guard — each
  // used to be able to run `on_exit` on their way out. That is not a tidiness
  // problem: the extra record was a status 0, which resets the consecutive
  // failure count the self-heal escalation is built on, and it deleted the
  // capture the real record was about to quote.
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_RUN_EXIT: "125",
    STUB_RUN_STDERR: "Error: no such image",
  }, { denoStub: true });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 125, outcome.stderr);

    const records = (await denoInvocationOrder(harness)).filter((command) =>
      command === "container-restart-backoff"
    );
    assertEquals(
      records.length,
      1,
      "one failed launch is one launcher outcome, never two",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - the statuses it treats as a refused start are the recorder's own (Issue #711)", async () => {
  // The launcher cannot import the recorder's list, so it carries a copy —
  // and a copy nothing checks is a copy that drifts. Pinned in both
  // directions: a status added to or removed from either side fails here.
  const source = await Deno.readTextFile(RUN_SH);
  const declaration = source.match(
    /CONTAINER_START_EXIT_STATUSES=\(([^)]*)\)/,
  );
  assert(
    declaration,
    "run.sh must name the statuses it treats as a refused container start",
  );
  const statuses = (declaration[1] ?? "").trim().split(/\s+/).map(Number);
  assertEquals(statuses, [...CONTAINER_START_EXIT_CODES]);
});

Deno.test("run.sh - the stderr capture leaves nothing behind in the temporary directory (Issue #711)", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  const tmp = `${harness.tmpDir}/tmp`;
  await Deno.mkdir(tmp, { recursive: true });
  harness.env.TMPDIR = tmp;
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    // The capture and the FIFO it streams through are both the launcher's, so
    // both go with it — a launcher that leaked a FIFO per launch would fill
    // the host it is meant to keep launching.
    const leftovers: string[] = [];
    for await (const entry of Deno.readDir(tmp)) leftovers.push(entry.name);
    assertEquals(leftovers, []);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Self-heal attribution (Issue #710)
// ---------------------------------------------------------------------------

/** The phase marker the launcher left behind, trimmed. */
async function launchPhase(harness: Harness): Promise<string> {
  const marker = await Deno.readTextFile(
    `${harness.tmpDir}/home/.vibe-coder/last-launch-phase`,
  );
  return marker.trim();
}

Deno.test("run.sh - attributes a failed volume init to volume preparation, not runtime detection (Issue #710)", async () => {
  // The reported alert: `Failure phase: runtime_detection` with exit status
  // 125, which only the runtime client produces. The volume init IS a
  // `run`, and it happens long after runtime detection succeeded.
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "0",
    STUB_INIT_EXIT: "125",
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 125, outcome.stderr);
    assertEquals(await launchPhase(harness), "volume_init");
    assertEquals(
      await recorded(harness, "run"),
      null,
      "the worker container must not start after a failed volume init",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - a clean launch still reaches the container_run phase (Issue #710)", async () => {
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);
    assertEquals(await launchPhase(harness), "container_run");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("run.sh - the outcome recorder may read the hostname, so the alert can name the host (Issue #710)", async () => {
  // Issue #633 gave loop.sh `--allow-sys=hostname` for exactly this reason;
  // the launcher's own recorder (the cron/launchd path, where there is no
  // supervisor) was left without it, so every alert it filed was titled
  // `unknown-host` and said `Host: unknown`.
  const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" }, {
    denoStub: true,
  });
  try {
    const outcome = await runLauncher(harness);
    assertEquals(outcome.code, 0, outcome.stderr);

    const args = await recorded(harness, "container-restart-backoff");
    assert(args, "the launcher must record its own outcome");
    assert(
      args.some((arg) => arg.startsWith("--allow-sys=")) &&
        args.some((arg) => arg.includes("hostname")),
      `the recorder cannot resolve the host without --allow-sys=hostname: ${
        args.join(" ")
      }`,
    );
  } finally {
    await harness.cleanup();
  }
});
