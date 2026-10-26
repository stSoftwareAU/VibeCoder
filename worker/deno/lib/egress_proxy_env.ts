/**
 * The proxy environment a worker container is started with (Issue #4051).
 *
 * Runtime-neutral: nothing here names a container CLI, so Docker and Podman
 * can reuse it. The variables only route traffic through the egress proxy.
 * They block nothing on their own; a container can unset them or connect
 * directly. Containment comes from the network the container sits on.
 *
 * Australian English spelling used throughout (behaviour, normalised).
 */

/** The port the egress proxy listens on inside its container. */
export const EGRESS_PROXY_PORT = 3128;

/** Every variable name the proxy environment sets, upper and lower case. */
export const EGRESS_PROXY_ENV_NAMES = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

/** Loopback only: nothing else bypasses the proxy. */
export const EGRESS_NO_PROXY = "localhost,127.0.0.1,::1";

const IPV4_LITERAL =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const DNS_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const ALL_DIGITS = /^\d+$/;
const MAX_DNS_NAME_CHARS = 253;

/**
 * True for a plain DNS name: dot-separated labels, and not an IP literal in
 * disguise (a final all-numeric label is refused, so `1.2.3` is not a name).
 */
function isPlainDnsName(host: string): boolean {
  if (host.length > MAX_DNS_NAME_CHARS) return false;
  const labels = host.split(".");
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  return !ALL_DIGITS.test(labels[labels.length - 1] ?? "");
}

/**
 * The six proxy variables for a worker, pointing at the egress proxy.
 *
 * @param proxyHost - The proxy's IPv4 literal or a plain DNS name
 * @returns Each name in {@link EGRESS_PROXY_ENV_NAMES} with its value
 * @throws Error naming the host when it is neither an IPv4 literal nor a
 *   plain DNS name
 */
export function egressProxyEnv(proxyHost: string): Record<string, string> {
  if (!IPV4_LITERAL.test(proxyHost) && !isPlainDnsName(proxyHost)) {
    throw new Error(
      `egress proxy host must be an IPv4 address or a plain DNS name, got ${
        JSON.stringify(proxyHost)
      }`,
    );
  }
  const url = `http://${proxyHost}:${EGRESS_PROXY_PORT}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY: EGRESS_NO_PROXY,
    no_proxy: EGRESS_NO_PROXY,
  };
}
