/**
 * Tests for the container launch plan (Issue #4065).
 *
 * The plan is the trusted containment boundary: it decides exactly which host
 * paths the worker container sees and which privilege flags it is started
 * with. These tests call the real builder with real inputs and assert on the
 * argument list it produces, so a future edit that broadens the mount set or
 * the privileges fails here rather than on an unattended host.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  APPROVAL_STATE_VOLUME_NAME,
  buildContainerLaunchPlan,
  type ContainerLaunchInputs,
  containerTargetPaths,
  parseContainerLaunchPlanText,
  pathStyleFor,
  renderContainerLaunchPlan,
  resolveContainerLaunchHostPaths,
  resolveContainerResources,
  WORK_VOLUME_NAME,
} from "../lib/container_launch.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
  type ContainerRuntimeKind,
} from "../lib/container_runtime.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";
import { activeAgentProvider } from "../lib/agent_provider.ts";

const TEST_FILE_PATH = new URL(import.meta.url).pathname;
const REPO_ROOT = TEST_FILE_PATH.replace(/\/worker\/deno\/tests\/[^/]+$/, "");

/** The repository's real manifest — the source of the in-container layout. */
const MANIFEST: ContainerManifest = parseContainerManifest(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
);

function descriptorFor(kind: ContainerRuntimeKind): ContainerRuntimeDescriptor {
  const candidate = CONTAINER_RUNTIMES[kind];
  return {
    platform: kind === "apple-container" ? "darwin" : "linux",
    kind,
    executable: candidate.executable,
    displayName: candidate.displayName,
    dialect: candidate.dialect,
    probed: [kind],
  };
}

function inputs(
  overrides: Partial<ContainerLaunchInputs> = {},
): ContainerLaunchInputs {
  return {
    descriptor: descriptorFor("docker"),
    manifest: MANIFEST,
    image: "vibe-coder:0123456789ab",
    containerName: "vibe-coder-4242",
    watchdogSeconds: 11_400,
    hostPaths: {
      homeDir: "/home/operator",
      baseDir: "/opt/VibeCoder",
      workDir: "/home/operator/auto-issue-work",
      logDir: "/home/operator/logs",
      configFile: "/opt/VibeCoder/.config.json",
      configStageDir: "/home/operator/.vibe-coder/run-config",
      credentialDir: "/home/operator/.vibe-coder/credentials",
    },
    ...overrides,
  };
}

/** Mount values (`src:dst[:ro]`) from a rendered argument list. */
function mountValues(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--volume" || args[i] === "--mount") {
      values.push(args[i + 1] ?? "");
    }
  }
  return values;
}

Deno.test("buildContainerLaunchPlan - mounts exactly the permitted host paths", () => {
  const plan = buildContainerLaunchPlan(inputs());
  const targets = containerTargetPaths(MANIFEST);

  // Issue #4067: credentials are exposed per sub-directory — the worker's
  // `gh` material and the active provider's — so material belonging to any
  // other provider never enters the container.
  const provider = activeAgentProvider();
  assertEquals(plan.mounts.length, 7);
  assertEquals(
    plan.mounts.map((mount) => [mount.source, mount.target, !!mount.readOnly]),
    [
      // The checkout is read-only (Issue #514): the worker never modifies
      // the code it is running.
      ["/opt/VibeCoder", targets.base, true],
      // The work dir and its approval-state sibling ride named volumes
      // (Issue #4186): fast guest-owned filesystems, no host directory.
      [WORK_VOLUME_NAME, targets.work, false],
      [APPROVAL_STATE_VOLUME_NAME, targets.approvalState, false],
      ["/home/operator/logs", targets.logs, false],
      ["/home/operator/.vibe-coder/run-config", targets.config, true],
      [
        "/home/operator/.vibe-coder/credentials/gh",
        `${targets.credentials}/gh`,
        true,
      ],
      [
        `/home/operator/.vibe-coder/credentials/${provider.credentials.subdir}`,
        `${targets.credentials}/${provider.credentials.subdir}`,
        true,
      ],
    ],
  );

  assertEquals(mountValues(plan.runArgs), [
    `/opt/VibeCoder:${targets.base}:ro`,
    `${WORK_VOLUME_NAME}:${targets.work}`,
    `${APPROVAL_STATE_VOLUME_NAME}:${targets.approvalState}`,
    `/home/operator/logs:${targets.logs}`,
    `/home/operator/.vibe-coder/run-config:${targets.config}:ro`,
    `/home/operator/.vibe-coder/credentials/gh:${targets.credentials}/gh:ro`,
    `/home/operator/.vibe-coder/credentials/${provider.credentials.subdir}:` +
    `${targets.credentials}/${provider.credentials.subdir}:ro`,
  ]);
});

