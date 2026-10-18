/**
 * Trusted host lifecycle for the isolated worker/broker pair (#3698, #3699).
 *
 * Receives only a host-built plan; it exposes no worker command or authority
 * RPC. Normal startup does not select it until the remaining account/bootstrap
 * and GitHub/git policy integration is complete.
 */
import type { BrokerIsolationPlan } from "./broker_isolation_plan.ts";
import {
  createReapDeps,
  dialectForExecutable,
  parseContainerListing,
  reapWedgedContainer,
} from "./container_watchdog.ts";

import { parseBrokerSessionConfig } from "./broker_session_config.ts";
import { CONTAINER_RUNTIMES } from "./container_runtime.ts";

const OWNER_LABEL = "io.vibecoder.broker-session";

interface RuntimeChild {
  pid: number;
  status: Promise<number>;
}

export interface BrokerSupervisorDeps {
  /** Bounded runtime calls; production uses the existing watchdog runner. */
  run: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr?: string }>;
  start: (args: string[], input?: Uint8Array) => RuntimeChild;
  /** True only when the existing reaper verifies the container/client gone. */
  reap: (
    name: string,
    pid: number | undefined,
    owner: string,
  ) => Promise<boolean>;
}

/** Classify runtime failures without printing names, paths or private values. */
function readinessDiagnostic(stderr: string | undefined): string {
  if (
    /can only create exec sessions on running containers|container .* is not running/i
      .test(stderr ?? "")
  ) {
    return "container-not-running";
  }
  if (/no such container|no container with name or ID/i.test(stderr ?? "")) {
    return "container-not-found";
  }
  if (
    /permission denied|operation not permitted|NotCapable/i.test(stderr ?? "")
  ) {
    return "permission-denied";
  }
  if (/timed? ?out|TimeoutError/i.test(stderr ?? "")) return "runtime-timeout";
  return "unclassified";
}

/** Only fixed state fields enter diagnostics; never echo the inspect payload. */
function readinessState(code: number, stdout: string): string {
  if (code !== 0) {
    return "state=unavailable, running=unknown, containerExit=unknown";
  }
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ) {
      value = parsed as Record<string, unknown>;
    }
  } catch {
    // Inspection is diagnostic only: malformed data cannot enable a retry.
  }
  const states = [
    "configured",
    "created",
    "initialized",
    "running",
    "paused",
    "restarting",
    "stopping",
    "stopped",
    "exited",
    "removing",
    "dead",
  ];
  const status =
    typeof value.Status === "string" && states.includes(value.Status)
      ? value.Status
      : "unknown";
  const running = typeof value.Running === "boolean"
    ? String(value.Running)
    : "unknown";
  const exit = typeof value.ExitCode === "number" &&
      Number.isSafeInteger(value.ExitCode) &&
      value.ExitCode >= 0 && value.ExitCode <= 255
    ? String(value.ExitCode)
    : "unknown";
  return `state=${status}, running=${running}, containerExit=${exit}`;
}

