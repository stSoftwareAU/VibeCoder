// Test-change policy for /review-fleet-prs (Issue #4655).
//
// Replaces the opt-in auto-release of issue-required test-change holds
// (Issue #3397). Every repo gets an evidence review: a removed or meaningfully
// changed test must say which old behaviour it checked, why that is obsolete,
// what covers the behaviour at the head, and what requires the change (a
// governing issue, quoted verbatim when the change is an expected value).
// `pr_reviewer_test_hold_repos` is the explicit owner override that keeps the
// owner-comment hold for every meaningful test change in a repo.
//
// Fail closed: a check that cannot run is a `retry`, never a pass, and a
// malformed note is a finding, never an approval. Comments are never read
// (they are untrusted text), and gh is always called with an argument array.

import {
  type Finding,
  HOLD_POLICY_VERSION,
  type TestChangeNote,
} from "./review_log.ts";
import type { TestCoverageRef } from "../../../../worker/deno/lib/fleet_review_log.ts";
import type { RunGh } from "./needs_human.ts";

const DEFAULT_CONFIG = new URL("../../../../.config.json", import.meta.url);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ISSUE_BRANCH = /^issue-(\d+)(?:-|$)/;
const PART_OF_SAME = /^[ \t]*Part of #(\d+)[ \t]*\.?[ \t]*$/i;
const PART_OF_OTHER =
  /^[ \t]*Part of ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)[ \t]*\.?[ \t]*$/i;
const PATH_PATTERN = /^[A-Za-z0-9_@.+\-\/ ()\[\]~]+$/;
const BOOLEAN_WORDS = /^(?:true|yes|ok|passes?|verified|n\/a|done)$/i;
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);
// Test files across the fleet's languages: Deno/TS, JS, Python, Go, Rust
// integration tests, Java/Kotlin. Inline Rust #[cfg(test)] modules cannot be
// seen from a path; the model review checks those.
const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|__tests__|spec|specs)\//,
  /(^|\/)src\/test\//,
  /[._-](test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(go|py|rs|sh|ps1)$/,
  /(^|\/)test_[^/]+\.py$/,
  /\.(Tests?)\.ps1$/,
  /Test\.(java|kt)$/,
];

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}

const MAX_GOVERNING_ISSUES = 5;
const PART_OF_SCAN_LINES = 200;
const MAX_PATH_LENGTH = 300;
const FETCH_FAILED = "fetch failed:";

/** The mode a repo runs under; every repo is `evidence` unless held. */
export type TestMode = "evidence" | "hold-all";

export interface EffectiveTestPolicy {
  version: number; // HOLD_POLICY_VERSION
  mode: "evidence"; // the default for every repo
  holdAllRepos: string[]; // `pr_reviewer_test_hold_repos`: owner-comment hold for every meaningful test change
  legacyAutoRelease: string[]; // `pr_reviewer_auto_release`: tolerated but ignored since #4655
  trustedLogins: string[]; // from `allowed_authors`, `authorized_commenters`, `pr_reviewers`
}

export interface GoverningIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  source: "closing" | "worker-branch" | "part-of";
}

export interface GoverningIssues {
  issues: GoverningIssue[];
  problems: string[];
}

export interface ApprovedTestChange {
  file: string;
  line: number;
  kind: string;
  obsolete: string;
  remaining: string;
  coverage: string[];
  requirement: string;
  verification: string;
}

export interface TestChangeAssessment {
  checked: boolean; // false when there was nothing to assess
  findings: Finding[]; // blocking, to be appended to the review's findings
  ownerReasons: string[]; // from `owner` verdicts; non-empty means a comment-only hold
  approved: ApprovedTestChange[]; // the changes that passed every check
  retry?: string; // a check could not run: post nothing and retry next pass
}