Deno.test("buildContainerLaunchPlan - named volumes carry the work dir and approval state (Issue #4186)", () => {
  const plan = buildContainerLaunchPlan(inputs());
  const targets = containerTargetPaths(MANIFEST);

  // The volumes the launcher must ensure exist, in mount order. Fixed names,
  // independent of the per-run container name and of the image tag: clones
  // survive every cycle and every image upgrade.
  assertEquals(plan.volumes, [WORK_VOLUME_NAME, APPROVAL_STATE_VOLUME_NAME]);

  // A fresh volume is root-owned, so the plan carries a one-shot init run the
  // launcher executes before the worker: root chowns the two mount roots to
  // the image's worker account. Idempotent — the launcher runs it every time.
  assertEquals(plan.initArgs, [
    "run",
    "--rm",
    "--name",
    "vibe-coder-4242-init",
    "--user",
    "0:0",
    "--entrypoint",
    "/usr/local/bin/vibe-volume-init",
    "--volume",
    `${WORK_VOLUME_NAME}:${targets.work}`,
    "--volume",
    `${APPROVAL_STATE_VOLUME_NAME}:${targets.approvalState}`,
    "vibe-coder:0123456789ab",
    `${MANIFEST.user.uid}:${MANIFEST.user.gid}`,
    targets.work,
    targets.approvalState,
  ]);
});

Deno.test("buildContainerLaunchPlan - volume-name overrides isolate tests, never smuggle a path", () => {
  // The containment integration tests use per-run throwaway volumes so they
  // never touch a production host's vibe-work state (Issue #4186).
  const plan = buildContainerLaunchPlan(inputs({
    volumes: {
      work: "vibe-test-work-1234",
      approvalState: "vibe-test-as-1234",
    },
  }));
  assertEquals(plan.volumes, ["vibe-test-work-1234", "vibe-test-as-1234"]);

  // The override is a volume *name*, never a host path: anything shaped like
  // a path (or otherwise unframeable) is refused, so the knob cannot broaden
  // the mount set.
  const error = assertThrows(
    () =>
      buildContainerLaunchPlan(inputs({
        volumes: { work: "/etc", approvalState: "vibe-test-as-1234" },
      })),
    Error,
  );
  assertStringIncludes(error.message, "volume name");
});

Deno.test("containerTargetPaths - the approval-state volume lands where the worker resolves it", () => {
  // The approval store is the sibling of the work dir (Issue #3717); mounting
  // its own volume at exactly that path is what makes tamper snapshots
  // survive a container kill (the bug found designing Issue #4186). This
  // pins the mount target to the worker's own resolution so the two can
  // never drift apart.
  const targets = containerTargetPaths(MANIFEST);
  assertEquals(
    targets.approvalState,
    resolveContentApprovalStateDir(targets.work),
  );
});

Deno.test("buildContainerLaunchPlan - in-container paths are the worker's own defaults", () => {
  const targets = containerTargetPaths(MANIFEST);
  assertEquals(targets.base, "/workspace");
  assertEquals(targets.work, "/home/vibe/auto-issue-work");
  assertEquals(targets.logs, "/home/vibe/logs");
  // A directory outside /workspace: Apple container cannot mount a single
  // file, and any file mount silently empties the other volumes — so the
  // staged config directory is mounted instead (verified on host-23).
  assertEquals(targets.config, "/home/vibe/.vibe-coder/run-config");
  assertEquals(targets.credentials, "/home/vibe/.vibe-coder/credentials");
});

Deno.test("buildContainerLaunchPlan - sizes the VM for real work (memory and cpus)", () => {
  // Apple container's default VM is 1 GiB / 4 CPUs. Observed live on host-23:
  // claude + a cargo-build quality gate inside 1 GiB memory-stalled the VM —
  // a trivial README task ran 3h16m to a no-changes timeout and three VMs
  // wedged outright. Every runtime dialect accepts --memory/--cpus.
  const plan = buildContainerLaunchPlan(inputs());
  const memIdx = plan.runArgs.indexOf("--memory");
  assert(memIdx > 0, plan.runArgs.join(" "));
  assertEquals(plan.runArgs[memIdx + 1], "8g");
  // No resolved host cpu count → no --cpus: a static guess can exceed a
  // small host's cores, which Docker hard-rejects (seen live in CI: "range
  // of CPUs is from 0.01 to 2.00"). The runtime's own default applies.
  assertEquals(plan.runArgs.includes("--cpus"), false);

  // Operator overrides flow through verbatim.
  const sized = buildContainerLaunchPlan(
    inputs({ resources: { memory: "12g", cpus: "8" } }),
  );
  assertEquals(sized.runArgs[sized.runArgs.indexOf("--memory") + 1], "12g");
  assertEquals(sized.runArgs[sized.runArgs.indexOf("--cpus") + 1], "8");
});

