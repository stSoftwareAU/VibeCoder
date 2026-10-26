/** Measured Apple controls: a failed dial alone is never firewall evidence. */
import {
  directTcpFailure,
  type EgressProbeResults,
  probeDirectTcp,
  probeProxyConnect,
} from "./egress_selfcheck.ts";

export type Reachability = "reachable" | "blocked" | "unknown";
export type AppleEgressMode = "internal" | "advisory";
export interface AppleRawProbes {
  ipv4: string;
  ipv6: string;
  hostname: string;
  host: string;
  dns: string;
}
export interface AppleControls {
  proxyAllowlist: "enforced" | "failed" | "unknown";
  directInternetV4: Reachability;
  directInternetV6: Reachability;
  directHostname: Reachability;
  hostLan: Reachability;
  dns: "reachable" | "unknown";
}

/** Only a matching, reachable negative control makes a refusal evidence. */
export function compareReachability(
  observed?: string,
  control?: string,
): Reachability {
  if (observed === "connected") return "reachable";
  if (observed === "refused" && control === "connected") return "blocked";
  return "unknown";
}

export function appleControls(
  probes: EgressProbeResults,
  observed: Partial<AppleRawProbes>,
  control: Partial<AppleRawProbes>,
): AppleControls {
  return {
    proxyAllowlist:
      probes.proxyDenied === "denied" && probes.proxyAllowed === "succeeded"
        ? "enforced"
        : probes.proxyDenied === "not_checked" ||
            probes.proxyAllowed === "not_checked"
        ? "unknown"
        : "failed",
    directInternetV4: compareReachability(observed.ipv4, control.ipv4),
    directInternetV6: compareReachability(observed.ipv6, control.ipv6),
    directHostname: compareReachability(observed.hostname, control.hostname),
    hostLan: compareReachability(observed.host, control.host),
    dns: observed.dns === "connected" ? "reachable" : "unknown",
  };
}

/** Host and DNS gaps are accepted; a configured proxy is never optional. */
export function appleControlFailures(
  mode: AppleEgressMode,
  controls: AppleControls,
): string[] {
  const failures: string[] = [];
  if (controls.proxyAllowlist !== "enforced") {
    failures.push(`proxyAllowlist=${controls.proxyAllowlist}`);
  }
  if (mode === "internal") {
    if (controls.directInternetV4 !== "blocked") {
      failures.push(`directInternetV4=${controls.directInternetV4}`);
    }
    if (controls.directInternetV6 === "reachable") {
      failures.push("directInternetV6=reachable");
    }
    if (controls.directHostname === "reachable") {
      failures.push("directHostname=reachable");
    }
  }
  return failures;
}

/** Bounded DNS/host probes distinguish unavailable services from isolation. */
export async function appleRawProbes(
  env: (name: string) => string | undefined,
  timeoutMs = 2000,
): Promise<AppleRawProbes> {
  const direct = async (host: string) => {
    if (!host.includes(":") && !/^\d+\./.test(host)) {
      try {
        await Deno.resolveDns(host, "A", {
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return "not_checked";
      }
    }
    return await probeDirectTcp(host, 443, timeoutMs);
  };
  const hostTargets = (env("VIBE_EGRESS_HOST_TARGETS") ?? "").split(",").filter(
    Boolean,
  );
  const token = env("VIBE_EGRESS_HOST_BANNER");
  const hostProbe = async (target: string): Promise<string> => {
    if (!token || !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(target)) {
      return "not_checked";
    }
    const [hostname, port] = target.split(":");
    let conn: Deno.Conn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      conn = await Deno.connect({
        hostname,
        port: Number(port),
        signal: AbortSignal.timeout(timeoutMs),
      });
      timer = setTimeout(() => conn?.close(), timeoutMs);
      const buf = new Uint8Array(128);
      const n = await conn.read(buf);
      return new TextDecoder().decode(buf.subarray(0, n ?? 0)) === token
        ? "connected"
        : "not_checked";
    } catch (error) {
      return directTcpFailure(error);
    } finally {
      clearTimeout(timer);
      try {
        conn?.close();
      } catch { /* Already closed by the deadline. */ }
    }
  };
  const dns = Deno.resolveDns("api.github.com", "A", {
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then(
      (answers) => answers.length ? "connected" : "not_checked",
      () => "not_checked",
    );
  const [ipv4, ipv6, hostname, hostResults, dnsResult] = await Promise.all([
    direct("1.1.1.1"),
    direct("2606:4700:4700::1111"),
    direct("api.github.com"),
    Promise.all(hostTargets.map(hostProbe)),
    dns,
  ]);
  return {
    ipv4,
    ipv6,
    hostname,
    host: hostResults.includes("connected")
      ? "connected"
      : hostResults.length &&
          hostResults.every((result) => result === "refused")
      ? "refused"
      : "not_checked",
    dns: dnsResult,
  };
}

/** Every enabled provider and registry uses the same real CONNECT path. */
export async function appleAllowedPaths(
  env: (name: string) => string | undefined,
  timeoutMs = 2000,
): Promise<Record<string, string>> {
  const proxy = env("HTTPS_PROXY") ?? "";
  const hosts = (env("VIBE_EGRESS_ALLOW_HOSTS") ?? "").split(",").filter(
    Boolean,
  );
  const measured = await Promise.all(
    hosts.map(async (host) =>
      [host, await probeProxyConnect(proxy, host, timeoutMs)] as const
    ),
  );
  return Object.fromEntries(measured);
}
