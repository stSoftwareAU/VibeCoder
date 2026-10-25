/**
 * Tests for the tabletop harness's container runner (Issue #4194).
 *
 * The runner starts a real container, which no unit test may do, so what is
 * tested here is everything the run hinges on either side of that call: the
 * argument list is the launcher's own plan with only the process replaced, an
 * attempt that says nothing is an error rather than a pass, and the outbox is
 * parsed into the sinks the canary scan then reads.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  attemptRunArgs,
  createTabletopContainerRunner,
  DEFAULT_EGRESS_PROBE_URL,
  parseAttemptOutcome,
  parseOutboxArtefacts,
  TabletopContainerUnavailableError,
  type TabletopRuntime,
} from "../lib/tabletop_container_runner.ts";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
} from "../lib/container_runtime.ts";
import { EGRESS_PROXY_READY_MARKER } from "../lib/egress_proxy.ts";
import type { TabletopFixture } from "../lib/tabletop_fixtures.ts";
import {
  parseWeakenedControls,
  tabletopReportPath,
} from "../commands/security_tabletop.ts";

/** A launch plan shaped exactly as `buildContainerLaunchPlan` returns one. */
function plan(): ContainerLaunchPlan {
  return {
    runtime: "docker",
    image: "vibe-coder:abc123",
    // The prune keeps the launch's whole image chain (Issue #1059); a
    // single-image tabletop launch names just the image it runs.
    keepImages: ["vibe-coder:abc123"],
    containerName: "vibe-tabletop-1234",
    watchdogSeconds: 11_400,
    mounts: [],
    ensureDirectories: [],
    volumes: ["vibe-tabletop-work-1234"],
    // The throwaway work volume is disposable, so a disk reset may take it
    // (Issue #2216); the tabletop mounts no approval store.
    resettableVolumes: ["vibe-tabletop-work-1234"],
    initArgs: ["run", "--rm", "vibe-coder:abc123"],
    imageInspectArgs: ["image", "inspect", "vibe-coder:abc123"],
    buildArgs: ["build"],
    // No private extension: the tabletop runs the standard image (#980).
    extensionBuildArgs: [],
    // The runtime's own removal verbs ride in the plan (Issues #731, #1956).
    volumeRemoveArgs: ["volume", "rm"],
    imageRemoveArgs: ["image", "rm"],
    // The claiming floor rides the plan too (Issue #732).
    claimFloorGb: 20,
    claimFloorPercent: 10,
    claimFloorOrigin: "gb=default,percent=default",
    builderStopArgs: [],
    builderAbsentPatterns: [],
    runArgs: [
      "run",
      "--rm",
      "--name",
      "vibe-tabletop-1234",
      "--memory",
      "8g",
      "--cap-drop",
      "ALL",
      "--volume",
      "/tmp/checkout:/workspace",
      "vibe-coder:abc123",
    ],
  };
}

Deno.test("attemptRunArgs keeps every containment flag the plan produced", () => {
  const args = attemptRunArgs(plan(), "vibe-tabletop-1234-0", [], ["/x.sh"]);
  for (const flag of ["--rm", "--memory", "--cap-drop", "--volume"]) {
    assert(args.includes(flag), `${flag} was dropped from the run`);
  }
  assert(
    args.includes("/tmp/checkout:/workspace"),
    "the mount set must survive verbatim",
  );
});

Deno.test("attemptRunArgs replaces only the process and the container name", () => {
  const args = attemptRunArgs(
    plan(),
    "vibe-tabletop-1234-2",
    ["VIBE_TABLETOP_CANARY=/creds/x"],
    ["/workspace/tabletop/a.sh"],
  );
  assertEquals(args[args.indexOf("--name") + 1], "vibe-tabletop-1234-2");
  assertEquals(args.at(-1), "/workspace/tabletop/a.sh");
  assertEquals(args.at(-2), "vibe-coder:abc123");
  assertEquals(args.at(-3), "bash");
  assertEquals(args.at(-4), "--entrypoint");
  assertEquals(
    args[args.indexOf("--env") + 1],
    "VIBE_TABLETOP_CANARY=/creds/x",
  );
});

