/**
 * Can a container on this host reach the network at all? (Issue #997)
 *
 * ## What went wrong
 *
 * GRQ-23 stalled for hours reporting the wrong cause (#991). The operator saw:
 *
 * ```text
 * #9 134.8 curl: (28) Failed to connect to github.com port 443 after 134719 ms
 * Error: failed to build vibe-coder:8bbfff3c47f5
 * Failure phase: image_build (container image build)
 * ```
 *
 * Every part of that was misleading. The image was fine and the network was
 * fine — the *host* reached `github.com` in 0.1 s throughout. What was broken
 * was egress from inside a container: a reject route on the container bridge
 * (`default link#22 UCSIg bridge100 !`) while a Tailscale `utun` interface held
 * a default route on the same host. Runs hours earlier had reached the
 * container and died at `GITHUB-USER-FAILED`, so the worker was running and
 * blind.
 *
 * ## The rule
 *
 * One reachability probe from inside a container, before the build, against a
 * literal external address:
 *
 * | container | host | verdict | what it means |
 * |---|---|---|---|
 * | reachable | – | `reachable` | carry on |
 * | blocked | reachable | `egress_blocked` | this host cannot route out of a container — a human, once |
 * | blocked | blocked | `network_down` | the network is down — wait |
 * | not run | – | `inconclusive` | never block a launch on a probe that could not run |
 *
 * The host hop is the discriminator. Without it "container cannot reach
 * `1.1.1.1`" is indistinguishable from "the link is down", and those need
 * opposite actions: one needs a person, the other needs patience.
 *
 * **DNS is not the probe.** `192.168.64.1` is the host itself, so name
 * resolution succeeds while every packet past the gateway is dropped — a probe
 * that only resolves a name reports healthy. {@link parseEgressTarget}
 * therefore refuses anything but an IP literal.
 *
 * Driving a container runtime is exactly what a unit test must not really do,
 * so every invocation is a seam on {@link EgressProbeDeps};
 * {@link createEgressProbeDeps} supplies the production implementation.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";
import type { RuntimeInvocation } from "./container_image_prune.ts";

/**
 * The address every hop is measured against.
 *
 * A literal IP on a port that is open across the public internet, so the probe
 * proves packets leave the host rather than that a resolver answered.
 */
export const EGRESS_PROBE_TARGET_DEFAULT = "1.1.1.1:443";

/** Bound on one hop — a dropped packet must cost seconds, not minutes. */
export const EGRESS_PROBE_TIMEOUT_MS = 8_000;

/**
 * Exit status a launcher reports when it parks a host whose containers cannot
 * reach the network.
 *
 * Deliberately outside the runtime CLI's own 125/126/127 range and distinct
 * from the wedged-container status (87), so the supervisor and the escalation
 * can both name the reason rather than reporting a bare failure. Kept in step
 * with `run.sh` and `run.ps1` by the launcher tests.
 */
export const HOST_EGRESS_BLOCKED_EXIT_STATUS = 88;

/**
 * The named reason a parked host reports as unavailable fleet capacity.
 *
 * One vocabulary word, used by the escalation, the self-heal event and the
 * host log alike, so "why is that host claiming nothing?" has one answer.
 */
export const HOST_EGRESS_BLOCKED_REASON = "container_egress_blocked";

/** Bound on the whole container hop, including the runtime's own startup. */
export const EGRESS_CONTAINER_TIMEOUT_MS = 60_000;

/** Where a hop was measured from. */
export type EgressHopSource = "container" | "host";

/** What one hop reported. */
export type EgressHopResult = "ok" | "fail" | "not-run";

/** One measured hop, and the words behind the result. */
export interface EgressHop {
  /** Where the packet was sent from. */
  from: EgressHopSource;
  /** What it was sent to, e.g. `1.1.1.1:443`. */
  target: string;
  /** Whether it arrived. */
  result: EgressHopResult;
  /** The runtime's or the socket's own explanation, when there is one. */
  detail?: string;
}

