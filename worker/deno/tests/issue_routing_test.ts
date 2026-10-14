/**
 * Tests for deterministic cross-repository issue routing (Issue #3691).
 *
 * Real function calls against a fake `gh` that records every call and returns
 * canned output. Fixtures are deterministic; the clock is injected.
 *
 * Australian English spelling used throughout.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  classifyIssueRouting,
  formatRoutingAuditBlock,
  type IssueRoutingContext,
  type IssueRoutingDraft,
  IssueRoutingPermissionError,
  resolveWrongRepoDuplicate,
  routeIssueCreation,
} from "../lib/issue_routing.ts";
import {
  formatRepoFastFailureMarker,
  formatRepoFastFailureTallyMarker,
} from "../lib/repo_fast_failure_issue.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const VIBE = "stSoftwareAU/VibeCoder";
const GRQ = "stSoftwareAU/GRQ-AutoTrader";
const OTHER = "stSoftwareAU/Other-Repo";
const NOW = Date.parse("2026-10-14T00:00:00Z");
const DAY = 86_400_000;

const ctx = (over: Partial<IssueRoutingContext> = {}): IssueRoutingContext => ({
  vibeCoderRepo: VIBE,
  allowedRepos: [VIBE, GRQ, OTHER],
  dryRun: false,
  recentlyClosedDays: 7,
  nowMs: NOW,
  ...over,
});

const draft = (
  title: string,
  body: string,
  extra: Partial<IssueRoutingDraft> = {},
): IssueRoutingDraft => ({ title, body, labels: ["bug"], ...extra });

type Row = {
  number: number;
  title: string;
  state: string;
  closedAt?: string | null;
  url?: string;
};

/** Fake gh: records calls, serves canned search/permission output. */
class FakeGh {
  calls: string[][] = [];
  perms = new Map<string, string>();
  issues = new Map<string, Row[]>();
  prs = new Map<string, Row[]>();
  views = new Map<string, string>();
  nextNumber = 100;
  /** Per-call override; return undefined to use the default. */
  hook?: (args: string[], n: number) => string | undefined;
  failOn?: (args: string[]) => boolean;

  run = (args: string[]): Promise<string> => {
    this.calls.push(args);
    if (this.failOn?.(args)) return Promise.reject(new Error("gh boom"));
    const over = this.hook?.(args, this.calls.length);
    if (over !== undefined) return Promise.resolve(over);
    const repo = args[args.indexOf("--repo") + 1] ?? "";
    const key = `${repo}#${args[2]}`;
    if (args[0] === "repo") {
      return Promise.resolve(this.perms.get(args[2]!) ?? "WRITE");
    }
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(this.issues.get(repo) ?? []));
    }
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(this.prs.get(repo) ?? []));
    }
    if (args[0] === "issue" && args[1] === "view") {
      const v = this.views.get(key);
      return v === undefined
        ? Promise.reject(new Error("not found"))
        : Promise.resolve(v);
    }
    if (args[0] === "issue" && args[1] === "create") {
      const n = this.nextNumber++;
      const rows = this.issues.get(repo) ?? [];
      rows.push({
        number: n,
        title: args[args.indexOf("--title") + 1]!,
        state: "OPEN",
      });
      this.issues.set(repo, rows);
      return Promise.resolve(`https://github.com/${repo}/issues/${n}\n`);
    }
    return Promise.resolve("");
  };

  verbs(): string[] {
    return this.calls.map((c) => `${c[0]} ${c[1]}`);
  }
  writes(): string[][] {
    return this.calls.filter((c) =>
      c[0] === "issue" && ["create", "close", "comment", "edit"].includes(c[1]!)
    );
  }
  arg(call: string[], flag: string): string {
    return call[call.indexOf(flag) + 1]!;
  }
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

Deno.test("classify: #3607-style PWA gap filed in VibeCoder belongs to GRQ-AutoTrader", () => {
  const d = classifyIssueRouting(
    draft(
      "PWA gap: blank space on the leaderboard",
      "The GRQ-AutoTrader PWA shows a blank space under the chart.",
    ),
    VIBE,
    ctx(),
  );
  assertEquals(d.owner_repository, GRQ);
  assertEquals(d.subject_repository, GRQ);
  assertEquals(d.issue_kind, "implementation");
  assert(d.wrong_repo);
  assert(!d.ambiguous);
  assertStringIncludes(d.reason, "no Vibe Coder signals");
});

Deno.test("classify: fast-failure diagnostic stays, even with worker paths", () => {
  const body = `${formatRepoFastFailureMarker(GRQ)}\n` +
    "see worker/deno/lib/x.ts and the prompts/ template; fleet worker claim";
  const d = classifyIssueRouting(draft("GRQ keeps failing", body), GRQ, ctx());
  assertEquals(d.issue_kind, "diagnostic");
  assertEquals(d.owner_repository, GRQ);
  assert(!d.wrong_repo);
  assert(!d.ambiguous);
  assertStringIncludes(d.reason, "#2592");
});