Deno.test("attemptRunArgs refuses a plan whose shape it does not recognise", () => {
  const noImage = plan();
  noImage.runArgs = ["run", "--name", "x", "some-other-image"];
  assertThrows(() => attemptRunArgs(noImage, "n", [], ["/x"]), Error, "image");

  const unnamed = plan();
  unnamed.runArgs = ["run", "--rm", "vibe-coder:abc123"];
  assertThrows(
    () => attemptRunArgs(unnamed, "n", [], ["/x"]),
    Error,
    "does not name the container",
  );
});

Deno.test("parseAttemptOutcome reads the status and detail the attempt reported", () => {
  assertEquals(
    parseAttemptOutcome("noise\noutcome\trefused\t/etc is not writable\n"),
    { status: "refused", detail: "/etc is not writable" },
  );
  assertEquals(
    parseAttemptOutcome("outcome\tachieved\treached https://example.com"),
    { status: "achieved", detail: "reached https://example.com" },
  );
});

Deno.test("an attempt that reports nothing usable is an error, never a pass", () => {
  assertEquals(parseAttemptOutcome("").status, "error");
  assertEquals(parseAttemptOutcome("all fine here").status, "error");
  assertEquals(parseAttemptOutcome("outcome\tcontained\tx").status, "error");
});

Deno.test("parseOutboxArtefacts groups the queued bodies by sink", () => {
  const artefacts = parseOutboxArtefacts(
    "pr-comment\tfirst body\nrun-log\ttelemetry line\npr-comment\tsecond body\n",
  );
  assertEquals(artefacts.length, 2);
  assertEquals(artefacts[0], {
    sink: "pr-comment",
    body: "first body\nsecond body",
  });
  assertEquals(artefacts[1], { sink: "run-log", body: "telemetry line" });
});

Deno.test("an untagged outbox line still becomes an artefact", () => {
  assertEquals(parseOutboxArtefacts("bare leak\n"), [{
    sink: "outbox",
    body: "bare leak",
  }]);
  assertEquals(parseOutboxArtefacts(""), []);
});

Deno.test("the unavailable-container error names the refusal, not a fallback", () => {
  const error = new TabletopContainerUnavailableError("no runtime on PATH");
  assert(error.message.includes("no runtime on PATH"));
  assert(
    error.message.includes("refuses"),
    "the message must say the run was refused rather than downgraded",
  );
});

Deno.test("the egress fixture probes a documentation host by default", () => {
  assertEquals(DEFAULT_EGRESS_PROBE_URL, "https://example.com");
});

// ---------------------------------------------------------------------------
// Command arguments
// ---------------------------------------------------------------------------

Deno.test("--weaken accepts the controls the harness can switch off", () => {
  assertEquals(parseWeakenedControls(undefined), []);
  assertEquals(parseWeakenedControls("sink-redaction"), ["sink-redaction"]);
  assertEquals(
    parseWeakenedControls("sink-redaction, canary-encoding-scan"),
    ["sink-redaction", "canary-encoding-scan"],
  );
});

Deno.test("--weaken refuses a control it does not know", () => {
  assertThrows(
    () => parseWeakenedControls("containment"),
    Error,
    "Unknown control",
  );
  assertThrows(() => parseWeakenedControls(""), Error, "--weaken");
});

Deno.test("a negative-control run writes to its own evidence file", () => {
  const day = new Date("2026-08-18T04:05:06Z");
  assertEquals(
    tabletopReportPath(day, false),
    "docs/evidence/tabletop-2026-08-18.md",
  );
  assertEquals(
    tabletopReportPath(day, true),
    "docs/evidence/tabletop-negative-control-2026-08-18.md",
  );
});

// ---------------------------------------------------------------------------
// The egress sidecar around the run (Issue #4047)
// ---------------------------------------------------------------------------

/** The repository root, from this test file's own location. */
const REPO_ROOT = new URL(import.meta.url).pathname.replace(
  /\/worker\/deno\/tests\/[^/]+$/,
  "",
);

