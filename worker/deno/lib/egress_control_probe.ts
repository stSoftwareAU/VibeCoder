/**
 * The probe that runs inside a short-lived container (Issue #4051).
 *
 * The host builds an environment with {@link buildProbeEnv}, runs
 * {@link EGRESS_PROBE_SCRIPT} under bash inside the container, and reads the
 * observations back with {@link parseProbeOutput}. Nothing the host supplies
 * is ever interpolated into code: every value reaches the script as an
 * environment variable or a positional argument, and every value is checked
 * here first.
 *
 * The script always exits 0 once it has printed, because the host reads the
 * observations rather than the exit status. A probe that could not run prints
 * nothing, and the host records that as not executed. It never counts as a
 * pass.
 *
 * Australian English spelling used throughout (behaviour, sanitise).
 */

import type { ProbeObservation, TcpOutcome } from "./egress_controls.ts";

/** The environment variables the script reads. */
export const PROBE_ENV = {
  timeout: "PROBE_TIMEOUT",
  literals4: "PROBE_LITERALS4",
  literals6: "PROBE_LITERALS6",
  names: "PROBE_NAMES",
  dnsName: "PROBE_DNS_NAME",
  hosts: "PROBE_HOSTS",
  hostPort: "PROBE_HOST_PORT",
  nonce: "PROBE_NONCE",
  proxy: "PROBE_PROXY",
  allowHost: "PROBE_ALLOW_HOST",
  denyHost: "PROBE_DENY_HOST",
  tools: "PROBE_TOOLS",
  gitUrl: "PROBE_GIT_URL",
} as const;

/** What a caller asks one probe container to measure. */
export interface ProbeSpec {
  /** Bound on each attempt, in whole seconds. */
  timeoutSeconds: number;
  /** IPv4 targets as `ip:port`. */
  literals4: string[];
  /** IPv6 targets as `[addr]:port`. */
  literals6: string[];
  /** Name-based targets as `host:port`. */
  names: string[];
  /** The hostname resolved with `getent`. */
  dnsName: string;
  /** The host's own addresses, probed with the nonce. */
  hostAddresses: string[];
  /** The port of the host-side controlled listener. */
  hostPort: number;
  /** 16 to 64 lowercase hex characters, written to the host listener. */
  nonce: string;
  /** The CONNECT proxy, with an allowed and a denied host to try. */
  proxy?: {
    host: string;
    port: number;
    allowedHost: string;
    deniedHost: string;
  };
  /** Tool paths to exercise through the inherited HTTPS_PROXY. */
  tools: Array<{ name: string; url: string }>;
  /** A git remote to `ls-remote`, when one should be tried. */
  gitUrl?: string;
}

const MAX_TIMEOUT_SECONDS = 30;
const MAX_LINE_CHARS = 1024;
const MAX_VALUE_CHARS_IN_ERROR = 80;
const MAX_HOSTNAME_CHARS = 253;

