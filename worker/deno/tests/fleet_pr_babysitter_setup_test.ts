import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  launchAgentPlist,
  main,
  missingAppPermissions,
  runContainerPreflight,
} from "../commands/fleet_pr_babysitter_setup.ts";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";

/**
 * A plan carrying the two fields the preflight reads: the runtime and the
 * image inspect arguments (Issue #4770).
 */
function preflightPlan(runtime: string): ContainerLaunchPlan {
  return {
    runtime,
    imageInspectArgs: ["image", "inspect", "vibe-coder:test"],
  } as unknown as ContainerLaunchPlan;
}

Deno.test("setup validates each App permission including write levels", () => {
  const permissions = {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    statuses: "read",
    workflows: "write",
  };
  assertEquals(missingAppPermissions(permissions), []);
  assertEquals(
    missingAppPermissions({ ...permissions, issues: "read", actions: "write" }),
    ["issues: write"],
  );
  assert(missingAppPermissions(undefined).includes("contents: write"));
});

Deno.test("folder scripts forward options to the right Deno command", async () => {
  const dir = await Deno.makeTempDir({ prefix: "babysitter-setup-test-" });
  try {
    const fake = `${dir}/fake-deno`;
    await Deno.writeTextFile(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
    const checkout = decodeURIComponent(
      new URL("../../..", import.meta.url).pathname,
    ).replace(/\/$/, "");
    for (
      const [script, target, option] of [
        ["setup.sh", "fleet_pr_babysitter_setup.ts", "--check"],
        ["run.sh", "fleet_pr_babysitter_supervisor.ts", "--dry-run"],
      ] as const
    ) {
      const result = await runWithTimeout("bash", [
        `${checkout}/fleet-pr-babysitter/${script}`,
        option,
      ], { cwd: dir, timeoutMs: 5_000, env: { DENO_EXECUTABLE: fake } });
      assert(result.ok);
      assert(result.value.success);
      assert(result.value.stdout.includes(target));
      assert(result.value.stdout.includes(option));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("launch agent schedules bounded passes and escapes filesystem paths", () => {
  const plist = launchAgentPlist({
    checkout: "/tmp/A & B",
    deno: "/usr/bin/deno",
    home: "/Users/Owner",
    ghConfigDir: "/tmp/gh <fleet>",
  });
  assert(
    plist.includes(
      "/tmp/A &amp; B/fleet-pr-babysitter/run.sh",
    ),
  );
  assert(plist.includes("<key>StartInterval</key><integer>300</integer>"));
  assert(!plist.includes("service.log"));
  assert(
    plist.includes("<key>DENO_EXECUTABLE</key><string>/usr/bin/deno</string>"),
  );
  assert(plist.includes("/tmp/gh &lt;fleet&gt;"));
  assert(!plist.includes("GH_TOKEN"));
});

// Issue #4770: setup checks the worker container (the runtime on PATH, then
// the image) and installs no Codex: the image carries the agent.
Deno.test("setup runs the container preflight (runtime, then image) and installs no Codex", async () => {
  const calls: string[] = [];
  await runContainerPreflight("/checkout", {
    buildPlan: () => Promise.resolve(preflightPlan("podman")),
    onPath: (runtime) => {
      calls.push(`onPath ${runtime}`);
      return Promise.resolve(true);
    },
    imageExists: (runtime, args) => {
      calls.push(`imageExists ${runtime} ${args.join(" ")}`);
      return Promise.resolve(true);
    },
  });
  // Only the runtime and image checks run: nothing installs or spawns Codex.
  assertEquals(calls, [
    "onPath podman",
    "imageExists podman image inspect vibe-coder:test",
  ]);
});

Deno.test("setup refuses a missing runtime before it checks the image", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      runContainerPreflight("/checkout", {
        buildPlan: () => Promise.resolve(preflightPlan("podman")),
        onPath: () => {
          calls.push("onPath");
          return Promise.resolve(false);
        },
        imageExists: () => {
          calls.push("imageExists");
          return Promise.resolve(true);
        },
      }),
    Error,
    "the container runtime is not on PATH",
  );
  assertEquals(calls, ["onPath"]);
});

Deno.test("setup refuses an unbuilt worker image and names the rebuild", async () => {
  await assertRejects(
    () =>
      runContainerPreflight("/checkout", {
        buildPlan: () => Promise.resolve(preflightPlan("podman")),
        onPath: () => Promise.resolve(true),
        imageExists: () => Promise.resolve(false),
      }),
    Error,
    "the worker image is not built; start the Vibe Coder (./run.sh) once to build it",
  );
});

Deno.test("setup entry point invokes the container preflight and does not install Codex", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      main({
        args: ["--check", "--app-id=1"],
        env: (name) => name === "HOME" ? "/private/home" : undefined,
        loadConfig: () => Promise.resolve({ repos: ["owner/repo"] } as never),
        command: (name) => {
          calls.push(name);
          return Promise.resolve("version");
        },
        preflight: (checkout) => {
          calls.push(`preflight ${checkout}`);
          return Promise.resolve();
        },
        chromiumCheck: () => {
          calls.push("chromium check");
          return Promise.resolve();
        },
        runGh: () => {
          calls.push("gh version");
          return Promise.reject(new Error("stop after preflight"));
        },
      }),
    Error,
    "stop after preflight",
  );
  assertEquals(calls.slice(0, 2), ["git", "rtk"]);
  assert(calls[2]?.startsWith("preflight "));
  assertEquals(calls[3], "chromium check");
  assertEquals(calls[4], "gh version");
  assert(!calls.some((call) => call.includes("codex")));
});
