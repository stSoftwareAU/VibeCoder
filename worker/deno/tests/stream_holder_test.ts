/**
 * Tests for stream affinity — the holder host and its head start (Issue #2336).
 *
 * A milestone stream's conversation lives on one host's disk, so the host that
 * ran it last should get the stream's next issue first. Every test drives the
 * real `stream_holder.ts` functions through an injected `gh` runner and an
 * injected clock, and asserts on the result, the calls made, and the lines
 * logged.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkStreamAffinity,
  decideStreamAffinity,
  formatStreamAffinityDeferral,
  formatStreamHolderMarker,
  parseStreamHolderMarker,
  readStreamHolder,
  resetStreamAffinityState,
  STREAM_AFFINITY_GRACE_SECONDS,
  streamTrackingIssue,
  writeStreamHolder,
} from "../lib/stream_holder.ts";
import { resolveStreamId, streamKey } from "../lib/stream_identity.ts";
import { claimIssue } from "../lib/claim_issue.ts";

const REPO = "stSoftwareAU/VibeCoder";
const MILESTONE = "#2319 session resume on by default";
const NOW = 1_700_000_000;
const FLEET = ["VibeCoderST", "stservice"];
const HOLDER = "GRQ-23-3f2a1b7c-1111-2222-3333-444455556666";
const OTHER = "syd-07-9e8d7c6b-1111-2222-3333-444455556666";

const STREAM = resolveStreamId(REPO, MILESTONE);
const KEY = streamKey(STREAM);

/** A `gh` runner over a fixed comment listing, recording every call. */
function holderGh(comments: unknown[]): {
  ghCommandFn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("--paginate")) {
      return Promise.resolve(JSON.stringify(comments));
    }
    return Promise.resolve("{}");
  };
  return { ghCommandFn, calls };
}

/** One comment row as `fetchMarkerComments`' `--jq` projection renders it. */
function markerComment(
  id: number,
  body: string,
  author = "stservice",
): Record<string, unknown> {
  return { id, body, created_at: new Date(NOW * 1000).toISOString(), author };
}

/** Collect the lines a call logs. */
function capture(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (message: string) => lines.push(message), lines };
}

// ---------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------

Deno.test("stream holder marker - round-trips the stream, host and epoch", () => {
  const marker = formatStreamHolderMarker(KEY, HOLDER, NOW);
  assertStringIncludes(marker, `stream=${KEY}`);
  assertStringIncludes(marker, `host=${HOLDER}`);
  assertStringIncludes(marker, `at=${NOW}`);

  const parsed = parseStreamHolderMarker(`${marker}\nsome visible text`);
  assert(parsed !== null);
  assertEquals(parsed.streamKey, KEY);
  assertEquals(parsed.host, HOLDER);
  assertEquals(parsed.atEpoch, NOW);
});

Deno.test("stream holder marker - a body with no marker parses to null", () => {
  assertEquals(parseStreamHolderMarker("just a comment"), null);
  assertEquals(
    parseStreamHolderMarker("<!-- vibe-stream-holder stream=x -->"),
    null,
  );
});

Deno.test("streamTrackingIssue - the planning issue the milestone was created from", () => {
  assertEquals(streamTrackingIssue(STREAM), 2319);
  // The blank stream has no milestone, so no tracking issue and no affinity.
  assertEquals(streamTrackingIssue(resolveStreamId(REPO, undefined)), null);
  // A milestone not created by planning carries no `#<N>` head.
  assertEquals(
    streamTrackingIssue(resolveStreamId(REPO, "hand-made milestone")),
    null,
  );
});

// ---------------------------------------------------------------------------
// Writing the holder
// ---------------------------------------------------------------------------

