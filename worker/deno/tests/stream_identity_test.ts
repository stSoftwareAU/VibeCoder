/**
 * Tests for `lib/stream_identity.ts` — the stream a repository's issues resolve
 * to (Issue #2331).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  isBlankStream,
  resolveStreamId,
  streamKey,
  streamLabel,
} from "../lib/stream_identity.ts";

const REPO = "stSoftwareAU/VibeCoder";
const MILESTONE = "#2319 worker deno lib: session resume on by default";

/** A key must be usable as a single path segment. */
function assertSafePathSegment(key: string): void {
  assert(key.length > 0, "key must not be empty");
  assert(!key.includes("/"), `key must not contain a slash: ${key}`);
  assert(!key.includes("\\"), `key must not contain a backslash: ${key}`);
  assert(!key.includes(".."), `key must not contain "..": ${key}`);
  assert(!key.startsWith("."), `key must not start with a dot: ${key}`);
  assert(
    /^[a-z0-9_-]+$/.test(key),
    `key must be lowercase alphanumeric, "-" and "_" only: ${key}`,
  );
}

Deno.test("resolveStreamId - keeps the repository and milestone title", () => {
  const stream = resolveStreamId(REPO, MILESTONE);
  assertEquals(stream.repo, REPO);
  assertEquals(stream.milestoneTitle, MILESTONE);
  assertEquals(isBlankStream(stream), false);
});

Deno.test("resolveStreamId - undefined milestone is the blank stream", () => {
  const stream = resolveStreamId(REPO, undefined);
  assertEquals(stream.milestoneTitle, undefined);
  assertEquals(isBlankStream(stream), true);
});

Deno.test("resolveStreamId - empty milestone title is the blank stream", () => {
  const stream = resolveStreamId(REPO, "");
  assertEquals(stream.milestoneTitle, undefined);
  assertEquals(isBlankStream(stream), true);
});

Deno.test("resolveStreamId - whitespace-only milestone title is the blank stream", () => {
  const stream = resolveStreamId(REPO, "   ");
  assertEquals(stream.milestoneTitle, undefined);
  assertEquals(isBlankStream(stream), true);
});

Deno.test("resolveStreamId - a surrounding-whitespace title is trimmed, not blanked", () => {
  const stream = resolveStreamId(REPO, `  ${MILESTONE}  `);
  assertEquals(stream.milestoneTitle, MILESTONE);
  assertEquals(isBlankStream(stream), false);
  assertEquals(streamKey(stream), streamKey(resolveStreamId(REPO, MILESTONE)));
});

Deno.test("resolveStreamId - a blank repository fails loud", () => {
  assertThrows(() => resolveStreamId("   ", MILESTONE), Error, "owner/name");
});

Deno.test("resolveStreamId - a repository without an owner fails loud", () => {
  assertThrows(
    () => resolveStreamId("VibeCoder", MILESTONE),
    Error,
    "owner/name",
  );
  assertThrows(() => resolveStreamId("a/b/c", MILESTONE), Error, "owner/name");
  assertThrows(
    () => resolveStreamId("/VibeCoder", MILESTONE),
    Error,
    "owner/name",
  );
});

Deno.test("isBlankStream - a directly built stream with a blank title is blank", () => {
  assertEquals(isBlankStream({ repo: REPO, milestoneTitle: "  " }), true);
  assertEquals(isBlankStream({ repo: REPO }), true);
  assertEquals(isBlankStream({ repo: REPO, milestoneTitle: "x" }), false);
});

Deno.test("streamKey - blank stream key names the repository and the blank suffix", () => {
  const key = streamKey(resolveStreamId(REPO, undefined));
  assertEquals(key, "stsoftwareau__vibecoder__blank");
  assertSafePathSegment(key);
});

Deno.test("streamKey - milestone key carries the slug and a short hash", () => {
  const key = streamKey(resolveStreamId(REPO, "#2319 session resume"));
  assertSafePathSegment(key);
  assert(
    key.startsWith("stsoftwareau__vibecoder__m-2319-session-resume-"),
    `unexpected key: ${key}`,
  );
  const hash = key.slice(key.lastIndexOf("-") + 1);
  assert(
    /^[0-9a-f]{8}$/.test(hash),
    `expected an 8 hex char hash, got: ${hash}`,
  );
});

Deno.test("streamKey - is stable across calls", () => {
  const first = streamKey(resolveStreamId(REPO, MILESTONE));
  const second = streamKey(resolveStreamId(REPO, MILESTONE));
  const third = streamKey({ repo: REPO, milestoneTitle: MILESTONE });
  assertEquals(first, second);
  assertEquals(first, third);
});

