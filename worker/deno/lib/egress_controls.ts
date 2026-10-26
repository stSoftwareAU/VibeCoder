/**
 * Per-control egress results for the Apple `container` runtime (Issue #4051).
 *
 * The worker runs on a per-launch `container network create --internal`
 * network, with the CONNECT allowlist proxy (Issue #4046) dual-homed on that
 * network and the default network. That is partial containment: the host
 * gateway stays reachable (apple/container#1320), DNS lookups leave the
 * container, and LAN access is not measured. Proxy variables are advisory
 * routing and block nothing on their own.
 *
 * Two short-lived probe containers produce a {@link ProbeRun} each: the
 * internal one measures the controls, and a negative control on the default
 * network proves the probe can see a successful connection at all. This module
 * turns those observations into one result per control rather than a single
 * pass or fail. It is pure: no I/O.
 *
 * Rules that matter here:
 * - `blocked` needs a negative control that proved the probe can connect. A
 *   probe that failed or never ran is never `blocked`.
 * - A refusal from the host is evidence that the host stack replied, not that
 *   a firewall dropped the packet, so it never yields `blocked` for the host.
 * - No mode is described as fully enforced or default-deny.
 *
 * Australian English spelling used throughout (behaviour, tunnelling).
 */

/** Version of the serialised report, bumped when its shape changes. */
export const EGRESS_CONTROLS_SCHEMA = 1;

/** The two launch modes the worker can run in. */
export type EgressMode = "internal-network" | "advisory-proxy";

/** The one-line label for each mode. */
export const EGRESS_MODE_LABELS: Readonly<Record<EgressMode, string>> = {
  "internal-network":
    "internal network + allowlist proxy (partial containment)",
  "advisory-proxy": "advisory proxy only (direct egress NOT blocked)",
};

/** What each mode claims about itself, printed at startup. */
const MODE_SCOPE: Readonly<Record<EgressMode, string>> = {
  "internal-network":
    "partial containment, not default-deny: the host gateway, DNS and LAN sit outside the promise",
  "advisory-proxy":
    "advisory only: proxy variables are routing, not containment",
};

/** How one TCP attempt ended. */
export type TcpOutcome = "ok" | "refused" | "timeout" | "unreachable" | "error";

/** One thing a probe container measured. */
export type ProbeObservation =
  | {
    kind: "net";
    address: string | null;
    gateway: string | null;
    ipv6: boolean;
  }
  | {
    kind: "tcp";
    family: "literal4" | "literal6" | "name4" | "host";
    target: string;
    outcome: TcpOutcome;
  }
  | { kind: "dns"; name: string; ok: boolean }
  | {
    kind: "connect";
    host: string;
    status: number | null;
    reason: string | null;
  }
  | { kind: "tool"; name: string; ok: boolean; detail: string };

/** One probe container run, as the host recorded it. */
export interface ProbeRun {
  label: "internal" | "control";
  /** False when the probe container could not run at all. */
  executed: boolean;
  /** Why it did not run, or exited non-zero (first cause line). */
  error?: string;
  observations: ProbeObservation[];
  /** The host-side controlled listener received this run's nonce. */
  hostSawNonce: boolean;
  /**
   * The two hosts the CONNECT probe asked for. When present, the allowlist is
   * judged by host identity rather than by the order or count of answers.
   */
  proxyCheck?: { allowedHost: string; deniedHost: string };
}

/** The state of a direct-egress control. */
export type DirectState = "blocked" | "reachable" | "untested" | "unavailable";

/** Every control's measured state, with the words behind it. */
export interface EgressControls {
  proxyAllowlist: {
    state: "enforced" | "not-enforced" | "untested";
    detail: string;
  };
  /** Literals and hostnames, with proxy variables bypassed. */
  directInternetV4: { state: DirectState; detail: string };
  /** `unavailable` only when the negative control also has no IPv6. */
  directInternetV6: { state: DirectState; detail: string };
  /** The host gateway and own addresses, via the controlled listener. */
  hostAccess: { state: "blocked" | "reachable" | "untested"; detail: string };
  /** Always untested: there is no controlled LAN endpoint to probe. */
  lanAccess: { state: "untested"; detail: string };
  dns: { state: "reachable" | "blocked" | "untested"; detail: string };
  toolPaths: Array<
    { name: string; state: "ok" | "failed" | "untested"; detail: string }
  >;
  negativeControl: {
    v4: boolean;
    v6: boolean;
    host: boolean;
    dns: boolean;
    executed: boolean;
    detail: string;
  };
}

