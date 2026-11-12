/** Competing production updater lanes with independent host-local stores (#4943). */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { updateBranch } from "../../../.claude/skills/review-fleet-prs/scripts/branch_update.ts";
import { createRendezvous } from "./support/rendezvous.ts";
import { runRefreshHost } from "./support/base_refresh_host.ts";
import { fix } from "../commands/fleet_pr_babysitter.ts";
import {
  AUTHOR,
  BASE,
  BASE_SHA,
  FakeFleet,
  headOf,
  movedHeadOf,
  nowSeconds,
  readyPr,
  REPO,
} from "./support/base_refresh_fleet.ts";

const noSleep = async () => {};

/** Separate host-local audit/state directories; only GitHub is shared. */
async function withHosts(
  body: (hosts: { reviewer: string; babysitter: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "refresh_hosts_4943_" });
  const hosts = {
    reviewer: `${root}/reviewer-host`,
    babysitter: `${root}/babysitter-host`,
  };
  await Promise.all(Object.values(hosts).map((dir) => Deno.mkdir(dir)));
  try {
    await body(hosts);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function reviewer(fleet: FakeFleet, host: string, number: number) {
  return updateBranch(
    {
      repo: REPO,
      number,
      headSha: fleet.prs.get(number)!.headRefOid,
      baseRefName: BASE,
    },
    fleet.gh,
    { fleetAuthors: [AUTHOR] },
    undefined,
    { auditDir: host, runId: `reviewer-${number}` },
    noSleep,
  );
}

async function babysitter(
  fleet: FakeFleet,
  host: string,
  number: number,
): Promise<void> {
  const initial = JSON.parse(
    await fleet.gh([
      "pr",
      "view",
      String(number),
      "--json",
      "statusCheckRollup",
    ]),
  );
  await fix(
    REPO,
    initial,
    [AUTHOR],
    AUTHOR,
    { appId: "1", installationId: "1", privateKeyPath: "/unused" },
    "/unused",
    fleet.gh,
    noSleep,
    3,
    { stateDir: host },
  );
}

function publishedFleet() {
  const fleet = new FakeFleet([
    readyPr(10),
    readyPr(11),
    readyPr(12, {
      reviewDecision: "REVIEW_REQUIRED",
    }),
  ]);
  return fleet;
}

Deno.test("production reviewer and babysitter hosts compete: one ready PR receives the strict-base merge; an unreviewed PR never does", async () => {
  await withHosts(async (hosts) => {
    const fleet = publishedFleet();
    // Both hosts reach GitHub's base-lock publication before either verifies
    // ownership. This rendezvous proves overlap without relying on timing.
    const bothPublished = createRendezvous(2);
    fleet.afterComment = async (body) => {
      if (
        !body.startsWith("<!-- BASE_REFRESH_LOCK_4613:") ||
        bothPublished.arrived >= 2
      ) return;
      assertEquals(
        await bothPublished.arrive(),
        2,
        "both production hosts must contend at GitHub",
      );
    };
    await Promise.all([
      runRefreshHost("reviewer", hosts.reviewer, 10, fleet.gh),
      runRefreshHost("babysitter", hosts.babysitter, 11, fleet.gh),
    ]);
    fleet.afterComment = undefined;
    const refreshed = [10, 11].filter((number) =>
      fleet.prs.get(number)!.headRefOid !== headOf(number)
    );
    assertEquals(refreshed.length, 1);
    const selected = refreshed[0]!;
    assertEquals(fleet.parents.get(movedHeadOf(selected)), [
      headOf(selected),
      BASE_SHA,
    ]);
    assertEquals(
      fleet.gate.has(movedHeadOf(selected)),
      false,
      "refresh must await new CI",
    );
    const waiting = selected === 10 ? 11 : 10;
    const waitingHead = fleet.prs.get(waiting)!.headRefOid;
    const refusal = await reviewer(fleet, hosts.reviewer, waiting);
    assertEquals(refusal.updated, false);
    if (!refusal.updated) {
      assertStringIncludes(
        refusal.error,
        `base refresh owned by ${REPO}#${selected}`,
      );
    }
    await babysitter(fleet, hosts.babysitter, waiting);
    await reviewer(fleet, hosts.reviewer, 12);
    await babysitter(fleet, hosts.babysitter, 12);
    assertEquals(fleet.prs.get(waiting)!.headRefOid, waitingHead);
    assertEquals(fleet.prs.get(12)!.headRefOid, headOf(12));
    assertEquals(fleet.ownerPrs(), [selected]);
  });
});

Deno.test("both production updater paths leave an unreviewed behind-only PR untouched when the strict base has no owner", async () => {
  await withHosts(async (hosts) => {
    const fleet = publishedFleet();
    const result = await reviewer(fleet, hosts.reviewer, 12);
    assertEquals(result.updated, false);
    if (!result.updated) {
      assertStringIncludes(result.error, "PR no longer ready");
    }
    await babysitter(fleet, hosts.babysitter, 12);
    assertEquals(fleet.prs.get(12)!.headRefOid, headOf(12));
    assertEquals(fleet.parents.has(movedHeadOf(12)), false);
    assertEquals(fleet.ownerPrs(), []);
  });
});

Deno.test("a human push during refreshed-head validation retains the owner and cannot reuse the previous head's green CI or approval", async () => {
  await withHosts(async (hosts) => {
    const fleet = publishedFleet();
    assertEquals((await reviewer(fleet, hosts.reviewer, 10)).updated, true);
    const refreshedHead = fleet.prs.get(10)!.headRefOid;
    const humanHead = "f".repeat(40);
    const selected = fleet.prs.get(10)!;
    // A human adds a commit while CI is validating the branch refresh.
    selected.headRefOid = humanHead;
    selected.mergeStateStatus = "BEHIND";
    selected.reviewDecision = "REVIEW_REQUIRED";
    fleet.parents.set(humanHead, [refreshedHead]);
    // The old refresh succeeding cannot validate the newer human commit.
    fleet.gate.set(refreshedHead, "success");
    const next = await reviewer(fleet, hosts.reviewer, 11);
    assertEquals(next.updated, false);
    if (!next.updated) {
      assertStringIncludes(next.error, `base refresh owned by ${REPO}#10`);
    }
    await babysitter(fleet, hosts.babysitter, 10);
    assertEquals(fleet.prs.get(10)!.headRefOid, humanHead);
    assertEquals(fleet.prs.get(11)!.headRefOid, headOf(11));
    assertEquals(fleet.parents.get(humanHead), [refreshedHead]);
    fleet.gate.set(humanHead, "success");
    assertEquals(
      (await reviewer(fleet, hosts.reviewer, 10)).updated,
      false,
      "current-head CI alone does not replace approval",
    );
    assertEquals(fleet.ownerPrs(), [10]);
    // A terminal failure on the actual human head releases this validation,
    // allowing the next reviewed candidate to progress.
    fleet.gate.set(humanHead, "failure");
    await babysitter(fleet, hosts.babysitter, 11);
    assertEquals(fleet.prs.get(11)!.headRefOid, movedHeadOf(11));
    assertEquals(fleet.ownerPrs(), [11]);
  });
});

for (const outcome of ["failure", "MERGED", "CLOSED"] as const) {
  Deno.test(`production updater reconciles selected PR ${outcome} and advances the next eligible PR`, async () => {
    await withHosts(async (hosts) => {
      const fleet = publishedFleet();
      assertEquals((await reviewer(fleet, hosts.reviewer, 10)).updated, true);
      const selectedHead = fleet.prs.get(10)!.headRefOid;
      // Pending CI retains ownership and blocks a competing host first.
      await babysitter(fleet, hosts.babysitter, 11);
      assertEquals(fleet.prs.get(11)!.headRefOid, headOf(11));
      if (outcome === "failure") fleet.gate.set(selectedHead, "failure");
      else fleet.prs.get(10)!.state = outcome;
      await babysitter(fleet, hosts.babysitter, 11);
      assertEquals(fleet.prs.get(11)!.headRefOid, movedHeadOf(11));
      assertEquals(fleet.parents.get(movedHeadOf(11)), [headOf(11), BASE_SHA]);
      assertEquals(fleet.ownerPrs(), [11]);
      assertEquals(fleet.prs.get(12)!.headRefOid, headOf(12));
    });
  });
}

Deno.test("a crashed host's owner blocks competitors until its bounded expiry, then the next host progresses", async () => {
  await withHosts(async (hosts) => {
    const fleet = publishedFleet();
    fleet.seedOwner(10, headOf(10), "crashed-host", nowSeconds() + 3600);
    await babysitter(fleet, hosts.babysitter, 11);
    assertEquals(fleet.prs.get(11)!.headRefOid, headOf(11));
    const owner = fleet.comments.find((row) =>
      row.body.startsWith("<!-- BASE_REFRESH_OWNER_4613:")
    )!;
    assert(owner);
    // Model the record after its deadline has passed, without a real sleep.
    owner.body = owner.body.replace(/:\d+ -->$/, `:${nowSeconds() - 1} -->`);
    assertEquals((await reviewer(fleet, hosts.reviewer, 11)).updated, true);
    assertEquals(fleet.prs.get(11)!.headRefOid, movedHeadOf(11));
    assertEquals(fleet.ownerPrs(), [11]);
  });
});

Deno.test("a base advance while selected CI is pending does not let another production host cancel that validation", async () => {
  await withHosts(async (hosts) => {
    const fleet = publishedFleet();
    assertEquals((await reviewer(fleet, hosts.reviewer, 10)).updated, true);
    const selectedHead = fleet.prs.get(10)!.headRefOid;
    fleet.baseSha = "9".repeat(40);
    fleet.prs.get(10)!.mergeStateStatus = "BEHIND";
    await babysitter(fleet, hosts.babysitter, 11);
    assertEquals((await reviewer(fleet, hosts.reviewer, 10)).updated, false);
    assertEquals(fleet.prs.get(10)!.headRefOid, selectedHead);
    assertEquals(fleet.prs.get(11)!.headRefOid, headOf(11));
    assertEquals(fleet.parents.get(selectedHead), [headOf(10), BASE_SHA]);
    assertEquals(fleet.ownerPrs(), [10]);
  });
});
