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
import { CONTAINER_WEDGED_EXIT_STATUS } from "../lib/container_watchdog.ts";
import { stripContainerfile } from "../lib/containerfile_strip.ts";
import { activeAgentProvider } from "../lib/agent_provider.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import {
  BASH_LAUNCHER,
  buildCount,
  builderHealed,
  type Harness,
  type LaunchOutcome,
  mountValues,
  recorded,
  removedImages,
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
      `${REPO_ROOT}:${TARGETS.base}`,
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
