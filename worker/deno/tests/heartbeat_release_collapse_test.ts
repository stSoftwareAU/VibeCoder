/**
 * Tests for collapsing repeated release comments into one (Issue #4327,
 * part of #4291).
 *
 * Root cause of #4174's four comments (see the PR description): every
 * claim posts its own CLAIM_LOCK comment and `seedMarkerStateForOwnComment`
 * points the local marker state at it, so each release PATCHed a fresh
 * comment and the released one from the previous attempt (kept with
 * `released: true` by #3751) was never revived. The tests here drive that
 * exact sequence — state seeded to a new comment per claim — through a fake
 * `ghFn` that records every POST / PATCH / DELETE.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appendAttempt,
  clearHeartbeat,
  formatAttemptBlock,
  MAX_ATTEMPTS,
  parseAttemptBlock,
  parseHeartbeatMarker,
  parseReleaseAttemptFromBody,
  releaseClaim,
  renderHeartbeatBody,
  seedMarkerState,
} from "../lib/heartbeat_storage.ts";
import { isHeartbeatOnlyBody } from "../lib/heartbeat_sweep.ts";
import type { RunOutcome } from "../lib/run_outcome.ts";

const HOST_A = "vibe-coder-27384-27d69915-f749-4e3b-9eeb-fda5310a8543";
const HOST_B = "vibe-coder-50110-27d69915-f749-4e3b-9eeb-fda5310a8543";
const TIMEOUT: RunOutcome = {
  kind: "no_pr",
  category: "timeout",
  phase: "execute",
  elapsedSeconds: 58 * 60,
  message: "Claude timed out after 3480s",
};

/** A fake GitHub: comments on one issue, recording every write. */
function fakeIssue(
  initial: { id: number; body: string; author?: string }[] = [],
) {
  const comments = initial.map((c) => ({ author: "Vibecoderbot", ...c }));
  const rec = { posts: 0, patches: [] as number[], deletes: 0, lists: 0 };
  let failListing = false;
  const ghFn = (args: string[]): Promise<string> => {
    if (
      args[0] === "api" && args[1]?.endsWith("/comments") &&
      args.includes("--jq") && !args.includes("-X")
    ) {
      rec.lists++;
      if (failListing) return Promise.reject(new Error("HTTP 502"));
      return Promise.resolve(
        JSON.stringify(
          comments.map((c) => ({ id: c.id, body: c.body, author: c.author })),
        ),
      );
    }
    if (args[0] === "api" && args.includes("PATCH")) {
      const id = parseInt(args[1]!.split("/").pop()!, 10);
      const body = args[args.indexOf("-f") + 1]!.replace(/^body=/, "");
      const c = comments.find((x) => x.id === id);
      if (c) c.body = body;
      rec.patches.push(id);
      return Promise.resolve(JSON.stringify(id));
    }
    if (args[0] === "api" && args.includes("POST")) {
      rec.posts++;
      return Promise.resolve(JSON.stringify({ id: 999 }));
    }
    if (args[0] === "api" && args.includes("DELETE")) {
      rec.deletes++;
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return {
    ghFn,
    rec,
    comments,
    setFailListing: (v: boolean) => {
      failListing = v;
    },
  };
}

/** The claim path's effect: a fresh CLAIM_LOCK+heartbeat comment, state seeded to it. */
async function claim(
  gh: ReturnType<typeof fakeIssue>,
  dir: string,
  machineId: string,
  commentId: number,
  epoch: number,
) {
  gh.comments.push({
    id: commentId,
    author: "Vibecoderbot",
    body: `<!-- CLAIM_LOCK:w-${commentId} --> Claimed by \`w-${commentId}\`\n` +
      renderHeartbeatBody({ machineId, epoch }, () => epoch),
  });
  await seedMarkerState(dir, "stSoftwareAU/VibeCoder", 4174, {
    commentId,
    lastRefresh: epoch,
    claimPrefix: `<!-- CLAIM_LOCK:w-${commentId} -->`,
  });
}

async function release(
  gh: ReturnType<typeof fakeIssue>,
  dir: string,
  machineId: string,
  epoch: number,
  outcome: RunOutcome | undefined = TIMEOUT,
) {
  await clearHeartbeat(
    dir,
    "stSoftwareAU/VibeCoder",
    4174,
    { machineId, ghFn: gh.ghFn, allowedAuthors: ["Vibecoderbot", "stsvcbot"] },
    () => epoch,
    outcome,
  );
}

const T = (h: number, m: number) => h * 3600 + m * 60;

Deno.test("release collapse - #4174 regression: two same-host no-PR releases → one release comment carrying attempts 2, the second claim comment reduced to a pointer; 0 POSTs, 0 DELETEs (Issue #4327)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "collapse-" });
  try {
    const gh = fakeIssue();
    await claim(gh, dir, HOST_A, 5311376184, T(3, 18));
    await release(gh, dir, HOST_A, T(3, 26));
    await claim(gh, dir, HOST_A, 5311535541, T(3, 48));
    await release(gh, dir, HOST_A, T(3, 55));

    const first = gh.comments.find((c) => c.id === 5311376184)!;
    const second = gh.comments.find((c) => c.id === 5311535541)!;
    assertStringIncludes(first.body, "**Attempts on this issue:** 2");
    assertStringIncludes(
      first.body,
      "- 03:26 `vibe-coder-27384` — no PR (`timeout`, phase `execute`)",
    );
    assertStringIncludes(
      first.body,
      "- 03:55 `vibe-coder-27384` — no PR (`timeout`, phase `execute`)",
    );
    // The current outcome stays plainly visible above the tally.
    assertStringIncludes(
      first.body,
      "⚠️ **Vibe Coder released this claim with no PR** — host `vibe-coder-27384`, finished 03:55 UTC.",
    );
    assertStringIncludes(
      second.body,
      "collapsed into the release summary above",
    );
    assertEquals(parseHeartbeatMarker(second.body)?.cleared, true);
    assertEquals(
      isHeartbeatOnlyBody(second.body),
      true,
      "pointer is swept later",
    );
    const releaseComments = gh.comments.filter((c) =>
      c.body.includes("**Attempts on this issue:**") ||
      (c.body.includes("released this claim") &&
        !c.body.includes("collapsed into"))
    );
    assertEquals(
      releaseComments.length,
      1,
      "exactly one comment carries the release",
    );
    assertEquals(gh.rec.posts, 0);
    assertEquals(gh.rec.deletes, 0, "collapse never deletes");
    assertEquals(
      gh.rec.patches.length,
      3,
      "release 1: PATCH A; release 2: PATCH A + pointer B",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release collapse - across two hosts: the second host starts from empty local state and reconstructs the tally from the adopted comment body (Issue #4327)", async () => {
  const dirA = await Deno.makeTempDir({ prefix: "collapse-a-" });
  const dirB = await Deno.makeTempDir({ prefix: "collapse-b-" });
  try {
    const gh = fakeIssue();
    await claim(gh, dirA, HOST_A, 100, T(3, 18));
    await release(gh, dirA, HOST_A, T(3, 26));
    await claim(gh, dirA, HOST_A, 200, T(3, 48));
    await release(gh, dirA, HOST_A, T(3, 55));
    // Host B: different work dir, different machine id.
    await claim(gh, dirB, HOST_B, 300, T(4, 46));
    await release(gh, dirB, HOST_B, T(4, 53));
    await claim(gh, dirB, HOST_B, 400, T(5, 20));
    await release(gh, dirB, HOST_B, T(5, 28));

    const canonical = gh.comments.find((c) => c.id === 100)!;
    assertStringIncludes(canonical.body, "**Attempts on this issue:** 4");
    assertStringIncludes(
      canonical.body,
      "- 04:53 `vibe-coder-50110` — no PR (`timeout`, phase `execute`)",
    );
    assertStringIncludes(
      canonical.body,
      "- 05:28 `vibe-coder-50110` — no PR (`timeout`, phase `execute`)",
    );
    assertStringIncludes(
      canonical.body,
      "host `vibe-coder-50110`, finished 05:28 UTC.",
    );
    for (const id of [200, 300, 400]) {
      const c = gh.comments.find((x) => x.id === id)!;
      assertStringIncludes(c.body, "collapsed into the release summary above");
    }
    assertEquals(gh.rec.posts, 0);
    assertEquals(gh.rec.deletes, 0);
  } finally {
    await Deno.remove(dirA, { recursive: true });
    await Deno.remove(dirB, { recursive: true });
  }
});

Deno.test("release collapse - cold host with no local state adopts the existing release comment on the release path (Issue #4327)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "collapse-cold-" });
  try {
    const gh = fakeIssue([{
      id: 50,
      body: renderHeartbeatBody({
        machineId: HOST_A,
        epoch: 0,
        released: true,
        outcome: TIMEOUT,
      }, () => T(3, 26)),
    }]);
    // No claim seeded here: state absent, as when the claim seed failed or
    // the work dir did not survive.
    await release(gh, dir, HOST_B, T(4, 53));
    const c = gh.comments.find((x) => x.id === 50)!;
    assertStringIncludes(c.body, "**Attempts on this issue:** 2");
    assertStringIncludes(
      c.body,
      "- 03:26 `vibe-coder-27384` — no PR (`timeout`, phase `execute`)",
    );
    assertStringIncludes(
      c.body,
      "- 04:53 `vibe-coder-50110` — no PR (`timeout`, phase `execute`)",
    );
    assertEquals(gh.rec.posts, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release collapse - the attempt list is capped with older entries collapsed into '+N earlier'; render→parse→render round-trips (Issue #4327)", () => {
  let tally = null as ReturnType<typeof appendAttempt> | null;
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
    tally = appendAttempt(tally, {
      epoch: T(1, i),
      host: "h",
      text: `no PR (\`timeout\`, phase \`execute\`)`,
    });
  }
  const block = formatAttemptBlock(tally!);
  assertStringIncludes(
    block,
    `**Attempts on this issue:** ${MAX_ATTEMPTS + 3}`,
  );
  assertStringIncludes(block, "- +3 earlier");
  assertEquals(
    block.split("\n").filter((l) => /^- \d{2}:\d{2} /.test(l)).length,
    MAX_ATTEMPTS,
  );
  const parsed = parseAttemptBlock(
    `prefix\n${block}\n\n**Progress**\n- 01:00 x`,
  );
  assertEquals(parsed?.total, MAX_ATTEMPTS + 3);
  assertEquals(parsed?.attempts.length, MAX_ATTEMPTS);
  assertEquals(
    formatAttemptBlock(parsed!),
    block,
    "render → parse → render is stable",
  );
  // A single attempt renders nothing (today's text unchanged).
  assertEquals(
    formatAttemptBlock({
      total: 1,
      attempts: [{ epoch: 0, host: "h", text: "released" }],
    }),
    "",
  );
  assertEquals(parseAttemptBlock("no block here"), null);
});

Deno.test("release collapse - parseReleaseAttemptFromBody reconstructs the first (block-less) release: pr / no_pr / no_pr_expected / bare (Issue #4327)", () => {
  const at = () => T(3, 26);
  const pr = renderHeartbeatBody({
    machineId: HOST_A,
    epoch: 0,
    released: true,
    outcome: { kind: "pr", prUrl: "u", prNumber: 12 },
  }, at);
  assertEquals(parseReleaseAttemptFromBody(pr), {
    epoch: T(3, 26),
    host: "vibe-coder-27384",
    text: "raised #12",
  });
  const nopr = renderHeartbeatBody({
    machineId: HOST_A,
    epoch: 0,
    released: true,
    outcome: TIMEOUT,
  }, at);
  assertEquals(
    parseReleaseAttemptFromBody(nopr)?.text,
    "no PR (`timeout`, phase `execute`)",
  );
  const expected = renderHeartbeatBody({
    machineId: HOST_A,
    epoch: 0,
    released: true,
    outcome: {
      kind: "no_pr_expected",
      phase: "planning",
      summary: "round posted",
    },
  }, at);
  assertEquals(parseReleaseAttemptFromBody(expected)?.text, "no PR expected");
  const bare = renderHeartbeatBody({
    machineId: HOST_A,
    epoch: 0,
    released: true,
  }, at);
  assertEquals(parseReleaseAttemptFromBody(bare)?.text, "released");
  assertEquals(
    parseReleaseAttemptFromBody(
      renderHeartbeatBody({ machineId: HOST_A, epoch: 5 }),
    ),
    null,
  );
});

Deno.test("release collapse - a body carrying an attempt block still parses cleared and is heartbeat-only for the sweep; a PR release stays visible above the tally (Issue #4327)", () => {
  const body = renderHeartbeatBody({
    machineId: HOST_A,
    epoch: 0,
    released: true,
    outcome: {
      kind: "pr",
      prUrl: "https://github.com/o/r/pull/9",
      prNumber: 9,
    },
    attempts: {
      total: 13,
      attempts: [
        {
          epoch: T(3, 26),
          host: "vibe-coder-27384",
          text: "no PR (`timeout`, phase `execute`)",
        },
        { epoch: T(5, 28), host: "vibe-coder-50110", text: "raised #9" },
      ],
    },
    milestones: [{ epoch: T(5, 0), text: "phase execute started" }],
  }, () => T(5, 28));
  assertEquals(parseHeartbeatMarker(body)?.cleared, true);
  assertEquals(isHeartbeatOnlyBody(body), true, body);
  assertEquals(isHeartbeatOnlyBody(body + "\n\nkeep this open please"), false);
  assert(
    body.indexOf("Raised #9") < body.indexOf("**Attempts on this issue:** 13"),
  );
  assertStringIncludes(body, "- +11 earlier");
  assert(
    body.indexOf("**Attempts on this issue:**") < body.indexOf("**Progress**"),
  );
});

Deno.test("release collapse - listing failure or no fleet comment degrades to today's behaviour and never throws (Issue #4327)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "collapse-fail-" });
  try {
    const gh = fakeIssue();
    await claim(gh, dir, HOST_A, 700, T(3, 18));
    gh.setFailListing(true);
    await release(gh, dir, HOST_A, T(3, 26));
    const own = gh.comments.find((c) => c.id === 700)!;
    assertStringIncludes(
      own.body,
      "⚠️ **Vibe Coder released this claim with no PR** — host `vibe-coder-27384`, finished 03:26 UTC.",
    );
    assert(!own.body.includes("**Attempts on this issue:**"));
    assertEquals(gh.rec.patches, [700]);
    // No local state AND listing fails: nothing to PATCH, nothing thrown.
    const cold = await Deno.makeTempDir({ prefix: "collapse-cold-fail-" });
    try {
      const gh2 = fakeIssue();
      gh2.setFailListing(true);
      const result = await releaseClaim(cold, "stSoftwareAU/VibeCoder", 4174, {
        githubUser: "vibe-bot",
        ghFn: gh2.ghFn,
        markerOptions: { machineId: HOST_B, ghFn: gh2.ghFn },
        outcome: TIMEOUT,
      });
      assert(result.ok);
      assertEquals(gh2.rec.patches.length, 0);
      assertEquals(gh2.rec.posts, 0);
    } finally {
      await Deno.remove(cold, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
