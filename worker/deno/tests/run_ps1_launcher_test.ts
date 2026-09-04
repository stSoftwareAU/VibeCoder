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
import { CONTAINER_START_EXIT_CODES } from "../lib/container_restart_backoff.ts";
import { CONTAINER_WEDGED_EXIT_STATUS } from "../lib/container_watchdog.ts";
import { stripContainerfile } from "../lib/containerfile_strip.ts";
import { activeAgentProvider } from "../lib/agent_provider.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import {
  buildCount,
  builderHealed,
  denoInvocationOrder,
  type Harness,
  type LaunchOutcome,
  mountValues,
  POWERSHELL_LAUNCHER,
  PWSH,
  recorded,
  recordedLaunchLog,
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

Deno.test({
  name:
    "run.ps1 - updates the worker checkout before it builds the launch plan (Issue #512)",
  ignore,
  fn: async () => {
    const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
    try {
      const outcome = await runLauncher(harness);
      assertEquals(outcome.code, 0, outcome.stderr);

      const args = await recorded(harness, "worker-checkout-update");
      assert(args, `the checkout was never updated: ${outcome.stderr}`);
      assertEquals(args[args.indexOf("--base-dir") + 1], REPO_ROOT);

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
  },
});

Deno.test({
  name:
    "run.ps1 - a failed checkout update warns and launches on the existing checkout (Issue #512)",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_CHECKOUT_UPDATE_EXIT: "1",
    });
    try {
      const outcome = await runLauncher(harness);
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
      assertStringIncludes(await runCoreLog(harness), "worker-checkout-update");
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

Deno.test({
  name:
    "run.ps1 - carries the container_tools spec into the build, JSON intact (Issue #72)",
  ignore,
  fn: async () => {
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
      // The JSON (quotes, braces, commas) must survive PowerShell argument
      // handling byte-for-byte — the parity risk this issue calls out.
      assertEquals(
        build[at + 1],
        `VIBE_CONTAINER_TOOLS=${JSON.stringify(spec)}`,
      );
      assertEquals(build.at(-1), `${REPO_ROOT}/container`);
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "run.ps1 - no container_tools means no extra build arg (Issue #72)",
  ignore,
  fn: async () => {
    const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "1" });
    try {
      const outcome = await runLauncher(harness);
      assertEquals(outcome.code, 0, outcome.stderr);
      const build = await recorded(harness, "build");
      assert(build, "an absent image reference must trigger a build");
      assertEquals(
        build.some((a) => a.startsWith("VIBE_CONTAINER_TOOLS=")),
        false,
      );
    } finally {
      await harness.cleanup();
    }
  },
});

// ---------------------------------------------------------------------------
// The container start the runtime client refused (Issue #720)
// ---------------------------------------------------------------------------
//
// The Windows counterpart of the run.sh capture (Issue #711). A
// `container_start` escalation filed from a Windows host named the phase and
// the exit status and nothing about why, because the client's stderr was
// inherited by the console and kept nowhere. `run.ps1` now pumps that stream to
// the console *and* to a capture, and hands the capture to the recorder as
// `--launch-log` for exactly the statuses that become a `container_start`
// escalation.

Deno.test({
  name:
    "run.ps1 - a refused container start quotes the runtime client's own stderr (Issue #720)",
  ignore,
  fn: async () => {
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
  },
});

Deno.test({
  name:
    "run.ps1 - the client's stderr reaches the console while the container is still running (Issue #720)",
  ignore,
  fn: async () => {
    // Capturing the output must not hold it back until the container exits:
    // the container's output IS this run's console, so an operator watching a
    // launch has to see it as it is produced. The stub prints its line and then
    // stalls, so a console line read before the launcher returns can only have
    // been streamed.
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
      const deadline = Date.now() + 120_000;
      while (!console_.includes(line) && Date.now() < deadline) {
        const read = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 5_000)
          ),
        ]);
        // A quiet slice is not the end of the stream (Issue #971). The
        // launcher inspects the image, prunes the store and creates two
        // volumes before the container is ever started, which on a slower
        // host is more than five seconds of silence — treating that silence
        // as end-of-stream failed the test for the one thing it does not
        // assert, how quickly the launcher gets as far as launching. Only the
        // overall deadline above ends the wait.
        if (read === null) continue;
        if (read.done) break;
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
  },
});

Deno.test({
  name:
    "run.ps1 - a container that started is never quoted as failure evidence (Issue #720)",
  ignore,
  fn: async () => {
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
      assert(args, "run.ps1 must record its own launcher outcome");
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
  },
});

