/**
 * Tests for the BuildKit builder self-heal (Issue #4441).
 *
 * The classifier decides whether a failed `container build` is the builder's
 * storage having gone bad — ENOSPC, a filesystem the builder VM remounted
 * read-only, BuildKit's `ResourceExhausted` — or an ordinary build failure
 * that must fail as it always did. The heal itself drives the runtime through
 * an injected seam, so these tests never start a builder VM.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  classifyBuildFailure,
  healActionForAttempt,
  healBuilderStorage,
  MAX_BUILD_LOG_TAIL_BYTES,
  readBuildLogTail,
  type RuntimeInvocation,
} from "../lib/container_build_heal.ts";
import { dialectForExecutable } from "../lib/container_watchdog.ts";

/** The failure host-23 actually produced, mid-export (Issue #4441). */
const ENOSPC_EXPORT = `#12 exporting to oci image format
Error: resourceExhausted: "failed to solve: failed to compute cache key: ` +
  `write /var/lib/container-builder-shim/exports/abc/out.tar: no space left ` +
  `on device"`;

/** What every launch printed afterwards, until the builder was restarted. */
const READ_ONLY_BUILDER = `[run.sh] building vibe-coder:1224218f38a0
Error: unknown: "open /tmp/1326465203: read-only file system"`;

/** A recording stand-in for the container runtime. */
function stubDeps(
  responses: (args: readonly string[]) => RuntimeInvocation = () => ({
    code: 0,
    stdout: "",
    stderr: "",
  }),
) {
  const calls: string[][] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    deps: {
      runRuntime: (args: readonly string[]) => {
        calls.push([...args]);
        return Promise.resolve(responses(args));
      },
      log: (message: string) => logs.push(message),
    },
  };
}

const APPLE = dialectForExecutable("container");
const DOCKER = dialectForExecutable("docker");

