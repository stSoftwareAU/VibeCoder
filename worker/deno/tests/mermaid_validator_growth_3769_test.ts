/**
 * Growth bound for the flowchart mixed-label scan in `validateMermaidBlock`
 * (Issue #3769). Registered in `WALL_CLOCK_TEST_FILES` so it runs in the
 * serial pass; measured by shape, never against a wall-clock constant.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { validateMermaidBlock } from "../lib/mermaid_validator.ts";
import { assertLinearGrowth } from "./support/growth.ts";

Deno.test(
  "validateMermaidBlock - flowchart mixed label: scans hostile input in linear time",
  () => {
    const result = assertLinearGrowth(
      "flowchart mixed-label scan",
      (chars) => {
        const pairs = Math.max(1, Math.floor(chars / 5));
        return `flowchart LR\n  ${"A[(".repeat(pairs)}${")]".repeat(pairs)}`;
      },
      (content) =>
        validateMermaidBlock({ type: "flowchart", content, startLine: 1 }),
      { baseChars: 20_000 },
    );
    assertEquals(result.valid, true);
  },
);