/** The promises a mode makes, and the gaps it openly carries. */
export interface EgressEvaluation {
  /** Broken promises, one sentence each. */
  regressions: string[];
  /** Residual gaps for the measured state, one sentence each. */
  acceptedGaps: string[];
}

/** A finished, serialisable egress report for one launch. */
export interface EgressControlReport {
  schema: typeof EGRESS_CONTROLS_SCHEMA;
  recordedAt: string;
  launch: string;
  runtime: { executable: string; version: string | null; macos: string | null };
  selectedMode: EgressMode;
  effectiveMode: EgressMode;
  controls: EgressControls;
  regressions: string[];
  acceptedGaps: string[];
}

type AddressFamily = "literal4" | "literal6" | "name4";
type TcpObservation = Extract<ProbeObservation, { kind: "tcp" }>;
type ConnectObservation = Extract<ProbeObservation, { kind: "connect" }>;
type NetObservation = Extract<ProbeObservation, { kind: "net" }>;
type DnsObservation = Extract<ProbeObservation, { kind: "dns" }>;
type NegativeControl = EgressControls["negativeControl"];

/** The observations of one kind, from one run. */
function observationsOf<K extends ProbeObservation["kind"]>(
  run: ProbeRun | null,
  kind: K,
): Extract<ProbeObservation, { kind: K }>[] {
  if (run === null) return [];
  return run.observations.filter(
    (observation): observation is Extract<ProbeObservation, { kind: K }> =>
      observation.kind === kind,
  );
}

function firstNet(run: ProbeRun | null): NetObservation | undefined {
  return observationsOf(run, "net")[0];
}

function reasonNotRun(run: ProbeRun): string {
  return run.error ?? "no reason recorded";
}

function targetsOf(list: readonly TcpObservation[]): string {
  return list.map((observation) => observation.target).join(", ");
}

function untested(detail: string): { state: "untested"; detail: string } {
  return { state: "untested", detail };
}

/** The negative control's proof, or the absence of one. */
function negativeControlOf(control: ProbeRun | null): NegativeControl {
  if (control === null) {
    return {
      v4: false,
      v6: false,
      host: false,
      dns: false,
      executed: false,
      detail: "no negative control was run, so no probe result is proven",
    };
  }
  if (!control.executed) {
    return {
      v4: false,
      v6: false,
      host: false,
      dns: false,
      executed: false,
      detail: `the negative control did not run (${
        reasonNotRun(control)
      }), so no probe result is proven`,
    };
  }
  const tcp = observationsOf(control, "tcp");
  const v4 = tcp.some((observation) =>
    (observation.family === "literal4" || observation.family === "name4") &&
    observation.outcome === "ok"
  );
  const v6 = tcp.some((observation) =>
    observation.family === "literal6" && observation.outcome === "ok"
  );
  const host = control.hostSawNonce;
  const dns = observationsOf(control, "dns").some((observation) =>
    observation.ok
  );
  const word = (proved: boolean): string => proved ? "reached" : "not reached";
  return {
    v4,
    v6,
    host,
    dns,
    executed: true,
    detail: `the negative control ran: IPv4 ${word(v4)}, IPv6 ${word(v6)}, ` +
      `host listener ${word(host)}, DNS ${word(dns)}`,
  };
}

/**
 * The shared rule for a direct-connect control.
 *
 * `reachable` on any successful attempt. Otherwise `blocked` needs every
 * attempt to have failed by timeout, unreachable or refused, with no error, and
 * a negative control that proved connections succeed. Anything else is
 * untested, with the reason.
 */
function directStateOf(
  label: string,
  internal: ProbeRun,
  families: readonly AddressFamily[],
  controlProof: boolean,
): { state: DirectState; detail: string } {
  const attempts = observationsOf(internal, "tcp").filter((observation) =>
    families.some((family) => family === observation.family)
  );
  const reached = attempts.filter((observation) =>
    observation.outcome === "ok"
  );
  if (reached.length > 0) {
    return {
      state: "reachable",
      detail: `${label} connected to ${
        targetsOf(reached)
      } with proxy variables bypassed`,
    };
  }
  if (!internal.executed) {
    return untested(
      `the internal probe did not run (${
        reasonNotRun(internal)
      }), so ${label} was not measured`,
    );
  }
  if (attempts.length === 0) {
    return untested(`no ${label} attempt was recorded`);
  }
  const errored = attempts.filter((observation) =>
    observation.outcome === "error"
  );
  if (errored.length > 0) {
    return untested(
      `${errored.length} ${label} attempt(s) errored (${
        targetsOf(errored)
      }), and an error is not evidence either way`,
    );
  }
  const attempted = attempts.map((observation) =>
    `${observation.target} ${observation.outcome}`
  ).join(", ");
  if (!controlProof) {
    return untested(
      `${label} attempts all failed (${attempted}), but the negative control ` +
        "did not prove that a connection can succeed, so this is not a block",
    );
  }
  return {
    state: "blocked",
    detail: `${label} attempts all failed (${attempted}) and the negative ` +
      "control proved that a connection can succeed",
  };
}