Deno.test("streamKey - titles that slug identically get different keys", () => {
  const a = streamKey(resolveStreamId(REPO, "#2298 merge conflicts"));
  const b = streamKey(resolveStreamId(REPO, "#2298: merge conflicts!"));
  assertNotEquals(a, b);
  // Both still slug to the same readable stem, so only the hash separates them.
  assert(a.startsWith("stsoftwareau__vibecoder__m-2298-merge-conflicts-"));
  assert(b.startsWith("stsoftwareau__vibecoder__m-2298-merge-conflicts-"));
  assertSafePathSegment(a);
  assertSafePathSegment(b);
});

Deno.test("streamKey - same milestone title in two repositories differs", () => {
  const mine = streamKey(resolveStreamId("stSoftwareAU/VibeCoder", MILESTONE));
  const theirs = streamKey(
    resolveStreamId("stSoftwareAU/OtherRepo", MILESTONE),
  );
  const elsewhere = streamKey(
    resolveStreamId("otherOwner/VibeCoder", MILESTONE),
  );
  assertNotEquals(mine, theirs);
  assertNotEquals(mine, elsewhere);
  assertNotEquals(theirs, elsewhere);
});

Deno.test("streamKey - blank streams of two repositories differ", () => {
  assertNotEquals(
    streamKey(resolveStreamId("stSoftwareAU/VibeCoder", undefined)),
    streamKey(resolveStreamId("stSoftwareAU/OtherRepo", undefined)),
  );
});

Deno.test("streamKey - a milestone stream never collides with the blank stream", () => {
  assertNotEquals(
    streamKey(resolveStreamId(REPO, "blank")),
    streamKey(resolveStreamId(REPO, undefined)),
  );
});

Deno.test("streamKey - repository names needing sanitising stay distinct", () => {
  const dotted = streamKey(resolveStreamId("owner/my.repo", undefined));
  const dashed = streamKey(resolveStreamId("owner/my-repo", undefined));
  const scored = streamKey(resolveStreamId("owner/my_repo", undefined));
  assertNotEquals(dotted, dashed);
  assertNotEquals(dotted, scored);
  assertNotEquals(dashed, scored);
  for (const key of [dotted, dashed, scored]) assertSafePathSegment(key);
  // A repository already safe as-is keeps its plain, readable form.
  assertEquals(dashed, "owner__my-repo__blank");
});

Deno.test("streamKey - a dot-only repository name yields a safe segment", () => {
  const key = streamKey(resolveStreamId("owner/..", undefined));
  assertSafePathSegment(key);
});

Deno.test("streamKey - a title of only punctuation yields a safe segment", () => {
  const key = streamKey(resolveStreamId(REPO, "!!! ???"));
  assertSafePathSegment(key);
  assert(
    key.startsWith("stsoftwareau__vibecoder__m-"),
    `unexpected key: ${key}`,
  );
});

Deno.test("streamKey - a unicode title yields a safe segment", () => {
  const key = streamKey(resolveStreamId(REPO, "Café ☕ résumé"));
  assertSafePathSegment(key);
  assertNotEquals(key, streamKey(resolveStreamId(REPO, "Café ☕ resume")));
});

Deno.test("streamKey - a very long title is capped", () => {
  const key = streamKey(resolveStreamId(REPO, "word ".repeat(200)));
  assertSafePathSegment(key);
  assert(key.length <= 120, `key too long (${key.length}): ${key}`);
});

Deno.test("streamKey - long titles sharing a prefix stay distinct", () => {
  const stem = "milestone title that runs well past the slug cap ".repeat(4);
  const a = streamKey(resolveStreamId(REPO, `${stem} one`));
  const b = streamKey(resolveStreamId(REPO, `${stem} two`));
  assertNotEquals(a, b);
});

Deno.test("streamKey - a directly built stream with a blank title keys as blank", () => {
  assertEquals(
    streamKey({ repo: REPO, milestoneTitle: "   " }),
    streamKey(resolveStreamId(REPO, undefined)),
  );
});

Deno.test("streamKey - an invalid repository fails loud", () => {
  assertThrows(() => streamKey({ repo: "VibeCoder" }), Error, "owner/name");
});

Deno.test("streamLabel - milestone stream reads as a GitHub reference", () => {
  assertEquals(
    streamLabel(resolveStreamId(REPO, "#2298 merge conflicts")),
    "stSoftwareAU/VibeCoder#2298 merge conflicts",
  );
});

Deno.test("streamLabel - a title without a leading hash is spaced", () => {
  assertEquals(
    streamLabel(resolveStreamId(REPO, "Session resume")),
    "stSoftwareAU/VibeCoder Session resume",
  );
});

Deno.test("streamLabel - blank stream says so", () => {
  assertEquals(
    streamLabel(resolveStreamId(REPO, undefined)),
    "stSoftwareAU/VibeCoder (blank)",
  );
});