/** Host routing state that explains a blocked container (Issue #997). */
export interface RoutingEvidence {
  /** Which command produced the table (empty when none could be read). */
  source: string;
  /** Routes that discard rather than forward — the likely cause. */
  rejectRoutes: string[];
  /** Tunnel interfaces holding a default route — the likely reason for them. */
  tunnelDefaultRoutes: string[];
}

/** Everything one probe measured. */
export interface EgressProbeReading {
  /** The address every hop was measured against. */
  target: string;
  /** The image the container hop ran, when one was available. */
  image?: string;
  /** Container → target. */
  container: EgressHop;
  /** Host → target, measured only when the container hop failed. */
  host: EgressHop;
  /** Host routing state, gathered only when the container hop failed. */
  routes: RoutingEvidence;
}

/** What the reading means. */
export type EgressVerdict =
  | "reachable"
  | "egress_blocked"
  | "network_down"
  | "inconclusive";

/** A finished probe. */
export interface EgressProbeResult {
  verdict: EgressVerdict;
  reading: EgressProbeReading;
  /** The hop table and routing evidence, ready to be quoted in an alert. */
  evidence: string;
}

/** A validated probe target. */
export interface EgressTarget {
  host: string;
  port: number;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Is this an IP literal — the only thing a probe may aim at? */
export function isIpLiteral(host: string): boolean {
  const v4 = IPV4.exec(host);
  if (v4) {
    return v4.slice(1).every((octet) => {
      const value = Number(octet);
      return value >= 0 && value <= 255 &&
        String(value) === String(Number(octet));
    });
  }
  // IPv6: hex groups and colons only, at least one colon. Deliberately loose —
  // `Deno.connect` is the real validator; this only has to exclude names.
  return /^[0-9a-fA-F:]+$/.test(host) && host.includes(":");
}

/**
 * Parse and validate `host:port`.
 *
 * A hostname is refused outright: `192.168.64.1` is the host itself, so DNS
 * answers while every packet past the gateway is dropped, and a probe that
 * resolved a name would report a blocked host as healthy (Issue #997).
 *
 * @param text - The configured target, e.g. `1.1.1.1:443`
 * @returns The validated host and port
 * @throws When the target is malformed or names a host rather than an address
 */
export function parseEgressTarget(text: string): EgressTarget {
  const trimmed = (text ?? "").trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(
      `egress probe target must be <ip>:<port>, got "${trimmed}"`,
    );
  }
  // `[2606:4700::1111]:443` and the bare IPv6 form both reduce to this.
  const host = trimmed.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = Number(trimmed.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`egress probe port must be 1-65535, got "${trimmed}"`);
  }
  if (!isIpLiteral(host)) {
    throw new Error(
      `egress probe target must be an IP literal, not a name ("${host}") — ` +
        "a resolver on the host bridge answers while every packet past the " +
        "gateway is dropped (Issue #997)",
    );
  }
  return { host, port };
}

/** Render a validated target back to `host:port`. */
export function formatEgressTarget(target: EgressTarget): string {
  return target.host.includes(":")
    ? `[${target.host}]:${target.port}`
    : `${target.host}:${target.port}`;
}

/**
 * The runtime argv for the container hop.
 *
 * Bash's `/dev/tcp` rather than `curl`: it is a shell builtin, so the probe
 * needs nothing installed in the image and cannot be defeated by a proxy
 * variable. The target is an IP literal validated above, so nothing
 * caller-controlled reaches the shell unchecked.
 *
 * @param image - Image to run the probe in
 * @param target - Validated target
 * @param name - Container name, so a leaked probe container is identifiable
 */
export function containerProbeArgs(
  image: string,
  target: EgressTarget,
  name: string,
): string[] {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--entrypoint",
    "/bin/bash",
    image,
    "-c",
    `exec 3<>/dev/tcp/${target.host}/${target.port}`,
  ];
}

/**
 * The base image a Containerfile builds on.
 *
 * The derived image is absent exactly when a build is due, which is when the
 * probe matters most — so the probe falls back to the base image, which is
 * already in the local store on any host that has ever built.
 *
 * @param text - Containerfile source
 * @returns The base image reference, or null when it cannot be read
 */
