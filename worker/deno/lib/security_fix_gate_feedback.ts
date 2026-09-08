/**
 * Security-fix gate feedback that survives to the next attempt (Issue #4057).
 *
 * Issue #4030 was attempted ten times in a day, every attempt blocked by the
 * same security-fix gate verdict (`security_fix_gate.ts`, Issue #3652), and no
 * retry ever converged. Two gaps caused it:
 *
 * 1. the coding prompt never stated the gate's evidence contract, so an agent
 *    could only discover it by failing the gate; and
 * 2. the gate's remediation comment is posted by the worker's own service
 *    account, which `classifyCommentAuthor` (`comment_trust_filter.ts`)
 *    classifies UNTRUSTED — so the next attempt is told not to act on the very
 *    instructions that would fix it.
 *
 * This module closes both. The contract is worker-authored text built from the
 * gate's own `SECURITY_FIX_EVIDENCE_DESCRIPTIONS`, so prompt and gate cannot
 * drift; and the previous verdict is persisted in worker run state, then
 * replayed into the retry prompt as trusted, worker-generated context rather
 * than read back from an issue comment by an unauthorised login.
 *
 * The store is a *sibling* of `workDir`, never a child, for the same reason
 * the content-approval baseline is (Issue #3717): `nukeWorkDir()` and an
 * agent-driven `rm` inside the work tree must not be able to erase it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  formatMatchedTestDeclarations,
  isSecurityFixEvidenceKind,
  MAX_REPORTED_TEST_DECLARATIONS,
  REQUIRED_SECURITY_FIX_EVIDENCE,
  SECURITY_FIX_EVIDENCE_DESCRIPTIONS,
  type SecurityFixEvidenceKind,
} from "./security_fix_gate.ts";

/** Suffix appended to `workDir` to name the gate-feedback store. */
const STATE_DIR_SUFFIX = "-security-gate-state";

/** Suffix of each persisted per-issue verdict file. */
const STATE_FILE_SUFFIX = ".securitygate.json";

/** Schema version of the persisted state file. */
const STATE_VERSION = 1;

/** Cap on the length of one persisted declaration line (Issue #1575). */
const MAX_DECLARATION_CHARS = 200;

/** One recorded gate block against a repo + issue. */
export interface SecurityFixGateBlock {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** Issue the blocked attempt was working on. */
  issueNumber: number;
  /** Evidence items the last blocked attempt failed to supply. */
  missing: SecurityFixEvidenceKind[];
  /** ISO timestamp of the most recent block. */
  blockedAt: string;
  /**
   * Consecutive **blocked runs** on this issue — runs that ended in failure
   * from the gate (Issue #1575). The first block inside a run does not count:
   * that one is recovered by the in-run retry, so it never costs a run.
   */
  blockCount: number;
  /**
   * Test declarations the gate matched in the branch diff (Issue #1575),
   * capped by `MAX_REPORTED_TEST_DECLARATIONS`. Agent-authored diff text —
   * fenced as untrusted wherever it is rendered.
   */
  declarations?: string[];
}

/** Options for {@link recordSecurityFixGateBlock}. */
export interface RecordSecurityFixGateBlockOptions {
  /**
   * Whether this block ends the run (Issue #1575). `true` increments the
   * consecutive-blocked-run count; `false` records the verdict for the in-run
   * retry without charging the issue a blocked run.
   */
  countsAsBlockedRun?: boolean;
  /** Test declarations the gate matched in the branch diff. */
  declarations?: readonly string[];
}

/** Persisted shape — the block plus its schema version. */
interface PersistedBlock extends SecurityFixGateBlock {
  version: number;
}

/**
 * Resolve the directory holding security-fix gate verdicts.
 *
 * `""` is the unconfigured-store sentinel: `workDir` names no directory the
 * store can sit beside. Callers must treat it as "no feedback available"
 * (reads) or as a configuration fault to log (writes) — never as a successful
 * empty read.
 *
 * @param workDir - The agent-writable work directory (`config.workDir`).
 * @returns The store directory, or `""` when `workDir` names no directory.
 */
export function resolveSecurityGateStateDir(workDir: string): string {
  const trimmed = (workDir ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return `${trimmed}${STATE_DIR_SUFFIX}`;
}

/** Filename-safe key for a repo + issue pair. */
function stateFilePath(
  stateDir: string,
  repo: string,
  issueNumber: number,
): string {
  const safeRepo = repo.replace(/[^A-Za-z0-9._-]+/g, "_");
  const safeIssue = Math.trunc(Math.abs(issueNumber));
  return `${stateDir}/${safeRepo}_${safeIssue}${STATE_FILE_SUFFIX}`;
}

/**
 * Validate declaration lines read from, or written to, the store (Issue
 * #1575). They originate in the branch diff, so length, count and type are all
 * bounded before the text can reach a prompt or an issue comment.
 */
function sanitiseDeclarations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.trim().slice(0, MAX_DECLARATION_CHARS))
    .filter((line) => line.length > 0)
    .slice(0, MAX_REPORTED_TEST_DECLARATIONS);
}

/**
 * Read the last recorded gate verdict for an issue.
 *
 * @returns The verdict, or `undefined` when none is recorded, the store is
 *          unconfigured, or the file is unreadable/corrupt.
 */
