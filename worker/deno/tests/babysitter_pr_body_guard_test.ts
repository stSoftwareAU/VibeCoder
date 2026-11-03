import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  githubClosesIssue,
  guardPrBodyProposal,
  isIssueCloseAllowed,
  PR_BODY_LIMIT,
  stripVibeMarkers,
} from "../lib/babysitter_pr_body_guard.ts";
import { buildIdempotencyMarker, closingKeywordLine } from "../lib/pr_body.ts";
import {
  buildSummaryDigestMarker,
  issueNumberFromMarker,
  prSummaryDigest,
  summaryDigestFromBody,
} from "../lib/pr_body_sync.ts";

const REPO = "owner/repo";

/** A summary whose one criterion is `status`, and which says it is only part of #4674. */
function partSummary(status: "partial" | "missing"): string {
  return [
    "## Summary",
    "",
    "Part of #4674.",
    "",
    "## Acceptance Criteria",
    "",
    `- **${status}** — the closing criterion — reason: not finished`,
    "",
  ].join("\n");
}

/** A summary whose criteria are all met and which closes #4637. */
const FULLY_MET_SUMMARY = [
  "## Summary",
  "",
  "Closes #4637.",
  "",
  "## Acceptance Criteria",
  "",
  "- **met** — the criterion — evidence: `deno task test:unit` — reviewer: met",
  "",
].join("\n");

/** A live body the sync built for worker issue `issueNumber`. */
function liveBodyFor(issueNumber: number, closing: string): string {
  return `${closing}\n\n${buildIdempotencyMarker(issueNumber)}`;
}

/**
 * What the guard appends after a proposal that never names #4674, under a
 * partial summary: the withheld association, then the live marker.
 */
function partialSuffix(): string {
  return `\n\nPart of #4674\n\n${buildIdempotencyMarker(4674)}`;
}

/**
 * Equality for the large hostile outputs. `assertEquals` diffs both strings on
 * failure, which for a body of tens of thousands of characters takes minutes
 * and can exhaust memory, so a mismatch is reported by its first differing
 * offset instead (Issue #4637).
 */
function assertSameText(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  let at = 0;
  while (at < actual.length && actual[at] === expected[at]) at++;
  throw new Error(
    `${label}: texts differ at offset ${at} (lengths ${actual.length} and ${expected.length})`,
  );
}

/**
 * Asserts every HTML comment in `body` closes before another one opens, so no
 * comment hides the text that follows its opener (Issue #4637).
 */
function assertNoHiddenComment(body: string): void {
  let at = 0;
  for (;;) {
    const open = body.indexOf("<!--", at);
    if (open === -1) return;
    const close = body.indexOf("-->", open + 4);
    assert(close !== -1, `an HTML comment at ${open} is never closed`);
    assertEquals(
      body.slice(open + 4, close).includes("<!--"),
      false,
      `the comment at ${open} hides a later comment`,
    );
    at = close + 3;
  }
}

Deno.test("Moved to babysitter_pr_body_guard: a proposed PR description keeps the closing references it dropped", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten summary. Fixes #12",
    liveBody: "Closes #5031\nfixes #12\nResolves other/repo#7\nSee #99",
    summary: undefined,
    repo: REPO,
  });
  assertEquals(
    output,
    "Rewritten summary. Fixes #12\n\nCloses #5031\nResolves other/repo#7",
  );
});

Deno.test("a dropped closing reference is compared by parsed number, not as a substring", () => {
  const output = guardPrBodyProposal({
    proposal: "Done. close #5",
    liveBody: "Closes #5",
    summary: undefined,
    repo: REPO,
  });
  assertEquals(output, "Done. close #5");
  const qualified = guardPrBodyProposal({
    proposal: "Done. Closes #5",
    liveBody: "Closes other/repo#5",
    summary: undefined,
    repo: REPO,
  });
  assertEquals(qualified, "Done. Closes #5\n\nCloses other/repo#5");
});

