/** Executable mount/argument checks for the production broker split. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { buildBrokerIsolationPlan } from "../lib/broker_isolation_plan.ts";
import { brokerPlanFixture as fixture } from "./support/broker_supervisor_plan.ts";

for (const kind of ["docker", "podman"] as const) {
  Deno.test(`broker split retains ${kind} hardening and isolates all private mounts`, async () => {
    const f = await fixture(kind);
    try {
      const plan = await buildBrokerIsolationPlan(f.input, {
        brokerConfigDir: f.config,
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
          brokerConfigDir: apple.config,
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
    for (
      const config of [
        f.input.hostPaths.baseDir,
        `${f.input.hostPaths.baseDir}/private`,
      ]
    ) {
      await Deno.mkdir(config, { recursive: true });
      await assertRejects(
        () =>
          buildBrokerIsolationPlan(f.input, {
            brokerConfigDir: config,
            socketVolume: "fixture-socket",
          }),
        Error,
        "private broker configuration overlaps a worker mount",
      );
    }
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
        }, { brokerConfigDir: f.config, socketVolume: "fixture-socket" }),
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
          brokerConfigDir: f.config,
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
          }, { brokerConfigDir: f.config, socketVolume: "fixture-socket" }),
        Error,
        "Original host configuration overlaps a worker mount",
      );
    }
  } finally {
    await f.close();
  }
});