export function baseImageFromContainerfile(text: string): string | null {
  const arg = /^\s*ARG\s+BASE_IMAGE\s*=\s*"?([^"\s]+)"?/m.exec(text);
  if (arg) return arg[1]!;
  // A Containerfile with a literal FROM and no ARG: take the last stage's
  // base, which is the one the worker image is built on.
  const froms = [...text.matchAll(/^\s*FROM\s+(\S+)/gm)]
    .map((match) => match[1]!)
    .filter((reference) => !reference.includes("${"));
  return froms.length > 0 ? froms[froms.length - 1]! : null;
}

/** Interface prefixes that mean "a tunnel", not the host's real uplink. */
const TUNNEL_INTERFACES =
  /^(utun|tun|tap|wg|ppp|ipsec|tailscale|zt|nebula|gpd)/i;

/**
 * Pull the routes that explain a blocked container out of a routing table.
 *
 * Handles both dialects the fleet runs: BSD/macOS `netstat -rn` (a reject
 * route carries `R` in its flags or a trailing `!`) and Linux `ip route`
 * (`unreachable`, `prohibit`, `blackhole`).
 *
 * @param text - The routing table as the host printed it
 * @param source - The command that produced it, for the evidence header
 */
export function parseRoutingEvidence(
  text: string,
  source: string,
): RoutingEvidence {
  const rejectRoutes: string[] = [];
  const tunnelDefaultRoutes: string[] = [];

  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const fields = line.split(/\s+/);

    // Linux: the discard disposition is the first token.
    if (/^(unreachable|prohibit|blackhole)\b/.test(line)) {
      rejectRoutes.push(line);
    } else if (line.startsWith("default") || fields[0] === "0.0.0.0/0") {
      // BSD: `default link#22 UCSIg bridge100 !` — flags in field 3.
      const flags = fields[2] ?? "";
      if (
        line.endsWith("!") || /^[A-Za-z]+$/.test(flags) && flags.includes("R")
      ) {
        rejectRoutes.push(line);
      }
      const iface = fields.find((field) => TUNNEL_INTERFACES.test(field));
      if (iface) tunnelDefaultRoutes.push(line);
    }
  }

  return { source, rejectRoutes, tunnelDefaultRoutes };
}

/** No routing table could be read. */
export function emptyRoutingEvidence(): RoutingEvidence {
  return { source: "", rejectRoutes: [], tunnelDefaultRoutes: [] };
}

/**
 * What a reading means.
 *
 * The host hop is the discriminator: a container that cannot get out while the
 * host can is a host-networking fault a retry will never clear; both blocked is
 * the link, which comes back on its own.
 */
export function classifyEgress(reading: EgressProbeReading): EgressVerdict {
  if (reading.container.result === "ok") return "reachable";
  if (reading.container.result === "not-run") return "inconclusive";
  if (reading.host.result === "ok") return "egress_blocked";
  if (reading.host.result === "fail") return "network_down";
  // The container is blocked and the host was never measured, so there is
  // nothing to attribute the fault to. Saying so beats guessing (Issue #3234).
  return "inconclusive";
}

/** One line naming what a verdict means for the launcher. */
export function describeEgressVerdict(verdict: EgressVerdict): string {
  switch (verdict) {
    case "reachable":
      return "a container on this host reaches the network";
    case "egress_blocked":
      return "this host cannot route out of a container — the host reaches " +
        "the same address, so the image and the network are both fine";
    case "network_down":
      return "the network is unreachable from this host as well as from a " +
        "container — nothing here to fix, wait for the link";
    case "inconclusive":
      return "the egress probe could not be run, so nothing is claimed " +
        "either way";
  }
}

function hopRow(hop: EgressHop): string {
  const result = hop.result === "ok"
    ? "OK"
    : hop.result === "fail"
    ? "FAIL"
    : "not run";
  const detail = hop.detail ? ` — ${hop.detail}` : "";
  return `| ${hop.from} → ${hop.target} | ${result}${detail} |`;
}

