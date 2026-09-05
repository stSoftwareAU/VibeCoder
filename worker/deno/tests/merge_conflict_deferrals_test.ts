/**
 * Tests for merge_conflict_deferrals.ts — the drain's fairness cursor and its
 * once-per-streak starvation notice (Issue #1111).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  announceDeferralStreak,
  buildDeferralNoticeBody,
  clearDeferral,
  CONFLICT_DEFERRAL_FILE,
  CONFLICT_DEFERRAL_MARKER,
  type ConflictDeferralIo,
  type ConflictDeferralState,
  DEFERRAL_ENTRY_TTL_MS,
  deferralCursor,
  hasOpenDeferralNotice,
  markDeferralNotified,
  parseConflictDeferrals,
  readConflictDeferrals,
  recordDeferral,
  shouldAnnounceDeferral,
  writeConflictDeferrals,
} from "../lib/merge_conflict_deferrals.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
} from "../lib/pr_merge_conflict_scan.ts";

const WORK_DIR = "/work";
const HOUR = 3600_000;
/** The worker's own login, and the only author this dedup trusts. */
const FLEET = "vibe-bot";
const isFleet = (login: string) => login === FLEET;

/** An in-memory work volume, so no test touches a real directory. */
function fakeVolume(): { files: Map<string, string>; io: ConflictDeferralIo } {
  const files = new Map<string, string>();
  return {
    files,
    io: {
      readTextFile: (path) => {
        const data = files.get(path);
        return data === undefined
          ? Promise.reject(new Deno.errors.NotFound(path))
          : Promise.resolve(data);
      },
      writeTextFile: (path, data) => {
        files.set(path, data);
        return Promise.resolve();
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The cursor on the volume
// ---------------------------------------------------------------------------

Deno.test("deferral cursor - survives a restart through the work volume", async () => {
  const volume = fakeVolume();
  const now = 1_700_000_000_000;

  const first: ConflictDeferralState = new Map();
  recordDeferral(first, "org/alpha#1", "repo-leased", now);
  await writeConflictDeferrals(WORK_DIR, first, volume.io, now);

  // A brand-new process: nothing in memory, everything from the volume.
  const reread = await readConflictDeferrals(WORK_DIR, volume.io, now + HOUR);
  assertEquals(reread.get("org/alpha#1")?.streak, 1);
  assertEquals(reread.get("org/alpha#1")?.bound, "repo-leased");
  assert(volume.files.has(`${WORK_DIR}/${CONFLICT_DEFERRAL_FILE}`));
});

Deno.test("deferral cursor - no work directory means no cursor, not a failure", async () => {
  const volume = fakeVolume();
  const state = await readConflictDeferrals(undefined, volume.io, 0);
  assertEquals(state.size, 0);
  await writeConflictDeferrals(undefined, state, volume.io, 0);
  assertEquals(volume.files.size, 0);
});

Deno.test("deferral cursor - a corrupt file reads as an empty cursor", async () => {
  const volume = fakeVolume();
  volume.files.set(`${WORK_DIR}/${CONFLICT_DEFERRAL_FILE}`, "{not json");
  assertEquals((await readConflictDeferrals(WORK_DIR, volume.io, 0)).size, 0);
  assertEquals(
    parseConflictDeferrals('{"org/a#1":{"streak":"lots"}}', 0).size,
    0,
  );
  assertEquals(parseConflictDeferrals("[1,2,3]", 0).size, 0);
});

Deno.test("deferral cursor - an unwritable volume warns and keeps the pass alive", async () => {
  const warnings: string[] = [];
  const io: ConflictDeferralIo = {
    readTextFile: () => Promise.reject(new Error("no volume")),
    writeTextFile: () => Promise.reject(new Error("read-only volume")),
  };
  const state: ConflictDeferralState = new Map();
  recordDeferral(state, "org/alpha#1", "cap", 1);

  await writeConflictDeferrals(WORK_DIR, state, io, 1, (m) => warnings.push(m));

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "read-only volume");
  assertStringIncludes(warnings[0] ?? "", "Issue #1111");
});

Deno.test("deferral cursor - entries that aged out are pruned, not kept forever", async () => {
  const volume = fakeVolume();
  const now = 1_700_000_000_000;
  const state: ConflictDeferralState = new Map();
  recordDeferral(state, "org/merged#1", "cap", now);
  await writeConflictDeferrals(WORK_DIR, state, volume.io, now);

  const later = now + DEFERRAL_ENTRY_TTL_MS + HOUR;
  assertEquals(
    (await readConflictDeferrals(WORK_DIR, volume.io, later)).size,
    0,
  );

  await writeConflictDeferrals(WORK_DIR, state, volume.io, later);
  assertEquals(volume.files.get(`${WORK_DIR}/${CONFLICT_DEFERRAL_FILE}`), "{}");
});

// ---------------------------------------------------------------------------
// Streaks and ordering
// ---------------------------------------------------------------------------

Deno.test("recordDeferral - counts consecutive passes and keeps the first timestamp", () => {
  const state: ConflictDeferralState = new Map();
  const first = recordDeferral(state, "org/a#1", "repo-leased", 1_000);
  const second = recordDeferral(state, "org/a#1", "deadline", 5_000);

  assertEquals(first.streak, 1);
  assertEquals(second.streak, 2);
  assertEquals(second.bound, "deadline");
  assertEquals(second.firstDeferredAtMs, 1_000);
  assertEquals(second.lastDeferredAtMs, 5_000);
});

Deno.test("clearDeferral - an attempt ends the streak outright", () => {
  const state: ConflictDeferralState = new Map();
  recordDeferral(state, "org/a#1", "cap", 1_000);
  recordDeferral(state, "org/a#1", "cap", 2_000);
  clearDeferral(state, "org/a#1");
  assertEquals(state.has("org/a#1"), false);

  // The next streak starts from one, not from where the old one stopped.
  assertEquals(recordDeferral(state, "org/a#1", "cap", 3_000).streak, 1);
});

Deno.test("deferralCursor - the most starved PR leads, then the longest waiting", () => {
  const state: ConflictDeferralState = new Map();
  recordDeferral(state, "org/new#3", "cap", 9_000);
  recordDeferral(state, "org/old#1", "repo-leased", 1_000);
  recordDeferral(state, "org/old#1", "repo-leased", 2_000);
  recordDeferral(state, "org/mid#2", "deadline", 5_000);
  recordDeferral(state, "org/mid#2", "deadline", 6_000);

  assertEquals(deferralCursor(state), [
    "org/old#1", // streak 2, waiting since 1_000
    "org/mid#2", // streak 2, waiting since 5_000
    "org/new#3", // streak 1
  ]);
});

// ---------------------------------------------------------------------------
// When a streak earns its comment
// ---------------------------------------------------------------------------

Deno.test("shouldAnnounceDeferral - needs the streak and more than one window", () => {
  const state: ConflictDeferralState = new Map();
  const start = 1_700_000_000_000;
  recordDeferral(state, "org/a#1", "repo-leased", start);
  recordDeferral(state, "org/a#1", "repo-leased", start + 60_000);
  // Three deferrals, but seven minutes apart: a busy cycle, not starvation.
  const quick = recordDeferral(
    state,
    "org/a#1",
    "repo-leased",
    start + 120_000,
  );
  assertEquals(shouldAnnounceDeferral(quick), false);

  const spanned = recordDeferral(
    state,
    "org/a#1",
    "repo-leased",
    start + 5 * HOUR,
  );
  assertEquals(shouldAnnounceDeferral(spanned), true);

  // Two deferrals over a long span is still not the configured streak.
  const shortStreak: ConflictDeferralState = new Map();
  recordDeferral(shortStreak, "org/b#2", "cap", start);
  const second = recordDeferral(
    shortStreak,
    "org/b#2",
    "cap",
    start + 5 * HOUR,
  );
  assertEquals(shouldAnnounceDeferral(second), false);

  // Bounds are configurable, and the notice fires once per streak only.
  assertEquals(
    shouldAnnounceDeferral(second, { streak: 2, minSpanMs: HOUR }),
    true,
  );
  markDeferralNotified(shortStreak, "org/b#2");
  assertEquals(
    shouldAnnounceDeferral(shortStreak.get("org/b#2")!, {
      streak: 2,
      minSpanMs: HOUR,
    }),
    false,
  );
});

Deno.test("buildDeferralNoticeBody - names the bound, the streak and what was not spent", () => {
  const state: ConflictDeferralState = new Map();
  const start = 1_700_000_000_000;
  recordDeferral(state, "org/a#7", "repo-leased", start);
  recordDeferral(state, "org/a#7", "repo-leased", start + HOUR);
  const entry = recordDeferral(
    state,
    "org/a#7",
    "repo-leased",
    start + 5 * HOUR,
  );

  const body = buildDeferralNoticeBody(7, entry);
  assertStringIncludes(body, CONFLICT_DEFERRAL_MARKER);
  assertStringIncludes(body, 'n="3"');
  assertStringIncludes(body, 'bound="repo-leased"');
  assertStringIncludes(body, "deferred 3 times in a row");
  assertStringIncludes(body, "PR #7");
  assertStringIncludes(body, new Date(start).toISOString());
  assertStringIncludes(body, "two-attempt");
  // A notice must never look like an attempt to the scan's own parser.
  assertEquals(body.includes(CONFLICT_ATTEMPT_MARKER), false);
});

// ---------------------------------------------------------------------------
// The marker: once per streak, across restarts and across hosts
// ---------------------------------------------------------------------------

Deno.test("hasOpenDeferralNotice - an attempt or a conclusion ends the streak the marker belongs to", () => {
  const notice = {
    body: `${CONFLICT_DEFERRAL_MARKER} n="3" -->`,
    user: { login: FLEET },
  };
  const check = (comments: readonly unknown[]) =>
    hasOpenDeferralNotice(comments, isFleet);

  assertEquals(check([]), false);
  assertEquals(check([notice]), true);
  assertEquals(
    check([notice, { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->` }]),
    false,
  );
  assertEquals(
    check([notice, { body: `${CONFLICT_FAILED_MARKER} n="1" -->` }]),
    false,
  );
  assertEquals(check([notice, { body: CONFLICT_RESOLVED_MARKER }]), false);
  assertEquals(
    check([notice, { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->` }, notice]),
    true,
  );
  // Junk on the thread is ignored rather than throwing.
  assertEquals(check([null, 7, { body: 3 }, notice]), true);
});

Deno.test("hasOpenDeferralNotice - a marker nobody trusted wrote is not a guard", () => {
  // On a public repository the body is text anybody may post. Trusting it
  // would let an unprivileged account silence the starvation notice for good
  // (`marker_dedup_author_manifest.ts`), so an untrusted marker is ignored —
  // failing towards posting, not towards silence.
  const forged = {
    body: `${CONFLICT_DEFERRAL_MARKER} n="9" -->`,
    user: { login: "drive-by" },
  };
  assertEquals(hasOpenDeferralNotice([forged], isFleet), false);
  // An anonymous entry with no author at all is no better.
  assertEquals(
    hasOpenDeferralNotice(
      [{ body: `${CONFLICT_DEFERRAL_MARKER} -->` }],
      isFleet,
    ),
    false,
  );
});

/** A PR comment thread plus the `gh` seam two "hosts" both talk to. */
function fakeThread(repo: string, prNumber: number) {
  const comments: { body: string; user: { login: string } }[] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      const page = (args[1] ?? "").includes("page=1") ? comments : [];
      return Promise.resolve(JSON.stringify(page));
    }
    if (args[0] === "pr" && args[1] === "comment") {
      assertEquals(args[2], String(prNumber));
      assertEquals(args[4], repo);
      assertEquals(args[5], "--body");
      comments.push({ body: args[6] ?? "", user: { login: FLEET } });
      return Promise.resolve("");
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { comments, ghCommandFn };
}

Deno.test("announceDeferralStreak - a second host posts nothing on top of the first", async () => {
  const thread = fakeThread("org/alpha", 7);
  const state: ConflictDeferralState = new Map();
  const start = 1_700_000_000_000;
  recordDeferral(state, "org/alpha#7", "cap", start);
  recordDeferral(state, "org/alpha#7", "cap", start + HOUR);
  const entry = recordDeferral(state, "org/alpha#7", "cap", start + 5 * HOUR);
  const notice = { repo: "org/alpha", prNumber: 7, entry };
  const options = {
    ghCommandFn: thread.ghCommandFn,
    isTrustedAuthor: isFleet,
  };

  // Host A, with an empty cursor of its own, posts.
  assertEquals(await announceDeferralStreak(notice, options), true);
  // Host B has never seen host A's volume — the marker on the PR is the guard.
  assertEquals(await announceDeferralStreak(notice, options), false);
  // And the same host after a restart is no different.
  assertEquals(await announceDeferralStreak(notice, options), false);
  assertEquals(thread.comments.length, 1);
});

Deno.test("announceDeferralStreak - an attempt since the notice opens the next streak", async () => {
  const thread = fakeThread("org/alpha", 7);
  const state: ConflictDeferralState = new Map();
  const start = 1_700_000_000_000;
  recordDeferral(state, "org/alpha#7", "cap", start);
  const entry = recordDeferral(state, "org/alpha#7", "cap", start + 5 * HOUR);
  const notice = { repo: "org/alpha", prNumber: 7, entry };
  const options = {
    ghCommandFn: thread.ghCommandFn,
    isTrustedAuthor: isFleet,
  };

  assertEquals(await announceDeferralStreak(notice, options), true);
  thread.comments.push({
    body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
    user: { login: FLEET },
  });
  // The old notice belongs to the streak that attempt ended.
  assertEquals(await announceDeferralStreak(notice, options), true);
  assertEquals(thread.comments.length, 3);
});

Deno.test("announceDeferralStreak - a GitHub failure is raised, never swallowed", async () => {
  const failing = () => Promise.reject(new Error("gh api exploded"));
  const state: ConflictDeferralState = new Map();
  const entry = recordDeferral(state, "org/alpha#7", "deadline", 1);

  let thrown: unknown;
  try {
    await announceDeferralStreak(
      { repo: "org/alpha", prNumber: 7, entry },
      { ghCommandFn: failing, isTrustedAuthor: isFleet },
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals((thrown as Error)?.message, "gh api exploded");
});