Deno.test({
  name:
    "run.ps1 - keeps reaping a container that outruns the watchdog while it is still writing (Issue #720)",
  ignore,
  fn: async () => {
    // The regression the capture could introduce: the pump is what the
    // launcher waits in, so a deadline checked only while the stream is idle
    // would let a chatty container postpone its own reaping indefinitely —
    // the wedge the watchdog exists to end (Issue #4173).
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_RUN_SLEEP: "60",
      STUB_RUN_STDERR: "[stub] still working",
      // 600 writes, one every 50ms: the container is still talking well past
      // the 2s deadline below, and falls quiet ~30s in.
      STUB_RUN_STDERR_REPEAT: "0.05",
      STUB_KILL_EXIT: "1",
      VIBE_CONTAINER_WATCHDOG_SECONDS: "2",
      VIBE_CONTAINER_REAP_GRACE_SECONDS: "2",
    });
    try {
      // Timed from the container's first line to the reap, not across the
      // whole launcher run (Issue #971). The run also covers image
      // inspection, a store prune and two volume creations before the
      // container starts, and the orphaned writer holds the stderr pipe open
      // after it: on a slower host that padding alone outran the bound, so
      // the test failed for everything except the deadline it names.
      const child = spawnLauncher(harness);
      const decoder = new TextDecoder();
      let stderr = "";
      let containerStarted = -1;
      let reaped = -1;
      for await (const chunk of child.stderr) {
        stderr += decoder.decode(chunk, { stream: true });
        if (containerStarted < 0 && stderr.includes("[stub] still working")) {
          containerStarted = Date.now();
        }
        if (reaped < 0 && stderr.includes("watchdog:")) reaped = Date.now();
      }
      const status = await child.status;
      await child.stdout.cancel();

      assertEquals(status.code, CONTAINER_WEDGED_EXIT_STATUS, stderr);
      assertStringIncludes(stderr, "watchdog");
      // The stream really was flowing across the deadline, so the reap was
      // not merely an idle timeout.
      assertStringIncludes(stderr, "[stub] still working");
      assert(containerStarted >= 0, `the container never wrote: ${stderr}`);
      assert(reaped >= 0, `the watchdog never reported a reap: ${stderr}`);
      // Reaped on the deadline, not when the container happened to fall
      // quiet: a launcher that waits out the chatter takes the writer's whole
      // ~30s, three times this bound.
      const elapsed = reaped - containerStarted;
      assert(
        elapsed < 10_000,
        `the wedge was reaped ${elapsed}ms after the container started ` +
          `writing, long after the 2s deadline - the container's own output ` +
          `postponed it`,
      );
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "run.ps1 - the stderr capture leaves nothing behind in the temporary directory (Issue #720)",
  ignore,
  fn: async () => {
    const refusal = "Error: invalid reference format";
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_RUN_EXIT: "125",
      STUB_RUN_STDERR: refusal,
    }, { denoStub: true });
    const tmp = `${harness.tmpDir}/tmp`;
    await Deno.mkdir(tmp, { recursive: true });
    // .NET reads TMPDIR on Unix and TMP/TEMP on Windows; the launcher's
    // temporary directory is whichever this host uses.
    harness.env.TMPDIR = tmp;
    harness.env.TMP = tmp;
    harness.env.TEMP = tmp;
    try {
      const outcome = await runLauncher(harness);
      assertEquals(outcome.code, 125, outcome.stderr);

      // The capture existed and was quoted — the recorder's copy of it is the
      // proof, so an empty directory below cannot mean "never created".
      const log = await recordedLaunchLog(harness);
      assert(log !== null, "no capture was handed to the outcome recorder");
      assertStringIncludes(log, refusal);

      // And it did not outlive the launcher: one leaked capture per launch
      // would fill the host it is meant to keep launching.
      const leftovers: string[] = [];
      for await (const entry of Deno.readDir(tmp)) leftovers.push(entry.name);
      assertEquals(leftovers, []);
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test("run.ps1 - the statuses it treats as a refused start are the recorder's own (Issue #720)", async () => {
  // The launcher cannot import the recorder's list, so it carries a copy —
  // and a copy nothing checks is a copy that drifts. Pinned in both
  // directions: a status added to or removed from either side fails here.
  // Runs everywhere, PowerShell or not: it is the contract that is asserted.
  const source = await Deno.readTextFile(`${REPO_ROOT}/run.ps1`);
  const declaration = source.match(
    /\$ContainerStartExitStatuses = @\(([^)]*)\)/,
  );
  assert(
    declaration,
    "run.ps1 must name the statuses it treats as a refused container start",
  );
  const statuses = (declaration[1] ?? "").split(",").map((status) =>
    Number(status.trim())
  );
  assertEquals(statuses, [...CONTAINER_START_EXIT_CODES]);
});

// ---------------------------------------------------------------------------
// Self-heal attribution (Issue #710)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "run.ps1 - attributes a failed volume init to volume preparation, not runtime detection (Issue #710)",
  ignore,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      STUB_INIT_EXIT: "125",
    });
    try {
      const outcome = await runLauncher(harness);
      assertEquals(outcome.code, 125, outcome.stderr);
      const marker = await Deno.readTextFile(
        `${harness.tmpDir}/home/.vibe-coder/last-launch-phase`,
      );
      assertEquals(marker.trim(), "volume_init");
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "run.ps1 - the outcome recorder may read the hostname, so the alert can name the host (Issue #710)",
  ignore,
  fn: async () => {
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
  },
});
