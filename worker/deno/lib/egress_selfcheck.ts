/**
 * Egress self-check (Issue #4048).
 *
 * Every container start proves the network policy before anything is claimed.
 * On a runtime that enforces egress the worker dials four bounded probes and
 * exits {@link EGRESS_SELFCHECK_EXIT_STATUS} unless all four say the policy
 * is holding. On Apple container the check records each observed control and enforces the
 * selected partial/advisory promises (Issue #4051). `not_checked` and
 * `proxy_unavailable` are never a pass.
 *
 * Probe results are injectable so a unit test does not open a socket.
 *
 * Australian English spelling throughout (behaviour).
 */

import {
  appleAllowedPaths,
  appleControlFailures,
  appleControls,
  type AppleRawProbes,
  appleRawProbes,
} from "./apple_egress_controls.ts";

/** The worker exits with this when an enforcing runtime did not prove egress. */
export const EGRESS_SELFCHECK_EXIT_STATUS = 90;

/**
 * Printed on stderr when the check fails. The launchers match this exact
 * string; keep `run.sh` and `run.ps1` in step with it.
 */
export const EGRESS_SELFCHECK_FAILURE_MARKER = "[EGRESS-SELFCHECK-FAILED]";

/** Printed once when the runtime does not enforce egress (Apple container). */
export const EGRESS_NOT_ENFORCED_MARKER = "[EGRESS-NOT-ENFORCED]";

/** Set by the launch plan. `true` or `false`; anything else is a loud failure. */
export const EGRESS_ENFORCED_ENV = "VIBE_EGRESS_ENFORCED";

/** Runtime kind the evidence line names (`docker`, `podman`, `apple-container`). */
export const EGRESS_RUNTIME_KIND_ENV = "VIBE_RUNTIME_KIND";

/** Runtime version token the evidence line names. */
export const EGRESS_RUNTIME_VERSION_ENV = "VIBE_RUNTIME_VERSION";

/** How long one probe may wait before it counts as not having connected. */
export const EGRESS_PROBE_TIMEOUT_MS = 2_000;

/** Body prefix the proxy writes on a refused CONNECT (Issue #4046). */
const EGRESS_DENIED_MARKER = "[EGRESS_DENIED]";

const DIRECT_CLOUDFLARE = "1.1.1.1";
const DIRECT_GITHUB = "api.github.com";
const DENIED_HOST = "example.com";
const ALLOWED_HOST = "api.github.com";
const PROBE_PORT = 443;

/** What a direct TCP dial did. `refused` is the result an enforcing network must produce. */
export type DirectTcpResult = "refused" | "connected" | "not_checked";

/** What the proxy said to a CONNECT for a host that is not allowlisted. */
export type ConnectDenyResult = "denied" | "through" | "not_checked";

/** What the proxy said to a CONNECT for an allowlisted host. */
export type ConnectAllowResult = "succeeded" | "failed" | "not_checked";

/** The four probes, already run. */
export interface EgressProbeResults {
  directCloudflare: DirectTcpResult;
  directGithub: DirectTcpResult;
  proxyDenied: ConnectDenyResult;
  proxyAllowed: ConnectAllowResult;
}

/**
 * `enforced` is the only pass. `not_enforced` is the Apple (and native) record
 * and is never a pass either.
 */
export type EgressVerdict =
  | "enforced"
  | "unenforced"
  | "proxy_unavailable"
  | "not_checked"
  | "not_enforced";

/** True only for a proved enforcing policy. */
export function egressVerdictPassed(verdict: EgressVerdict): boolean {
  return verdict === "enforced";
}

/**
 * Classify probe results.
 *
 * A direct connection or a denied host that got through is `unenforced`, even
 * when another probe could not run. The allowlisted CONNECT failing is
 * `proxy_unavailable`. Anything else that is not the full four-probe success
 * is `not_checked`.
 */
