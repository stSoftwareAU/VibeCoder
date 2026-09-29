/**
 * Tests for the partial milestone rollup (Issue #2830).
 *
 * A fake `gh` models just enough of GitHub — PRs, branch refs, the compare
 * endpoint and milestones — for the creator and the full-rollup gates to run
 * against the same state.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createPartialRollup,
  listMergedPartialRollupHeads,
  partialRollupMarker,
} from "../lib/milestone_partial_rollup.ts";
import { hasExistingMilestoneSummaryPr } from "../lib/milestone_completion.ts";
import {
  decideMilestoneBaseMerge,
  isMilestoneBranch,
} from "../lib/milestone_children_gate.ts";

const REPO = "owner/repo";
const TITLE = "Deadlock Breaker";
const BRANCH = "milestone/deadlock-breaker";
const DEFAULT = "main";
const TIP = "abcdef1234567890abcdef1234567890abcdef12";
const SNAPSHOT = "partial-rollup/deadlock-breaker-abcdef1";

interface FakePr {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  body: string;
  state: "OPEN" | "MERGED";
}

class FakeGitHub {
  prs: FakePr[] = [];
  refs = new Map<string, string>([[BRANCH, TIP]]);
  behindBy = 0;
  aheadBy = 3;
  calls: string[][] = [];
  nextPr = 500;

  get creates(): string[][] {
    return this.calls.filter((a) =>
      (a[0] === "pr" && a[1] === "create") || a.includes("POST")
    );
  }

  gh = (args: string[]): Promise<string> => {
    this.calls.push(args);
    const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
    const path = args[1] ?? "";
    if (args[0] === "pr" && args[1] === "list") {
      const state = flag("--state");
      const head = args.includes("--head") ? flag("--head") : undefined;
      // `"phrase" in:body` — GitHub's body search, modelled as a substring.
      const phrase = args.includes("--search")
        ? /^"([^"]+)" in:body$/.exec(flag("--search"))?.[1]
        : undefined;
      if (args.includes("--search") && phrase === undefined) {
        return Promise.reject(
          new Error(`unmodelled search ${flag("--search")}`),
        );
      }
      const hits = this.prs.filter((pr) =>
        (state === "all" || pr.state === state.toUpperCase()) &&
        (head === undefined || pr.headRefName === head) &&
        (phrase === undefined || pr.body.includes(phrase))
      ).slice(0, Number(flag("--limit")) || undefined);
      return Promise.resolve(JSON.stringify(hits));
    }
    if (args[0] === "pr" && args[1] === "create") {
      const number = this.nextPr++;
      const head = flag("--head");
      this.prs.push({
        number,
        headRefName: head,
        baseRefName: flag("--base"),
        headRefOid: this.refs.get(head) ?? "",
        body: flag("--body"),
        state: "OPEN",
      });
      return Promise.resolve(`https://github.com/${REPO}/pull/${number}\n`);
    }
    if (args[0] === "api" && args[1] === "-X" && args[2] === "POST") {
      const ref = (args[args.indexOf("-f") + 1] ?? "").replace(
        "ref=refs/heads/",
        "",
      );
      const sha = (args[args.lastIndexOf("-f") + 1] ?? "").replace("sha=", "");
      if (this.refs.has(ref)) {
        return Promise.reject(new Error("Reference already exists (HTTP 422)"));
      }
      this.refs.set(ref, sha);
      return Promise.resolve("{}");
    }
    if (args[0] === "api" && path.includes("/git/ref/heads/")) {
      const branch = path.split("/git/ref/heads/")[1] ?? "";
      const sha = this.refs.get(branch);
      return sha
        ? Promise.resolve(`${sha}\n`)
        : Promise.reject(new Error("Not Found (HTTP 404)"));
    }
    if (args[0] === "api" && path.includes("/compare/")) {
      return Promise.resolve(
        JSON.stringify({ behind_by: this.behindBy, ahead_by: this.aheadBy }),
      );
    }
    if (args[0] === "api" && args.some((a) => a.includes("/milestones"))) {
      return Promise.resolve(
        JSON.stringify([{ number: 7, title: TITLE, state: "open" }]),
      );
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };

  first(): FakePr {
    const pr = this.prs[0];
    if (pr === undefined) throw new Error("no PR was created");
    return pr;
  }

  run() {
    return createPartialRollup({
      repo: REPO,
      milestone: TITLE,
      milestoneBranch: BRANCH,
      defaultBranch: DEFAULT,
      ghFn: this.gh,
    });
  }
}

Deno.test("createPartialRollup - milestone behind default is deferred and creates nothing", async () => {
  const gh = new FakeGitHub();
  gh.behindBy = 2;
  const result = await gh.run();
  assertEquals(result.outcome, "deferred");
  if (result.outcome === "deferred") {
    assertEquals(result.reason, "milestone-behind");
  }
  assertEquals(gh.creates, []);
  assertFalse(gh.refs.has(SNAPSHOT));
});

Deno.test("createPartialRollup - level milestone snapshots the tip and opens a marked PR with no closing keyword", async () => {
  const gh = new FakeGitHub();
  const result = await gh.run();
  assertEquals(result.outcome, "created");
  if (result.outcome !== "created") return;
  assertEquals(result.snapshotBranch, SNAPSHOT);
  assertEquals(result.headSha, TIP);
  assertFalse(result.reusedRef);
  assertEquals(gh.refs.get(SNAPSHOT), TIP);

  const pr = gh.first();
  assertEquals(pr.headRefName, SNAPSHOT);
  assertEquals(pr.baseRefName, DEFAULT);
  assertStringIncludes(pr.body, partialRollupMarker(TITLE));
  assertFalse(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s*#\d/i.test(pr.body));
});

Deno.test("createPartialRollup - second call with an open marked PR reports exists and creates nothing", async () => {
  const gh = new FakeGitHub();
  const first = await gh.run();
  assertEquals(first.outcome, "created");
  const createsAfterFirst = gh.creates.length;

  const second = await gh.run();
  assertEquals(second.outcome, "exists");
  if (second.outcome === "exists") assertEquals(second.prNumber, 500);
  assertEquals(gh.creates.length, createsAfterFirst);
  assertEquals(gh.prs.length, 1);
});

Deno.test("createPartialRollup - an open partial rollup of another milestone does not count", async () => {
  const gh = new FakeGitHub();
  gh.prs.push({
    number: 9,
    headRefName: "partial-rollup/other-1234567",
    baseRefName: DEFAULT,
    headRefOid: TIP,
    body: partialRollupMarker("Other"),
    state: "OPEN",
  });
  assertEquals((await gh.run()).outcome, "created");
});

Deno.test("createPartialRollup - existing snapshot ref at the tip is reused, never updated", async () => {
  const gh = new FakeGitHub();
  gh.refs.set(SNAPSHOT, TIP);
  const result = await gh.run();
  assertEquals(result.outcome, "created");
  if (result.outcome === "created") assert(result.reusedRef);
  assertEquals(gh.refs.get(SNAPSHOT), TIP);
});

Deno.test("createPartialRollup - existing snapshot ref at another SHA fails and opens no PR", async () => {
  const gh = new FakeGitHub();
  const other = "abcdef1999999999999999999999999999999999";
  gh.refs.set(SNAPSHOT, other);
  const result = await gh.run();
  assertEquals(result.outcome, "failed");
  assertEquals(gh.refs.get(SNAPSHOT), other);
  assertEquals(gh.prs.length, 0);
});

Deno.test("createPartialRollup - nothing ahead of default is deferred", async () => {
  const gh = new FakeGitHub();
  gh.aheadBy = 0;
  const result = await gh.run();
  assertEquals(result.outcome, "deferred");
  if (result.outcome === "deferred") {
    assertEquals(result.reason, "nothing-to-roll-up");
  }
  assertEquals(gh.creates, []);
});

Deno.test("createPartialRollup - invalid names fail before reaching gh", async () => {
  const gh = new FakeGitHub();
  const cases = [
    { repo: "owner/repo; rm -rf /", milestoneBranch: BRANCH, milestone: TITLE },
    { repo: REPO, milestoneBranch: "feature/x", milestone: TITLE },
    { repo: REPO, milestoneBranch: "milestone/a b", milestone: TITLE },
    { repo: REPO, milestoneBranch: "milestone/../main", milestone: TITLE },
    { repo: "owner/..", milestoneBranch: BRANCH, milestone: TITLE },
    { repo: REPO, milestoneBranch: BRANCH, milestone: 'x" --><script>' },
  ];
  for (const c of cases) {
    const result = await createPartialRollup({
      ...c,
      defaultBranch: DEFAULT,
      ghFn: gh.gh,
    });
    assertEquals(result.outcome, "failed");
  }
  assertEquals(gh.calls, []);
});

Deno.test("createPartialRollup - a closing keyword in the milestone title is refused", async () => {
  const gh = new FakeGitHub();
  gh.refs.set("milestone/fixes-12", TIP);
  const result = await createPartialRollup({
    repo: REPO,
    milestone: "Fixes #12",
    milestoneBranch: "milestone/fixes-12",
    defaultBranch: DEFAULT,
    ghFn: gh.gh,
  });
  assertEquals(result.outcome, "failed");
  if (result.outcome === "failed") {
    assertStringIncludes(result.reason, "closing keyword");
  }
  assertEquals(gh.creates, []);
});

Deno.test("createPartialRollup - a closing keyword with an issue URL in the title is refused", async () => {
  const gh = new FakeGitHub();
  gh.refs.set("milestone/fixes-https-github-com-o-r-issues-12", TIP);
  const result = await createPartialRollup({
    repo: REPO,
    milestone: "Fixes https://github.com/o/r/issues/12",
    milestoneBranch: "milestone/fixes-https-github-com-o-r-issues-12",
    defaultBranch: DEFAULT,
    ghFn: gh.gh,
  });
  assertEquals(result.outcome, "failed");
  if (result.outcome === "failed") {
    assertStringIncludes(result.reason, "closing keyword");
  }
  assertEquals(gh.creates, []);
});

Deno.test("listMergedPartialRollupHeads - a full page throws rather than reporting a truncated history", async () => {
  const gh = new FakeGitHub();
  for (let n = 0; n < 100; n++) {
    gh.prs.push({
      number: n + 1,
      headRefName: `partial-rollup/other-${String(n).padStart(7, "0")}`,
      baseRefName: DEFAULT,
      headRefOid: TIP,
      body: partialRollupMarker("Other"),
      state: "MERGED",
    });
  }
  await assertRejects(
    () => listMergedPartialRollupHeads(REPO, TITLE, gh.gh),
    Error,
    "truncated",
  );
});

Deno.test("createPartialRollup - a failed PR lookup fails loud", async () => {
  const result = await createPartialRollup({
    repo: REPO,
    milestone: TITLE,
    milestoneBranch: BRANCH,
    defaultBranch: DEFAULT,
    ghFn: () => Promise.reject(new Error("rate limited")),
  });
  assertEquals(result.outcome, "failed");
  if (result.outcome === "failed") {
    assertStringIncludes(result.reason, "rate limited");
  }
});

Deno.test("listMergedPartialRollupHeads - returns head SHAs of this milestone's merged partial rollups", async () => {
  const gh = new FakeGitHub();
  await gh.run();
  assertEquals(await listMergedPartialRollupHeads(REPO, TITLE, gh.gh), []);

  gh.first().state = "MERGED";
  gh.prs.push({
    number: 9,
    headRefName: "partial-rollup/other-1234567",
    baseRefName: DEFAULT,
    headRefOid: "1234567000000000000000000000000000000000",
    body: partialRollupMarker("Other"),
    state: "MERGED",
  });
  assertEquals(await listMergedPartialRollupHeads(REPO, TITLE, gh.gh), [TIP]);
});

Deno.test("listMergedPartialRollupHeads - a failed lookup throws rather than reporting none", async () => {
  await assertRejects(() =>
    listMergedPartialRollupHeads(
      REPO,
      TITLE,
      () => Promise.reject(new Error("boom")),
    )
  );
});

Deno.test("isMilestoneBranch - a partial-rollup snapshot is not a milestone head", () => {
  assertFalse(isMilestoneBranch(SNAPSHOT));
});

Deno.test("hasExistingMilestoneSummaryPr - null while a partial rollup is open and after it merges", async () => {
  const gh = new FakeGitHub();
  await gh.run();
  const open = await hasExistingMilestoneSummaryPr(REPO, TITLE, BRANCH, gh.gh);
  assertEquals(open, { ok: true, value: null });

  gh.first().state = "MERGED";
  const merged = await hasExistingMilestoneSummaryPr(
    REPO,
    TITLE,
    BRANCH,
    gh.gh,
  );
  assertEquals(merged, { ok: true, value: null });
});

Deno.test("decideMilestoneBaseMerge - a child PR into the milestone is still allowed after a partial rollup merges", async () => {
  const gh = new FakeGitHub();
  await gh.run();
  gh.first().state = "MERGED";
  const decision = await decideMilestoneBaseMerge({
    repo: REPO,
    prNumber: 42,
    baseRefName: BRANCH,
    ghCommandFn: gh.gh,
  });
  assertEquals(decision.decision, "allow");
});
