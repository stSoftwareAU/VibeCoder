import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertWithheld,
  githubClosesIssue,
  guardPrBodyProposal,
  isIssueCloseAllowed,
  PR_BODY_LIMIT,
  stripVibeMarkers,
} from "../lib/babysitter_pr_body_guard.ts";
import {
  buildIdempotencyMarker,
  closingKeywordLine,
  hasGithubClosingReference,
} from "../lib/pr_body.ts";
import {
  buildSummaryDigestMarker,
  issueNumberFromMarker,
  prSummaryDigest,
  summaryDigestFromBody,
} from "../lib/pr_body_sync.ts";

const REPO = "owner/repo";

Deno.test("a withheld issue association is preserved when only another repository is mentioned (PR #4779 review)", () => {
  for (
    const [mention, appended] of [["owner/other#4674", true], [
      "owner/repo#4674",
      false,
    ], ["#4674", false]] as const
  ) {
    const output = guardPrBodyProposal({
      proposal: `Rewritten. Ported from ${mention}.`,
      liveBody: liveBodyFor(4674, "Closes #4674"),
      summary: partSummary("partial"),
      repo: REPO,
      headRefName: "feature",
    });
    assertEquals(output.includes("Part of #4674"), appended);
  }
});

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
    headRefName: "feature",
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
    headRefName: "feature",
  });
  assertEquals(output, "Done. close #5");
  const qualified = guardPrBodyProposal({
    proposal: "Done. Closes #5",
    liveBody: "Closes other/repo#5",
    summary: undefined,
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(qualified, "Done. Closes #5\n\nCloses other/repo#5");
});

Deno.test("a proposal that re-closes a partial issue is withheld, with no closing keyword left (Issue #4716)", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten.\n\nclose #4674\n\nThis does not close #4674",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
  });
  assertEquals(output, proposal + `\n\n${buildIdempotencyMarker(4637)}`);
});

Deno.test("a close split by a line break does not settle the close, so Closes #N is appended (Issue #4964)", () => {
  const proposal = "Rewritten.\n\nCloses\n#4637.";
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "issue-4637-thing",
  });
  assertEquals(
    output,
    `${proposal}\n\nCloses #4637\n\n${buildIdempotencyMarker(4637)}`,
  );
  assert(hasGithubClosingReference(output, 4637, REPO));
});

Deno.test("a close with code between the keyword and #N does not settle the close, so Closes #N is appended (Issue #4964)", () => {
  const proposal = "Rewritten.\n\nCloses `x` #4637.";
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "issue-4637-thing",
  });
  assertEquals(
    output,
    `${proposal}\n\nCloses #4637\n\n${buildIdempotencyMarker(4637)}`,
  );
  assert(hasGithubClosingReference(output, 4637, REPO));
});

Deno.test("a same-repository qualified close is honoured, and another repository's is not (Issue #4964)", () => {
  const same = "Rewritten.\n\nCloses owner/repo#4637";
  const sameOutput = guardPrBodyProposal({
    proposal: same,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "issue-4637-thing",
  });
  assertEquals(sameOutput, `${same}\n\n${buildIdempotencyMarker(4637)}`);
  const other = "Rewritten.\n\nCloses other/repo#4637";
  const otherOutput = guardPrBodyProposal({
    proposal: other,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "issue-4637-thing",
  });
  assertEquals(
    otherOutput,
    `${other}\n\nCloses #4637\n\n${buildIdempotencyMarker(4637)}`,
  );
});

Deno.test("a colon or full-URL close is honoured for this repository in any case, and another repository's is not (PR #5038 review)", () => {
  const guard = (proposal: string) =>
    guardPrBodyProposal({
      proposal,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "issue-4637-thing",
    });
  for (
    const close of [
      "Closes: Owner/Repo#4637",
      "Closes https://github.com/Owner/Repo/issues/4637",
    ]
  ) {
    const proposal = `Rewritten.\n\n${close}`;
    assertEquals(
      guard(proposal),
      `${proposal}\n\n${buildIdempotencyMarker(4637)}`,
      `${close} closes this repository's issue, so nothing is appended`,
    );
  }
  for (
    const close of [
      "Closes: other/repo#4637",
      "Closes https://github.com/other/repo/issues/4637",
    ]
  ) {
    const proposal = `Rewritten.\n\n${close}`;
    assertEquals(
      guard(proposal),
      `${proposal}\n\nCloses #4637\n\n${buildIdempotencyMarker(4637)}`,
      `${close} closes another repository's issue, so Closes #4637 is appended`,
    );
  }
});

