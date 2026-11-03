import { assertEquals, assertRejects } from "@std/assert";
import {
  BabysitterFailure,
  babysitterRetryDelayMs,
  babysitterRetryEligible,
  type BabysitterRetryRecord,
  buildBabysitterAttemptMarker,
  classifyBabysitterBlocker,
  classifyBabysitterFailure,
  clearBabysitterRetryStates,
  listBabysitterRetryStates,
  loadBabysitterRetryState,
  saveBabysitterRetryState,
  sharedBabysitterAttemptCount,
} from "../lib/babysitter_retry_state.ts";

Deno.test("babysitter retry state migrates a legacy attempt to a bounded retry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const legacyPath = `${dir}/owner--repo--7--${"a".repeat(40)}`;
    await Deno.writeTextFile(legacyPath, "failed CI\n");
    const migrated = await loadBabysitterRetryState({
      stateDir: dir,
      repo: "owner/repo",
      prNumber: 7,
      failureIdentity: "failed CI",
      head: "a".repeat(40),
      legacyPath,
      now: Date.parse("2026-11-03T00:00:00Z"),
    });
    assertEquals(migrated?.lastOutcome, "legacy-attempt");
    assertEquals(migrated?.nextEligibleAt, "2026-11-03T00:05:00.000Z");
    assertEquals(migrated?.attempts.substantive, 0);
    assertEquals(await Deno.readTextFile(legacyPath), "failed CI\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitter retry state survives restart and keeps repair identity across heads", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const record: BabysitterRetryRecord = {
      version: 2,
      repo: "owner/repo",
      prNumber: 7,
      failureIdentity: "failed CI",
      observedHead: "a".repeat(40),
      blockerClass: "code",
      lastOutcome: "no-progress",
      attempts: { infrastructure: 0, substantive: 2 },
      nextEligibleAt: "2026-11-03T00:05:00.000Z",
      nextAction: "change the repair diagnosis before retrying",
      pushedHead: null,
      reconciliation: "repair-needed",
    };
    await saveBabysitterRetryState(dir, record);
    const restored = await loadBabysitterRetryState({
      stateDir: dir,
      repo: "owner/repo",
      prNumber: 7,
      failureIdentity: "failed CI",
      head: "b".repeat(40),
      now: Date.parse("2026-11-03T00:01:00Z"),
    });
    assertEquals(restored?.observedHead, "a".repeat(40));
    assertEquals(restored?.attempts.substantive, 2);
    assertEquals(restored?.nextEligibleAt, record.nextEligibleAt);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitter clears incident state after a merged PR is observed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const record: BabysitterRetryRecord = {
      version: 2,
      repo: "owner/repo",
      prNumber: 7,
      failureIdentity: "failed CI",
      observedHead: "a".repeat(40),
      blockerClass: "unknown",
      lastOutcome: "pushed",
      attempts: { infrastructure: 0, substantive: 1 },
      nextEligibleAt: null,
      nextAction: "wait for merge observation",
      pushedHead: "b".repeat(40),
      reconciliation: "waiting-for-ci-review",
    };
    await saveBabysitterRetryState(dir, record);
    assertEquals(
      (await listBabysitterRetryStates(dir, "owner/repo")).length,
      1,
    );
    await clearBabysitterRetryStates(dir, "owner/repo", 7);
    assertEquals(await listBabysitterRetryStates(dir, "owner/repo"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitter retry classification separates host, race, code and owner outcomes", () => {
  assertEquals(
    classifyBabysitterBlocker("fetch failed: DNS lookup"),
    "infrastructure",
  );
  assertEquals(
    classifyBabysitterBlocker("No space left on device"),
    "capability",
  );
  assertEquals(
    classifyBabysitterBlocker("PR head changed during the fix"),
    "race",
  );
  assertEquals(classifyBabysitterBlocker("test assertion failed"), "code");
  assertEquals(
    classifyBabysitterBlocker("explicit human decision required"),
    "owner",
  );
  assertEquals(babysitterRetryDelayMs("infrastructure", 1), 60_000);
  assertEquals(babysitterRetryDelayMs("capability", 1), 15 * 60_000);
  assertEquals(babysitterRetryDelayMs("race", 2), 60_000);
  assertEquals(babysitterRetryDelayMs("code", 2), 10 * 60_000);
  assertEquals(babysitterRetryDelayMs("unknown", 1), 5 * 60_000);
  assertEquals(babysitterRetryDelayMs("owner", 4), null);
  assertEquals(babysitterRetryEligible(undefined), true);
  assertEquals(
    babysitterRetryEligible({
      version: 2,
      repo: "owner/repo",
      prNumber: 7,
      failureIdentity: "failed CI",
      observedHead: "a".repeat(40),
      blockerClass: "infrastructure",
      lastOutcome: "provider-failure",
      attempts: { infrastructure: 1, substantive: 0 },
      nextEligibleAt: "2026-11-03T00:05:00.000Z",
      nextAction: "retry",
      pushedHead: null,
      reconciliation: "repair-needed",
    }, Date.parse("2026-11-03T00:04:59Z")),
    false,
  );
  assertEquals(
    babysitterRetryEligible({
      version: 2,
      repo: "owner/repo",
      prNumber: 7,
      failureIdentity: "failed CI",
      observedHead: "a".repeat(40),
      blockerClass: "infrastructure",
      lastOutcome: "provider-failure",
      attempts: { infrastructure: 1, substantive: 0 },
      nextEligibleAt: "2026-11-03T00:05:00.000Z",
      nextAction: "retry",
      pushedHead: null,
      reconciliation: "repair-needed",
    }, Date.parse("2026-11-03T00:05:00Z")),
    true,
  );
});

Deno.test("babysitter attempt tally is stable and trusts only fleet authors", () => {
  const first = buildBabysitterAttemptMarker(
    "owner/repo",
    7,
    "failed CI",
    "a".repeat(40),
    1,
    "no-change",
  );
  const afterPush = buildBabysitterAttemptMarker(
    "owner/repo",
    7,
    "failed CI",
    "b".repeat(40),
    2,
    "pushed",
  );
  assertEquals(first.signature, afterPush.signature);
  const comments = [
    {
      id: 1,
      author: "fleet-bot[bot]",
      body: first.marker,
      createdAt: "2026-11-03T00:00:00Z",
    },
    {
      id: 2,
      author: "outsider",
      body: afterPush.marker,
      createdAt: "2026-11-03T00:01:00Z",
    },
  ];
  assertEquals(
    sharedBabysitterAttemptCount(
      comments,
      ["fleet-bot[bot]"],
      first.signature,
    ),
    1,
  );
  assertEquals(
    sharedBabysitterAttemptCount(
      comments,
      ["fleet-bot[bot]"],
      "0".repeat(16),
    ),
    0,
  );
  let unresolved = false;
  try {
    sharedBabysitterAttemptCount(comments, [], first.signature);
  } catch (error) {
    unresolved = error instanceof Error &&
      error.message.includes("Cannot resolve fleet authors");
  }
  assertEquals(unresolved, true);
});

Deno.test("structured failures classify without text matching, with a text fallback", () => {
  assertEquals(
    classifyBabysitterFailure(new BabysitterFailure("plain words", "race")),
    "race",
  );
  assertEquals(
    classifyBabysitterFailure(
      Object.assign(new Error("x"), { code: "ENOSPC" }),
    ),
    "capability",
  );
  assertEquals(
    classifyBabysitterFailure(
      new Error("agent exited unsuccessfully with code 137"),
    ),
    "infrastructure",
  );
  assertEquals(
    classifyBabysitterFailure(
      new Error("agent exited unsuccessfully with code 1"),
    ),
    "code",
  );
  assertEquals(
    classifyBabysitterFailure("token expires soon"),
    "infrastructure",
  );
});

Deno.test("retry records keep bounded evidence and a single escalation across restarts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const record: BabysitterRetryRecord = {
      version: 2,
      repo: "owner/repo",
      prNumber: 7,
      failureIdentity: "failed CI",
      observedHead: "a".repeat(40),
      blockerClass: "code",
      lastOutcome: "no-progress",
      attempts: { infrastructure: 0, substantive: 3 },
      nextEligibleAt: null,
      nextAction: "escalated",
      pushedHead: null,
      reconciliation: "repair-needed",
      evidence: ["one", "two"],
      escalation: { issue: "owner/repo#9", at: "2026-11-03T00:00:00.000Z" },
    };
    await saveBabysitterRetryState(dir, record);
    const [restored] = await listBabysitterRetryStates(dir, "owner/repo");
    assertEquals(restored, record);
    for (
      const broken of [
        { ...record, evidence: "one" },
        { ...record, evidence: [1] },
        { ...record, escalation: "owner/repo#9" },
        { ...record, escalation: { issue: 9, at: "x" } },
        { ...record, escalation: { issue: "x", at: 9 } },
      ]
    ) {
      await Deno.writeTextFile(
        `${dir}/attempt-v2-${
          (await Array.fromAsync(Deno.readDir(dir)))[0]!.name.slice(11, 27)
        }.json`,
        JSON.stringify(broken),
      );
      await assertRejects(
        () => listBabysitterRetryStates(dir, "owner/repo"),
        Error,
        "Invalid babysitter retry state",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
