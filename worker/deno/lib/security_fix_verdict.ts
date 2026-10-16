/**
 * Independent verifier verdict for the security-fix gate's trigger-closed item
 * (Issue #3657).
 *
 * A read-only VulnHunter `/vulnhunt-fix-verify` run answers four gates against
 * the finding body and the branch diff only. The verdict is derived here by the
 * worker, never by the model: "absence of contradiction is not evidence of a
 * fix". A gate the verifier cannot answer, or answers without a `path:line`
 * citation that resolves at the head, counts as `skipped`, never `pass`.
 *
 * Deliberate departure from VulnHunter's mapping: a `reachability` fail also
 * maps to NOT_FIXED (VulnHunter names only `sink_mitigated`), because a
 * mitigation off the original trigger's path leaves the trigger open. Every
 * non-FIXED verdict blocks the PR anyway.
 *
 * Pure functions, except {@link confirmCitations}, which calls the injected
 * {@link HeadLineCounter}. Australian English throughout.
 */

import { codeFenceFor, scrubUntrustedText } from "./prompt_delimiter.ts";

/** The four gates the independent verifier answers, in prompt order. */
export const SECURITY_FIX_VERIFIER_GATES = [
  "sink_mitigated",
  "reachability",
  "class_eliminated",
  "sweep_complete",
] as const;

/** One of the verifier's gates. */
export type SecurityFixVerifierGate =
  (typeof SECURITY_FIX_VERIFIER_GATES)[number];

/** The status a gate answer can carry. */
export type SecurityFixGateStatus = "pass" | "fail" | "skipped";

/** The worker-derived verdict on the original trigger. */
export type SecurityFixVerdict =
  | "FIXED"
  | "NOT_FIXED"
  | "PARTIAL"
  | "INCONCLUSIVE";

/** One gate answer, after the worker has checked its citation. */
export interface SecurityFixGateAnswer {
  status: SecurityFixGateStatus;
  /** The `path:line` the verifier cited, as written (trimmed); null when none. */
  citation: string | null;
  rationale: string;
  /** Why the worker demoted the verifier's answer to `skipped`; absent when the answer stands. */
  demotion?: string;
}

/** Every gate's answer, keyed by gate name. */
export type SecurityFixGateAnswers = Record<
  SecurityFixVerifierGate,
  SecurityFixGateAnswer
>;

/** The verifier's outcome: a checked verdict, or the reason it did not finish. */
export type SecurityFixVerification =
  | {
    kind: "checked";
    verdict: SecurityFixVerdict;
    gates: SecurityFixGateAnswers;
  }
  | { kind: "not_checked"; reason: string };

/** A repo-relative file and a 1-based line in it. */
export interface SecurityFixCitation {
  path: string;
  line: number;
}

/** Line count of a regular file at the head, or null when the path names none. Throws when the lookup itself fails. */
export type HeadLineCounter = (path: string) => Promise<number | null>;

/** Cap on the verifier reply the worker will parse (untrusted model output). */
export const MAX_VERIFIER_REPLY_CHARS = 200_000;

/** Cap on the rationale kept for each gate. */
export const MAX_GATE_RATIONALE_CHARS = 500;

const GATE_STATUSES: readonly string[] = ["pass", "fail", "skipped"];

/** `path:line` or `path:start-end`; bounded so untrusted input cannot backtrack. */
const CITATION_PATTERN =
  /^([^\s:][^\n:]{0,299}):([1-9]\d{0,6})(?:-[1-9]\d{0,6})?$/;

/** A Windows drive prefix such as `C:`. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGateStatus(value: string): value is SecurityFixGateStatus {
  return GATE_STATUSES.includes(value);
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseGateAnswer(
  gate: SecurityFixVerifierGate,
  raw: unknown,
): SecurityFixGateAnswer {
  if (!isPlainObject(raw)) {
    throw new Error(`verifier reply gate ${gate} is missing or not an object`);
  }
  const status = typeof raw.status === "string"
    ? raw.status.trim().toLowerCase()
    : "";
  if (!isGateStatus(status)) {
    throw new Error(
      `verifier reply gate ${gate} has an unknown status (expected pass, fail or skipped)`,
    );
  }
  const citation =
    typeof raw.citation === "string" && raw.citation.trim() !== ""
      ? raw.citation.trim()
      : null;
  const rationale = typeof raw.rationale === "string"
    ? raw.rationale.trim().slice(0, MAX_GATE_RATIONALE_CHARS)
    : "";
  return { status, citation, rationale };
}

/**
 * Parse the verifier's JSON reply into its four gate answers. Throws, naming
 * the rule broken, for anything short of a complete, well-formed reply: the
 * caller turns the throw into a not-checked verification, never a partial one.
 */