Deno.test("a same-line close joined by a tab or written as Fixes is left unchanged (Issue #4964)", () => {
  for (const close of ["Closes\t#4637", "Fixes #4637"]) {
    const proposal = `Rewritten.\n\n${close}`;
    const output = guardPrBodyProposal({
      proposal,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "issue-4637-thing",
    });
    assertEquals(
      output,
      `${proposal}\n\n${buildIdempotencyMarker(4637)}`,
      close,
    );
  }
});

Deno.test("a line-wrapped colon or full-URL close does not settle the close, and a same-line one does (Issue #4964)", () => {
  const url = "https://github.com/owner/repo/issues/4637";
  for (
    const close of [
      "Closes:\n#4637",
      "Closes\n: #4637",
      `Closes\n${url}`,
      "Closes: `x` #4637",
    ]
  ) {
    const proposal = `Done.\n\n${close}`;
    const output = guardPrBodyProposal({
      proposal,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "issue-4637-thing",
    });
    assertEquals(
      output,
      `${proposal}\n\nCloses #4637\n\n${buildIdempotencyMarker(4637)}`,
      close,
    );
  }
  for (const close of ["Closes: #4637", `Closes ${url}`]) {
    const proposal = `Done.\n\n${close}`;
    const output = guardPrBodyProposal({
      proposal,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "issue-4637-thing",
    });
    assertEquals(
      output,
      `${proposal}\n\n${buildIdempotencyMarker(4637)}`,
      close,
    );
  }
});

Deno.test("a withheld issue's close split by a line break, by code, or in colon or URL form leaves no effective close (Issue #4964)", () => {
  const closeLeft =
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:\s*#4674|(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+https:\/\/github\.com\/\S+\/issues\/4674/i;
  for (
    const form of [
      "Closes\n#4674",
      "Closes `x` #4674",
      "Closes: #4674",
      "Fixes https://github.com/owner/repo/issues/4674",
    ]
  ) {
    const output = guardPrBodyProposal({
      proposal: `Rewritten.\n\n${form}`,
      liveBody: liveBodyFor(4674, "Closes #4674"),
      summary: partSummary("partial"),
      repo: REPO,
      headRefName: "issue-4674-thing",
    });
    assertEquals(hasGithubClosingReference(output, 4674, REPO), false, form);
    assertEquals(closingKeywordLine(output, 4674), null, form);
    assertEquals(closeLeft.test(output), false, form);
    if (form.includes("`")) {
      // A code span is inert, and its bare #4674 still counts as a mention
      // under the existing rule, so no Part of is appended for this form.
      assertStringIncludes(output, "#4674", form);
    } else {
      assertStringIncludes(output, "Part of #4674", form);
    }
  }
});

Deno.test("the withhold backstop still refuses a real close for the withheld issue, and not one inside code (Issue #4964)", () => {
  for (
    const survivor of [
      "Closes #4674",
      "Closes owner/repo#4674",
      "Closes: #4674",
      "Closes\n#4674",
    ]
  ) {
    assertThrows(
      () => assertWithheld(survivor, 4674, REPO),
      Error,
      "still closes #4674",
      survivor,
    );
  }
  assertWithheld("Closes `x` #4674", 4674, REPO);
  assertWithheld("`Closes #4674`", 4674, REPO);
});

Deno.test("a closing keyword quoted as code is not an effective close (Issue #4964)", () => {
  const output = guardPrBodyProposal({
    proposal:
      "Rewritten. Use `Closes #4674` in the body.\n\n```\nCloses #4674\n```",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "issue-4674-thing",
  });
  assertEquals(hasGithubClosingReference(output, 4674, REPO), false);
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "Part of #4674");
});

Deno.test("a proposal that only says Part of a fully met issue is left as written, not closed", () => {
  const proposal = "Rewritten.\n\nPart of #4637";
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(closingKeywordLine(output, 4637), null);
  assertStringIncludes(output, "Part of #4637");
});