Deno.test("classify: tally marker is also a diagnostic", () => {
  const d = classifyIssueRouting(
    draft("tally", formatRepoFastFailureTallyMarker(GRQ)),
    GRQ,
    ctx(),
  );
  assertEquals(d.issue_kind, "diagnostic");
});

Deno.test("classify: a marker for another repo is not the exception", () => {
  const d = classifyIssueRouting(
    draft("t", `${formatRepoFastFailureMarker(OTHER)} worker/deno/lib/a.ts`),
    GRQ,
    ctx(),
  );
  assertEquals(d.issue_kind, "implementation");
  assertEquals(d.owner_repository, GRQ);
  assert(d.ambiguous);
});

Deno.test("classify: worker fix filed in VibeCoder stays", () => {
  const d = classifyIssueRouting(
    draft(
      "fix(worker): lane worktree HEAD dangles",
      "worker/deno/lib/lane.ts leaves the lane worktree HEAD dangling.",
    ),
    VIBE,
    ctx(),
  );
  assertEquals(d.owner_repository, VIBE);
  assert(!d.wrong_repo);
  assertStringIncludes(d.reason, "stays in");
});

Deno.test("classify: AutoTrader finding needing a prompts/ fix belongs to VibeCoder", () => {
  const d = classifyIssueRouting(
    draft(
      "Review finding repeats",
      "The review keeps missing this; fix prompts/review/prompt.md.",
    ),
    GRQ,
    ctx(),
  );
  assertEquals(d.owner_repository, VIBE);
  assertEquals(d.subject_repository, GRQ);
  assert(d.wrong_repo);
  assert(!d.ambiguous);
  assertStringIncludes(d.reason, "prompts/");
});

Deno.test("classify: GRQ scoring bug moves from VibeCoder, stays in GRQ", () => {
  const text = draft("Scoring bug", "GRQ-AutoTrader scoring is off by one.");
  const filedInVibe = classifyIssueRouting(text, VIBE, ctx());
  assertEquals(filedInVibe.owner_repository, GRQ);
  assert(filedInVibe.wrong_repo);
  const filedInGrq = classifyIssueRouting(text, GRQ, ctx());
  assertEquals(filedInGrq.owner_repository, GRQ);
  assert(!filedInGrq.wrong_repo);
});

Deno.test("classify: full owner/repo name counts as a mention", () => {
  const d = classifyIssueRouting(
    draft("x", `See ${GRQ} home page.`),
    VIBE,
    ctx(),
  );
  assertEquals(d.owner_repository, GRQ);
});

Deno.test("classify: other repo plus Vibe Coder signals is ambiguous cross-repo", () => {
  const d = classifyIssueRouting(
    draft("x", "GRQ-AutoTrader fleet orchestration drops claims."),
    VIBE,
    ctx(),
  );
  assert(d.ambiguous);
  assert(!d.wrong_repo);
  assertEquals(d.issue_kind, "cross-repo");
  assertEquals(d.owner_repository, VIBE);
  assertStringIncludes(d.reason, "split");
  assertStringIncludes(d.reason, "close nothing automatically");
});

Deno.test("classify: two other repos named is ambiguous (in VibeCoder and elsewhere)", () => {
  const text = draft("x", "Both GRQ-AutoTrader and Other-Repo are affected.");
  const inVibe = classifyIssueRouting(text, VIBE, ctx());
  assert(inVibe.ambiguous && !inVibe.wrong_repo);
  assertEquals(inVibe.owner_repository, VIBE);
  const inGrq = classifyIssueRouting(text, GRQ, ctx());
  assert(inGrq.ambiguous && !inGrq.wrong_repo);
  assertEquals(inGrq.owner_repository, GRQ);
});

Deno.test("classify: Vibe Coder and product signals in another repo is ambiguous", () => {
  const d = classifyIssueRouting(
    draft("x", "The worker leaves a blank space on the page."),
    GRQ,
    ctx(),
  );
  assert(d.ambiguous);
  assert(!d.wrong_repo);
  assertEquals(d.owner_repository, GRQ);
  assertEquals(d.issue_kind, "implementation");
  assertStringIncludes(d.reason, "both bases apply");
  assertStringIncludes(d.reason, "close nothing automatically");
});

Deno.test("classify: ordinary draft with no signals stays put", () => {
  const inGrq = classifyIssueRouting(draft("x", "plain"), GRQ, ctx());
  assertEquals(inGrq.owner_repository, GRQ);
  const inVibe = classifyIssueRouting(draft("x", "plain"), VIBE, ctx());
  assertEquals(inVibe.owner_repository, VIBE);
  assertStringIncludes(inVibe.reason, "names no other repository");
});

