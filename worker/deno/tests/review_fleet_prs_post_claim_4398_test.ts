/**
 * post.ts deletes the review claims at the reviewed head once its review is
 * posted, whichever host made them (Issue #4398).
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { claimBody } from "../../../.claude/skills/review-fleet-prs/scripts/claim.ts";
import { releaseClaimAtHead } from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";

const HEAD = "a".repeat(40);
const OLD = "0f0e0d0c0b0a";
const REPO = "acme/widgets";
const NUMBER = 42;
const EXPIRES = Date.parse("2026-10-26T12:00:00Z");

interface Row {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
}

const row = (id: number, body: string): Row => ({
  id,
  body,
  created_at: "2026-10-26T11:00:00Z",
  user: { login: "reviewer-app" },
});
const claim = (id: number, sha: string, host: string) =>
  row(id, claimBody(sha, host, EXPIRES));
const human = (id: number) =>
  row(
    id,
    `Saw this in the log: <!-- vibe-review-claim sha=${HEAD} host=mac expires=2026-10-26T12:00:00.000Z -->`,
  );

// Mirrors gh: the list is one JSON array of REST comments, and a DELETE
// removes the comment, or fails with a 404 once it is gone.
function fakeGh(
  initial: Row[],
  opts: { failDeleteOf?: number; listFails?: boolean } = {},
) {
  const comments = [...initial];
  const list = `repos/${REPO}/issues/${NUMBER}/comments`;
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === list && args[2] === "--paginate") {
      if (opts.listFails) {
        return Promise.reject(new Error("gh api: HTTP 502: Bad Gateway"));
      }
      return Promise.resolve(JSON.stringify(comments));
    }
    const del = args[0] === "api" && args[1] === "-X" && args[2] === "DELETE"
      ? /^repos\/acme\/widgets\/issues\/comments\/(\d+)$/.exec(args[3] ?? "")
      : null;
    if (del) {
      const id = Number(del[1]);
      if (id === opts.failDeleteOf) {
        return Promise.reject(
          new Error(`gh api ${args[3]}: HTTP 500: boom\nsecond line of stderr`),
        );
      }
      const at = comments.findIndex((c) => c.id === id);
      if (at < 0) {
        return Promise.reject(
          new Error(`gh api ${args[3]}: HTTP 404: Not Found`),
        );
      }
      comments.splice(at, 1);
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  return { gh, remaining: () => comments.map((c) => c.id) };
}

const pr = { repo: REPO, number: NUMBER, headSha: HEAD };

Deno.test("releaseClaimAtHead deletes the claims at the reviewed head whichever host made them", async () => {
  const fake = fakeGh([claim(10, HEAD, "mac-1"), claim(11, HEAD, "linux-2")]);
  const result = await releaseClaimAtHead(pr, fake.gh);
  assertEquals(result, { released: 2 });
  assertEquals(fake.remaining(), []);
});

Deno.test("releaseClaimAtHead leaves a claim at another head and a human comment that quotes the marker", async () => {
  const fake = fakeGh([
    claim(20, OLD, "mac-1"),
    human(21),
    claim(22, HEAD, "linux-2"),
  ]);
  const result = await releaseClaimAtHead(pr, fake.gh);
  assertEquals(result, { released: 1 });
  assertEquals(fake.remaining(), [20, 21]);
});

Deno.test("releaseClaimAtHead returns a failed delete as an error string, never throws, and keeps going", async () => {
  const fake = fakeGh(
    [
      claim(30, HEAD, "mac-1"),
      claim(31, HEAD, "linux-2"),
      claim(32, OLD, "mac-1"),
      human(33),
    ],
    { failDeleteOf: 30 },
  );
  const result = await releaseClaimAtHead(pr, fake.gh);
  assertEquals(result.released, 0);
  assertStringIncludes(result.error ?? "", "could not be deleted");
  assertStringIncludes(result.error ?? "", "30");
  // Only the first line of the message is reported.
  assertEquals((result.error ?? "").includes("\n"), false);
  assertEquals((result.error ?? "").includes("second line"), false);
  // The failed claim stays; the other claim at the head is still deleted;
  // the claim at the old head and the human comment are untouched.
  assertEquals(fake.remaining(), [30, 32, 33]);
});

Deno.test("releaseClaimAtHead returns a failed listing as an error string, never throws", async () => {
  const fake = fakeGh([claim(40, HEAD, "mac-1")], { listFails: true });
  const result = await releaseClaimAtHead(pr, fake.gh);
  assertEquals(result.released, 0);
  assertStringIncludes(result.error ?? "", "listing comments failed");
  assertEquals(fake.remaining(), [40]);
});

// The call site: `main()` runs as a subprocess, with a `gh` shim first on
// PATH, so the claim deletion after the posted review is exercised for real.
const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);
const POST = fromFileUrl(
  new URL(
    "../../../.claude/skills/review-fleet-prs/scripts/post.ts",
    import.meta.url,
  ),
);

// Answers the calls post.ts makes for an approved review with no findings and
// no removed tests; any other call exits 1 so the test fails loudly.
const SHIM = `#!/bin/sh
echo "$*" >> "$SHIM_LOG"
case "$*" in
  "pr view 42 -R acme/widgets --json headRefOid,state,mergeStateStatus,isDraft,mergeable")
    echo "{\\"headRefOid\\":\\"$SHIM_HEAD\\",\\"state\\":\\"OPEN\\",\\"mergeStateStatus\\":\\"CLEAN\\",\\"isDraft\\":false,\\"mergeable\\":\\"MERGEABLE\\"}" ;;
  "pr review "*) ;;
  "api repos/acme/widgets/issues/42/comments --paginate") cat "$SHIM_COMMENTS" ;;
  "api -X DELETE repos/acme/widgets/issues/comments/"*) echo "\${4##*/}" >> "$SHIM_DELETED" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

