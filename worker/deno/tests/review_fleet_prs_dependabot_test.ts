/**
 * Dependabot upkeep of the review-fleet-prs skill (Issue #3663). The App cannot
 * command Dependabot, so the gate never comments on a Dependabot PR: a
 * conflicting one is left for Dependabot to rebase, and an approved, unarmed
 * one gets auto-merge armed. post.ts arms auto-merge on an approved, behind
 * one and then brings it up to date.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dependabotAction } from "../../../.claude/skills/review-fleet-prs/scripts/dependabot.ts";
import { armDependabotAutoMerge } from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";
import type { SearchPr } from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

const pr = (over: Partial<SearchPr> = {}): SearchPr => ({
  number: 30,
  title: "chore: bump x",
  url: "https://github.com/o/r/pull/30",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  headRefOid: "head",
  baseRefName: "Develop",
  repository: {
    nameWithOwner: "o/r",
    defaultBranchRef: { name: "Develop" },
    autoMergeAllowed: true,
    squashMergeAllowed: true,
    mergeCommitAllowed: true,
  },
  author: { login: "app/dependabot" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  reviews: { nodes: [] },
  ...over,
});

const approved = {
  nodes: [{
    author: { login: "nleck" },
    state: "APPROVED",
    body: "",
    commit: { oid: "head" },
  }],
};

Deno.test("a conflicting Dependabot PR is left to Dependabot, approved or not (Issue #3663)", () => {
  assertEquals(
    dependabotAction(pr({ mergeable: "CONFLICTING" }), "nleck").kind,
    "conflicting",
  );
  assertEquals(
    dependabotAction(
      pr({ mergeable: "CONFLICTING", reviews: approved }),
      "nleck",
    )
      .kind,
    "conflicting",
  );
});

Deno.test("a behind Dependabot PR approved by the reviewer at its head gets auto-merge armed first (Issue #3663)", () => {
  assertEquals(
    dependabotAction(
      pr({ mergeStateStatus: "BEHIND", reviews: approved }),
      "nleck",
    ),
    { kind: "auto-merge", method: "squash" },
  );
  assertEquals(
    dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck"),
    { kind: "none", reason: "not approved" },
  );
});

Deno.test("an approved, up-to-date Dependabot PR gets auto-merge armed with the repo's allowed method", () => {
  assertEquals(
    dependabotAction(pr({ reviews: approved }), "nleck"),
    { kind: "auto-merge", method: "squash" },
  );
  assertEquals(
    dependabotAction(
      pr({
        reviews: approved,
        repository: { ...pr().repository, squashMergeAllowed: false },
      }),
      "nleck",
    ),
    { kind: "auto-merge", method: "merge" },
  );
});

Deno.test("no auto-merge without the reviewer's approval at the head, when already armed, or when the repo forbids it", () => {
  assertEquals(dependabotAction(pr(), "nleck").kind, "none");
  const stale = {
    nodes: [{ ...approved.nodes[0]!, commit: { oid: "older" } }],
  };
  assertEquals(
    dependabotAction(pr({ reviews: stale }), "nleck").kind,
    "none",
  );
  assertEquals(
    dependabotAction(
      pr({ reviews: approved, autoMergeRequest: { enabledAt: "t" } }),
      "nleck",
    ).kind,
    "none",
  );
  assertEquals(
    dependabotAction(
      pr({
        reviews: approved,
        repository: { ...pr().repository, autoMergeAllowed: false },
      }),
      "nleck",
    ).kind,
    "none",
  );
  assertEquals(
    dependabotAction(
      pr({ isDraft: true, mergeStateStatus: "BEHIND" }),
      "nleck",
    ).kind,
    "none",
  );
});

// ---- post.ts: auto-merge is armed before the update ------------------------

// Answers the repo-settings query and records every gh call.
const fakeGh = (
  settings: Record<string, boolean>,
  merge: () => string = () => "",
) => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify(settings));
    }
    if (args[0] === "pr" && args[1] === "merge") {
      return Promise.resolve(merge());
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { gh, calls };
};

Deno.test("armDependabotAutoMerge arms with the repo's allowed method (Issue #3663)", async () => {
  const { gh, calls } = fakeGh({
    autoMergeAllowed: true,
    squashMergeAllowed: false,
    mergeCommitAllowed: true,
  });
  assertEquals(
    await armDependabotAutoMerge({ repo: "acme/app", number: 7 }, gh),
    { armed: true, method: "merge" },
  );
  assertEquals(calls.at(-1), [
    "pr",
    "merge",
    "7",
    "-R",
    "acme/app",
    "--auto",
    "--merge",
  ]);
});

Deno.test("armDependabotAutoMerge leaves a repo that forbids auto-merge alone, and reports a refusal (Issue #3663)", async () => {
  const forbids = fakeGh({
    autoMergeAllowed: false,
    squashMergeAllowed: true,
    mergeCommitAllowed: true,
  });
  assertEquals(
    await armDependabotAutoMerge({ repo: "acme/app", number: 7 }, forbids.gh),
    undefined,
  );
  assertEquals(forbids.calls.some((c) => c[1] === "merge"), false);
  const refused = fakeGh({
    autoMergeAllowed: true,
    squashMergeAllowed: true,
    mergeCommitAllowed: true,
  }, () => {
    throw new Error("gh pr: auto-merge is not allowed\nmore");
  });
  assertEquals(
    await armDependabotAutoMerge({ repo: "acme/app", number: 7 }, refused.gh),
    { armed: false, error: "gh pr: auto-merge is not allowed" },
  );
});

// ---- post.ts end to end: an approved, behind Dependabot PR is updated ------

const CLEAN_REPLY = {
  summary: "Looks right.",
  findings: [],
  testChanges: "none",
};

// Runs post.ts on an approved, behind Dependabot PR #7 against a gh stub that
// answers only the calls post.ts makes on this path and exits 1 on any other.
// `mergeExit` is the exit code of `gh pr merge --auto`.
async function postBehindDependabot(mergeExit: number) {
  const tmp = await Deno.makeTempDir({ prefix: "post-3663-" });
  try {
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin);
    // Mirrors gh on this path: the GraphQL repository fields autoMergeAllowed/squashMergeAllowed/mergeCommitAllowed under --jq .data.repository; `gh pr merge --auto` prints nothing on success; GitHub REST "Update a pull request branch" answers 202 with message/url; gh exits non-zero on an HTTP error.
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh
echo "$@" >> "${tmp}/calls"
if [ "$1 $2" = "pr view" ]; then
  echo '{"headRefOid":"head-7","state":"OPEN","mergeStateStatus":"BEHIND","autoMergeRequest":null}'
elif [ "$1 $2" = "pr review" ]; then
  exit 0
elif [ "$1 $2" = "api graphql" ]; then
  echo '{"autoMergeAllowed":true,"mergeCommitAllowed":true,"squashMergeAllowed":true}'
elif [ "$*" = "pr merge 7 -R acme/app --auto --squash" ]; then
  [ ${mergeExit} -eq 0 ] || echo "GraphQL: Pull request is in clean status" >&2
  exit ${mergeExit}
elif [ "$*" = "api --method PUT repos/acme/app/pulls/7/update-branch -f expected_head_sha=head-7" ]; then
  echo '{"message":"Updating pull request branch.","url":"https://github.com/acme/app/pull/7"}'
else
  echo "gh stub: unexpected call: $*" >&2
  exit 1
fi
`,
      { mode: 0o755 },
    );
    const input = `${tmp}/input.json`;
    await Deno.writeTextFile(
      input,
      JSON.stringify({
        pr: {
          repo: "acme/app",
          number: 7,
          title: "chore: bump x",
          url: "https://github.com/acme/app/pull/7",
          headSha: "head-7",
          kind: "dependabot",
          testChanges: { removed: [], edited: [] },
          checklistState: { problem: null, expected: [] },
        },
        review: CLEAN_REPLY,
      }),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL(
          "../../../.claude/skills/review-fleet-prs/scripts/post.ts",
          import.meta.url,
        ).pathname,
        `--input=${input}`,
        `--state-dir=${tmp}/state`,
      ],
      env: { PATH: `${bin}:${Deno.env.get("PATH")}`, HOME: tmp },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assert(out.success, stderr);
    return {
      result: JSON.parse(new TextDecoder().decode(out.stdout).trim()),
      calls: (await Deno.readTextFile(`${tmp}/calls`)).trim().split("\n"),
    };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

const UPDATE_CALL =
  "api --method PUT repos/acme/app/pulls/7/update-branch -f expected_head_sha=head-7";

Deno.test("post.ts end to end: an approved, behind Dependabot PR gets auto-merge armed, then is updated, and is never commented on (Issue #3663)", async () => {
  const { result, calls } = await postBehindDependabot(0);
  assertEquals(result.outcome, "approved");
  assertEquals(result.branchUpdated, true);
  assertEquals(result.autoMergeArmed, "squash");
  const armed = calls.indexOf("pr merge 7 -R acme/app --auto --squash");
  const updated = calls.indexOf(UPDATE_CALL);
  assert(armed >= 0 && updated > armed, calls.join("\n"));
  assertEquals(calls.some((c) => c.includes("@dependabot")), false);
  assertEquals(calls.some((c) => c.startsWith("pr comment")), false);
});

Deno.test("post.ts end to end: a Dependabot PR whose auto-merge is refused is not updated, so the next gate pass can arm it at the approved head (Issue #3663)", async () => {
  const { result, calls } = await postBehindDependabot(1);
  assertEquals(result.outcome, "approved");
  assertStringIncludes(
    result.autoMergeError,
    "Pull request is in clean status",
  );
  assertEquals(result.branchUpdated, undefined);
  assertEquals(calls.includes(UPDATE_CALL), false);
});