/**
 * The hop table and routing evidence, as an alert quotes it.
 *
 * This is what makes the fault diagnosable in a minute rather than an hour:
 * which hop failed, that the host itself is fine, the reject route, and any
 * tunnel interface holding a default route.
 */
export function formatEgressEvidence(
  reading: EgressProbeReading,
  verdict: EgressVerdict,
): string {
  const lines = [
    `Container egress probe: ${verdict} — ${describeEgressVerdict(verdict)}`,
    ...(reading.image ? [`Probe image: ${reading.image}`] : []),
    "",
    "| hop | result |",
    "|---|---|",
    hopRow(reading.container),
    hopRow(reading.host),
  ];

  const { routes } = reading;
  if (routes.source) {
    lines.push("", `Host routing table (${routes.source}):`);
    lines.push(
      routes.rejectRoutes.length > 0
        ? `- reject route(s): ${routes.rejectRoutes.join(" / ")}`
        : "- no reject route found on a default route",
    );
    lines.push(
      routes.tunnelDefaultRoutes.length > 0
        ? `- tunnel interface holding a default route: ` +
          `${routes.tunnelDefaultRoutes.join(" / ")}`
        : "- no tunnel interface holds a default route",
    );
  } else if (verdict !== "reachable") {
    lines.push("", "Host routing table: could not be read on this host.");
  }

  return lines.join("\n");
}

/** Every side effect a probe performs — each one a seam for the tests. */
export interface EgressProbeDeps {
  /** Run the container runtime, bounded and captured. */
  runRuntime: (args: readonly string[]) => Promise<RuntimeInvocation>;
  /** Is this image reference present in the local store? */
  imagePresent: (image: string) => Promise<boolean>;
  /** Connect to the target from the host itself. */
  connectFromHost: (
    target: EgressTarget,
  ) => Promise<{ ok: boolean; detail?: string }>;
  /** The host's routing table, and the command that produced it. */
  readRoutes: () => Promise<{ source: string; text: string }>;
  /** Operator-facing log sink (stderr in production). */
  log: (message: string) => void;
}

/** One probe request. */
export interface EgressProbeOptions {
  /** Validated target every hop is measured against. */
  target: EgressTarget;
  /** Image references to probe with, best first. */
  images: readonly string[];
  /** Name for the throwaway probe container. */
  containerName: string;
}

/**
 * Probe whether a container on this host can reach the network.
 *
 * Fast path first: a container that gets out costs one short run and nothing
 * else — no host connect, no routing table. Only a blocked container pays for
 * the evidence, which is the case where the evidence is worth having.
 *
 * @param deps - Injected runtime, socket, routing and log seams
 * @param options - Target, candidate images and the probe container's name
 * @returns The verdict, the reading behind it, and the evidence to quote
 */
export async function probeContainerEgress(
  deps: EgressProbeDeps,
  options: EgressProbeOptions,
): Promise<EgressProbeResult> {
  const target = formatEgressTarget(options.target);
  const reading: EgressProbeReading = {
    target,
    container: { from: "container", target, result: "not-run" },
    host: { from: "host", target, result: "not-run" },
    routes: emptyRoutingEvidence(),
  };

  let image: string | undefined;
  for (const candidate of options.images) {
    if (!candidate) continue;
    if (await deps.imagePresent(candidate)) {
      image = candidate;
      break;
    }
  }

  if (!image) {
    // Never block a launch on a probe that could not run: an unbuilt host with
    // an empty store is a first launch, not a broken network.
    reading.container.detail =
      "no image in the local store to run the probe in";
    const verdict = classifyEgress(reading);
    return {
      verdict,
      reading,
      evidence: formatEgressEvidence(reading, verdict),
    };
  }

  reading.image = image;
  const run = await deps.runRuntime(
    containerProbeArgs(image, options.target, options.containerName),
  );
  if (run.code === 0) {
    reading.container.result = "ok";
    const verdict = classifyEgress(reading);
    return {
      verdict,
      reading,
      evidence: formatEgressEvidence(reading, verdict),
    };
  }

  reading.container.result = "fail";
  reading.container.detail = firstLine(run.stderr) || firstLine(run.stdout) ||
    `the probe container exited ${run.code}`;

  const host = await deps.connectFromHost(options.target);
  reading.host.result = host.ok ? "ok" : "fail";
  if (host.detail) reading.host.detail = host.detail;

  try {
    const routes = await deps.readRoutes();
    reading.routes = parseRoutingEvidence(routes.text, routes.source);
  } catch (error) {
    // Evidence is a nicety; the verdict is not. A routing table that cannot be
    // read says so in the report rather than losing the whole probe.
    deps.log(
      `[container-egress-probe] could not read the host routing table: ` +
        `${(error as Error).message}`,
    );
  }

  const verdict = classifyEgress(reading);
  return { verdict, reading, evidence: formatEgressEvidence(reading, verdict) };
}