Deno.test("classify: explicit mention of the Vibe Coder repo is a signal", () => {
  const d = classifyIssueRouting(
    draft("x", `Needs a change in ${VIBE}.`),
    GRQ,
    ctx(),
  );
  assertEquals(d.owner_repository, VIBE);
  assertStringIncludes(d.reason, `mention of ${VIBE}`);
});

Deno.test("classify: parts across repos are cross-repo, owner prefers target", () => {
  const parts = [
    { repo: VIBE, title: "a", body: "a" },
    { repo: GRQ, title: "b", body: "b" },
  ];
  const inGrq = classifyIssueRouting(draft("x", "y", { parts }), GRQ, ctx());
  assertEquals(inGrq.issue_kind, "cross-repo");
  assertEquals(inGrq.owner_repository, GRQ);
  assertStringIncludes(inGrq.reason, VIBE);
  assertStringIncludes(inGrq.reason, GRQ);
  const inOther = classifyIssueRouting(
    draft("x", "y", { parts }),
    OTHER,
    ctx(),
  );
  assertEquals(inOther.owner_repository, VIBE);
  assert(inOther.wrong_repo);
});

Deno.test("classify: parts in a single repo are not a split", () => {
  const d = classifyIssueRouting(
    draft("x", "y", { parts: [{ repo: GRQ, title: "a", body: "a" }] }),
    GRQ,
    ctx(),
  );
  assertEquals(d.issue_kind, "implementation");
});

Deno.test("audit block: visible line and hidden marker, inert values", () => {
  const block = formatRoutingAuditBlock({
    owner_repository: GRQ,
    subject_repository: "a b>-->c",
    issue_kind: "implementation",
    reason: "line one\nline two",
    wrong_repo: true,
    ambiguous: false,
  });
  assertStringIncludes(block, "Routing: owner");
  assertStringIncludes(block, "line one line two");
  assertStringIncludes(
    block,
    `<!-- VIBE_ISSUE_ROUTING owner=${GRQ} subject=a-b----c kind=implementation -->`,
  );
});

// ---------------------------------------------------------------------------
// Hostile input: each regex stays linear
// ---------------------------------------------------------------------------

const hostile = (unit: string, tail: string) => (chars: number) =>
  unit.repeat(Math.ceil(chars / unit.length)) + tail;

for (
  const [name, unit, tail] of [
    ["path regex", "worker/den", "!"],
    ["prompts regex", "prompt", "!"],
    ["keyword regex", "vibe ", "!"],
    ["product regex", "pw", "!"],
    ["repo mention regex", "GRQ-AutoTrade", "!"],
    ["repo mention regex, boundary", "GRQ-AutoTrader-", "x"],
    ["whitespace run", " ", "x"],
  ] as const
) {
  Deno.test(`classify: hostile input stays linear (${name})`, () => {
    const out = assertLinearGrowth(
      name,
      hostile(unit, tail),
      (input) => classifyIssueRouting(draft(input, input), GRQ, ctx()),
      { baseChars: 100_000, graceMs: 500 },
    );
    assert(out.owner_repository.length > 0);
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const pwaDraft = draft(
  "PWA gap: blank space on the leaderboard",
  "The GRQ-AutoTrader PWA shows a blank space under the chart.",
  { labels: ["bug", "enhancement"] },
);

Deno.test("route: wrong-repo draft is created in the owner, no labels migrated", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger);
  assertEquals(audit.action, "created");
  assertEquals(audit.owner_repository, GRQ);
  assertEquals(audit.issues, [{
    repo: GRQ,
    number: 100,
    url: `https://github.com/${GRQ}/issues/100`,
    state: "open",
  }]);
  assertEquals(audit.labels_not_migrated, ["bug", "enhancement"]);
  const create = gh.writes().find((c) => c[1] === "create")!;
  assertEquals(gh.arg(create, "--repo"), GRQ);
  assert(!create.includes("--label"));
  const body = gh.arg(create, "--body");
  assertStringIncludes(body, "Labels not migrated: bug, enhancement");
  assertStringIncludes(body, "<!-- VIBE_ISSUE_ROUTING owner=");
  // Permission is checked before the first write.
  assertEquals(
    gh.calls.findIndex((c) => c[0] === "repo") < gh.calls.indexOf(create),
    true,
  );
});

Deno.test("route: same-repo create passes labels and the routing block", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(
    draft("fix(worker): thing", "worker/deno/lib/a.ts is wrong", {
      labels: ["bug"],
    }),
    VIBE,
    ctx(),
    gh.run,
    logger,
  );
  assertEquals(audit.action, "created");
  assertEquals(audit.labels_not_migrated, []);
  const create = gh.writes()[0]!;
  assertEquals(
    create.slice(create.indexOf("--label"), create.indexOf("--label") + 2),
    [
      "--label",
      "bug",
    ],
  );
  assert(
    !gh.calls.some((c) => c[0] === "repo"),
    "no permission call for target",
  );
  assertStringIncludes(gh.arg(create, "--body"), "Routing: owner");
});

