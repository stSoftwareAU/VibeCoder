/**
 * Tests for host_escalation.ts — the host identity a HOST-level failure
 * report is named for (Issue #556, Issue #2088).
 *
 * The GitHub issue channel this module once carried was retired with Issue
 * #2088: a host-level failure is handed to `callbacks.host_failure` on the
 * host, so what remains here is the `owner/repo` parse and the host id the
 * hook payload's `host` field carries.
 *
 * Issue #967: every case hands the module its own environment map instead of
 * moving `VIBE_HOST_ID` for every other test in the process. A fall back to
 * `Deno.env.get` therefore fails here rather than passing on the ambient
 * value.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { escalationHostId, parseOriginRepo } from "../lib/host_escalation.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

Deno.test("parseOriginRepo - reads owner/repo from SSH and HTTPS origins", () => {
  assertEquals(
    parseOriginRepo("git@github.com:stSoftwareAU/VibeCoder.git"),
    "stSoftwareAU/VibeCoder",
  );
  assertEquals(
    parseOriginRepo("https://github.com/stSoftwareAU/VibeCoder"),
    "stSoftwareAU/VibeCoder",
  );
  assertEquals(parseOriginRepo("https://example.com/not/github"), null);
});

Deno.test("escalationHostId - the fleet host id wins over the machine name", () => {
  assertEquals(escalationHostId(envFrom({ VIBE_HOST_ID: "GRQ-23" })), "GRQ-23");
});

Deno.test("escalationHostId - no host id falls back to the machine name", () => {
  // The injected map carries no VIBE_HOST_ID, so the hostname branch runs —
  // and a read of the ambient variable (set on every fleet host) would give
  // the fleet id instead and fail here.
  assertEquals(escalationHostId(emptyEnv), Deno.hostname().split(".")[0]);
});
