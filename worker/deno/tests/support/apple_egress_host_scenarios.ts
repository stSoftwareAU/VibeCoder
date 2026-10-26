/**
 * Child-process scenario for `tests/apple_egress_host_test.ts` (Issue #4051).
 *
 * `deno task test:unit` grants no network access by design, so the listener
 * scenario runs here, in a child granted only `--allow-net` for loopback and
 * the wildcard bind, and `--allow-sys=networkInterfaces`. It prints one JSON
 * object on stdout and exits.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  newAppleEgressNonce,
  startAppleHostListener,
} from "../../lib/apple_egress_host.ts";

/** Bounded polls for the listener to record a nonce it was sent. */
const POLL_LIMIT = 500;
const POLL_INTERVAL_MS = 10;

const listener = await startAppleHostListener();
try {
  const nonce = newAppleEgressNonce();
  const other = newAppleEgressNonce();
  const beforeSend = listener.seen(nonce);

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: listener.port,
  });
  const bytes = new TextEncoder().encode(`${nonce}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
  conn.close();

  let afterSend = listener.seen(nonce);
  for (let i = 0; i < POLL_LIMIT && !afterSend; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    afterSend = listener.seen(nonce);
  }

  console.log(
    JSON.stringify({
      port: listener.port,
      addresses: listener.addresses,
      beforeSend,
      afterSend,
      otherSeen: listener.seen(other),
    }),
  );
} finally {
  await listener.close();
}
