/**
 * Tests for run.ps1 as a containerised launcher (Issue #4066).
 *
 * `run.ps1` is the Windows containment boundary, and is held to exactly the
 * contract `run.sh` is: the runtime executable is replaced with a recording
 * stub on PATH, the real launcher runs, and the invocation it constructed is
 * asserted on — the mounts, their read-only modes, the absence of a runtime
 * socket, of privilege-broadening flags, of host networking and of published
 * ports.
 *
 * PowerShell is not installed on every developer host, so these tests are
 * skipped (visibly, never silently passed) when `pwsh` cannot be resolved.
 * The `Validate Scripts` runner has PowerShell, so drift is caught in CI.
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
  buildCount,
  builderHealed,
  type Harness,
  type LaunchOutcome,
  mountValues,
  POWERSHELL_LAUNCHER,
  PWSH,
  recorded,
  removedImages,
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
const PROVIDER_SUBDIR = activeAgentProvider().credentials.subdir;
const IMAGE = await resolveContainerImageReference(REPO_ROOT);

/** Skip, visibly, on a host without PowerShell. */
const ignore = POWERSHELL_LAUNCHER === null;

/** Run `run.ps1` under the shared launcher harness. */
function runLauncher(harness: Harness): Promise<LaunchOutcome> {
  return runHarnessLauncher(harness, POWERSHELL_LAUNCHER!);
}

/** Start `run.ps1` under the shared launcher harness. */
function spawnLauncher(harness: Harness): Deno.ChildProcess {
  return spawnHarnessLauncher(harness, POWERSHELL_LAUNCHER!);
}

Deno.test({
  name: "run.ps1 - launches the container with exactly the permitted mounts",
  ignore,
  fn: async () => {
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

      // The read/write host mounts are created by the launcher, so the
      // runtime never invents a root-owned empty directory for them.
      assertEquals(
        (await Deno.stat(`${harness.tmpDir}/home/logs`)).isDirectory,
        true,
      );

      // The volume lifecycle mirrors run.sh (Issue #4186): ensure, then the
      // idempotent ownership init, before the worker starts.
      assert(await recorded(harness, "volume-inspect"));
      assert(await recorded(harness, "volume-create"));
      const init = await recorded(harness, "run-init");
      assert(init, "the volume-ownership init must run before the worker");
      assertEquals(
        init[init.indexOf("--entrypoint") + 1],
        "/usr/local/bin/vibe-volume-init",
      );

      // The image is present, so nothing was built.
      assertEquals(await recorded(harness, "build"), null);
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "run.ps1 - never mounts the host home, a runtime socket, or opens the container up",
  ignore,
  fn: async () => {
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
  },
});

Deno.test({
  name:
    "run.ps1 - builds the image when the content-derived reference is absent",
  ignore,
  fn: async () => {
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
      // Issue #4393: the build reads the comment-stripped copy the plan
      // wrote beside the plan file, never the committed Containerfile.
      const fileArg = build[build.indexOf("--file") + 1] ?? "";
      assert(
        /vibe-launch-plan-[^/\\]+\.Containerfile$/.test(fileArg),
        `--file must name the stripped copy: ${fileArg}`,
      );
      assertEquals(
        await Deno.readTextFile(`${harness.recordDir}/build.containerfile`),
        stripContainerfile(
          await Deno.readTextFile(`${REPO_ROOT}/container/Containerfile`),
        ),
      );

      // The build is not the end of the launch - the worker still starts.
      assert(await recorded(harness, "run"));
    } finally {
      await harness.cleanup();
    }
  },
});

/** A local image store holding the current reference and two superseded ones. */
const SUPERSEDED = ["vibe-coder:aaaaaaaaaaaa", "vibe-coder:bbbbbbbbbbbb"];
const IMAGE_STORE = [
  IMAGE,
  ...SUPERSEDED,
  // Not ours: neither may be touched.
  "node:22",
  "ghcr.io/other/vibe-coder:latest",
].join("\n");

Deno.test({
  name: "run.ps1 - prunes every superseded vibe-coder tag (Issue #4162)",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_IMAGE_LIST: IMAGE_STORE,
    });
    try {
      const outcome = await runLauncher(harness);
      assertEquals(outcome.code, 0, outcome.stderr);

      // Exactly the superseded tags of our own image - the current reference
      // and every foreign image are left alone, as on the bash launcher.
      assertEquals(await removedImages(harness), SUPERSEDED);
      for (const reference of SUPERSEDED) {
        assertStringIncludes(outcome.stderr, reference);
      }
      assert(await recorded(harness, "run"));
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "run.ps1 - a superseded tag the runtime refuses to remove is a warning, not a failed launch",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_IMAGE_LIST: IMAGE_STORE,
      STUB_IMAGE_REMOVE_EXIT: "1",
    });
    try {
      const outcome = await runLauncher(harness);
      // Reclaiming disk must never block a launch, but it must be said aloud.
      assertEquals(outcome.code, 0, outcome.stderr);
      assertStringIncludes(outcome.stderr, "prune");
      assert(await recorded(harness, "run"), "the worker still launched");
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "run.ps1 - exits with the container's exit status",
  ignore,
  fn: async () => {
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
  },
});

