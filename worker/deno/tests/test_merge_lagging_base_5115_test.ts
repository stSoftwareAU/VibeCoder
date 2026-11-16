import { assert, assertEquals } from "@std/assert";
import { requestReadyBranchUpdate } from "../lib/required_branch_checks_4613.ts";
import { classifyTransientBranchRefreshRefusal } from "../lib/branch_refresh_refusal_streak.ts";
import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";

// Issue #5115: GitHub updates pulls/N base.sha and the test merge independently,
// so the test merge may be built on a base commit that is older than base.sha
// and older than the live base tip. The updater must accept it only when that
// parent is an ancestor of (or equal to) the live base tip.

const STALE = "PR test merge parents do not match its head and base";
const BASE_SHA_OLD = "5a8b950".padEnd(40, "0");
const TEST_MERGE_PARENT = "e694d7a".padEnd(40, "0");
const LIVE_TIP = "751f627".padEnd(40, "0");
const HISTORY = [BASE_SHA_OLD, TEST_MERGE_PARENT, LIVE_TIP];

interface Scenario {
  prBaseSha: string;
  scriptedBaseParent: string;
  scriptedHeadParent?: string;
  liveTip: string | null;
  history: string[];
  omitCompareStatus: boolean;
}

const defaults: Scenario = {
  prBaseSha: BASE_SHA_OLD,
  scriptedBaseParent: TEST_MERGE_PARENT,
  liveTip: LIVE_TIP,
  history: HISTORY,
  omitCompareStatus: false,
};

async function run(overrides: Partial<Scenario> = {}) {
  const opts = { ...defaults, ...overrides };
  const f = strictRefreshFixture();
  const refreshes: Array<{ pr: number; expectedHeadSha: string | null }> = [];
  const gh = async (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    // Fake update-branch: record the refresh as state and enforce GitHub's
    // expected-head contract (a mismatched expected head is a 422).
    const update = args.includes("PUT")
      ? args.find((a) =>
        /^repos\/owner\/repo\/pulls\/\d+\/update-branch$/.test(a)
      )
      : undefined;
    if (update) {
      const field = args.find((a) => a.startsWith("expected_head_sha="));
      const expectedHeadSha = field ? field.split("=")[1]! : null;
      if (expectedHeadSha !== null && expectedHeadSha !== f.head) {
        throw new Error("HTTP 422: expected head sha didn't match");
      }
      refreshes.push({
        pr: Number(update.split("/")[4]),
        expectedHeadSha,
      });
      return "{}";
    }
    if (args[0] === "api" && endpoint.endsWith("/pulls/10")) {
      const pr = JSON.parse(await f.gh(args));
      pr.base.sha = opts.prBaseSha;
      return JSON.stringify(pr);
    }
    if (args[0] === "api" && endpoint.includes("/git/commits/")) {
      return JSON.stringify({
        parents: [
          { sha: opts.scriptedBaseParent },
          { sha: opts.scriptedHeadParent ?? f.head },
        ],
      });
    }
    if (args[0] === "api" && endpoint === "repos/owner/repo/branches/main") {
      const branch = JSON.parse(await f.gh(args));
      if (opts.liveTip !== null) branch.commit = { sha: opts.liveTip };
      return JSON.stringify(branch);
    }
    const compare = /^repos\/owner\/repo\/compare\/([^/.]+)\.\.\.([^/.]+)$/
      .exec(endpoint);
    if (args[0] === "api" && compare) {
      const [x, y] = [compare[1]!, compare[2]!];
      const ix = opts.history.indexOf(x);
      const iy = opts.history.indexOf(y);
      let status: string;
      let aheadBy = 0;
      let behindBy = 0;
      if (y === x) {
        status = "identical";
      } else if (ix >= 0 && iy >= 0 && iy < ix) {
        status = "behind";
        behindBy = ix - iy;
      } else if (ix >= 0 && iy >= 0 && iy > ix) {
        status = "ahead";
        aheadBy = iy - ix;
      } else {
        status = "diverged";
        aheadBy = 1;
        behindBy = 1;
      }
      return JSON.stringify(
        opts.omitCompareStatus
          ? { ahead_by: aheadBy, behind_by: behindBy }
          : { status, ahead_by: aheadBy, behind_by: behindBy },
      );
    }
    return f.gh(args);
  };
  const result = await requestReadyBranchUpdate(
    "owner/repo",
    10,
    gh,
    "main",
    f.head,
    async () => {},
    { fleetAuthors: ["VibeCoderST"] },
    "test-5115",
  );
  const owners = f.comments.filter((row) =>
    row.body.includes("BASE_REFRESH_OWNER")
  );
  return { f, result, refreshes, owners };
}