Deno.test("route: diagnostic and worker-fix stay in their repos", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  const diag = await routeIssueCreation(
    draft(
      "GRQ keeps failing",
      `${formatRepoFastFailureMarker(GRQ)}\nworker/deno/lib/x.ts`,
    ),
    GRQ,
    ctx(),
    gh.run,
    logger,
  );
  assertEquals(diag.issues[0]!.repo, GRQ);
  assertEquals(diag.issue_kind, "diagnostic");
  assert(!diag.wrong_repo);
  const fix = await routeIssueCreation(
    draft("fix(worker): lane worktree HEAD dangles", "worker/deno/lib/lane.ts"),
    VIBE,
    ctx(),
    gh.run,
    logger,
  );
  assertEquals(fix.issues[0]!.repo, VIBE);
  assertEquals(fix.action, "created");
});

Deno.test("route: AutoTrader finding needing a prompts fix is filed in VibeCoder", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(
    draft("Review finding repeats", "Fix prompts/review/prompt.md"),
    GRQ,
    ctx(),
    gh.run,
    logger,
  );
  assertEquals(audit.issues[0]!.repo, VIBE);
  assert(audit.wrong_repo);
  assertEquals(audit.labels_not_migrated, ["bug"]);
});

Deno.test("route: ambiguous is filed in the target, nothing closed", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(
    draft("x", "The worker leaves a blank space on the page."),
    GRQ,
    ctx(),
    gh.run,
    logger,
  );
  assertEquals(audit.action, "filed-ambiguous");
  assertEquals(audit.issues[0]!.repo, GRQ);
  assert(audit.ambiguous && !audit.wrong_repo);
  assertStringIncludes(audit.reason, "close nothing automatically");
  assert(!gh.writes().some((c) => c[1] === "close"));
  assert(!gh.calls.some((c) => c[0] === "repo"));
});

Deno.test("route: open duplicate is reused, no create", async () => {
  const gh = new FakeGh();
  gh.issues.set(GRQ, [{
    number: 7,
    title: "  PWA gap:  BLANK space on the leaderboard ",
    state: "OPEN",
    url: "u7",
  }]);
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger);
  assertEquals(audit.action, "reused");
  assertEquals(audit.issues, [{
    repo: GRQ,
    number: 7,
    url: "u7",
    state: "open",
  }]);
  assertEquals(gh.writes().length, 0);
  const search = gh.calls.find((c) => c[1] === "list")!;
  assertEquals(gh.arg(search, "--search"), `${pwaDraft.title} in:title`);
});

Deno.test("route: closed within the window is reused; outside it is not", async () => {
  const title = pwaDraft.title;
  const within = new FakeGh();
  within.issues.set(GRQ, [{
    number: 8,
    title,
    state: "CLOSED",
    closedAt: new Date(NOW - 6 * DAY).toISOString(),
  }]);
  const { logger } = makeRecordingLogger();
  const a = await routeIssueCreation(pwaDraft, VIBE, ctx(), within.run, logger);
  assertEquals(a.action, "reused");
  assertEquals(a.issues[0]!.state, "closed");
  assertEquals(within.writes().length, 0);

  const outside = new FakeGh();
  outside.issues.set(GRQ, [{
    number: 8,
    title,
    state: "CLOSED",
    closedAt: new Date(NOW - 8 * DAY).toISOString(),
  }]);
  const b = await routeIssueCreation(
    pwaDraft,
    VIBE,
    ctx(),
    outside.run,
    logger,
  );
  assertEquals(b.action, "created");
  assertEquals(outside.writes().filter((c) => c[1] === "create").length, 1);

  const nodate = new FakeGh();
  nodate.issues.set(GRQ, [{
    number: 8,
    title,
    state: "CLOSED",
    closedAt: null,
  }]);
  const c = await routeIssueCreation(pwaDraft, VIBE, ctx(), nodate.run, logger);
  assertEquals(c.action, "created");
});

Deno.test("route: a non-matching title is not reused", async () => {
  const gh = new FakeGh();
  gh.issues.set(GRQ, [{ number: 9, title: "something else", state: "OPEN" }]);
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger);
  assertEquals(audit.action, "created");
});

Deno.test("route: a matching PR is reused, whatever its state", async () => {
  const gh = new FakeGh();
  gh.prs.set(GRQ, [{
    number: 12,
    title: pwaDraft.title,
    state: "MERGED",
    closedAt: new Date(NOW - 90 * DAY).toISOString(),
    url: "pr12",
  }]);
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger);
  assertEquals(audit.action, "reused");
  assertEquals(audit.issues[0]!.number, 12);
  assertEquals(audit.issues[0]!.state, "closed");
  assertEquals(gh.writes().length, 0);
  assert(gh.calls.some((c) => c[0] === "pr" && c[1] === "list"));
});

