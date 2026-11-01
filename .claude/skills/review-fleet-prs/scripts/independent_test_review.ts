import { testChangeEvidenceGaps } from "../../../../worker/deno/lib/pre_pr_verifier.ts";
import { type LinkedIssue, normaliseWs } from "./auto_release.ts";
import { decideOutcome, type FableReview, type Outcome } from "./review_log.ts";
import type { RunGh } from "./needs_human.ts";
import { issueNumberFromBranch } from "../../../../worker/deno/lib/issue_branch_candidates.ts";

/** Resolve identities, then fetch issue title and body independently of PR prose. */
export async function fetchGoverningIssues(
  repo: string,
  number: number,
  runGh: RunGh,
  workerIdentity = false,
): Promise<LinkedIssue[]> {
  const pr = JSON.parse(
    await runGh([
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "closingIssuesReferences,body,headRefName",
    ]),
  );
  if (
    !Array.isArray(pr.closingIssuesReferences) ||
    typeof pr.body !== "string" || typeof pr.headRefName !== "string"
  ) {
    throw new Error("PR issue references, body or branch missing");
  }
  const refs = new Map<string, { repo: string; number: number }>();
  const add = (r: string, n: number) => {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) ||
      !Number.isSafeInteger(n) || n <= 0
    ) throw new Error("invalid issue identity");
    refs.set(`${r.toLowerCase()}#${n}`, { repo: r, number: n });
  };
  for (const ref of pr.closingIssuesReferences) {
    add(`${ref.repository.owner.login}/${ref.repository.name}`, ref.number);
  }
  const branchIssue = workerIdentity
    ? issueNumberFromBranch(pr.headRefName)
    : null;
  if (branchIssue !== null) add(repo, branchIssue);
  for (
    const match of pr.body.matchAll(
      /^\s*Part of\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gim,
    )
  ) {
    add(match[1] ?? repo, Number(match[2]));
  }
  const issues: LinkedIssue[] = [];
  for (const ref of refs.values()) {
    const issue = JSON.parse(
      await runGh([
        "issue",
        "view",
        String(ref.number),
        "-R",
        ref.repo,
        "--json",
        "title,body",
      ]),
    );
    if (typeof issue.title !== "string" || typeof issue.body !== "string") {
      throw new Error(`issue ${ref.repo}#${ref.number} lacks title or body`);
    }
    issues.push({ title: issue.title, body: issue.body });
  }
  return issues;
}

/** Structural checks complement the independent reviewer's inspection; they
 * cannot establish whether a test protects the contract on their own. */
export function independentTestReview(
  notes: readonly Record<string, unknown>[],
  removedTests: readonly string[],
  issues: readonly LinkedIssue[],
): string[] {
  const reasons = testChangeEvidenceGaps(notes);
  if (issues.length === 0) reasons.push("no governing issue could be read");
  for (const file of removedTests) {
    if (!notes.some((note) => note.file === file)) {
      reasons.push(`${file}: removed test has no evidence`);
    }
  }
  for (const note of notes) {
    const at = `${note.file}:${note.line}`;
    if (note.kind === "added-skip") reasons.push(`${at}: added skip`);
    const quote = typeof note.criterionQuote === "string"
      ? normaliseWs(note.criterionQuote)
      : "";
    if (
      !quote ||
      !issues.some((issue) =>
        normaliseWs(issue.title).includes(quote) ||
        normaliseWs(issue.body).includes(quote)
      )
    ) reasons.push(`${at}: requirement not found in governing issue`);
  }
  return reasons;
}

/** An unavailable or incomplete assessment is retried, never approved. */
export async function decideIndependentOutcome(
  pr: { repo: string; number: number; kind?: "fleet" | "dependabot" },
  review: FableReview,
  removedTests: readonly string[],
  runGh: RunGh,
): Promise<Outcome> {
  const initial = decideOutcome(review, removedTests);
  if (initial !== "held") return initial;
  const issues = await fetchGoverningIssues(
    pr.repo,
    pr.number,
    runGh,
    pr.kind === "fleet",
  );
  const reasons = independentTestReview(
    review.testChangeNotes as unknown as Record<string, unknown>[],
    removedTests,
    issues,
  );
  if (reasons.length > 0) {
    throw new Error(
      `independent test review incomplete: ${reasons.join("; ")}`,
    );
  }
  // The reviewer currently has no isolated target checkout or runner-owned
  // execution evidence. Its prose cannot establish that the surviving tests
  // were independently inspected or exercised.
  throw new Error(
    "independent test execution evidence is unavailable; retry after an isolated runner is available",
  );
}
