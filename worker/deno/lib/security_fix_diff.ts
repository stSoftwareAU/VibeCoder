/**
 * Diff evidence collection for the security-fix gate (Issue #3652).
 *
 * The gate itself is pure (`security_fix_gate.ts`); this module is the thin
 * impure half that asks git what the PR branch actually changed, so the gate
 * can assert a machine-checkable signal instead of trusting only the prose the
 * agent wrote about its own work.
 *
 * Collection is static — `git diff` only, nothing is executed. Returns `null`
 * when no diff could be computed at all, so the gate can fail loud rather than
 * treat "no evidence" as success (Issue #3234).
 *
 * Australian English throughout.
 */

import {
  isTestFilePath,
  type SecurityFixDiffEvidence,
} from "./security_fix_gate.ts";

/** Upper bound on the test diff text handed to the gate. */
const MAX_DIFF_CHARS = 512_000;

function splitLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Collect the PR branch's changed files and the diff body of its test files.
 *
 * Tries `origin/<base>...HEAD` first, then the local `<base>...HEAD`, because
 * a worker clone may have either ref. Returns `null` when neither resolves.
 */
export async function collectSecurityFixDiff(
  gitCommandFn: (args: string[]) => Promise<string>,
  baseBranch: string,
): Promise<SecurityFixDiffEvidence | null> {
  // No base branch means no comparison point — fail loud, never guess one.
  const base = baseBranch.trim();
  if (!base) return null;

  const refs = [`origin/${base}...HEAD`, `${base}...HEAD`];

  let changedFiles: string[] | null = null;
  let resolvedRef = "";
  for (const ref of refs) {
    try {
      const output = await gitCommandFn(["diff", "--name-only", ref]);
      changedFiles = splitLines(output);
      resolvedRef = ref;
      break;
    } catch {
      // Try the next ref; exhausting them returns null (fail loud upstream).
    }
  }

  if (changedFiles === null) return null;

  const testFiles = changedFiles.filter(isTestFilePath);
  if (testFiles.length === 0) {
    return { changedFiles, testDiffText: "" };
  }

  let testDiffText = "";
  try {
    testDiffText = await gitCommandFn([
      "diff",
      "--unified=0",
      resolvedRef,
      "--",
      ...testFiles,
    ]);
  } catch {
    // An empty body cannot satisfy the identifier assertion, so the gate
    // blocks rather than passing a fault off as success.
    testDiffText = "";
  }

  return {
    changedFiles,
    testDiffText: testDiffText.slice(0, MAX_DIFF_CHARS),
  };
}