function healOptions(overrides: {
  buildLog: string;
  attempt?: number;
  restartArgs?: readonly (readonly string[])[];
  recreateArgs?: readonly (readonly string[])[];
}) {
  return {
    attempt: 1,
    restartArgs: APPLE.builderRestartArgs,
    recreateArgs: APPLE.builderRecreateArgs,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

Deno.test("classifyBuildFailure - names the ENOSPC export failure as builder storage", () => {
  const result = classifyBuildFailure(ENOSPC_EXPORT);
  assertEquals(result.class, "builder-storage");
  assertEquals(result.signature, "no space left on device");
});

Deno.test("classifyBuildFailure - names a read-only builder filesystem as builder storage", () => {
  const result = classifyBuildFailure(READ_ONLY_BUILDER);
  assertEquals(result.class, "builder-storage");
  assertEquals(result.signature, "read-only file system");
});

Deno.test("classifyBuildFailure - matches BuildKit's ResourceExhausted whatever its casing", () => {
  assertEquals(
    classifyBuildFailure('Error: ResourceExhausted: "failed to solve"').class,
    "builder-storage",
  );
  assertEquals(
    classifyBuildFailure("rpc error: code = resourceexhausted").class,
    "builder-storage",
  );
});

Deno.test("classifyBuildFailure - matches a signature wrapped across lines", () => {
  // Runtime CLIs wrap long diagnostics; the signature must survive it.
  const wrapped = "write /var/lib/x/out.tar: no space left\n   on device";
  assertEquals(classifyBuildFailure(wrapped).class, "builder-storage");
});

Deno.test("classifyBuildFailure - leaves an ordinary build failure alone", () => {
  const ordinary = `#8 [4/9] RUN apt-get install -y nosuchpackage
E: Unable to locate package nosuchpackage
Error: process "/bin/sh -c apt-get install -y nosuchpackage" did not ` +
    `complete successfully: exit code: 100`;
  const result = classifyBuildFailure(ordinary);
  assertEquals(result.class, "other");
  assertEquals(result.signature, undefined);
});

Deno.test("classifyBuildFailure - empty output is not a builder-storage failure", () => {
  assertEquals(classifyBuildFailure("").class, "other");
  assertEquals(classifyBuildFailure("   \n  ").class, "other");
});

Deno.test("classifyBuildFailure - a Containerfile that merely mentions the phrase is not a storage failure", () => {
  // The phrase has to be the failure, not a word in the build's own echo of a
  // source line, so the match is on the diagnostic wording BuildKit emits.
  const result = classifyBuildFailure(
    "#3 [2/9] RUN echo 'this image is read-only by design'",
  );
  assertEquals(result.class, "other");
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

Deno.test("healActionForAttempt - restarts first, recreates on the second failure", () => {
  assertEquals(healActionForAttempt(1), "restart");
  assertEquals(healActionForAttempt(2), "recreate");
  assertEquals(healActionForAttempt(7), "recreate");
  // A caller that passes nonsense still gets the cheap action, never the
  // destructive one.
  assertEquals(healActionForAttempt(0), "restart");
  assertEquals(healActionForAttempt(Number.NaN), "restart");
});

// ---------------------------------------------------------------------------
// The per-runtime argument lists
// ---------------------------------------------------------------------------

Deno.test("dialect - Apple container restarts, then recreates, its builder VM (Issue #4441)", () => {
  assertEquals(APPLE.builderRestartArgs, [
    ["builder", "stop"],
    ["builder", "start"],
  ]);
  assertEquals(APPLE.builderRecreateArgs, [
    ["builder", "delete"],
    ["builder", "start"],
  ]);
});

Deno.test("dialect - Docker and Podman prune the build cache instead (Issue #4441)", () => {
  assertEquals(DOCKER.builderRestartArgs, [["builder", "prune", "-f"]]);
  assertEquals(DOCKER.builderRecreateArgs, [["builder", "prune", "-f"]]);
  assertEquals(dialectForExecutable("podman").builderRestartArgs, [[
    "builder",
    "prune",
    "-f",
  ]]);
});

// ---------------------------------------------------------------------------
// The heal
// ---------------------------------------------------------------------------

Deno.test("healBuilderStorage - restarts the builder for a storage failure", async () => {
  const { deps, calls } = stubDeps();
  const outcome = await healBuilderStorage(
    deps,
    healOptions({ buildLog: ENOSPC_EXPORT }),
  );

  assertEquals(outcome.healable, true);
  assertEquals(outcome.action, "restart");
  assertEquals(outcome.ok, true);
  assertEquals(calls, [["builder", "stop"], ["builder", "start"]]);
});

Deno.test("healBuilderStorage - escalates to a recreate on the second attempt", async () => {
  const { deps, calls } = stubDeps();
  const outcome = await healBuilderStorage(
    deps,
    healOptions({ buildLog: READ_ONLY_BUILDER, attempt: 2 }),
  );

  assertEquals(outcome.action, "recreate");
  assertEquals(outcome.ok, true);
  assertEquals(calls, [["builder", "delete"], ["builder", "start"]]);
});

Deno.test("healBuilderStorage - does nothing for a failure it cannot heal", async () => {
  const { deps, calls } = stubDeps();
  const outcome = await healBuilderStorage(
    deps,
    healOptions({ buildLog: "E: Unable to locate package nosuchpackage" }),
  );

  assertEquals(outcome.healable, false);
  assertEquals(outcome.action, undefined);
  assertEquals(outcome.ok, false);
  assertEquals(calls, []);
});

Deno.test("healBuilderStorage - an already-stopped builder is not a failed heal", async () => {
  // `builder stop` exits non-zero when there is nothing running; only the
  // final step (the start) has to succeed for the retry to be worth making.
  const { deps, calls } = stubDeps((args) =>
    args[1] === "stop"
      ? { code: 1, stdout: "", stderr: "Error: builder is not running" }
      : { code: 0, stdout: "", stderr: "" }
  );
  const outcome = await healBuilderStorage(
    deps,
    healOptions({ buildLog: ENOSPC_EXPORT }),
  );

  assertEquals(outcome.ok, true);
  assertEquals(calls.length, 2);
  assertEquals(outcome.steps[0]?.code, 1);
});

Deno.test("healBuilderStorage - a builder that will not start is a failed heal", async () => {
  const { deps, logs } = stubDeps((args) =>
    args[1] === "start"
      ? { code: 1, stdout: "", stderr: "Error: cannot start builder" }
      : { code: 0, stdout: "", stderr: "" }
  );
  const outcome = await healBuilderStorage(
    deps,
    healOptions({ buildLog: ENOSPC_EXPORT }),
  );

  assertEquals(outcome.ok, false);
  assert(outcome.detail?.includes("builder start"), outcome.detail);
  assert(logs.some((line) => line.includes("cannot start builder")));
});

Deno.test("healBuilderStorage - a runtime with no heal arguments fails loud", async () => {
  const { deps, calls } = stubDeps();
  const outcome = await healBuilderStorage(
    deps,
    healOptions({
      buildLog: ENOSPC_EXPORT,
      restartArgs: [],
      recreateArgs: [],
    }),
  );

  assertEquals(outcome.healable, true);
  assertEquals(outcome.ok, false);
  assertEquals(calls, []);
  assert(outcome.detail?.includes("no builder"), outcome.detail);
});

// ---------------------------------------------------------------------------
// Reading the build log
// ---------------------------------------------------------------------------

Deno.test("readBuildLogTail - reads a short log whole", async () => {
  const path = await Deno.makeTempFile({ prefix: "vibe_build_log_" });
  try {
    await Deno.writeTextFile(path, ENOSPC_EXPORT);
    assertEquals(await readBuildLogTail(path), ENOSPC_EXPORT);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("readBuildLogTail - keeps the tail of an enormous log", async () => {
  const path = await Deno.makeTempFile({ prefix: "vibe_build_log_" });
  try {
    // A real build log runs to megabytes; the failure is always at the end.
    await Deno.writeTextFile(
      path,
      "#1 progress\n".repeat(60_000) + ENOSPC_EXPORT,
    );
    const tail = await readBuildLogTail(path);
    assert(tail.length <= MAX_BUILD_LOG_TAIL_BYTES);
    assertEquals(classifyBuildFailure(tail).class, "builder-storage");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("readBuildLogTail - an unreadable log fails loud rather than reading as empty", async () => {
  await assertRejects(
    () => readBuildLogTail("/no/such/build/log"),
    Error,
    "/no/such/build/log",
  );
});