export function classifyEgressProbes(
  results: EgressProbeResults,
): Exclude<EgressVerdict, "not_enforced"> {
  if (
    results.directCloudflare === "connected" ||
    results.directGithub === "connected" ||
    results.proxyDenied === "through"
  ) {
    return "unenforced";
  }
  if (results.proxyAllowed === "failed") return "proxy_unavailable";
  if (
    results.directCloudflare === "refused" &&
    results.directGithub === "refused" &&
    results.proxyDenied === "denied" &&
    results.proxyAllowed === "succeeded"
  ) {
    return "enforced";
  }
  return "not_checked";
}

/** One start's decision: the verdict, the exit, and the durable line. */
export interface EgressPolicyDecision {
  verdict: EgressVerdict;
  passed: boolean;
  exitCode: number;
  /** Present when the launch must stop. Includes the launcher marker. */
  marker?: string;
  /** Present when the dialect does not enforce and the launch continues. */
  warning?: string;
  /** The `run_core.log` line, without the timestamp the log adds. */
  record: string;
  /** Measured Apple controls must be persisted before claims. */
  requireRecord?: boolean;
}

/** Format the durable evidence line. Every field is one token. */
export function formatEgressPolicyRecord(input: {
  verdict: EgressVerdict;
  runtime: string;
  version: string;
  date: string;
}): string {
  const token = (value: string, label: string): string => {
    const trimmed = value.trim();
    if (trimmed === "" || /\s/.test(trimmed) || trimmed.includes("=")) {
      throw new Error(
        `egress policy record: ${label} must be a single token, got ${
          JSON.stringify(value)
        }`,
      );
    }
    return trimmed;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error(
      `egress policy record: date must be an ISO date (YYYY-MM-DD), got ${
        JSON.stringify(input.date)
      }`,
    );
  }
  return `egress policy: ${token(input.verdict, "verdict")} runtime=${
    token(input.runtime, "runtime")
  } version=${token(input.version, "version")} date=${input.date}`;
}

function readFlag(
  env: (name: string) => string | undefined,
): "true" | "false" | "absent" {
  const raw = env(EGRESS_ENFORCED_ENV);
  if (raw === undefined || raw.trim() === "") return "absent";
  const value = raw.trim();
  if (value === "true" || value === "false") return value;
  throw new Error(
    `${EGRESS_ENFORCED_ENV} must be "true" or "false", got ${
      JSON.stringify(raw)
    }`,
  );
}

function identityToken(
  env: (name: string) => string | undefined,
  name: string,
  fallback: string,
): string {
  const raw = env(name)?.trim() ?? "";
  if (raw === "") return fallback;
  const token = raw.replace(/\s+/g, "_");
  if (token.includes("=")) return fallback;
  return token;
}

/**
 * Decide the start-up policy.
 *
 * Legacy `enforced: false` (without an Apple mode) does not run probes:
 * a direct dial from Apple container or a native process would succeed and
 * would be misread as a broken policy. An explicit `false` warns once and
 * names the dialect. Only `enforced` is a pass; every other verdict on an
 * enforcing runtime exits {@link EGRESS_SELFCHECK_EXIT_STATUS}.
 */
export function decideEgressPolicy(input: {
  flag: "true" | "false" | "absent";
  dialect: string;
  version: string;
  date: string;
  probes?: EgressProbeResults;
}): EgressPolicyDecision {
  const runtime = input.dialect.trim() === "" ? "unspecified" : input.dialect;
  if (input.flag !== "true") {
    const verdict: EgressVerdict = "not_enforced";
    return {
      verdict,
      passed: false,
      exitCode: 0,
      ...(input.flag === "false"
        ? { warning: `${EGRESS_NOT_ENFORCED_MARKER} dialect=${runtime}` }
        : {}),
      record: formatEgressPolicyRecord({
        verdict,
        runtime,
        version: input.version,
        date: input.date,
      }),
    };
  }
  const verdict = input.probes
    ? classifyEgressProbes(input.probes)
    : "not_checked";
  const passed = egressVerdictPassed(verdict);
  return {
    verdict,
    passed,
    exitCode: passed ? 0 : EGRESS_SELFCHECK_EXIT_STATUS,
    ...(passed
      ? {}
      : { marker: `${EGRESS_SELFCHECK_FAILURE_MARKER} ${verdict}` }),
    record: formatEgressPolicyRecord({
      verdict,
      runtime,
      version: input.version,
      date: input.date,
    }),
  };
}