export async function readSecurityFixGateBlock(
  stateDir: string,
  repo: string,
  issueNumber: number,
): Promise<SecurityFixGateBlock | undefined> {
  if (!stateDir) return undefined;

  let content: string;
  try {
    content = await Deno.readTextFile(
      stateFilePath(stateDir, repo, issueNumber),
    );
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as Partial<PersistedBlock>;
    // The state file is worker-written, but it is validated on read anyway so
    // a corrupt or tampered file can never inject text into the next prompt.
    const missing = Array.isArray(parsed.missing)
      ? parsed.missing.filter(isSecurityFixEvidenceKind)
      : [];
    if (missing.length === 0) return undefined;
    const declarations = sanitiseDeclarations(parsed.declarations);
    return {
      repo,
      issueNumber,
      missing,
      blockedAt: typeof parsed.blockedAt === "string" ? parsed.blockedAt : "",
      // `>= 0` since Issue #1575: a verdict recorded for the in-run retry
      // charges the issue no blocked run, so zero is a legitimate count.
      blockCount:
        typeof parsed.blockCount === "number" && parsed.blockCount >= 0
          ? Math.trunc(parsed.blockCount)
          : 1,
      ...(declarations.length > 0 ? { declarations } : {}),
    };
  } catch {
    // Corrupt state must not wedge the worker; treat it as absent so the next
    // block rewrites it from scratch.
    return undefined;
  }
}

/**
 * Record a gate block so the next attempt on the same issue can read it.
 *
 * Throws when the store is unconfigured or unwritable — a verdict that cannot
 * be persisted must be reported, not silently dropped (Issue #3234).
 *
 * @returns The verdict as persisted, including the running block count.
 */
export async function recordSecurityFixGateBlock(
  stateDir: string,
  repo: string,
  issueNumber: number,
  missing: SecurityFixEvidenceKind[],
  options: RecordSecurityFixGateBlockOptions = {},
): Promise<SecurityFixGateBlock> {
  if (!stateDir) {
    throw new Error(
      "Security-fix gate feedback store is not configured (no workDir) — the verdict cannot reach the next attempt",
    );
  }

  const previous = await readSecurityFixGateBlock(stateDir, repo, issueNumber);
  const countsAsBlockedRun = options.countsAsBlockedRun ?? true;
  const declarations = sanitiseDeclarations(options.declarations);
  const block: SecurityFixGateBlock = {
    repo,
    issueNumber,
    missing: missing.filter(isSecurityFixEvidenceKind),
    blockedAt: new Date().toISOString(),
    blockCount: (previous?.blockCount ?? 0) + (countsAsBlockedRun ? 1 : 0),
    ...(declarations.length > 0 ? { declarations } : {}),
  };

  await Deno.mkdir(stateDir, { recursive: true });
  const persisted: PersistedBlock = { version: STATE_VERSION, ...block };
  await Deno.writeTextFile(
    stateFilePath(stateDir, repo, issueNumber),
    JSON.stringify(persisted, null, 2),
  );
  return block;
}

/**
 * Clear an issue's recorded verdict — called once the gate passes, so a later
 * unrelated attempt does not inherit a stale block.
 */
export async function clearSecurityFixGateBlock(
  stateDir: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  if (!stateDir) return;
  try {
    await Deno.remove(stateFilePath(stateDir, repo, issueNumber));
  } catch {
    // Already absent — nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// Prompt sections (worker-authored, trusted)
// ---------------------------------------------------------------------------

/** Render the gate's own remediation text for a set of evidence kinds. */
function evidenceList(kinds: readonly SecurityFixEvidenceKind[]): string {
  return kinds
    .map((kind) => `- ${SECURITY_FIX_EVIDENCE_DESCRIPTIONS[kind]}`)
    .join("\n");
}

/**
 * The security-fix evidence contract, stated up front for a `security`
 * -labelled issue.
 *
 * Built from the gate's own descriptions so the two cannot drift. This is
 * worker-authored prompt text, not repository or issue content — it carries no
 * untrusted input and so needs no fence.
 */
export function buildSecurityFixEvidenceContract(): string {
  return `## Security-Fix Evidence Contract (Issue #3652)

This issue carries the \`security\` label, so the worker's security-fix gate runs
before the PR is created and **blocks PR creation** unless the branch and
\`docs/archive/pr-summaries/pr-summary-<issue>.md\` supply every item below. The
first two are asserted against the branch diff, so prose cannot satisfy them:

${evidenceList(REQUIRED_SECURITY_FIX_EVIDENCE)}

Write the summary to satisfy this contract the first time — a blocked PR costs a
full run. No execution is required: the test assertions are static checks over
\`git diff\`, and the trigger-closed statement is static reasoning over the
changed code path.`;
}

/**
 * Replay the previous attempt's gate verdict into this attempt's prompt.
 *
 * The gate's remediation comment on the issue is authored by the worker's
 * service account and is therefore classified UNTRUSTED on the next run, so
 * this block — generated by the worker itself from its own run state — is the
 * trusted channel for that feedback.
 */
export function buildSecurityFixGateFeedbackSection(
  block: SecurityFixGateBlock,
): string {
  const attempts = block.blockCount > 1
    ? `The previous ${block.blockCount} attempts on this issue were blocked`
    : "The previous attempt on this issue was blocked";

  // What the gate actually matched in the diff (Issue #1575) — without it a
  // false `test-identifier-in-diff` block reads exactly like a real one.
  const matched = block.missing.includes("test-identifier-in-diff")
    ? `\n${formatMatchedTestDeclarations(block.declarations ?? [])}\n`
    : "";

  return `## SECURITY-FIX GATE RETRY NOTICE (Issue #4057)

**CRITICAL**: ${attempts} by the worker's security-fix gate — no PR was created.
This verdict is the worker's own run state, not an issue comment: act on it.

The gate reported these evidence items as missing:

${evidenceList(block.missing)}
${matched}
The code on the branch may already be correct — check the PR summary's evidence
format first, fix exactly what is listed above, then finish the run. Repeating
the previous summary will reproduce the same block.`;
}