Deno.test("route: lowest-numbered match wins when several exist", async () => {
  const gh = new FakeGh();
  gh.issues.set(GRQ, [
    { number: 30, title: pwaDraft.title, state: "OPEN" },
    { number: 20, title: pwaDraft.title, state: "OPEN" },
  ]);
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger);
  assertEquals(audit.issues[0]!.number, 20);
});

Deno.test("route: concurrent filer appears between the searches (reuse)", async () => {
  const gh = new FakeGh();
  let issueLists = 0;
  gh.hook = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      issueLists++;
      return issueLists === 1 ? "[]" : JSON.stringify([
        { number: 55, title: pwaDraft.title, state: "OPEN", url: "u55" },
      ]);
    }
    return undefined;
  };
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger);
  assertEquals(audit.action, "reused");
  assertEquals(audit.issues[0]!.number, 55);
  assertEquals(gh.writes().length, 0);
  assertEquals(issueLists, 2);
});

Deno.test("route: post-create lower-numbered duplicate wins, ours closed with explanation", async () => {
  const gh = new FakeGh();
  let issueLists = 0;
  gh.hook = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      issueLists++;
      if (issueLists <= 2) return "[]";
      return JSON.stringify([
        { number: 99, title: pwaDraft.title, state: "OPEN", url: "u99" },
        { number: 100, title: pwaDraft.title, state: "OPEN" },
      ]);
    }
    return undefined;
  };
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger);
  assertEquals(audit.action, "reused");
  assertEquals(audit.issues, [{
    repo: GRQ,
    number: 99,
    url: "u99",
    state: "open",
  }]);
  const close = gh.writes().find((c) => c[1] === "close")!;
  assertEquals(close[2], "100");
  assertEquals(gh.arg(close, "--repo"), GRQ);
  assertEquals(gh.arg(close, "--reason"), "not planned");
  assertStringIncludes(gh.arg(close, "--comment"), `${GRQ}#99`);
});

Deno.test("route: post-create keeps ours when it is the lowest", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger);
  assertEquals(audit.action, "created");
  assert(!gh.writes().some((c) => c[1] === "close"));
  // search, search again, create, search once more
  assertEquals(
    gh.verbs().filter((v) => v === "issue list").length,
    3,
  );
});

Deno.test("route: dry-run performs no writes", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  for (
    const [d, repo] of [[pwaDraft, VIBE], [draft("x", "plain"), GRQ]] as const
  ) {
    const audit = await routeIssueCreation(
      d,
      repo,
      ctx({ dryRun: true }),
      gh.run,
      logger,
    );
    assertEquals(audit.action, "dry-run");
    assertEquals(audit.issues[0]!.state, "dry-run");
    assertEquals(audit.issues[0]!.number, null);
  }
  assertEquals(gh.writes(), []);
  assert(!gh.calls.some((c) => c[1] === "create"));
});

Deno.test("route: dry-run still enforces permission on a foreign destination", async () => {
  const gh = new FakeGh();
  gh.perms.set(GRQ, "READ");
  const { logger } = makeRecordingLogger();
  await assertRejects(
    () =>
      routeIssueCreation(pwaDraft, VIBE, ctx({ dryRun: true }), gh.run, logger),
    IssueRoutingPermissionError,
  );
  assertEquals(gh.writes(), []);
});

Deno.test("route: insufficient permission throws with the observed text, no writes", async () => {
  for (const perm of ["READ", "VIEWER", ""]) {
    const gh = new FakeGh();
    gh.perms.set(GRQ, perm);
    const { logger } = makeRecordingLogger();
    const err = await assertRejects(
      () => routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger),
      IssueRoutingPermissionError,
      GRQ,
    );
    assertStringIncludes(err.message, `'${perm}'`);
    assertEquals(gh.writes(), []);
  }
});

Deno.test("route: TRIAGE, MAINTAIN, ADMIN and WRITE are accepted", async () => {
  for (const perm of ["TRIAGE", "MAINTAIN", "ADMIN", "write\n"]) {
    const gh = new FakeGh();
    gh.perms.set(GRQ, perm);
    const { logger } = makeRecordingLogger();
    const audit = await routeIssueCreation(
      pwaDraft,
      VIBE,
      ctx(),
      gh.run,
      logger,
    );
    assertEquals(audit.action, "created");
  }
});

Deno.test("route: destination outside the allowlist throws before any gh call", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  const quiet = await routeIssueCreation(
    pwaDraft,
    VIBE,
    ctx({ allowedRepos: [VIBE, OTHER, `${GRQ}-x`] }),
    gh.run,
    logger,
  );
  assertEquals(quiet.issues[0]!.repo, VIBE);
  // GRQ is not in the allowlist so it is not even a named repo: stays in VibeCoder.
  const gh2 = new FakeGh();
  const forced = routeIssueCreation(
    draft("x", "Fix prompts/a/prompt.md"),
    GRQ,
    ctx({ allowedRepos: [GRQ] }),
    gh2.run,
    logger,
  );
  const err = await assertRejects(
    () => forced,
    IssueRoutingPermissionError,
    VIBE,
  );
  assertStringIncludes(err.message, "allowed");
  assertEquals(gh2.calls, []);
});