const CANARY = "ghp_tabletop_runner_unit_canary";

/** The Docker descriptor the runner drives in these tests. */
const DOCKER: ContainerRuntimeDescriptor = {
  platform: "linux",
  kind: "docker",
  executable: CONTAINER_RUNTIMES.docker.executable,
  displayName: CONTAINER_RUNTIMES.docker.displayName,
  dialect: CONTAINER_RUNTIMES.docker.dialect,
  probed: ["docker"],
};

/** The Apple descriptor: no internal network, so no egress sidecar. */
const APPLE: ContainerRuntimeDescriptor = {
  platform: "darwin",
  kind: "apple-container",
  executable: CONTAINER_RUNTIMES["apple-container"].executable,
  displayName: CONTAINER_RUNTIMES["apple-container"].displayName,
  dialect: CONTAINER_RUNTIMES["apple-container"].dialect,
  probed: ["apple-container"],
};

/** A minimal attempt that reports itself refused. */
function fixture(id: string): TabletopFixture {
  return {
    id,
    surface: "issue-body",
    objective: "read-credential",
    expectation: "refused",
    payload: "payload",
    controls: [],
    attempt: "#!/bin/bash\nprintf 'outcome\\trefused\\tblocked\\n'\n",
  };
}

/** A runtime that answers every command, recording each argument list. */
function fakeRuntime(
  descriptor: ContainerRuntimeDescriptor,
  behaviour: { failAttempt?: boolean } = {},
): { runtime: TabletopRuntime; calls: string[][] } {
  const calls: string[][] = [];
  const runtime: TabletopRuntime = {
    detect: () => Promise.resolve(descriptor),
    run: (_executable, args) => {
      calls.push([...args]);
      if (isAttempt(args)) {
        if (behaviour.failAttempt) {
          return Promise.reject(new Error("attempt wedged"));
        }
        return Promise.resolve({
          code: 0,
          stdout: "outcome\trefused\tblocked\n",
          stderr: "",
        });
      }
      if (args[0] === "logs") {
        return Promise.resolve({
          code: 0,
          stdout: `${EGRESS_PROXY_READY_MARKER}\n`,
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  return { runtime, calls };
}

/** An attempt container: a `run` whose last argument is the attempt script. */
function isAttempt(args: readonly string[]): boolean {
  return args[0] === "run" && (args.at(-1) ?? "").endsWith(".sh");
}

/** The sidecar's detached run. */
function isProxyRun(args: readonly string[]): boolean {
  return args[0] === "run" && args.includes("--detach");
}

/** A runner whose configuration cannot be read from the developer's host. */
function runnerWith(runtime: TabletopRuntime) {
  return createTabletopContainerRunner({
    repoRoot: REPO_ROOT,
    image: "vibe-coder:tabletop-unit",
    runtime,
    // No configuration file: the provider set falls back to the defaults.
    env: (name) =>
      name === "CONFIG_FILE"
        ? "/nonexistent-vibe-tabletop-unit/.config.json"
        : undefined,
  });
}

Deno.test("the egress sidecar comes up before the first attempt, and every attempt shares it", async () => {
  const fake = fakeRuntime(DOCKER);
  const outcome = await runnerWith(fake.runtime).run(
    [fixture("a"), fixture("b")],
    { canary: CANARY },
  );
  const calls = fake.calls;

  const create = calls.findIndex((c) =>
    c[0] === "network" && c[1] === "create"
  );
  const proxyRun = calls.findIndex(isProxyRun);
  const connect = calls.findIndex((c) =>
    c[0] === "network" && c[1] === "connect"
  );
  const attempts = calls.flatMap((c, i) => (isAttempt(c) ? [i] : []));
  assert(create >= 0, "the internal network was never created");
  assert(proxyRun > create, "the proxy started before its network existed");
  assert(connect > proxyRun, "the proxy was not attached before the attempts");
  assertEquals(attempts.length, 2, "both attempts should have run");
  assert(
    attempts[0]! > connect,
    "an attempt started before the sidecar was up",
  );

  // One sidecar and one network for the whole run, not one per container.
  assertEquals(
    calls.filter((c) => c[0] === "network" && c[1] === "create").length,
    1,
  );
  assertEquals(calls.filter(isProxyRun).length, 1);

  // Every attempt is on the sidecar's internal network, and the sidecar's
  // allowlist is the resolved one, not an empty list.
  const network = calls[create]!.at(-1)!;
  for (const index of attempts) {
    const args = calls[index]!;
    assertEquals(args[args.indexOf("--network") + 1], network);
  }
  const allowed = calls[proxyRun]!.find((arg) =>
    arg.startsWith("VIBE_EGRESS_ALLOW_HOSTS=")
  );
  assert(
    allowed?.includes("github.com"),
    `the sidecar was not given the resolved allowlist: ${allowed}`,
  );

  // The attempts are still reported one per fixture.
  assertEquals(outcome.attempts.map((attempt) => attempt.status), [
    "refused",
    "refused",
  ]);
});

Deno.test("the egress sidecar is stopped after the last attempt, and before the fixture is deleted", async () => {
  const fake = fakeRuntime(DOCKER);
  await runnerWith(fake.runtime).run([fixture("a"), fixture("b")], {
    canary: CANARY,
  });
  const calls = fake.calls;

  const attempts = calls.flatMap((c, i) => (isAttempt(c) ? [i] : []));
  const proxyName = calls[calls.findIndex(isProxyRun)]!.at(
    calls[calls.findIndex(isProxyRun)]!.indexOf("--name") + 1,
  );
  // The last match is the teardown: the start also removes any leftover of an
  // earlier launch, before anything is created.
  const proxyRm = calls.findLastIndex((c) =>
    c[0] === "rm" && c.at(-1) === proxyName
  );
  const networkRm = calls.findLastIndex((c) =>
    c[0] === "network" && c[1] === "rm"
  );
  const volumeRm = calls.findLastIndex((c) =>
    c[0] === "volume" && c[1] === "rm"
  );
  assert(proxyRm > attempts.at(-1)!, "the sidecar outlived the last attempt");
  assert(networkRm > proxyRm, "the network was removed before the proxy");
  assert(volumeRm > networkRm, "the fixture volumes went before the sidecar");
});

Deno.test("the egress sidecar is stopped in the finally even when an attempt fails", async () => {
  const fake = fakeRuntime(DOCKER, { failAttempt: true });
  await assertRejects(
    () => runnerWith(fake.runtime).run([fixture("a")], { canary: CANARY }),
    Error,
    "attempt wedged",
  );
  const calls = fake.calls;

  const attempt = calls.findIndex(isAttempt);
  assert(attempt >= 0, "the failing attempt was never started");
  const proxyName = calls[calls.findIndex(isProxyRun)]!.at(
    calls[calls.findIndex(isProxyRun)]!.indexOf("--name") + 1,
  );
  // The last match is the teardown, after the leftover clean-up at start.
  const proxyRm = calls.findLastIndex((c) =>
    c[0] === "rm" && c.at(-1) === proxyName
  );
  const networkRm = calls.findLastIndex((c) =>
    c[0] === "network" && c[1] === "rm"
  );
  const volumeRm = calls.findLastIndex((c) =>
    c[0] === "volume" && c[1] === "rm"
  );
  assert(proxyRm > attempt, "a failed attempt left the sidecar running");
  assert(networkRm > proxyRm, "a failed attempt left the network behind");
  assert(volumeRm > networkRm, "a failed attempt skipped the volume clean-up");
});

Deno.test("an Apple run starts no egress sidecar and runs no network command", async () => {
  const fake = fakeRuntime(APPLE);
  const outcome = await runnerWith(fake.runtime).run([fixture("a")], {
    canary: CANARY,
  });
  assertEquals(outcome.attempts.length, 1, "the attempt should have run");
  const networkCommands = fake.calls.filter((c) =>
    c[0] === "network" || c[0] === "logs" || isProxyRun(c)
  );
  assertEquals(
    networkCommands,
    [],
    "Apple container has no internal network, so no sidecar command may run",
  );
});
