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
import {
  answerCommentsRead,
  type RestComment,
} from "./support/fake_issue_comments.ts";

Deno.test("the marker names its key, and a key outside the allow-list is refused", () => {
  assertEquals(
    gateInfraReleaseMarker("comment-pr_review-12"),
    "<!-- vibe-gate-infra-release key=comment-pr_review-12 -->",
  );
  for (const bad of ["", "a b", 'a"b', "a|b", "a\nb", "x".repeat(81)]) {
    assertThrows(() => gateInfraReleaseMarker(bad), Error, "not allowed");
  }
});

Deno.test("only trusted authors' comments carrying this key's marker count", async () => {
  const comments: RestComment[] = [
    {
      user: { login: "Fleet-Bot" },
      body: `released ${gateInfraReleaseMarker("ci-sig")}`,
    },
    { user: { login: "fleet-bot" }, body: gateInfraReleaseMarker("ci-sig") },
    // Another repair's key, a plain comment and a stranger's copy do not count.
    { user: { login: "fleet-bot" }, body: gateInfraReleaseMarker("ci-sig2") },
    { user: { login: "fleet-bot" }, body: "CI fix pushed" },
    { user: { login: "stranger" }, body: gateInfraReleaseMarker("ci-sig") },
  ];
  const count = await countGateInfraReleases(
    (args) => answerCommentsRead(args, comments),
    "org/repo",
    7,
    "ci-sig",
    ["fleet-bot"],
  );
  assertEquals(count, 2);
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
      () => Promise.resolve(""),
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
