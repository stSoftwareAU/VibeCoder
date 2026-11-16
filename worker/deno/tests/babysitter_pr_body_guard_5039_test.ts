import { assert, assertEquals, assertFalse } from "@std/assert";
import { guardPrBodyProposal } from "../lib/babysitter_pr_body_guard.ts";
import {
  buildIdempotencyMarker,
  githubClosingReferences,
  hasGithubClosingReference,
  hasGithubColonOrUrlClosingReference,
  maskCodeWithPlaceholder,
} from "../lib/pr_body.ts";
import { issueNumberFromMarker } from "../lib/pr_body_sync.ts";

const REPO = "owner/repo";

/** A summary whose criteria are all met and which closes #4637. */
const FULLY_MET_SUMMARY = [
  "## Summary",
  "",
  "Closes #4637.",
  "",
  "## Acceptance Criteria",
  "",
  "- **met** — the criterion — evidence: `x` — reviewer: met",
  "",
].join("\n");

/** A summary that says it is only part of #4674 and has a partial criterion. */
const PARTIAL_SUMMARY = [
  "## Summary",
  "",
  "Part of #4674.",
  "",
  "## Acceptance Criteria",
  "",
  "- **partial** — the closing criterion — reason: not finished",
  "",
].join("\n");

/** A live body the sync built for worker issue `issueNumber`. */
function liveBodyFor(issueNumber: number, closing: string): string {
  return `${closing}\n\n${buildIdempotencyMarker(issueNumber)}`;
}

function guardMet(proposal: string, liveBody: string): string {
  return guardPrBodyProposal({
    proposal,
    liveBody,
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "feature",
  });
}

Deno.test("a proposal ending in an unclosed fence keeps restored close and marker outside code (Issue #5039)", () => {
  const body = guardMet(
    "Rewritten.\n\n```\nconst x = 1;",
    liveBodyFor(4637, "Closes #4637"),
  );
  assert(hasGithubClosingReference(body, 4637, REPO));
  assertEquals(issueNumberFromMarker(maskCodeWithPlaceholder(body)), 4637);
});

Deno.test("a fence opened under a list item cannot swallow restored references (Issue #5039)", () => {
  const body = guardMet(
    "- item\n  ```\n  code",
    liveBodyFor(4637, "Closes #4637"),
  );
  assert(hasGithubClosingReference(body, 4637, REPO));
  assertEquals(issueNumberFromMarker(maskCodeWithPlaceholder(body)), 4637);
});

Deno.test("a line-wrapped or code-split close in the proposal does not keep the live close (Issue #5039)", () => {
  const live = liveBodyFor(4637, "Closes #4637\nCloses #99");
  for (const proposal of ["Done. Closes\n#99", "Done. Closes `x` #99"]) {
    const body = guardMet(proposal, live);
    assert(hasGithubClosingReference(body, 99, REPO), proposal);
  }
});

Deno.test("a valid colon, URL or qualified close in the proposal is not duplicated (Issue #5039)", () => {
  const live = liveBodyFor(4637, "Closes #4637\nCloses #99");
  for (
    const proposal of [
      "Done. Fixes: #99",
      "Done. Resolves https://github.com/owner/repo/issues/99",
      "Done. Closes owner/repo#99",
    ]
  ) {
    const body = guardMet(proposal, live);
    assertFalse(body.includes("Closes #99"), proposal);
    assert(
      hasGithubClosingReference(body, 99, REPO) ||
        hasGithubColonOrUrlClosingReference(body, 99, REPO),
      proposal,
    );
  }
});

Deno.test("a live colon close dropped by the proposal is restored (Issue #5039)", () => {
  const body = guardMet(
    "Done.",
    liveBodyFor(4637, "Closes #4637\nFixes: #99"),
  );
  assert(body.includes("Fixes: #99"));
  assert(hasGithubColonOrUrlClosingReference(body, 99, REPO));
});

Deno.test("a live line-wrapped impostor is not restored as a close (Issue #5039)", () => {
  const body = guardMet(
    "Done.",
    liveBodyFor(4637, "Closes #4637\nCloses\n#77"),
  );
  assertFalse(body.includes("#77"));
});

Deno.test("partial governing work with an unclosed fence stays non-closing (Issue #5039)", () => {
  const body = guardPrBodyProposal({
    proposal: "Rewritten.\n\n```\nCloses #4674",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: PARTIAL_SUMMARY,
    repo: REPO,
    headRefName: "feature",
  });
  assertFalse(hasGithubClosingReference(body, 4674, REPO));
  assertFalse(hasGithubColonOrUrlClosingReference(body, 4674, REPO));
  assert(maskCodeWithPlaceholder(body).includes("Part of #4674"));
});

