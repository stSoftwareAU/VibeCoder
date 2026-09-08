/**
 * End-to-end regression test for the escalation dedup window (Issue #1619).
 *
 * `escalateToHuman` recognises its own prior hand-off comment by the
 * `<!-- needs-human-escalation: … -->` marker, but it can only see the
 * comments `getIssueComments` fetched. The shim used on that path asked the
 * REST list endpoint with no `per_page`, so GitHub returned the **oldest 30**
 * comments — on NEAT-AI-core#593 (46 comments at the time) the marker sat in
 * comment 47 and was never fetched, and the escalation posted a duplicate
 * 90 seconds after the first.
 *
 * This test drives the real `escalateToHuman` through the real shim with a
 * `ghFn` that mimics GitHub's paging: 30 comments for an un-paged request,
 * all 47 when `per_page=100` is asked for.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createGhEscalationClient } from "../lib/gh_escalation_client.ts";
import {
  buildDedupMarker,
  escalateToHuman,
} from "../lib/needs_human_escalation.ts";
import type { Logger, Result } from "../types.ts";

const FLEET = { fleetAuthors: ["vibe-coder[bot]"] };
const DEDUP_KEY = "content-modified-593";
const NOW = Date.parse("2026-09-08T02:00:00Z");
/** The prior escalation comment, posted 90 seconds before this run. */
const MARKER_AT = new Date(NOW - 90_000).toISOString();

function silentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

function ensureLabelStub(): (
  repo: string,
  name: string,
  colour?: string,
  description?: string,
) => Promise<Result<void>> {
  return () => Promise.resolve({ ok: true, value: undefined } as Result<void>);
}

/**
 * A `ghFn` backed by 47 comments, the last of which carries the dedup marker.
 * It serves the request the way GitHub does: the oldest 30 when no `per_page`
 * is given, and up to 100 per page when it is.
 */
function makeGhWithBusyIssue(): {
  ghFn: (args: string[]) => Promise<string>;
  postedComments: string[];
} {
  const total = 47;
  const all = Array.from({ length: total }, (_unused, index) => ({
    id: index + 1,
    body: index + 1 === total
      ? `## Needs human attention\n\n**Why:** earlier\n\n${
        buildDedupMarker(DEDUP_KEY)
      }`
      : `routine comment ${index + 1}`,
    created_at: index + 1 === total ? MARKER_AT : "2026-09-07T00:00:00Z",
    user: { login: "vibe-coder[bot]" },
  }));
  const postedComments: string[] = [];

  const ghFn = (args: string[]): Promise<string> => {
    // The REST path is the first `repos/...` argument, whichever flags precede it.
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("-X")) {
      if (path.split("?")[0]?.endsWith("/comments")) {
        const bodyArg = args[args.length - 1] ?? "";
        postedComments.push(bodyArg.replace(/^body=/, ""));
      }
      return Promise.resolve("{}");
    }
    if (path.includes("/comments")) {
      const query = path.split("?")[1] ?? "";
      const params = new URLSearchParams(query);
      const perPage = Number(params.get("per_page") ?? "30");
      const page = Number(params.get("page") ?? "1");
      const start = (page - 1) * perPage;
      return Promise.resolve(
        JSON.stringify(all.slice(start, start + perPage)),
      );
    }
    return Promise.resolve("[]");
  };
  return { ghFn, postedComments };
}

Deno.test("escalateToHuman via the gh shim - finds a dedup marker past the oldest 30 comments", async () => {
  const { ghFn, postedComments } = makeGhWithBusyIssue();

  const result = await escalateToHuman({
    ghClient: createGhEscalationClient(ghFn),
    repo: "stSoftwareAU/NEAT-AI-core",
    target: { kind: "issue", number: 593 },
    needsHumanLabel: "needs-human",
    reason: "issue content modified after approval",
    nextStep: "Review the edit and re-approve.",
    dedupKey: DEDUP_KEY,
    githubUser: "vibe-coder[bot]",
    deps: {
      github: { ensureLabelExists: ensureLabelStub() },
      now: () => NOW,
      dedupAuthors: FLEET,
    },
    logger: silentLogger(),
  });

  assert(result.ok, "escalation should succeed");
  assertEquals(result.value.dedupSkipped, true);
  assertEquals(result.value.commentPosted, false);
  assertEquals(postedComments, [], "no duplicate comment should be posted");
});

Deno.test("escalateToHuman via the gh shim - an un-paged fetch of the same issue misses the marker", async () => {
  const { ghFn, postedComments } = makeGhWithBusyIssue();
  // The pre-fix shim, reconstructed against the same 47-comment fixture:
  // one un-paged request, which GitHub answers with the oldest 30 comments.
  // It records the fault being fixed — that an un-paged read of this very
  // issue cannot see the marker — so the contrast with the test above is
  // the paging, not the fixture.
  const unpagedClient = createGhEscalationClient(ghFn);
  const preFixComments = await ghFn([
    "api",
    "repos/stSoftwareAU/NEAT-AI-core/issues/593/comments",
  ]);
  assertEquals(JSON.parse(preFixComments).length, 30);

  const result = await escalateToHuman({
    ghClient: {
      ...unpagedClient,
      getIssueComments: async () => {
        const raw = await ghFn([
          "api",
          "repos/stSoftwareAU/NEAT-AI-core/issues/593/comments",
        ]);
        return JSON.parse(raw).map((entry: Record<string, unknown>) => ({
          id: entry.id as number,
          body: entry.body as string,
          author: "vibe-coder[bot]",
          createdAt: entry.created_at as string,
          reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
        }));
      },
    },
    repo: "stSoftwareAU/NEAT-AI-core",
    target: { kind: "issue", number: 593 },
    needsHumanLabel: "needs-human",
    reason: "issue content modified after approval",
    nextStep: "Review the edit and re-approve.",
    dedupKey: DEDUP_KEY,
    githubUser: "vibe-coder[bot]",
    deps: {
      github: { ensureLabelExists: ensureLabelStub() },
      now: () => NOW,
      dedupAuthors: FLEET,
    },
    logger: silentLogger(),
  });

  assert(result.ok, "escalation should succeed");
  assertEquals(result.value.dedupSkipped, false);
  assertEquals(
    postedComments.length,
    1,
    "the un-paged scan misses comment 47 and posts a duplicate",
  );
});