function directIpv4Of(
  internal: ProbeRun,
  negativeControl: NegativeControl,
): { state: DirectState; detail: string } {
  return directStateOf(
    "IPv4 direct egress",
    internal,
    ["literal4", "name4"],
    negativeControl.v4,
  );
}

function directIpv6Of(
  internal: ProbeRun,
  control: ProbeRun | null,
  negativeControl: NegativeControl,
): { state: DirectState; detail: string } {
  const reachedV6 = observationsOf(internal, "tcp").some((observation) =>
    observation.family === "literal6" && observation.outcome === "ok"
  );
  const noRoute = firstNet(control)?.ipv6 === false ||
    firstNet(internal)?.ipv6 === false;
  if (
    !reachedV6 && control?.executed === true && !negativeControl.v6 && noRoute
  ) {
    return {
      state: "unavailable",
      detail:
        "no IPv6 route on this host, so IPv6 egress could not be exercised",
    };
  }
  return directStateOf(
    "IPv6 direct egress",
    internal,
    ["literal6"],
    negativeControl.v6,
  );
}

function hostAccessOf(
  internal: ProbeRun,
  negativeControl: NegativeControl,
): { state: "blocked" | "reachable" | "untested"; detail: string } {
  if (internal.hostSawNonce) {
    return {
      state: "reachable",
      detail: "the host's controlled listener received this run's nonce, so " +
        "the container reached the host's own addresses",
    };
  }
  const attempts = observationsOf(internal, "tcp").filter((observation) =>
    observation.family === "host"
  );
  if (
    internal.executed && attempts.length > 0 &&
    attempts.every((observation) =>
      observation.outcome === "timeout" || observation.outcome === "unreachable"
    ) &&
    negativeControl.host
  ) {
    return {
      state: "blocked",
      detail: `host addresses timed out or were unreachable (${
        targetsOf(attempts)
      }) and the negative control's nonce reached the listener`,
    };
  }
  const reasons: string[] = [];
  if (!internal.executed) {
    reasons.push(`the internal probe did not run (${reasonNotRun(internal)})`);
  } else if (attempts.length === 0) {
    reasons.push("no host attempt was recorded");
  }
  if (attempts.some((observation) => observation.outcome === "refused")) {
    reasons.push(
      "a host attempt was refused, which shows the host stack replied and is " +
        "not evidence of a firewall",
    );
  }
  if (attempts.some((observation) => observation.outcome === "error")) {
    reasons.push(
      "a host attempt errored, and an error is not evidence either way",
    );
  }
  if (attempts.some((observation) => observation.outcome === "ok")) {
    reasons.push("a host attempt connected but the nonce did not arrive");
  }
  if (!negativeControl.host) {
    reasons.push(
      "the negative control's nonce did not reach the listener, so a timeout " +
        "proves nothing",
    );
  }
  return {
    state: "untested",
    detail: reasons.length > 0
      ? reasons.join("; ")
      : "host access was not measured",
  };
}

function dnsOf(
  internal: ProbeRun,
  negativeControl: NegativeControl,
): { state: "reachable" | "blocked" | "untested"; detail: string } {
  const lookups: DnsObservation[] = observationsOf(internal, "dns");
  const resolved = lookups.filter((lookup) => lookup.ok);
  if (resolved.length > 0) {
    return {
      state: "reachable",
      detail: `name lookups from the container succeeded (${
        resolved.map((lookup) => lookup.name).join(", ")
      })`,
    };
  }
  if (internal.executed && lookups.length > 0 && negativeControl.dns) {
    return {
      state: "blocked",
      detail: `name lookups failed (${
        lookups.map((lookup) => lookup.name).join(", ")
      }) and the negative control resolved a name`,
    };
  }
  if (!internal.executed) {
    return untested(
      `the internal probe did not run (${
        reasonNotRun(internal)
      }), so DNS was not measured`,
    );
  }
  if (lookups.length === 0) return untested("no DNS lookup was recorded");
  return untested(
    "name lookups failed, but the negative control did not resolve a name, so this is not a block",
  );
}

