/**
 * Dependabot upkeep of the review-fleet-prs skill (Issue #3663). The App cannot
 * command Dependabot, so the gate never comments on a Dependabot PR: a
 * conflicting one is left for Dependabot to rebase, and an approved, unarmed
 * one gets auto-merge armed. post.ts brings an approved, behind one up to date.
 */
import { assert, assertEquals } from "@std/assert";
import { dependabotAction } from "../../../.claude/skills/review-fleet-prs/scripts/dependabot.ts";
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

// ---- post.ts end to end: an approved, behind Dependabot PR is updated ------

const CLEAN_REPLY = {
  summary: "Looks right.",
  findings: [],
  testChanges: "none",
};

Deno.test("post.ts end to end: an approved, behind Dependabot PR is updated and never commented on (Issue #3663)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "post-3663-" });
  try {
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin);
    // Mirrors gh on this path: GitHub REST "Update a pull request branch" answers 202 with message/url; gh exits non-zero on an HTTP error.
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh
echo "$@" >> "${tmp}/calls"
if [ "$1 $2" = "pr view" ]; then
  echo '{"headRefOid":"head-7","state":"OPEN","mergeStateStatus":"BEHIND"}'
elif [ "$1 $2" = "pr review" ]; then
  exit 0
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
    const result = JSON.parse(new TextDecoder().decode(out.stdout).trim());
    assertEquals(result.outcome, "approved");
    assertEquals(result.branchUpdated, true);
    const calls = (await Deno.readTextFile(`${tmp}/calls`)).trim().split("\n");
    assert(
      calls.includes(
        "api --method PUT repos/acme/app/pulls/7/update-branch -f expected_head_sha=head-7",
      ),
      calls.join("\n"),
    );
    assertEquals(calls.some((c) => c.includes("@dependabot")), false);
    assertEquals(calls.some((c) => c.startsWith("pr comment")), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