Deno.test("route: gh error during the permission check is wrapped, cause kept", async () => {
  const gh = new FakeGh();
  gh.failOn = (a) => a[0] === "repo";
  const { logger } = makeRecordingLogger();
  const err = await assertRejects(
    () => routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger),
    IssueRoutingPermissionError,
    "gh boom",
  );
  assert(err.cause instanceof Error);
  assertEquals(gh.writes(), []);
});

Deno.test("route: create output without an issue number throws", async () => {
  const gh = new FakeGh();
  gh.hook = (a) => (a[1] === "create" ? "nothing useful" : undefined);
  const { logger } = makeRecordingLogger();
  await assertRejects(
    () => routeIssueCreation(pwaDraft, VIBE, ctx(), gh.run, logger),
    Error,
    "no issue number",
  );
});

Deno.test("route: malformed or non-array search JSON throws with context", async () => {
  for (
    const [bad, expect] of [["{not json", "Malformed JSON"], [
      "{}",
      "non-array",
    ]]
  ) {
    const gh = new FakeGh();
    gh.hook = (a) => (a[1] === "list" ? bad : undefined);
    const { logger } = makeRecordingLogger();
    await assertRejects(
      () => routeIssueCreation(draft("x", "plain"), GRQ, ctx(), gh.run, logger),
      Error,
      expect,
    );
    assertEquals(gh.writes(), []);
  }
  const gh = new FakeGh();
  gh.hook = (a) => (a[0] === "pr" ? "oops" : undefined);
  const { logger } = makeRecordingLogger();
  await assertRejects(
    () => routeIssueCreation(draft("x", "plain"), GRQ, ctx(), gh.run, logger),
    Error,
    "gh pr list",
  );
});

Deno.test("route: junk rows in search results are ignored", async () => {
  const gh = new FakeGh();
  gh.hook = (a) =>
    a[0] === "issue" && a[1] === "list"
      ? JSON.stringify([null, 3, { number: "x" }])
      : undefined;
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(
    draft("x", "plain"),
    GRQ,
    ctx(),
    gh.run,
    logger,
  );
  assertEquals(audit.action, "created");
});

// --- cross-repo split ------------------------------------------------------

const splitDraft = draft("Cross-repo change", "umbrella", {
  labels: ["bug"],
  parts: [
    {
      repo: VIBE,
      title: "Vibe part: expose the endpoint",
      body: "worker side",
    },
    {
      repo: GRQ,
      title: "GRQ part: consume the endpoint",
      body: "product side",
      dependsOnRepos: [VIBE],
    },
  ],
});

Deno.test("route: split files one issue per repo and links them without duplicating scope", async () => {
  const gh = new FakeGh();
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(
    splitDraft,
    VIBE,
    ctx(),
    gh.run,
    logger,
  );
  assertEquals(audit.action, "split");
  assertEquals(audit.issues.map((i) => `${i.repo}#${i.number}`), [
    `${VIBE}#100`,
    `${GRQ}#101`,
  ]);
  const creates = gh.writes().filter((c) => c[1] === "create");
  assertEquals(creates.map((c) => gh.arg(c, "--title")), [
    "Vibe part: expose the endpoint",
    "GRQ part: consume the endpoint",
  ]);
  assertStringIncludes(gh.arg(creates[0]!, "--body"), "worker side");
  assert(!gh.arg(creates[0]!, "--body").includes("product side"));
  assert(creates[0]!.includes("--label"));
  assert(!creates[1]!.includes("--label"));
  assertStringIncludes(
    gh.arg(creates[1]!, "--body"),
    "Labels not migrated: bug",
  );
  assertEquals(audit.labels_not_migrated, ["bug"]);
  const comments = gh.writes().filter((c) => c[1] === "comment");
  assertEquals(comments.length, 2);
  const onVibe = comments.find((c) => c[2] === "100")!;
  assertEquals(gh.arg(onVibe, "--repo"), VIBE);
  assertEquals(gh.arg(onVibe, "--body"), `Related: ${GRQ}#101`);
  const onGrq = comments.find((c) => c[2] === "101")!;
  assertEquals(
    gh.arg(onGrq, "--body"),
    `Depends on ${VIBE}#100`.replace("on ", "on: "),
  );
  // Permission only for the non-target repo.
  assertEquals(gh.calls.filter((c) => c[0] === "repo").map((c) => c[2]), [GRQ]);
});

