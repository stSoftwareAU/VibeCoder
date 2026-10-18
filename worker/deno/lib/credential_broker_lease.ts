/**
 * Host-owned broker lifetime (#3698, #3699).
 *
 * Creation is an in-process trusted-supervisor operation, never an HTTP
 * endpoint. The host supplies the selected account and repository scope;
 * requests cannot mint, expand or renew that authority. The returned local
 * capability contains no upstream credential and works only on this handler.
 */
import {
  createCredentialBroker,
  type CredentialBrokerOptions,
} from "./credential_broker.ts";

/** A revocable handler plus the only value handed across the agent boundary. */
export interface CredentialBrokerLease {
  capability: string;
  handle: (request: Request) => Promise<Response>;
  close: () => void;
  closed: Promise<void>;
}

/** Create one bounded grant from trusted host policy, with no renewal API. */
export function createCredentialBrokerLease(
  options: Omit<CredentialBrokerOptions, "capability" | "signal"> & {
    lifetimeMs: number;
  },
): CredentialBrokerLease {
  if (
    !Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs < 1 ||
    options.lifetimeMs > 86_400_000
  ) throw new Error("Broker lifetime must be an integer from 1 ms to 24 hours");
  const capability = crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const controller = new AbortController();
  const handle = createCredentialBroker({
    ...options,
    capability,
    signal: controller.signal,
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = () => {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    controller.abort(
      new DOMException("Broker session is closed", "AbortError"),
    );
    resolveClosed();
  };
  const timer = setTimeout(close, options.lifetimeMs);
  return { capability, handle, close, closed };
}
