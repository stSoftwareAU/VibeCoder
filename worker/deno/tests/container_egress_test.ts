/**
 * Tests for the per-launch egress sidecar (Issue #4047).
 *
 * The plan is checked against the real Docker and Podman dialects, and the
 * start and stop helpers run against a fake runtime that records every argv
 * and returns scripted results, so no container runtime is needed.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildEgressSidecarPlan,
  DEFAULT_EGRESS_NETWORK_NAME,
  DEFAULT_EGRESS_PROXY_NAME,
  EGRESS_PROXY_PORT,
  type RuntimeRunner,
  type RuntimeRunResult,
  startEgressSidecar,
  stopEgressSidecar,
} from "../lib/container_egress.ts";
import { CONTAINER_RUNTIMES } from "../lib/container_runtime.ts";
import { FORBIDDEN_RUN_FLAGS } from "../lib/container_launch.ts";
import { launcherPidFromContainerName } from "../lib/container_watchdog.ts";
import { EGRESS_PROXY_READY_MARKER } from "../lib/egress_proxy.ts";

const DOCKER = CONTAINER_RUNTIMES.docker.dialect;
const PODMAN = CONTAINER_RUNTIMES.podman.dialect;
const APPLE = CONTAINER_RUNTIMES["apple-container"].dialect;

/** A legal input; each refusal test changes exactly one field of it. */
const BASE = {
  dialect: DOCKER,
  image: "vibe-coder:latest",
  networkName: DEFAULT_EGRESS_NETWORK_NAME,
  proxyName: DEFAULT_EGRESS_PROXY_NAME,
  allowlist: ["api.example.com", "pypi.org"],
  checkout: {
    source: "/srv/vibe/worker/deno",
    target: "/opt/vibe/worker/deno",
  },
};

const PROXY_URL = `http://${DEFAULT_EGRESS_PROXY_NAME}:${EGRESS_PROXY_PORT}`;

const OK: RuntimeRunResult = { code: 0, stdout: "", stderr: "" };
const READY_LOG: RuntimeRunResult = {
  code: 0,
  stdout: `${EGRESS_PROXY_READY_MARKER} on 0.0.0.0:3128 hosts=2\n`,
  stderr: "",
};

/**
 * A fake runtime: records each argv, then answers with `respond`. A throw in
 * `respond` rejects the call, as a runner that cannot spawn would.
 */
function fakeRunner(
  respond: (args: readonly string[]) => RuntimeRunResult = () => OK,
) {
  const calls: string[][] = [];
  const run: RuntimeRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve().then(() => respond(args));
  };
  return { calls, run };
}

/** Compare two argv lists by value, for the `calls` log. */
function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------------------
// The plan against the real runtimes
// ---------------------------------------------------------------------------