Deno.test("a proposal that re-closes a partial issue is withheld, with no closing keyword left (Issue #4716)", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten.\n\nclose #4674\n\nThis does not close #4674",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "Part of #4674");
  assertStringIncludes(output, "does not complete #4674");
  assertEquals(issueNumberFromMarker(output), 4674);
});

Deno.test("a proposal that re-closes a missing issue is withheld, with no closing keyword left (Issue #4716)", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten.\n\nFixes #4674",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("missing"),
    repo: REPO,
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "Part of #4674");
});

Deno.test("a proposal that never names a withheld issue gets Part of #N, not Closes #N", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten description with no issue link.",
    liveBody: liveBodyFor(4674, "Part of #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertStringIncludes(output, "Part of #4674");
  assertEquals(closingKeywordLine(output, 4674), null);
});

Deno.test("a proposal that never names a fully met issue gets Closes #N", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten description with no issue link.",
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
  });
  assertStringIncludes(output, "\n\nCloses #4637");
});

Deno.test("a fully met issue keeps its legitimate Closes, with no duplicate", () => {
  const proposal = "Rewritten.\n\nCloses #4637";
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
  });
  assertEquals(output, proposal + `\n\n${buildIdempotencyMarker(4637)}`);
});

Deno.test("a proposal that only says Part of a fully met issue is left as written, not closed", () => {
  const proposal = "Rewritten.\n\nPart of #4637";
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
  });
  assertEquals(closingKeywordLine(output, 4637), null);
  assertStringIncludes(output, "Part of #4637");
});