Deno.test("resolveContainerResources - host-aware defaults with operator overrides", () => {
  // Everything minus an 8 GiB host reserve (Issue #4229): half-the-host
  // was a conservative default the philosophy forbids, and it OOM-killed
  // the agent + quality gate three times on the shared 24 GiB laptop.
  // cores-4 with a floor of 4 (Issue #4272): cores-2 oversubscribed a
  // shared host — an 8-vCPU VM on the 10-core laptop stalled wholesale
  // whenever host load burst, and the guest's agent was SIGKILLed by
  // heartbeat machinery (kills at 105 s with nothing heavy in the VM;
  // the only 70-minute survivor ran on an idle host).
  assertEquals(
    resolveContainerResources({
      env: () => undefined,
      totalMemoryBytes: 24 * 1024 ** 3,
      cpuCount: 12,
    }),
    { memory: "16g", cpus: "8" },
  );
  // The host-23 shape: 10-core shared laptop leaves 4 cores for the host.
  assertEquals(
    resolveContainerResources({
      env: () => undefined,
      totalMemoryBytes: 24 * 1024 ** 3,
      cpuCount: 10,
    }),
    { memory: "16g", cpus: "6" },
  );
  // Small host floors at 8g/4 — capped at the host's own cores.
  assertEquals(
    resolveContainerResources({
      env: () => undefined,
      totalMemoryBytes: 8 * 1024 ** 3,
      cpuCount: 4,
    }),
    { memory: "8g", cpus: "4" },
  );
  // A 2-core CI host must never be asked for more than 2 cpus, and a tiny
  // host's memory floor is its own total, not 8g.
  assertEquals(
    resolveContainerResources({
      env: () => undefined,
      totalMemoryBytes: 7 * 1024 ** 3,
      cpuCount: 2,
    }),
    { memory: "7g", cpus: "2" },
  );
  // Big dedicated host: everything but the reserve.
  assertEquals(
    resolveContainerResources({
      env: () => undefined,
      totalMemoryBytes: 64 * 1024 ** 3,
      cpuCount: 20,
    }),
    { memory: "56g", cpus: "16" },
  );
  // The 8g floor holds where total-minus-reserve would dip below it.
  assertEquals(
    resolveContainerResources({
      env: () => undefined,
      totalMemoryBytes: 16 * 1024 ** 3,
      cpuCount: 8,
    }),
    { memory: "8g", cpus: "4" },
  );
  // Operator env overrides win verbatim (a dedicated host can go beyond).
  assertEquals(
    resolveContainerResources({
      env: (n) =>
        n === "VIBE_CONTAINER_MEMORY"
          ? "24g"
          : n === "VIBE_CONTAINER_CPUS"
          ? "10"
          : undefined,
      totalMemoryBytes: 64 * 1024 ** 3,
      cpuCount: 20,
    }),
    { memory: "24g", cpus: "10" },
  );
  // Unreadable host info: memory floors at 8g (never the runtime's 1 GiB
  // default); cpus stays unset so the runtime default applies.
  assertEquals(
    resolveContainerResources({ env: () => undefined }),
    { memory: "8g" },
  );
  // Configurable reserve (Issue #4301): a dedicated fleet host sets
  // VIBE_CONTAINER_CPU_RESERVE=0 and the VM gets every core; a partial
  // reserve is honoured; garbage falls back to the default.
  assertEquals(
    resolveContainerResources({
      env: (n) => n === "VIBE_CONTAINER_CPU_RESERVE" ? "0" : undefined,
      totalMemoryBytes: 24 * 1024 ** 3,
      cpuCount: 10,
    }),
    { memory: "16g", cpus: "10" },
  );
  assertEquals(
    resolveContainerResources({
      env: (n) => n === "VIBE_CONTAINER_CPU_RESERVE" ? "2" : undefined,
      totalMemoryBytes: 24 * 1024 ** 3,
      cpuCount: 10,
    }),
    { memory: "16g", cpus: "8" },
  );
  assertEquals(
    resolveContainerResources({
      env: (n) => n === "VIBE_CONTAINER_CPU_RESERVE" ? "lots" : undefined,
      totalMemoryBytes: 24 * 1024 ** 3,
      cpuCount: 10,
    }),
    { memory: "16g", cpus: "6" },
  );
});

Deno.test("buildContainerLaunchPlan - passes the host identity into the container", () => {
  // private-repo-6 heartbeats must name the real host, not the ephemeral
  // container hostname (a fresh name every cycle would leave the host
  // permanently "dead" on the fleet board and add a phantom host per run).
  const plan = buildContainerLaunchPlan(inputs({ hostId: "host-23" }));
  assertEquals(plan.runArgs.includes("VIBE_HOST_ID=host-23"), true);
  // Without a hostId the env is simply absent — the worker falls back to
  // its own hostname (native mode behaviour).
  const bare = buildContainerLaunchPlan(inputs());
  assertEquals(
    bare.runArgs.some((arg) => arg.startsWith("VIBE_HOST_ID=")),
    false,
  );
});