Deno.test("route: split reuses an existing part and still links it", async () => {
  const gh = new FakeGh();
  gh.issues.set(GRQ, [{
    number: 41,
    title: "GRQ part: consume the endpoint",
    state: "OPEN",
    url: "u41",
  }]);
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(
    splitDraft,
    VIBE,
    ctx(),
    gh.run,
    logger,
  );
  assertEquals(audit.action, "split");
  assertEquals(audit.issues[1]!.number, 41);
  assertEquals(gh.writes().filter((c) => c[1] === "create").length, 1);
  assertEquals(gh.writes().filter((c) => c[1] === "comment").length, 2);
});

Deno.test("route: split dry-run writes nothing; split permission failure writes nothing", async () => {
  const dry = new FakeGh();
  const { logger } = makeRecordingLogger();
  const audit = await routeIssueCreation(
    splitDraft,
    VIBE,
    ctx({ dryRun: true }),
    dry.run,
    logger,
  );
  assertEquals(audit.action, "dry-run");
  assertEquals(audit.issues.map((i) => i.state), ["dry-run", "dry-run"]);
  assertEquals(dry.writes(), []);

  const denied = new FakeGh();
  denied.perms.set(GRQ, "READ");
  await assertRejects(
    () => routeIssueCreation(splitDraft, VIBE, ctx(), denied.run, logger),
    IssueRoutingPermissionError,
  );
  assertEquals(denied.writes(), []);
});

// ---------------------------------------------------------------------------
// resolveWrongRepoDuplicate
// ---------------------------------------------------------------------------

const wrong = { repo: VIBE, number: 3607 };
const correct = { repo: GRQ, number: 3242 };

function resolveFake(wrongBody = "plain body", wrongState = "OPEN"): FakeGh {
  const gh = new FakeGh();
  gh.views.set(`${GRQ}#3242`, JSON.stringify({ number: 3242, state: "OPEN" }));
  gh.views.set(
    `${VIBE}#3607`,
    JSON.stringify({ body: wrongBody, state: wrongState }),
  );
  return gh;
}

Deno.test("resolve: verifies, links both, then closes the wrong one last", async () => {
  const gh = resolveFake();
  const { logger } = makeRecordingLogger();
  const out = await resolveWrongRepoDuplicate({
    wrong,
    correct,
    ctx: ctx(),
    gh: gh.run,
    logger,
  });
  assert(out.closedWrong);
  const verbs = gh.verbs();
  assertEquals(verbs.at(-1), "issue close");
  assertEquals(verbs.filter((v) => v === "issue close").length, 1);
  const firstWrite = verbs.findIndex((v) => v === "issue comment");
  assertEquals(verbs.indexOf("issue view") < firstWrite, true);
  assertEquals(gh.calls[0]!.slice(0, 3), ["issue", "view", "3242"]);
  const comments = gh.calls.filter((c) => c[1] === "comment");
  assertEquals(comments.length, 2);
  assertEquals(
    comments.map((c) => `${gh.arg(c, "--repo")}#${c[2]}`).sort(),
    [`${GRQ}#3242`, `${VIBE}#3607`],
  );
  assertStringIncludes(
    gh.arg(comments.find((c) => c[2] === "3242")!, "--body"),
    `${VIBE}#3607`,
  );
  assertStringIncludes(
    gh.arg(comments.find((c) => c[2] === "3607")!, "--body"),
    `${GRQ}#3242`,
  );
  const close = gh.calls.at(-1)!;
  assertEquals(close[2], "3607");
  assertEquals(gh.arg(close, "--repo"), VIBE);
  assertEquals(gh.arg(close, "--reason"), "not planned");
  assertStringIncludes(gh.arg(close, "--comment"), `${GRQ}#3242`);
  // Never delete, never edit labels, assignees or bodies.
  assert(!gh.calls.some((c) => c[1] === "delete" || c[1] === "edit"));
  assert(!gh.calls.flat().some((a) => /label|assignee/.test(a)));
});

Deno.test("resolve: refuses to close a diagnostic and says why", async () => {
  for (
    const marker of [
      formatRepoFastFailureMarker(VIBE),
      formatRepoFastFailureTallyMarker(VIBE),
    ]
  ) {
    const gh = resolveFake(`${marker}\nbody`);
    const { logger } = makeRecordingLogger();
    const out = await resolveWrongRepoDuplicate({
      wrong,
      correct,
      ctx: ctx(),
      gh: gh.run,
      logger,
    });
    assertEquals(out.closedWrong, false);
    assertStringIncludes(out.reason, "#2592");
    assertEquals(gh.writes(), []);
  }
});

Deno.test("resolve: a wrong issue that is already closed is left alone", async () => {
  const gh = resolveFake("plain", "CLOSED");
  const { logger } = makeRecordingLogger();
  const out = await resolveWrongRepoDuplicate({
    wrong,
    correct,
    ctx: ctx(),
    gh: gh.run,
    logger,
  });
  assertEquals(out.closedWrong, false);
  assertStringIncludes(out.reason, "already closed");
  assertEquals(gh.writes(), []);
});