Deno.test("code in an unclosed fence cannot forge a marker or keep a close (Issue #5039)", () => {
  const body = guardMet(
    "Rewritten.\n\n```\nCloses #99\n<!-- vibe-worker-issue-99 -->",
    liveBodyFor(4637, "Closes #4637\nCloses #99"),
  );
  assertFalse(body.includes("vibe-worker-issue-99"));
  assertEquals(issueNumberFromMarker(maskCodeWithPlaceholder(body)), 4637);
  assert(hasGithubClosingReference(body, 99, REPO));
});

Deno.test("githubClosingReferences reads only same-line, outside-code closes (Issue #5039)", () => {
  assertEquals(githubClosingReferences("Closes\n#9", REPO), []);
  assertEquals(githubClosingReferences("Closes `x` #9", REPO), []);
  assertEquals(githubClosingReferences("```\nCloses #4\n```", REPO), []);
  const text = [
    "Fixes: #9",
    "Resolves https://github.com/Owner/Repo/issues/8",
    "closes other/x#3",
    "Closes owner/repo#2",
  ].join("\n");
  const refs = githubClosingReferences(text, REPO);
  assertEquals(
    refs.map((ref) => [ref.issueNumber, ref.repository]),
    [[9, "owner/repo"], [8, "owner/repo"], [3, "other/x"], [2, "owner/repo"]],
  );
  assertEquals(
    refs.map((ref) => text.slice(ref.start, ref.end)),
    [
      "Fixes: #9",
      "Resolves https://github.com/Owner/Repo/issues/8",
      "closes other/x#3",
      "Closes owner/repo#2",
    ],
  );
});

Deno.test("a backtick opener with a backtick in its info string gets no closer (Issue #5039)", () => {
  const body = guardMet(
    "Rewritten.\n\n```js`x\ncode",
    liveBodyFor(4637, "Closes #4637"),
  );
  assertFalse(body.includes("code\n```"));
  assert(body.includes("Closes #4637"));
});

Deno.test("restored references and markers render outside list-exit and invalid-info fences", async () => {
  const { Parser, HtmlRenderer } = await import("commonmark") as unknown as {
    Parser: new () => { parse(text: string): unknown };
    HtmlRenderer: new () => { render(node: unknown): string };
  };
  for (
    const proposal of [
      "- item\n  ```\n  code\n\nOutside list.",
      "Rewritten.\n\n```js`x\ncode\n```\nactual code",
    ]
  ) {
    const body = guardMet(proposal, liveBodyFor(4637, "Closes #4637"));
    const html = new HtmlRenderer().render(new Parser().parse(body));
    assert(html.includes("<p>Closes #4637</p>"), html);
    assert(html.includes("<!-- vibe-worker-issue-4637 -->"), html);
  }
});

Deno.test("code references after invalid-info openers cannot suppress either restored close", async () => {
  const { Parser, HtmlRenderer } = await import("commonmark") as unknown as {
    Parser: new () => { parse(text: string): unknown };
    HtmlRenderer: new () => { render(node: unknown): string };
  };
  for (const number of [4637, 99]) {
    const proposal = "Rewritten.\n\n```js`x\ncode\n```\nCloses #" + number;
    const body = guardMet(
      proposal,
      liveBodyFor(4637, "Closes #4637\nCloses #99"),
    );
    const html = new HtmlRenderer().render(new Parser().parse(body));
    assert(html.includes("Closes #4637"), html);
    const prose = html.replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, "");
    assert(prose.includes("Closes #4637"), html);
    assert(prose.includes("Closes #99"), html);
    assert(prose.includes("<!-- vibe-worker-issue-4637 -->"), html);
  }
});

Deno.test("list exit followed by a new fence cannot suppress restored closes", async () => {
  const { Parser, HtmlRenderer } = await import("commonmark") as unknown as {
    Parser: new () => { parse(text: string): unknown };
    HtmlRenderer: new () => { render(node: unknown): string };
  };
  for (const number of [4637, 99]) {
    const proposal = "- item\n  ```\n  code\n\nOutside list.\n```\nCloses #" +
      number;
    const body = guardMet(
      proposal,
      liveBodyFor(4637, "Closes #4637\nCloses #99"),
    );
    const html = new HtmlRenderer().render(new Parser().parse(body));
    const prose = html.replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, "");
    assert(prose.includes("Closes #4637"), html);
    assert(prose.includes("Closes #99"), html);
    assert(prose.includes("<!-- vibe-worker-issue-4637 -->"), html);
  }
});