/** Describe one CONNECT answer for a detail line. */
function describeAnswer(answer: ConnectObservation): string {
  if (answer.status === null) return `${answer.host} gave no answer`;
  const reason = answer.reason === null ? "" : ` with reason ${answer.reason}`;
  return `${answer.host} answered ${answer.status}${reason}`;
}

/**
 * The CONNECT allowlist reading, judged by host identity.
 *
 * `not-enforced` when the denied host was tunnelled (200). `enforced` only when
 * the allowed host was tunnelled and the denied host was refused with reason
 * `not-allowlisted`. Anything else is untested, naming the reading that is
 * missing or odd.
 */
function proxyAllowlistByIdentity(
  check: { allowedHost: string; deniedHost: string },
  answers: readonly ConnectObservation[],
): EgressControls["proxyAllowlist"] {
  const allowed = answers.find((answer) => answer.host === check.allowedHost);
  const denied = answers.find((answer) => answer.host === check.deniedHost);
  if (denied?.status === 200) {
    return {
      state: "not-enforced",
      detail: `denied host ${check.deniedHost} was tunnelled (200), so the ` +
        "allowlist did not refuse it",
    };
  }
  if (
    allowed?.status === 200 && denied?.status === 403 &&
    denied.reason === "not-allowlisted"
  ) {
    return {
      state: "enforced",
      detail:
        `allowed host ${check.allowedHost} tunnelled (200) and denied host ` +
        `${check.deniedHost} was refused (403 not-allowlisted)`,
    };
  }
  const odd: string[] = [];
  if (allowed === undefined) {
    odd.push(`no CONNECT answer for the allowed host ${check.allowedHost}`);
  } else if (allowed.status !== 200) {
    odd.push(
      `the allowed host ${describeAnswer(allowed)} where 200 was expected`,
    );
  }
  if (denied === undefined) {
    odd.push(`no CONNECT answer for the denied host ${check.deniedHost}`);
  } else if (denied.status !== 403 || denied.reason !== "not-allowlisted") {
    odd.push(
      `the denied host ${
        describeAnswer(denied)
      } where 403 not-allowlisted was expected`,
    );
  }
  return untested(odd.join("; "));
}

/**
 * The CONNECT allowlist reading.
 *
 * With a `proxyCheck`, the answers are matched by host identity. Without one,
 * the answers cannot be attributed to the allowed and denied hosts, so the
 * allowlist is untested, never enforced. Two distinct hosts both tunnelling
 * (200) is still not-enforced, because the denied one got through.
 */
function proxyAllowlistOf(
  internal: ProbeRun,
): EgressControls["proxyAllowlist"] {
  if (!internal.executed) {
    return untested(
      `the internal probe did not run (${
        reasonNotRun(internal)
      }), so the CONNECT allowlist was not measured`,
    );
  }
  const answers: ConnectObservation[] = observationsOf(internal, "connect");
  if (answers.length === 0) {
    return untested(
      "no CONNECT answer was recorded, so neither the allowed reading nor the denied reading was measured",
    );
  }
  if (internal.proxyCheck !== undefined) {
    return proxyAllowlistByIdentity(internal.proxyCheck, answers);
  }
  const tunnelled = answers.filter((answer) => answer.status === 200);
  const tunnelledHosts = [
    ...new Set(tunnelled.map((answer) => answer.host)),
  ];
  if (tunnelledHosts.length >= 2) {
    return {
      state: "not-enforced",
      detail: `CONNECT to ${tunnelledHosts.join(" and ")} both answered 200, ` +
        "so a host the allowlist should refuse was tunnelled",
    };
  }
  return untested(
    `no proxyCheck was recorded, so the CONNECT answers (${
      answers.map(describeAnswer).join("; ")
    }) cannot be matched to the allowed and denied hosts by identity`,
  );
}

/** One entry per tool observation; none when the internal run did not execute. */
function toolPathsOf(internal: ProbeRun): EgressControls["toolPaths"] {
  if (!internal.executed) return [];
  return observationsOf(internal, "tool").map((observation) => ({
    name: observation.name,
    state: observation.ok ? "ok" : "failed",
    detail: observation.detail,
  }));
}

