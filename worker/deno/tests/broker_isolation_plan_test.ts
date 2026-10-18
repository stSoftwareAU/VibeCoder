/** Executable mount/argument checks for the production broker split. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { buildBrokerIsolationPlan } from "../lib/broker_isolation_plan.ts";
import { brokerPlanFixture as fixture } from "./support/broker_supervisor_plan.ts";

for (const kind of ["docker", "podman"] as const) {
  Deno.test(`broker split retains ${kind} hardening and isolates all private mounts`, async () => {
    const f = await fixture(kind);
    try {
      const plan = await buildBrokerIsolationPlan(f.input, {
        privateVolume: "fixture-private-config",
        socketVolume: "fixture-broker-socket",
      });
      assertEquals(plan.runtime, kind);
      assertEquals(
        plan.worker.runArgs[plan.worker.runArgs.indexOf("--network") + 1],
        "none",
      );
      assertEquals(
        plan.broker.runArgs[plan.broker.runArgs.indexOf("--network") + 1],
        "bridge",
      );
      for (const role of [plan.worker, plan.broker]) {
        assertEquals(
          role.runArgs[role.runArgs.indexOf("--cap-drop") + 1],
          "ALL",
        );
        assertEquals(
          role.runArgs[role.runArgs.indexOf("--security-opt") + 1],
          "no-new-privileges",
        );
        assert(role.runArgs.includes("--read-only"));
        assert(role.runArgs.includes("--tmpfs"));
        assertEquals(
          role.mounts.find((m) => m.target === "/run/broker")?.readOnly,
          role === plan.worker,
        );
      }
      assertEquals(plan.privateVolume, "fixture-private-config");
      assertEquals(
        plan.worker.mounts.some((m) => m.source === plan.privateVolume),
        false,
      );
      assertEquals(
        plan.broker.mounts.find((m) => m.source === plan.privateVolume)
          ?.readOnly,
        true,
      );
      assertEquals(
        plan.provisionArgs[plan.provisionArgs.indexOf("--network") + 1],
        "none",
      );
      assert(plan.provisionArgs.includes("--read-only"));
      assertEquals(
        plan.provisionArgs[plan.provisionArgs.indexOf("--cap-drop") + 1],
        "ALL",
      );
      assertEquals(
        plan.provisionArgs[plan.provisionArgs.indexOf("--security-opt") + 1],
        "no-new-privileges",
      );
      assert(
        plan.provisionArgs.includes(
          "fixture-private-config:/run/broker-config",
        ),
      );
      assertEquals(plan.provisionArgs.includes("--allow-net"), false);
      assertEquals(
        plan.provisionArgs.some((arg) => arg.includes(":/run/broker:")),
        false,
      );
      assertEquals(plan.provisionArgs.at(-1), "stage");
      assertEquals(plan.broker.mounts.map((m) => m.target), [
        "/workspace",
        "/run/broker-config",
        "/run/broker",
      ]);
      assertEquals(plan.broker.mounts.filter((m) => !m.readOnly).length, 1);
      assertEquals(
        plan.worker.mounts.some((m) => m.source.includes("/credentials/")),
        false,
      );
      assertEquals(
        plan.worker.runArgs.some((a) => a.includes("/credentials/")),
        false,
      );
      assertEquals(
        plan.worker.runArgs.some((a) => a.includes(f.config)),
        false,
      );
      assertEquals(
        plan.broker.runArgs.filter((_arg, i, args) => args[i - 1] === "--env"),
        [
          "DENO_DIR=/tmp/broker-deno-cache",
          "DENO_NO_UPDATE_CHECK=1",
        ],
      );
      assertEquals(plan.broker.runArgs.at(-1), "serve");
      assertEquals(plan.worker.runArgs.at(-1), plan.worker.image);
      assertEquals(plan.socketInitArgs.filter((a) => a.includes(":/")), [
        "fixture-broker-socket:/run/broker",
        "fixture-private-config:/run/broker-config",
      ]);
      assertEquals(
        plan.socketInitArgs[plan.socketInitArgs.indexOf("--network") + 1],
        "none",
      );
      assertEquals(plan.worker.volumes.length, 3);
      assertEquals(plan.socketVolume, "fixture-broker-socket");
    } finally {
      await f.close();
    }
  });
}

Deno.test("broker split rejects unsupported runtime and shared credential/config aliases", async () => {
  const apple = await fixture("apple-container");
  try {
    await assertRejects(
      () =>
        buildBrokerIsolationPlan(apple.input, {
          privateVolume: "fixture-private-config",
          socketVolume: "fixture-socket",
        }),
      Error,
      "Apple broker boundary has not been validated",
    );
  } finally {
    await apple.close();
  }
  const f = await fixture();
  try {
    const promptAlias = `${f.root}/prompt-alias`;
    await Deno.symlink(
      `${f.input.hostPaths.credentialDir}/claude`,
      promptAlias,
    );
    await assertRejects(
      () =>
        buildBrokerIsolationPlan({
          ...f.input,
          customPromptPaths: [`${promptAlias}/prompt.md`],
        }, {
          privateVolume: "fixture-private-config",
          socketVolume: "fixture-socket",
        }),
      Error,
      "credential source overlaps a worker mount",
    );
    for (
      const socketVolume of [
        "../escape",
        "vibe-work",
        "vibe-approval-state",
        "vibe-agent-state",
      ]
    ) {
      await assertRejects(() =>
        buildBrokerIsolationPlan(f.input, {
          privateVolume: "fixture-private-config",
          socketVolume,
        })
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("broker split refuses an original host config exposed through checkout or a symlink", async () => {
  const f = await fixture();
  try {
    const raw = `${f.input.hostPaths.baseDir}/.config.json`;
    await Deno.writeTextFile(raw, '{"synthetic":"private-host-value"}');
    for (const alias of [raw, `${f.root}/config-alias`]) {
      if (alias !== raw) await Deno.symlink(raw, alias);
      await assertRejects(
        () =>
          buildBrokerIsolationPlan({
            ...f.input,
            hostPaths: { ...f.input.hostPaths, configFile: alias },
          }, {
            privateVolume: "fixture-private-config",
            socketVolume: "fixture-socket",
          }),
        Error,
        "Original host configuration overlaps a worker mount",
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("broker split refuses private volume aliases and mounts no host credential config", async () => {
  const f = await fixture();
  try {
    for (const privateVolume of ["fixture-socket", "vibe-work", "../private"]) {
      await assertRejects(() =>
        buildBrokerIsolationPlan(f.input, {
          socketVolume: "fixture-socket",
          privateVolume,
        })
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("broker split snapshots session volume options before asynchronous path checks", async () => {
  const f = await fixture();
  try {
    const options = {
      socketVolume: "fixture-socket",
      privateVolume: "fixture-private",
    };
    const building = buildBrokerIsolationPlan(f.input, options);
    options.privateVolume = "vibe-work";
    options.socketVolume = "vibe-agent-state";
    const plan = await building;
    assertEquals(plan.privateVolume, "fixture-private");
    assertEquals(plan.socketVolume, "fixture-socket");
  } finally {
    await f.close();
  }
});
