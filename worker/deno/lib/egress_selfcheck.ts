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
  /**
   * What each CONNECT probe saw, as a short token such as `refused`,
   * `timeout` or `HTTP/1.1 502 Bad Gateway ×3`. Read by
   * {@link describeProbeFailures} to name the cause on the failure marker.
   * Absent for injected probes, which leaves the marker unchanged.
   */
  observed?: { proxyDenied?: string; proxyAllowed?: string };
  /**
   * Per-attempt and listener-wait lines. Read by `run_worker` (written to the
   * launch log) and by the `egress-selfcheck` command (printed on stderr).
   * They never change the verdict.
   */
  diagnostics?: string[];
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
  /**
   * Probe diagnostics (per-attempt lines, listener wait). Written to the launch
   * log before the failure exit, and printed by the `egress-selfcheck` command.
   */
  diagnostics?: string[];
}

/**
 * The cause tokens for the failure marker. A CONNECT probe that did not pass
 * and has `observed` detail adds `proxyDenied=<value> (<observed>)` or
 * `proxyAllowed=<value> (<observed>)`. A probe without detail adds nothing, so
 * its marker is unchanged.
 *
 * @param probes - The probe results, with optional `observed` detail
 * @returns The entries in order, possibly empty
 */
export function describeProbeFailures(probes: EgressProbeResults): string[] {
  const details: string[] = [];
  const denied = probes.observed?.proxyDenied;
  if (probes.proxyDenied !== "denied" && denied) {
    details.push(`proxyDenied=${probes.proxyDenied} (${denied})`);
  }
  const allowed = probes.observed?.proxyAllowed;
  if (probes.proxyAllowed !== "succeeded" && allowed) {
    details.push(`proxyAllowed=${probes.proxyAllowed} (${allowed})`);
  }
  return details;
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
  const details = input.probes ? describeProbeFailures(input.probes) : [];
  const diagnostics = input.probes?.diagnostics;
  return {
    verdict,
    passed,
    exitCode: passed ? 0 : EGRESS_SELFCHECK_EXIT_STATUS,
    ...(passed ? {} : {
      marker: [`${EGRESS_SELFCHECK_FAILURE_MARKER} ${verdict}`, ...details]
        .join(" "),
    }),
    ...(diagnostics && diagnostics.length > 0 ? { diagnostics } : {}),
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

/** What one CONNECT probe concluded, and a short token of what it saw. */
export interface ConnectOutcome {
  result: ConnectRaw;
  /**
   * `connected`, `denied`, `refused`, `timeout`, `closed without an answer`,
   * `error: <message>`, `not checked`, or the first line of an unexpected answer.
   */
  observed: string;
}

export type ConnectRaw =
  | "denied"
  | "succeeded"
  | "through"
  | "failed"
  | "not_checked";

/** Longest `observed` token kept; a longer answer is cut to this. */
const OBSERVED_MAX_CHARS = 80;

/** The first line of an answer, control characters stripped, capped at 80 characters. */
function observedToken(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const printable = firstLine.replace(/\p{Cc}/gu, "").trim();
  return Array.from(printable).slice(0, OBSERVED_MAX_CHARS).join("");
}

/** True when the error carries this `name` (DOM and Deno errors both do). */
function errorNamed(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { name?: unknown }).name === name;
}

/** Host and usable port of a proxy URL, or undefined when it is unusable. */
function proxyEndpoint(
  proxyUrl: string,
): { hostname: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return undefined;
  }
  const port = url.port === ""
    ? (url.protocol === "https:" ? 443 : 80)
    : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { hostname: url.hostname, port };
}

/**
 * Send one CONNECT and classify the answer, keeping a short note of what was
 * seen for the log and the failure marker.
 *
 * @param proxyUrl - The proxy URL from the environment
 * @param host - The host to CONNECT to
 * @param timeoutMs - Budget for the dial and for the answer
 * @returns The classified result and its `observed` token
 */