/**
 * Derive every control's state from the internal run and its negative control.
 *
 * @param internal - The probe run on the internal network
 * @param control - The negative control run on the default network, or null
 * @returns One result per control
 */
export function deriveEgressControls(
  internal: ProbeRun,
  control: ProbeRun | null,
): EgressControls {
  const negativeControl = negativeControlOf(control);
  return {
    proxyAllowlist: proxyAllowlistOf(internal),
    directInternetV4: directIpv4Of(internal, negativeControl),
    directInternetV6: directIpv6Of(internal, control, negativeControl),
    hostAccess: hostAccessOf(internal, negativeControl),
    // SIMPLE-ON-PURPOSE: LAN reachability is never probed, always reported untested — upgrade when a controlled LAN test endpoint exists to tell a firewall from a closed port
    lanAccess: {
      state: "untested",
      detail:
        "only the host's own addresses are probed; no controlled endpoint exists on the LAN, so LAN access is not measured",
    },
    dns: dnsOf(internal, negativeControl),
    toolPaths: toolPathsOf(internal),
    negativeControl,
  };
}

/** The gap sentence for direct IPv4 egress, in advisory mode. */
function advisoryDirectEgressSentence(
  v4: EgressControls["directInternetV4"],
): string {
  const base =
    "direct egress is not blocked: proxy variables are advisory routing";
  switch (v4.state) {
    case "blocked":
      return `${base} (this run measured IPv4 direct egress blocked, but advisory-proxy does not promise that)`;
    case "reachable":
      return `${base} (measured reachable: ${v4.detail})`;
    default:
      return `${base} (IPv4 direct egress ${v4.state}: ${v4.detail})`;
  }
}

/**
 * Check the measured controls against what the mode promises.
 *
 * `internal-network` promises the proxy allowlist refuses non-allowlisted hosts,
 * direct IPv4 egress is blocked, direct IPv6 egress is not reachable, and no
 * tool path fails. `advisory-proxy` promises only the proxy allowlist and the
 * tool paths. Every gap is listed for the measured state, whatever the mode.
 *
 * @param mode - The mode whose promises are checked
 * @param controls - The derived controls
 * @returns Broken promises and residual gaps, as sentences
 */
export function evaluateEgress(
  mode: EgressMode,
  controls: EgressControls,
): EgressEvaluation {
  const regressions: string[] = [];
  const acceptedGaps: string[] = [];
  const {
    proxyAllowlist,
    directInternetV4,
    directInternetV6,
    hostAccess,
    lanAccess,
    dns,
    toolPaths,
    negativeControl,
  } = controls;

  if (proxyAllowlist.state !== "enforced") {
    regressions.push(
      `${mode} promises that the proxy refuses non-allowlisted hosts, but ` +
        `proxyAllowlist is ${proxyAllowlist.state} (${proxyAllowlist.detail})`,
    );
  }
  if (mode === "internal-network") {
    if (directInternetV4.state !== "blocked") {
      regressions.push(
        `internal-network promises that direct IPv4 egress is blocked, but ` +
          `directInternetV4 is ${directInternetV4.state} (${directInternetV4.detail})`,
      );
    }
    if (
      directInternetV6.state === "reachable" ||
      directInternetV6.state === "untested"
    ) {
      regressions.push(
        `internal-network promises that direct IPv6 egress is not reachable, ` +
          `but directInternetV6 is ${directInternetV6.state} (${directInternetV6.detail})`,
      );
    }
  }
  for (const tool of toolPaths) {
    if (tool.state === "failed") {
      regressions.push(
        `${mode} promises that no tool path fails, but tool path ${tool.name} ` +
          `failed (${tool.detail})`,
      );
    }
  }

  if (mode === "advisory-proxy") {
    acceptedGaps.push(advisoryDirectEgressSentence(directInternetV4));
  } else if (directInternetV4.state !== "blocked") {
    acceptedGaps.push(
      `direct IPv4 egress is ${directInternetV4.state}: ${directInternetV4.detail}`,
    );
  }
  if (
    directInternetV6.state === "reachable" ||
    directInternetV6.state === "unavailable" ||
    directInternetV6.state === "untested"
  ) {
    acceptedGaps.push(
      `direct IPv6 egress is ${directInternetV6.state}: ${directInternetV6.detail}`,
    );
  }
  if (hostAccess.state === "reachable") {
    acceptedGaps.push(
      "host services on the internal network's gateway are reachable — apple/container#1320 (" +
        `${hostAccess.detail})`,
    );
  } else if (hostAccess.state === "untested") {
    acceptedGaps.push(`host access is untested: ${hostAccess.detail}`);
  }
  acceptedGaps.push(`LAN access is untested: ${lanAccess.detail}`);
  if (dns.state === "reachable") {
    acceptedGaps.push(
      `DNS lookups leave the container, a residual tunnelling channel (${dns.detail})`,
    );
  } else if (dns.state === "untested") {
    acceptedGaps.push(`DNS lookups are untested: ${dns.detail}`);
  }
  if (
    !negativeControl.executed || !negativeControl.v4 || !negativeControl.host ||
    !negativeControl.dns
  ) {
    acceptedGaps.push(`negative control invalid: ${negativeControl.detail}`);
  }

  return { regressions, acceptedGaps };
}