Deno.test("resolve: missing correct issue throws and closes nothing", async () => {
  const gh = resolveFake();
  gh.views.delete(`${GRQ}#3242`);
  const { logger } = makeRecordingLogger();
  await assertRejects(
    () =>
      resolveWrongRepoDuplicate({
        wrong,
        correct,
        ctx: ctx(),
        gh: gh.run,
        logger,
      }),
    Error,
    "could not be verified",
  );
  assertEquals(gh.writes(), []);
  const mismatch = resolveFake();
  mismatch.views.set(
    `${GRQ}#3242`,
    JSON.stringify({ number: 1, state: "OPEN" }),
  );
  await assertRejects(
    () =>
      resolveWrongRepoDuplicate({
        wrong,
        correct,
        ctx: ctx(),
        gh: mismatch.run,
        logger,
      }),
    Error,
    "not found",
  );
  assertEquals(mismatch.writes(), []);
  const bad = resolveFake();
  bad.views.set(`${GRQ}#3242`, "not json");
  await assertRejects(
    () =>
      resolveWrongRepoDuplicate({
        wrong,
        correct,
        ctx: ctx(),
        gh: bad.run,
        logger,
      }),
    Error,
    "Malformed JSON",
  );
  assertEquals(bad.writes(), []);
});

Deno.test("resolve: unreadable or malformed wrong issue throws and closes nothing", async () => {
  const { logger } = makeRecordingLogger();
  const missing = resolveFake();
  missing.views.delete(`${VIBE}#3607`);
  await assertRejects(
    () =>
      resolveWrongRepoDuplicate({
        wrong,
        correct,
        ctx: ctx(),
        gh: missing.run,
        logger,
      }),
    Error,
    "nothing closed",
  );
  assertEquals(missing.writes(), []);
  const bad = resolveFake();
  bad.views.set(`${VIBE}#3607`, "<html>");
  await assertRejects(
    () =>
      resolveWrongRepoDuplicate({
        wrong,
        correct,
        ctx: ctx(),
        gh: bad.run,
        logger,
      }),
    Error,
    "Malformed JSON",
  );
  assertEquals(bad.writes(), []);
});

Deno.test("resolve: a failed comment stops before the close", async () => {
  for (const which of ["3242", "3607"]) {
    const gh = resolveFake();
    gh.failOn = (a) => a[1] === "comment" && a[2] === which;
    const { logger } = makeRecordingLogger();
    await assertRejects(
      () =>
        resolveWrongRepoDuplicate({
          wrong,
          correct,
          ctx: ctx(),
          gh: gh.run,
          logger,
        }),
      Error,
      "gh boom",
    );
    assert(!gh.calls.some((c) => c[1] === "close"));
  }
});

Deno.test("resolve: permission failure on either repo throws before any write", async () => {
  const { logger } = makeRecordingLogger();
  for (const [repo, perm] of [[VIBE, "READ"], [GRQ, "READ"]] as const) {
    const gh = resolveFake();
    gh.perms.set(repo, perm);
    await assertRejects(
      () =>
        resolveWrongRepoDuplicate({
          wrong,
          correct,
          ctx: ctx(),
          gh: gh.run,
          logger,
        }),
      IssueRoutingPermissionError,
    );
    assertEquals(gh.writes(), []);
  }
  const gh = resolveFake();
  await assertRejects(
    () =>
      resolveWrongRepoDuplicate({
        wrong,
        correct,
        ctx: ctx({ allowedRepos: [GRQ] }),
        gh: gh.run,
        logger,
      }),
    IssueRoutingPermissionError,
    "allowed",
  );
  assertEquals(gh.writes(), []);
});

Deno.test("resolve: same-repo duplicates check permission once; dry-run does nothing", async () => {
  const { logger } = makeRecordingLogger();
  const gh = new FakeGh();
  gh.views.set(`${VIBE}#5`, JSON.stringify({ number: 5, state: "OPEN" }));
  gh.views.set(`${VIBE}#6`, JSON.stringify({ body: "x", state: "OPEN" }));
  const out = await resolveWrongRepoDuplicate({
    wrong: { repo: VIBE, number: 6 },
    correct: { repo: VIBE, number: 5 },
    ctx: ctx(),
    gh: gh.run,
    logger,
  });
  assert(out.closedWrong);
  assertEquals(gh.calls.filter((c) => c[0] === "repo").length, 1);

  const dry = resolveFake();
  const res = await resolveWrongRepoDuplicate({
    wrong,
    correct,
    ctx: ctx({ dryRun: true }),
    gh: dry.run,
    logger,
  });
  assertEquals(res.closedWrong, false);
  assertStringIncludes(res.reason, "dry-run");
  assertEquals(dry.calls, []);
});
