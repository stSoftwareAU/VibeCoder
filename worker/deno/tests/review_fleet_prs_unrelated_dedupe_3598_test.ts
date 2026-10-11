/**
 * review-fleet-prs files the reviewer's out-of-scope findings as issues. A new
 * instance of a defect class that already has an open issue is added to that
 * issue as a comment instead of filed again, and a filed body carries the
 * footer exactly once (Issue #3598).
 */
import { assert, assertEquals } from "@std/assert";
import {
  type FableReview,
  parseFableReview,
  REVIEW_MARKER,
  reviewBody,
  type UnrelatedIssue,
  unrelatedIssueBody,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";
import { fileUnrelatedIssues } from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";

const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);
const SKILL = fromFileUrl(
  new URL(
    "../../../.claude/skills/review-fleet-prs/SKILL.md",
    import.meta.url,
  ),
);

const PR = {
  repo: "owner/repo",
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
};

const issue = (over: Partial<UnrelatedIssue> = {}): UnrelatedIssue => ({
  title: "Guard misses a percent-encoded number segment",
  file: "lib/guard.ts",
  line: 12,
  body: "The guard reads the raw path.",
  ...over,
});

const review = (unrelatedIssues: UnrelatedIssue[]): FableReview => ({
  summary: "ok",
  findings: [],
  testChanges: "none",
  testChangeNotes: [],
  unrelatedIssues,
});

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** A `gh` stub that records every call and answers from `answers`. */
function ghStub(
  answers: { view?: unknown; viewThrows?: boolean; list?: unknown[] },
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "issue" && sub === "view") {
      if (answers.viewThrows) return Promise.reject(new Error("gh: boom"));
      return Promise.resolve(JSON.stringify(answers.view));
    }
    if (cmd === "issue" && sub === "list") {
      return Promise.resolve(JSON.stringify(answers.list ?? []));
    }
    if (cmd === "issue" && sub === "create") {
      return Promise.resolve("https://github.com/owner/repo/issues/900");
    }
    if (cmd === "issue" && sub === "comment") return Promise.resolve("");
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  const did = (sub: string) =>
    calls.filter((c) => c[0] === "issue" && c[1] === sub);
  return { gh, calls, did };
}

Deno.test("parseFableReview keeps a positive whole-number existingIssue and drops any other value (Issue #3598)", () => {
  // At most three unrelated issues are kept per review, so two parses.
  const parse = (values: unknown[]) =>
    parseFableReview(JSON.stringify({
      ...review([]),
      unrelatedIssues: values.map((existingIssue, i) =>
        issue({ title: `t${i}`, existingIssue: existingIssue as number })
      ),
    })).unrelatedIssues.map((i) => i.existingIssue);
  assertEquals(parse([3568, 0, "3568"]), [3568, undefined, undefined]);
  assertEquals(parse([-4, 1.5, 12]), [undefined, undefined, 12]);
});

Deno.test("unrelatedIssueBody writes the footer once even when the reviewer's body already carries it (Issue #3598)", () => {
  const withFooter = issue({
    body: [
      "The guard reads the raw path.",
      "",
      `Found while reviewing ${PR.url}, but outside that PR's scope.`,
      "",
      `_${REVIEW_MARKER}._`,
    ].join("\n"),
  });
  const body = unrelatedIssueBody(withFooter, PR);
  assertEquals(count(body, "Found while reviewing"), 1);
  assertEquals(count(body, REVIEW_MARKER), 1);
  assert(body.includes("The guard reads the raw path."));
});

Deno.test("an unrelated issue naming an open existing issue is added there as a comment, not filed (Issue #3598)", async () => {
  const stub = ghStub({
    view: {
      number: 3568,
      url: "https://github.com/owner/repo/issues/3568",
      title: "Umbrella",
      state: "OPEN",
    },
  });
  const filed = await fileUnrelatedIssues(
    PR,
    review([issue({ existingIssue: 3568 })]),
    stub.gh,
  );
  assertEquals(stub.did("create").length, 0, "no new issue is filed");
  const comments = stub.did("comment");
  assertEquals(comments.length, 1);
  assertEquals(comments[0]![2], "3568");
  assertEquals(filed, [{
    number: 3568,
    url: "https://github.com/owner/repo/issues/3568",
    title: "Umbrella",
    addedTo: true,
  }]);
});

Deno.test("an existingIssue that is closed, or cannot be read, still files a new issue (Issue #3598)", async () => {
  for (
    const answers of [
      { view: { number: 3568, url: "u", title: "t", state: "CLOSED" } },
      { viewThrows: true },
    ]
  ) {
    const stub = ghStub(answers);
    const filed = await fileUnrelatedIssues(
      PR,
      review([issue({ existingIssue: 3568 })]),
      stub.gh,
    );
    assertEquals(stub.did("comment").length, 0);
    assertEquals(stub.did("create").length, 1, "the finding is never lost");
    assertEquals(filed.map((f) => f.number), [900]);
  }
});

Deno.test("with no existingIssue, an open issue with the same title is linked and nothing is filed (Issue #3598)", async () => {
  const stub = ghStub({
    list: [{ number: 41, url: "u41", title: issue().title }],
  });
  const filed = await fileUnrelatedIssues(PR, review([issue()]), stub.gh);
  assertEquals(stub.did("create").length, 0);
  assertEquals(stub.did("view").length, 0);
  assertEquals(filed.map((f) => f.number), [41]);
});

Deno.test("reviewBody names an issue the instance was added to, apart from newly filed ones (Issue #3598)", () => {
  const body = reviewBody("approved", review([]), [], [
    { number: 900, url: "u900", title: "New one" },
    { number: 3568, url: "u3568", title: "Umbrella", addedTo: true },
  ]);
  assert(body.includes("- #900 New one"));
  assert(/- #3568 Umbrella \(added as a new instance\)/.test(body));
});

Deno.test("SKILL.md tells the reviewer to search by file and defect class and to name an open issue in existingIssue (Issue #3598)", async () => {
  const skill = (await Deno.readTextFile(SKILL)).replace(/\s+/g, " ");
  assert(
    skill.includes('"existingIssue"'),
    "the JSON contract names existingIssue",
  );
  assert(
    /search[^.]*by the file path/i.test(skill),
    "the search goes by file path, not only the title",
  );
  assert(
    /same defect class/i.test(skill),
    "a match is the same defect class, including an umbrella issue",
  );
});