Deno.test({
  name: "run.ps1 - fails the launch when the image cannot be built",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "1",
      STUB_BUILD_EXIT: "9",
    });
    try {
      const outcome = await runLauncher(harness);
      assertEquals(outcome.code, 9, outcome.stderr);
      assertStringIncludes(outcome.stderr, "failed to build");
      assertEquals(
        await recorded(harness, "run"),
        null,
        "a failed build must not fall through to a launch",
      );
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "run.ps1 - waits for the container and reports a termination as failure",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_RUN_SLEEP: "5",
    });
    try {
      const child = spawnLauncher(harness);
      assert(
        await waitForRecord(harness, "run"),
        "the container never started",
      );

      // The launcher is still alive while the container runs — it did not
      // replace itself with the runtime — so terminating it is observable.
      child.kill("SIGTERM");
      const output = await child.output();

      assert(
        output.code !== 0,
        "a terminated launcher must report failure to loop.ps1 / Task " +
          "Scheduler, never a clean exit",
      );
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "run.ps1 - refuses to launch when another worker is already running on this host (Issue #26)",
  ignore,
  fn: async () => {
    const live = `vibe-coder-${Deno.pid}`;
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_LIST_JSON: JSON.stringify([{ Names: live }]),
    });
    try {
      const outcome = await runLauncher(harness);

      assert(outcome.code !== 0, "a second worker must not launch");
      assertStringIncludes(outcome.stderr, "another worker is already running");
      assertStringIncludes(outcome.stderr, live);
      assertEquals(await recorded(harness, "kill"), null);
      assertEquals(await recorded(harness, "build"), null);
      assertEquals(await recorded(harness, "run"), null);
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "run.ps1 - reaps a container that outlives the watchdog deadline",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      // The wedge: the container never exits and the runtime's own kill cannot
      // reap it, exactly as observed on host-23 (Issue #4173).
      STUB_RUN_SLEEP: "900",
      STUB_KILL_EXIT: "1",
      VIBE_CONTAINER_WATCHDOG_SECONDS: "2",
      VIBE_CONTAINER_REAP_GRACE_SECONDS: "2",
    });
    try {
      const outcome = await runLauncher(harness);

      // The same named non-zero reason run.sh reports, so the scheduler's next
      // cycle runs instead of the slot staying blocked.
      assertEquals(outcome.code, CONTAINER_WEDGED_EXIT_STATUS, outcome.stderr);
      assertStringIncludes(outcome.stderr, "watchdog");

      const args = await recorded(harness, "run");
      assert(args, "the container never started");
      assertEquals(
        await recorded(harness, "kill"),
        ["kill", args[args.indexOf("--name") + 1]!],
      );
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "run.ps1 - exits non-zero with an actionable message when no runtime is available",
  ignore,
  fn: async () => {
    const harness = await setupHarness({ STUB_PROBE_EXIT: "1" });
    try {
      const outcome = await runLauncher(harness);
      assert(outcome.code !== 0, "an unavailable runtime must fail the launch");
      assertStringIncludes(outcome.stderr, "No supported container runtime");
      assertStringIncludes(outcome.stderr, "no host fallback");
      assertEquals(await recorded(harness, "run"), null);
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "run.ps1 - fails loud when the credential directory is absent",
  ignore,
  fn: async () => {
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
  },
});

Deno.test({
  name:
    "run.ps1 - heals the builder and retries once when the build dies on storage (Issue #4441)",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "1",
      STUB_BUILD_EXIT: "1",
      STUB_BUILD_STDERR:
        'Error: resourceExhausted: "failed to solve: write /out.tar: no ' +
        'space left on device"',
      // The retry succeeds once the builder is usable again.
      STUB_BUILD_RETRY_EXIT: "0",
    });
    try {
      const outcome = await runLauncher(harness);

      assertEquals(outcome.code, 0, outcome.stderr);
      assertEquals(await buildCount(harness), 2);
      // The heal is whatever the launch plan's runtime needs: Docker and
      // Podman prune the build cache, Apple container (what the stub resolves
      // to on a macOS host) restarts its builder VM.
      assert(
        await builderHealed(harness),
        `no builder heal was performed: ${outcome.stderr}`,
      );
      assert(await recorded(harness, "run"), "the worker must still launch");
      assertStringIncludes(
        await runCoreLog(harness),
        "container-build-heal",
      );
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "run.ps1 - a build that failed for its own reasons is not healed or retried (Issue #4441)",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "1",
      STUB_BUILD_EXIT: "9",
      STUB_BUILD_STDERR: "E: Unable to locate package nosuchpackage",
    });
    try {
      const outcome = await runLauncher(harness);

      assertEquals(outcome.code, 9, outcome.stderr);
      assertEquals(await buildCount(harness), 1);
      assertEquals(await builderHealed(harness), false);
      assertEquals(await recorded(harness, "run"), null);
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test("run.ps1 - PowerShell availability is reported, never assumed", () => {
  // Fail loud rather than silently passing an untested launcher: when
  // PowerShell is present the suite above must have run.
  assertEquals(
    PWSH === null,
    ignore,
    "the PowerShell suite must run whenever PowerShell is resolvable",
  );
  if (ignore) {
    console.warn(
      "run.ps1 behavioural tests skipped: PowerShell (pwsh) is not " +
        "installed on this host. Set VIBE_PWSH to run them locally.",
    );
  }
});