Deno.test("buildContainerLaunchPlan - points the worker at the staged read-only config", () => {
  const plan = buildContainerLaunchPlan(inputs());
  const targets = containerTargetPaths(MANIFEST);
  // CONFIG_PATH must name the file inside the staged read-only directory —
  // never /workspace/.config.json, which is the writable repo-mount copy.
  assertEquals(
    plan.runArgs.includes(`CONFIG_PATH=${targets.config}/.config.json`),
    true,
    plan.runArgs.join(" "),
  );
});

Deno.test("buildContainerLaunchPlan - starts the container with least privilege", () => {
  const plan = buildContainerLaunchPlan(inputs());

  assertEquals(plan.runArgs[0], "run");
  assertEquals(plan.runArgs.includes("--rm"), true);
  assertEquals(plan.runArgs.includes("--cap-drop"), true);
  assertEquals(plan.runArgs.includes("ALL"), true);
  assertEquals(plan.runArgs.includes("--security-opt"), true);
  assertEquals(plan.runArgs.includes("no-new-privileges"), true);
  assertEquals(plan.runArgs.includes("--network"), true);
  assertEquals(plan.runArgs.includes("bridge"), true);
  assertEquals(
    plan.runArgs.some((arg) => arg.startsWith("/tmp:")),
    true,
    "a writable tmpfs keeps the container root filesystem disposable",
  );
  // The image is the last argument, so the launcher can append the worker's
  // own arguments after it.
  assertEquals(
    plan.runArgs[plan.runArgs.length - 1],
    "vibe-coder:0123456789ab",
  );
});

Deno.test("buildContainerLaunchPlan - never broadens privileges or publishes ports", () => {
  const plan = buildContainerLaunchPlan(inputs());
  const forbidden = [
    "--privileged",
    "--publish",
    "-p",
    "--cap-add",
    "--device",
    "--pid=host",
    "--userns=host",
    "--network=host",
    "host",
  ];
  for (const flag of forbidden) {
    assertEquals(
      plan.runArgs.includes(flag),
      false,
      `run arguments must not contain ${flag}`,
    );
  }
  for (const value of mountValues(plan.runArgs)) {
    assertEquals(
      value.includes(".sock"),
      false,
      "no container-runtime control socket may be mounted",
    );
  }
});

Deno.test("buildContainerLaunchPlan - omits flags the runtime does not support", () => {
  const plan = buildContainerLaunchPlan(
    inputs({ descriptor: descriptorFor("apple-container") }),
  );

  assertEquals(plan.runArgs.includes("--cap-drop"), false);
  assertEquals(plan.runArgs.includes("--security-opt"), false);
  assertEquals(plan.runArgs.includes("--tmpfs"), false);
  assertEquals(plan.runArgs.includes("--network"), false);
  // The mount set is identical regardless of runtime.
  assertEquals(mountValues(plan.runArgs).length, 7);
  // Singular `image`, verified against Apple container 1.2.2 on a real host:
  // `container images ...` is not a subcommand there — the CLI tries to load
  // a plugin named `container-images`, fails, and exits 64, which run.sh
  // would read as "image absent" and rebuild on every launch.
  assertEquals(plan.imageInspectArgs, [
    "image",
    "inspect",
    "vibe-coder:0123456789ab",
  ]);
});

Deno.test("buildContainerLaunchPlan - build and inspect use the runtime's dialect", () => {
  const plan = buildContainerLaunchPlan(inputs());

  assertEquals(plan.imageInspectArgs, [
    "image",
    "inspect",
    "vibe-coder:0123456789ab",
  ]);
  assertEquals(plan.buildArgs, [
    "build",
    "--file",
    "/opt/VibeCoder/container/Containerfile",
    "--tag",
    "vibe-coder:0123456789ab",
    "/opt/VibeCoder/container",
  ]);
});

Deno.test("buildContainerLaunchPlan - a stripped Containerfile path is what --file names; the context stays container/ (Issue #4393)", () => {
  const plan = buildContainerLaunchPlan({
    ...inputs(),
    containerfile: "/tmp/vibe-launch-plan.abc123.Containerfile",
  });
  assertEquals(plan.buildArgs.slice(0, 3), [
    "build",
    "--file",
    "/tmp/vibe-launch-plan.abc123.Containerfile",
  ]);
  assertEquals(plan.buildArgs.at(-1), "/opt/VibeCoder/container");
});

Deno.test("buildContainerLaunchPlan - the launcher only ensures the read/write host mounts", () => {
  // The work dir moved onto a named volume (Issue #4186) and the checkout is
  // read-only (Issue #514), so the log directory is the only host directory
  // left for the launcher to create — on the read-only test alone, with no
  // second overlapping exclusion for the checkout.
  const plan = buildContainerLaunchPlan(inputs());
  assertEquals(plan.ensureDirectories, ["/home/operator/logs"]);
  assert(
    !plan.ensureDirectories.includes("/opt/VibeCoder"),
    "the launcher must never create or touch the read-only checkout mount",
  );
});

// ---------------------------------------------------------------------------
// The worker checkout is read-only (Issue #514)
// ---------------------------------------------------------------------------

