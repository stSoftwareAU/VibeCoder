import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  REVIEW_MARKER,
  type SearchPr,
  skipReason,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";
import {
  CURRENT_REVIEW_POLICY,
  policyMarker,
} from "../../../.claude/skills/review-fleet-prs/scripts/reviewer_policy.ts";

// Public PR #4645: the held review at this head records the old refusal
// expectation and its replacement. The fixture does not contact GitHub.
const HEAD = "6b9657bc2c42f0f4040a56da692e9d1d4f5cf13d";
const REPO = "stSoftwareAU/VibeCoder";
const FILE = "worker/deno/tests/milestone_merge_only_4326_test.ts";
const oldBody =
  `Held for owner review: this PR changes existing tests.\n\nThe expected value changes from true to undefined for the cargo-withhold verdict.\n\n_${REVIEW_MARKER}._`;
const searchPr = (body = oldBody): SearchPr => ({
  number: 4645,
  title: "Cargo-budget withholds",
  url: `https://github.com/${REPO}/pull/4645`,
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: HEAD,
  baseRefName: "main",
  repository: { nameWithOwner: REPO, defaultBranchRef: { name: "main" } },
  author: { login: "VibeCoderST" },
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: { state: "SUCCESS" },
        checkSuites: { nodes: [] },
      },
    }],
  },
  reviews: {
    nodes: [{
      author: { login: "stsoftware-pr-reviewer" },
      commit: { oid: HEAD },
      state: "COMMENTED",
      body,
    }],
  },
});
const review = {
  summary: "The new verdict leaves the refusal counter unchanged.",
  findings: [],
  testChanges: "meaningful",
  testChangeNotes: [{
    file: FILE,
    line: 280,
    change: "Reverse the refusal expectation",
    kind: "expected-value",
    criterionQuote: "Leave refusedCycles unchanged for a cargo withhold",
    oldBehaviour: "A cargo withhold counted as a refusal.",
    requiredBehaviour: "A cargo withhold leaves the counter unchanged.",
    coverage:
      "The sweep, pre-cut sync and verdict tests check the counter and verdict.",
    regressionCheck: {
      method: "mutation",
      command: "deno test milestone_cargo_withhold_not_counted_4588_test.ts",
      break: "restore refusal: true",
      result: "counter assertion fails",
    },
  }],
  unrelatedIssues: [],
  checklist: [],
};
const post = decodeURIComponent(
  new URL(
    "../../../.claude/skills/review-fleet-prs/scripts/post.ts",
    import.meta.url,
  ).pathname,
);
const shim = `#!/bin/sh
echo "$*" >> "$SHIM_LOG"
case "$*" in
  "pr view 4645 -R stSoftwareAU/VibeCoder --json headRefOid,state,mergeStateStatus,isDraft,mergeable") echo "{\\"headRefOid\\":\\"$SHIM_HEAD\\",\\"state\\":\\"OPEN\\",\\"mergeStateStatus\\":\\"CLEAN\\",\\"isDraft\\":false,\\"mergeable\\":\\"MERGEABLE\\"}" ;;
  "pr view 4645 -R stSoftwareAU/VibeCoder --json headRefOid,state") echo "{\\"headRefOid\\":\\"$SHIM_HEAD\\",\\"state\\":\\"OPEN\\"}" ;;
  "pr view 4645 -R stSoftwareAU/VibeCoder --json closingIssuesReferences,body,headRefName") echo '{"closingIssuesReferences":[{"repository":{"owner":{"login":"stSoftwareAU"},"name":"VibeCoder"},"number":4588}],"body":"","headRefName":"issue-4588-fix"}' ;;
  "issue view 4588 -R stSoftwareAU/VibeCoder --json title,body") echo '{"title":"Cargo withhold","body":"Leave refusedCycles unchanged for a cargo withhold"}' ;;
  "api repos/stSoftwareAU/VibeCoder/pulls/4645/reviews --method POST "*) for arg in "$@"; do case "$arg" in body=@*) cp "\${arg#body=@}" "$SHIM_BODY" ;; esac; done; echo "{\\"user\\":{\\"login\\":\\"stsoftware-pr-reviewer[bot]\\"},\\"commit_id\\":\\"$SHIM_HEAD\\"}" ;;
  "api repos/stSoftwareAU/VibeCoder/issues/4645/events --paginate --slurp") echo '[[{"event":"labeled","actor":{"login":"stsoftware-pr-reviewer[bot]"},"label":{"name":"needs-human"},"created_at":"2026-11-01T18:30:32Z"}]]' ;;
  "api repos/stSoftwareAU/VibeCoder/pulls/4645/reviews --paginate --slurp") echo "[[{\\"state\\":\\"COMMENTED\\",\\"user\\":{\\"login\\":\\"stsoftware-pr-reviewer[bot]\\"},\\"commit_id\\":\\"$SHIM_HEAD\\",\\"body\\":\\"Held for owner review: this PR changes existing tests. Automated review by /review-fleet-prs\\",\\"submitted_at\\":\\"2026-11-01T18:30:27Z\\"}]]" ;;
  "api repos/stSoftwareAU/VibeCoder/issues/4645/comments --paginate") echo '[]' ;;
  "pr edit 4645 -R stSoftwareAU/VibeCoder --remove-label needs-human") ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

async function replay(
  owned: boolean,
  moved = false,
  finding = false,
  crossHost = false,
) {
  const home = await Deno.makeTempDir();
  const bin = `${home}/bin`, state = `${home}/state`;
  await Deno.mkdir(bin);
  await Deno.mkdir(state);
  await Deno.writeTextFile(`${bin}/gh`, shim);
  await Deno.chmod(`${bin}/gh`, 0o755);
  if (!crossHost) {
    await Deno.writeTextFile(
      `${state}/log.jsonl`,
      JSON.stringify({
        at: "2026-11-02T00:00:00Z",
        repo: REPO,
        number: 4645,
        outcome: "held",
        headSha: HEAD,
        addedNeedsHuman: owned,
      }) + "\n",
    );
  }
  const input = `${home}/input.json`;
  await Deno.writeTextFile(
    input,
    JSON.stringify({
      pr: {
        repo: REPO,
        number: 4645,
        title: "Cargo-budget withholds",
        url: `https://github.com/${REPO}/pull/4645`,
        headSha: HEAD,
        kind: "fleet",
        reconsideredTestHold: crossHost,
        testChanges: { removed: [], edited: [FILE] },
        checklistState: { problem: null, expected: [] },
        previousFindings: [],
      },
      review: {
        ...review,
        findings: finding
          ? [{
            file: FILE,
            line: 280,
            problem: "The widened range is tautological and cannot fail.",
            fix: "Assert the required counter value.",
          }]
          : [],
      },
    }),
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-lock",
      "--allow-run=gh,osascript",
      "--allow-read",
      "--allow-write",
      "--allow-env=HOME,XDG_STATE_HOME",
      post,
      `--input=${input}`,
      `--state-dir=${state}`,
      "--no-model",
    ],
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      SHIM_HEAD: moved ? "new-head" : HEAD,
      SHIM_LOG: `${home}/calls`,
      SHIM_BODY: `${home}/body`,
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return {
    result: JSON.parse(new TextDecoder().decode(out.stdout).trim()),
    calls: await Deno.readTextFile(`${home}/calls`),
    body: await Deno.readTextFile(`${home}/body`).catch(() => ""),
  };
}