for (
  const [label, dialect] of [["docker", DOCKER], ["podman", PODMAN]] as const
) {
  Deno.test(`buildEgressSidecarPlan (${label}) - the sidecar is locked down and read-only`, () => {
    const plan = buildEgressSidecarPlan({ ...BASE, dialect });
    const args = plan.proxyRunArgs;

    assert(args.includes("--cap-drop"));
    assertEquals(args[args.indexOf("--cap-drop") + 1], "ALL");
    assert(args.includes("--security-opt"));
    assertEquals(args[args.indexOf("--security-opt") + 1], "no-new-privileges");
    assert(args.includes("--read-only"));

    // No writable volume and no published port: the sidecar only dials out.
    assertEquals(args.includes("--volume"), false);
    assertEquals(args.includes("-v"), false);
    assertEquals(args.includes("--publish"), false);
    assertEquals(args.includes("-p"), false);
    assertEquals(args.includes("--rm"), false);

    for (const flag of FORBIDDEN_RUN_FLAGS) {
      assertEquals(
        args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)),
        false,
        `sidecar argv must not carry ${flag}`,
      );
    }

    // Exactly one mount: the read-only worker source tree, code only.
    assertEquals(args.filter((arg) => arg === "--mount").length, 1);
    const mount = args[args.indexOf("--mount") + 1] ?? "";
    assertEquals(
      mount,
      "type=bind,source=/srv/vibe/worker/deno,target=/opt/vibe/worker/deno,readonly",
    );
    assert(mount.endsWith(",readonly"));
  });

  Deno.test(`buildEgressSidecarPlan (${label}) - the worker env points at the sidecar, loopback never proxied`, () => {
    const plan = buildEgressSidecarPlan({ ...BASE, dialect });

    assertEquals(plan.workerEnv, [
      `HTTPS_PROXY=${PROXY_URL}`,
      `https_proxy=${PROXY_URL}`,
      `HTTP_PROXY=${PROXY_URL}`,
      `http_proxy=${PROXY_URL}`,
      "NO_PROXY=localhost,127.0.0.1,::1",
      "no_proxy=localhost,127.0.0.1,::1",
    ]);
    // The proxy itself is never on the bypass list, so the worker cannot skip it.
    for (
      const entry of plan.workerEnv.filter((e) =>
        e.includes("NO_PROXY") || e.includes("no_proxy")
      )
    ) {
      assertEquals(entry.includes(DEFAULT_EGRESS_PROXY_NAME), false);
      assertEquals(entry.includes("*"), false);
    }
    assertEquals(plan.internalNetwork, DEFAULT_EGRESS_NETWORK_NAME);
    assertEquals(plan.proxyReadyMarker, EGRESS_PROXY_READY_MARKER);
  });

  Deno.test(`buildEgressSidecarPlan (${label}) - the argv is the documented runtime invocation`, () => {
    const plan = buildEgressSidecarPlan({ ...BASE, dialect });
    assertEquals(plan.networkCreateArgs, [
      "network",
      "create",
      "--internal",
      DEFAULT_EGRESS_NETWORK_NAME,
    ]);
    assertEquals(plan.networkRemoveArgs, [
      "network",
      "rm",
      DEFAULT_EGRESS_NETWORK_NAME,
    ]);
    assertEquals(plan.proxyConnectArgs, [
      "network",
      "connect",
      DEFAULT_EGRESS_NETWORK_NAME,
      DEFAULT_EGRESS_PROXY_NAME,
    ]);
    assertEquals(plan.proxyLogsArgs, ["logs", DEFAULT_EGRESS_PROXY_NAME]);
    assertEquals(plan.proxyRemoveArgs, ["rm", "-f", DEFAULT_EGRESS_PROXY_NAME]);
    // The sidecar joins the outbound bridge; the internal network is attached
    // afterwards, so it is the only member with a route out.
    const network =
      plan.proxyRunArgs[plan.proxyRunArgs.indexOf("--network") + 1];
    assertEquals(network, "bridge");
    // The sidecar runs the checkout's own entry point, frozen and cache-only,
    // with the image's pre-seeded Deno cache.
    assertEquals(
      plan.proxyRunArgs.slice(plan.proxyRunArgs.indexOf("--entrypoint")),
      [
        "--entrypoint",
        "deno",
        BASE.image,
        "run",
        "--frozen",
        "--lock=/opt/vibe/worker/deno/deno.lock",
        "--cached-only",
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "/opt/vibe/worker/deno/mod.ts",
        "egress-proxy",
        "--listen",
        `0.0.0.0:${EGRESS_PROXY_PORT}`,
      ],
    );
    assertEquals(
      plan.proxyRunArgs.includes("DENO_DIR=/opt/deno-seed"),
      true,
    );
  });
}

// ---------------------------------------------------------------------------
// Refusals: each names its reason, and the same input made legal is accepted
// ---------------------------------------------------------------------------

