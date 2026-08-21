/**
 * Tests for `lib/superseding_pr.ts` (Issue #218).
 *
 * The worker's "a PR exists for this issue → treat the run as a success"
 * shortcut could not tell an open PR (work in flight — continue) from a
 * merged or closed one (nothing left for this run to raise). On
 * VibeCoder#185 a sibling host's PR #215 merged mid-run and the shortcut
 * carried the timed-out run onwards into a completion phase whose branch was
 * by then level with `main`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ClassifyExistingPrDeps,
  classifyExistingPrForIssue,
  formatSupersededReason,
} from "../lib/superseding_pr.ts";

/** Deps whose lookup returns `prUrl` and whose `gh pr view` reports `state`. */
function makeDeps(options: {
  prUrl?: string | null;
  state?: string;
  headRefName?: string;
  ghThrows?: boolean;
  lookupThrows?: boolean;
  warns?: string[];
  ghCalls?: string[][];
}): ClassifyExistingPrDeps {
  return {
    findExistingPrForIssue: () => {
      if (options.lookupThrows) throw new Error("gh exploded");
      return Promise.resolve(
        options.prUrl
          ? { ok: true as const, value: options.prUrl }
          : { ok: false as const, error: new Error("No PR found") },
      );
    },
    runGhCommand: (args: string[]) => {
      options.ghCalls?.push(args);
      if (options.ghThrows) return Promise.reject(new Error("gh view failed"));
      return Promise.resolve(JSON.stringify({
        state: options.state ?? "OPEN",
        ...(options.headRefName ? { headRefName: options.headRefName } : {}),
      }));
    },
    ...(options.warns ? { warn: (m: string) => options.warns!.push(m) } : {}),
  };
}

Deno.test("superseding_pr - no PR for the issue classifies as none", async () => {
  const disposition = await classifyExistingPrForIssue(
    "org/repo",
    185,
    makeDeps({ prUrl: null }),
  );
  assertEquals(disposition.kind, "none");
});

Deno.test("superseding_pr - an OPEN PR classifies as open so the run continues", async () => {
  const ghCalls: string[][] = [];
  const disposition = await classifyExistingPrForIssue(
    "org/repo",
    185,
    makeDeps({
      prUrl: "https://github.com/org/repo/pull/215",
      state: "OPEN",
      headRefName: "issue-185-thing",
      ghCalls,
    }),
  );
  assertEquals(disposition.kind, "open");
  assert(disposition.kind === "open");
  assertEquals(disposition.prNumber, 215);
  assertEquals(disposition.headRefName, "issue-185-thing");
  // The state lookup asked about the PR the lookup returned, in the right repo.
  assertEquals(ghCalls.length, 1);
  assert(ghCalls[0]!.includes("215"));
  assert(ghCalls[0]!.includes("org/repo"));
});

Deno.test("superseding_pr - a MERGED PR supersedes the run (Issue #218)", async () => {
  const disposition = await classifyExistingPrForIssue(
    "org/repo",
    185,
    makeDeps({
      prUrl: "https://github.com/org/repo/pull/215",
      state: "MERGED",
    }),
  );
  assert(disposition.kind === "superseded");
  assertEquals(disposition.prState, "MERGED");
  assertEquals(disposition.prNumber, 215);
});

Deno.test("superseding_pr - a CLOSED PR supersedes the run (Issue #218)", async () => {
  const disposition = await classifyExistingPrForIssue(
    "org/repo",
    185,
    makeDeps({ prUrl: "https://github.com/org/repo/pull/99", state: "CLOSED" }),
  );
  assert(disposition.kind === "superseded");
  assertEquals(disposition.prState, "CLOSED");
  assertEquals(disposition.prNumber, 99);
});

Deno.test("superseding_pr - an unreadable PR state fails safe to open, loudly", async () => {
  const warns: string[] = [];
  const disposition = await classifyExistingPrForIssue(
    "org/repo",
    185,
    makeDeps({
      prUrl: "https://github.com/org/repo/pull/215",
      ghThrows: true,
      warns,
    }),
  );
  // Fail-safe: a `gh` hiccup must never invent a "superseded" stop.
  assertEquals(disposition.kind, "open");
  assertEquals(warns.length, 1);
  assert(warns[0]!.includes("215"), warns[0]);
});

Deno.test("superseding_pr - an unrecognised PR state fails safe to open, loudly", async () => {
  const warns: string[] = [];
  const disposition = await classifyExistingPrForIssue(
    "org/repo",
    185,
    makeDeps({
      prUrl: "https://github.com/org/repo/pull/215",
      state: "DRAFTED_SOMEHOW",
      warns,
    }),
  );
  assertEquals(disposition.kind, "open");
  assertEquals(warns.length, 1);
  assert(warns[0]!.includes("DRAFTED_SOMEHOW"), warns[0]);
});

Deno.test("superseding_pr - a throwing lookup classifies as none, never as superseded", async () => {
  const warns: string[] = [];
  const disposition = await classifyExistingPrForIssue(
    "org/repo",
    185,
    makeDeps({ lookupThrows: true, warns }),
  );
  assertEquals(disposition.kind, "none");
  assertEquals(warns.length, 1);
});

Deno.test("superseding_pr - a lookup returning an object reference still classifies", async () => {
  // Several call sites mock the seam with `{ number, url }` rather than a URL
  // string; the classification must not silently degrade to "none".
  const disposition = await classifyExistingPrForIssue("org/repo", 185, {
    findExistingPrForIssue: () =>
      Promise.resolve({
        ok: true,
        value: { number: 215, url: "https://github.com/org/repo/pull/215" },
      }) as never,
    runGhCommand: () => Promise.resolve(JSON.stringify({ state: "MERGED" })),
  });
  assert(disposition.kind === "superseded");
  assertEquals(disposition.prNumber, 215);
});

Deno.test("superseding_pr - the reason names the PR and the preserved WIP", () => {
  const reason = formatSupersededReason(
    {
      kind: "superseded",
      prState: "MERGED",
      prUrl: "https://github.com/org/repo/pull/215",
      prNumber: 215,
    },
    "WIP preserved: committed and pushed to 'issue-185-thing'",
  );
  assert(
    reason.startsWith("superseded:pr#215"),
    `the stable token must lead the reason: ${reason}`,
  );
  assert(reason.includes("merged"), reason);
  assert(reason.includes("issue-185-thing"), reason);
});