for (
  const mode of [
    "stable",
    "lookup-fails",
    "moved",
    "replay-owned",
    "replay-human",
  ]
) {
  const lookupFails = mode === "lookup-fails";
  const replay = mode.startsWith("replay-");
  Deno.test(`post.ts main posting safety: ${mode}`, async () => {
    const home = await Deno.makeTempDir();
    const bin = `${home}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      `${bin}/gh`,
      (lookupFails ? SHIM.replace("CLEAN", "BEHIND") : SHIM)
        .replace(
          'case "$*" in',
          `case "$*" in
  "pr view 42 -R acme/widgets --json closingIssuesReferences,headRefName,body")
    printf '%s' '{"closingIssuesReferences":[],"headRefName":"issue-3416-retries","body":""}' ;;
  "api repos/acme/widgets/issues/3416")
    printf '%s' '{"title":"Retries","body":"Use three retries","user":{"login":"owner"},"author_association":"OWNER"}' ;;
  "api repos/acme/widgets/contents/tests/retry_test.ts?ref=${HEAD}")
    printf '%s' '{"type":"file","encoding":"base64","content":"${
            btoa("test('retries three times', () => {});\n")
          }"}' ;;
  "pr edit 42 -R acme/widgets --remove-label needs-human") exit 0 ;;`,
        )
        .replace(
          '    echo "{',
          `    if [ -f "$SHIM_COUNT" ]; then
      ${mode === "moved" ? `SHIM_HEAD="${OLD}"` : ":"}
    fi
    touch "$SHIM_COUNT"
    echo "{`,
        ),
    );
    await Deno.chmod(`${bin}/gh`, 0o755);

    const round = `${home}/round`;
    await Deno.mkdir(round);
    const input = `${round}/input.json`;
    await Deno.writeTextFile(
      input,
      JSON.stringify({
        pr: {
          repo: REPO,
          number: NUMBER,
          title: "t",
          url: `https://github.com/${REPO}/pull/${NUMBER}`,
          headSha: HEAD,
          kind: "fleet",
          testChanges: { removed: [], edited: [] },
          checklistState: { problem: null, expected: [] },
          previousFindings: [],
        },
        review: {
          summary: "Looks right.",
          findings: [],
          testChanges: replay ? "meaningful" : "none",
          testChangeNotes: replay
            ? [{
              file: "tests/retry_test.ts",
              line: 7,
              change: "expects 3 retries instead of 2",
              kind: "expected-value",
              verdict: "justified",
              obsolete: "The old default of two retries.",
              remaining: "Asserts the new default of three retries.",
              coverage: [{
                role: "existing",
                path: "tests/retry_test.ts",
                name: "retries three times",
              }],
              requirementQuote: "Use three retries",
              failsWithoutChange: "fails on the base branch with two retries",
              verification: "reverted the default to 2; the test failed",
            }]
            : [],
        },
      }),
    );
    const comments = `${home}/comments.json`;
    await Deno.writeTextFile(
      comments,
      JSON.stringify([
        claim(11, HEAD, "mac-1"),
        claim(12, OLD, "mac-1"),
        human(13),
      ]),
    );
    const shimLog = `${home}/gh.log`;
    const deleted = `${home}/deleted.txt`;
    if (replay) {
      await Deno.mkdir(`${home}/state`);
      await Deno.writeTextFile(
        `${home}/state/log.jsonl`,
        JSON.stringify({
          at: "2026-10-26T11:00:00Z",
          repo: REPO,
          number: NUMBER,
          headSha: HEAD,
          outcome: "held",
          summary: "Policy-1 test hold",
          findings: [],
          addedNeedsHuman: mode === "replay-owned",
        }) + "\n",
      );
    }

    const denoDir = Deno.execPath().replace(/\/[^/]*$/, "");
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-lock",
        "--allow-run=gh,osascript",
        "--allow-read",
        "--allow-write",
        "--allow-env=HOME,XDG_STATE_HOME",
        POST,
        `--input=${input}`,
        `--state-dir=${home}/state`,
      ],
      env: {
        HOME: home,
        TMPDIR: home,
        PATH: `${bin}:${denoDir}:/usr/bin:/bin`,
        SHIM_HEAD: HEAD,
        SHIM_COMMENTS: comments,
        SHIM_LOG: shimLog,
        SHIM_DELETED: deleted,
        SHIM_COUNT: `${home}/head-read`,
      },
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 0, `post.ts failed: ${stderr}`);
    // Deno's own note about `osascript` (absent on Linux) is not post.ts's.
    assertEquals(stderr.includes("could not delete the review claim"), false);

    const result = JSON.parse(new TextDecoder().decode(out.stdout).trim());
    const calls = (await Deno.readTextFile(shimLog)).trim().split("\n");
    if (mode === "moved") {
      assertEquals(result.posted, false);
      assertEquals(result.reason, `now ${OLD} OPEN`);
      assertEquals(calls.some((c) => c.startsWith("pr review ")), false);
      assertEquals(calls.some((c) => c.startsWith("pr edit ")), false);
      return;
    }
    assertEquals(result.posted, true);
    assertEquals(result.outcome, "approved", JSON.stringify(result));
    const record = JSON.parse(
      (await Deno.readTextFile(`${home}/state/log.jsonl`)).trim().split("\n")
        .at(-1)!,
    );
    assertEquals(record.outcome, "approved");
    if (replay) assertEquals(record.testChangesReviewed, true);
    if (lookupFails) assertStringIncludes(stderr, "branch refresh skipped");

    // Only the claim at the reviewed head is deleted: the claim at the old head
    // and the human comment that quotes the marker stay.
    const deletedIds = (await Deno.readTextFile(deleted)).trim().split("\n");
    assertEquals(deletedIds, ["11"]);

    // The review is posted before the claim is deleted.
    assertEquals(
      calls.some((c) => c.includes("--remove-label needs-human")),
      mode === "replay-owned",
    );
    assertEquals(calls.some((c) => c.includes("--approve")), true);
    if (lookupFails) assertEquals(calls.includes("api user --jq .login"), true);
    const reviewAt = calls.findIndex((c) => c.startsWith("pr review "));
    const deleteAt = calls.findIndex((c) => c.includes("-X DELETE"));
    assertEquals(reviewAt >= 0 && deleteAt > reviewAt, true, calls.join("\n"));
  });
}
