/**
 * Base-refresh churn across competing callers (Issue #4943).
 *
 * Several lanes (branch-update loop, PR maintenance, babysitter, auto-merge
 * sweep) and several worker hosts ask requestReadyBranchUpdate for the same
 * strict base with no merge queue. Each call mints its own worker id, so they
 * are separate callers; they share one stateful fake GitHub, which is the only
 * place the base-refresh owner and the update-branch calls are observed.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "../types.ts";
import { requestReadyBranchUpdate } from "../lib/required_branch_checks_4613.ts";

const REPO = "owner/repo";
const BASE = "main";
const BASE_SHA = "c".repeat(40);
const AUTHOR = "VibeCoderST";
const AUTHOR_OPTIONS = { fleetAuthors: [AUTHOR] };
const OWNER_PREFIX = "<!-- BASE_REFRESH_OWNER_4613:";
const OWNER_REFUSAL =
  /^base refresh owned by owner\/repo#10 \(refresh-[0-9a-f-]{36}\)$/;
const noSleep = async () => {};

interface Pr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headRefOid: string;
  mergeSha: string;
  mergeable: "MERGEABLE" | "CONFLICTING";
  mergeStateStatus: "BEHIND" | "DIRTY";
  reviewDecision: "APPROVED" | "REVIEW_REQUIRED";
  autoMergeRequest: unknown;
}

interface CommentRow {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  author: string;
  user: { login: string };
}

interface UpdateCall {
  prNumber: number;
  expectedHead: string | undefined;
}

interface Logged {
  result: Result<void>;
  lines: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Fixed-width SHAs per PR number, so the fake can map a merge commit to its PR. */