Deno.test("writeStreamHolder - posts the marker on the milestone's tracking issue", async () => {
  const { ghCommandFn, calls } = holderGh([]);

  const written = await writeStreamHolder({
    repo: REPO,
    stream: STREAM,
    host: HOLDER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(written, true);
  const post = calls.find((args) => args.includes("POST"));
  assert(post, "a new holder is posted as a comment");
  const joined = post.join(" ");
  assertStringIncludes(joined, `repos/${REPO}/issues/2319/comments`);
  assertStringIncludes(joined, `stream=${KEY}`);
  assertStringIncludes(joined, `host=${HOLDER}`);
});

Deno.test("writeStreamHolder - supersedes the live marker instead of accumulating", async () => {
  const stale = formatStreamHolderMarker(KEY, OTHER, NOW - 900);
  const older = formatStreamHolderMarker(KEY, OTHER, NOW - 1800);
  const { ghCommandFn, calls } = holderGh([
    markerComment(11, older),
    markerComment(22, stale),
  ]);

  const written = await writeStreamHolder({
    repo: REPO,
    stream: STREAM,
    host: HOLDER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(written, true);
  assertEquals(
    calls.some((args) => args.includes("POST")),
    false,
    "an existing marker is rewritten, never duplicated",
  );
  const patch = calls.find((args) => args.includes("PATCH"));
  assert(patch, "the newest marker is rewritten in place");
  assertStringIncludes(
    patch.join(" "),
    "repos/stSoftwareAU/VibeCoder/issues/comments/22",
  );
  assertStringIncludes(patch.join(" "), `host=${HOLDER}`);
  // The leftover from an earlier run is removed, so one live marker survives.
  const deletes = calls.filter((args) => args.includes("DELETE"));
  assertEquals(deletes.length, 1);
  assertStringIncludes(deletes[0]!.join(" "), "/issues/comments/11");
});

Deno.test("writeStreamHolder - another stream's marker is left alone", async () => {
  const otherStream = resolveStreamId(REPO, "#999 another milestone");
  const foreign = formatStreamHolderMarker(
    streamKey(otherStream),
    OTHER,
    NOW - 60,
  );
  const { ghCommandFn, calls } = holderGh([markerComment(33, foreign)]);

  await writeStreamHolder({
    repo: REPO,
    stream: STREAM,
    host: HOLDER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assert(
    calls.some((args) => args.includes("POST")),
    "this stream gets its own marker",
  );
  assertEquals(calls.some((args) => args.includes("DELETE")), false);
  assertEquals(calls.some((args) => args.includes("PATCH")), false);
});

Deno.test("writeStreamHolder - the blank stream has no holder and makes no call", async () => {
  const { ghCommandFn, calls } = holderGh([]);

  const written = await writeStreamHolder({
    repo: REPO,
    stream: resolveStreamId(REPO, undefined),
    host: HOLDER,
    ghCommandFn,
    nowSeconds: NOW,
  });

  assertEquals(written, false);
  assertEquals(calls.length, 0);
});

Deno.test("writeStreamHolder - an unresolvable tracking issue is logged, not raised", async () => {
  const { ghCommandFn, calls } = holderGh([]);
  const { log, lines } = capture();

  const written = await writeStreamHolder({
    repo: REPO,
    stream: resolveStreamId(REPO, "hand-made milestone"),
    host: HOLDER,
    ghCommandFn,
    nowSeconds: NOW,
    log,
  });

  assertEquals(written, false);
  assertEquals(calls.length, 0);
  assert(
    lines.some((line) => line.includes("no tracking issue")),
    `the skipped write must be reported: ${lines.join(" | ")}`,
  );
});

Deno.test("writeStreamHolder - a gh failure is logged, not raised", async () => {
  const { log, lines } = capture();

  const written = await writeStreamHolder({
    repo: REPO,
    stream: STREAM,
    host: HOLDER,
    ghCommandFn: () => Promise.reject(new Error("gh exploded")),
    nowSeconds: NOW,
    log,
  });

  assertEquals(written, false);
  assert(lines.some((line) => line.includes("gh exploded")));
});

// ---------------------------------------------------------------------------
// Reading the holder
// ---------------------------------------------------------------------------

Deno.test("readStreamHolder - returns the newest marker for the stream", async () => {
  const { ghCommandFn } = holderGh([
    markerComment(11, formatStreamHolderMarker(KEY, OTHER, NOW - 900)),
    markerComment(22, formatStreamHolderMarker(KEY, HOLDER, NOW - 60)),
  ]);

  const holder = await readStreamHolder(REPO, STREAM, {
    ghCommandFn,
    trustedAuthors: FLEET,
  });

  assert(holder !== null);
  assertEquals(holder.host, HOLDER);
  assertEquals(holder.atEpoch, NOW - 60);
});

Deno.test("readStreamHolder - a marker from outside the fleet is ignored", async () => {
  const { ghCommandFn } = holderGh([
    markerComment(11, formatStreamHolderMarker(KEY, OTHER, NOW), "a-stranger"),
  ]);

  const holder = await readStreamHolder(REPO, STREAM, {
    ghCommandFn,
    trustedAuthors: FLEET,
  });

  assertEquals(holder, null);
});

Deno.test("readStreamHolder - no marker means no holder", async () => {
  const { ghCommandFn } = holderGh([]);
  assertEquals(
    await readStreamHolder(REPO, STREAM, {
      ghCommandFn,
      trustedAuthors: FLEET,
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// The affinity decision
// ---------------------------------------------------------------------------

Deno.test("decideStreamAffinity - the holder host never defers to itself", () => {
  const decision = decideStreamAffinity({
    holder: { host: HOLDER, atEpoch: NOW - 60 },
    // A second slot on the same host resolves to the same machine, so the
    // conversation on that disk is reachable and there is nothing to wait for.
    thisHost: "GRQ-23-aaaaaaaa-1111-2222-3333-444455556666",
    eligibleSinceSeconds: NOW,
    nowSeconds: NOW,
  });
  assertEquals(decision.defer, false);
  assertEquals(decision.graceExpired, undefined);
});

Deno.test("decideStreamAffinity - no holder recorded means no deferral", () => {
  assertEquals(
    decideStreamAffinity({
      holder: null,
      thisHost: OTHER,
      eligibleSinceSeconds: NOW,
      nowSeconds: NOW,
    }).defer,
    false,
  );
});

Deno.test("decideStreamAffinity - a non-holder defers for the whole grace period", () => {
  const start = decideStreamAffinity({
    holder: { host: HOLDER, atEpoch: NOW - 60 },
    thisHost: OTHER,
    eligibleSinceSeconds: NOW,
    nowSeconds: NOW,
  });
  assertEquals(start.defer, true);
  assertEquals(start.secondsLeft, STREAM_AFFINITY_GRACE_SECONDS);
  assertEquals(start.holderHost, "GRQ-23");

  const midway = decideStreamAffinity({
    holder: { host: HOLDER, atEpoch: NOW - 60 },
    thisHost: OTHER,
    eligibleSinceSeconds: NOW,
    nowSeconds: NOW + STREAM_AFFINITY_GRACE_SECONDS - 30,
  });
  assertEquals(midway.defer, true);
  assertEquals(midway.secondsLeft, 30);
});

Deno.test("decideStreamAffinity - the grace expires exactly at the boundary", () => {
  const expired = decideStreamAffinity({
    holder: { host: HOLDER, atEpoch: NOW - 60 },
    thisHost: OTHER,
    eligibleSinceSeconds: NOW,
    nowSeconds: NOW + STREAM_AFFINITY_GRACE_SECONDS,
  });
  assertEquals(expired.defer, false);
  assertEquals(expired.graceExpired, true);
  assertEquals(expired.holderHost, "GRQ-23");
});

Deno.test("formatStreamAffinityDeferral - names the stream, the host and the countdown", () => {
  assertEquals(
    formatStreamAffinityDeferral(`${REPO}${MILESTONE}`, "GRQ-23", 270),
    `stream affinity: deferring ${REPO}${MILESTONE} to GRQ-23 (270s left)`,
  );
});

// ---------------------------------------------------------------------------
// The claim-path check
// ---------------------------------------------------------------------------

Deno.test("checkStreamAffinity - a non-holder defers and logs the countdown once", async () => {
  resetStreamAffinityState();
  const { ghCommandFn } = holderGh([
    markerComment(22, formatStreamHolderMarker(KEY, HOLDER, NOW - 60)),
  ]);
  const { log, lines } = capture();

  const first = await checkStreamAffinity({
    repo: REPO,
    issueNumber: 2336,
    milestoneTitle: MILESTONE,
    thisHost: OTHER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
    log,
  });

  assertEquals(first.defer, true);
  assertEquals(first.secondsLeft, STREAM_AFFINITY_GRACE_SECONDS);
  assertStringIncludes(first.detail ?? "", "stream affinity: deferring");
  assertStringIncludes(first.detail ?? "", "to GRQ-23");
  assertEquals(lines.length, 1, lines.join(" | "));

  // A second scan inside the grace still defers, and stays quiet.
  const second = await checkStreamAffinity({
    repo: REPO,
    issueNumber: 2336,
    milestoneTitle: MILESTONE,
    thisHost: OTHER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW + 30,
    log,
  });
  assertEquals(second.defer, true);
  assertEquals(second.secondsLeft, STREAM_AFFINITY_GRACE_SECONDS - 30);
  assertEquals(lines.length, 1, "the countdown is logged once, not every scan");
  resetStreamAffinityState();
});

Deno.test("checkStreamAffinity - after the grace the claim proceeds and the reset is logged", async () => {
  resetStreamAffinityState();
  const { ghCommandFn } = holderGh([
    markerComment(22, formatStreamHolderMarker(KEY, HOLDER, NOW - 60)),
  ]);
  const { log, lines } = capture();

  // First sighting starts this host's clock.
  await checkStreamAffinity({
    repo: REPO,
    issueNumber: 2336,
    milestoneTitle: MILESTONE,
    thisHost: OTHER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
    log,
  });

  const taken = await checkStreamAffinity({
    repo: REPO,
    issueNumber: 2336,
    milestoneTitle: MILESTONE,
    thisHost: OTHER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW + STREAM_AFFINITY_GRACE_SECONDS,
    log,
  });

  assertEquals(taken.defer, false);
  assertEquals(taken.graceExpired, true);
  assert(
    lines.some((line) =>
      line.includes("stream session reset: affinity grace expired")
    ),
    `the reset must be logged: ${lines.join(" | ")}`,
  );
  resetStreamAffinityState();
});

Deno.test("checkStreamAffinity - the holder host claims immediately", async () => {
  resetStreamAffinityState();
  const { ghCommandFn } = holderGh([
    markerComment(22, formatStreamHolderMarker(KEY, HOLDER, NOW - 60)),
  ]);

  const decision = await checkStreamAffinity({
    repo: REPO,
    issueNumber: 2336,
    milestoneTitle: MILESTONE,
    thisHost: HOLDER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(decision.defer, false);
  assertEquals(decision.graceExpired, undefined);
  resetStreamAffinityState();
});

Deno.test("checkStreamAffinity - a blank-stream issue is never deferred and costs no call", async () => {
  resetStreamAffinityState();
  const { ghCommandFn, calls } = holderGh([
    markerComment(22, formatStreamHolderMarker(KEY, HOLDER, NOW - 60)),
  ]);

  const decision = await checkStreamAffinity({
    repo: REPO,
    issueNumber: 2336,
    thisHost: OTHER,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(decision.defer, false);
  assertEquals(calls.length, 0);
  resetStreamAffinityState();
});

Deno.test("checkStreamAffinity - a gh outage fails open, loudly", async () => {
  resetStreamAffinityState();
  const { log, lines } = capture();

  const decision = await checkStreamAffinity({
    repo: REPO,
    issueNumber: 2336,
    milestoneTitle: MILESTONE,
    thisHost: OTHER,
    ghCommandFn: () => Promise.reject(new Error("gh exploded")),
    trustedAuthors: FLEET,
    nowSeconds: NOW,
    log,
  });

  assertEquals(decision.defer, false);
  assert(
    lines.some((line) => line.includes("gh exploded")),
    `an unread holder must never pass silently as "no holder": ${
      lines.join(" | ")
    }`,
  );
  resetStreamAffinityState();
});

// ---------------------------------------------------------------------------
// The claim path
// ---------------------------------------------------------------------------

/** A `gh` runner for the whole claim path, with a holder marker attached. */
function claimGh(holderMarkers: unknown[]) {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("--paginate")) {
      return Promise.resolve(JSON.stringify(holderMarkers));
    }
    if (joined.includes("issue list")) return Promise.resolve("[]");
    if (joined.includes("--json assignees")) return Promise.resolve("[]");
    if (joined.includes("--jq .state")) return Promise.resolve("OPEN");
    if (joined.includes("/comments")) return Promise.resolve("[]");
    return Promise.resolve("");
  };
  return { ghCommandFn, calls };
}

Deno.test("claim issue - a non-holder defers the stream's next issue (Issue #2336)", async () => {
  resetStreamAffinityState();
  const { ghCommandFn, calls } = claimGh([
    markerComment(
      22,
      formatStreamHolderMarker(KEY, HOLDER, Math.floor(Date.now() / 1000) - 60),
    ),
  ]);

  const result = await claimIssue({
    repo: REPO,
    issueNumber: 2336,
    githubUser: "stservice",
    workerId: "my-worker",
    hostname: "syd-07",
    fleetAuthors: FLEET,
    milestoneTitle: MILESTONE,
    streamLockEnabled: true,
    sleepFn: () => Promise.resolve(),
    ghCommandFn,
    wasClosedThisRun: () => false,
  });

  assertEquals(result.ok, true);
  assert(result.ok);
  assertEquals(result.value.claimed, false);
  assertEquals(result.value.reason, "stream_affinity");
  assertStringIncludes(
    result.value.reasonDetail ?? "",
    "stream affinity: deferring",
  );
  // A deferred issue collects no assignee and no claim comment.
  assertEquals(
    calls.some((args) => args.join(" ").includes("--add-assignee")),
    false,
  );
  resetStreamAffinityState();
});

Deno.test("claim issue - the holder host claims its own stream immediately (Issue #2336)", async () => {
  resetStreamAffinityState();
  const { ghCommandFn, calls } = claimGh([
    markerComment(
      22,
      formatStreamHolderMarker(
        KEY,
        "syd-07-9e8d7c6b-1111-2222-3333-444455556666",
        Math.floor(Date.now() / 1000) - 60,
      ),
    ),
  ]);

  const result = await claimIssue({
    repo: REPO,
    issueNumber: 2336,
    githubUser: "stservice",
    workerId: "my-worker",
    hostname: "syd-07",
    fleetAuthors: FLEET,
    milestoneTitle: MILESTONE,
    streamLockEnabled: true,
    sleepFn: () => Promise.resolve(),
    ghCommandFn,
    wasClosedThisRun: () => false,
  });

  assertEquals(result.ok, true);
  assert(result.ok);
  assertEquals(result.value.claimed, true);
  assertEquals(
    calls.some((args) => args.join(" ").includes("--add-assignee stservice")),
    true,
  );
  resetStreamAffinityState();
});