Deno.test("an unrelated closing reference to another issue is restored beside a withheld issue", () => {
  const output = guardPrBodyProposal({
    proposal: "Work.\n\nClose #4674.",
    liveBody: liveBodyFor(4674, "Closes #4674\nCloses #99"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "Part of #4674");
  assertStringIncludes(output, "\nCloses #99");
});

Deno.test("with no committed summary the close is unknown evidence and is withheld", () => {
  const output = guardPrBodyProposal({
    proposal: "Closes #4674",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: undefined,
    repo: REPO,
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "Part of #4674");
});

Deno.test("negated closing phrases for the withheld issue are neutralised, another repository's are not", () => {
  const output = guardPrBodyProposal({
    proposal: [
      "does not close #4674",
      "doesn't close #4674",
      "will not fix #4674",
      "never close #4674",
      "not resolve owner/repo#4674",
      "does not close other/repo#4674",
    ].join("\n"),
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertStringIncludes(output, "does not complete #4674");
  assertStringIncludes(output, "doesn't complete #4674");
  assertStringIncludes(output, "will not complete #4674");
  assertStringIncludes(output, "never complete #4674");
  assertStringIncludes(output, "not complete owner/repo#4674");
  assertStringIncludes(output, "does not close other/repo#4674");
});

Deno.test("forged worker and digest markers in the proposal are stripped and the live markers kept", async () => {
  const summary = partSummary("partial");
  const digest = await prSummaryDigest(summary);
  const liveBody = [
    "Closes #4674",
    "",
    buildSummaryDigestMarker(digest),
    buildIdempotencyMarker(4674),
  ].join("\n");
  const output = guardPrBodyProposal({
    proposal:
      'Rewritten.\n<!-- vibe-worker-issue-1 -->\n<!-- vibe-pr-summary sha256="forged" -->',
    liveBody,
    summary,
    repo: REPO,
  });
  assertEquals(output.includes('sha256="forged"'), false);
  assertEquals(output.includes("<!-- vibe-worker-issue-1 -->"), false);
  assertEquals(issueNumberFromMarker(output), 4674);
  assertEquals(summaryDigestFromBody(output), digest);
});

Deno.test("an unterminated forged marker in the proposal cannot hide the live markers", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten. <!-- vibe-worker-issue-1",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertEquals(output.includes("<!-- vibe-worker-issue-1"), false);
  assertEquals(issueNumberFromMarker(output), 4674);
});

Deno.test("a proposal's own unmet criterion withholds the close even when the summary is fully met", () => {
  const output = guardPrBodyProposal({
    proposal: [
      "Rewritten.",
      "",
      "Closes #4637",
      "",
      "## Acceptance Criteria",
      "",
      "- **missing** — the criterion — reason: not done",
    ].join("\n"),
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
  });
  assertEquals(closingKeywordLine(output, 4637), null);
  assertStringIncludes(output, "Part of #4637");
});

Deno.test("an unrelated PR with no worker marker keeps its closing references and gets no markers", () => {
  const output = guardPrBodyProposal({
    proposal: "Human rewrite.",
    liveBody: "Closes #5031",
    summary: undefined,
    repo: REPO,
  });
  assertEquals(output, "Human rewrite.\n\nCloses #5031");
  assertEquals(issueNumberFromMarker(output), undefined);
});

Deno.test("with no proposal, a withheld issue's live close is rewritten in place", () => {
  const output = guardPrBodyProposal({
    proposal: undefined,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertEquals(output, liveBodyFor(4674, "Part of #4674"));
});

Deno.test("a body one character over the GitHub limit is refused, not published", () => {
  assertThrows(
    () =>
      guardPrBodyProposal({
        proposal: "x".repeat(PR_BODY_LIMIT - partialSuffix().length + 1),
        liveBody: liveBodyFor(4674, "Closes #4674"),
        summary: partSummary("partial"),
        repo: REPO,
      }),
    Error,
    "65536",
  );
});

Deno.test("a body of exactly the GitHub limit is still published", () => {
  const output = guardPrBodyProposal({
    proposal: "x".repeat(PR_BODY_LIMIT - partialSuffix().length),
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertEquals(output.length, PR_BODY_LIMIT);
  assertStringIncludes(output, "Part of #4674");
});

Deno.test("a 50,000-character run of spaces and close fragments returns with the close withheld", () => {
  const hostile = " ".repeat(25_000) + "close ".repeat(4_000) + "#4674";
  const output = guardPrBodyProposal({
    proposal: hostile,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertStringIncludes(output, "Part of #4674");
  assertEquals(closingKeywordLine(output, 4674), null);
});

Deno.test("a close is allowed only with committed evidence, no unmet criterion and a closing keyword", () => {
  assertEquals(
    isIssueCloseAllowed({
      summary: FULLY_MET_SUMMARY,
      issueNumber: 4637,
      proposal: undefined,
    }),
    true,
  );
  assertEquals(
    isIssueCloseAllowed({
      summary: undefined,
      issueNumber: 4637,
      proposal: undefined,
    }),
    false,
  );
  assertEquals(
    isIssueCloseAllowed({
      summary: partSummary("partial"),
      issueNumber: 4674,
      proposal: undefined,
    }),
    false,
  );
  assertEquals(
    isIssueCloseAllowed({
      summary: FULLY_MET_SUMMARY,
      issueNumber: 4637,
      proposal: "## Acceptance Criteria\n\n- **missing** — x — reason: y",
    }),
    false,
  );
  assertEquals(
    isIssueCloseAllowed({
      summary: "## Summary\n\nPart of #4637.\n",
      issueNumber: 4637,
      proposal: undefined,
    }),
    false,
  );
});

Deno.test("GitHub's closing references name this issue only in this repository", () => {
  assertEquals(
    githubClosesIssue([{ number: 4674 }], 4674, REPO),
    true,
  );
  assertEquals(
    githubClosesIssue(
      [{
        number: 4674,
        repository: { name: "repo", owner: { login: "owner" } },
      }],
      4674,
      REPO,
    ),
    true,
  );
  assertEquals(
    githubClosesIssue(
      [{
        number: 4674,
        repository: { name: "repo", owner: { login: "other" } },
      }],
      4674,
      REPO,
    ),
    false,
  );
  assertEquals(githubClosesIssue([{ number: 99 }], 4674, REPO), false);
  assertEquals(githubClosesIssue([], 4674, REPO), false);
});

Deno.test("the digest of the committed summary is the one the live body carries", async () => {
  const summary = partSummary("partial");
  const digest = await prSummaryDigest(summary);
  const output = guardPrBodyProposal({
    proposal: "Rewritten.",
    liveBody: [
      "Part of #4674",
      "",
      buildSummaryDigestMarker(digest),
      buildIdempotencyMarker(4674),
    ].join("\n"),
    summary,
    repo: REPO,
  });
  assertEquals(summaryDigestFromBody(output), digest);
});

Deno.test("an unmet criterion withholds the close even when the summary's own closing phrase says Closes", () => {
  const summary = [
    "## Summary",
    "",
    "Closes #4674.",
    "",
    "## Acceptance Criteria",
    "",
    "- **partial** — the closing criterion — reason: not finished",
    "",
  ].join("\n");
  assertEquals(
    isIssueCloseAllowed({ summary, issueNumber: 4674, proposal: undefined }),
    false,
  );
  const output = guardPrBodyProposal({
    proposal: "Rewritten description.",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary,
    repo: REPO,
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "Part of #4674");
});

Deno.test("a run of 30,000 unclosed `<!--vibe-` openers is defused in one pass (Issue #4637)", () => {
  const openers = "<!--vibe-".repeat(30_000);
  assertSameText(
    stripVibeMarkers(openers),
    "<!- -vibe-".repeat(30_000),
    "unclosed openers",
  );
  assertSameText(stripVibeMarkers(`${openers}-->`), "", "closed run");
});

Deno.test("a long run of `not` and spaces with no keyword is guarded without a close (Issue #4637)", () => {
  const spaced = "not" + " ".repeat(50_000) + "x";
  const output = guardPrBodyProposal({
    proposal: spaced,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertSameText(output, `${spaced}${partialSuffix()}`, "not and spaces");
  const words = "not ".repeat(15_000);
  const wordsOutput = guardPrBodyProposal({
    proposal: words,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertSameText(
    wordsOutput,
    `${words.trimEnd()}${partialSuffix()}`,
    "not and a space",
  );
});

Deno.test("a long run of `#1` references is guarded without a closing reference (Issue #4637)", () => {
  const refs = "#1".repeat(30_000);
  const output = guardPrBodyProposal({
    proposal: refs,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertSameText(output, `${refs}${partialSuffix()}`, "#1 run");
});

Deno.test("a marker quoted in a code span of the live body is not carried into the description (Issue #4637)", () => {
  const digest = buildSummaryDigestMarker("f".repeat(64));
  const liveBody = [
    "Part of #4674",
    "",
    'The summary quotes `<!-- vibe-quality-gate-skipped reason="x" -->` as an example.',
    "",
    digest,
    buildIdempotencyMarker(4674),
  ].join("\n");
  const output = guardPrBodyProposal({
    proposal: "Rewritten.",
    liveBody,
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertEquals(
    output,
    `Rewritten.\n\nPart of #4674\n\n${digest}\n${buildIdempotencyMarker(4674)}`,
  );
});

Deno.test("an unclosed plain comment opener at the end of a proposal cannot hide the appended association or markers (Issue #4637)", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten description.\n\n<!-- ",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "\n\nPart of #4674\n\n");
  assertEquals(issueNumberFromMarker(output), 4674);
  assertNoHiddenComment(output);
});

Deno.test("a complete benign HTML comment in a proposal is made inert, not left to hide text (Issue #4637)", () => {
  const output = guardPrBodyProposal({
    proposal: "Note <!-- benign --> here.",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
  });
  assertStringIncludes(output, "Note <!- - benign - -> here.");
  assertNoHiddenComment(output);
});