Deno.test("buildEgressSidecarPlan - refuses the Apple dialect, which cannot enforce egress", () => {
  assertRejectsSync(
    () => buildEgressSidecarPlan({ ...BASE, dialect: APPLE }),
    "does not enforce egress",
  );
  buildEgressSidecarPlan({ ...BASE, dialect: DOCKER });
});

Deno.test("buildEgressSidecarPlan - refuses an empty allowlist", () => {
  assertRejectsSync(
    () => buildEgressSidecarPlan({ ...BASE, allowlist: [] }),
    "allowlist is empty",
  );
  buildEgressSidecarPlan({ ...BASE, allowlist: ["pypi.org"] });
});

Deno.test("buildEgressSidecarPlan - refuses a malformed network or proxy name", () => {
  assertRejectsSync(
    () => buildEgressSidecarPlan({ ...BASE, networkName: "bad name!" }),
    "network name 'bad name!' must match",
  );
  assertRejectsSync(
    () => buildEgressSidecarPlan({ ...BASE, proxyName: "-leading-dash" }),
    "proxy name '-leading-dash' must match",
  );
  buildEgressSidecarPlan({ ...BASE, networkName: "good-name" });
});

Deno.test("buildEgressSidecarPlan - refuses bridge and host as a name", () => {
  assertRejectsSync(
    () => buildEgressSidecarPlan({ ...BASE, networkName: "bridge" }),
    "network name 'bridge' is reserved",
  );
  assertRejectsSync(
    () => buildEgressSidecarPlan({ ...BASE, proxyName: "host" }),
    "proxy name 'host' is reserved",
  );
  buildEgressSidecarPlan({ ...BASE, networkName: "vibe-coder-egress" });
});

Deno.test("buildEgressSidecarPlan - refuses a comma in the mount source", () => {
  assertRejectsSync(
    () =>
      buildEgressSidecarPlan({
        ...BASE,
        checkout: { ...BASE.checkout, source: "/srv/a,readonly=false" },
      }),
    "contains a comma, double quote or control character",
  );
  buildEgressSidecarPlan({
    ...BASE,
    checkout: { ...BASE.checkout, source: "/srv/a" },
  });
});

Deno.test("buildEgressSidecarPlan - refuses an empty image", () => {
  assertRejectsSync(
    () => buildEgressSidecarPlan({ ...BASE, image: "   " }),
    "container image name is empty",
  );
  buildEgressSidecarPlan({ ...BASE, image: "vibe-coder:latest" });
});

// ---------------------------------------------------------------------------
// The allowlist travels in one env var only
// ---------------------------------------------------------------------------

Deno.test("buildEgressSidecarPlan - the allowlist is comma-joined in one --env and nowhere else", () => {
  const plan = buildEgressSidecarPlan({
    ...BASE,
    allowlist: ["api.example.com", "pypi.org"],
  });
  const envIndex = plan.proxyRunArgs.indexOf(
    "VIBE_EGRESS_ALLOW_HOSTS=api.example.com,pypi.org",
  );
  assert(envIndex > 0, "allowlist must be an env value");
  assertEquals(plan.proxyRunArgs[envIndex - 1], "--env");

  const mentions = plan.proxyRunArgs.filter((arg) =>
    arg.includes("api.example.com")
  );
  assertEquals(mentions, ["VIBE_EGRESS_ALLOW_HOSTS=api.example.com,pypi.org"]);
  for (
    const other of [
      plan.workerEnv,
      plan.networkCreateArgs,
      plan.networkRemoveArgs,
      plan.proxyConnectArgs,
      plan.proxyLogsArgs,
      plan.proxyRemoveArgs,
    ]
  ) {
    assertEquals(other.some((arg) => arg.includes("api.example.com")), false);
  }
});

// ---------------------------------------------------------------------------
// Start: order, failure paths and readiness
// ---------------------------------------------------------------------------

