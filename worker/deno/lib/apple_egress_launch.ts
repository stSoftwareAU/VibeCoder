/** Apple-specific argv/capability adapter; policy and proxy stay shared. */
import type { ParsedContainerLaunchPlan } from "./container_launch.ts";
import type { EgressSidecarPlan } from "./egress_sidecar.ts";
import type { AppleEgressMode } from "./apple_egress_controls.ts";

/** Cleanup authority must never live in a worker-visible bind mount. */
export async function appleStateDirectory(
  home: string,
  runArgs: readonly string[],
  currentUid: () => number | null = () => Deno.uid(),
): Promise<string> {
  const state = `${await Deno.realPath(home)}/.vibe-apple-egress`;
  try {
    await Deno.mkdir(state, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = await Deno.lstat(state);
  if (
    !info.isDirectory || info.isSymlink || info.uid !== currentUid() ||
    info.mode === null || (info.mode & 0o077) !== 0
  ) throw new Error("Apple ownership state must be a private host directory");
  for (let i = 0; i < runArgs.length; i++) {
    if (runArgs[i] !== "--volume" && runArgs[i] !== "-v") continue;
    const source = runArgs[i + 1]?.split(":")[0];
    if (!source?.startsWith("/")) continue; // Named guest volumes.
    const mounted = await Deno.realPath(source);
    if (
      mounted === state ||
      state.startsWith(mounted === "/" ? "/" : `${mounted}/`) ||
      mounted.startsWith(`${state}/`)
    ) throw new Error("Apple ownership state overlaps a worker bind mount");
  }
  return state;
}

/** Bound writes, output drains and shutdown even when a CLI ignores SIGTERM. */
export async function boundedAppleChild<T>(
  child: Deno.ChildProcess,
  action: () => Promise<T>,
  timeoutMs: number,
  graceMs = 1000,
  cancelIo: () => void = () => {},
): Promise<T> {
  const signal = (name: Deno.Signal) => {
    try {
      child.kill(name);
    } catch { /* Already exited. */ }
  };
  let expired = false;
  const soft = setTimeout(() => {
    expired = true;
    signal("SIGTERM");
  }, timeoutMs);
  let hard: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    hard = setTimeout(() => {
      signal("SIGKILL");
      cancelIo();
      reject(new Error("Apple runtime command exceeded its bounded deadline"));
    }, timeoutMs + graceMs);
  });
  try {
    const result = await Promise.race([action(), deadline]);
    if (expired) {
      throw new Error("Apple runtime command exceeded its bounded deadline");
    }
    return result;
  } catch (error) {
    signal("SIGKILL");
    cancelIo();
    let reap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      child.status.catch(() => {}),
      new Promise<void>((resolve) => {
        reap = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(reap);
    throw error;
  } finally {
    clearTimeout(soft);
    clearTimeout(hard);
  }
}

/** Explicit readers let a deadline close pipes inherited by CLI descendants. */
export async function appleChildOutput(
  child: Deno.ChildProcess,
  stdin: Uint8Array | undefined,
  timeoutMs: number,
  graceMs = 1000,
): Promise<Deno.CommandOutput> {
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const writer = stdin ? child.stdin.getWriter() : undefined;
  const cancel = () => {
    for (const reader of readers) reader.cancel().catch(() => {});
    writer?.abort().catch(() => {});
  };
  const collect = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  };
  return await boundedAppleChild(
    child,
    async () => {
      const [status, stdout, stderr] = await Promise.all([
        child.status,
        collect(readers[0]!),
        collect(readers[1]!),
        (async () => {
          if (writer && stdin) {
            await writer.write(stdin);
            await writer.close();
          }
        })(),
      ]);
      return { ...status, stdout, stderr };
    },
    timeoutMs,
    graceMs,
    cancel,
  );
}

export interface AppleCapabilities {
  version: string;
  macOS: string;
  internal: boolean;
  reason: string;
}

/** Version AND actual help must support the measured 1.2.2 dialect. */
export function appleCapabilities(
  version: string,
  macOS: string,
  createHelp: string,
  runHelp: string,
): AppleCapabilities {
  const match = /(?:version\s+)?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || !/^\d+\./.test(macOS.trim())) {
    throw new Error("Apple runtime/macOS version could not be measured");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const supportedVersion = major > 1 ||
    (major === 1 && (minor > 2 || (minor === 2 && patch >= 2)));
  const internal = supportedVersion && Number(macOS.split(".")[0]) >= 26 &&
    createHelp.includes("--internal") && runHelp.includes("--network");
  return {
    version: match[0].replace(/^version\s+/, ""),
    macOS: macOS.trim(),
    internal,
    reason: internal
      ? "version and CLI network flags verified"
      : "internal/multi-network dialect unavailable on measured CLI/macOS",
  };
}

export function appleMode(
  request: string | undefined,
  caps: AppleCapabilities,
): AppleEgressMode {
  if (
    request !== undefined && !["auto", "internal", "advisory"].includes(request)
  ) {
    throw new Error(
      "VIBE_APPLE_EGRESS_MODE must be auto, internal or advisory",
    );
  }
  if (request === "internal" && !caps.internal) {
    throw new Error(`Apple internal mode unavailable: ${caps.reason}`);
  }
  return request === "advisory" || !caps.internal ? "advisory" : "internal";
}

export interface AppleLaunch {
  sidecar: EgressSidecarPlan;
  run: string[];
  network: string;
  proxy: string;
  mode: AppleEgressMode;
}

/** One unique launch owns only these names; never remove a pre-existing name. */
export function appleLaunch(
  plan: ParsedContainerLaunchPlan,
  mode: AppleEgressMode,
  owner: number,
  nonce: string,
): AppleLaunch {
  if (
    !Number.isSafeInteger(owner) || owner <= 0 || owner > 2147483647 ||
    !/^[a-f0-9]{32}$/.test(nonce)
  ) throw new Error("Invalid Apple launch identity");
  if (!plan.proxyName || !plan.proxyRun.length || !plan.networkCreate.length) {
    throw new Error("Apple launch is missing its shared proxy plan");
  }
  const network = `vibe-egress-owned-${owner}-${nonce.slice(0, 24)}`;
  const proxy = `${network}-proxy`;
  const originalNetwork = plan.networkCreate.at(-1)!;
  const rewrite = (args: string[]) =>
    args.map((arg) =>
      arg === plan.proxyName ? proxy : arg === originalNetwork ? network : arg
    );
  const withoutNetwork = (args: string[]) =>
    args.filter((arg, i) =>
      !(arg === "--network" && args[i + 1] === network) &&
      !(arg === network && args[i - 1] === "--network")
    );
  const run = rewrite(plan.run);
  const proxyRun = rewrite(plan.proxyRun);
  // The internal network has no reachable DNS, and Deno's fetch resolves the
  // target before it uses HTTPS_PROXY: each new host waited ~10s for that
  // lookup to time out. A resolver at 127.0.0.1 is refused at once, so the
  // request goes straight to the proxy, which resolves and checks the host.
  const internalRun = (args: string[]) => {
    const at = args.findIndex((arg, i) =>
      arg === "--network" && args[i + 1] === network
    );
    return at === -1
      ? args
      : [...args.slice(0, at + 2), "--dns", "127.0.0.1", ...args.slice(at + 2)];
  };
  return {
    network,
    proxy,
    mode,
    run: mode === "internal" ? internalRun(run) : withoutNetwork(run),
    sidecar: {
      runtime: plan.runtime,
      egressEnforced: false,
      networkCreateArgs: mode === "internal" ? rewrite(plan.networkCreate) : [],
      networkRemoveArgs: mode === "internal" ? rewrite(plan.networkRemove) : [],
      networkConnectArgs: [],
      proxyRunArgs: mode === "internal" ? proxyRun : withoutNetwork(proxyRun),
      proxyStopArgs: rewrite(plan.proxyStop),
      proxyName: proxy,
      proxyBundle: plan.proxyBundle,
    },
  };
}

/** Inspect the named attachment, never whichever interface happens to be first. */
export function appleProxyAddress(
  text: string,
  network: string,
): { address: string; gateway: string } {
  const parsed = JSON.parse(text);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const attachments = entries[0]?.status?.networks;
  if (!Array.isArray(attachments)) {
    throw new Error("Apple inspect omitted network attachments");
  }
  const found = attachments.find((value: { network?: string }) =>
    value.network === network
  );
  const address = typeof found?.ipv4Address === "string"
    ? found.ipv4Address.split("/")[0]
    : "";
  const gateway = typeof found?.ipv4Gateway === "string"
    ? found.ipv4Gateway
    : "";
  if (
    ![address, gateway].every((value) =>
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
    )
  ) {
    throw new Error(
      `Apple inspect omitted IPv4 address/gateway for ${network}`,
    );
  }
  return { address, gateway };
}

/** Replace only environment values in the generated run command. */
export function appleWorkerArgs(
  args: readonly string[],
  env: Record<string, string>,
): string[] {
  const result = [...args];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z_a-z][A-Z_a-z0-9]*$/.test(key) || value.includes("\0")) {
      throw new Error("Invalid Apple startup environment");
    }
    const index = result.findIndex((arg, i) =>
      result[i - 1] === "--env" && arg.startsWith(`${key}=`)
    );
    if (index >= 0) result[index] = `${key}=${value}`;
    else result.splice(1, 0, "--env", `${key}=${value}`);
  }
  return result;
}

