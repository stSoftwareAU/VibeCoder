/**
 * Tests for transient_network_failure.ts (Issue #644).
 *
 * The run this exists for: 7.5 minutes of startup on GRQ-23, then
 *
 *     Fatal error in main loop: gh command failed (exit 1):
 *     Post "https://api.github.com/graphql": unexpected EOF
 *
 * Zero issues processed, and the launcher counted a crash — five consecutive
 * by the time anyone looked, all the same flaky link.
 *
 * The risk in the other direction is the one worth guarding: classifying a
 * REAL failure as transient would retry-and-forget a genuine bug. Half these
 * tests are about what must NOT match.
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatTransientNetworkHalt,
  isTransientNetworkFailure,
} from "../lib/transient_network_failure.ts";

Deno.test("isTransientNetworkFailure - the exact message that ended the GRQ-23 run", () => {
  assert(isTransientNetworkFailure(
    `gh command failed (exit 1): Post "https://api.github.com/graphql": unexpected EOF`,
  ));
});

Deno.test("isTransientNetworkFailure - the DNS failures seen on the same host", () => {
  // These appeared four times in run_core.log on the same day.
  assert(isTransientNetworkFailure(
    "ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known",
  ));
  assert(isTransientNetworkFailure(
    "error connecting to api.github.com\ncheck your internet connection",
  ));
});

Deno.test("isTransientNetworkFailure - transport faults across spellings", () => {
  for (
    const message of [
      `Post "https://api.github.com/graphql": dial tcp 4.237.22.34:443: connect: connection refused`,
      "read tcp 10.0.0.1:443: connection reset by peer",
      "net/http: TLS handshake timeout",
      "dial tcp: lookup api.github.com: no such host",
      "request failed: ETIMEDOUT",
      "503 Service Unavailable",
    ]
  ) {
    assert(
      isTransientNetworkFailure(message),
      `should be transient: ${message}`,
    );
  }
});

Deno.test("isTransientNetworkFailure - matching is case-insensitive", () => {
  assert(isTransientNetworkFailure("UNEXPECTED EOF"));
  assert(isTransientNetworkFailure("Connection Refused"));
});

// ---------------------------------------------------------------------------
// What must NOT be called transient
//
// Treating a deliberate answer from the server as a blip would retry past a
// real bug and lose it — the opposite mistake, and the more expensive one.
// ---------------------------------------------------------------------------

Deno.test("isTransientNetworkFailure - a deliberate server answer is NOT transient", () => {
  for (
    const message of [
      "gh command failed (exit 1): HTTP 404: Not Found",
      "HTTP 403: Resource not accessible by integration",
      "HTTP 422: Validation Failed",
      "GraphQL: Could not resolve to a PullRequest with the number of 999",
    ]
  ) {
    assertEquals(
      isTransientNetworkFailure(message),
      false,
      `should NOT be transient: ${message}`,
    );
  }
});

Deno.test("isTransientNetworkFailure - an ordinary programming fault is NOT transient", () => {
  for (
    const message of [
      "TypeError: Cannot read properties of undefined (reading 'sha')",
      "AssertionError: Values are not equal",
      "No such file or directory (os error 2)",
      "merge conflict in worker/deno/lib/run_core.ts",
    ]
  ) {
    assertEquals(
      isTransientNetworkFailure(message),
      false,
      `should NOT be transient: ${message}`,
    );
  }
});

Deno.test("isTransientNetworkFailure - 'Could not resolve to a PullRequest' is not a DNS failure", () => {
  // The trap: GitHub's GraphQL "Could not resolve to a …" wording sits close
  // to "could not resolve host". They must not be confused — one is a blip,
  // the other is a wrong number the worker asked for.
  assertEquals(
    isTransientNetworkFailure(
      "GraphQL: Could not resolve to a Repository with the name 'org/typo'",
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// What the run says when it stops
// ---------------------------------------------------------------------------

Deno.test("formatTransientNetworkHalt - names the network, not the worker", () => {
  const line = formatTransientNetworkHalt("unexpected EOF", 0);
  // A whole day was spent looking for a worker fault that was never there.
  assertStringIncludes(line, "the network failed, not the worker");
  assertStringIncludes(line, "no issues had been processed yet");
  assertStringIncludes(line, "next cycle retries");
  // The cause survives, so the line is still diagnosable.
  assertStringIncludes(line, "unexpected EOF");
});

Deno.test("formatTransientNetworkHalt - says how much work survived", () => {
  const line = formatTransientNetworkHalt("connection refused", 3);
  assertStringIncludes(line, "3 issue(s) were processed before it did");
});