const IPV4_LITERAL =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_CHARACTERS = /^[0-9a-fA-F:]{2,39}$/;
const HOST_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const HOST_PORT = /^([^:]{1,253}):(\d{1,5})$/;
const BRACKETED_PORT = /^\[([^\]]{2,39})\]:(\d{1,5})$/;
const DIGITS = /^\d{1,5}$/;
const NONCE_PATTERN = /^[0-9a-f]{16,64}$/;
const TOOL_NAME = /^[a-z0-9:._-]{1,64}$/;
const FORBIDDEN_CHARACTERS = /[\s'"`$]/;

/** Validation failure naming the field, with the value shortened for the log. */
function refuse(field: string, rule: string, value: unknown): never {
  const text = typeof value === "string" ? value : String(value);
  const shown = text.length > MAX_VALUE_CHARS_IN_ERROR
    ? `${text.slice(0, MAX_VALUE_CHARS_IN_ERROR)}…`
    : text;
  throw new Error(`probe ${field} ${rule}, got ${JSON.stringify(shown)}`);
}

/** Reject whitespace, quotes, `$` and backticks in any value that reaches the shell. */
function checkToken(field: string, value: string): string {
  if (FORBIDDEN_CHARACTERS.test(value)) {
    refuse(field, "must not contain whitespace, quotes, $ or backticks", value);
  }
  return value;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isIpv4(value: string): boolean {
  return IPV4_LITERAL.test(value);
}

function isIpv6(value: string): boolean {
  if (!IPV6_CHARACTERS.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

/** A dotted hostname: no IP literal, no empty or over-long label. */
function isHostname(value: string): boolean {
  if (value.length > MAX_HOSTNAME_CHARS) return false;
  return value.split(".").every((label) => HOST_LABEL.test(label));
}

/** Split an entry with a pattern, returning the host and port text. */
function splitEntry(entry: string, pattern: RegExp): [string, string] | null {
  const match = pattern.exec(entry);
  if (match === null) return null;
  const [, host = "", port = ""] = match;
  return [host, port];
}

function checkHttpsUrl(field: string, value: string): string {
  checkToken(field, value);
  if (value.length > 2048) {
    refuse(field, "must be at most 2048 characters", value);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    refuse(field, "must be an https URL", value);
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    !isHostname(url.hostname) || isIpv4(url.hostname)
  ) {
    refuse(field, "must be an https URL with a plain hostname", value);
  }
  return value;
}

/**
 * Validate a probe spec and turn it into the script's environment.
 *
 * Every field is checked before anything is built, so a bad value fails the
 * launch with a message naming the field rather than reaching the shell.
 *
 * @param spec - What the probe should measure
 * @returns Every `PROBE_*` variable, each set (empty when unused)
 * @throws Error naming the first field that is malformed
 */
export function buildProbeEnv(spec: ProbeSpec): Record<string, string> {
  const timeout = spec.timeoutSeconds;
  if (
    !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS
  ) {
    refuse(
      "timeoutSeconds",
      `must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`,
      timeout,
    );
  }

  const literals4 = spec.literals4.map((entry, index) => {
    const field = `literals4[${index}]`;
    const parts = splitEntry(entry, HOST_PORT);
    if (
      parts === null || !isIpv4(parts[0]) || !DIGITS.test(parts[1]) ||
      !isPort(Number(parts[1]))
    ) {
      refuse(field, "must be an IPv4 address and port as ip:port", entry);
    }
    return checkToken(field, entry);
  });

  const literals6 = spec.literals6.map((entry, index) => {
    const field = `literals6[${index}]`;
    const parts = splitEntry(entry, BRACKETED_PORT);
    if (
      parts === null || !isIpv6(parts[0]) || !DIGITS.test(parts[1]) ||
      !isPort(Number(parts[1]))
    ) {
      refuse(field, "must be an IPv6 address and port as [addr]:port", entry);
    }
    return checkToken(field, entry);
  });

  const names = spec.names.map((entry, index) => {
    const field = `names[${index}]`;
    const parts = splitEntry(entry, HOST_PORT);
    if (
      parts === null || !isHostname(parts[0]) || !DIGITS.test(parts[1]) ||
      !isPort(Number(parts[1]))
    ) {
      refuse(field, "must be a hostname and port as host:port", entry);
    }
    return checkToken(field, entry);
  });

  if (!isHostname(spec.dnsName)) {
    refuse("dnsName", "must be a hostname", spec.dnsName);
  }
  checkToken("dnsName", spec.dnsName);

  const hosts = spec.hostAddresses.map((address, index) => {
    const field = `hostAddresses[${index}]`;
    if (!isIpv4(address) && !isIpv6(address)) {
      refuse(field, "must be an IP address without a port", address);
    }
    return checkToken(field, address);
  });

  if (!isPort(spec.hostPort)) {
    refuse("hostPort", "must be an integer from 1 to 65535", spec.hostPort);
  }

  if (!NONCE_PATTERN.test(spec.nonce)) {
    refuse("nonce", "must be 16 to 64 lowercase hex characters", spec.nonce);
  }

  let proxy = "";
  let allowHost = "";
  let denyHost = "";
  if (spec.proxy !== undefined) {
    const { host, port, allowedHost, deniedHost } = spec.proxy;
    if (!isIpv4(host) && !isHostname(host)) {
      refuse("proxy.host", "must be an IPv4 address or a hostname", host);
    }
    if (!isPort(port)) {
      refuse("proxy.port", "must be an integer from 1 to 65535", port);
    }
    if (!isHostname(allowedHost)) {
      refuse("proxy.allowedHost", "must be a hostname", allowedHost);
    }
    if (!isHostname(deniedHost)) {
      refuse("proxy.deniedHost", "must be a hostname", deniedHost);
    }
    proxy = checkToken("proxy.host", `${host}:${port}`);
    allowHost = allowedHost;
    denyHost = deniedHost;
  }

  const tools = spec.tools.map((tool, index) => {
    if (!TOOL_NAME.test(tool.name)) {
      refuse(
        `tools[${index}].name`,
        "must be 1 to 64 characters of a-z, 0-9, colon, dot, underscore or hyphen",
        tool.name,
      );
    }
    checkHttpsUrl(`tools[${index}].url`, tool.url);
    return `${tool.name}=${tool.url}`;
  });

  const gitUrl = spec.gitUrl === undefined
    ? ""
    : checkHttpsUrl("gitUrl", spec.gitUrl);

  return {
    [PROBE_ENV.timeout]: String(timeout),
    [PROBE_ENV.literals4]: literals4.join(" "),
    [PROBE_ENV.literals6]: literals6.join(" "),
    [PROBE_ENV.names]: names.join(" "),
    [PROBE_ENV.dnsName]: spec.dnsName,
    [PROBE_ENV.hosts]: hosts.join(" "),
    [PROBE_ENV.hostPort]: String(spec.hostPort),
    [PROBE_ENV.nonce]: spec.nonce,
    [PROBE_ENV.proxy]: proxy,
    [PROBE_ENV.allowHost]: allowHost,
    [PROBE_ENV.denyHost]: denyHost,
    [PROBE_ENV.tools]: tools.join(" "),
    [PROBE_ENV.gitUrl]: gitUrl,
  };
}

/**
 * The bash script the probe container runs.
 *
 * Output grammar, one observation per line, single spaces:
 * - `net <address|none> <gateway|none> <yes|no>`
 * - `tcp <literal4|literal6|name4|host> <target> <ok|refused|timeout|unreachable|error>`
 * - `dns <name> <ok|fail>`
 * - `connect <host> <status|none> <reason|none>`
 * - `tool <name> <ok|fail> <detail>`
 *
 * Untrusted values reach the script only as environment variables and as
 * positional arguments to `bash -c`, never as code.
 */
export const EGRESS_PROBE_SCRIPT = `set -f

# One TCP attempt. Arguments: family, target as printed, host, port, nonce.
tcp_attempt() {
  local out rc outcome
  out=$(timeout "$PROBE_TIMEOUT" bash -c 'exec 3<>"/dev/tcp/$1/$2" || exit 1; if [ -n "$3" ]; then printf "%s\\n" "$3" >&3; fi' _ "$3" "$4" "$5" 2>&1)
  rc=$?
  case "$rc" in
    0) outcome=ok ;;
    124) outcome=timeout ;;
    *)
      case "$out" in
        *"Connection refused"*) outcome=refused ;;
        *"No route to host"* | *"Network is unreachable"*) outcome=unreachable ;;
        *"Name or service not known"* | *"Temporary failure in name resolution"* | *"Unknown host"* | *"Resolver Error"*) outcome=unreachable ;;
        *) outcome=error ;;
      esac
      ;;
  esac
  printf 'tcp %s %s %s\\n' "$1" "$2" "$outcome"
}

# A literal or name entry: addr:port, or [addr]:port for IPv6. Arguments: family, entry.
run_entry() {
  local family="$1" entry="$2" host port
  port=\${entry##*:}
  host=\${entry%:*}
  host=\${host#\\[}
  host=\${host%\\]}
  tcp_attempt "$family" "$entry" "$host" "$port" ""
}

# The host's own addresses, each probed with the nonce.
probe_hosts() {
  local ip target
  for ip in $PROBE_HOSTS; do
    case "$ip" in
      *:*) target="[$ip]:$PROBE_HOST_PORT" ;;
      *) target="$ip:$PROBE_HOST_PORT" ;;
    esac
    tcp_attempt host "$target" "$ip" "$PROBE_HOST_PORT" "$PROBE_NONCE"
  done
}

ipv4_from_ip() {
  local token previous=""
  for token in $(ip -4 -o addr show scope global 2>/dev/null); do
    if [ "$previous" = inet ]; then
      printf '%s' "\${token%%/*}"
      return 0
    fi
    previous=$token
  done
  return 1
}

ipv4_from_hostname() {
  local token
  for token in $(hostname -I 2>/dev/null); do
    case "$token" in
      *.*) printf '%s' "$token"; return 0 ;;
    esac
  done
  return 1
}

# Little-endian hex from /proc/net/route, such as 0140A8C0, to dotted decimal.
hex_to_ipv4() {
  local hex="$1"
  case "$hex" in
    [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]) ;;
    *) return 1 ;;
  esac
  printf '%d.%d.%d.%d' "0x\${hex:6:2}" "0x\${hex:4:2}" "0x\${hex:2:2}" "0x\${hex:0:2}"
}

probe_net() {
  local address=none gateway=none ipv6=no found
  if command -v ip >/dev/null 2>&1; then
    found=$(ipv4_from_ip) && address=$found
  fi
  if [ "$address" = none ] && command -v hostname >/dev/null 2>&1; then
    found=$(ipv4_from_hostname) && address=$found
  fi
  if [ -r /proc/net/route ]; then
    local iface dest gw
    while read -r iface dest gw _; do
      if [ "$dest" = 00000000 ] && [ "$gw" != 00000000 ]; then
        found=$(hex_to_ipv4 "$gw") && gateway=$found
        break
      fi
    done < /proc/net/route
  fi
  if [ -r /proc/net/if_inet6 ]; then
    local addr index plen scope
    while read -r addr index plen scope _; do
      if [ "$scope" = 00 ]; then ipv6=yes; fi
    done < /proc/net/if_inet6
  fi
  if [ "$ipv6" = no ] && [ -r /proc/net/ipv6_route ]; then
    local dest plen
    while read -r dest plen _; do
      if [ "$dest" = 00000000000000000000000000000000 ] && [ "$plen" = 00 ]; then
        ipv6=yes
        break
      fi
    done < /proc/net/ipv6_route
  fi
  printf 'net %s %s %s\\n' "$address" "$gateway" "$ipv6"
}

probe_dns() {
  if [ -n "$PROBE_DNS_NAME" ]; then
    if timeout "$PROBE_TIMEOUT" getent ahostsv4 "$PROBE_DNS_NAME" >/dev/null 2>&1; then
      printf 'dns %s ok\\n' "$PROBE_DNS_NAME"
    else
      printf 'dns %s fail\\n' "$PROBE_DNS_NAME"
    fi
  fi
}

# Raw CONNECT over /dev/tcp. Arguments: proxy host, proxy port, target host.
# Prints "<status> <reason>", or "none none" when no answer arrives.
read -r -d '' CONNECT_CODE <<'CONNECT_END'
exec 3<>"/dev/tcp/$1/$2" || { printf 'none none\\n'; exit 0; }
printf 'CONNECT %s:443 HTTP/1.1\\r\\nHost: %s:443\\r\\n\\r\\n' "$3" "$3" >&3
IFS= read -r -t 5 -u 3 status_line || { printf 'none none\\n'; exit 0; }
read -r _proto code _rest <<< "$status_line"
code=\${code//[!0-9]/}
if [ "$code" = 200 ]; then printf '200 none\\n'; exit 0; fi
reason=
n=0
while [ "$n" -lt 12 ] && IFS= read -r -t 2 -u 3 header_line; do
  n=$((n + 1))
  case "$header_line" in
    *reason=*)
      reason=\${header_line#*reason=}
      reason=\${reason%%[!a-z-]*}
      reason=\${reason:0:40}
      break
      ;;
  esac
done
printf '%s %s\\n' "\${code:-none}" "\${reason:-none}"
CONNECT_END

probe_connect() {
  local answer status reason
  answer=$(timeout 30 bash -c "$CONNECT_CODE" _ "$PROXY_HOST" "$PROXY_PORT" "$1" 2>/dev/null)
  read -r status reason <<< "$answer"
  case "$status" in
    [0-9][0-9][0-9]) ;;
    *) status=none ;;
  esac
  case "$reason" in
    "" | *[!a-z-]*) reason=none ;;
  esac
  printf 'connect %s %s %s\\n' "$1" "$status" "$reason"
}

# First line of a captured error, with whitespace as underscores, capped at 80.
# Arguments: error file, exit status.
first_error() {
  local line
  line=$(head -n 1 "$1" 2>/dev/null)
  line=\${line//[[:space:]]/_}
  line=\${line:0:80}
  if [ -z "$line" ]; then line=exit_$2; fi
  printf '%s' "$line"
}

remove_scratch() {
  if [ "$1" != /dev/null ]; then rm -f "$1"; fi
}

probe_tools() {
  local item name url code rc errfile
  for item in $PROBE_TOOLS; do
    name=\${item%%=*}
    url=\${item#*=}
    if ! command -v curl >/dev/null 2>&1; then
      printf 'tool %s fail not_installed\\n' "$name"
      continue
    fi
    errfile=$(mktemp 2>/dev/null) || errfile=/dev/null
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>"$errfile")
    rc=$?
    case "$code" in
      [1-5][0-9][0-9]) printf 'tool %s ok http_%s\\n' "$name" "$code" ;;
      *) printf 'tool %s fail %s\\n' "$name" "$(first_error "$errfile" "$rc")" ;;
    esac
    remove_scratch "$errfile"
  done
}

probe_git() {
  local rc errfile
  if ! command -v git >/dev/null 2>&1; then
    printf 'tool git fail not_installed\\n'
    return 0
  fi
  errfile=$(mktemp 2>/dev/null) || errfile=/dev/null
  GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote "$PROBE_GIT_URL" HEAD >/dev/null 2>"$errfile"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'tool git ok head_listed\\n'
  else
    printf 'tool git fail %s\\n' "$(first_error "$errfile" "$rc")"
  fi
  remove_scratch "$errfile"
}

probe_net
for entry in $PROBE_LITERALS4; do run_entry literal4 "$entry"; done
for entry in $PROBE_LITERALS6; do run_entry literal6 "$entry"; done
for entry in $PROBE_NAMES; do run_entry name4 "$entry"; done
probe_hosts
probe_dns
if [ -n "$PROBE_PROXY" ]; then
  PROXY_HOST=\${PROBE_PROXY%:*}
  PROXY_PORT=\${PROBE_PROXY##*:}
  probe_connect "$PROBE_ALLOW_HOST"
  probe_connect "$PROBE_DENY_HOST"
fi
probe_tools
if [ -n "$PROBE_GIT_URL" ]; then probe_git; fi
exit 0
`;

/** Shape of one observation line: a known kind, then its fields. */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "net",
  "tcp",
  "dns",
  "connect",
  "tool",
]);
const NET_LINE =
  /^net (none|\d{1,3}(?:\.\d{1,3}){3}) (none|\d{1,3}(?:\.\d{1,3}){3}) (yes|no)$/;
const TCP_LINE =
  /^tcp (literal4|literal6|name4|host) (\S{1,256}) (ok|refused|timeout|unreachable|error)$/;
const DNS_LINE = /^dns (\S{1,253}) (ok|fail)$/;
const CONNECT_LINE = /^connect (\S{1,253}) (none|\d{3}) (none|[a-z-]{1,40})$/;
const TOOL_LINE = /^tool ([a-z0-9:._-]{1,64}) (ok|fail) (\S{1,200})$/;

/**
 * Read the observations a probe container printed.
 *
 * Blank lines and lines that do not begin with a known kind are ignored. A line
 * that does begin with a known kind must match its grammar exactly, or the
 * whole parse throws, so a damaged probe cannot be read as a partial result.
 *
 * @param text - The probe container's standard output
 * @returns The observations, in print order
 * @throws Error when a known-kind line is malformed or too long
 */
export function parseProbeOutput(text: string): ProbeObservation[] {
  const observations: ProbeObservation[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const space = line.indexOf(" ");
    const kind = space === -1 ? line : line.slice(0, space);
    if (!KNOWN_KINDS.has(kind)) continue;
    observations.push(parseKnownLine(kind, line));
  }
  return observations;
}

function parseKnownLine(kind: string, line: string): ProbeObservation {
  const malformed = (): never => {
    throw new Error(
      `malformed ${kind} line in probe output: ${
        JSON.stringify(line.slice(0, 80))
      }`,
    );
  };
  if (line.length > MAX_LINE_CHARS) malformed();
  switch (kind) {
    case "net": {
      const match = NET_LINE.exec(line);
      if (match === null) return malformed();
      const [, address = "", gateway = "", ipv6 = ""] = match;
      return {
        kind: "net",
        address: address === "none" ? null : address,
        gateway: gateway === "none" ? null : gateway,
        ipv6: ipv6 === "yes",
      };
    }
    case "tcp": {
      const match = TCP_LINE.exec(line);
      if (match === null) return malformed();
      const [, family = "", target = "", outcome = ""] = match;
      return {
        kind: "tcp",
        family: family as "literal4" | "literal6" | "name4" | "host",
        target,
        outcome: outcome as TcpOutcome,
      };
    }
    case "dns": {
      const match = DNS_LINE.exec(line);
      if (match === null) return malformed();
      const [, name = "", result = ""] = match;
      return { kind: "dns", name, ok: result === "ok" };
    }
    case "connect": {
      const match = CONNECT_LINE.exec(line);
      if (match === null) return malformed();
      const [, host = "", status = "", reason = ""] = match;
      return {
        kind: "connect",
        host,
        status: status === "none" ? null : Number(status),
        reason: reason === "none" ? null : reason,
      };
    }
    case "tool": {
      const match = TOOL_LINE.exec(line);
      if (match === null) return malformed();
      const [, name = "", result = "", detail = ""] = match;
      return { kind: "tool", name, ok: result === "ok", detail };
    }
    default:
      return malformed();
  }
}