Deno.test("startEgressSidecar - happy path runs the steps in order and returns once ready", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const sleeps: number[] = [];
  const { calls, run } = fakeRunner((args) =>
    args[0] === "logs" ? READY_LOG : OK
  );

  await startEgressSidecar(plan, run, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  assertEquals(calls, [
    ["rm", "-f", DEFAULT_EGRESS_PROXY_NAME],
    ["network", "rm", DEFAULT_EGRESS_NETWORK_NAME],
    plan.networkCreateArgs,
    plan.proxyRunArgs,
    plan.proxyConnectArgs,
    plan.proxyLogsArgs,
  ]);
  assertEquals(sleeps, []);
});

Deno.test("startEgressSidecar - a failing leftover clean-up is ignored, even when it rejects", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const { calls, run } = fakeRunner((args) => {
    if (sameArgs(args, plan.proxyRemoveArgs)) {
      return { code: 1, stdout: "", stderr: "no such container" };
    }
    if (sameArgs(args, plan.networkRemoveArgs)) {
      throw new Error("runtime vanished");
    }
    return args[0] === "logs" ? READY_LOG : OK;
  });

  await startEgressSidecar(plan, run, { sleep: () => Promise.resolve() });

  assert(calls.some((args) => sameArgs(args, plan.proxyRunArgs)));
});

Deno.test("startEgressSidecar - a failed create throws with exit code and stderr, then tears down", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const { calls, run } = fakeRunner((args) => {
    if (sameArgs(args, plan.networkCreateArgs)) {
      return {
        code: 1,
        stdout: "",
        stderr: "Error: network already exists\nmore detail",
      };
    }
    return OK;
  });

  await assertRejects(
    () => startEgressSidecar(plan, run, { sleep: () => Promise.resolve() }),
    Error,
    "could not create the internal network (exit 1): Error: network already exists",
  );

  // The proxy was never started, and teardown still ran.
  assertEquals(calls.some((args) => sameArgs(args, plan.proxyRunArgs)), false);
  const after = calls.slice(
    calls.findIndex((args) => sameArgs(args, plan.networkCreateArgs)) + 1,
  );
  assert(after.some((args) => sameArgs(args, plan.proxyLogsArgs)));
  assert(after.some((args) => sameArgs(args, plan.proxyRemoveArgs)));
  assert(after.some((args) => sameArgs(args, plan.networkRemoveArgs)));
});

Deno.test("startEgressSidecar - a failed proxy run throws naming the step", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const { calls, run } = fakeRunner((args) => {
    if (sameArgs(args, plan.proxyRunArgs)) {
      return { code: 125, stdout: "", stderr: "docker: image not found" };
    }
    return OK;
  });

  await assertRejects(
    () => startEgressSidecar(plan, run, { sleep: () => Promise.resolve() }),
    Error,
    "could not start the egress proxy (exit 125): docker: image not found",
  );
  assertEquals(
    calls.some((args) => sameArgs(args, plan.proxyConnectArgs)),
    false,
  );
  assert(calls.some((args) => sameArgs(args, plan.networkRemoveArgs)));
});

Deno.test("startEgressSidecar - a failed connect throws naming the step and tears down", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const { calls, run } = fakeRunner((args) => {
    if (sameArgs(args, plan.proxyConnectArgs)) {
      return { code: 1, stdout: "", stderr: "network not found" };
    }
    return OK;
  });

  await assertRejects(
    () => startEgressSidecar(plan, run, { sleep: () => Promise.resolve() }),
    Error,
    "could not attach the egress proxy to the internal network (exit 1): network not found",
  );
  assert(calls.some((args) => sameArgs(args, plan.proxyRemoveArgs)));
  assert(calls.some((args) => sameArgs(args, plan.networkRemoveArgs)));
});

