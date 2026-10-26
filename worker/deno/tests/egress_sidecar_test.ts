/**
 * The shared sidecar helper (Issue #4047).
 *
 * The runner is injected, so the test does not start a container.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type EgressSidecarPlan,
  startEgressSidecar,
  stopEgressSidecar,
} from "../lib/egress_sidecar.ts";
import { EGRESS_PROXY_LISTENING_MARKER } from "../lib/egress_proxy.ts";

function plan(): EgressSidecarPlan {
  return {
    runtime: "docker",
    egressEnforced: true,
    networkCreateArgs: ["network", "create", "--internal", "vibe-net"],
    networkRemoveArgs: ["network", "rm", "vibe-net"],
    networkConnectArgs: ["network", "connect", "vibe-net", "vibe-proxy"],
    proxyRunArgs: ["run", "-i", "--name", "vibe-proxy"],
    proxyStopArgs: ["rm", "--force", "vibe-proxy"],
    proxyName: "vibe-proxy",
    proxyBundle: "/repo",
  };
}

Deno.test("startEgressSidecar - removes a stale network, then the proxy, then connects", async () => {
  const calls: string[] = [];
  let packed = false;
  await startEgressSidecar(plan(), {
    pack: () => {
      packed = true;
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
    sleep: () => Promise.resolve(),
    now: () => 0,
    readyTimeoutMs: 1,
    run: (args, stdin) => {
      calls.push(args.join(" "));
      if (args[0] === "logs") {
        return Promise.resolve({
          code: 0,
          stdout: `${EGRESS_PROXY_LISTENING_MARKER} on 0.0.0.0:3128 hosts=1\n`,
          stderr: "",
        });
      }
      if (args[0] === "run") {
        assert(stdin !== undefined && stdin.length === 3);
      }
      const fail = args[0] === "network" && args[1] === "rm";
      return Promise.resolve({ code: fail ? 1 : 0, stdout: "", stderr: "" });
    },
  });
  assertEquals(packed, true);
  assertEquals(calls[0], "network rm vibe-net");
  assertEquals(calls[1], "network create --internal vibe-net");
  assert(calls[2]?.startsWith("rm --force"), calls.join(" | "));
  assert(calls.some((call) => call.startsWith("run ")), calls.join(" | "));
  const runAt = calls.findIndex((call) => call.startsWith("run "));
  const connectAt = calls.findIndex((call) =>
    call.startsWith("network connect")
  );
  assert(runAt >= 0 && connectAt > runAt, calls.join(" | "));
});

Deno.test("startEgressSidecar - a failed network create does not start the proxy", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      startEgressSidecar(plan(), {
        pack: () => Promise.resolve(new Uint8Array()),
        run: (args) => {
          calls.push(args.join(" "));
          const code = args[1] === "create" ? 1 : 0;
          return Promise.resolve({ code, stdout: "", stderr: "no network" });
        },
      }),
    Error,
    "refusing to launch",
  );
  assertEquals(calls.some((call) => call.startsWith("run ")), false);
});

Deno.test("startEgressSidecar - a plan that does not enforce is a no-op", async () => {
  let called = false;
  await startEgressSidecar(
    { ...plan(), egressEnforced: false },
    {
      run: () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    },
  );
  assertEquals(called, false);
});

Deno.test("stopEgressSidecar - captures the log and removes the proxy and the network", async () => {
  const calls: string[] = [];
  const dir = await Deno.makeTempDir({ prefix: "egress-stop-" });
  const logFile = `${dir}/egress-proxy.log`;
  try {
    const problems = await stopEgressSidecar(plan(), {
      logFile,
      run: (args) => {
        calls.push(args.join(" "));
        return Promise.resolve({
          code: 0,
          stdout: `${EGRESS_PROXY_LISTENING_MARKER}\n`,
          stderr: "",
        });
      },
    });
    assertEquals(problems, []);
    assertEquals(calls[0], "logs vibe-proxy");
    assertEquals(calls[1], "rm --force vibe-proxy");
    assertEquals(calls[2], "network rm vibe-net");
    const text = await Deno.readTextFile(logFile);
    assert(text.includes(EGRESS_PROXY_LISTENING_MARKER));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