Deno.test("buildContainerLaunchPlan - mounts the worker checkout read-only in every runtime dialect (Issue #514)", () => {
  const targets = containerTargetPaths(MANIFEST);

  // Every supported dialect, not just the one the test host happens to run:
  // the read-only marker is spelled by the dialect, so a runtime added with
  // a different suffix must still render the checkout mount read-only.
  for (const kind of ["docker", "podman", "apple-container"] as const) {
    const descriptor = descriptorFor(kind);
    const plan = buildContainerLaunchPlan(inputs({ descriptor }));

    const checkout = plan.mounts.find((mount) => mount.target === targets.base);
    assert(checkout, `${kind}: the plan must mount the checkout`);
    assertEquals(
      checkout.readOnly,
      true,
      `${kind}: the checkout mount must be read-only`,
    );

    // And the flag must actually survive into the rendered arguments — a
    // ContainerMount field the dialect never spells would contain nothing.
    const suffix = descriptor.dialect.readOnlyMountSuffix;
    assertEquals(
      mountValues(plan.runArgs)[0],
      `/opt/VibeCoder:${targets.base}${suffix}`,
      `${kind}: the rendered checkout mount must carry ${suffix}`,
    );

    // The rendered stream the launchers read carries it too, so neither
    // run.sh nor run.ps1 can drop it on the way to the runtime.
    assertStringIncludes(
      renderContainerLaunchPlan(plan),
      `run=/opt/VibeCoder:${targets.base}${suffix}\0`,
    );
  }
});

Deno.test("buildContainerLaunchPlan - refuses to mount the host home directory", () => {
  const error = assertThrows(
    () =>
      buildContainerLaunchPlan(
        inputs({
          hostPaths: {
            homeDir: "/home/operator",
            baseDir: "/opt/VibeCoder",
            workDir: "/home/operator/auto-issue-work",
            logDir: "/home/operator",
            configFile: "/opt/VibeCoder/.config.json",
            configStageDir: "/home/operator/.vibe-coder/run-config",
            credentialDir: "/home/operator/.vibe-coder/credentials",
          },
        }),
      ),
    Error,
  );
  assertStringIncludes(error.message, "home directory");
});

Deno.test("buildContainerLaunchPlan - refuses an ancestor of the home directory", () => {
  const error = assertThrows(
    () =>
      buildContainerLaunchPlan(
        inputs({
          hostPaths: {
            homeDir: "/home/operator",
            baseDir: "/opt/VibeCoder",
            workDir: "/home/operator/auto-issue-work",
            logDir: "/home",
            configFile: "/opt/VibeCoder/.config.json",
            configStageDir: "/home/operator/.vibe-coder/run-config",
            credentialDir: "/home/operator/.vibe-coder/credentials",
          },
        }),
      ),
    Error,
  );
  assertStringIncludes(error.message, "home directory");
});

Deno.test("buildContainerLaunchPlan - refuses a container-runtime control socket", () => {
  for (
    const socket of [
      "/var/run/docker.sock",
      "/run/user/1000/podman/podman.sock",
      "/tmp/container.sock",
    ]
  ) {
    const error = assertThrows(
      () =>
        buildContainerLaunchPlan(
          inputs({
            hostPaths: {
              homeDir: "/home/operator",
              baseDir: "/opt/VibeCoder",
              workDir: "/home/operator/auto-issue-work",
              logDir: socket,
              configFile: "/opt/VibeCoder/.config.json",
              configStageDir: "/home/operator/.vibe-coder/run-config",
              credentialDir: "/home/operator/.vibe-coder/credentials",
            },
          }),
        ),
      Error,
      undefined,
      `expected ${socket} to be refused`,
    );
    assertStringIncludes(error.message, "socket");
  }
});

Deno.test("buildContainerLaunchPlan - refuses a relative or unframeable mount source", () => {
  const relative = assertThrows(
    () =>
      buildContainerLaunchPlan(
        inputs({
          hostPaths: {
            homeDir: "/home/operator",
            baseDir: "relative/checkout",
            workDir: "/home/operator/auto-issue-work",
            logDir: "/home/operator/logs",
            configFile: "/opt/VibeCoder/.config.json",
            configStageDir: "/home/operator/.vibe-coder/run-config",
            credentialDir: "/home/operator/.vibe-coder/credentials",
          },
        }),
      ),
    Error,
  );
  assertStringIncludes(relative.message, "absolute");

  const newline = assertThrows(
    () =>
      buildContainerLaunchPlan(
        inputs({
          hostPaths: {
            homeDir: "/home/operator",
            baseDir: "/opt/Vibe\nCoding",
            workDir: "/home/operator/auto-issue-work",
            logDir: "/home/operator/logs",
            configFile: "/opt/VibeCoder/.config.json",
            configStageDir: "/home/operator/.vibe-coder/run-config",
            credentialDir: "/home/operator/.vibe-coder/credentials",
          },
        }),
      ),
    Error,
  );
  assertStringIncludes(newline.message, "control character");
});