const headOf = (n: number) => `${"a".repeat(38)}${pad(n)}`;
const mergeOf = (n: number) => `${"e".repeat(38)}${pad(n)}`;
const movedHeadOf = (n: number) => `${"d".repeat(38)}${pad(n)}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function readyPr(number: number, overrides: Partial<Pr> = {}): Pr {
  return {
    number,
    state: "OPEN",
    isDraft: false,
    headRefOid: headOf(number),
    mergeSha: mergeOf(number),
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
    reviewDecision: "APPROVED",
    autoMergeRequest: {},
    ...overrides,
  };
}

/**
 * Stateful GitHub for one strict base shared by competing callers. Owner
 * comments, PR states and check runs are common to every caller.
 */
class FakeFleet {
  readonly prs = new Map<number, Pr>();
  /** Gate conclusion per head SHA; a missing entry means no check run. */
  readonly gate = new Map<string, string>();
  readonly comments: CommentRow[] = [];
  readonly updates: UpdateCall[] = [];
  readonly liveReads = new Map<number, number>();
  strict = true;
  mergeQueue = false;
  /** Replace a PR's head on its Nth live read (a read that carries isDraft). */
  moveHead: { prNumber: number; atLiveRead: number; to: string } | null = null;
  private nextId = 100;

  constructor(prs: Pr[]) {
    for (const pr of prs) {
      this.prs.set(pr.number, pr);
      this.gate.set(pr.headRefOid, "success");
    }
  }

  readonly gh = async (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    if (args[0] === "pr" && endpoint === "view") {
      return this.view(
        Number(args[2]),
        args.at(-1)?.includes("isDraft") === true,
      );
    }
    if (args[0] === "issue" && endpoint === "comment") {
      const id = this.addComment(args[args.indexOf("--body") + 1]!);
      return `https://github.com/${REPO}/issues/10#issuecomment-${id}`;
    }
    if (args.includes("PUT")) {
      const path = args.find((arg) => arg.endsWith("/update-branch")) ?? "";
      const match = /\/pulls\/(\d+)\/update-branch$/.exec(path);
      if (!match) throw new Error(`Unexpected PUT: ${args.join(" ")}`);
      const expected = args.find((arg) => arg.startsWith("expected_head_sha="));
      this.updates.push({
        prNumber: Number(match[1]),
        expectedHead: expected?.slice("expected_head_sha=".length),
      });
      return "{}";
    }
    if (args.includes("DELETE")) {
      const id = Number(args.at(-1)!.split("/").at(-1));
      const index = this.comments.findIndex((row) => row.id === id);
      if (index >= 0) this.comments.splice(index, 1);
      return "";
    }
    if (endpoint.includes("/comments?")) return JSON.stringify(this.comments);
    if (endpoint.includes("/pulls?state=all")) return "10\n";
    if (endpoint.includes("/rules/branches/")) {
      return JSON.stringify([[
        ...(this.mergeQueue ? [{ type: "merge_queue" }] : []),
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: this.strict,
            required_status_checks: [{ context: "gate" }],
          },
        },
      ]]);
    }
    if (endpoint.includes("/branches/")) {
      return JSON.stringify({ protection: null });
    }
    const commit = /\/commits\/([0-9a-f]{40})\//.exec(endpoint)?.[1];
    if (endpoint.includes("/check-runs?")) {
      const conclusion = commit ? this.gate.get(commit) : undefined;
      return JSON.stringify([{
        check_runs: conclusion === undefined ? [] : [{
          name: "gate",
          status: "completed",
          conclusion,
          app: { id: 1, slug: "external-ci" },
        }],
      }]);
    }
    if (endpoint.includes("/status?")) {
      return JSON.stringify([{ statuses: [] }]);
    }
    const mergeSha = /\/git\/commits\/([0-9a-f]{40})$/.exec(endpoint)?.[1];
    if (mergeSha) {
      const pr = [...this.prs.values()].find((p) => p.mergeSha === mergeSha);
      if (!pr) throw new Error(`Unknown merge commit ${mergeSha}`);
      return JSON.stringify({
        parents: [{ sha: BASE_SHA }, { sha: pr.headRefOid }],
      });
    }
    const number = /\/pulls\/(\d+)$/.exec(endpoint)?.[1];
    if (number) {
      const pr = this.prs.get(Number(number));
      if (!pr) throw new Error(`Unknown PR ${number}`);
      return JSON.stringify({
        state: pr.state === "OPEN" ? "open" : "closed",
        mergeable: pr.mergeable === "MERGEABLE",
        merge_commit_sha: pr.mergeSha,
        head: { sha: pr.headRefOid },
        base: { ref: BASE, sha: BASE_SHA },
      });
    }
    throw new Error(`Unexpected refresh command: ${args.join(" ")}`);
  };

  private view(number: number, live: boolean): string {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no pull request ${number}`);
    if (live) {
      const reads = (this.liveReads.get(number) ?? 0) + 1;
      this.liveReads.set(number, reads);
      const move = this.moveHead;
      if (move && move.prNumber === number && move.atLiveRead === reads) {
        pr.headRefOid = move.to;
      }
    }
    return JSON.stringify({
      state: pr.state,
      isDraft: pr.isDraft,
      baseRefName: BASE,
      headRefOid: pr.headRefOid,
      autoMergeRequest: pr.autoMergeRequest,
      reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
    });
  }

  private addComment(body: string): number {
    const id = this.nextId++;
    const now = new Date().toISOString();
    this.comments.push({
      id,
      body,
      created_at: now,
      updated_at: now,
      author: AUTHOR,
      user: { login: AUTHOR },
    });
    return id;
  }

  /** Seed an owner record as a crashed or stale worker would have left it. */
  seedOwner(
    prNumber: number,
    headSha: string,
    workerId: string,
    expiresAt: number,
  ): void {
    this.addComment(
      `${OWNER_PREFIX}${encodeURIComponent(REPO)}:${
        encodeURIComponent(BASE)
      }:${prNumber}:${headSha}:${
        encodeURIComponent(workerId)
      }:${expiresAt} -->`,
    );
  }

  ownerPrs(): number[] {
    return this.comments
      .filter((row) => row.body.startsWith(OWNER_PREFIX))
      .map((row) => Number(row.body.split(":")[3]));
  }
}

/** Ask for a refresh, capturing the console.warn lines the call emits. */
async function askLogged(
  fleet: FakeFleet,
  prNumber: number,
  source: string,
): Promise<Logged> {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await requestReadyBranchUpdate(
      REPO,
      prNumber,
      fleet.gh,
      BASE,
      undefined,
      noSleep,
      AUTHOR_OPTIONS,
      source,
    );
    return {
      result,
      lines: lines.filter((line) => line.startsWith("[base-refresh]")),
    };
  } finally {
    console.warn = original;
  }
}

/** Assert exactly one bounded diagnostic line for the call, and return it. */
function oneLine(logged: Logged): string {
  assertEquals(logged.lines.length, 1, "one diagnostic line per call");
  const line = logged.lines[0]!;
  assert(line.length <= 600, `diagnostic line is ${line.length} characters`);
  return line;
}

function refusal(result: Result<void>): string {
  if (result.ok) throw new Error("expected the refresh to be refused");
  return result.error.message;
}

Deno.test("two ready behind PRs share one owner: #10 refreshes and #11 is refused for every competing caller", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  const first = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(first.result.ok, true);
  const firstLine = oneLine(first);
  assertStringIncludes(firstLine, "source=branch-update-loop");
  assertStringIncludes(firstLine, "outcome=refresh-requested");
  assertStringIncludes(firstLine, "pr=#10");
  assertStringIncludes(
    firstLine,
    'reason="branch update requested from GitHub"',
  );

  for (const source of ["pr-maintenance", "babysitter-behind"]) {
    const refused = await askLogged(fleet, 11, source);
    assertEquals(OWNER_REFUSAL.test(refusal(refused.result)), true);
    const line = oneLine(refused);
    assertStringIncludes(line, `source=${source}`);
    assertStringIncludes(line, "outcome=refresh-skipped");
    assertStringIncludes(line, "pr=#11");
    assertStringIncludes(line, "owner=#10/refresh-");
  }

  assertEquals(fleet.updates, [{
    prNumber: 10,
    expectedHead: headOf(10),
  }]);
  assertEquals(fleet.ownerPrs(), [10]);
});

const unready: Array<[string, Partial<Pr>]> = [
  ["(a) reviewDecision is REVIEW_REQUIRED", {
    reviewDecision: "REVIEW_REQUIRED",
  }],
  ["(b) no auto-merge request is set", { autoMergeRequest: null }],
  ["(c) the PR is a draft", { isDraft: true }],
  ["(d) mergeable is CONFLICTING, a genuine conflict left to the repair path", {
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
  }],
];

for (const [label, overrides] of unready) {
  Deno.test(`an unready behind-only PR never gets update-branch: ${label}`, async () => {
    const fleet = new FakeFleet([readyPr(10, overrides)]);
    const logged = await askLogged(fleet, 10, "branch-update-loop");
    assertEquals(
      refusal(logged.result),
      "PR no longer ready for a branch update",
    );
    assertStringIncludes(oneLine(logged), "outcome=refresh-skipped");
    assertEquals(fleet.updates, []);
    assertEquals(fleet.ownerPrs(), []);
  });
}

Deno.test("failed required CI on the owner releases the base so the next ready PR refreshes", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  assertEquals(
    (await askLogged(fleet, 10, "branch-update-loop")).result.ok,
    true,
  );
  fleet.gate.set(headOf(10), "failure");
  const next = await askLogged(fleet, 11, "auto-merge-sweep");
  assertEquals(next.result.ok, true);
  assertStringIncludes(oneLine(next), "outcome=refresh-requested");
  assertEquals(fleet.updates.map((u) => u.prNumber), [10, 11]);
  assertEquals(fleet.ownerPrs(), [11]);
});

Deno.test("a merged owner releases the base so the next ready PR refreshes", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  assertEquals(
    (await askLogged(fleet, 10, "branch-update-loop")).result.ok,
    true,
  );
  fleet.prs.get(10)!.state = "MERGED";
  const next = await askLogged(fleet, 11, "auto-merge-sweep");
  assertEquals(next.result.ok, true);
  assertEquals(fleet.updates.map((u) => u.prNumber), [10, 11]);
  assertEquals(fleet.ownerPrs(), [11]);
});

Deno.test("a closed owner releases the base so the next ready PR refreshes", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  assertEquals(
    (await askLogged(fleet, 10, "branch-update-loop")).result.ok,
    true,
  );
  fleet.prs.get(10)!.state = "CLOSED";
  const next = await askLogged(fleet, 11, "auto-merge-sweep");
  assertEquals(next.result.ok, true);
  assertEquals(fleet.updates.map((u) => u.prNumber), [10, 11]);
  assertEquals(fleet.ownerPrs(), [11]);
});

Deno.test("an owner record past its expiry is reconciled away so the next ready PR refreshes", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  fleet.seedOwner(10, headOf(10), "crashed-host", nowSeconds() - 60);
  const next = await askLogged(fleet, 11, "babysitter-behind");
  assertEquals(next.result.ok, true);
  assertStringIncludes(oneLine(next), "outcome=refresh-requested");
  assertEquals(fleet.updates.map((u) => u.prNumber), [11]);
  assertEquals(fleet.ownerPrs(), [11]);
});

Deno.test("an unexpired owner from a crashed worker still blocks the next ready PR", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  fleet.seedOwner(10, headOf(10), "crashed-host", nowSeconds() + 3600);
  const next = await askLogged(fleet, 11, "pr-maintenance");
  assertEquals(
    refusal(next.result),
    "base refresh owned by owner/repo#10 (crashed-host)",
  );
  assertStringIncludes(oneLine(next), "owner=#10/crashed-host");
  assertEquals(fleet.updates, []);
  assertEquals(fleet.ownerPrs(), [10]);
});

Deno.test("a newer push seen on the second live read refuses the refresh before any update-branch call", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.moveHead = { prNumber: 10, atLiveRead: 2, to: movedHeadOf(10) };
  const logged = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(
    refusal(logged.result),
    "PR changed while its required checks were read",
  );
  assertStringIncludes(oneLine(logged), "outcome=refresh-skipped");
  assertEquals(fleet.updates, []);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a newer push seen on the third live read releases the just-acquired owner and sends no update-branch call", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.moveHead = { prNumber: 10, atLiveRead: 3, to: movedHeadOf(10) };
  const logged = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(
    refusal(logged.result),
    "required-check read failed: PR base or head changed before branch update",
  );
  assertEquals(fleet.updates, []);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a merge-queue base refuses the behind-only refresh and writes no ownership comment", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.mergeQueue = true;
  const logged = await askLogged(fleet, 10, "auto-merge-sweep");
  assertEquals(
    refusal(logged.result),
    "merge-queue base is exempt from behind-only refresh",
  );
  assertStringIncludes(oneLine(logged), "outcome=refresh-skipped");
  assertEquals(fleet.updates, []);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a non-strict base keeps the direct update-branch path with no ownership comment", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.strict = false;
  const logged = await askLogged(fleet, 10, "pr-maintenance");
  assertEquals(logged.result.ok, true);
  assertStringIncludes(oneLine(logged), "outcome=refresh-requested");
  assertEquals(fleet.updates, [{
    prNumber: 10,
    expectedHead: headOf(10),
  }]);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a candidate with no required check on its head is refused before any update-branch call", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.gate.delete(headOf(10));
  const logged = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(
    refusal(logged.result),
    "required current-head checks have not passed",
  );
  assertStringIncludes(oneLine(logged), "outcome=refresh-skipped");
  assertEquals(fleet.updates, []);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a candidate whose required check failed on its head is refused before any update-branch call", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.gate.set(headOf(10), "failure");
  const logged = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(
    refusal(logged.result),
    "required current-head checks have not passed",
  );
  assertEquals(fleet.updates, []);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a PR that already owns the base is not blocked by its own record when it asks again", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  const first = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(first.result.ok, true);
  const again = await askLogged(fleet, 10, "auto-merge-sweep");
  assertEquals(again.result.ok, true);
  assertStringIncludes(oneLine(again), "outcome=refresh-requested");
  assertEquals(fleet.updates.map((u) => u.prNumber), [10, 10]);
});
