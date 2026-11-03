import { assertEquals } from "@std/assert";
import {
  babysitterRetryDelayMs,
  babysitterRetryEligible,
  type BabysitterRetryRecord,
  classifyBabysitterBlocker,
  loadBabysitterRetryState,
  saveBabysitterRetryState,
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
});