/** The PR facts the assessor needs; `testChanges` comes from the diff. */
export interface AssessedPr {
  repo: string;
  number: number;
  headSha: string;
  kind: "fleet" | "dependabot";
  testChanges: { removed: string[]; edited: string[] };
  // The PR's base branch name. A `gone` coverage entry is checked against it;
  // missing or invalid, a `gone` entry cannot pass (it shows nothing was removed).
  baseRef?: string;
}

const isRepo = (v: unknown): v is string =>
  typeof v === "string" && REPO_PATTERN.test(v);
const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

// The first non-blank line of an error, for a retry reason or a problem.
function firstLine(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.split("\n").map((l) => l.trim()).find((l) => l !== "") ??
    "gh failed";
}

const isNotFound = (e: unknown): boolean => {
  const message = e instanceof Error ? e.message : String(e);
  return /HTTP 404|Not Found/i.test(message);
};

export const normaliseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

// Model text for a comment: no backticks, no angle brackets, one line, capped.
function plain(text: string): string {
  return text
    .replace(/[<>]/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// Plain substring match, never a pattern built from the quote. No minimum
// length: the quote must simply be present in a resolved governing issue.
export function quoteFound(
  quote: string,
  issues: readonly { title: string; body: string }[],
): boolean {
  const q = normaliseWs(quote);
  if (q === "") return false;
  return issues.some((i) =>
    normaliseWs(i.title).includes(q) || normaliseWs(i.body).includes(q)
  );
}

const NEGATIVE_LEADING_WORD = /^(?:no|false)\b/;
const NEGATIVE_CONTAINS = [
  "does not fail",
  "doesn't fail",
  "passes without",
  "would pass",
  "not verified",
  "unknown",
];

// Positive only: `true`, or a statement that is not led by no/false and does
// not say the test passes without the change.
function failsWithout(v: TestChangeNote["failsWithoutChange"]): boolean {
  if (v === true) return true;
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  if (s === "") return false;
  if (NEGATIVE_LEADING_WORD.test(s)) return false;
  return !NEGATIVE_CONTAINS.some((n) => s.includes(n));
}

// At least three words, and not a bare yes/true/passes-style claim.
function verificationOk(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = normaliseWs(v);
  if (t.split(" ").length < 3) return false;
  return !BOOLEAN_WORDS.test(t);
}

// Repo list from config: absent or null is empty; anything else must be a
// list of owner/repo strings, or the caller gets an error.
function repoList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every(isRepo)) return undefined;
  return v as string[];
}

// Logins from the three trust lists; a non-string entry is skipped.
function trustedLoginsOf(config: Record<string, unknown>): string[] {
  const logins = new Set<string>();
  for (
    const key of ["allowed_authors", "authorized_commenters", "pr_reviewers"]
  ) {
    const list = config[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string" && entry.trim() !== "") {
        logins.add(entry.trim());
      }
    }
  }
  return [...logins];
}

/**
 * The effective policy from a parsed `.config.json`. Throws on a malformed
 * `pr_reviewer_test_hold_repos`; a malformed `pr_reviewer_auto_release` is
 * reported as empty because it is ignored since #4655.
 */
export function effectiveTestPolicy(
  config: Record<string, unknown>,
): EffectiveTestPolicy {
  const holdAllRepos = repoList(config.pr_reviewer_test_hold_repos);
  if (holdAllRepos === undefined) {
    throw new Error(
      'pr_reviewer_test_hold_repos must be an array of "owner/repo" strings',
    );
  }
  return {
    version: HOLD_POLICY_VERSION,
    mode: "evidence",
    holdAllRepos,
    legacyAutoRelease: repoList(config.pr_reviewer_auto_release) ?? [],
    trustedLogins: trustedLoginsOf(config),
  };
}

/** Read the policy from `.config.json`; a missing file is the defaults. */
export async function loadTestPolicy(
  configPath: string | URL = DEFAULT_CONFIG,
): Promise<EffectiveTestPolicy> {
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return effectiveTestPolicy({});
    throw e;
  }
  return effectiveTestPolicy(JSON.parse(text));
}