function productionDeps(plan: BrokerIsolationPlan): BrokerSupervisorDeps {
  const reaper = createReapDeps({
    runtime: plan.runtime,
    listArgs: [...dialectForExecutable(plan.runtime).listArgs, "--all"],
    workDir: Deno.cwd(),
    timeoutMs: 5000,
  });
  return {
    run: (args) => reaper.runRuntime(args),
    start(args, input) {
      const child = new Deno.Command(plan.runtime, {
        args,
        stdin: input ? "piped" : "null",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      const delivered = input
        ? (async () => {
          const writer = child.stdin.getWriter();
          try {
            await writer.write(input);
            await writer.close();
          } finally {
            writer.releaseLock();
          }
        })()
        : Promise.resolve();
      return {
        pid: child.pid,
        status: Promise.all([child.status, delivered]).then(([status]) =>
          status.code
        ),
      };
    },
    async reap(containerName, clientPid, owner) {
      const listed = await reaper.runRuntime(reaper.listArgs);
      if (listed.code !== 0) return false;
      const present = parseContainerListing(listed.stdout).some((entry) =>
        entry.name === containerName
      );
      if (present) {
        const ownership = await reaper.runRuntime([
          "inspect",
          "--format",
          `{{ index .Config.Labels "${OWNER_LABEL}" }}`,
          containerName,
        ]);
        if (ownership.code !== 0 || ownership.stdout.trim() !== owner) {
          return false;
        }
      } else if (clientPid !== undefined && reaper.isProcessAlive(clientPid)) {
        // No labelled container exists yet: terminate only the known local
        // client. Never issue a name-based kill against an unowned container.
        if (!reaper.killProcess(clientPid)) return false;
      }
      const gone = async () => {
        const listed = await reaper.runRuntime(reaper.listArgs);
        return listed.code === 0 &&
          (clientPid === undefined || !reaper.isProcessAlive(clientPid)) &&
          !parseContainerListing(listed.stdout).some((entry) =>
            entry.name === containerName
          );
      };
      if (await gone()) return true;
      if (!present) return false;
      const removeStopped = async () => {
        if (clientPid !== undefined && reaper.isProcessAlive(clientPid)) {
          return false;
        }
        const ownership = await reaper.runRuntime([
          "inspect",
          "--format",
          `{{ index .Config.Labels "${OWNER_LABEL}" }}`,
          containerName,
        ]);
        if (ownership.code !== 0 || ownership.stdout.trim() !== owner) {
          return false;
        }
        // No force: the runtime must refuse removal if execution is active.
        const removed = await reaper.runRuntime(["rm", containerName]);
        return removed.code === 0 && await gone();
      };
      if (await removeStopped()) return true;
      const stopped = await reaper.runRuntime([
        "stop",
        "--time",
        "1",
        containerName,
      ]);
      if (stopped.code === 0) {
        for (let attempt = 0; attempt < 10; attempt++) {
          if (await gone() || await removeStopped()) return true;
          await reaper.sleep(100);
        }
      }
      const result = await reapWedgedContainer(reaper, {
        containerName,
        clientPid,
        graceSeconds: 1,
        trigger: "watchdog",
        reason: "isolated broker/worker session ended",
      });
      return result.clientExited && (await gone() || await removeStopped());
    },
  };
}

/** Run existing attached worker semantics inside the credential boundary. */
export async function superviseBrokeredWorker(
  plan: BrokerIsolationPlan,
  options: {
    /** Selected host values; never included in the launch plan or runtime argv. */
    sessionConfig: string;
    signal?: AbortSignal;
    readinessTimeoutMs?: number;
    pollMs?: number;
  },
  deps?: BrokerSupervisorDeps,
): Promise<number> {
  plan = structuredClone(plan);
  const sessionInput = new TextEncoder().encode(
    JSON.stringify(parseBrokerSessionConfig(options.sessionConfig)),
  );
  deps ??= productionDeps(plan);
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  if (
    !Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1 ||
    readinessTimeoutMs > 60_000 ||
    !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000
  ) {
    throw new Error("Invalid broker readiness bounds");
  }
  const watchdog = new AbortController();
  const timer = setTimeout(
    () => watchdog.abort(),
    plan.worker.watchdogSeconds * 1000,
  );
  const signal = AbortSignal.any([
    watchdog.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const cancelled = () =>
    new Error(
      watchdog.signal.aborted
        ? "Broker supervisor deadline expired"
        : "Broker supervisor cancelled",
    );
  const checkCancelled = () => {
    if (signal.aborted) throw cancelled();
  };
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
  });
  // Register the rejection handler even during bounded setup calls, which
  // complete before cleanup so a late init cannot recreate a removed socket.
  interrupted.catch(() => {});
  const owner = crypto.randomUUID();
  const label = OWNER_LABEL;
  const labelled = (
    args: string[],
  ) => [args[0]!, "--label", `${label}=${owner}`, ...args.slice(1)];
  const initialisers: string[] = [];
  const owned = new Set<string>();
  const volumes = [
    { name: plan.socketVolume, removeArgs: plan.socketRemoveArgs },
    { name: plan.privateVolume, removeArgs: plan.privateRemoveArgs },
  ];
  let provisioner: RuntimeChild | undefined;
  let broker: RuntimeChild | undefined;
  let worker: RuntimeChild | undefined;
  let brokerExited = false;
  let brokerExit: Promise<never> | undefined;
  const checked = async (args: string[], message: string) => {
    const result = await deps.run(args);
    if (result.code !== 0) throw new Error(message);
    return result.stdout;
  };
  let outcome: { code: number } | { error: unknown };
  try {
    checkCancelled();
    // Preflight both names before creating either one. Each successful create
    // still needs an independent owner witness before it becomes removable.
    for (const volume of volumes) {
      const existing = await checked([
        "volume",
        "ls",
        "--filter",
        `name=^${volume.name}$`,
        "--format",
        "{{.Name}}",
      ], "Could not establish broker volume ownership");
      if (existing.trim() !== "") {
        throw new Error("Broker socket or private volume already exists");
      }
      checkCancelled();
    }
    for (const volume of volumes) {
      await checked([
        "volume",
        "create",
        "--label",
        `${label}=${owner}`,
        volume.name,
      ], "Could not create broker session volume");
      const actualOwner = await checked([
        "volume",
        "inspect",
        "--format",
        `{{ index .Labels "${label}" }}`,
        volume.name,
      ], "Could not verify broker volume ownership");
      if (actualOwner.trim() !== owner) {
        throw new Error("Broker volume ownership changed");
      }
      owned.add(volume.name);
      checkCancelled();
    }
    checkCancelled();
    initialisers.push(
      plan.socketInitArgs[plan.socketInitArgs.indexOf("--name") + 1]!,
    );
    await checked(
      labelled(plan.socketInitArgs),
      "Broker socket initialisation failed",
    );
    checkCancelled();
    initialisers.push(
      plan.worker.initArgs[plan.worker.initArgs.indexOf("--name") + 1]!,
    );
    await checked(
      labelled(plan.worker.initArgs),
      "Worker volume initialisation failed",
    );
    checkCancelled();
    provisioner = deps.start(labelled(plan.provisionArgs), sessionInput);
    const provisionCode = await Promise.race([provisioner.status, interrupted]);
    if (provisionCode !== 0) {
      throw new Error("Broker credential provisioning failed");
    }
    checkCancelled();
    broker = deps.start(labelled(plan.broker.runArgs));
    brokerExit = broker.status.then(() => {
      brokerExited = true;
      throw new Error(
        worker
          ? "Broker exited while the worker was active"
          : "Broker exited before readiness",
      );
    }, () => {
      brokerExited = true;
      throw new Error("Broker runtime client failed");
    });
    brokerExit.catch(() => {});
    const deadline = Date.now() + readinessTimeoutMs;
    while (true) {
      checkCancelled();
      if (brokerExited) await brokerExit;
      if (Date.now() >= deadline) {
        throw new Error("Broker readiness deadline expired");
      }
      const identity = await deps.run([
        "inspect",
        "--format",
        `{{ index .Config.Labels "${label}" }}`,
        plan.broker.name,
      ]);
      if (identity.code === 0 && identity.stdout.trim() !== owner) {
        throw new Error("Broker container ownership changed");
      }
      const result = identity.code === 0
        ? await deps.run(plan.readinessArgs)
        : identity;
      checkCancelled();
      if (brokerExited) await brokerExit;
      if (Date.now() >= deadline) {
        throw new Error("Broker readiness deadline expired");
      }
      if (result.code === 0) break;
      // Podman 4.9.3's default inspect tries each object kind before reporting
      // this exact startup miss. Retry identity only; the next iteration must
      // establish our label before any authenticated readiness exec may run.
      const pendingPodmanIdentity = identity.code === 125 &&
        dialectForExecutable(plan.runtime) ===
          CONTAINER_RUNTIMES.podman.dialect &&
        identity.stderr?.trim() ===
          `Error: no such object: "${plan.broker.name}"`;
      if (result.code !== 1 && !pendingPodmanIdentity) {
        // A runtime's exec error is not authenticated readiness. Record its
        // observed state before deciding whether a future fix may retry it.
        const state = await deps.run([
          "inspect",
          "--format",
          "{{json .State}}",
          plan.broker.name,
        ]);
        throw new Error(
          `Broker readiness probe failed (phase=${
            identity.code === 0 ? "exec" : "identity"
          }, exit=${result.code}, diagnostic=${
            readinessDiagnostic(result.stderr)
          }, ${readinessState(state.code, state.stdout)})`,
        );
      }
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise((resolve) => {
            pollTimer = setTimeout(resolve, pollMs);
          }),
          brokerExit,
          interrupted,
        ]);
      } finally {
        clearTimeout(pollTimer);
      }
    }
    checkCancelled();
    worker = deps.start(labelled(plan.worker.runArgs));
    const workerExit = worker.status.then((code) => {
      return code;
    }, () => {
      throw new Error("Worker runtime client failed");
    });
    outcome = {
      code: await Promise.race([workerExit, brokerExit, interrupted]),
    };
  } catch (error) {
    outcome = { error };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  const failures: string[] = [];
  // Revoke authority first, then stop execution. Neither role may survive
  // the host session; a verified cleanup failure must be visible to callers.
  for (
    const role of [
      { child: broker, name: plan.broker.name },
      { child: worker, name: plan.worker.containerName },
      { child: provisioner, name: `${plan.worker.containerName}-broker-stage` },
      ...initialisers.map((name) => ({ child: undefined, name })),
    ]
  ) {
    if (!role.child && !initialisers.includes(role.name)) continue;
    try {
      if (!await deps.reap(role.name, role.child?.pid, owner)) {
        failures.push(role.name);
      }
    } catch {
      failures.push(role.name);
    }
  }
  if (failures.length === 0) {
    for (const volume of [...volumes].reverse()) {
      if (!owned.has(volume.name)) continue;
      try {
        const ownerNow = await checked([
          "volume",
          "inspect",
          "--format",
          `{{ index .Labels "${label}" }}`,
          volume.name,
        ], "Broker volume ownership could not be rechecked");
        if (ownerNow.trim() !== owner) {
          throw new Error("Broker volume ownership changed");
        }
        await checked(
          volume.removeArgs,
          "Broker session volume could not be removed",
        );
      } catch {
        failures.push(
          volume.name === plan.socketVolume
            ? "socket volume"
            : "private volume",
        );
      }
    }
  }
  if (failures.length > 0) {
    const reason = `Broker cleanup failed: ${failures.join(", ")}`;
    throw "error" in outcome
      ? new AggregateError([outcome.error], reason)
      : new Error(reason);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.code;
}