function isUnchecked(error: unknown): boolean {
  const errors = Deno.errors as {
    NotCapable?: new (...args: never[]) => Error;
    PermissionDenied?: new (...args: never[]) => Error;
  };
  if (errors.NotCapable && error instanceof errors.NotCapable) return true;
  if (errors.PermissionDenied && error instanceof errors.PermissionDenied) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /requires net access|permission denied/i.test(message);
}

/** Unknown local errors must never become evidence of network isolation. */
export function directTcpFailure(error: unknown): "refused" | "not_checked" {
  if (isUnchecked(error)) return "not_checked";
  const message = error instanceof Error ? error.message : String(error);
  return /connection refused|timed? ?out|unreachable|aborted|network is down|host is down|no route/i
      .test(message)
    ? "refused"
    : "not_checked";
}

/** Dial `host:port`; permission and unrecognised failures are `not_checked`. */
export async function probeDirectTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DirectTcpResult> {
  let conn: Deno.Conn | undefined;
  try {
    conn = await Deno.connect({
      hostname: host,
      port,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return "connected";
  } catch (error) {
    return directTcpFailure(error);
  } finally {
    try {
      conn?.close();
    } catch {
      // The dial already failed.
    }
  }
}

type ConnectRaw = "denied" | "succeeded" | "through" | "failed" | "not_checked";

/** Send one CONNECT and classify the status line. */
export async function probeProxyConnect(
  proxyUrl: string,
  host: string,
  timeoutMs: number,
): Promise<ConnectRaw> {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return "not_checked";
  }
  const port = url.port === ""
    ? (url.protocol === "https:" ? 443 : 80)
    : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "not_checked";
  }
  let conn: Deno.Conn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    conn = await Deno.connect({
      hostname: url.hostname,
      port,
      signal: AbortSignal.timeout(timeoutMs),
    });
    timer = setTimeout(() => conn?.close(), timeoutMs);
    const request =
      `CONNECT ${host}:${PROBE_PORT} HTTP/1.1\r\nHost: ${host}:${PROBE_PORT}\r\n\r\n`;
    await conn.write(new TextEncoder().encode(request));
    const buf = new Uint8Array(2048);
    const n = await conn.read(buf);
    const text = new TextDecoder().decode(buf.subarray(0, Math.max(0, n ?? 0)));
    if (text.includes("403") && text.includes(EGRESS_DENIED_MARKER)) {
      return "denied";
    }
    if (/^HTTP\/1\.[01] 200\b/.test(text)) return "succeeded";
    if (text.trim() === "") return "failed";
    return "through";
  } catch (error) {
    if (isUnchecked(error)) return "not_checked";
    return "failed";
  } finally {
    clearTimeout(timer);
    try {
      conn?.close();
    } catch {
      // Already closed.
    }
  }
}