Deno.test("public old hold is discovered once and replay posts at the assessed head", async () => {
  assertEquals(
    await skipReason(
      searchPr(),
      "stsoftware-pr-reviewer",
      undefined,
      undefined,
      CURRENT_REVIEW_POLICY,
    ),
    null,
  );
  const result = await replay(true);
  assertEquals(result.result.outcome, "approved");
  assertStringIncludes(result.calls, `commit_id=${HEAD}`);
  assertStringIncludes(result.calls, "--remove-label needs-human");
  assertStringIncludes(result.body, policyMarker(CURRENT_REVIEW_POLICY));
  assertEquals(
    await skipReason(
      searchPr(result.body),
      "stsoftware-pr-reviewer",
      undefined,
      undefined,
      CURRENT_REVIEW_POLICY,
    ),
    "already-reviewed",
  );
});

Deno.test("replay preserves a pre-existing hold and sends a vacuous assertion back", async () => {
  const result = await replay(false, false, true);
  assertEquals(result.result.outcome, "changes_requested");
  assertStringIncludes(result.body, "tautological");
  assertEquals(result.calls.includes("--remove-label needs-human"), false);
});

Deno.test("replay recovers another host's reviewer-owned label from GitHub", async () => {
  const result = await replay(false, false, false, true);
  assertEquals(result.result.outcome, "approved");
  assertStringIncludes(result.calls, "issues/4645/events --paginate --slurp");
  assertStringIncludes(result.calls, "--remove-label needs-human");
});

Deno.test("replay posts nothing when the head moved", async () => {
  const result = await replay(true, true);
  assertEquals(result.result.posted, false);
  assertEquals(result.calls.includes("/pulls/4645/reviews"), false);
  assertEquals(result.calls.includes("--remove-label"), false);
});