Deno.test("buildContainerLaunchPlan - rejects an unusable container name", () => {
  const error = assertThrows(
    () => buildContainerLaunchPlan(inputs({ containerName: "vibe coder;rm" })),
    Error,
  );
  assertStringIncludes(error.message, "container name");
});

Deno.test("buildContainerLaunchPlan - refuses a plan with no usable watchdog deadline", () => {
  for (const watchdogSeconds of [0, -1, Number.NaN]) {
    const error = assertThrows(
      () => buildContainerLaunchPlan(inputs({ watchdogSeconds })),
      Error,
    );
    // A launcher handed no deadline would wait on a wedged container for ever
    // — the failure Issue #4173 exists to end.
    assertStringIncludes(error.message, "watchdog deadline");
  }
});

Deno.test("resolveContainerLaunchHostPaths - defaults follow the worker's own resolution", () => {
  const paths = resolveContainerLaunchHostPaths("/opt/VibeCoder", (name) =>
    ({
      HOME: "/home/operator",
    })[name]);

  assertEquals(paths.homeDir, "/home/operator");
  assertEquals(paths.workDir, "/home/operator/auto-issue-work");
  assertEquals(paths.logDir, "/home/operator/logs");
  assertEquals(paths.configFile, "/opt/VibeCoder/.config.json");
  assertEquals(
    paths.configStageDir,
    "/home/operator/.vibe-coder/run-config",
  );
  assertEquals(
    paths.credentialDir,
    "/home/operator/.vibe-coder/credentials",
  );
});

Deno.test("resolveContainerLaunchHostPaths - honours the worker's own overrides", () => {
  const env: Record<string, string> = {
    HOME: "/home/operator",
    WORK_DIR: "/data/work",
    CONFIG_PATH: "/etc/vibe/config.json",
    VIBE_CREDENTIAL_DIR: "/data/creds",
  };
  const paths = resolveContainerLaunchHostPaths(
    "/opt/VibeCoder",
    (name) => env[name],
  );

  assertEquals(paths.workDir, "/data/work");
  assertEquals(paths.configFile, "/etc/vibe/config.json");
  assertEquals(paths.credentialDir, "/data/creds");
});

Deno.test("resolveContainerLaunchHostPaths - relative overrides resolve against the checkout", () => {
  const env: Record<string, string> = {
    HOME: "/home/operator",
    CONFIG_PATH: ".config.json",
  };
  const paths = resolveContainerLaunchHostPaths(
    "/opt/VibeCoder",
    (name) => env[name],
  );
  assertEquals(paths.configFile, "/opt/VibeCoder/.config.json");
});

Deno.test("resolveContainerLaunchHostPaths - fails loud without a home directory", () => {
  const error = assertThrows(
    () => resolveContainerLaunchHostPaths("/opt/VibeCoder", () => undefined),
    Error,
  );
  assertStringIncludes(error.message, "HOME");
});

Deno.test("renderContainerLaunchPlan - round-trips through the launcher's framing", () => {
  const plan = buildContainerLaunchPlan(inputs());
  const parsed = parseContainerLaunchPlanText(renderContainerLaunchPlan(plan));

  assertEquals(parsed.runtime, "docker");
  assertEquals(parsed.image, "vibe-coder:0123456789ab");
  assertEquals(parsed.name, "vibe-coder-4242");
  // The launcher's outer deadline travels in the plan, so both launchers wait
  // under the same one and neither invents its own (Issue #4173).
  assertEquals(parsed.watchdog, "11400");
  assertEquals(parsed.run, plan.runArgs);
  assertEquals(parsed.build, plan.buildArgs);
  assertEquals(parsed.exists, plan.imageInspectArgs);
  assertEquals(parsed.ensure, plan.ensureDirectories);
  assertEquals(parsed.volume, plan.volumes);
  assertEquals(parsed.init, plan.initArgs);
});

// ---------------------------------------------------------------------------
// Windows hosts (Issue #4066)
//
// `run.ps1` hands over Windows host paths. Only the host side of a mount
// changes: the in-container side stays exactly what `run.sh` produces, so the
// worker sees one environment regardless of which launcher started it.
// ---------------------------------------------------------------------------

/** Host paths as `run.ps1` resolves them on a Windows host. */
const WINDOWS_HOST_PATHS = {
  homeDir: "C:\\Users\\operator",
  baseDir: "C:\\VibeCoder",
  workDir: "C:\\Users\\operator\\auto-issue-work",
  logDir: "C:\\Users\\operator\\logs",
  configFile: "C:\\VibeCoder\\.config.json",
  configStageDir: "C:\\Users\\operator\\.vibe-coder\\run-config",
  credentialDir: "C:\\Users\\operator\\.vibe-coder\\credentials",
};