function proxyUrlFrom(
  env: (name: string) => string | undefined,
): string | undefined {
  const raw = env("HTTPS_PROXY") ?? env("https_proxy") ?? env("HTTP_PROXY") ??
    env("http_proxy");
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/** Run the four probes. A missing proxy URL makes the CONNECT probes `not_checked` / `failed`. */
export async function runEgressProbes(
  env: (name: string) => string | undefined,
  timeoutMs: number = EGRESS_PROBE_TIMEOUT_MS,
): Promise<EgressProbeResults> {
  const [directCloudflare, directGithub] = await Promise.all([
    probeDirectTcp(DIRECT_CLOUDFLARE, PROBE_PORT, timeoutMs),
    probeDirectTcp(DIRECT_GITHUB, PROBE_PORT, timeoutMs),
  ]);
  const proxy = proxyUrlFrom(env);
  if (proxy === undefined) {
    return {
      directCloudflare,
      directGithub,
      proxyDenied: "not_checked",
      proxyAllowed: "not_checked",
    };
  }
  const denied = await probeProxyConnect(proxy, DENIED_HOST, timeoutMs);
  const allowed = await probeProxyConnect(proxy, ALLOWED_HOST, timeoutMs);
  const proxyDenied: ConnectDenyResult = denied === "denied"
    ? "denied"
    : denied === "succeeded" || denied === "through"
    ? "through"
    : "not_checked";
  const proxyAllowed: ConnectAllowResult = allowed === "succeeded"
    ? "succeeded"
    : allowed === "not_checked"
    ? "not_checked"
    : "failed";
  return { directCloudflare, directGithub, proxyDenied, proxyAllowed };
}

export interface CheckEgressPolicyInput {
  env: (name: string) => string | undefined;
  /** Injected results. When set, no socket is opened. */
  probes?: EgressProbeResults;
  /** Injected runner. Used only when `probes` is absent and the flag is true. */
  probe?: () => Promise<EgressProbeResults>;
  /** ISO date `YYYY-MM-DD`. Defaults to today's UTC date. */
  date?: string;
  timeoutMs?: number;
  appleObserved?: Partial<AppleRawProbes>;
  appleControl?: Partial<AppleRawProbes>;
}

/**
 * The start-up check runs for enforcing dialects and explicitly selected Apple
 * modes. Injected probe results keep unit tests off the network.
 */
export async function checkEgressPolicy(
  input: CheckEgressPolicyInput,
): Promise<EgressPolicyDecision> {
  const flag = readFlag(input.env);
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const dialect = identityToken(
    input.env,
    EGRESS_RUNTIME_KIND_ENV,
    "unspecified",
  );
  const version = identityToken(
    input.env,
    EGRESS_RUNTIME_VERSION_ENV,
    "unknown",
  );
  let probes = input.probes;
  const appleMode = input.env("VIBE_APPLE_EGRESS_MODE");
  const apple = dialect === "apple-container" &&
    (appleMode === "internal" || appleMode === "advisory");
  if ((flag === "true" || apple) && probes === undefined) {
    probes = input.probe ? await input.probe() : await runEgressProbes(
      input.env,
      input.timeoutMs ?? EGRESS_PROBE_TIMEOUT_MS,
    );
  }
  if (apple && probes) {
    let control = input.appleControl;
    if (!control) {
      try {
        control = JSON.parse(input.env("VIBE_EGRESS_NEGATIVE_CONTROL") ?? "{}");
      } catch {
        control = {};
      }
    }
    const observed = input.appleObserved ??
      (input.probe || input.probes
        ? {}
        : await appleRawProbes(input.env, input.timeoutMs));
    const controls = appleControls(probes, observed, control ?? {});
    const failures = appleControlFailures(appleMode, controls);
    const paths = input.probe || input.probes
      ? {}
      : await appleAllowedPaths(input.env, input.timeoutMs);
    const report = {
      mode: appleMode,
      runtime: dialect,
      version,
      macOS: input.env("VIBE_EGRESS_MACOS_VERSION") ?? "unknown",
      date,
      controls,
      observed,
      negativeControl: control,
      allowedPaths: paths,
      failures,
    };
    const decision = decideEgressPolicy({
      flag: "false",
      dialect,
      version,
      date,
    });
    return {
      ...decision,
      requireRecord: true,
      exitCode: failures.length ? EGRESS_SELFCHECK_EXIT_STATUS : 0,
      ...(failures.length
        ? { marker: `${EGRESS_SELFCHECK_FAILURE_MARKER} ${failures.join(" ")}` }
        : {}),
      warning:
        `${EGRESS_NOT_ENFORCED_MARKER} Apple ${appleMode}: host/LAN and DNS remain measured gaps; untested controls are unknown`,
      record: `${decision.record} controls=${JSON.stringify(report)}`,
    };
  }
  return decideEgressPolicy({ flag, dialect, version, date, probes });
}