Deno.test("a fully met issue that the proposal names as Refs or Related to is not closed again (Issue #4637)", () => {
  for (
    const ref of [
      "Refs #4637",
      "Ref #4637",
      "refs: #4637",
      "References #4637",
      "Related to #4637",
      "relates to #4637",
      "Refs owner/repo#4637",
    ]
  ) {
    const proposal = `Rewritten.\n\n${ref}`;
    const output = guardPrBodyProposal({
      proposal,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "feature",
    });
    assertEquals(output, proposal + "\n\n" + buildIdempotencyMarker(4637), ref);
    assertEquals(closingKeywordLine(output, 4637), null, ref);
  }
});

Deno.test("a Refs to a fully met issue in another repository does not settle its close (Issue #4637)", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten.\n\nRefs owner/other#4637",
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "feature",
  });
  assertStringIncludes(output, "\n\nCloses #4637\n\n");
});

Deno.test("a Refs to a different issue in this repository does not settle a fully met issue's close (Issue #4637)", () => {
  for (const ref of ["Refs #4674", "Related to #4674", "Part of #4674"]) {
    const output = guardPrBodyProposal({
      proposal: `Rewritten.\n\n${ref}`,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "feature",
    });
    assertStringIncludes(output, "\n\nCloses #4637\n\n", ref);
  }
});

Deno.test("a Refs inside a code span or fence does not settle a fully met issue's close (Issue #4637)", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten.\n\n`Refs #4637`\n\n```\nRefs #4637\n```",
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "feature",
  });
  assertStringIncludes(output, "\n\nCloses #4637\n\n");
});

Deno.test("a Refs to a partly met issue is not a closing reference and adds no closing keyword (Issue #4637)", () => {
  const proposal = "Rewritten.\n\nRefs #4674";
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertEquals(output, proposal + "\n\n" + buildIdempotencyMarker(4674));
});

Deno.test("hostile refs and related fragments return with the close added (Issue #4637)", () => {
  const proposals = [
    "Rewritten.\n\nrefs" + " ".repeat(40_000) + "!",
    "Rewritten.\n\nrelated" + " ".repeat(40_000) + "x",
    "Rewritten.\n\nrefs " + "a".repeat(40_000) + "!",
  ];
  for (const proposal of proposals) {
    const output = guardPrBodyProposal({
      proposal,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "feature",
    });
    assertSameText(
      output,
      `${proposal}\n\nCloses #4637\n\n${buildIdempotencyMarker(4637)}`,
      `hostile fragment ${JSON.stringify(proposal.slice(0, 20))}`,
    );
  }
});

Deno.test("a proposal that starts with Refs to a fully met issue gets no Closes #N (Issue #4637)", () => {
  const proposal = "Refs #4637";
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(output, proposal + "\n\n" + buildIdempotencyMarker(4637));
});

