// Opt-in auto-release of issue-required test-change holds (Issue #3397).
//
// A repo listed in `.config.json` key `pr_reviewer_auto_release` has a PR held
// only for a meaningful test change approved instead, when every note is a
// changed expected value that quotes a linked issue's acceptance criterion
// verbatim and states the edited test fails without the code change.

import {
  decideOutcome,
  type FableReview,
  type TestChangeNote,
} from "./review_log.ts";
import type { RunGh } from "./needs_human.ts";

const DEFAULT_CONFIG = new URL("../../../../.config.json", import.meta.url);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const MIN_QUOTE_WORDS = 5;

export interface LinkedIssue {
  title: string;
  body: string;
}

export const normaliseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

// Plain substring match, never a pattern built from the quote.
export function quoteFound(
  quote: string,
  issues: readonly LinkedIssue[],
): boolean {
  const q = normaliseWs(quote);
  if (q.split(" ").filter((w) => w !== "").length < MIN_QUOTE_WORDS) {
    return false;
  }
  return issues.some((i) =>
    normaliseWs(i.title).includes(q) || normaliseWs(i.body).includes(q)
  );
}

const NEGATIVE_EQUALS_OR_STARTS = ["no", "false"];
const NEGATIVE_CONTAINS = [
  "does not fail",
  "doesn't fail",
  "passes without",
  "would pass",
  "not verified",
  "unknown",
];

function failsWithout(v: TestChangeNote["failsWithoutChange"]): boolean {
  if (v === true) return true;
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  if (s === "") return false;
  if (NEGATIVE_EQUALS_OR_STARTS.some((n) => s.startsWith(n))) return false;
  return !NEGATIVE_CONTAINS.some((n) => s.includes(n));
}

export function autoReleaseDecision(
  review: FableReview,
  removedTests: readonly string[],
  issues: readonly LinkedIssue[] | undefined,
): { release: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (review.findings.length > 0) reasons.push("review has findings");
  if (review.testChanges !== "meaningful") {
    reasons.push("test changes are not meaningful");
  }
  if (removedTests.length > 0) reasons.push("test files were removed");
  if (!issues || issues.length === 0) {
    reasons.push("no linked issue could be read");
  }
  if (review.testChangeNotes.length === 0) reasons.push("no test change notes");
  for (const n of review.testChangeNotes) {
    const at = `\`${n.file}:${n.line}\``;
    if (n.kind !== "expected-value") {
      reasons.push(`${at}: not a changed expected value`);
    }
    if (
      typeof n.criterionQuote !== "string" || n.criterionQuote.trim() === ""
    ) {
      reasons.push(`${at}: no criterion quote`);
    } else if (!quoteFound(n.criterionQuote, issues ?? [])) {
      reasons.push(`${at}: criterion quote not found in a linked issue`);
    }
    if (!failsWithout(n.failsWithoutChange)) {
      reasons.push(`${at}: does not state the test fails without the change`);
    }
  }
  return { release: reasons.length === 0, reasons };
}

// Fails loud on a malformed config, like reviewerApp in app_token.ts.
export function autoReleaseRepos(config: Record<string, unknown>): string[] {
  const v = config.pr_reviewer_auto_release;
  if (v === undefined || v === null) return [];
  if (
    !Array.isArray(v) ||
    !v.every((r) => typeof r === "string" && REPO_PATTERN.test(r))
  ) {
    throw new Error(
      'pr_reviewer_auto_release must be an array of "owner/repo" strings',
    );
  }
  return v as string[];
}

export async function loadAutoReleaseRepos(
  configPath: string | URL = DEFAULT_CONFIG,
): Promise<string[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  return autoReleaseRepos(JSON.parse(text));
}

export const isAutoReleaseRepo = (
  repos: readonly string[],
  repo: string,
): boolean => repos.some((r) => r.toLowerCase() === repo.toLowerCase());

// Fail closed: `{ error }` on any failure, bad shape or no linked issue, so
// the caller keeps the hold and can say why. Comments are never requested
// (untrusted text).
export async function fetchLinkedIssues(
  prRepo: string,
  number: number,
  runGh: RunGh,
): Promise<LinkedIssue[] | { error: string }> {
  try {
    const pr = JSON.parse(
      await runGh([
        "pr",
        "view",
        String(number),
        "-R",
        prRepo,
        "--json",
        "closingIssuesReferences",
      ]),
    );
    const refs = pr.closingIssuesReferences;
    if (!Array.isArray(refs) || refs.length === 0) {
      return { error: "no linked issue" };
    }
    const issues: LinkedIssue[] = [];
    for (const ref of refs) {
      const repo = `${ref.repository.owner.login}/${ref.repository.name}`;
      const x = JSON.parse(
        await runGh([
          "issue",
          "view",
          String(ref.number),
          "-R",
          repo,
          "--json",
          "title,body",
        ]),
      );
      issues.push({ title: String(x.title ?? ""), body: String(x.body ?? "") });
    }
    return issues;
  } catch (e) {
    return {
      error: `linked issue fetch failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

export async function resolveAutoRelease(
  pr: { repo: string; number: number },
  review: FableReview,
  removedTests: readonly string[],
  repos: readonly string[],
  runGh: RunGh,
): Promise<{ release: boolean; reasons: string[] }> {
  if (!isAutoReleaseRepo(repos, pr.repo)) {
    return { release: false, reasons: ["repo not opted in"] };
  }
  if (decideOutcome(review, removedTests) !== "held") {
    return { release: false, reasons: ["no hold"] };
  }
  const issues = await fetchLinkedIssues(pr.repo, pr.number, runGh);
  if (!Array.isArray(issues)) {
    return { release: false, reasons: [issues.error] };
  }
  return autoReleaseDecision(review, removedTests, issues);
}