export async function probeProxyConnectDetailed(
  proxyUrl: string,
  host: string,
  timeoutMs: number,
): Promise<ConnectOutcome> {
  const endpoint = proxyEndpoint(proxyUrl);
  if (endpoint === undefined) {
    return { result: "not_checked", observed: "not checked" };
  }
  let conn: Deno.Conn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    conn = await Deno.connect({
      hostname: endpoint.hostname,
      port: endpoint.port,
      signal: AbortSignal.timeout(timeoutMs),
    });
    timer = setTimeout(() => {
      timedOut = true;
      conn?.close();
    }, timeoutMs);
    const request =
      `CONNECT ${host}:${PROBE_PORT} HTTP/1.1\r\nHost: ${host}:${PROBE_PORT}\r\n\r\n`;
    await conn.write(new TextEncoder().encode(request));
    const buf = new Uint8Array(2048);
    const n = await conn.read(buf);
    const text = new TextDecoder().decode(buf.subarray(0, Math.max(0, n ?? 0)));
    if (text.includes("403") && text.includes(EGRESS_DENIED_MARKER)) {
      return { result: "denied", observed: "denied" };
    }
    if (/^HTTP\/1\.[01] 200\b/.test(text)) {
      return { result: "succeeded", observed: "connected" };
    }
    if (text.trim() === "") {
      return {
        result: "failed",
        observed: timedOut ? "timeout" : "closed without an answer",
      };
    }
    return { result: "through", observed: observedToken(text) };
  } catch (error) {
    if (isUnchecked(error)) {
      return { result: "not_checked", observed: "not checked" };
    }
    if (error instanceof Deno.errors.ConnectionRefused) {
      return { result: "failed", observed: "refused" };
    }
    if (timedOut || errorNamed(error, "TimeoutError")) {
      return { result: "failed", observed: "timeout" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { result: "failed", observed: `error: ${observedToken(message)}` };
  } finally {
    clearTimeout(timer);
    try {
      conn?.close();
    } catch {
      // Already closed.
    }
  }
}

/** Send one CONNECT and classify the status line. Wraps {@link probeProxyConnectDetailed}. */
export async function probeProxyConnect(
  proxyUrl: string,
  host: string,
  timeoutMs: number,
): Promise<ConnectRaw> {
  return (await probeProxyConnectDetailed(proxyUrl, host, timeoutMs)).result;
}

/** Budget for the proxy to start listening (Issue #4493). */
export const EGRESS_PROXY_LISTEN_TIMEOUT_MS = 30_000;

/** Pause between listener checks. */
const EGRESS_PROXY_LISTEN_INTERVAL_MS = 250;

/** Budget for one plain TCP dial while waiting for the listener. */
const LISTENER_DIAL_TIMEOUT_MS = 1_000;

/** Outcome of {@link waitForProxyListener}. */
export type ProxyListenerWait =
  | { listening: true }
  | { listening: false; observed: string };

/** Default pause: a real timer. Tests inject their own. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the proxy accepts TCP connections (Issue #4493).
 *
 * The proxy logs `[EGRESS_PROXY] listening on <addr>` (see
 * EGRESS_PROXY_LISTENING_MARKER in `lib/egress_proxy.ts`) once it is bound, and
 * on Apple container it binds seconds after the worker starts. Each check is a
 * plain TCP dial that closes at once and sends no bytes, so the proxy logs
 * nothing for it. Only a refused dial or a timeout is retried, until the
 * deadline. A permission error, a non-local failure, or an unusable proxy URL
 * returns `listening: true`, so the CONNECT probe reports it as `not_checked`.
 *
 * @param proxyUrl - The proxy URL from the environment
 * @param options - Budget, interval, and the sleep and clock seams (tests)
 * @returns `listening: true`, or `listening: false` with what the last dial saw
 */
export async function waitForProxyListener(
  proxyUrl: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<ProxyListenerWait> {
  const endpoint = proxyEndpoint(proxyUrl);
  if (endpoint === undefined) return { listening: true };
  const timeoutMs = options.timeoutMs ?? EGRESS_PROXY_LISTEN_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? EGRESS_PROXY_LISTEN_INTERVAL_MS;
  const sleep = options.sleep ?? pause;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  let observed = "refused";
  for (;;) {
    let conn: Deno.Conn | undefined;
    try {
      conn = await Deno.connect({
        hostname: endpoint.hostname,
        port: endpoint.port,
        signal: AbortSignal.timeout(LISTENER_DIAL_TIMEOUT_MS),
      });
      return { listening: true };
    } catch (error) {
      if (isUnchecked(error)) return { listening: true };
      if (error instanceof Deno.errors.ConnectionRefused) {
        observed = "refused";
      } else if (errorNamed(error, "TimeoutError")) {
        observed = "timeout";
      } else {
        return { listening: true };
      }
    } finally {
      try {
        conn?.close();
      } catch {
        // Already closed.
      }
    }
    if (now() >= deadline) return { listening: false, observed };
    await sleep(intervalMs);
  }
}

/** Attempts the allowlisted CONNECT gets before the self-check concludes. */
export const EGRESS_ALLOWED_PROBE_ATTEMPTS = 3;

/**
 * Budget for one allowlisted CONNECT. Unlike the denied probe, the proxy has
 * to resolve and dial the upstream host before it answers, and on the Apple
 * runtime it does so from a container started seconds earlier.
 */
export const EGRESS_ALLOWED_PROBE_TIMEOUT_MS = 5_000;

/** Pause between allowlisted CONNECT attempts. */
const EGRESS_ALLOWED_PROBE_DELAY_MS = 1_000;

/** The `observed` text for a proxy that never started listening (Issue #4493). */
function noListenerObserved(listenMs: number, observed: string): string {
  return `no listener after ${listenMs}ms (${observed})`;
}

/** The log line for a proxy that never started listening (Issue #4493). */
function noListenerLogLine(
  host: string,
  listenMs: number,
  observed: string,
): string {
  return `[egress-selfcheck] proxy for ${host} is not accepting connections after ${listenMs}ms (${observed})`;
}

/** `refused ×3, timeout ×1`: counts in first-seen order. */
function summariseObserved(counts: Map<string, number>): string {
  return [...counts].map(([token, count]) => `${token} ×${count}`).join(", ");
}

/**
 * Probe an allowlisted CONNECT, retrying a slow or silent answer.
 *
 * One cold upstream dial that missed its budget used to fail the self-check
 * and cost the whole launch (`proxyAllowlist=failed`, worker claimed
 * nothing). A refusal is final at once: the proxy said no, and asking again
 * will not change its allowlist. Every attempt that did not succeed is logged
 * with what it saw, and the failed result's `observed` counts those answers.
 *
 * Unless `waitForListener` is false, the probe first waits for the proxy to
 * accept connections (see {@link waitForProxyListener}). A proxy that never
 * starts ends the probe with no attempts spent and an `observed` that says
 * `no listener`.
 *
 * @param proxyUrl - The proxy URL from the environment
 * @param host - An allowlisted host
 * @param options - Attempts, per-attempt budget, pause, log sink, and listener
 *   wait (budget, sleep, clock, on/off); the sleep and clock are for tests
 * @returns `succeeded`, `denied` or `not_checked` as soon as one attempt gives
 *   it; otherwise `failed` with the counts of what the attempts saw
 */
export async function probeProxyAllowedDetailed(
  proxyUrl: string,
  host: string,
  options: {
    attempts?: number;
    timeoutMs?: number;
    delayMs?: number;
    log?: (line: string) => void;
    listenTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    waitForListener?: boolean;
  } = {},
): Promise<ConnectOutcome> {
  const attempts = options.attempts ?? EGRESS_ALLOWED_PROBE_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? EGRESS_ALLOWED_PROBE_TIMEOUT_MS;
  const delayMs = options.delayMs ?? EGRESS_ALLOWED_PROBE_DELAY_MS;
  const listenMs = options.listenTimeoutMs ?? EGRESS_PROXY_LISTEN_TIMEOUT_MS;
  const sleep = options.sleep ?? pause;
  const log = options.log ?? ((line: string) => console.warn(line));
  if (options.waitForListener ?? true) {
    const listener = await waitForProxyListener(proxyUrl, {
      timeoutMs: listenMs,
      sleep,
      now: options.now,
    });
    if (!listener.listening) {
      log(noListenerLogLine(host, listenMs, listener.observed));
      return {
        result: "failed",
        observed: noListenerObserved(listenMs, listener.observed),
      };
    }
  }
  const counts = new Map<string, number>();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = await probeProxyConnectDetailed(proxyUrl, host, timeoutMs);
    if (
      outcome.result === "succeeded" || outcome.result === "not_checked" ||
      outcome.result === "denied"
    ) {
      return outcome;
    }
    counts.set(outcome.observed, (counts.get(outcome.observed) ?? 0) + 1);
    log(
      `[egress-selfcheck] allowlisted CONNECT to ${host} ${outcome.observed} (attempt ${attempt} of ${attempts})`,
    );
    if (attempt < attempts && delayMs > 0) await sleep(delayMs);
  }
  return { result: "failed", observed: summariseObserved(counts) };
}

/**
 * {@link probeProxyAllowedDetailed} without the listener wait and without the
 * detail: the attempts, the budget and the result only. The result is
 * `failed` when no attempt connected, whatever the proxy answered.
 *
 * @param proxyUrl - The proxy URL from the environment
 * @param host - An allowlisted host
 * @param options - Attempts, per-attempt budget, pause and log sink (tests)
 * @returns The probe's result
 */
export async function probeProxyAllowed(
  proxyUrl: string,
  host: string,
  options: {
    attempts?: number;
    timeoutMs?: number;
    delayMs?: number;
    log?: (line: string) => void;
  } = {},
): Promise<ConnectRaw> {
  const outcome = await probeProxyAllowedDetailed(proxyUrl, host, {
    ...options,
    waitForListener: false,
  });
  return outcome.result;
}

function proxyUrlFrom(
  env: (name: string) => string | undefined,
): string | undefined {
  const raw = env("HTTPS_PROXY") ?? env("https_proxy") ?? env("HTTP_PROXY") ??
    env("http_proxy");
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Run the four probes. A missing proxy URL makes the CONNECT probes
 * `not_checked`.
 *
 * The proxy's listener is awaited once, after the direct dials and before the
 * CONNECT probes (Issue #4493). A proxy that never starts gives `proxyAllowed:
 * failed` with `observed.proxyAllowed` saying `no listener`, and spends no
 * attempts. The probe detail goes to `observed`, and the attempt lines to
 * `diagnostics`.
 *
 * @param env - Environment lookup (`HTTPS_PROXY` and friends)
 * @param timeoutMs - Budget for the direct dials and the denied CONNECT
 * @param options - Seams: direct dial, sleep and clock, listener budget (tests)
 * @returns The four results, with `observed` and `diagnostics` when present
 */
export async function runEgressProbes(
  env: (name: string) => string | undefined,
  timeoutMs?: number,
  options: {
    directTcp?: typeof probeDirectTcp;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    listenTimeoutMs?: number;
  } = {},
): Promise<EgressProbeResults> {
  const allowedTimeoutMs = timeoutMs ?? EGRESS_ALLOWED_PROBE_TIMEOUT_MS;
  timeoutMs ??= EGRESS_PROBE_TIMEOUT_MS;
  const directTcp = options.directTcp ?? probeDirectTcp;
  const [directCloudflare, directGithub] = await Promise.all([
    directTcp(DIRECT_CLOUDFLARE, PROBE_PORT, timeoutMs),
    directTcp(DIRECT_GITHUB, PROBE_PORT, timeoutMs),
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
  const diagnostics: string[] = [];
  const listenMs = options.listenTimeoutMs ?? EGRESS_PROXY_LISTEN_TIMEOUT_MS;
  const listener = await waitForProxyListener(proxy, {
    timeoutMs: listenMs,
    sleep: options.sleep,
    now: options.now,
  });
  if (!listener.listening) {
    diagnostics.push(
      noListenerLogLine(ALLOWED_HOST, listenMs, listener.observed),
    );
    return {
      directCloudflare,
      directGithub,
      proxyDenied: "not_checked",
      proxyAllowed: "failed",
      observed: {
        proxyAllowed: noListenerObserved(listenMs, listener.observed),
      },
      diagnostics,
    };
  }
  const denied = await probeProxyConnectDetailed(proxy, DENIED_HOST, timeoutMs);
  const allowed = await probeProxyAllowedDetailed(proxy, ALLOWED_HOST, {
    timeoutMs: allowedTimeoutMs,
    sleep: options.sleep,
    waitForListener: false,
    log: (line) => diagnostics.push(line),
  });
  const proxyDenied: ConnectDenyResult = denied.result === "denied"
    ? "denied"
    : denied.result === "succeeded" || denied.result === "through"
    ? "through"
    : "not_checked";
  const proxyAllowed: ConnectAllowResult = allowed.result === "succeeded"
    ? "succeeded"
    : allowed.result === "not_checked"
    ? "not_checked"
    : "failed";
  return {
    directCloudflare,
    directGithub,
    proxyDenied,
    proxyAllowed,
    observed: { proxyDenied: denied.observed, proxyAllowed: allowed.observed },
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
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
    // Unset unless a test pins it: the allowlisted CONNECT gets its own,
    // longer budget than the other probes.
    probes = input.probe
      ? await input.probe()
      : await runEgressProbes(input.env, input.timeoutMs);
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
    const details = describeProbeFailures(probes);
    return {
      ...decision,
      requireRecord: true,
      exitCode: failures.length ? EGRESS_SELFCHECK_EXIT_STATUS : 0,
      ...(failures.length
        ? {
          marker: [
            `${EGRESS_SELFCHECK_FAILURE_MARKER} ${failures.join(" ")}`,
            ...details,
          ].join(" "),
        }
        : {}),
      ...(probes.diagnostics && probes.diagnostics.length > 0
        ? { diagnostics: probes.diagnostics }
        : {}),
      warning:
        `${EGRESS_NOT_ENFORCED_MARKER} Apple ${appleMode}: host/LAN and DNS remain measured gaps; untested controls are unknown`,
      record: `${decision.record} controls=${JSON.stringify(report)}`,
    };
  }
  return decideEgressPolicy({ flag, dialect, version, date, probes });
}