Deno.test("pathStyleFor - recognises the host's own path spelling", () => {
  assertEquals(pathStyleFor("C:\\VibeCoder"), "windows");
  assertEquals(pathStyleFor("c:/VibeCoder"), "windows");
  assertEquals(pathStyleFor("/opt/VibeCoder"), "posix");
  assertEquals(pathStyleFor("relative/checkout"), "posix");
});

Deno.test("buildContainerLaunchPlan - Windows hosts mount the same targets", () => {
  const plan = buildContainerLaunchPlan(
    inputs({ hostPaths: WINDOWS_HOST_PATHS }),
  );
  const targets = containerTargetPaths(MANIFEST);

  assertEquals(mountValues(plan.runArgs), [
    `C:\\VibeCoder:${targets.base}:ro`,
    // Named volumes are runtime objects, not host paths: their spelling is
    // identical on every host (Issue #4186).
    `${WORK_VOLUME_NAME}:${targets.work}`,
    `${APPROVAL_STATE_VOLUME_NAME}:${targets.approvalState}`,
    `C:\\Users\\operator\\logs:${targets.logs}`,
    `C:\\Users\\operator\\.vibe-coder\\run-config:${targets.config}:ro`,
    `C:\\Users\\operator\\.vibe-coder\\credentials\\gh:${targets.credentials}/gh:ro`,
    `C:\\Users\\operator\\.vibe-coder\\credentials\\${activeAgentProvider().credentials.subdir}:${targets.credentials}/${activeAgentProvider().credentials.subdir}:ro`,
  ]);

  // The two launchers differ only in the host spelling: same count, same
  // targets, same read-only modes as the POSIX plan.
  const posix = buildContainerLaunchPlan(inputs());
  assertEquals(
    plan.mounts.map((mount) => [mount.target, mount.readOnly === true]),
    posix.mounts.map((mount) => [mount.target, mount.readOnly === true]),
  );
  assertEquals(
    plan.runArgs.filter((arg) => arg.startsWith("--")),
    posix.runArgs.filter((arg) => arg.startsWith("--")),
  );
});

Deno.test("buildContainerLaunchPlan - Windows build arguments use host separators", () => {
  const plan = buildContainerLaunchPlan(
    inputs({ hostPaths: WINDOWS_HOST_PATHS }),
  );
  assertEquals(plan.buildArgs, [
    "build",
    "--file",
    "C:\\VibeCoder\\container\\Containerfile",
    "--tag",
    "vibe-coder:0123456789ab",
    "C:\\VibeCoder\\container",
  ]);
  assertEquals(plan.ensureDirectories, ["C:\\Users\\operator\\logs"]);
});

Deno.test("buildContainerLaunchPlan - refuses a Windows profile or drive root", () => {
  for (
    const source of [
      "C:\\Users\\operator",
      "c:/users/OPERATOR",
      "C:\\Users",
    ]
  ) {
    const error = assertThrows(
      () =>
        buildContainerLaunchPlan(
          inputs({
            hostPaths: { ...WINDOWS_HOST_PATHS, logDir: source },
          }),
        ),
      Error,
      undefined,
      `expected ${source} to be refused`,
    );
    assertStringIncludes(error.message, "home directory");
  }

  const root = assertThrows(
    () =>
      buildContainerLaunchPlan(
        inputs({ hostPaths: { ...WINDOWS_HOST_PATHS, logDir: "C:\\" } }),
      ),
    Error,
  );
  assertStringIncludes(root.message, "root");
});

Deno.test("buildContainerLaunchPlan - refuses the Windows runtime control pipe", () => {
  const error = assertThrows(
    () =>
      buildContainerLaunchPlan(
        inputs({
          hostPaths: {
            ...WINDOWS_HOST_PATHS,
            logDir: "\\\\.\\pipe\\docker_engine",
          },
        }),
      ),
    Error,
  );
  assertStringIncludes(error.message, "socket");
});

Deno.test("buildContainerLaunchPlan - refuses a drive-relative Windows source", () => {
  const error = assertThrows(
    () =>
      buildContainerLaunchPlan(
        inputs({ hostPaths: { ...WINDOWS_HOST_PATHS, logDir: "C:work" } }),
      ),
    Error,
  );
  assertStringIncludes(error.message, "absolute");
});

Deno.test("resolveContainerLaunchHostPaths - Windows defaults follow USERPROFILE", () => {
  const env: Record<string, string> = {
    USERPROFILE: "C:\\Users\\operator\\",
    // A Unix-emulation HOME must not win on a Windows host: the runtime
    // cannot bind it.
    HOME: "/c/Users/operator",
  };
  const paths = resolveContainerLaunchHostPaths(
    "C:\\VibeCoder",
    (name) => env[name],
  );

  assertEquals(paths.homeDir, "C:\\Users\\operator");
  assertEquals(paths.workDir, "C:\\Users\\operator\\auto-issue-work");
  assertEquals(paths.logDir, "C:\\Users\\operator\\logs");
  assertEquals(paths.configFile, "C:\\VibeCoder\\.config.json");
  assertEquals(
    paths.credentialDir,
    "C:\\Users\\operator\\.vibe-coder\\credentials",
  );
});

