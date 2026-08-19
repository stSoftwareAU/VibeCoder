/**
 * Tests for the Result type pattern (Issue #223).
 *
 * Following TDD: These tests define the expected behaviour for
 * the discriminated union Result type and generic CommandResult.
 */

import { assertEquals } from "@std/assert";
import type { CommandResult, Result } from "../types.ts";

// =============================================================================
// Result<T, E> type — Discriminated union tests
// =============================================================================

Deno.test("Result type - ok result holds typed value", () => {
  const result: Result<string> = { ok: true, value: "hello" };
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "hello");
  }
});

Deno.test("Result type - error result holds error", () => {
  const result: Result<string> = { ok: false, error: new Error("failed") };
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message, "failed");
  }
});

Deno.test("Result type - custom error type", () => {
  interface CustomError {
    code: number;
    detail: string;
  }
  const result: Result<string, CustomError> = {
    ok: false,
    error: { code: 404, detail: "not found" },
  };
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, 404);
    assertEquals(result.error.detail, "not found");
  }
});

Deno.test("Result type - type narrowing with ok check", () => {
  function getResult(succeed: boolean): Result<number> {
    if (succeed) {
      return { ok: true, value: 42 };
    }
    return { ok: false, error: new Error("nope") };
  }

  const success = getResult(true);
  if (success.ok) {
    assertEquals(success.value, 42);
  }

  const failure = getResult(false);
  if (!failure.ok) {
    assertEquals(failure.error.message, "nope");
  }
});

Deno.test("Result type - complex value type", () => {
  interface VersionData {
    version: string;
    runtime: string;
  }
  const result: Result<VersionData> = {
    ok: true,
    value: { version: "1.0.0", runtime: "Deno" },
  };
  if (result.ok) {
    assertEquals(result.value.version, "1.0.0");
    assertEquals(result.value.runtime, "Deno");
  }
});

// =============================================================================
// CommandResult<T> — Generic data typing tests
// =============================================================================

Deno.test("CommandResult - generic data type is accessible", () => {
  interface VersionInfo {
    version: string;
    runtime: string;
  }
  const result: CommandResult<VersionInfo> = {
    success: true,
    message: "v1.0.0",
    data: { version: "1.0.0", runtime: "Deno" },
  };
  assertEquals(result.success, true);
  assertEquals(result.data?.version, "1.0.0");
  assertEquals(result.data?.runtime, "Deno");
});

Deno.test("CommandResult - defaults to unknown when no type parameter", () => {
  const result: CommandResult = {
    success: true,
    message: "ok",
    data: { anything: "goes" },
  };
  assertEquals(result.success, true);
  // Without type parameter, data is unknown — callers must cast
  assertEquals((result.data as Record<string, unknown>)?.anything, "goes");
});

Deno.test("CommandResult - data is optional", () => {
  const result: CommandResult<string> = {
    success: true,
    message: "done",
  };
  assertEquals(result.data, undefined);
});

Deno.test("CommandResult - failure result with typed data", () => {
  interface ErrorDetail {
    code: string;
    failures: string[];
  }
  const result: CommandResult<ErrorDetail> = {
    success: false,
    message: "partial failure",
    data: { code: "PARTIAL", failures: ["item1"] },
  };
  assertEquals(result.success, false);
  assertEquals(result.data?.code, "PARTIAL");
});
