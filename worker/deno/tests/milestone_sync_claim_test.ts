/**
 * The cross-host sync claim (Issue #2030) — real git, with a bare remote.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  claimMilestoneSync,
  DEFAULT_SYNC_CLAIM_TTL_MS,
  releaseMilestoneSyncClaim,
  SYNC_CLAIM_REF_PREFIX,
  syncClaimRef,
} from "../lib/milestone_sync_claim.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  const decode = new TextDecoder();
  if (out.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${decode.decode(out.stderr)}`);
  }
  return decode.decode(out.stdout);
}

const BRANCH = "milestone/2030";

/** A bare origin with a milestone branch, and two clones of it. */
async function fleet(): Promise<
  { origin: string; a: string; b: string; cleanup: () => Promise<void> }
> {
  const root = await Deno.makeTempDir({ prefix: "issue-2030-claim-" });
  const origin = `${root}/origin.git`;
  const seed = `${root}/seed`;
  await git(["init", "-q", "--bare", origin], root);
  // A bare origin whose HEAD names `main`, whatever the runner's
  // `init.defaultBranch` is, so a clone of it checks `main` out.
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
  await git(["init", "-q", "--initial-branch=main", seed], root);
  await git(["config", "user.email", "t@example.com"], seed);
  await git(["config", "user.name", "Test"], seed);
  await Deno.writeTextFile(`${seed}/seed.ts`, "export const v = 1;\n");
  await git(["add", "-A"], seed);
  await git(["commit", "-q", "-m", "Seed"], seed);
  await git(["branch", BRANCH], seed);
  await git(["remote", "add", "origin", origin], seed);
  await git(["push", "-q", "origin", "main", BRANCH], seed);
  const clone = async (name: string): Promise<string> => {
    const dir = `${root}/${name}`;
    await git(["clone", "-q", origin, dir], root);
    await git(["config", "user.email", `${name}@example.com`], dir);
    await git(["config", "user.name", name], dir);
    return dir;
  };
  const a = await clone("host-a");
  const b = await clone("host-b");
  return {
    origin,
    a,
    b,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

async function remoteHasClaim(origin: string): Promise<boolean> {
  const refs = await git([
    "for-each-ref",
    "--format=%(refname)",
    SYNC_CLAIM_REF_PREFIX,
  ], origin);
  return refs.trim().length > 0;
}

Deno.test("syncClaimRef - a hidden ref under the claims namespace; unsafe names refused", () => {
  assertEquals(syncClaimRef(BRANCH), `${SYNC_CLAIM_REF_PREFIX}${BRANCH}`);
  let threw = false;
  try {
    syncClaimRef("--upload-pack=evil");
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(DEFAULT_SYNC_CLAIM_TTL_MS, 2 * 60 * 60 * 1000);
});

Deno.test("claimMilestoneSync - the first host claims; a sibling is told who holds it; release frees it (Issue #2030)", async () => {
  const fx = await fleet();
  try {
    const first = await claimMilestoneSync({
      milestoneBranch: BRANCH,
      options: { cwd: fx.a },
      hostLabel: "host-a",
    });
    assertEquals(first.kind, "claimed");
    assert(await remoteHasClaim(fx.origin), "the claim ref exists on origin");

    const second = await claimMilestoneSync({
      milestoneBranch: BRANCH,
      options: { cwd: fx.b },
      hostLabel: "host-b",
    });
    assertEquals(second.kind, "held-elsewhere");
    if (second.kind === "held-elsewhere") {
      assert(second.ageMs >= 0 && second.ageMs < 60_000);
    }

    const released = await releaseMilestoneSyncClaim(BRANCH, { cwd: fx.a });
    assertEquals(released, { ok: true });
    assertEquals(await remoteHasClaim(fx.origin), false);

    const third = await claimMilestoneSync({
      milestoneBranch: BRANCH,
      options: { cwd: fx.b },
      hostLabel: "host-b",
    });
    assertEquals(third.kind, "claimed");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("claimMilestoneSync - a claim older than the TTL is taken over, atomically (Issue #2030)", async () => {
  const fx = await fleet();
  try {
    const stale = await claimMilestoneSync({
      milestoneBranch: BRANCH,
      options: { cwd: fx.a },
      hostLabel: "host-a",
    });
    assertEquals(stale.kind, "claimed");
    // Host B sees the claim as three hours old.
    const later = await claimMilestoneSync({
      milestoneBranch: BRANCH,
      options: { cwd: fx.b },
      hostLabel: "host-b",
      nowMs: () => Date.now() + 3 * 60 * 60 * 1000,
    });
    assertEquals(later.kind, "claimed");
    if (later.kind === "claimed") assertEquals(later.tookOverStale, true);
    // Host A, back from the dead, now finds B's fresh claim.
    const back = await claimMilestoneSync({
      milestoneBranch: BRANCH,
      options: { cwd: fx.a },
      hostLabel: "host-a",
    });
    assertEquals(back.kind, "held-elsewhere");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("claimMilestoneSync - a clone that cannot see the milestone tip reports unknown, and the caller proceeds", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2030-nogit-" });
  try {
    const outcome = await claimMilestoneSync({
      milestoneBranch: BRANCH,
      options: { cwd: dir },
    });
    assertEquals(outcome.kind, "unknown");
    if (outcome.kind === "unknown") {
      assertStringIncludes(outcome.reason, "milestone tip could not be read");
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