/** Case-insensitive: `hold-all` only for a repo listed as an owner override. */
export function testModeFor(
  policy: EffectiveTestPolicy,
  repo: string,
): TestMode {
  return policy.holdAllRepos.some((r) => r.toLowerCase() === repo.toLowerCase())
    ? "hold-all"
    : "evidence";
}

/** One line for the log and the summary. */
export function describeTestPolicy(policy: EffectiveTestPolicy): string {
  const list = (xs: string[]) => xs.length === 0 ? "none" : xs.join(", ");
  return `test-change policy v${policy.version}: ${policy.mode} review; owner-hold repos: ${
    list(policy.holdAllRepos)
  }; ignored legacy pr_reviewer_auto_release: ${
    list(policy.legacyAutoRelease)
  }`;
}

const normaliseLogin = (login: string): string =>
  login.replace(/\[bot\]$/i, "").toLowerCase();

interface Candidate {
  repo: string;
  number: number;
  source: GoverningIssue["source"];
}

/**
 * The issues that govern a PR: closing references, the worker's own issue
 * (fleet branches only) and anchored `Part of #N` lines. Each candidate must be
 * an issue (not a PR) by a trusted author; anything else is a problem string.
 * A `fetch failed:` problem means the links could not be read: retry, not
 * a finding.
 */
export async function resolveGoverningIssues(
  pr: { repo: string; number: number; kind: "fleet" | "dependabot" },
  policy: Pick<EffectiveTestPolicy, "trustedLogins">,
  runGh: RunGh,
): Promise<GoverningIssues> {
  if (!isRepo(pr.repo) || !isPositiveInt(pr.number)) {
    return {
      issues: [],
      problems: ["pull request reference is not a valid owner/repo and number"],
    };
  }
  let view: Record<string, unknown> | undefined;
  try {
    view = asRecord(
      JSON.parse(
        await runGh([
          "pr",
          "view",
          String(pr.number),
          "-R",
          pr.repo,
          "--json",
          "closingIssuesReferences,headRefName,body",
        ]),
      ),
    );
  } catch (e) {
    return {
      issues: [],
      problems: [
        `${FETCH_FAILED} pull request view could not be read: ${firstLine(e)}`,
      ],
    };
  }
  if (view === undefined) {
    return {
      issues: [],
      problems: [
        `${FETCH_FAILED} pull request view could not be read: response is not an object`,
      ],
    };
  }

  const problems: string[] = [];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (repo: string, number: number, source: Candidate["source"]) => {
    if (!isRepo(repo) || !isPositiveInt(number)) return;
    const key = `${repo.toLowerCase()}#${number}`;
    if (seen.has(key) || candidates.length >= MAX_GOVERNING_ISSUES) return;
    seen.add(key);
    candidates.push({ repo, number, source });
  };

  const refs = Array.isArray(view.closingIssuesReferences)
    ? view.closingIssuesReferences
    : [];
  for (const ref of refs) {
    const r = asRecord(ref);
    const repository = asRecord(r?.repository);
    const owner = asRecord(repository?.owner);
    const repo = typeof owner?.login === "string" &&
        typeof repository?.name === "string"
      ? `${owner.login}/${repository.name}`
      : "";
    const number = r?.number;
    if (!isRepo(repo) || !isPositiveInt(number)) {
      problems.push("a closing reference names no valid issue and is ignored");
      continue;
    }
    add(repo, number, "closing");
  }

  if (pr.kind === "fleet" && typeof view.headRefName === "string") {
    const m = ISSUE_BRANCH.exec(view.headRefName);
    if (m) add(pr.repo, Number(m[1]), "worker-branch");
  }

  // Only anchored lines count: `Part of #N` inside a sentence is prose.
  const body = typeof view.body === "string" ? view.body : "";
  for (const raw of body.split("\n").slice(0, PART_OF_SCAN_LINES)) {
    const line = raw.replace(/\r$/, "");
    const same = PART_OF_SAME.exec(line);
    if (same) {
      add(pr.repo, Number(same[1]), "part-of");
      continue;
    }
    const other = PART_OF_OTHER.exec(line);
    if (other) {
      problems.push(
        `Part of ${other[1]}#${
          other[2]
        } is ignored: a Part of line names an issue in this repo as #N`,
      );
    }
  }

  const trusted = new Set(policy.trustedLogins.map(normaliseLogin));
  const issues: GoverningIssue[] = [];
  for (const c of candidates) {
    const ref = `${c.repo}#${c.number}`;
    let x: Record<string, unknown> | undefined;
    try {
      x = asRecord(
        JSON.parse(
          await runGh(["api", `repos/${c.repo}/issues/${c.number}`]),
        ),
      );
    } catch (e) {
      if (isNotFound(e)) {
        problems.push(`linked issue ${ref} is not readable: Not Found`);
      } else {
        problems.push(
          `${FETCH_FAILED} linked issue ${ref} could not be read: ${
            firstLine(e)
          }`,
        );
      }
      continue;
    }
    if (x === undefined) {
      problems.push(
        `${FETCH_FAILED} linked issue ${ref} could not be read: response is not an object`,
      );
      continue;
    }
    if (x.pull_request !== undefined && x.pull_request !== null) {
      problems.push(`${ref} is a pull request, not an issue; it is ignored`);
      continue;
    }
    const login = asRecord(x.user)?.login;
    const byAssociation = c.repo.toLowerCase() === pr.repo.toLowerCase() &&
      typeof x.author_association === "string" &&
      TRUSTED_ASSOCIATIONS.has(x.author_association);
    const byLogin = typeof login === "string" &&
      trusted.has(normaliseLogin(login));
    if (!byAssociation && !byLogin) {
      problems.push(`${ref} is not by a trusted author; it is ignored`);
      continue;
    }
    issues.push({
      repo: c.repo,
      number: c.number,
      title: typeof x.title === "string" ? x.title : "",
      body: typeof x.body === "string" ? x.body : "",
      source: c.source,
    });
  }
  return { issues, problems };
}