Deno.test("resolveContainerLaunchHostPaths - Windows overrides are honoured", () => {
  const env: Record<string, string> = {
    USERPROFILE: "C:\\Users\\operator",
    WORK_DIR: "D:\\vibe\\work",
    CONFIG_PATH: ".config.json",
    VIBE_CREDENTIAL_DIR: "D:\\vibe\\creds",
  };
  const paths = resolveContainerLaunchHostPaths(
    "C:\\VibeCoder",
    (name) => env[name],
  );

  assertEquals(paths.workDir, "D:\\vibe\\work");
  assertEquals(paths.configFile, "C:\\VibeCoder\\.config.json");
  assertEquals(paths.credentialDir, "D:\\vibe\\creds");
});

// ---------------------------------------------------------------------------
// The provider layer is separable (Issue #4067)
// ---------------------------------------------------------------------------

Deno.test("buildContainerLaunchPlan - exposes only the active provider's credentials", () => {
  // A second provider is a descriptor, not an edit to the mount construction:
  // the plan follows whatever credential sub-directory the descriptor names.
  const nextProvider = {
    ...activeAgentProvider(),
    id: "next",
    credentials: {
      ...activeAgentProvider().credentials,
      subdir: "next-provider",
    },
  };

  const plan = buildContainerLaunchPlan(
    inputs({ agentProviders: [nextProvider] }),
  );
  const targets = containerTargetPaths(MANIFEST);
  const readOnly = plan.mounts.filter((mount) => mount.readOnly);

  assertEquals(
    readOnly.map((mount) => mount.source),
    [
      // The checkout leads the read-only set since Issue #514.
      "/opt/VibeCoder",
      "/home/operator/.vibe-coder/run-config",
      "/home/operator/.vibe-coder/credentials/gh",
      "/home/operator/.vibe-coder/credentials/next-provider",
    ],
  );
  assertEquals(
    readOnly[3]?.target,
    `${targets.credentials}/next-provider`,
  );
  // The other provider's material stays on the host.
  assertEquals(
    plan.mounts.some((mount) =>
      mount.source.endsWith(`/${activeAgentProvider().credentials.subdir}`)
    ),
    false,
  );
});

Deno.test("buildContainerLaunchPlan - carries the builder-stop arguments only for runtimes with a builder helper (Issue #4331)", () => {
  const apple = buildContainerLaunchPlan(
    inputs({ descriptor: descriptorFor("apple-container") }),
  );
  assertEquals(apple.builderStopArgs, ["builder", "stop"]);
  const docker = buildContainerLaunchPlan(
    inputs({ descriptor: descriptorFor("docker") }),
  );
  assertEquals(docker.builderStopArgs, []);
  // And the rendered plan names them under their own key.
  const rendered = renderContainerLaunchPlan(apple);
  assertEquals(
    rendered.includes("builder-stop=builder\0builder-stop=stop\0"),
    true,
  );
});

Deno.test("buildContainerLaunchPlan - passes the host disk reading into the container (Issue #226)", () => {
  // Inside the container df sees the virtual work volume, not the host
  // filesystem it is thin-provisioned on; the launcher's reading is what
  // the worker gates new claims on.
  const plan = buildContainerLaunchPlan(
    inputs({
      hostDisk: { availableBytes: 24_000_000_000, totalBytes: 494_000_000_000 },
    }),
  );
  assertEquals(
    plan.runArgs.includes("VIBE_HOST_DISK_AVAIL_BYTES=24000000000"),
    true,
  );
  assertEquals(
    plan.runArgs.includes("VIBE_HOST_DISK_TOTAL_BYTES=494000000000"),
    true,
  );
  const bare = buildContainerLaunchPlan(inputs());
  assertEquals(
    bare.runArgs.some((arg) => arg.startsWith("VIBE_HOST_DISK_")),
    false,
  );
});

Deno.test("buildContainerLaunchPlan - passes the supervisor run cap into the container (Issue #421)", () => {
  // Inside the container the worker cannot see loop.sh's `timeout`, so the
  // cap and the run's start epoch are handed over explicitly; without them
  // the progress-extension policy applies no ceiling and a progressing run
  // walks into the SIGTERM.
  const plan = buildContainerLaunchPlan(
    inputs({
      runCap: { maxSeconds: 10800, startedEpochSeconds: 1_700_000_000 },
    }),
  );
  assertEquals(plan.runArgs.includes("VIBE_RUN_MAX_SECONDS=10800"), true);
  assertEquals(
    plan.runArgs.includes("VIBE_RUN_STARTED_EPOCH=1700000000"),
    true,
  );
  const bare = buildContainerLaunchPlan(inputs());
  assertEquals(
    bare.runArgs.some((arg) => arg.startsWith("VIBE_RUN_")),
    false,
  );
});
