/**
 * Tests for the `.config.json` `callbacks` block (Issue #806, parent #796).
 *
 * The block is the public extension contract's only configuration surface, so
 * every fault must fail the config load loudly rather than leaving an operator
 * with a hook that silently never runs.
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertCallbacksConfig,
  DEFAULT_CALLBACK_TIMEOUT_SECONDS,
  MAX_CALLBACK_TIMEOUT_SECONDS,
  parseCallbacksConfig,
} from "../lib/run_callbacks_config.ts";

function parsed(raw: unknown) {
  const result = parseCallbacksConfig(raw);
  assert(
    result.ok,
    `expected a valid block, got: ${!result.ok && result.error}`,
  );
  return result.value;
}

function error(raw: unknown): string {
  const result = parseCallbacksConfig(raw);
  assert(!result.ok, "expected the block to be rejected");
  return result.error;
}

Deno.test("run_callbacks_config - an absent block configures no hooks", () => {
  for (const raw of [undefined, null]) {
    const config = parsed(raw);
    assertEquals(config.success, undefined);
    assertEquals(config.failure, undefined);
    assertEquals(config.always, undefined);
    assertEquals(config.timeoutSeconds, DEFAULT_CALLBACK_TIMEOUT_SECONDS);
  }
});

Deno.test("run_callbacks_config - an empty block configures no hooks", () => {
  const config = parsed({});
  assertEquals(config.success, undefined);
  assertEquals(config.timeoutSeconds, DEFAULT_CALLBACK_TIMEOUT_SECONDS);
});

Deno.test("run_callbacks_config - all three hooks are optional and independent", () => {
  const config = parsed({ failure: "/opt/hooks/failure.sh" });
  assertEquals(config.success, undefined);
  assertEquals(config.failure, "/opt/hooks/failure.sh");
  assertEquals(config.always, undefined);
});

Deno.test("run_callbacks_config - accepts all three absolute executable paths", () => {
  const config = parsed({
    success: "/opt/hooks/success.sh",
    failure: "/opt/hooks/failure.sh",
    always: "/opt/hooks/always.sh",
  });
  assertEquals(config.success, "/opt/hooks/success.sh");
  assertEquals(config.failure, "/opt/hooks/failure.sh");
  assertEquals(config.always, "/opt/hooks/always.sh");
});

Deno.test("run_callbacks_config - surrounding whitespace is trimmed", () => {
  assertEquals(
    parsed({ success: "  /opt/hooks/s.sh  " }).success,
    "/opt/hooks/s.sh",
  );
});

Deno.test("run_callbacks_config - a relative path is rejected in every mode", () => {
  const message = error({ success: "hooks/success.sh" });
  assert(message.includes("callbacks.success"), message);
  assert(message.includes("absolute"), message);
});

Deno.test("run_callbacks_config - a home-relative path is rejected", () => {
  assert(error({ always: "~/hooks/always.sh" }).includes("absolute"));
});

Deno.test("run_callbacks_config - a non-POSIX absolute path is rejected", () => {
  // The worker runs inside the container, whose filesystem is POSIX.
  assert(error({ success: "C:\\hooks\\success.cmd" }).includes("absolute"));
});

Deno.test("run_callbacks_config - an empty or blank path is rejected", () => {
  assert(error({ success: "" }).includes("callbacks.success"));
  assert(error({ failure: "   " }).includes("callbacks.failure"));
});

Deno.test("run_callbacks_config - a NUL-containing path is rejected", () => {
  const message = error({ always: "/opt/hooks/a\u0000.sh" });
  assert(message.includes("callbacks.always"), message);
  assert(message.includes("NUL"), message);
});

Deno.test("run_callbacks_config - a non-string path is rejected", () => {
  for (const value of [42, true, ["/opt/hooks/s.sh"], { path: "/x" }, null]) {
    const message = error({ success: value });
    assert(message.includes("callbacks.success"), message);
  }
});

Deno.test("run_callbacks_config - a non-object block is rejected", () => {
  for (const raw of ["/opt/hooks/s.sh", 7, true, ["/opt/hooks/s.sh"]]) {
    assert(error(raw).includes("callbacks must be an object"));
  }
});

Deno.test("run_callbacks_config - an unknown key inside the block is rejected", () => {
  const message = error({ succes: "/opt/hooks/s.sh" });
  assert(message.includes("succes"), message);
  assert(message.includes("success"), message);
});

Deno.test("run_callbacks_config - timeout_seconds overrides the default", () => {
  assertEquals(parsed({ timeout_seconds: 5 }).timeoutSeconds, 5);
});

Deno.test("run_callbacks_config - a non-positive or non-integer timeout is rejected", () => {
  for (
    const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "30"]
  ) {
    const message = error({ timeout_seconds: value });
    assert(message.includes("callbacks.timeout_seconds"), message);
  }
});

Deno.test("run_callbacks_config - a timeout above the ceiling is rejected", () => {
  const message = error({ timeout_seconds: MAX_CALLBACK_TIMEOUT_SECONDS + 1 });
  assert(message.includes("callbacks.timeout_seconds"), message);
});

Deno.test("run_callbacks_config - assertCallbacksConfig throws on a fault", () => {
  assertThrows(
    () => assertCallbacksConfig({ success: "relative.sh" }),
    Error,
    "callbacks.success",
  );
});

Deno.test("run_callbacks_config - assertCallbacksConfig returns the parsed block", () => {
  assertEquals(
    assertCallbacksConfig({ success: "/opt/hooks/s.sh" }).success,
    "/opt/hooks/s.sh",
  );
});