export interface AppleOwnership {
  owner: number;
  manager: number;
  network: string;
  proxy: string;
  createdNetwork: boolean;
  createdProxy: boolean;
}

/** A dead launcher AND dead supervisor, with exact journal/name ownership. */
export function staleAppleOwnership(
  text: string,
  filename: string,
  alive: (pid: number) => boolean,
): AppleOwnership | undefined {
  const value = JSON.parse(text) as AppleOwnership;
  const match = /^vibe-egress-owned-([1-9]\d*)-([a-f0-9]{24})$/.exec(
    value.network,
  );
  if (
    !match || filename !== `${value.network}.json` ||
    value.proxy !== `${value.network}-proxy` ||
    value.owner !== Number(match[1]) || !Number.isSafeInteger(value.manager) ||
    value.manager <= 0 || typeof value.createdNetwork !== "boolean" ||
    typeof value.createdProxy !== "boolean" || alive(value.owner) ||
    alive(value.manager)
  ) return undefined;
  return value;
}

/** Retry failed setup only, preserving the selected mode across every attempt. */
export async function retryAppleEgress<T>(
  attempt: (number: number) => Promise<T>,
  options: {
    cancelled: () => boolean;
    failed: (number: number, error: unknown) => void;
    pause: () => Promise<void>;
  },
): Promise<T> {
  for (let number = 1; number <= 3; number++) {
    try {
      return await attempt(number);
    } catch (error) {
      options.failed(number, error);
      if (number === 3 || options.cancelled()) throw error;
      await options.pause();
    }
  }
  throw new Error("Apple egress setup was not attempted");
}