/**
 * Assemble a report, running the promise check for the effective mode.
 *
 * @param input - Everything the report records, without the derived fields
 * @returns The report with its schema version, regressions and gaps filled in
 */
export function buildEgressControlReport(
  input: Omit<EgressControlReport, "schema" | "regressions" | "acceptedGaps">,
): EgressControlReport {
  const evaluation = evaluateEgress(input.effectiveMode, input.controls);
  return {
    schema: EGRESS_CONTROLS_SCHEMA,
    recordedAt: input.recordedAt,
    launch: input.launch,
    runtime: input.runtime,
    selectedMode: input.selectedMode,
    effectiveMode: input.effectiveMode,
    controls: input.controls,
    regressions: evaluation.regressions,
    acceptedGaps: evaluation.acceptedGaps,
  };
}

/** One control's line: its name, state and detail. */
function controlLine(
  name: string,
  control: { state: string; detail: string },
): string {
  return `control ${name}: ${control.state} — ${control.detail}`;
}

/**
 * The startup report, one line per fact, each prefixed `[egress] `.
 *
 * @param report - The finished report
 * @returns The lines, in print order
 */
export function formatStartupReport(report: EgressControlReport): string[] {
  const { controls } = report;
  const lines: string[] = [
    `mode: ${EGRESS_MODE_LABELS[report.effectiveMode]}`,
    `scope: ${MODE_SCOPE[report.effectiveMode]}`,
  ];
  if (report.selectedMode !== report.effectiveMode) {
    lines.push(
      `mode selected ${report.selectedMode}, but ${report.effectiveMode} is in effect`,
    );
  }
  lines.push(
    `runtime: ${report.runtime.executable} version ${
      report.runtime.version ?? "unknown"
    }, macOS ${report.runtime.macos ?? "unknown"}`,
    `launch: ${report.launch}, recorded ${report.recordedAt}`,
    controlLine("proxy-allowlist", controls.proxyAllowlist),
    controlLine("direct-ipv4", controls.directInternetV4),
    controlLine("direct-ipv6", controls.directInternetV6),
    controlLine("host-access", controls.hostAccess),
    controlLine("lan-access", controls.lanAccess),
    controlLine("dns", controls.dns),
  );
  for (const tool of controls.toolPaths) {
    lines.push(controlLine(`tool ${tool.name}`, tool));
  }
  lines.push(
    `control negative-control: ${
      controls.negativeControl.executed ? "executed" : "not run"
    } — ${controls.negativeControl.detail}`,
  );
  for (const gap of report.acceptedGaps) lines.push(`residual gap: ${gap}`);
  for (const regression of report.regressions) {
    lines.push(`REGRESSION: ${regression}`);
  }
  return lines.map((line) => `[egress] ${line}`);
}

/**
 * The single run-log line for a report.
 *
 * @param report - The finished report
 * @returns One line, with no line break
 */
export function summariseEgressControls(report: EgressControlReport): string {
  const { controls } = report;
  return `egress-containment: mode=${report.effectiveMode} ` +
    `proxy=${controls.proxyAllowlist.state} ` +
    `direct-v4=${controls.directInternetV4.state} ` +
    `direct-v6=${controls.directInternetV6.state} ` +
    `host=${controls.hostAccess.state} ` +
    `lan=${controls.lanAccess.state} ` +
    `dns=${controls.dns.state} ` +
    `regressions=${report.regressions.length} ` +
    `gaps=${report.acceptedGaps.length}`;
}