/** Keep a runtime's diagnostic output to one short, single-line reason. */
function firstLine(text: string, limit = 200): string {
  const line = (text ?? "").split("\n").map((part) => part.trim()).find((
    part,
  ) => part !== "");
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** Routing-table commands, tried in order until one answers. */
const ROUTING_COMMANDS: ReadonlyArray<{ command: string; args: string[] }> = [
  { command: "netstat", args: ["-rn"] },
  { command: "ip", args: ["route", "show"] },
];

/**
 * The production seam: real subprocesses and a real socket, both bounded.
 *
 * @param runtime - Runtime executable the launch plan chose
 * @param imageInspectArgs - How this runtime is asked whether an image exists
 * @returns Dependencies for {@link probeContainerEgress}
 */
export function createEgressProbeDeps(
  runtime: string,
  imageInspectArgs: (image: string) => readonly string[],
): EgressProbeDeps {
  const runBounded = async (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<RuntimeInvocation> => {
    const result = await runWithTimeout(command, [...args], { timeoutMs });
    if (!result.ok) {
      return {
        code: -1,
        stdout: "",
        stderr: `${command} could not be run: ${result.error.message}`,
      };
    }
    if (result.value.timedOut) {
      return {
        code: -1,
        stdout: result.value.stdout,
        stderr: `${command} ${args.join(" ")} did not answer within ${
          Math.round(timeoutMs / 1000)
        }s`,
      };
    }
    return {
      code: result.value.code,
      stdout: result.value.stdout,
      stderr: result.value.stderr,
    };
  };

  return {
    log: (message) => console.error(message),
    runRuntime: (args) =>
      runBounded(runtime, args, EGRESS_CONTAINER_TIMEOUT_MS),
    imagePresent: async (image) => {
      const result = await runBounded(
        runtime,
        imageInspectArgs(image),
        EGRESS_PROBE_TIMEOUT_MS,
      );
      return result.code === 0;
    },
    connectFromHost: async (target) => {
      // `Deno.connect` takes no deadline of its own, and a dropped SYN retries
      // for over a minute: the connect is raced against a timer, and a
      // connection that lands late is closed rather than leaked.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EGRESS_PROBE_TIMEOUT_MS);
      });
      const attempt = Deno.connect({
        hostname: target.host,
        port: target.port,
      });
      try {
        const connection = await Promise.race([attempt, expiry]);
        if (connection === null) {
          attempt.then((late) => late.close()).catch(() => {});
          return {
            ok: false,
            detail: `no answer within ${
              Math.round(EGRESS_PROBE_TIMEOUT_MS / 1000)
            }s`,
          };
        }
        connection.close();
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: (error as Error).message };
      } finally {
        clearTimeout(timer);
      }
    },
    readRoutes: async () => {
      for (const candidate of ROUTING_COMMANDS) {
        const result = await runBounded(
          candidate.command,
          candidate.args,
          EGRESS_PROBE_TIMEOUT_MS,
        );
        if (result.code === 0 && result.stdout.trim() !== "") {
          return {
            source: `${candidate.command} ${candidate.args.join(" ")}`,
            text: result.stdout,
          };
        }
      }
      return { source: "", text: "" };
    },
  };
}
