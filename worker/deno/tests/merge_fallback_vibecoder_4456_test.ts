/**
 * A merge fallback is a VibeCoder failure (Issue #4456).
 *
 * The fallback record used to be filed as a new issue in the repository the
 * conflict was in, and for a PR with no originating issue it became the re-do
 * item. Owner rule: the fallback means the worker failed to finish the work,
 * so it is filed in VibeCoder, one open issue per cause, and a private source
 * repository is never named there.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMergeFallbackBody,
  fileMergeFallbackIssue,
  MERGE_FALLBACK_LABEL,
  MERGE_FALLBACK_TARGET_REPO,
  mergeFallbackCause,
  type MergeFallbackFiling,
  mergeFallbackTitle,
} from "../lib/merge_fallback_issue.ts";

const FLEET_AUTHOR = "vibe-coder-bot";
const SOURCE = "acme/secret-trading";

const MILESTONE: MergeFallbackFiling = {
  target: {
    kind: "milestone",
    repo: SOURCE,
    milestoneBranch: "milestone/3864-crates-policy-maximum-cost",
    defaultBranch: "Develop",
  },
  conflictedFiles: ["crates/policy/src/strategy.rs"],
  runs: [{
    run: 1,
    host: "vibe-coder-6674",
    timings: [{ stage: "agent", seconds: 0 }],
    analysis: [
      "Concluded `failed` at 2026-10-28T07:13:13.936Z: refused 2 cycles in a " +
      "row (the conflict resolver declined) — climbing to the next rung",
      "",
      "Files no rung could settle:",
      "- `crates/policy/src/strategy.rs` — agent: both sides rewrote #4541",
    ].join("\n"),
  }],
  behindBy: 71,
  fallbackAction: "revert conflicted on #4541. Nothing was left reverted.",
};

function fakeGh(visibility: string, listing = "[]") {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args: string[]) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === `repos/${SOURCE}`) {
        return Promise.resolve(`${visibility}\n`);
      }
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(listing);
      }
      if (args[0] === "issue" && args[1] === "create") {
        return Promise.resolve(
          `https://github.com/${MERGE_FALLBACK_TARGET_REPO}/issues/5000\n`,
        );
      }
      return Promise.resolve("");
    },
  };
}

function deps(gh: (args: string[]) => Promise<string>) {
  return {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
  };
}

function created(calls: string[][]): string[] {
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create, "the fallback must be filed");
  return create;
}

Deno.test("a fallback is filed in VibeCoder as a bug, never in the source repository (Issue #4456)", async () => {
  const { gh, calls } = fakeGh("private");
  const result = await fileMergeFallbackIssue(MILESTONE, deps(gh));

  assert(result.ok);
  const create = created(calls);
  assertEquals(create[create.indexOf("--repo") + 1], "stSoftwareAU/VibeCoder");
  const labels = create
    .map((arg, i) => (create[i - 1] === "--label" ? arg : null))
    .filter((arg): arg is string => arg !== null);
  assertEquals(labels.sort(), ["bug", MERGE_FALLBACK_LABEL].sort());
  assert(!create.includes("idle-task"));
  assert(
    !calls.some((c) => c.includes("--repo") && c.includes(SOURCE)),
    "nothing may be written to the source repository",
  );
});

Deno.test("the title names the cause, unwrapped from the refusal climb (Issue #4456)", () => {
  assertEquals(
    mergeFallbackCause(MILESTONE),
    "the conflict resolver declined",
  );
  assertEquals(
    mergeFallbackTitle(MILESTONE),
    "Merge fallback: the conflict resolver declined",
  );
  assertEquals(
    mergeFallbackCause({
      ...MILESTONE,
      runs: [{
        run: 1,
        analysis: "Concluded `failed` at 2026-10-28T01:12:49.982Z: the merge " +
          "gate refused the merged tree",
      }],
    }),
    "the merge gate refused the merged tree",
  );
  assertEquals(mergeFallbackCause({ ...MILESTONE, runs: [] }), "unclassified");
  assertEquals(
    mergeFallbackCause({ ...MILESTONE, cause: "PR conflict ladder exhausted" }),
    "PR conflict ladder exhausted",
  );
});

Deno.test("a private source is never named: no repo, branch, path or bare #N (Issue #4456)", () => {
  const body = buildMergeFallbackBody(MILESTONE, "private");
  for (
    const leak of [
      "acme",
      "secret-trading",
      "milestone/3864",
      "crates/policy",
      "strategy.rs",
      "Develop",
    ]
  ) {
    assert(!body.includes(leak), `the body leaks ${leak}:\n${body}`);
  }
  // VibeCoder's own issue reference is the only number allowed.
  assert(
    !/#\d/.test(body.replaceAll("(Issue #4456)", "")),
    `the body carries a source #N:\n${body}`,
  );
  // What stays: the host, the timings, the conclusion and how far behind.
  assertStringIncludes(body, "vibe-coder-6674");
  assertStringIncludes(body, "agent 0s");
  assertStringIncludes(body, "the conflict resolver declined");
  assertStringIncludes(body, "71");
});

Deno.test("a public source keeps the full record, with references qualified by repo (Issue #4456)", () => {
  const body = buildMergeFallbackBody(MILESTONE, "public");
  assertStringIncludes(body, SOURCE);
  assertStringIncludes(body, "milestone/3864-crates-policy-maximum-cost");
  assertStringIncludes(body, "crates/policy/src/strategy.rs");
  assertStringIncludes(body, `${SOURCE}#4541`);
  assert(
    !/(^|[^\w/])#4541/.test(body.replaceAll(`${SOURCE}#4541`, "")),
    "a bare #4541 would link to a VibeCoder issue",
  );
});

Deno.test("an unknown visibility is treated as private (Issue #4456)", async () => {
  const { gh, calls } = fakeGh("");
  const result = await fileMergeFallbackIssue(MILESTONE, deps(gh));
  assert(result.ok);
  const create = created(calls);
  const body = create[create.indexOf("--body") + 1] ?? "";
  assert(!body.includes("secret-trading"));
});

Deno.test("a second fallback with the same cause on another branch appends to the one open issue (Issue #4456)", async () => {
  const listing = JSON.stringify([{
    number: 4800,
    title: "Merge fallback: the conflict resolver declined",
    state: "OPEN",
    url: `https://github.com/${MERGE_FALLBACK_TARGET_REPO}/issues/4800`,
    author: { login: FLEET_AUTHOR },
  }]);
  const { gh, calls } = fakeGh("private", listing);
  const other: MergeFallbackFiling = {
    ...MILESTONE,
    target: {
      kind: "milestone",
      repo: SOURCE,
      milestoneBranch: "milestone/4050-reporting",
      defaultBranch: "Develop",
    },
  };
  const result = await fileMergeFallbackIssue(other, deps(gh));

  assert(result.ok);
  assertEquals(result.value.appended, true);
  assertEquals(result.value.issueNumber, 4800);
  assert(!calls.some((c) => c[0] === "issue" && c[1] === "create"));
  const comment = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  assert(comment);
  assertEquals(
    comment[comment.indexOf("--repo") + 1],
    "stSoftwareAU/VibeCoder",
  );
});