// A repo-relative path a coverage entry may name; null when it is allowed.
function coveragePathProblem(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    return "is empty or longer than 300 characters";
  }
  if (!PATH_PATTERN.test(path)) return "has characters outside the allowed set";
  if (path.startsWith("/")) return "is absolute";
  if (path.includes("\\")) return "contains a backslash";
  if (path.split("/").some((seg) => seg === "." || seg === "..")) {
    return "contains a . or .. segment";
  }
  if (path.includes("//")) return "contains //";
  return null;
}

type Probe =
  | { state: "present"; text: string }
  | { state: "absent" }
  | { state: "not-file" }
  | { state: "unreadable" }
  | { state: "error"; message: string };

// One contents read at a ref (the head sha, or the base branch name). 404 is
// absent; any other gh error is an error, which the caller turns into a retry.
async function probeContents(
  repo: string,
  path: string,
  ref: string,
  runGh: RunGh,
): Promise<Probe> {
  const encoded = path.split("/").map((s) => encodeURIComponent(s)).join("/");
  let raw: string;
  try {
    raw = await runGh([
      "api",
      `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    ]);
  } catch (e) {
    if (isNotFound(e)) return { state: "absent" };
    return { state: "error", message: firstLine(e) };
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(JSON.parse(raw));
  } catch {
    return { state: "unreadable" };
  }
  const content = body?.content;
  if (typeof content !== "string") return { state: "not-file" };
  if (body?.encoding !== undefined && body.encoding !== "base64") {
    return { state: "unreadable" };
  }
  try {
    const bin = atob(content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return {
      state: "present",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { state: "unreadable" };
  }
}

interface Problem {
  problem: string;
  fix: string;
}

interface NoteOutcome {
  problems: Problem[];
  owner?: string;
  approved?: ApprovedTestChange;
  retry?: string;
}

interface Context {
  pr: AssessedPr;
  governing: GoverningIssues;
  runGh: RunGh;
}

// Kinds that are never accepted as a test change, whatever the rest says.
const BLOCKED_KINDS: ReadonlySet<string> = new Set([
  "added-skip",
  "weakened-assertion",
  "threshold-reduced",
]);
// Kinds that must cite a governing issue (every kind not blocked must).
const REQUIREMENT_KINDS: ReadonlySet<string> = new Set([
  "expected-value",
  "replaced",
  "removed-case",
  "removed-file",
  "other",
]);

function notFileOrUnreadable(
  where: string,
  state: "not-file" | "unreadable" | "absent" | "present",
  label: string,
  at = "the head",
): Problem {
  return state === "not-file"
    ? {
      problem:
        `${label} ${where} is not a file at ${at} (a directory or other non-file)`,
      fix: `Cite a file, not a directory, that exists at ${at}`,
    }
    : {
      problem: `${label} ${where} could not be read as text at ${at}`,
      fix: `Cite a UTF-8 text file that exists at ${at}`,
    };
}

// A base branch name that can be put in a contents query, or undefined.
const BASE_REF_PATTERN = /^[A-Za-z0-9_.\/-]{1,200}$/;
function validBaseRef(v: unknown): string | undefined {
  return typeof v === "string" && BASE_REF_PATTERN.test(v) && !v.includes("..")
    ? v
    : undefined;
}

// A `gone` entry must name something that existed at the base ref: an
// invented path or symbol shows nothing was removed.
function neverExisted(where: string, fix?: string): Problem {
  return {
    problem:
      `gone coverage ${where} never existed at the base ref, so it does not show anything was removed`,
    fix: fix ??
      "Cite functionality that existed at the base ref and is gone at the head",
  };
}

// Coverage: each entry is checked at the head; at least one must pass.
async function checkCoverage(
  note: TestChangeNote,
  ctx: Context,
  problems: Problem[],
): Promise<{ passed: TestCoverageRef[]; retry?: string }> {
  const passed: TestCoverageRef[] = [];
  const coverage = note.coverage ?? [];
  if (!SHA_PATTERN.test(ctx.pr.headSha)) {
    problems.push({
      problem:
        "coverage cannot be checked: the head commit id is not a full 40-character sha",
      fix: "Re-run the review on a pushed head commit",
    });
    return { passed };
  }
  for (const ref of coverage) {
    const pathProblem = coveragePathProblem(ref.path);
    if (pathProblem !== null) {
      problems.push({
        problem: `coverage path ${
          plain(ref.path)
        } is not an allowed repo-relative path: it ${pathProblem}`,
        fix:
          "Name a repo-relative test file path with no leading slash, backslash, empty segment or . or .. segment",
      });
      continue;
    }
    const name = ref.name?.trim() ?? "";
    const where = name === ""
      ? plain(ref.path)
      : `${plain(ref.path)}::${plain(name)}`;
    if (ref.role === "gone" && isTestPath(ref.path)) {
      problems.push({
        problem:
          `gone coverage ${where} is a test file, so it does not show any functionality was removed`,
        fix:
          "Cite the removed production file or symbol, not a test the PR deletes or edits",
      });
      continue;
    }
    if (ref.role !== "gone" && ctx.pr.testChanges.removed.includes(ref.path)) {
      problems.push({
        problem:
          `coverage ${where} is a removed test file, so it cannot cover the behaviour`,
        fix: "Point the coverage at a test that exists at the head",
      });
      continue;
    }
    if (
      ref.role !== "gone" && ref.role !== "replacement" &&
      ref.role !== "existing"
    ) {
      problems.push({
        problem: `coverage ${where} has an unknown role`,
        fix: "Set the role to replacement, existing or gone",
      });
      continue;
    }
    const probe = await probeContents(
      ctx.pr.repo,
      ref.path,
      ctx.pr.headSha,
      ctx.runGh,
    );
    if (probe.state === "error") return { passed, retry: plain(probe.message) };
    if (ref.role === "gone") {
      // Gone at the head: absent, or (with a name) the name is missing.
      const goneAtHead = probe.state === "absent" ||
        (probe.state === "present" && name !== "" &&
          !probe.text.includes(name));
      if (!goneAtHead) {
        if (probe.state === "present") {
          problems.push(
            name === ""
              ? {
                problem:
                  `gone coverage ${where} still exists at the head, so it does not show the behaviour is removed`,
                fix:
                  "Name the removed test or symbol in coverage, or drop the gone entry",
              }
              : {
                problem:
                  `gone coverage ${where} still names a symbol present at the head`,
                fix:
                  "Remove the symbol, or cite coverage that exists at the head",
              },
          );
        } else {
          problems.push(
            notFileOrUnreadable(where, probe.state, "gone coverage"),
          );
        }
        continue;
      }
      // It must have existed at the base ref, or nothing was removed.
      const base = validBaseRef(ctx.pr.baseRef);
      if (base === undefined) {
        problems.push(neverExisted(
          where,
          "The review has no valid base branch name for this PR, so the removal cannot be checked",
        ));
        continue;
      }
      const baseProbe = await probeContents(
        ctx.pr.repo,
        ref.path,
        base,
        ctx.runGh,
      );
      if (baseProbe.state === "error") {
        return { passed, retry: plain(baseProbe.message) };
      }
      if (baseProbe.state === "absent") {
        problems.push(neverExisted(where));
      } else if (
        baseProbe.state === "not-file" || baseProbe.state === "unreadable"
      ) {
        problems.push(
          notFileOrUnreadable(
            where,
            baseProbe.state,
            "gone coverage",
            "the base ref",
          ),
        );
      } else if (name !== "" && !baseProbe.text.includes(name)) {
        problems.push(neverExisted(where));
      } else {
        passed.push(ref);
      }
      continue;
    }
    if (probe.state === "absent") {
      problems.push({
        problem: `coverage ${where} is absent at the head`,
        fix: "Cite a test that exists at the head that covers the behaviour",
      });
    } else if (probe.state === "not-file" || probe.state === "unreadable") {
      problems.push(notFileOrUnreadable(where, probe.state, "coverage"));
    } else if (name !== "" && !probe.text.includes(name)) {
      problems.push({
        problem: `coverage name ${where} is not in the file at the head`,
        fix: "Cite a test or symbol name that appears in the file at the head",
      });
    } else {
      passed.push(ref);
    }
  }
  return { passed };
}

// Every check for one note, collecting all its problems.
async function checkNote(
  note: TestChangeNote,
  ctx: Context,
): Promise<NoteOutcome> {
  const problems: Problem[] = [];
  const kind = note.kind ?? "";

  if (BLOCKED_KINDS.has(kind)) {
    return {
      problems: [{
        problem:
          "a skipped test, a weakened assertion or a lowered threshold is never accepted as a test change: restore it",
        fix: "Restore the original test and fix the code instead",
      }],
    };
  }

  if (note.verdict === "owner") {
    const question = normaliseWs(note.ownerQuestion ?? "");
    if (question === "") {
      return {
        problems: [{
          problem:
            "owner verdict without a question: say what the owner has to decide in ownerQuestion",
          fix:
            "Set ownerQuestion to the product-contract question the owner must answer",
        }],
      };
    }
    return {
      problems: [],
      owner: `\`${plain(note.file)}:${note.line}\`: ${plain(question)}`,
    };
  }

  if (note.verdict !== "justified") {
    problems.push(
      note.verdict === "unjustified"
        ? {
          problem:
            "the test change loses protection that nothing replaces, and the verdict is unjustified: restore the protection or replace it",
          fix: "Restore the test, or add a replacement and justify the change",
        }
        : {
          problem:
            "no justified verdict: the test change must be marked justified with its evidence",
          fix: "Set verdict to justified only when every check is met",
        },
    );
  }

  const obsolete = normaliseWs(note.obsolete ?? "");
  if (obsolete === "") {
    problems.push({
      problem:
        "no obsolete statement: say which old behaviour the test checked and why it is no longer required",
      fix: "Set obsolete to the old behaviour and why it is obsolete",
    });
  }

  const remaining = normaliseWs(note.remaining ?? "");
  const coverage = note.coverage ?? [];
  const allGone = coverage.length > 0 &&
    coverage.every((c) => c.role === "gone");
  if (remaining === "" && !allGone) {
    problems.push({
      problem:
        "no remaining statement: say what behaviour still holds after the change",
      fix:
        "Set remaining to the behaviour still covered, or give gone coverage for removed functionality",
    });
  }

  const cov = await checkCoverage(note, ctx, problems);
  if (cov.retry !== undefined) return { problems, retry: cov.retry };
  if (SHA_PATTERN.test(ctx.pr.headSha) && cov.passed.length === 0) {
    problems.push({
      problem:
        "no coverage: no listed test at the head covers the behaviour, and no gone entry shows it removed",
      fix:
        "Cite an existing or replacement test at the head, or a gone entry for removed functionality",
    });
  }

  const quote = normaliseWs(note.requirementQuote ?? "") !== ""
    ? normaliseWs(note.requirementQuote ?? "")
    : normaliseWs(note.criterionQuote ?? "");
  const issues = ctx.governing.issues;
  if (issues.length === 0) {
    const why = ctx.governing.problems.map(plain).join("; ");
    problems.push({
      problem:
        `no usable governing issue: link the issue this change serves with "Closes #N" or an anchored "Part of #N" line${
          why === "" ? "" : `. Why none was usable: ${why}`
        }`,
      fix: "Link the issue that requires this test change",
    });
  }
  if (quote !== "") {
    if (!quoteFound(quote, issues)) {
      problems.push({
        problem:
          `requirement quote is not found in a linked issue (comments never count): ${
            plain(quote)
          }`,
        fix:
          "Quote the acceptance text verbatim from a linked issue's title or body",
      });
    }
  } else if (kind === "expected-value") {
    problems.push({
      problem:
        "expected-value change needs a requirement quote: quote the linked issue text that requires the new value verbatim",
      fix: "Set requirementQuote to the verbatim text of the linked issue",
    });
  }
  if (!REQUIREMENT_KINDS.has(kind)) {
    problems.push({
      problem:
        "kind is missing or unknown: say what sort of test change this is",
      fix: "Set kind to one of the allowed kinds",
    });
  }

  const needsVerification = kind === "expected-value" || kind === "replaced" ||
    coverage.some((c) => c.role === "replacement");
  if (needsVerification && !failsWithout(note.failsWithoutChange)) {
    problems.push({
      problem:
        "the edited test is not shown to fail without the code change: state the observed failure with the change reverted",
      fix:
        "Revert the code change, run the test, and set failsWithoutChange to the observed failure",
    });
  }
  // When every coverage entry is `gone`, nothing at the head covers the
  // behaviour, so the reviewer must show the production code is really gone
  // (callers searched, build run) rather than assert it.
  if ((needsVerification || allGone) && !verificationOk(note.verification)) {
    problems.push({
      problem:
        "a boolean or vacuous claim is not proof: give the command or mutation run and its observed result in verification",
      fix:
        "Set verification to the command or mutation you ran and the result you observed",
    });
  }

  if (problems.length > 0) return { problems };

  const ids = issues.map((i) =>
    i.repo.toLowerCase() === ctx.pr.repo.toLowerCase()
      ? `#${i.number}`
      : `${i.repo}#${i.number}`
  );
  const verification = normaliseWs(note.verification ?? "");
  return {
    problems: [],
    approved: {
      file: note.file,
      line: note.line,
      kind,
      obsolete,
      remaining,
      coverage: cov.passed.map((c) =>
        `${c.role}: ${plain(c.path)}${
          c.name && c.name.trim() !== "" ? `::${plain(c.name)}` : ""
        }`
      ),
      requirement: `${ids.join(", ")}${
        quote === "" ? "" : ` — "${plain(quote)}"`
      }`,
      verification: verification === "" ? "existing coverage" : verification,
    },
  };
}

/**
 * Assess the test changes of one PR. Not applicable (`checked: false`, gh
 * never called) unless the review says the test changes are meaningful or a
 * test file was removed.
 */
export async function assessTestChanges(
  pr: AssessedPr,
  review: {
    testChanges: "none" | "trivial" | "tightened" | "meaningful";
    testChangeNotes: TestChangeNote[];
  },
  policy: EffectiveTestPolicy,
  runGh: RunGh,
): Promise<TestChangeAssessment> {
  const removed = pr.testChanges.removed;
  if (review.testChanges !== "meaningful" && removed.length === 0) {
    return { checked: false, findings: [], ownerReasons: [], approved: [] };
  }
  if (!isRepo(pr.repo) || !isPositiveInt(pr.number)) {
    throw new Error(
      "assessTestChanges needs a valid owner/repo and a positive PR number",
    );
  }
  const notes = review.testChangeNotes;
  const noNotes: Finding[] = review.testChanges === "meaningful" &&
      notes.length === 0 && removed.length === 0
    ? [{
      file: pr.testChanges.edited[0] ?? removed[0] ?? "",
      line: 0,
      problem:
        "meaningful test change has no review note: say what old behaviour is obsolete and what covers the required behaviour",
      fix:
        "Add a testChangeNotes entry for each meaningfully changed test file with file, kind, verdict, obsolete, remaining and coverage",
    }]
    : [];
  const needsIssues = removed.length > 0 ||
    notes.some((n) =>
      !BLOCKED_KINDS.has(n.kind ?? "") && n.verdict !== "owner"
    );
  const governing: GoverningIssues = needsIssues
    ? await resolveGoverningIssues(pr, policy, runGh)
    : { issues: [], problems: [] };
  const fetchProblem = governing.problems.find((p) =>
    p.startsWith(FETCH_FAILED)
  );
  if (fetchProblem !== undefined) {
    return {
      checked: true,
      findings: [],
      ownerReasons: [],
      approved: [],
      retry: plain(fetchProblem),
    };
  }

  const findings: Finding[] = [...noNotes];
  for (const file of removed) {
    if (!notes.some((n) => n.file === file)) {
      findings.push({
        file,
        line: 0,
        problem:
          "removed test file has no review note: say what old behaviour is obsolete and what covers the required behaviour",
        fix:
          "Add a testChangeNotes entry for this file with obsolete, remaining and coverage",
      });
    }
  }

  const ctx: Context = { pr, governing, runGh };
  const ownerReasons: string[] = [];
  const approved: ApprovedTestChange[] = [];
  for (const note of notes) {
    const outcome = await checkNote(note, ctx);
    if (outcome.retry !== undefined) {
      return {
        checked: true,
        findings: [],
        ownerReasons: [],
        approved: [],
        retry: outcome.retry,
      };
    }
    for (const p of outcome.problems) {
      findings.push({
        file: note.file,
        line: note.line,
        problem: p.problem,
        fix: p.fix,
      });
    }
    if (outcome.owner !== undefined) ownerReasons.push(outcome.owner);
    if (outcome.approved !== undefined) approved.push(outcome.approved);
  }
  return { checked: true, findings, ownerReasons, approved };
}