Deno.test("startEgressSidecar - readiness never seen throws after readyTries with the log text", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const sleeps: number[] = [];
  const { calls, run } = fakeRunner((args) =>
    args[0] === "logs" ? { code: 0, stdout: "booting deno\n", stderr: "" } : OK
  );

  await assertRejects(
    () =>
      startEgressSidecar(plan, run, {
        readyTries: 3,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
    Error,
    "never reported ready after 3 tries; last log: booting deno",
  );

  // Three polls, a pause between each pair, and no pause after the last.
  const polls = calls.filter((args) => sameArgs(args, plan.proxyLogsArgs));
  assertEquals(polls.length, 4); // three during start, one in teardown
  assertEquals(sleeps, [1000, 1000]);
  assert(calls.some((args) => sameArgs(args, plan.networkRemoveArgs)));
});

Deno.test("startEgressSidecar - a teardown failure is appended to the start error, never swallowed", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const { run } = fakeRunner((args) => {
    if (sameArgs(args, plan.networkCreateArgs)) {
      return { code: 1, stdout: "", stderr: "boom" };
    }
    if (sameArgs(args, plan.networkRemoveArgs)) {
      return { code: 1, stdout: "", stderr: "network busy" };
    }
    return OK;
  });

  await assertRejects(
    () => startEgressSidecar(plan, run, { sleep: () => Promise.resolve() }),
    Error,
    "could not create the internal network (exit 1): boom; teardown also failed: " +
      "egress sidecar teardown failed: remove the internal network (exit 1): network busy",
  );
});

// ---------------------------------------------------------------------------
// Stop: order, log capture and fail-loud teardown
// ---------------------------------------------------------------------------

Deno.test("stopEgressSidecar - reads logs, appends them, then removes the proxy and the network", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const events: string[] = [];
  const { run } = fakeRunner((args) => {
    if (sameArgs(args, plan.proxyLogsArgs)) {
      events.push("logs");
      return { code: 0, stdout: "proxy said hi\n", stderr: "" };
    }
    if (sameArgs(args, plan.proxyRemoveArgs)) events.push("rm-proxy");
    if (sameArgs(args, plan.networkRemoveArgs)) events.push("rm-network");
    return OK;
  });

  await stopEgressSidecar(plan, run, {
    appendLog: (text) => {
      events.push(`append:${text}`);
      return Promise.resolve();
    },
  });

  assertEquals(events, [
    "logs",
    "append:proxy said hi",
    "rm-proxy",
    "rm-network",
  ]);
});

Deno.test("stopEgressSidecar - empty logs are not appended", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const appended: string[] = [];
  const { run } = fakeRunner(() => OK);

  await stopEgressSidecar(plan, run, {
    appendLog: (text) => {
      appended.push(text);
      return Promise.resolve();
    },
  });

  assertEquals(appended, []);
});

Deno.test("stopEgressSidecar - a failing proxy removal still attempts the network removal, then throws", async () => {
  const plan = buildEgressSidecarPlan(BASE);
  const { calls, run } = fakeRunner((args) => {
    if (sameArgs(args, plan.proxyRemoveArgs)) {
      return { code: 1, stdout: "", stderr: "no such container" };
    }
    return OK;
  });

  await assertRejects(
    () => stopEgressSidecar(plan, run),
    Error,
    "egress sidecar teardown failed: remove the egress proxy (exit 1): no such container",
  );
  assert(calls.some((args) => sameArgs(args, plan.networkRemoveArgs)));
});

// ---------------------------------------------------------------------------
// The sidecar is never mistaken for a worker
// ---------------------------------------------------------------------------

Deno.test("launcherPidFromContainerName - the egress sidecar is not a launcher worker", () => {
  assertEquals(launcherPidFromContainerName(DEFAULT_EGRESS_PROXY_NAME), null);
  // Control: a real worker name does carry a launcher PID.
  assertEquals(launcherPidFromContainerName("vibe-coder-4242"), 4242);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert a synchronous call throws an error whose message includes `fragment`. */
function assertRejectsSync(fn: () => unknown, fragment: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `expected an Error containing "${fragment}"`);
  assertStringIncludes(caught.message, "Refusing to launch:");
  assertStringIncludes(caught.message, fragment);
}