Deno.test("an unrelated closing reference to another issue is restored beside a withheld issue", () => {
  const output = guardPrBodyProposal({
    proposal: "Work.\n\nClose #4674.",
    liveBody: liveBodyFor(4674, "Closes #4674\nCloses #99"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "Part of #4674");
  assertStringIncludes(output, "\nCloses #99");
});

Deno.test("several references to a withheld issue are all withheld, and another issue's reference is kept (Issue #4716)", () => {
  const output = guardPrBodyProposal({
    proposal: "Closes #4674. Also fixes #4674 and resolves #9.",
    liveBody: liveBodyFor(4674, "Closes #4674\nFixes #9"),
    summary: partSummary("missing"),
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(closingKeywordLine(output, 4674), null);
  assertStringIncludes(output, "resolves #9");
  assertStringIncludes(output, "Part of #4674");
});

Deno.test("with no committed summary the close is unknown evidence and is withheld", () => {
  const output = guardPrBodyProposal({
    proposal: "Closes #4674",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: undefined,
    repo: REPO,
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
        headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
  });
  assertStringIncludes(output, "Part of #4674");
  assertEquals(closingKeywordLine(output, 4674), null);
});

Deno.test("a close is allowed only with committed evidence and no unmet criterion", () => {
  assertEquals(
    isIssueCloseAllowed({
      summary: FULLY_MET_SUMMARY,
      proposal: undefined,
    }),
    true,
  );
  assertEquals(
    isIssueCloseAllowed({
      summary: undefined,
      proposal: undefined,
    }),
    false,
  );
  assertEquals(
    isIssueCloseAllowed({
      summary: partSummary("partial"),
      proposal: undefined,
    }),
    false,
  );
  assertEquals(
    isIssueCloseAllowed({
      summary: FULLY_MET_SUMMARY,
      proposal: "## Acceptance Criteria\n\n- **missing** — x — reason: y",
    }),
    false,
  );
  // The summary's own wording does not decide it (the assembler appends
  // `Closes #N` to a fully met summary that omits it).
  assertEquals(
    isIssueCloseAllowed({
      summary: "## Summary\n\nPart of #4637.\n",
      proposal: undefined,
    }),
    true,
  );
});

Deno.test("a fully met summary with no closing keyword keeps the close, as the assembler does", () => {
  const summary = [
    "## Summary",
    "",
    "Nothing here names a closing keyword.",
    "",
    "## Acceptance Criteria",
    "",
    "- **met** — the criterion — evidence: `deno task test:unit` — reviewer: met",
    "",
  ].join("\n");
  const dropped = guardPrBodyProposal({
    proposal: "Rewritten description.",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary,
    repo: REPO,
    headRefName: "feature",
  });
  assertStringIncludes(dropped, "Closes #4674");
  assertEquals(dropped.includes("Part of #4674"), false);
  const kept = guardPrBodyProposal({
    proposal: undefined,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary,
    repo: REPO,
    headRefName: "feature",
  });
  assertStringIncludes(kept, "Closes #4674");
  assertEquals(kept.includes("Part of #4674"), false);
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
    headRefName: "feature",
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
    isIssueCloseAllowed({ summary, proposal: undefined }),
    false,
  );
  const output = guardPrBodyProposal({
    proposal: "Rewritten description.",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary,
    repo: REPO,
    headRefName: "feature",
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
    headRefName: "feature",
  });
  assertSameText(output, `${spaced}${partialSuffix()}`, "not and spaces");
  const words = "not ".repeat(15_000);
  const wordsOutput = guardPrBodyProposal({
    proposal: words,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
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
    headRefName: "feature",
  });
  assertStringIncludes(output, "Note <!- - benign - -> here.");
  assertNoHiddenComment(output);
});

Deno.test("a colon or full-URL closing form for the withheld issue becomes Part of (Issue #4637)", () => {
  const output = guardPrBodyProposal({
    proposal: [
      "Closes: #4674",
      "closes : #4674",
      "Fixes https://github.com/owner/repo/issues/4674",
      "Resolved: owner/repo#4674",
    ].join("\n"),
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(
    output,
    [
      "Part of #4674",
      "Part of #4674",
      "Part of https://github.com/owner/repo/issues/4674",
      "Part of owner/repo#4674",
      "",
      buildIdempotencyMarker(4674),
    ].join("\n"),
  );
});

Deno.test("a colon or full-URL form naming another issue or repository is left as written (Issue #4637)", () => {
  const proposal = [
    "Closes: #99",
    "Fixes https://github.com/owner/repo/issues/99",
    "Fixes https://github.com/other/repo/issues/4674",
  ].join("\n");
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(output, `${proposal}${partialSuffix()}`);
  const otherRepo = guardPrBodyProposal({
    proposal: "Resolved: other/repo#4674",
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
  });
  assertStringIncludes(otherRepo, "Resolved: other/repo#4674");
});

Deno.test("a colon or full-URL closing form inside code is left as written (Issue #4637)", () => {
  const proposal = [
    "Use `Closes: #4674` and `Fixes https://github.com/owner/repo/issues/4674` here.",
    "",
    "```",
    "Resolved: owner/repo#4674",
    "```",
  ].join("\n");
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(output, `${proposal}${partialSuffix()}`);
});

Deno.test("with the close allowed, a colon or full-URL closing form is left as written (Issue #4637)", () => {
  const proposal =
    "Rewritten.\n\nCloses: #4637\nFixes https://github.com/owner/repo/issues/4637";
  const output = guardPrBodyProposal({
    proposal,
    liveBody: liveBodyFor(4637, "Closes #4637"),
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(output, `${proposal}\n\n${buildIdempotencyMarker(4637)}`);
});

Deno.test("a run of 30,000 spaces and colons after Closes with no issue number is guarded in linear time (Issue #4637)", () => {
  const hostile = "Closes" + " :".repeat(15_000) + "x";
  const output = guardPrBodyProposal({
    proposal: hostile,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
  });
  assertSameText(output, `${hostile}${partialSuffix()}`, "colon run");
});

Deno.test("a run of 30,000 owner characters after a full-URL Closes with no issue number is guarded in linear time (Issue #4637)", () => {
  const hostile = "Closes https://github.com/" + "a".repeat(30_000) + "x";
  const output = guardPrBodyProposal({
    proposal: hostile,
    liveBody: liveBodyFor(4674, "Closes #4674"),
    summary: partSummary("partial"),
    repo: REPO,
    headRefName: "feature",
  });
  assertSameText(output, `${hostile}${partialSuffix()}`, "URL owner run");
});

Deno.test("a proposal that only mentions a fully met issue still gets Closes #N (PR #4779 review)", () => {
  for (
    const mention of [
      "This addresses the review on Issue #4637.",
      "Related: owner/other#4637.",
      "See #4637 for the background.",
    ]
  ) {
    const output = guardPrBodyProposal({
      proposal: `Rewritten. ${mention}`,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "issue-4637-fix",
    });
    assertStringIncludes(output, "\n\nCloses #4637");
    assertEquals(closingKeywordLine(output, 4637), "Closes #4637");
    assertEquals(output.includes("Part of #4637"), false);
  }
});

Deno.test("a closing keyword, a colon or URL closing form or an explicit Part of settles the close without a second Closes (PR #4779 review)", () => {
  for (
    const settled of [
      "Fixes #4637",
      "Closes: #4637",
      "Resolves https://github.com/owner/repo/issues/4637",
      "Part of #4637",
    ]
  ) {
    const output = guardPrBodyProposal({
      proposal: `Rewritten. ${settled}`,
      liveBody: liveBodyFor(4637, "Closes #4637"),
      summary: FULLY_MET_SUMMARY,
      repo: REPO,
      headRefName: "issue-4637-fix",
    });
    assertEquals(output.includes("\n\nCloses #4637"), false, settled);
    assert(output.startsWith(`Rewritten. ${settled}`), settled);
  }
});

Deno.test("a body that lost its worker marker is governed by its worker branch (PR #4779 review)", () => {
  const live = "Closes #4674";
  const partOf = guardPrBodyProposal({
    proposal: "Rewritten. Part of #4674 and more.",
    liveBody: live,
    summary: undefined,
    repo: REPO,
    headRefName: "issue-4674-babysitter",
  });
  assertEquals(closingKeywordLine(partOf, 4674), null);
  assertStringIncludes(partOf, "Part of #4674");
  const closes = guardPrBodyProposal({
    proposal: "Rewritten. Closes #4674",
    liveBody: live,
    summary: undefined,
    repo: REPO,
    headRefName: "issue-4674-babysitter",
  });
  assertEquals(closingKeywordLine(closes, 4674), null);
  assertStringIncludes(closes, "Part of #4674");
  const noProposal = guardPrBodyProposal({
    proposal: undefined,
    liveBody: live,
    summary: undefined,
    repo: REPO,
    headRefName: "issue-4674-babysitter",
  });
  assertEquals(closingKeywordLine(noProposal, 4674), null);
  // Positive control: the same body on a branch that names no issue is unrelated.
  const unrelated = guardPrBodyProposal({
    proposal: "Rewritten. Part of #4674 and more.",
    liveBody: live,
    summary: undefined,
    repo: REPO,
    headRefName: "feature",
  });
  assertEquals(closingKeywordLine(unrelated, 4674), "Closes #4674");
});

Deno.test("a marker-less worker branch with a fully met committed summary keeps the close (PR #4779 review)", () => {
  const output = guardPrBodyProposal({
    proposal: "Rewritten description.",
    liveBody: "Some body.",
    summary: FULLY_MET_SUMMARY,
    repo: REPO,
    headRefName: "issue-4637-fix",
  });
  assertEquals(closingKeywordLine(output, 4637), "Closes #4637");
});