export function parseSecurityFixVerifierReply(
  text: string,
): SecurityFixGateAnswers {
  if (text.length > MAX_VERIFIER_REPLY_CHARS) {
    throw new Error(
      `verifier reply is longer than ${MAX_VERIFIER_REPLY_CHARS} characters`,
    );
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON object in verifier reply");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(
      `verifier reply is not valid JSON: ${(error as Error).message}`,
    );
  }
  const gates = isPlainObject(parsed) ? parsed.gates : undefined;
  if (!isPlainObject(gates)) {
    throw new Error("verifier reply has no gates object");
  }
  const answers = {} as SecurityFixGateAnswers;
  for (const gate of SECURITY_FIX_VERIFIER_GATES) {
    answers[gate] = parseGateAnswer(gate, gates[gate]);
  }
  return answers;
}

/**
 * Parse a `path:line` (or `path:start-end`) citation into a repo-relative path
 * and its start line, or null when it is not one. Surrounding backticks and a
 * leading `./` are tolerated; absolute, drive-letter, backslashed, control-
 * character and `..`-carrying paths are rejected.
 */
export function parseCitation(raw: string): SecurityFixCitation | null {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith("`") && text.endsWith("`")) {
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("./")) text = text.slice(2);
  const match = CITATION_PATTERN.exec(text);
  if (!match) return null;
  const path = match[1] ?? "";
  if (
    path.startsWith("/") || path.startsWith("-") || DRIVE_PREFIX.test(path) ||
    path.includes("\\") || hasControlCharacter(path) ||
    path.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    return null;
  }
  return { path, line: Number(match[2]) };
}

/** Why a citation fails to resolve at the head, or null when it does. */
async function citationProblem(
  citation: string | null,
  headLines: (path: string) => Promise<number | null>,
): Promise<string | null> {
  if (citation === null) return "no file:line citation";
  const parsed = parseCitation(citation);
  if (!parsed) return "the citation is not a repo-relative path:line";
  const count = await headLines(parsed.path);
  if (count === null) return `${parsed.path} does not exist at the head`;
  if (parsed.line > count) {
    return `line ${parsed.line} is past the end of ${parsed.path} (${count} lines)`;
  }
  return null;
}

/**
 * Demote every pass or fail whose citation does not resolve at the head to
 * `skipped`, recording why. A `skipped` answer stands as it is. Each distinct
 * path is counted once. A throwing counter rejects: the caller reports not
 * checked.
 */
export async function confirmCitations(
  answers: SecurityFixGateAnswers,
  countLines: HeadLineCounter,
): Promise<SecurityFixGateAnswers> {
  const counts = new Map<string, number | null>();
  const headLines = async (path: string): Promise<number | null> => {
    if (!counts.has(path)) counts.set(path, await countLines(path));
    return counts.get(path) ?? null;
  };
  const confirmed = {} as SecurityFixGateAnswers;
  for (const gate of SECURITY_FIX_VERIFIER_GATES) {
    const answer = answers[gate];
    const problem = answer.status === "skipped"
      ? null
      : await citationProblem(answer.citation, headLines);
    confirmed[gate] = problem === null
      ? { ...answer }
      : { ...answer, status: "skipped", demotion: problem };
  }
  return confirmed;
}

/**
 * The worker's verdict from the four gate answers. Only FIXED (all four pass)
 * lets the trigger-closed item be satisfied.
 */
export function deriveSecurityFixVerdict(
  answers: SecurityFixGateAnswers,
): SecurityFixVerdict {
  const status = (gate: SecurityFixVerifierGate) => answers[gate].status;
  if (
    status("sink_mitigated") === "fail" || status("reachability") === "fail"
  ) {
    return "NOT_FIXED";
  }
  if (
    status("sink_mitigated") === "pass" &&
    (status("class_eliminated") === "fail" ||
      status("sweep_complete") === "fail")
  ) {
    return "PARTIAL";
  }
  if (SECURITY_FIX_VERIFIER_GATES.every((gate) => status(gate) === "pass")) {
    return "FIXED";
  }
  return "INCONCLUSIVE";
}

/** One gate rendered on one line; newlines in untrusted text are flattened. */
function formatGateLine(
  gate: SecurityFixVerifierGate,
  answer: SecurityFixGateAnswer,
): string {
  const citation = (answer.citation ?? "no citation").replace(/\n/g, " ");
  const rationale = (answer.rationale || "no rationale").replace(/\n/g, " ");
  const demoted = answer.demotion === undefined
    ? ""
    : ` [demoted to skipped: ${answer.demotion}]`;
  return `${gate}: ${answer.status} — ${citation} — ${rationale}${demoted}`;
}

/**
 * Render the verifier's verdict for an operator comment or a retry prompt. The
 * body is untrusted, so it is scrubbed and code-fenced exactly as the
 * discrimination record is.
 */
export function formatSecurityFixVerification(
  verification: SecurityFixVerification,
): string {
  const lines = verification.kind === "checked"
    ? [
      `verdict: ${verification.verdict} (derived by the worker from the gate answers)`,
      ...SECURITY_FIX_VERIFIER_GATES.map((gate) =>
        formatGateLine(gate, verification.gates[gate])
      ),
    ]
    : [`not checked: ${verification.reason}`];
  const body = scrubUntrustedText(lines.join("\n"));
  const fence = codeFenceFor(body);
  return `Independent verifier verdict:

${fence}text
${body}
${fence}`;
}
