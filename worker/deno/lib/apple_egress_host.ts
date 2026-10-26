/**
 * Production side effects for the Apple `container` egress lifecycle (Issue #4051).
 *
 * `lib/apple_egress.ts` injects every side effect through
 * {@link AppleEgressDeps}. This module supplies the real ones: the Apple CLI and
 * host commands through the repo's bounded subprocess helper, a listener the
 * probes report their nonce to, a CSPRNG nonce, the host liveness probe, and an
 * atomic report writer.
 *
 * Australian English spelling used throughout (behaviour, normalised).
 */

import type { AppleEgressDeps, HostListener } from "./apple_egress.ts";
import { probePidAlive, type RuntimeInvocation } from "./container_watchdog.ts";
import { atomicWrite } from "./file_utils.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/** Bound on one host command such as `sw_vers`. */
const HOST_COMMAND_TIMEOUT_MS = 15_000;

/** Longest nonce line the listener reads before it drops a connection. */
const NONCE_LINE_MAX_CHARS = 256;

/** Idle bound on one connection: a silent peer is dropped after this long. */
const CONNECTION_IDLE_MS = 5_000;

/** Most host addresses the listener reports. */
const MAX_HOST_ADDRESSES = 8;

/** Options for {@link createAppleEgressDeps}. */
export interface AppleEgressHostOptions {
  /** The Apple CLI executable, normally `container`. */
  runtime: string;
}

/**
 * Run one command bounded, with its output captured.
 *
 * A missing executable, a timeout and a non-zero exit all come back as a
 * {@link RuntimeInvocation}; a timeout is never an empty success.
 */
async function runBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<RuntimeInvocation> {
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
}

/** A fresh nonce: 16 random bytes as 32 lowercase hex characters. */
export function newAppleEgressNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The one line logged when the listener has no address to report. */
export const NO_HOST_ADDRESS_WARNING =
  "[egress] warning: the host listener has no usable IPv4 address, so host-hop probes cannot be measured";

/**
 * The host's IPv4 addresses from an interface list: non-loopback,
 * non-link-local, at most 8. Logs {@link NO_HOST_ADDRESS_WARNING} when none
 * is usable, so an empty list is never silent.
 *
 * @param interfaces - The interfaces, as `Deno.networkInterfaces()` reports them
 * @param log - Receives the warning line
 * @returns The usable IPv4 addresses, in interface order
 */
export function usableHostAddresses(
  interfaces: readonly Pick<Deno.NetworkInterfaceInfo, "family" | "address">[],
  log: (line: string) => void,
): string[] {
  const found = new Set<string>();
  for (const info of interfaces) {
    if (info.family !== "IPv4") continue;
    if (
      info.address.startsWith("127.") || info.address.startsWith("169.254.")
    ) {
      continue;
    }
    found.add(info.address);
    if (found.size >= MAX_HOST_ADDRESSES) break;
  }
  if (found.size === 0) log(NO_HOST_ADDRESS_WARNING);
  return [...found];
}

/** The host's usable addresses; a denied interface listing is an empty list. */
function hostAddresses(log: (line: string) => void): string[] {
  let interfaces: Deno.NetworkInterfaceInfo[] = [];
  try {
    interfaces = Deno.networkInterfaces();
  } catch {
    // Denied (no --allow-sys=networkInterfaces): the empty list is warned about
    // by usableHostAddresses, so the denial is not silent.
  }
  return usableHostAddresses(interfaces, log);
}

function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}

/**
 * Bind a listener on 0.0.0.0 that reads one nonce line per connection.
 *
 * `seen(nonce)` is true only for a line some connection actually sent. A
 * connection is read up to a newline (or end of stream), capped at
 * {@link NONCE_LINE_MAX_CHARS} and dropped after {@link CONNECTION_IDLE_MS} of
 * silence.
 *
 * @returns The bound port, the host's addresses, and `seen` and `close`
 */
export async function startAppleHostListener(): Promise<HostListener> {
  const listener = Deno.listen({
    hostname: "0.0.0.0",
    port: 0,
    transport: "tcp",
  });
  const received = new Set<string>();
  const open = new Set<Deno.Conn>();
  const handlers = new Set<Promise<void>>();
  const decoder = new TextDecoder();

  const serve = async (conn: Deno.Conn): Promise<void> => {
    open.add(conn);
    try {
      const buffer = new Uint8Array(NONCE_LINE_MAX_CHARS);
      let line = "";
      while (true) {
        const timer = setTimeout(() => closeQuietly(conn), CONNECTION_IDLE_MS);
        let count: number | null;
        try {
          count = await conn.read(buffer);
        } finally {
          clearTimeout(timer);
        }
        if (count === null) break;
        line += decoder.decode(buffer.subarray(0, count), { stream: true });
        const end = line.indexOf("\n");
        if (end >= 0) {
          line = line.slice(0, end);
          break;
        }
        if (line.length >= NONCE_LINE_MAX_CHARS) {
          line = "";
          break;
        }
      }
      const nonce = line.trim();
      if (nonce !== "") received.add(nonce);
    } catch {
      // A reset, timed-out or closed connection records nothing.
    } finally {
      closeQuietly(conn);
      open.delete(conn);
    }
  };

  const accepting = (async () => {
    try {
      while (true) {
        const conn = await listener.accept();
        const handler = serve(conn);
        handlers.add(handler);
        handler.finally(() => handlers.delete(handler));
      }
    } catch {
      // The listener was closed.
    }
  })();

  const port = (listener.addr as Deno.NetAddr).port;

  return {
    port,
    addresses: hostAddresses((line) => console.error(line)),
    seen: (nonce: string) => received.has(nonce),
    close: async () => {
      try {
        listener.close();
      } catch {
        // Already closed.
      }
      for (const conn of open) closeQuietly(conn);
      await accepting;
      await Promise.allSettled([...handlers]);
    },
  };
}

/**
 * The production {@link AppleEgressDeps}.
 *
 * @param options - The Apple CLI executable the launch chose
 * @returns Every side effect the lifecycle performs, for real
 */
export function createAppleEgressDeps(
  options: AppleEgressHostOptions,
): AppleEgressDeps {
  return {
    run: (args, timeoutMs) => runBounded(options.runtime, args, timeoutMs),
    startHostListener: () => startAppleHostListener(),
    newNonce: newAppleEgressNonce,
    isProcessAlive: (pid) => probePidAlive(pid),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    log: (line) => console.error(line),
    writeReport: async (path, text) => {
      const written = await atomicWrite({ targetFile: path, content: text });
      if (!written.ok) throw written.error;
    },
    runHost: (command, args) =>
      runBounded(command, args, HOST_COMMAND_TIMEOUT_MS),
  };
}
