/** Lifecycle tests drive production plans with controlled runtime completion. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type BrokerSupervisorDeps,
  superviseBrokeredWorker as supervise,
} from "../lib/broker_supervisor.ts";
import { buildBrokerIsolationPlan } from "../lib/broker_isolation_plan.ts";
import { brokerPlanFixture } from "./support/broker_supervisor_plan.ts";

const SESSION = JSON.stringify({
  credentials: { claude: "synthetic-private-secret" },
  repositories: ["fixture/allowed"],
  lifetimeMs: 5000,
});
function superviseBrokeredWorker(
  plan: Parameters<typeof supervise>[0],
  options: Omit<Parameters<typeof supervise>[1], "sessionConfig"> = {},
  deps?: BrokerSupervisorDeps,
) {
  return supervise(plan, { ...options, sessionConfig: SESSION }, deps);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => resolve = r);
  return { promise, resolve };
}

async function harness() {
  const fixture = await brokerPlanFixture();
  const plan = await buildBrokerIsolationPlan(fixture.input, {
    privateVolume: "fixture-private-config",
    socketVolume: "fixture-owned-socket",
  });
  const broker = deferred<number>();
  const worker = deferred<number>();
  const started = deferred<void>();
  const events: string[] = [];
  let ready = false;
  let ownedLabel = "";
  const deps: BrokerSupervisorDeps = {
    async run(args) {
      if (args[0] === "volume" && args[1] === "ls") {
        return { code: 0, stdout: "" };
      }
      if (args[0] === "volume" && args[1] === "create") {
        ownedLabel = args[3]!.split("=")[1]!;
        events.push("create-socket");
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        return { code: 0, stdout: ownedLabel };
      }
      if (args[0] === "inspect") return { code: 0, stdout: ownedLabel };
      if (args[0] === "volume" && args[1] === "rm") {
        events.push(
          args.at(-1) === plan.socketVolume
            ? "remove-socket"
            : "remove-private",
        );
      }
      if (args[0] === "exec") {
        events.push("probe");
        return { code: ready ? 0 : 1, stdout: "" };
      }
      if (args[0] === "run") events.push("initialise");
      return { code: 0, stdout: "" };
    },
    start(args, input) {
      if (args.includes(`${plan.worker.containerName}-broker-stage`)) {
        events.push("start-stage");
        assertEquals(new TextDecoder().decode(input), SESSION);
        assertEquals(
          args.some((a) => a.includes("synthetic-private-secret")),
          false,
        );
        return { pid: 70, status: Promise.resolve(0) };
      }
      const isBroker = args.includes(plan.broker.name);
      events.push(isBroker ? "start-broker" : "start-worker");
      if (!isBroker) {
        assert(ready, "worker ran before authenticated broker readiness");
        started.resolve();
      }
      return {
        pid: isBroker ? 71 : 72,
        status: isBroker ? broker.promise : worker.promise,
      };
    },
    async reap(name) {
      events.push(`reap:${name}`);
      if (name === plan.broker.name) broker.resolve(0);
      else if (name === plan.worker.containerName) worker.resolve(143);
      return true;
    },
  };
  return {
    fixture,
    plan,
    broker,
    worker,
    started,
    events,
    deps,
    ready: () => {
      ready = true;
    },
  };
}

Deno.test("supervisor waits for readiness then preserves the attached worker exit and reaps the broker", async () => {
  const h = await harness();
  try {
    const running = superviseBrokeredWorker(h.plan, {
      readinessTimeoutMs: 200,
      pollMs: 1,
    }, h.deps);
    h.ready();
    await h.started.promise;
    h.worker.resolve(7);
    assertEquals(await running, 7);
    assert(h.events.indexOf("start-stage") < h.events.indexOf("start-broker"));
    assert(h.events.indexOf("probe") < h.events.indexOf("start-worker"));
    assert(h.events.includes(`reap:${h.plan.broker.name}`));
    assertEquals(h.events.at(-1), "remove-socket");
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor readiness timeout prevents worker launch and cleans only its socket volume", async () => {
  const h = await harness();
  try {
    await assertRejects(
      () =>
        superviseBrokeredWorker(
          h.plan,
          { readinessTimeoutMs: 5, pollMs: 1 },
          h.deps,
        ),
      Error,
      "Broker readiness deadline expired",
    );
    assertEquals(h.events.includes("start-worker"), false);
    assert(h.events.includes(`reap:${h.plan.broker.name}`));
    assertEquals(h.events.at(-1), "remove-socket");
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor diagnoses runtime readiness failure without exposing stderr or accepting exec 125", async () => {
  const h = await harness();
  let probes = 0;
  let stateInspections = 0;
  try {
    const run = h.deps.run;
    h.deps.run = (args) => {
      if (args[0] === "exec") {
        probes++;
        return Promise.resolve({
          code: 125,
          stdout: "synthetic-private-stdout",
          stderr:
            "Error: can only create exec sessions on running containers: container state improper; synthetic-private-stderr",
        });
      }
      if (args[0] === "inspect" && args[2] === "{{json .State}}") {
        stateInspections++;
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            Status: "created",
            Running: false,
            ExitCode: 0,
            Error: "synthetic-private-state-error",
          }),
        });
      }
      return run(args);
    };
    const failure = await assertRejects(
      () => superviseBrokeredWorker(h.plan, {}, h.deps),
      Error,
      "Broker readiness probe failed (phase=exec, exit=125, diagnostic=container-not-running, state=created, running=false, containerExit=0)",
    );
    assertEquals(failure.message.includes("synthetic-private"), false);
    assertEquals(probes, 1);
    assertEquals(stateInspections, 1);
    assertEquals(h.events.includes("start-worker"), false);
    assert(h.events.includes(`reap:${h.plan.broker.name}`));
    assertEquals(h.events.at(-1), "remove-socket");
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor diagnoses failed identity lookup and malformed state without trusting runtime text", async () => {
  const h = await harness();
  let probes = 0;
  try {
    const run = h.deps.run;
    h.deps.run = (args) => {
      if (args[0] === "inspect") {
        return Promise.resolve(
          args[2] === "{{json .State}}"
            ? {
              code: 0,
              stdout: JSON.stringify({
                Status: "synthetic-private-state",
                Running: "true",
                ExitCode: "0",
              }),
            }
            : {
              code: 125,
              stdout: "",
              stderr:
                "Error: no container with name or ID synthetic-private-name found: no such container",
            },
        );
      }
      if (args[0] === "exec") probes++;
      return run(args);
    };
    const failure = await assertRejects(
      () => superviseBrokeredWorker(h.plan, {}, h.deps),
      Error,
      "Broker readiness probe failed (phase=identity, exit=125, diagnostic=container-not-found, state=unknown, running=unknown, containerExit=unknown)",
    );
    assertEquals(failure.message.includes("synthetic-private"), false);
    assertEquals(probes, 0);
    assertEquals(h.events.includes("start-worker"), false);
  } finally {
    await h.fixture.close();
  }
});

Deno.test({
  name:
    "supervisor production adapter retains scrubbed exec failure diagnostics and reaps the broker",
  ignore: Deno.build.os === "windows",
  async fn() {
    const h = await harness();
    try {
      const executable = `${h.fixture.root}/podman`;
      await Deno.copyFile(
        new URL("./fixtures/broker_fake_runtime.py", import.meta.url),
        executable,
      );
      await Deno.chmod(executable, 0o700);
      await Deno.writeTextFile(
        `${h.fixture.root}/fail-readiness-exec`,
        "fixture",
      );
      h.plan.runtime = executable;
      const failure = await assertRejects(
        () => superviseBrokeredWorker(h.plan, { readinessTimeoutMs: 3000 }),
        Error,
        "Broker readiness probe failed (phase=exec, exit=125, diagnostic=container-not-running, state=running, running=true, containerExit=0)",
      );
      assertEquals(failure.message.includes("synthetic-private"), false);
      const calls = (await Deno.readTextFile(`${h.fixture.root}/calls.log`))
        .trim().split("\n").map((line) => JSON.parse(line) as string[]);
      assert(
        calls.some((args) =>
          args[0] === "inspect" && args[2] === "{{json .State}}"
        ),
      );
      assertEquals(
        calls.some((args) =>
          args[0] === "run" &&
          args[args.indexOf("--name") + 1] === h.plan.worker.containerName
        ),
        false,
      );
      const entries = Array.from(Deno.readDirSync(h.fixture.root)).map((
        entry,
      ) => entry.name);
      assertEquals(entries.some((name) => name.endsWith(".container")), false);
      assertEquals(entries.some((name) => name.endsWith(".volume")), false);
    } finally {
      await h.fixture.close();
    }
  },
});

Deno.test("supervisor broker loss stops a running worker and external cancellation revokes both roles", async () => {
  for (const cause of ["broker", "cancel"] as const) {
    const h = await harness();
    const controller = new AbortController();
    try {
      h.ready();
      const running = superviseBrokeredWorker(h.plan, {
        signal: controller.signal,
        readinessTimeoutMs: 200,
        pollMs: 1,
      }, h.deps);
      await h.started.promise;
      if (cause === "broker") h.broker.resolve(0);
      else controller.abort();
      await assertRejects(
        () => running,
        Error,
        cause === "broker"
          ? "Broker exited while the worker was active"
          : "Broker supervisor cancelled",
      );
      assert(h.events.includes(`reap:${h.plan.worker.containerName}`));
      if (cause === "cancel") {
        assert(h.events.includes(`reap:${h.plan.broker.name}`));
      }
      assertEquals(h.events.at(-1), "remove-socket");
    } finally {
      await h.fixture.close();
    }
  }
});

Deno.test("supervisor refuses pre-existing socket volumes and surfaces cleanup failure", async () => {
  const existing = await harness();
  try {
    existing.deps.run = () =>
      Promise.resolve({ code: 0, stdout: "fixture-owned-socket\n" });
    await assertRejects(
      () => superviseBrokeredWorker(existing.plan, {}, existing.deps),
      Error,
      "Broker socket or private volume already exists",
    );
    assertEquals(existing.events, []);
  } finally {
    await existing.fixture.close();
  }
  const broken = await harness();
  try {
    broken.ready();
    broken.deps.reap = () => Promise.resolve(false);
    const running = superviseBrokeredWorker(broken.plan, {}, broken.deps);
    await broken.started.promise;
    broken.worker.resolve(0);
    await assertRejects(() => running, Error, "Broker cleanup failed");
    // A still-running broker owns its socket; never pretend removal succeeded.
    assertEquals(broken.events.includes("remove-socket"), false);
    assertEquals(broken.events.includes("remove-private"), false);
  } finally {
    await broken.fixture.close();
  }
});

Deno.test("supervisor does not start a worker after early broker exit or a late readiness success", async () => {
  for (const late of [false, true]) {
    const h = await harness();
    try {
      const run = h.deps.run;
      h.deps.run = async (args) => {
        if (args[0] === "exec") {
          if (late) await new Promise((resolve) => setTimeout(resolve, 15));
          else h.broker.resolve(0);
          return { code: 0, stdout: "" };
        }
        return await run(args);
      };
      await assertRejects(
        () =>
          superviseBrokeredWorker(
            h.plan,
            { readinessTimeoutMs: 8, pollMs: 1 },
            h.deps,
          ),
        Error,
        late ? "readiness deadline expired" : "exited before readiness",
      );
      assertEquals(h.events.includes("start-worker"), false);
      assert(h.events.includes(`reap:${h.plan.broker.name}`));
      assertEquals(h.events.at(-1), "remove-socket");
    } finally {
      await h.fixture.close();
    }
  }
});

Deno.test("supervisor labels every started container and keeps foreign or unverifiable socket ownership", async () => {
  const h = await harness();
  try {
    h.ready();
    const run = h.deps.run;
    const start = h.deps.start;
    const labels: string[] = [];
    let inspections = 0;
    h.deps.run = async (args) => {
      if (args[0] === "run") labels.push(args[args.indexOf("--label") + 1]!);
      if (
        args[0] === "volume" && args[1] === "inspect" &&
        args.at(-1) === h.plan.socketVolume && ++inspections === 2
      ) return { code: 0, stdout: "different-owner" };
      return await run(args);
    };
    h.deps.start = (args, input) => {
      labels.push(args[args.indexOf("--label") + 1]!);
      return start(args, input);
    };
    const running = superviseBrokeredWorker(h.plan, {}, h.deps);
    await h.started.promise;
    h.worker.resolve(0);
    await assertRejects(
      () => running,
      Error,
      "Broker cleanup failed: socket volume",
    );
    assertEquals(labels.length, 5);
    assertEquals(new Set(labels).size, 1);
    assert(labels[0]!.startsWith("io.vibecoder.broker-session="));
    assertEquals(h.events.includes("remove-socket"), false);
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor snapshots host plan and refuses cancellation before creating resources", async () => {
  const h = await harness();
  const controller = new AbortController();
  try {
    controller.abort();
    await assertRejects(
      () =>
        superviseBrokeredWorker(h.plan, { signal: controller.signal }, h.deps),
      Error,
      "Broker supervisor cancelled",
    );
    assertEquals(h.events, []);
    h.ready();
    const start = h.deps.start;
    h.deps.start = (args, input) => {
      assertEquals(args.includes("--privileged"), false);
      return start(args, input);
    };
    const running = superviseBrokeredWorker(h.plan, {}, h.deps);
    h.plan.worker.runArgs.push("--privileged");
    await h.started.promise;
    h.worker.resolve(0);
    assertEquals(await running, 0);
  } finally {
    await h.fixture.close();
  }
});

Deno.test({
  name:
    "supervisor production process adapter attaches and cleans actual local child processes",
  // The fixture is a POSIX executable; hosted OCI validation also runs Linux.
  ignore: Deno.build.os === "windows",
  async fn() {
    const h = await harness();
    try {
      const executable = `${h.fixture.root}/docker`;
      await Deno.copyFile(
        new URL("./fixtures/broker_fake_runtime.py", import.meta.url),
        executable,
      );
      await Deno.chmod(executable, 0o700);
      h.plan.runtime = executable;
      const running = superviseBrokeredWorker(h.plan, {
        readinessTimeoutMs: 3000,
      });
      h.plan.runtime = `${h.fixture.root}/must-never-start`;
      const result = await running.then((code) => ({ code }), (error) => ({
        error: error instanceof Error ? error.name : "unknown",
      }));
      assertEquals(result, { code: 7 });
      const calls = (await Deno.readTextFile(`${h.fixture.root}/calls.log`))
        .trim().split("\n").map((line) => JSON.parse(line) as string[]);
      assert(calls.some((args) => args[0] === "exec"));
      assert(
        calls.some((args) =>
          args[0] === "stop" && args.at(-1) === h.plan.broker.name
        ),
      );
      const entries = Array.from(Deno.readDirSync(h.fixture.root)).map((
        entry,
      ) => entry.name);
      assertEquals(entries.some((name) => name.endsWith(".container")), false);
      assertEquals(entries.some((name) => name.endsWith(".volume")), false);
    } finally {
      await h.fixture.close();
    }
  },
});

Deno.test("supervisor refuses a foreign broker identity before readiness or worker start", async () => {
  const h = await harness();
  try {
    h.ready();
    const run = h.deps.run;
    h.deps.run = (args) =>
      args[0] === "inspect"
        ? Promise.resolve({ code: 0, stdout: "another-host-session" })
        : run(args);
    h.worker.resolve(0);
    await assertRejects(
      () => superviseBrokeredWorker(h.plan, {}, h.deps),
      Error,
      "Broker container ownership changed",
    );
    assertEquals(h.events.includes("probe"), false);
    assertEquals(h.events.includes("start-worker"), false);
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor cancels readiness polling without leaving timers or starting the worker", async () => {
  const h = await harness();
  const controller = new AbortController();
  try {
    const run = h.deps.run;
    h.deps.run = async (args) => {
      const result = await run(args);
      if (args[0] === "exec") setTimeout(() => controller.abort(), 5);
      return result;
    };
    await assertRejects(
      () =>
        superviseBrokeredWorker(h.plan, {
          signal: controller.signal,
          readinessTimeoutMs: 1000,
          pollMs: 500,
        }, h.deps),
      Error,
      "Broker supervisor cancelled",
    );
    assertEquals(h.events.includes("start-worker"), false);
    assertEquals(h.events.at(-1), "remove-socket");
  } finally {
    await h.fixture.close();
  }
});

Deno.test({
  name:
    "supervisor production cleanup refuses foreign stopped containers and removes its own stopped worker",
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const foreign of [true, false]) {
      const h = await harness();
      try {
        const executable = `${h.fixture.root}/docker`;
        await Deno.copyFile(
          new URL("./fixtures/broker_fake_runtime.py", import.meta.url),
          executable,
        );
        await Deno.chmod(executable, 0o700);
        h.plan.runtime = executable;
        const name = `${h.plan.worker.containerName}-broker-init`;
        if (foreign) {
          await Deno.writeTextFile(
            `${h.fixture.root}/${name}.container`,
            JSON.stringify({ pid: 99999999, owner: "another-session" }),
          );
          await assertRejects(
            () => superviseBrokeredWorker(h.plan),
            Error,
            `Broker cleanup failed: ${name}`,
          );
          const calls = (await Deno.readTextFile(`${h.fixture.root}/calls.log`))
            .trim().split("\n").map((s) => JSON.parse(s) as string[]);
          assertEquals(
            calls.some((args) =>
              ["stop", "kill", "rm"].includes(args[0]!) && args.at(-1) === name
            ),
            false,
          );
          assertEquals(
            await Deno.readTextFile(`${h.fixture.root}/${name}.container`),
            JSON.stringify({ pid: 99999999, owner: "another-session" }),
          );
          assertEquals(
            calls.some((args) => args[0] === "volume" && args[1] === "rm"),
            false,
          );
        } else {
          await Deno.writeTextFile(`${h.fixture.root}/keep-stopped-worker`, "");
          assertEquals(await superviseBrokeredWorker(h.plan), 7);
          assertEquals(
            Array.from(Deno.readDirSync(h.fixture.root)).some((entry) =>
              entry.name.endsWith(".container")
            ),
            false,
          );
        }
      } finally {
        await h.fixture.close();
      }
    }
  },
});

Deno.test("supervisor revokes a cancelled provisioner before removing either private session volume", async () => {
  const h = await harness();
  const controller = new AbortController();
  const staging = deferred<void>();
  const completion = deferred<number>();
  const start = h.deps.start;
  const reap = h.deps.reap;
  try {
    h.deps.start = (args, input) => {
      const child = start(args, input);
      if (args.includes(`${h.plan.worker.containerName}-broker-stage`)) {
        staging.resolve();
        return { ...child, status: completion.promise };
      }
      return child;
    };
    h.deps.reap = async (name, pid, owner) => {
      if (name.endsWith("-broker-stage")) completion.resolve(143);
      return await reap(name, pid, owner);
    };
    const running = superviseBrokeredWorker(h.plan, {
      signal: controller.signal,
    }, h.deps);
    await staging.promise;
    controller.abort();
    await assertRejects(() => running, Error, "Broker supervisor cancelled");
    assertEquals(h.events.includes("start-broker"), false);
    assertEquals(h.events.includes("start-worker"), false);
    assert(
      h.events.includes(`reap:${h.plan.worker.containerName}-broker-stage`),
    );
    assert(
      h.events.indexOf(`reap:${h.plan.worker.containerName}-broker-stage`) <
        h.events.indexOf("remove-private"),
    );
    assert(h.events.includes("remove-private"));
    assert(h.events.includes("remove-socket"));
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor refuses invalid session data before resources and cleans only proven volumes after partial setup", async () => {
  const h = await harness();
  try {
    await assertRejects(
      () =>
        supervise(h.plan, {
          sessionConfig: '{"credentials":"synthetic-secret"}',
        }, h.deps),
      Error,
      "Invalid private broker session configuration",
    );
    assertEquals(h.events, []);
    const run = h.deps.run;
    h.deps.run = (args) =>
      args[0] === "volume" && args[1] === "create" &&
        args.at(-1) === h.plan.privateVolume
        ? Promise.resolve({ code: 1, stdout: "" })
        : run(args);
    await assertRejects(
      () => superviseBrokeredWorker(h.plan, {}, h.deps),
      Error,
      "Could not create broker session volume",
    );
    assertEquals(h.events.includes("remove-private"), false);
    assertEquals(h.events.includes("remove-socket"), true);
    assertEquals(h.events.includes("start-stage"), false);
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor does not launch broker or worker when private provisioning fails", async () => {
  const h = await harness();
  try {
    h.deps.start = () => ({ pid: 70, status: Promise.resolve(9) });
    await assertRejects(
      () => superviseBrokeredWorker(h.plan, {}, h.deps),
      Error,
      "Broker credential provisioning failed",
    );
    assertEquals(h.events.includes("start-worker"), false);
    assertEquals(h.events.includes("probe"), false);
    assert(h.events.includes("remove-private"));
    assert(h.events.includes("remove-socket"));
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor refuses a pre-existing private volume before creating socket state", async () => {
  const h = await harness();
  try {
    h.ready();
    h.worker.resolve(0);
    const run = h.deps.run;
    h.deps.run = (args) =>
      args[0] === "volume" && args[1] === "ls" &&
        args.includes(`name=^${h.plan.privateVolume}$`)
        ? Promise.resolve({ code: 0, stdout: h.plan.privateVolume })
        : run(args);
    await assertRejects(
      () => superviseBrokeredWorker(h.plan, {}, h.deps),
      Error,
      "already exists",
    );
    assertEquals(h.events, []);
  } finally {
    await h.fixture.close();
  }
});

Deno.test("supervisor keeps private state whose ownership changes while still cleaning its socket", async () => {
  const h = await harness();
  try {
    h.ready();
    h.worker.resolve(0);
    const run = h.deps.run;
    let inspections = 0;
    h.deps.run = (args) =>
      args[0] === "volume" && args[1] === "inspect" &&
        args.at(-1) === h.plan.privateVolume && ++inspections === 2
        ? Promise.resolve({ code: 0, stdout: "foreign-private-owner" })
        : run(args);
    await assertRejects(
      () => superviseBrokeredWorker(h.plan, {}, h.deps),
      Error,
      "Broker cleanup failed: private volume",
    );
    assertEquals(h.events.includes("remove-private"), false);
    assertEquals(h.events.includes("remove-socket"), true);
  } finally {
    await h.fixture.close();
  }
});