Deno.test("lagging base.sha, test-merge parent and live tip are all accepted when the parent is on the base history (Issue #5115)", async () => {
  const s = await run();
  if (!s.result.ok) throw s.result.error;
  assertEquals(s.refreshes, [{ pr: 10, expectedHeadSha: s.f.head }]);
});

Deno.test("test-merge parent equal to the live tip is accepted while base.sha lags (Issue #5115)", async () => {
  const s = await run({ scriptedBaseParent: LIVE_TIP });
  if (!s.result.ok) throw s.result.error;
  assertEquals(s.refreshes, [{ pr: 10, expectedHeadSha: s.f.head }]);
});

Deno.test("test merge with a head parent other than the PR head is refused (Issue #5115)", async () => {
  const s = await run({
    prBaseSha: BASE_SHA_OLD,
    scriptedBaseParent: BASE_SHA_OLD,
    scriptedHeadParent: "d".repeat(40),
  });
  assertEquals(s.result.ok, false);
  if (!s.result.ok) {
    assert(s.result.error.message.includes(STALE), s.result.error.message);
    assertEquals(
      classifyTransientBranchRefreshRefusal(s.result.error.message),
      "test-merge-parents-stale",
    );
  }
  assertEquals(s.refreshes, []);
  assertEquals(s.owners.length, 0);
});

Deno.test("test-merge parent that is not on the live base history is refused (Issue #5115)", async () => {
  const s = await run({ scriptedBaseParent: "f".repeat(40) });
  assertEquals(s.result.ok, false);
  if (!s.result.ok) {
    assert(s.result.error.message.includes(STALE), s.result.error.message);
    assertEquals(
      classifyTransientBranchRefreshRefusal(s.result.error.message),
      "test-merge-parents-stale",
    );
  }
  assertEquals(s.refreshes, []);
  assertEquals(s.owners.length, 0);
});

Deno.test("test-merge parent newer than the live tip read is refused (Issue #5115)", async () => {
  const s = await run({
    history: [BASE_SHA_OLD, LIVE_TIP, TEST_MERGE_PARENT],
  });
  assertEquals(s.result.ok, false);
  if (!s.result.ok) {
    assert(s.result.error.message.includes(STALE), s.result.error.message);
    assertEquals(
      classifyTransientBranchRefreshRefusal(s.result.error.message),
      "test-merge-parents-stale",
    );
  }
  assertEquals(s.refreshes, []);
  assertEquals(s.owners.length, 0);
});

for (
  const [label, overrides, reason] of [
    [
      "the compare status is not a string",
      { omitCompareStatus: true },
      "base compare status is unreadable",
    ],
    [
      "the live base tip is unreadable",
      { liveTip: null },
      "live base tip is unreadable",
    ],
  ] as const
) {
  Deno.test(`lagging base read fails loud when ${label} (Issue #5115)`, async () => {
    const s = await run({ ...overrides });
    assertEquals(s.result.ok, false);
    if (!s.result.ok) {
      assert(s.result.error.message.includes(reason), s.result.error.message);
    }
    assertEquals(s.refreshes, []);
  });
}
