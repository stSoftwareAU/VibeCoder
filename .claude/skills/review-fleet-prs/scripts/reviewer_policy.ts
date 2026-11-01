// Effective test-review policy on this reviewer host.
const DEFAULT_CONFIG = new URL("../../../../.config.json", import.meta.url);
export const CURRENT_REVIEW_POLICY = "2026-11-02" as const;
export type ReviewerPolicyVersion = typeof CURRENT_REVIEW_POLICY | "legacy";
export interface ReviewerPolicy {
  version: typeof CURRENT_REVIEW_POLICY;
  overrides: Record<string, ReviewerPolicyVersion>;
}
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function reviewerPolicy(
  config: Record<string, unknown>,
): ReviewerPolicy {
  const old = config.pr_reviewer_auto_release;
  if (
    old !== undefined && old !== null && (!Array.isArray(old) ||
      !old.every((r) => typeof r === "string" && REPO.test(r)))
  ) {
    throw new Error(
      'pr_reviewer_auto_release must be an array of "owner/repo" strings',
    );
  }
  const value = config.pr_reviewer_test_policy;
  if (value === undefined || value === null) {
    return { version: CURRENT_REVIEW_POLICY, overrides: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "pr_reviewer_test_policy must be a map of repository names to policy versions",
    );
  }
  const overrides: Record<string, ReviewerPolicyVersion> = {};
  for (const [repo, version] of Object.entries(value)) {
    if (
      !REPO.test(repo) ||
      (version !== "legacy" && version !== CURRENT_REVIEW_POLICY)
    ) {
      throw new Error(`invalid pr_reviewer_test_policy entry: ${repo}`);
    }
    const key = repo.toLowerCase();
    if (key in overrides) {
      throw new Error(`duplicate pr_reviewer_test_policy entry: ${repo}`);
    }
    overrides[key] = version;
  }
  return { version: CURRENT_REVIEW_POLICY, overrides };
}

export function policyForRepo(
  policy: ReviewerPolicy,
  repo: string,
): ReviewerPolicyVersion {
  return policy.overrides[repo.toLowerCase()] ?? policy.version;
}

export async function loadReviewerPolicy(
  path: string | URL = DEFAULT_CONFIG,
): Promise<ReviewerPolicy> {
  try {
    return reviewerPolicy(JSON.parse(await Deno.readTextFile(path)));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return reviewerPolicy({});
    throw e;
  }
}

export function policyMarker(version: ReviewerPolicyVersion): string {
  return `Test review policy: ${version}`;
}
