/**
 * Tests for `lib/ci_human_gate_comment.ts` (Issue #2727).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildHumanGateComment,
  inertCodeSpan,
} from "../lib/ci_human_gate_comment.ts";

Deno.test("inertCodeSpan - plain text takes a single-backtick fence", () => {
  assertEquals(inertCodeSpan("add the label"), "` add the label `");
});

Deno.test("inertCodeSpan - the fence outruns the longest backtick run", () => {
  assertEquals(inertCodeSpan("a `b` ``c``"), "``` a `b` ``c`` ```");
});

Deno.test("inertCodeSpan - leading and trailing backticks cannot merge with the fence", () => {
  assertEquals(inertCodeSpan("`x`"), "`` `x` ``");
});

Deno.test("buildHumanGateComment - names the check and the step and ends with the marker", () => {
  const body = buildHumanGateComment({
    safeCheckName: "bootstrap-applied",
    humanStep: "ping @owner",
    marker: '<!-- vibe-ci-human-gate check="bootstrap-applied" -->',
  });

  assertStringIncludes(body, "**bootstrap-applied**");
  assertStringIncludes(body, "\n` ping @owner `\n");
  assertEquals(
    body.split("\n").at(-1),
    '<!-- vibe-ci-human-gate check="bootstrap-applied" -->',
  );
});
