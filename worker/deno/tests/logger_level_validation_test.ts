/**
 * Tests for `LOG_LEVEL` validation (Issue #3649, SEC-d17c4be9026a).
 *
 * `defaultLogger` used to build its level with an unchecked
 * `Deno.env.get("LOG_LEVEL") as LogLevel` cast. Any value outside the four
 * canonical names — including the very natural lower-case `debug` — reached
 * `shouldLog` as an unknown key, making every `LOG_LEVELS[configured]`
 * lookup `undefined` and every `n >= undefined` comparison false. The result
 * was total log silence, including the `[SECURITY]` lines, with no
 * indication that anything had gone wrong.
 *
 * `parseLogLevel` is the validating boundary: it normalises case, rejects
 * unknown values loudly, and falls back to the default level.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLogger, type LogLevel, parseLogLevel } from "../lib/logger.ts";

Deno.test("parseLogLevel - accepts each canonical level unchanged", () => {
  const levels: LogLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR"];
  for (const level of levels) {
    assertEquals(parseLogLevel(level, () => {}), level);
  }
});

Deno.test("parseLogLevel - normalises case and surrounding whitespace", () => {
  const warnings: string[] = [];
  assertEquals(parseLogLevel("debug", (m) => warnings.push(m)), "DEBUG");
  assertEquals(parseLogLevel("  Warning ", (m) => warnings.push(m)), "WARNING");
  assertEquals(warnings.length, 0, "a recognisable level must not warn");
});

Deno.test("parseLogLevel - returns undefined for unset or empty input", () => {
  const warnings: string[] = [];
  assertEquals(parseLogLevel(undefined, (m) => warnings.push(m)), undefined);
  assertEquals(parseLogLevel("", (m) => warnings.push(m)), undefined);
  assertEquals(parseLogLevel("   ", (m) => warnings.push(m)), undefined);
  assertEquals(warnings.length, 0, "an unset LOG_LEVEL is not a fault");
});

Deno.test("parseLogLevel - rejects an unknown value loudly and falls back", () => {
  const warnings: string[] = [];
  assertEquals(parseLogLevel("verbose", (m) => warnings.push(m)), undefined);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "LOG_LEVEL");
  assertStringIncludes(warnings[0] ?? "", "verbose");
});

Deno.test("parseLogLevel - does not accept inherited Object properties", () => {
  // A prototype key such as `constructor` must not be mistaken for a level.
  const warnings: string[] = [];
  assertEquals(
    parseLogLevel("constructor", (m) => warnings.push(m)),
    undefined,
  );
  assertEquals(parseLogLevel("toString", (m) => warnings.push(m)), undefined);
  assertEquals(warnings.length, 2);
});

Deno.test("logger - a lower-case configured level still emits output", () => {
  // The end-to-end symptom: before the fix, `logLevel: "debug"` silenced
  // every level including ERROR.
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: parseLogLevel("debug", () => {}),
  });

  logger.error("boom");
  logger.info("hello");

  assertEquals(output.length, 2);
  assertStringIncludes(output.join("\n"), "boom");
});

Deno.test("logger - an unknown configured level falls back to INFO, not silence", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: parseLogLevel("nonsense", () => {}),
  });

  logger.error("still audible");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0] ?? "", "still audible");
});
