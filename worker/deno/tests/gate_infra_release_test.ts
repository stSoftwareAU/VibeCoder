/**
 * Tests for lib/gate_infra_release.ts: the marker and count that bound how
 * often a repair is released, uncharged, for a pre-push gate infrastructure
 * fault (PR #4896 review).
 *
 * Uses Australian English throughout (behaviour, normalise, etc.).
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  countGateInfraReleases,
  gateInfraReleaseMarker,
  safeGateDetail,
} from "../lib/gate_infra_release.ts";

Deno.test("the marker names its key, and a key outside the allow-list is refused", () => {
  assertEquals(
    gateInfraReleaseMarker("comment-pr_review-12"),
    "<!-- vibe-gate-infra-release key=comment-pr_review-12 -->",
  );
  for (const bad of ["", "a b", 'a"b', "a|b", "a\nb", "x".repeat(81)]) {
    assertThrows(() => gateInfraReleaseMarker(bad), Error, "not allowed");
  }
});

Deno.test("only trusted authors' marked comments count", async () => {
  const calls: string[][] = [];
  const count = await countGateInfraReleases(
    (args) => {
      calls.push(args);
      return Promise.resolve(
        [
          "Fleet-Bot\ttrue",
          "fleet-bot\ttrue",
          "fleet-bot\tfalse",
          "stranger\ttrue",
          "",
        ].join("\n"),
      );
    },
    "org/repo",
    7,
    "ci-sig",
    ["fleet-bot"],
  );
  assertEquals(count, 2);
  assertEquals(calls[0]?.slice(0, 5), [
    "api",
    "repos/org/repo/issues/7/comments",
    "--paginate",
    "--jq",
    calls[0]?.[4],
  ]);
  assertEquals(calls[0]?.length, 5);
  assertEquals(
    calls[0]?.at(-1)?.includes("vibe-gate-infra-release key=ci-sig -->"),
    true,
  );
});

Deno.test("an unreadable PR, or no trusted author, is unknown rather than zero", async () => {
  assertEquals(
    await countGateInfraReleases(
      () => Promise.reject(new Error("gh: 503")),
      "org/repo",
      7,
      "k",
      ["fleet-bot"],
    ),
    null,
  );
  assertEquals(
    await countGateInfraReleases(
      () => Promise.resolve("fleet-bot\ttrue"),
      "org/repo",
      7,
      "k",
      [],
    ),
    null,
  );
  await assertRejects(() =>
    countGateInfraReleases(() => Promise.resolve(""), "org/repo", 7, "a b", [
      "x",
    ])
  );
});

Deno.test("gate detail is one bounded line with no markup", () => {
  const detail = safeGateDetail(`a<!-- x -->\`b\`\r\nc${"d".repeat(500)}`);
  assertEquals(/[<>`\r\n]/.test(detail), false);
  assertEquals(detail.length <= 300, true);
});
