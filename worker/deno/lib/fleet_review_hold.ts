/** Shared owner-hold contract written by the fleet reviewer (Issue #4658). */

export const REVIEW_MARKER = "Automated review by /review-fleet-prs";

/** Version 2 holds only product-contract questions or explicit repo overrides. */
export const HOLD_POLICY_VERSION = 2;
export const HOLD_POLICY_MARKER_PREFIX = "<!-- vibe-hold-policy v=";
const HOLD_POLICY_LINE = /^<!-- vibe-hold-policy v=(\d{1,4}) -->$/;

export const OWNER_CONTRACT_HOLD =
  "Held for owner review: the intended product contract behind these test changes is unclear.";
export const OWNER_POLICY_HOLD =
  "Held for owner review: this repository holds every meaningful test change for the owner (pr_reviewer_test_hold_repos).";

export function holdPolicyMarker(version = HOLD_POLICY_VERSION): string {
  return `${HOLD_POLICY_MARKER_PREFIX}${version} -->`;
}

/** Last whole-line policy marker; an absent marker is a legacy version 1 hold. */
export function holdPolicyFromBody(body: string | undefined): number {
  let version = 1;
  for (const line of (body ?? "").split("\n")) {
    const match = HOLD_POLICY_LINE.exec(line.trim());
    if (match) version = Number(match[1]);
  }
  return version;
}

/** Body semantics only: callers must independently verify its action provenance. */
export function ownerHoldFromBody(body: string): {
  reason: "product-contract" | "repository-policy";
  detail: string;
} | null {
  if (holdPolicyFromBody(body) !== HOLD_POLICY_VERSION) return null;
  const lines = body.split(/\r?\n/);
  if (!lines.includes(`_${REVIEW_MARKER}._`)) return null;
  if (lines[0] === OWNER_POLICY_HOLD) {
    return { reason: "repository-policy", detail: OWNER_POLICY_HOLD };
  }
  if (lines[0] !== OWNER_CONTRACT_HOLD) return null;
  const questions: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith("- ")) break;
    const question = line.slice(2).trim();
    if (question) questions.push(question);
  }
  return questions.length > 0
    ? { reason: "product-contract", detail: questions.join("; ") }
    : null;
}
